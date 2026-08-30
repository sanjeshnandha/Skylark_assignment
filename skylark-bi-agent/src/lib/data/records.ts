/**
 * Raw board rows → canonical, typed, normalized records.
 *
 * A record keeps three things for every field: the cleaned value, the raw
 * value as it came out of monday.com, and any parse issue. Provenance is what
 * lets the agent say "14 of these 32 rows had no value recorded" instead of
 * quietly averaging over a hole.
 */

import {
  normText, normNumber, normDate, normMonthName, normSector, normStage,
  normDealStatus, normProbability, normExecutionStatus, normBillingLabel,
  normQuantity, categoryKey, PROBABILITY_WEIGHTS, type StageInfo,
} from './normalize.ts';
import { DEALS, WORK_ORDERS, type BoardDef, type FieldDef } from './schema.ts';
import { fyOf, fyQuarterOf, fyLabel, daysBetween, toISO } from './dates.ts';

export type FieldValue = {
  value: unknown;
  raw: string | null;
  issue?: string;
  /** Extra facets: sector kind, quantity unit, stage bucket… */
  meta?: Record<string, unknown>;
};

export type Record_ = {
  /** monday.com item id. */
  id: string;
  board: 'deals' | 'work_orders';
  /** Canonical key → normalized value. */
  f: Record<string, FieldValue>;
  /** Computed fields that do not exist in the source. */
  d: Record<string, unknown>;
  /** Rows the ingest layer judged not to be real data. */
  excluded?: { reason: string };
};

/** A single raw row: canonical field key → whatever monday returned. */
export type RawRow = { id: string; values: Record<string, unknown> };

/* ────────────────────────────────────────────────────────────────────────────
 * Field-level normalization
 * ────────────────────────────────────────────────────────────────────────── */

function normalizeField(field: FieldDef, raw: unknown): FieldValue {
  switch (field.kind) {
    case 'text': return normText(raw);
    case 'category': {
      const t = normText(raw);
      return { ...t, meta: { key: categoryKey(t.value) } };
    }
    case 'number': return normNumber(raw);
    case 'currency': return normNumber(raw);
    case 'quantity': {
      const q = normQuantity(raw);
      return { value: q.value, raw: q.raw, issue: q.issue, meta: { unit: q.unit } };
    }
    case 'date': return normDate(raw);
    case 'month': return normMonthName(raw);
    case 'sector': {
      const s = normSector(raw);
      return { value: s.value, raw: s.raw, issue: s.issue, meta: { kind: s.kind } };
    }
    case 'stage': {
      const s = normStage(raw);
      return {
        value: s.value?.label ?? null, raw: s.raw, issue: s.issue,
        meta: s.value ? { code: s.value.code, order: s.value.order, bucket: s.value.bucket } : undefined,
      };
    }
    case 'dealStatus': return normDealStatus(raw);
    case 'probability': return normProbability(raw);
    case 'executionStatus': {
      const e = normExecutionStatus(raw);
      return { value: e.value, raw: e.raw, issue: e.issue, meta: { active: e.active } };
    }
    case 'billingLabel': return normBillingLabel(raw);
    default: return normText(raw);
  }
}

/* ────────────────────────────────────────────────────────────────────────────
 * Junk-row detection
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * The Deal Funnel sheet has the header row repeated *inside* the data at rows
 * 50 and 179 — with a plausible deal name in the first cell, so a naive
 * "skip if first cell looks like a header" check misses them entirely. They
 * survive an XLSX→monday import as ordinary items and would otherwise be
 * counted as two real deals with the stage literally named "Deal Stage".
 *
 * The reliable signal is that several *other* cells equal their own column
 * header. Two or more such matches is decisive.
 */
function detectHeaderEcho(board: BoardDef, values: Record<string, unknown>): boolean {
  let matches = 0;
  for (const field of board.fields) {
    const v = values[field.key];
    if (v === null || v === undefined) continue;
    const a = categoryKey(String(v));
    const b = categoryKey(field.source);
    if (a && b && a === b) matches += 1;
    if (matches >= 2) return true;
  }
  return false;
}

