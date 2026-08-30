/**
 * Provider-neutral conversation types.
 *
 * The agent loop holds conversation state in THIS shape, never in a vendor's
 * wire format. Each provider converts to and from its own protocol at the
 * boundary. That is what lets the same conversation be answered by Gemini,
 * Groq or Claude without the loop knowing which — and what stops vendor
 * quirks (Anthropic's content blocks, Gemini's parts, OpenAI's tool_calls
 * fragments) from leaking into the business logic.
 */

export type ProviderId = 'gemini' | 'groq' | 'anthropic';

export type ToolCall = {
  /** Stable id used to match a result back to its call. Synthesised for Gemini, which does not issue one. */
  id: string;
  name: string;
  args: Record<string, unknown>;
  /** Optional vendor-specific signature (e.g. Gemini's thought_signature). */
  signature?: string;
};

export type ToolResult = {
  id: string;
  name: string;
  /** JSON-serialised tool output. */
  content: string;
  isError: boolean;
};

export type LlmMessage =
  | { role: 'user'; text: string }
  | { role: 'assistant'; text: string; toolCalls: ToolCall[] }
  | { role: 'tool'; results: ToolResult[] };

export type LlmEvent =
  | { type: 'text'; delta: string }
  | { type: 'tool_calls'; calls: ToolCall[] }
  | { type: 'done'; stopReason: 'tool_calls' | 'end' | 'max_tokens'; usage: { input: number; output: number } };

export type ToolSpec = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

export type StreamRequest = {
  system: string;
  messages: LlmMessage[];
  tools: ToolSpec[];
  signal?: AbortSignal;
  maxTokens?: number;
};

export interface LlmProvider {
  readonly id: ProviderId;
  /** Model identifier actually being called. */
  readonly model: string;
  /** Human label for the UI, e.g. "Gemini 2.5 Flash". */
  readonly label: string;
  stream(req: StreamRequest): AsyncGenerator<LlmEvent>;
}

/**
 * A provider failure translated into something a user can act on.
 * `recoverable` drives whether the UI suggests retrying.
 */
export class LlmError extends Error {
  readonly recoverable: boolean;
  readonly provider: ProviderId;
  readonly status?: number;

  constructor(message: string, opts: { provider: ProviderId; recoverable: boolean; status?: number }) {
    super(message);
    this.name = 'LlmError';
    this.provider = opts.provider;
    this.recoverable = opts.recoverable;
    this.status = opts.status;
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * Shared SSE reading
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Yields the payload of each `data:` line in a text/event-stream.
 *
 * Both Gemini (`?alt=sse`) and Groq stream this way. Written against the raw
 * body rather than an SDK so there is one code path to reason about, and so a
 * partial chunk split across TCP packets is reassembled correctly — the
 * failure mode that silently truncates tool arguments if you split on
 * newlines per-chunk.
 */
export async function* sseLines(
  body: ReadableStream<Uint8Array>,
  signal?: AbortSignal,
): AsyncGenerator<string> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  try {
    for (;;) {
      if (signal?.aborted) return;
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });

      let nl: number;
      while ((nl = buffer.indexOf('\n')) !== -1) {
        const line = buffer.slice(0, nl).replace(/\r$/, '');
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (payload) yield payload;
      }
    }
    // A final line with no trailing newline still carries data.
    const tail = buffer.trim();
    if (tail.startsWith('data:')) {
      const payload = tail.slice(5).trim();
      if (payload) yield payload;
    }
  } finally {
    try { await reader.cancel(); } catch { /* already closed */ }
  }
}

/** Reads an error body without letting a huge HTML error page into the message. */
export async function errorText(res: Response): Promise<string> {
  try {
    const t = await res.text();
    try {
      const j = JSON.parse(t) as { error?: { message?: string } | string; message?: string };
      const m = typeof j.error === 'string' ? j.error : j.error?.message ?? j.message;
      if (m) return String(m);
    } catch { /* not JSON */ }
    return t.slice(0, 300);
  } catch {
    return `HTTP ${res.status}`;
  }
}
