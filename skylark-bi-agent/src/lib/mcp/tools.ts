/**
 * The MCP tool surface.
 *
 * These definitions are the single source of truth for both transports: the
 * hosted MCP endpoint at /api/mcp and the in-process path the chat agent uses.
 * Same handlers, same schemas, so anything that works in Claude Desktop works
 * in the web UI and vice versa.
 *
 * Design principle: the tools are *analytical*, not a thin GraphQL wrapper.
 * A founder question rarely maps to "fetch rows" — it maps to "aggregate this
 * metric over that slice and tell me what's missing". Pushing that into the
 * tool layer keeps the model from having to do arithmetic in its head, which
 * is where BI agents usually start inventing numbers.
 */

import { getDataSource, type BoardId } from '../monday/source.ts';
import { DEALS, WORK_ORDERS, boardById, numericFields, groupableFields, dateFields, type BoardDef } from '../data/schema.ts';
import { applyFilters, searchRecords, type Filter } from '../data/filter.ts';
import { aggregate, type Metric } from '../data/aggregate.ts';
import { boardQuality, caveatsFor } from '../data/quality.ts';
import { flatten, type Record_ } from '../data/records.ts';
import { resolvePeriod, PERIOD_EXPRESSIONS, toISO } from '../data/dates.ts';
import { categoryKey } from '../data/normalize.ts';
import { MondayError } from '../monday/client.ts';

export type ToolDef = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<unknown>;
};

/* ─── shared schema fragments ──────────────────────────────────────────────── */

const boardEnum = { type: 'string', enum: ['deals', 'work_orders'] };

const filterSchema = {
  type: 'array',
  description:
    'Filters combined with AND. A row whose value for the filtered field is missing NEVER matches a comparison filter — use is_null to find those deliberately.',
  items: {
    type: 'object',
    properties: {
      field: {
        type: 'string',
        description: 'Canonical field key from describe_board, or a derived key prefixed with "d." (e.g. d.isOpen, d.isSlipping, d.billedPct).',
      },
      op: {
        type: 'string',
        enum: ['eq', 'neq', 'in', 'not_in', 'contains', 'starts_with', 'gt', 'gte', 'lt', 'lte', 'between', 'is_null', 'is_not_null', 'is_true', 'is_false', 'in_period', 'before', 'after'],
      },
      value: { description: 'Comparison value. For in/not_in pass an array. For in_period pass a period expression.' },
      value2: { description: 'Upper bound, for the between operator.' },
    },
    required: ['field', 'op'],
  },
};

/* ─── helpers ──────────────────────────────────────────────────────────────── */

async function loadBoard(id: BoardId) {
  const src = getDataSource();
  return src.getBoard(id);
}

function asBoardId(v: unknown): BoardId {
  const s = String(v ?? '').toLowerCase();
  if (s === 'deals' || s === 'deal' || s === 'deal_funnel') return 'deals';
  if (s === 'work_orders' || s === 'work_order' || s === 'workorders' || s === 'wo') return 'work_orders';
  throw new Error(`Unknown board "${String(v)}". Use "deals" or "work_orders".`);
}

function fieldsUsedIn(filters: Filter[], extra: (string | null | undefined)[]): string[] {
  const s = new Set<string>();
  for (const f of filters) if (!f.field.startsWith('d.')) s.add(f.field);
  for (const e of extra) if (e && !e.startsWith('d.')) s.add(e);
  return [...s];
}


/**
 * Explains an empty or suspicious result instead of returning a bare zero.
 *
 * The source data runs to roughly April 2026 while the agent runs against
 * today's date, so a perfectly reasonable question ("how does this quarter
 * look?") can legitimately match nothing. A BI agent that answers "₹0" there
 * is worse than useless — it looks like a business collapse rather than a
 * gap in the records. This computes the actual populated range of every date
 * field that was filtered on, so the agent can say what the data does cover.
 */
