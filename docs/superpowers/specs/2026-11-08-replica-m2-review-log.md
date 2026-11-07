# M2 Dispatch — adversarial review log

## Spec round 1 (v1 → v2), 2026-11-08 — 3 critics (A data/concurrency/idempotency/tenancy/security, B dispatcher experience and buildability, C codebase reality and simplicity)

Counts: A 2 blocker / 5 major / 6 minor; B 3 blocker / 12 major / 13 minor; C 0 blocker / 6 major / 13
minor / 4 nit. Total 5 blockers, 23 majors. Lead rulings L1–L11 were binding and are marked.

Lead rulings:
- L1 Synced requests stay draggable. HCP moves and lane changes are pushed as today. FieldPulse time
  moves are pushed with `pushJobToFieldpulse` as the sheet does; FieldPulse lane changes are refused with
  honest copy; the card shows a visible FieldPulse cue.
- L2 A technician whose row is `cancelled` is revived when they become lead or crew again; integration
  case override → drag back; Undo after "Move anyway" = the inverse move.
- L3 Reset lists include `on_hold`; "started" counts only the current lead's and crew's live rows; the
  done-when test's expected statuses match the trigger; the demoted lead stays on the crew as a helper,
  keeps M3d form access, and lead-only money passes to the new lead.
- L4 The version gate compares the visit id as well.
- L5 Drop band from the pointer; prompt only when the window doesn't cover the drop band; default Keep for
  anytime and custom; plain lane changes never prompt.
- L6 A minimal Add technician / remove helper control in the sheet's Visits section; row 98 `yes`.
- L7 Cut the window locks, SQL re-count and BAND_FULL; `reserveCapacitySlot` unchanged; only the active
  visit is draggable; mass reschedule keeps preview + confirm, loses the undo.
- L8 The board scrolls horizontally; state the real lane count at 1440.
- L9 Time off: define details and copy; use the confirm pattern unless there's a reason not to.
- L10 A-M3, A-M4, A-M5, the autopilot race, `docs/DISPATCH.md`.
- L11 Plan task 0: a Playwright drag spike.

Applied:
- Synced requests (A-B2, B-M8, C1, C6; L1): `MANAGED_EXTERNALLY` now covers only a FieldPulse
  technician change (move, tray, mass `T2`). HCP requests move like native ones and keep
  `after(pushJobToHcp)`; the spec states HCP writes back status and invoice status only, so moves stick,
  and a request never locks itself by being pushed. FieldPulse time moves call `pushJobToFieldpulse` in
  `after()` when the window changed, exactly as the sheet (`requests/[id]/route.ts:356`, :382-386); its
  failure handling is the sheet's (degrade-safe, logged, the nightly import writes FieldPulse's window
  back if the push failed). The FieldPulse assignee is set by the nightly import from FieldPulse or null
  (`import/jobs.ts:429-460`), hence the refusal. FieldPulse cards show the `md` SyncPill ("FieldPulse")
  with a lock, not the `sm` "FP" or a tooltip. The 0-of-11 dev fact was replaced by "16 of 207
  FieldPulse rows are app-created bookings the app pushed" and the booking pushes are cited.
- Revived rows (A-B1, B-B2; L2): §5.3 step 3 resets a revived `cancelled` lead (and a new lead inserted
  with a started status and no timestamp) to the request's status, or `assigned` while someone else
  works; the #2+ swap does the same in `ON CONFLICT`; `addVisitTechnician` revives a cancelled helper row
  instead of `DO NOTHING`. Revived rows keep their timestamps and are not started (§3.2). Integration
  (b2) overrides then drags back; Undo after "Move anyway" sends the inverse move from the response's
  `previous` (new `windowRule: 'exact'`, Undo only). A's `TECHNICIAN_DONE` refusal is not needed: a done
  helper made lead keeps `completed`, which is started, so a later lead change asks first (§3.2).
