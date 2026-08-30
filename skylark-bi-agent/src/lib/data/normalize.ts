/**
 * Value-level normalizers.
 *
 * Every rule here is a response to something actually present in the source
 * spreadsheets — the profiling notes in DECISION_LOG.md name the row counts.
 * Nothing normalizes speculatively: if a value cannot be understood we return
 * null and record why, rather than guessing and quietly corrupting an average.
 */

export type Normalized<T> = {
  value: T | null;
  /** The raw cell exactly as monday.com returned it, for provenance. */
  raw: string | null;
  /** Set when the raw value was non-empty but could not be parsed. */
  issue?: string;
};

/**
 * Placeholders that mean "no value was recorded".
 *
 * Deliberately does NOT include "none" or "nil". In the Work Order tracker
 * `NONE` is a real answer on the software-platform column — it means "no
 * Skylark platform is part of the deliverables" for 127 of 176 rows. Treating
 * it as blank silently erased the majority of that column and made
 * platform-attach rate look like 21% instead of 93%.
 */
const EMPTY = new Set([
  '', '-', '--', 'n/a', 'na', 'null', 'tbd', 'tba',
  'not applicable', 'not available', '#n/a', '#value!', '#ref!', '#div/0!', '?', 'xx',
]);

export function isBlank(v: unknown): boolean {
  if (v === null || v === undefined) return true;
  const s = String(v).trim().toLowerCase();
  return EMPTY.has(s);
}

function raw(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v).trim();
  return s === '' ? null : s;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Text
 * ────────────────────────────────────────────────────────────────────────── */

/** Collapses whitespace, strips zero-width characters and stray quotes. */
export function normText(v: unknown): Normalized<string> {
  if (isBlank(v)) return { value: null, raw: raw(v) };
  const cleaned = String(v)
    .replace(/[​-‍﻿]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/^["'\s]+|["'\s]+$/g, '')
    .trim();
  return cleaned === '' ? { value: null, raw: raw(v) } : { value: cleaned, raw: raw(v) };
}

/**
 * Normalizes a categorical label for *comparison* — lowercase, no punctuation,
 * no spacing. `"BIlled"`, `"billed"` and `"Billed "` all collapse to `billed`,
 * which is what lets the Work Order tracker's two competing status columns be
 * reconciled at all.
 */
export function categoryKey(v: unknown): string | null {
  const t = normText(v).value;
  if (t === null) return null;
  return t.toLowerCase().replace(/[^a-z0-9]+/g, '');
}

/* ────────────────────────────────────────────────────────────────────────────
 * Numbers & currency
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * Parses Indian-format currency and plain numbers. Handles ₹ / Rs / INR
 * prefixes, thousands separators in both Western (1,234,567) and Indian
 * (12,34,567) grouping, trailing units, parenthesised negatives, and the
 * lakh/crore suffixes that appear in hand-typed cells.
 */
export function normNumber(v: unknown): Normalized<number> {
  if (isBlank(v)) return { value: null, raw: raw(v) };
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) return { value: null, raw: raw(v), issue: 'non-finite number' };
    return { value: round2(v), raw: raw(v) };
  }

  let s = String(v).trim();
  const negative = /^\(.*\)$/.test(s) || s.startsWith('-');
  s = s.replace(/^\(|\)$/g, '');

  // Scale suffixes, checked before separators are stripped.
  let scale = 1;
  const scaled = s.match(/([\d.,\s]+)\s*(crores?|cr|lakhs?|lacs?|lc|k|mn|m|bn)\b/i);
  if (scaled) {
    const unit = scaled[2].toLowerCase();
    if (/^cr|^crore/.test(unit)) scale = 1e7;
    else if (/^l/.test(unit)) scale = 1e5;
    else if (unit === 'k') scale = 1e3;
    else if (unit === 'm' || unit === 'mn') scale = 1e6;
    else if (unit === 'bn') scale = 1e9;
    s = scaled[1];
  }

  s = s.replace(/(?:₹|rs\.?|inr|usd|\$)/gi, '').replace(/,/g, '').replace(/\s/g, '');
  // Anything left that is not part of a number (a stray unit like "HA") goes.
  const m = s.match(/-?\d*\.?\d+(?:e[+-]?\d+)?/i);
  if (!m) return { value: null, raw: raw(v), issue: `no number found in ${JSON.stringify(String(v))}` };

  const n = Number(m[0]) * scale;
  if (!Number.isFinite(n)) return { value: null, raw: raw(v), issue: 'unparseable number' };
  const signed = negative && n > 0 ? -n : n;
  return { value: round2(signed), raw: raw(v) };
}

