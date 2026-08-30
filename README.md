# Skylark BI — monday.com Business Intelligence Agent

A conversational agent that answers founder-level business questions from two monday.com boards — a sales pipeline and a work-order tracker — and is honest about what the data does not contain.

```
"How's our pipeline looking for the energy sector this quarter?"
"What's our order book, and how much has actually been collected?"
"Which sectors are we winning but failing to deliver?"
"Prepare a leadership update."
```

**Live demo:** _(add your Vercel URL here after deploying)_
**MCP endpoint:** `<deployment>/api/mcp` — usable from Claude Desktop, Cursor, or any MCP client
**Decision log:** [DECISION_LOG.md](./DECISION_LOG.md)

---

## Quick start

```bash
npm install
cp .env.example .env.local          # then fill in a monday token + one LLM key

# 1. Create the boards and import the spreadsheets (one time, ~2 minutes)
npm run import -- "Deal funnel Data.xlsx" "Work_Order_Tracker Data.xlsx"

# 2. Run
npm run dev                          # → http://localhost:3000
```

`npm run import` writes the new board ids back into `.env.local` automatically.

**Requires Node 22.18+** — the project uses Node's native TypeScript execution, which lets the importer, the MCP server and the web app share one schema module with no build step.

### Choosing an LLM

The agent runs on **Gemini, Groq or Anthropic** behind one interface. Set a single key and it works — if `LLM_PROVIDER` is blank, whichever key is present is used (preferring gemini → groq → anthropic).

