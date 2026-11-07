# Replica M2: Dispatch, as deltas to /admin/calendar

Status: v3.1 (2026-11-08) after adversarial review rounds 1–2 (5 critic reports) and lead ruling L3.1-1
(log in
`docs/superpowers/specs/2026-11-08-replica-m2-review-log.md`). Owner: Raymond Chen.
Milestone source: `replica/architecture.md` build order item 5 (lines 625–633), the F03 route table
(lines 134–145), the reassign-guard constraint (lines 93–95), the races paragraph (lines 344–351) and the
F04 ownership and status rules (lines 146–175). Builds on M0a, M3a, M3b and M3d (a visit with a form
submission is never deleted). Trigger citations are to `drizzle/0050_m3a_run_the_day.sql`; the live body
is 0058's, identical except the `v_has_progress` predicate (`0058_m3d_forms.sql:112-117`). Integration
paths are under `src/lib/integrations/`.

## 1. Goal

The office runs the day on the existing day view. Dragging a request into a window its current window
doesn't cover asks which window to use. Moving a visit a technician has started is refused with a 409
until the dispatcher confirms "Move anyway"; the override is audited and Undo restores the previous crew.
A visit worked by two technicians shows in both lanes with crew chips; the sheet's Visits section adds
and removes helpers and changes a later visit's time. Time off, non-job events and on-call shifts show as
blocks in the lane. Each card has a keyboard-reachable `Move…` action. A dispatcher can move a
technician's day after a preview. No second board: `/admin/dispatch`, month and agenda are untouched.

FieldPulse-mapped requests (`fieldpulse_job_id` set) are read-only on the board in M2: time, window, day
and technician are all changed in FieldPulse, and the card says so. Pushing a board move to FieldPulse
would write to the owner's live FieldPulse account, which is a follow-up the owner verifies first (§10).
Native requests (including unmapped ones in a FieldPulse org) and Housecall Pro requests move on the
board.

Done when (architecture.md): dragging across a window boundary prompts for the window; a working job
refuses reassignment with a 409 unless overridden; a two-tech job shows on both lanes. All three are
proved on native requests; FieldPulse-mapped requests refuse every board move.

Feature rows (`replica/features.csv`, row = file line):
- **96** (must) → `yes`, "a drop into a window the current one doesn't cover asks which window; a drop
  into a covered band keeps it; FieldPulse-mapped requests are moved in FieldPulse".
- **97** (must) → `yes`, "a started visit refuses a move with 409 HAS_PROGRESS; Move anyway hands it over,
  is audited and can be undone".
- **98** (must) → `yes`, "lead + helpers per visit, added in the request sheet; the visit shows in every
  crew member's lane with crew chips; no named teams (a visit's crew is its team)".
- **102** (could) → `yes`, "move a technician's day to another day and/or technician after a preview;
  FieldPulse-mapped requests are skipped".
- Unchanged: **82** (`no`, capacity milestone, §10), **100** (`partial`), **79**, **93**, **101**, **103**.

Dev facts (dev branch, 2026-11-08, read-only):
- Open placed requests: 32 native, 83 FieldPulse; the default org is the only FieldPulse-connected org,
  and 29 of its native open placed requests have no `fieldpulse_job_id`. 16 FieldPulse rows are bookings
  the app pushed. 0 rows carry `hcp_job_id`.
- 15 open placed requests are unassigned; all 15 have a visit #1 with no assignment row.
- Windows not an exact named band: 3 of 32 native open placed, 82 of 83 FieldPulse.
- Helper rows 0 (no UI creates them today). Visits #2+: 2, both cancelled. `technician_shifts`: 0.
- Rows `in_progress` with no timestamp: 16 (15 FieldPulse, 1 native office status mirror).
- Native `pending` requests with an assignee: 5. FieldPulse `pending` with an assignee: 47.
- Visits at `version` 0: 284 of 298. Job time entries with no `appointment_id`: 1 of 6.

## 2. Surfaces

| surface | who | what |
| --- | --- | --- |
| Calendar Day view (`interactive-scheduling-calendar.tsx` `DayView` / `DayLane`, :165–332) | admin, interactive (§7.8) | crew chips and helper copies, blocks, drop flow, dialogs, banner, `Move…`, lane menu `Move this day…` |
| Calendar Week view (`WeekView`, :346–415) | same | prompt on drops; one card per request |
| Unscheduled tray (`draggable-unscheduled-panel.tsx`) | admin | drags use the move route |
| Calendar, not interactive | admin | read-only; `Move…` still offered (§7.8) |
| Request sheet, Visits section (`request-detail-sheet.tsx:578-615`) | admin | `Technicians` control (§7.7), `Change time` on a later visit (§7.7), reassign/schedule copy (§5.6) |
| `/admin/dispatch`, month, agenda, tech app | — | unchanged |

## 3. Data model

**No migration.** `drizzle/0059` stays free.

### 3.1 Arrival windows
`arrival_window_start` / `arrival_window_end` on `service_requests` (`schema.ts:570-571`) and
`appointments` (`:707-708`); no `window_start` / `window_end` exists. `starts_at` / `ends_at` (`:705-706`)
are written equal to the window by every writer (0050:102–105; `appointment-queries.ts:163-166`, :257;
dev: 0 differ) and M2 keeps them equal. Visit #1 is written through the request columns and mirrored by
the trigger, which fires only on a real change of the date, either window end, `assigned_to` or `status`
(0049:221–229). Named windows `ARRIVAL_WINDOWS` (`arrival-window.ts:12-27`); drop bands
`RESCHEDULE_WINDOW_ROWS` (`calendar-time.ts:329-333`).

### 3.2 Started
`src/lib/admin/visit-started.ts` (pure `rowStarted`, SQL twin `startedRowSql(alias)`);
`STARTED_ASSIGNMENT_STATUSES = ['en_route', 'arrived', 'in_progress', 'completed']` in `request-status.ts`.
Only live rows (`status <> 'cancelled'`) count:
- the lead row is started when `en_route`, `arrived`, `in_progress`, `completed`, or `on_hold` with a
  progress timestamp (a pause);
- a helper row is started when working (`en_route`, `arrived`, `in_progress`, or a pause); a done helper
  doesn't hold the visit;
- timestamps alone don't count (they only tell a pause from an untouched `on_hold`), so a revived row is
  not started.
