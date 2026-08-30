/**
 * Google Gemini provider (Generative Language REST API, SSE streaming).
 *
 * Called over plain fetch rather than through an SDK: it is one endpoint and
 * one response shape, and it keeps the deployment free of a dependency that
 * would otherwise need bundling for serverless.
 *
 * Gemini quirks handled here:
 *   • Roles are only "user" and "model" — a tool RESULT is sent as a `user`
 *     turn containing functionResponse parts, not a dedicated role.
 *   • Function calls carry no id, so ids are synthesised and matched back by
 *     name and order.
 *   • functionResponse.response must be a JSON object, never a bare string.
 *   • Parallel calls arrive as several parts in one candidate.
 */

import {
  type LlmProvider, type LlmEvent, type StreamRequest, type ToolCall,
  LlmError, sseLines, errorText,
} from './types.ts';
import { sanitiseTools } from './schema.ts';

const DEFAULT_BASE = 'https://generativelanguage.googleapis.com/v1beta';

type Part =
  | { text: string }
  | { functionCall: { name: string; args?: Record<string, unknown>; id?: string }; thoughtSignature?: string; thought_signature?: string }
  | { functionResponse: { name: string; response: Record<string, unknown>; id?: string } };

type Chunk = {
  candidates?: Array<{ content?: { parts?: Part[]; role?: string }; finishReason?: string }>;
  usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
  error?: { message?: string; status?: string };
};

export class GeminiProvider implements LlmProvider {
  readonly id = 'gemini' as const;
  readonly model: string;
  readonly label: string;
  private apiKey: string;
  private base: string;

  constructor(opts: { apiKey: string; model?: string; baseUrl?: string }) {
    this.apiKey = opts.apiKey;
    this.model = opts.model ?? 'gemini-2.5-flash';
    this.base = (opts.baseUrl ?? DEFAULT_BASE).replace(/\/$/, '');
    this.label = prettyModel(this.model);
  }

  async *stream(req: StreamRequest): AsyncGenerator<LlmEvent> {
    const tools = sanitiseTools(req.tools, { uppercaseTypes: true });

    const body = {
      systemInstruction: { parts: [{ text: req.system }] },
      contents: toContents(req.messages),
      tools: tools.length
        ? [{
            functionDeclarations: tools.map((t) => ({
              name: t.name,
              description: t.description,
              ...(t.parameters ? { parameters: t.parameters } : {}),
            })),
          }]
        : undefined,
      // AUTO lets the model answer directly once it has what it needs, which
      // is what ends the tool loop.
      toolConfig: tools.length ? { functionCallingConfig: { mode: 'AUTO' } } : undefined,
      generationConfig: {
        maxOutputTokens: req.maxTokens ?? 4096,
        temperature: 0,
      },
    };

    const url = `${this.base}/models/${encodeURIComponent(this.model)}:streamGenerateContent?alt=sse`;
    let res: Response;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'x-goog-api-key': this.apiKey },
        body: JSON.stringify(body),
        signal: req.signal,
      });
    } catch (err) {
      if (req.signal?.aborted) return;
      throw new LlmError(`Could not reach the Gemini API: ${(err as Error).message}`, {
        provider: 'gemini', recoverable: true,
      });
    }

    if (!res.ok || !res.body) throw describeError(res.status, await errorText(res));

    const calls: ToolCall[] = [];
    let input = 0;
    let output = 0;
    let finish = '';

    for await (const payload of sseLines(res.body, req.signal)) {
      let chunk: Chunk;
      try { chunk = JSON.parse(payload) as Chunk; } catch { continue; }

      if (chunk.error?.message) {
        throw new LlmError(`Gemini: ${chunk.error.message}`, { provider: 'gemini', recoverable: true });
      }

      if (chunk.usageMetadata) {
        input = chunk.usageMetadata.promptTokenCount ?? input;
        output = chunk.usageMetadata.candidatesTokenCount ?? output;
      }

      const candidate = chunk.candidates?.[0];
      if (candidate?.finishReason) finish = candidate.finishReason;

      for (const part of candidate?.content?.parts ?? []) {
        if ('functionCall' in part) console.log('DEBUG_PART:', JSON.stringify(part));
        if ('text' in part && part.text) {
          yield { type: 'text', delta: part.text };
        } else if ('functionCall' in part && part.functionCall?.name) {
          const sig = ('thoughtSignature' in part) ? (part as any).thoughtSignature : (part as any).thought_signature;
          calls.push({
            id: part.functionCall.id || `gem_${calls.length}_${part.functionCall.name}`,
            name: part.functionCall.name,
            args: (part.functionCall.args ?? {}) as Record<string, unknown>,
            ...(sig ? { signature: sig } : {}),
          });
        }
      }
    }

    if (calls.length) {
      yield { type: 'tool_calls', calls };
      yield { type: 'done', stopReason: 'tool_calls', usage: { input, output } };
      return;
    }
    yield {
      type: 'done',
      stopReason: finish === 'MAX_TOKENS' ? 'max_tokens' : 'end',
      usage: { input, output },
    };
  }
}

