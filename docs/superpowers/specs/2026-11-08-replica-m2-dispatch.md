# Replica M2: Dispatch, as deltas to /admin/calendar

Status: v4.1 FINAL (2026-11-08) after adversarial review rounds 1–3 (7 critic reports), the v4
verification and lead rulings
(log in `docs/superpowers/specs/2026-11-08-replica-m2-review-log.md`). Owner: Raymond Chen.
Milestone source: `replica/architecture.md` build order item 5 (lines 625–633), the F03 route table
(lines 134–145), the reassign-guard constraint (lines 93–95), the races paragraph (lines 344–351) and the
F04 ownership and status rules (lines 146–175). Builds on M0a, M3a, M3b and M3d (a visit with a form
submission is never deleted). Trigger citations are to `drizzle/0050_m3a_run_the_day.sql`; the live body
is 0058's, identical except the `v_has_progress` predicate (`0058_m3d_forms.sql:112-117`). Integration
paths are under `src/lib/integrations/`. Times in copy use `formatBusinessTimeRange`
(`calendar-time.ts:267`, "9 AM–11 AM").

## 1. Goal

The office runs the day on the existing day view. Dragging a request into a window its current window
doesn't cover asks which window to use. Moving a visit a technician has started is refused with a 409
until the dispatcher confirms "Move anyway"; the override is audited, and dragging the request back
reverses it. A visit worked by two technicians shows in both lanes with crew chips; the sheet's Visits
section adds and removes helpers and changes a later visit's time. Time off, non-job events and on-call
shifts show as blocks in the lane. Every movable card has a visible `Move…` button (the keyboard and
touch path). A dispatcher can move a technician's day after a preview. No second board.

FieldPulse-mapped requests (`fieldpulse_job_id` set) are read-only on the board: time, window, day and
technician are changed in FieldPulse, and the card says so. A board push to FieldPulse would write to the
owner's live account; it is a follow-up the owner verifies first (§10). Native requests (including
unmapped ones in a FieldPulse org) and Housecall Pro requests move on the board.

Done when (architecture.md): dragging across a window boundary prompts for the window; a working job
refuses reassignment with a 409 unless overridden; a two-tech job shows on both lanes. All three are
proved on native requests.

Feature rows (`replica/features.csv`, row = file line):
- **96** (must) → `yes`, "a drop into a window the current one doesn't cover asks which window; a drop
  into a covered band keeps it; FieldPulse-mapped requests are moved in FieldPulse".
- **97** (must) → `yes`, "a started visit refuses a move with 409 HAS_PROGRESS; Move anyway hands it over
  and is audited; drag it back to reverse".
- **98** (must) → `yes`, "lead + helpers per visit, added in the request sheet; the visit shows in every
  crew member's lane with crew chips; no named teams (a visit's crew is its team)".
- **102** (could) → `yes`, "move a technician's day to another day and/or technician after a preview;
  FieldPulse-mapped requests are skipped".
- Unchanged: **82** (`no`, capacity milestone), **100** (`partial`), **79**, **93**, **101**, **103**.

Dev facts (dev branch, 2026-11-08, read-only):
- Open placed requests: 32 native, 83 FieldPulse; the default org is the only FieldPulse-connected org;
  29 of its native open placed requests have no `fieldpulse_job_id`. 0 rows carry `hcp_job_id`.
- 15 open placed requests are unassigned; all 15 have a visit #1 with no assignment row.
- Windows not an exact named band: 3 of 32 native open placed, 82 of 83 FieldPulse.
- Helper rows 0 (no UI creates them today). Visits #2+: 2, both cancelled. `technician_shifts`: 0.
- Rows `in_progress` with no timestamp: 16 (15 FieldPulse, 1 native office status mirror).
- Native `pending` requests with an assignee: 5. Visits at `version` 0: 284 of 298. Job time entries with
  no `appointment_id`: 1 of 6.

## 2. Surfaces

| surface | who | what |
| --- | --- | --- |
| Calendar Day view (`interactive-scheduling-calendar.tsx` `DayView` / `DayLane`, :165–332) | admin | crew chips, helper copies, blocks, drop flow, dialogs, banner, `Move…`, lane menu `Move this day…` |
| Calendar Week view (`WeekView`, :346–415) | admin | prompt on drops; one card per request |
| Unscheduled list (`draggable-unscheduled-panel.tsx`) | admin | drags and `Move…` use the move route |
| Request sheet, Visits section (`request-detail-sheet.tsx:578-615`) | admin | `Technicians` control and `Change time` on a later visit (§7.7); refusal copy (§5.6) |
| `/admin/dispatch`, month, agenda, tech app | — | unchanged |

## 3. Data model

**No migration.** `drizzle/0059` stays free.

### 3.1 Arrival windows
`arrival_window_start` / `arrival_window_end` on `service_requests` (`schema.ts:570-571`) and
`appointments` (`:707-708`); no `window_start` / `window_end` exists. `starts_at` / `ends_at` (`:705-706`)
are written equal to the window by every writer (0050:102–105; `appointment-queries.ts:163-166`, :257;
dev: 0 differ), and M2 keeps them equal. Visit #1 is written through the request columns and mirrored by
the trigger, which fires only on a real change of the date, either window end, `assigned_to` or `status`
(0049:221–229). Named windows `ARRIVAL_WINDOWS` (`arrival-window.ts:12-27`); drop bands
`RESCHEDULE_WINDOW_ROWS` (`calendar-time.ts:329-333`).

### 3.2 Started
`src/lib/admin/visit-started.ts` (pure `rowStarted`, SQL twin `startedRowSql(alias)`);
`STARTED_ASSIGNMENT_STATUSES = ['en_route', 'arrived', 'in_progress', 'completed']` in `request-status.ts`.
Only live rows (`status <> 'cancelled'`) count:
- the lead row is started when `en_route`, `arrived`, `in_progress`, `completed`, or `on_hold` with a
  progress timestamp (a pause);
- a helper row is started when working (`en_route`, `arrived`, `in_progress`, or a pause);
- timestamps alone don't count; they only tell a pause from an untouched `on_hold`.
A visit is started when any live row is. Status counts because the trigger mirrors request status onto
an untouched lead row (0050:147–159; dev: 16) and architecture.md:93–95 names the guard by status.

Where it applies: a new `visitOneStartedGuardSql()` beside `visitOneGuardSql()` (`visit-one-guard.ts:39`)
is used by the move, drag-to-Unscheduled, `assignTechnician`, `reassignTechnician` and
`placeAndAssignRequest`; `classifyVisitOne` (:44) takes the rule. **Unchanged**, on today's timestamp rule:
the sheet's schedule edit (`scheduleRequest`, `queries.ts:914`) and `updateAppointment`
(`visitProgressed`, `appointment-queries.ts:199-201`; it deletes untouched rows and plain-inserts the list,
`:272-275`, so a timestamped row passing the gate would hit `appointment_assignments_unique`). The sheet's
reassign refuses a visit where only a helper is working; the board allows that lead swap (§5.3). The
sheet's refusal points to `Move…`. `REASSIGNABLE_STATUSES` (`request-status.ts:69`; architecture.md:95
places it in `queries.ts`) stays `IN_FLIGHT_STATUSES`.

