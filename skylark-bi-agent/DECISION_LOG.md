# Decision Log

**Skylark Drones — monday.com Business Intelligence Agent**

---

## The problem as I read it

The brief asks for an agent that answers founder questions from monday.com. The hard part is not querying — it is that **almost every interesting field in this data is partly missing**, and an agent that reports totals without denominators will confidently tell a founder the pipeline is half its real size. Most of my time went into making it honest rather than clever.

## Key assumptions

**"This quarter" means the Indian financial year quarter (Apr–Mar).** Invoice numbers in the source read `SDPL/FY25-26/…`, confirming an April year-start. Calendar quarters remain available explicitly (`CQ3_2025`); every resolved period reports which convention it used, and the agent states the actual months so a wrong assumption is visible immediately.

**Ambiguous `DD/MM/YYYY` dates are day-first.** Every unambiguous row (day > 12) is day-first without exception; month-first parsing would mis-date roughly a third of the calendar.

**`Tender` and `DSP` are not industry sectors.** They sit in the deals board's sector column but describe routes to market. This matters more than it sounds: **`Tender` alone is ₹53.2 Cr of the ₹68.8 Cr open pipeline** — leave it in a sector ranking and it drowns every real sector. The normalizer tags each value's kind; the agent excludes non-sectors and says so.

**Deal values are masked but internally consistent** — ratios and rankings hold, absolute rupees are not real. Said once per conversation, not on every line.

**Probability weights (High 0.75 / Medium 0.45 / Low 0.20) are mine, not Skylark's.** No model was supplied, so the agent labels any weighted figure as a working convention.

**GST is exactly 18% throughout** — verified across all 169 rows with both figures, which lets missing values be derived rather than dropped.

## Trade-offs

**Analytical MCP tools, not a GraphQL passthrough.** The tools are `aggregate`, `cross_board_summary`, `data_quality_report` — not `run_query`. Founder questions map to "aggregate this metric over that slice and tell me what's missing", not "fetch rows". Keeping arithmetic out of the model's head is where BI agents usually start inventing numbers. **Cost:** a question outside the tools' shape needs a new tool.

**Whole-board fetch, 60-second cache, filtered in process.** monday's server-side filtering cannot express cross-board joins, coverage-aware aggregation, or derived fields like "open past its expected close date". The boards are 344 and 176 rows. **Cost:** this does not scale to 100k-row boards; at that size aggregation moves server-side.

**Charts render from tool results, never from model output.** If the model emitted chart data, a hallucinated number could be drawn as a confident bar. Deriving the figure from the same JSON the tool returned means picture and prose cannot disagree.

**Two transports over one tool definition.** The same handlers serve the hosted MCP endpoint (`/api/mcp`) and the in-process agent, so an external MCP client and the web UI never drift apart. The stateless JSON-RPC endpoint is hand-written because the SDK's Node transport wants `req`/`res` objects Next's Web `Request` does not provide.

**The LLM is a deployment choice, not an architectural one.** The loop holds conversation state in a provider-neutral shape; each provider translates at the boundary, so Gemini, Groq and Claude are one env var apart. Not gold-plating — the three function-calling dialects disagree in ways that bite. Gemini rejects a property with no declared `type`, and our filter values are deliberately polymorphic (a value may be a string, a number, or an array). Rather than maintain three schema variants, every provider gets one sanitised schema where polymorphic values are declared as strings with encoding instructions, and the filter layer parses them back. That coercion earns its keep regardless of provider: every model sends `"1000"` for a number sooner or later. **Default is Gemini 2.5 Flash** — free tier, and the strongest function-calling among free options, which matters with ten tools and three or four calls per answer. Groq is far faster but open models are less reliable at chaining calls against complex schemas.

**Next.js on Vercel, one deployable.** UI, agent and MCP server ship together — one URL, no local setup, as the brief requires.

**A mock data source, used only in tests.** `DATA_SOURCE=mock` replays the workbooks through the identical interface, so the engine is testable without an account. The fixture is gitignored, the hosted demo runs `live`, and nothing above that seam can tell the difference — which is what makes the 53 tests worth anything. Provider protocols are likewise tested against a local stub speaking each wire format, including SSE frames split mid-JSON and OpenAI-style tool arguments arriving as fragments across a dozen deltas. That last one matters: parsing before the stream ends truncates arguments in a way that looks exactly like hallucination.

## What the data actually contained

- **Two repeated header rows buried inside the deals data** (rows 50 and 179), each with a plausible deal name in the first cell, so a naive header check misses them. Detected by matching *other* cells against their own column headers.
- **Four completely empty columns**, including Collection Date — which means true AR ageing cannot be computed at all, only balances. The agent says so rather than approximating.
- **Client codes cannot be joined across boards** (`COMPANY089` vs `WOCOMPANY_002`). Owner code and deal name are the only real join keys.
- **Two competing billing columns that disagree**, one containing the typo `BIlled`. Reconciled using billed value as tie-breaker, since money is 100% populated and the status columns are hand-maintained.
- **Six work orders billed above their order value**, and **49 past their end date but not complete** — surfaced as anomalies, not clamped.
- **`NONE` is a real answer**, not a blank: it means "no Skylark platform attached" on 127 of 176 rows. My first blank-value list swallowed it and made platform-attach read 21% instead of 93%. Caught by cross-checking against the profiling numbers; there is now a regression test.
- **The boards end around April 2026.** Against today's date, "this quarter" legitimately matches nothing. Answering "₹0" would read as a business collapse rather than a gap, so the tools return the real populated date range whenever a period filter matches nothing, and the agent must check `data_time_range` before any time-bounded question.

## How I interpreted "help prepare data for leadership updates"

As: **a founder should be able to ask once a week and get something they could paste into a board email** — not a dashboard, not a data dump.

So `leadership_brief` assembles the standing numbers in one call — pipeline and weighted pipeline, funnel shape, win rate, sector mix, order book, execution status, billing, collections, top receivables — with **data-quality caveats as a first-class section**, because anything going to a board needs its own footnotes. Using one tool rather than a dozen `aggregate` calls also fixes the definitions, so week-on-week comparisons are real rather than an artefact of the agent phrasing the query differently. The agent is instructed to return a written brief — what moved, what is at risk, what needs a decision.

## What I would do differently with more time

- **Snapshot the boards on a schedule.** Nothing here is time-series: I can say pipeline is ₹68.8 Cr but not that it grew. Weekly snapshots would turn every metric into a trend, which is most of what a founder wants.
- **Push aggregation server-side** behind the same tool interface, so the design survives boards 100× larger.
- **Write back to monday.com.** The agent finds 49 overdue work orders and 6 over-billings but cannot flag them. The brief specifies read-only, so this stayed out.
- **Reconcile the boards properly.** With only masked names to join on, "which pipeline deals became work orders" is approximate. A shared key would make conversion rate and cycle time answerable.
- **Evaluate the agent, not just the engine.** The 53 tests cover normalization, aggregation and provider protocols; the agent's *judgement* — right tool, right caveat — is checked by hand via `npm run smoke`. A graded question set with expected tool sequences would catch prompt regressions, and would let the three models be compared on the same questions rather than by impression.