function explainDateCoverage(
  allRecords: Record_[],
  filters: Filter[],
): { field: string; earliest: string | null; latest: string | null; populated: number }[] {
  const dateFilterFields = [...new Set(
    filters
      .filter((f) => ['in_period', 'before', 'after', 'between', 'gt', 'gte', 'lt', 'lte'].includes(f.op))
      .map((f) => f.field)
      .filter((f) => !f.startsWith('d.')),
  )];

  return dateFilterFields.map((field) => {
    const values = allRecords
      .map((r) => r.f[field]?.value)
      .filter((v): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v))
      .sort();
    return {
      field,
      earliest: values[0] ?? null,
      latest: values[values.length - 1] ?? null,
      populated: values.length,
    };
  }).filter((c) => c.populated > 0);
}

/* ─── tools ────────────────────────────────────────────────────────────────── */

export const TOOLS: ToolDef[] = [
  /* ── 1. connection & board discovery ─────────────────────────────────────── */
  {
    name: 'list_boards',
    description:
      'Confirms the monday.com connection and lists the two boards available with their live row counts. Call this first if a later tool reports a connection or board problem.',
    inputSchema: { type: 'object', properties: {} },
    handler: async () => {
      const src = getDataSource();
      const info = await src.describe();
      return {
        connection: info.kind,
        account: info.account ?? null,
        boards: info.boards,
        note: src.kind === 'mock'
          ? 'Running against the offline spreadsheet replay (test mode), not a live monday.com account.'
          : 'Live monday.com data.',
      };
    },
  },

  /* ── 2. schema ───────────────────────────────────────────────────────────── */
  {
    name: 'describe_board',
    description:
      'Returns the full field dictionary for a board: every field key, what it means, how completely it is populated in the source, and which fields are safe to group by, sum, or filter on dates. ALWAYS call this before querying a board you have not yet described in this conversation — the field notes carry the data-quality warnings you must pass on to the user.',
    inputSchema: {
      type: 'object',
      properties: { board: boardEnum },
      required: ['board'],
    },
    handler: async (args) => {
      const id = asBoardId(args.board);
      const def = boardById(id)!;
      const data = await loadBoard(id);
      return {
        board: id,
        boardName: data.boardName,
        description: def.description,
        rowCount: data.records.length,
        excludedRows: data.excluded.length,
        source: data.source,
        fields: def.fields.map((f) => ({
          key: f.key,
          label: f.label,
          type: f.kind,
          populatedPct: f.sourceFill,
          unusable: Boolean(f.unusable),
          description: f.description,
        })),
        derivedFields: id === 'deals' ? DERIVED_DEALS : DERIVED_WORK_ORDERS,
        groupableFields: groupableFields(def).map((f) => f.key),
        numericFields: numericFields(def).map((f) => f.key),
        dateFields: dateFields(def).map((f) => f.key),
        periodExpressions: PERIOD_EXPRESSIONS,
        missingOnLiveBoard: data.missingFields,
      };
    },
  },

  /* ── 3. aggregation — the workhorse ──────────────────────────────────────── */
  {
    name: 'aggregate',
    description:
      'The primary analysis tool. Filters rows, then computes a metric, optionally grouped by a field. Use this for anything numeric — pipeline totals, revenue by sector, deal counts by stage, average order value, receivables by owner. It returns per-group coverage (how many rows actually had a value) and explicit caveats. Prefer this over fetching rows and adding them up yourself: the coverage numbers it returns are what make the answer honest.',
    inputSchema: {
      type: 'object',
      properties: {
        board: boardEnum,
        metric: {
          type: 'string',
          enum: ['sum', 'avg', 'count', 'count_distinct', 'min', 'max', 'median', 'p90'],
          description: 'count needs no field; every other metric does.',
        },
        field: { type: 'string', description: 'Numeric field key to aggregate, e.g. dealValue or orderValueExGst.' },
        group_by: { type: 'string', description: 'Field key to group by, e.g. sector, dealStage, ownerCode, d.poQuarter.' },
        filters: filterSchema,
        limit: { type: 'integer', description: 'Max groups to return. Default 25.' },
        sort: { type: 'string', enum: ['value_desc', 'value_asc', 'group_asc', 'count_desc'], description: 'Default value_desc.' },
      },
      required: ['board', 'metric'],
    },
    handler: async (args) => {
      const id = asBoardId(args.board);
      const def = boardById(id)!;
      const data = await loadBoard(id);
      const filters = (args.filters as Filter[] | undefined) ?? [];

      const { matched, notes } = applyFilters(data.records, filters);
      const result = aggregate(matched, {
        metric: args.metric as Metric,
        field: (args.field as string) ?? null,
        groupBy: (args.group_by as string) ?? null,
        limit: (args.limit as number) ?? 25,
        sort: args.sort as 'value_desc' | undefined,
      });

      const fieldCaveats = caveatsFor(matched, fieldsUsedIn(filters, [args.field as string]), def);

      const coverage = explainDateCoverage(data.records, filters);
      const extra: string[] = [];
      if (matched.length === 0 && coverage.length) {
        for (const c of coverage) {
          extra.push(
            `No rows matched. The "${c.field}" values that ARE recorded run from ${c.earliest} to ${c.latest} ` +
            `(${c.populated} of ${data.records.length} rows). This is a gap in the data, not a business result of zero — ` +
            `say so, and offer the nearest period that does have data.`,
          );
        }
      }

      return {
        board: id,
        metric: result.metric,
        field: result.field,
        groupBy: result.groupBy,
        rowsConsidered: data.records.length,
        rowsMatched: matched.length,
        total: result.total,
        groups: result.rows,
        periodNotes: notes,
        dateCoverage: coverage.length ? coverage : undefined,
        caveats: [...result.caveats, ...fieldCaveats, ...extra],
      };
    },
  },

  /* ── 4. row-level retrieval ──────────────────────────────────────────────── */
  {
    name: 'query_records',
    description:
      'Returns individual rows matching filters. Use when the user wants to see specific deals or work orders ("which deals are slipping", "list the top 5 by value"), not when they want a total — use aggregate for totals. Keep `fields` narrow; requesting every column on many rows wastes context for no benefit.',
    inputSchema: {
      type: 'object',
      properties: {
        board: boardEnum,
        filters: filterSchema,
        fields: { type: 'array', items: { type: 'string' }, description: 'Field keys to return. Defaults to a sensible summary set.' },
        sort_by: { type: 'string', description: 'Field key to sort on.' },
        sort_dir: { type: 'string', enum: ['asc', 'desc'] },
        limit: { type: 'integer', description: 'Default 20, max 100.' },
      },
      required: ['board'],
    },
    handler: async (args) => {
      const id = asBoardId(args.board);
      const def = boardById(id)!;
      const data = await loadBoard(id);
      const filters = (args.filters as Filter[] | undefined) ?? [];
      const { matched, notes } = applyFilters(data.records, filters);

      const sortBy = args.sort_by as string | undefined;
      const dir = (args.sort_dir as string) === 'asc' ? 1 : -1;
      const sorted = sortBy
        ? [...matched].sort((a, b) => {
            const av = sortBy.startsWith('d.') ? a.d[sortBy.slice(2)] : a.f[sortBy]?.value;
            const bv = sortBy.startsWith('d.') ? b.d[sortBy.slice(2)] : b.f[sortBy]?.value;
            if (av === null || av === undefined) return 1;   // nulls always last
            if (bv === null || bv === undefined) return -1;
            if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
            return String(av).localeCompare(String(bv)) * dir;
          })
        : matched;

      const limit = Math.min(Number(args.limit ?? 20), 100);
      const wanted = (args.fields as string[] | undefined) ?? defaultFields(id);
      const rows = sorted.slice(0, limit).map((r) => {
        const flat = flatten(r);
        const out: Record<string, unknown> = {};
        for (const k of wanted) if (flat[k] !== undefined) out[k] = flat[k];
        return out;
      });

      const cov = explainDateCoverage(data.records, filters);
      const covNotes = matched.length === 0
        ? cov.map((c) => `No rows matched. Recorded "${c.field}" values run ${c.earliest} to ${c.latest}.`)
        : [];

      return {
        board: id,
        matched: matched.length,
        returned: rows.length,
        truncated: matched.length > rows.length,
        rows,
        periodNotes: notes,
        dateCoverage: cov.length ? cov : undefined,
        caveats: [...caveatsFor(sorted.slice(0, limit), fieldsUsedIn(filters, wanted), def), ...covNotes],
      };
    },
  },

  /* ── 5. cross-board ──────────────────────────────────────────────────────── */
  {
    name: 'cross_board_summary',
    description:
      'Answers questions that span both boards — how pipeline compares to work in execution, whether a sector wins deals but underdelivers, how a named owner looks end to end. Joins on the only two keys that are actually shared: masked deal name and owner code. Client codes are masked differently on the two boards and CANNOT be joined; this tool will tell you so rather than producing a wrong join.',
    inputSchema: {
      type: 'object',
      properties: {
        join_on: { type: 'string', enum: ['sector', 'ownerCode', 'dealName'], description: 'Dimension to align the two boards on.' },
        deal_filters: filterSchema,
        work_order_filters: filterSchema,
        metrics: {
          type: 'array',
          items: { type: 'string', enum: ['deal_count', 'deal_value', 'open_pipeline', 'won_count', 'wo_count', 'order_value', 'billed_value', 'receivable'] },
          description: 'Defaults to a standard set covering pipeline and execution.',
        },
      },
      required: ['join_on'],
    },
    handler: async (args) => {
      const joinOn = String(args.join_on);
      const [deals, wos] = await Promise.all([loadBoard('deals'), loadBoard('work_orders')]);

      const d = applyFilters(deals.records, (args.deal_filters as Filter[]) ?? []);
      const w = applyFilters(wos.records, (args.work_order_filters as Filter[]) ?? []);

      const keyOf = (r: Record_): string => {
        const v = r.f[joinOn]?.value;
        return v === null || v === undefined ? '(not recorded)' : String(v);
      };

      const groups = new Map<string, { deals: Record_[]; wos: Record_[] }>();
      for (const r of d.matched) {
        const k = keyOf(r);
        if (!groups.has(k)) groups.set(k, { deals: [], wos: [] });
        groups.get(k)!.deals.push(r);
      }
      for (const r of w.matched) {
        const k = keyOf(r);
        if (!groups.has(k)) groups.set(k, { deals: [], wos: [] });
        groups.get(k)!.wos.push(r);
      }

      const sum = (rs: Record_[], k: string) =>
        Math.round(rs.reduce((a, r) => a + (typeof r.f[k]?.value === 'number' ? (r.f[k].value as number) : 0), 0));

      const rows = [...groups.entries()].map(([group, g]) => ({
        group,
        deal_count: g.deals.length,
        deal_value: sum(g.deals, 'dealValue'),
        open_pipeline: sum(g.deals.filter((r) => r.d.isOpen === true), 'dealValue'),
        won_count: g.deals.filter((r) => r.d.isWon === true).length,
        wo_count: g.wos.length,
        order_value: sum(g.wos, 'orderValueExGst'),
        billed_value: sum(g.wos, 'billedIncGst'),
        receivable: sum(g.wos, 'receivable'),
        /** Present on one board only — usually meaningful, not a bug. */
        presence: g.deals.length && g.wos.length ? 'both' : g.deals.length ? 'pipeline only' : 'execution only',
      })).sort((a, b) => (b.order_value + b.deal_value) - (a.order_value + a.deal_value));

      const caveats: string[] = [];
      if (joinOn === 'dealName') {
        const onlyWo = rows.filter((r) => r.presence === 'execution only').length;
        caveats.push(
          `Deal names are not unique on the deals board (155 names across 346 rows), so a name may cover several opportunities. ${onlyWo} names appear in execution with no matching pipeline row.`,
        );
      }
      if (joinOn === 'sector') {
        caveats.push(
          'The deals board carries two non-sector values in its sector column ("Tender", "DSP") that have no counterpart on the work orders board; they appear as execution-free rows.',
        );
      }
      caveats.push(
        'Client codes are masked under different schemes on the two boards (COMPANYnnn vs WOCOMPANY_nnn), so no client-level join is possible.',
      );

      return {
        joinOn,
        dealsMatched: d.matched.length,
        workOrdersMatched: w.matched.length,
        rows: rows.slice(0, 30),
        caveats,
      };
    },
  },

  /* ── 6. data quality ─────────────────────────────────────────────────────── */
  {
    name: 'data_quality_report',
    description:
      'Profiles a board: fill rate per field, parse failures, rows excluded as junk, and business-logic anomalies such as over-billed work orders or won deals with no close date. Call this when the user asks how reliable the data is, when a number looks surprising and you want to check whether missing data explains it, or before making a strong claim about a sparse field.',
    inputSchema: {
      type: 'object',
      properties: {
        board: boardEnum,
        include_field_detail: { type: 'boolean', description: 'Include the full per-field table. Default false — headlines and anomalies only.' },
      },
      required: ['board'],
    },
    handler: async (args) => {
      const id = asBoardId(args.board);
      const def = boardById(id)!;
      const data = await loadBoard(id);
      const q = boardQuality(def, data.records, data.excluded);
      return {
        board: id,
        boardName: q.boardName,
        rows: q.totalRows,
        excludedRows: q.excludedRows,
        exclusionReasons: q.exclusionReasons,
        headlines: q.headlines,
        anomalies: q.anomalies,
        fields: args.include_field_detail
          ? q.fields.map((f) => ({ field: f.field, label: f.label, fillPct: f.fillPct, distinct: f.distinct, parseIssues: f.parseIssues, unusable: f.unusable }))
          : undefined,
      };
    },
  },

  /* ── 7. distinct values ──────────────────────────────────────────────────── */
  {
    name: 'distinct_values',
    description:
      'Lists the actual values present in a field, with counts. Use it before filtering on a category you are unsure about — it stops you filtering for "Solar" when the data says "Renewables", which would silently return zero rows and look like a real answer.',
    inputSchema: {
      type: 'object',
      properties: {
        board: boardEnum,
        field: { type: 'string' },
        limit: { type: 'integer', description: 'Default 40.' },
      },
      required: ['board', 'field'],
    },
    handler: async (args) => {
      const id = asBoardId(args.board);
      const data = await loadBoard(id);
      const field = String(args.field);
      const counts = new Map<string, number>();
      let nulls = 0;
      for (const r of data.records) {
        const v = field.startsWith('d.') ? r.d[field.slice(2)] : r.f[field]?.value;
        if (v === null || v === undefined || v === '') { nulls += 1; continue; }
        const k = String(v);
        counts.set(k, (counts.get(k) ?? 0) + 1);
      }
      const values = [...counts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, Number(args.limit ?? 40))
        .map(([value, count]) => ({ value, count }));
      return {
        board: id, field, distinct: counts.size, notRecorded: nulls,
        totalRows: data.records.length, values,
      };
    },
  },

  /* ── 8. search ───────────────────────────────────────────────────────────── */
  {
    name: 'search',
    description:
      'Free-text search across every field of a board. Use it to locate a specific deal, customer code or work order when you do not know which field the term lives in.',
    inputSchema: {
      type: 'object',
      properties: {
        board: boardEnum,
        query: { type: 'string' },
        limit: { type: 'integer', description: 'Default 15.' },
      },
      required: ['board', 'query'],
    },
    handler: async (args) => {
      const id = asBoardId(args.board);
      const data = await loadBoard(id);
      const hits = searchRecords(data.records, String(args.query));
      const limit = Math.min(Number(args.limit ?? 15), 50);
      return {
        board: id, query: args.query, matched: hits.length,
        rows: hits.slice(0, limit).map((r) => {
          const flat = flatten(r);
          const out: Record<string, unknown> = {};
          for (const k of defaultFields(id)) if (flat[k] !== undefined) out[k] = flat[k];
          return out;
        }),
      };
    },
  },

  /* ── 9. temporal coverage ────────────────────────────────────────────────── */
  {
    name: 'data_time_range',
    description:
      'Reports the actual date range covered by each date field on a board, and how many rows have that date recorded. Call this BEFORE answering any question about "this quarter", "recently" or a named period — the boards are a point-in-time export and may not extend to today. Reporting zero for a period the data never covered is the single most misleading thing this agent could do.',
    inputSchema: {
      type: 'object',
      properties: { board: boardEnum },
      required: ['board'],
    },
    handler: async (args) => {
      const id = asBoardId(args.board);
      const def = boardById(id)!;
      const data = await loadBoard(id);
      const ranges = dateFields(def).map((f) => {
        const vals = data.records
          .map((r) => r.f[f.key]?.value)
          .filter((v): v is string => typeof v === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(v))
          .sort();
        return {
          field: f.key, label: f.label,
          earliest: vals[0] ?? null, latest: vals[vals.length - 1] ?? null,
          populated: vals.length, ofRows: data.records.length,
          fillPct: data.records.length ? Math.round((vals.length / data.records.length) * 1000) / 10 : 0,
        };
      });
      const all = ranges.filter((r) => r.earliest);
      return {
        board: id,
        today: toISO(new Date()),
        overallEarliest: all.length ? all.map((r) => r.earliest!).sort()[0] : null,
        overallLatest: all.length ? all.map((r) => r.latest!).sort().reverse()[0] : null,
        fields: ranges,
        note: 'These boards are a point-in-time export. If today falls outside the range above, periods like "this quarter" will legitimately contain no rows — say that explicitly rather than reporting zero.',
      };
    },
  },

  /* ── 9. leadership brief ─────────────────────────────────────────────────── */
  {
    name: 'leadership_brief',
    description:
      'Assembles the standing numbers for a leadership or board update in one call: pipeline health, funnel shape, sector mix, execution status, billing and collections, plus the data-quality caveats that belong in any pack that goes to a board. Use this when the user asks to prepare an update, a board pack, a weekly review, or "how is the business doing" — it is far cheaper and more consistent than assembling a dozen aggregate calls, and it guarantees the same definitions every week.',
    inputSchema: {
      type: 'object',
      properties: {
        period: {
          type: 'string',
          description: `Period for time-bounded sections. One of: ${PERIOD_EXPRESSIONS.join(', ')}. Defaults to this_quarter.`,
        },
        sector: { type: 'string', description: 'Optional: restrict the whole brief to one sector.' },
      },
    },
    handler: async (args) => {
      const periodExpr = String(args.period ?? 'this_quarter');
      const period = resolvePeriod(periodExpr) ?? resolvePeriod('this_quarter')!;
      const sector = args.sector ? String(args.sector) : null;

      const [deals, wos] = await Promise.all([loadBoard('deals'), loadBoard('work_orders')]);

      const sectorFilter = (rs: Record_[]) =>
        sector ? rs.filter((r) => categoryKey(String(r.f.sector?.value ?? '')) === categoryKey(sector)) : rs;

      const D = sectorFilter(deals.records);
      const W = sectorFilter(wos.records);

      const open = D.filter((r) => r.d.isOpen === true);
      const won = D.filter((r) => r.d.isWon === true);
      const lost = D.filter((r) => r.d.isLost === true);
      const sum = (rs: Record_[], k: string) =>
        Math.round(rs.reduce((a, r) => a + (typeof r.f[k]?.value === 'number' ? (r.f[k].value as number) : 0), 0));
      const sumD = (rs: Record_[], k: string) =>
        Math.round(rs.reduce((a, r) => a + (typeof r.d[k] === 'number' ? (r.d[k] as number) : 0), 0));

      const closingThisPeriod = open.filter((r) => {
        const dt = r.d.effectiveCloseDate as string | null;
        return dt !== null && dt >= period.from && dt <= period.to;
      });

      const openWithValue = open.filter((r) => r.d.hasValue === true);
      const weighted = open.filter((r) => r.d.weightedValue !== null);

      const wonInPeriod = D.filter((r) => {
        const dt = r.d.effectiveCloseDate as string | null;
        return r.d.isWon === true && dt !== null && dt >= period.from && dt <= period.to;
      });

      const posInPeriod = W.filter((r) => {
        const dt = r.f.poDate?.value as string | null;
        return dt !== null && dt >= period.from && dt <= period.to;
      });

      const byGroup = (rs: Record_[], key: string, valueKey: string) => {
        const m = new Map<string, { count: number; value: number }>();
        for (const r of rs) {
          const g = String(r.f[key]?.value ?? '(not recorded)');
          const cur = m.get(g) ?? { count: 0, value: 0 };
          cur.count += 1;
          const v = r.f[valueKey]?.value;
          if (typeof v === 'number') cur.value += v;
          m.set(g, cur);
        }
        return [...m.entries()]
          .map(([group, v]) => ({ group, count: v.count, value: Math.round(v.value) }))
          .sort((a, b) => b.value - a.value);
      };

      const dq = boardQuality(deals.def, deals.records, deals.excluded);
      const wq = boardQuality(wos.def, wos.records, wos.excluded);

      return {
        period: { expression: periodExpr, label: period.label, convention: period.convention, from: period.from, to: period.to },
        scope: sector ? `sector = ${sector}` : 'whole business',
        generatedAt: toISO(new Date()),

        pipeline: {
          openDeals: open.length,
          openValue: sum(open, 'dealValue'),
          openValueCoverage: `${openWithValue.length} of ${open.length} open deals have a value recorded`,
          weightedValue: sumD(weighted, 'weightedValue'),
          weightedCoverage: `${weighted.length} of ${open.length} open deals have both a value and a probability band`,
          weightingNote: 'Weights: High 0.75, Medium 0.45, Low 0.20 — a working convention chosen for this agent, not a company-supplied model.',
          closingThisPeriod: { count: closingThisPeriod.length, value: sum(closingThisPeriod, 'dealValue') },
          slipping: open.filter((r) => r.d.isSlipping === true).length,
        },

        funnel: byGroup(D.filter((r) => r.d.isOpen === true), 'dealStage', 'dealValue'),

        outcomes: {
          won: won.length,
          lost: lost.length,
          winRate: won.length + lost.length > 0
            ? `${Math.round((won.length / (won.length + lost.length)) * 100)}% of resolved deals`
            : 'not computable',
          wonInPeriod: { count: wonInPeriod.length, value: sum(wonInPeriod, 'dealValue') },
        },

        sectorMix: byGroup(D.filter((r) => r.d.isTrueSector === true), 'sector', 'dealValue').slice(0, 8),

        execution: {
          totalWorkOrders: W.length,
          orderBook: sum(W, 'orderValueExGst'),
          newOrdersInPeriod: { count: posInPeriod.length, value: sum(posInPeriod, 'orderValueExGst') },
          active: W.filter((r) => r.d.isActive === true).length,
          completed: W.filter((r) => r.d.isComplete === true).length,
          overdue: W.filter((r) => r.d.isOverdue === true).length,
          byStatus: byGroup(W, 'executionStatus', 'orderValueExGst'),
        },

        billingAndCollections: {
          billedInclGst: sum(W, 'billedIncGst'),
          collectedInclGst: sum(W, 'collectedIncGst'),
          receivable: sum(W, 'receivable'),
          collectionRecordedOn: `${W.filter((r) => r.d.collectionRecorded === true).length} of ${W.length} work orders`,
          overBilled: W.filter((r) => r.d.isOverBilled === true).length,
          topReceivables: [...W]
            .filter((r) => typeof r.f.receivable?.value === 'number' && (r.f.receivable.value as number) > 0)
            .sort((a, b) => (b.f.receivable!.value as number) - (a.f.receivable!.value as number))
            .slice(0, 5)
            .map((r) => ({
              serial: r.f.serialNo?.value ?? null,
              customer: r.f.customerCode?.value ?? null,
              sector: r.f.sector?.value ?? null,
              receivable: Math.round(r.f.receivable!.value as number),
            })),
        },

        dataCaveats: [...dq.headlines.slice(0, 2), ...dq.anomalies.slice(0, 3), ...wq.headlines.slice(0, 2), ...wq.anomalies.slice(0, 3)],
      };
    },
  },
];

