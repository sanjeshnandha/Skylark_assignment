import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRecords } from '../src/lib/data/records.ts';
import { DEALS, WORK_ORDERS } from '../src/lib/data/schema.ts';
import { applyFilters } from '../src/lib/data/filter.ts';
import { aggregate } from '../src/lib/data/aggregate.ts';

const TODAY = '2026-01-15';

function deals(rows: Array<Record<string, unknown>>) {
  return buildRecords(DEALS, rows.map((values, i) => ({ id: `d${i}`, values })), TODAY);
}

test('repeated header rows embedded in the data are excluded', () => {
  const { records, excluded } = deals([
    { dealName: 'Naruto', dealStatus: 'Open', dealStage: 'A. Lead Generated', dealValue: 100 },
    // The real shape of the junk rows: a plausible name, header text elsewhere.
    { dealName: 'Nezuko', dealStatus: 'Deal Status', 'closeDateActual': 'Close Date (A)', dealStage: 'Deal Stage' },
    { dealName: 'Sakura', dealStatus: 'Won', dealStage: 'G. Project Won', dealValue: 200 },
  ]);
  assert.equal(records.length, 2);
  assert.equal(excluded.length, 1);
  assert.match(excluded[0].excluded!.reason, /header/);
});

test('missing values never satisfy a comparison filter', () => {
  const { records } = deals([
    { dealName: 'A', dealValue: 500000, dealStatus: 'Open' },
    { dealName: 'B', dealValue: null, dealStatus: 'Open' },
    { dealName: 'C', dealValue: 50, dealStatus: 'Open' },
  ]);
  const r = applyFilters(records, [{ field: 'dealValue', op: 'lt', value: 1000 }]);
  // B has no value: it is unknown, not "under 1000".
  assert.equal(r.matched.length, 1);
  assert.equal(r.matched[0].f.dealName.value, 'C');
  assert.equal(r.unknownOnField, 1);
});

test('is_null finds the unrecorded rows deliberately', () => {
  const { records } = deals([
    { dealName: 'A', dealValue: 100 },
    { dealName: 'B', dealValue: null },
  ]);
  assert.equal(applyFilters(records, [{ field: 'dealValue', op: 'is_null' }]).matched.length, 1);
  assert.equal(applyFilters(records, [{ field: 'dealValue', op: 'is_not_null' }]).matched.length, 1);
});

test('aggregation reports coverage and warns when it is partial', () => {
  const { records } = deals([
    { dealName: 'A', sector: 'Mining', dealValue: 100, dealStatus: 'Open' },
    { dealName: 'B', sector: 'Mining', dealValue: null, dealStatus: 'Open' },
    { dealName: 'C', sector: 'Renewables', dealValue: 300, dealStatus: 'Open' },
  ]);
  const r = aggregate(records, { metric: 'sum', field: 'dealValue', groupBy: 'sector' });
  const mining = r.rows.find((x) => x.group === 'Mining')!;
  assert.equal(mining.value, 100);
  assert.equal(mining.count, 2);      // two Mining rows
  assert.equal(mining.covered, 1);    // only one has a value
  assert.equal(r.total.value, 400);
  assert.equal(r.total.coveragePct, 66.67);
  assert.ok(r.caveats.some((c) => /2 of 3|66/.test(c)), 'expected a coverage caveat');
});

test('a group with no values yields null, never a misleading zero', () => {
  const { records } = deals([
    { dealName: 'A', sector: 'Mining', dealValue: null },
    { dealName: 'B', sector: 'Mining', dealValue: null },
  ]);
  const r = aggregate(records, { metric: 'sum', field: 'dealValue', groupBy: 'sector' });
  assert.equal(r.rows[0].value, null);
  assert.notEqual(r.rows[0].value, 0);
});

test('probability-weighted value requires both a value and a band', () => {
  const { records } = deals([
    { dealName: 'A', dealValue: 1000, closureProbability: 'High', dealStatus: 'Open' },
    { dealName: 'B', dealValue: 1000, closureProbability: null, dealStatus: 'Open' },
  ]);
  assert.equal(records[0].d.weightedValue, 750);
  assert.equal(records[1].d.weightedValue, null); // not 0, and not unweighted
});

