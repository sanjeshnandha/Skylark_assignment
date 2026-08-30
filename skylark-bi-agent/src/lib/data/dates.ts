/**
 * Period handling.
 *
 * Founders ask about "this quarter" and "last quarter". For an Indian company
 * that is almost always the *financial* year quarter (Apr–Mar), not the
 * calendar one, and getting this wrong silently shifts every number by up to
 * three months. So: FY is the default, calendar quarters are available
 * explicitly, and every resolved period reports which convention it used so
 * the agent can state it in the answer.
 */

export type Period = {
  /** Inclusive ISO date. */
  from: string;
  /** Inclusive ISO date. */
  to: string;
  /** Human label, e.g. "Q3 FY2025-26 (Oct–Dec 2025)". */
  label: string;
  /** Which convention produced this, for disclosure in the answer. */
  convention: 'financial-year' | 'calendar' | 'explicit' | 'rolling';
};

/** India's financial year starts 1 April. */
const FY_START_MONTH = 4;

export function fyOf(iso: string): number {
  const y = +iso.slice(0, 4);
  const m = +iso.slice(5, 7);
  return m >= FY_START_MONTH ? y : y - 1;
}

export function fyLabel(fyStart: number): string {
  return `FY${fyStart}-${String((fyStart + 1) % 100).padStart(2, '0')}`;
}

/** FY quarter 1..4 for an ISO date (Q1 = Apr–Jun). */
export function fyQuarterOf(iso: string): number {
  const m = +iso.slice(5, 7);
  return Math.floor(((m - FY_START_MONTH + 12) % 12) / 3) + 1;
}

export function fyQuarter(fyStart: number, q: 1 | 2 | 3 | 4): Period {
  const startMonth = FY_START_MONTH + (q - 1) * 3;
  const y = startMonth > 12 ? fyStart + 1 : fyStart;
  const m = ((startMonth - 1) % 12) + 1;
  const from = `${y}-${String(m).padStart(2, '0')}-01`;
  const endM = m + 2;
  const endY = endM > 12 ? y + 1 : y;
  const em = ((endM - 1) % 12) + 1;
  const to = `${endY}-${String(em).padStart(2, '0')}-${lastDay(endY, em)}`;
  return {
    from, to,
    label: `Q${q} ${fyLabel(fyStart)} (${monthAbbr(m)}–${monthAbbr(em)} ${endY})`,
    convention: 'financial-year',
  };
}

export function calendarQuarter(year: number, q: 1 | 2 | 3 | 4): Period {
  const m = (q - 1) * 3 + 1;
  return {
    from: `${year}-${String(m).padStart(2, '0')}-01`,
    to: `${year}-${String(m + 2).padStart(2, '0')}-${lastDay(year, m + 2)}`,
    label: `Q${q} ${year} (calendar, ${monthAbbr(m)}–${monthAbbr(m + 2)})`,
    convention: 'calendar',
  };
}

export function financialYear(fyStart: number): Period {
  return {
    from: `${fyStart}-04-01`,
    to: `${fyStart + 1}-03-31`,
    label: `${fyLabel(fyStart)} (Apr ${fyStart} – Mar ${fyStart + 1})`,
    convention: 'financial-year',
  };
}

/**
 * Resolves the period expressions the agent is allowed to pass.
 *
 * Accepted:
 *   this_quarter · last_quarter · next_quarter · this_fy · last_fy
 *   this_month · last_month · ytd · last_30_days · last_90_days · last_12_months
 *   FY2025-26 · Q3_FY2025-26 · CQ3_2025 · 2025-07-01..2025-09-30
 *
 * `today` is injectable so tests are deterministic.
 */