/* ─── supporting metadata ──────────────────────────────────────────────────── */

const DERIVED_DEALS = [
  { key: 'd.isOpen', description: 'Deal Status is Open.' },
  { key: 'd.isWon', description: 'Deal Status is Won.' },
  { key: 'd.isLost', description: 'Deal Status is Dead.' },
  { key: 'd.stageBucket', description: 'open · won · lost · on-hold · disqualified, derived from the stage label.' },
  { key: 'd.stageOrder', description: 'Numeric funnel position from the stage letter (A=1 … O=15).' },
  { key: 'd.hasValue', description: 'A deal value is recorded.' },
  { key: 'd.weightedValue', description: 'Deal value × probability weight. Null unless both are present.' },
  { key: 'd.effectiveCloseDate', description: 'Actual close date if present, else tentative.' },
  { key: 'd.closeDateBasis', description: '"actual" or "tentative" — which date the above used.' },
  { key: 'd.closeQuarter', description: 'FY quarter of the effective close date, e.g. "Q3 FY2025-26".' },
  { key: 'd.createdQuarter', description: 'FY quarter the deal was created in.' },
  { key: 'd.ageDays', description: 'Days since the deal was created.' },
  { key: 'd.isSlipping', description: 'Open deal whose tentative close date has already passed.' },
  { key: 'd.daysOverdue', description: 'How far past the tentative close date a slipping deal is.' },
  { key: 'd.isTrueSector', description: 'False for the non-sector values "Tender" and "DSP".' },
];

