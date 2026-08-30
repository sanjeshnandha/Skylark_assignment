/**
 * Filter DSL.
 *
 * Deliberately small and declarative: the agent emits JSON, never code, and
 * every operator degrades predictably on missing data. The rule throughout is
 * that **null never silently satisfies a filter** — a deal with no recorded
 * value is not "under 10 lakh", it is unknown, and it is counted as such in
 * the coverage numbers the agent reports.
 */

import type { Record_ } from './records.ts';
import { categoryKey } from './normalize.ts';
import { resolvePeriod, type Period } from './dates.ts';

export type Op =
  | 'eq' | 'neq' | 'in' | 'not_in' | 'contains' | 'starts_with'
  | 'gt' | 'gte' | 'lt' | 'lte' | 'between'
  | 'is_null' | 'is_not_null' | 'is_true' | 'is_false'
  | 'in_period' | 'before' | 'after';

export type Filter = {
  /** Canonical field key, or a derived key prefixed with `d.` (e.g. `d.isOpen`). */
  field: string;
  op: Op;
  value?: unknown;
  /** For `between`. */
  value2?: unknown;
};

export type FilterResult = {
  matched: Record_[];
  /** Rows rejected purely because the filtered field was null. */
  unknownOnField: number;
  notes: string[];
};

function read(r: Record_, field: string): { value: unknown; present: boolean } {
  if (field.startsWith('d.')) {
    const v = r.d[field.slice(2)];
    return { value: v ?? null, present: v !== null && v !== undefined };
  }
  const fv = r.f[field];
  if (!fv) return { value: null, present: false };
  return { value: fv.value, present: fv.value !== null && fv.value !== undefined };
}

function looseEq(a: unknown, b: unknown): boolean {
  if (typeof a === 'number' && typeof b === 'number') return a === b;
  if (typeof a === 'boolean' || typeof b === 'boolean') return Boolean(a) === Boolean(b);
  const ka = categoryKey(String(a));
  const kb = categoryKey(String(b));
  return ka !== null && ka === kb;
}

function asNumber(v: unknown): number | null {
  if (typeof v === 'number') return v;
  if (typeof v === 'string') {
    const n = Number(v.replace(/,/g, ''));
    return Number.isFinite(n) ? n : null;
  }
  return null;
}


/**
 * Repairs loosely-typed filter values before they are compared.
 *
 * Tool schemas declare polymorphic values as strings so the same definition
 * works on Gemini, Groq and Anthropic (see agent/providers/schema.ts). This
 * turns them back into real types. It also absorbs the everyday sloppiness of
 * every model tested: `"1000"` for a number, `'["Mining","Renewables"]'` for a
 * list, `"true"` for a boolean, and a comma-joined string where an array was
 * expected.
 *
 * Anything that does not clearly parse is left exactly as it came, so a
 * genuine string value like "SDPLDEAL-004" is never mangled.
 */
export function coerceFilterValues(filters: Filter[]): Filter[] {
  return filters.map((f) => {
    const next: Filter = { ...f };
    if ('value' in next) next.value = coerce(next.value, next.op);
    if ('value2' in next) next.value2 = coerce(next.value2, next.op);
    return next;
  });
}