### 3.3 Crew
A visit's crew = its live rows (`schema.ts:728-752`; one lead). The M3a helper writers change:
- `addVisitTechnician` (`assignment-queries.ts:61`): the request lock becomes `FOR NO KEY UPDATE` (:79,
  so two adds can't both see 4); a cancelled non-lead row is revived instead of `ON CONFLICT DO NOTHING`
  (:90): `DO UPDATE SET status = 'assigned', assigned_by = $actor, assigned_at = now(), en_route_at = NULL,
  arrived_at = NULL, started_at = NULL, completed_at = NULL WHERE appointment_assignments.status =
  'cancelled' AND NOT appointment_assignments.is_lead`; requires a live lead row → 409 `NO_LEAD`
  (today any visit with no rows passes, :86); enforces `MAX_TECHNICIANS_PER_VISIT = 5`
  (`appointment-types.ts:30`) in SQL → 409 `VISIT_FULL`.
- `removeVisitTechnician` (:125): untouched → DELETE (today); not started by §3.2 but timestamped →
  `status = 'cancelled'`; started → `HAS_PROGRESS` (today).
- Both bump `appointments.version` in the same batch, gated on the row write, so a stale sheet or board
  card answers `VERSION_CONFLICT` / `STALE` after another dispatcher's helper change.
- **Revived rows start clean.** Every revive (helper add, a lead row by `reviveLeadSql`, §5.3) nulls the
  four progress timestamps, so arrival KPIs and M3d's own-progress gate (`form-gates.ts:25-28`) aren't fed
  stale stamps. History stays in time entries and status events.
- The visits GET (`listAppointments`) adds `started` (from `rowStarted`) and `hasProgress` (any timestamp)
  per assignment for the sheet.

### 3.4 Blocks
`technician_shifts` (`schema.ts:754-772`; kinds `on_call`, `time_off`, `non_job`; `removes_capacity`
default per `shift-types.ts:20-22`; up to 31 days, :17). Read only; written on the Staff page's time-off
dialog. Only `removes_capacity` rows block (as `noTimeOff`, `appointment-queries.ts:76-80`), whatever the
kind.

## 4. Concurrency

### 4.1 Revision gate
Cards carry `visitId` and `visitVersion`. `visitId` = the displayed visit (`displayVisitIdSql`,
`current-visit.ts:54-59`), falling back to visit #1's id: `activeVisitIdSql` (:33-40) returns only a visit
with a live row, and an unassigned #1 has none (dev: 15 of 15). `visitId: null` means no visit #1 exists.
The gate: `EXISTS (SELECT 1 FROM appointments p WHERE p.id = $visitId AND p.organization_id = $org AND
p.service_request_id = $rid AND p.appointment_number = 1 AND p.version = $v)`, or `NOT EXISTS (…
appointment_number = 1)` for null. The id matters because a new #1 starts at version 0. The trigger bumps
#1's version on every watched change (0050:119), so a lead's status tap, another dispatcher's move, a
helper change (§3.3) or an autopilot placement between render and drop answers `STALE`. A helper's tap
bumps nothing and is caught by the started guard. The autopilot places only still-unassigned requests
(`requireUnassigned`, `scheduling-queries.ts:780-785`); its residual is in §11. The same gate is added to
drag-to-Unscheduled (§5.5).

### 4.2 Idempotency
- **Single move: not keyed.** Absolute values under the version gate; a re-send after a lost response
  answers `STALE`; the client refetches and treats the move as landed, quietly, when the refetched card has
  the intended lead and window (pure `moveLanded`).
- **Mass reschedule: keyed** (`withIdempotency`, `idempotency.ts:215`; Idempotency-Key required,
  `parseIdempotencyKey` :47; 2xx stored; no new `STORED_CODES`). The client mints one key per commit body
  and reuses it only for a network retry of that body. `runAsWinner` stores the done row after the work
  (:186-200), so a crash between commit and done row is recovered from the audit row: id
  `derivedId(scope, 'audit')` (org-scoped, :82-87); every batch statement carries `NOT EXISTS (SELECT 1
  FROM audit_log WHERE id = $auditId AND organization_id = $org)`; `run` first reads that row (org-scoped)
  and, when it exists, rebuilds the 200 from it plus current versions and writes nothing.
- **Recovery re-sends only update-style pushes:** `syncRequestToCalendar` and `pushJobToHcp` for moved
  requests that already have `hcp_job_id` (the update path). Never an HCP create, `stampDispatchOverride` or
  `recordStatusEvent` (a stale telemetry stamp would overwrite a later human pick, `dispatch-override.ts:62-76`;
  events would duplicate). A moved request that would need an HCP create is listed in the 200 as
  `pushesNotSent: [requestId]` ("Not sent to Housecall Pro. Open it to retry."). The pushes are idempotent
  only when sequential (HCP creates before its `hcp_job_id IS NULL` mapping write, `housecall-pro/job-sync.ts:188-209`;
  the Google upsert is list-then-insert, `google-calendar/client.ts:176-203`), so `run` registers its
  `after()` calls as its last step, after the 200 envelope is built: a run that throws has registered
  none, and a takeover happens only after 2 minutes.

### 4.3 Locks
L_req first in every batch (`lockRequestSql`, `invoice-field-writes.ts:42`); mass locks all its requests
`ORDER BY id FOR NO KEY UPDATE`. Request → rows everywhere.

## 5. Writers

### 5.1 Who, and synced requests
Admin session only (`verifyToken` rejects other roles, `auth/config.ts:45`); no `/api/tech` change. Every
body id is re-read under the session org inside the write. Every FieldPulse refusal is a SQL predicate
(`fieldpulse_job_id IS NULL`) in the writer's guarded statement, plus the classifier.

| source | time / window / day | technician | pushes after a visit #1 change |
| --- | --- | --- | --- |
| native, no FSM id | yes | yes | `syncRequestToCalendar`, `pushJobToHcp` as today (`reschedule/route.ts:184-189`); no FieldPulse call |
| Housecall Pro (`hcp_job_id`) | yes | yes | the same |
| FieldPulse (`fieldpulse_job_id`) | **no**: 409 `MANAGED_EXTERNALLY` | **no** | — |

- **Native.** Today's drag pushes to Google Calendar and HCP only; M2 matches it. In an HCP-connected
  org `pushJobToHcp` creates the HCP job on the first move (`housecall-pro/job-sync.ts:160-200`), as today;
  the request stays movable (HCP writes back status and invoice status only,
  `housecall-pro/webhook-sync.ts`), but the M3a crew writers then refuse it (`assignment-queries.ts:83`).
  Dormant on dev.
- **FieldPulse-mapped** requests are refused by the move, drag-to-Unscheduled, mass reschedule
  (`fieldpulse`), and the sheet's `assignTechnician` / `reassignTechnician` (`queries.ts:506`, :662; today
  they write an assignee the nightly import overwrites, `import/jobs.ts:429-460`). The import owns their
  window and assignee (`import/jobs.ts:528-536`). M2 makes no FieldPulse call. The sheet's schedule edit
  and its existing `pushJobToFieldpulse` are untouched (§11).

### 5.2 Window resolution (`src/lib/admin/move-window.ts`, pure, client and server)
- **Drop band** = the band under the pointer: `pointerWithin`, falling back to `rectIntersection` when the
  pointer is over no droppable (a lane gap). Task 0 proved the fallback is needed: with plain `pointerWithin` a
  card dragged from Unscheduled stops auto-scrolling while the pointer rests in an 8 px lane gap. A drop
  released in a gap therefore lands on the band the card overlaps most; the window prompt still guards a band
  change. A drop over nothing at all does nothing.
- `currentWindowKind(start, end)` → `band` | `anytime` | `custom` | `none`.
- `covers(current, D, B)` = the current window, on day `D` with the same wall-clock times, overlaps band
  `B` (half-open).
