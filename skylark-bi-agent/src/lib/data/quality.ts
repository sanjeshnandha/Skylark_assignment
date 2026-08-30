/**
 * Data quality reporting.
 *
 * Two jobs. `boardQuality` profiles a whole board so the agent can answer
 * "how good is this data?" honestly. `caveatsFor` looks at the specific rows
 * behind a specific answer and produces the one or two sentences worth putting
 * in front of a founder — because a wall of generic warnings on every reply
 * trains people to ignore all of them.
 */

import type { Record_ } from './records.ts';
import type { BoardDef } from './schema.ts';

export type FieldQuality = {
  field: string;
  label: string;
  populated: number;
  total: number;
  fillPct: number;
  distinct: number;
  parseIssues: number;
  sampleIssues: string[];
  unusable: boolean;
};

export type BoardQuality = {
  board: string;
  boardName: string;
  totalRows: number;
  excludedRows: number;
  exclusionReasons: Record<string, number>;
  fields: FieldQuality[];
  /** Board-level problems worth naming in an answer. */
  headlines: string[];
  anomalies: string[];
};

export function boardQuality(
  board: BoardDef,
  records: Record_[],
  excluded: Record_[],
): BoardQuality {
  const total = records.length;
  const fields: FieldQuality[] = board.fields.map((def) => {
    let populated = 0, parseIssues = 0;
    const distinct = new Set<string>();
    const issues: string[] = [];
    for (const r of records) {
      const fv = r.f[def.key];
      if (!fv) continue;
      if (fv.value !== null && fv.value !== undefined && fv.value !== '') {
        populated += 1;
        distinct.add(String(fv.value));
      }
      if (fv.issue) {
        parseIssues += 1;
        if (issues.length < 3) issues.push(fv.issue);
      }
    }
    return {
      field: def.key, label: def.label, populated, total,
      fillPct: total ? Math.round((populated / total) * 1000) / 10 : 0,
      distinct: distinct.size, parseIssues, sampleIssues: issues,
      unusable: Boolean(def.unusable) || populated === 0,
    };
  });

  const exclusionReasons: Record<string, number> = {};
  for (const e of excluded) {
    const k = e.excluded?.reason ?? 'unknown';
    exclusionReasons[k] = (exclusionReasons[k] ?? 0) + 1;
  }

  const headlines: string[] = [];
  const empty = fields.filter((f) => f.populated === 0);
  if (empty.length) {
    headlines.push(
      `${empty.length} column${empty.length > 1 ? 's are' : ' is'} completely empty and cannot answer anything: ${empty.map((f) => f.label).join(', ')}.`,
    );
  }
  const sparse = fields.filter((f) => f.populated > 0 && f.fillPct < 50);
  if (sparse.length) {
    headlines.push(
      `${sparse.length} column${sparse.length > 1 ? 's are' : ' is'} under 50% populated: ` +
      sparse.map((f) => `${f.label} (${f.fillPct}%)`).join(', ') + '.',
    );
  }
  if (excluded.length) {
    headlines.push(
      `${excluded.length} row${excluded.length > 1 ? 's were' : ' was'} excluded as non-data: ` +
      Object.entries(exclusionReasons).map(([r, n]) => `${n} × ${r}`).join(', ') + '.',
    );
  }
  const withIssues = fields.filter((f) => f.parseIssues > 0);
  if (withIssues.length) {
    headlines.push(
      `Values that could not be parsed: ` +
      withIssues.map((f) => `${f.label} (${f.parseIssues})`).join(', ') + '.',
    );
  }

  return {
    board: board.id, boardName: board.boardName, totalRows: total,
    excludedRows: excluded.length, exclusionReasons, fields,
    headlines, anomalies: findAnomalies(board, records),
  };
}

