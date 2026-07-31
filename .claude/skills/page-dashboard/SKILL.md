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
· `src/components/admin/onboarding/onboarding-checklist.tsx`
· `src/components/admin/request-detail-sheet.tsx`
· tables `serviceRequests`, `users`

**Data flow:** `useDashboardOverview` polls `/api/admin/overview` every 30 s.
A module-level SWR cache (`createSwrCache`) returns the prior payload
instantly on re-mount so returning to the dashboard paints data before the
poll resolves — no skeleton flash. The query runs four parallel DB reads
(stats + todaySchedule + needsAttention + awaitingFollowUp) in one round-trip.

**Invariants:**
- Poll is equality-guarded: if the JSON payload hasn't changed since the last
  tick, `setOverview` is skipped entirely — prevents re-rendering the whole
  page on every 30 s poll when nothing changed.
- `isMountedRef` prevents setState after unmount (fast navigation away).
- "Needs attention" filters on `assignedTo IS NULL` — an assigned-but-urgent
  request must NOT appear there even if it has no window.
- Urgency order: `emergency` before `high`, then oldest-first (longest-waiting
  floats to top).
- `onSelect` / `refetch` wiring: the `RequestDetailSheet` calls `refetch`
  after an assign so the stat cards re-count without a full page reload.

**Gotchas:**
- The dashboard lists cap at `DASHBOARD_LIST_LIMIT` (queries.ts constant) —
  they are NOT paginated. Do not add a pager; use the requests page for the
  full list.
- `DashboardListCard` receives `meta="arrivalWindow"` or `meta="followUp"`;
  adding a new meta type requires updating the component, not just the page.

**Verify changes:** `npx vitest run src/lib/admin/queries.test.ts` (covers
getDashboardStats and related helpers). Visual via the admin-pages skill recipe.
