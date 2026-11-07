# Replica M2: Dispatch, as deltas to /admin/calendar

Status: v2 (2026-11-08) after adversarial review round 1 (3 critics; log in
`docs/superpowers/specs/2026-11-08-replica-m2-review-log.md`). Owner: Raymond Chen.
Milestone source: `replica/architecture.md` build order item 5 (lines 625–633), the F03 route table
(lines 134–145), the reassign-guard constraint (lines 93–95), the races paragraph (lines 344–351) and the
F04 ownership and status rules (lines 146–175). Builds on M0a (visits, assignments, shifts), M3a
(ownership, the visit trigger), M3b (idempotency keys) and M3d (a visit with a form submission is never
deleted). Trigger citations are to `drizzle/0050_m3a_run_the_day.sql`; the live body is 0058's, which is
0050's verbatim except the `v_has_progress` predicate (`0058_m3d_forms.sql:112-117`).

## 1. Goal

The office runs the day on the existing day view. Dragging a request into a window its current window
doesn't cover asks whether to keep the window, use the new one, or choose one. Moving a visit a
technician has started is refused with a 409 until the dispatcher confirms "Move anyway"; the override is
audited and offers Undo. A visit worked by two technicians shows in both lanes with crew chips, and the
sheet's Visits section adds and removes helpers. Time off, non-job events and on-call shifts show as
blocks in the lane. A dispatcher can move a technician's day to another day or technician after a
preview. There is no second board: `/admin/dispatch`, month and agenda are untouched.

Synced requests stay on the board. Housecall Pro requests move like native ones and are pushed as
today. FieldPulse requests move in time (pushed with `pushJobToFieldpulse`, as the sheet does), but
their technician can't be changed here, because the nightly FieldPulse sync owns the assignee.

Done when (architecture.md): dragging across a window boundary prompts for the window; a working job
refuses reassignment with a 409 unless overridden; a two-tech job shows on both lanes.

Feature rows (`replica/features.csv`, row = file line):
- **96** Edit arrival window prompt on move (must) → `yes`, note "a drop into a window the current one
  doesn't cover asks: keep, use the new window, or choose one; lane changes and covered drops keep it".
- **97** Block reassign of working or done jobs (must) → `yes`, note "a started visit refuses a move with
  409 HAS_PROGRESS; Move anyway overrides, is audited and can be undone; the old lead stays as a helper".
- **98** Multi-technician and team assignment with team grouping (must) → `yes`, note "lead + helpers
  per visit, added in the request sheet; the visit shows in every crew member's lane with crew chips; no
  named teams (a visit's crew is its team)".
- **102** Mass reschedule (could) → `yes`, note "move a technician's day to another day and/or
  technician, with a preview; no undo (move it back)".
- Cut, unchanged: **82** capacity board (stays `no`; the window-load strip and guard go to a capacity
  milestone, §10), **100** zones (stays `partial`), **79**, **93**, **101**, **103**.

Dev facts (dev branch, 2026-11-08, read-only):
- Open placed requests: 32 native, 83 FieldPulse (all 207 FieldPulse rows are in the default org; 16 of
  them are app-created bookings the app pushed to FieldPulse). 0 rows carry `hcp_job_id`.
- Windows that aren't an exact named band: 3 of 32 native open placed requests, 82 of 83 FieldPulse.
- Helper rows: 0 (no UI creates them today, §7.7). Visits #2+: 2, both cancelled. `technician_shifts`: 0.
- Rows `in_progress` with no timestamp: 16 (15 FieldPulse, 1 native office status mirror). Rows with a
  progress timestamp: 5.
- Native `pending` requests with an assignee: 5 (lead rows `pending`, which the technician app doesn't
  list).
- Visits at `version` 0: 284 of 298. Job time entries with no `appointment_id`: 1 of 6.

## 2. Surfaces

| surface | who | what |
| --- | --- | --- |
| Calendar Day view (`interactive-scheduling-calendar.tsx` `DayView` / `DayLane`, :165–332) | admin, ≥ 1024 px | crew chips and helper copies (§7.2), blocks (§7.3), drop flow, window prompt, confirm, Undo (§7.4, §7.5), lane menu `Move this day…` (§7.6) |
| Calendar Week view (`WeekView`, :346–415) | admin, ≥ 1024 px | the window prompt on drops; one card per request |
| Unscheduled tray (`draggable-unscheduled-panel.tsx`) | admin | drags use the move route; FieldPulse requests can't go back to the tray |
| Calendar below 1024 px | admin | read-only (§7.8) |
| Request detail sheet, Visits section (`request-detail-sheet.tsx:578-615`) | admin | `Technicians` control: add a helper, remove one (§7.7); reassign and schedule refuse a started visit with new copy (§5.6) |
| `/admin/dispatch`, month, agenda, tech app | — | unchanged |

## 3. Data model

**No migration.** `drizzle/0059` stays free (journal last entry `idx 58`).

### 3.1 Arrival windows
The window is `arrival_window_start` / `arrival_window_end` on `service_requests` (`schema.ts:570-571`)
and `appointments` (`schema.ts:707-708`); no `window_start` / `window_end` column exists.
`appointments.starts_at` / `ends_at` (`:705-706`) are written equal to the window by every writer (the
trigger, 0050:102–105; `addAppointment`, `appointment-queries.ts:163-166`; `updateAppointment`, :257); M2
keeps them equal (dev: 0 rows differ). Visit #1 is written through the request columns and mirrored by
the trigger, which fires only on a real change of `scheduled_date`, either window end, `assigned_to` or
`status` (0049:221–229). Named windows: `ARRIVAL_WINDOWS` (`arrival-window.ts:12-27`); drop targets are
the three bands `RESCHEDULE_WINDOW_ROWS` (`calendar-time.ts:329-333`).

### 3.2 Started (the reassign guard's definition)
New `src/lib/admin/visit-started.ts` (pure `rowStarted` + SQL twin `startedRowSql(alias)`), with
`STARTED_ASSIGNMENT_STATUSES = ['en_route', 'arrived', 'in_progress', 'completed']` in `request-status.ts`.
Only the visit's live rows (`status <> 'cancelled'`) count:
- the **lead** row is started when its status is `en_route`, `arrived`, `in_progress` or `completed`, or
  `on_hold` with a progress timestamp (a pause);
- a **helper** row is started when it is working: `en_route`, `arrived`, `in_progress`, or a pause. A done
  helper (`completed`) doesn't hold the visit.
- Timestamps alone don't count, except to tell a pause from an untouched `on_hold`. A row revived to
  `assigned` / `scheduled` after an override keeps its timestamps as history and is not started.
- A visit is started when any live row is started.
Status counts because the trigger mirrors request status onto an untouched lead row (0050:147–159; dev:
16 rows) and architecture.md:93–95 names the guard by status. `visit-one-guard.ts` `progressed()` (:22),
`appointment-queries.ts` `visitProgressed` (:199-201) and `classifyMiss` (:222-226) switch to it, so the
sheet, the tray, visit PATCH and the board share one rule. `removeVisitTechnician`'s per-row timestamp
check (`assignment-queries.ts:134-135`) and the trigger's `v_has_progress` are different questions and
stay. `REASSIGNABLE_STATUSES` (`request-status.ts:69`; architecture.md:95 places it in `queries.ts`)
stays `IN_FLIGHT_STATUSES`: the visit guard already refuses every status that narrowing would remove.

### 3.3 Crew
A visit's crew = its live rows (`schema.ts:728-752`; one lead; at most `MAX_TECHNICIANS_PER_VISIT = 5`,
`appointment-types.ts:30`). Helpers are written by the existing M3a endpoints (`POST/DELETE
…/appointments/[aid]/assignments`, `assignment-queries.ts:61`, `:125`), which now get a UI (§7.7).
`addVisitTechnician`'s insert changes from `ON CONFLICT DO NOTHING` (:90) to reviving a cancelled
non-lead row: `ON CONFLICT (appointment_id, technician_id) DO UPDATE SET status = 'assigned',
assigned_by = $actor, assigned_at = now() WHERE appointment_assignments.status = 'cancelled' AND NOT
appointment_assignments.is_lead` (timestamps kept, not started by §3.2).