function coerce(v: unknown, op: Op): unknown {
  if (v === null || v === undefined) return v;
  if (Array.isArray(v)) return v.map((x) => coerce(x, 'eq'));
  if (typeof v !== 'string') return v;

  const s = v.trim();

  // A period expression must survive untouched.
  if (op === 'in_period') return s;

  // JSON array, e.g. ["Mining","Renewables"]
  if (s.startsWith('[') && s.endsWith(']')) {
    try {
      const parsed = JSON.parse(s);
      if (Array.isArray(parsed)) return parsed;
    } catch {
      // Malformed JSON array — fall back to splitting on commas.
      const inner = s.slice(1, -1).trim();
      if (inner) return inner.split(',').map((x) => x.trim().replace(/^["']|["']$/g, ''));
    }
  }

  // A comma-joined list where a list was expected.
  if ((op === 'in' || op === 'not_in') && s.includes(',')) {
    return s.split(',').map((x) => x.trim()).filter(Boolean);
  }

  if (s === 'true') return true;
  if (s === 'false') return false;
  if (s === 'null') return null;

  // Numeric string, but never for a date — "2025" must not become the number 2025.
  if (/^-?\d+(\.\d+)?$/.test(s) && !/^\d{4}-\d{2}-\d{2}$/.test(s)) {
    const n = Number(s);
    if (Number.isFinite(n)) return n;
  }

  return s;
}

export function applyFilters(
  records: Record_[],
  filters: Filter[],
  today = new Date(),
): FilterResult {
  const notes: string[] = [];
  let unknownOnField = 0;
  if (!filters.length) return { matched: records, unknownOnField: 0, notes };
  filters = coerceFilterValues(filters);

  const periods = new Map<string, Period>();
  for (const f of filters) {
    if (f.op === 'in_period') {
      const p = resolvePeriod(String(f.value), today);
      if (!p) {
        notes.push(`Could not interpret the period "${String(f.value)}" — that filter was ignored.`);
        continue;
      }
      periods.set(`${f.field}::${String(f.value)}`, p);
      notes.push(`"${String(f.value)}" resolved to ${p.label}${p.convention === 'financial-year' ? ' using the Indian financial year (Apr–Mar)' : ''}.`);
    }
  }

  const matched = records.filter((r) => {
    for (const f of filters) {
      const { value, present } = read(r, f.field);

      if (f.op === 'is_null') { if (present) return false; continue; }
      if (f.op === 'is_not_null') { if (!present) return false; continue; }
      if (f.op === 'is_true') { if (value !== true) return false; continue; }
      if (f.op === 'is_false') { if (value !== false) return false; continue; }

      // Every remaining operator requires a value to compare against.
      if (!present) { unknownOnField += 1; return false; }

      switch (f.op) {
        case 'eq': if (!looseEq(value, f.value)) return false; break;
        case 'neq': if (looseEq(value, f.value)) return false; break;
        case 'in': {
          const arr = Array.isArray(f.value) ? f.value : [f.value];
          if (!arr.some((x) => looseEq(value, x))) return false;
          break;
        }
        case 'not_in': {
          const arr = Array.isArray(f.value) ? f.value : [f.value];
          if (arr.some((x) => looseEq(value, x))) return false;
          break;
        }
        case 'contains':
          if (!String(value).toLowerCase().includes(String(f.value).toLowerCase())) return false;
          break;
        case 'starts_with':
          if (!String(value).toLowerCase().startsWith(String(f.value).toLowerCase())) return false;
          break;
        case 'gt': case 'gte': case 'lt': case 'lte': case 'between': {
          const a = asNumber(value);
          const b = asNumber(f.value);
          if (a === null || b === null) {
            // Dates compare lexicographically as ISO strings.
            const sv = String(value), fv = String(f.value);
            if (f.op === 'gt' && !(sv > fv)) return false;
            if (f.op === 'gte' && !(sv >= fv)) return false;
            if (f.op === 'lt' && !(sv < fv)) return false;
            if (f.op === 'lte' && !(sv <= fv)) return false;
            if (f.op === 'between' && !(sv >= fv && sv <= String(f.value2))) return false;
            break;
          }
          if (f.op === 'gt' && !(a > b)) return false;
          if (f.op === 'gte' && !(a >= b)) return false;
          if (f.op === 'lt' && !(a < b)) return false;
          if (f.op === 'lte' && !(a <= b)) return false;
          if (f.op === 'between') {
            const c = asNumber(f.value2);
            if (c === null || !(a >= b && a <= c)) return false;
          }
          break;
        }
        case 'before': if (!(String(value) < String(f.value))) return false; break;
        case 'after': if (!(String(value) > String(f.value))) return false; break;
        case 'in_period': {
          const p = periods.get(`${f.field}::${String(f.value)}`);
          if (!p) break; // unresolvable period → filter ignored, already noted
          const iso = String(value);
          if (!(iso >= p.from && iso <= p.to)) return false;
          break;
        }
      }
    }
    return true;
  });

  return { matched, unknownOnField, notes };
}

/** Free-text search across every string field of a record. */
export function searchRecords(records: Record_[], query: string): Record_[] {
  const q = query.trim().toLowerCase();
  if (!q) return records;
  return records.filter((r) =>
    Object.values(r.f).some((fv) => fv.value !== null && String(fv.value).toLowerCase().includes(q)),
  );
}