A visit is started when any live row is. Status counts because the trigger mirrors request status onto
an untouched lead row (0050:147–159; dev: 16) and architecture.md:93–95 names the guard by status.
`visit-one-guard.ts` `progressed()` (:22) switches to this rule, so the sheet, the tray and the board
agree. `updateAppointment`'s `visitProgressed` (`appointment-queries.ts:199-201`) and `classifyMiss`
(:222-226) **keep** the timestamp rule: `updateAppointment` deletes only untouched rows and then
plain-inserts the list (`:272-275`, `insertAssignments` :94-98), so letting a timestamped row through
would hit `appointment_assignments_unique` and answer 500. `REASSIGNABLE_STATUSES`
(`request-status.ts:69`; architecture.md:95 places it in `queries.ts`) stays `IN_FLIGHT_STATUSES`.

### 3.3 Crew
A visit's crew = its live rows (`schema.ts:728-752`; one lead). The M3a helper writer
(`addVisitTechnician`, `assignment-queries.ts:61`) changes:
- revives a cancelled non-lead row instead of `ON CONFLICT DO NOTHING` (:90): `DO UPDATE SET status =
  'assigned', assigned_by = $actor, assigned_at = now() WHERE appointment_assignments.status = 'cancelled'
  AND NOT appointment_assignments.is_lead`;
- requires a live lead row on the visit (today any visit with no rows passes, :86; every unassigned
  placed #1 has none) → 409 `NO_LEAD`;
- enforces `MAX_TECHNICIANS_PER_VISIT = 5` (`appointment-types.ts:30`) in SQL: `(SELECT count(*) … live)
  < 5` → 409 `VISIT_FULL` (today only `addAppointment`'s zod caps it).
`removeVisitTechnician` (:125): untouched → DELETE (today); not started by §3.2 but timestamped →
`status = 'cancelled'` (the row stays for history); started → `HAS_PROGRESS` (today).

### 3.4 Blocks
`technician_shifts` (`schema.ts:754-772`; kinds `on_call`, `time_off`, `non_job`; `removes_capacity`
default per `shift-types.ts:20-22`). Read only; written on the Staff page's time-off dialog.

## 4. Concurrency

### 4.1 Revision gate
Cards carry `visitId` and `visitVersion`. `visitId` = the displayed visit (`displayVisitIdSql`,
`current-visit.ts:54-59`), **falling back to visit #1's id**: `activeVisitIdSql` (:33-40) returns only a
visit with a live row, and an unassigned #1 has none (dev: 15 of 15). `visitId: null` means no visit #1
exists. The gate compares id and version: `EXISTS (SELECT 1 FROM appointments p WHERE p.id = $visitId
AND p.organization_id = $org AND p.service_request_id = $rid AND p.appointment_number = 1 AND p.version =
$v)`, or `NOT EXISTS (… appointment_number = 1)` for null. The id matters because a new #1 starts at
version 0. The trigger bumps #1's version on every watched change (0050:119), so a lead's status tap,
another dispatcher's move or an autopilot placement between render and drop answers `STALE`; a helper's
tap bumps nothing and is caught by the started guard instead. The autopilot places only still-unassigned
requests (`requireUnassigned`, `scheduling-queries.ts:780-785`); its residual is in §11.

### 4.2 Idempotency
- **Single move: not keyed.** Absolute values under the version gate; a re-send after a lost response
  answers `STALE`, the client refetches and treats the move as landed, quietly, when the refetched card
  has the intended lead and window (pure `moveLanded`).
- **Mass reschedule: keyed** (`withIdempotency`, `idempotency.ts:215`; Idempotency-Key required,
  `parseIdempotencyKey` :47; 2xx stored; no new `STORED_CODES`). `runAsWinner` stores the done row after
  the work (`:186-200`), so a crash between commit and done row is recovered from the audit row: its id is
  `derivedId(scope, 'audit')` (org-scoped, `:82-87`), its details hold `movedVisitIds` and `skipped:
  [[visitId, reason]]`, every statement in the batch carries `NOT EXISTS (SELECT 1 FROM audit_log WHERE id
  = $auditId AND organization_id = $org)`, and `run` first reads that row (with `organization_id = $org`).
  When it exists, `run` rebuilds the 200 from it plus current versions, writes nothing, and re-sends the
  after-calls for the moved requests. Re-sending is safe: `syncRequestToCalendar` upserts, the HCP push
  updates a mapped job with the same window (an HCP create is guarded by `hcp_job_id IS NULL` and won't
  duplicate), and `stampDispatchOverride` is last-write-wins. Mass never calls FieldPulse.

### 4.3 Locks
L_req first in every batch (`lockRequestSql`, `invoice-field-writes.ts:42`); mass locks all its requests
`ORDER BY id FOR NO KEY UPDATE`. Request → rows everywhere.

## 5. Writers

### 5.1 Who, and synced requests
Admin session only (`verifyToken` rejects other roles, `auth/config.ts:45`); no `/api/tech` change. Every
body id is re-read under the session org inside the write.

| source | time / window / day | technician (lane, tray, sheet reassign, mass `T2`) | push after a visit #1 window change |
| --- | --- | --- | --- |
| native, no FSM id | yes | yes | `pushJobToHcp` as today (`reschedule/route.ts:184-189`); **no** FieldPulse call |
| Housecall Pro (`hcp_job_id`) | yes | yes | `pushJobToHcp` |
| FieldPulse (`fieldpulse_job_id`) | **no**: 409 `MANAGED_EXTERNALLY` | **no**: 409 `MANAGED_EXTERNALLY` | — |

- **Native.** Today's drag pushes to Google Calendar and HCP only; M2 matches it and never calls
  FieldPulse for a request without `fieldpulse_job_id`, so a board move never creates a FieldPulse job.
  In an HCP-connected org `pushJobToHcp` creates the HCP job on the first move (`housecall-pro/job-sync.ts:160-200`),
  as today; the request stays movable (HCP writes back status and invoice status only,
  `housecall-pro/webhook-sync.ts`), but the M3a crew writers then refuse it (`assignment-queries.ts:83`).
  Dormant on dev (0 HCP connections).
- **FieldPulse-mapped requests** are read-only on the board: every move, the tray and mass reschedule
  refuse them (409 `MANAGED_EXTERNALLY`, "Change this request in FieldPulse."), and the batch's UPDATE
  carries `fieldpulse_job_id IS NULL`. The nightly import owns their window and assignee
  (`import/jobs.ts:528-536`, `:429-460`), and a board push would be an irreversible write to the owner's
  live FieldPulse account, so M2 makes none. The schedule-only push is a follow-up (§10). The sheet's
  existing schedule edit and its `pushJobToFieldpulse` call are not changed by M2 (§11).
- **FieldPulse technician changes** are also refused in the sheet's `assignTechnician` / `reassignTechnician` (`queries.ts:506`, :662, which today
  write an assignee the nightly import overwrites from FieldPulse or null, `import/jobs.ts:429-460`).
- The status CASE (§5.3) is native only by construction (FieldPulse requests never reach the batch).

### 5.2 Window resolution (`src/lib/admin/move-window.ts`, pure, client and server)
- **Drop band** = the band under the pointer: `collisionDetection={pointerWithin}`; a drop not over any
  droppable does nothing.
- `currentWindowKind(start, end)` → `band` | `anytime` | `custom` | `none`.
- `covers(current, D, B)` = the current window, on day `D` with the same wall-clock times, overlaps band
  `B` (half-open).
- `promptPlan(current, D, B, leadChanges)`:
  - no window (tray) → no prompt, use band `B`;
  - `covers` → no prompt, keep. A lane change into a band the window covers never prompts. Same lane and
    day → nothing is sent, and the banner says "Still 11:00 AM – 1:00 PM. Open the request to change the
    time.";
  - otherwise prompt. Default **Use the new window** for a `band` window, **Keep** for `anytime` and
    `custom` when the day or lead changes. With the same day and lead, Keep would change nothing, so it is
    not offered and the default is Use the new window.
- `resolveMoveWindow(current, D, B, rule, pick | exact)`: `match` → band `B` on `D`
  (`arrivalWindowUtcForBusinessDate`, `calendar-time.ts:311`); `pick` → an `ARRIVAL_WINDOWS` value on `D`;
  `keep` → the same wall-clock start and end on `D` (`businessWallClockToUtc`, :129; an end past midnight
  stays on `D + 1`); `exact` → given instants (Undo only; end > start, span ≤ 24 h). `keep` with no window
  → 400 `VALIDATION_ERROR` `{ path: ['windowRule'] }`.
- The server recomputes from the window it read. A changed window whose end ≤ now → 400 `WINDOW_ENDED`
  (`window-ended.ts:9`, as `POST …/appointments`, its route.ts:93-94); a lead change keeping an ended
  window is allowed.

### 5.3 `moveVisit` (`src/lib/admin/visit-move.ts`)
Input `{ requestId, visitId | null, expectedVersion | null, day, band, windowRule, pick?, exact?,
technicianId?, confirm: ('started' | 'conflict')[], expectStartedIds?: uuid[], restore?: Previous }`.
`technicianId` = the new lead (absent or equal = keep); dropping on Unassigned never unassigns
(`interactive-scheduling-calendar.tsx:561-573`). Only **visit #1** moves, and only while it is the
displayed visit and not ended; otherwise 409 `VISIT_PINNED`.

**Pre-read** (one query): request (status, source, assignee), visit #1 (version, window, ended), its live
rows with `rowStarted` and timestamps, open time entries per technician. Refusals in order: 404;
`REQUEST_TERMINAL`; `VISIT_ENDED`; `VISIT_PINNED`; `STALE` (id or version); `MANAGED_EXTERNALLY`
(§5.1); `TECHNICIAN_NOT_FOUND` (`activeTechnicianIds`, `appointment-queries.ts:63`); `WINDOW_ENDED`;
`TIME_OFF`. **Who is checked for time off and conflicts** is the technicians the move assigns: the new
lead when the lead changes, and, when the window changes, every live crew member who stays on the visit.
A crew member whose time doesn't change is never re-checked, and the old lead leaves the visit (below), so
their time off never blocks a handover.

Confirm needs:
- `started`: the lead changes and the current lead's row is started; or the window changes and any live
  row is started. A lead swap with only a helper working and the window unchanged needs nothing. With
  `expectStartedIds` (Undo), `started` counts as confirmed only when the set of started rows equals it.
- `conflict`: a checked technician has an open row (`OPEN_ASSIGNMENT_STATUSES`, `ownership.ts:13-15`) on
  another live visit of an open request overlapping the window (half-open, as `checkScheduleConflict`,
  `scheduling-queries.ts:237`), or the window is outside the new lead's hours (a span variant of
  `isWindowWithinAvailability`, `availability-coverage.ts:88`, over `spanIsCovered`, :56).