- `promptPlan(current, D, B, leadChanges)`:
  - no window (Unscheduled) → no prompt, use band `B`;
  - `covers` → no prompt, keep. A lane change into a covered band never prompts. Same lane and day → nothing
    is sent; no banner when `B` is exactly the window, else "Still 8 AM–8 PM. Use Move… to change the
    window.";
  - otherwise prompt. Default "Use the new window" for a `band` window, "Keep" for `anytime` and `custom`
    when the day or lead changes; with the same day and lead Keep would change nothing, so it isn't offered.
- `resolveMoveWindow(current, D, B, rule, pick)`: `match` → band `B` on `D`
  (`arrivalWindowUtcForBusinessDate`, `calendar-time.ts:311`); `pick` → an `ARRIVAL_WINDOWS` value on `D`;
  `keep` → the same wall-clock start and end on `D` (`businessWallClockToUtc`, :129; an end past midnight
  stays on `D + 1`). `keep` with no window → 400 `VALIDATION_ERROR` `{ path: ['windowRule'] }`.
- The server recomputes from the window it read. A changed window whose end ≤ now → 400 `WINDOW_ENDED`
  (`window-ended.ts:9`); a lead change keeping an ended window is allowed. The client disables ended choices
  and doesn't send an Unscheduled drop into an ended band (banner `WINDOW_ENDED_MESSAGE`).

### 5.3 `moveVisit` (`src/lib/admin/visit-move.ts`)
Input `{ requestId, visitId | null, expectedVersion | null, day, band, windowRule, pick?, technicianId?,
confirm: ('started' | 'conflict')[] }`. `technicianId` = the new lead (absent or equal = keep); dropping on
Unassigned never unassigns (`interactive-scheduling-calendar.tsx:561-573`). Only **visit #1** moves, and
only while it is the displayed visit and live; otherwise 409 `VISIT_PINNED` `{ visitNumber }` or
`VISIT_ENDED`.

**Pre-read** (one query): request (status, source, assignee), visit #1 (version, window, `cancelled_at`,
ended), its live rows with `rowStarted`, open time entries per technician. Refusals in order: 404;
`REQUEST_TERMINAL`; `VISIT_ENDED`; `VISIT_PINNED`; `STALE`; `MANAGED_EXTERNALLY`; `TECHNICIAN_NOT_FOUND`
(`activeTechnicianIds`, `appointment-queries.ts:63`); `TECHNICIAN_DONE` (the new lead is a `completed`
helper on this visit: "Sam has finished on this visit."); `WINDOW_ENDED`; `TIME_OFF`. Time off and
conflicts are checked only for the technicians the move assigns: the new lead when the lead changes, and,
when the window changes, every live crew member who stays. A crew member whose time doesn't change is
never re-checked; the old lead leaves the visit, so their time off never blocks a handover.

Confirm needs:
- `started`: the lead changes and the current lead's row is started; or the window changes and any live
  row is started. A lead swap with only a helper working and the window unchanged needs nothing.
- `conflict`: a checked technician has an open row (`OPEN_ASSIGNMENT_STATUSES`, `ownership.ts:13-15`) on
  another live visit of an open request overlapping the window (half-open, as `checkScheduleConflict`,
  `scheduling-queries.ts:237`), or the window is outside the new lead's hours (a span variant of
  `isWindowWithinAvailability`, `availability-coverage.ts:88`, over `spanIsCovered`, :56).
Unconfirmed needs → 409 `HAS_PROGRESS` when `started` is among them, else `SCHEDULE_CONFLICT`; `details:
{ needs, started?: [{ technicianId, status, hasTimestamp, openTimeEntry }], conflicts?: [{ id,
referenceNumber, technicianId, arrivalWindowStart, arrivalWindowEnd }], outsideAvailability? }`. `TIME_OFF`
details `{ timeOff: [{ technicianId, startsAt, endsAt, kind }] }`, no `needs`: time off is never
overridable (admin-pages skill).

**Batch** (every predicate carries `organization_id = $org`; `<gate>` = `EXISTS (SELECT 1 FROM
service_requests r WHERE r.id = $rid AND r.organization_id = $org AND r.xmin = pg_current_xact_id()::xid)`):
0. L_req.
1. `UPDATE service_requests SET assigned_to = $lead, scheduled_date = $start, arrival_window_start =
   $start, arrival_window_end = $end, status = <CASE>, hold_reason = <…>, follow_up_date = <…>, updated_at
   = now() WHERE id = $rid AND organization_id = $org AND fieldpulse_job_id IS NULL AND status NOT IN
   ('completed','cancelled') AND <version gate> AND NOT <#1 ended or cancelled> AND <lead not done:
   NOT EXISTS (SELECT 1 FROM appointment_assignments d WHERE d.organization_id = $org AND d.appointment_id
   = <#1> AND d.technician_id = $lead AND d.status = 'completed')> AND <no time off, checked
   technicians> AND (<'started' confirmed> OR NOT <started arm>) AND (<'conflict' confirmed> OR <no
   conflict>) RETURNING id, status`. Each guard is the SQL twin of a pre-read check. `<CASE>`: `pending`
   with a lead → `assigned` (as `create-request-queries.ts:375-387`); a lead change past a started lead
   while `status IN ('en_route','arrived','in_progress','on_hold')` and no other live row is started →
   `scheduled`, clearing `hold_reason` and `follow_up_date` (as `appointment-queries.ts:121-122`);
   otherwise unchanged. `en_route` and `on_hold → scheduled` are listed edges (`request-status.ts:33`,
   :38); the rest are override-only, recorded as such.
2. The old lead, on a lead change. The trigger deletes an untouched row, demotes a progressed one to
   `cancelled` and keeps a `completed` one (0050:125–133); M2 also cancels the kept `completed` row
   (`… SET status = 'cancelled' WHERE technician_id = $oldLead AND NOT is_lead AND status = 'completed' AND
   <gate>`). Timestamps stay as history. The old lead leaves the crew.
3. The new lead's row (a trigger insert, or an existing row the trigger keeps `cancelled`, 0050:134–145):
   `reviveLeadSql(org, rid, gate)` = `UPDATE appointment_assignments a SET status = CASE WHEN r.status IN
   ('en_route','arrived','in_progress','on_hold') THEN 'assigned' ELSE r.status END, en_route_at = <NULL
   when reviving a cancelled row>, … FROM service_requests r WHERE r.id = $rid AND … a.technician_id =
   $lead AND a.is_lead AND (a.status = 'cancelled' OR (a.status IN ('en_route','arrived','in_progress',
   'on_hold') AND <no timestamp>)) AND <gate>`.
4. The old lead's open time stops: `closeJobEntriesSql({ organizationId, requestId: $rid, technicianIds:
   [$oldLead], gate })` (`time-entry-sql.ts:34`) with the visit filter `(t.appointment_id = <#1> OR
   t.appointment_id IS NULL)`.
5. Audit, gated on `#1.xmin = pg_current_xact_id()::xid` (the M3c gate, `equipment-writes.ts:89`).
6. `SELECT version FROM appointments WHERE … appointment_number = 1` (after the trigger), for the 200.

**Zero rows** → re-read in the pre-read's order; nothing failing → `STALE`. A deadlock (`isDeadlock`,
`status-writes.ts:53`) → `STALE`.

**After the batch** (best-effort, as `scheduling-queries.ts:843-868`, registered last): `recordStatusEvent(old
→ 'assigned', human)` on every first assignment, whatever the status column did; `old → scheduled` (human)
on an override reset; `stampDispatchOverride(org, rid, lead, user)` when a lead is set; `after()`
`syncRequestToCalendar` and `pushJobToHcp` on a window or lead change. No FieldPulse call. No message to a
customer or technician.

