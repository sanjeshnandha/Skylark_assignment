import { test, before } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import { existsSync } from 'node:fs';
import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { GeminiProvider } from '../src/lib/agent/providers/gemini.ts';
import { GroqProvider } from '../src/lib/agent/providers/groq.ts';
import { sanitiseTool } from '../src/lib/agent/providers/schema.ts';
import { coerceFilterValues } from '../src/lib/data/filter.ts';
import { runAgent } from '../src/lib/agent/run.ts';
import { TOOLS } from '../src/lib/mcp/tools.ts';
import type { LlmEvent, StreamRequest, LlmProvider } from '../src/lib/agent/providers/types.ts';

process.env.DATA_SOURCE = 'mock';

/**
 * The agent-loop test runs real tools against the offline replay, so it needs
 * data/mock-dataset.json. Generating it here rather than relying on someone
 * having run `npm run mock:build` first keeps `npm test` order-independent on
 * a fresh clone.
 */
before(async () => {
  const fixture = path.join(process.cwd(), 'data', 'mock-dataset.json');
  if (existsSync(fixture)) return;

  const books = ['Deal funnel Data.xlsx', 'Work_Order_Tracker Data.xlsx'];
  if (!books.every((b) => existsSync(path.join(process.cwd(), b)))) return;

  const { readBoardSheet } = await import('../scripts/read-workbook.ts');
  const { DEALS, WORK_ORDERS } = await import('../src/lib/data/schema.ts');
  const [d, w] = await Promise.all([
    readBoardSheet(books[0], DEALS),
    readBoardSheet(books[1], WORK_ORDERS),
  ]);
  await mkdir(path.join(process.cwd(), 'data'), { recursive: true });
  await writeFile(fixture, JSON.stringify({
    generatedAt: new Date().toISOString(),
    boards: {
      deals: { name: DEALS.boardName, rows: d.map((r) => ({ id: `mock-d-${r.rowNumber}`, values: r.values })) },
      work_orders: { name: WORK_ORDERS.boardName, rows: w.map((r) => ({ id: `mock-w-${r.rowNumber}`, values: r.values })) },
    },
  }), 'utf8');
});

/* ────────────────────────────────────────────────────────────────────────────
 * A stub that speaks each provider's wire protocol.
 *
 * Neither API is reachable from the build sandbox, so correctness of the
 * request shaping and stream parsing is proved here instead: the stub captures
 * exactly what we sent and replays a byte-accurate response, including SSE
 * frames deliberately split mid-JSON to catch buffer-reassembly bugs.
 * ────────────────────────────────────────────────────────────────────────── */

type Captured = { path: string; headers: Record<string, string>; body: any };

async function withStub(
  frames: string[][],
  fn: (baseUrl: string, captured: Captured[]) => Promise<void>,
): Promise<void> {
  const captured: Captured[] = [];
  let call = 0;

  const server: Server = createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => { raw += c; });
    req.on('end', () => {
      captured.push({
        path: req.url ?? '',
        headers: req.headers as Record<string, string>,
        body: raw ? JSON.parse(raw) : null,
      });
      const chunks = frames[Math.min(call++, frames.length - 1)];
      res.writeHead(200, { 'Content-Type': 'text/event-stream' });
      // Written as separate socket writes, so the client must reassemble.
      for (const c of chunks) res.write(c);
      res.end();
    });
  });

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  try {
    await fn(`http://127.0.0.1:${port}`, captured);
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
}

async function collect(gen: AsyncGenerator<LlmEvent>): Promise<LlmEvent[]> {
  const out: LlmEvent[] = [];
  for await (const e of gen) out.push(e);
  return out;
}

const REQ: StreamRequest = {
  system: 'You are a BI analyst.',
  messages: [{ role: 'user', text: 'pipeline by sector?' }],
  tools: [{
    name: 'aggregate',
    description: 'Aggregate a metric.',
    inputSchema: {
      type: 'object',
      properties: {
        board: { type: 'string', enum: ['deals', 'work_orders'] },
        metric: { type: 'string' },
        filters: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              field: { type: 'string' },
              op: { type: 'string' },
              value: { description: 'Comparison value.' },   // deliberately untyped
            },
            required: ['field', 'op'],
          },
        },
      },
      required: ['board', 'metric'],
    },
  }],
};

/* ── schema portability ─────────────────────────────────────────────────── */

