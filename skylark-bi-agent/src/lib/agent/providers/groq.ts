/**
 * Groq provider (OpenAI-compatible chat completions, SSE streaming).
 *
 * The OpenAI wire format streams tool calls as *fragments*: an opening delta
 * carries the id and function name, then subsequent deltas append raw
 * characters to `function.arguments` until the JSON happens to be complete.
 * Nothing announces the end. Accumulating those fragments by index — and only
 * parsing once the stream finishes — is the whole job here, and getting it
 * wrong truncates arguments in a way that looks like the model hallucinating.
 *
 * Because the endpoint is OpenAI-compatible, `GROQ_BASE_URL` also points this
 * provider at any other compatible service (Together, Fireworks, OpenRouter,
 * a local llama.cpp server) without new code.
 */

import {
  type LlmProvider, type LlmEvent, type StreamRequest, type ToolCall,
  LlmError, sseLines, errorText,
} from './types.ts';
import { sanitiseTools } from './schema.ts';

const DEFAULT_BASE = 'https://api.groq.com/openai/v1';

type Delta = {
  content?: string | null;
  tool_calls?: Array<{
    index: number;
    id?: string;
    type?: string;
    function?: { name?: string; arguments?: string };
  }>;
};

type Chunk = {
  choices?: Array<{ delta?: Delta; finish_reason?: string | null }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
  error?: { message?: string };
};

export class GroqProvider implements LlmProvider {
  readonly id = 'groq' as const;
  readonly model: string;
  readonly label: string;
  private apiKey: string;
  private base: string;

  constructor(opts: { apiKey: string; model?: string; baseUrl?: string }) {
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? 'llama-3.3-70b-versatile';
    this.base = (opts.baseUrl ?? DEFAULT_BASE).replace(/\/$/, '');
    this.label = prettyModel(this.model);
  }

  async *stream(req: StreamRequest): AsyncGenerator<LlmEvent> {
    const tools = sanitiseTools(req.tools, { uppercaseTypes: false });

    const body = {
      model: this.model,
      stream: true,
      stream_options: { include_usage: true },
      temperature: 0,
      max_tokens: req.maxTokens ?? 4096,
      messages: toMessages(req.system, req.messages),
      tools: tools.length
        ? tools.map((t) => ({
            type: 'function',
            function: {
              name: t.name,
              description: t.description,
              parameters: t.parameters ?? { type: 'object', properties: {} },
            },
          }))
        : undefined,
      tool_choice: tools.length ? 'auto' : undefined,
    };

    let res: Response;
    try {
      res = await fetch(`${this.base}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${this.apiKey}`,
        },
        body: JSON.stringify(body),
        signal: req.signal,
      });
    } catch (err) {
      if (req.signal?.aborted) return;
      throw new LlmError(`Could not reach the Groq API: ${(err as Error).message}`, {
        provider: 'groq', recoverable: true,
      });
    }

    if (!res.ok || !res.body) throw describeError(res.status, await errorText(res));

    // index → partial call. Arguments arrive as a character stream.
    const pending = new Map<number, { id: string; name: string; args: string }>();
    let input = 0;
    let output = 0;
    let finish = '';

    for await (const payload of sseLines(res.body, req.signal)) {
      if (payload === '[DONE]') break;

      let chunk: Chunk;
      try { chunk = JSON.parse(payload) as Chunk; } catch { continue; }

      if (chunk.error?.message) {
        throw new LlmError(`Groq: ${chunk.error.message}`, { provider: 'groq', recoverable: true });
      }
      if (chunk.usage) {
        input = chunk.usage.prompt_tokens ?? input;
        output = chunk.usage.completion_tokens ?? output;
      }

      const choice = chunk.choices?.[0];
      if (choice?.finish_reason) finish = choice.finish_reason;

      const delta = choice?.delta;
      if (!delta) continue;

      if (typeof delta.content === 'string' && delta.content) {
        yield { type: 'text', delta: delta.content };
      }

      for (const frag of delta.tool_calls ?? []) {
        const idx = frag.index ?? 0;
        const cur = pending.get(idx) ?? { id: '', name: '', args: '' };
        if (frag.id) cur.id = frag.id;
        if (frag.function?.name) cur.name = frag.function.name;
        if (frag.function?.arguments) cur.args += frag.function.arguments;
        pending.set(idx, cur);
      }
    }

    if (pending.size) {
      const calls: ToolCall[] = [...pending.entries()]
        .sort((a, b) => a[0] - b[0])
        .map(([idx, c]) => ({
          id: c.id || `groq_${idx}_${c.name}`,
          name: c.name,
          args: parseArgs(c.args),
        }))
        .filter((c) => c.name);

      if (calls.length) {
        yield { type: 'tool_calls', calls };
        yield { type: 'done', stopReason: 'tool_calls', usage: { input, output } };
        return;
      }
    }

    yield {
      type: 'done',
      stopReason: finish === 'length' ? 'max_tokens' : 'end',
      usage: { input, output },
    };
  }
}