| Provider | Cost | Get a key | Notes |
|---|---|---|---|
| **Gemini** *(default)* | Free tier, no card | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) | Strongest function-calling of the free options — matters with 10 tools and multi-step reasoning |
| **Groq** | Free tier | [console.groq.com/keys](https://console.groq.com/keys) | Dramatically faster. Open models occasionally need a retry on long tool chains |
| **Anthropic** | Paid | [console.anthropic.com](https://console.anthropic.com) | Best reasoning; requires credits |

```bash
LLM_PROVIDER=gemini
GEMINI_API_KEY=<your key>
```

Switching provider is one env var — no code changes. `GROQ_BASE_URL` also points the Groq provider at any OpenAI-compatible endpoint (Together, Fireworks, OpenRouter, a local llama.cpp server).

### Environment

| Variable | Required | Notes |
|---|---|---|
| `MONDAY_API_TOKEN` | yes | monday.com → avatar → **Administration → Connections → API** → API v2 Token |
| `GEMINI_API_KEY` / `GROQ_API_KEY` / `ANTHROPIC_API_KEY` | one of | See the table above |
| `LLM_PROVIDER` | no | `gemini` · `groq` · `anthropic`. Blank = auto-detect from the key present |
| `GEMINI_MODEL` | no | Defaults to `gemini-2.5-flash` (fully supports newer reasoning models like `gemini-3.5-flash` and `gemini-2.0-flash`) |
| `GROQ_MODEL` | no | Defaults to `llama-3.3-70b-versatile` |
| `ANTHROPIC_MODEL` | no | Defaults to `claude-sonnet-4-5` |
| `MONDAY_DEALS_BOARD_ID` | no | Set by the importer. If blank, boards are discovered by name |
| `MONDAY_WORK_ORDERS_BOARD_ID` | no | As above |
| `DATA_SOURCE` | no | `live` (default) or `mock` — see [Testing](#testing) |
| `APP_ACCESS_CODE` | no | Set it to gate a public deployment so strangers cannot spend your API quota |

Visit `/api/health` to see what is configured and whether monday.com is reachable. It never echoes a secret.

---

## Architecture

```
                    ┌──────────────────────────────────────────┐
  Browser ────────▶ │  Next.js app                             │
                    │                                          │
                    │  /            chat UI, streaming          │
                    │  /api/chat    agent loop                  │
                    │  /api/mcp     hosted MCP server ◀──────── │ ◀── Claude Desktop,
                    │  /api/health  config + connectivity       │     Cursor, any MCP client
                    └───────────────┬──────────────────────────┘
                                    │
                    ┌───────────────▼──────────────────────────┐
                    │  MCP tool layer  (src/lib/mcp/tools.ts)  │
                    │  10 analytical tools — one definition,   │
                    │  shared by the agent and the endpoint    │
                    └───────────────┬──────────────────────────┘
                                    │
        ┌───────────────────────────┼───────────────────────────┐
        ▼                           ▼                           ▼
  ┌───────────┐            ┌────────────────┐          ┌────────────────┐
  │ filter /  │            │  normalization │          │ data quality   │
  │ aggregate │            │  + derived     │          │ + anomalies    │
  └───────────┘            └────────────────┘          └────────────────┘
                                    │
                    ┌───────────────▼──────────────────────────┐
                    │  DataSource  (live | mock)               │
                    └───────────────┬──────────────────────────┘
                                    ▼
                    ┌──────────────────────────────────────────┐
                    │  monday.com GraphQL                       │
                    │  retry · rate-limit + complexity handling │
                    │  board discovery · column mapping         │
                    └──────────────────────────────────────────┘
```

**The LLM is swappable.** The agent loop holds its conversation in a provider-neutral shape; each provider converts to its own wire format at the boundary — Anthropic's content blocks, Gemini's `parts` (including native state-preservation for `thoughtSignature` in thinking models), OpenAI's streamed `tool_calls` fragments. One tool definition is sanitised into whichever JSON Schema dialect the provider accepts, so nothing above `src/lib/agent/providers/` knows or cares which model is answering.

**One schema drives everything.** `src/lib/data/schema.ts` declares every field once — its spreadsheet header, its monday.com column type, how to normalize it, how populated it is, and what it means. The importer, the query layer and the agent's field documentation all read from it, so adding a column means editing one file.

**Column ids are never hardcoded.** monday generates them per board, so boards are resolved by configured id or by name, and column titles are matched onto canonical field keys tolerantly — renaming a column in the monday UI does not break the agent.

### Key directories

```
src/lib/data/       normalize · schema · records · filter · aggregate · quality · dates
src/lib/monday/     client (retry, rate limits) · boards (discovery) · fetch · source
src/lib/mcp/        tools.ts — the 10 tools, single source of truth
src/lib/agent/      system prompt · provider-agnostic tool-use loop
src/lib/agent/providers/   gemini · groq · anthropic · schema portability
src/components/     chat UI, markdown renderer, charts, tool trace
scripts/            import-to-monday · build-mock-dataset · smoke-test
mcp/stdio.ts        stdio MCP entry point for desktop MCP clients
tests/              35 unit tests
```

---

## The tools

| Tool | Purpose |
|---|---|
| `list_boards` | Connection check and board inventory |
| `describe_board` | Field dictionary with fill rates and data-quality notes |
| `aggregate` | Sum / avg / count / median / p90, grouped and filtered, **with coverage** |
| `query_records` | Row-level retrieval |
| `cross_board_summary` | Joins pipeline and execution on sector, owner or deal name |
| `data_quality_report` | Fill rates, parse failures, excluded rows, business-logic anomalies |
| `distinct_values` | What values a field actually contains |
| `search` | Free-text across a board |
| `data_time_range` | What period the data covers — checked before any time-bounded question |
| `leadership_brief` | The standing numbers for a leadership update, in one call |

Every aggregation returns the value **and** how many rows actually had that value. This is the design centre of the whole project: on this data, the denominator is frequently the story.

### Using it from Claude Desktop

Add to `claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "skylark-bi": {
      "command": "node",
      "args": ["/absolute/path/to/mcp/stdio.ts"],
      "env": { "MONDAY_API_TOKEN": "eyJ..." }
    }
  }
}
```

Or point any HTTP MCP client at `<deployment>/api/mcp` (stateless Streamable HTTP).

---

## How messy data is handled

The source is a real operational export. What the agent does about it:

| In the data | What happens |
|---|---|
| Two header rows repeated inside the deals data | Detected by matching cells against their own column headers, excluded, and reported |
| 52% of deal values missing (but only 4% of *open* deals) | Every total carries its coverage; the agent reports the denominator |
| Four completely empty columns | Marked unusable; the agent says the data is not captured rather than approximating |
| `Dec` vs `November`, `28/11/25` vs Excel serial `45989` | Normalized to month numbers and ISO dates; no year is ever invented |
| `5360 HA`, `4`, `59.33` in one quantity column | Number and unit parsed separately; summing across units raises a caveat |
| `Fully Billed` vs `BIlled` in two disagreeing columns | Reconciled using billed value as the tie-breaker; conflicts reported |
| `Tender` and `DSP` in the sector column | Tagged as non-sectors and excluded from sector breakdowns |
| Client codes masked differently on each board | Cross-board tool refuses that join and says why |
| Negative "amount to be billed" on 6 rows | Surfaced as over-billing, not clamped to zero |
| Data ends ~Apr 2026, today is later | Tools return the real date range; the agent says "no data for that period" instead of "₹0" |

---

## Testing

```bash
npm test                # 53 unit tests — normalization, periods, filtering, aggregation, provider protocols
npm run smoke           # runs real founder questions end to end and prints the tool calls
npm run import:dry -- "…xlsx" "…xlsx"   # validate parsing without touching monday.com
```

To work without a monday.com account:

```bash
npm run mock:build -- "Deal funnel Data.xlsx" "Work_Order_Tracker Data.xlsx"
DATA_SOURCE=mock npm run dev
```

`mock` replays the spreadsheets through the identical interface used for live data. The generated fixture is gitignored — **no spreadsheet data is committed to this repository**, and the hosted demo runs against live monday.com.

---

## Deploying

```bash
npm i -g vercel
vercel --prod
```

Then set `MONDAY_API_TOKEN`, your LLM key (`GEMINI_API_KEY` by default), `LLM_PROVIDER`, `MONDAY_DEALS_BOARD_ID` and `MONDAY_WORK_ORDERS_BOARD_ID` in the Vercel project's environment variables, and redeploy. Set `APP_ACCESS_CODE` too if the URL will be shared publicly.

---

## Notes

- All rupee figures in the source are **masked** — internally consistent, so ratios and comparisons hold, but not Skylark's real numbers. The agent says so.
- monday.com access is **read-only**, as the brief specifies. The importer writes once at setup; nothing else mutates a board.
- Rotate the API tokens after evaluation.
