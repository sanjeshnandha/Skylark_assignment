'use client';

/**
 * Charts and tiles rendered from tool RESULTS, not from model output.
 *
 * This is deliberate. If the model emitted chart data, a hallucinated number
 * could be drawn as a confident bar. Deriving the figure from the same JSON
 * the tool returned means the picture and the prose cannot disagree — and if
 * the model misreads its own tool result, the chart makes that visible rather
 * than hiding it.
 *
 * Form follows the data's job: these are magnitudes compared across
 * categories, so horizontal bars, one series, one emerald hue, sorted by
 * value, directly labelled. No legend (a single series needs none), recessive
 * grid, and a table view for anyone who wants the exact figures.
 */

import React, { useState } from 'react';
import { metricValue, titleCase, compact } from './format.ts';
import { DEALS, WORK_ORDERS } from '../lib/data/schema.ts';

/** Prefer the schema's human label over de-camel-casing the field key. */
function fieldLabel(board: string, key: string | null): string {
  if (!key) return '';
  const def = board === 'deals' ? DEALS : WORK_ORDERS;
  const hit = def.fields.find((f) => f.key === key);
  if (hit) return hit.label;
  const derived: Record<string, string> = {
    'd.weightedValue': 'Weighted Value', 'd.poQuarter': 'PO Quarter',
    'd.closeQuarter': 'Close Quarter', 'd.createdQuarter': 'Created Quarter',
    'd.billingState': 'Billing State', 'd.stageBucket': 'Stage Outcome',
    'd.billedPct': 'Billed %', 'd.poFY': 'Financial Year', 'd.quantityUnit': 'Unit',
  };
  return derived[key] ?? titleCase(key);
}

const METRIC_WORD: Record<string, string> = {
  sum: 'Total', avg: 'Average', count: 'Number of records',
  count_distinct: 'Distinct', min: 'Lowest', max: 'Highest',
  median: 'Median', p90: '90th percentile',
};

/* ── shared shapes ──────────────────────────────────────────────────────── */

type AggregateResult = {
  board: string;
  metric: string;
  field: string | null;
  groupBy: string | null;
  rowsMatched: number;
  total: { count: number; covered: number; value: number | null; coveragePct: number };
  groups: Array<{ group: string; count: number; covered: number; value: number | null; coveragePct: number }>;
  caveats?: string[];
};

export function isAggregate(name: string, r: unknown): r is AggregateResult {
  if (name !== 'aggregate' || !r || typeof r !== 'object') return false;
  const o = r as AggregateResult;
  return Array.isArray(o.groups) && o.groups.length > 1 && Boolean(o.groupBy);
}

/* ── bar chart ──────────────────────────────────────────────────────────── */