const DERIVED_WORK_ORDERS = [
  { key: 'd.billedPct', description: 'Billed value as a percentage of order value (both incl GST).' },
  { key: 'd.collectedPct', description: 'Collected as a percentage of billed. Null when no collection is recorded.' },
  { key: 'd.collectionRecorded', description: 'A collection figure exists — blank is not the same as zero.' },
  { key: 'd.unbilled', description: 'Order value minus billed value, incl GST.' },
  { key: 'd.hasReceivable', description: 'Receivable greater than zero.' },
  { key: 'd.isActive', description: 'Execution is in progress.' },
  { key: 'd.isComplete', description: 'Execution Status is Completed.' },
  { key: 'd.isOverdue', description: 'Past its probable end date and not Completed.' },
  { key: 'd.daysOverdue', description: 'Days past the probable end date.' },
  { key: 'd.poQuarter', description: 'FY quarter of the PO date, e.g. "Q2 FY2025-26".' },
  { key: 'd.poFY', description: 'Financial year of the PO date.' },
  { key: 'd.ageDays', description: 'Days since the PO date.' },
  { key: 'd.platformAttached', description: 'A Skylark software platform is part of the deliverables.' },
  { key: 'd.billingState', description: 'Reconciled billing state, money-derived where possible.' },
  { key: 'd.billingStateConflict', description: 'Set when the two billing columns disagree.' },
  { key: 'd.isOverBilled', description: 'Billed for more than the order value.' },
  { key: 'd.quantityUnit', description: 'Unit parsed out of the PO quantity, e.g. HA, KM, COUNT.' },
];

