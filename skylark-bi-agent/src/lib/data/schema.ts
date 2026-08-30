/**
 * Canonical field definitions for both boards.
 *
 * This module is the single source of truth used by three different consumers,
 * which is what keeps them from drifting apart:
 *
 *   1. `scripts/import-to-monday.ts` — creates the monday.com columns and maps
 *      spreadsheet headers onto them.
 *   2. `src/lib/monday/fetch.ts`     — maps monday column values back to typed
 *      records at query time.
 *   3. `src/lib/mcp/tools.ts`        — generates the field documentation the
 *      agent reads to decide what it can filter and group by.
 *
 * Adding a column means editing this file and nothing else.
 */

export type FieldKind =
  | 'text' | 'number' | 'currency' | 'date' | 'month'
  | 'category' | 'sector' | 'stage' | 'dealStatus' | 'probability'
  | 'executionStatus' | 'billingLabel' | 'quantity';

/** monday.com column types we emit at import time. */
export type MondayColumnType = 'text' | 'numbers' | 'date' | 'status' | 'dropdown' | 'name';

export type FieldDef = {
  /** Stable key used everywhere in the agent, the MCP tools and the UI. */
  key: string;
  /** Human label — also the monday.com column title. */
  label: string;
  /** Exact header string in the source spreadsheet. */
  source: string;
  kind: FieldKind;
  mondayType: MondayColumnType;
  /** Shown to the agent so it filters on the right thing. */
  description: string;
  /** Percentage of rows populated in the source, measured during profiling. */
  sourceFill: number;
  /** Excluded from aggregation suggestions — present but unusable. */
  unusable?: boolean;
};

export type BoardDef = {
  id: 'deals' | 'work_orders';
  /** Board name created by the importer and used for auto-discovery. */
  boardName: string;
  sheetName: string;
  /** 0-indexed row in the source sheet that holds the headers. */
  headerRow: number;
  description: string;
  fields: FieldDef[];
};

/* ────────────────────────────────────────────────────────────────────────────
 * Deals — sales pipeline
 * ────────────────────────────────────────────────────────────────────────── */

export const DEALS: BoardDef = {
  id: 'deals',
  boardName: 'Deal Funnel',
  sheetName: 'Deal tracker',
  headerRow: 0,
  description:
    'Sales pipeline. One row per deal opportunity. Deal values are masked but internally consistent, so ratios and comparisons are meaningful even though absolute rupee figures are not the real ones.',
  fields: [
    { key: 'dealName', label: 'Deal Name', source: 'Deal Name', kind: 'text', mondayType: 'name',
      sourceFill: 99.4,
      description: 'Masked deal/opportunity name (codenames such as "Naruto"). NOT unique — 155 distinct names across 346 rows, so the same name can cover several opportunities. Also the only join key to the work orders board.' },
    { key: 'ownerCode', label: 'Owner Code', source: 'Owner code', kind: 'category', mondayType: 'text',
      sourceFill: 95.1,
      description: 'Masked deal owner, OWNER_001..OWNER_007. Same code space as the work orders board BD/KAM field.' },
    { key: 'clientCode', label: 'Client Code', source: 'Client Code', kind: 'category', mondayType: 'text',
      sourceFill: 99.4,
      description: 'Masked client, COMPANY001..COMPANY199. WARNING: masked under a different scheme from the work orders board (WOCOMPANY_xxx) — the two CANNOT be joined on client.' },
    { key: 'dealStatus', label: 'Deal Status', source: 'Deal Status', kind: 'dealStatus', mondayType: 'status',
      sourceFill: 99.7,
      description: 'Won · Dead · Open · On Hold. The headline lifecycle state. "Open" means still live in the pipeline.' },
    { key: 'closeDateActual', label: 'Close Date (Actual)', source: 'Close Date (A)', kind: 'date', mondayType: 'date',
      sourceFill: 8.1,
      description: 'Actual close date. Only 8% populated — including on most Won deals — so it cannot carry win-rate-over-time analysis on its own. Fall back to Tentative Close Date and say so.' },
    { key: 'closureProbability', label: 'Closure Probability', source: 'Closure Probability', kind: 'probability', mondayType: 'status',
      sourceFill: 25.4,
      description: 'High · Medium · Low. Only 25% populated overall, but populated for most Open deals, which is where it matters.' },
    { key: 'dealValue', label: 'Deal Value (Masked, INR)', source: 'Masked Deal value', kind: 'currency', mondayType: 'numbers',
      sourceFill: 47.7,
      description: 'Masked deal value in INR. 48% populated overall BUT ~96% populated for Open deals — so pipeline totals are well covered while historical won/lost values are not. Always report coverage alongside a total.' },
    { key: 'tentativeCloseDate', label: 'Tentative Close Date', source: 'Tentative Close Date', kind: 'date', mondayType: 'date',
      sourceFill: 78.6,
      description: 'Expected close date. The practical basis for "this quarter" pipeline questions given how sparse the actual close date is.' },
    { key: 'dealStage', label: 'Deal Stage', source: 'Deal Stage', kind: 'stage', mondayType: 'status',
      sourceFill: 100,
      description: 'Lettered funnel stage, "A. Lead Generated" through "O. Not Relevant at all". The letter encodes funnel order. "Project Completed" is the one unlettered stage.' },
    { key: 'productDeal', label: 'Product Deal', source: 'Product deal', kind: 'category', mondayType: 'dropdown',
      sourceFill: 50.9,
      description: 'Product mix: Pure Service, Service + Spectra, Dock/DMO/Spectra combinations, Hardware. Distinguishes services revenue from platform revenue.' },
    { key: 'sector', label: 'Sector / Service', source: 'Sector/service', kind: 'sector', mondayType: 'status',
      sourceFill: 97.7,
      description: 'Industry vertical: Mining, Renewables, Railways, Powerline, Construction, Manufacturing, Aviation, Security and Surveillance. NOTE the column also carries two non-sector values, "Tender" and "DSP", which are routes to market — exclude them from sector breakdowns and say that you did.' },
    { key: 'createdDate', label: 'Created Date', source: 'Created Date', kind: 'date', mondayType: 'date',
      sourceFill: 99.7,
      description: 'Date the deal entered the funnel. Range Aug 2024 – Jan 2026. The most reliable date on this board.' },
  ],
};