export function BarFigure({ result }: { result: AggregateResult }) {
  const [showTable, setShowTable] = useState(false);

  const groups = result.groups.filter((g) => g.value !== null && g.value !== 0).slice(0, 12);
  if (!groups.length) return null;

  const max = Math.max(...groups.map((g) => Math.abs(g.value ?? 0)));
  if (max <= 0) return null;

  const title = result.metric === 'count'
    ? `Number of records by ${fieldLabel(result.board, result.groupBy)}`
    : `${METRIC_WORD[result.metric] ?? titleCase(result.metric)} ${fieldLabel(result.board, result.field)} by ${fieldLabel(result.board, result.groupBy)}`;

  // Coverage is the honest part: say when bars rest on partial data.
  const lowCoverage = groups.filter((g) => g.coveragePct < 90);

  return (
    <figure className="figure">
      <div className="figure-head">
        <div>
          <div className="figure-title">{title}</div>
          <div className="figure-sub">
            {result.rowsMatched.toLocaleString('en-IN')} rows matched
            {result.total.coveragePct < 100 && result.metric !== 'count'
              ? ` · ${result.total.covered} with a value recorded (${result.total.coveragePct}%)`
              : ''}
          </div>
        </div>
        <button className="figure-toggle" onClick={() => setShowTable((v) => !v)}>
          {showTable ? 'Chart' : 'Table'}
        </button>
      </div>

      {showTable ? (
        <div className="table-wrap" style={{ marginTop: 11, marginBottom: 0 }}>
          <table>
            <thead>
              <tr>
                <th>{fieldLabel(result.board, result.groupBy) || 'Group'}</th>
                <th style={{ textAlign: 'right' }}>{METRIC_WORD[result.metric] ?? titleCase(result.metric)}</th>
                <th style={{ textAlign: 'right' }}>Rows</th>
                <th style={{ textAlign: 'right' }}>Coverage</th>
              </tr>
            </thead>
            <tbody>
              {result.groups.map((g) => (
                <tr key={g.group}>
                  <td>{g.group}</td>
                  <td style={{ textAlign: 'right' }}>{metricValue(g.value, result.field, result.metric)}</td>
                  <td style={{ textAlign: 'right' }}>{g.count}</td>
                  <td style={{ textAlign: 'right' }}>{g.coveragePct}%</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="bars" role="img" aria-label={title}>
          {groups.map((g) => {
            const pct = (Math.abs(g.value ?? 0) / max) * 100;
            return (
              <div className="bar-row" key={g.group} title={`${g.group}: ${metricValue(g.value, result.field, result.metric)} across ${g.count} row${g.count === 1 ? '' : 's'}`}>
                <div className="bar-label">{g.group}</div>
                <div className="bar-track">
                  <div className="bar-fill" style={{ width: `${Math.max(pct, 1.2)}%` }} />
                </div>
                <div>
                  <span className="bar-value">{metricValue(g.value, result.field, result.metric)}</span>
                  {result.metric !== 'count' && (
                    <span className="bar-count">{'  '}· {g.count}</span>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}

      {(lowCoverage.length > 0 || result.groups.length > groups.length) && (
        <figcaption className="figure-note">
          {result.groups.length > groups.length &&
            `Showing the top ${groups.length} of ${result.groups.length} groups. `}
          {lowCoverage.length > 0 &&
            `Partial data: ${lowCoverage
              .slice(0, 3)
              .map((g) => `${g.group} (${g.covered}/${g.count} rows)`)
              .join(', ')}${lowCoverage.length > 3 ? `, +${lowCoverage.length - 3} more` : ''}.`}
        </figcaption>
      )}
    </figure>
  );
}

/* ── leadership brief tiles ─────────────────────────────────────────────── */

type Brief = {
  period?: { label?: string };
  pipeline?: { openDeals?: number; openValue?: number; weightedValue?: number; slipping?: number; openValueCoverage?: string };
  outcomes?: { won?: number; lost?: number; winRate?: string };
  execution?: { orderBook?: number; active?: number; overdue?: number; totalWorkOrders?: number };
  billingAndCollections?: { billedInclGst?: number; collectedInclGst?: number; receivable?: number };
};

export function isBrief(name: string, r: unknown): r is Brief {
  return name === 'leadership_brief' && Boolean(r) && typeof r === 'object' && 'pipeline' in (r as object);
}

export function BriefTiles({ brief }: { brief: Brief }) {
  const t: Array<{ label: string; value: string; meta?: string }> = [];

  if (brief.pipeline?.openValue !== undefined) {
    t.push({
      label: 'Open pipeline',
      value: inrShort(brief.pipeline.openValue),
      meta: `${brief.pipeline.openDeals ?? 0} open deals`,
    });
  }
  if (brief.pipeline?.weightedValue !== undefined) {
    t.push({ label: 'Weighted', value: inrShort(brief.pipeline.weightedValue), meta: 'by close probability' });
  }
  if (brief.execution?.orderBook !== undefined) {
    t.push({
      label: 'Order book',
      value: inrShort(brief.execution.orderBook),
      meta: `${brief.execution.totalWorkOrders ?? 0} work orders`,
    });
  }
  if (brief.billingAndCollections?.receivable !== undefined) {
    t.push({ label: 'Receivable', value: inrShort(brief.billingAndCollections.receivable), meta: 'outstanding' });
  }
  if (brief.outcomes?.winRate) {
    t.push({ label: 'Win rate', value: brief.outcomes.winRate.replace(' of resolved deals', ''), meta: `${brief.outcomes.won ?? 0}W / ${brief.outcomes.lost ?? 0}L` });
  }
  if (brief.pipeline?.slipping !== undefined) {
    t.push({ label: 'Slipping', value: String(brief.pipeline.slipping), meta: 'past expected close' });
  }

  if (!t.length) return null;
  return (
    <div className="tiles">
      {t.map((x) => (
        <div className="tile" key={x.label}>
          <div className="tile-label">{x.label}</div>
          <div className="tile-value">{x.value}</div>
          {x.meta && <div className="tile-meta">{x.meta}</div>}
        </div>
      ))}
    </div>
  );
}

function inrShort(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  return `₹${compact(n)}`;
}
