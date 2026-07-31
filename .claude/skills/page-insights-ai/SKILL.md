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
`src/lib/admin/ai-insights-queries.ts` · API
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
- `AdminAuthRedirectError` from `adminFetch` is silently swallowed in the catch
  (session expired → redirect handled by `adminFetch` itself); do not surface it
  as an error message.

**Gotchas:**
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