test('Gemini schema: types uppercased, untyped property given a type and encoding hint', () => {
  const s = sanitiseTool(REQ.tools[0], { uppercaseTypes: true });
  const p = s.parameters as any;
  assert.equal(p.type, 'OBJECT');
  assert.equal(p.properties.board.type, 'STRING');
  assert.deepEqual(p.properties.board.enum, ['deals', 'work_orders']);
  assert.equal(p.properties.filters.type, 'ARRAY');
  const value = p.properties.filters.items.properties.value;
  assert.equal(value.type, 'STRING', 'an untyped property must be given a type for Gemini');
  assert.match(value.description, /JSON array/, 'must tell the model how to encode a list');
});

test('Gemini schema: unsupported keywords are stripped', () => {
  const s = sanitiseTool(
    { name: 't', description: 'd', inputSchema: {
      type: 'object', additionalProperties: false, $schema: 'http://json-schema.org/draft-07/schema#',
      properties: { a: { type: 'string', default: 'x' } },
    } },
    { uppercaseTypes: true },
  );
  const p = s.parameters as any;
  assert.equal('additionalProperties' in p, false);
  assert.equal('$schema' in p, false);
  assert.equal('default' in p.properties.a, false);
});

test('a tool with no parameters omits the schema entirely', () => {
  // Gemini rejects {type: OBJECT, properties: {}}.
  const s = sanitiseTool({ name: 'list_boards', description: 'd', inputSchema: { type: 'object', properties: {} } }, { uppercaseTypes: true });
  assert.equal(s.parameters, undefined);
});

test('every real tool survives sanitisation for both dialects', () => {
  for (const t of TOOLS) {
    for (const uppercase of [true, false]) {
      const s = sanitiseTool({ name: t.name, description: t.description, inputSchema: t.inputSchema as any }, { uppercaseTypes: uppercase });
      assert.ok(s.name && s.description, `${t.name} lost its identity`);
      if (s.parameters) {
        const json = JSON.stringify(s.parameters);
        assert.equal(/"additionalProperties"|"\$schema"|"oneOf"/.test(json), false, `${t.name} kept an unsupported keyword`);
        // No property may be left without a type or an enum.
        const walk = (n: any): void => {
          if (!n || typeof n !== 'object') return;
          if (n.properties) {
            for (const [k, v] of Object.entries<any>(n.properties)) {
              assert.ok(v.type || v.enum, `${t.name}.${k} has no type`);
              walk(v);
            }
          }
          if (n.items) walk(n.items);
        };
        walk(s.parameters);
      }
    }
  }
});

/* ── value coercion ─────────────────────────────────────────────────────── */

test('string-encoded filter values are coerced back to real types', () => {
  const out = coerceFilterValues([
    { field: 'dealValue', op: 'gt', value: '1000000' },
    { field: 'sector', op: 'in', value: '["Mining","Renewables"]' },
    { field: 'sector', op: 'in', value: 'Mining, Renewables' },
    { field: 'd.isOpen', op: 'eq', value: 'true' },
    { field: 'tentativeCloseDate', op: 'in_period', value: 'this_quarter' },
    { field: 'poDate', op: 'after', value: '2025-04-01' },
    { field: 'serialNo', op: 'eq', value: 'SDPLDEAL-004' },
  ]);
  assert.equal(out[0].value, 1000000);
  assert.deepEqual(out[1].value, ['Mining', 'Renewables']);
  assert.deepEqual(out[2].value, ['Mining', 'Renewables']);
  assert.equal(out[3].value, true);
  assert.equal(out[4].value, 'this_quarter', 'period expressions must survive untouched');
  assert.equal(out[5].value, '2025-04-01', 'an ISO date must not become a number');
  assert.equal(out[6].value, 'SDPLDEAL-004', 'a genuine string must not be mangled');
});

/* ── Gemini protocol ────────────────────────────────────────────────────── */

const geminiText = (t: string) =>
  `data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: t }], role: 'model' } }] })}\n\n`;