function defaultFields(id: BoardId): string[] {
  return id === 'deals'
    ? ['dealName', 'clientCode', 'ownerCode', 'sector', 'dealStage', 'dealStatus', 'dealValue', 'closureProbability', 'tentativeCloseDate', 'createdDate', 'weightedValue', 'isSlipping', 'daysOverdue']
    : ['serialNo', 'dealName', 'customerCode', 'sector', 'typeOfWork', 'executionStatus', 'orderValueExGst', 'billedIncGst', 'receivable', 'poDate', 'billedPct', 'billingState', 'isOverdue'];
}

/* ─── dispatch ─────────────────────────────────────────────────────────────── */

export function getTool(name: string): ToolDef | undefined {
  return TOOLS.find((t) => t.name === name);
}

/**
 * Runs a tool and converts any failure into a result the model can act on.
 * Throwing here would abort the whole turn; returning a structured error lets
 * the agent apologise usefully, or retry with a narrower query.
 */
export async function callTool(name: string, args: Record<string, unknown>): Promise<unknown> {
  const tool = getTool(name);
  if (!tool) return { error: true, message: `No such tool "${name}".`, availableTools: TOOLS.map((t) => t.name) };
  try {
    return await tool.handler(args ?? {});
  } catch (err) {
    if (err instanceof MondayError) {
      return {
        error: true, kind: err.kind, message: err.userMessage, technical: err.message,
        recoverable: ['rate_limit', 'complexity', 'network'].includes(err.kind),
        suggestion: err.kind === 'complexity'
          ? 'Retry with a narrower filter or fewer fields.'
          : err.kind === 'not_found'
            ? 'Call list_boards to see which boards this account actually has.'
            : undefined,
      };
    }
    return { error: true, message: (err as Error)?.message ?? String(err) };
  }
}

export const TOOL_SCHEMAS = TOOLS.map((t) => ({
  name: t.name,
  description: t.description,
  inputSchema: t.inputSchema,
}));
