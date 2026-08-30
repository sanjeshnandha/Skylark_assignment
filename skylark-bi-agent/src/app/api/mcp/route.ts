/**
 * Hosted MCP endpoint (Streamable HTTP, stateless).
 *
 * Implemented directly against the JSON-RPC wire format rather than through
 * the SDK's Node transport, because that transport wants Node's req/res
 * objects and this runs on Next's Web Request/Response. Stateless is the right
 * shape here anyway: every tool call is independent, so there is no session to
 * keep, and it survives the serverless cold starts a hosted demo will hit.
 *
 * Point any MCP client at:  https://<deployment>/api/mcp
 */

import { NextRequest } from 'next/server';
import { TOOLS, callTool } from '../../../lib/mcp/tools.ts';

export const runtime = 'nodejs';
export const maxDuration = 60;

const PROTOCOL_VERSION = '2025-06-18';

type JsonRpcRequest = { jsonrpc: '2.0'; id?: string | number | null; method: string; params?: Record<string, unknown> };

function result(id: string | number | null | undefined, value: unknown) {
  return Response.json({ jsonrpc: '2.0', id: id ?? null, result: value });
}

function rpcError(id: string | number | null | undefined, code: number, message: string) {
  return Response.json({ jsonrpc: '2.0', id: id ?? null, error: { code, message } }, { status: 200 });
}

export async function POST(req: NextRequest) {
  let body: JsonRpcRequest | JsonRpcRequest[];
  try {
    body = await req.json();
  } catch {
    return rpcError(null, -32700, 'Parse error: request body was not valid JSON.');
  }

  // Batches are permitted by JSON-RPC; handle them rather than 400-ing.
  if (Array.isArray(body)) {
    const responses = await Promise.all(body.map(handle));
    return Response.json(responses.filter((r) => r !== null));
  }

  const single = await handle(body);
  if (single === null) return new Response(null, { status: 202 }); // notification
  return Response.json(single);
}

async function handle(req: JsonRpcRequest): Promise<unknown | null> {
  const { id, method, params } = req;

  switch (method) {
    case 'initialize':
      return {
        jsonrpc: '2.0', id: id ?? null,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: 'skylark-monday-bi', version: '1.0.0' },
          instructions:
            'Business-intelligence tools over two monday.com boards: a sales pipeline (Deal Funnel) and project execution with billing (Work Order Tracker). Call describe_board before querying a board — the field notes carry data-quality warnings that belong in any answer built on them.',
        },
      };

    case 'notifications/initialized':
    case 'notifications/cancelled':
      return null;

    case 'ping':
      return { jsonrpc: '2.0', id: id ?? null, result: {} };

    case 'tools/list':
      return {
        jsonrpc: '2.0', id: id ?? null,
        result: {
          tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema })),
        },
      };

    case 'tools/call': {
      const name = String((params as { name?: string })?.name ?? '');
      const args = ((params as { arguments?: Record<string, unknown> })?.arguments ?? {});
      if (!name) return { jsonrpc: '2.0', id: id ?? null, error: { code: -32602, message: 'Missing tool name.' } };
      const value = await callTool(name, args);
      const isError = Boolean(value && typeof value === 'object' && (value as { error?: boolean }).error);
      return {
        jsonrpc: '2.0', id: id ?? null,
        result: { content: [{ type: 'text', text: JSON.stringify(value, null, 2) }], isError },
      };
    }

    case 'resources/list':
      return { jsonrpc: '2.0', id: id ?? null, result: { resources: [] } };
    case 'prompts/list':
      return { jsonrpc: '2.0', id: id ?? null, result: { prompts: [] } };

    default:
      return { jsonrpc: '2.0', id: id ?? null, error: { code: -32601, message: `Method not found: ${method}` } };
  }
}

/** A GET here is usually a human checking the URL, so answer usefully. */
export async function GET() {
  return Response.json({
    name: 'skylark-monday-bi',
    transport: 'Streamable HTTP (stateless JSON-RPC over POST)',
    protocolVersion: PROTOCOL_VERSION,
    tools: TOOLS.map((t) => t.name),
    usage: 'POST JSON-RPC 2.0 to this URL. Try {"jsonrpc":"2.0","id":1,"method":"tools/list"}.',
  });
}