test('effective close date falls back to tentative and records which was used', () => {
  const { records } = deals([
    { dealName: 'A', closeDateActual: '2025-06-01', tentativeCloseDate: '2025-07-01' },
    { dealName: 'B', tentativeCloseDate: '2025-07-01' },
  ]);
  assert.equal(records[0].d.effectiveCloseDate, '2025-06-01');
  assert.equal(records[0].d.closeDateBasis, 'actual');
  assert.equal(records[1].d.effectiveCloseDate, '2025-07-01');
  assert.equal(records[1].d.closeDateBasis, 'tentative');
});

test('slipping deals are open with a close date already past', () => {
  const { records } = deals([
    { dealName: 'A', dealStatus: 'Open', tentativeCloseDate: '2025-01-01' },
    { dealName: 'B', dealStatus: 'Open', tentativeCloseDate: '2026-12-01' },
    { dealName: 'C', dealStatus: 'Won', tentativeCloseDate: '2025-01-01' },
  ]);
  assert.equal(records[0].d.isSlipping, true);
  assert.equal(records[1].d.isSlipping, false);
  assert.equal(records[2].d.isSlipping, false); // won, so not slipping
});

test('billing state is derived from money and conflicts are reported', () => {
  const { records } = buildRecords(WORK_ORDERS, [
    // Money says fully billed; the status columns disagree with each other.
    { id: 'w1', values: { serialNo: 'X1', orderValueIncGst: 1000, billedIncGst: 1000, invoiceStatus: 'Partially Billed', billingStatus: 'BIlled' } },
    { id: 'w2', values: { serialNo: 'X2', orderValueIncGst: 1000, billedIncGst: 0 } },
    { id: 'w3', values: { serialNo: 'X3', orderValueIncGst: 1000, billedIncGst: 400 } },
  ], TODAY);
  assert.equal(records[0].d.billingState, 'Fully Billed');
  assert.ok(records[0].d.billingStateConflict);
  assert.equal(records[1].d.billingState, 'Not Billed');
  assert.equal(records[2].d.billingState, 'Partially Billed');
});

test('blank collections are not read as zero collected', () => {
  const { records } = buildRecords(WORK_ORDERS, [
    { id: 'w1', values: { serialNo: 'X1', orderValueIncGst: 1000, billedIncGst: 1000, collectedIncGst: null } },
    { id: 'w2', values: { serialNo: 'X2', orderValueIncGst: 1000, billedIncGst: 1000, collectedIncGst: 0 } },
  ], TODAY);
  assert.equal(records[0].d.collectionRecorded, false);
  assert.equal(records[0].d.collectedPct, null);
  assert.equal(records[1].d.collectionRecorded, true);
  assert.equal(records[1].d.collectedPct, 0);
});

test('over-billing is detected rather than clamped away', () => {
  const { records } = buildRecords(WORK_ORDERS, [
    { id: 'w1', values: { serialNo: 'X1', orderValueExGst: 1000, toBillExGst: -500 } },
    { id: 'w2', values: { serialNo: 'X2', orderValueExGst: 1000, toBillExGst: 200 } },
  ], TODAY);
  assert.equal(records[0].d.isOverBilled, true);
  assert.equal(records[1].d.isOverBilled, false);
});

test('mixed quantity units raise a caveat instead of a bogus total', () => {
  const { records } = buildRecords(WORK_ORDERS, [
    { id: 'w1', values: { serialNo: 'X1', quantityPo: '5000 HA' } },
    { id: 'w2', values: { serialNo: 'X2', quantityPo: '20 KM' } },
  ], TODAY);
  const r = aggregate(records, { metric: 'sum', field: 'quantityPo', groupBy: null });
  assert.ok(r.caveats.some((c) => /different units/i.test(c)), 'expected a mixed-unit caveat');
});

test('period filters resolve against the FY calendar', () => {
  const { records } = deals([
    { dealName: 'A', tentativeCloseDate: '2025-11-10', dealStatus: 'Open' },
    { dealName: 'B', tentativeCloseDate: '2025-08-10', dealStatus: 'Open' },
  ]);
  const r = applyFilters(
    records,
    [{ field: 'tentativeCloseDate', op: 'in_period', value: 'this_quarter' }],
    new Date(Date.UTC(2025, 10, 15)),
  );
  assert.equal(r.matched.length, 1);
  assert.equal(r.matched[0].f.dealName.value, 'A');
  assert.ok(r.notes.some((n) => /financial year/i.test(n)));
});
