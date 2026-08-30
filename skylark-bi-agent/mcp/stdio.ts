#!/usr/bin/env node
/**
 * stdio MCP entry point.
 *
 * Lets any MCP client — Claude Desktop, Cursor, the MCP inspector — use the
 * same monday.com business-intelligence tools the web agent uses. Add to
 * claude_desktop_config.json:
 *
 *   {
 *     "mcpServers": {
 *       "skylark-bi": {
 *         "command": "node",
 *         "args": ["/absolute/path/to/mcp/stdio.ts"],
 *         "env": { "MONDAY_API_TOKEN": "eyJ..." }
 *       }
 *     }
 *   }
 *
 * Requires Node 22.18+ (native TypeScript execution).
 */

import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { ListToolsRequestSchema, CallToolRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Load .env.local when present so the server works without a wrapper script.
const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(here, '..');
for (const file of ['.env.local', '.env']) {
  try {
    for (const line of readFileSync(path.join(root, file), 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
    }
  } catch { /* file absent — environment may already be configured */ }
}
process.chdir(root);

const { TOOLS, callTool } = await import('../src/lib/mcp/tools.ts');

const server = new Server(
  { name: 'skylark-monday-bi', version: '1.0.0' },
  { capabilities: { tools: {} } },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: TOOLS.map((t) => ({
    name: t.name,
    description: t.description,
    inputSchema: t.inputSchema as { type: 'object' },
  })),
}));

server.setRequestHandler(CallToolRequestSchema, async (req) => {
  const result = await callTool(req.params.name, (req.params.arguments ?? {}) as Record<string, unknown>);
  const isError = Boolean(result && typeof result === 'object' && (result as { error?: boolean }).error);
  return {
    content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }],
    isError,
  };
});

await server.connect(new StdioServerTransport());
process.stderr.write('skylark-monday-bi MCP server ready on stdio\n');
