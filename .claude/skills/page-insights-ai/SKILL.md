---
name: page-insights-ai
description: Use when working on the /admin/insights page — AI assistant analytics (deflection rate, session outcomes, token usage, bot analytics, ops insights).
---

# AI insights (/admin/insights)

**Purpose:** operators see how well the AI assistant is performing: what share
of replies needed no LLM call (deflection), how sessions resolved, token spend,
and feedback signals; plus bot analytics and operations metrics sub-sections.

**Files:** page `src/app/admin/(dashboard)/insights/page.tsx` · sub-sections
`src/components/admin/insights/bot-analytics-section.tsx`,
`src/components/admin/insights/ops-insights-section.tsx` · types
`src/lib/admin/ai-insights-types.ts` · queries
`src/lib/admin/ai-insights-queries.ts`,
`src/lib/admin/bot-analytics-queries.ts` (`getBotAnalytics`) · API
`src/app/api/admin/ai-insights/route.ts` (main metrics),
`src/app/api/admin/ops-insights/route.ts` (ops sub-section) · tables
`customer_sessions`, `messages`, `service_requests`, `audit_log` (no dedicated
metrics table).

**Data flow:** page fetches `/api/admin/ai-insights` on mount via `adminFetch`.
`isFetchingRef` guards against concurrent fetches (double-mount in dev strict
mode). Manual refresh button re-fetches. `OpsInsightsSection` fetches
`/api/admin/ops-insights` independently. No polling; no caching beyond the
in-memory state.

**Invariants:**
- All metrics are computed live from existing tables — there is no pre-aggregated
  metrics store. Adding a new metric means adding a query in
  `ai-insights-queries.ts`, a field to `AiInsights` type, and a card in
  `INSIGHT_CARDS`.
- Deflection rate = share of assistant replies answered without an LLM call
  (deterministic/router path). Shown as the hero `StatCard` with `size="lg"`.
- `deterministicReplies / llmReplies` = instant vs AI reply split (shown as
  "N / N" in one card, not a percentage).
- Tenancy: all queries in `ai-insights-queries.ts` use `withTenant`.
- `getAiInsights` (AI assistant section) and `OpsInsightsSection`'s own counts
  are ALL-TIME (no date filter) except "New (7 days)" — the page discloses
  this explicitly via a `SectionHeading` description above the AI assistant
  cards and a caption above `OpsInsightsSection`, rather than implying a
  rolling window. If a real period-over-period delta is ever added, it needs
  a second query in `ai-insights-queries.ts` — this pass deliberately left
  that file untouched and only added the disclosure.
- `getBotAnalytics` (`bot-analytics-queries.ts`) runs its three sub-queries via
  `db.batch()`, not `Promise.all` — same neon-http invariant as
  `ai-insights-queries.ts` / `ops-insights-queries.ts`. The batch call needs
  `as const` on the array so drizzle's `BatchItem<'pg'>` overload resolves.
- `AdminAuthRedirectError` from `adminFetch` is silently swallowed in the catch
  (session expired → redirect handled by `adminFetch` itself); do not surface it
  as an error message.

- "Open requests" uses the shared `OPEN_STATUSES` (every source) — the same
  definition as the dashboard tiles (see page-dashboard "Open requests");
  `openImported` is the FieldPulse/HCP share shown in its sublabel. Technician
  load "Active" uses the same list. Never re-declare a local open list.
- Issue-type chart: `groupIssueTypes` (`src/lib/admin/issue-type-label.ts`)
  keeps the top 8 known issue types and folds smaller ones plus imported
  free-text job titles into "Other", with a caption counting the imports.
  Labels come from `ISSUE_TYPE_LABELS`; unknown codes are humanized, never raw.
- Requests by time of day: hours are bucketed `AT TIME ZONE` the org's
  business zone (`getOrgTimeZone`, `src/lib/admin/org-time-zone.ts` — the
  after-hours settings zone, Eastern by default; `OpsInsights.timeZone`), over
  NATIVE requests only (an imported job's created_at is the import run). The
  query groups by `sql\`1\`` because the zone is a bound parameter. Each hour
  column is `h-full` — without it the columns collapsed and every bar was 0 px.
  Caption names the zone via `timeZoneLabel`.
- Imported free-text titles get NO issue-type bar (they made an "Other 209"
  that dwarfed the real bars); the caption counts them. Urgency rows are
  ordered by `sortByUrgency` (emergency → low).
- Error copy is fixed human text with Try again, never the server message.
- Bot analytics is last-30-days only; its ratios render "—" when there are no
  turns (`formatRatio`), and the abandon note shows only when some session
  was classified.

**Gotchas:**
- Figures read visible rows only (go-live P6, `src/lib/admin/visibility.ts`);
  bot turns follow their session and session-less turns count. Technician load
  drops retired demo users for org viewers.
- `isFetchingRef` is a ref (not state) so toggling it doesn't trigger a
  re-render — intentional; the loading spinner is driven by `isLoading` state.
- The page slug is `page-insights-ai` (not `page-insights`) to avoid clashing
  with any future `page-reports` or `page-insights-ops` skill.
- `BotAnalyticsSection` and `OpsInsightsSection` manage their own fetch/loading
  state independently of the parent page — do not merge them into the parent
  fetch without reading both components first.

**Verify changes:** `npx vitest run` (no dedicated test file for insights;
query helpers are pure-function testable). Visual via admin-pages recipe
(`/admin/insights`).