/** A row with nothing but an id is an artefact of an empty spreadsheet line. */
function isEmptyRow(values: Record<string, unknown>): boolean {
  return Object.values(values).every((v) => v === null || v === undefined || String(v).trim() === '');
}

/* ────────────────────────────────────────────────────────────────────────────
 * Derived fields
 * ────────────────────────────────────────────────────────────────────────── */

function num(r: Record<string, FieldValue>, k: string): number | null {
  const v = r[k]?.value;
  return typeof v === 'number' ? v : null;
}
function str(r: Record<string, FieldValue>, k: string): string | null {
  const v = r[k]?.value;
  return typeof v === 'string' ? v : null;
}

function deriveDeal(f: Record<string, FieldValue>, today: string): Record<string, unknown> {
  const d: Record<string, unknown> = {};
  const status = str(f, 'dealStatus');
  const stageMeta = f.dealStage?.meta as { bucket?: string; order?: number } | undefined;

  d.isOpen = status === 'Open';
  d.isWon = status === 'Won';
  d.isLost = status === 'Dead';
  d.stageBucket = stageMeta?.bucket ?? null;
  d.stageOrder = stageMeta?.order ?? null;

  const value = num(f, 'dealValue');
  const prob = str(f, 'closureProbability') as keyof typeof PROBABILITY_WEIGHTS | null;
  d.hasValue = value !== null;

  /**
   * Probability-weighted value. Only defined when BOTH a value and a
   * probability band exist — a weighted pipeline that silently treats
   * unrated deals as zero is worse than one that reports its coverage.
   */
  d.weightedValue = value !== null && prob ? Math.round(value * PROBABILITY_WEIGHTS[prob]) : null;
  d.probabilityWeight = prob ? PROBABILITY_WEIGHTS[prob] : null;

  /**
   * The date to reason about when someone says "closing this quarter".
   * Actual close date is only 8% populated, so tentative is the working
   * answer and `closeDateBasis` records which one was used.
   */
  const actual = str(f, 'closeDateActual');
  const tentative = str(f, 'tentativeCloseDate');
  d.effectiveCloseDate = actual ?? tentative ?? null;
  d.closeDateBasis = actual ? 'actual' : tentative ? 'tentative' : null;

  const created = str(f, 'createdDate');
  d.ageDays = created ? daysBetween(created, today) : null;
  d.createdFY = created ? fyLabel(fyOf(created)) : null;
  d.createdQuarter = created ? `Q${fyQuarterOf(created)} ${fyLabel(fyOf(created))}` : null;
  const eff = d.effectiveCloseDate as string | null;
  d.closeQuarter = eff ? `Q${fyQuarterOf(eff)} ${fyLabel(fyOf(eff))}` : null;

  /** Open deals whose expected close date has already passed. */
  d.isSlipping = d.isOpen === true && tentative !== null && tentative < today;
  d.daysOverdue = d.isSlipping ? daysBetween(tentative!, today) : null;

  const sectorMeta = f.sector?.meta as { kind?: string } | undefined;
  d.isTrueSector = sectorMeta?.kind === 'sector';
  return d;
}

