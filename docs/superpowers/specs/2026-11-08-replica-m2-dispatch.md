# Replica M2: Dispatch, as deltas to /admin/calendar

Status: v1 DRAFT (2026-11-08), for adversarial review. Owner: Raymond Chen.
Milestone source: `replica/architecture.md` build order item 5 "M2 Dispatch, as deltas to
`/admin/calendar`" (lines 625–633), the F03 route table (lines 134–145), the reassign-guard constraint
(lines 93–95), "The parts that bite" races paragraph (lines 344–351) and the F04 ownership and status
rules (lines 146–175). Builds on M0a (visits, assignments, shifts), M3a (ownership, the 0050 trigger), M3b
(idempotency keys) and M3d (0058: a visit with a form submission is never deleted).

## 1. Goal

The office runs the day on the existing day view. Dragging a request from one arrival window to another
asks whether to match the window to the new time, keep the old window, or choose one. Moving a visit a
technician has already started (en route, arrived, working, paused or done) is refused with a 409 until
the dispatcher confirms "Move anyway", and the override is audited. A visit worked by two technicians
shows in both lanes, with crew chips on the card. Time off, non-job events and on-call shifts show as
blocks in the lane. A strip above the lanes shows each window's load (booked + held against the
technicians working it), and an office move into a full window asks first. A dispatcher can move a
technician's whole day to another day or technician, with a preview and an undo. There is no second
board: `/admin/dispatch` and the month and agenda views are untouched.

Done when (architecture.md): dragging across a window boundary prompts for the window; a working job
refuses reassignment with a 409 unless overridden; a two-tech job shows on both lanes.

Feature rows (`replica/features.csv`, row = file line):
- **96** Edit arrival window prompt on move (must) → `yes`, note "drag across a window boundary asks:
  match the new time, keep the window, or choose one; same-window and day-only moves keep the window".
- **97** Block reassign of working or done jobs (must) → `yes`, note "a started visit (en route, arrived,
  working, paused or done) refuses a move with 409 HAS_PROGRESS; Move anyway overrides and is audited".
- **98** Multi-technician and team assignment with team grouping (must) → `yes`, note "lead + helpers
  per visit; the visit shows in every crew member's lane with crew chips; no named teams (a visit's crew
  is its team, ruling 9)".
- **102** Mass reschedule (could) → `yes`, note "move a technician's day to another day and/or
  technician, with preview and a 30-second undo".
- **82** Capacity planning board (should) → `partial`, note "day-view window strip: booked + held vs
  technicians working, over-commit flagged; no buffers, overrides or booking-% threshold".
- Cut, unchanged: **100** zones (stays `partial`), **79** custom one-off window, **93** tray tabs,
  **101** late outline, **103** route view (§10).

Dev facts this spec relies on (dev branch, 2026-11-08, read-only counts):
- Open placed requests: 32 native, 83 synced (FieldPulse); all 207 synced rows are in the default org.
- Windows that are not an exact named band (8–12, 12–4, 4–8, 8–8 Eastern): 3 of 32 native open placed
  requests, 82 of 83 synced.
- Helper rows (non-lead, not cancelled): 0. Visits #2+: 2 (both cancelled). `technician_shifts`: 0 rows.
  `capacity_reservations`: 1. `customer_locations.zone` set: 0 of 16.
- Assignment rows with a progress timestamp: 5. Rows whose status is `in_progress` with no timestamp: 16
  (all synced: the trigger mirrors the FieldPulse status onto the untouched lead row, 0050:147–159).
- Native `pending` requests with an assignee: 5 (their lead rows are `pending`, which the technician app
  does not list, `ownership.ts:13-15`).
- Office-booked requests (`admin-` sessions) carrying a `fieldpulse_job_id`: 0 of 11.
- `appointments.starts_at` differs from `arrival_window_start`: 0 rows.

## 2. Surfaces

| surface | who | what |
| --- | --- | --- |
| Calendar Day view (`interactive-scheduling-calendar.tsx` `DayView` / `DayLane`, :165–332) | admin, ≥ 1024 px | crew chips and helper copies (§7.2), blocks (§7.3), window strip (§7.4), drop flow with the window prompt and the confirm dialog (§7.5, §7.6), lane menu `Move this day…` (§7.7) |
| Calendar Week view (`WeekView`, :346–415) | admin, ≥ 1024 px | the window prompt on drops (§7.9); one card per request, no helper copies, no blocks |
| Unscheduled tray (`draggable-unscheduled-panel.tsx`) | admin | drags use the same move route; a visit #2+ card can't be dropped on it (§5.6) |
| Calendar below 1024 px | admin | read-only: no drag, a notice, cards open the request sheet (§7.8) |
| Request detail sheet (`request-detail-sheet.tsx`) | admin | reassign and schedule refuse a started visit with copy pointing to the calendar (§5.7); no override there |
| `/admin/dispatch`, month, agenda, tech app | — | unchanged |

## 3. Data model

**No migration.** Every table M2 needs exists; `drizzle/0059` stays free (journal last entry `idx 58`,
`0058_m3d_forms`). The decisions below are about which existing columns carry what.

### 3.1 Arrival windows
The window is `arrival_window_start` / `arrival_window_end` on `service_requests` (`schema.ts:570-571`)
and on `appointments` (`schema.ts:707-708`). There is no `window_start` / `window_end` column anywhere.
`appointments.starts_at` / `ends_at` (`:705-706`) are written equal to the window by every writer (the
trigger, 0050:102–105; `addAppointment`, `appointment-queries.ts:163-166`; `updateAppointment`, :257);
M2 keeps them equal and does not split "planned work time" from "promised window" (dev: 0 rows differ).
Visit #1's window is written only through the request columns and mirrored by the trigger
(`service_requests_sync_appointment_upd`, 0049:221–229, fires only on a real change of `scheduled_date`,
either window end, `assigned_to` or `status`). Visits #2+ are written on `appointments` directly.

Named windows: `ARRIVAL_WINDOWS` (`arrival-window.ts:12-27`: morning 8–12, afternoon 12–4, evening 4–8,
anytime 8–8, business time). Drop targets are the three bands `RESCHEDULE_WINDOW_ROWS`
(`calendar-time.ts:329-333`); `anytime` is never a drop target, only a "Choose a window" option.

### 3.2 Started visits (the reassign guard's definition)
New `src/lib/admin/visit-started.ts` (pure + SQL twin):
- `STARTED_ASSIGNMENT_STATUSES = ['en_route', 'arrived', 'in_progress', 'completed']` (in
  `request-status.ts` beside the other lists, with the enum-coverage test updated).
- **A row is started** when `status <> 'cancelled' AND (status IN STARTED_ASSIGNMENT_STATUSES OR en_route_at
  / arrived_at / started_at / completed_at IS NOT NULL)`. *Working* = en route, arrived, in progress, or a
  pause (`on_hold` with a timestamp); *done* = `completed`. A cancelled row never counts, even with
  timestamps: after an override the demoted technician's row is cancelled-with-progress (§5.3) and must
  not lock the visit forever.
