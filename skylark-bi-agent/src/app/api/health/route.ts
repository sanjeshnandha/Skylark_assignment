/**
 * Health and configuration check. Reports what is wired up without ever
 * echoing a secret — useful when a deployment misbehaves.
 */

import { getDataSource } from '../../../lib/monday/source.ts';
import { TOOLS } from '../../../lib/mcp/tools.ts';
import { selectedProviderId, configuredProviders, createProvider } from '../../../lib/agent/providers/index.ts';

export const runtime = 'nodejs';

export async function GET() {
  let model = '(none)';
  try { model = createProvider().label; } catch { /* reported via llmProvider below */ }

  const checks: Record<string, unknown> = {
    llmProvider: selectedProviderId() ?? '(none configured)',
    llmModel: model,
    keysPresent: configuredProviders(),
    dataSource: (process.env.DATA_SOURCE ?? 'live').toLowerCase(),
    mondayToken: Boolean(process.env.MONDAY_API_TOKEN?.trim()),
    dealsBoardId: process.env.MONDAY_DEALS_BOARD_ID?.trim() || '(auto-discover by name)',
    workOrdersBoardId: process.env.MONDAY_WORK_ORDERS_BOARD_ID?.trim() || '(auto-discover by name)',
    accessCodeEnabled: Boolean(process.env.APP_ACCESS_CODE?.trim()),
    tools: TOOLS.length,
  };

  try {
    const info = await getDataSource().describe();
    checks.connection = 'ok';
    checks.account = info.account ?? null;
    checks.boards = info.boards;
  } catch (err) {
    checks.connection = 'failed';
    checks.connectionError = (err as Error)?.message ?? String(err);
  }

  return Response.json(checks, { status: checks.connection === 'ok' ? 200 : 503 });
}
