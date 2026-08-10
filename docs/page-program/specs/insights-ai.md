# insights-ai — target-state spec

`/admin/insights` — AI assistant + operations analytics for admins.

## 1. Purpose

Let an operator answer, in one glance: "is the AI assistant carrying its
weight, and what's happening in the shop right now?" — deflection rate,
session outcomes, token spend, feedback, bot routing quality, and a live
operations snapshot (open work, technician load, revenue). One job: turn raw
conversation/request rows into numbers an owner acts on, with zero fabricated
figures. Not a general BI tool — no export, no custom queries, no LLM-written
narrative.

## 2. Brainstorm

Considered, and what shipped or got cut:

- **Compute every metric live from existing tables, no metrics store** —
  shipped. Rejected alternative: a pre-aggregated `insights_daily` rollup
  table. Reason: data volume doesn't justify write-path complexity yet, and
  the prior audit's fear (fake/broken figures) is best addressed by keeping
  the query the single source of truth, not a cache that can drift.
  verified (`ai-insights-queries.ts:1-11`, `ops-insights-queries.ts:1-10`
  module docs both state this).
- **Single `db.batch()` per query module** — shipped for two of three
  modules (`ai-insights-queries.ts:52`, `ops-insights-queries.ts:46`), missed
  for the third (`bot-analytics-queries.ts:93` still uses `Promise.all`) —
  see Gap Ginsights-ai-2. Necessary because neon-http charges one HTTP
  round-trip per un-batched query and `db.transaction()` isn't available
  (AGENTS.md, admin-pages skill).
- **Deflection rate as the hero stat** — shipped (`page.tsx:152-160`, `size="lg"`).
  Correct call: it's the one number that answers "is the deterministic
  router actually working," which is the whole point of having a router
  instead of an LLM-only bot.
- **Period-over-period delta pills on headline metrics** — NOT shipped here,
  even though the primitive already exists and is proven elsewhere in this
  exact codebase: `/admin/operations` has a 30/90/365-day preset selector
  feeding `toStatDelta`/`durationDelta`/`countDelta` into `StatCard`'s
  `delta` prop (`src/app/admin/(dashboard)/operations/page.tsx:28-30,50-68,127`).
  `/admin/insights` never passes `delta` (grep confirms zero occurrences in
  `page.tsx`, `bot-analytics-section.tsx`, `ops-insights-section.tsx`). This
  is a real gap, not a wishlist item — see Gap Ginsights-ai-1.
- **Arbitrary custom date-range picker (start/end calendar)** — rejected.
  The proven in-repo pattern is a small preset list (30/90/365 days), which
  bounds query cost and UI complexity; an open calendar picker is scope
  creep this page has no evidence of needing.
- **CSV / data export button** — rejected. No user request, no precedent on
  other insights-style pages, adds surface area (file streaming, size
  limits) for a feature nobody asked for. YAGNI.
- **LLM-generated narrative summary ("here's what changed this week")** —
  rejected. Would put an LLM call on this page's request path for the first
  time, adding cost, latency, and a new failure mode (missing/failed API
  key) to a page whose entire value proposition today is "instant, free,
  deterministic." Directly contradicts the page's own headline metric.
- **Real-time/streaming updates (polling or WebSocket)** — rejected. No
  other admin page polls; manual refresh is the established, documented
  pattern here (`page-insights-ai` skill). Not a bug, a deliberate choice.
- **Anomaly detection / threshold alerting on metrics** — rejected. No
  notification infrastructure exists to deliver an alert; standalone
  feature, not a page fix.
- **Per-technician drill-down page** — rejected. The technician-load table
  already surfaces active/completed/total per tech
  (`ops-insights-section.tsx:270-280`); a dedicated page would duplicate
  `page-technicians`.

## 3. Current state

**Files** (verified — read in full):
- Page: `src/app/admin/(dashboard)/insights/page.tsx` (198 lines) — fetches
  `/api/admin/ai-insights` on mount (`:84-119`), renders a hero
  `StatCard size="lg"` for deflection rate (`:152-160`) plus a 3-col grid of
  `INSIGHT_CARDS` (`:36-75`), then mounts `BotAnalyticsSection` and
  `OpsInsightsSection` (`:192-194`).
- Types: `src/lib/admin/ai-insights-types.ts` — `AiInsights` interface, all
  fields `readonly`, rates are 0-100 whole numbers (module doc `:1-9`).