### 3.4 Blocks
`technician_shifts` (`schema.ts:754-772`, kinds `on_call`, `time_off`, `non_job`; `removes_capacity`
default per `shift-types.ts:20-22`). Read only; written on the Staff page's time-off dialog.

## 4. Concurrency

### 4.1 Revision gate
Every board write carries the visit the dispatcher saw: `visitId` + `visitVersion`
(`appointments.version`, `schema.ts:713`). The gate compares both: `EXISTS (SELECT 1 FROM appointments p
WHERE p.id = $visitId AND p.organization_id = $org AND p.service_request_id = $rid AND p.version = $v)`;
with `visitId: null` (a tray request with no visit yet), `NOT EXISTS (… appointment_number = 1)`. The id
matters: a new visit #1 starts at version 0 (284 of 298 on dev), so sending a card to the tray and
placing it again creates a different visit at the same version. The trigger bumps #1's version on every
watched change (0050:119), so a technician's tap, another dispatcher's move or an autopilot placement
(`placeAndAssignRequest` writes the same request columns) between render and drop answers `STALE`. The
autopilot itself only places requests still unassigned (`requireUnassigned`,
`scheduling-queries.ts:780-785`), so it can't overwrite a dispatcher's lane change; its residual is in
§11. Helper changes don't bump the version; every crew check runs in SQL at write time.

### 4.2 Idempotency
- **Single move: not keyed.** It writes absolute values under the version gate, so a re-send after a
  lost response answers `STALE`. The client then refetches and treats the move as landed, silently, when
  the refetched card has the intended lead and window (pure `moveLanded`); otherwise the STALE banner.
  No `idempotency_keys` row per drag.
- **Mass reschedule: keyed** with `withIdempotency(scope, canonicalHash(body), run)`
  (`idempotency.ts:215`), Idempotency-Key required (`parseIdempotencyKey`, :47; missing → 400
  `VALIDATION_ERROR`), 2xx stored only; no new `STORED_CODES`. Crash after commit: `runAsWinner` writes
  the done row after the work (`idempotency.ts:186-200`), so a taken-over re-run must not meet its own
  version bumps. The audit row's id is `derivedId(scope, 'audit')` (`ON CONFLICT (id) DO NOTHING`, in
  the batch), and its details carry `movedVisitIds` and `skippedVisitIds` (ids only, ≤ 30 each). `run`
  first reads that row; when it exists, it rebuilds the 200 from it plus the visits' current versions and
  writes nothing. The M3b rule (m3b spec "a re-run after a crash … must not credit twice").

### 4.3 Locks
L_req first in every batch: `lockRequestSql(org, rid)` (`invoice-field-writes.ts:42`). The mass batch
locks all its requests first: `SELECT 1 FROM service_requests WHERE organization_id = $org AND id =
ANY($ids) ORDER BY id FOR NO KEY UPDATE`. Request → rows everywhere, as every M3 writer does.

## 5. Writers

### 5.1 Who, and synced requests
Admin session only (`getAdminSession`; `verifyToken` rejects other roles, `auth/config.ts:45`); no
`/api/tech` route changes. Every body id is re-read under the session org inside the write.

| source | time / window / day | technician (lane change, tray, mass `T2`) | after a visit #1 window change |
| --- | --- | --- | --- |
| native | yes | yes | `pushJobToHcp`, `pushJobToFieldpulse` (no-ops unless the org is connected) |
| Housecall Pro (`hcp_job_id`) | yes | yes | `pushJobToHcp` |
| FieldPulse (`fieldpulse_job_id`) | yes | **no**: 409 `MANAGED_EXTERNALLY` | `pushJobToFieldpulse` |

- **Housecall Pro** writes back status and invoice status only (`housecall-pro/webhook-sync.ts`, around
  :232 and :309-311), never schedule or assignee, so moves stick, as today's drag route assumes
  (`reschedule/route.ts:186-189`). A request never becomes unmovable because the app pushed it.
- **FieldPulse** time moves are pushed exactly as the sheet pushes a schedule change
  (`requests/[id]/route.ts:356`, `:382-386`): `after(() => pushJobToFieldpulse(org, rid))` when the
  window changed. Failure handling is the sheet's: `pushJobToFieldpulse` is degrade-safe, logs a warning
  and never throws (`fieldpulse/job-sync.ts:136-226`), and the response doesn't wait for it. If the push
  fails, the nightly import writes FieldPulse's old window back (`import/jobs.ts:528-536`), as it does for
  the sheet today. The assignee is never pushed; the import sets `assigned_to` from FieldPulse's
  assignment or null (`import/jobs.ts:429-460`), so a lane change would be undone overnight. The board
  refuses it with honest copy (§8). Pushing the assignee (the client accepts `assigned_user_id`,
  `fieldpulse/client.ts:984-1001`) is a later milestone.