Success → 200 `{ visitId, visitVersion, requestStatus, arrivalWindowStart, arrivalWindowEnd, leadId,
confirmed }`.

**What an override hands over.** The old lead's row is `cancelled` with its timestamps; their time entries
stay and their open time stops. They still read the job (`techCanReadSql`, `ownership.ts:169-171`) but
can't write forms on that visit (the gate needs a live row, `src/lib/forms/form-gates.ts:16`). Their M3d
draft stays on the visit (submissions belong to the visit), and the new lead can edit it once on site
(request in `BILL_STATUSES` or their own row arrived, `form-gates.ts:36-41`). Lead-only work (status taps,
close-out, field invoice, estimates, payments) passes to the new lead; drafts stay on the request
(`field-sale-statuses.ts:7`). To reverse, drag the request back: an ordinary move that revives the old
lead's row clean (step 3), with progress starting again from their next tap.

**Audit** `visit_moved`, entity `appointment`, entityId #1: `{ requestId, fromTechnicianId,
toTechnicianId, windowRule, window: 'morning' | 'afternoon' | 'evening' | 'anytime' | 'custom', dayChanged,
confirmed, startedStatuses, conflictCount, outsideAvailability }`. No instants.

### 5.4 Drag-to-Unscheduled (`unscheduleRequest`, `scheduling-queries.ts:916`)
Gains the §4.1 version gate (the card already carries it), the FieldPulse predicate,
`visitOneStartedGuardSql`, and a work-logged guard: `NOT EXISTS (SELECT 1 FROM technician_time_entries t
WHERE t.organization_id = $org AND t.service_request_id = $rid AND t.kind = 'job' AND (t.appointment_id =
<#1> OR t.appointment_id IS NULL))` → 409 `WORK_LOGGED`. Why: a revive clears timestamps (§3.3), and the
0058 trigger keeps visit #1 only when a row has a timestamp or the visit has a form submission
(0058:150-160), so after arrive → Move anyway → drag back, an Unscheduled drop would delete a worked visit
(its rows cascade, its entries lose `appointment_id`, `schema.ts:2594`). Time entries are the durable
record of work, so they gate it. HCP pushed as today (`unschedule/route.ts:72-73`). A visit with a form
submission keeps its row (0058); M2 deletes no worked visit.

### 5.5 The sheet
- `assignTechnician` / `reassignTechnician` get the started guard (no override there), the FieldPulse
  predicate, the same lead-not-done predicate as §5.3 step 1 (409 `TECHNICIAN_DONE`), and `reviveLeadSql` appended to their `lockedUpdate` batch (`visit-one-guard.ts:32-36`) gated
  on the request xmin, so a sheet reassign A → B → A never leaves a `cancelled` lead.
  `placeAndAssignRequest` (autopilot, office booking) appends it too.
- `scheduleRequest` and `updateAppointment` are unchanged (§3.2).
- `visitOneRefusalResponse` (`visit-one-guard.ts:59-62`) takes a context and checks FieldPulse first:
  any sheet refusal on a FieldPulse-mapped request names FieldPulse (§8). Native: "A technician has
  started this visit. To move it anyway, use Move… on the calendar."
- On a FieldPulse-mapped request the Assign/Reassign select is disabled, with "Change the technician for
  this request in FieldPulse." below it.

### 5.6 Mass reschedule (`src/lib/admin/mass-reschedule.ts`)
Every displayed visit #1 on business day `D` whose lead is `T` moves to day `D2` and/or lead `T2`,
keeping wall-clock times. No `deltaMinutes` (architecture.md:144); no undo (move them back).
- **Preview** lists every visit `T` is on that day: `moves`, or skipped `started`, `ended`, `later_visit`,
  `time_off` (checked: `T2`, plus the crew when the day changes), `window_ended`, `already_on_visit` (`T2`
  has any row, cancelled included), `fieldpulse`, `helper`; plus the soft flag `conflict`.
- **Commit** `{ technicianId, fromDate, toDate, toTechnicianId?, visits: [{ visitId, expectedVersion }]
  (1–30), preSkipped: [{ visitId, reason }], confirmConflict }`, keyed. One batch: L_req over all, then per
  visit the §5.3 statements with their own version gate, lead gate `= T` and `starts on D`; `started` is
  never confirmed in bulk; `confirmConflict` confirms `conflict` for all, else those skip. Any statement
  error rolls back all and answers 500. Then the audit row, computed **in SQL**: `movedVisitIds = (SELECT
  array_agg(p.id) FROM appointments p WHERE p.id = ANY($candidateIds) AND p.organization_id = $org AND
  p.xmin = pg_current_xact_id()::xid)`; `skipped` = `preSkipped` (validated: ids among the day's visits,
  reasons from the enum) plus every candidate not moved as `stale`.
- After (registered last): per moved request the §5.3 after-calls, and `stampDispatchOverride(org, rid,
  T2, user)` when `T2` is set.
- Result `{ moved: [{ visitId, requestId, visitVersion }], skipped: [{ visitId, reason }], pushesNotSent }`,
  read back from the audit row.
- Audit `dispatch_mass_rescheduled`, entity `user`, entityId `T`: `{ toTechnicianId, dayShift,
  movedVisitIds, skipped: [[visitId, reason]], confirmConflict }`.

## 6. Routes (`force-dynamic`, admin session, logs carry codes and ids only)

| route | gate | success |
| --- | --- | --- |
| `GET /api/admin/calendar` (exists) | `adminRead` | §7.1 fields; day view adds `blocks` |
| `POST /api/admin/requests/[id]/move` (new) | `isUuid`, `admin:visit-move:<user>` `adminMutation`, `readJsonBody`, zod | §5.3 |
| `POST /api/admin/requests/[id]/unschedule` (exists) | + version, FieldPulse, started guard, `WORK_LOGGED` | unchanged |
| `POST` and `PATCH /api/admin/requests/[id]/assign` (exist) | + FieldPulse refusal, started guard, `TECHNICIAN_DONE`, revive | unchanged |
| `PATCH /api/admin/requests/[id]` (exists, schedule edit) | unchanged | unchanged |
| `POST /api/admin/dispatch/mass-reschedule/preview` (new) | `adminRead`; `isRealIsoDate`, today − 1 … today + 365; `isUuid` | `{ candidates }` |
| `POST /api/admin/dispatch/mass-reschedule` (new) | `adminMutation`, zod, Idempotency-Key | §5.6 |
| `POST/DELETE …/appointments/[aid]/assignments` (exist) | + `NO_LEAD`, `VISIT_FULL`, revive, version bump (§3.3) | unchanged |
| `PATCH …/appointments/[aid]` (exists) | unchanged | used by `Change time` |
| `POST /api/admin/requests/[id]/reschedule` | **removed** with `tests/api/admin/reschedule.test.ts` and its route test; only caller `use-reschedule-job.ts:99`, which keeps `unschedule` | — |

## 7. Client

Admin primitives, sentence case, "request" and "technician", no `err.message`. Logic in pure helpers.

### 7.1 Board data (`getSchedulingCalendar`, `queries.ts:1661`)
After `mergePlacedRows` (:1573), one query reads each placed and Unscheduled card's visit (§4.1's
expression), its `version`, `cancelled_at` and live rows joined to `users`, org-scoped. Cards gain
`visitId`, `visitVersion`, `crew: [{ technicianId, name, isLead, state: 'open' | 'working' | 'done' }]`
(inactive names withheld as `dashboardRequestSelect`, :1263-1267), `started`, `movable: 'yes' | 'no'`
(`no` for FieldPulse-mapped, a displayed #2+, an ended visit, a #1 with `cancelled_at`, or a
completed/cancelled request), `laneRole`. Day view adds `blocks` (`listShiftsInRange`, all kinds).
`queries.test.ts`: new queries after the existing five; the visit feed stays index 4.

### 7.2 Lanes, crew and cues
- Helper copies (`laneCards`, pure): each active helper's lane; not draggable; "Helping <lead first
  name>"; title "<customer> · <ref>. Helping <lead>. Move it from <lead>'s lane."; keys
  `${requestId}:${technicianId}`.
- Crew chips (`crew-chips.tsx`), own row under the customer, only with 2+ crew: initials, lead first with
  the `marker` border, working filled, done with a check, `+N` past 3, `aria-label` with name and state.
  `chipLayout(width, height)`: below 120 px wide, in Week view, or below 72 px high → a people icon and
  the count in the top row, `aria-label="2 technicians"`. Card width = (224 / `columns`) − 4.
- FieldPulse: the `SyncPill` (`sync-pill.tsx:3`, props `source`, `size`) wrapped in a span titled "Change
  this request in FieldPulse."; `md` ("FieldPulse") in Day view when the card is ≥ 160 px wide, else `sm`
  ("FP"); Week view and Unscheduled rows always `sm`; a lock icon beside it; no grab cursor, no `Move…`;
  the time never truncates before the pill.
- Started: an activity icon (not the lock) titled "Started. Moving it asks first.", only on `movable:
  'yes'` cards; "started" in the `aria-label`.
- Visit #2+ (pinned, today's `:224`): tag "Visit #<n>" (today), title and `aria-label` suffix "Visit #<n>.
  Change its time in the request."; no grab cursor.
- Lane counts include helper copies; ended skipped (`liveJobCount`, :127).
- Layout: `TimeAxis` moves out of the `overflow-x-auto` element; the lanes sit in their own `overflow-x-auto
  min-w-0 flex-1` scroller. Width at 1440: 1440 − sidebar 232 (`sidebar.tsx:329`) − `PageShell p-6` 48 −
  Unscheduled 288 + gap 16 (`draggable-unscheduled-panel.tsx:125`) − board `p-3` and border 26 − axis 56 +
  gap 8 = 766 px of lanes at 224 + 8: **Unassigned plus two technician lanes are fully visible**, the third
  shows 70 px, the rest scroll. Lane headers get `tabIndex={-1}` (focus targets).
- `DndContext autoScroll={{ threshold: { x: 0.04, y: 0.2 }, acceleration: 3 }}` (Task 0 retuned from 0.06 / 5; passed twice): the horizontal zone
  shrinks from dnd-kit's default 0.2 of the scroller (153 px of 766, which covers the right half of the
  second technician lane, `@dnd-kit/core` `getScrollDirectionAndSpeed`) to about 31 px, inside the 70 px peek of
  the third lane, at 0.3 of the default speed.

