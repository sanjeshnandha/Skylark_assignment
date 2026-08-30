/**
 * Paginated item fetching.
 *
 * monday returns items through a cursor (`items_page`). Boards here are small
 * — a few hundred rows — so a whole board is fetched and cached for a short
 * window, and all filtering happens in process. That is a deliberate trade:
 * monday's server-side query language cannot express most of what a founder
 * asks (cross-board joins, coverage-aware aggregation, derived fields), and
 * paying one 300-row fetch per cache window is far cheaper than issuing a new
 * API call for every filter permutation the agent explores mid-conversation.
 */

import { MondayClient } from './client.ts';
import type { ResolvedBoard } from './boards.ts';
import { buildRecords, type RawRow, type Record_ } from '../data/records.ts';

const ITEMS_QUERY = `
  query ($boardId: ID!, $limit: Int!, $cursor: String) {
    boards(ids: [$boardId]) {
      items_page(limit: $limit, cursor: $cursor) {
        cursor
        items {
          id
          name
          column_values {
            id
            type
            text
            value
          }
        }
      }
    }
  }`;

type RawItem = {
  id: string;
  name: string;
  column_values: Array<{ id: string; type: string; text: string | null; value: string | null }>;
};

/**
 * Extracts a usable JS value from a monday column.
 *
 * `text` is monday's own rendering and is right for statuses and dropdowns.
 * `value` is the raw JSON and is the only reliable source for dates (which
 * render locale-dependently) and numbers (which render with separators). We
 * take the structured one where it exists and fall back to text.
 */
function extract(cv: RawItem['column_values'][number]): unknown {
  const { type, text, value } = cv;

  if (value) {
    try {
      const parsed = JSON.parse(value) as unknown;
      if (parsed !== null) {
        if (type === 'date' && typeof parsed === 'object' && parsed && 'date' in parsed) {
          const d = (parsed as { date?: string | null }).date;
          return d ?? null;
        }
        if (type === 'numbers') {
          if (typeof parsed === 'number') return parsed;
          if (typeof parsed === 'string' && parsed.trim() !== '') {
            const n = Number(parsed);
            return Number.isFinite(n) ? n : parsed;
          }
          return null;
        }
        if (type === 'dropdown' && typeof parsed === 'object' && parsed && 'ids' in parsed) {
          return text ?? null; // label text is what we want, ids are meaningless here
        }
      }
    } catch {
      // Fall through to text.
    }
  }

  if (text === null || text === undefined || text === '') return null;
  return text;
}

const pageCache = new Map<string, { at: number; rows: RawRow[] }>();
const PAGE_TTL_MS = 60 * 1000;

export function clearItemCache(): void {
  pageCache.clear();
}

export async function fetchRawRows(
  client: MondayClient,
  board: ResolvedBoard,
  opts: { pageSize?: number; maxItems?: number; force?: boolean } = {},
): Promise<RawRow[]> {
  const key = board.boardId;
  const cached = pageCache.get(key);
  if (!opts.force && cached && Date.now() - cached.at < PAGE_TTL_MS) return cached.rows;

  const pageSize = opts.pageSize ?? 250;
  const maxItems = opts.maxItems ?? 5000;
  const rows: RawRow[] = [];
  let cursor: string | null = null;

  do {
    const d: { boards: Array<{ items_page: { cursor: string | null; items: RawItem[] } }> } =
      await client.query(ITEMS_QUERY, { boardId: board.boardId, limit: pageSize, cursor });

    const page = d.boards?.[0]?.items_page;
    if (!page) break;

    for (const item of page.items) {
      const values: Record<string, unknown> = {};
      // The item name carries the deal name on both boards.
      for (const [fieldKey, colId] of Object.entries(board.fieldToColumn)) {
        if (colId === 'name') values[fieldKey] = item.name;
      }
      for (const cv of item.column_values) {
        const fieldKey = board.columnToField[cv.id];
        if (!fieldKey) continue;
        values[fieldKey] = extract(cv);
      }
      rows.push({ id: item.id, values });
    }

    cursor = page.cursor;
  } while (cursor && rows.length < maxItems);

  pageCache.set(key, { at: Date.now(), rows });
  return rows;
}

export async function fetchRecords(
  client: MondayClient,
  board: ResolvedBoard,
  opts: { force?: boolean } = {},
): Promise<{ records: Record_[]; excluded: Record_[]; fetched: number }> {
  const rows = await fetchRawRows(client, board, opts);
  const { records, excluded } = buildRecords(board.def, rows);
  return { records, excluded, fetched: rows.length };
}
