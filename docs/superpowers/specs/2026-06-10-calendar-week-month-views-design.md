# Wide Week + Month Calendar Views (HCP parity) — Design

**Date:** 2026-06-10
**Status:** Approved
**Branch:** `feat/calendar-week-month-views`

## Goal

Bring the scheduling calendar closer to Housecall Pro by adding two views:

1. A **wide Week** view — a full-width 7-column time grid (Google/HCP style),
   replacing the current cramped, horizontally-scrolling week.
2. A **Month** view — a traditional 6×7 calendar grid, read-only overview.

Jobs are **color-coded by urgency** (emergency/high/medium/low) across both,
reusing the existing `urgency-badge` palette. Both views reuse the existing
DST-safe time helpers, scheduling source/queries, and request-detail sheet.

## Non-Goals (YAGNI)

- No drag-and-drop in Month (HCP month is an overview; scheduling stays in
  day/week). Month is read-only — click a chip → detail, click a day → Day view.
- No new scheduling/conflict logic. Week keeps the exact drag-to-reschedule
  semantics it has today (drop changes day+window; assignment unchanged).
- No technician-color or status-color mode in this pass (urgency only).
- No calendar-wide redesign beyond these two views.

## Current state (verified)

- `CalendarView = 'day' | 'week'`. The route maps `week → businessWeekDates`,
  `day → [date]`, returning `SchedulingCalendar { days, lanes, unassigned,
  unscheduled, availability }`.
- `InteractiveSchedulingCalendar` renders `DayView` (per-tech lanes) and a
  cramped `WeekView` (narrow `min-w-32` columns, window-bands, scrolls).
- Time math lives in `calendar-time.ts` (Eastern render, UTC persist, DST via
  the tz db). `businessWeekDates(iso)` returns the Sun-anchored 7 dates.
- Urgency enum: `low | medium | high | emergency`; palette in
  `src/components/admin/urgency-badge.tsx`.

## Design

### View model

Widen `CalendarView` to `'day' | 'week' | 'month'`. The page toggle gains a
Month button; the stepper steps 1 day / 7 days / 1 month; the range label
formats per view (Day: full date; Week: "Week of …"; Month: "June 2026").

### Shared urgency accent

Extract `urgencyAccent(urgency)` into a small shared module
(`src/lib/admin/urgency-accent.ts`) returning the left-border + dot/background
classes derived from the existing badge palette, so week cards and month chips
color consistently with the badges. `urgency-badge.tsx` may consume it too
(keeps one source of truth) but that refactor is optional and non-breaking.

### 1. Wide Week (time grid)

New `week-time-grid.tsx` replaces the inner `WeekView`:

- One left **hour axis** (reusing `hourRowLabels` / `CALENDAR_START_HOUR..END`).
- **7 equal-width day columns** (flex-1, no horizontal scroll) Sun→Sat.
- Each column is a continuous day lane showing **all** jobs for that business
  day (across technicians + unassigned), positioned by arrival window with the
  existing `positionJobs` geometry. Cards are compact, urgency-accented.
- **Today column highlighted**; a thin **"now" indicator line** when today is in
  range. Clicking a **day header** jumps to that day in Day view (callback to
  the page: `onPickDay(iso)` → `setDate(iso); setView('day')`).
- **Drag-to-reschedule preserved**: each column is a droppable under the
  unassigned scope per day (today's week semantics — reschedule moves day+window,
  never reassigns). The existing `DndContext`/handlers are unchanged; only the
  column layout/markup changes.

### 2. Month (read-only grid)

New `month-grid.tsx`:

- A **6×7 grid** (up to 6 week-rows). Weekday header Sun–Sat. Cells are the
  business days spanning the month, including leading/trailing days from
  adjacent months (dimmed). **Today emphasized.**
- Each cell shows the day number and up to **3 job chips** (arrival time +
  customer/ref, urgency-accented), then **"+N more"** when over the cap.
- **Click a chip** → open `RequestDetailSheet` (existing `onSelect(id)`).
- **Click a day cell** → jump to that day in Day view (`onPickDay(iso)`).
- Read-only: no DnD, no window-bands.

### Data layer

Month spans ~42 cells; the full lane/availability payload is unnecessary and
heavy. Add a **lightweight month payload**:

- `calendar-time.ts`: `businessMonthDates(isoDate)` — the 6×7 (or 5×7) grid of
  business-tz ISO dates covering `isoDate`'s month, Sun-anchored leading days +
  trailing days to fill the final week. DST-safe (mirrors `businessWeekDates`,
  midday anchoring). Always returns whole weeks (length 35 or 42).
- `types.ts`:
  ```
  interface MonthCalendarDay { day: string; inMonth: boolean;
    jobs: readonly DashboardRequest[]; }
  interface MonthCalendar { month: string /* YYYY-MM */;
    days: readonly MonthCalendarDay[]; }
  ```
- `scheduling-queries.ts` (or `queries.ts`): `getMonthCalendar(orgId, startIso,
  endIso, gridDays, monthYyyyMm)` — pulls scheduled jobs in range (reusing the
  existing range query / DashboardRequest projection), buckets them by business
  day, and emits one `MonthCalendarDay` per grid date with `inMonth` set from
  `monthYyyyMm`. Tenant-scoped.
- `calendar/route.ts`: accept `view=month`. For month, compute
  `businessMonthDates(date)`, derive the half-open instant range (first grid day
  midnight → day after last grid day), call `getMonthCalendar`, return the month
  payload. Day/week behavior unchanged.

### Hooks

- Widen `CalendarView` in `use-scheduling-calendar.ts` (day/week unchanged).
- Add `use-month-calendar.ts` (`useMonthCalendar(date)`) — same fetch/poll/guard
  shape as `useSchedulingCalendar`, but typed to `MonthCalendar` and hitting
  `?view=month`. A separate hook keeps the payload types clean (month ≠
  SchedulingCalendar).

### Page wiring (`calendar/page.tsx`)

- Add Month to the toggle; stepper step = `month ? 'month' : week ? 7 : 1`
  (month stepping shifts whole months via a `shiftMonth` helper).
- `view === 'month'` → render `MonthGrid` (fed by `useMonthCalendar`); else the
  existing `InteractiveSchedulingCalendar` (which now renders the wide week grid
  for `week`). Wire `onPickDay`.

## HCP-parity notes carried by this PR

- Day-drilldown navigation loop (month cell → day, week header → day).
- "Today" affordance + now-line shared across day/week.
- Consistent urgency color legend across all three views.

## Testing (≥80% bar)

- `businessMonthDates`: month start/end, leading/trailing fill, whole-week
  length, a DST-transition month, February.
- `getMonthCalendar`: bucketing by business day, range correctness, `inMonth`
  flagging, tenant scope, empty days.
- `calendar/route` month branch: payload shape + `view` parse.
- Week/Month components are wired to tested data paths; add a focused render
  test for chip overflow ("+N more") and urgency accent mapping.

## Migration / deploy

No schema change. No migration. Pure read-path + UI.
