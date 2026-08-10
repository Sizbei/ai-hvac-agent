# Round 1 — Evidence audit: dashboard / calendar / dispatch / requests / technicians / map

Method: every `verified` claim load-bearing for a P0/P1 gap or a requirement
was checked by opening the cited file at the cited lines in the current
working tree (not run — read only, plus read-only `git log`/`git show`).
Line-number drift with matching content is `minor`; wrong content or absent
behavior is `blocker`. The four flagged high-stakes claims (technicians.md's
trigger-drop, map.md's `geocodeCapped`, dashboard.md's `Promise.all`,
dispatch.md's all-clear) were independently re-derived from source, not just
spot-checked.

## Findings

| id | spec | severity | tag | spec line under attack | what I found |
|---|---|---|---|---|---|
| O-E-1 | technicians.md | blocker | verified | "the trigger itself already scopes its lockout check to `OLD.organization_id` (verified in the deleted migration's recovered text, `git show 392cbc4:drizzle/0008_last_admin_guard.sql`), and the re-authored version must preserve that scoping exactly." (§7 Invariants) | The org-scoping claim itself is true — but this is the spec's **only** concrete recovery instruction for Rtechnicians-1, and it points at the wrong migration. `git log --all --diff-filter=D --summary -- "*last_admin*"` shows `0cea181` deleted **two** files in the same commit: `drizzle/0008_last_admin_guard.sql` (added `392cbc4`) **and** `drizzle/0027_last_admin_guard_super_admin.sql` (added `a117843`, between `392cbc4` and the squash). `git show a117843:drizzle/0027_last_admin_guard_super_admin.sql` recovers a `CREATE OR REPLACE FUNCTION enforce_last_active_admin()` whose guard condition is `OLD.role IN ('admin', 'super_admin')` — 0008's body only checks `OLD.role = 'admin'`, so it does **not** count a `super_admin` as an admin-tier user for the lockout check. 0027's own header comment states why: "an org whose only privileged user is a super_admin (e.g. the seeded owner) could be demoted or deactivated into a lockout" under 0008's body. Neither the Current-state (§3), Gaps (§4), nor Invariants (§7) sections of the spec ever mention 0027 exists or was also deleted — the spec's Requirements (§5) acceptance criterion happens to use the phrase "an active admin-tier user" (0027's semantics, not 0008's), but gives no citation for it and points the reader at 0008's recovered text as the concrete source. An implementer following the spec's explicit `git show` instruction verbatim would restore the pre-0027 (`role = 'admin'` only) function body, silently reintroducing the exact super_admin-lockout bug 0027 shipped to fix — a regression inside the very migration meant to close a P0. |
| O-E-2 | technicians.md | minor | verified | "`git log --all --diff-filter=D -- "*last_admin*"` shows `0cea181` deleted `drizzle/0008_last_admin_guard.sql` (originally added in `392cbc4`)" (§4 Gaps table, Gtechnicians-1 evidence) | Same underlying fact as O-E-1, restated: this evidence line is true as far as it goes (0008 was deleted by 0cea181) but under-counts — the same `git log` command's own output (which I ran verbatim) also lists `drizzle/0027_last_admin_guard_super_admin.sql` as deleted by the same commit. The core P0 diagnosis ("no current migration file recreates the trigger") is unaffected and still 100% correct; this is the same omission as O-E-1, called out separately because it's the Gaps-table citation an implementer would read first, before ever reaching §7. |

No other blockers or majors found. Everything else checked — including all
three remaining high-stakes claims and a wide sample of other load-bearing
`verified` citations across all six specs — matched the code exactly, often
down to the exact line number.

## Coverage: claims checked file:line against spec citation

**dashboard.md** (Rdashboard-1's `Promise.all` claim — high-stakes)
- `getDashboardOverview` at `queries.ts:1187`, its `Promise.all([...])` at
  `queries.ts:1196` — confirmed exact, no `db.batch` anywhere in the function
  body (lines 1187-1266 read in full).
- Sibling `db.batch` usage confirmed at exact cited lines:
  `ai-insights-queries.ts:52`, `conversation-queries.ts:438`,
  `crm-queries.ts:866,951`, `estimate-queries.ts:127,135`.
- Two divergent `OPEN_STATUSES` constants confirmed exactly as described:
  `queries.ts:441-447` = 5 statuses (`pending,assigned,scheduled,in_progress,on_hold`);
  `ops-insights-queries.ts:29` = 3 statuses (`pending,assigned,in_progress`).
  Zero overlap in status count, matches the spec's "5 vs 3" framing precisely.
- `DASHBOARD_LIST_LIMIT = 50` at `types.ts:201` — exact line.
- `getDashboardStats` at `queries.ts:1049` (spec: 1049-1104) — one aggregate
  `SELECT` with `CASE`-driven `count()` columns, confirmed real SQL, not
  client-side reduction; `importedPending` bucket confirmed at line ~1086.
- `dashboardRequestSelect`/`toDashboardRequest` at `queries.ts:1109`/`1157`
  (spec cites 1106-1108 for the preceding comment, 1157-1179 for the
  function) — confirmed narrow projection, no phone/email/address/transcript
  field present.
- `DashboardStatCards` renders exactly 7 `STAT_CARDS` entries
  (`dashboard-stat-cards.tsx:24-32`), each value read from `stats[config.key]`
  — no hardcoded numbers, matches spec.
- `POLL_INTERVAL_MS = 30_000` at `use-dashboard-overview.ts:15` — exact.
- `page-dashboard/SKILL.md:27` — confirmed verbatim: "The query runs four
  parallel DB reads (...) in one round-trip," which the spec correctly flags
  as inaccurate given the actual `Promise.all` mechanism (each neon-http
  query is its own HTTP round-trip; only `db.batch` collapses them to one).

**calendar.md**
- Grep for `SortableContext` across `src/` (repo-wide, not just the one
  component) returns zero matches — confirmed no `SortableContext` exists
  anywhere, backing the "arrow-key navigation likely doesn't move focus to a
  sensible target" claim.
- `DndContext`/`KeyboardSensor`/`sortableKeyboardCoordinates` confirmed in
  `src/components/admin/calendar/interactive-scheduling-calendar.tsx`
  (note: this file lives under `admin/calendar/`, not `admin/dispatch/` —
  the spec never states the wrong directory itself, so not a citation error,
  just noted for my own path-finding). No `accessibility` prop found on the
  `DndContext` call (line 607) — confirmed.
- `request-detail-sheet.tsx` grep for "reschedule" — zero matches, confirmed.
- Atomic `NOT EXISTS` double-book guard confirmed at
  `scheduling-queries.ts:709-725`, folded directly into the guarded UPDATE's
  WHERE clause as described.
- `setBoard(prev)` rollback confirmed present on both conflict/error paths
  (lines 495, 545, 562 — spec cites 544-566, minor line-range drift, content
  matches). `isRescheduling` disables draggable cards (lines 626, 639, 651 —
  spec cites 626,650, minor drift, content matches).

**dispatch.md** (confidence-gate-server-side + shadow-mode-never-writes —
both high-stakes, and the 0-P0/0-P1 all-clear)
- `autoAssignBookedRequest` at `scheduling-queries.ts:1239` (spec:
  1239-1459) — read in full.
- `classifyDispatch` at `score.ts:285-303` — exact. `MIN_CONFIDENCE_GAP =
  0.08` at `score.ts:271`, `EMERGENCY_MIN_CONFIDENCE_GAP = 0.02` at
  `score.ts:276` — both exact, matching the spec's `:271-276,296-298`.
- Grep for `score|gap|threshold|confidence` in
  `dispatch/page.tsx`, `dispatch-column.tsx`, `use-dispatch-board.ts` turns
  up only Tailwind `gap-*` classes and the `outcomeLabel` map — zero actual
  scoring/threshold logic client-side. Confirms "no client-side confidence
  logic exists anywhere in the dispatch page."
- Shadow branch (`if (!enabled) { ... }`) confirmed at exactly
  `scheduling-queries.ts:1299-1329` (spec: 1299-1328, off by one closing
  brace, minor). Read line-for-line: it calls `rankedTechnicianOrder(...,
  true /* skipRouting */)` (the 7th arg, exactly at line 1307 as the spec
  cites) then `recordDispatchDecision(..., true /* is_shadow */)` — and
  **nothing else**. No `stampDispatchOutcome`, no `placeAndAssignRequest`
  call anywhere inside that `if` block. The claim "shadow mode never writes
  a real assignment" is confirmed exactly as stated.
- `OUTCOME_LABELS` at `page.tsx:36-41` — exact keys confirmed:
  `queued_no_capacity, queued_low_confidence, queued_after_hours,
  queued_no_match`. `DispatchOutcome` union at `score.ts:261-265` — exact:
  `committed | queued_ambiguous | queued_no_fit | queued_needs_review`. Zero
  key overlap, confirmed verbatim as Gdispatch-1 states.
- `dispatch-column.tsx` `timeZone: 'UTC'` confirmed at line 32 (spec cites
  25-34) while `getDispatchBoard` (`queries.ts:1280`) anchors on
  `businessDayBounds`/`businessIsoDate` (Eastern) — confirms Gdispatch-3.
- Gdispatch-2 (no test isolates "shadow branch never writes"): confirmed —
  `scheduling-queries.test.ts` has three `shadow:` `it()` blocks (lines
  955, 970, 981) that assert the overall `autoAssignBookedRequest` result
  and the `isShadow: true` insert, but none specifically assert that
  `placeAndAssignRequest`/`stampDispatchOutcome` were *not* called from
  inside the `!enabled` branch as an isolated unit — the spec's own hedge
  ("inferred from listing, not exhaustive test-body read") is accurate and
  appropriately cautious; this is P2, not load-bearing for a requirement.

**requests.md**
- `page.tsx:24` `sortKey='newest'` default — exact line, exact value.
- Index names all confirmed at exact or near-exact lines in `schema.ts`:
  `requests_org_id_idx:635`, `requests_status_idx:637`,
  `requests_ref_idx:638`, `requests_org_assigned_status_idx:659`,
  `requests_org_status_idx:663` — spec's range `634-669` covers all of them.
- `data-table-shell.tsx` grep for `rowClassName` — zero matches, confirmed
  no per-row className hook exists.
- `urgency-badge.tsx` confirmed lines 14-21 are exactly the `UrgencyBadge`
  component, which only colors the `Badge`, not a row.

**technicians.md** (last-admin trigger drop — high-stakes; see O-E-1/O-E-2
above for the one real gap found)
- `git log --all --diff-filter=D --summary -- "*last_admin*"` independently
  reproduced: confirms `0cea181` ("squash migrations to a single baseline")
  deleted both last-admin-guard migration files.
- `grep -rin "trigger\|plpgsql\|last_active_admin" drizzle/*.sql` across all
  current migration files (`0000_baseline.sql` through `0043_aggressive_tidy.sql`)
  — independently reproduced, zero matches. Confirms a fresh database gets
  no trigger today.
- `staff-queries.ts:22-28` — confirmed: the module's own docstring states
  the application-level `countActiveAdmins` check (called at line 306,
  defined at line 158) "is a read-then-write and is NOT race-proof on its
  own: two admins demoting each OTHER concurrently could both pass it," and
  names the trigger as "the authoritative guard." This directly supports
  (does not undercut) the P0 severity: the app-level check existing does not
  make the missing trigger a lower-severity gap, exactly as the spec argues.
- `isLastAdminViolation` at `staff-queries.ts:69`, matching on the
  `last_active_admin` message substring — confirmed present and wired at
  line 330-331.
- Commit `392cbc4`'s message independently confirmed to say exactly what
  the spec quotes: "Sidebar points at /admin/staff; /admin/technicians
  307-redirects; the orphaned technician table/form components are removed."
- `page-technicians/SKILL.md:35-37` — confirmed verbatim match to the
  spec's quoted trigger-guard description.

**map.md** (`geocodeCapped` narrow-signal claim — high-stakes)
- `route.ts` (`GET /api/admin/dispatch/map`) read in full. `MAX_GEOCODE =
  25` at line 27. `needGeocode`/`cached` split at lines 202-210 (spec:
  202-210, exact). Live geocode fallback `needGeocode.slice(0,
  MAX_GEOCODE).map(...)` at line 214 (spec: 213-223, exact region) — a
  failed/no-hit lookup returns `null` and is filtered out at line 226 with
  **no counter incremented anywhere** — confirmed, no tracking variable for
  dropped jobs exists in the function.
- `geocodeCapped: needGeocode.length > MAX_GEOCODE` confirmed verbatim at
  line 263 (spec: `:263`, exact) — true only when *more than 25* jobs need
  geocoding, confirming the spec's claim that a load with e.g. 3 ungeocoded
  jobs (all under the cap, one of which fails) reports `geocodeCapped:
  false` with zero indication anything is missing.
- `"Showing first 25 geocoded jobs"` confirmed verbatim at
  `dispatch-map.tsx:313` and `apple-dispatch-map.tsx:512` (spec cites
  311-315/510-514, exact regions) — confirmed inaccurate as the spec states:
  cached (majority) jobs aren't capped at all, only the live-geocode
  fallback is.
- `map-pins.ts` — confirmed the only file matching `*map-pins*` under `src`;
  no test file exists, backing Gmap-2 exactly.

## Per-spec verdict

- **dashboard.md** — sign-off. All load-bearing claims confirmed exact.
- **calendar.md** — sign-off. All load-bearing claims confirmed (minor line
  drift only, content correct).
- **dispatch.md** — sign-off. The 0-P0/0-P1 all-clear holds up under
  independent re-derivation of both stress-tested invariants (confidence
  gate is server-only; shadow mode's `!enabled` branch never calls
  `stampDispatchOutcome`/`placeAndAssignRequest`).
- **requests.md** — sign-off. Sampled claims confirmed exact.
- **technicians.md** — blocked on O-E-1. The P0 diagnosis itself (trigger
  absent from every current migration) is fully confirmed and correctly
  scoped — do not weaken or downgrade Gtechnicians-1. But Rtechnicians-1's
  concrete remediation instructions must be corrected before implementation:
  the migration to re-author is `0027_last_admin_guard_super_admin.sql`'s
  body (`OLD.role IN ('admin', 'super_admin')`), not `0008`'s
  (`OLD.role = 'admin'`) — recreating 0008 verbatim as currently instructed
  would ship a regression of the exact bug 0027 fixed.
- **map.md** — sign-off. Both P0/P1 gaps and the high-stakes
  `geocodeCapped` claim confirmed exact, including the inaccurate chip-text
  claim.

## Summary

2 blocker/O-E findings (both technicians.md, both describing the same
underlying evidence-trail gap from two angles), 0 majors, 0 minors beyond
the line-range drift noted inline (which never changed a claim's truth
value). 5 of 6 specs sign off outright; technicians.md's core P0 diagnosis
is correct and should ship, but its migration-recovery citation needs a
one-line fix (cite/recover `0027_last_admin_guard_super_admin.sql`, not
`0008_last_admin_guard.sql`) before Rtechnicians-1 is implemented.

**The four flagged high-stakes claims:**

1. **technicians.md's trigger-drop claim** — TRUE, independently
   re-verified via fresh `git log`/`grep`. But the spec's own recovery
   instructions cite the wrong (superseded) migration for what to restore —
   see O-E-1/O-E-2.
2. **map.md's `geocodeCapped` narrow-and-inaccurate claim** — TRUE,
   confirmed exactly against `route.ts` and both map components' chip text.
3. **dashboard.md's `Promise.all` (not `db.batch()`) claim** — TRUE,
   confirmed exactly at `queries.ts:1196`, with all four cited sibling
   `db.batch()` call sites also confirmed.
4. **dispatch.md's 0 P0 / 0 P1 all-clear** — HOLDS. Both stress-tested
   invariants (confidence gate is server-side only; shadow mode's `!enabled`
   branch never writes a real assignment) were independently re-derived
   from source, not just taken on the spec's word, and both check out
   exactly as claimed.
