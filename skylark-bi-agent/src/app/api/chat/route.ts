/**
 * Chat endpoint. Streams agent events to the browser as newline-delimited
 * JSON — simpler than SSE to produce and to parse, and it survives the proxy
 * buffering that sometimes breaks SSE on serverless hosts.
 */

import { NextRequest } from 'next/server';
import { runAgent, type ChatMessage } from '../../../lib/agent/run.ts';
import { selectedProviderId } from '../../../lib/agent/providers/index.ts';

export const runtime = 'nodejs';
export const maxDuration = 120;

export async function POST(req: NextRequest) {
  const gate = process.env.APP_ACCESS_CODE?.trim();
  let body: { messages?: ChatMessage[]; accessCode?: string };
  try {
    body = await req.json();
  } catch {
    return Response.json({ error: 'Invalid JSON body.' }, { status: 400 });
  }

  if (gate && body.accessCode !== gate) {
    return Response.json({ error: 'Access code required.', needsAccessCode: true }, { status: 401 });
  }

  if (!selectedProviderId()) {
    return Response.json(
      {
        error:
          'No LLM API key is configured on the server. Set GEMINI_API_KEY (free at aistudio.google.com), ' +
          'GROQ_API_KEY (free at console.groq.com) or ANTHROPIC_API_KEY.',
      },
      { status: 500 },
    );
  }

  const messages = (body.messages ?? []).filter(
    (m) => (m.role === 'user' || m.role === 'assistant') && typeof m.content === 'string' && m.content.trim(),
  );
  if (!messages.length) {
    return Response.json({ error: 'No messages supplied.' }, { status: 400 });
  }

  const encoder = new TextEncoder();
  const stream = new ReadableStream({
    async start(controller) {
      const send = (obj: unknown) => {
        try {
          controller.enqueue(encoder.encode(JSON.stringify(obj) + '\n'));
        } catch { /* client disconnected */ }
      };
      try {
        for await (const event of runAgent(messages, { signal: req.signal })) {
          send(event);
        }
      } catch (err) {
        send({ type: 'error', message: (err as Error)?.message ?? 'The agent stopped unexpectedly.', recoverable: true });
      } finally {
        try { controller.close(); } catch { /* already closed */ }
      }
    },
  });

  return new Response(stream, {
    headers: {
      'Content-Type': 'application/x-ndjson; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      'X-Accel-Buffering': 'no',
    },
  });
}
