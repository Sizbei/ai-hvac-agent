---
name: page-dashboard
description: Use when working on the /admin page — KPI overview home with live-polling stat cards and priority request lists.
---

# Dashboard (/admin)

**Purpose:** the admin home screen — an operator lands here to see open KPIs,
today's arrival-window schedule, unassigned urgent/emergency requests, and
on-hold items awaiting follow-up.

**Files:** page `src/app/admin/(dashboard)/page.tsx` · hook
`src/hooks/use-dashboard-overview.ts` · API `src/app/api/admin/overview/route.ts`
· query `src/lib/admin/queries.ts` (`getDashboardOverview`, `getDashboardStats`) ·
components `src/components/admin/dashboard/dashboard-greeting.tsx`
· `src/components/admin/dashboard/dashboard-stat-cards.tsx`
· `src/components/admin/dashboard/dashboard-list-card.tsx`
· `src/components/admin/dashboard/recent-conversations-card.tsx`
· `src/components/admin/onboarding/setup-card.tsx`
· `src/components/admin/request-detail-sheet.tsx`
· tables `serviceRequests`, `users`

**Data flow:** `useDashboardOverview` polls `/api/admin/overview` every 30 s.
A module-level SWR cache (`createSwrCache`) returns the prior payload
instantly on re-mount so returning to the dashboard paints data before the
poll resolves — no skeleton flash. `getDashboardOverview` runs five queries
(stats + todaySchedule + needsAttention + awaitingFollowUp +
overdueInvoices) via `db.batch()` — ONE HTTP round-trip, not `Promise.all`
(neon-http invariant; the stats query is built with `buildDashboardStatsQuery`
so `getDashboardStats` and `getDashboardOverview` share the exact same SQL
without either awaiting inside the batch array).

**Open requests (one definition, shared with insights and requests):** open =
status in `OPEN_STATUSES` (pending, scheduled, assigned, en_route, arrived,
in_progress, on_hold), every source. The five tiles Pending / Scheduled /
Assigned / In progress (en_route + arrived + in_progress) / On hold count
NATIVE requests and partition open exactly; each carries "+N imported" for
FieldPulse/HCP jobs in the same bucket. The caption above the tiles states the
total (`openRequestCaption`, `src/lib/admin/open-requests.ts`), and it equals
"Open requests" on /admin/insights. Before 2026-11-05 the dashboard had no
"Assigned" tile (only "Assigned today") and insights left out scheduled and
on_hold, so the two pages disagreed (19 vs 110 on the dev default org).
`assignedToday` stays in the API but has no tile.

**Invariants:**
- Poll is equality-guarded: if the JSON payload hasn't changed since the last
  tick, `setOverview` is skipped entirely — prevents re-rendering the whole
  page on every 30 s poll when nothing changed.
- `isMountedRef` prevents setState after unmount (fast navigation away).
- "Needs attention" filters on `assignedTo IS NULL` OR the assignee is an
  INACTIVE technician (`eq(users.isActive, false)`) — an assigned-but-urgent
  request must NOT appear there while its assignee is active, but deactivating
  a technician never clears `assignedTo` (see page-staff/page-technicians), so
  without the inactive check an emergency stuck on a deactivated tech would
  silently vanish from the one screen meant to catch it.
- `dashboardRequestSelect.assignedToName` is a CASE that returns `NULL` when
  `users.isActive = false` — every list built on this select withholds a
  deactivated technician's name rather than implying coverage that no longer
  exists.
- Urgency order: `emergency` before `high`, then oldest-first (longest-waiting
  floats to top).
- `DashboardStatCards` renders an "Overdue invoices" tile (links to
  `/admin/invoices`) from `overdueInvoices`; a real `0` renders `"0"`, only the
  pre-load state renders `"—"`.
- `overdueInvoices` (count + cents) reuses the SAME `overdueWhere()` predicate
  from `src/lib/admin/invoice-queries.ts` that `/admin/invoices` and
  `/admin/operations` use — never a second "overdue" definition.
- `onSelect` / `refetch` wiring: the `RequestDetailSheet` calls `refetch`
  after an assign so the stat cards re-count without a full page reload.

**Gotchas:**
- The dashboard lists cap at `DASHBOARD_LIST_LIMIT` (queries.ts constant) —
  they are NOT paginated. Do not add a pager; use the requests page for the
  full list.
- `DashboardListCard` receives `meta="arrivalWindow"` or `meta="followUp"`;
  adding a new meta type requires updating the component, not just the page.

- Tiles Pending, Scheduled, Assigned and On hold link to
  `/admin/requests?status=…`; In progress and Open emergencies span several
  statuses and are not links. On phones the strips are two columns.

- List rows: issue type via `issueTypeLabel`, hold reason via `humanizeCode`
  (sentence case, never Title-Cased enums); customer via
  `customerDisplayName` ("Erased customer" for the `[deleted]` erasure
  placeholder, "No name on file" for none — never "Unknown").
- Recent conversations fetches 20, drops sessions with no messages and no
  request (`recentConversations` in `src/lib/admin/dashboard-display.ts`) and
  titles rows by customer name → reference → channel, never an id hash.

**Verify changes:** `npx vitest run src/lib/admin/queries.test.ts` (covers
getDashboardStats and related helpers). Visual via the admin-pages skill recipe.

**Setup card:** `setup-card.tsx` (data from the onboarding store, see page-setup)
replaces the old checklist. It shows progress and Up next, hides on
`dismissedAt`/`completedSeenAt`, and for the demo org keeps its dismiss in
`sessionStorage` only.