Unconfirmed needs → 409 `HAS_PROGRESS` when `started` is among them, else `SCHEDULE_CONFLICT`; `details:
{ needs, started?: [{ technicianId, status, hasTimestamp, openTimeEntry }], conflicts?: [{ id,
referenceNumber, technicianId, arrivalWindowStart, arrivalWindowEnd }], outsideAvailability? }`. `TIME_OFF`
details: `{ timeOff: [{ technicianId, startsAt, endsAt, kind }] }`, no `needs` (never overridable,
admin-pages skill; that is why it isn't a "Schedule anyway?" confirm).

**Batch** (every predicate carries `organization_id = $org`; `<gate>` = `EXISTS (SELECT 1 FROM
service_requests r WHERE r.id = $rid AND r.organization_id = $org AND r.xmin = pg_current_xact_id()::xid)`):
0. L_req.
1. (`restore` only, when the current lead was a helper in `previous`) `UPDATE appointment_assignments
   SET is_lead = false WHERE … appointment_id = <#1> AND technician_id = <current lead>`, so the trigger's
   step 3 (which only touches `is_lead` rows, 0050:125–133) leaves that row alone.
2. `UPDATE service_requests SET assigned_to = $lead, scheduled_date = $start, arrival_window_start =
   $start, arrival_window_end = $end, status = <CASE>, hold_reason = <…>, follow_up_date = <…>, updated_at
   = now() WHERE id = $rid AND organization_id = $org AND status NOT IN ('completed','cancelled') AND
   <version gate> AND NOT <#1 ended> AND fieldpulse_job_id IS NULL AND <no time off, checked technicians> AND (<'started' confirmed> OR NOT <started arm>) AND
   (<'conflict' confirmed> OR <no conflict>) RETURNING id, status`. Every guard is the SQL twin of a
   pre-read check. `<CASE>`, native only: `pending` with a lead → `assigned` (as
   `create-request-queries.ts:375-387`); a lead change past a started lead while `status IN
   ('en_route','arrived','in_progress','on_hold')` and no other live row is started → `scheduled`, clearing
   `hold_reason` and `follow_up_date` (as `appointment-queries.ts:121-122`); `restore` → `previous.requestStatus`;
   otherwise unchanged. `en_route` and `on_hold → scheduled` are listed edges (`request-status.ts:33`,
   :38); the rest are override-only, recorded as such (After).
3. The old lead on a lead change. The trigger deletes an untouched row, demotes a progressed one to
   `cancelled` and keeps a `completed` one (0050:125–133). M2 also cancels the kept `completed` row:
   `UPDATE appointment_assignments SET status = 'cancelled' WHERE … technician_id = $oldLead AND NOT
   is_lead AND status = 'completed' AND <gate>` (not under `restore`). Timestamps stay. **The old lead
   leaves the crew; this supersedes the round-1 ruling that kept them as a helper.**
4. The new lead's row (trigger insert, or a revived row, which the trigger keeps `cancelled`,
   0050:134–145): `UPDATE appointment_assignments a SET status = CASE WHEN r.status IN
   ('en_route','arrived','in_progress','on_hold') THEN 'assigned' ELSE r.status END FROM service_requests r
   WHERE r.id = $rid AND … a.technician_id = $lead AND a.is_lead AND (a.status = 'cancelled' OR (a.status
   IN ('en_route','arrived','in_progress','on_hold') AND <no timestamp>)) AND <gate>` — the shared
   `reviveLeadSql(org, rid, gate)`.