### 7.3 Blocks
`lane-blocks.tsx`, between the bands and the cards in z-order (`placeJobInLane`), non-interactive: a
`removes_capacity` block hatched with the title or "Time off" / "Non-job event" / "On call"; a block that
keeps capacity outlined only (`on_call` as a 3 px rail). A small "Staff" text link inside the block's
label (`/admin/staff`) is the only link. Bands stay droppable. `describeDropTarget` (`calendar-dnd.ts`)
appends ", Sam is off" or ", ended". Ended bands on today are shaded.

### 7.4 Drop flow and focus (`handleDragEnd`, `interactive-scheduling-calendar.tsx:534`)
`KeyboardSensor` and `sortableKeyboardCoordinates` (:513-515) are removed (they never move: the active id
`job:<uuid>` has no droppable), and `@dnd-kit/sortable` leaves `package.json` (its only import is :17).
The draggable wrapper (`draggable-job-card.tsx:45-48`) drops dnd-kit's `tabIndex` (set -1),
`aria-roledescription` and `aria-describedby`; `DndContext accessibility.screenReaderInstructions` reads
"Use Move… to move a request with the keyboard." Tab order per card: the card button, then `Move…`.
`handleDragStart` (:523-532) finds the card by `requestId` and `laneRole === 'lead'`. Client move state
(overlay, optimistic board, in-flight set, `applyMoveResult`) is keyed by `requestId`; `visitId` only rides
in the body.
1. Unscheduled drop → §5.4. Its `STALE` goes through the same refetch and `moveLanded` path as a move
   (landed means the request is back in Unscheduled); otherwise the STALE banner (§8).
2. `promptPlan`; the prompt if needed.
3. `resolveMoveWindow`.
4. `timeOffHits(blocks, checkedTechnicians, window)` (pure; `removesCapacity` blocks only) → the time-off
   dialog, nothing sent.
5. No-op → nothing (or the covered line, §5.2).
6. Optimistic move: `optimisticCrew(crew, newLeadId)` (new lead out of the helpers, old lead off),
   `laneCards` re-derived; then `POST …/move`.
7. 200 → `applyMoveResult` (version, lead, window), refetch, `moveBanner`. 409 needs → roll back, confirm.
   `TIME_OFF` → time-off dialog. `STALE` or network failure → refetch; `moveLanded` keeps it quietly, else
   the banner. Other codes → roll back, banner, refetch.
The in-flight set disables only that request's card and copies; `isRescheduling` leaves the lane and
Unscheduled props (:702, :715, :727).
**Focus** (next frame, after a drop, a refusal or any dialog closing): the card button
`[data-request-id="…"][data-lane-role="lead"]`; if that card isn't on the board, the drop lane's header; after
a `Move…` to another day, the date stepper's label. Dialogs set `onCloseAutoFocus={e => e.preventDefault()}`
and call this helper.

### 7.5 Dialogs, banner and `Move…`
- **Window prompt** (`window-prompt-dialog.tsx`): title "Arrival window"; description "Moving <customer> ·
  <ref> to Sam's afternoon." (lane named when it changes); a `RadioGroup`: "Keep 9 AM–11 AM" (+ " on Wed,
  Nov 11"), "Use the afternoon window · 12 PM–4 PM" (disabled "Already ended" when that band ended),
  "Choose a window" revealing a `Select` (Morning, Afternoon, Evening, Anytime with hours; `selectLabel`;
  ended ones disabled "Already ended"); defaults §5.2; footnote "The customer isn't told about this
  change."; Enter = Move except while the Select is open; Escape = Cancel; buttons "Move" / "Cancel".
- **Confirm** (`ConflictDialog` generalised; its time-off branch, `conflict-dialog.tsx:71-93`, deleted):
  title "Move anyway?"; §8 lines; "Cancel" / "Move anyway" ("Moving…").
- **Time-off dialog**: title "Can't move this request"; one line per technician (§8); "Pick another time or
  technician."; "OK".
- **`Move…`**: a small always-visible ghost button (`h-6`, "Move…") at the card's bottom-right on every
  `movable: 'yes'` lead card and Unscheduled row; `aria-label="Move <customer> · <ref>"`. It is the keyboard
  and touch path. Dialog `move-dialog.tsx` (pure `moveDialogDefaults(card, today)`, `moveDialogBody(card,
  form)`):
  - title "Move <customer> · <ref>"; buttons "Move" / "Cancel" ("Moving…");
  - **Technician** `Select`: the current lead selected; an unassigned or Unscheduled card shows
    "Unassigned" first and selected, which keeps it unassigned;
  - **Date**: the card's business day (an Unscheduled card without one: today); min today, max today + 365;
  - **Window** `RadioGroup`: "Keep 9 AM–11 AM" (shown only when the card has a window; the default then),
    Morning, Afternoon, Evening, Anytime with hours; without a window the default is the first band on the
    chosen date that hasn't ended; ended choices disabled "Already ended";
  - "Move" is disabled while nothing changes (same technician, date and Keep);
  - `timeOffHits` runs when the date is the displayed day; otherwise the server's `TIME_OFF` opens the same
    dialog;
  - it sends the move route (`windowRule` `keep` or `pick`, `day`, `band` = the picked band or the window's
    starting band), then the same 409 flow, confirm and banner.