- Started rule and override statuses (A-M1, C2, C12, A-m2; L3): started = a live lead row working or
  done, or a live helper row working; timestamps only tell a pause from an untouched `on_hold`. The reset
  lists include `on_hold`. A progressed old lead is set to a helper `assigned` after the trigger cancels
  it; an untouched old lead is still deleted by the trigger. Test (b) now expects Sam `scheduled` (the
  trigger inserts the request's new status) and Alex helper `assigned`; (b3) covers the pause; (c) covers
  the done lead becoming a done helper. Steps 2–4 run only on a lead change. The handover is stated: the
  helper keeps reading the job and M3d form access (subject to the on-site window), lead-only work goes
  to the new lead, drafts stay on the request.
- Version gate (A-M2; L4): compares id and version; integration (g').
- Window prompt (B-B3, B-m4; L5): `pointerWithin` with `closestCenter` for keyboard drags; `covers` =
  the window, on the drop day, overlaps the band; defaults Keep for anytime/custom, "Use the new window"
  for a band; pure tests for anytime, 11–1 and 7–9 lane changes.
- Crew UI (B-B1, C3; L6): §7.7 `Technicians` control in the sheet's Visits section with copy for the
  existing codes; the walk adds Sam through the sheet; row 98 stays `yes`.
- Scope cuts (B-M12, C4, C5 part, C11, A-m4; L7): §4.3 L_band, §5.5's SQL twins, `BAND_FULL`, the
  `reserveCapacitySlot` change and integration (k) are removed; the window-load strip went with them to a
  capacity milestone (so B-M11, B-m7, B-m13, C14, C15 are moot and row 82 stays `no`). Only the active
  visit is draggable (the board's card is the displayed visit, `current-visit.ts:54-59`, which is the
  active one unless ended), so the #2+ batch stays only for an active #2+ visit. Mass reschedule keeps
  preview and confirm; its undo, `undoBody` and the undo banner are removed (A-m5 c moot).
- Lane width (B-M1; L8): §7.2 states the arithmetic: Unassigned plus two technician lanes fit at 1440,
  the third shows 70 px, the rest scroll; the time axis becomes sticky.
- Time off (B-M3, B-M9; L9): bands stay droppable (a disabled band sent the drop to a neighbour), the
  client checks loaded blocks first, the server answers `TIME_OFF` with `{ timeOff: [{ technicianId,
  startsAt, endsAt, kind }] }`, dialog "Can't move this request" / "<Sam> is off 4:00 PM – 8:00 PM on
  Tue, Nov 10." / OK. The suggested "Schedule anyway?" confirm was not used: time off is a repo invariant
  that is never overridable (admin-pages skill; `noTimeOff` in every writer) and the lead allowed this
  exception.
- Crash after commit (A-M3; L10): only mass reschedule is keyed now; its audit id is
  `derivedId(scope, 'audit')`, details carry moved and skipped ids, and a re-run rebuilds the 200 from it.
  Integration (m) deletes the key row and re-sends.
- First-assignment events (A-M4; L10): `recordStatusEvent(old → assigned)` on every first assignment,
  whatever the status column does; integration (j').
- Unfinished work after an override (A-M5; L10): §5.3 "What an override hands over"; the confirm copy
  says Sam takes over close-out, the invoice and estimates. The `HAS_DRAFT_WORK` alternative was not taken
  (the helper keeps the draft).
- Autopilot (C9; L10): §4.1 says a drag after an autopilot write meets STALE; the reverse case (an
  Unassigned-lane window move of a fresh request) is listed under "Not closed", with docs/DISPATCH.md.
- Docs (C10; L10): `docs/DISPATCH.md` §5 added to §13; mass calls `stampDispatchOverride` when `T2` is
  set; body field renamed `confirm`, audit field `confirmed`.
- Drag spike (C16, B walk; L11): §9 task 0, with scrolling both ends into view.
- B-M2 chips on their own row, only with 2+ crew, count below 120 px (`chipLayout`).
- B-M4 `applyMoveResult` writes the new version before the refetch.
- B-M5 in-flight state per visit; `isRescheduling` leaves lane and tray props.
- B-M6 confirm copy built from the details (timestamp or mirrored status, open time entry, reset) plus
  "Neither technician is told. Call them."
- B-M7 a lead change that shrinks the crew shows "Sam is now the lead. Alex is off this visit."
- B-M10 mass: `helper` reason and copy, default day (same day when a technician is picked), result banner,
  preview states, singular label. The undo-banner lifecycle is moot.
- C13 single move unkeyed; a re-send's STALE is resolved by `moveLanded` after a refetch.
- Minors: B-m1 count with an icon and "2 technicians"; B-m2 no-op after Keep; B-m3 ended bands shaded,
  ended options disabled; B-m5 block link to Staff, outline-only for a non-removing `non_job`; B-m6 lazy
  `matchMedia`; B-m8 and C18 notice copy; B-m9 "Use the afternoon window", singular forms; B-m10 Enter =
  Move, dialog on the next frame; B-m11 overlay found by `visitId` and lead; B-m12 via B-M6; A-m1 the
  off-graph `arrived`/`in_progress → scheduled` edge stated; A-m3 org predicates on every statement; A-m5
  (a) `start on D` predicate and (b) all-or-nothing on a statement error; A-m6 entries with no visit;
  C7 "15 FieldPulse, 1 native office status mirror"; C8 FieldPulse sheet copy; C17 design deviations and
  the contrast check; C19 `requestId` added; N1 0058 note; N2 `equipment-writes.ts:89`; N4 noted in §13;
  `MAX_TECHNICIANS_PER_VISIT` cited at :30; `form-gates.ts` path and `runAsWinner` lines corrected.

Rejected / moot:
- B-M8 option 2 (stop calling `pushJobToHcp` for an unmapped request): moot under L1, since a pushed HCP
  request stays movable.
- B-M8 board-wide "N of M requests are managed in FieldPulse" notice: replaced by the per-card pill and
  the lane-change banner; FieldPulse requests are movable in time now.
- A-B1 `TECHNICIAN_DONE`: not needed (see Applied, revived rows).
- A-m4, B-M11, B-M12, B-m7, B-m13, C14, C15, N3: moot with the capacity cut (L7).
- C5 (keep every visit #2+ pinned): superseded by L7's "only the active visit is draggable"; an active
  #2+ visit is the request's current card and moves through the #2+ batch.
- C9 option (a) (gate the autopilot on the held window): not taken; listed under "Not closed".
- C13's suggestion to key only mass: taken; the single move's audit row is gated on xmin and can't
  duplicate.
- B-M1's flex lanes and collapsing tray: rejected by L8 (scroll as today; the axis is sticky).
- B-B2 item 3 for every override with a 30 s timer: Undo is offered after "Move anyway" until the next
  move or 60 s; no Undo for mass (L7).

Verdict: v2 for round 2. All five round-1 blockers are resolved by L1, L2, L5 and L6.

## Spec round 2 (v2 → v3), 2026-11-08 — 2 critics (A correctness/data/concurrency/tenancy/FieldPulse-HCP, B UX and buildability)

Counts: A 2 blocker / 4 major / 8 minor; B 1 blocker / 11 major / 15 minor. Neither signed off. Lead
rulings L2-1…L2-10 binding.

Lead rulings:
- L2-1 (A-B1) `visitId` falls back to visit #1's id; null = no #1; test.
- L2-2 (A-B2) A board move never creates a FieldPulse job or touches its description. Mapped jobs get a
  schedule-only update; if no safe schedule-only call exists, FieldPulse time moves are refused too.
  Unmapped native requests behave as today's drag.
- L2-3 (A-M1, B-B1) On Move anyway the old lead's row is cancelled, not kept as a helper; timestamps and
  entries kept, time stopped; the draft stays and the new crew can edit it; Undo revives. Supersedes L3's
  helper clause.
- L2-4 (A-M2) Undo restores the exact previous crew; a helper promoted to lead goes back to helper; fix
  (b2).
- L2-5 (pending ruling) Visits #2+ stay pinned with a tag and title; the sheet gets `Change time` through
  `updateAppointment`, which keeps its old progress gate; mass skips `later_visit`; fix v2's six
  contradictions.
- L2-6 (A-M4) The sheet path revives a cancelled lead as the board does.
- L2-7 Time off: check only the technicians the move assigns.
- L2-8 (B-M10) No keyboard drag; a `Move…` action per card; focus rules.
- L2-9 (B-M9) The spike proves auto-scroll, `pointerWithin` band detection and tray-to-lane.
- L2-10 Apply the remaining majors and minors, incl. per-visit skip reasons in the mass audit and pushes
  re-sent on recovery.

Applied:
- `visitId` fallback (A-B1; L2-1): §4.1 and §7.1 use the displayed visit, else #1; integration (j'').
- FieldPulse (A-B2; L2-2): today's drag route was checked (`reschedule/route.ts:184-189`: Google Calendar
  and HCP only), so native requests get no FieldPulse call. A schedule-only call exists:
  `updateJob(id, { scheduleStart, scheduleEnd })` serialises only the two schedule keys because
  `JSON.stringify` drops undefined ones (`fieldpulse/client.ts:984-999`). New `pushScheduleToFieldpulse`
  wraps it for mapped jobs only. Because `updateJob` is a PUT whose treatment of omitted fields is
  unverified, FieldPulse time moves are enabled only after task 0b proves it keeps the description and
  assignee; otherwise they are refused ("Change this request in FieldPulse."). The sheet's create and
  description overwrite are recorded as a pre-existing bug. Route test asserts the body keys.
- Old lead cancelled (A-M1, B-B1; L2-3): §5.3 step 3 (the kept `completed` row is cancelled too); time
  off and conflicts check only the technicians the move assigns (L2-7), so a sick technician's time off
  never blocks the handover; integration (b4), (h2); §8 confirm copy rewritten.
- Undo (A-M2, B-m9, A-m6; L2-4): `previous` carries the crew and request status; `restore` mode (steps 1,
  5) keeps a helper-turned-lead from the trigger's delete and writes back each row; Undo sends the
  original confirm with `expectStartedIds`, so it re-asks only for new starts and never blindly replays;
  offered only with a previous lead and an unended window; the 200's version is read after the trigger.
  (b2) now expects Alex lead `scheduled` after a drag back (step 4 revives to the request's status);
  (b2u) and (b2h) cover Undo.
- Visits #2+ pinned (A-M3, B pending ruling; L2-5): the #2+ batch, test (i), the tray #2+ line, the #2+
  `movable` case and "every active visit" in mass are gone; `VISIT_PINNED`; card tag, title and
  `aria-label`; sheet `Change time` (§7.7) with its copy; `updateAppointment` keeps `visitProgressed`
  (§3.2 explains the unique-constraint 500); mass `later_visit`; integration (i').
- Revive on every lead writer (A-M4; L2-6): `reviveLeadSql` appended to `assignTechnician`,
  `reassignTechnician` and `placeAndAssignRequest`; integration (e) A → B → A.
- Keyboard (B-M10; L2-8): `KeyboardSensor` and `sortableKeyboardCoordinates` removed (verified they never
  move); `Move…` per card with its dialog using the same route and 409 flow; focus after drops,
  refusals and dialogs (§7.4); walk step.
- Spike (B-M9; L2-9): task 0 now proves auto-scroll to an off-screen lane, `pointerWithin` 4 px from a
  band edge, and tray to an off-screen lane.
- Mass (A-m4, B-m7, B-m8; L2-10): per-visit `skipped: [[visitId, reason]]` in the audit; org-scoped
  recovery read; `NOT EXISTS` audit predicate in each statement; recovery re-sends the after-calls
  (idempotent: calendar upsert, update-path pushes, HCP create guarded by `hcp_job_id IS NULL`,
  last-write-wins telemetry); `conflict` named once, `stale` listed; button count, disabled when nothing
  changes, result variants, dialog stays open on the result, date min and max, default-day rule.
- A-m1 server cap `VISIT_FULL`; A-m2 `NO_LEAD`; A-m3 status CASE native only, `on_hold` reset clears hold
  fields; A-m5 HCP conversion stated in §5.1 and §11; A-m7 test (g) split into lead tap → STALE and helper
  tap → HAS_PROGRESS; A-m8 paths now under `src/lib/integrations/`.
- A-M1 (c): `removeVisitTechnician` cancels a timestamped, not-started helper instead of refusing.
- B-M2 time-off pre-check after the prompt resolves the window (`timeOffHits`); walk fixed.
- B-M3 same day and lead: Keep isn't offered, default Use the new window; covered no-op line.
- B-M4 pill size by width, no lock on the pill, started in the `aria-label`.
- B-M5 sheet assign/reassign refuse FieldPulse technician changes; §7.7 wording fixed.
- B-M6 client move state keyed by `requestId`; pure test with two tray cards.
- B-M7 `optimisticCrew`.
- B-M8 `moveBanner`, fixed bottom-right, roles, lifecycle, close ×.
- B-M11 time axis out of the scroller; lanes in their own scroller.
- B minors: 1 "job" → "request"; 2 sentence case; 3 "Please try again."; 4 time-off copy by kind with a
  way out; 5 covered-lane wording; 6 `RadioGroup`, Enter except while a Select is open, lane named; 10
  `onAssigned`, HCP and cap copy, × hidden on working helpers; 11 `ConflictDialog` time-off branch
  deleted; 12 `chipLayout(width, height)`; 13 `describeDropTarget` speaks time off and ended; 14
  `(pointer: fine)` and "on a computer"; 15 walk adds the FieldPulse card, `Move…`, a skipped mass row,
  1023 px. B's internal check: server `MANAGED_EXTERNALLY` mapped to the banner.

Rejected / moot:
- A-m8's "`import/jobs.ts:528-536` is now :513-527": not taken; `.update(serviceRequests)` is at :528 and
  the window fields follow it (re-grepped); :513-527 is the insert path.
- B-M10's `bandKeyboardCoordinates`: superseded by L2-8 (no keyboard drag).
- B-M3's "Keep reads 'Don't move'": replaced by not offering Keep when it would change nothing.
- B-m9 "send `response.confirmed` with Undo" and A-M2 "Undo always sends `confirm: []`": merged; Undo sends
  the confirm with `expectStartedIds`, which honours only the starts that were confirmed.
- A-M1 (a), (b), the "ghost helper": moot under L2-3 (no demoted helper exists).
- B-M8's `sticky bottom-4` placement: the fixed bottom-right toast was chosen (one rule for both).

Verdict: v3 for round 3. Round 2's three blockers are resolved by L2-1, L2-2 and L2-3.

## Lead ruling before round 3 (v3 → v3.1), 2026-11-08

- L3.1-1 The dev default org's FieldPulse key reaches the owner's real, live FieldPulse account; task 0b
  would PUT to a real FieldPulse job, which is outward-facing and not reversible by us, so it isn't done
  autonomously. Supersedes L2-2's schedule-only push.

Applied:
- FieldPulse-mapped requests are read-only on the board: time, window, day and technician moves, the tray
  and mass reschedule refuse them with 409 `MANAGED_EXTERNALLY` "Change this request in FieldPulse."; the
  move UPDATE carries `fieldpulse_job_id IS NULL`; `movable` is `'yes' | 'no'` (FieldPulse → `no`); the
  card shows the FieldPulse pill with a lock, no grab cursor and no `Move…`; the mass reason is
  `fieldpulse`. The sheet's FieldPulse technician refusal (B-M5) stays.
- Task 0b and `pushScheduleToFieldpulse` removed from M2; listed in §10 "Follow-up (needs the owner)": the
  owner verifies on a test job in their own FieldPulse that a schedule-only `updateJob` PUT keeps the
  description and assignee, then the push is built and FieldPulse time moves are enabled.
- Unmapped native requests in a FieldPulse org move as today with no FieldPulse call; Housecall Pro is
  unchanged from v3.
- Goal and Done-when state that the done-when is proved on native requests and FieldPulse-mapped requests
  refuse every board move; features.csv notes for 96 and 102 say so; §4.2 recovery no longer mentions a
  FieldPulse push; §5.3 after-calls make no FieldPulse call; tests: route test asserts no M2 route imports a
  FieldPulse client or push, integration (f) expects MANAGED_EXTERNALLY for every FieldPulse board move and
  no FieldPulse call for a native request in a connected throwaway org (client mocked), (m) and the walk
  updated; §11 rulings, "not closed", "not verified" and §12 updated.

## Spec round 3 (v3.1 → v4 FINAL), 2026-11-08 — 2 critics (A correctness/data/concurrency/tenancy, B UX and buildability)

Counts: A 1 blocker / 7 major / 11 minor; B 0 blocker / 7 major / 20 minor. Neither signed off. Lead rulings
L3-1…L3-7 binding.

Lead rulings:
- L3-1 Cut Undo from M2. Every round found new state-corruption paths in it (round 2: dropped helpers,
  replayed confirms; round 3: an ungated pre-step leaving no lead on a lost race (A-B1), stale helper
  rewrites (A-M1), client-supplied statuses (A-M2), lost labor (A-M7), missing status events (A-m6)),
  while dragging the request back already recovers: an ordinary move that revives the old lead's row.
  "Move anyway" stays with its confirm.
- L3-2 The sheet's schedule edit stays exactly as today (A-M6): not switched to the started rule;
  `updateAppointment` keeps its gate; its `pushJobToFieldpulse` is an existing gap. Change time copy never
  says "pause"; every sheet refusal on a FieldPulse request names FieldPulse (B-M1, B-M2).
- L3-3 (A-M3) The mass audit is computed in SQL.
- L3-4 (A-M4) A recovered mass run re-sends only update-style pushes; never an HCP create; such requests are
  listed "not sent; open it to retry".
- L3-5 (A-M5) Fix test (b): the new lead edits the draft once on site.
- L3-6 (B majors) `Move…` always visible; the drag wrapper out of the tab order; spike proves near-lane
  drops and Unscheduled-to-lane drags don't slide the board, with auto-scroll settings; the `Move…` dialog
  fully specified.
- L3-7 All minors; real time format, `Visit #<n>`, "Unscheduled", "below".

Applied:
- Undo removed (A-B1, A-M1, A-M2, A-M7, A-m6, A-m7, B-M3; L3-1): `restore`, `previous`, `expectStartedIds`,
  `startedIds`, the `exact` rule, steps 1 and 5, §5.4 Undo, the Undo banner and copy, tests (b2u) and (b2h).
  (b2) drag-back stays. §10 lists Undo as out of scope.
- Guards (A-M6, A-m11; L3-2): two guards. `visitOneStartedGuardSql` (§3.2) for the move, Unscheduled,
  assign, reassign and `placeAndAssignRequest`; `visitOneGuardSql` unchanged for `scheduleRequest`;
  `updateAppointment` unchanged. The sheet/board difference (helper working) is stated and the sheet copy
  points to `Move…`. Integration (e) checks the schedule edit behaves as today.
- Change time (B-M1, A-m3, B-m9; L3-2): HAS_PROGRESS "Work has started on this visit, so its time can't
  change. Cancel it and add a new visit instead."; disabled when any row has `hasProgress`; one copy map
  (`VISIT_ERROR_COPY` updated) incl. TECHNICIAN_NOT_FOUND, VISIT_ENDED, VISIT_CANCELLED and a canon generic.
- FieldPulse in the sheet (B-M2, B-m18, A-m8; L3-2): refusals check FieldPulse first and name it; the
  Assign/Reassign select is disabled on FieldPulse requests; every FieldPulse refusal is a SQL predicate.
- Mass audit in SQL (A-M3; L3-3): `movedVisitIds` from the xmin of the candidates, `skipped` =
  validated `preSkipped` plus every candidate not moved as `stale`; route test for a forged reason.
- Recovery pushes (A-M4, A-m5; L3-4): only `syncRequestToCalendar` and `pushJobToHcp` for requests with
  `hcp_job_id`; no create, no telemetry, no status events; `pushesNotSent`; the "idempotent" claim corrected
  to "only when sequential"; `after()` registered as `run`'s last step.
- Test (b) (A-M5; L3-5): Alex arrives and starts a draft; Sam's save before arriving is refused, after
  arriving it lands; §5.3 states the on-site condition.
- Card and dialog (B-M4, B-M5, B-M6, B-M7; L3-6): `Move…` is a small always-visible button on every
  movable lead card and Unscheduled row; the drag wrapper loses `tabIndex`, `aria-roledescription` and
  `aria-describedby`, `screenReaderInstructions` points to `Move…`, `@dnd-kit/sortable` removed;
  `autoScroll={{ threshold: { x: 0.06, y: 0.2 }, acceleration: 5 }}` (default 0.2 / 10, verified in
  `@dnd-kit/core`), task 0 (d) and (e) prove near-lane drops and Unscheduled → Unassigned keep `scrollLeft`,
  with 5 technicians seeded and §7.2's layout applied locally; the `Move…` dialog's title, buttons,
  defaults, unassigned and Unscheduled cards, ended choices, disabled-when-unchanged, time-off check and body
  (`moveDialogDefaults`, `moveDialogBody`).
- A minors: m1 `FOR NO KEY UPDATE` in `addVisitTechnician`, concurrent 6th add test; m2 helper writers bump
  `appointments.version`; m4 `TECHNICIAN_DONE`; m8 Unscheduled drop gets the version gate; m9 `movable: 'no'`
  for a #1 with `cancelled_at`; m10 every revive nulls the progress timestamps (history stays in entries
  and events).
- B minors: 1 "9 AM–11 AM" format throughout (`formatBusinessTimeRange`, `calendar-time.ts:267`); 2
  `Visit #<n>` and `VISIT_PINNED { visitNumber }`; 3 "Unscheduled"; 4 sheet copy points to `Move…`; 5
  confirm line 3 reworded, combined lead and window rule, day in the time-change line; 6 started cue is a
  different icon and only on movable cards; 7 focus target with `data-lane-role`, lane headers
  `tabIndex={-1}`, off-day `Move…` focus; 8 "Reassign below"; 9 one copy map; 10 `onChanged` calls
  `onAssigned`; 11 visits GET adds `started` and `hasProgress`; 12 `removesCapacity` only, kind and
  multi-day copy; 13 no banner when the band equals the window, the covered line points to `Move…`; 14
  always-mounted live region, 4 s for "Moved.", cleared on drag start, top-centre below 640 px (the 60 s
  Undo part is moot); 15 blocks non-interactive between bands and cards with a "Staff" link; 16 mass key
  lifecycle, failure and 422 copy, singular label, refetch, no ⋯ on Unassigned, the lane menu kept when not
  interactive; 17 ended band disabled in the prompt, no send for an Unscheduled drop into an ended band; 18
  disabled select; 19 pill wrapper with the title, width from `columns`, Week and Unscheduled `sm`; 20
  helper-copy title, "Assign a technician to this request first.", the three FieldPulse variants named in
  §8, both PATCH routes named in §6, `movable` for terminal requests, the walk's en-route request pinned to
  8 AM–12 PM.

Rejected / moot:
- A-M2's `undoOf` audit design, A-M7's restore entries, A-m6, A-m7, B-M3, B-m14's 60 s Undo pause: moot
  with Undo cut (L3-1).
- A-M6 option (b) (started rule in the schedule edit with a FieldPulse refusal): not taken (L3-2 chose a).
- A-m10's "Undo restores stamps from the audit": moot; the revive-nulls-stamps part was taken.

Verdict: v4 FINAL. The round-3 blocker (A-B1) is removed with Undo. The spec grew from 636 to 682 lines:
cutting Undo saved about 40 lines, but fully specifying the `Move…` dialog, the copy map and the FieldPulse
variants added more.

## v4 verification (v4 → v4.1 FINAL), 2026-11-08

Verification confirmed the round-3 majors closed, Undo fully cut, the five-technician cap race-free (the
count sits in the INSERT's WHERE after the lock), version checks sound, `autoScroll` options valid in
`@dnd-kit/core` 6.3.1, and `@dnd-kit/sortable` safe to remove. Three open items, all applied:

- (3a) A worked visit became deletable: a revive clears timestamps, and the 0058 trigger keeps visit #1
  only for timestamps or form submissions (0058:150-160), so arrive → Move anyway → drag back → drop on
  Unscheduled deleted the visit. Revive keeps clearing timestamps (it helps the M3d, close-out and hold
  gates). `unscheduleRequest` now refuses a visit #1 with any job time entry on it (or with no visit link)
  → 409 `WORK_LOGGED` "Work was logged on this visit, so it can't go back to Unscheduled." (§5.4, §6, §8;
  render test; integration (n2) runs the full sequence and checks the visit, Alex's row and his entries).
- (3b) `TECHNICIAN_DONE` had no SQL twin: §5.3 step 1 now carries "the new lead has no `completed` row on
  #1", and `assignTechnician` / `reassignTechnician` carry the same predicate (§5.5, §6, §8). Integration (c)
  adds the sheet paths and a helper's done tap injected between the move's pre-read and batch.
- (3d) An Unscheduled drop's `STALE` uses the same refetch and `moveLanded` path (landed = back in
  Unscheduled), else the existing STALE banner line (§7.4, §8); integration (n3).

Not changed: features.csv row 97's note "drag it back to reverse" describes an ordinary move, not Undo.
