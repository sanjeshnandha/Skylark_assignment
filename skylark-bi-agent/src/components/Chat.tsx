'use client';

import React, { useCallback, useEffect, useRef, useState } from 'react';
import { Markdown } from './Markdown.tsx';
import { ToolTrace, type ToolCall } from './ToolTrace.tsx';
import { BarFigure, BriefTiles, isAggregate, isBrief } from './Figures.tsx';

type Turn = {
  role: 'user' | 'assistant';
  content: string;
  calls: ToolCall[];
  status?: string;
  error?: { message: string; recoverable: boolean };
  done?: boolean;
};

const STARTERS = [
  { q: "How's our pipeline looking for the energy sector this quarter?", label: 'Sector pipeline', hint: 'The founder question from the brief — watch it handle the period gap' },
  { q: 'What is our total order book, and how much of it has actually been billed and collected?', label: 'Revenue & collections', hint: 'Order value vs billed vs collected, with the coverage gaps named' },
  { q: 'Which deals are slipping — open past their expected close date?', label: 'Slipping deals', hint: 'Row-level pipeline risk' },
  { q: 'How reliable is this data? What should I not trust?', label: 'Data quality', hint: 'Empty columns, contradictions and parse failures' },
  { q: 'Prepare a leadership update on the business.', label: 'Leadership update', hint: 'A written brief, not a data dump' },
  { q: 'Compare pipeline against work in execution by sector. Where are we winning but not delivering?', label: 'Cross-board view', hint: 'Joins both boards on sector' },
];