5. `restore` only: each technician in `previous.crew` gets back `is_lead` and `status` (§5.4).
6. The old lead's open time stops (on a lead change, not under `restore`): `closeJobEntriesSql({
   organizationId, requestId: $rid, technicianIds: [$oldLead], gate })` (`time-entry-sql.ts:34`) with the
   visit filter `(t.appointment_id = <#1> OR t.appointment_id IS NULL)`.
7. Audit, gated on `#1.xmin = pg_current_xact_id()::xid` (the M3c gate, `equipment-writes.ts:89`).
8. `SELECT version FROM appointments WHERE … appointment_number = 1` (after the trigger), for the 200.

**Zero rows** → re-read in the pre-read's order; nothing failing → `STALE`. A deadlock (`isDeadlock`,
`status-writes.ts:53`) → `STALE`.

**After the batch** (best-effort, as `scheduling-queries.ts:843-868`): `recordStatusEvent(old →
'assigned', human)` on every first assignment, whatever the status column did; `old → scheduled` (human)
on an override reset; `stampDispatchOverride(org, rid, lead, user)` when a lead is set; `after()`
`syncRequestToCalendar` and `pushJobToHcp` on a window or lead change (today's calls). No FieldPulse call.
No customer or technician message.

Success → 200 `{ visitId, visitVersion, requestStatus, arrivalWindowStart, arrivalWindowEnd, leadId,
startedIds, previous: Previous, confirmed }`, `Previous = { arrivalWindowStart, arrivalWindowEnd,
requestStatus, crew: [{ technicianId, isLead, status }] }`.

**What an override hands over.** The old lead's row is `cancelled` with its timestamps; their time entries
are kept and their open time stops. They still read the job (`techCanReadSql`, `ownership.ts:169-171`,
admits cancelled rows with progress) but can't write forms on that visit (the gate needs a live row,
`src/lib/forms/form-gates.ts:16`). Their M3d draft stays on the visit (submissions belong to the visit,
not the row) and the new crew can edit it. Lead-only work (status taps, close-out, field invoice,
estimates, payments) passes to the new lead; drafts stay on the request (`BILL_STATUSES`,
`field-sale-statuses.ts:7`). Undo revives them.

