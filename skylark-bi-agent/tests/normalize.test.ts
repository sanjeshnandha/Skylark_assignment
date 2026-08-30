import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  normNumber, normDate, normMonthName, normQuantity, normSector, normStage,
  normDealStatus, normProbability, normBillingLabel, categoryKey, isBlank,
} from '../src/lib/data/normalize.ts';

test('currency: Indian and Western grouping, symbols, negatives, scale suffixes', () => {
  assert.equal(normNumber('₹12,34,567').value, 1234567);
  assert.equal(normNumber('1,234,567.89').value, 1234567.89);
  assert.equal(normNumber('Rs. 45000').value, 45000);
  assert.equal(normNumber('(2500)').value, -2500);
  assert.equal(normNumber('-1500').value, -1500);
  assert.equal(normNumber('2.5 Cr').value, 25000000);
  assert.equal(normNumber('15 lakhs').value, 1500000);
  assert.equal(normNumber('12k').value, 12000);
});

test('currency: spreadsheet float noise is snapped to 2dp', () => {
  assert.equal(normNumber(2984097.3600000003).value, 2984097.36);
  assert.equal(normNumber(0.10432872).value, 0.1);
});

test('currency: unparseable input returns null with a reason, never 0', () => {
  const r = normNumber('pending');
  assert.equal(r.value, null);
  assert.ok(r.issue);
});

test('blank placeholders: "none" and "nil" are real values, not blanks', () => {
  assert.equal(isBlank('N/A'), true);
  assert.equal(isBlank('  '), true);
  assert.equal(isBlank('#REF!'), true);
  // Regression: NONE is a real answer on the software-platform column.
  assert.equal(isBlank('NONE'), false);
  assert.equal(isBlank('nil'), false);
});

test('dates: ISO, Excel serial, day-first slashes, and written forms', () => {
  assert.equal(normDate('2025-11-28').value, '2025-11-28');
  assert.equal(normDate(new Date(Date.UTC(2025, 10, 28))).value, '2025-11-28');
  assert.equal(normDate(45989).value, '2025-11-28');
  assert.equal(normDate('28/11/2025').value, '2025-11-28');
  assert.equal(normDate('28-11-25').value, '2025-11-28');
  assert.equal(normDate('28 Nov 2025').value, '2025-11-28');
  assert.equal(normDate('Nov 28, 2025').value, '2025-11-28');
});

test('dates: ambiguous slash dates read day-first', () => {
  // 3 March, not 5 March — the documented Indian-format assumption.
  assert.equal(normDate('03/05/2025').value, '2025-05-03');
  // Unambiguous: 25 cannot be a month.
  assert.equal(normDate('25/03/2025').value, '2025-03-25');
  // Impossible day-first, so it must be month-first.
  assert.equal(normDate('03/25/2025').value, '2025-03-25');
});

test('dates: impossible and out-of-range values are rejected, not coerced', () => {
  assert.equal(normDate('31/02/2025').value, null);
  assert.equal(normDate('not a date').value, null);
  // A plain quantity in a date column must not become a date.
  assert.equal(normDate(4).value, null);
});

test('months: inconsistent abbreviation is normalized, year never invented', () => {
  assert.equal(normMonthName('Dec').value, 12);
  assert.equal(normMonthName('November').value, 11);
  assert.equal(normMonthName('june').value, 6);
  assert.equal(normMonthName('rubbish').value, null);
});

test('quantity: number and unit are separated, aliases folded', () => {
  assert.deepEqual(
    { v: normQuantity('5360 HA').value, u: normQuantity('5360 HA').unit },
    { v: 5360, u: 'HA' },
  );
  assert.equal(normQuantity('59.33').value, 59.33);
  assert.equal(normQuantity('59.33').unit, null);
  // Source typos for the same unit must collapse together.
  assert.equal(normQuantity('12 ACERS').unit, 'ACRE');
  assert.equal(normQuantity('12 Acres').unit, 'ACRE');
  assert.equal(normQuantity('4 nos').unit, 'COUNT');
});

test('sector: aliases resolve and non-sectors are flagged', () => {
  assert.equal(normSector('mining').value, 'Mining');
  assert.equal(normSector('Renewables').kind, 'sector');
  assert.equal(normSector('Tender').kind, 'route-to-market');
  assert.equal(normSector('DSP').kind, 'route-to-market');
  assert.equal(normSector('Others').kind, 'unclassified');
});

test('stage: funnel letter parsed for ordering, unlettered stage slotted by meaning', () => {
  const a = normStage('A. Lead Generated').value!;
  assert.equal(a.order, 1);
  assert.equal(a.bucket, 'open');
  const g = normStage('G. Project Won').value!;
  assert.equal(g.bucket, 'won');
  const l = normStage('L. Project Lost').value!;
  assert.equal(l.bucket, 'lost');
  // The one stage in the source with no letter.
  const pc = normStage('Project Completed').value!;
  assert.equal(pc.bucket, 'won');
  assert.equal(pc.order, 10.5);
});

test('statuses: casing and typos reconcile', () => {
  assert.equal(normDealStatus('won').value, 'Won');
  assert.equal(normDealStatus('On Hold').value, 'On Hold');
  assert.equal(normProbability('high').value, 'High');
  // "BIlled" is a real typo in the source.
  assert.equal(normBillingLabel('BIlled').value, 'Fully Billed');
  assert.equal(normBillingLabel('Billed- Visit 7').value, 'Partially Billed');
});

test('categoryKey collapses cosmetic differences only', () => {
  assert.equal(categoryKey('Fully Billed'), categoryKey('fully  billed'));
  assert.equal(categoryKey('WO Status (billed)'), categoryKey('wo status billed'));
  assert.notEqual(categoryKey('Mining'), categoryKey('Railways'));
});