- **A visit is started** when any of its rows is started.
- Status, not timestamps alone, because the trigger mirrors request status onto an untouched lead row
  (0050:147–159): an office "Mark in progress" or a FieldPulse `in_progress` leaves a row `in_progress`
  with no timestamp (dev: 16), and architecture.md:93–95 names the guard by status.

`visit-one-guard.ts` `progressed()` (:22) and `appointment-queries.ts` `visitProgressed` (:199-201) and
`classifyMiss`'s progress probe (:222-226) switch to this definition, so the sheet, drag-to-tray, visit
PATCH and the board share one rule. `REASSIGNABLE_STATUSES` (`request-status.ts:69`) stays
`IN_FLIGHT_STATUSES`; ruling 3 says why. `removeVisitTechnician`'s per-row timestamp check
(`assignment-queries.ts:134-135`) is about one row and stays. The 0050/0058 trigger is not changed: its
`v_has_progress` decides whether a visit row may be deleted, a different question.

### 3.3 Crew
A visit's crew = its `appointment_assignments` rows with `status <> 'cancelled'` (`schema.ts:728-752`;
one lead by `appointment_assignments_one_lead_idx`; at most `MAX_TECHNICIANS_PER_VISIT = 5`,
`appointment-types.ts:29`). Helpers are added and removed by the existing M3a endpoints (`POST/DELETE
…/appointments/[aid]/assignments`, `assignment-queries.ts:61`, `:125`); M2 adds no helper writer.

### 3.4 Blocks
Shifts and non-job events are `technician_shifts` rows (`schema.ts:754-772`, kinds `on_call`,
`time_off`, `non_job`; `removes_capacity` defaults true except on call, `shift-types.ts:20-22`). No new
table: M2 only reads them for the lane. They are written on the Staff page's time-off dialog
(`time-off-dialog.tsx`, `GET/POST /api/admin/technicians/[id]/shifts`).

### 3.5 Window load ("placed + reserved")
For a business day `d` and band `b`, exactly as `computeOpenWindows` counts it (`availability.ts:127`):
- `capacity` = active technicians whose weekly hours cover the band that weekday (:150–161);
- `booked` ("placed") = how many of those covering technicians have an open request with a window, or a
  capacity-removing shift, starting on `d` and overlapping `b` (:163–177; `bookedBandsForJob`, :61);
- `reserved` ("held") = `capacity_reservations` rows for (`d`, `b`) whose request is not among the
  booked ones (:179–188);
- **over-committed** when `booked + reserved > capacity`.
The known gap (`capacity-hold.ts:71-79`; architecture.md:347–350) has two halves. (1) Office placements
never look at holds: a dispatcher can drag jobs onto every covering technician in a band that holds a
customer's online booking, sequentially, no race needed. (2) A confirm's ceiling comes from a snapshot,
so a placement between that snapshot and the reservation insert over-commits. M2 closes both for the
board's writers and the reservation insert (§5.5); writers that stay outside it are listed in §11.

`OpenWindow` (`types.ts:422`) gains `reserved?: number` (a count, like `booked`), populated by
`computeOpenWindows`. The public availability route returns `OpenWindow` verbatim
(`api/availability/route.ts:129-134`); one more count, no identity.

## 4. Concurrency: versions, keys, locks