- Native requests in a FieldPulse-connected org are pushed at booking (`create-request-queries.ts:409`,
  `submit-session-request.ts:420`) and from then on follow the FieldPulse row; M2 doesn't change that.

### 5.2 Window resolution (`src/lib/admin/move-window.ts`, pure, client and server)
- **Drop band** is the band under the pointer: dnd-kit `pointerWithin` collision with `closestCenter` as
  the fallback for keyboard drags (§7.4).
- `currentWindowKind(start, end)` → `band` | `anytime` | `custom` | `none`.
- `covers(current, D, B)` = the current window, moved to day `D` with the same wall-clock times, overlaps
  band `B` (half-open).
- `promptPlan(current, D, B)`:
  - no window (tray) → no prompt, use band `B`;
  - `covers` → no prompt, keep (lane changes and same-band day moves never prompt; a custom 9–11 stays
    9–11, today it becomes 8–12);
  - otherwise prompt, default **Use the new window** for a `band` window, **Keep** for `anytime` and
    `custom`.
- `resolveMoveWindow(current, D, B, rule, pick | exact)`: `match` → band `B` on `D`
  (`arrivalWindowUtcForBusinessDate`, `calendar-time.ts:311`); `pick` → the picked `ARRIVAL_WINDOWS` value
  on `D`; `keep` → the same wall-clock start and end on `D` (`businessWallClockToUtc`, :129; an end on the
  next business day stays on `D + 1`); `exact` → the given instants (used only by Undo, §7.5; end > start,
  span ≤ 24 h). `keep` with no window → 400 `VALIDATION_ERROR` `{ path: ['windowRule'] }`.
- Same lead, same window → nothing is sent.
- The server recomputes from the window it read (the version gate proves it unchanged).
- **Ended:** a changed window whose end ≤ now → 400 `WINDOW_ENDED` (`WINDOW_ENDED_MESSAGE`,
  `window-ended.ts:9`, as `POST …/appointments` does, its route.ts:93-94). A lead change that keeps an
  ended window is allowed.

### 5.3 `moveVisit` (`src/lib/admin/visit-move.ts`)
Input `{ requestId, visitId | null, expectedVersion | null, day, band, windowRule, pick?, exact?,
technicianId?, confirm: ('started' | 'conflict')[] }`. `technicianId` = the new lead; absent or equal to
the current lead = keep; dropping on Unassigned never unassigns (`interactive-scheduling-calendar.tsx:561-573`).
Only the request's **active visit** is moved: the card the board shows (`displayVisitIdSql`,
`current-visit.ts:54-59`) when it isn't ended; ended visits stay pinned.

**Pre-read** (one query): request (status, source, assignee), the visit (number, version, window, ended),
its live rows with `rowStarted` and timestamps. Refusals, in order: not in org → 404; `completed` /
`cancelled` → `REQUEST_TERMINAL`; visit cancelled or ended → `VISIT_ENDED`; id or version differs →
`STALE`; FieldPulse and the lead changes → `MANAGED_EXTERNALLY`; new lead not an active technician of the
org (`activeTechnicianIds`, `appointment-queries.ts:63`) → `TECHNICIAN_NOT_FOUND`; changed window ended →
`WINDOW_ENDED`; a capacity-removing shift of any crew member after the move overlaps the window →
`TIME_OFF` (never overridable, §5.5). Then the confirm needs, computed for the crew after the move:
- `started`: the lead changes and the current lead's row is started; or the window changes and any live
  row is started. A lead swap with only a helper working and the window unchanged needs nothing.
- `conflict`: a crew member has an open row (`OPEN_ASSIGNMENT_STATUSES`, `ownership.ts:13-15`) on another
  live visit of an open request overlapping the window (half-open, as `checkScheduleConflict`,
  `scheduling-queries.ts:237`), or the window is outside the new lead's hours (a span variant of
  `isWindowWithinAvailability`, `availability-coverage.ts:88`, over the private `spanIsCovered`, :56).
Unconfirmed needs → 409, code `HAS_PROGRESS` when `started` is among them, else `SCHEDULE_CONFLICT`,
`details: { needs, started?: [{ technicianId, status, hasTimestamp, openTimeEntry }], conflicts?: [{ id,
referenceNumber, technicianId, arrivalWindowStart, arrivalWindowEnd }], outsideAvailability? }`. Ids,
enums, booleans and the conflicting request's window only. Nothing is written.

**Batch, visit #1** (request columns; the trigger mirrors them). Every table predicate carries
`organization_id = $org`. `<gate>` = `EXISTS (SELECT 1 FROM service_requests r WHERE r.id = $rid AND
r.organization_id = $org AND r.xmin = pg_current_xact_id()::xid)`.
0. L_req.
1. `UPDATE service_requests SET assigned_to = $lead, scheduled_date = $start, arrival_window_start =
   $start, arrival_window_end = $end, status = <CASE>, updated_at = now() WHERE id = $rid AND
   organization_id = $org AND status NOT IN ('completed','cancelled') AND <version gate> AND NOT <visit
   ended> AND (fieldpulse_job_id IS NULL OR assigned_to IS NOT DISTINCT FROM $lead) AND <no time off, every
   crew member> AND (<'started' confirmed> OR NOT <started arm>) AND (<'conflict' confirmed> OR <no
   conflict>) RETURNING id, status`. Each guard is the SQL twin of a pre-read check.
   `<CASE>`: `pending` with a lead → `assigned` (the technician app hides `pending`; as
   `create-request-queries.ts:375-387`); a lead change past a started lead while `status IN
   ('en_route','arrived','in_progress','on_hold')` and no other live row is started → `scheduled`
   (an override-only edge: `en_route` and `on_hold → scheduled` are in `TRANSITIONS`,
   `request-status.ts:33`, :38; `arrived` and `in_progress → scheduled` are not, and are recorded as
   such, §5.3 After); otherwise unchanged.
