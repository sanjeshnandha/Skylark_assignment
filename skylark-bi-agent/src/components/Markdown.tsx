'use client';

/**
 * A small markdown renderer.
 *
 * Written by hand rather than pulled from npm for one reason: the output is
 * built from an explicit element allowlist, so model output can never inject
 * markup into the page. It covers exactly the subset the agent is told to use
 * — headings, bold, italic, code, lists, tables, blockquotes, links, rules.
 */

import React from 'react';

type Inline = React.ReactNode;

function renderInline(text: string, keyPrefix = ''): Inline[] {
  const out: Inline[] = [];
  let rest = text;
  let i = 0;

  const patterns: Array<[RegExp, (m: RegExpMatchArray, k: string) => Inline]> = [
    [/^`([^`]+)`/, (m, k) => <code key={k}>{m[1]}</code>],
    [/^\*\*([^*]+)\*\*/, (m, k) => <strong key={k}>{renderInline(m[1], k)}</strong>],
    [/^__([^_]+)__/, (m, k) => <strong key={k}>{renderInline(m[1], k)}</strong>],
    [/^\*([^*\n]+)\*/, (m, k) => <em key={k}>{renderInline(m[1], k)}</em>],
    [/^\[([^\]]+)\]\((https?:\/\/[^)\s]+)\)/, (m, k) => (
      <a key={k} href={m[2]} target="_blank" rel="noopener noreferrer">{m[1]}</a>
    )],
  ];

  let buffer = '';
  const flush = () => { if (buffer) { out.push(buffer); buffer = ''; } };

  while (rest.length) {
    let matched = false;
    for (const [re, build] of patterns) {
      const m = rest.match(re);
      if (m) {
        flush();
        out.push(build(m, `${keyPrefix}i${i++}`));
        rest = rest.slice(m[0].length);
        matched = true;
        break;
      }
    }
    if (!matched) { buffer += rest[0]; rest = rest.slice(1); }
  }
  flush();
  return out;
}

function splitRow(line: string): string[] {
  return line.replace(/^\||\|$/g, '').split('|').map((c) => c.trim());
}

export function Markdown({ text }: { text: string }) {
  const lines = text.replace(/\r\n/g, '\n').split('\n');
  const blocks: React.ReactNode[] = [];
  let i = 0;
  let k = 0;

  while (i < lines.length) {
    const line = lines[i];

    // Fenced code
    if (/^```/.test(line)) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i])) body.push(lines[i++]);
      i++;
      blocks.push(<pre key={k++}><code>{body.join('\n')}</code></pre>);
      continue;
    }

    // Table: header row followed by a separator row
    if (/\|/.test(line) && i + 1 < lines.length && /^[\s|:-]+$/.test(lines[i + 1]) && /-/.test(lines[i + 1])) {
      const head = splitRow(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && /\|/.test(lines[i]) && lines[i].trim()) rows.push(splitRow(lines[i++]));
      blocks.push(
        <div className="table-wrap" key={k++}>
          <table>
            <thead><tr>{head.map((h, j) => <th key={j}>{renderInline(h, `h${j}`)}</th>)}</tr></thead>
            <tbody>
              {rows.map((r, ri) => (
                <tr key={ri}>{head.map((_, ci) => <td key={ci}>{renderInline(r[ci] ?? '', `c${ri}${ci}`)}</td>)}</tr>
              ))}
            </tbody>
          </table>
        </div>,
      );
      continue;
    }

    if (/^(---|\*\*\*|___)\s*$/.test(line)) { blocks.push(<hr key={k++} />); i++; continue; }

    const h = line.match(/^(#{1,4})\s+(.*)$/);
    if (h) {
      const level = Math.min(h[1].length, 3);
      const content = renderInline(h[2], `h${k}`);
      blocks.push(level <= 2 ? <h2 key={k++}>{content}</h2> : <h3 key={k++}>{content}</h3>);
      i++;
      continue;
    }

    if (/^>\s?/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) body.push(lines[i++].replace(/^>\s?/, ''));
      blocks.push(<blockquote key={k++}>{renderInline(body.join(' '), `q${k}`)}</blockquote>);
      continue;
    }

    if (/^\s*[-*+]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*[-*+]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*[-*+]\s+/, ''));
      blocks.push(<ul key={k++}>{items.map((it, j) => <li key={j}>{renderInline(it, `l${k}${j}`)}</li>)}</ul>);
      continue;
    }

    if (/^\s*\d+[.)]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) items.push(lines[i++].replace(/^\s*\d+[.)]\s+/, ''));
      blocks.push(<ol key={k++}>{items.map((it, j) => <li key={j}>{renderInline(it, `o${k}${j}`)}</li>)}</ol>);
      continue;
    }

    if (!line.trim()) { i++; continue; }

    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,4}\s|>|```|\s*[-*+]\s|\s*\d+[.)]\s)/.test(lines[i]) && !/^(---|\*\*\*|___)\s*$/.test(lines[i])) {
      para.push(lines[i++]);
    }
    blocks.push(<p key={k++}>{renderInline(para.join(' '), `p${k}`)}</p>);
  }

  return <div className="prose">{blocks}</div>;
}