- **Banner** (`moveBanner(response, crewBefore, crewAfter)`, pure): "Moved." / "Sam is now the lead. Alex
  is off this visit." / errors. `CalendarStatus` (`calendar/page.tsx:47`) moves to a live region that is
  always mounted, `fixed` bottom-right (top-centre below 640 px), with a close ×; `role="status"`, errors
  `role="alert"`. "Moved." clears after 4 s; errors stay until closed; any banner clears on the next drag
  start (a board callback).

### 7.6 Mass reschedule
Each technician lane header (not Unassigned) gets `⋯` (`aria-label="More for <name>"`) → `Move this day…`,
also when the board isn't interactive. Dialog "Move <name>'s requests on Tue, Nov 10": `To day` (default
the next weekday; picking a technician sets it to the same day only if the dispatcher hasn't changed it;
min today, max today + 365), `To technician` ("Same technician"), the preview (skeleton after 300 ms;
"Couldn't load the preview. Please try again." + Try again; "No requests to move on this day."), rows "9
AM–11 AM · <customer> · <ref>" with "Moves" or the reason, and a checkbox "Move them even where they
overlap" when any `conflict` shows. "Move 1 request" / "Move N requests" counts the rows that will move;
disabled when nothing changes. After commit the board refetches and the dialog stays open on the result:
"Moved 3 of Alex's requests to Sam on Wed, Nov 11." (variants without day or technician; "None of Alex's
requests moved."), what stayed with reasons, and `pushesNotSent` rows. Commit failure "Couldn't move the
requests. Please try again."; 422 (key reused) "This move was already sent with different choices. Open
the preview again."

### 7.7 Sheet: Visits section
- **Technicians** on each live visit row: the crew with "Lead"; a × on each helper whose `started` is
  false ("Remove <name> from this visit", `DELETE …/assignments/[tid]`); "Add technician", a `Select` of
  active technicians not live on the visit (`POST …/assignments`), disabled at 5 with "A visit can have up
  to 5 technicians.", hidden with "Assign a technician to this request first." while the visit has no
  lead. FieldPulse rows: "Change the technicians for this request in FieldPulse."; HCP: "Helpers aren't
  available for Housecall Pro requests." `VisitsSection`'s `onChanged` (`request-detail-sheet.tsx:381-404`)
  also calls `onAssigned` so the board refetches. The lead changes with Reassign below, or on the
  calendar.
- **Change time** on each live visit #2+: dialog "Change visit #<n>" (date, window `Select`, "Save" /
  "Cancel") → `PATCH …/appointments/[aid]` with the row's `version` and its current technicians lead first
  (`updateAppointment`, unchanged). Disabled when any row has `hasProgress`, with the HAS_PROGRESS line
  below. One copy map: `VISIT_ERROR_COPY` (:351-363) is updated, not duplicated (§8).

### 7.8 When the board isn't interactive
`boardInteractive(width, finePointer)`: interactive at ≥ 1024 px with `(pointer: fine)`; a lazy
`matchMedia` init (the board is `ssr: false`, `calendar/page.tsx:28-43`). Otherwise no sensors; chips,
blocks, `Move…` and the lane menu stay; notice "Dragging needs a computer. Use Move… on a request, or open
it." Today's touch drag goes.

### 7.9 Week view
Columns under the unassigned scope (no technician change); the prompt applies; one card per request.

## 8. Copy

| where | copy |
| --- | --- |
| Confirm · started, lead change | line 1: "<Alex Rivera> is en route to this visit." / "…has arrived." / "…is in progress on this visit." / "…is paused on this visit." / "…is done with this visit."; no timestamp: "This visit is marked in progress." Line 2: "<Alex> comes off the visit. <Sam> becomes the lead and takes over close-out, the invoice and estimates." + "The request goes back to scheduled." when it does + "Alex's time on it stops." when `openTimeEntry`. Line 3: "Technicians aren't told about this move. Call them." |
| Confirm · started, time change | "<Alex Rivera> is in progress on this visit. It moves to 12 PM–4 PM" + " on Wed, Nov 11" when the day changes + "." per started technician, then line 3. Lead and window both change: the lead-change lines, then "It moves to <range> on <day>.", then line 3 |
| Confirm · conflict | "Overlapping requests:" + rows (`conflict-dialog.tsx:88-106`), first names when more than one technician; the out-of-hours line unchanged |
| Time off | "<Sam> is off 4 PM–8 PM on Tue, Nov 10." · over more than one day "<Sam> is off Mon, Nov 9 – Fri, Nov 13." · `non_job` or a capacity-removing `on_call`: "<Sam> has a non-job event 4 PM–8 PM on Tue, Nov 10." · a helper adds "Or remove <Sam> in the request." |
| FieldPulse (three variants) | board, Unscheduled, mass row: "Change this request in FieldPulse." · sheet technician: "Change the technician for this request in FieldPulse." · sheet crew: "Change the technicians for this request in FieldPulse." · any other sheet refusal on a FieldPulse request: "A technician has started this visit. Change it in FieldPulse." |
| Banners | STALE "This request changed. The calendar has been refreshed." · VISIT_ENDED "This visit has ended. Add a new visit instead." · VISIT_PINNED "Visit #<n>. Change its time in the request." · REQUEST_TERMINAL "This request is completed, so it can't be moved." / "…cancelled…" · TECHNICIAN_NOT_FOUND "That technician isn't active any more." · TECHNICIAN_DONE "<Sam> has finished on this visit." · WINDOW_ENDED `WINDOW_ENDED_MESSAGE` · other "Couldn't move the request. Please try again." |
| Unscheduled | started "A technician has started this visit, so it can't go back to Unscheduled." · WORK_LOGGED "Work was logged on this visit, so it can't go back to Unscheduled." · STALE: the banners' STALE line |
| Sheet reassign | native HAS_PROGRESS "A technician has started this visit. To move it anyway, use Move… on the calendar." · TECHNICIAN_DONE "<name> has finished on this visit." |
| Sheet crew | ALREADY_ASSIGNED "<name> is already on this visit." · HAS_PROGRESS "<name> has started, so they stay on this visit." · TIME_OFF "<name> is off during this visit." · VISIT_ENDED "This visit has ended." · NO_LEAD "Assign a technician to this request first." · VISIT_FULL "This visit already has 5 technicians." · other "Couldn't change the technicians. Please try again." |
| Change time (`VISIT_ERROR_COPY`) | HAS_PROGRESS "Work has started on this visit, so its time can't change. Cancel it and add a new visit instead." · VERSION_CONFLICT "This visit changed. It has been refreshed." · TIME_OFF "<name> is off during this time." · TECHNICIAN_NOT_FOUND "A technician on this visit isn't active any more. Cancel it and add a new visit instead." · VISIT_ENDED, VISIT_CANCELLED, WINDOW_ENDED (existing) · generic "Couldn't save the visit. Please try again." |
| Mass reasons | started "Started" · ended "Visit ended" · later_visit "Visit #<n>. Change it in the request." · time_off "Time off then" · window_ended "That time has passed" · already_on_visit "<Sam> is already on it" · fieldpulse "Change it in FieldPulse" · helper "Helping <lead first name>. Change it in the request." · stale "Changed since you opened this" · conflict "Overlaps another request" · pushesNotSent "Not sent to Housecall Pro. Open it to retry." |

