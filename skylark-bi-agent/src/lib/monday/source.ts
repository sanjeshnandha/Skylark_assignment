/**
 * The single seam between "where the data comes from" and everything above it.
 *
 * `live` is the real thing and the default: every question issues real GraphQL
 * against the configured monday.com account. `mock` replays the source
 * spreadsheets through this identical interface and exists purely so the query
 * engine, the MCP tools and the agent loop can be tested without an account or
 * a network. Nothing above this file can tell the difference, which is exactly
 * why the tests are worth anything.
 *
 * The hosted demo runs `live`. See DECISION_LOG.md.
 */

import { MondayClient, MondayError } from './client.ts';
import { resolveBoard, type ResolvedBoard } from './boards.ts';
import { fetchRecords, clearItemCache } from './fetch.ts';
import { DEALS, WORK_ORDERS, type BoardDef } from '../data/schema.ts';
import { buildRecords, type Record_ } from '../data/records.ts';
import { loadMockRows } from '../mock/mock-monday.ts';

export type BoardId = 'deals' | 'work_orders';

export type BoardData = {
  boardId: string;
  boardName: string;
  def: BoardDef;
  records: Record_[];
  excluded: Record_[];
  /** Where these rows came from, surfaced in the UI so a demo is never mistaken for live data. */
  source: 'live' | 'mock';
  missingFields: string[];
  fetchedAt: string;
};

export interface DataSource {
  readonly kind: 'live' | 'mock';
  getBoard(id: BoardId, opts?: { force?: boolean }): Promise<BoardData>;
  describe(): Promise<{ kind: string; account?: string; boards: Array<{ id: string; name: string; boardId: string; items: number }> }>;
}

/* ─── Live ─────────────────────────────────────────────────────────────────── */

class LiveSource implements DataSource {
  readonly kind = 'live' as const;
  private client: MondayClient;
  private ids: Partial<Record<BoardId, string>>;
  private resolved = new Map<BoardId, ResolvedBoard>();

  constructor(token: string, ids: Partial<Record<BoardId, string>>) {
    this.client = new MondayClient({ token });
    this.ids = ids;
  }

  private def(id: BoardId): BoardDef {
    return id === 'deals' ? DEALS : WORK_ORDERS;
  }

  private async board(id: BoardId): Promise<ResolvedBoard> {
    const cached = this.resolved.get(id);
    if (cached) return cached;
    const r = await resolveBoard(this.client, this.def(id), this.ids[id] || undefined);
    this.resolved.set(id, r);
    return r;
  }

  async getBoard(id: BoardId, opts: { force?: boolean } = {}): Promise<BoardData> {
    const board = await this.board(id);
    const { records, excluded } = await fetchRecords(this.client, board, opts);
    return {
      boardId: board.boardId,
      boardName: board.boardName,
      def: board.def,
      records,
      excluded,
      source: 'live',
      missingFields: board.missingFields,
      fetchedAt: new Date().toISOString(),
    };
  }

  async describe() {
    const me = await this.client.me();
    const boards = await Promise.all(
      (['deals', 'work_orders'] as BoardId[]).map(async (id) => {
        const b = await this.board(id);
        return { id, name: b.boardName, boardId: b.boardId, items: b.itemsCount ?? 0 };
      }),
    );
    return { kind: 'live monday.com', account: `${me.account.name} (${me.name})`, boards };
  }
}

/* ─── Mock ─────────────────────────────────────────────────────────────────── */

class MockSource implements DataSource {
  readonly kind = 'mock' as const;

  async getBoard(id: BoardId): Promise<BoardData> {
    const def = id === 'deals' ? DEALS : WORK_ORDERS;
    const rows = await loadMockRows(id);
    const { records, excluded } = buildRecords(def, rows);
    return {
      boardId: `mock-${id}`,
      boardName: def.boardName,
      def,
      records,
      excluded,
      source: 'mock',
      missingFields: [],
      fetchedAt: new Date().toISOString(),
    };
  }

  async describe() {
    // Report the usable row count, not the raw sheet length, so the count the
    // UI shows matches the count the agent actually reasons over — a live
    // board would not contain the repeated header rows either.
    const boards = await Promise.all(
      (['deals', 'work_orders'] as BoardId[]).map(async (id) => {
        const b = await this.getBoard(id);
        return { id, name: b.boardName, boardId: b.boardId, items: b.records.length };
      }),
    );
    return { kind: 'offline replay of the source spreadsheets (test mode)', boards };
  }
}

/* ─── Factory ──────────────────────────────────────────────────────────────── */

let cached: DataSource | null = null;

export function getDataSource(): DataSource {
  if (cached) return cached;

  const mode = (process.env.DATA_SOURCE ?? 'live').toLowerCase();
  if (mode === 'mock') {
    cached = new MockSource();
    return cached;
  }

  const token = process.env.MONDAY_API_TOKEN?.trim();
  if (!token) {
    throw new MondayError(
      'MONDAY_API_TOKEN is not set. Add it to .env.local (or your deployment environment), ' +
      'or set DATA_SOURCE=mock to run against the offline replay.',
      'auth',
    );
  }
  cached = new LiveSource(token, {
    deals: process.env.MONDAY_DEALS_BOARD_ID?.trim() || undefined,
    work_orders: process.env.MONDAY_WORK_ORDERS_BOARD_ID?.trim() || undefined,
  });
  return cached;
}

export function resetDataSource(): void {
  cached = null;
  clearItemCache();
}