### 4.1 Revision gate
Every board write carries the version of the visit the dispatcher saw: `appointments.version`
(`schema.ts:713`, "CAS on version, never on updated_at", architecture.md:344–346). The trigger bumps
visit #1's version on every real change of a watched request column (0050:119), so a technician's tap
(which changes request status) or another dispatcher's move invalidates a stale drag. Cards carry
`visitId` + `visitVersion` (§7.1). A tray request with no visit yet (no date, window or assignee: the
trigger deletes or never creates #1, 0050:69–94) carries `visitId: null`; its gate is "no visit #1
exists". A miss → 409 `STALE`; the board refetches.

Helper changes don't bump the version (they write `appointment_assignments` only). They don't need to:
every crew-dependent check runs in SQL against the rows present at write time (§5.2).

### 4.2 Idempotency (M3b `withIdempotency`)
The move and the mass reschedule go through `withIdempotency(scope, canonicalHash(body), run)`
(`idempotency.ts:215`), scope `(org, admin user, literal path, Idempotency-Key)`; `parseIdempotencyKey`
(:47) → missing or malformed → 400 `VALIDATION_ERROR`. The client mints a key per committed drop
(`mintKey`, `idempotency-codes.ts`) and per mass-reschedule confirm; a confirm-dialog re-send has a
different body (`override`) and a new key.
- **Why it fits:** a result lost on the network is re-sent once with the same key and body (§7.5) and
  replays the stored 200 instead of meeting `STALE` from its own write; the mass reschedule's replay
  returns the original per-visit result, which the undo needs.
- **Stored:** 2xx only. `STORED_CODES` gains nothing: every M2 refusal can change on the next try
  (`STALE`, `HAS_PROGRESS`, `SCHEDULE_CONFLICT`, `BAND_FULL`, `TIME_OFF`, `WINDOW_ENDED`,
  `MANAGED_EXTERNALLY`, `VISIT_ENDED`, `REQUEST_TERMINAL`, `TECHNICIAN_NOT_FOUND`, `NOT_FOUND`), so the
  key is released and the next drop mints a new one. `VALIDATION_ERROR` is already stored; a malformed
  body is a client bug.
- **Volume:** one `idempotency_keys` row per drop. Nothing prunes that table today (no cron touches it);
  noted in §11, not fixed here.
Drag-to-tray (`/unschedule`) stays unkeyed: it writes an absolute state, and its retry is harmless.

### 4.3 Locks
- **L_req** first in every batch: `lockRequestSql(org, rid)` (`invoice-field-writes.ts:42`, `FOR NO KEY
  UPDATE`). The mass reschedule's first statement locks all its requests: `SELECT 1 FROM service_requests
  WHERE organization_id = $org AND id = ANY($ids) ORDER BY id FOR NO KEY UPDATE`.
- **L_band** next, for each (day, band) the write lands a capacity claim in, in sorted key order:
  `SELECT pg_advisory_xact_lock(hashtextextended('m2-band|' || $org || '|' || $day || '|' || $band, 0))`
  (`bandLockSql`, `src/lib/admin/band-load.ts`). Released at commit; a neon-http batch is one transaction.
- Order is request → band → rows everywhere. `reserveCapacitySlot` takes L_band only (its request row
  may not exist yet), technician status taps take L_req only, so no cycle.

## 5. Writers

### 5.1 Who may write
Admin session only (`getAdminSession`; `verifyToken` rejects any role but `admin` / `super_admin`,
`auth/config.ts:45`). Technicians never write dispatch; no `/api/tech` route changes. Every body id is
re-read under the session org inside the write: the request, the visit (`p.service_request_id = $rid AND
p.organization_id = $org`), the technician (active, `role = 'technician'`, in the org, as
`activeTechnicianIds`, `appointment-queries.ts:63`).

**Native only.** A request with `fieldpulse_job_id` or `hcp_job_id` is refused with 409
`MANAGED_EXTERNALLY` by the move, drag-to-tray and the mass reschedule (skipped there), the M3 rule
(`ownership.ts:163`; helpers already refuse, `assignment-queries.ts:83`). Ruling 2.

### 5.2 Window resolution (`src/lib/admin/move-window.ts`, pure, shared by client and server)
Inputs: the visit's current window (or none), the drop's business day `D` and band `B`, the rule and
an optional pick.
- `currentWindowKind(start, end)` → `band` (exactly one of morning / afternoon / evening on its business
  day), `anytime` (8–8), `custom` (anything else), or `none`.
- `windowCrossing(current, B)` = the current window exists and `windowRowOfInstant(start)`
  (`calendar-time.ts:372`) ≠ `B`. An `anytime` window starts in morning; a custom 11–1 starts in morning.
- `promptPlan(current, D, B)` → `{ prompt: false, rule: 'match' }` when there is no window (tray);
  `{ prompt: false, rule: 'keep' }` when no crossing (a lane change or a day change in the same band keeps
  the window, custom ones included: today's drop rewrites a 9–11 to 8–12, which M2 stops); `{ prompt:
  true, default: 'match' }` on a crossing (design spec, `replica/design/components.md` "Arrival-window
  prompt").
- `resolveMoveWindow(current, D, B, rule, pick)`:
  - `match` → band `B` on `D` (`arrivalWindowUtcForBusinessDate`, `calendar-time.ts:311`);
  - `pick` → the picked `ARRIVAL_WINDOWS` value on `D`;
  - `keep` → the same wall-clock start and end on `D` (`businessWallClockToUtc`, `:129`, DST-correct); an
    end on the next business day stays on `D + 1`. `keep` with no current window → 400 `VALIDATION_ERROR`
    `{ path: ['windowRule'] }`.
- The server recomputes from the stored window it read (the CAS proves it didn't change); the client's
  copy is for the prompt text and the optimistic card only.
- **Ended windows:** when the resolved window differs from the current one and its end ≤ now → 400
  `WINDOW_ENDED` (`WINDOW_ENDED_MESSAGE`, `window-ended.ts:9`, as `POST …/appointments` does, its
  route.ts:93-94). A lead change that keeps an ended window is allowed (fixing who did a past job).

### 5.3 `moveVisit` (`src/lib/admin/visit-move.ts`)
Input `{ requestId, visitId | null, expectedVersion | null, day, band, windowRule, pick?, technicianId?,
override: ('started' | 'conflict' | 'band_full')[] }`. `technicianId` = the new lead; absent or equal to
the current lead = keep. Dropping on the Unassigned lane never unassigns (today's rule,
`interactive-scheduling-calendar.tsx:561-573`).

**Pre-read** (one query): the request (status, native, assignee), visit #1 or the given visit (number,
version, window, `cancelled_at`, ended per `visitEndedSql`, `current-visit.ts:44`), its crew rows with
the started flag. Hard refusals in this order: not in org → 404; synced → `MANAGED_EXTERNALLY`; request
`completed` / `cancelled` → `REQUEST_TERMINAL`; visit cancelled or ended → `VISIT_ENDED`; version ≠
expected → `STALE`; new lead not an active technician in the org → `TECHNICIAN_NOT_FOUND`; resolved window
ended → `WINDOW_ENDED`. Then the checks, all computed for the **crew after the move** (new lead + the
other non-cancelled rows; a new lead who was a helper is counted once):
1. **Time off** (hard, never overridable, `TIME_OFF`): a capacity-removing shift of any crew member
   overlaps the resolved window (`noTimeOff`, `appointment-queries.ts:76`).
2. **Started** (`needs: 'started'`): the lead changes and the current lead's row is started; or the
   window changes and any crew row is started. A lead swap with only a helper started and the window
   unchanged needs nothing (the helper keeps working).
3. **Conflict** (`needs: 'conflict'`): for each crew member, an open row (`OPEN_ASSIGNMENT_STATUSES`,
   `ownership.ts:13-15`) on another live visit of an open request overlapping the resolved window
   (half-open, as `checkScheduleConflict`, `scheduling-queries.ts:237`); or the window is outside the
   new lead's hours (span version of `isWindowWithinAvailability`, `availability-coverage.ts:88`: M2
   exports a span variant over the private `spanIsCovered`, :56). Visits, not request columns, so helpers
   and visits #2+ are seen.
4. **Window full** (`needs: 'band_full'`, §5.5): only when the move lands a new capacity claim.
Any `needs` not in `override` → 409 (code = `HAS_PROGRESS` if `started` is among them, else
`SCHEDULE_CONFLICT`, else `BAND_FULL`) with `details: { needs, started?: [{ technicianId, status }],
conflicts?: [{ id, referenceNumber, technicianId, arrivalWindowStart, arrivalWindowEnd }],
outsideAvailability?, band?: { day, band, capacity, booked, reserved } }`. Ids, enums and counts only;
the client names technicians from the board it already has. Nothing is written.

**Batch, visit #1** (the request columns; the trigger mirrors them):
0. L_req; 1. L_band for each band the claim lands in;
2. `UPDATE service_requests SET assigned_to = $lead, scheduled_date = $start, arrival_window_start =
   $start, arrival_window_end = $end, status = <status CASE>, updated_at = now() WHERE id = $rid AND
   organization_id = $org AND fieldpulse_job_id IS NULL AND hcp_job_id IS NULL AND status NOT IN
   ('completed','cancelled') AND <version gate> AND NOT <visit #1 ended> AND <time off, every crew member>
   AND (<'started' overridden> OR NOT <started arm>) AND (<'conflict' overridden> OR <no conflict, every
   crew member>) AND (<'band_full' overridden> OR <band guard>) RETURNING id, status`. Every guard is the
   SQL twin of a pre-read check, so a change between the read and the write misses instead of landing.
   Status CASE: `pending` with a lead → `assigned` (the technician app hides `pending`; dev has 5 such
   native requests; `create-request-queries.ts:375-387` already flips on office booking); a lead change
   overriding a started lead, while `status IN ('en_route','arrived','in_progress')` and no other crew row
   stays started → `scheduled` (the new lead hasn't started; `en_route → scheduled` is a listed edge,
   `request-status.ts:33`); otherwise unchanged.
3. The new lead's row: `UPDATE appointment_assignments SET status = 'assigned' WHERE appointment_id =
   <visit #1> AND technician_id = $lead AND is_lead AND status IN ('en_route','arrived','in_progress')
   AND no timestamps AND <request xmin gate>`: the trigger's step 3 inserts the new lead with the request
   status (0050:134–137), which would read as started without the technician doing anything.
4. When a started lead was overridden off: `closeJobEntriesSql({ technicianIds: [old lead],
   appointmentId: <visit #1>, gate: <request xmin gate> })` (`time-entry-sql.ts:34`). The trigger demotes
   the old row to `cancelled` keeping its timestamps (0050:130–133; `completed` stays `completed`), so the
   technician still reads the job (`techCanReadSql`, `ownership.ts:169-171`) and their time stops.
5. Holds (§5.5): with a lead → `DELETE FROM capacity_reservations WHERE organization_id = $org AND
   service_request_id = $rid AND <gate>`; without a lead and with a hold → the hold moves to the new (day,
   band) at the lowest free ordinal.
6. `INSERT INTO audit_log … SELECT … WHERE EXISTS (SELECT 1 FROM appointments p WHERE p.service_request_id
   = $rid AND p.appointment_number = 1 AND p.xmin = pg_current_xact_id()::xid)` (the trigger wrote #1 in
   this transaction; the M3c `equipment-writes.ts:84` pattern).
`<request xmin gate>` = `EXISTS (SELECT 1 FROM service_requests r WHERE r.id = $rid AND r.xmin =
pg_current_xact_id()::xid)`.

**Batch, visit #2+** (written directly; the request columns describe #1 and are not touched):
0. L_req; 1. L_band; 2. `UPDATE appointments SET scheduled_date, starts_at, ends_at, arrival_window_start,
   arrival_window_end, version = version + 1, updated_at = now() WHERE id = $vid AND organization_id =
   $org AND service_request_id = $rid AND appointment_number > 1 AND version = $v AND cancelled_at IS NULL
   AND <request native, not terminal> AND <the same guards> RETURNING id`;
3. lead swap gated on `landed()` (`appointment-queries.ts:89-91`), the trigger's step 3 written for this
   visit: delete the old lead row when it has no timestamps, else `is_lead = false, status = CASE WHEN
   status = 'completed' THEN status ELSE 'cancelled' END`; then `INSERT … (is_lead true, status
   'assigned') ON CONFLICT (appointment_id, technician_id) DO UPDATE SET is_lead = true` (a helper keeps
   its status);
4. when a started lead was overridden off and this visit is the request's active visit
   (`activeVisitIdSql`, `current-visit.ts:33`): the same request status reset as #1, gated on `landed()`;
   and the old lead's open entries on this visit closed;
5. audit, gated on `landed()`.
Visits #2+ never touch holds (holds belong to the booking, i.e. visit #1).

**Zero rows** → re-read in the pre-read's order and answer the first failing code; a guard that now fails
answers its 409 with fresh `details`; nothing failing → `STALE`. A deadlock (`isDeadlock`,
`status-writes.ts:53`) also answers `STALE`, as the request PATCH does.

**After the batch** (best-effort, as `placeAndAssignRequest` does today, `scheduling-queries.ts:843-868`):
`recordStatusEvent` for each request status change (pending → assigned: actor human, the first-response
KPI's first assignment; started reset → scheduled: actor human); `stampDispatchOverride(org, rid, lead,
user)` when a lead is set (`dispatch-override.ts`); for visit #1 only, `after(() =>
syncRequestToCalendar(...))` and `after(() => pushJobToHcp(...))`, the same two calls the drag route
makes today (`reschedule/route.ts:184`, `:189`). No customer or technician message is sent (§10).

Success → 200 `{ visitId, visitVersion, requestStatus, arrivalWindowStart, arrivalWindowEnd, leadId,
overrides }`.

**Audit** `visit_moved`, entity `appointment`, entityId the visit: `{ requestId, appointmentNumber,
fromTechnicianId, toTechnicianId, windowRule, window: 'morning' | 'afternoon' | 'evening' | 'anytime' |
'custom', dayChanged, overrides, startedStatuses, conflictCount, outsideAvailability, bandFull }`. Ids,
enums, booleans and counts only (the M3 audit rule; no window instants, which with a reference number
would place a customer at an address and time).

### 5.4 Drag-to-tray (`/unschedule`, `unscheduleRequest`, `scheduling-queries.ts:916`)
Unchanged except: refuses synced requests (`MANAGED_EXTERNALLY`, one predicate in its guarded UPDATE and
the classifier), and its started check is §3.2's through `visitOneGuardSql`. Only visit #1 cards may be
dropped on the tray; a visit #2+ card dropped there does nothing and shows "Visit #2 can't go back to
the tray. Cancel it in the request's Visits section." A visit #1 with a form submission keeps its visit
row (0058's trigger predicate; M2 deletes no visit anywhere).

### 5.5 Window load guard and the reservation insert (`src/lib/admin/band-load.ts`)
Pure, extracted from `computeOpenWindows` without changing its output: `coveringTechnicians(activeIds,
availability, day, band)` and `bandsTouched(start, end, day)` (`bookedBandsForJob`, `availability.ts:61`,
exported). SQL twins, parameterised by the covering ids (a JS read of `technician_availability`, which
only Settings changes):
- `bandBookedSql(org, day, band, coveringIds, excludeRequestId)` = count of distinct technicians among
  `coveringIds` with an open request (`OPEN_STATUSES`) or a capacity-removing shift whose start is on `day`
  (business time) and which overlaps the band (an end at or before the start, or past midnight, read as end of day, as
  `availability.ts:76-79`);
- `bandReservedSql(org, day, band, coveringIds, excludeRequestId)` = holds on (`day`, `band`) whose request
  is null or not counted by `bandBookedSql`.
**When a move lands a new claim:** for each band its new window touches, the new lead covers it, isn't
already counted there by another job, and this request wasn't already counted there (a same-band lane
change to a free technician is a new claim; keeping the band and the lead is not). The guard: `booked +
reserved + 1 <= capacity`. A lead outside the band's covering set adds no claim (it's an availability
conflict instead). Moving to the Unassigned lane lands a claim only by moving an existing hold.

**`reserveCapacitySlot`** (`capacity-reservation-queries.ts:50`) gains the guard on the other side: it
reads the covering ids, then runs `db.batch([bandLockSql, INSERT … SELECT … WHERE bandBookedSql +
bandReservedSql < $capacity ON CONFLICT DO NOTHING RETURNING id])` per ordinal; `capacity` is a new
parameter from the caller's snapshot (`create-request-queries.ts:183`, `submit-session-request.ts:111`
pass `match.capacity`). Its contract stays "never throws; null = soft booking". With both sides taking
L_band and re-counting in SQL, a placement and a hold for the same band serialise and the second sees
the first.

DB scheduling source only (`DbSchedulingSource`, `scheduling-source.ts:72`): an HCP-sourced org's
capacity comes from Housecall Pro, so its moves skip the guard and its reservations keep today's path
(as shifts are ignored for HCP sources, page-calendar skill). The guard's own commit and test group, so
reverting M2 can keep or drop it on its own.

### 5.6 Mass reschedule (`src/lib/admin/mass-reschedule.ts`)
"Move a technician's day": every visit on business day `D` whose lead is technician `T`, to day `D2`
and/or lead `T2`, keeping each window's wall-clock times (`keep`, §5.2). No `deltaMinutes`
(architecture.md:144): minute shifts make custom windows off the bands the capacity model counts;
ruling 7.
- **Preview** (read-only): each candidate with `moves` or `skipped: started | synced | ended | time_off |
  window_ended | already_on_visit | stale` and soft flags `conflict`, `band_full`. Helper copies are not
  candidates (their visit moves with its lead). `already_on_visit` = `T2` already on that visit, refused
  so the undo is exact.
- **Commit** `{ technicianId: T, fromDate: D, toDate: D2, toTechnicianId?: T2, visits: [{ visitId,
  expectedVersion }] (1–30), overrideSoft: boolean }`, keyed. One batch: L_req over all requests (sorted),
  L_band over all touched bands (sorted), then one guarded UPDATE per visit (the §5.3 statements, each
  with its own version gate, lead gate `= T` and guards; `started` is never overridable here), then one
  audit row. Each visit lands or misses independently inside the transaction. `overrideSoft` overrides
  `conflict` and `band_full` for every visit; without it those visits are skipped.
- Result `{ moved: [{ visitId, requestId, visitVersion }], skipped: [{ visitId, reason }] }`; reasons for
  zero-row misses come from a re-read after the batch.
- **Undo** = the inverse commit built by pure `undoBody(result, input)`: `{ technicianId: T2 ?? T,
  fromDate: D2, toDate: D, toTechnicianId: T2 ? T : undefined, visits: moved with their new versions,
  overrideSoft: false }`, a new key. A visit changed since (new version) is skipped `stale`; a clash
  the original move created for someone else asks again. Offered for 30 s.
- Audit `dispatch_mass_rescheduled`, entity `user`, entityId `T`: `{ toTechnicianId, dayShift (whole
  days), movedCount, skippedCount, skippedReasons: { reason: count }, overrideSoft, undo: boolean }`.

### 5.7 The sheet
`reassignTechnician` (`queries.ts:662`), `assignTechnician` (:506), `scheduleRequest` (:914) and
`updateAppointment` keep their writers and gain §3.2's started rule through the shared guard; no override
in the sheet. Their `HAS_PROGRESS` copy becomes "A technician has started this visit. To move it anyway,
drag it on the calendar." (`visitOneRefusalResponse`, `visit-one-guard.ts:59-62`, gains a context
argument; the tray and the move route keep their own copy, §8). The sheet still edits synced requests
and pushes the schedule to FieldPulse (`requests/[id]/route.ts:382-386`); ruling 2.

## 6. Routes (all `force-dynamic`, admin session, logs carry codes and ids only)

| route | gate | success |
| --- | --- | --- |
| `GET /api/admin/calendar` (exists, `calendar/route.ts`) | unchanged, `adminRead` | day/week payload gains §7.1 fields; day view also `blocks`, `bands` |
| `POST /api/admin/requests/[id]/move` (new) | `isUuid`, `admin:visit-move:<user>` `adminMutation`, `readJsonBody`, zod, Idempotency-Key | 200 §5.3 |
| `POST /api/admin/requests/[id]/unschedule` (exists) | + synced refusal | unchanged |
| `POST /api/admin/dispatch/mass-reschedule/preview` (new) | `admin:mass-reschedule:<user>` `adminRead`, zod (`fromDate`, `toDate` real ISO dates within today − 1 … today + 365, `isRealIsoDate`; technician ids `isUuid`) | 200 `{ candidates }` |
| `POST /api/admin/dispatch/mass-reschedule` (new) | `adminMutation`, zod, Idempotency-Key | 200 §5.6 |
| `POST /api/admin/requests/[id]/reschedule` | **removed** with its test (the board was its only caller, `use-reschedule-job.ts:99`); `useRescheduleJob` keeps `unschedule`, `reschedule` moves to `useMoveVisit` | — |

The move route lives under the request, not `appointments/[id]/move` (architecture.md:139), because a
tray request may have no visit yet. Body ids are lowercased before comparison. 400 bodies are
`VALIDATION_ERROR` with `details.path`, never zod text.

## 7. Client

Admin primitives and tokens (`src/components/admin/ui/`, `status-colors.ts`), sentence case, "request",
no `err.message`. Pure helpers carry the logic (no jsdom).

### 7.1 Board data (`getSchedulingCalendar`, `queries.ts:1661`)
After `mergePlacedRows` (:1573), one more query reads, for the displayed visit of every placed and tray
card (visit #1 for `request` placements; the office visit otherwise), `appointments.id`, `version` and
its rows `{ technicianId, isLead, status, timestamps }` joined to `users` (`name`, `is_active`), org-scoped.
Cards gain `visitId: string | null`, `visitVersion: number | null`, `crew: [{ technicianId, name,
isLead, state: 'open' | 'working' | 'done' }]` (non-cancelled rows; inactive technicians' names withheld
as `dashboardRequestSelect` does, :1263-1267), `started: boolean`, and per lane `laneRole: 'lead' |
'helper'`. Day view adds `blocks: [{ id, technicianId, kind, title, startsAt, endsAt, removesCapacity }]`
(new `listShiftsInRange(org, start, end)`, all kinds, `shift-queries.ts`) and `bands: OpenWindow[]` for
the day (`getOpenAvailability(org, [day])`, `availability-queries.ts:113`). `queries.test.ts`'s mock
order: the new queries run after the existing five, so the calendar's visit feed stays index 4.

### 7.2 Lanes and crew (Day view)
- A card renders in its lead's lane (as today) and, as a **helper copy**, in each helper's lane (active
  technicians with a lane). Pure `laneCards(placed, crew)` builds both. Helper copies: `laneRole:
  'helper'`, not draggable, a "Helping <lead first name>" line under the customer; tap opens the sheet.
  React keys `${requestId}:${technicianId}`.
- **Crew chips** (`crew-chips.tsx`) on the card's top row: initials in `font-mono` 16 px circles, the lead
  first with the `marker` border, `working` filled with the in-progress token, `done` with a check; more
  than 3 → `+N`; each chip has `title` and an `aria-label` with the full name and state. Compact (week):
  the count only ("2 techs" in mono).
- **Started cards** show a lock icon (title "Started. Moving it asks first."); still draggable: the
  server decides and the confirm dialog overrides. Synced cards are not draggable (`syncedSource` set;
  title "Managed in FieldPulse" / "Managed in Housecall Pro").
- Visit #2+ cards become draggable (today pinned, :224); visit-ended cards stay pinned.
- Lane header counts lead cards and helper copies (the technician's load); ended visits still skipped
  (`liveJobCount`, :127).
- `applyOptimisticReschedule` / `currentScopeOf` (`calendar-optimistic.ts:58`, :85) key by `visitId` and
  move every copy: the lead copy to its new lane, helper copies re-timed, a new lead's old helper copy
  removed. Rolled back as today.

### 7.3 Blocks
`lane-blocks.tsx` draws each block behind the cards, positioned by `placeJobInLane`: `time_off` and
`non_job` hatched (`bg-surface-sunken`, the design spec's non-job kind) with the title or "Time off" /
"Non-job event"; `on_call` a 3 px left rail with "On call" in its title. Not interactive. A band fully
covered by a capacity-removing block gets `outOfHours`-style shading plus "Time off" in its accessible
name and is not droppable (`useDroppable({ disabled })`); a partly covered band stays droppable and the
server answers `TIME_OFF` (the existing no-override `ConflictDialog` path).

### 7.4 Window strip
Above the lanes, one row per band from `bands` (pure `bandStripText`): "Morning · 2 of 3 booked · 1
held", "Afternoon · full", "Evening · over by 1" (`ring-1 ring-signal`, the design spec's alert overlay),
"Evening · no technicians" when capacity is 0. Numbers in mono. The strip is a reading of the same counts
the bot offers customers; it refreshes with the 30-second poll.

### 7.5 Drop flow (`handleDragEnd`, `interactive-scheduling-calendar.tsx:534`)
1. Tray drop → §5.4 (visit #2+ refused client-side with its line).
2. Band drop: `promptPlan(current, day, band)`; no change at all (same lane, same band, same day) →
   nothing.
3. `prompt: true` → the window prompt opens **before** anything moves; Escape or Cancel → nothing moved.
4. Then the optimistic move with `resolveMoveWindow`, then `POST …/move` with a fresh key.
5. 200 → refetch. 409 with `needs` → roll back, open the confirm dialog (§7.6) holding the body; "Move
   anyway" re-sends with `override = needs` and a new key. `TIME_OFF` → the existing dialog without
   override. Other codes → roll back, status banner with §8 copy, refetch.
6. Network failure or 5xx → re-send once with the same key and body; 200 (replayed) → keep; 409
   `IN_PROGRESS` → wait `Retry-After`, re-send once; otherwise roll back, "Couldn't move the request.
   Please try again.", refetch (the refetch shows whether it landed).
The 30-second poll may replace the board while a dialog is open; the dialog keeps its body, and a stale
version answers `STALE`.

### 7.6 Window prompt and confirm dialog
- **Prompt** (`window-prompt-dialog.tsx`, `Dialog`, radio group, first option focused): title "Arrival
  window"; description "Moving <customer> · <ref> to the <band>."; options "Match the new time · 12:00
  PM – 4:00 PM" (default), "Keep 9:00 AM – 11:00 AM" (+ " on Wed, Nov 11" when the day changes), "Choose
  a window" with a `Select` (Morning 8:00 AM – 12:00 PM, Afternoon 12:00 PM – 4:00 PM, Evening 4:00 PM –
  8:00 PM, Anytime 8:00 AM – 8:00 PM; `selectLabel` formatter; options that would end in the past are
  disabled "Already ended"). Footnote: "The customer isn't told about this change." Buttons "Move" /
  "Cancel".
- **Confirm** (`ConflictDialog` generalised, `conflict-dialog.tsx`): title "Move anyway?"; one block per
  need (§8); buttons "Cancel" and "Move anyway" (destructive, "Moving…" while sending).

### 7.7 Mass reschedule
Lane header `⋯` button (`aria-label="More for <name>"`) → menu `Move this day…`. Dialog title "Move
<name>'s requests on Tue, Nov 10": `To day` (date input, default the next business day), `To
technician` (`Select`, default "Same technician"), then the preview list (rows "9:00 AM – 11:00 AM ·
<customer> · <ref>" with "Moves" or the skip reason), a checkbox "Move them even where they overlap or
the window is full" when any soft flag shows, primary "Move N requests" (disabled at 0). After success
the page status banner (`CalendarStatus`, `calendar/page.tsx:47`, gains an optional action) shows "Moved
3 requests to Wed, Nov 11." + `Undo` for 30 s; undo shows "Moved 3 requests back." or what it skipped.

### 7.8 Below 1024 px
Pure `boardInteractive(width)`; a `useMinWidth(1024)` hook (`matchMedia`, false until mounted; the board
is `ssr: false`). Read-only: no `DndContext` sensors, no lane menu, crew chips and blocks still shown,
a notice above the board "Moving requests needs a wider screen. Tap a request to open it." Today's touch
drag is removed below 1024 px: 224 px lanes, the prompt and the confirm don't fit, and horizontal scroll
competes with drag.

### 7.9 Week view
All columns stay under the unassigned scope (no technician change). The prompt applies; a drop on
another day in the same band keeps the window's times. One card per request (helper copies excluded by
`laneRole`). No blocks, no strip.

## 8. Copy

| where | copy |
| --- | --- |
| Confirm · started (lead change) | "<Alex Rivera> is in progress on this visit." / "…is en route to this visit." / "…has arrived." / "…is paused on this visit." / "…is done with this visit." then "<Alex> comes off the visit and their time on it stops. <Sam> becomes the lead." |
| Confirm · started (time change) | "<Alex Rivera> is in progress on this visit. Their visit moves to 12:00 PM – 4:00 PM." (one line per started crew member) |
| Confirm · conflict | "Overlapping requests:" + the existing rows (`conflict-dialog.tsx:88-106`), each prefixed with the technician's first name when more than one crew member; out-of-hours line unchanged |
| Confirm · window full | "Afternoon on Tue, Nov 10 is full: 3 technicians working, 2 booked, 1 held for a request without a technician." |
| Codes (banner) | STALE "This request changed. The calendar has been refreshed." · MANAGED_EXTERNALLY "This request is managed in FieldPulse. Change it there." / "…in Housecall Pro…" · VISIT_ENDED "This visit has ended. Add a new visit instead." (existing) · REQUEST_TERMINAL "This request is completed, so it can't be moved." / "…cancelled…" · TECHNICIAN_NOT_FOUND "That technician isn't active any more." · WINDOW_ENDED `WINDOW_ENDED_MESSAGE` · IN_PROGRESS "Still saving the last move. Try again in a moment." · other "Couldn't move the request. Please try again." |
| Tray | started "A technician has started this visit, so it can't go back to the tray." · visit #2+ "Visit #2 can't go back to the tray. Cancel it in the request's Visits section." |
| Sheet | HAS_PROGRESS "A technician has started this visit. To move it anyway, drag it on the calendar." |
| Mass skip reasons | started "Started" · synced "Managed in FieldPulse" · ended "Visit ended" · time_off "Time off that day" · window_ended "That time has passed" · already_on_visit "<Sam> is already on it" · stale "Changed since you opened this" · soft: "Overlaps another request" · "Window full" |
| Strip / blocks / notice | §7.3, §7.4, §7.8 |

Dates in the business timezone (`BUSINESS_TIME_ZONE`, `calendar-time.ts:27`), times via
`formatBusinessTimeRange`. Canon: request / technician / cancelled / Unicode … and “ ” / sentence case.

## 9. Tests

No jsdom/RTL; component logic lives in pure helpers. Capture the vitest baseline first.

**Pure:** `rowStarted` (each status; cancelled-with-timestamps not started; paused `on_hold` with a
timestamp started; mirrored `in_progress` without timestamps started); `currentWindowKind`;
`windowCrossing` (anytime and custom start in morning); `promptPlan` (tray, same band, day only, custom
same band, crossing → match default); `resolveMoveWindow` (match, pick each window, keep across days,
keep across the 2027-03-14 DST start, keep with an end past midnight, keep with no window → error);
`moveNeeds` (lead change with started lead; time change with a started helper; lead swap with only a
helper started → none; new lead who was a helper counted once); `bandsTouched` = `bookedBandsForJob`;
`coveringTechnicians` (and `computeOpenWindows` output identical before and after the extraction on the
existing fixtures); `reserved` populated; `bandStripText` (booked, held, full, over, no technicians);
`laneCards` (lead + helper copies, inactive helper skipped, week excludes copies); optimistic move by
`visitId` with copies; `undoBody`; mass candidate classification; `boardInteractive`; copy builders for
§8.

**SQL renders (`PgDialect`):** the move batches start with `lockRequestSql`, then `bandLockSql` in sorted
order; every table carries `organization_id`; the version gate (null → no visit #1); the status CASE;
the new-lead row reset and the entries close gated on the request xmin; the #2+ lead swap gated on
`landed()`; the audit insert gated on xmin; `bandBookedSql` / `bandReservedSql` mirror
`bookedBandsForJob` (day filter, end clamp); `reserveCapacitySlot`'s batch is `[bandLockSql, guarded
INSERT]`; `visitOneGuardSql` and `visitProgressed` use `startedRowSql`; the unschedule guard has the
native predicate.

**Route tests:** every code and its order; 400 on a missing key, a non-UUID id, `keep` without a window;
replay returns `replayed: true`; a reused key with a different body → 422; synced → 409 before any
other check; 409 `details` contain only ids, enums, counts and window instants of the conflicting
request (no names); preview and commit reject a 31st visit; the removed `/reschedule` path returns 404;
`unschedule` refuses synced; tech cookie → 401 on every new route.

**Integration (`tests/integration/dispatch-board.test.ts`, `VITEST_INTEGRATION=1`, dev DB, throwaway
orgs by SQL via `createOrgCore`, never the FieldPulse-connected default org):**
(a) window: a native request 9–11 on Alex → move to Sam's lane keeping the band → 9–11 kept; match to
afternoon → 12–4; pick anytime; keep to another day → 9–11 that day; a match to an ended band today →
WINDOW_ENDED; a lead change keeping an ended window → 200;
(b) done-when, working: Alex taps en route (through `status-writes`) → move to Sam → 409 HAS_PROGRESS
`needs: ['started']` → override → Sam is lead with `assigned`, Alex's row `cancelled` with `en_route_at`
kept, request `scheduled`, Alex's open time entry closed, one audit row with `overrides: ['started']`, one
status event `en_route → scheduled`; Alex still reads the job; Sam's technician list shows it;
(c) done: Alex taps done (request still `in_progress`) → time move → 409 → override → Alex's row stays
`completed`;
(d) helper working, lead untouched → lead swap without override → 200, helper row unchanged, request
status unchanged; time move → 409;
(e) mirrored only: office `PATCH` status `in_progress` → board move → 409; sheet reassign → 409
HAS_PROGRESS with the sheet copy;
(f) synced (`fieldpulse_job_id` set by SQL) → move, unschedule → MANAGED_EXTERNALLY; mass → `synced`;
(g) concurrency: two moves from one version on two connections → one 200, one STALE; same key and body
after a 200 → replay, one audit row; same key, other body → 422; a technician tap between render and drop
→ STALE;
(h) multi-assignee, done-when: a helper added by `addVisitTechnician` → calendar GET puts the card in
both lanes with `laneRole` lead / helper and both crew chips; lane counts include it; drop the lead
card on the helper's lane → the helper is lead, the old lead row deleted; a time move where the helper
has time off → TIME_OFF; where the helper is double-booked → SCHEDULE_CONFLICT naming the helper;
(i) visit #2: drag moves the appointment row only, request columns unchanged, version + 1; lead swap on
#2 keeps helpers; stale version → STALE;
(j) pending: a `pending` request with Alex dropped on Alex's lane → `assigned`, lead row `assigned`,
status event pending → assigned;
(k) window load: two covering technicians, one hold, one booked → a move landing the third claim →
BAND_FULL with `{ capacity: 2, booked: 1, reserved: 1 }`; override → 200; a reservation insert and a
move racing on two connections → `booked + reserved <= capacity` afterwards unless the move overrode;
`bandBookedSql` / `bandReservedSql` equal `computeOpenWindows` on the same rows (time off, a custom
window across two bands, a hold for a placed request); an unassigned held request moved to another band
→ its hold moves;
(l) blocks: a time-off, a non-job and an on-call shift → day GET `blocks` lists all three; a band fully
inside time off is reported covered;
(m) mass: Alex's day with 2 movable visits, 1 started, 1 synced and 1 helper copy → preview reasons;
commit to tomorrow → 2 moved with wall-clock times kept, one audit row; undo → back; a second undo
attempt after Sam moved one → that one `stale`; same key replay returns the original result;
(n) M3d: a visit #1 with a form submission dragged to the tray → the visit row survives (times null,
lead demoted), the request is in the tray; no M2 path deletes a visit;
(o) tenancy: another org's request, visit and technician ids → 404 / TECHNICIAN_NOT_FOUND; mass with
another org's technician → 404;
(p) audit rows carry ids, enums, booleans and counts only.

**Browser walk** (1440 × 900; throwaway org via a `scripts/agent/m2-walk.mts` modelled on `m3d-walk.mts`;
everything by SQL; mint the admin session with `MINT_ORG_ID` and assert the org; queue guard before,
zero `communication_jobs` after). Data: Alex and Sam with Mon–Fri hours; a 9–11 request on Alex; a
two-technician request (Alex lead, Sam helper) in the afternoon; a request whose lead row Alex has
`en_route_at` stamped; Sam's time off 4–8 PM; one hold in the morning. Drag with Playwright mouse
events (dnd-kit `PointerSensor` needs > 6 px before it activates, :507-509): `mouse.move` to the card
centre, `down`, move 10 px, then `move` to the target band centre with `steps: 12`, `up`, then wait for
the dialog. Walk: Day view shows the two-technician card in both lanes with two chips, Sam's evening
hatched "Time off", the strip "Morning · 1 of 2 booked · 1 held" → drag the 9–11 card from morning to
afternoon → prompt, default Match → Cancel → nothing moved → drag again → Keep → 9–11 → drag again →
Match → 12–4 → drag the en-route card to Sam → "Move anyway?" with "Alex is en route to this visit." →
Cancel → unchanged → again → Move anyway → the card in Sam's lane, Alex's chip gone → Week view: drag a
card to the next day, same band → no prompt → `Move this day…` on Alex → preview (started and helper
reasons shown) → Move → banner → Undo → back → resize to 390: notice, no drag, a tap opens the sheet.
Screenshots at each step; look at them.

## 10. Out of scope

- Zones (row 100): needs a zones list, a technician zone, a location picker and a board filter; nothing
  in the done-when depends on it. Capacity adjustments, buffers and booking-% thresholds (row 82's rest):
  they change the availability the bot offers customers and need a table (0059) and their own review.
- Named teams and team grouping on the board (ruling 9); skills (row 99); tray tabs (93); late outlines
  (101); route view and sequencing (103); a custom one-off window picker (79).
- Moving synced requests on the board; any new FieldPulse or Housecall Pro write.
- Telling the customer or the technician about a move (no message, no push); the office tells them.
- Adding or removing helpers by drag (the sheet's Visits section does it); dragging helper copies;
  resizing a card to change the window; arrow-key 15-minute moves.
- `/admin/dispatch` (no second board), month and agenda views; blocks and the strip in the week view.
- Editing shifts on the board; repeating shifts.
- Pruning `idempotency_keys`.
- `deltaMinutes` mass shifts; mass reschedule of more than 30 visits; mass moves of visits #2+ where `T`
  is only a helper.

## 11. Rulings and things not verified

Rulings:
1. The window is `arrival_window_*`; `starts_at/ends_at` stay equal to it. The prompt fires on a drop
   that crosses from the window's starting band to another band; same-band and day-only moves keep the
   window's wall-clock times, custom ones included; default Match on a crossing.
2. Synced requests (`fieldpulse_job_id` or `hcp_job_id`) are read-only on the board and refused by the
   move, the tray and the mass move. The nightly FieldPulse sync rewrites `assigned_to`, both window ends
   and status (`fieldpulse/import/jobs.ts:528-536`), and the drag route never pushed to FieldPulse
   (`reschedule/route.ts:184-189`), so a drag on a FieldPulse job was undone overnight. Consequence, by
   the same native rule the tech app uses: a request the app pushes to FieldPulse or Housecall Pro
   becomes read-only on the board too (dev: 0 of 11 office bookings carry a FieldPulse id). On the
   default dev org most placed cards are synced (83 of 115 open placed).
3. Started = a non-cancelled row en route, arrived, working, paused or done, by status or timestamp; one
   definition for the board, the sheet, the tray and visit PATCH. `REASSIGNABLE_STATUSES` is not
   narrowed (architecture.md:95 asked for it): the visit guard already covers every status it would
   remove, and narrowing would also refuse a request whose lead is untouched but whose status a helper
   drives.
4. The override exists only on the board (desktop). A lead change past a started lead demotes that row
   to `cancelled` with its timestamps (the trigger's existing step 3), closes their open time on the
   visit, starts the new lead at `assigned`, and resets the request to `scheduled` when nobody else on
   the visit is started. A time change leaves every row as it is.
5. CAS on `appointments.version`; `withIdempotency` on the move and the mass move, 2xx stored only; L_req
   then L_band.
6. A drop moves the lead; adding a helper stays in the sheet. A visit shows in each crew member's lane;
   helper copies are not draggable. A drop on a helper's lane makes them lead and takes the old lead off
   the visit.
7. Mass reschedule moves a technician's lead visits from one day to another day and/or technician,
   keeping times; started visits are never overridden in bulk; undo is the inverse move, CAS-gated, for
   30 s. No `deltaMinutes`.
8. "Placed + reserved" = `computeOpenWindows`' `booked + reserved` against `capacity`; board moves and
   reservation inserts both take L_band and re-count in SQL; over → 409 `BAND_FULL`, overridable.
9. Row 98's "team grouping" is read as the visit's crew; named teams are not modelled. Row 98 → `yes`
   on that reading; the reviewer may prefer `partial`.
10. No migration; blocks are the existing `technician_shifts`. Rows 82 partial, 100 cut, 102 in.
11. Below 1024 px the board is read-only.

Not closed by M2 (stated, not fixed):
- Writers outside L_band can still over-commit a window: the office booking with a technician
  (`placeAndAssignRequest` from `create-request-queries.ts:346`), the sheet's assign / schedule, the
  autopilot (it places into its own held band, net zero for the band), visit #2+ PATCH, the FieldPulse
  sync. The strip shows any over-commit they cause.
- The capacity model counts request leads only: visits #2+ and helpers don't consume window capacity
  (pre-existing; `getScheduledJobsForRange`, `scheduling-queries.ts:292`, reads requests).
- A capacity-removing shift counts only on the business day it starts (`bookedBandsForJob`); the SQL twin
  mirrors it for parity.
- `idempotency_keys` grows by one row per drop; nothing prunes it.

Verified in this spec's research: the column names (§3.1); 0 rows with `starts_at` ≠ window; the dev
counts in §1; `/reschedule` has one caller; technicians can't hold an admin session.

Not verified (plan or build):
- `pg_advisory_xact_lock` inside a neon-http `db.batch` holds until commit and serialises two batches
  (integration (k) proves it before anything relies on it).
- Playwright mouse drags against dnd-kit's `closestCenter` with `restrictToWindowEdges` land on the
  intended band at 1440 (the walk asserts the dropped band from the prompt text).
- Five technician lanes plus Unassigned at 1440 with the tray open; more lanes scroll as today.
- The extra crew query and the day-view `getOpenAvailability` call stay inside the calendar's latency
  budget (measure the day GET before and after on dev).

## 12. Review focus (for the plan and code reviews)

- The started definition and its three call sites; the cancelled-with-timestamps exclusion.
- The visit #1 batch: the trigger's step 3 under a lead change past a started lead; the new-lead row
  reset; the entries close; the status CASE; the xmin gates.
- The #2+ lead swap matching the trigger's semantics.
- Every guard in the UPDATE matching its pre-read twin; the zero-row re-read order.
- `bandBookedSql` / `bandReservedSql` parity with `computeOpenWindows`; lock order; the reservation
  insert's new batch and its never-throws contract.
- Synced refusal on every M2 writer; the board never writes to FieldPulse.
- Idempotency: stored codes; the automatic one-time re-send; mass replay and undo.

## 13. Docs

`page-calendar` (drop flow, prompt, confirm, crew and helper copies, blocks, strip, read-only below
1024 px, `/reschedule` removed, queries.test indices), `page-requests` (started definition, sheet copy,
tray refusal), `page-dispatch` (unchanged; helpers show only in their lead's column), `admin-pages`
(the started rule, L_band), `replica/features.csv` rows 82/96/97/98/102, `replica/parity.md`,
`replica/build-log.md`, `replica/architecture.md` annotation (move route under the request, no
`deltaMinutes`, `REASSIGNABLE_STATUSES` unchanged, synced read-only on the board, rows 82/100), memory.