export function Chat({ boardInfo }: { boardInfo: React.ReactNode }) {
  const [turns, setTurns] = useState<Turn[]>([]);
  const [input, setInput] = useState('');
  const [busy, setBusy] = useState(false);
  const abortRef = useRef<AbortController | null>(null);
  const threadRef = useRef<HTMLDivElement>(null);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const stickRef = useRef(true);

  // Follow the stream, but stop fighting the user if they scroll up to read.
  useEffect(() => {
    const el = threadRef.current;
    if (!el) return;
    const onScroll = () => {
      stickRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 120;
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => el.removeEventListener('scroll', onScroll);
  }, []);

  useEffect(() => {
    if (stickRef.current && threadRef.current) {
      threadRef.current.scrollTop = threadRef.current.scrollHeight;
    }
  });

  const send = useCallback(async (question: string) => {
    const text = question.trim();
    if (!text || busy) return;

    stickRef.current = true;
    setInput('');
    if (taRef.current) taRef.current.style.height = 'auto';

    const history = [...turns, { role: 'user' as const, content: text, calls: [] }];
    setTurns([...history, { role: 'assistant', content: '', calls: [], status: 'Thinking…' }]);
    setBusy(true);

    const ctrl = new AbortController();
    abortRef.current = ctrl;

    const patch = (fn: (t: Turn) => Turn) =>
      setTurns((prev) => {
        const next = [...prev];
        next[next.length - 1] = fn(next[next.length - 1]);
        return next;
      });

    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          messages: history.map((t) => ({ role: t.role, content: t.content })),
        }),
        signal: ctrl.signal,
      });

      if (!res.ok || !res.body) {
        const j = await res.json().catch(() => ({ error: `Server returned ${res.status}.` }));
        patch((t) => ({ ...t, status: undefined, done: true, error: { message: j.error ?? `Server returned ${res.status}.`, recoverable: false } }));
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = '';

      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.trim()) continue;
          let ev: Record<string, unknown>;
          try { ev = JSON.parse(line); } catch { continue; }

          switch (ev.type) {
            case 'status':
              patch((t) => ({ ...t, status: String(ev.message) }));
              break;
            case 'text':
              patch((t) => ({ ...t, content: t.content + String(ev.delta), status: undefined }));
              break;
            case 'tool_start':
              patch((t) => ({
                ...t,
                status: undefined,
                calls: [...t.calls, { id: String(ev.id), name: String(ev.name), input: ev.input, running: true }],
              }));
              break;
            case 'tool_end':
              patch((t) => ({
                ...t,
                calls: t.calls.map((c) =>
                  c.id === ev.id ? { ...c, running: false, result: ev.result, ok: Boolean(ev.ok), ms: Number(ev.ms) } : c,
                ),
              }));
              break;
            case 'error':
              patch((t) => ({ ...t, status: undefined, done: true, error: { message: String(ev.message), recoverable: Boolean(ev.recoverable) } }));
              break;
            case 'done':
              patch((t) => ({ ...t, status: undefined, done: true }));
              break;
          }
        }
      }
    } catch (err) {
      if ((err as Error)?.name !== 'AbortError') {
        patch((t) => ({ ...t, status: undefined, done: true, error: { message: (err as Error)?.message ?? 'Connection lost.', recoverable: true } }));
      } else {
        patch((t) => ({ ...t, status: undefined, done: true }));
      }
    } finally {
      setBusy(false);
      abortRef.current = null;
    }
  }, [busy, turns]);

  const stop = () => abortRef.current?.abort();

  const onKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); void send(input); }
  };

  const grow = (e: React.ChangeEvent<HTMLTextAreaElement>) => {
    setInput(e.target.value);
    e.target.style.height = 'auto';
    e.target.style.height = `${Math.min(e.target.scrollHeight, 190)}px`;
  };

  return (
    <>
      <div className="topbar">
        <div>
          <h1>Business Intelligence Agent</h1>
          <p>Ask about pipeline, revenue, execution or collections — answered live from monday.com</p>
        </div>
        <div className="topbar-actions">
          {turns.length > 0 && (
            <button className="ghost-btn" onClick={() => !busy && setTurns([])} disabled={busy}>
              New question
            </button>
          )}
        </div>
      </div>

      <div className="thread" ref={threadRef}>
        <div className="thread-inner">
          {turns.length === 0 ? (
            <div className="empty">
              <h2>What would you like to know?</h2>
              <p>
                I query your monday.com Deal Funnel and Work Order Tracker directly. The data is
                real-world messy, so I will tell you what is missing rather than quietly averaging over it.
              </p>
              <div className="empty-grid">
                {STARTERS.map((s) => (
                  <button key={s.label} className="empty-card" onClick={() => void send(s.q)}>
                    <b>{s.label}</b>
                    <span>{s.hint}</span>
                  </button>
                ))}
              </div>
            </div>
          ) : (
            turns.map((t, i) =>
              t.role === 'user' ? (
                <div className="msg msg-user" key={i}>
                  <div className="bubble-user">{t.content}</div>
                </div>
              ) : (
                <div className="msg msg-assistant" key={i}>
                  {t.calls.length > 0 && <ToolTrace calls={t.calls} />}
                  {t.calls.map((c) =>
                    c.result && isAggregate(c.name, c.result) ? (
                      <BarFigure key={`fig-${c.id}`} result={c.result} />
                    ) : c.result && isBrief(c.name, c.result) ? (
                      <BriefTiles key={`tiles-${c.id}`} brief={c.result} />
                    ) : null,
                  )}
                  {t.status && (
                    <div className="status-line"><span className="spinner" aria-hidden />{t.status}</div>
                  )}
                  {t.content && <Markdown text={t.content} />}
                  {t.error && (
                    <div className={`callout ${t.error.recoverable ? 'callout-warn' : 'callout-error'}`} role="alert">
                      <svg width="15" height="15" viewBox="0 0 16 16" fill="none" aria-hidden>
                        <circle cx="8" cy="8" r="6.7" stroke="currentColor" strokeWidth="1.4" />
                        <path d="M8 4.6v4M8 10.9h.01" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" />
                      </svg>
                      <div>
                        <b>{t.error.recoverable ? 'Something went wrong' : 'Configuration problem'}</b>
                        <br />{t.error.message}
                      </div>
                    </div>
                  )}
                </div>
              ),
            )
          )}
        </div>
      </div>

      <div className="composer-wrap">
        <div className="composer">
          <div className="composer-box">
            <textarea
              ref={taRef}
              rows={1}
              value={input}
              onChange={grow}
              onKeyDown={onKeyDown}
              placeholder="Ask about pipeline, revenue, execution, collections…"
              disabled={busy}
              aria-label="Ask a question"
            />
            {busy ? (
              <button className="stop-btn" onClick={stop}>
                <span className="spinner" aria-hidden />Stop
              </button>
            ) : (
              <button className="send" onClick={() => void send(input)} disabled={!input.trim()} aria-label="Send">
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden>
                  <path d="M8 13V3M3.5 7.5L8 3l4.5 4.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              </button>
            )}
          </div>
          <p className="composer-hint">{boardInfo}</p>
        </div>
      </div>
    </>
  );
}
