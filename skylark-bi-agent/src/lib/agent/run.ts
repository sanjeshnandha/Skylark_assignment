/**
 * The agent loop.
 *
 * Provider-agnostic: it holds the conversation in the neutral shape defined in
 * providers/types.ts and asks whichever provider is configured to stream a
 * turn. Tool execution goes through `callTool`, the same entry point the
 * hosted MCP endpoint uses, so what the web agent can do and what an external
 * MCP client can do never drift apart.
 */

import { TOOLS, callTool } from '../mcp/tools.ts';
import { systemPrompt } from './system-prompt.ts';
import { getDataSource } from '../monday/source.ts';
import {
  createProvider, LlmError,
  type LlmProvider, type LlmMessage, type ToolCall, type ToolResult,
} from './providers/index.ts';

export type ChatMessage = { role: 'user' | 'assistant'; content: string };

export type AgentEvent =
  | { type: 'status'; message: string }
  | { type: 'text'; delta: string }
  | { type: 'tool_start'; id: string; name: string; input: unknown }
  | { type: 'tool_end'; id: string; name: string; ok: boolean; result: unknown; ms: number }
  | { type: 'done'; usage: { inputTokens: number; outputTokens: number }; turns: number; provider: string; model: string }
  | { type: 'error'; message: string; recoverable: boolean };

const MAX_TURNS = 10;

/**
 * Tool results can be large — a 100-row query is tens of kilobytes. Truncating
 * keeps a long conversation affordable, and the tools are designed so the
 * important parts (totals, coverage, caveats) come first in the JSON. The
 * limit is lower for open models, whose context windows are smaller.
 */
function serializeResult(result: unknown, limit: number): string {
  const json = JSON.stringify(result, null, 1);
  if (json.length <= limit) return json;
  return json.slice(0, limit) + `\n… truncated (${json.length} chars). Narrow the query or request fewer fields.`;
}

export async function* runAgent(
  history: ChatMessage[],
  opts: { provider?: LlmProvider; signal?: AbortSignal } = {},
): AsyncGenerator<AgentEvent> {
  let provider: LlmProvider;
  try {
    provider = opts.provider ?? createProvider();
  } catch (err) {
    yield {
      type: 'error',
      message: err instanceof LlmError ? err.message : String((err as Error)?.message ?? err),
      recoverable: false,
    };
    return;
  }

  let source: 'live' | 'mock' = 'live';
  try {
    source = getDataSource().kind;
  } catch {
    // A configuration problem surfaces on the first tool call with a better message.
  }

  const system = systemPrompt({ source });
  const tools = TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema as Record<string, unknown>,
  }));

  // Open models have tighter context; give them less tool output per call.
  const resultLimit = provider.id === 'groq' ? 12_000 : 24_000;

  const messages: LlmMessage[] = history
    .slice(-20)
    .map((m) => (m.role === 'user'
      ? { role: 'user' as const, text: m.content }
      : { role: 'assistant' as const, text: m.content, toolCalls: [] }));

  let inputTokens = 0;
  let outputTokens = 0;

  for (let turn = 1; turn <= MAX_TURNS; turn++) {
    if (opts.signal?.aborted) return;

    let text = '';
    let calls: ToolCall[] = [];
    let stop: 'tool_calls' | 'end' | 'max_tokens' = 'end';

    try {
      for await (const ev of provider.stream({ system, messages, tools, signal: opts.signal })) {
        if (opts.signal?.aborted) return;
        if (ev.type === 'text') {
          text += ev.delta;
          yield { type: 'text', delta: ev.delta };
        } else if (ev.type === 'tool_calls') {
          calls = ev.calls;
          for (const c of calls) {
            yield { type: 'status', message: `Querying ${c.name.replace(/_/g, ' ')}…` };
          }
        } else {
          stop = ev.stopReason;
          inputTokens += ev.usage.input;
          outputTokens += ev.usage.output;
        }
      }
    } catch (err) {
      if (opts.signal?.aborted) return;
      yield {
        type: 'error',
        message: err instanceof LlmError ? err.message : String((err as Error)?.message ?? err),
        recoverable: err instanceof LlmError ? err.recoverable : true,
      };
      return;
    }

    messages.push({ role: 'assistant', text, toolCalls: calls });

    if (stop !== 'tool_calls' || !calls.length) {
      if (stop === 'max_tokens') {
        yield { type: 'error', message: 'The answer was cut off at the model’s output limit. Try a narrower question.', recoverable: true };
      }
      yield {
        type: 'done',
        usage: { inputTokens, outputTokens },
        turns: turn,
        provider: provider.id,
        model: provider.label,
      };
      return;
    }

    const results: ToolResult[] = [];
    for (const call of calls) {
      if (opts.signal?.aborted) return;
      yield { type: 'tool_start', id: call.id, name: call.name, input: call.args };

      const started = Date.now();
      const result = await callTool(call.name, call.args);
      const ms = Date.now() - started;
      const isError = Boolean(result && typeof result === 'object' && (result as { error?: boolean }).error);

      yield { type: 'tool_end', id: call.id, name: call.name, ok: !isError, result, ms };
      results.push({ id: call.id, name: call.name, content: serializeResult(result, resultLimit), isError });
    }

    messages.push({ role: 'tool', results });
  }

  yield {
    type: 'error',
    message: `Stopped after ${MAX_TURNS} rounds of tool calls without reaching an answer. The question may need to be narrower.`,
    recoverable: true,
  };
}