/* ────────────────────────────────────────────────────────────────────────────
 * Work Orders — project execution, billing and collections
 * ────────────────────────────────────────────────────────────────────────── */

export const WORK_ORDERS: BoardDef = {
  id: 'work_orders',
  boardName: 'Work Order Tracker',
  sheetName: 'work order tracker',
  headerRow: 1, // row 0 of this sheet is entirely blank
  description:
    'Won business in execution. One row per work order, covering delivery status, order value, billing progress and receivables. All rupee amounts are masked but mutually consistent; GST is exactly 18% throughout.',
  fields: [
    { key: 'dealName', label: 'Deal Name', source: 'Deal name masked', kind: 'text', mondayType: 'name',
      sourceFill: 99.4,
      description: 'Masked deal name. Join key to the deals board — 52 of 58 distinct names here also appear there.' },
    { key: 'customerCode', label: 'Customer Code', source: 'Customer Name Code', kind: 'category', mondayType: 'text',
      sourceFill: 100,
      description: 'Masked customer, WOCOMPANY_001..WOCOMPANY_051. Different masking scheme from the deals board — not joinable to Client Code.' },
    { key: 'serialNo', label: 'Serial #', source: 'Serial #', kind: 'text', mondayType: 'text',
      sourceFill: 100,
      description: 'SDPLDEAL-xxx. The only genuinely unique identifier across either board — use it to reference a specific work order.' },
    { key: 'natureOfWork', label: 'Nature of Work', source: 'Nature of Work', kind: 'category', mondayType: 'status',
      sourceFill: 93.2,
      description: 'One time Project · Proof of Concept · Annual Rate Contract · Monthly Contract. Contract types imply recurring vs one-off revenue.' },
    { key: 'lastExecutedMonth', label: 'Last Executed Month', source: 'Last executed month of recurring project', kind: 'month', mondayType: 'text',
      sourceFill: 8.5,
      description: 'Month name only, no year ("Dec", "November"). Applies to recurring contracts. Year must be inferred — never assume one silently.' },
    { key: 'executionStatus', label: 'Execution Status', source: 'Execution Status', kind: 'executionStatus', mondayType: 'status',
      sourceFill: 97.7,
      description: 'Completed · Ongoing · Executed until current month · Not Started · Pause / Struck · Partially Completed · Details pending from Client. The operational delivery state.' },
    { key: 'dataDeliveryDate', label: 'Data Delivery Date', source: 'Data Delivery Date', kind: 'date', mondayType: 'date',
      sourceFill: 33.0,
      description: 'Date processed data was delivered to the client. Sparse — absence does not imply non-delivery.' },
    { key: 'poDate', label: 'Date of PO/LOI', source: 'Date of PO/LOI', kind: 'date', mondayType: 'date',
      sourceFill: 99.4,
      description: 'Date the purchase order or LOI was received. Range Sep 2022 – Jan 2026. The most reliable date on this board and the right basis for "when did we win this" questions.' },
    { key: 'documentType', label: 'Document Type', source: 'Document Type', kind: 'category', mondayType: 'status',
      sourceFill: 92.0,
      description: 'Purchase Order · LOA/LOI · Email Confirmation. Email-confirmation work is contractually weaker.' },
    { key: 'probableStartDate', label: 'Probable Start Date', source: 'Probable Start Date', kind: 'date', mondayType: 'date',
      sourceFill: 89.8, description: 'Planned execution start.' },
    { key: 'probableEndDate', label: 'Probable End Date', source: 'Probable End Date', kind: 'date', mondayType: 'date',
      sourceFill: 89.2, description: 'Planned execution end. Compare with today to find overdue work.' },
    { key: 'ownerCode', label: 'BD/KAM Personnel Code', source: 'BD/KAM Personnel code', kind: 'category', mondayType: 'text',
      sourceFill: 93.8,
      description: 'Masked account owner, OWNER_001..OWNER_008. Same code space as the deals board Owner Code — this is the reliable cross-board join.' },
    { key: 'sector', label: 'Sector', source: 'Sector', kind: 'sector', mondayType: 'status',
      sourceFill: 100,
      description: 'Mining, Renewables, Railways, Powerline, Construction, Others. Fully populated and clean — unlike the deals board, it carries no non-sector values.' },
    { key: 'typeOfWork', label: 'Type of Work', source: 'Type of Work', kind: 'category', mondayType: 'dropdown',
      sourceFill: 100,
      description: 'Service delivered — 36 distinct values (Volumetric survey, Topography Survey: RGB, Powerline Inspection, Hydrology, …). The finest-grained view of what the business actually does.' },
    { key: 'softwarePlatform', label: 'Skylark Platform in Deliverables', source: 'Is any Skylark software platform part of the client deliverables in this deal?', kind: 'category', mondayType: 'status',
      sourceFill: 93.2,
      description: 'NONE · SPECTRA · DMO · SPECTRA + DMO. Identifies platform-attached revenue, which is the strategic mix question.' },
    { key: 'lastInvoiceDate', label: 'Last Invoice Date', source: 'Last invoice date', kind: 'date', mondayType: 'date',
      sourceFill: 49.4, description: 'Date of the most recent invoice raised on this work order.' },
    { key: 'latestInvoiceNo', label: 'Latest Invoice No.', source: 'latest invoice no.', kind: 'text', mondayType: 'text',
      sourceFill: 50.0, description: 'Invoice reference, format SDPL/FY25-26/nnn. The FY prefix encodes the financial year.' },

    { key: 'orderValueExGst', label: 'Order Value (Excl GST)', source: 'Amount in Rupees (Excl of GST) (Masked)', kind: 'currency', mondayType: 'numbers',
      sourceFill: 100,
      description: 'Total order value excluding GST. Fully populated — the most reliable money field on either board and the correct default for "revenue" and "order book" questions.' },
    { key: 'orderValueIncGst', label: 'Order Value (Incl GST)', source: 'Amount in Rupees (Incl of GST) (Masked)', kind: 'currency', mondayType: 'numbers',
      sourceFill: 100, description: 'Order value including 18% GST. Exactly 1.18x the excl-GST figure in every row.' },
    { key: 'billedExGst', label: 'Billed Value (Excl GST)', source: 'Billed Value in Rupees (Excl of GST.) (Masked)', kind: 'currency', mondayType: 'numbers',
      sourceFill: 64.2, description: 'Value invoiced so far, excluding GST.' },
    { key: 'billedIncGst', label: 'Billed Value (Incl GST)', source: 'Billed Value in Rupees (Incl of GST.) (Masked)', kind: 'currency', mondayType: 'numbers',
      sourceFill: 100, description: 'Value invoiced so far including GST. Fully populated (zeros where nothing is billed), so prefer this for billing-progress ratios.' },
    { key: 'collectedIncGst', label: 'Collected Amount (Incl GST)', source: 'Collected Amount in Rupees (Incl of GST.) (Masked)', kind: 'currency', mondayType: 'numbers',
      sourceFill: 44.3, description: 'Cash actually collected, including GST. Blank means no collection recorded, which is not the same as zero collected — flag this when reporting collections.' },
    { key: 'toBillExGst', label: 'To Be Billed (Excl GST)', source: 'Amount to be billed in Rs. (Exl. of GST) (Masked)', kind: 'currency', mondayType: 'numbers',
      sourceFill: 100, description: 'Unbilled remainder excluding GST. Goes NEGATIVE on 6 rows where billing exceeded the order value — a real over-billing signal, not a parsing error.' },
    { key: 'toBillIncGst', label: 'To Be Billed (Incl GST)', source: 'Amount to be billed in Rs. (Incl. of GST) (Masked)', kind: 'currency', mondayType: 'numbers',
      sourceFill: 100, description: 'Unbilled remainder including GST.' },
    { key: 'receivable', label: 'Amount Receivable', source: 'Amount Receivable (Masked)', kind: 'currency', mondayType: 'numbers',
      sourceFill: 100, description: 'Outstanding receivable, including GST. Fully populated — the right field for collections and AR ageing questions.' },
    { key: 'arPriority', label: 'AR Priority Account', source: 'AR Priority account', kind: 'category', mondayType: 'status',
      sourceFill: 5.7, description: 'Flagged "Priority" on 10 rows. Blank means not flagged rather than unknown.' },

    { key: 'quantityOps', label: 'Quantity by Ops', source: 'Quantity by Ops', kind: 'number', mondayType: 'numbers',
      sourceFill: 24.4, description: 'Quantity as measured by operations. Sparse.' },
    { key: 'quantityPo', label: 'Quantity as per PO', source: 'Quantities as per PO', kind: 'quantity', mondayType: 'text',
      sourceFill: 93.2,
      description: 'Free text with the unit inline ("5360 HA", "4", "59.33"). Units are MIXED — hectares, kilometres, tower counts, visit counts — so these must never be summed across different types of work.' },
    { key: 'quantityBilled', label: 'Quantity Billed', source: 'Quantity billed (till date)', kind: 'number', mondayType: 'numbers',
      sourceFill: 13.1, description: 'Quantity billed to date. Very sparse.' },
    { key: 'quantityBalance', label: 'Balance Quantity', source: 'Balance in quantity', kind: 'number', mondayType: 'numbers',
      sourceFill: 89.2, description: 'Quantity still to be delivered or billed. Same mixed-unit caveat as Quantity as per PO.' },

    { key: 'invoiceStatus', label: 'Invoice Status', source: 'Invoice Status', kind: 'billingLabel', mondayType: 'status',
      sourceFill: 63.6,
      description: 'Fully Billed · Partially Billed · Not Billed · Stuck, plus free-text variants like "Billed- Visit 7". Overlaps with Billing Status; the two disagree on some rows.' },
    { key: 'expectedBillingMonth', label: 'Expected Billing Month', source: 'Expected Billing Month', kind: 'month', mondayType: 'text',
      sourceFill: 0, unusable: true,
      description: 'ENTIRELY EMPTY in the source. Present for structural fidelity only — never use it to answer a question; say the data is not captured.' },
    { key: 'actualBillingMonth', label: 'Actual Billing Month', source: 'Actual Billing Month', kind: 'month', mondayType: 'text',
      sourceFill: 39.8,
      description: 'Month name only, no year, and inconsistently abbreviated ("Dec" vs "November"). Normalized to a month number; the year is genuinely unknown.' },
    { key: 'actualCollectionMonth', label: 'Actual Collection Month', source: 'Actual Collection Month', kind: 'month', mondayType: 'text',
      sourceFill: 0, unusable: true, description: 'ENTIRELY EMPTY in the source.' },
    { key: 'woStatusBilled', label: 'WO Status (Billed)', source: 'WO Status (billed)', kind: 'category', mondayType: 'status',
      sourceFill: 58.0, description: 'Open · Closed. Whether the work order is commercially closed out.' },
    { key: 'collectionStatus', label: 'Collection Status', source: 'Collection status', kind: 'category', mondayType: 'status',
      sourceFill: 0, unusable: true,
      description: 'ENTIRELY EMPTY in the source. Collection state must be inferred from Amount Receivable instead.' },
    { key: 'collectionDate', label: 'Collection Date', source: 'Collection Date', kind: 'date', mondayType: 'date',
      sourceFill: 0, unusable: true,
      description: 'ENTIRELY EMPTY in the source. This is why true AR ageing (days outstanding) cannot be computed — only receivable balances.' },
    { key: 'billingStatus', label: 'Billing Status', source: 'Billing Status', kind: 'billingLabel', mondayType: 'status',
      sourceFill: 15.9,
      description: 'Second, sparser billing column: Update Required · Not Billable · Partially Billed · BIlled (sic) · Stuck. Reconciled with Invoice Status at query time.' },
  ],
};

export const BOARDS: BoardDef[] = [DEALS, WORK_ORDERS];

export function boardById(id: string): BoardDef | undefined {
  return BOARDS.find((b) => b.id === id);
}

export function fieldByKey(board: BoardDef, key: string): FieldDef | undefined {
  return board.fields.find((f) => f.key === key);
}

/** Fields safe to sum or average. */
export function numericFields(board: BoardDef): FieldDef[] {
  return board.fields.filter(
    (f) => !f.unusable && (f.kind === 'currency' || f.kind === 'number' || f.kind === 'quantity'),
  );
}

/** Fields safe to group by. */
export function groupableFields(board: BoardDef): FieldDef[] {
  return board.fields.filter(
    (f) => !f.unusable &&
      ['category', 'sector', 'stage', 'dealStatus', 'probability', 'executionStatus', 'billingLabel', 'text', 'month'].includes(f.kind),
  );
}

export function dateFields(board: BoardDef): FieldDef[] {
  return board.fields.filter((f) => !f.unusable && f.kind === 'date');
}
