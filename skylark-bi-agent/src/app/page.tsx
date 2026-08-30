/**
 * The console.
 *
 * The sidebar is rendered on the server so the connection state shown to the
 * user is the real one — checked against monday.com on page load, not asserted
 * hopefully by the client. If the connection is down the user sees exactly why
 * before typing a question into a dead endpoint.
 */

import { Chat } from '../components/Chat.tsx';
import { getDataSource } from '../lib/monday/source.ts';
import { MondayError } from '../lib/monday/client.ts';
import { selectedProviderId, createProvider } from '../lib/agent/providers/index.ts';

export const dynamic = 'force-dynamic';
export const revalidate = 0;

type Health =
  | { ok: true; kind: string; account: string | null; source: 'live' | 'mock'; boards: Array<{ id: string; name: string; boardId: string; items: number }> }
  | { ok: false; message: string };

async function checkHealth(): Promise<Health> {
  try {
    const src = getDataSource();
    const info = await src.describe();
    return { ok: true, kind: info.kind, account: info.account ?? null, source: src.kind, boards: info.boards };
  } catch (err) {
    return {
      ok: false,
      message: err instanceof MondayError ? err.userMessage : (err as Error)?.message ?? 'Unknown error',
    };
  }
}

export default async function Page() {
  const health = await checkHealth();
  const providerId = selectedProviderId();
  let modelLabel: string | null = null;
  try { modelLabel = createProvider().label; } catch { modelLabel = null; }

  return (
    <div className="app">
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark" aria-hidden>
            <svg width="17" height="17" viewBox="0 0 20 20" fill="none">
              <path d="M10 2.2 17 6v8l-7 3.8L3 14V6l7-3.8Z" stroke="currentColor" strokeWidth="1.5" strokeLinejoin="round" />
              <path d="M6.6 11.4V9M10 12.2V7.6M13.4 11.4V10" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
            </svg>
          </div>
          <div>
            <div className="brand-name">Skylark BI</div>
            <div className="brand-sub">monday.com intelligence</div>
          </div>
        </div>

        <div className="side-section">
          <div className="side-label">Connection</div>
          <div className="status-card">
            {health.ok ? (
              <>
                <div className="status-row">
                  <span className={`dot ${health.source === 'live' ? 'live' : 'mock'}`} aria-hidden />
                  <strong>{health.source === 'live' ? 'Live monday.com' : 'Offline replay'}</strong>
                </div>
                {health.account && <div className="status-meta">{health.account}</div>}
                {health.source === 'mock' && (
                  <div className="status-meta">
                    Test mode — reading the source spreadsheets, not a live account.
                  </div>
                )}
                <div>
                  {health.boards.map((b) => (
                    <div className="board-stat" key={b.id}>
                      <span>{b.name}</span>
                      <b>{b.items.toLocaleString('en-IN')}</b>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <>
                <div className="status-row">
                  <span className="dot down" aria-hidden />
                  <strong>Not connected</strong>
                </div>
                <div className="status-meta">{health.message}</div>
              </>
            )}
            <div className="board-stat">
              <span>Model</span>
              <b style={{ fontSize: 12 }}>{modelLabel ?? '—'}</b>
            </div>
            {!providerId && (
              <div className="status-row" style={{ color: 'var(--warn)' }}>
                <span className="dot mock" aria-hidden />
                <span style={{ fontSize: 12 }}>No LLM API key set</span>
              </div>
            )}
          </div>
        </div>

        <div className="side-section">
          <div className="side-label">What I can answer</div>
          <div style={{ fontSize: 12.6, color: 'var(--ink-2)', lineHeight: 1.6 }}>
            Pipeline health and value · win rates · sector and owner performance ·
            order book, billing and collections · execution delays · deals at risk ·
            cross-board comparisons · leadership updates
          </div>
        </div>

        <div className="side-section">
          <div className="side-label">How I handle bad data</div>
          <div style={{ fontSize: 12.4, color: 'var(--ink-3)', lineHeight: 1.6 }}>
            Totals come with the row count behind them. A blank is reported as
            &ldquo;not recorded&rdquo;, never as zero. Repeated header rows and
            non-sector labels are excluded and named. If a period has no data,
            I say so instead of answering nought.
          </div>
        </div>

        <div className="side-foot">
          Built for the Skylark Drones full-stack assignment.
          <br />
          MCP endpoint at <code style={{ fontSize: 10.5 }}>/api/mcp</code> · health at{' '}
          <code style={{ fontSize: 10.5 }}>/api/health</code>
        </div>
      </aside>

      <main className="main">
        <Chat
          boardInfo={
            health.ok
              ? `Querying ${health.boards.map((b) => `${b.name} (${b.items})`).join(' and ')} · figures are masked but internally consistent`
              : 'Not connected to monday.com — check the sidebar'
          }
        />
      </main>
    </div>
  );
}
