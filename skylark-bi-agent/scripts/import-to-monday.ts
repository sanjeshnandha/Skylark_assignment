#!/usr/bin/env node
/**
 * Creates both monday.com boards and imports the source workbooks into them.
 *
 *   npm run import:dry -- "Deal funnel Data.xlsx" "Work_Order_Tracker Data.xlsx"
 *   npm run import     -- "Deal funnel Data.xlsx" "Work_Order_Tracker Data.xlsx"
 *
 * Flags:
 *   --dry-run     parse and validate everything, make no API calls
 *   --recreate    create fresh boards even if boards with these names exist
 *   --batch=N     items per GraphQL request (default 10)
 *
 * The script is idempotent in the only sense that matters here: it refuses to
 * run against an account that already has these boards unless you say
 * --recreate, so a re-run cannot silently double every row.
 */

import { readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import path from 'node:path';
import { MondayClient, MondayError } from '../src/lib/monday/client.ts';
import { DEALS, WORK_ORDERS, type BoardDef, type FieldDef } from '../src/lib/data/schema.ts';
import { normDate, normNumber, normText, categoryKey } from '../src/lib/data/normalize.ts';
import { readBoardSheet, type SheetRow } from './read-workbook.ts';

/* ─── args & env ───────────────────────────────────────────────────────────── */

const argv = process.argv.slice(2);
const flags = new Set(argv.filter((a) => a.startsWith('--')));
const files = argv.filter((a) => !a.startsWith('--'));
const DRY = flags.has('--dry-run');
const RECREATE = flags.has('--recreate');
const BATCH = Number(argv.find((a) => a.startsWith('--batch='))?.split('=')[1] ?? 10);

loadEnv();

function loadEnv() {
  for (const f of ['.env.local', '.env']) {
    const p = path.join(process.cwd(), f);
    if (!existsSync(p)) continue;
    for (const line of readFileSync(p, 'utf8').split('\n')) {
      const m = line.match(/^\s*([A-Z_][A-Z0-9_]*)\s*=\s*(.*)$/);
      if (m && !process.env[m[1]]) process.env[m[1]] = m[2].trim().replace(/^["']|["']$/g, '');
    }
  }
}

const C = {
  reset: '\x1b[0m', dim: '\x1b[2m', bold: '\x1b[1m',
  green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', cyan: '\x1b[36m',
};
const log = (s = '') => console.log(s);
const ok = (s: string) => log(`${C.green}✓${C.reset} ${s}`);
const warn = (s: string) => log(`${C.yellow}!${C.reset} ${s}`);
const die = (s: string): never => { log(`${C.red}✗ ${s}${C.reset}`); process.exit(1); };

/* ─── locate the workbooks ─────────────────────────────────────────────────── */

function findWorkbooks(): { deals: string; wos: string } {
  if (files.length >= 2) return { deals: files[0], wos: files[1] };

  const searchDirs = [process.cwd(), path.join(process.cwd(), 'data'), path.join(process.cwd(), '..')];
  const guess = (patterns: RegExp[]) => {
    for (const dir of searchDirs) {
      try {
        for (const f of readdirSync(dir)) {
          if (patterns.some((p) => p.test(f))) return path.join(dir, f);
        }
      } catch { /* directory not readable */ }
    }
    return null;
  };
  const d = files[0] ?? guess([/deal.*funnel.*\.xlsx$/i, /deal.*\.xlsx$/i]);
  const w = files[1] ?? guess([/work.?order.*\.xlsx$/i]);
  if (!d || !w) {
    die(
      'Could not find the workbooks. Pass them explicitly:\n' +
      '  npm run import -- "Deal funnel Data.xlsx" "Work_Order_Tracker Data.xlsx"',
    );
  }
  return { deals: d!, wos: w! };
}

/* ─── column value encoding ────────────────────────────────────────────────── */

/**
 * Converts a spreadsheet cell into monday's column-value JSON.
 *
 * Returns `undefined` for anything unusable so the key is omitted entirely —
 * monday treats an explicit empty string differently from an absent key on
 * some column types, and omitting is the safer of the two.
 */
function encode(field: FieldDef, value: unknown): unknown | undefined {
  switch (field.mondayType) {
    case 'name':
      return undefined; // carried as item_name

    case 'date': {
      const d = normDate(value);
      return d.value ? { date: d.value } : undefined;
    }

    case 'numbers': {
      const n = normNumber(value);
      return n.value === null ? undefined : String(n.value);
    }

    case 'status': {
      const t = normText(value);
      if (t.value === null) return undefined;
      // monday rejects labels over 40 characters on status columns.
      return { label: t.value.slice(0, 40) };
    }

    case 'dropdown': {
      const t = normText(value);
      if (t.value === null) return undefined;
      return { labels: [t.value.slice(0, 60)] };
    }

    case 'text':
    default: {
      const t = normText(value);
      return t.value === null ? undefined : t.value;
    }
  }
}

/** Rows that are repeated headers rather than data — see records.ts. */
function isHeaderEcho(def: BoardDef, values: Record<string, unknown>): boolean {
  let hits = 0;
  for (const f of def.fields) {
    const v = values[f.key];
    if (v === null || v === undefined) continue;
    if (categoryKey(String(v)) && categoryKey(String(v)) === categoryKey(f.source)) hits += 1;
    if (hits >= 2) return true;
  }
  return false;
}

/* ─── monday operations ────────────────────────────────────────────────────── */

async function findExistingBoard(client: MondayClient, name: string): Promise<string | null> {
  const d = await client.query<{ boards: Array<{ id: string; name: string }> }>(
    `query { boards(limit: 100, state: active) { id name } }`,
  );
  const hit = d.boards.find((b) => categoryKey(b.name) === categoryKey(name));
  return hit ? String(hit.id) : null;
}

async function createBoard(client: MondayClient, def: BoardDef): Promise<string> {
  const d = await client.query<{ create_board: { id: string } }>(
    `mutation ($name: String!) {
       create_board(board_name: $name, board_kind: public, description: $desc) { id }
     }`.replace('$desc', JSON.stringify(def.description.slice(0, 480))),
    { name: def.boardName },
  );
  return String(d.create_board.id);
}

/** Boards are created with sample items and default columns; clear them out. */
async function tidyNewBoard(client: MondayClient, boardId: string): Promise<void> {
  const d = await client.query<{
    boards: Array<{ items_page: { items: Array<{ id: string }> }; columns: Array<{ id: string; title: string; type: string }> }>;
  }>(
    `query ($id: ID!) {
       boards(ids: [$id]) {
         items_page(limit: 50) { items { id } }
         columns { id title type }
       }
     }`,
    { id: boardId },
  );
  const board = d.boards?.[0];
  if (!board) return;

  for (const item of board.items_page?.items ?? []) {
    try {
      await client.query(`mutation ($id: ID!) { delete_item(item_id: $id) { id } }`, { id: item.id });
    } catch { /* a sample item that will not delete is harmless */ }
  }

  // Remove monday's stock columns so the board reads as a clean import.
  for (const col of board.columns ?? []) {
    if (col.id === 'name' || col.type === 'subtasks') continue;
    try {
      await client.query(
        `mutation ($b: ID!, $c: String!) { delete_column(board_id: $b, column_id: $c) { id } }`,
        { b: boardId, c: col.id },
      );
    } catch { /* undeletable stock column — the mapper ignores it anyway */ }
  }
}

async function createColumns(client: MondayClient, boardId: string, def: BoardDef): Promise<Record<string, string>> {
  const map: Record<string, string> = {};
  for (const field of def.fields) {
    if (field.mondayType === 'name') { map[field.key] = 'name'; continue; }
    const d = await client.query<{ create_column: { id: string } }>(
      `mutation ($b: ID!, $t: String!, $ct: ColumnType!, $desc: String) {
         create_column(board_id: $b, title: $t, column_type: $ct, description: $desc) { id }
       }`,
      { b: boardId, t: field.label, ct: field.mondayType, desc: field.description.slice(0, 480) },
    );
    map[field.key] = String(d.create_column.id);
    process.stdout.write(`${C.dim}.${C.reset}`);
  }
  log('');
  return map;
}

/**
 * Items are created in batches of aliased mutations. One request per item
 * would take ~500 requests and hit the rate limit; one giant request would
 * blow the complexity budget. Ten is comfortably inside both.
 */
async function importRows(
  client: MondayClient,
  boardId: string,
  def: BoardDef,
  rows: SheetRow[],
  colMap: Record<string, string>,
): Promise<{ created: number; failed: Array<{ row: number; error: string }> }> {
  let created = 0;
  const failed: Array<{ row: number; error: string }> = [];
  const nameField = def.fields.find((f) => f.mondayType === 'name')!;

  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const parts: string[] = [];
    const vars: Record<string, unknown> = { b: boardId };

    batch.forEach((row, j) => {
      const colVals: Record<string, unknown> = {};
      for (const field of def.fields) {
        if (field.mondayType === 'name') continue;
        const enc = encode(field, row.values[field.key]);
        if (enc !== undefined) colVals[colMap[field.key]] = enc;
      }
      const nameRaw = normText(row.values[nameField.key]).value ?? `Row ${row.rowNumber}`;
      vars[`n${j}`] = nameRaw.slice(0, 250);
      vars[`v${j}`] = JSON.stringify(colVals);
      parts.push(
        `i${j}: create_item(board_id: $b, item_name: $n${j}, column_values: $v${j}, create_labels_if_missing: true) { id }`,
      );
    });

    const decls = ['$b: ID!', ...batch.map((_, j) => `$n${j}: String!, $v${j}: JSON!`)].join(', ');
    try {
      await client.query(`mutation (${decls}) { ${parts.join(' ')} }`, vars);
      created += batch.length;
    } catch (err) {
      // One bad row must not lose the other nine — fall back to one at a time.
      for (const row of batch) {
        const colVals: Record<string, unknown> = {};
        for (const field of def.fields) {
          if (field.mondayType === 'name') continue;
          const enc = encode(field, row.values[field.key]);
          if (enc !== undefined) colVals[colMap[field.key]] = enc;
        }
        try {
          await client.query(
            `mutation ($b: ID!, $n: String!, $v: JSON!) {
               create_item(board_id: $b, item_name: $n, column_values: $v, create_labels_if_missing: true) { id }
             }`,
            {
              b: boardId,
              n: (normText(row.values[nameField.key]).value ?? `Row ${row.rowNumber}`).slice(0, 250),
              v: JSON.stringify(colVals),
            },
          );
          created += 1;
        } catch (e2) {
          failed.push({ row: row.rowNumber, error: (e2 as Error).message.slice(0, 160) });
        }
      }
    }
    const pct = Math.round(((i + batch.length) / rows.length) * 100);
    process.stdout.write(`\r  ${C.dim}${created}/${rows.length} items (${pct}%)${C.reset}   `);
  }
  log('');
  return { created, failed };
}

/* ─── main ─────────────────────────────────────────────────────────────────── */

async function main() {
  log(`${C.bold}Skylark BI — monday.com importer${C.reset}`);
  log(`${C.dim}${'─'.repeat(58)}${C.reset}`);

  const wb = findWorkbooks();
  log(`Deals workbook       ${C.cyan}${wb.deals}${C.reset}`);
  log(`Work orders workbook ${C.cyan}${wb.wos}${C.reset}`);
  log();

  const plan: Array<{ def: BoardDef; file: string; rows: SheetRow[]; skipped: number }> = [];
  for (const [def, file] of [[DEALS, wb.deals], [WORK_ORDERS, wb.wos]] as const) {
    const all = await readBoardSheet(file, def);
    const rows = all.filter((r) => !isHeaderEcho(def, r.values));
    const skipped = all.length - rows.length;
    plan.push({ def, file, rows, skipped });
    ok(`${def.boardName}: ${rows.length} rows ready, ${def.fields.length} columns` +
       (skipped ? ` ${C.yellow}(${skipped} repeated-header row${skipped > 1 ? 's' : ''} skipped)${C.reset}` : ''));
  }
  log();

  if (DRY) {
    log(`${C.bold}Dry run — nothing was sent to monday.com.${C.reset}`);
    for (const p of plan) {
      log(`\n${C.bold}${p.def.boardName}${C.reset}`);
      for (const f of p.def.fields) {
        const sample = p.rows.slice(0, 400).map((r) => encode(f, r.values[f.key])).filter((v) => v !== undefined);
        const pct = Math.round((sample.length / Math.min(400, p.rows.length)) * 100);
        log(`  ${f.label.padEnd(36)} ${C.dim}${f.mondayType.padEnd(9)} ${String(pct).padStart(3)}% populated${C.reset}`);
      }
    }
    log(`\nRun without --dry-run to create the boards.`);
    return;
  }

  const token = process.env.MONDAY_API_TOKEN?.trim();
  if (!token) die('MONDAY_API_TOKEN is not set. Put it in .env.local (see .env.example).');

  const client = new MondayClient({
    token: token!,
    onRetry: ({ attempt, waitMs, reason }) =>
      warn(`monday.com ${reason} — retry ${attempt} in ${Math.round(waitMs / 1000)}s`),
  });

  let me;
  try {
    me = await client.me();
  } catch (err) {
    die(err instanceof MondayError ? err.userMessage : String(err));
  }
  ok(`Connected as ${C.bold}${me!.name}${C.reset} — account "${me!.account.name}"`);
  log();

  const created: Record<string, string> = {};

  for (const p of plan) {
    const existing = await findExistingBoard(client, p.def.boardName);
    if (existing && !RECREATE) {
      die(
        `A board named "${p.def.boardName}" already exists (id ${existing}).\n` +
        `  • To reuse it, put the id in .env.local and skip the import.\n` +
        `  • To import again into a NEW board, re-run with --recreate.\n` +
        `  Refusing to continue so the existing board is not duplicated.`,
      );
    }

    log(`${C.bold}${p.def.boardName}${C.reset}`);
    const boardId = await createBoard(client, p.def);
    ok(`board created — id ${C.bold}${boardId}${C.reset}`);

    await tidyNewBoard(client, boardId);
    process.stdout.write(`  creating ${p.def.fields.length - 1} columns `);
    const colMap = await createColumns(client, boardId, p.def);
    ok(`columns created`);

    const { created: n, failed } = await importRows(client, boardId, p.def, p.rows, colMap);
    if (failed.length) {
      warn(`${failed.length} row(s) failed:`);
      failed.slice(0, 5).forEach((f) => log(`    row ${f.row}: ${C.dim}${f.error}${C.reset}`));
    }
    ok(`${n}/${p.rows.length} items imported`);
    log(`  ${C.dim}https://${me!.account.slug}.monday.com/boards/${boardId}${C.reset}`);
    log();

    created[p.def.id] = boardId;
  }

  // Persist the ids so the app resolves boards directly instead of by name.
  const envPath = path.join(process.cwd(), '.env.local');
  let env = existsSync(envPath) ? readFileSync(envPath, 'utf8') : '';
  const set = (k: string, v: string) => {
    env = new RegExp(`^${k}=.*$`, 'm').test(env)
      ? env.replace(new RegExp(`^${k}=.*$`, 'm'), `${k}=${v}`)
      : `${env.replace(/\n*$/, '\n')}${k}=${v}\n`;
  };
  set('MONDAY_DEALS_BOARD_ID', created.deals);
  set('MONDAY_WORK_ORDERS_BOARD_ID', created.work_orders);
  writeFileSync(envPath, env, 'utf8');

  log(`${C.dim}${'─'.repeat(58)}${C.reset}`);
  ok(`Board ids written to .env.local`);
  log(`  MONDAY_DEALS_BOARD_ID=${created.deals}`);
  log(`  MONDAY_WORK_ORDERS_BOARD_ID=${created.work_orders}`);
  log(`\n${C.bold}Next:${C.reset} npm run dev  →  http://localhost:3000`);
  log(`  ${C.dim}API calls used: ${client.stats.requests} (${client.stats.retries} retries)${C.reset}`);
}

main().catch((err) => {
  log(`\n${C.red}Import failed:${C.reset} ${err instanceof MondayError ? err.userMessage : String(err?.message ?? err)}`);
  if (err instanceof MondayError && err.detail) log(`${C.dim}${JSON.stringify(err.detail).slice(0, 400)}${C.reset}`);
  process.exit(1);
});