Dates in `BUSINESS_TIME_ZONE` (`calendar-time.ts:27`).

## 9. Tests

No jsdom/RTL. Capture the vitest baseline first.

**Task 0, drag spike (before feature code).** A throwaway script against a throwaway org with at least
5 active technicians, at 1440 × 900, sidebar expanded, with §7.2's layout (axis out, lanes in their own
scroller), `pointerWithin` and the §7.2 `autoScroll` settings applied locally. It proves: (a) lane 1 →
lane 5: pointer down, move to within 20 px of the lanes scroller's right edge, hold until the target band's
`boundingBox()` is in the viewport (poll with a timeout), move onto its centre, release → assignee and
window changed; (b) Unscheduled → an off-screen lane the same way; (c) a drop 4 px inside a band edge lands
on that band; (d) a drop on the right half of the second technician lane lands there with `scrollLeft`
unchanged; (e) an Unscheduled → Unassigned drag, which crosses the right-edge zone, lands with
`scrollLeft` back at 0. Steps: `mouse.move` in `steps: 12`, past `PointerSensor`'s 6 px (:507-509). If (d)
or (e) fail, the threshold and acceleration are retuned there; any other failure redesigns the walk or the
drag model before feature code.

**Pure:** `rowStarted`; `currentWindowKind`; `covers`; `promptPlan` (Unscheduled; covered lane change;
anytime, 11–1, 7–9; crossing defaults; same day and lead without Keep); `resolveMoveWindow` (match, pick,
keep across days and the 2027-03-14 DST start, end past midnight, keep without a window); `timeOffHits`
(capacity-removing only); `moveNeeds` (checked technicians; old lead excluded); `optimisticCrew`;
`laneCards`; `chipLayout`; `applyMoveResult`; `moveLanded`; `moveBanner`; `moveDialogDefaults` and
`moveDialogBody` (unassigned, Unscheduled, no window, ended bands, no change); optimistic Unscheduled drag
with two cards; mass classification and default day; `boardInteractive`; §8 copy builders.