export function resolvePeriod(expr: string, today = new Date()): Period | null {
  const now = toISO(today);
  const s = expr.trim().toLowerCase().replace(/[\s-]+/g, '_');

  const explicit = expr.trim().match(/^(\d{4}-\d{2}-\d{2})\s*(?:\.\.|to|—|–)\s*(\d{4}-\d{2}-\d{2})$/i);
  if (explicit) {
    return { from: explicit[1], to: explicit[2], label: `${explicit[1]} to ${explicit[2]}`, convention: 'explicit' };
  }

  const qfy = expr.trim().match(/^q([1-4])[\s_]*fy\s*(\d{4})(?:[-\/](\d{2,4}))?$/i);
  if (qfy) return fyQuarter(+qfy[2], +qfy[1] as 1 | 2 | 3 | 4);

  const cq = expr.trim().match(/^cq([1-4])[\s_]*(\d{4})$/i);
  if (cq) return calendarQuarter(+cq[2], +cq[1] as 1 | 2 | 3 | 4);

  const fy = expr.trim().match(/^fy\s*(\d{4})(?:[-\/](\d{2,4}))?$/i);
  if (fy) return financialYear(+fy[1]);

  const curFy = fyOf(now);
  const curQ = fyQuarterOf(now) as 1 | 2 | 3 | 4;

  switch (s) {
    case 'this_quarter': case 'current_quarter': case 'quarter':
      return fyQuarter(curFy, curQ);
    case 'last_quarter': case 'previous_quarter': {
      const q = curQ === 1 ? 4 : ((curQ - 1) as 1 | 2 | 3 | 4);
      return fyQuarter(curQ === 1 ? curFy - 1 : curFy, q);
    }
    case 'next_quarter': {
      const q = curQ === 4 ? 1 : ((curQ + 1) as 1 | 2 | 3 | 4);
      return fyQuarter(curQ === 4 ? curFy + 1 : curFy, q);
    }
    case 'this_fy': case 'this_financial_year': case 'current_fy':
      return financialYear(curFy);
    case 'last_fy': case 'previous_fy': case 'last_financial_year':
      return financialYear(curFy - 1);
    case 'this_month': case 'current_month': {
      const y = +now.slice(0, 4), m = +now.slice(5, 7);
      return { from: `${now.slice(0, 7)}-01`, to: `${now.slice(0, 7)}-${lastDay(y, m)}`,
        label: `${monthAbbr(m)} ${y}`, convention: 'calendar' };
    }
    case 'last_month': {
      let y = +now.slice(0, 4), m = +now.slice(5, 7) - 1;
      if (m === 0) { m = 12; y -= 1; }
      const p = `${y}-${String(m).padStart(2, '0')}`;
      return { from: `${p}-01`, to: `${p}-${lastDay(y, m)}`, label: `${monthAbbr(m)} ${y}`, convention: 'calendar' };
    }
    case 'ytd': case 'fy_to_date':
      return { from: `${curFy}-04-01`, to: now,
        label: `${fyLabel(curFy)} to date (1 Apr ${curFy} – ${now})`, convention: 'financial-year' };
    case 'last_30_days': return rolling(today, 30);
    case 'last_90_days': return rolling(today, 90);
    case 'last_6_months': return rolling(today, 182);
    case 'last_12_months': case 'ttm': return rolling(today, 365);
    case 'all_time': case 'all':
      return { from: '1990-01-01', to: '2100-12-31', label: 'all time', convention: 'explicit' };
    default: return null;
  }
}

function rolling(today: Date, days: number): Period {
  const end = toISO(today);
  const start = new Date(today.getTime() - days * 86400000);
  return { from: toISO(start), to: end, label: `last ${days} days (${toISO(start)} – ${end})`, convention: 'rolling' };
}

export function inPeriod(iso: string | null, p: Period): boolean {
  if (!iso) return false;
  return iso >= p.from && iso <= p.to;
}

function lastDay(y: number, m: number): string {
  return String(new Date(Date.UTC(y, m, 0)).getUTCDate()).padStart(2, '0');
}

function monthAbbr(m: number): string {
  return ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'][((m - 1) % 12 + 12) % 12];
}

export function toISO(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

export function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(b) - Date.parse(a)) / 86400000);
}

/** Every period expression the agent may use, for the tool schema. */
export const PERIOD_EXPRESSIONS = [
  'this_quarter', 'last_quarter', 'next_quarter', 'this_fy', 'last_fy',
  'this_month', 'last_month', 'ytd', 'last_30_days', 'last_90_days',
  'last_6_months', 'last_12_months', 'all_time',
  'FY2025', 'Q3_FY2025', 'CQ3_2025', 'YYYY-MM-DD..YYYY-MM-DD',
];