function deriveWorkOrder(f: Record<string, FieldValue>, today: string): Record<string, unknown> {
  const d: Record<string, unknown> = {};

  const order = num(f, 'orderValueExGst');
  const orderInc = num(f, 'orderValueIncGst');
  const billedInc = num(f, 'billedIncGst');
  const collected = num(f, 'collectedIncGst');
  const receivable = num(f, 'receivable');

  d.orderValue = order;
  /** Billing progress against the incl-GST order value; both are 100% populated. */
  d.billedPct = orderInc && orderInc > 0 && billedInc !== null
    ? Math.round((billedInc / orderInc) * 1000) / 10 : null;
  /**
   * Collection rate. Blank collected means "no collection recorded", which is
   * not the same as zero, so this stays null rather than reading as 0%.
   */
  d.collectedPct = billedInc && billedInc > 0 && collected !== null
    ? Math.round((collected / billedInc) * 1000) / 10 : null;
  d.collectionRecorded = collected !== null;
  d.unbilled = orderInc !== null && billedInc !== null ? Math.round((orderInc - billedInc) * 100) / 100 : null;
  d.hasReceivable = receivable !== null && receivable > 0.5;

  const exec = f.executionStatus?.meta as { active?: boolean | null } | undefined;
  d.isActive = exec?.active ?? null;
  d.isComplete = str(f, 'executionStatus') === 'Completed';

  const po = str(f, 'poDate');
  d.poFY = po ? fyLabel(fyOf(po)) : null;
  d.poQuarter = po ? `Q${fyQuarterOf(po)} ${fyLabel(fyOf(po))}` : null;
  d.ageDays = po ? daysBetween(po, today) : null;

  /** Execution running past its planned end date and not yet complete. */
  const end = str(f, 'probableEndDate');
  d.isOverdue = end !== null && end < today && d.isComplete !== true;
  d.daysOverdue = d.isOverdue ? daysBetween(end!, today) : null;

  d.platformAttached = (() => {
    const p = str(f, 'softwarePlatform');
    return p === null ? null : p.toUpperCase() !== 'NONE';
  })();

  /**
   * Reconciles the two competing billing columns. When they disagree the
   * *money* is the tie-breaker, because billed value is 100% populated while
   * both status columns are sparse and hand-maintained.
   */
  const invoice = str(f, 'invoiceStatus');
  const billing = str(f, 'billingStatus');
  const fromMoney: string | null = billedInc === null || orderInc === null || orderInc === 0
    ? null
    : billedInc <= 0.5 ? 'Not Billed'
      : billedInc >= orderInc - 0.5 ? 'Fully Billed'
        : 'Partially Billed';
  d.billingStateDerived = fromMoney;
  d.billingStateReported = invoice ?? billing ?? null;
  d.billingStateConflict =
    invoice !== null && billing !== null && invoice !== billing
      ? `Invoice Status says "${invoice}", Billing Status says "${billing}"`
      : null;
  d.billingState = fromMoney ?? invoice ?? billing ?? null;

  /** Billed more than the order value — a genuine over-billing signal. */
  d.isOverBilled = num(f, 'toBillExGst') !== null && num(f, 'toBillExGst')! < -1;

  const qUnit = (f.quantityPo?.meta as { unit?: string | null } | undefined)?.unit ?? null;
  d.quantityUnit = qUnit;
  return d;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Public entry point
 * ────────────────────────────────────────────────────────────────────────── */

export function buildRecords(
  board: BoardDef,
  rows: RawRow[],
  today = toISO(new Date()),
): { records: Record_[]; excluded: Record_[] } {
  const records: Record_[] = [];
  const excluded: Record_[] = [];

  for (const row of rows) {
    if (isEmptyRow(row.values)) {
      excluded.push({ id: row.id, board: board.id, f: {}, d: {}, excluded: { reason: 'blank row' } });
      continue;
    }
    if (detectHeaderEcho(board, row.values)) {
      excluded.push({
        id: row.id, board: board.id, f: {}, d: {},
        excluded: { reason: 'repeated header row embedded in the data' },
      });
      continue;
    }

    const f: Record<string, FieldValue> = {};
    for (const field of board.fields) {
      f[field.key] = normalizeField(field, row.values[field.key]);
    }
    const d = board.id === 'deals' ? deriveDeal(f, today) : deriveWorkOrder(f, today);
    records.push({ id: row.id, board: board.id, f, d });
  }

  return { records, excluded };
}

/** Flattens a record for output: value only, plus derived fields. */
export function flatten(r: Record_): Record<string, unknown> {
  const out: Record<string, unknown> = { _id: r.id };
  for (const [k, v] of Object.entries(r.f)) if (v.value !== null) out[k] = v.value;
  for (const [k, v] of Object.entries(r.d)) if (v !== null && v !== undefined) out[k] = v;
  return out;
}

export { DEALS, WORK_ORDERS };