**SQL renders (`PgDialect`):** L_req first; `organization_id` everywhere; the version gate with the id
(null → no #1) in the move and unschedule; the CASE incl. `on_hold` and the hold fields; steps 2–4 only on
a lead change, gated; `reviveLeadSql` (nulls timestamps on a cancelled revive) in the move, sheet writers
and `placeAndAssignRequest`; the entries filter; the audit xmin gate; the final version read;
`visitOneStartedGuardSql` in the five callers, `visitOneGuardSql` unchanged in `scheduleRequest`,
`visitProgressed` unchanged; `fieldpulse_job_id IS NULL` in every M2 writer; `addVisitTechnician` lock,
revive, lead and cap clauses and version bump; `removeVisitTechnician` cancel branch and version bump; the lead-not-done predicate in the move, `assignTechnician`
and `reassignTechnician`; the work-logged guard in `unscheduleRequest`; the
mass `NOT EXISTS` predicate and the SQL-computed audit details.

**Route tests:** every code and its order; 400s (non-UUID, `keep` without a window); TIME_OFF has no
`needs`; details carry no names; mass key rules, a 31st visit refused, a forged `preSkipped` reason or a
foreign visit id refused; `/reschedule` → 404; tech cookie → 401; no M2 route imports a FieldPulse
client or push function.

_Plan note (2026-11-08): the suite is built as `tests/integration/field-dispatch.test.ts` (owner's instruction); the cases below are unchanged._
**Integration (`tests/integration/dispatch-board.test.ts`, `VITEST_INTEGRATION=1`, dev DB, throwaway orgs
by SQL via `createOrgCore`, never the default org; pushes mocked):**
(a) window: 9–11 on Alex → Sam's morning → 9–11; afternoon match → 12–4; pick; keep to another day; match
into an ended band → WINDOW_ENDED;
(b) done-when: Alex (lead) taps arrived (request `arrived`) and starts a form draft → move to Sam → 409 HAS_PROGRESS → confirm →
request `scheduled`, Sam lead `scheduled`, Alex `cancelled` with his timestamps, Alex's open entry closed,
one audit row, one event `arrived → scheduled`; Alex still reads the job;
Sam's save of Alex's draft before arriving → refused by M3d's gate; Sam taps arrived → edits it;
(b2) drag back to Alex → no confirm; Alex lead `scheduled` with null timestamps (revived), Sam deleted
(untouched);
(b3) pause: request `on_hold` → override → `scheduled`, hold fields cleared;
(b4) Alex en route, then Alex's time off from now → move to Sam with confirm → 200;
(c) done lead: Alex `completed` → time move → confirm; lead change → Alex `cancelled`; a done helper as the
new lead → TECHNICIAN_DONE; the same through the sheet's assign and reassign → TECHNICIAN_DONE; a helper who
taps done between the move's pre-read and batch (statement injected between them) → TECHNICIAN_DONE on the
re-read, Sam not lead;
(d) helper working, lead untouched → board lead swap without confirm; sheet reassign → HAS_PROGRESS; time
move → 409;
(e) office PATCH `in_progress` → board 409; sheet reassign 409 with the Move… copy; sheet reassign A → B →
A where A had timestamps → A lead, open status, null timestamps; the sheet's schedule edit on the same
request behaves as today (timestamp rule);
(f) FieldPulse (`fieldpulse_job_id` by SQL): time, day and lane moves, Unscheduled, sheet reassign →
MANAGED_EXTERNALLY with nothing written; a FieldPulse `in_progress` row with no timestamp → sheet refusals
name FieldPulse; mass → `fieldpulse`; GET `movable: 'no'`; a native request in a FieldPulse-connected
throwaway org (dummy key, client mocked) → move → 200 and no FieldPulse call; HCP: lane and time → 200,
`pushJobToHcp`;
(g) two moves from one version on two connections → one STALE; a lead `en_route` tap from `scheduled`
between render and drop → STALE; a helper's tap → HAS_PROGRESS; a helper add between render and drop →
STALE; (g') Unscheduled then re-place → an old card → STALE; a stale Unscheduled drop → STALE;
(h) done-when: Sam added through `POST …/assignments` → both lanes, two chips; remove → gone; add after a
cancel → revived with null timestamps; a 6th, also concurrently → one VISIT_FULL; add on an unassigned
visit → NO_LEAD; drop the lead card on Sam's lane → Sam lead, Alex removed; a time move with helper time off
→ TIME_OFF naming Sam; (h2) helper Sam off, lead swap with the window unchanged → 200;
(i') `Change time` on a #2 visit → the board GET shows it moved; a #2 with a timestamped row → HAS_PROGRESS;
a displayed #2 card → `movable: 'no'`, the move route → VISIT_PINNED `{ visitNumber: 2 }`;
(j) `pending` with Alex dropped on Alex → `assigned`, event; (j') `scheduled` with no lead → one `assigned`
event; (j'') a placed unassigned request → GET `visitId` = #1's id → drop on Alex → 200;
(l) blocks: three kinds in the day GET;
(m) mass: 2 movable, 1 started, 1 FieldPulse, 1 helper, 1 later visit → reasons; commit → 2 moved,
wall-clock kept, one audit row whose moved and skipped come from SQL; a visit made stale inside the batch →
recorded `stale`; same key → same result; delete the key row and re-send → same result, nothing
re-written, calendar sync and HCP update re-sent, no HCP create, a request needing one in `pushesNotSent`;
(n) visit #1 with a form submission to Unscheduled → the visit survives; (n2) Alex arrives (time entry on
#1) → Move anyway to Sam → drag back to Alex (revived, null timestamps) → drop on Unscheduled →
409 WORK_LOGGED; visit #1, Alex's row and his time entries (with `appointment_id`) intact; (n3) a stale
Unscheduled drop → STALE, refetch, banner;
(o) tenancy: other org ids → 404 / TECHNICIAN_NOT_FOUND;
(p) audit rows carry ids, enums, booleans and counts only.

**Browser walk** (1440 × 900; `scripts/agent/m2-walk.mts` modelled on `m3d-walk.mts`; throwaway org by
SQL; `MINT_ORG_ID`, org asserted; queue guard before, zero `communication_jobs` after): Alex and Sam with
hours; a 9–11 request on Alex; Alex en route on a morning (8 AM–12 PM) request; an afternoon request on
Alex; Sam off 4 PM–8 PM; a FieldPulse card set by SQL. Add Sam as helper through the sheet → both lanes,
chips → 9–11 to Alex's afternoon → prompt, default "Use the afternoon window" (same day and lead) → Cancel →
again → Move → 12 PM–4 PM → en-route card to Sam → "Move anyway?" → Cancel → again → Move anyway → banner →
drag it back to Alex → back, no confirm → the afternoon request on Sam's evening → Use the new window →
Move → time-off dialog, nothing moved → the FieldPulse card: pill and lock, no grab cursor, no `Move…` →
`Move…` on a card from the keyboard → dialog → move → focus returns to the card → Week view, next day same
band → no prompt → `Move this day…` with a skipped row → move → at 1023 px and at 390 px with
`hasTouch`/`isMobile`: notice, `Move…` visible, tap it, move. Screenshots at each step; look at them.
`python3 .claude/skills/replica-design/contrast.py` on the chip, pill and hatch tokens.

Design deviations from `replica/design/components.md`: started cards stay draggable (:81 says no grab
cursor); the prompt's button is "Move", Keep listed first (:98–104 say "Move job").

## 10. Out of scope

- Undo of a move (drag it back instead); mass undo.
- Capacity: the window-load strip, holds-aware office moves, the placed + reserved race, capacity
  adjustments (row 82); `reserveCapacitySlot` unchanged. Zones (100).
- Any board write to FieldPulse; helpers on FieldPulse or HCP requests (M3a refuses both).
- Dragging visits #2+ (the sheet changes their time); keyboard drag (`Move…` instead).
- Named teams, skills (99), tray tabs (93), late outlines (101), route view (103), custom window picker
  (79).
- Telling the customer or a technician about a move; adding helpers by drag; resizing cards.
- `/admin/dispatch`, month, agenda; blocks in Week view; editing shifts on the board.
- `deltaMinutes`; more than 30 visits per mass run.

**Follow-up (needs the owner).** FieldPulse time moves from the board: a `pushScheduleToFieldpulse(org,
rid)` wrapper calling `updateJob(id, { scheduleStart, scheduleEnd })`, which serialises only the two
schedule keys (`JSON.stringify` drops undefined ones, `fieldpulse/client.ts:984-999`). `updateJob` is a
PUT, and whether FieldPulse clears omitted fields is unknown. The owner verifies on a test job in their own
FieldPulse that a schedule-only PUT keeps the description and assignee; then the push is built and
FieldPulse time moves are enabled. Not done autonomously: the dev default org's key reaches the owner's
live account, and a PUT there can't be undone by us.

## 11. Rulings and things not verified

Rulings (lead rulings L1–L11, L2-1…L2-10, L3.1-1, L3-1…L3-7 in the log):
1. Window = `arrival_window_*`; prompt only when the pointer's band isn't covered; defaults §5.2.
2. Synced: HCP moves and is pushed; FieldPulse-mapped requests are read-only on the board and their
   technician is refused in the sheet; M2 makes no FieldPulse call. Unmapped native requests in a
   FieldPulse org move as today.
3. Started = live lead row working or done, or live helper row working; used by the board, Unscheduled and
   the sheet's assign/reassign. The sheet's schedule edit and `updateAppointment` keep today's rule.
4. Move anyway: the old lead's row is `cancelled` (timestamps and entries kept, time stopped); the new lead
   starts unstarted; the request resets to `scheduled` (incl. `on_hold`) when nobody else works. Reverse
   by dragging back; no Undo.
5. A cancelled row is revived clean (timestamps nulled) whenever its technician becomes lead (board, sheet,
   autopilot) or helper; a `completed` row never becomes lead; a visit with job time entries never goes back
   to Unscheduled.
6. Time off is never overridable; only the technicians a move assigns are checked.
7. Visit #1 only, while displayed and live; visits #2+ pinned and changed in the sheet.
8. `visitId` falls back to #1; version gate on id + version (also on Unscheduled drops and after helper
   changes); single move unkeyed; mass keyed with an SQL-computed audit row for recovery, which re-sends
   only update-style pushes.
9. Keyboard and touch: an always-visible `Move…`; no keyboard drag. No migration. Row 98's team grouping =
   the visit's crew.

Existing gaps M2 doesn't touch:
- Capacity over-commit (`capacity-hold.ts:71-79`; capacity milestone).
- The sheet's schedule edit calls `pushJobToFieldpulse` (`requests/[id]/route.ts:382-386`), which creates
  FieldPulse jobs for native requests and overwrites the FieldPulse description.
- In an HCP-connected org the first move of a native request creates its HCP job, after which helpers are
  refused.
- Autopilot: after a dispatcher moves a fresh, still unassigned request within the Unassigned lane, an
  autopilot run already scoring can re-place it at its held slot (`requireUnassigned` checks the assignee
  only; docs/DISPATCH.md:56-62).
- `idempotency_keys` isn't pruned.

Verified: column names; dev counts (§1); `/reschedule` callers; `updateJob` drops undefined keys; layout
arithmetic; `formatBusinessTimeRange`'s format; dnd-kit's default auto-scroll threshold 0.2 and
acceleration 10.

Not verified: task 0 (drag spike and the auto-scroll values); FieldPulse PUT semantics (follow-up); the
day GET's latency with the crew query (measure before and after).

## 12. Review focus

- §3.2's two guards and their callers; `scheduleRequest` and `updateAppointment` untouched.
- The move batch under the trigger's step 3; `reviveLeadSql` everywhere a lead changes.
- FieldPulse: a SQL refusal on every board and sheet technician path; no FieldPulse import in M2 code.
- Mass: SQL-computed audit, recovery pushes, `after()` registered last.
- `Move…`: defaults, tab order, focus; the drag wrapper out of the tab order.

## 13. Docs

`page-calendar` (drop flow, prompt, confirm, `Move…`, focus, crew, blocks, FieldPulse read-only, auto-scroll
values, interactivity rule, `/reschedule` removed, `@dnd-kit/sortable` removed, queries.test indices),
`page-requests` (started rule and where it applies, sheet copy, crew control, Change time, FieldPulse
refusals, revive), `page-dispatch` (helpers show only in their lead's column), `admin-pages` (started
rule), `docs/DISPATCH.md` §5 (move route, `/reschedule` removed, the autopilot invariant and residual),
`replica/features.csv` rows 96/97/98/102, `replica/parity.md`, `replica/build-log.md`,
`replica/architecture.md` annotation (move route under the request, no `deltaMinutes`,
`REASSIGNABLE_STATUSES` unchanged and in `request-status.ts`, synced rules, capacity deferred), memory.