- Queries: `src/lib/admin/ai-insights-queries.ts` — `getAiInsights` runs 9
  independent counts/sums in one `db.batch` (`:42-144`), tenant-scoped via
  `withTenant` on every query (`:57,66,77,85,97,109,118,128,141`).
  `deflectionRate = deterministic / (deterministic + llm)` (`:163-166`, the
  invariant the page skill documents). No date/period filter anywhere in
  this file — every count is all-time since org creation.
- API: `src/app/api/admin/ai-insights/route.ts` — session gate, rate limit
  (`RATE_LIMITS.adminRead`), calls the query, wraps in `successResponse`. No
  LLM call anywhere in this route or `getAiInsights` — verified by grep for
  `generateText`/`streamText`/`openai`/`anthropic` across all three
  query/route files (zero matches). This page has no LLM-missing-key or
  LLM-failure failure mode.
- Bot analytics: `src/components/admin/insights/bot-analytics-section.tsx`
  + `src/hooks/use-bot-analytics.ts` fetch `/api/admin/bot-analytics`
  independently (own loading/error state, `use-bot-analytics.ts:17-71`).
  `src/lib/admin/bot-analytics-queries.ts` — `getBotAnalytics` defaults to
  a **fixed last-30-days window** (`:88-91`), computed via `Promise.all`
  over 3 queries (`:93-170`), not `db.batch`. The route
  (`src/app/api/admin/bot-analytics/route.ts:23`) never parses a period from
  the request, so the UI cannot ask for a different window — the "last 30
  days · N turns" label (`bot-analytics-section.tsx:97`) is the only period
  disclosure on the page.
- Ops insights: `src/components/admin/insights/ops-insights-section.tsx` +
  `src/app/api/admin/ops-insights/route.ts` +
  `src/lib/admin/ops-insights-queries.ts`. All headline counts
  (`totalRequests`, `openRequests`, `completedRequests`, `cancelledRequests`,
  `byIssueType/Urgency/Status`, `technicianLoad`, `requestsByHour`,
  `costStats`) are all-time, computed via `db.batch` (`:46`, 7 queries).
  Only `requestsLast7Days` (`:65-74`) is time-bound. No period label is
  rendered anywhere in `OpsInsightsSection` for the all-time figures.
- `messages.tokensUsed` is genuinely populated from live LLM usage, not a
  placeholder: `src/lib/ai/metrics.ts:31-36` sets it from
  `extractTokens(result)` on the real model response; every deterministic
  reply insert explicitly sets `tokensUsed: 0` (e.g.
  `src/app/api/chat/route.ts:204,434,736,849,912,950,1014`, ditto
  `voice-turn.ts`, `voice/gather/route.ts`, `session/route.ts`). One insert
  path — the admin CSR-takeover reply,
  `src/app/api/admin/conversations/[id]/message/route.ts:111-116` — omits
  `tokensUsed` entirely, leaving it `NULL` (column is nullable,
  `src/lib/db/schema.ts:477`, no `.notNull()`). `ai-insights-queries.ts`'s
  deterministic/llm counts filter `eq(tokensUsed, 0)` / `gt(tokensUsed, 0)`
  (`:96,108`), so a `NULL` row matches neither — it's silently excluded from
  both buckets rather than miscounted. Arguably correct (a human CSR reply
  is neither deterministic-router nor LLM), but undocumented — see Gap
  Ginsights-ai-4.
- `StatCard` (`src/components/admin/ui/stat-card.tsx`) supports a `delta`
  prop (`:22-27`) rendered via `DeltaPill` (`:111`) — a proven, already-used
  primitive (see Brainstorm), just not wired up on this page.
- Test coverage: `bot-analytics-queries.test.ts` and
  `ops-insights-queries.test.ts` exist with mocked-`db` unit tests (both
  files verified, DB-mock pattern via `vi.hoisted`). **No
  `ai-insights-queries.test.ts` exists** — confirmed by `ls` returning "No
  such file" — despite `getAiInsights` computing the page's hero metric.

## 4. Gaps

