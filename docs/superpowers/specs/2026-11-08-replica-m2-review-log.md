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
