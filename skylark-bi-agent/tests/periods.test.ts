import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolvePeriod, fyOf, fyQuarterOf, fyLabel } from '../src/lib/data/dates.ts';

// Fixed "today" so these assertions never rot.
const TODAY = new Date(Date.UTC(2025, 10, 15)); // 15 Nov 2025 → Q3 FY2025-26

test('financial year runs April to March', () => {
  assert.equal(fyOf('2025-11-15'), 2025);
  assert.equal(fyOf('2026-03-31'), 2025);
  assert.equal(fyOf('2026-04-01'), 2026);
  assert.equal(fyLabel(2025), 'FY2025-26');
});

test('FY quarters: Q1 is Apr-Jun', () => {
  assert.equal(fyQuarterOf('2025-04-01'), 1);
  assert.equal(fyQuarterOf('2025-07-01'), 2);
  assert.equal(fyQuarterOf('2025-11-15'), 3);
  assert.equal(fyQuarterOf('2026-01-01'), 4);
});

test('"this quarter" is the FY quarter, not the calendar quarter', () => {
  const p = resolvePeriod('this_quarter', TODAY)!;
  assert.equal(p.from, '2025-10-01');
  assert.equal(p.to, '2025-12-31');
  assert.equal(p.convention, 'financial-year');
  assert.match(p.label, /Q3 FY2025-26/);
});

test('last quarter rolls back across the FY boundary correctly', () => {
  const p = resolvePeriod('last_quarter', TODAY)!;
  assert.equal(p.from, '2025-07-01');
  assert.equal(p.to, '2025-09-30');

  // From Q1, "last quarter" is Q4 of the PREVIOUS financial year.
  const fromQ1 = resolvePeriod('last_quarter', new Date(Date.UTC(2025, 4, 10)))!;
  assert.equal(fromQ1.from, '2025-01-01');
  assert.equal(fromQ1.to, '2025-03-31');
});

test('calendar quarters are available explicitly and differ from FY', () => {
  const cq = resolvePeriod('CQ3_2025', TODAY)!;
  assert.equal(cq.from, '2025-07-01');
  assert.equal(cq.convention, 'calendar');
});

test('explicit ranges, financial years and named FY quarters parse', () => {
  assert.equal(resolvePeriod('2025-07-01..2025-09-30', TODAY)!.from, '2025-07-01');
  assert.equal(resolvePeriod('FY2025', TODAY)!.to, '2026-03-31');
  assert.equal(resolvePeriod('Q1_FY2025', TODAY)!.from, '2025-04-01');
});

test('ytd runs from 1 April to today', () => {
  const p = resolvePeriod('ytd', TODAY)!;
  assert.equal(p.from, '2025-04-01');
  assert.equal(p.to, '2025-11-15');
});

test('month ends are correct including February in a leap year', () => {
  assert.equal(resolvePeriod('this_month', new Date(Date.UTC(2024, 1, 10)))!.to, '2024-02-29');
  assert.equal(resolvePeriod('this_month', new Date(Date.UTC(2025, 1, 10)))!.to, '2025-02-28');
});

test('unknown expressions return null rather than a silent default', () => {
  assert.equal(resolvePeriod('sometime soon', TODAY), null);
});