/** Business-logic contradictions worth escalating, not just missing values. */
function findAnomalies(board: BoardDef, records: Record_[]): string[] {
  const out: string[] = [];

  if (board.id === 'work_orders') {
    const overBilled = records.filter((r) => r.d.isOverBilled === true);
    if (overBilled.length) {
      const ids = overBilled.slice(0, 5).map((r) => r.f.serialNo?.value).filter(Boolean);
      out.push(
        `${overBilled.length} work order${overBilled.length > 1 ? 's have' : ' has'} been billed for more than the order value (negative amount-to-be-billed): ${ids.join(', ')}${overBilled.length > 5 ? ', …' : ''}. Either the order value was revised upward without the tracker being updated, or these are genuine over-billings.`,
      );
    }
    const conflicts = records.filter((r) => r.d.billingStateConflict);
    if (conflicts.length) {
      out.push(
        `${conflicts.length} work order${conflicts.length > 1 ? 's have' : ' has'} disagreeing values in the two billing columns. Billed value was used as the tie-breaker since it is fully populated.`,
      );
    }
    const noCollection = records.filter((r) => r.d.collectionRecorded === false && (r.f.billedIncGst?.value as number ?? 0) > 0);
    if (noCollection.length) {
      out.push(
        `${noCollection.length} work orders have been billed but have no collection figure recorded at all. Blank is not the same as zero collected, so collection rates exclude them.`,
      );
    }
    const overdue = records.filter((r) => r.d.isOverdue === true);
    if (overdue.length) {
      out.push(`${overdue.length} work orders are past their probable end date and not marked Completed.`);
    }
  }

  if (board.id === 'deals') {
    const wonNoClose = records.filter((r) => r.d.isWon === true && !r.f.closeDateActual?.value);
    if (wonNoClose.length) {
      out.push(
        `${wonNoClose.length} deals are marked Won but have no actual close date, so win-rate-over-time has to fall back to the tentative close date.`,
      );
    }
    const openNoValue = records.filter((r) => r.d.isOpen === true && r.d.hasValue === false);
    if (openNoValue.length) {
      out.push(`${openNoValue.length} open deals carry no deal value, so they are invisible in any pipeline total.`);
    }
    const slipping = records.filter((r) => r.d.isSlipping === true);
    if (slipping.length) {
      out.push(`${slipping.length} open deals have a tentative close date that has already passed.`);
    }
    const nonSector = records.filter((r) => r.d.isTrueSector === false && r.f.sector?.value);
    if (nonSector.length) {
      const labels = [...new Set(nonSector.map((r) => String(r.f.sector!.value)))];
      out.push(
        `${nonSector.length} deals are classified under a value that is not an industry sector (${labels.join(', ')}). Sector breakdowns exclude them.`,
      );
    }
  }

  return out;
}

/**
 * Answer-specific caveats. Given the rows actually used and the fields
 * actually read, returns only what materially affects THIS number — at most a
 * handful of lines, ordered by how much they change the interpretation.
 */
export function caveatsFor(
  records: Record_[],
  fieldsUsed: string[],
  board: BoardDef,
): string[] {
  const out: string[] = [];
  const n = records.length;
  if (n === 0) return ['No rows matched these filters.'];

  for (const key of fieldsUsed) {
    const def = board.fields.find((f) => f.key === key);
    if (!def) continue;
    const populated = records.filter(
      (r) => r.f[key]?.value !== null && r.f[key]?.value !== undefined && r.f[key]?.value !== '',
    ).length;
    const pct = Math.round((populated / n) * 1000) / 10;
    if (populated === 0) {
      out.push(`"${def.label}" is not recorded on any of these ${n} rows.`);
    } else if (pct < 90) {
      out.push(`"${def.label}" is recorded on ${populated} of ${n} rows (${pct}%).`);
    }
  }

  if (records.some((r) => r.d.closeDateBasis === 'tentative')) {
    const t = records.filter((r) => r.d.closeDateBasis === 'tentative').length;
    out.push(`${t} of these deals have no actual close date, so the tentative close date was used.`);
  }

  return out.slice(0, 4);
}