/**
 * The source workbook carries float noise from spreadsheet arithmetic
 * (`2984097.3600000003`). Rupee amounts are meaningful to the paisa at most,
 * so everything is snapped to 2dp — this keeps sums from drifting and stops
 * the agent quoting sixteen significant figures at a founder.
 */
function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

/**
 * Quantities in the Work Order tracker are free text with the unit inline
 * (`"5360 HA"`, `"4"`, `"59.33"`, `"12 nos"`). We keep both halves: the number
 * is aggregatable, and the unit is what stops the agent from summing hectares
 * and tower-counts into one meaningless total.
 */
export function normQuantity(v: unknown): Normalized<number> & { unit: string | null } {
  const n = normNumber(v);
  if (isBlank(v)) return { ...n, unit: null };
  const text = String(v);
  const unitMatch = text.match(/(?:\d|\.)\s*([a-z][a-z.\/²]*)\s*$/i);
  let unit = unitMatch ? unitMatch[1].toUpperCase().replace(/\.$/, '') : null;
  // The source spells the same unit several ways, including outright typos
  // ("ACERS", "ACR"). Folding them together is what makes the mixed-unit guard
  // in the aggregator meaningful rather than noise.
  const UNIT_ALIASES: Record<string, string> = {
    NOS: 'COUNT', NO: 'COUNT', QTY: 'COUNT', UNIT: 'COUNT', UNITS: 'COUNT', EA: 'COUNT',
    HECTARES: 'HA', HECTARE: 'HA', HECTAERS: 'HA',
    ACRES: 'ACRE', ACR: 'ACRE', ACERS: 'ACRE', ACRE: 'ACRE',
    KMS: 'KM', KILOMETRES: 'KM', KILOMETERS: 'KM',
    RKMS: 'RKM',
    TOWER: 'TOWERS', SITE: 'SITES', LOCATIONS: 'LOCATION', MINE: 'MINES',
  };
  if (unit && UNIT_ALIASES[unit]) unit = UNIT_ALIASES[unit];
  return { ...n, unit };
}

/* ────────────────────────────────────────────────────────────────────────────
 * Dates
 * ────────────────────────────────────────────────────────────────────────── */

const MONTHS: Record<string, number> = {
  jan: 1, january: 1, feb: 2, february: 2, mar: 3, march: 3, apr: 4, april: 4,
  may: 5, jun: 6, june: 6, jul: 7, july: 7, aug: 8, august: 8,
  sep: 9, sept: 9, september: 9, oct: 10, october: 10,
  nov: 11, november: 11, dec: 12, december: 12,
};

/**
 * Parses the date formats present in the source, in priority order:
 * ISO (`2025-11-28`), monday.com date objects, Excel serial numbers,
 * `DD/MM/YYYY` and `DD-MM-YYYY`, and `12 Mar 2025` / `Mar 12, 2025`.
 *
 * Ambiguous slash dates are read **day-first**. The source is an Indian
 * company's operational tracker and the unambiguous rows (day > 12) are
 * day-first without exception, so month-first parsing would silently
 * mis-date roughly a third of the calendar. This is recorded in the
 * decision log as an explicit, reversible assumption.
 */