2. Only on a lead change, the old lead: the trigger deletes an untouched row and demotes a progressed one
   to `cancelled` (or keeps `completed`), 0050:125–133. A progressed old lead stays on the crew as a
   helper: `UPDATE appointment_assignments SET status = 'assigned' WHERE organization_id = $org AND
   appointment_id = <#1> AND technician_id = $oldLead AND NOT is_lead AND status = 'cancelled' AND <any
   timestamp> AND <gate>`.
3. Only on a lead change, the new lead (inserted by the trigger with the request's status, or revived,
   0050:134–145, which keeps a `cancelled` row `cancelled`): `UPDATE appointment_assignments a SET status
   = CASE WHEN r.status IN ('en_route','arrived','in_progress','on_hold') THEN 'assigned' ELSE r.status END
   FROM service_requests r WHERE r.id = $rid AND r.organization_id = $org AND a.organization_id = $org AND
   a.appointment_id = <#1> AND a.technician_id = $lead AND a.is_lead AND (a.status = 'cancelled' OR
   (a.status IN ('en_route','arrived','in_progress','on_hold') AND <no timestamp>)) AND <gate>`. So a new
   or revived lead never reads as started without doing anything.
4. A progressed old lead's open time stops: `closeJobEntriesSql({ organizationId, requestId: $rid,
   technicianIds: [$oldLead], gate })` (`time-entry-sql.ts:34`) with the visit filter widened to
   `(t.appointment_id = <#1> OR t.appointment_id IS NULL)` (dev: 1 of 6 job entries has none).
5. Audit `INSERT … SELECT … WHERE EXISTS (SELECT 1 FROM appointments p WHERE p.organization_id = $org AND
   p.service_request_id = $rid AND p.appointment_number = 1 AND p.xmin = pg_current_xact_id()::xid)` (the
   M3c gate, `equipment-writes.ts:89`).

**Batch, active visit #2+** (written directly; request columns untouched):
0. L_req. 1. `UPDATE appointments SET scheduled_date, starts_at, ends_at, arrival_window_start,
   arrival_window_end, version = version + 1, updated_at = now() WHERE id = $vid AND organization_id =
   $org AND service_request_id = $rid AND appointment_number > 1 AND version = $v AND cancelled_at IS NULL
   AND <request not terminal; FieldPulse lead unchanged> AND <the same guards> RETURNING id`.
2. Lead swap gated on `landed()` (`appointment-queries.ts:89-91`): the old lead row is deleted when
   untouched, else `is_lead = false, status = CASE WHEN status = 'completed' THEN status ELSE 'assigned'
   END`; the new lead `INSERT … (is_lead true, 'assigned') ON CONFLICT (appointment_id, technician_id) DO
   UPDATE SET is_lead = true, status = CASE WHEN status = 'cancelled' OR (<started status> AND <no
   timestamp>) THEN 'assigned' ELSE status END`.
3. The request status reset of step 1's CASE, as its own `UPDATE service_requests … WHERE <landed()>`.
4. Steps 4–5 above for this visit.

**Zero rows** → re-read in the pre-read's order and answer the first failing code (a guard that now
fails answers its 409 with fresh `details`); nothing failing → `STALE`. A deadlock (`isDeadlock`,
`status-writes.ts:53`) → `STALE`.

**After the batch** (best-effort, as `placeAndAssignRequest` does today, `scheduling-queries.ts:843-868`):
- `recordStatusEvent(from: <old status>, to: 'assigned', actor: human)` on every first assignment (old
  `assigned_to` null, lead now set), whatever the status column did, as `scheduling-queries.ts:843-855`
  does for the first-response KPI; and `<old> → scheduled` (actor human) on an override reset;
- `stampDispatchOverride(org, rid, lead, user)` when a lead is set (`dispatch-override.ts`);
- visit #1 and the window changed: `after()` `syncRequestToCalendar`, `pushJobToHcp`, `pushJobToFieldpulse`;
  a lead change on a native or HCP request: `syncRequestToCalendar`, `pushJobToHcp` (today's calls,
  `reschedule/route.ts:184`, :189).
- No customer or technician message is sent.

Success → 200 `{ visitId, visitVersion, requestStatus, arrivalWindowStart, arrivalWindowEnd, leadId,
previous: { arrivalWindowStart, arrivalWindowEnd, leadId }, confirmed }`.

**What an override hands over.** The old lead stays on the visit as a helper: they still read the job
(`techCanReadSql`, `ownership.ts:169-171`), keep M3d form access on that visit (the visit gate needs a
live row, `src/lib/forms/form-gates.ts:16`; the native on-site window still applies, so an en-route helper gets
NOT_ON_SITE until someone is on site), and their open time stops. Lead-only work (request status taps,
close-out, field invoice, estimates, payments) passes to the new lead, who is the active visit's lead. A
draft field invoice or estimate stays on the request for the new lead to continue once on site
(`BILL_STATUSES`, `field-sale-statuses.ts:7`).

**Audit** `visit_moved`, entity `appointment`, entityId the visit: `{ requestId, appointmentNumber,
fromTechnicianId, toTechnicianId, windowRule, window: 'morning' | 'afternoon' | 'evening' | 'anytime' |
'custom', dayChanged, confirmed, startedStatuses, conflictCount, outsideAvailability, undo }`. No
instants.

### 5.4 Drag-to-tray (`unscheduleRequest`, `scheduling-queries.ts:916`)
Unchanged except: FieldPulse requests are refused (`MANAGED_EXTERNALLY`; it clears the assignee) in the
guarded UPDATE and the classifier; the started check is §3.2's through `visitOneGuardSql`. HCP requests
are pushed as today (`unschedule/route.ts:72-73`). Only a visit #1 card may go to the tray; a #2+ card
dropped there does nothing and shows its line (§8). A visit with a form submission keeps its row (0058);
M2 deletes no visit.

### 5.5 Time off
Never overridable (admin-pages skill: "Time off … is never overridable"; every writer guards it in SQL,
`noTimeOff`, `appointment-queries.ts:76`). That is why the lead's suggested "Schedule anyway?" confirm is
not used. 409 `TIME_OFF` `details: { timeOff: [{ technicianId, startsAt, endsAt, kind }] }`, one per crew
member. The client checks the loaded blocks first and shows the same dialog without a request (§7.4);
the server is the gate.