| Gap | Severity | Evidence |
|---|---|---|
| Ginsights-ai-1: No period-over-period context anywhere on the page — an owner sees "Total conversations: N" / "Deflection rate: X%" with no way to tell if this week is better or worse than last, and the three sections silently cover three different, undisclosed windows (ai-insights = all-time, bot-analytics = fixed last-30-days, ops-insights = all-time + one last-7-days figure) | P1 | `ai-insights-queries.ts` has no date filter at all (`:42-144`); `bot-analytics-queries.ts:88-91` hardcodes 30 days with no UI selector (`route.ts:23` never reads query params); `ops-insights-queries.ts` is all-time except `requestsLast7Days` (`:65-74`); zero `delta=` usages in any insights file (grep), while the identical `StatCard`/`delta` pattern is already proven and live on `/admin/operations` (`operations/page.tsx:28-30,50-68,127`). |
| Ginsights-ai-2: `getBotAnalytics` costs 3 HTTP round-trips per page load where its two sibling query modules cost 1 | P1 | `bot-analytics-queries.ts:93` uses `Promise.all` over 3 independent queries; `ai-insights-queries.ts:52` and `ops-insights-queries.ts:46` use `db.batch` for the same shape of problem, each with an explicit comment about cutting round-trips (`ai-insights-queries.ts:40-41`, `ops-insights-queries.ts:36-37`). Repo-wide invariant (AGENTS.md, admin-pages skill) calls out `db.batch` as the neon-http pattern for independent queries. |
| Ginsights-ai-3: `getAiInsights` — the query behind the page's hero metric — has no dedicated test file | P2 | `ls src/lib/admin/ai-insights-queries.test.ts` → no such file; sibling modules `bot-analytics-queries.test.ts` and `ops-insights-queries.test.ts` both exist with the repo's standard mocked-`db` vitest pattern. The `page-insights-ai` skill's "no dedicated test file for insights" note is imprecise — 2 of 3 query modules do have one. |
| Ginsights-ai-4: The one code path that inserts an assistant message without `tokensUsed` (admin CSR takeover) is silently invisible in both the deterministic and LLM buckets, with no comment explaining the exclusion is intentional | P2 | `src/app/api/admin/conversations/[id]/message/route.ts:111-116` omits `tokensUsed`; `ai-insights-queries.ts:96,108` filters exclude `NULL`. Does not corrupt either number (a human reply is correctly neither bucket), but a future reader could "fix" this by defaulting it to 0 and silently start counting human replies as deterministic AI turns. |

## 5. Requirements

Only Ginsights-ai-1 and Ginsights-ai-2 clear the P0/P1 bar.