test('Gemini: request shape, streamed text and usage', async () => {
  await withStub([[
    geminiText('Renewables leads at '),
    geminiText('₹9.35 Cr.'),
    `data: ${JSON.stringify({ candidates: [{ finishReason: 'STOP' }], usageMetadata: { promptTokenCount: 900, candidatesTokenCount: 40 } })}\n\n`,
  ]], async (base, captured) => {
    const p = new GeminiProvider({ apiKey: 'k-test', baseUrl: base, model: 'gemini-2.5-flash' });
    const events = await collect(p.stream(REQ));

    // Request
    const req = captured[0];
    assert.match(req.path, /streamGenerateContent\?alt=sse/);
    assert.equal(req.headers['x-goog-api-key'], 'k-test');
    assert.equal(req.body.systemInstruction.parts[0].text, 'You are a BI analyst.');
    assert.equal(req.body.contents[0].role, 'user');
    assert.equal(req.body.tools[0].functionDeclarations[0].name, 'aggregate');
    assert.equal(req.body.toolConfig.functionCallingConfig.mode, 'AUTO');

    // Response
    const text = events.filter((e) => e.type === 'text').map((e: any) => e.delta).join('');
    assert.equal(text, 'Renewables leads at ₹9.35 Cr.');
    const done = events.at(-1) as any;
    assert.equal(done.stopReason, 'end');
    assert.equal(done.usage.input, 900);
  });
});

test('Gemini: parallel function calls are parsed', async () => {
  await withStub([[
    `data: ${JSON.stringify({ candidates: [{ content: { parts: [
      { functionCall: { name: 'describe_board', args: { board: 'deals' } } },
      { functionCall: { name: 'data_time_range', args: { board: 'deals' } } },
    ] } }] })}\n\n`,
    `data: ${JSON.stringify({ candidates: [{ finishReason: 'STOP' }] })}\n\n`,
  ]], async (base) => {
    const p = new GeminiProvider({ apiKey: 'k', baseUrl: base });
    const events = await collect(p.stream(REQ));
    const tc = events.find((e) => e.type === 'tool_calls') as any;
    assert.equal(tc.calls.length, 2);
    assert.equal(tc.calls[0].name, 'describe_board');
    assert.deepEqual(tc.calls[1].args, { board: 'deals' });
    assert.notEqual(tc.calls[0].id, tc.calls[1].id, 'synthesised ids must be unique');
    assert.equal((events.at(-1) as any).stopReason, 'tool_calls');
  });
});

test('Gemini: SSE frames split mid-JSON are reassembled', async () => {
  const full = geminiText('hello world');
  const cut = Math.floor(full.length / 2);
  await withStub([[full.slice(0, cut), full.slice(cut),
    `data: ${JSON.stringify({ candidates: [{ finishReason: 'STOP' }] })}\n\n`]],
  async (base) => {
    const p = new GeminiProvider({ apiKey: 'k', baseUrl: base });
    const events = await collect(p.stream(REQ));
    const text = events.filter((e) => e.type === 'text').map((e: any) => e.delta).join('');
    assert.equal(text, 'hello world');
  });
});

test('Gemini: tool results are sent as a user turn of functionResponse parts', async () => {
  await withStub([[`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] })}\n\n`]],
  async (base, captured) => {
    const p = new GeminiProvider({ apiKey: 'k', baseUrl: base });
    await collect(p.stream({
      ...REQ,
      messages: [
        { role: 'user', text: 'q' },
        { role: 'assistant', text: '', toolCalls: [{ id: 'c1', name: 'aggregate', args: { board: 'deals' } }] },
        { role: 'tool', results: [{ id: 'c1', name: 'aggregate', content: '{"total":5}', isError: false }] },
      ],
    }));
    const contents = captured[0].body.contents;
    assert.equal(contents[1].role, 'model');
    assert.equal(contents[1].parts[0].functionCall.name, 'aggregate');
    // Gemini has no "tool" role: results ride on a user turn.
    assert.equal(contents[2].role, 'user');
    assert.equal(contents[2].parts[0].functionResponse.name, 'aggregate');
    assert.deepEqual(contents[2].parts[0].functionResponse.response, { total: 5 });
  });
});

test('Gemini: a non-object tool result is still wrapped in an object', async () => {
  await withStub([[`data: ${JSON.stringify({ candidates: [{ content: { parts: [{ text: 'ok' }] }, finishReason: 'STOP' }] })}\n\n`]],
  async (base, captured) => {
    const p = new GeminiProvider({ apiKey: 'k', baseUrl: base });
    await collect(p.stream({
      ...REQ,
      messages: [
        { role: 'user', text: 'q' },
        { role: 'assistant', text: '', toolCalls: [{ id: 'c1', name: 't', args: {} }] },
        { role: 'tool', results: [{ id: 'c1', name: 't', content: '[1,2,3]', isError: false }] },
      ],
    }));
    const r = captured[0].body.contents[2].parts[0].functionResponse.response;
    assert.equal(typeof r, 'object');
    assert.deepEqual(r, { result: [1, 2, 3] });
  });
});