**Audit** `visit_moved`, entity `appointment`, entityId #1: `{ requestId, fromTechnicianId,
toTechnicianId, windowRule, window: 'morning' | 'afternoon' | 'evening' | 'anytime' | 'custom', dayChanged,
confirmed, startedStatuses, conflictCount, outsideAvailability, undo }`. No instants.

### 5.4 Undo
After "Move anyway" the banner offers Undo when `previous.crew` has a lead and the previous window hasn't
ended. Undo = `POST …/move` with `restore: previous`, `windowRule: 'exact'` (the previous window), the
previous lead, the new `visitVersion`, `confirm: response.confirmed`, `expectStartedIds:
response.startedIds`. It restores the exact previous crew: the same lead and helpers with their previous
statuses (step 1 keeps a helper-turned-lead from being deleted; step 4 revives the old lead; step 5 writes
each previous row's `is_lead` and `status`), and the request status. A technician added by the move and
not in `previous.crew` is removed by the trigger as an untouched old lead. Not restored: the closed time
entry (the old lead's time between the move and Undo isn't counted). Anything that changed since (a new
start, another move) asks again or answers `STALE`. An ended previous window → "Can't undo. The original
time has passed."

### 5.5 Drag-to-tray (`unscheduleRequest`, `scheduling-queries.ts:916`)
Unchanged except: FieldPulse refused (it clears the assignee); the started check is §3.2's via
`visitOneGuardSql`. HCP pushed as today (`unschedule/route.ts:72-73`). A visit with a form submission
keeps its row (0058); M2 deletes no visit.

### 5.6 The sheet
- `assignTechnician`, `reassignTechnician`, `scheduleRequest` gain §3.2 through the shared guard (no
  override there), refuse FieldPulse technician changes, and append `reviveLeadSql` to their
  `lockedUpdate` batch (`visit-one-guard.ts:32-36`) gated on the request xmin, so a sheet reassign A → B →
  A never leaves a `cancelled` lead (the trigger keeps a cancelled row cancelled). `placeAndAssignRequest`
  (autopilot, office booking) appends it too.
- `visitOneRefusalResponse` (`visit-one-guard.ts:59-62`) takes a context: sheet "A technician has started
  this visit. To move it anyway, drag it on the calendar on a computer."; FieldPulse "Change the technician
  for this request in FieldPulse."; the tray its own line (§8).

### 5.7 Mass reschedule (`src/lib/admin/mass-reschedule.ts`)
Every displayed visit #1 on business day `D` whose lead is `T` moves to day `D2` and/or lead `T2`,
keeping wall-clock times. No `deltaMinutes` (architecture.md:144). No undo (move them back).
- **Preview** lists every visit `T` is on that day: `moves`, or skipped `started`, `ended`,
  `later_visit` (a visit #2+), `time_off` (checked: `T2`, plus the crew when the day changes),
  `window_ended`, `already_on_visit` (`T2` has any row, cancelled included), `fieldpulse` (any FieldPulse-mapped request),
  `helper`; plus the soft flag `conflict`.
- **Commit** `{ technicianId, fromDate, toDate, toTechnicianId?, visits: [{ visitId, expectedVersion }]
  (1–30), confirmConflict }`, keyed. One batch: L_req over all, then per visit the §5.3 statements with
  their own version gate, lead gate `= T` and `starts on D`; `started` never confirmed in bulk;
  `confirmConflict` confirms `conflict` for all, else those skip. Any statement error rolls back all and
  answers 500. Then the audit row (§4.2).
- After: per moved request the §5.3 after-calls, and `stampDispatchOverride(org, rid, T2, user)` when `T2`
  is set.
- Result `{ moved: [{ visitId, requestId, visitVersion }], skipped: [{ visitId, reason }] }`, reasons
  incl. `stale` and `conflict`.
- Audit `dispatch_mass_rescheduled`, entity `user`, entityId `T`: `{ toTechnicianId, dayShift,
  movedVisitIds, skipped: [[visitId, reason]], confirmConflict }`.

## 6. Routes (`force-dynamic`, admin session, logs carry codes and ids only)

| route | gate | success |
| --- | --- | --- |
| `GET /api/admin/calendar` (exists) | `adminRead` | §7.1 fields; day view adds `blocks` |
| `POST /api/admin/requests/[id]/move` (new) | `isUuid`, `admin:visit-move:<user>` `adminMutation`, `readJsonBody`, zod | §5.3 |
| `POST /api/admin/requests/[id]/unschedule` (exists) | + FieldPulse refusal | unchanged |
| `POST /api/admin/requests/[id]/assign`, `PATCH …` (exist) | + FieldPulse refusal, revive | unchanged |
| `POST /api/admin/dispatch/mass-reschedule/preview` (new) | `adminRead`; `isRealIsoDate`, today − 1 … today + 365; `isUuid` | `{ candidates }` |
| `POST /api/admin/dispatch/mass-reschedule` (new) | `adminMutation`, zod, Idempotency-Key | §5.7 |
| `POST/DELETE …/appointments/[aid]/assignments` (exist) | + `NO_LEAD`, `VISIT_FULL`, revive (§3.3) | unchanged |
| `PATCH …/appointments/[aid]` (exists) | unchanged | used by `Change time` |
| `POST /api/admin/requests/[id]/reschedule` | **removed** with `tests/api/admin/reschedule.test.ts` and its route test; only caller `use-reschedule-job.ts:99`, which keeps `unschedule` | — |

## 7. Client

Admin primitives, sentence case, "request" and "technician", no `err.message`. Logic in pure helpers.

### 7.1 Board data (`getSchedulingCalendar`, `queries.ts:1661`)
After `mergePlacedRows` (:1573), one query reads each placed and tray card's visit (§4.1's `visitId`
expression), its `version` and live rows joined to `users`, org-scoped. Cards gain `visitId`,
`visitVersion`, `crew: [{ technicianId, name, isLead, state: 'open' | 'working' | 'done' }]` (inactive
names withheld as `dashboardRequestSelect`, :1263-1267), `started`, `movable: 'yes' | 'no'`
(FieldPulse-mapped, a displayed #2+ or an ended visit → `no`), `laneRole`.
Day view adds `blocks` (`listShiftsInRange`, all kinds). `queries.test.ts`: new queries after the
existing five; the visit feed stays index 4.

### 7.2 Lanes, crew and cues
- Helper copies (`laneCards`, pure): each active helper's lane; not draggable; "Helping <lead first
  name>"; title "<customer> · <ref>. Helping <lead>. Drag the card in <lead>'s lane."; keys
  `${requestId}:${technicianId}`.
- Crew chips (`crew-chips.tsx`), own row under the customer, only with 2+ crew: initials, lead first with
  the `marker` border, working filled, done with a check, `+N` past 3, `aria-label` with name and state.
  `chipLayout(width, height)`: below 120 px wide, in Week view, or below 72 px high → a people icon and
  the count in the top row, `aria-label="2 technicians"`.
- FieldPulse: the `SyncPill` (`sync-pill.tsx:3`) at `md` ("FieldPulse") in Day view when the card is ≥ 160
  px wide, else `sm` ("FP"), with a lock beside it; the time never truncates before the pill. Pill title and
  `aria-label` addition: "Change this request in FieldPulse." The card isn't draggable (no grab cursor) and
  has no `Move…`; a tap opens the sheet.
- Started: a lock icon (title "Started. Moving it asks first."), and "started" in the `aria-label`.
- Visit #2+ (pinned, today's `:224`): tag "Visit #2" (today), title "Visit #2. Change its time in the
  request.", the same appended to the `aria-label`; no grab cursor.
- Lane counts include helper copies; ended skipped (`liveJobCount`, :127).
- Layout: `TimeAxis` moves out of the `overflow-x-auto` element; the lanes sit in their own `overflow-x-auto
  min-w-0 flex-1` scroller (dnd-kit auto-scrolls that scroller). Width at 1440: 1440 − sidebar 232
  (`sidebar.tsx:329`) − `PageShell p-6` 48 − tray 288 + gap 16 (`draggable-unscheduled-panel.tsx:125`) −
  board `p-3` and border 26 − axis 56 + gap 8 = 766 px of lanes at 224 + 8: **Unassigned plus two
  technician lanes are fully visible**, the third shows 70 px, the rest scroll.

### 7.3 Blocks
`lane-blocks.tsx`, behind the cards (`placeJobInLane`): `time_off` and a capacity-removing `non_job`
hatched with the title or "Time off" / "Non-job event"; a non-removing `non_job` outlined; `on_call` a 3 px
rail titled "On call"; each links to `/admin/staff`. Bands stay droppable. `describeDropTarget`
(`calendar-dnd.ts`) appends ", Sam is off" or ", ended" to the spoken target. Ended bands on today are
shaded.

### 7.4 Drop flow (`handleDragEnd`, `interactive-scheduling-calendar.tsx:534`)
`KeyboardSensor` with `sortableKeyboardCoordinates` (:513-515) is removed: it never moves (the active id
`job:<uuid>` has no droppable), and keyboard moves go through `Move…` (§7.5). `handleDragStart`
(:523-532) finds the card by `requestId` and `laneRole === 'lead'`. All client move state (overlay,
optimistic board, in-flight set, `applyMoveResult`, Undo) is keyed by `requestId`; `visitId` only rides
in the body.
1. Tray drop → §5.5. (FieldPulse cards can't be dragged at all.)
2. `promptPlan`; the prompt if needed.
3. `resolveMoveWindow`.
4. `timeOffHits(blocks, checkedTechnicians, window)` (pure) → the time-off dialog, nothing sent.
5. No-op → nothing (or the covered line, §5.2).
6. Optimistic move: `optimisticCrew(crew, newLeadId)` (new lead out of the helpers, old lead off the
   visit), `laneCards` re-derived; then `POST …/move`.
7. 200 → `applyMoveResult` (version, lead, window), refetch, `moveBanner`. 409 needs → roll back, confirm
   (§7.5). `TIME_OFF` → time-off dialog. `STALE` or network failure → refetch; `moveLanded` keeps it
   quietly, else the banner. Other codes → roll back, banner, refetch.
The in-flight set disables only that request's card and copies; `isRescheduling` leaves the lane and tray
props (:702, :715, :727).
**Focus.** After a drop, a refusal, or any dialog closing (Move, Cancel, OK, Escape), focus moves on the
next frame to the card for that `requestId` (`[data-request-id]` on its button); if that card isn't on the
board, to the lane header of the drop scope. Dialogs set `onCloseAutoFocus={e => e.preventDefault()}` and
call this helper.

### 7.5 Dialogs, banner, `Move…`
- **Window prompt** (`window-prompt-dialog.tsx`): title "Arrival window"; description "Moving <customer> ·
  <ref> to Sam's afternoon." (lane named when it changes); a `RadioGroup`: "Keep 9:00 AM – 11:00 AM" (+ "
  on Wed, Nov 11"), "Use the afternoon window · 12:00 PM – 4:00 PM", "Choose a window" revealing a
  `Select` (Morning, Afternoon, Evening, Anytime with hours; `selectLabel`; ended ones "Already ended");
  defaults §5.2; footnote "The customer isn't told about this change."; Enter = Move except while the
  Select is open; Escape = Cancel; buttons "Move" / "Cancel".
- **Confirm** (`ConflictDialog` generalised; its time-off branch, `conflict-dialog.tsx:71-93`, is deleted):
  title "Move anyway?"; §8 blocks; "Cancel" / "Move anyway" ("Moving…").
- **Time-off dialog**: "Can't move this request"; one line per technician (§8); "Pick another time or
  technician."; "OK".
- **`Move…`**: each draggable lead card (never a FieldPulse card) has a sibling icon button (`aria-label="Move <customer> · <ref>"`,
  in the tab order after the card, visible on hover and focus-within). It opens a dialog: Technician
  (`Select` of active technicians, current selected), Date (date input), Window (`RadioGroup`: Keep current, Morning, Afternoon, Evening,
  Anytime). "Move" sends the same route (`windowRule` `keep` or `pick`), then the same 409 flow, confirm and
  banner. It is offered also when the board isn't interactive.
- **Banner** (`moveBanner(response, crewBefore, crewAfter, confirmed)`, pure): "Moved." / "Sam is now the
  lead. Alex is off this visit." / errors. Rendered `fixed` bottom-right of the viewport (`CalendarStatus`,
  `calendar/page.tsx:47`, moves there and gains an action and a close ×); `role="status"`, errors
  `role="alert"`. Clears on the next drag start; Undo shows for 60 s; errors stay until closed. The text is
  announced after the server answers.

### 7.6 Mass reschedule
Lane header `⋯` (`aria-label="More for <name>"`) → `Move this day…`. Dialog "Move <name>'s requests on
Tue, Nov 10": `To day` (default the next weekday; picking a technician sets it to the same day only if the
dispatcher hasn't changed it; min today, max today + 365), `To technician` ("Same technician"), the preview
(skeleton after 300 ms; "Couldn't load the preview. Please try again." + Try again; "No requests to move
on this day."), rows "9:00 AM – 11:00 AM · <customer> · <ref>" with "Moves" or the reason, a checkbox
"Move them even where they overlap" when any `conflict` shows. "Move N requests" counts the rows that will
move; disabled when nothing changes. After commit the dialog stays open on the result: "Moved 3 of Alex's
requests to Sam on Wed, Nov 11." (variants without day or technician; "None of Alex's requests moved."),
then what stayed, with reasons.

### 7.7 Sheet: Visits section
- **Technicians** on each live visit row: the crew with "Lead"; a × on each helper not working ("Remove
  <name> from this visit", `DELETE …/assignments/[tid]`); "Add technician", a `Select` of active
  technicians not live on the visit (`POST …/assignments`), disabled at 5 with "A visit can have up to 5
  technicians.", hidden with "Set a lead first." while the visit has no lead. FieldPulse rows: "Change the
  technicians for this request in FieldPulse."; HCP: "Helpers aren't available for Housecall Pro
  requests." Success calls `onAssigned` (`calendar/page.tsx:342`) so the board refetches. The lead changes
  with Reassign above or on the calendar.
- **Change time** on each live visit #2+: dialog "Change visit #2" (date, window `Select`, "Save" /
  "Cancel") → `PATCH …/appointments/[aid]` with the row's `version` and its current technicians lead first
  (`updateAppointment`, unchanged, keeps its timestamp progress gate). Copy: HAS_PROGRESS "A technician has
  started this visit. Ask them to pause it first."; VERSION_CONFLICT "This visit changed. It has been
  refreshed."; TIME_OFF "<name> is off during this time."; WINDOW_ENDED `WINDOW_ENDED_MESSAGE`; other
  "Couldn't change the visit. Please try again."

### 7.8 When the board isn't interactive
`boardInteractive(width, finePointer)`: interactive at ≥ 1024 px with `(pointer: fine)`; a lazy
`matchMedia` init (the board is `ssr: false`, `calendar/page.tsx:28-43`). Otherwise no sensors and no lane
menu; chips, blocks and `Move…` stay; notice "Dragging needs a computer. Use Move… on a request, or open
it." Today's touch drag goes.

### 7.9 Week view
Columns under the unassigned scope (no technician change); the prompt applies; one card per request.

## 8. Copy

| where | copy |
| --- | --- |
| Confirm · started, lead change | line 1: "<Alex Rivera> is en route to this visit." / "…has arrived." / "…is in progress on this visit." / "…is paused on this visit." / "…is done with this visit."; no timestamp: "This visit is marked in progress." Line 2: "<Alex> comes off the visit. <Sam> becomes the lead and takes over close-out, the invoice and estimates." + "The request goes back to scheduled." when it does + "Alex's time on it stops." when `openTimeEntry`. Line 3: "Neither technician is told. Call them." |
| Confirm · started, time change | "<Alex Rivera> is in progress on this visit. It moves to 12:00 PM – 4:00 PM." per started technician + line 3 |
| Confirm · conflict | "Overlapping requests:" + rows (`conflict-dialog.tsx:88-106`), first names when more than one technician; out-of-hours line unchanged |
| Time off | `time_off`: "<Sam> is off 4:00 PM – 8:00 PM on Tue, Nov 10." · `non_job`: "<Sam> has a non-job event 4:00 PM – 8:00 PM on Tue, Nov 10." · a helper adds "Or remove <Sam> in the request." |
| Banners | STALE "This request changed. The calendar has been refreshed." · MANAGED_EXTERNALLY "Change this request in FieldPulse." · VISIT_ENDED "This visit has ended. Add a new visit instead." · VISIT_PINNED "Visit #2. Change its time in the request." · REQUEST_TERMINAL "This request is completed, so it can't be moved." / "…cancelled…" · TECHNICIAN_NOT_FOUND "That technician isn't active any more." · WINDOW_ENDED `WINDOW_ENDED_MESSAGE` · Undo ended "Can't undo. The original time has passed." · other "Couldn't move the request. Please try again." |
| Tray | started "A technician has started this visit, so it can't go back to the tray." · FieldPulse "Change this request in FieldPulse." |
| Sheet crew | ALREADY_ASSIGNED "<name> is already on this visit." · HAS_PROGRESS "<name> has started, so they stay on this visit." · TIME_OFF "<name> is off during this visit." · VISIT_ENDED "This visit has ended." · NO_LEAD "Set a lead first." · VISIT_FULL "This visit already has 5 technicians." · other "Couldn't change the technicians. Please try again." |
| Mass reasons | started "Started" · ended "Visit ended" · later_visit "Visit #2. Change it in the request." · time_off "Time off then" · window_ended "That time has passed" · already_on_visit "<Sam> is already on it" · fieldpulse "Change it in FieldPulse" · helper "Helping <lead first name>. Change it in the request." · stale "Changed since you opened this" · conflict "Overlaps another request" |

Dates in `BUSINESS_TIME_ZONE` (`calendar-time.ts:27`), times via `formatBusinessTimeRange`.

## 9. Tests

No jsdom/RTL. Capture the vitest baseline first.

**Task 0, drag spike (before feature code).** A throwaway script against a throwaway org at 1440 × 900,
sidebar expanded, with `pointerWithin` swapped in locally, proves: (a) lane 1 → lane 5: pointer down, move
to within 20 px of the lanes scroller's right edge, hold until the target band's `boundingBox()` is in the
viewport (poll with a timeout), move onto its centre, release → assignee and window changed as intended;
(b) tray → an off-screen lane, the same way; (c) a drop 4 px inside a band edge lands on that band, not
its neighbour. Steps: `mouse.move` in `steps: 12`, past `PointerSensor`'s 6 px (:507-509). Any failure
redesigns the walk or the drag model first.

**Pure:** `rowStarted`; `currentWindowKind`; `covers`; `promptPlan` (tray; covered lane change; anytime,
11–1, 7–9; crossing defaults; same day and lead without Keep); `resolveMoveWindow` (match, pick, keep
across days and the 2027-03-14 DST start, end past midnight, exact, keep without a window);
`timeOffHits`; `moveNeeds` (checked technicians; old lead excluded); `optimisticCrew` (drop on a helper's
lane; old lead untouched and progressed); `laneCards`; `chipLayout`; `applyMoveResult`; `moveLanded`;
`moveBanner`; optimistic tray drag with two tray cards (no `visitId`); mass classification and default
day; `boardInteractive`; §8 copy builders.

**SQL renders (`PgDialect`):** L_req first; `organization_id` everywhere; the version gate with the id
(null → no #1); the native-only CASE incl. `on_hold` and the hold fields; steps 1, 3–6 on their
conditions, gated; `reviveLeadSql` in the sheet writers and `placeAndAssignRequest`; the entries filter;
the audit xmin gate; the final version read; `startedRowSql` in `visitOneGuardSql` only
(`visitProgressed` unchanged); FieldPulse predicates; `addVisitTechnician` revive, lead and cap clauses;
`removeVisitTechnician`'s cancel branch; the mass `NOT EXISTS` audit predicate.

**Route tests:** every code and its order; 400s (non-UUID, `keep` without a window, `exact` over 24 h);
TIME_OFF has no `needs`; details carry no names; mass key rules, a 31st visit refused; `/reschedule` →
404; tech cookie → 401; no route in M2 imports a FieldPulse client or push function (render/import test).

**Integration (`tests/integration/dispatch-board.test.ts`, `VITEST_INTEGRATION=1`, dev DB, throwaway orgs
by SQL via `createOrgCore`, never the default org; pushes mocked):**
(a) window: 9–11 on Alex → Sam's morning → 9–11; afternoon match → 12–4; pick; keep to another day; match
into an ended band → WINDOW_ENDED;
(b) done-when: Alex taps en route → move to Sam → 409 HAS_PROGRESS → confirm → request `scheduled`, Sam
lead `scheduled`, Alex `cancelled` with `en_route_at` kept, Alex's open entry closed, one audit row, one
event `en_route → scheduled`; Alex reads the job; Sam can edit Alex's form draft;
(b2) drag back to Alex → no confirm; Alex lead `scheduled` (revived by step 4), Sam deleted (untouched);
(b2u) Undo instead → Alex lead `en_route`, request `en_route`, Sam gone;
(b2h) Alex lead en route + Sam helper `assigned` → Move anyway to Sam → Undo → Alex lead `en_route`, Sam
helper `assigned` (not deleted);
(b3) pause: request `on_hold` → override → `scheduled`, hold fields cleared;
(b4) Alex en route, then Alex's time off from now → move to Sam with confirm → 200;
(c) done lead: Alex `completed` → time move → confirm; lead change → Alex `cancelled`;
(d) helper working, lead untouched → lead swap without confirm; time move → 409;
(e) office PATCH `in_progress` → board 409; sheet reassign 409 with the sheet copy; sheet reassign A → B
→ A where A has timestamps → A lead with an open status;
(f) FieldPulse (`fieldpulse_job_id` by SQL): time move, day move, lane change, tray, sheet reassign →
MANAGED_EXTERNALLY with nothing written; mass → `fieldpulse`; GET `movable: 'no'`; a native request in a
FieldPulse-connected throwaway org (a connection row with a dummy key, client mocked) → move → 200 and no
FieldPulse call; HCP: lane and time → 200, `pushJobToHcp`;
(g) two moves from one version on two connections → one STALE; a lead `en_route` tap from `scheduled`
between render and drop → STALE; a helper's tap → HAS_PROGRESS; (g') tray then re-place → an old card →
STALE;
(h) done-when: Sam added through `POST …/assignments` → both lanes, two chips; remove → gone; add after a
cancel → revived; a 6th → VISIT_FULL; add on an unassigned visit → NO_LEAD; drop the lead card on Sam's
lane → Sam lead, Alex removed; time move with helper time off → TIME_OFF naming Sam; (h2) helper Sam off,
lead swap with the window unchanged → 200;
(i') `Change time` on a #2 visit → the board GET shows it moved; a displayed #2 card → `movable: 'no'`,
the move route → VISIT_PINNED;
(j) `pending` with Alex dropped on Alex → `assigned`, event; (j') `scheduled` with no lead → one `assigned`
event; (j'') a placed unassigned request → GET `visitId` = #1's id → drop on Alex → 200;
(l) blocks: three kinds in the day GET;
(m) mass: 2 movable, 1 started, 1 FieldPulse, 1 helper, 1 later visit → reasons; commit → 2 moved,
wall-clock kept, one audit row with per-visit skips; same key → same result; delete the key row and
re-send → same result, nothing re-written, pushes re-sent;
(n) visit #1 with a form submission to the tray → the visit survives;
(o) tenancy: other org ids → 404 / TECHNICIAN_NOT_FOUND;
(p) audit rows carry ids, enums, booleans and counts only.

**Browser walk** (1440 × 900; `scripts/agent/m2-walk.mts` modelled on `m3d-walk.mts`; throwaway org by
SQL; `MINT_ORG_ID`, org asserted; queue guard before, zero `communication_jobs` after): Alex and Sam with
hours; a 9–11 request on Alex; Alex en route on another; an afternoon request on Alex; Sam off 4–8 PM; a
FieldPulse card set by SQL. Add Sam as helper through the sheet → both lanes, chips → 9–11 to Alex's
afternoon → prompt, default "Use the afternoon window" (same day and lead) → Cancel → again → Move → 12–4 →
en-route card to Sam → "Move anyway?" → Cancel → again → Move anyway → banner → Undo → back → the
afternoon request on Sam's evening → Use the new window → Move → time-off dialog, nothing moved → the
FieldPulse card: pill and lock visible, no grab cursor, no `Move…` → `Move…` from the keyboard on a card → dialog →
move → focus returns to the card → Week view, next day same band → no prompt → `Move this day…` with a
skipped row → move → 1023 px and 390 px: notice, `Move…` works. Screenshots at each step; look at them.
`python3 .claude/skills/replica-design/contrast.py` on the chip, pill and hatch tokens.

Design deviations from `replica/design/components.md`: started cards stay draggable (:81 says no grab
cursor); the prompt's button is "Move", Keep listed first (:98–104 say "Move job").

## 10. Out of scope

- Capacity: the window-load strip, holds-aware office moves, the placed + reserved race, capacity
  adjustments (row 82); `reserveCapacitySlot` unchanged. Zones (100).
- Any board write to FieldPulse (schedule or assignee); helpers on FieldPulse or HCP requests (M3a refuses
  both).
- Dragging visits #2+ (the sheet changes their time); keyboard drag (`Move…` instead).
- Named teams, skills (99), tray tabs (93), late outlines (101), route view (103), custom window picker
  (79).
- Telling the customer or a technician about a move; adding helpers by drag; resizing cards.
- `/admin/dispatch`, month, agenda; blocks in Week view; editing shifts on the board.
- Mass undo, `deltaMinutes`, more than 30 visits per run.

**Follow-up (needs the owner).** FieldPulse time moves from the board: a `pushScheduleToFieldpulse(org,
rid)` wrapper calling `updateJob(id, { scheduleStart, scheduleEnd })`, which serialises only the two
schedule keys (`JSON.stringify` drops undefined ones, `fieldpulse/client.ts:984-999`). `updateJob` is a
PUT, and whether FieldPulse clears omitted fields is unknown. The owner verifies on a test job in their
own FieldPulse that a schedule-only PUT keeps the description and assignee; then the push is built and
FieldPulse time moves are enabled (`movable` gains `time_only`). Not done autonomously: the dev default
org's key reaches the owner's live account, and a PUT there can't be undone by us.

## 11. Rulings and things not verified

Rulings (lead rulings L1–L11 round 1, L2-1…L2-10 round 2, in the log):
1. Window = `arrival_window_*`; prompt only when the pointer's band isn't covered; defaults §5.2.
2. Synced: HCP moves and is pushed. FieldPulse-mapped requests are read-only on the board (time, window,
   day and technician) and their technician is refused in the sheet; M2 makes no FieldPulse call (L3.1-1).
   Unmapped native requests in a FieldPulse org move as today.
3. Started = live lead row working or done, or live helper row working.
4. Move anyway: the old lead's row is `cancelled` (timestamps and entries kept, time stopped); the new
   lead starts unstarted; the request resets to `scheduled` (incl. `on_hold`) when nobody else works.
   Supersedes round 1's "old lead stays as a helper".
5. Undo restores the exact previous crew and request status; it re-asks only for new starts.
6. A cancelled row is revived whenever its technician becomes lead (board, sheet, autopilot) or helper.
7. Time off is never overridable; only the technicians a move assigns are checked.
8. Visit #1 only, while displayed; visits #2+ pinned and changed in the sheet.
9. `visitId` falls back to #1; version gate on id + version; single move unkeyed; mass keyed with
   audit-row recovery.
10. Keyboard: `Move…` action, no keyboard drag. No migration. Row 98's team grouping = the visit's crew.

Not closed by M2:
- Capacity over-commit as today (`capacity-hold.ts:71-79`; capacity milestone).
- Autopilot: after a dispatcher moves a fresh, still unassigned request within the Unassigned lane, an
  autopilot run already scoring can re-place it at its held slot (`requireUnassigned` checks the assignee
  only; docs/DISPATCH.md:56-62).
- The sheet's `pushJobToFieldpulse` on a schedule change still creates FieldPulse jobs for native requests
  and overwrites the FieldPulse description (pre-existing bug; reported, not fixed here).
- In an HCP-connected org the first move of a native request creates its HCP job, after which helpers are
  refused (pre-existing push; M3a rule).
- `idempotency_keys` isn't pruned.

Verified: column names; dev counts (§1); `/reschedule` callers; `updateJob` drops undefined keys; layout
arithmetic.

Not verified: task 0 (drag spike); FieldPulse PUT semantics (follow-up, §10); the day GET's latency with the
crew query (measure before and after).

## 12. Review focus

- §3.2 and its single call site change (`progressed()`), with `updateAppointment` left alone.
- The batch: steps 1–6 and their conditions under the trigger's step 3; `restore`.
- `reviveLeadSql` in every request-column writer that changes the lead.
- FieldPulse: refused on every board path and the sheet's technician paths; no FieldPulse import in M2 code.
- Mass recovery; the `visitId` fallback.

## 13. Docs

`page-calendar` (drop flow, prompt, confirm, Undo, `Move…`, focus, crew, blocks, FieldPulse cue,
FieldPulse read-only on the board, interactivity rule, `/reschedule` removed, queries.test indices), `page-requests` (started rule, sheet copy,
crew control, Change time, FieldPulse reassign refusal, revive), `page-dispatch` (helpers show only in
their lead's column), `admin-pages` (started rule), `docs/DISPATCH.md` §5 (move route, `/reschedule`
removed, the autopilot invariant and residual), `replica/features.csv` rows 96/97/98/102,
`replica/parity.md`, `replica/build-log.md`, `replica/architecture.md` annotation (move route under the
request, no `deltaMinutes`, `REASSIGNABLE_STATUSES` unchanged and in `request-status.ts`, synced rules,
capacity deferred), memory.
