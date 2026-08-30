/**
 * Shared XLSX reader.
 *
 * Maps spreadsheet columns onto canonical field keys using the header row
 * declared in the schema, matching on a normalized key so that trailing
 * spaces and casing differences in the source headers do not break the map.
 */

import ExcelJS from 'exceljs';
import { categoryKey } from '../src/lib/data/normalize.ts';
import type { BoardDef } from '../src/lib/data/schema.ts';

export type SheetRow = { rowNumber: number; values: Record<string, unknown> };

function cellValue(cell: ExcelJS.Cell): unknown {
  const v = cell.value;
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v;
  if (typeof v === 'object') {
    // exceljs models rich text, formulas, hyperlinks and errors as distinct
    // object shapes; go through `unknown` rather than assert one of them.
    const o = v as unknown as Record<string, unknown>;
    if ('text' in o) return o.text;                       // hyperlink
    if ('result' in o) return o.result;                   // formula
    if ('richText' in o) {
      return (o.richText as Array<{ text: string }>).map((t) => t.text).join('');
    }
    if ('error' in o) return null;                        // #REF! etc.
  }
  return v;
}

export async function readBoardSheet(file: string, def: BoardDef): Promise<SheetRow[]> {
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.readFile(file);

  const ws =
    wb.worksheets.find((s) => categoryKey(s.name) === categoryKey(def.sheetName)) ?? wb.worksheets[0];
  if (!ws) throw new Error(`No worksheet found in ${file}`);

  // exceljs rows are 1-indexed; the schema records a 0-indexed header row.
  const headerRow = ws.getRow(def.headerRow + 1);
  const headerToCol = new Map<string, number>();
  headerRow.eachCell({ includeEmpty: false }, (cell, colNumber) => {
    const k = categoryKey(String(cellValue(cell) ?? ''));
    if (k && !headerToCol.has(k)) headerToCol.set(k, colNumber);
  });

  const fieldToCol = new Map<string, number>();
  const unmatched: string[] = [];
  for (const field of def.fields) {
    const col =
      headerToCol.get(categoryKey(field.source) ?? '') ??
      headerToCol.get(categoryKey(field.label) ?? '');
    if (col) fieldToCol.set(field.key, col);
    else unmatched.push(field.source);
  }
  if (unmatched.length) {
    console.warn(`  ! ${unmatched.length} schema field(s) not found in ${file}: ${unmatched.join(' | ')}`);
  }

  const rows: SheetRow[] = [];
  ws.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber <= def.headerRow + 1) return;
    const values: Record<string, unknown> = {};
    let any = false;
    for (const [key, col] of fieldToCol) {
      const v = cellValue(row.getCell(col));
      values[key] = v;
      if (v !== null && v !== undefined && String(v).trim() !== '') any = true;
    }
    if (any) rows.push({ rowNumber, values });
  });

  return rows;
}