/* ── Groq protocol ──────────────────────────────────────────────────────── */

test('Groq: request shape and streamed text', async () => {
  await withStub([[
    `data: ${JSON.stringify({ choices: [{ delta: { content: 'Order book is ' } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: { content: '₹21.16 Cr.' }, finish_reason: 'stop' }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [], usage: { prompt_tokens: 800, completion_tokens: 30 } })}\n\n`,
    'data: [DONE]\n\n',
  ]], async (base, captured) => {
    const p = new GroqProvider({ apiKey: 'g-test', baseUrl: base, model: 'llama-3.3-70b-versatile' });
    const events = await collect(p.stream(REQ));

    const req = captured[0];
    assert.match(req.path, /\/chat\/completions$/);
    assert.equal(req.headers.authorization, 'Bearer g-test');
    assert.equal(req.body.stream, true);
    assert.equal(req.body.messages[0].role, 'system');
    assert.equal(req.body.tools[0].type, 'function');
    assert.equal(req.body.tools[0].function.name, 'aggregate');

    const text = events.filter((e) => e.type === 'text').map((e: any) => e.delta).join('');
    assert.equal(text, 'Order book is ₹21.16 Cr.');
    assert.equal((events.at(-1) as any).usage.input, 800);
  });
});

test('Groq: tool-call argument fragments are accumulated across deltas', async () => {
  // The OpenAI format streams arguments one fragment at a time; nothing marks
  // the end, so parsing early truncates them.
  const frags = ['{"board":', '"work_ord', 'ers","met', 'ric":"sum"}'];
  await withStub([[
    `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'call_abc', type: 'function', function: { name: 'aggregate', arguments: '' } }] } }] })}\n\n`,
    ...frags.map((f) => `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, function: { arguments: f } }] } }] })}\n\n`),
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}\n\n`,
    'data: [DONE]\n\n',
  ]], async (base) => {
    const p = new GroqProvider({ apiKey: 'k', baseUrl: base });
    const events = await collect(p.stream(REQ));
    const tc = events.find((e) => e.type === 'tool_calls') as any;
    assert.equal(tc.calls.length, 1);
    assert.equal(tc.calls[0].id, 'call_abc');
    assert.deepEqual(tc.calls[0].args, { board: 'work_orders', metric: 'sum' });
  });
});

test('Groq: two parallel tool calls stay separate by index', async () => {
  await withStub([[
    `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [
      { index: 0, id: 'a', function: { name: 'describe_board', arguments: '{"board":"deals"}' } },
      { index: 1, id: 'b', function: { name: 'data_time_range', arguments: '{"board":"deals"}' } },
    ] } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}\n\n`,
    'data: [DONE]\n\n',
  ]], async (base) => {
    const p = new GroqProvider({ apiKey: 'k', baseUrl: base });
    const tc = (await collect(p.stream(REQ))).find((e) => e.type === 'tool_calls') as any;
    assert.equal(tc.calls.length, 2);
    assert.deepEqual(tc.calls.map((c: any) => c.name), ['describe_board', 'data_time_range']);
  });
});

test('Groq: malformed tool arguments are repaired rather than thrown away', async () => {
  await withStub([[
    // Trailing comma and a markdown fence — both seen from open models.
    `data: ${JSON.stringify({ choices: [{ delta: { tool_calls: [{ index: 0, id: 'a', function: { name: 'aggregate', arguments: '```json\\n{"board":"deals","metric":"count",}\\n```' } }] } }] })}\n\n`,
    `data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'tool_calls' }] })}\n\n`,
    'data: [DONE]\n\n',
  ]], async (base) => {
    const p = new GroqProvider({ apiKey: 'k', baseUrl: base });
    const tc = (await collect(p.stream(REQ))).find((e) => e.type === 'tool_calls') as any;
    assert.deepEqual(tc.calls[0].args, { board: 'deals', metric: 'count' });
  });
});

test('Groq: tool results become individual tool-role messages', async () => {
  await withStub([[`data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' }, finish_reason: 'stop' }] })}\n\n`, 'data: [DONE]\n\n']],
  async (base, captured) => {
    const p = new GroqProvider({ apiKey: 'k', baseUrl: base });
    await collect(p.stream({
      ...REQ,
      messages: [
        { role: 'user', text: 'q' },
        { role: 'assistant', text: '', toolCalls: [{ id: 'c1', name: 'aggregate', args: { board: 'deals' } }] },
        { role: 'tool', results: [{ id: 'c1', name: 'aggregate', content: '{"total":5}', isError: false }] },
      ],
    }));
    const msgs = captured[0].body.messages;
    assert.equal(msgs[2].role, 'assistant');
    assert.equal(msgs[2].tool_calls[0].id, 'c1');
    assert.equal(msgs[3].role, 'tool');
    assert.equal(msgs[3].tool_call_id, 'c1');
  });
});

