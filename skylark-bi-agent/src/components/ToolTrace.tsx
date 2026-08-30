'use client';

/**
 * Shows what the agent actually asked monday.com for.
 *
 * A BI answer is only trustworthy if you can check it, so every tool call is
 * visible and expandable down to the raw JSON. Collapsed by default — the
 * summary line carries enough to spot a wrong filter at a glance.
 */

import React, { useState } from 'react';

export type ToolCall = {
  id: string;
  name: string;
  input: unknown;
  result?: unknown;
  ok?: boolean;
  ms?: number;
  running?: boolean;
};

function summarize(call: ToolCall): string {
  const a = (call.input ?? {}) as Record<string, unknown>;
  const bits: string[] = [];
  if (a.board) bits.push(String(a.board).replace('_', ' '));
  if (a.metric) bits.push(String(a.metric));
  if (a.field) bits.push(String(a.field));
  if (a.group_by) bits.push(`by ${String(a.group_by)}`);
  if (a.period) bits.push(String(a.period));
  if (a.query) bits.push(`"${String(a.query)}"`);
  if (a.join_on) bits.push(`join on ${String(a.join_on)}`);
  if (Array.isArray(a.filters) && a.filters.length) {
    bits.push(
      a.filters
        .slice(0, 3)
        .map((f) => {
          const o = f as { field?: string; op?: string; value?: unknown };
          const v = Array.isArray(o.value) ? o.value.join('/') : o.value;
          return `${o.field} ${o.op}${v !== undefined ? ` ${String(v)}` : ''}`;
        })
        .join(', '),
    );
  }

  const r = call.result as Record<string, unknown> | undefined;
  const out = bits.join(' · ');
  if (!r) return out;
  if (typeof r.rowsMatched === 'number') return `${out} → ${r.rowsMatched} rows`;
  if (typeof r.matched === 'number') return `${out} → ${r.matched} matched`;
  if (typeof r.rowCount === 'number') return `${out} → ${r.rowCount} rows`;
  if (typeof r.distinct === 'number') return `${out} → ${r.distinct} distinct`;
  return out;
}

export function ToolTrace({ calls }: { calls: ToolCall[] }) {
  if (!calls.length) return null;
  return (
    <div className="trace">
      {calls.map((c) => <TraceItem key={c.id} call={c} />)}
    </div>
  );
}

function TraceItem({ call }: { call: ToolCall }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="trace-item" data-open={open}>
      <button className="trace-head" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        {call.running ? (
          <span className="spinner" aria-hidden />
        ) : call.ok === false ? (
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden style={{ color: 'var(--serious)' }}>
            <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.5" />
            <path d="M8 5v4M8 11h.01" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
          </svg>
        ) : (
          <svg width="13" height="13" viewBox="0 0 16 16" fill="none" aria-hidden style={{ color: 'var(--emerald-600)' }}>
            <circle cx="8" cy="8" r="6.5" stroke="currentColor" strokeWidth="1.3" opacity=".35" />
            <path d="M5.2 8.2l2 2 3.6-4" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        )}
        <span className="trace-name">{call.name}</span>
        <span className="trace-summary">{summarize(call)}</span>
        {call.ms !== undefined && <span className="trace-ms">{call.ms} ms</span>}
        <svg className="trace-chevron" width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden>
          <path d="M6 4l4 4-4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      </button>
      {open && (
        <div className="trace-body">
          <p className="trace-sub">Request</p>
          <pre>{JSON.stringify(call.input, null, 2)}</pre>
          {call.result !== undefined && (
            <>
              <p className="trace-sub">Response</p>
              <pre>{JSON.stringify(call.result, null, 2)}</pre>
            </>
          )}
        </div>
      )}
    </div>
  );
}