### 5.6 The sheet
`reassignTechnician` (`queries.ts:662`), `assignTechnician` (:506), `scheduleRequest` (:914) and
`updateAppointment` keep their writers and gain §3.2 through the shared guard; no override there.
`visitOneRefusalResponse` (`visit-one-guard.ts:59-62`) takes a context: sheet, native/HCP "A technician
has started this visit. To move it anyway, drag it on the calendar."; sheet, FieldPulse "A technician
has started this job. Change it in FieldPulse."; the tray keeps its own copy.

### 5.7 Mass reschedule (`src/lib/admin/mass-reschedule.ts`)
Every active visit on business day `D` whose lead is `T` moves to day `D2` and/or lead `T2`, keeping each
window's wall-clock times (`keep`). No `deltaMinutes` (architecture.md:144): minute shifts make custom
windows. No undo: the dispatcher mass-moves back.
- **Preview** (read-only) lists every visit `T` is on that day: `moves`, or skipped `started` (never
  overridden in bulk), `ended`, `time_off`, `window_ended`, `already_on_visit` (`T2` has any row on it,
  cancelled included), `fieldpulse_technician` (FieldPulse request and `T2` set), `helper` (`T` only
  helps; it moves with its lead), plus the soft flag `conflict`.
- **Commit** `{ technicianId, fromDate, toDate, toTechnicianId?, visits: [{ visitId, expectedVersion }]
  (1–30), confirmSoft }`, keyed (§4.2). One batch: L_req over all requests, then per visit the §5.3
  statements, each with its own version gate, lead gate `= T` and `start on D` predicate; `confirmSoft`
  confirms `conflict` for every visit, else those are skipped. Each visit lands or misses independently;
  any statement error rolls back all and answers 500 (nothing moved; the client refetches). Then the audit
  row (§4.2).
- After: per moved request the §5.3 after-calls, and `stampDispatchOverride(org, rid, T2, user)` when `T2`
  is set.
- Result `{ moved: [{ visitId, requestId, visitVersion }], skipped: [{ visitId, reason }] }`.
- Audit `dispatch_mass_rescheduled`, entity `user`, entityId `T`, id `derivedId(scope, 'audit')`: `{
  toTechnicianId, dayShift, movedVisitIds, skippedVisitIds, skippedReasons: { reason: count },
  confirmSoft }`.

## 6. Routes (`force-dynamic`, admin session, logs carry codes and ids only)

| route | gate | success |
| --- | --- | --- |
| `GET /api/admin/calendar` (exists) | unchanged, `adminRead` | §7.1 fields; day view adds `blocks` |
| `POST /api/admin/requests/[id]/move` (new) | `isUuid`, `admin:visit-move:<user>` `adminMutation`, `readJsonBody`, zod | 200 §5.3 |
| `POST /api/admin/requests/[id]/unschedule` (exists) | + FieldPulse refusal | unchanged |
| `POST /api/admin/dispatch/mass-reschedule/preview` (new) | `adminRead`; dates `isRealIsoDate` within today − 1 … today + 365; ids `isUuid` | `{ candidates }` |
| `POST /api/admin/dispatch/mass-reschedule` (new) | `adminMutation`, zod, Idempotency-Key | §5.7 |
| `POST /api/admin/requests/[id]/appointments/[aid]/assignments`, `DELETE …/[tid]` (exist) | unchanged; insert revives (§3.3) | unchanged |
| `POST /api/admin/requests/[id]/reschedule` | **removed** with its tests (`tests/api/admin/reschedule.test.ts`, `route.test.ts`); its only caller was `use-reschedule-job.ts:99`, which keeps `unschedule` | — |

The move route sits under the request, not `appointments/[id]/move` (architecture.md:139), because a
tray request may have no visit. 400 bodies are `VALIDATION_ERROR` with `details.path`.

## 7. Client

Admin primitives and tokens, sentence case, "request" and "technician", no `err.message`. Logic in pure
helpers.

### 7.1 Board data (`getSchedulingCalendar`, `queries.ts:1661`)
After `mergePlacedRows` (:1573), one query reads, for every placed and tray card's displayed visit,
`appointments.id`, `version` and its rows joined to `users` (`name`, `is_active`), org-scoped. Cards gain
`visitId`, `visitVersion`, `crew: [{ technicianId, name, isLead, state: 'open' | 'working' | 'done' }]`
(live rows; inactive names withheld as `dashboardRequestSelect` does, :1263-1267), `started`,
`movable: 'yes' | 'time_only' | 'no'` (FieldPulse → `time_only`; ended → `no`), and per lane `laneRole:
'lead' | 'helper'`. Day view adds `blocks` (new `listShiftsInRange`, all kinds, `shift-queries.ts`).
`queries.test.ts`: the new queries run after the existing five; the visit feed stays index 4.

### 7.2 Lanes, crew and cues (Day view)
- A card renders in its lead's lane and, as a helper copy (`laneCards`, pure), in each active helper's
  lane: not draggable, a "Helping <lead first name>" line, tap opens the sheet. Keys
  `${requestId}:${technicianId}`.
- Crew chips (`crew-chips.tsx`) on their own row under the customer, only when the crew has 2 or more:
  initials, the lead first with the `marker` border, working filled, done with a check, more than 3 →
  `+N`; each chip has a title and an `aria-label` with name and state. Below 120 px card width (pure
  `chipLayout`) or in Week view: a people icon and the count, `aria-label="2 technicians"`.
- FieldPulse cards show the `SyncPill` at `md` size ("FieldPulse", `sync-pill.tsx:3`; today `sm` "FP")
  in the card's top row, and a small lock on the pill with title "Technician set in FieldPulse". HCP cards
  keep the `sm` pill.
- Started cards show a lock icon (title "Started. Moving it asks first.") and stay draggable (design
  deviation, §9).
- Lane counts include helper copies; ended visits skipped (`liveJobCount`, :127).
- The time axis is `sticky left-0` with the surface background, so it stays put while lanes scroll.
- Width at 1440: viewport − sidebar 232 (`sidebar.tsx:329`) − `PageShell` `p-6` 48 = 1160; − tray 288 +
  gap 16 (`draggable-unscheduled-panel.tsx:125`) = 856; − board `p-3` and border 26 = 830; − axis 56 + gap
  8 = 766 for lanes at 224 + 8 each. **Unassigned plus two technician lanes are fully visible**; the third
  shows 70 px; the rest scroll horizontally as today (dnd-kit auto-scrolls at the edge while dragging).

