---
name: page-calendar
description: Use when working on the /admin/calendar page — day/week/month/agenda scheduling calendar with dnd-kit drag-and-drop.
---

# Calendar (/admin/calendar)

**Purpose:** interactive scheduling view — drag placed jobs between technician
lanes and time slots (day/week), scan a month overview, or page through the
chronological agenda feed.

**Files:** page `src/app/admin/(dashboard)/calendar/page.tsx` · hooks
`src/hooks/use-scheduling-calendar.ts` (day/week) ·
`src/hooks/use-month-calendar.ts` · `src/hooks/use-agenda.ts` ·
APIs `src/app/api/admin/calendar/route.ts` ·
`src/app/api/admin/agenda/route.ts` ·
queries `src/lib/admin/queries.ts` (`getSchedulingCalendar`, `getMonthCalendar`,
`getAgenda`) · `src/lib/admin/scheduling-queries.ts` ·
`src/lib/admin/calendar-time.ts` (`businessIsoDate`, `businessDayBounds`) ·
components `src/components/admin/calendar/interactive-scheduling-calendar.tsx`
(dnd-kit, ssr:false) · `src/components/admin/calendar/month-grid.tsx` ·
`src/components/admin/calendar/agenda-view.tsx` ·
`src/components/admin/calendar/draggable-job-card.tsx` ·
`src/components/admin/calendar/droppable-window-band.tsx` ·
`src/components/admin/calendar/conflict-dialog.tsx` ·
`src/components/admin/calendar/unscheduled-panel.tsx` ·
`src/components/admin/ui/urgency-legend.tsx` ·
tables `serviceRequests`, `users`, `technicianAvailability`

**Data flow:** day/week use `useSchedulingCalendar` (polls 30 s, latest-wins
monotonic counter); month uses `useMonthCalendar` (same pattern); agenda uses
`useAgenda` (no poll — keyset cursor pagination via `/api/admin/agenda`). Each
hook is `enabled` only for its active view so inactive hooks never fire.
`InteractiveSchedulingCalendar` is code-split with `next/dynamic` (ssr:false)
so dnd-kit doesn't load for month/agenda views.

**Invariants:**
- Date arithmetic uses Eastern business time (`America/New_York`) for the
  "today" anchor and the stepper — `todayBusiness()` reads via `Intl`, not
  `new Date().toISOString()`. UTC date math is safe for whole-day shifts only.
- `showCompleted` persists to `localStorage` (`calendar:showCompleted`); the
  initial state is `false` (SSR-safe) and synced in a `useEffect` to avoid
  hydration mismatch.
- Equality guard on every poll: `prevDataRef` serializes the payload; no
  re-render if it hasn't changed.
- Placed-job overlap predicate: half-open window overlap
  (`arrivalWindowStart < rangeEnd AND arrivalWindowEnd > rangeStart`) — NOT a
  point test. Never switch to a point test; jobs spanning a day boundary vanish.
- Agenda feed: `loadOlder` de-dupes by id as a guard against double-fire
  appending the same page twice.
- `getSchedulingCalendar`'s `unscheduled` query is ordered urgency-first
  (`emergency` then `high` then the rest), oldest-first within a tier — same
  approach as the dashboard's "needs attention" ordering. It is capped at
  `DASHBOARD_LIST_LIMIT`; a plain oldest-first order let a backlog past the
  cap push a brand-new emergency out of the very panel dispatchers place jobs
  from. Never revert to a bare `orderBy(asc(createdAt))` here.

**Shifts (M0a):** `technician_shifts` time off removes capacity: it is
subtracted in `getOpenAvailability` (via `SchedulingSource.getCapacityBlocks`),
`checkScheduleConflict`, `placeAndAssignRequest`, `assignTechnician` /
`reassignTechnician` / `scheduleRequest` (409 `TIME_OFF`),
`autoAssignBookedRequest` and `suggestTechnicians`. HCP/FieldPulse scheduling
sources ignore shifts. The calendar still renders requests only; visits #2+
(`appointments`) are rendered in M2. Known gap: the conflict dialog still
offers "Schedule anyway" for a time-off conflict (server refuses it).

**Current visit placement:** day/week (`getSchedulingCalendar`), month and the
dispatch board place a request by the visit the technician's phone shows
(`current-visit.ts`, see page-requests). Two feeds merged by
`mergePlacedRows` in queries.ts: `placedByRequestQuery` (request columns) and
`placedByVisitQuery` (driven from `appointments` in range, where the displayed
visit is #2+ or ended); a row the other feed owns is dropped. In queries.test.ts
the visit feed is the LAST select (calendar index 4, dispatch 2, month 1).
Cards carry `visitNumber` (#2+) and `visitEnded`: a later visit shows
"Visit #2" in its lead's lane, an ended one stays where it was, dashed and
struck through ("Visit ended"), and neither is draggable (a drop would rewrite
visit #1). Lane counts skip ended cards.

**Gotchas:**
- Overlapping cards sit side by side: `overlapColumns`
  (`src/lib/admin/calendar-overlap.ts`) splits each cluster of overlapping
  cards into equal columns (pixel spans, so min-height and pinned cards count).
- A failed day/week load renders `LoadErrorState` instead of the grid (never
  "Nothing to place"); the hook's error copy is human.
- A job whose window lies wholly outside the drawn hours is pinned to the
  lane's top/bottom edge (`placeJobInLane` in calendar-time.ts, dashed
  outline) — never drop it silently; the lane header counts it.
- Lanes are `shrink-0` with `height: GRID_PX`; `flex-1` squeezed them by the
  header height. Day and week axes both sit under a `pt-7` wrapper.
- Drag announcements come from `describeDragJob`/`describeDropTarget`
  (calendar-dnd.ts); draggables carry a `label`. Never let dnd-kit read ids.
- Month cells are divs; the day-number button stretches over the cell (no
  button-in-button).

- `onStatus` callback surfaces a transient `CalendarStatus` banner (warning or
  error) from `InteractiveSchedulingCalendar` after a reschedule — a rollback
  posts an error tone, a soft conflict posts warning.
- Month and agenda stepper is hidden for agenda (a flat paged list, not a
  date range).
- `unscheduled` panel in day/week: open requests with no tech OR no window —
  distinct from the "to place" queue and from the dispatch exceptions rail.

**Verify changes:** `npx vitest run src/lib/admin/scheduling-queries.test.ts`
· `src/lib/admin/calendar-time.test.ts`
· `src/lib/admin/calendar-optimistic.test.ts`.
Visual: admin-pages recipe; toggle Day → Week → Month → Agenda; drag a card.