/**
 * Open models occasionally emit arguments that are not quite valid JSON —
 * a trailing comma, or the object wrapped in a markdown fence. Recovering
 * rather than throwing keeps one bad call from killing the whole turn; the
 * tool layer will report a useful error if the arguments are truly unusable.
 */
function parseArgs(raw: string): Record<string, unknown> {
  const s = raw.trim();
  if (!s) return {};
  try {
    return JSON.parse(s) as Record<string, unknown>;
  } catch { /* try to repair */ }

  const fenced = s.match(/```(?:json)?\s*([\s\S]*?)```/);
  const candidate = (fenced ? fenced[1] : s).trim();
  const repaired = candidate.replace(/,\s*([}\]])/g, '$1');
  try {
    return JSON.parse(repaired) as Record<string, unknown>;
  } catch { /* give up below */ }

  const first = repaired.indexOf('{');
  const last = repaired.lastIndexOf('}');
  if (first !== -1 && last > first) {
    try {
      return JSON.parse(repaired.slice(first, last + 1)) as Record<string, unknown>;
    } catch { /* fall through */ }
  }
  return { __unparsed_arguments: raw };
}

function toMessages(system: string, messages: StreamRequest['messages']) {
  const out: Array<Record<string, unknown>> = [{ role: 'system', content: system }];

  for (const m of messages) {
    if (m.role === 'user') {
      out.push({ role: 'user', content: m.text });
      continue;
    }
    if (m.role === 'assistant') {
      out.push({
        role: 'assistant',
        content: m.text || null,
        ...(m.toolCalls.length
          ? {
              tool_calls: m.toolCalls.map((c) => ({
                id: c.id,
                type: 'function',
                function: { name: c.name, arguments: JSON.stringify(c.args) },
              })),
            }
          : {}),
      });
      continue;
    }
    // Each result is its own message in the OpenAI format.
    for (const r of m.results) {
      out.push({ role: 'tool', tool_call_id: r.id, name: r.name, content: r.content });
    }
  }
  return out;
}

function describeError(status: number, message: string): LlmError {
  if (status === 401) {
    return new LlmError('The Groq API key was rejected. Check GROQ_API_KEY.', { provider: 'groq', recoverable: false, status });
  }
  if (status === 404 || /model.*not.*(found|exist)|decommissioned/i.test(message)) {
    return new LlmError(`Groq does not recognise that model. Check GROQ_MODEL — Groq retires models fairly often; "llama-3.3-70b-versatile" is a safe current choice.`, { provider: 'groq', recoverable: false, status });
  }
  if (status === 429) {
    return new LlmError('Groq rate limit reached. The free tier resets quickly — try again shortly.', { provider: 'groq', recoverable: true, status });
  }
  if (status === 413 || /too large|context/i.test(message)) {
    return new LlmError('The conversation exceeded the model context window. Start a new question.', { provider: 'groq', recoverable: false, status });
  }
  if (status >= 500) {
    return new LlmError('Groq had a server error. Retrying usually works.', { provider: 'groq', recoverable: true, status });
  }
  return new LlmError(`Groq error (${status}): ${message}`, { provider: 'groq', recoverable: status !== 400, status });
}

function prettyModel(model: string): string {
  if (/kimi-k2/i.test(model)) return 'Kimi K2 (Groq)';
  if (/llama-3\.3-70b/i.test(model)) return 'Llama 3.3 70B (Groq)';
  if (/llama-4/i.test(model)) return 'Llama 4 (Groq)';
  if (/qwen/i.test(model)) return `Qwen (Groq)`;
  return `${model} (Groq)`;
}
