---
name: page-integrations
description: Use when working on the /admin/integrations page — read-only connection-status overview of all external services (FieldPulse, Housecall Pro, Stripe, Twilio, Google Calendar, AI), grouped by category with Manage links.
---

# Integrations (/admin/integrations)

**Purpose:** at-a-glance status board for every external service the org may have
connected. Read-only — individual setup flows live in Settings › Integrations tabs.
Each card shows a status badge and, where configurable, a Manage link.

**Files:** page `src/app/admin/(dashboard)/integrations/page.tsx` · hook
`src/hooks/use-integrations.ts` · meta registry
`src/lib/admin/integration-meta.ts` · status derivation
`src/lib/admin/integrations-status.ts` · FieldPulse sync-health source
`src/lib/integrations/fieldpulse/connection-queries.ts`
(`getFieldpulseConnectionStatus`) · API `src/app/api/admin/integrations/route.ts`

**Data flow:** `useIntegrations` fetches `/api/admin/integrations` once on mount
(no polling, no SWR cache). The API reads env vars and org credential rows to
derive each service's status; no writes occur here.

**Invariants:**
- Status values: `live`, `connected`, `sync_failed`, `mock`, `not_configured`.
  Status badge classes come from the `STATUS_BADGE` constant in the page file
  — no raw palette classes in JSX.
- FieldPulse shows `sync_failed` (red, over `connected`'s green) when
  `fieldpulse.connected && availabilitySyncStatus === "failed"` — a
  "Connected" badge must not stay green while the daily availability-sync
  cron is actually failing. The detail string is fixed human copy — it
  must NOT echo `lastSyncError` (raw provider text such as "HTTP 403"). The
  Settings › Integrations FieldPulse panel shows the same failure via the
  status route's `syncFailed`.
- An env-key-served FSM (single-tenant org only) shows `SERVER_KEY_DETAIL`,
  worded to match the Settings panels (`fsm-connection-view.ts`). Keep the two
  pages telling the same story when you change either.
- Icon + intent come from `getIntegrationMeta(key)` in
  `src/lib/admin/integration-meta.ts`. Unmapped keys fall back to
  `{ icon: Plug, intent: 'neutral' }` — the UI never breaks on unknown services.
  Add new services to `REGISTRY` there, not in the page.
- Category sections render in the order declared in `CATEGORY_SECTIONS`
  (`FSM → payments → financing → comms → ai`). Sections with no items are skipped.
- `item.configurable && item.manageHref` both required to show the Manage button —
  an item can be configurable but have no href (e.g., partially wired integrations).

**Wording:** the `mock` status badge reads "Test mode"; details say "Test
mode — no real charges are made" / "Set up" / "Not set up", never "mock",
"adapter" or "API key". A failed load shows `LoadErrorState`, not "No
integrations found".

**Gotchas:**
- `mock` status (yellow) means env vars are present but credentials are not yet
  live/validated — a common state during initial setup.
- The `/admin/integrations` overview is separate from the Settings › Integrations
  tab panels; the panels handle credential entry, this page only shows status.

**Verify changes:** visual via the admin-pages recipe at `/admin/integrations` ·
confirm all five category sections render and badge colours match status tokens.
