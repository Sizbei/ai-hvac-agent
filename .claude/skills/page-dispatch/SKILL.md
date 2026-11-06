---
name: page-dispatch
description: Use when working on the /admin/dispatch page — kanban dispatch board with auto-assign decision panel and exceptions rail.
---

# Dispatch (/admin/dispatch)

**Purpose:** day-level kanban view — one column per active technician plus an
unassigned pile; the dispatcher manually assigns or overrides the AI suggestion.
Exceptions rail surfaces requests the auto-dispatch engine queued but could not
place.

**Files:** page `src/app/admin/(dashboard)/dispatch/page.tsx` · hook
`src/hooks/use-dispatch-board.ts` · API `src/app/api/admin/dispatch/route.ts` ·
queries `src/lib/admin/queries.ts` (`getDispatchBoard`) ·
`src/lib/admin/dispatch-exceptions-queries.ts` (`getDispatchExceptions`) ·
`src/lib/admin/dispatch-decision-queries.ts` (`getDispatchDecisionForRequest`) ·
`src/lib/admin/calendar-time.ts` (`businessIsoDate`) ·
suggest API `src/app/api/admin/dispatch/suggest/[id]/route.ts` ·
assign API `src/app/api/admin/requests/[id]/assign/route.ts` ·
decision API `src/app/api/admin/requests/[id]/decision/route.ts` ·
components `src/components/admin/dispatch/dispatch-column.tsx`
· `src/components/admin/request-detail-sheet.tsx` (hosts the decision panel
  and suggestion cards)
· `src/components/admin/ui/urgency-legend.tsx` ·
tables `serviceRequests`, `users`, `dispatchDecisions`

**Data flow:** `useDispatchBoard` fetches `/api/admin/dispatch?date=YYYY-MM-DD`
(latest-wins monotonic counter, polls 30 s, equality-guarded). The route calls
`getDispatchBoard` + `getDispatchExceptions` in parallel. Technician suggestion
scores are fetched lazily from `/api/admin/dispatch/suggest/[id]` when the
detail sheet opens for an unassigned request — fail-open (empty = no card shown).

**Invariants:**
- The dispatch board anchors on the BUSINESS day (`businessIsoDate`, Eastern
  TZ), not the UTC day — after 8 pm ET the UTC date has already rolled over;
  using it would put the evening board on tomorrow.
- `dispatch-column.tsx`'s `formatTime` (exported, clock-label formatter for a
  job card's arrival-window instant) renders in `BUSINESS_TIME_ZONE`
  (`src/lib/admin/calendar-time.ts`), NOT `'UTC'` — the board is bucketed by
  the business day, so a card's time must match that zone or it reads 4-5h
  off. This is DIFFERENT from `page.tsx`'s `shiftDate`/date-stepper, which
  correctly stays pinned to UTC because it formats a plain date-only value at
  UTC midnight, not a real instant — do not "fix" that one to match.
- Jobs are bucketed strictly to ACTIVE technician columns. A job whose assignee
  is deactivated falls to the unassigned pile — it never silently disappears.
- `isShadow: true` in `dispatchDecisions` means the auto-assign ran in
  observation-only mode; the row is recorded but no assignment was committed.
  Shadow rows display a "shadow mode" indicator in the decision panel inside the
  detail sheet — do not hide them.
- `autoAssigned: true` on a request (schema `service_requests.auto_assigned`)
  surfaces as an "Auto" `ContextBadge` on the job card — preserve this badge.
- `OUTCOME_LABELS` in the page maps `queued_*` codes to human strings —
  add entries here when new auto-dispatch outcome codes are introduced.
- Override telemetry: when the dispatcher picks a different technician after
  seeing suggestions, the `/assign` route records the override in
  `dispatchDecisions` (overriddenTechnicianId, overriddenByUserId, overriddenAt).

**Gotchas:**
- Jobs are placed by the current visit (see page-calendar "Current visit
  placement"): a visit #2+ sits in its lead's column with "Visit #2"; a visit
  a hold ended stays, dashed and struck through with "Visit ended", and the
  column count skips it.
- Suggestion reasons count "requests that day" (the request's day).
- Columns render busy-first (`busyColumnsFirst`,
  `src/lib/admin/dispatch-board-order.ts`).
- `GET /requests/[id]/decision` answers 200 with `data: null` when no decision
  exists (was 404 on every sheet open).
- Suggestion reasons use `jobTypeLabel` words and singular/plural counts; the
  sheet shows no raw score number.

- Date stepper is UTC-safe for WHOLE-day shifts only (`shiftDate` uses UTC
  arithmetic) — do not introduce `getDate`/`setDate` without a TZ offset.
- Exceptions rail only shows when `board.exceptions.length > 0` — the card is
  absent (not empty-stated) when the queue is clear.
- `suggest/[id]` is advisory only; the human's final assign call is the commit.

**Verify changes:** `npx vitest run src/lib/admin/dispatch-exceptions-queries.test.ts`
· `src/lib/admin/dispatch-decision-queries.test.ts`
· `src/components/admin/dispatch/dispatch-column.test.ts`.
Visual: admin-pages recipe; create an unassigned request; confirm it appears in
the unassigned column; assign it and confirm it moves.
