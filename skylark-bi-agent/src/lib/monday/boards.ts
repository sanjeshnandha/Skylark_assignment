/**
 * Board discovery and column mapping.
 *
 * The agent must never hardcode column ids — they are generated when the board
 * is created and differ in every account. So we resolve boards by id when one
 * is configured, fall back to matching on board name, and then map monday's
 * column titles onto our canonical field keys with a tolerant match.
 *
 * The result is cached for the lifetime of the server process: schemas change
 * rarely and re-fetching them on every question wastes the complexity budget.
 */

import { MondayClient, MondayError } from './client.ts';
import { BOARDS, type BoardDef } from '../data/schema.ts';
import { categoryKey } from '../data/normalize.ts';

export type ColumnMeta = { id: string; title: string; type: string };

export type ResolvedBoard = {
  def: BoardDef;
  boardId: string;
  boardName: string;
  itemsCount: number | null;
  columns: ColumnMeta[];
  /** canonical field key → monday column id. `dealName` maps to the item name. */
  fieldToColumn: Record<string, string>;
  /** monday column id → canonical field key. */
  columnToField: Record<string, string>;
  /** Schema fields with no matching column on the live board. */
  missingFields: string[];
  /** Live columns we could not map back to the schema. */
  unmappedColumns: ColumnMeta[];
};

type CacheEntry = { at: number; value: ResolvedBoard };
const cache = new Map<string, CacheEntry>();
const TTL_MS = 10 * 60 * 1000;

export function clearBoardCache(): void {
  cache.clear();
}

const BOARD_QUERY = `
  query ($ids: [ID!]) {
    boards(ids: $ids) {
      id
      name
      state
      items_count
      columns { id title type }
    }
  }`;

const BOARD_LIST_QUERY = `
  query {
    boards(limit: 100, state: active, order_by: created_at) {
      id
      name
      items_count
      columns { id title type }
    }
  }`;

type RawBoard = { id: string; name: string; items_count?: number | null; columns: ColumnMeta[] };

/**
 * Titles are matched on a normalized key so that trivial edits in the monday
 * UI — a changed capital, an added space, a stray "(Masked)" — do not break
 * the mapping. Falls back to the source spreadsheet header, which is what the
 * columns are called if someone imported the sheet by hand instead of running
 * our importer.
 */
function mapColumns(def: BoardDef, columns: ColumnMeta[]) {
  const byKey = new Map<string, ColumnMeta>();
  for (const c of columns) {
    const k = categoryKey(c.title);
    if (k && !byKey.has(k)) byKey.set(k, c);
  }

  const fieldToColumn: Record<string, string> = {};
  const columnToField: Record<string, string> = {};
  const missingFields: string[] = [];
  const used = new Set<string>();

  for (const field of def.fields) {
    if (field.mondayType === 'name') {
      fieldToColumn[field.key] = 'name';
      continue;
    }
    const candidates = [field.label, field.source, field.key];
    let hit: ColumnMeta | undefined;
    for (const c of candidates) {
      const k = categoryKey(c);
      if (k && byKey.has(k)) { hit = byKey.get(k); break; }
    }
    // Last resort: a column whose title starts with the label, which catches
    // monday's habit of appending suffixes to duplicated columns.
    if (!hit) {
      const lk = categoryKey(field.label);
      if (lk) hit = columns.find((c) => categoryKey(c.title)?.startsWith(lk));
    }
    if (hit) {
      fieldToColumn[field.key] = hit.id;
      columnToField[hit.id] = field.key;
      used.add(hit.id);
    } else {
      missingFields.push(field.key);
    }
  }

  return {
    fieldToColumn,
    columnToField,
    missingFields,
    unmappedColumns: columns.filter((c) => !used.has(c.id)),
  };
}

async function fetchById(client: MondayClient, id: string): Promise<RawBoard | null> {
  const d = await client.query<{ boards: RawBoard[] }>(BOARD_QUERY, { ids: [id] });
  return d.boards?.[0] ?? null;
}

async function findByName(client: MondayClient, def: BoardDef): Promise<RawBoard | null> {
  const d = await client.query<{ boards: RawBoard[] }>(BOARD_LIST_QUERY);
  const target = categoryKey(def.boardName);
  const alt = categoryKey(def.sheetName);
  // Exact normalized match first, then a containment match so "Deal Funnel
  // (imported)" still resolves.
  return (
    d.boards.find((b) => categoryKey(b.name) === target) ??
    d.boards.find((b) => categoryKey(b.name) === alt) ??
    d.boards.find((b) => {
      const k = categoryKey(b.name);
      return Boolean(k && target && (k.includes(target) || target.includes(k)));
    }) ??
    null
  );
}

export async function resolveBoard(
  client: MondayClient,
  def: BoardDef,
  configuredId?: string,
): Promise<ResolvedBoard> {
  const cacheKey = `${def.id}:${configuredId ?? 'auto'}`;
  const hit = cache.get(cacheKey);
  if (hit && Date.now() - hit.at < TTL_MS) return hit.value;

  let raw: RawBoard | null = null;
  if (configuredId) {
    raw = await fetchById(client, configuredId);
    if (!raw) {
      throw new MondayError(
        `Board id ${configuredId} (configured for "${def.boardName}") does not exist in this account.`,
        'not_found',
      );
    }
  } else {
    raw = await findByName(client, def);
    if (!raw) {
      throw new MondayError(
        `No board named "${def.boardName}" found in this monday.com account. ` +
        `Run \`npm run import\` to create it, or set the board id explicitly.`,
        'not_found',
      );
    }
  }

  const mapped = mapColumns(def, raw.columns ?? []);
  const resolved: ResolvedBoard = {
    def,
    boardId: String(raw.id),
    boardName: raw.name,
    itemsCount: raw.items_count ?? null,
    columns: raw.columns ?? [],
    ...mapped,
  };
  cache.set(cacheKey, { at: Date.now(), value: resolved });
  return resolved;
}

export async function resolveAllBoards(
  client: MondayClient,
  ids: { deals?: string; work_orders?: string } = {},
): Promise<Record<'deals' | 'work_orders', ResolvedBoard>> {
  const [deals, workOrders] = await Promise.all([
    resolveBoard(client, BOARDS[0], ids.deals),
    resolveBoard(client, BOARDS[1], ids.work_orders),
  ]);
  return { deals, work_orders: workOrders };
}
