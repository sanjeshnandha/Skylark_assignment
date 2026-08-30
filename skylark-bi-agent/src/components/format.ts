/**
 * Indian-format number rendering, shared by every component so the sidebar,
 * the tiles and the charts never disagree about what ₹6.88 Cr means.
 */

export function inr(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  const sign = n < 0 ? '-' : '';
  if (abs >= 1e7) return `${sign}₹${(abs / 1e7).toFixed(2)} Cr`;
  if (abs >= 1e5) return `${sign}₹${(abs / 1e5).toFixed(1)} L`;
  if (abs >= 1000) return `${sign}₹${Math.round(abs).toLocaleString('en-IN')}`;
  return `${sign}₹${abs.toFixed(abs % 1 === 0 ? 0 : 2)}`;
}

export function compact(n: number | null | undefined): string {
  if (n === null || n === undefined || !Number.isFinite(n)) return '—';
  const abs = Math.abs(n);
  if (abs >= 1e7) return `${(n / 1e7).toFixed(2)} Cr`;
  if (abs >= 1e5) return `${(n / 1e5).toFixed(1)} L`;
  if (abs >= 1000) return n.toLocaleString('en-IN', { maximumFractionDigits: 0 });
  return String(Math.round(n * 100) / 100);
}

/** Currency fields get a rupee symbol; counts and percentages do not. */
const CURRENCY_FIELDS = new Set([
  'dealValue', 'orderValueExGst', 'orderValueIncGst', 'billedExGst', 'billedIncGst',
  'collectedIncGst', 'toBillExGst', 'toBillIncGst', 'receivable', 'weightedValue',
  'd.weightedValue', 'd.unbilled',
]);

export function isCurrencyField(field: string | null | undefined): boolean {
  return Boolean(field && CURRENCY_FIELDS.has(field));
}

export function metricValue(v: number | null, field: string | null, metric: string): string {
  if (v === null) return '—';
  if (metric === 'count' || metric === 'count_distinct') return v.toLocaleString('en-IN');
  return isCurrencyField(field) ? inr(v) : compact(v);
}

export function titleCase(s: string): string {
  return s.replace(/^d\./, '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ')
    .replace(/^\w/, (c) => c.toUpperCase());
}