export function normDate(v: unknown): Normalized<string> {
  if (isBlank(v)) return { value: null, raw: raw(v) };

  if (v instanceof Date) {
    return Number.isNaN(v.getTime())
      ? { value: null, raw: raw(v), issue: 'invalid Date' }
      : { value: toISO(v.getUTCFullYear(), v.getUTCMonth() + 1, v.getUTCDate()), raw: raw(v) };
  }

  // Excel serial day number (days since 1899-12-30). Bounded to 1990-2100 so a
  // plain quantity like 45000 in a date column is not silently read as a date.
  if (typeof v === 'number') {
    if (v > 32874 && v < 73415) {
      const ms = Math.round((v - 25569) * 86400 * 1000);
      const d = new Date(ms);
      return { value: toISO(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()), raw: raw(v) };
    }
    return { value: null, raw: raw(v), issue: `numeric value ${v} out of plausible date range` };
  }

  const s = String(v).trim();

  // ISO, optionally with a time component.
  const iso = s.match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T\s].*)?$/);
  if (iso) return isoOrIssue(+iso[1], +iso[2], +iso[3], s);

  // DD/MM/YYYY, DD-MM-YYYY, DD.MM.YY
  const dmy = s.match(/^(\d{1,2})[\/\-.](\d{1,2})[\/\-.](\d{2,4})$/);
  if (dmy) {
    let [, a, b, y] = dmy;
    let day = +a, month = +b;
    // Only swap when day-first is impossible.
    if (day > 12 && month <= 12) { /* unambiguous day-first */ }
    else if (month > 12 && day <= 12) { day = +b; month = +a; }
    const year = normYear(+y);
    return isoOrIssue(year, month, day, s);
  }

  // 12 Mar 2025 / 12-Mar-25
  const dMonY = s.match(/^(\d{1,2})[\s\-]([a-z]{3,9})[\s\-,]+(\d{2,4})$/i);
  if (dMonY && MONTHS[dMonY[2].toLowerCase()]) {
    return isoOrIssue(normYear(+dMonY[3]), MONTHS[dMonY[2].toLowerCase()], +dMonY[1], s);
  }

  // Mar 12, 2025
  const monDY = s.match(/^([a-z]{3,9})[\s\-]+(\d{1,2})[\s,\-]+(\d{2,4})$/i);
  if (monDY && MONTHS[monDY[1].toLowerCase()]) {
    return isoOrIssue(normYear(+monDY[3]), MONTHS[monDY[1].toLowerCase()], +monDY[2], s);
  }

  const parsed = Date.parse(s);
  if (!Number.isNaN(parsed)) {
    const d = new Date(parsed);
    return { value: toISO(d.getUTCFullYear(), d.getUTCMonth() + 1, d.getUTCDate()), raw: raw(v) };
  }

  return { value: null, raw: raw(v), issue: `unrecognised date format ${JSON.stringify(s)}` };
}

/**
 * Month-only cells (`"Dec"`, `"November"`, `"June"`) appear in the billing and
 * recurring-execution columns with no year attached. We return the month
 * number and never invent a year — a caller that needs a full date must say
 * which year it is assuming, and the agent surfaces that as a caveat.
 */
export function normMonthName(v: unknown): Normalized<number> {
  if (isBlank(v)) return { value: null, raw: raw(v) };
  const key = String(v).trim().toLowerCase().replace(/[^a-z]/g, '');
  const m = MONTHS[key];
  if (m) return { value: m, raw: raw(v) };
  const asDate = normDate(v);
  if (asDate.value) return { value: +asDate.value.slice(5, 7), raw: raw(v) };
  return { value: null, raw: raw(v), issue: `unrecognised month ${JSON.stringify(String(v))}` };
}

function normYear(y: number): number {
  if (y >= 1000) return y;
  return y < 70 ? 2000 + y : 1900 + y;
}

function isoOrIssue(y: number, m: number, d: number, src: string): Normalized<string> {
  if (m < 1 || m > 12 || d < 1 || d > 31 || y < 1990 || y > 2100) {
    return { value: null, raw: src, issue: `out-of-range date ${JSON.stringify(src)}` };
  }
  const probe = new Date(Date.UTC(y, m - 1, d));
  if (probe.getUTCMonth() + 1 !== m || probe.getUTCDate() !== d) {
    return { value: null, raw: src, issue: `impossible calendar date ${JSON.stringify(src)}` };
  }
  return { value: toISO(y, m, d), raw: src };
}

