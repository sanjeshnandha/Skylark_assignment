#!/usr/bin/env node
/**
 * End-to-end agent check.
 *
 * Runs a set of founder-level questions through the real agent loop and prints
 * the tool calls and the answer. Use it after an import to confirm the whole
 * chain works, and after prompt changes to see whether the agent still reaches
 * for the right tools.
 *
 *   npm run smoke                    # all questions
 *   npm run smoke -- "your question" # just one
 *   DATA_SOURCE=mock npm run smoke   # without a monday.com account
 */

import { readFileSync, existsSync } from 'node:fs';
import path from 'node:path';

for (const f of ['.env.local', '.env']) {
  const p = path.join(process.cwd(), f);
  if (!existsSync(p)) continue;
  for (const line of readFileSync(p, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
  }
}

const { runAgent } = await import('../src/lib/agent/run.ts');
const { selectedProviderId, createProvider } = await import('../src/lib/agent/providers/index.ts');

const C = { dim: '\x1b[2m', bold: '\x1b[1m', green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', cyan: '\x1b[36m', reset: '\x1b[0m' };

const DEFAULT_QUESTIONS = [
  "How's our pipeline looking for the energy sector this quarter?",
  'What is our total order book and how much has actually been billed and collected?',
  'Which sectors are we winning deals in but struggling to deliver?',
  'How reliable is this data? What should I not trust?',
  'Prepare a leadership update on the business.',
];

const custom = process.argv.slice(2).filter((a) => !a.startsWith('--'));
const questions = custom.length ? custom : DEFAULT_QUESTIONS;

if (!selectedProviderId()) {
  console.error(
    `${C.red}No LLM API key is set.${C.reset} Add one to .env.local:\n` +
    `  GEMINI_API_KEY   free at aistudio.google.com\n` +
    `  GROQ_API_KEY     free at console.groq.com\n` +
    `  ANTHROPIC_API_KEY`,
  );
  process.exit(1);
}
const provider = createProvider();
console.log(`${C.dim}Model: ${provider.label}  ·  data source: ${process.env.DATA_SOURCE ?? 'live'}${C.reset}`);

let failures = 0;

for (const [i, q] of questions.entries()) {
  console.log(`\n${C.bold}${'─'.repeat(72)}${C.reset}`);
  console.log(`${C.bold}Q${i + 1}. ${q}${C.reset}\n`);

  const started = Date.now();
  let answer = '';
  let toolCount = 0;
  let errored: string | null = null;

  for await (const ev of runAgent([{ role: 'user', content: q }], { provider })) {
    if (ev.type === 'tool_start') {
      toolCount += 1;
      const args = JSON.stringify(ev.input);
      console.log(`  ${C.cyan}→ ${ev.name}${C.reset} ${C.dim}${args.slice(0, 150)}${args.length > 150 ? '…' : ''}${C.reset}`);
    }
    if (ev.type === 'tool_end' && !ev.ok) {
      console.log(`  ${C.yellow}  ! tool returned an error${C.reset}`);
    }
    if (ev.type === 'text') answer += ev.delta;
    if (ev.type === 'error') errored = ev.message;
    if (ev.type === 'done') {
      console.log(`  ${C.dim}${ev.turns} turn(s), ${ev.usage.inputTokens} in / ${ev.usage.outputTokens} out tokens${C.reset}`);
    }
  }

  console.log();
  if (errored) {
    failures += 1;
    console.log(`${C.red}ERROR: ${errored}${C.reset}`);
  } else {
    console.log(answer.trim());
  }

  // Cheap sanity checks — not a substitute for reading the answers.
  const problems: string[] = [];
  if (!errored) {
    if (toolCount === 0) problems.push('answered without calling any tool');
    if (answer.trim().length < 60) problems.push('answer suspiciously short');
    if (/\d{7,}\.\d{4,}/.test(answer)) problems.push('raw unrounded figure in the answer');
  }
  if (problems.length) {
    failures += 1;
    console.log(`\n${C.yellow}⚠ ${problems.join('; ')}${C.reset}`);
  }
  console.log(`${C.dim}${((Date.now() - started) / 1000).toFixed(1)}s · ${toolCount} tool calls${C.reset}`);
}

console.log(`\n${C.bold}${'─'.repeat(72)}${C.reset}`);
console.log(failures === 0
  ? `${C.green}✓ All ${questions.length} questions answered cleanly.${C.reset}`
  : `${C.yellow}${failures} question(s) flagged — read the output above.${C.reset}`);
process.exit(failures ? 1 : 0);
