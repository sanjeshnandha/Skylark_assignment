/**
 * Anthropic provider.
 *
 * Kept alongside Gemini and Groq so the choice of model is a deployment
 * decision rather than a rewrite. Uses the official SDK, which already handles
 * the content-block streaming protocol.
 */

import Anthropic from '@anthropic-ai/sdk';
import {
  type LlmProvider, type LlmEvent, type StreamRequest, type ToolCall, LlmError,
} from './types.ts';
import { sanitiseTools } from './schema.ts';

export class AnthropicProvider implements LlmProvider {
  readonly id = 'anthropic' as const;
  readonly model: string;
  readonly label: string;
  private client: Anthropic;

  constructor(opts: { apiKey: string; model?: string; baseUrl?: string }) {
    this.model = opts.model ?? 'claude-sonnet-4-5';
    this.label = prettyModel(this.model);
    this.client = new Anthropic({
      apiKey: opts.apiKey,
      ...(opts.baseUrl ? { baseURL: opts.baseUrl } : {}),
    });
  }

  async *stream(req: StreamRequest): AsyncGenerator<LlmEvent> {
    const tools: Anthropic.Tool[] = sanitiseTools(req.tools, { uppercaseTypes: false }).map((t) => ({
      name: t.name,
      description: t.description,
      input_schema: (t.parameters ?? { type: 'object', properties: {} }) as Anthropic.Tool.InputSchema,
    }));

    try {
      const stream = this.client.messages.stream(
        {
          model: this.model,
          max_tokens: req.maxTokens ?? 4096,
          temperature: 0,
          system: req.system,
          tools,
          messages: toMessages(req.messages),
        },
        { signal: req.signal },
      );

      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          yield { type: 'text', delta: event.delta.text };
        }
      }

      const final = await stream.finalMessage();
      const calls: ToolCall[] = final.content
        .filter((b): b is Anthropic.ToolUseBlock => b.type === 'tool_use')
        .map((b) => ({ id: b.id, name: b.name, args: (b.input ?? {}) as Record<string, unknown> }));

      const usage = { input: final.usage.input_tokens, output: final.usage.output_tokens };

      if (calls.length) {
        yield { type: 'tool_calls', calls };
        yield { type: 'done', stopReason: 'tool_calls', usage };
        return;
      }
      yield {
        type: 'done',
        stopReason: final.stop_reason === 'max_tokens' ? 'max_tokens' : 'end',
        usage,
      };
    } catch (err) {
      if (req.signal?.aborted) return;
      throw describeError(err);
    }
  }
}

function toMessages(messages: StreamRequest['messages']): Anthropic.MessageParam[] {
  const out: Anthropic.MessageParam[] = [];

  for (const m of messages) {
    if (m.role === 'user') {
      out.push({ role: 'user', content: m.text });
      continue;
    }
    if (m.role === 'assistant') {
      const blocks: Anthropic.ContentBlockParam[] = [];
      if (m.text.trim()) blocks.push({ type: 'text', text: m.text });
      for (const c of m.toolCalls) {
        blocks.push({ type: 'tool_use', id: c.id, name: c.name, input: c.args });
      }
      out.push({ role: 'assistant', content: blocks.length ? blocks : [{ type: 'text', text: ' ' }] });
      continue;
    }
    // Tool results are a user turn of tool_result blocks.
    out.push({
      role: 'user',
      content: m.results.map((r) => ({
        type: 'tool_result' as const,
        tool_use_id: r.id,
        content: r.content,
        is_error: r.isError,
      })),
    });
  }
  return out;
}

function describeError(err: unknown): LlmError {
  const e = err as { status?: number; error?: { error?: { message?: string } }; message?: string };
  const detail = e?.error?.error?.message ?? e?.message ?? String(err);

  if (e?.status === 401) {
    return new LlmError('The Anthropic API key was rejected. Check ANTHROPIC_API_KEY.', { provider: 'anthropic', recoverable: false, status: 401 });
  }
  if (e?.status === 400 && /credit balance/i.test(detail)) {
    return new LlmError('The Anthropic account has no credits left. Add credits at console.anthropic.com → Plans & Billing, or switch LLM_PROVIDER to gemini or groq.', { provider: 'anthropic', recoverable: false, status: 400 });
  }
  if (e?.status === 429) {
    return new LlmError('Rate limited by the Anthropic API. Try again in a few seconds.', { provider: 'anthropic', recoverable: true, status: 429 });
  }
  if (e?.status && e.status >= 500) {
    return new LlmError('The Anthropic API had a server error. Retrying usually works.', { provider: 'anthropic', recoverable: true, status: e.status });
  }
  return new LlmError(detail.slice(0, 300), { provider: 'anthropic', recoverable: true, status: e?.status });
}

function prettyModel(model: string): string {
  if (/sonnet-4-5|sonnet-4\.5/.test(model)) return 'Claude Sonnet 4.5';
  if (/haiku/.test(model)) return 'Claude Haiku';
  if (/opus/.test(model)) return 'Claude Opus';
  return `Claude (${model})`;
}