- **Rinsights-ai-1**: Every metric section on `/admin/insights` must
  disclose the time window it covers, and the hero "Deflection rate" and
  "Total conversations" cards must show a period-over-period delta,
  reusing the existing `StatCard` `delta` prop and the
  `toStatDelta`/duration-or-count-delta pattern already proven on
  `/admin/operations` (`operations/page.tsx:50-68`) — no new UI primitive.
  Scope: a small preset window (e.g. last 30 days, matching
  `bot-analytics-queries.ts`'s existing default) compared against the prior
  equal-length window; not an open date-range picker (Brainstorm, rejected).
  **Acceptance criterion**: loading `/admin/insights` shows a visible label
  on every section (ai-insights header, "Bot analytics", "Operations")
  stating its window (e.g. "Last 30 days"), and the Deflection rate and
  Total conversations `StatCard`s render a `DeltaPill` computed from
  real prior-vs-current-period counts (not a hardcoded/mocked value) — a
  `vitest` unit test on the pure delta-computation function proves: current
  > previous → positive/good delta, current < previous → negative delta,
  previous = 0 → no crash (matches the existing `asPercent`/`ratio`
  zero-denominator guard pattern in `ai-insights-queries.ts:30-35`).
- **Rinsights-ai-2**: `getBotAnalytics` in `bot-analytics-queries.ts` must
  issue its 3 independent queries (`totalsRow`, `intentRows`, `outcomeRows`)
  via a single `db.batch` call instead of `Promise.all`, matching the
  pattern at `ai-insights-queries.ts:52` and `ops-insights-queries.ts:46`.
  **Acceptance criterion**: `bot-analytics-queries.ts:93` no longer calls
  `Promise.all`; `db.batch([...])` replaces it with the same 3 query
  builders and the same destructured result shape; `bot-analytics-queries.test.ts`
  updated to mock `db.batch` instead of/alongside `db.select`, and still
  passes; `getBotAnalytics`'s return value is unchanged for the same input
  data (no behavior change, pure round-trip optimization).

## 6. Non-goals

- Custom arbitrary date-range picker — rejected in Brainstorm (scope creep;
  a bounded preset satisfies Rinsights-ai-1).
- CSV/data export — rejected in Brainstorm (YAGNI, no demand).
- LLM-written narrative summary — rejected in Brainstorm (would add the
  page's first request-path LLM call and its failure modes).
- Real-time polling/WebSocket updates — rejected in Brainstorm (no
  precedent, deliberate manual-refresh design per the page skill).
- Anomaly detection / alerting — rejected in Brainstorm (no notification
  infra; separate feature).
- Per-technician drill-down page — rejected in Brainstorm (duplicates
  `page-technicians`; the existing table already covers it).
- Ginsights-ai-3 (missing `ai-insights-queries.test.ts`) and Ginsights-ai-4
  (undocumented `NULL`-tokensUsed exclusion) are P2 — recorded in Gaps and
  left in the backlog per METHOD.md's severity gate, not implementation
  work in this run.
- Not changing `deflectionRate`'s formula, the "N / N" (not percentage)
  display for instant/AI replies, or any existing metric's definition —
  Rinsights-ai-1 adds context (window label, delta) around existing
  numbers, it does not redefine them.

## 7. Invariants

- All metrics computed live from existing tables — no pre-aggregated
  metrics store (`ai-insights-queries.ts:1-11`, `ops-insights-queries.ts:1-10`
  module docs). A prior-period comparison for Rinsights-ai-1 must be a
  second live query over the same tables, not a cached/derived guess.
- `deflectionRate = deterministic / (deterministic + llm)`,
  `deterministicReplies`/`llmReplies` shown as "N / N" not a percentage
  (`page-insights-ai` skill; `ai-insights-queries.ts:163-166`;
  `page.tsx:66`) — unchanged by this spec's requirements.
- Tenancy: every query in all three query modules is scoped via
  `withTenant` — any new prior-period query added for Rinsights-ai-1 must
  use the same helper, never a raw unscoped query.
- neon-http: `db.transaction()` throws at runtime; independent queries use
  `db.batch()` (AGENTS.md, admin-pages skill) — this is exactly what
  Rinsights-ai-2 brings `bot-analytics-queries.ts` into line with, and any
  new query added for Rinsights-ai-1 must follow the same rule.
- No LLM call on this page's request path today, and none of this spec's
  requirements add one (Non-goals) — the page's only failure modes are
  DB/auth, not missing-API-key.
- `isFetchingRef` (not state) double-fetch guards in `page.tsx:82`,
  `ops-insights-section.tsx:153`, and `use-bot-analytics.ts` — preserved;
  `AdminAuthRedirectError` stays silently swallowed in each `catch`
  (`page.tsx:109`, `ops-insights-section.tsx:174`,
  `use-bot-analytics.ts` equivalent) — session-expiry redirect is handled
  by `adminFetch` itself, never surfaced as a page error.
- `BotAnalyticsSection` and `OpsInsightsSection` keep independent
  fetch/loading state from the parent page (page skill) — a window-label
  or preset-selector added for Rinsights-ai-1 must not merge their fetches.
- Copy canon: "request" not "job", sentence case, Unicode `…`, human error
  copy (never `err.message` in UI) — any new window-label/delta copy must
  follow this (admin-pages skill).
- Demo account / GDPR / SMS guards, money atomicity — not touched; this
  page has no money mutation or PII-erase surface.

## 8. Verification

- `npx tsc --noEmit` → 0.
- `npx eslint src/lib/admin/ai-insights-queries.ts src/lib/admin/bot-analytics-queries.ts src/lib/admin/ops-insights-queries.ts src/app/admin/(dashboard)/insights/page.tsx src/components/admin/insights/bot-analytics-section.tsx src/components/admin/insights/ops-insights-section.tsx` (plus any new files) → 0 errors.
- `npx vitest run` → must not drop below the live baseline (297 files ·
  4022 passed · 1 skipped, per `docs/page-program/README.md`).
- Existing suites must stay green: `bot-analytics-queries.test.ts`,
  `ops-insights-queries.test.ts`, `ops-insights-format.test.ts`.
- New pure-function vitest coverage: the delta/window computation added for
  Rinsights-ai-1 (zero-previous-period guard, positive/negative sign), and
  `bot-analytics-queries.test.ts` updated to assert `db.batch` is called
  (not `Promise.all`/`db.select` directly) for Rinsights-ai-2.
- Manual/visual, per admin-pages recipe: `npm run dev` (background) → mint
  session → `node scripts/agent/screenshot-page.mjs /admin/insights` →
  confirm each section shows a window label and the Deflection rate /
  Total conversations cards show a delta pill (or no pill when the prior
  period has zero data, per the zero-denominator guard).
- `node scripts/agent/verify-skills.mjs` → 0 missing (if any file paths
  cited in `page-insights-ai` skill change as part of implementing these
  requirements, the skill must be updated in the same commit).