### 7.3 Blocks
`lane-blocks.tsx` draws blocks behind the cards (`placeJobInLane`): `time_off` and a capacity-removing
`non_job` hatched with the title or "Time off" / "Non-job event"; a `non_job` that keeps capacity
outlined only; `on_call` a 3 px left rail titled "On call". A block links to the Staff page
(`/admin/staff`). Bands stay droppable (a disabled droppable would send the drop to a neighbour); a
fully covered band gets "Time off" in its accessible name. Ended bands on today are shaded and named
"Ended".

### 7.4 Drop flow (`handleDragEnd`, `interactive-scheduling-calendar.tsx:534`)
`collisionDetection` becomes `pointerWithin`, falling back to `closestCenter` when the pointer is over no
droppable (keyboard drags). `handleDragStart` (:523-532) finds the overlay card by `visitId` and
`laneRole === 'lead'`.
1. Tray drop → §5.4 (a #2+ card or a FieldPulse card is refused client-side with its line).
2. Band drop: FieldPulse card on another lane → banner (§8), nothing sent. Resolved crew overlaps a
   capacity-removing block → the time-off dialog, nothing sent. `promptPlan`; same lead and window →
   nothing.
3. Prompt (opened on the next frame, so the key that ended a keyboard drop doesn't submit it); Escape or
   Cancel → nothing moved; after Keep with the same lead and day → nothing.
4. Optimistic move (`applyOptimisticReschedule` / `currentScopeOf`, `calendar-optimistic.ts:58`, :85, keyed
   by `visitId`, moving every copy), then `POST …/move`.
5. 200 → `applyMoveResult` writes `visitVersion`, `leadId` and the window into the board for that
   `visitId` (a quick second drag doesn't meet its own STALE), then refetch. A lead change that shrank the
   crew shows "Sam is now the lead. Alex is off this visit."
6. 409 `HAS_PROGRESS` / `SCHEDULE_CONFLICT` → roll back, open the confirm (§7.5) holding the body; "Move
   anyway" re-sends with `confirm = needs`. `TIME_OFF` → the time-off dialog. `STALE` → refetch; if
   `moveLanded`, keep quietly; else the banner. Other codes → roll back, banner, refetch. Network failure
   or 5xx → refetch; `moveLanded` decides as for STALE.
In-flight state is per visit (`Set<visitId>`): only that card and its copies are disabled; `isRescheduling`
leaves the lane and tray props (:702, :715, :727).

### 7.5 Dialogs and Undo
- **Window prompt** (`window-prompt-dialog.tsx`): title "Arrival window"; description "Moving <customer> ·
  <ref> to the <band>."; options "Keep 9:00 AM – 11:00 AM" (+ " on Wed, Nov 11" when the day changes),
  "Use the afternoon window · 12:00 PM – 4:00 PM", "Choose a window" with a `Select` (Morning, Afternoon,
  Evening, Anytime with hours; `selectLabel`; ended ones disabled "Already ended"); default per §5.2.
  Footnote "The customer isn't told about this change." Enter anywhere = Move; Escape = Cancel. Buttons
  "Move" / "Cancel".
- **Confirm** (`ConflictDialog` generalised, `conflict-dialog.tsx`): title "Move anyway?"; blocks per need
  (§8); "Cancel" and "Move anyway" (destructive, "Moving…").
- **Time-off dialog**: title "Can't move this request"; one line per crew member; single "OK".
- **Undo after Move anyway:** the banner (`CalendarStatus`, `calendar/page.tsx:47`, gains an optional
  action) says "Moved. Alex stays on as a helper." (or "Moved." for a time-only override) with `Undo`,
  until the next move or 60 s. Undo = the inverse move from the response's `previous`: `windowRule:
  'exact'`, the previous lead, the new `visitVersion`; it may itself ask to confirm. It puts the lead and
  window back; it doesn't restore progress (the old lead's row is `assigned` with their earlier
  timestamps; they tap again) or the request status.

### 7.6 Mass reschedule
Lane header `⋯` (`aria-label="More for <name>"`) → `Move this day…`. Dialog "Move <name>'s requests on
Tue, Nov 10": `To day` (default: the same day when a technician is picked, else the next weekday), `To
technician` (`Select`, "Same technician"), the preview (skeleton after 300 ms; "Couldn't load the preview.
Try again."; "No requests to move on this day."), rows "9:00 AM – 11:00 AM · <customer> · <ref>" with
"Moves" or the reason, a checkbox "Move them even where they overlap" when any `conflict` shows, and
"Move 1 request" / "Move N requests". After: "Moved 3 of Alex's requests to Sam on Wed, Nov 11. 2 stayed."

### 7.7 Sheet: technicians on a visit
Each live visit row in Visits (`request-detail-sheet.tsx:578-615`) gains `Technicians`: the crew with
"Lead" on the lead, a × on each helper ("Remove <name> from this visit", `DELETE …/assignments/[tid]`),
and "Add technician", a `Select` of active technicians not live on the visit (disabled at 5) calling `POST
…/assignments`. Hidden on FieldPulse requests (with "Change technicians for this job in FieldPulse.") and
for HCP (the M3a writers refuse both, `assignment-queries.ts:83`). Error copy maps the existing codes (§8).
The lead changes on the board, not here.

### 7.8 Below 1024 px
Pure `boardInteractive(width)`; `useMinWidth(1024)` initialised lazily from `matchMedia` (the board is
`ssr: false`, `calendar/page.tsx:28-43`, so the first paint is right). Read-only: no sensors, no lane
menu; chips and blocks shown; notice "Moving requests needs a wider screen. Tap a request to change its
technician or time." Today's touch drag goes: 224 px lanes, the prompt and the confirm don't fit, and
horizontal scroll competes with drag; the sheet still schedules.

### 7.9 Week view
Columns stay under the unassigned scope (no technician change); the prompt applies; one card per request.

## 8. Copy

| where | copy |
| --- | --- |
| Confirm · started, lead change | line 1 from the details: "<Alex Rivera> is en route to this visit." / "…has arrived." / "…is in progress on this visit." / "…is paused on this visit." / "…is done with this visit."; status without a timestamp: "This visit is marked in progress." Line 2: "<Alex> stays on as a helper. <Sam> becomes the lead and takes over close-out, the invoice and estimates. The request goes back to Scheduled." (the last sentence only when the reset applies; "Alex's time on it stops." only when `openTimeEntry`). Line 3: "Neither technician is told. Call them." |
| Confirm · started, time change | "<Alex Rivera> is in progress on this visit. It moves to 12:00 PM – 4:00 PM." (one line per started crew member) + line 3 |
| Confirm · conflict | "Overlapping requests:" + the existing rows (`conflict-dialog.tsx:88-106`), prefixed with the technician's first name when the crew has more than one; the out-of-hours line unchanged |
| Time off | "<Sam> is off 4:00 PM – 8:00 PM on Tue, Nov 10." |
| Banners | STALE "This request changed. The calendar has been refreshed." · FieldPulse lane change "Change the technician for this job in FieldPulse." · VISIT_ENDED "This visit has ended. Add a new visit instead." · REQUEST_TERMINAL "This request is completed, so it can't be moved." / "…cancelled…" · TECHNICIAN_NOT_FOUND "That technician isn't active any more." · WINDOW_ENDED `WINDOW_ENDED_MESSAGE` · other "Couldn't move the request. Please try again." |
| Tray | started "A technician has started this visit, so it can't go back to the tray." · #2+ "Visit #2 can't go back to the tray. Cancel it in the request's Visits section." · FieldPulse "Change the technician for this job in FieldPulse." |
| Sheet | §5.6; crew control: ALREADY_ASSIGNED "<name> is already on this visit." · HAS_PROGRESS "<name> has started, so they stay on this visit." · TIME_OFF "<name> is off during this visit." · VISIT_ENDED "This visit has ended." · other "Couldn't change the technicians. Please try again." |
| Mass skip reasons | started "Started" · ended "Visit ended" · time_off "Time off that day" · window_ended "That time has passed" · already_on_visit "<Sam> is already on it" · fieldpulse_technician "Technician set in FieldPulse" · helper "Helping <lead first name>. Change it in the request." · stale "Changed since you opened this" · soft "Overlaps another request" |

Dates in `BUSINESS_TIME_ZONE` (`calendar-time.ts:27`), times via `formatBusinessTimeRange`.

## 9. Tests

No jsdom/RTL. Capture the vitest baseline first.

**Drag spike (plan task 0, before any feature code).** A throwaway script against a throwaway org proves
a Playwright pointer drag lands on the intended band and lane at 1440: scroll source and target into view
(`scrollIntoViewIfNeeded` + `boundingBox()`), `mouse.move` to the card centre, `down`, move 10 px
(`PointerSensor` distance 6, :507-509), `move` to the target band centre with `steps: 12`, `up`; assert
with today's code that the request's window and assignee changed as intended, including a lane that
started off screen. If it can't, the walk is redesigned before M2 is built.

**Pure:** `rowStarted` (lead and helper statuses; done helper not started; revived `assigned` with
timestamps not started; pause; mirrored `in_progress`); `currentWindowKind`; `covers`; `promptPlan` (tray;
lane change; anytime and custom dropped on a covered band; 7–9 lane change; crossing → defaults);
`resolveMoveWindow` (match, pick, keep across days and the 2027-03-14 DST start, end past midnight,
exact, keep without a window); no-op detection; `moveNeeds`; `laneCards`; `chipLayout`;
`applyMoveResult`; `moveLanded`; optimistic move by `visitId`; mass classification and default day;
`boardInteractive`; §8 copy builders.

**SQL renders (`PgDialect`):** batches start with `lockRequestSql`; every table carries `organization_id`;
the version gate includes the id (null → no #1); the status CASE incl. `on_hold`; steps 2–4 only on a
lead change, gated; the entries filter with `IS NULL`; the #2+ swap; the audit xmin gate; `startedRowSql`
in `visitOneGuardSql` and `visitProgressed`; the FieldPulse lead predicate; the unschedule FieldPulse
predicate; the `addVisitTechnician` revive clause; the mass audit id.

**Route tests:** every code and its order; 400 on a non-UUID id, `keep` without a window, `exact` over
24 h; TIME_OFF details have no `needs`; 409 details carry no names; mass: missing key → 400, replay,
reused key → 422, a 31st visit refused; `/reschedule` → 404; tech cookie → 401 on every new route.

**Integration (`tests/integration/dispatch-board.test.ts`, `VITEST_INTEGRATION=1`, dev DB, throwaway orgs
by SQL via `createOrgCore`, never the default org; pushes mocked):**
(a) window: a 9–11 request on Alex → Sam's lane, morning → 9–11 kept, no prompt needed; afternoon match
→ 12–4; pick anytime; keep to another day; a match into an ended band → WINDOW_ENDED;
(b) done-when, working: Alex taps en route (`status-writes`) → move to Sam → 409 HAS_PROGRESS → confirm →
request `scheduled`, Sam lead `scheduled`, Alex a helper `assigned` with `en_route_at` kept, Alex's open
entry closed, one audit row with `confirmed: ['started']`, one status event `en_route → scheduled`; Alex
still reads the job and his form gate passes the assignment check;
(b2) then drag back to Alex → no confirm needed; Alex lead `scheduled` (revived), Sam deleted (untouched),
the crew shows Alex; Undo body from (b)'s `previous` does the same;
(b3) pause: Alex arrives and pauses (request `on_hold`) → override to Sam → request `scheduled`, Sam
`scheduled`, Alex helper `assigned`;
(c) done: Alex taps done (request `in_progress`) → time move → 409 → confirm → Alex stays `completed`;
lead change → Alex a done helper; a later time move needs no confirm;
(d) helper working, lead untouched → lead swap → 200 without confirm, helper unchanged; time move → 409;
(e) mirrored only: office PATCH `in_progress` → board move 409; sheet reassign 409 with the sheet copy;
FieldPulse request → the FieldPulse sheet copy;
(f) FieldPulse (`fieldpulse_job_id` by SQL): time move → 200, `pushJobToFieldpulse` called once; lane
change → MANAGED_EXTERNALLY; tray → MANAGED_EXTERNALLY; mass with `T2` → `fieldpulse_technician`;
HCP (`hcp_job_id`): lane and time move → 200, `pushJobToHcp` called;
(g) concurrency: two moves from one version on two connections → one 200, one STALE; a tap between
render and drop → STALE; (g') tray then re-place (new visit #1 at version 0) → an old card's drop → STALE;
(h) multi-assignee, done-when: Sam added through `POST …/assignments` → calendar GET has the card in both
lanes with both chips; remove → gone; add again after a cancel → the row revived; drop the lead card on
Sam's lane → Sam lead, Alex removed; helper time off → TIME_OFF naming Sam; helper double-booked →
SCHEDULE_CONFLICT naming Sam;
(i) active visit #2: drag moves the appointment only, request columns unchanged, version + 1;
(j) `pending` with Alex dropped on Alex → `assigned`, lead row `assigned`, event pending → assigned;
(j') `scheduled` with no lead dropped on Alex → one `assigned` event;
(l) blocks: three kinds listed in the day GET;
(m) mass: Alex's day with 2 movable, 1 started, 1 FieldPulse (with `T2`), 1 helper → preview reasons;
commit → 2 moved with wall-clock times, one audit row; same key → the same result; delete the key row and
re-send → the same `moved` list rebuilt from the audit row, nothing re-written;
(n) M3d: visit #1 with a form submission dragged to the tray → the visit survives;
(o) tenancy: other org's request, visit and technician ids → 404 / TECHNICIAN_NOT_FOUND;
(p) audit rows carry ids, enums, booleans and counts only.

**Browser walk** (1440 × 900; throwaway org via `scripts/agent/m2-walk.mts` modelled on `m3d-walk.mts`;
everything by SQL; admin session with `MINT_ORG_ID`, org asserted; queue guard before, zero
`communication_jobs` after): Alex and Sam with hours; a 9–11 request on Alex; Alex en route on another;
Sam's time off 4–8 PM. Add Sam as helper on a third request through the sheet → both lanes, two chips →
drag the 9–11 card to afternoon → prompt, default Keep → Cancel → unchanged → Use the afternoon window →
12–4 → drag the en-route card to Sam → "Move anyway?" → Cancel → again → Move anyway → Sam's lane, Alex
chip as helper → Undo → back → drop on Sam's evening → time-off dialog, nothing moved → Week view, next
day same band → no prompt → `Move this day…` → preview → move → resize to 390: notice, tap opens the sheet.
Screenshots at each step; look at them. `python3 .claude/skills/replica-design/contrast.py` on the new
chip and pill tokens.

Design deviations from `replica/design/components.md`: started cards stay draggable (the server
decides; :81 says no grab cursor); the prompt's button is "Move" and Keep is listed first (:98–104 say
"Move job", the canon says "request").

## 10. Out of scope

- Capacity: the window-load strip, holds-aware office moves, closing the placed + reserved race, and
  capacity adjustments (row 82) go to a capacity milestone; `reserveCapacitySlot` is unchanged. Zones
  (row 100).
- Pushing the FieldPulse assignee; helpers on FieldPulse or HCP requests (M3a refuses both).
- Named teams; skills (99); tray tabs (93); late outlines (101); route view (103); custom window picker
  (79).
- Telling the customer or a technician about a move.
- Adding helpers by drag; dragging helper copies; resizing cards; arrow-key minute moves.
- `/admin/dispatch`, month, agenda; blocks in Week view; editing shifts on the board.
- Mass undo, `deltaMinutes`, more than 30 visits per run.

## 11. Rulings and things not verified

Rulings (lead rulings L1–L11 in the log):
1. Window = `arrival_window_*`. The prompt fires only when the pointer's band isn't covered by the window;
   lane changes never prompt; default Keep for anytime and custom, Use the new window for a band.
2. Synced: HCP moves like native and is pushed; FieldPulse moves in time and is pushed like the sheet;
   FieldPulse technician changes are refused with honest copy and a visible FieldPulse pill.
3. Started = live lead row working or done, or live helper row working. An override keeps a progressed
   old lead as a helper, starts the new lead unstarted, resets the request to `scheduled` (incl. from
   `on_hold`) when no one else is working, and hands lead-only work to the new lead.
4. A cancelled row is revived when its technician becomes lead or crew again.
5. Version gate on visit id + version; the single move is unkeyed; mass is keyed with audit-row recovery.
6. Only the active visit is draggable. Crew UI lives in the sheet.
7. Time off is refused, never confirmed (repo invariant).
8. Mass reschedule: preview + confirm, no undo. Row 82 cut.
9. Row 98's team grouping = the visit's crew.
10. No migration; read-only below 1024 px.

Not closed by M2:
- Capacity over-commit as today: office moves ignore holds, and the placed + reserved race in
  `capacity-hold.ts:71-79` stands (capacity milestone).
- Autopilot: after a dispatcher moves a freshly booked, still unassigned request within the Unassigned
  lane, an autopilot run already scoring can re-place it at its held slot (`requireUnassigned` checks the
  assignee only, `scheduling-queries.ts:780-785`; docs/DISPATCH.md:56-62). A dispatcher's drag after the
  autopilot's write meets STALE.
- A FieldPulse push that fails is undone overnight, as for the sheet.
- `idempotency_keys` isn't pruned (mass adds one row per run).

Verified: column names (§3.1); dev counts (§1); `/reschedule` callers; technicians can't hold an admin
session; the sheet's FieldPulse push path; layout arithmetic (§7.2).

Not verified: the Playwright drag (task 0); `pointerWithin` with `restrictToWindowEdges` and auto-scroll
on a lane that starts off screen; the day GET's latency with the crew query (measure before and after).

## 12. Review focus

- §3.2's started rule and its call sites; revived rows.
- The visit #1 batch: the trigger's step 3 under a lead change, steps 2–4 and their gates; the #2+ swap.
- Guards in the UPDATE matching the pre-read; the zero-row order.
- FieldPulse: time moves pushed like the sheet, lead changes refused in SQL and on the client.
- Mass recovery after a crash; the version gate with the id.

## 13. Docs

`page-calendar` (drop flow, prompt, confirm, Undo, crew, blocks, FieldPulse cue, read-only below 1024,
`/reschedule` removed, queries.test indices), `page-requests` (started rule, sheet copy, crew control,
tray), `page-dispatch` (helpers show only in their lead's column), `admin-pages` (started rule),
`docs/DISPATCH.md` §5 (move route, `/reschedule` removed, the autopilot invariant and its residual),
`replica/features.csv` rows 96/97/98/102, `replica/parity.md`, `replica/build-log.md`,
`replica/architecture.md` annotation (move route under the request, no `deltaMinutes`,
`REASSIGNABLE_STATUSES` unchanged and in `request-status.ts`, synced rules, capacity deferred), memory.