function toISO(y: number, m: number, d: number): string {
  return `${y}-${String(m).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/* ────────────────────────────────────────────────────────────────────────────
 * Domain vocabularies
 * ────────────────────────────────────────────────────────────────────────── */

/**
 * The `Sector/service` column conflates two different things: genuine industry
 * verticals (Mining, Renewables, Powerline…) and go-to-market classifications
 * that are not sectors at all (`Tender`, `DSP`). We keep the label but tag the
 * kind, so "revenue by sector" can exclude non-sectors and say that it did.
 */
export const SECTORS = [
  'Mining', 'Renewables', 'Railways', 'Powerline', 'Construction',
  'Manufacturing', 'Aviation', 'Security and Surveillance',
] as const;

const SECTOR_ALIASES: Record<string, string> = {
  mining: 'Mining', mines: 'Mining', coal: 'Mining',
  renewables: 'Renewables', renewable: 'Renewables', solar: 'Renewables', wind: 'Renewables',
  railways: 'Railways', railway: 'Railways', rail: 'Railways',
  powerline: 'Powerline', powerlines: 'Powerline', power: 'Powerline',
  transmission: 'Powerline', tline: 'Powerline',
  construction: 'Construction', infra: 'Construction', infrastructure: 'Construction',
  manufacturing: 'Manufacturing',
  aviation: 'Aviation',
  securityandsurveillance: 'Security and Surveillance', security: 'Security and Surveillance',
  surveillance: 'Security and Surveillance',
  others: 'Others', other: 'Others', misc: 'Others',
  tender: 'Tender', dsp: 'DSP',
};

export type SectorKind = 'sector' | 'unclassified' | 'route-to-market';

export function normSector(v: unknown): Normalized<string> & { kind: SectorKind } {
  const t = normText(v);
  if (t.value === null) return { ...t, kind: 'unclassified' };
  const key = categoryKey(t.value)!;
  const label = SECTOR_ALIASES[key] ?? t.value;
  const kind: SectorKind =
    label === 'Tender' || label === 'DSP' ? 'route-to-market'
      : label === 'Others' ? 'unclassified'
      : 'sector';
  return { value: label, raw: t.raw, kind };
}

/**
 * Deal stages arrive as `"A. Lead Generated"` … `"O. Not Relevant at all"`,
 * except for `"Project Completed"`, which lost its letter somewhere. The letter
 * is the company's own funnel ordering, so we parse it out and use it for
 * sorting, and slot the unlettered stage in by meaning.
 */
export type StageInfo = {
  label: string;
  code: string | null;
  order: number;
  /** open · won · lost · on-hold · disqualified */
  bucket: 'open' | 'won' | 'lost' | 'on-hold' | 'disqualified';
};

const STAGE_OVERRIDES: Record<string, { code: string; order: number }> = {
  // Unlettered in the source; sits after "J. Invoice sent" by meaning.
  projectcompleted: { code: 'J+', order: 10.5 },
};

export function normStage(v: unknown): Normalized<StageInfo> {
  const t = normText(v);
  if (t.value === null) return { value: null, raw: t.raw };

  const label = t.value;
  const m = label.match(/^([A-Z])\.\s*(.+)$/);
  let code: string | null = null;
  let order: number;

  if (m) {
    code = m[1];
    order = m[1].charCodeAt(0) - 64; // A → 1
  } else {
    const ov = STAGE_OVERRIDES[categoryKey(label)!];
    code = ov?.code ?? null;
    order = ov?.order ?? 99;
  }

  const key = categoryKey(label)!;
  let bucket: StageInfo['bucket'] = 'open';
  if (/projectwon|workorderreceived|invoicesent|amountaccrued|projectcompleted/.test(key)) bucket = 'won';
  else if (/projectlost/.test(key)) bucket = 'lost';
  else if (/onhold/.test(key)) bucket = 'on-hold';
  else if (/notrelevant/.test(key)) bucket = 'disqualified';

  return { value: { label, code, order, bucket }, raw: t.raw };
}

/** Deal Status: Won · Dead · Open · On Hold. */
export function normDealStatus(v: unknown): Normalized<'Won' | 'Dead' | 'Open' | 'On Hold'> {
  const t = normText(v);
  if (t.value === null) return { value: null, raw: t.raw };
  const key = categoryKey(t.value)!;
  const map: Record<string, 'Won' | 'Dead' | 'Open' | 'On Hold'> = {
    won: 'Won', closedwon: 'Won',
    dead: 'Dead', lost: 'Dead', closedlost: 'Dead',
    open: 'Open', active: 'Open', inprogress: 'Open',
    onhold: 'On Hold', hold: 'On Hold', paused: 'On Hold',
  };
  const hit = map[key];
  return hit
    ? { value: hit, raw: t.raw }
    : { value: null, raw: t.raw, issue: `unrecognised deal status ${JSON.stringify(t.value)}` };
}

/** High / Medium / Low, mapped to weights used for probability-weighted pipeline. */
export const PROBABILITY_WEIGHTS = { High: 0.75, Medium: 0.45, Low: 0.2 } as const;

export function normProbability(v: unknown): Normalized<'High' | 'Medium' | 'Low'> {
  const t = normText(v);
  if (t.value === null) return { value: null, raw: t.raw };
  const key = categoryKey(t.value)!;
  if (key.startsWith('high') || key === 'h') return { value: 'High', raw: t.raw };
  if (key.startsWith('med') || key === 'm') return { value: 'Medium', raw: t.raw };
  if (key.startsWith('low') || key === 'l') return { value: 'Low', raw: t.raw };
  return { value: null, raw: t.raw, issue: `unrecognised probability ${JSON.stringify(t.value)}` };
}

/**
 * Execution status of a work order. `"Pause / struck"` and
 * `"Details pending from Client"` are real values in the source and are
 * preserved rather than folded into a tidier bucket.
 */
export function normExecutionStatus(v: unknown): Normalized<string> & { active: boolean | null } {
  const t = normText(v);
  if (t.value === null) return { ...t, active: null };
  const key = categoryKey(t.value)!;
  const canonical: Record<string, string> = {
    completed: 'Completed', complete: 'Completed', done: 'Completed',
    ongoing: 'Ongoing', inprogress: 'Ongoing',
    executeduntilcurrentmonth: 'Executed until current month',
    notstarted: 'Not Started', yettostart: 'Not Started',
    pausestruck: 'Pause / Struck', paused: 'Pause / Struck', struck: 'Pause / Struck',
    partialcompleted: 'Partially Completed', partiallycompleted: 'Partially Completed',
    detailspendingfromclient: 'Details pending from Client',
  };
  const label = canonical[key] ?? t.value;
  const active = /^(Ongoing|Executed until current month|Partially Completed)$/.test(label)
    ? true
    : /^(Completed|Pause \/ Struck)$/.test(label) ? false : null;
  return { value: label, raw: t.raw, active };
}

/**
 * Billing state. The tracker has **two** overlapping columns — `Invoice Status`
 * (36% populated) and `Billing Status` (16% populated, and containing the
 * typo `"BIlled"`). Neither is authoritative alone. `reconcileBilling` below
 * merges them and reports when they disagree.
 */
export function normBillingLabel(v: unknown): Normalized<string> {
  const t = normText(v);
  if (t.value === null) return t;
  const key = categoryKey(t.value)!;
  const canonical: Record<string, string> = {
    fullybilled: 'Fully Billed', billed: 'Fully Billed',
    partiallybilled: 'Partially Billed', partialbilled: 'Partially Billed',
    notbilledyet: 'Not Billed', notbilled: 'Not Billed', notbillable: 'Not Billable',
    stuck: 'Stuck', updaterequired: 'Update Required',
  };
  if (canonical[key]) return { value: canonical[key], raw: t.raw };
  // "Billed- Visit 7" → Partially Billed, keeping the visit note as provenance.
  if (/^billed/.test(key)) return { value: 'Partially Billed', raw: t.raw };
  return { value: t.value, raw: t.raw };
}