/**
 * Maps the neutral history onto Gemini's contents array.
 *
 * Consecutive tool-result turns are merged into one `user` content, because
 * Gemini expects every functionResponse for a set of parallel calls to arrive
 * together rather than as separate turns.
 */
function toContents(messages: StreamRequest['messages']) {
  const contents: Array<{ role: 'user' | 'model'; parts: Part[] }> = [];

  for (const m of messages) {
    if (m.role === 'user') {
      contents.push({ role: 'user', parts: [{ text: m.text }] });
      continue;
    }

    if (m.role === 'assistant') {
      const parts: Part[] = [];
      if (m.text.trim()) parts.push({ text: m.text });
      for (const c of m.toolCalls) {
        const p: Part = { functionCall: { name: c.name, args: c.args, id: c.id.startsWith('gem_') ? undefined : c.id } };
        if (c.signature) (p as any).thoughtSignature = c.signature;
        parts.push(p);
      }
      // Gemini rejects an empty parts array.
      if (!parts.length) parts.push({ text: ' ' });
      console.log('DEBUG_SENDING_ASSISTANT_PARTS:', JSON.stringify(parts));
      contents.push({ role: 'model', parts });
      continue;
    }

    const parts: Part[] = m.results.map((r): Part => ({
      functionResponse: {
        name: r.name,
        id: r.id.startsWith('gem_') ? undefined : r.id,
        // Must be an object; wrap so a JSON string is always valid here.
        response: safeObject(r.content, r.isError),
      },
    }));
    const last = contents[contents.length - 1];
    // Explicit boolean: an inferred type predicate here would narrow
    // `last.parts` to the functionResponse variant and reject the push.
    const isResultTurn: boolean =
      last !== undefined && last.role === 'user' && last.parts.every(isFunctionResponse);
    if (last && isResultTurn) {
      last.parts.push(...parts);
    } else {
      contents.push({ role: 'user', parts });
    }
  }

  return contents;
}

function isFunctionResponse(p: Part): boolean {
  return Object.prototype.hasOwnProperty.call(p, 'functionResponse');
}

function safeObject(content: string, isError: boolean): Record<string, unknown> {
  try {
    const parsed = JSON.parse(content) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed as Record<string, unknown>;
    }
    return { result: parsed };
  } catch {
    return isError ? { error: content } : { result: content };
  }
}

function describeError(status: number, message: string): LlmError {
  if (status === 400 && /API key not valid|API_KEY_INVALID/i.test(message)) {
    return new LlmError('The Gemini API key was rejected. Check GEMINI_API_KEY.', { provider: 'gemini', recoverable: false, status });
  }
  if (status === 403) {
    return new LlmError('Gemini refused the request — the key may lack access to this model, or the Generative Language API is not enabled for the project.', { provider: 'gemini', recoverable: false, status });
  }
  if (status === 404) {
    return new LlmError(`Gemini does not recognise that model. Check GEMINI_MODEL — "gemini-2.5-flash" and "gemini-2.0-flash" are safe choices.`, { provider: 'gemini', recoverable: false, status });
  }
  if (status === 429) {
    return new LlmError('Gemini free-tier rate limit reached. Waiting a minute usually clears it.', { provider: 'gemini', recoverable: true, status });
  }
  if (status >= 500) {
    return new LlmError('Gemini had a server error. Retrying usually works.', { provider: 'gemini', recoverable: true, status });
  }
  return new LlmError(`Gemini error (${status}): ${message}`, { provider: 'gemini', recoverable: status !== 400, status });
}

function prettyModel(model: string): string {
  const m = model.replace(/^models\//, '');
  if (/2\.5-flash/.test(m)) return 'Gemini 2.5 Flash';
  if (/2\.5-pro/.test(m)) return 'Gemini 2.5 Pro';
  if (/2\.0-flash/.test(m)) return 'Gemini 2.0 Flash';
  return `Gemini (${m})`;
}
