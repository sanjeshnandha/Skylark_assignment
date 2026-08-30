/**
 * Grouping and aggregation.
 *
 * Every result carries its own coverage: how many rows fell in the group, and
 * how many of those actually had a value for the metric. A founder asking for
 * pipeline by sector gets a number *and* the honest denominator behind it,
 * because on this dataset the denominator is frequently the story.
 */

import type { Record_ } from './records.ts';

export type Metric = 'sum' | 'avg' | 'count' | 'count_distinct' | 'min' | 'max' | 'median' | 'p90';

export type GroupRow = {
  group: string;
  /** Rows in this group. */
  count: number;
  /** Rows in this group that had a usable value for the metric. */
  covered: number;
  value: number | null;
  /** covered / count, as a percentage. */
  coveragePct: number;
};

export type AggregateResult = {
  metric: Metric;
  field: string | null;
  groupBy: string | null;
  rows: GroupRow[];
  total: {
    count: number;
    covered: number;
    value: number | null;
    coveragePct: number;
  };
  /** Human-readable caveats to pass straight through to the answer. */
  caveats: string[];
};

function read(r: Record_, field: string): unknown {
  if (field.startsWith('d.')) return r.d[field.slice(2)] ?? null;
  return r.f[field]?.value ?? null;
}

function label(r: Record_, field: string): string {
  const v = read(r, field);
  if (v === null || v === undefined || v === '') return '(not recorded)';
  return String(v);
}

function compute(metric: Metric, values: number[]): number | null {
  if (metric === 'count') return values.length;
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  switch (metric) {
    case 'sum': return round(values.reduce((a, b) => a + b, 0));
    case 'avg': return round(values.reduce((a, b) => a + b, 0) / values.length);
    case 'min': return round(sorted[0]);
    case 'max': return round(sorted[sorted.length - 1]);
    case 'median': return round(quantile(sorted, 0.5));
    case 'p90': return round(quantile(sorted, 0.9));
    default: return null;
  }
}

function quantile(sorted: number[], q: number): number {
  const pos = (sorted.length - 1) * q;
  const base = Math.floor(pos);
  const rest = pos - base;
  return sorted[base + 1] !== undefined
    ? sorted[base] + rest * (sorted[base + 1] - sorted[base])
    : sorted[base];
}

function round(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export function aggregate(
  records: Record_[],
  opts: { metric: Metric; field?: string | null; groupBy?: string | null; limit?: number; sort?: 'value_desc' | 'value_asc' | 'group_asc' | 'count_desc' },
): AggregateResult {
  const { metric, field = null, groupBy = null } = opts;
  const caveats: string[] = [];

  const needsField = metric !== 'count';
  if (needsField && !field) {
    return {
      metric, field, groupBy, rows: [],
      total: { count: records.length, covered: 0, value: null, coveragePct: 0 },
      caveats: [`The "${metric}" metric needs a field to operate on.`],
    };
  }

  const buckets = new Map<string, Record_[]>();
  if (groupBy) {
    for (const r of records) {
      const g = label(r, groupBy);
      const arr = buckets.get(g);
      if (arr) arr.push(r); else buckets.set(g, [r]);
    }
  } else {
    buckets.set('All', records);
  }

  const mixedUnits = new Set<string>();

  const rows: GroupRow[] = [];
  for (const [group, rs] of buckets) {
    let values: number[] = [];
    let covered = 0;

    if (metric === 'count') {
      covered = rs.length;
      values = new Array(rs.length).fill(1);
    } else if (metric === 'count_distinct') {
      const seen = new Set<string>();
      for (const r of rs) {
        const v = read(r, field!);
        if (v !== null && v !== undefined && v !== '') { seen.add(String(v)); covered += 1; }
      }
      rows.push({ group, count: rs.length, covered, value: seen.size,
        coveragePct: rs.length ? round((covered / rs.length) * 100) : 0 });
      continue;
    } else {
      for (const r of rs) {
        const v = read(r, field!);
        if (typeof v === 'number' && Number.isFinite(v)) { values.push(v); covered += 1; }
        // Track mixed quantity units so we never sum hectares onto tower counts.
        if (field === 'quantityPo' || field === 'quantityBalance') {
          const u = r.d.quantityUnit as string | null;
          if (u) mixedUnits.add(u);
        }
      }
    }

    rows.push({
      group,
      count: rs.length,
      covered,
      value: compute(metric, values),
      coveragePct: rs.length ? round((covered / rs.length) * 100) : 0,
    });
  }

  const sort = opts.sort ?? 'value_desc';
  rows.sort((a, b) => {
    if (sort === 'group_asc') return a.group.localeCompare(b.group);
    if (sort === 'count_desc') return b.count - a.count;
    const av = a.value ?? -Infinity, bv = b.value ?? -Infinity;
    return sort === 'value_asc' ? av - bv : bv - av;
  });

  const limited = opts.limit && opts.limit > 0 ? rows.slice(0, opts.limit) : rows;
  if (limited.length < rows.length) {
    caveats.push(`Showing the top ${limited.length} of ${rows.length} groups.`);
  }

  // Overall total computed across all records, not the sum of the shown rows.
  let allValues: number[] = [];
  let totalCovered = 0;
  if (metric === 'count') {
    totalCovered = records.length;
    allValues = new Array(records.length).fill(1);
  } else if (metric === 'count_distinct') {
    const seen = new Set<string>();
    for (const r of records) {
      const v = read(r, field!);
      if (v !== null && v !== undefined && v !== '') { seen.add(String(v)); totalCovered += 1; }
    }
    allValues = [];
    const res: AggregateResult = {
      metric, field, groupBy, rows: limited,
      total: { count: records.length, covered: totalCovered, value: seen.size,
        coveragePct: records.length ? round((totalCovered / records.length) * 100) : 0 },
      caveats,
    };
    return res;
  } else {
    for (const r of records) {
      const v = read(r, field!);
      if (typeof v === 'number' && Number.isFinite(v)) { allValues.push(v); totalCovered += 1; }
    }
  }

  const coveragePct = records.length ? round((totalCovered / records.length) * 100) : 0;
  if (needsField && coveragePct < 90 && records.length > 0) {
    caveats.push(
      `Only ${totalCovered} of ${records.length} matching rows (${coveragePct}%) have a value recorded for "${field}". ` +
      `The figure covers those ${totalCovered} rows only — the true total is likely higher.`,
    );
  }
  if (mixedUnits.size > 1) {
    caveats.push(
      `These quantities mix ${mixedUnits.size} different units (${[...mixedUnits].join(', ')}). ` +
      `Summing them produces a meaningless number — compare within a single unit instead.`,
    );
  }

  return {
    metric, field, groupBy, rows: limited,
    total: { count: records.length, covered: totalCovered, value: compute(metric, allValues), coveragePct },
    caveats,
  };
}