/* ── error mapping ──────────────────────────────────────────────────────── */

test('provider errors become actionable messages, not stack traces', async () => {
  const server = createServer((req, res) => {
    res.writeHead(429, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: { message: 'Resource exhausted' } }));
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as { port: number }).port;
  try {
    const p = new GeminiProvider({ apiKey: 'k', baseUrl: `http://127.0.0.1:${port}` });
    await assert.rejects(
      () => collect(p.stream(REQ)),
      (e: any) => e.name === 'LlmError' && e.recoverable === true && /rate limit/i.test(e.message),
    );
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
  }
});

/* ── the full loop, driven through a stub provider ──────────────────────── */

test('agent loop: tool call → real tool execution → second turn → answer', async (t) => {
  if (!existsSync(path.join(process.cwd(), 'data', 'mock-dataset.json'))) {
    t.skip('needs data/mock-dataset.json — run: npm run mock:build -- "<deals>.xlsx" "<work orders>.xlsx"');
    return;
  }
  let turn = 0;
  const stubProvider: LlmProvider = {
    id: 'gemini', model: 'stub', label: 'Stub',
    async *stream(req) {
      turn += 1;
      if (turn === 1) {
        yield { type: 'tool_calls', calls: [{ id: 't1', name: 'aggregate', args: { board: 'work_orders', metric: 'sum', field: 'orderValueExGst', group_by: 'sector' } }] };
        yield { type: 'done', stopReason: 'tool_calls', usage: { input: 100, output: 20 } };
        return;
      }
      // The second turn must be able to see the real tool result.
      const toolTurn = req.messages.find((m) => m.role === 'tool') as any;
      assert.ok(toolTurn, 'the tool result was not fed back to the model');
      const payload = JSON.parse(toolTurn.results[0].content);
      assert.ok(payload.total.value > 0, 'the tool returned no data');
      yield { type: 'text', delta: `Order book is ₹${(payload.total.value / 1e7).toFixed(2)} Cr.` };
      yield { type: 'done', stopReason: 'end', usage: { input: 200, output: 30 } };
    },
  };

  const events: any[] = [];
  for await (const e of runAgent([{ role: 'user', content: 'order book by sector?' }], { provider: stubProvider })) {
    events.push(e);
  }

  const started = events.find((e) => e.type === 'tool_start');
  const ended = events.find((e) => e.type === 'tool_end');
  assert.equal(started.name, 'aggregate');
  assert.equal(ended.ok, true);

  const answer = events.filter((e) => e.type === 'text').map((e) => e.delta).join('');
  assert.match(answer, /₹21\.16 Cr/, 'the answer must carry the real aggregated figure');

  const done = events.at(-1);
  assert.equal(done.type, 'done');
  assert.equal(done.turns, 2);
  assert.equal(done.usage.inputTokens, 300);
});

test('agent loop: a provider failure is surfaced, not thrown', async () => {
  const failing: LlmProvider = {
    id: 'groq', model: 'stub', label: 'Stub',
    // eslint-disable-next-line require-yield
    async *stream() {
      const { LlmError } = await import('../src/lib/agent/providers/types.ts');
      throw new LlmError('Groq rate limit reached.', { provider: 'groq', recoverable: true });
    },
  };
  const events: any[] = [];
  for await (const e of runAgent([{ role: 'user', content: 'hi' }], { provider: failing })) events.push(e);
  const err = events.find((e) => e.type === 'error');
  assert.ok(err);
  assert.equal(err.recoverable, true);
  assert.match(err.message, /rate limit/i);
});
