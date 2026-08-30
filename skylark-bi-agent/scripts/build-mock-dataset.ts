/**
 * Generates data/mock-dataset.json from the two source workbooks.
 *
 * Test fixture only — the output is gitignored, so no spreadsheet data is ever
 * committed. See src/lib/mock/mock-monday.ts.
 *
 *   npm run mock:build -- "<Deal funnel Data.xlsx>" "<Work_Order_Tracker Data.xlsx>"
 */

import { writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { readBoardSheet } from './read-workbook.ts';
import { DEALS, WORK_ORDERS } from '../src/lib/data/schema.ts';

const [dealsFile, woFile] = process.argv.slice(2);
if (!dealsFile || !woFile) {
  console.error('Usage: npm run mock:build -- "<Deal funnel Data.xlsx>" "<Work_Order_Tracker Data.xlsx>"');
  process.exit(1);
}

const [deals, wos] = await Promise.all([
  readBoardSheet(dealsFile, DEALS),
  readBoardSheet(woFile, WORK_ORDERS),
]);

const out = {
  generatedAt: new Date().toISOString(),
  note: 'Offline test fixture generated from the source workbooks. Not committed; not used when DATA_SOURCE=live.',
  boards: {
    deals: {
      name: DEALS.boardName,
      rows: deals.map((r) => ({ id: `mock-d-${r.rowNumber}`, values: r.values })),
    },
    work_orders: {
      name: WORK_ORDERS.boardName,
      rows: wos.map((r) => ({ id: `mock-w-${r.rowNumber}`, values: r.values })),
    },
  },
};

await mkdir(path.join(process.cwd(), 'data'), { recursive: true });
await writeFile(path.join(process.cwd(), 'data', 'mock-dataset.json'), JSON.stringify(out), 'utf8');
console.log(`✓ data/mock-dataset.json — ${deals.length} deals, ${wos.length} work orders`);
