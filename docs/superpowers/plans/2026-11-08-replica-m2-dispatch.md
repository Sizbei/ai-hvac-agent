# Replica M2: Dispatch, as deltas to /admin/calendar — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Prerequisite:** main at `b9cfba1` or later (spec v4.1 FINAL committed; migrations through 0058 applied on dev; no migration in M2, `drizzle/0059` stays free). Vitest baseline on `b9cfba1`: **533 files, 6 760 passed, 1 skipped** (`npx vitest run`). **Plan v2** after adversarial review round 1 (critic A: spec fidelity, SQL, concurrency, test strength; critic B: buildability, UI/copy, task boundaries; reports in the session scratchpad `m2/plan-r1-A.md`, `m2/plan-r1-B.md`) and the lead's rulings on them. v2 changes: mass reschedule excludes the run's own requests from the overlap check (SQL and preview), reclassifies every visit at commit (never trusting the preview), records a changed or vanished visit as `stale` instead of refusing the commit, answers a taken-over run as recovery, and refuses a no-change body; the started arm is pinned in the mass render test; `othersStarted` makes the confirm's reset line exact; FieldPulse is answered before time off on the sheet; the walk fixture never lands on a busy band, every walk move asserts 200, and the 1023/390 steps assert read-only and refusal outcomes; Task 3 keeps `reschedule/route.test.ts` green; the prompt's Enter never overrides a focused Cancel; Task 9a runs `contrast.py`; no `git stash`; the spike's retune loop stops after 3; the Unscheduled FieldPulse row has its lock and an absent `movable` means not movable everywhere. Every code block of Tasks 1–10 was re-applied to one scratch worktree and compiled; see the Self-review.

**Goal:** The office runs the day on the existing day view: a drag into a window the current one doesn't cover asks which window; a started visit refuses a move with 409 until "Move anyway"; a visit worked by two technicians shows in both lanes with crew chips; blocks show time off, non-job events and on-call; every movable card has `Move…`; a technician's day moves after a preview; FieldPulse-mapped requests are read-only on the board.

**Architecture:** No migration. Pure modules carry the rules both sides share (`visit-started.ts`, `move-window.ts`, `board-move.ts`, `dispatch-copy.ts`, `mass-reschedule-model.ts`, `visit-move-plan.ts`). SQL builders (`visit-move-sql.ts`) are pure and pinned by `PgDialect` renders. Every writer is ONE `db.batch` led by L_req (`lockRequestSql`): the move's guarded `UPDATE service_requests` carries the SQL twin of every pre-read check (version gate on id + version, FieldPulse, started arm, no time off, no overlap, lead not done, active technician) and the 0050/0058 trigger mirrors it onto visit #1; follow-on statements (cancel a kept `completed` old lead, `reviveLeadSql`, close the old lead's time, the audit row) are gated on the request's xmin. Mass reschedule runs under `withIdempotency` with an SQL-computed audit row as its recovery record. The board reads crew and visit versions in one extra org-scoped query; the client keeps the drop flow in pure helpers the React board calls.

**Tech Stack:** Next.js 16 App Router (`params` are Promises; `after()` from `next/server` for background work), Drizzle 0.45 on Neon neon-http (`db.batch()` = one transaction; `db.transaction()` throws; `db.execute(sql…)` returns `.rows`), zod 4, `@dnd-kit/core` 6.3.1 (`pointerWithin`, `autoScroll` options), vitest (node only; SQL rendered with `new PgDialect().sqlToQuery`), Playwright 1.60 (spike and walks), admin primitives (`Dialog`, `RadioGroup`, `Select`, `Button`, `SectionCard`).

**Spec:** `docs/superpowers/specs/2026-11-08-replica-m2-dispatch.md` (v4.1 FINAL) and its review log `docs/superpowers/specs/2026-11-08-replica-m2-review-log.md` (lead rulings L1–L11, L2-1…L2-10, L3.1-1, L3-1…L3-7, v4.1 items 3a/3b/3d). The spec is the authority; this plan argues from it. Binding from the log: **Undo is cut** (L3-1; drag back instead); **FieldPulse-mapped requests are read-only on the board** and M2 makes **no FieldPulse call** (L3.1-1).

**Lead rulings / deviations** (binding; recorded again in Task 11's docs):
1. **Integration suite path.** `tests/integration/field-dispatch.test.ts` (the owner's instruction for this plan); spec §9 names `tests/integration/dispatch-board.test.ts`. Same cases, (a)–(p) incl. (b2), (b3), (b4), (c), (g), (g'), (h2), (i'), (j'), (j''), (n2), (n3).
2. **`listShiftsInRange` does not exist** (spec §7.1 cites it). Task 6 creates it (mass preview needs it first; Task 7's board read uses it) in `src/lib/admin/shift-queries.ts`: every kind, org-wide, half-open overlap, `starts_at` order.
3. **Board crew read is its own module** (`src/lib/admin/board-crew-queries.ts`, one `db.execute`) run after the five existing reads; `queries.test.ts` mocks it, so the visit feed stays select index 4 (spec §7.1).
4. **Outside-hours is pre-read only.** Overlap and time off have in-write SQL twins in the move UPDATE; the "outside the new lead's hours" check stays a pre-read (as `placeAndAssignRequest` today: its in-write guards are overlap and time off). A dispatcher editing hours between pre-read and batch is the residual.
5. **Overlap twin.** A checked technician's open row (`OPEN_ASSIGNMENT_STATUSES`) on a live visit of ANOTHER open request whose visit window overlaps (half-open). The moving request is excluded whole, as `checkScheduleConflict`'s `excludeRequestId`.
6. **Override reset is native-only** (log A-m3): `→ scheduled` only when `fieldpulse_job_id IS NULL AND hcp_job_id IS NULL`, like `resumeHeldRequest`. An HCP lead swap past a started lead keeps the status (dormant on dev: 0 HCP rows).
7. **Status events** after a move: a first assignment (old lead null, new lead set) records `old → assigned`; any other status change the batch made records `old → new`; a `pending → assigned` first assignment records one event, not two.
8. **Refusal order** (spec §5.3) gains `VALIDATION_ERROR { path: ['windowRule'] }` (keep with no window) right after `MANAGED_EXTERNALLY`. `WINDOW_ENDED` is **400** (spec §5.2) although it sits in the 409 order.
9. **Where `after()` lives.** The move route registers `syncRequestToCalendar` / `pushJobToHcp` through `registerRequestPushes` (`src/lib/admin/move-pushes.ts`) after the envelope is built; `recordStatusEvent` and `stampDispatchOverride` run awaited and best-effort inside `moveVisit` (as `placeAndAssignRequest`). Mass registers all after-work through an injected `schedule` (default `after`) as `run`'s last step (spec §4.2).
10. **Copy.** Apostrophes are U+2019 (`’`) in every user-facing string, matching the sheet's existing copy; the spec's straight `'` is typography. In the started-time confirm, one line per started technician, then ONE "It moves to <range>[ on <day>]." line (spec §8 "per started technician" read as the started lines); " on <day>" appears only when the day changes, also in the combined lead + window form.
11. **Change time `TIME_OFF`.** `updateAppointment` doesn't say who is off: one technician → "<name> is off during this time."; several → "A technician on this visit is off during this time."
12. **`visitOneRefusalResponse(reason, opts)`** takes `{ fieldpulse?, surface? }`. The schedule-edit route (`PATCH /api/admin/requests/[id]`, writer unchanged) reads `isFieldpulseMapped` before mapping a refusal, so a FieldPulse request's refusal names FieldPulse (spec §5.5).
13. **`moveDialogDefaults(card, today, now)`** takes `now` (ended bands are disabled and the default skips them).
14. **Optional calendar fields.** `DashboardRequest` gains OPTIONAL `visitId`, `visitVersion`, `crew`, `started`, `movable`, `laneRole`, `laneTechnicianId`, `fieldpulse` (dashboard, dispatch and month share the type); `SchedulingCalendar.blocks` is optional (day view only); `AppointmentAssignmentRecord.started` / `hasProgress` are optional.
15. **Unschedule body** `{ visitId: uuid | null, expectedVersion: int | null }` is required (spec §5.4 "the card already carries it").
16. **Mass classification order:** `fieldpulse`, `helper`, `later_visit`, `ended`, `started`, `window_ended`, `already_on_visit`, `time_off`, else `moves` with the soft `conflict` flag.
17. **Test seam.** `moveVisit(…, hooks?: { afterPreRead?: () => Promise<void> })` exists only so integration (c) can inject a helper's done tap between the pre-read and the batch; no route passes it.
18. **Ids are lowercased** at every route boundary (path id, body ids) before they reach a writer, so an uppercase `technicianId` equal to the lead is not a lead change.
19. **Dialog focus on Base UI.** The repo's `Dialog` is Base UI (`@base-ui/react/dialog`), which has no `onCloseAutoFocus`; spec §7.4's "Dialogs set `onCloseAutoFocus={e => e.preventDefault()}`" is built as `finalFocus={false}` on `DialogContent` (the Popup prop) plus the board's `focusAfterMove` helper on the next frame.
20. **`RadioGroup` doesn't exist** in `src/components/ui/`; Task 9a adds `src/components/ui/radio-group.tsx`, a thin wrapper over `@base-ui/react/radio-group` and `@base-ui/react/radio` (already installed, `@base-ui/react` 1.5).

**Rejected or deferred** (one line each):
- A `pushScheduleToFieldpulse` wrapper and FieldPulse time moves: spec §10 follow-up, needs the owner.
- Keyboard drag: removed (L2-8); `Move…` is the keyboard and touch path.
- Week-view blocks, a capacity strip, `reserveCapacitySlot` changes: spec §10.

## Global Constraints

- Gates before every commit: `npx tsc --noEmit` → 0; `npx eslint <changed files>` → 0 errors (warnings allowed); `npx vitest run` never below the live baseline (533 files / 6 760 passed / 1 skipped on `b9cfba1`; capture it again before Task 1 and report files / passed / skipped in every task report; a single failure on a full run: rerun once before treating it as a regression). No jsdom/RTL: component logic lives in pure helpers tested in node. `node scripts/agent/verify-skills.mjs` → 0 missing when skills change (Task 11). `npx drizzle-kit generate` → "No schema changes" after Task 11 (no schema edits in M2).
- `.env.local` is the DEV Neon branch. NEVER point it at prod (`ep-withered-hill`). The integration suite, `scripts/agent/m2-walk.mts` and every probe refuse that host.
- **Walk and probe safety (owner's rules):** UI walks and probes run on THROWAWAY orgs only (`createOrgCore` via `scripts/agent/m2-walk.mts seed`), with the comms queue at 0 before seeding (`SELECT count(*) FROM communication_jobs WHERE status='pending' AND scheduled_for <= now() + interval '15 minutes'` must be 0), never touching the default org `00000000-0000-0000-0000-000000000001`, and the org is deleted afterwards (`m2-walk.mts delete <org>` asserts zero `communication_jobs` for it first). **No step writes to FieldPulse**: the dev default org's FieldPulse key reaches the owner's LIVE account. FieldPulse-mapped rows are made by setting `fieldpulse_job_id` with SQL on a throwaway org that has no FieldPulse connection; the FieldPulse-connected case in integration (f) uses a dummy key and a mocked client. Requests are inserted by SQL, never through `POST /api/admin/requests`.
- neon-http: `db.transaction()` throws; every writer is ONE `db.batch` (`runBatch` from `src/lib/admin/invoice-field-writes.ts` for raw SQL lists, `lockedUpdate` for the drizzle sheet writers), led by L_req (`lockRequestSql`); a deadlock (40P01) is `STALE`, never a 500.
- SQL rules (M3b/M3c/M3d, kept): every enum literal cast (`'cancelled'::request_status`); every fragment holding `OR` in its own parentheses and pinned by a `PgDialect` render test; `organization_id = $org` on EVERY table reference that M2 writes, subqueries and EXISTS bodies included. Reused correlated fragments from before M2 (`visitEndedSql`, `displayVisitIdSql`, `placedByVisitSql`, the guard's `ended()`) bind no org of their own; they are correlated on an outer request row the statement already filters by `organization_id`, so tenancy holds (critic A hygiene note); array parameters through `sql.param([...])::uuid[]` or `uuidArraySql` (a bare JS array expands to `($1, $2)`); trusted aliases only through `sql.raw` after a `/^[a-z][a-z0-9_]*$/` check.
- Tenancy and envelopes: `getAdminSession()` (`@/lib/auth/session`); `successResponse` / `errorResponse` / `readJsonBody` (`@/lib/api-response`); `isUuid` (`@/lib/validation/uuid`); `slidingWindow(key, max, windowMs)` with `RATE_LIMITS.adminMutation` for writes and `adminRead` for the preview; `logAudit` (`@/lib/admin/audit`) or an in-batch audit INSERT; audit details are ids, enums, booleans and counts only — no names, no instants. Logs carry codes and ids only (`errorCode` from `@/lib/logger`); responses never carry `err.message`. Route files export only HTTP methods and `dynamic = "force-dynamic"`: helpers live in `src/lib`.
- **No M2 file imports a FieldPulse client or push** (`@/lib/integrations/fieldpulse/*`); Task 8's route test greps for it.
- Copy canon: sentence case; office copy says "request" and "technician"; "cancelled"; Unicode `…` and `’`; no exclamation marks; human error copy only. Every user-facing string in this plan is EXACT (spec §8 plus lead ruling 10); do not reword. Times through `formatBusinessTimeRange` ("9 AM–11 AM"), days through `formatDayLabel` ("Tue, Nov 10") in `BUSINESS_TIME_ZONE`.
- UI: admin primitives (`src/components/admin/ui/`), `Dialog` from `@/components/ui/dialog`, `RadioGroup` / `RadioItem` from `@/components/ui/radio-group` (Task 9a), `Select` with a `SelectValue` formatter (`selectLabel`), focus rings with `focus-visible:outline-solid`. Read `~/.claude/design-principles.md`, `.claude/skills/page-calendar/SKILL.md`, `.claude/skills/admin-pages/SKILL.md` before Tasks 9a–10; `.claude/skills/page-requests/SKILL.md` before Tasks 3, 4 and 10; `.claude/skills/page-dispatch/SKILL.md` before Task 11's docs.
- Files to re-read right before editing (other workstreams touch them): `vitest.config.ts` (Task 11 appends one line), `src/components/admin/request-detail-sheet.tsx` (Task 10), `src/lib/admin/queries.ts` (Tasks 3 and 7), `package.json` (Task 9b removes `@dnd-kit/sortable`; run `npm install` after, then `git add package.json package-lock.json`).
- Git: `git add` ONLY the task's files by path (never `git add -A` / `git add .`), never `--amend`, never force-push; other agents commit concurrently (retry once on `index.lock`). Every commit message ends with exactly these two lines:
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`
  `Claude-Session: https://claude.ai/code/session_01GuWoF63tQU1i7ELqyYU3A6`
- Order: execution is SEQUENTIAL — Tasks 0, 1, 2, … 8, 9a, 9b, 10, 11, one at a time, each committed (and reviewed) before the next starts, and each compiles and passes the full suite at its own boundary. A task whose change breaks an existing test owns updating it; that test is listed in the task's **Files**.
- Disk: about 4 GB free on the dev machine. One scratch worktree at a time (`git worktree add /tmp/m2-wt <sha>` + `ln -s "$PWD/node_modules" /tmp/m2-wt/node_modules`), removed with `git worktree remove --force /tmp/m2-wt` when done. Never run `npm install` / `npm uninstall` in a symlinked scratch worktree (it rewrites the main checkout's `node_modules`); Task 9b's `npm uninstall` runs in the real tree. Never `git stash` (the tree is shared). Walk screenshots go to the session scratchpad and are deleted after review.

## Review Focus

1. **An uppercase id from a client.** A hand-built body or a client that uppercases sends `technicianId: "ABCDEF…"` equal to the current lead: it must not count as a lead change (steps 2–4 would cancel and revive the lead's own row). Pinned by `an uppercase technicianId equal to the lead is not a lead change` (Task 5, `planMove`) and `lowercases the path id and every body id` (Task 8).
2. **A window that crosses midnight, or a DST night, with Keep.** An 11 PM–1 AM visit kept onto another day must end on the next day; a 9 AM–11 AM kept across 2027-03-14 must stay 9–11 Eastern, not shift an hour. Pinned by `keep keeps an end past midnight on D + 1` and `keep across the 2027-03-14 DST start` (Task 1).
3. **A technician deactivated between render and drop.** The pre-read saw them active; the batch must still refuse (`TECHNICIAN_NOT_FOUND` on the re-read), never park the request on an inactive user. Pinned by `step 1 requires the new lead to be an active technician of the org` (Task 3 render) and `a 0-row batch re-reads and answers TECHNICIAN_NOT_FOUND` (Task 5).
4. **A mass body with a repeated visit id, or 31 visits.** The same visit listed twice would run its statements twice in one batch; the second must not double-move or double-count. Pinned by `duplicate visit ids are refused` and `a 31st visit is refused` (Task 6 schema test; Task 8 route test).
5. **A drop whose band is exactly the current window on the same lane and day.** Nothing is sent and no banner shows (spec §5.2); a band that only overlaps shows the covered line. Pinned by `same lane and day, band equal to the window → noop without the covered line` (Task 1) and the 9b walk step "drop a morning card on its own morning band".

---

## File map (exclusive ownership)

| task | creates | modifies / deletes |
| --- | --- | --- |
| 0 | `scripts/agent/m2-walk.mts`, `scripts/agent/m2-drag.mts` | — (the spike's local edits to the calendar are reverted; `spike-m2-drag.mts` is deleted) |
| 1 | `src/lib/admin/board-types.ts`, `src/lib/admin/visit-started.ts` (+test), `src/lib/admin/move-window.ts` (+test) | `src/lib/admin/request-status.ts` (+`STARTED_ASSIGNMENT_STATUSES`) |
| 2 | `src/lib/admin/board-move.ts` (+test), `src/lib/admin/dispatch-copy.ts` (+test), `src/lib/admin/mass-reschedule-model.ts` (+test) | `src/lib/admin/types.ts` (optional calendar fields), `src/lib/admin/appointment-types.ts` (optional `started`, `hasProgress`) |
| 3 | `src/lib/admin/visit-move-sql.ts` (+test) | `src/lib/admin/visit-one-guard.ts` (+test), `src/lib/admin/queries.ts` (assign/reassign), `src/lib/admin/queries.test.ts`, `src/lib/admin/scheduling-queries.ts` (`placeAndAssignRequest`), `src/lib/admin/scheduling-queries.test.ts`, `src/app/api/admin/requests/[id]/assign/route.ts` (+`route.test.ts`), `src/app/api/admin/requests/[id]/route.ts` (FieldPulse refusal copy) |
| 4 | — | `src/lib/admin/assignment-queries.ts` (+test), `src/lib/admin/appointment-queries.ts` (`loadAppointments`), `src/app/api/admin/requests/[id]/appointments/[aid]/assignments/route.ts`, `src/lib/admin/scheduling-queries.ts` (`unscheduleRequest`), `src/lib/admin/scheduling-queries.test.ts`, `src/app/api/admin/requests/[id]/unschedule/route.ts` (+`route.test.ts`) |
| 5 | `src/lib/admin/visit-move-plan.ts` (+test), `src/lib/admin/visit-move.ts` (+test) | — |
| 6 | `src/lib/admin/mass-reschedule.ts` (+test) | `src/lib/admin/shift-queries.ts` (+`listShiftsInRange`; covered by integration (l)) |
| 7 | `src/lib/admin/board-crew-queries.ts` (+test) | `src/lib/admin/queries.ts` (`getSchedulingCalendar`), `src/lib/admin/queries.test.ts` |
| 8 | `src/lib/admin/move-pushes.ts`, `src/lib/admin/move-body.ts` (+test), `src/app/api/admin/requests/[id]/move/route.ts` (+`route.test.ts`), `src/app/api/admin/dispatch/mass-reschedule/route.ts`, `src/app/api/admin/dispatch/mass-reschedule/preview/route.ts` (+`mass-reschedule/route.test.ts`), `src/lib/admin/m2-imports.test.ts` | deletes `src/app/api/admin/requests/[id]/reschedule/route.ts`, its `route.test.ts`, `tests/api/admin/reschedule.test.ts` |
| 9a | `src/components/ui/radio-group.tsx`, `src/hooks/use-move-request.ts`, `src/lib/admin/move-request-client.ts` (+test), `src/components/admin/calendar/{crew-chips,lane-blocks,window-prompt-dialog,time-off-dialog,move-dialog,move-banner}.tsx` | `src/components/admin/calendar/{calendar-job-card,draggable-job-card,droppable-window-band,conflict-dialog}.tsx`, `src/lib/admin/calendar-dnd.ts` (+test) |
| 9b | — | `src/components/admin/calendar/interactive-scheduling-calendar.tsx`, `src/components/admin/calendar/draggable-unscheduled-panel.tsx`, `src/app/admin/(dashboard)/calendar/page.tsx`, `src/lib/admin/calendar-optimistic.ts` (+test); deletes `src/hooks/use-reschedule-job.ts`; `package.json` / `package-lock.json` (drop `@dnd-kit/sortable`) |
| 10 | `src/components/admin/calendar/{mass-move-dialog,lane-menu}.tsx`, `src/hooks/use-mass-reschedule.ts`, `src/components/admin/visit-crew-control.tsx`, `src/components/admin/visit-change-time-dialog.tsx`, `src/lib/admin/sheet-visit-copy.ts` (+test), `src/lib/admin/mass-dialog-state.ts` (+test), `src/lib/admin/mass-dialog-key.ts` (+test) | `src/app/admin/(dashboard)/calendar/page.tsx` (lane menu slot + dialog), `src/components/admin/request-detail-sheet.tsx` |
| 11 | `tests/integration/field-dispatch.test.ts` | `vitest.config.ts`, `.claude/skills/{page-calendar,page-requests,page-dispatch,admin-pages}/SKILL.md`, `docs/DISPATCH.md`, `replica/{features.csv,parity.md,build-log.md,architecture.md}`, memory `replica-program-fp-st.md` (not committed) |

The spec §9 browser walk runs in pieces: Task 0 proves the drag mechanics, Task 9b walks the board (prompt, confirm, Move anyway, drag back, time off, FieldPulse card, `Move…` by keyboard, Week view, 1023 px and 390 px), Task 10 walks the sheet crew control and `Move this day…`. Each walk seeds its own throwaway org with `m2-walk.mts` and deletes it.

---
### Task 0: Drag spike on the CURRENT calendar, then the M2 walk fixture

The spike runs before any feature code. It proves, against today's board with only spec §7.2's layout and drag settings applied locally (and reverted after): (a) a pointer drag lands on the intended band and lane, through auto-scroll to an off-screen lane; (b) Unscheduled → an off-screen lane; (c) `pointerWithin` band detection 4 px inside a band edge; (d) a drop on the right half of the second technician lane with `scrollLeft` unchanged; (e) Unscheduled → Unassigned with `scrollLeft` back at 0. The seeding and drag helpers it uses become the committed walk fixture; the spike script itself is deleted.

**Files:**
- Create: `scripts/agent/m2-walk.mts` (fixture CLI: `seed`, `seed --spike`, `state <org> <rid>`, `delete <org>`), `scripts/agent/m2-drag.mts` (Playwright helpers imported by every M2 walk)
- Temporary (never committed): `spike-m2-drag.mts` at the repo root; local edits to `src/components/admin/calendar/interactive-scheduling-calendar.tsx` and `src/components/admin/calendar/droppable-window-band.tsx`, reverted with `git checkout --` in Step 7

**Interfaces:**
- Consumes: today's board (`/admin/calendar`, the `POST …/reschedule` drag route, `placeAndAssignRequest`), `createOrgCore`, `signToken`.
- Produces: `m2-walk.mts seed [--spike]` prints ONE JSON line `{ org, admin, techs: { alex, sam, casey?, drew?, eli? }, day, bands: { morning|afternoon|evening: { start, end } }, requests: { … }, tokens: { admin } }` (`day` = tomorrow's business day; `bands` are that day's band instants); `state <org> <rid>` prints `{ assignedTo, start, end, status }`; `delete <org>` prints `{ deleted }`. `m2-drag.mts` exports `bandLocator(page, scope, day, window)`, `laneScroller(page)`, `scrollLeft(page)`, `dragToBand(page, source, target, opts?)`, `openBoard(page, base, day)` (the caller sets the session cookie on the context). Data attributes the helpers read (added locally here, permanently in Task 9a/9b): `data-lanes-scroller` on the lanes scroller; `data-band-scope` / `data-band-day` / `data-window` on each band.

- [ ] **Step 1: The walk fixture** — `scripts/agent/m2-walk.mts`:

```ts
/**
 * M2 walk fixture (dev only). Creates a THROWAWAY org with createOrgCore and
 * seeds the spec §9 data by SQL; prints one JSON line with ids and a minted
 * admin session (its org asserted). Never touches the default org; refuses
 * prod; refuses to seed while the comms queue holds a due message; never sets
 * a FieldPulse connection (the FieldPulse card is a bare fieldpulse_job_id).
 * `delete <orgId>` asserts the org queued nothing, then deletes it.
 *
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/agent/m2-walk.mts seed            # spec §9 walk data
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/agent/m2-walk.mts seed --spike    # task 0: five technicians
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/agent/m2-walk.mts state <orgId> <requestId>
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/agent/m2-walk.mts delete <orgId>
 */
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^([A-Z_0-9]+)=(.*)$/);
  if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.replace(/^"|"$/g, "");
}
if ((process.env.DATABASE_URL ?? "").includes("ep-withered-hill")) throw new Error("Refusing to run against the production database");

const DEFAULT_ORG = "00000000-0000-0000-0000-000000000001";
const ORG_PREFIX = "Probe Org M2 Walk ";
const { db } = await import("../../src/lib/db");
const { sql } = await import("drizzle-orm");
const { encrypt } = await import("../../src/lib/crypto");
const { signToken } = await import("../../src/lib/auth/config");
const { createOrgCore } = await import("../../src/lib/admin/provisioning");
const { businessWallClockToUtc, businessIsoDate, arrivalWindowUtcForBusinessDate } = await import("../../src/lib/admin/calendar-time");

type Row = Record<string, unknown>;
const run = async (q: ReturnType<typeof sql>): Promise<Row[]> => (await db.execute(q)).rows as Row[];
const one = async (q: ReturnType<typeof sql>): Promise<string> => String((await run(q))[0]!.id);

async function queueGuard(): Promise<void> {
  const [r] = await run(sql`SELECT count(*)::int AS n FROM communication_jobs WHERE status = 'pending' AND scheduled_for <= now() + interval '15 minutes'`);
  if (Number(r!.n) !== 0) throw new Error(`comms queue holds ${String(r!.n)} due message(s); not walking`);
}

/**
 * Tomorrow's business day: every window on it is still ahead, whatever the hour of the walk. Never a
 * Saturday: the walks step to the next day in a Sunday-first Week view, which must be the same week.
 */
function tomorrow(): string {
  const d = new Date(`${businessIsoDate(new Date())}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  if (d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
const at = (day: string, h: number, m = 0) => businessWallClockToUtc(day, h, m).toISOString();

async function seed(spike: boolean): Promise<void> {
  await queueGuard();
  const out = await createOrgCore({
    name: `${ORG_PREFIX}${randomUUID().slice(0, 8)}`,
    createdBy: null,
    ownerEmail: null,
    ownerUser: { email: `owner-${randomUUID()}@throwaway.example`, name: "Probe Owner", googleId: `probe-${randomUUID()}` },
    skipOrgCountCheck: true,
  });
  if (!out.ok) throw new Error(`createOrgCore failed: ${JSON.stringify(out.error)}`);
  const org = out.result.organizationId;
  if (org === DEFAULT_ORG) throw new Error("refusing the default org");
  const admin = out.result.ownerUserId!;
  const [conn] = await run(sql`SELECT count(*)::int AS n FROM fieldpulse_connections WHERE organization_id = ${org}`);
  if (Number(conn!.n) !== 0) throw new Error("throwaway org unexpectedly has a FieldPulse connection");

  const tech = async (name: string) => {
    const id = await one(sql`INSERT INTO users (organization_id,email,name,role,password_hash,is_active)
      VALUES (${org},'tech-'||gen_random_uuid()||'@throwaway.example',${name},'technician','x',true) RETURNING id`);
    // Every weekday, all day: no drop in the walk is refused as out of hours.
    await run(sql`INSERT INTO technician_availability (organization_id, technician_id, day_of_week, start_minute, end_minute)
      SELECT ${org}::uuid, ${id}::uuid, d, 0, 1440 FROM generate_series(0, 6) AS d`);
    return id;
  };
  const techs: Record<string, string> = { alex: await tech("Alex Rivera"), sam: await tech("Sam Lee") };
  if (spike) {
    techs.casey = await tech("Casey Park");
    techs.drew = await tech("Drew Moss");
    techs.eli = await tech("Eli Grant");
  }
  const day = tomorrow();

  const request = async (o: { name: string; lead: string | null; start: string | null; end: string | null; status: string; fieldpulse?: boolean }) => {
    const cust = await one(sql`INSERT INTO customers (organization_id,name_encrypted) VALUES (${org},${encrypt(o.name)}) RETURNING id`);
    const sess = await one(sql`INSERT INTO customer_sessions (organization_id,token) VALUES (${org},gen_random_uuid()::text) RETURNING id`);
    return one(sql`INSERT INTO service_requests (organization_id,session_id,assigned_to,customer_id,issue_type,urgency,description,reference_number,
        scheduled_date,arrival_window_start,arrival_window_end,status,fieldpulse_job_id)
      VALUES (${org},${sess},${o.lead},${cust},'no_heat','medium','M2 walk probe','WLK-'||substr(md5(random()::text),1,8),
        ${o.start}::timestamptz,${o.start}::timestamptz,${o.end}::timestamptz,${o.status}::request_status,
        ${o.fieldpulse ? `fp-walk-${randomUUID().slice(0, 8)}` : null})
      RETURNING id`);
  };

  const requests: Record<string, string> = {};
  if (spike) {
    // (a) Alex 9–11 → Sam's afternoon (lane 5, off-screen at 1440).
    requests.a = await request({ name: "Spike Lane Five", lead: techs.alex!, start: at(day, 9), end: at(day, 11), status: "scheduled" });
    // (b) Unscheduled → Eli's morning (lane 4, off-screen).
    requests.b = await request({ name: "Spike Tray Off", lead: null, start: null, end: null, status: "pending" });
    // (c) Casey 1–3 PM: two drops 4 px inside the morning/afternoon edge.
    requests.c = await request({ name: "Spike Band Edge", lead: techs.casey!, start: at(day, 13), end: at(day, 15), status: "scheduled" });
    // (d) Alex 5–7 PM → right half of Casey's lane (the second technician lane), evening band.
    requests.d = await request({ name: "Spike Near Lane", lead: techs.alex!, start: at(day, 17), end: at(day, 19), status: "scheduled" });
    // (e) Unscheduled → the Unassigned lane's morning band.
    requests.e = await request({ name: "Spike Tray Home", lead: null, start: null, end: null, status: "pending" });
  } else {
    // Spec §9 walk: a 9–11 request on Alex; Alex en route on a morning (8 AM–12 PM) request;
    // an afternoon request on Alex; Sam off 4 PM–8 PM; a FieldPulse card set by SQL.
    requests.nineEleven = await request({ name: "Pat Nine", lead: techs.alex!, start: at(day, 9), end: at(day, 11), status: "scheduled" });
    requests.enRoute = await request({ name: "Robin Route", lead: techs.alex!, start: at(day, 8), end: at(day, 12), status: "scheduled" });
    await run(sql`UPDATE appointment_assignments a SET status = 'en_route'::request_status, en_route_at = now()
      FROM appointments p WHERE a.appointment_id = p.id AND p.service_request_id = ${requests.enRoute} AND p.appointment_number = 1
        AND p.organization_id = ${org} AND a.organization_id = ${org} AND a.technician_id = ${techs.alex} AND a.is_lead`);
    await run(sql`UPDATE service_requests SET status = 'en_route'::request_status WHERE id = ${requests.enRoute} AND organization_id = ${org}`);
    requests.afternoon = await request({ name: "Lee Afternoon", lead: techs.alex!, start: at(day, 12), end: at(day, 16), status: "scheduled" });
    requests.fieldpulse = await request({ name: "Fran Pulse", lead: techs.alex!, start: at(day, 13), end: at(day, 15), status: "scheduled", fieldpulse: true });
    requests.unscheduled = await request({ name: "Una Placed", lead: null, start: null, end: null, status: "pending" });
    await run(sql`INSERT INTO technician_shifts (organization_id, technician_id, kind, title, starts_at, ends_at, removes_capacity)
      VALUES (${org}, ${techs.sam}, 'time_off', NULL, ${at(day, 16)}::timestamptz, ${at(day, 20)}::timestamptz, true)`);
  }

  const [u] = await run(sql`SELECT id, email, name, role, organization_id FROM users WHERE id = ${admin}`);
  if (u!.organization_id !== org) throw new Error("token org mismatch");
  const tokens = {
    admin: await signToken({ userId: admin, email: String(u!.email), name: String(u!.name), role: u!.role as "super_admin", organizationId: org }),
  };
  const band = (w: "morning" | "afternoon" | "evening") => {
    const b = arrivalWindowUtcForBusinessDate(day, w);
    return { start: b.start.toISOString(), end: b.end.toISOString() };
  };
  const bands = { morning: band("morning"), afternoon: band("afternoon"), evening: band("evening") };
  console.log(JSON.stringify({ org, admin, techs, day, bands, requests, tokens }));
}

async function state(org: string, rid: string): Promise<void> {
  const [r] = await run(sql`SELECT assigned_to, arrival_window_start, arrival_window_end, status FROM service_requests WHERE id = ${rid} AND organization_id = ${org}`);
  if (!r) throw new Error("no such request in that org");
  const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);
  console.log(JSON.stringify({ assignedTo: r.assigned_to ?? null, start: iso(r.arrival_window_start), end: iso(r.arrival_window_end), status: r.status }));
}

async function remove(org: string): Promise<void> {
  if (org === DEFAULT_ORG) throw new Error("refusing the default org");
  const [q] = await run(sql`SELECT count(*)::int AS n FROM communication_jobs WHERE organization_id = ${org}`);
  if (Number(q!.n) !== 0) throw new Error(`the walk queued ${String(q!.n)} communication job(s)`);
  const deleted = await run(sql`DELETE FROM organizations WHERE id = ${org} AND name LIKE ${`${ORG_PREFIX}%`} RETURNING id`);
  if (deleted.length !== 1) throw new Error(`no walk org ${org} was deleted`);
  console.log(JSON.stringify({ deleted: org }));
}

const [cmd, arg, arg2] = process.argv.slice(2);
if (cmd === "seed") await seed(arg === "--spike");
else if (cmd === "state" && arg && arg2) await state(arg, arg2);
else if (cmd === "delete" && arg) await remove(arg);
else throw new Error("usage: m2-walk.mts seed [--spike] | state <orgId> <requestId> | delete <orgId>");
process.exit(0);
```

Check the two table names the fixture relies on before running: `grep -n '"fieldpulse_connections"\|"technician_availability"' src/lib/db/schema.ts` → both present (if the connections table has another name, use it; the check must stay).

- [ ] **Step 2: The drag helpers** — `scripts/agent/m2-drag.mts` (no top-level side effects; every M2 walk imports it):

```ts
/**
 * Playwright drag helpers for the M2 calendar walks. Pointer drags only
 * (dnd-kit PointerSensor: activation distance 6 px, so the first move is 10 px).
 * Auto-scroll is driven by holding the pointer near the lanes scroller's right
 * edge over a band, then polling until the target band is fully visible.
 */
import type { Locator, Page } from "playwright";

export type Band = "morning" | "afternoon" | "evening";

export function bandLocator(page: Page, scope: string, day: string, window: Band): Locator {
  return page.locator(`[data-band-scope="${scope}"][data-band-day="${day}"][data-window="${window}"]`);
}

export function laneScroller(page: Page): Locator {
  return page.locator("[data-lanes-scroller]");
}

export async function scrollLeft(page: Page): Promise<number> {
  return laneScroller(page).evaluate((el) => (el as HTMLElement).scrollLeft);
}

async function box(loc: Locator) {
  const b = await loc.boundingBox();
  if (!b) throw new Error("element has no box (not rendered)");
  return b;
}

/** Fully inside the scroller horizontally (the scroller clips; boundingBox does not). */
async function fullyVisible(page: Page, target: Locator): Promise<boolean> {
  const [s, t] = await Promise.all([box(laneScroller(page)), box(target)]);
  return t.x >= s.x && t.x + t.width <= s.x + s.width;
}

export interface DragOptions {
  /** Point inside the target band, as fractions of its box (default centre). */
  readonly at?: { readonly fx: number; readonly fy?: number; readonly dy?: number };
  /** Hold near the scroller's right edge until the target is visible. */
  readonly viaRightEdge?: boolean;
  readonly timeoutMs?: number;
}

export async function dragToBand(page: Page, source: Locator, target: Locator, opts: DragOptions = {}): Promise<void> {
  const s = await box(source);
  await page.mouse.move(s.x + s.width / 2, s.y + Math.min(12, s.height / 2));
  await page.mouse.down();
  await page.mouse.move(s.x + s.width / 2 + 10, s.y + Math.min(12, s.height / 2) + 10, { steps: 3 });

  if (opts.viaRightEdge && !(await fullyVisible(page, target))) {
    const sc = await box(laneScroller(page));
    const t = await box(target);
    // Over a band (the peeking lane's) so dnd-kit's `over` node has the scroller as an ancestor.
    await page.mouse.move(sc.x + sc.width - 20, t.y + t.height / 2, { steps: 12 });
    const deadline = Date.now() + (opts.timeoutMs ?? 8_000);
    while (!(await fullyVisible(page, target))) {
      if (Date.now() > deadline) {
        await page.mouse.up();
        throw new Error("auto-scroll never brought the target band into view");
      }
      await page.waitForTimeout(50);
    }
  }

  const point = async () => {
    const t = await box(target);
    const fx = opts.at?.fx ?? 0.5;
    const y = opts.at?.dy !== undefined ? t.y + opts.at.dy : t.y + t.height * (opts.at?.fy ?? 0.5);
    return { x: t.x + t.width * fx, y };
  };
  const first = await point();
  await page.mouse.move(first.x, first.y, { steps: 12 });
  await page.waitForTimeout(150);
  // Re-aim once: the board may have scrolled while the pointer left the edge zone.
  const second = await point();
  await page.mouse.move(second.x, second.y, { steps: 2 });
  await page.mouse.up();
}

/** Open /admin/calendar (the context carries the session cookie) and step forward to `day` (one or two days ahead in every M2 walk). */
export async function openBoard(page: Page, base: string, day: string): Promise<void> {
  await page.goto(`${base}/admin/calendar`, { waitUntil: "load", timeout: 60_000 });
  const band = page.locator(`[data-band-day="${day}"]`).first();
  for (let i = 0; i < 3; i++) {
    await page.getByRole("button", { name: "Next day" }).click();
    if (await band.waitFor({ timeout: 10_000 }).then(() => true, () => false)) return;
  }
  throw new Error(`the board never showed ${day}`);
}
```

- [ ] **Step 3: Type-check both files**

Run: `npx tsc --noEmit && npx eslint scripts/agent/m2-walk.mts scripts/agent/m2-drag.mts`
Expected: 0 errors (`tsconfig.json` includes `**/*.mts`, so both scripts are type-checked).

- [ ] **Step 4: Apply §7.2's layout and drag settings LOCALLY (not committed).** Three edits:

In `src/components/admin/calendar/interactive-scheduling-calendar.tsx`, replace the import line

```ts
  closestCenter,
```

with

```ts
  pointerWithin,
```

and replace

```tsx
      collisionDetection={closestCenter}
```

with

```tsx
      collisionDetection={pointerWithin}
      autoScroll={{ threshold: { x: 0.04, y: 0.2 }, acceleration: 3 }}
```

In the same file, `DayView`'s body: replace

```tsx
    <div className="flex gap-2 overflow-x-auto pb-2">
      {/* pt-7 offsets the axis past the lane header row (h-6 + mb-1 = 28px),
          as in the week view, so each hour label sits on its line. */}
      <div className="pt-7">
        <TimeAxis />
      </div>
      <div className="flex min-w-0 flex-1 gap-2">
```

with

```tsx
    <div className="flex gap-2 pb-2">
      {/* pt-7 offsets the axis past the lane header row (h-6 + mb-1 = 28px),
          as in the week view, so each hour label sits on its line. */}
      <div className="pt-7">
        <TimeAxis />
      </div>
      <div data-lanes-scroller className="flex min-w-0 flex-1 gap-2 overflow-x-auto">
```

In `src/components/admin/calendar/droppable-window-band.tsx`, replace

```tsx
      data-window={window}
```

with

```tsx
      data-window={window}
      data-band-scope={scope}
      data-band-day={isoDay}
```

Run `npx tsc --noEmit` → 0 (the edits compile against today's code).

- [ ] **Step 5: The spike script** — `spike-m2-drag.mts` at the repo root (deleted in Step 7). Dev server running (`npm run dev`, background; stop it afterwards):

```ts
import { execFileSync } from "node:child_process";
import { chromium } from "playwright";
import { bandLocator, dragToBand, openBoard, scrollLeft } from "./scripts/agent/m2-drag.mts";

const env = { ...process.env, NODE_OPTIONS: "--conditions=react-server" };
const fixture = (...args: string[]) =>
  JSON.parse(execFileSync("npx", ["tsx", "scripts/agent/m2-walk.mts", ...args], { encoding: "utf8", env }).trim().split("\n").pop()!);
type Span = { start: string; end: string };
const fx = fixture("seed", "--spike") as {
  org: string; day: string; techs: Record<string, string>; requests: Record<string, string>; tokens: { admin: string };
  bands: { morning: Span; afternoon: Span; evening: Span };
};
const BASE = "http://localhost:3000";
const OUT = process.env.SPIKE_OUT ?? "/tmp";
const state = (rid: string) => fixture("state", fx.org, rid) as { assignedTo: string | null; start: string | null; end: string | null };
const results: Record<string, string> = {};
const check = (name: string, ok: boolean, detail: unknown) => {
  results[name] = ok ? "PASS" : `FAIL ${JSON.stringify(detail)} (route: ${statuses.at(-1) ?? "no response"})`;
  console.log(name, results[name]);
};
// Records the response status: a non-2xx, or a timeout here, is infrastructure, not evidence about the drag (Step 6).
const statuses: string[] = [];
const settle = (page: import("playwright").Page) =>
  page.waitForResponse((r) => r.url().includes("/reschedule") || r.url().includes("/unschedule"), { timeout: 15_000 })
    .then((r) => { statuses.push(`${r.url().split("/").at(-1)} ${r.status()}`); return r; });

const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  await ctx.addCookies([{ name: "hvac_admin_session", value: fx.tokens.admin, domain: "localhost", path: "/" }]);
  const page = await ctx.newPage();
  await openBoard(page, BASE, fx.day);
  const card = (_rid: string, name: string) => page.getByRole("button", { name: new RegExp(`^${name} ·`) });
  const tray = (name: string) => page.locator("li").filter({ hasText: name }).getByRole("button");
  await page.screenshot({ path: `${OUT}/spike-0-board.png` });

  // Layout fact (§7.2): the lanes scroller's width at 1440 with the sidebar expanded.
  const width = await page.locator("[data-lanes-scroller]").evaluate((el) => (el as HTMLElement).clientWidth);
  console.log("lanes scroller width", width, "(spec §7.2 says 766)");

  // (a) lane 1 (Alex) → lane 5 (Sam), via the right edge.
  let wait = settle(page);
  await dragToBand(page, card(fx.requests.a!, "Spike Lane Five"), bandLocator(page, fx.techs.sam!, fx.day, "afternoon"), { viaRightEdge: true });
  await wait;
  let s = state(fx.requests.a!);
  check("(a) lane 1 → lane 5", s.assignedTo === fx.techs.sam && s.start === fx.bands.afternoon.start && s.end === fx.bands.afternoon.end, s);
  await page.screenshot({ path: `${OUT}/spike-a.png` });

  // (b) Unscheduled → lane 4 (Eli), off-screen.
  await page.locator("[data-lanes-scroller]").evaluate((el) => { (el as HTMLElement).scrollLeft = 0; });
  wait = settle(page);
  await dragToBand(page, tray("Spike Tray Off"), bandLocator(page, fx.techs.eli!, fx.day, "morning"), { viaRightEdge: true });
  await wait;
  s = state(fx.requests.b!);
  check("(b) Unscheduled → lane 4", s.assignedTo === fx.techs.eli && s.start === fx.bands.morning.start, s);

  // (c) pointerWithin 4 px inside a band edge: just below the morning/afternoon line → afternoon,
  // then just above it → morning. Casey is the second technician lane (fully visible).
  await page.locator("[data-lanes-scroller]").evaluate((el) => { (el as HTMLElement).scrollLeft = 0; });
  wait = settle(page);
  await dragToBand(page, card(fx.requests.c!, "Spike Band Edge"), bandLocator(page, fx.techs.casey!, fx.day, "afternoon"), { at: { fx: 0.5, dy: 4 } });
  await wait;
  const afternoon = state(fx.requests.c!);
  const morningBox = await bandLocator(page, fx.techs.casey!, fx.day, "morning").boundingBox();
  wait = settle(page);
  await dragToBand(page, card(fx.requests.c!, "Spike Band Edge"), bandLocator(page, fx.techs.casey!, fx.day, "morning"), { at: { fx: 0.5, dy: morningBox!.height - 4 } });
  await wait;
  const morning = state(fx.requests.c!);
  check("(c) 4 px inside the edge", afternoon.start === fx.bands.afternoon.start && morning.start === fx.bands.morning.start, { afternoon, morning });

  // (d) right half of the second technician lane: lands there, scrollLeft unchanged.
  await page.locator("[data-lanes-scroller]").evaluate((el) => { (el as HTMLElement).scrollLeft = 0; });
  const before = await scrollLeft(page);
  wait = settle(page);
  await dragToBand(page, card(fx.requests.d!, "Spike Near Lane"), bandLocator(page, fx.techs.casey!, fx.day, "evening"), { at: { fx: 0.85, fy: 0.3 } });
  await wait;
  const afterD = await scrollLeft(page);
  s = state(fx.requests.d!);
  check("(d) near-lane drop, no slide", s.assignedTo === fx.techs.casey && s.start === fx.bands.evening.start && afterD === before, { s, before, afterD });

  // (e) Unscheduled → Unassigned: crosses the right-edge zone; lands, scrollLeft back at 0.
  wait = settle(page);
  await dragToBand(page, tray("Spike Tray Home"), bandLocator(page, "unassigned", fx.day, "morning"), { at: { fx: 0.5, fy: 0.5 } });
  await wait;
  const afterE = await scrollLeft(page);
  s = state(fx.requests.e!);
  check("(e) Unscheduled → Unassigned", s.start === fx.bands.morning.start && s.assignedTo === null && afterE === 0, { s, afterE });
  await page.screenshot({ path: `${OUT}/spike-e.png` });
} finally {
  await browser.close();
  fixture("delete", fx.org);
}
console.log(JSON.stringify(results));
```

Run: `SPIKE_OUT=<session scratchpad> NODE_OPTIONS=--conditions=react-server npx tsx spike-m2-drag.mts`
Expected: five `PASS` lines, then `{"deleted":"<org>"}` from the fixture. Look at the three screenshots. Record the printed lanes scroller width.

Every assertion compares exact instants against the fixture's `bands` (computed server-side for the walk day, so EST/EDT never matters). Never widen one to "any start".

- [ ] **Step 6: Retune or redesign on failure.** First tell the drag model from the script: a check that failed on a timeout, a missing element or a non-2xx route status (printed after `route:`) is **infrastructure** — fix the script or the seed and re-run Step 5; it is not evidence about dragging. Then use this table (record the outcome in the Task 0 report and in Task 9b's `DndContext`):

| failing check | change |
| --- | --- |
| (d) and/or (e) only | Retune and re-run Steps 5–6, **at most 3 retunes**, in this order: (1) `threshold.x` 0.06 → 0.04 (31 px); (2) `acceleration` 5 → 3; (3) `threshold.x` → 0.03. The first passing values replace §7.2's `{ x: 0.06, y: 0.2 }, acceleration 5` in Task 9b Step 3 and in Task 11's page-calendar text. If (d)/(e) still fail after the third retune, **stop**: report to the spec owner that §7.2 needs a layout change (e.g. a narrower Unscheduled panel or lanes narrow enough that the second technician lane is clear of the edge zone), and build nothing until the spec says which. |
| (c) | `pointerWithin` is unreliable at band edges on this layout. One try: give each band a 2 px transparent inset (bands no longer touch) and re-run (c). If it still fails, **stop** and report: §5.2's `covers` rule depends on the band under the pointer, so the spec owner picks the fallback (e.g. `closestCenter` among bands of the hovered lane). |
| (a) or (b) | Auto-scroll can't reach off-screen lanes. **Stop** and report the spec change: §7.2 drops "the rest scroll" for a lane picker (`Move…` names the lane; drags only between visible lanes), §9's walk replaces every off-screen drag with `Move…`, and Task 0 (a)/(b) are rewritten against `Move…`. |
| measured width ≠ 766 ± 2 | Not a failure: record the real width; Task 11 corrects page-calendar's lane-count sentence ("Unassigned plus two technician lanes are fully visible") if the count changes. |

- [ ] **Step 7: Revert the local edits, delete the spike, commit the fixture**

```bash
git checkout -- src/components/admin/calendar/interactive-scheduling-calendar.tsx src/components/admin/calendar/droppable-window-band.tsx
rm spike-m2-drag.mts
git status --short   # only the two new scripts
npx tsc --noEmit && npx eslint scripts/agent/m2-walk.mts scripts/agent/m2-drag.mts
git add scripts/agent/m2-walk.mts scripts/agent/m2-drag.mts
git commit -m "$(cat <<'EOF'
chore(m2): drag spike passed; M2 walk fixture and drag helpers

Task 0 of the M2 plan: pointer drags with auto-scroll to off-screen
lanes, pointerWithin band edges, and near-lane drops without sliding were
proved on the current calendar with spec 7.2's layout applied locally
(reverted). The fixture seeds throwaway orgs only.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01GuWoF63tQU1i7ELqyYU3A6
EOF
)"
```

Report: the five results, the measured scroller width, the final `autoScroll` values, the screenshot paths (then delete the screenshots).

---
### Task 1: Pure rules — the started rule and window resolution

**Files:**
- Create: `src/lib/admin/board-types.ts`, `src/lib/admin/visit-started.ts`, `src/lib/admin/visit-started.test.ts`, `src/lib/admin/move-window.ts`, `src/lib/admin/move-window.test.ts`
- Modify: `src/lib/admin/request-status.ts` (append `STARTED_ASSIGNMENT_STATUSES` after `REASSIGNABLE_STATUSES`)

**Interfaces:**
- Consumes: `arrivalWindowUtcForBusinessDate`, `businessWallClockToUtc`, `businessIsoDate`, `toBusinessWallClock`, `RescheduleWindowRow` (`src/lib/admin/calendar-time.ts`); `ARRIVAL_WINDOWS`, `ArrivalWindow` (`src/lib/admin/arrival-window.ts`).
- Produces (later tasks import exactly these):
  - `board-types.ts`: `CrewState`, `CrewMember`, `LaneRole`, `Movable`, `BoardBlock`, `MoveConfirm`, `WindowRule`, `MoveBand`, `MoveBody`, `StartedDetail`, `ConflictDetail`, `MoveNeedsDetails`, `TimeOffDetail`, `MoveSuccessData`, `MassReason`, `MASS_PRESKIP_REASONS`, `MassPreSkipReason`, `MassOutcome`, `MassCandidate`, `MassResult`.
  - `request-status.ts`: `STARTED_ASSIGNMENT_STATUSES`.
  - `visit-started.ts`: `WORKING_STATUSES`, `rowStarted(row: StartedRowInput): boolean`, `anyTimestampSql(alias): SQL`, `startedRowSql(alias): SQL`.
  - `move-window.ts`: `TimeWindow`, `WindowKind`, `PromptPlan`, `ResolvedWindow`, `windowEqual`, `namedWindowOf`, `currentWindowKind`, `keepWindowOn`, `covers`, `promptPlan`, `resolveMoveWindow`, `windowHasEndedAt`, `timeOffHits`.

- [ ] **Step 1: Shared types** — `src/lib/admin/board-types.ts` (client-safe: type-only imports):

```ts
/**
 * M2 board and move contracts shared by the server writers, the routes and the
 * calendar client (spec §4–§7). Client-safe: no runtime imports.
 */
import type { ArrivalWindow } from "./arrival-window";
import type { RescheduleWindowRow } from "./calendar-time";

export type CrewState = "open" | "working" | "done";

/** One live row on the displayed visit. `name` is null for an inactive technician (withheld). */
export interface CrewMember {
  readonly technicianId: string;
  readonly name: string | null;
  readonly isLead: boolean;
  readonly state: CrewState;
}

export type LaneRole = "lead" | "helper";
export type Movable = "yes" | "no";

/** A technician_shifts row as the day view draws it (spec §3.4, §7.3). */
export interface BoardBlock {
  readonly id: string;
  readonly technicianId: string;
  readonly kind: "on_call" | "time_off" | "non_job";
  readonly title: string | null;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly removesCapacity: boolean;
}

export type MoveConfirm = "started" | "conflict";
export type WindowRule = "match" | "pick" | "keep";
export type MoveBand = RescheduleWindowRow;

/** Body of POST /api/admin/requests/[id]/move (spec §5.3). */
export interface MoveBody {
  readonly visitId: string | null;
  readonly expectedVersion: number | null;
  /** Business-tz day (YYYY-MM-DD) of the drop. */
  readonly day: string;
  /** The band under the pointer (or the dialog's band). */
  readonly band: MoveBand;
  readonly windowRule: WindowRule;
  readonly pick?: ArrivalWindow;
  /** The new lead; absent or equal to the current lead = keep. Never unassigns. */
  readonly technicianId?: string;
  readonly confirm: readonly MoveConfirm[];
}

export interface StartedDetail {
  readonly technicianId: string;
  readonly status: string;
  readonly hasTimestamp: boolean;
  readonly openTimeEntry: boolean;
}

export interface ConflictDetail {
  readonly id: string;
  readonly referenceNumber: string;
  readonly technicianId: string;
  readonly arrivalWindowStart: string;
  readonly arrivalWindowEnd: string;
}

/** `details` of a 409 HAS_PROGRESS / SCHEDULE_CONFLICT from the move route. Ids only, no names. */
export interface MoveNeedsDetails {
  readonly needs: readonly MoveConfirm[];
  readonly started?: readonly StartedDetail[];
  readonly conflicts?: readonly ConflictDetail[];
  readonly outsideAvailability?: boolean;
  /** A live row other than the current lead's is started (so a lead change won't reset the request to scheduled). */
  readonly othersStarted?: boolean;
}

/** One entry of TIME_OFF's `details.timeOff` (never overridable, so no `needs`). */
export interface TimeOffDetail {
  readonly technicianId: string;
  readonly startsAt: string;
  readonly endsAt: string;
  readonly kind: "on_call" | "time_off" | "non_job";
}

/** 200 `data` of the move route. */
export interface MoveSuccessData {
  readonly visitId: string;
  readonly visitVersion: number;
  readonly requestStatus: string;
  readonly arrivalWindowStart: string;
  readonly arrivalWindowEnd: string;
  readonly leadId: string | null;
  readonly confirmed: readonly MoveConfirm[];
}

/** Why mass reschedule left a visit where it was (spec §5.6). */
export type MassReason =
  | "started" | "ended" | "later_visit" | "time_off" | "window_ended"
  | "already_on_visit" | "fieldpulse" | "helper" | "stale";

/** Reasons the client may send in `preSkipped` (every preview reason, plus a conflict it didn't confirm). */
export const MASS_PRESKIP_REASONS = [
  "started", "ended", "later_visit", "time_off", "window_ended",
  "already_on_visit", "fieldpulse", "helper", "conflict",
] as const;
export type MassPreSkipReason = (typeof MASS_PRESKIP_REASONS)[number];

export type MassOutcome = "moves" | Exclude<MassReason, "stale">;

export interface MassCandidate {
  readonly visitId: string;
  readonly requestId: string;
  readonly referenceNumber: string;
  readonly customerName: string | null;
  readonly arrivalWindowStart: string;
  readonly arrivalWindowEnd: string;
  readonly visitNumber: number;
  readonly expectedVersion: number;
  readonly outcome: MassOutcome;
  /** Soft: overlaps another request or falls outside the lead's hours. */
  readonly conflict: boolean;
  /** For `helper`: the lead's first name ("Helping Alex"). */
  readonly leadFirstName: string | null;
}

export interface MassResult {
  readonly moved: readonly { readonly visitId: string; readonly requestId: string; readonly visitVersion: number }[];
  readonly skipped: readonly { readonly visitId: string; readonly reason: MassReason | "conflict" }[];
  readonly pushesNotSent: readonly string[];
}
```

- [ ] **Step 2: Write the failing tests** — `src/lib/admin/visit-started.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { rowStarted, startedRowSql, anyTimestampSql } from "./visit-started";
import { STARTED_ASSIGNMENT_STATUSES } from "./request-status";

const render = (q: Parameters<PgDialect["sqlToQuery"]>[0]) => new PgDialect().sqlToQuery(q).sql.replace(/\s+/g, " ");

describe("rowStarted (spec §3.2)", () => {
  const cases: Array<[string, boolean, boolean, boolean]> = [
    // status, isLead, hasTimestamp, started
    ["en_route", true, true, true],
    ["arrived", true, false, true],          // status counts: the trigger mirrors it onto an untouched lead
    ["in_progress", true, false, true],      // office status mirror (dev: 16 rows)
    ["completed", true, true, true],
    ["on_hold", true, true, true],           // a pause
    ["on_hold", true, false, false],         // untouched on_hold: timestamps only tell a pause apart
    ["scheduled", true, true, false],        // timestamps alone don't count
    ["assigned", true, false, false],
    ["cancelled", true, true, false],        // only live rows count
    ["en_route", false, false, true],        // a working helper
    ["in_progress", false, true, true],
    ["on_hold", false, true, true],
    ["completed", false, true, false],       // a done helper isn't working
    ["assigned", false, false, false],
  ];
  for (const [status, isLead, hasTimestamp, started] of cases) {
    it(`${isLead ? "lead" : "helper"} ${status}${hasTimestamp ? " with a timestamp" : ""} → ${started}`, () => {
      expect(rowStarted({ status, isLead, hasTimestamp })).toBe(started);
    });
  }
  it("the shared list is the lead's started statuses", () => {
    expect(STARTED_ASSIGNMENT_STATUSES).toEqual(["en_route", "arrived", "in_progress", "completed"]);
  });
});

describe("startedRowSql — the SQL twin", () => {
  it("renders the same rule with enum casts, every OR parenthesised", () => {
    expect(render(startedRowSql("a"))).toBe(
      "(a.status <> 'cancelled'::request_status AND (a.status IN ('en_route'::request_status, 'arrived'::request_status, 'in_progress'::request_status) OR (a.status = 'on_hold'::request_status AND (a.en_route_at IS NOT NULL OR a.arrived_at IS NOT NULL OR a.started_at IS NOT NULL OR a.completed_at IS NOT NULL)) OR (a.is_lead AND a.status = 'completed'::request_status)))",
    );
  });
  it("anyTimestampSql lists the four progress stamps", () => {
    expect(render(anyTimestampSql("sa"))).toBe(
      "(sa.en_route_at IS NOT NULL OR sa.arrived_at IS NOT NULL OR sa.started_at IS NOT NULL OR sa.completed_at IS NOT NULL)",
    );
  });
  it("refuses an alias that isn't a plain identifier", () => {
    expect(() => startedRowSql("a; DROP")).toThrow("bad SQL alias");
  });
});
```

`src/lib/admin/move-window.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  covers, currentWindowKind, keepWindowOn, namedWindowOf, promptPlan, resolveMoveWindow, timeOffHits, windowHasEndedAt,
  type TimeWindow,
} from "./move-window";
import type { BoardBlock } from "./board-types";

// 2026-11-10 is a Tuesday in EST (UTC-5): 9 AM = 14:00Z.
const D = "2026-11-10";
const w = (start: string, end: string): TimeWindow => ({ start: new Date(start), end: new Date(end) });
const NINE_ELEVEN = w("2026-11-10T14:00:00.000Z", "2026-11-10T16:00:00.000Z");
const MORNING = w("2026-11-10T13:00:00.000Z", "2026-11-10T17:00:00.000Z");
const ANYTIME = w("2026-11-10T13:00:00.000Z", "2026-11-11T01:00:00.000Z");
const ELEVEN_ONE = w("2026-11-10T16:00:00.000Z", "2026-11-10T18:00:00.000Z");
const SEVEN_NINE = w("2026-11-10T12:00:00.000Z", "2026-11-10T14:00:00.000Z");
const iso = (t: TimeWindow) => [t.start.toISOString(), t.end.toISOString()];

describe("namedWindowOf / currentWindowKind", () => {
  it("names the exact bands on the start's business day", () => {
    expect(namedWindowOf(MORNING.start, MORNING.end)).toBe("morning");
    expect(namedWindowOf(new Date("2026-11-10T21:00:00.000Z"), new Date("2026-11-11T01:00:00.000Z"))).toBe("evening");
    expect(namedWindowOf(ANYTIME.start, ANYTIME.end)).toBe("anytime");
    expect(namedWindowOf(NINE_ELEVEN.start, NINE_ELEVEN.end)).toBeNull();
  });
  it("band | anytime | custom | none", () => {
    expect(currentWindowKind(MORNING.start, MORNING.end)).toBe("band");
    expect(currentWindowKind(ANYTIME.start, ANYTIME.end)).toBe("anytime");
    expect(currentWindowKind(NINE_ELEVEN.start, NINE_ELEVEN.end)).toBe("custom");
    expect(currentWindowKind(null, null)).toBe("none");
    expect(currentWindowKind(MORNING.start, null)).toBe("none");
  });
});

describe("keepWindowOn", () => {
  it("keeps the wall-clock times on another day", () => {
    expect(iso(keepWindowOn(NINE_ELEVEN, "2026-11-11"))).toEqual(["2026-11-11T14:00:00.000Z", "2026-11-11T16:00:00.000Z"]);
  });
  it("keep keeps an end past midnight on D + 1", () => {
    const late = w("2026-11-11T04:00:00.000Z", "2026-11-11T06:00:00.000Z"); // 11 PM–1 AM from Nov 10
    expect(iso(keepWindowOn(late, "2026-11-12"))).toEqual(["2026-11-13T04:00:00.000Z", "2026-11-13T06:00:00.000Z"]);
  });
  it("keep across the 2027-03-14 DST start stays 9–11 Eastern", () => {
    const before = w("2027-03-13T14:00:00.000Z", "2027-03-13T16:00:00.000Z"); // 9–11 EST
    expect(iso(keepWindowOn(before, "2027-03-14"))).toEqual(["2027-03-14T13:00:00.000Z", "2027-03-14T15:00:00.000Z"]); // 9–11 EDT
  });
});

describe("covers (half-open, the window moved onto the drop day)", () => {
  it("anytime covers every band", () => {
    for (const b of ["morning", "afternoon", "evening"] as const) expect(covers(ANYTIME, D, b)).toBe(true);
  });
  it("11–1 covers morning and afternoon, not evening", () => {
    expect(covers(ELEVEN_ONE, D, "morning")).toBe(true);
    expect(covers(ELEVEN_ONE, D, "afternoon")).toBe(true);
    expect(covers(ELEVEN_ONE, D, "evening")).toBe(false);
  });
  it("7–9 covers morning only", () => {
    expect(covers(SEVEN_NINE, D, "morning")).toBe(true);
    expect(covers(SEVEN_NINE, D, "afternoon")).toBe(false);
  });
  it("a window ending exactly where a band starts doesn't cover it", () => {
    expect(covers(MORNING, D, "afternoon")).toBe(false);
  });
  it("is evaluated on the drop day", () => {
    expect(covers(NINE_ELEVEN, "2026-11-11", "morning")).toBe(true);
  });
  it("no window covers nothing", () => {
    expect(covers(null, D, "morning")).toBe(false);
  });
});

describe("promptPlan (spec §5.2)", () => {
  it("Unscheduled (no window) → use the band, no prompt", () => {
    expect(promptPlan(null, D, "afternoon", true)).toEqual({ kind: "use_band" });
  });
  it("a covered lane change never prompts: keep", () => {
    expect(promptPlan(NINE_ELEVEN, D, "morning", true)).toEqual({ kind: "keep" });
    expect(promptPlan(ANYTIME, D, "afternoon", true)).toEqual({ kind: "keep" });
    expect(promptPlan(ELEVEN_ONE, D, "afternoon", true)).toEqual({ kind: "keep" });
    expect(promptPlan(SEVEN_NINE, D, "morning", true)).toEqual({ kind: "keep" });
  });
  it("a covered day change keeps the window too", () => {
    expect(promptPlan(NINE_ELEVEN, "2026-11-11", "morning", false)).toEqual({ kind: "keep" });
  });
  it("same lane and day, band equal to the window → noop without the covered line", () => {
    expect(promptPlan(MORNING, D, "morning", false)).toEqual({ kind: "noop", coveredLine: false });
  });
  it("same lane and day, a band the window only overlaps → noop with the covered line", () => {
    expect(promptPlan(ANYTIME, D, "afternoon", false)).toEqual({ kind: "noop", coveredLine: true });
  });
  it("same day and lead: Keep isn't offered, default Use the new window", () => {
    expect(promptPlan(NINE_ELEVEN, D, "afternoon", false)).toEqual({ kind: "prompt", defaultChoice: "match", offerKeep: false });
  });
  it("crossing defaults: a band window → Use the new window; custom → Keep", () => {
    expect(promptPlan(MORNING, D, "afternoon", true)).toEqual({ kind: "prompt", defaultChoice: "match", offerKeep: true });
    expect(promptPlan(NINE_ELEVEN, D, "afternoon", true)).toEqual({ kind: "prompt", defaultChoice: "keep", offerKeep: true });
    expect(promptPlan(ELEVEN_ONE, D, "evening", true)).toEqual({ kind: "prompt", defaultChoice: "keep", offerKeep: true });
    expect(promptPlan(SEVEN_NINE, "2026-11-11", "afternoon", false)).toEqual({ kind: "prompt", defaultChoice: "keep", offerKeep: true });
  });
});

describe("resolveMoveWindow", () => {
  it("match → the drop band on the drop day", () => {
    expect(resolveMoveWindow(NINE_ELEVEN, D, "afternoon", "match")).toEqual({ ok: true, start: new Date("2026-11-10T17:00:00.000Z"), end: new Date("2026-11-10T21:00:00.000Z") });
  });
  it("pick → the named window on the drop day (anytime included)", () => {
    expect(resolveMoveWindow(NINE_ELEVEN, "2026-11-11", "morning", "pick", "anytime")).toEqual({ ok: true, start: new Date("2026-11-11T13:00:00.000Z"), end: new Date("2026-11-12T01:00:00.000Z") });
  });
  it("pick without a pick is not ok", () => {
    expect(resolveMoveWindow(NINE_ELEVEN, D, "morning", "pick")).toEqual({ ok: false });
  });
  it("keep → the same wall-clock times on the drop day", () => {
    expect(resolveMoveWindow(NINE_ELEVEN, "2026-11-12", "evening", "keep")).toEqual({ ok: true, start: new Date("2026-11-12T14:00:00.000Z"), end: new Date("2026-11-12T16:00:00.000Z") });
  });
  it("keep without a window is not ok (the route answers 400 windowRule)", () => {
    expect(resolveMoveWindow(null, D, "morning", "keep")).toEqual({ ok: false });
  });
});

describe("windowHasEndedAt", () => {
  it("ended once the end is at or before now", () => {
    expect(windowHasEndedAt(MORNING, new Date("2026-11-10T17:00:00.000Z"))).toBe(true);
    expect(windowHasEndedAt(MORNING, new Date("2026-11-10T16:59:59.000Z"))).toBe(false);
  });
});

describe("timeOffHits", () => {
  const block = (over: Partial<BoardBlock>): BoardBlock => ({
    id: "s1", technicianId: "sam", kind: "time_off", title: null,
    startsAt: "2026-11-10T21:00:00.000Z", endsAt: "2026-11-11T01:00:00.000Z", removesCapacity: true, ...over,
  });
  const EVENING = w("2026-11-10T21:00:00.000Z", "2026-11-11T01:00:00.000Z");
  it("hits a capacity-removing block of a checked technician that overlaps", () => {
    expect(timeOffHits([block({})], ["sam"], EVENING).map((b) => b.id)).toEqual(["s1"]);
  });
  it("ignores blocks that keep capacity, whatever the kind", () => {
    expect(timeOffHits([block({ kind: "on_call", removesCapacity: false }), block({ id: "s2", kind: "non_job", removesCapacity: false })], ["sam"], EVENING)).toEqual([]);
  });
  it("a capacity-removing on_call still hits", () => {
    expect(timeOffHits([block({ kind: "on_call", removesCapacity: true })], ["sam"], EVENING)).toHaveLength(1);
  });
  it("ignores technicians the move doesn't check, and touching edges", () => {
    expect(timeOffHits([block({})], ["alex"], EVENING)).toEqual([]);
    expect(timeOffHits([block({})], ["sam"], w("2026-11-10T17:00:00.000Z", "2026-11-10T21:00:00.000Z"))).toEqual([]);
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `npx vitest run src/lib/admin/visit-started.test.ts src/lib/admin/move-window.test.ts`
Expected: FAIL — `Failed to resolve import "./visit-started"` / `"./move-window"`.

- [ ] **Step 4: Implement.** Append to `src/lib/admin/request-status.ts` right after the `REASSIGNABLE_STATUSES` export:

```ts
/** Assignment-row statuses that mean a technician has started a visit (M2
 * spec §3.2): a lead row counts all four, a helper row the first three; a row
 * `on_hold` counts only with a progress timestamp (a pause). Live rows only. */
export const STARTED_ASSIGNMENT_STATUSES = ["en_route", "arrived", "in_progress", "completed"] as const satisfies readonly RequestStatus[];
```

`src/lib/admin/visit-started.ts`:

```ts
/**
 * "Started" (M2 spec §3.2): a live lead row en route, arrived, in progress or
 * completed, or on hold with a progress timestamp (a pause); a live helper row
 * en route, arrived, in progress or paused. Timestamps alone don't count; they
 * only tell a pause from an untouched on_hold. Status counts because the
 * trigger mirrors request status onto an untouched lead row (0050:147–159).
 * Pure `rowStarted` and its SQL twin `startedRowSql`; aliases are trusted
 * literals checked against a plain-identifier pattern.
 */
import { sql, type SQL } from "drizzle-orm";
import { STARTED_ASSIGNMENT_STATUSES } from "./request-status";

/** A helper is started only while working (or paused). */
export const WORKING_STATUSES = ["en_route", "arrived", "in_progress"] as const;

export interface StartedRowInput {
  readonly status: string;
  readonly isLead: boolean;
  readonly hasTimestamp: boolean;
}

export function rowStarted(row: StartedRowInput): boolean {
  if (row.status === "cancelled") return false;
  if (row.status === "on_hold") return row.hasTimestamp;
  const list: readonly string[] = row.isLead ? STARTED_ASSIGNMENT_STATUSES : WORKING_STATUSES;
  return list.includes(row.status);
}

const ALIAS = /^[a-z][a-z0-9_]*$/;
function alias(a: string): string {
  if (!ALIAS.test(a)) throw new Error(`bad SQL alias: ${a}`);
  return a;
}

/** Any of the four progress stamps on row `a`. Parenthesised: it holds OR. */
export function anyTimestampSql(a: string): SQL {
  const x = alias(a);
  return sql.raw(`(${x}.en_route_at IS NOT NULL OR ${x}.arrived_at IS NOT NULL OR ${x}.started_at IS NOT NULL OR ${x}.completed_at IS NOT NULL)`);
}

/** SQL twin of rowStarted for assignment row `a`. */
export function startedRowSql(a: string): SQL {
  const x = alias(a);
  const working = WORKING_STATUSES.map((s) => `'${s}'::request_status`).join(", ");
  return sql.raw(
    `(${x}.status <> 'cancelled'::request_status AND (${x}.status IN (${working})` +
      ` OR (${x}.status = 'on_hold'::request_status AND ${anyTimestampText(x)})` +
      ` OR (${x}.is_lead AND ${x}.status = 'completed'::request_status)))`,
  );
}

function anyTimestampText(x: string): string {
  return `(${x}.en_route_at IS NOT NULL OR ${x}.arrived_at IS NOT NULL OR ${x}.started_at IS NOT NULL OR ${x}.completed_at IS NOT NULL)`;
}
```

`src/lib/admin/move-window.ts`:

```ts
/**
 * Window resolution for a board move (M2 spec §5.2). Pure; used by the client
 * (the prompt) and the server (the move recomputes from the window it read).
 * All wall-clock math is in the business timezone through calendar-time.
 */
import { ARRIVAL_WINDOWS, type ArrivalWindow } from "./arrival-window";
import {
  arrivalWindowUtcForBusinessDate,
  businessIsoDate,
  businessWallClockToUtc,
  toBusinessWallClock,
  type RescheduleWindowRow,
} from "./calendar-time";
import type { BoardBlock, WindowRule } from "./board-types";

export interface TimeWindow {
  readonly start: Date;
  readonly end: Date;
}

export type WindowKind = "band" | "anytime" | "custom" | "none";

export type PromptPlan =
  | { readonly kind: "use_band" }
  | { readonly kind: "keep" }
  /** Nothing is sent. `coveredLine`: show "Still <range>. Use Move… to change the window." */
  | { readonly kind: "noop"; readonly coveredLine: boolean }
  | { readonly kind: "prompt"; readonly defaultChoice: "match" | "keep"; readonly offerKeep: boolean };

export type ResolvedWindow = { readonly ok: true; readonly start: Date; readonly end: Date } | { readonly ok: false };

export function windowEqual(a: TimeWindow, b: TimeWindow): boolean {
  return a.start.getTime() === b.start.getTime() && a.end.getTime() === b.end.getTime();
}

/** The named arrival window a span is exactly, on its start's business day, else null. */
export function namedWindowOf(start: Date | null, end: Date | null): ArrivalWindow | null {
  if (!start || !end) return null;
  const day = businessIsoDate(start);
  for (const name of ARRIVAL_WINDOWS) {
    if (windowEqual({ start, end }, arrivalWindowUtcForBusinessDate(day, name))) return name;
  }
  return null;
}

export function currentWindowKind(start: Date | null, end: Date | null): WindowKind {
  if (!start || !end) return "none";
  const named = namedWindowOf(start, end);
  if (named === "anytime") return "anytime";
  return named ? "band" : "custom";
}

const DAY_MS = 86_400_000;

/** Whole calendar days from `a` to `b` (YYYY-MM-DD; UTC date math is safe for whole days). */
function dayDiff(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00.000Z`) - Date.parse(`${a}T00:00:00.000Z`)) / DAY_MS);
}

function addDays(isoDay: string, n: number): string {
  const d = new Date(`${isoDay}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** The same wall-clock start and end on `day`; an end past midnight stays on the following day. DST-correct. */
export function keepWindowOn(current: TimeWindow, day: string): TimeWindow {
  const s = toBusinessWallClock(current.start);
  const e = toBusinessWallClock(current.end);
  const spanDays = dayDiff(businessIsoDate(current.start), businessIsoDate(current.end));
  return {
    start: businessWallClockToUtc(day, s.hour, s.minute),
    end: businessWallClockToUtc(addDays(day, spanDays), e.hour, e.minute),
  };
}

/** The current window, moved onto `day` with the same wall-clock times, overlaps band `band` (half-open). */
export function covers(current: TimeWindow | null, day: string, band: RescheduleWindowRow): boolean {
  if (!current) return false;
  const kept = keepWindowOn(current, day);
  const b = arrivalWindowUtcForBusinessDate(day, band);
  return kept.start.getTime() < b.end.getTime() && kept.end.getTime() > b.start.getTime();
}

/**
 * What a drop on band `band` of `day` does (spec §5.2): no window → use the
 * band; covered → keep (same lane and day → nothing is sent); otherwise ask.
 * Default "Use the new window" for a band window, "Keep" for anytime and custom
 * when the day or lead changes; with the same day and lead Keep would change
 * nothing, so it isn't offered.
 */
export function promptPlan(
  current: TimeWindow | null,
  day: string,
  band: RescheduleWindowRow,
  leadChanges: boolean,
): PromptPlan {
  if (!current) return { kind: "use_band" };
  const sameDay = businessIsoDate(current.start) === day;
  if (covers(current, day, band)) {
    if (sameDay && !leadChanges) {
      return { kind: "noop", coveredLine: !windowEqual(current, arrivalWindowUtcForBusinessDate(day, band)) };
    }
    return { kind: "keep" };
  }
  const offerKeep = !sameDay || leadChanges;
  const kind = currentWindowKind(current.start, current.end);
  return { kind: "prompt", defaultChoice: kind === "band" || !offerKeep ? "match" : "keep", offerKeep };
}

/** The window a move writes. `keep` with no window and `pick` without a pick are not ok. */
export function resolveMoveWindow(
  current: TimeWindow | null,
  day: string,
  band: RescheduleWindowRow,
  rule: WindowRule,
  pick?: ArrivalWindow,
): ResolvedWindow {
  if (rule === "match") return { ok: true, ...arrivalWindowUtcForBusinessDate(day, band) };
  if (rule === "pick") return pick ? { ok: true, ...arrivalWindowUtcForBusinessDate(day, pick) } : { ok: false };
  if (!current) return { ok: false };
  return { ok: true, ...keepWindowOn(current, day) };
}

/** A window has ended once its end is at or before `now` (window-ended.ts semantics). */
export function windowHasEndedAt(window: TimeWindow, now: Date): boolean {
  return window.end.getTime() <= now.getTime();
}

/** Capacity-removing blocks of the checked technicians that overlap the window (half-open). */
export function timeOffHits(
  blocks: readonly BoardBlock[],
  technicianIds: readonly string[],
  window: TimeWindow,
): BoardBlock[] {
  const ids = new Set(technicianIds);
  return blocks.filter(
    (b) =>
      b.removesCapacity &&
      ids.has(b.technicianId) &&
      Date.parse(b.startsAt) < window.end.getTime() &&
      Date.parse(b.endsAt) > window.start.getTime(),
  );
}
```

(The private `anyTimestampText` keeps `startedRowSql` a single `sql.raw`, so its render is one exact string; `anyTimestampSql` returns the same text as SQL.)

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/lib/admin/visit-started.test.ts src/lib/admin/move-window.test.ts`
Expected: PASS (all).

- [ ] **Step 6: Gates and commit**

```bash
npx tsc --noEmit && npx eslint src/lib/admin/board-types.ts src/lib/admin/visit-started.ts src/lib/admin/visit-started.test.ts src/lib/admin/move-window.ts src/lib/admin/move-window.test.ts src/lib/admin/request-status.ts && npx vitest run
git add src/lib/admin/board-types.ts src/lib/admin/visit-started.ts src/lib/admin/visit-started.test.ts src/lib/admin/move-window.ts src/lib/admin/move-window.test.ts src/lib/admin/request-status.ts
git commit -m "$(cat <<'EOF'
feat(m2): started rule and window resolution, pure

rowStarted / startedRowSql (spec 3.2) and the drop-window rules covers,
promptPlan, resolveMoveWindow (match, pick, keep across days, DST and
midnight) and timeOffHits (spec 5.2), plus the board contract types.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01GuWoF63tQU1i7ELqyYU3A6
EOF
)"
```

---
### Task 2: Pure board model, §8 copy, mass classification

**Files:**
- Create: `src/lib/admin/board-move.ts`, `src/lib/admin/board-move.test.ts`, `src/lib/admin/dispatch-copy.ts`, `src/lib/admin/dispatch-copy.test.ts`, `src/lib/admin/mass-reschedule-model.ts`, `src/lib/admin/mass-reschedule-model.test.ts`
- Modify: `src/lib/admin/types.ts` (optional calendar fields on `DashboardRequest`, optional `blocks` on `SchedulingCalendar`), `src/lib/admin/appointment-types.ts` (optional `started`, `hasProgress` on `AppointmentAssignmentRecord`)

**Interfaces:**
- Consumes (Task 1): `rowStarted`; `keepWindowOn`, `timeOffHits`, `windowHasEndedAt`, `TimeWindow`; every type in `board-types.ts`. Existing: `UNASSIGNED_SCOPE` (`calendar-optimistic.ts`), `arrivalWindowUtcForBusinessDate`, `businessIsoDate`, `formatBusinessTimeRange`, `toBusinessWallClock`, `windowRowOfInstant`, `BUSINESS_TIME_ZONE` (`calendar-time.ts`), `WINDOW_ENDED_MESSAGE` (`window-ended.ts`).
- Produces:
  - `board-move.ts`: `NeedsRow`, `MoveNeedsInput`, `MoveNeeds`, `moveNeeds`, `resetsToScheduled`, `optimisticCrew`, `laneCards`, `laneKey`, `findLeadCard`, `applyMoveResult`, `IntendedMove`, `moveLanded`, `boardInteractive`, `showCrewChips`, `chipLayout`, `crewChipModel`, `initials`, `crewStateWord`, `cardWidthPx`, `pillSize`, `MoveDialogForm`, `moveDialogDefaults(card, today, now, fromUnscheduled?)`, `moveDialogBody(card, form, fromUnscheduled?)`, `bandEnded(day, window, now)`.
  - `dispatch-copy.ts`: constants `MOVE_GENERIC`, `STALE_LINE`, `MOVED`, `CALL_THEM`, `PROMPT_FOOTNOTE`, `INTERACTIVE_NOTICE`, `SR_INSTRUCTIONS`, `STARTED_CUE_TITLE`, `FIELDPULSE_BOARD`, `FIELDPULSE_SHEET_TECH`, `FIELDPULSE_SHEET_CREW`, `FIELDPULSE_SHEET_STARTED`, `SHEET_STARTED_NATIVE`, `TIME_OFF_TITLE`, `TIME_OFF_FOOTER`, `OUT_OF_HOURS_LINE`, `UNSCHEDULE_COPY`, `MASS_COPY`; functions `firstName`, `dayLabel(isoDay)`, `instantDayLabel(date)`, `rangeLabel(start, end)`, `coveredLine(range)`, `startedLine`, `ConfirmContext`, `confirmLines`, `conflictRows`, `timeOffLine`, `moveErrorBanner`, `moveBanner`, `massReasonLabel`, `massResultHeadline`, `massMoveButton`, `massDialogTitle`.
  - `mass-reschedule-model.ts`: `MassVisitFacts`, `MassContext`, `MassClassification`, `classifyMassVisit`, `massDefaultDay`, `massDayShift`, `massChanges`.
  - `types.ts`: `DashboardRequest` optional `visitId`, `visitVersion`, `crew`, `started`, `movable`, `laneRole`, `laneTechnicianId`, `fieldpulse`; `SchedulingCalendar.blocks?`.

- [ ] **Step 1: Types.** In `src/lib/admin/types.ts`, add at the top (after the file comment):

```ts
import type { BoardBlock, CrewMember, LaneRole, Movable } from './board-types';
```

In `DashboardRequest`, replace

```ts
  /** A hold ended this visit and nothing is booked yet: shown, never dragged. */
  readonly visitEnded?: boolean;
}
```

with

```ts
  /** A hold ended this visit and nothing is booked yet: shown, never dragged. */
  readonly visitEnded?: boolean;
  // ── M2: calendar-only fields (getSchedulingCalendar); absent on other lists ──
  /** The displayed visit, else visit #1 (spec §4.1); null when no visit #1 exists. */
  readonly visitId?: string | null;
  readonly visitVersion?: number | null;
  /** Live rows on the displayed visit, lead first. */
  readonly crew?: readonly CrewMember[];
  readonly started?: boolean;
  readonly movable?: Movable;
  /** "helper" on a copy laneCards puts in a helper's lane; server cards are "lead". */
  readonly laneRole?: LaneRole;
  /** On a helper copy: whose lane it sits in. */
  readonly laneTechnicianId?: string;
  /** FieldPulse-mapped: read-only on the board. */
  readonly fieldpulse?: boolean;
}
```

In `SchedulingCalendar`, replace

```ts
  readonly availability: readonly AvailabilitySlot[];
}
```

(the one inside `SchedulingCalendar`, right after the availability comment block) with

```ts
  readonly availability: readonly AvailabilitySlot[];
  /** Day view only: every technician_shifts row overlapping the day (spec §7.1). */
  readonly blocks?: readonly BoardBlock[];
}
```

In `src/lib/admin/appointment-types.ts`, replace

```ts
export interface AppointmentAssignmentRecord {
  readonly technicianId: string;
  readonly technicianName: string;
  readonly isLead: boolean;
  readonly status: string;
}
```

with

```ts
export interface AppointmentAssignmentRecord {
  readonly technicianId: string;
  readonly technicianName: string;
  readonly isLead: boolean;
  readonly status: string;
  /** M2 §3.3: started by the board's rule (rowStarted). Set by listAppointments / getAppointment. */
  readonly started?: boolean;
  /** Any progress timestamp on the row. */
  readonly hasProgress?: boolean;
}
```

Run `npx tsc --noEmit` → 0 (all fields optional; no consumer changes).

- [ ] **Step 2: Write the failing tests** — `src/lib/admin/board-move.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  applyMoveResult, boardInteractive, cardWidthPx, chipLayout, crewChipModel, findLeadCard, initials, laneCards, laneKey,
  moveDialogBody, moveDialogDefaults, moveLanded, moveNeeds, optimisticCrew, pillSize, resetsToScheduled, showCrewChips,
  type NeedsRow,
} from "./board-move";
import type { CrewMember } from "./board-types";
import type { DashboardRequest, SchedulingCalendar } from "./types";

const ALEX = "a1111111-1111-4111-8111-111111111111";
const SAM = "b2222222-2222-4222-8222-222222222222";
const KIM = "c3333333-3333-4333-8333-333333333333";
const row = (technicianId: string, isLead: boolean, status: string, hasTimestamp = false): NeedsRow => ({ technicianId, isLead, status, hasTimestamp });
const crew = (...m: Array<[string, string | null, boolean, CrewMember["state"]]>): CrewMember[] =>
  m.map(([technicianId, name, isLead, state]) => ({ technicianId, name, isLead, state }));

function card(over: Partial<DashboardRequest> = {}): DashboardRequest {
  return {
    id: "r1", referenceNumber: "HVAC-1", customerName: "Pat Doe", issueType: "no_heat", urgency: "medium", status: "scheduled",
    isAfterHours: false, assignedToName: "Alex Rivera", arrivalWindowStart: "2026-11-10T14:00:00.000Z", arrivalWindowEnd: "2026-11-10T16:00:00.000Z",
    followUpDate: null, holdReason: null, autoAssigned: false, createdAt: "2026-11-01T00:00:00.000Z", syncedSource: null,
    visitId: "v1", visitVersion: 3, crew: crew([ALEX, "Alex Rivera", true, "open"]), started: false, movable: "yes", laneRole: "lead",
    ...over,
  };
}
function board(over: Partial<SchedulingCalendar> = {}): SchedulingCalendar {
  return {
    days: ["2026-11-10"],
    lanes: [
      { technicianId: ALEX, technicianName: "Alex Rivera", jobs: [card()] },
      { technicianId: SAM, technicianName: "Sam Lee", jobs: [] },
    ],
    unassigned: [], unscheduled: [], availability: [], ...over,
  };
}

describe("moveNeeds (spec §5.3: checked technicians, started)", () => {
  const rows = [row(ALEX, true, "in_progress", true), row(SAM, false, "assigned"), row(KIM, false, "cancelled")];
  it("lead change only: checks the new lead; started when the current lead's row is", () => {
    const n = moveNeeds({ leadChanges: true, windowChanges: false, currentLeadId: ALEX, newLeadId: SAM, rows });
    expect(n.checked).toEqual([SAM]);
    expect(n.started).toBe(true);
    expect(n.startedRows.map((r) => r.technicianId)).toEqual([ALEX]);
  });
  it("window change only: checks every live crew member; a cancelled row isn't crew", () => {
    const n = moveNeeds({ leadChanges: false, windowChanges: true, currentLeadId: ALEX, newLeadId: ALEX, rows });
    expect([...n.checked].sort()).toEqual([ALEX, SAM].sort());
    expect(n.started).toBe(true);
  });
  it("lead and window change: the old lead is excluded from the checked list", () => {
    const n = moveNeeds({ leadChanges: true, windowChanges: true, currentLeadId: ALEX, newLeadId: KIM, rows });
    expect([...n.checked].sort()).toEqual([KIM, SAM].sort());
  });
  it("a lead swap with only a helper working and the window unchanged needs nothing", () => {
    const n = moveNeeds({ leadChanges: true, windowChanges: false, currentLeadId: ALEX, newLeadId: KIM,
      rows: [row(ALEX, true, "scheduled"), row(SAM, false, "in_progress", true)] });
    expect(n.started).toBe(false);
  });
  it("a helper working + a time move → started", () => {
    const n = moveNeeds({ leadChanges: false, windowChanges: true, currentLeadId: ALEX, newLeadId: ALEX,
      rows: [row(ALEX, true, "scheduled"), row(SAM, false, "en_route", true)] });
    expect(n.started).toBe(true);
  });
  it("nothing changes → nothing checked", () => {
    expect(moveNeeds({ leadChanges: false, windowChanges: false, currentLeadId: ALEX, newLeadId: ALEX, rows }).checked).toEqual([]);
  });
});

describe("resetsToScheduled", () => {
  const started = [{ technicianId: ALEX, status: "arrived", hasTimestamp: true, openTimeEntry: true }];
  it("a native request on site whose old lead is the only started row resets", () => {
    expect(resetsToScheduled({ status: "arrived", native: true, oldLeadId: ALEX, started })).toBe(true);
  });
  it("not when someone else is working, not on HCP/FieldPulse, not from scheduled", () => {
    expect(resetsToScheduled({ status: "arrived", native: true, oldLeadId: ALEX, started: [...started, { technicianId: SAM, status: "in_progress", hasTimestamp: true, openTimeEntry: false }] })).toBe(false);
    expect(resetsToScheduled({ status: "arrived", native: false, oldLeadId: ALEX, started })).toBe(false);
    expect(resetsToScheduled({ status: "scheduled", native: true, oldLeadId: ALEX, started })).toBe(false);
  });
  it("not when the 409 says another row is started (a lead-only change lists only the lead)", () => {
    expect(resetsToScheduled({ status: "arrived", native: true, oldLeadId: ALEX, started, othersStarted: true })).toBe(false);
  });
});

describe("optimisticCrew", () => {
  it("the new lead comes out of the helpers; the old lead is off", () => {
    expect(optimisticCrew(crew([ALEX, "Alex", true, "working"], [SAM, "Sam", false, "open"]), SAM, "Sam")).toEqual(
      crew([SAM, "Sam", true, "open"]),
    );
  });
  it("a technician not on the crew joins as an open lead", () => {
    expect(optimisticCrew(crew([ALEX, "Alex", true, "open"], [KIM, "Kim", false, "working"]), SAM, "Sam")).toEqual(
      crew([SAM, "Sam", true, "open"], [KIM, "Kim", false, "working"]),
    );
  });
  it("the same lead changes nothing", () => {
    const c = crew([ALEX, "Alex", true, "open"]);
    expect(optimisticCrew(c, ALEX, "Alex")).toEqual(c);
  });
});

describe("laneCards (helper copies)", () => {
  const two = card({ crew: crew([ALEX, "Alex Rivera", true, "open"], [SAM, "Sam Lee", false, "working"]) });
  it("adds a non-draggable copy to each helper's lane, keyed request:technician", () => {
    const out = laneCards(board({ lanes: [{ technicianId: ALEX, technicianName: "Alex Rivera", jobs: [two] }, { technicianId: SAM, technicianName: "Sam Lee", jobs: [] }] }));
    const samJobs = out.lanes[1]!.jobs;
    expect(samJobs).toHaveLength(1);
    expect(samJobs[0]).toMatchObject({ id: "r1", laneRole: "helper", laneTechnicianId: SAM });
    expect(laneKey(samJobs[0]!)).toBe(`r1:${SAM}`);
    expect(laneKey(out.lanes[0]!.jobs[0]!)).toBe("r1");
  });
  it("is idempotent and skips ended visits and helpers without a lane", () => {
    const b = board({ lanes: [{ technicianId: ALEX, technicianName: "Alex Rivera", jobs: [two, card({ id: "r2", visitEnded: true, crew: two.crew })] }] });
    const once = laneCards(b);
    expect(laneCards(once)).toEqual(once);
    expect(once.lanes[0]!.jobs.map((j) => j.id)).toEqual(["r1", "r2"]);
  });
});

describe("findLeadCard / applyMoveResult / moveLanded", () => {
  const names = new Map([[ALEX, "Alex Rivera"], [SAM, "Sam Lee"]]);
  it("finds the lead card in lanes, the unassigned lane or Unscheduled, never a helper copy", () => {
    const b = laneCards(board({ lanes: [{ technicianId: ALEX, technicianName: "A", jobs: [] }, { technicianId: SAM, technicianName: "S", jobs: [card({ crew: crew([SAM, "Sam", true, "open"], [ALEX, "Alex", false, "open"]) })] }] }));
    expect(findLeadCard(b, "r1")).toMatchObject({ scope: SAM });
    expect(findLeadCard(board({ lanes: [], unscheduled: [card()] }), "r1")).toMatchObject({ scope: "unscheduled" });
    expect(findLeadCard(board(), "nope")).toBeNull();
  });
  it("writes the new version, window, status and lead before the refetch", () => {
    const out = applyMoveResult(board(), "r1", {
      visitId: "v1", visitVersion: 4, requestStatus: "scheduled", arrivalWindowStart: "2026-11-10T17:00:00.000Z",
      arrivalWindowEnd: "2026-11-10T21:00:00.000Z", leadId: SAM, confirmed: [],
    }, names);
    expect(out.lanes[0]!.jobs).toEqual([]);
    expect(out.lanes[1]!.jobs[0]).toMatchObject({ visitVersion: 4, arrivalWindowStart: "2026-11-10T17:00:00.000Z", assignedToName: "Sam Lee" });
    expect(out.lanes[1]!.jobs[0]!.crew?.[0]).toMatchObject({ technicianId: SAM, isLead: true });
  });
  it("moveLanded: the refetched card has the intended lead and window", () => {
    const b = board();
    expect(moveLanded(b, { requestId: "r1", leadId: ALEX, start: "2026-11-10T14:00:00.000Z", end: "2026-11-10T16:00:00.000Z" })).toBe(true);
    expect(moveLanded(b, { requestId: "r1", leadId: SAM, start: "2026-11-10T14:00:00.000Z", end: "2026-11-10T16:00:00.000Z" })).toBe(false);
    expect(moveLanded(b, { requestId: "r1", leadId: ALEX, start: "2026-11-10T17:00:00.000Z", end: "2026-11-10T21:00:00.000Z" })).toBe(false);
  });
  it("moveLanded for an Unscheduled drop: landed means back in Unscheduled", () => {
    expect(moveLanded(board({ lanes: [], unscheduled: [card()] }), { requestId: "r1", unscheduled: true })).toBe(true);
    expect(moveLanded(board(), { requestId: "r1", unscheduled: true })).toBe(false);
  });
  it("two tray cards: moving one leaves the other in Unscheduled", () => {
    const b = board({ lanes: [{ technicianId: ALEX, technicianName: "A", jobs: [] }], unscheduled: [card({ id: "u1", arrivalWindowStart: null, arrivalWindowEnd: null }), card({ id: "u2", arrivalWindowStart: null, arrivalWindowEnd: null })] });
    const out = applyMoveResult(b, "u1", { visitId: "v9", visitVersion: 1, requestStatus: "assigned", arrivalWindowStart: "2026-11-10T13:00:00.000Z", arrivalWindowEnd: "2026-11-10T17:00:00.000Z", leadId: ALEX, confirmed: [] }, names);
    expect(out.unscheduled.map((j) => j.id)).toEqual(["u2"]);
    expect(out.lanes[0]!.jobs.map((j) => j.id)).toEqual(["u1"]);
  });
});

describe("layout helpers", () => {
  it("boardInteractive: ≥ 1024 px with a fine pointer", () => {
    expect(boardInteractive(1440, true)).toBe(true);
    expect(boardInteractive(1023, true)).toBe(false);
    expect(boardInteractive(1440, false)).toBe(false);
  });
  it("chips only with 2+ crew; a count below 120 px wide, below 72 px high, or in Week view", () => {
    expect(showCrewChips(crew([ALEX, "A", true, "open"]))).toBe(false);
    expect(showCrewChips(crew([ALEX, "A", true, "open"], [SAM, "S", false, "open"]))).toBe(true);
    expect(chipLayout(220, 112, "day")).toBe("chips");
    expect(chipLayout(119, 112, "day")).toBe("count");
    expect(chipLayout(220, 71, "day")).toBe("count");
    expect(chipLayout(220, 112, "week")).toBe("count");
  });
  it("crewChipModel: lead first, three chips, +N past three", () => {
    const m = crewChipModel(crew([SAM, "Sam", false, "open"], [ALEX, "Alex", true, "working"], [KIM, "Kim", false, "done"], ["d", "Dee", false, "open"], ["e", "Eve", false, "open"]));
    expect(m.chips.map((c) => c.technicianId)).toEqual([ALEX, SAM, KIM]);
    expect(m.more).toBe(2);
  });
  it("initials", () => {
    expect(initials("Alex Rivera")).toBe("AR");
    expect(initials("Sam")).toBe("S");
    expect(initials(null)).toBe("?");
  });
  it("card width = 224 / columns − 4; pill md at ≥ 160 px in Day view only", () => {
    expect(cardWidthPx(1)).toBe(220);
    expect(cardWidthPx(2)).toBe(108);
    expect(pillSize("day", 220)).toBe("md");
    expect(pillSize("day", 108)).toBe("sm");
    expect(pillSize("week", 220)).toBe("sm");
  });
});

describe("moveDialogDefaults / moveDialogBody (spec §7.5)", () => {
  const today = "2026-11-10";
  const morningNow = new Date("2026-11-10T12:00:00.000Z"); // 7 AM ET: nothing has ended
  it("a placed card: its lead, its day, Keep", () => {
    expect(moveDialogDefaults(card(), today, morningNow)).toEqual({ technicianId: ALEX, day: "2026-11-10", window: "keep" });
  });
  it("an unassigned card: Unassigned, Keep", () => {
    expect(moveDialogDefaults(card({ crew: [] }), today, morningNow)).toEqual({ technicianId: "", day: "2026-11-10", window: "keep" });
  });
  it("an Unscheduled card without a window: Unassigned, today, the first band that hasn't ended", () => {
    const u = card({ arrivalWindowStart: null, arrivalWindowEnd: null });
    expect(moveDialogDefaults(u, today, morningNow, true)).toEqual({ technicianId: "", day: today, window: "morning" });
    expect(moveDialogDefaults(u, today, new Date("2026-11-10T18:30:00.000Z"), true).window).toBe("afternoon"); // 1:30 PM: morning ended, afternoon hasn't
    expect(moveDialogDefaults(u, today, new Date("2026-11-10T21:30:00.000Z"), true).window).toBe("evening"); // 4:30 PM
  });
  it("no change → null (Move disabled)", () => {
    expect(moveDialogBody(card(), { technicianId: ALEX, day: "2026-11-10", window: "keep" })).toBeNull();
    expect(moveDialogBody(card(), { technicianId: "", day: "2026-11-10", window: "keep" })).toBeNull();
  });
  it("keep to another day: rule keep, the band the kept start falls in", () => {
    expect(moveDialogBody(card(), { technicianId: ALEX, day: "2026-11-11", window: "keep" })).toEqual({
      visitId: "v1", expectedVersion: 3, day: "2026-11-11", band: "morning", windowRule: "keep", confirm: [],
    });
  });
  it("a picked window and another technician", () => {
    expect(moveDialogBody(card(), { technicianId: SAM, day: "2026-11-10", window: "afternoon" })).toEqual({
      visitId: "v1", expectedVersion: 3, day: "2026-11-10", band: "afternoon", windowRule: "pick", pick: "afternoon", technicianId: SAM, confirm: [],
    });
  });
  it("Anytime rides on the morning band", () => {
    expect(moveDialogBody(card(), { technicianId: ALEX, day: "2026-11-10", window: "anytime" })).toMatchObject({ band: "morning", pick: "anytime" });
  });
  it("picking exactly the current window, same day and technician, is no change", () => {
    const m = card({ arrivalWindowStart: "2026-11-10T13:00:00.000Z", arrivalWindowEnd: "2026-11-10T17:00:00.000Z" });
    expect(moveDialogBody(m, { technicianId: ALEX, day: "2026-11-10", window: "morning" })).toBeNull();
  });
  it("an Unscheduled card with no window can't Keep", () => {
    const u = card({ arrivalWindowStart: null, arrivalWindowEnd: null });
    expect(moveDialogBody(u, { technicianId: "", day: today, window: "keep" }, true)).toBeNull();
    expect(moveDialogBody(u, { technicianId: "", day: today, window: "morning" }, true)).toMatchObject({ windowRule: "pick", pick: "morning" });
  });
});
```

`src/lib/admin/dispatch-copy.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  CALL_THEM, confirmLines, conflictRows, coveredLine, dayLabel, firstName, massDialogTitle, massMoveButton, massReasonLabel,
  massResultHeadline, moveBanner, moveErrorBanner, startedLine, timeOffLine, MOVED, STALE_LINE,
} from "./dispatch-copy";
import { WINDOW_ENDED_MESSAGE } from "./window-ended";

const ALEX = "alex-id";
const SAM = "sam-id";
const names = new Map([[ALEX, "Alex Rivera"], [SAM, "Sam Lee"]]);

describe("names and dates", () => {
  it("firstName", () => {
    expect(firstName("Alex Rivera")).toBe("Alex");
    expect(firstName("  ")).toBe("A technician");
    expect(firstName(null)).toBe("A technician");
  });
  it("dayLabel is the business day, 'Tue, Nov 10'", () => {
    expect(dayLabel("2026-11-10")).toBe("Tue, Nov 10");
  });
  it("coveredLine", () => {
    expect(coveredLine("8 AM–8 PM")).toBe("Still 8 AM–8 PM. Use Move… to change the window.");
  });
});

describe("confirm copy (spec §8)", () => {
  it("started line per status; a mirrored status with no timestamp is 'marked'", () => {
    expect(startedLine("Alex Rivera", "en_route", true)).toBe("Alex Rivera is en route to this visit.");
    expect(startedLine("Alex Rivera", "arrived", true)).toBe("Alex Rivera has arrived.");
    expect(startedLine("Alex Rivera", "in_progress", true)).toBe("Alex Rivera is in progress on this visit.");
    expect(startedLine("Alex Rivera", "on_hold", true)).toBe("Alex Rivera is paused on this visit.");
    expect(startedLine("Alex Rivera", "completed", true)).toBe("Alex Rivera is done with this visit.");
    expect(startedLine("Alex Rivera", "in_progress", false)).toBe("This visit is marked in progress.");
  });
  it("lead change: lines 1–3 with reset and time stop", () => {
    expect(confirmLines(
      { needs: ["started"], started: [{ technicianId: ALEX, status: "arrived", hasTimestamp: true, openTimeEntry: true }] },
      { names, oldLeadId: ALEX, newLeadId: SAM, leadChanges: true, windowChanges: false, range: "9 AM–11 AM", dayLabel: null, resetsToScheduled: true },
    )).toEqual([
      "Alex Rivera has arrived.",
      "Alex comes off the visit. Sam becomes the lead and takes over close-out, the invoice and estimates. The request goes back to scheduled. Alex’s time on it stops.",
      CALL_THEM,
    ]);
  });
  it("time change: started lines, then one 'It moves to' line with the day when it changes", () => {
    expect(confirmLines(
      { needs: ["started"], started: [{ technicianId: ALEX, status: "in_progress", hasTimestamp: true, openTimeEntry: false }] },
      { names, oldLeadId: ALEX, newLeadId: ALEX, leadChanges: false, windowChanges: true, range: "12 PM–4 PM", dayLabel: "Wed, Nov 11", resetsToScheduled: false },
    )).toEqual(["Alex Rivera is in progress on this visit.", "It moves to 12 PM–4 PM on Wed, Nov 11.", CALL_THEM]);
  });
  it("lead and window both change: lead lines, then the move line", () => {
    expect(confirmLines(
      { needs: ["started"], started: [{ technicianId: ALEX, status: "en_route", hasTimestamp: true, openTimeEntry: false }] },
      { names, oldLeadId: ALEX, newLeadId: SAM, leadChanges: true, windowChanges: true, range: "12 PM–4 PM", dayLabel: null, resetsToScheduled: true },
    )).toEqual([
      "Alex Rivera is en route to this visit.",
      "Alex comes off the visit. Sam becomes the lead and takes over close-out, the invoice and estimates. The request goes back to scheduled.",
      "It moves to 12 PM–4 PM.",
      CALL_THEM,
    ]);
  });
  it("conflict rows name technicians only when more than one is involved", () => {
    const c = (technicianId: string) => ({ id: "x", referenceNumber: "HVAC-9", technicianId, arrivalWindowStart: "2026-11-10T17:00:00.000Z", arrivalWindowEnd: "2026-11-10T21:00:00.000Z" });
    expect(conflictRows([c(SAM)], names)).toEqual(["HVAC-9 · 12 PM–4 PM"]);
    expect(conflictRows([c(SAM), c(ALEX)], names)).toEqual(["HVAC-9 · 12 PM–4 PM · Sam", "HVAC-9 · 12 PM–4 PM · Alex"]);
  });
});

describe("time off copy", () => {
  const block = { startsAt: "2026-11-10T21:00:00.000Z", endsAt: "2026-11-11T01:00:00.000Z", kind: "time_off" as const };
  it("one day", () => {
    expect(timeOffLine("Sam Lee", block, false)).toBe("Sam is off 4 PM–8 PM on Tue, Nov 10.");
  });
  it("more than one day", () => {
    expect(timeOffLine("Sam Lee", { ...block, startsAt: "2026-11-09T05:00:00.000Z", endsAt: "2026-11-14T05:00:00.000Z" }, false)).toBe("Sam is off Mon, Nov 9 – Fri, Nov 13.");
  });
  it("a non-job event or a capacity-removing on-call shift", () => {
    expect(timeOffLine("Sam Lee", { ...block, kind: "non_job" }, false)).toBe("Sam has a non-job event 4 PM–8 PM on Tue, Nov 10.");
    expect(timeOffLine("Sam Lee", { ...block, kind: "on_call" }, false)).toBe("Sam has a non-job event 4 PM–8 PM on Tue, Nov 10.");
  });
  it("a helper adds the way out", () => {
    expect(timeOffLine("Sam Lee", block, true)).toBe("Sam is off 4 PM–8 PM on Tue, Nov 10. Or remove Sam in the request.");
  });
});

describe("banners", () => {
  it("each code's line", () => {
    expect(moveErrorBanner("STALE")).toBe(STALE_LINE);
    expect(moveErrorBanner("VISIT_ENDED")).toBe("This visit has ended. Add a new visit instead.");
    expect(moveErrorBanner("VISIT_PINNED", { visitNumber: 2 })).toBe("Visit #2. Change its time in the request.");
    expect(moveErrorBanner("REQUEST_TERMINAL", { status: "completed" })).toBe("This request is completed, so it can’t be moved.");
    expect(moveErrorBanner("REQUEST_TERMINAL", { status: "cancelled" })).toBe("This request is cancelled, so it can’t be moved.");
    expect(moveErrorBanner("TECHNICIAN_NOT_FOUND")).toBe("That technician isn’t active any more.");
    expect(moveErrorBanner("TECHNICIAN_DONE", { technicianId: SAM }, names)).toBe("Sam has finished on this visit.");
    expect(moveErrorBanner("WINDOW_ENDED")).toBe(WINDOW_ENDED_MESSAGE);
    expect(moveErrorBanner("MANAGED_EXTERNALLY")).toBe("Change this request in FieldPulse.");
    expect(moveErrorBanner("INTERNAL_ERROR")).toBe("Couldn’t move the request. Please try again.");
  });
  it("moveBanner: a lead change that shrinks the crew names both", () => {
    const before = [{ technicianId: ALEX, name: "Alex Rivera", isLead: true, state: "working" as const }];
    const after = [{ technicianId: SAM, name: "Sam Lee", isLead: true, state: "open" as const }];
    expect(moveBanner(before, after)).toBe("Sam is now the lead. Alex is off this visit.");
    expect(moveBanner(before, before)).toBe(MOVED);
    expect(moveBanner([], after)).toBe(MOVED);
  });
});

describe("mass copy (spec §7.6, §8)", () => {
  it("reasons", () => {
    expect(massReasonLabel("started", {})).toBe("Started");
    expect(massReasonLabel("ended", {})).toBe("Visit ended");
    expect(massReasonLabel("later_visit", { visitNumber: 2 })).toBe("Visit #2. Change it in the request.");
    expect(massReasonLabel("time_off", {})).toBe("Time off then");
    expect(massReasonLabel("window_ended", {})).toBe("That time has passed");
    expect(massReasonLabel("already_on_visit", { toFirstName: "Sam" })).toBe("Sam is already on it");
    expect(massReasonLabel("fieldpulse", {})).toBe("Change it in FieldPulse");
    expect(massReasonLabel("helper", { leadFirstName: "Alex" })).toBe("Helping Alex. Change it in the request.");
    expect(massReasonLabel("stale", {})).toBe("Changed since you opened this");
    expect(massReasonLabel("conflict", {})).toBe("Overlaps another request");
  });
  it("result headline variants", () => {
    expect(massResultHeadline(3, "Alex", "Sam", "Wed, Nov 11")).toBe("Moved 3 of Alex’s requests to Sam on Wed, Nov 11.");
    expect(massResultHeadline(3, "Alex", "Sam", null)).toBe("Moved 3 of Alex’s requests to Sam.");
    expect(massResultHeadline(1, "Alex", null, "Wed, Nov 11")).toBe("Moved 1 of Alex’s requests to Wed, Nov 11.");
    expect(massResultHeadline(0, "Alex", "Sam", null)).toBe("None of Alex’s requests moved.");
  });
  it("button and title", () => {
    expect(massMoveButton(1)).toBe("Move 1 request");
    expect(massMoveButton(4)).toBe("Move 4 requests");
    expect(massDialogTitle("Alex Rivera", "Tue, Nov 10")).toBe("Move Alex’s requests on Tue, Nov 10");
  });
});
```

`src/lib/admin/mass-reschedule-model.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { classifyMassVisit, massChanges, massDayShift, massDefaultDay, type MassContext, type MassVisitFacts } from "./mass-reschedule-model";

const T = "t-alex";
const T2 = "t-sam";
const facts = (over: Partial<MassVisitFacts> = {}): MassVisitFacts => ({
  visitId: "v1", requestId: "r1", visitNumber: 1,
  window: { start: new Date("2026-11-10T14:00:00.000Z"), end: new Date("2026-11-10T16:00:00.000Z") },
  fieldpulse: false, techIsLead: true, ended: false,
  rows: [{ technicianId: T, isLead: true, status: "scheduled", hasTimestamp: false }],
  toTechOnVisit: false, ...over,
});
const ctx = (over: Partial<MassContext> = {}): MassContext => ({
  technicianId: T, toTechnicianId: T2, fromDate: "2026-11-10", toDate: "2026-11-11", now: new Date("2026-11-09T12:00:00.000Z"),
  blocks: [], busy: [], outsideHours: () => false, ...over,
});

describe("classifyMassVisit (order: fieldpulse, helper, later_visit, ended, started, window_ended, already_on_visit, time_off)", () => {
  it("moves, keeping wall-clock times on the new day", () => {
    const r = classifyMassVisit(facts(), ctx());
    expect(r.outcome).toBe("moves");
    expect(r.newWindow.start.toISOString()).toBe("2026-11-11T14:00:00.000Z");
  });
  it("each skip reason", () => {
    expect(classifyMassVisit(facts({ fieldpulse: true, techIsLead: false }), ctx()).outcome).toBe("fieldpulse");
    expect(classifyMassVisit(facts({ techIsLead: false }), ctx()).outcome).toBe("helper");
    expect(classifyMassVisit(facts({ visitNumber: 2 }), ctx()).outcome).toBe("later_visit");
    expect(classifyMassVisit(facts({ ended: true }), ctx()).outcome).toBe("ended");
    expect(classifyMassVisit(facts({ rows: [{ technicianId: T, isLead: true, status: "en_route", hasTimestamp: true }] }), ctx()).outcome).toBe("started");
    expect(classifyMassVisit(facts(), ctx({ now: new Date("2026-11-11T17:00:00.000Z") })).outcome).toBe("window_ended");
    expect(classifyMassVisit(facts({ toTechOnVisit: true }), ctx()).outcome).toBe("already_on_visit");
    expect(classifyMassVisit(facts(), ctx({ blocks: [{ id: "s", technicianId: T2, kind: "time_off", title: null, startsAt: "2026-11-11T13:00:00.000Z", endsAt: "2026-11-11T22:00:00.000Z", removesCapacity: true }] })).outcome).toBe("time_off");
  });
  it("time off is checked for T2 and, when the day changes, the crew who stays — never the old lead", () => {
    const offT = { id: "s", technicianId: T, kind: "time_off" as const, title: null, startsAt: "2026-11-11T13:00:00.000Z", endsAt: "2026-11-11T22:00:00.000Z", removesCapacity: true };
    expect(classifyMassVisit(facts(), ctx({ blocks: [offT] })).outcome).toBe("moves");
    expect(classifyMassVisit(facts(), ctx({ toTechnicianId: null, blocks: [offT] })).outcome).toBe("time_off");
  });
  it("a conflict is a soft flag on a move", () => {
    const busy = [{ technicianId: T2, requestId: "r9", start: new Date("2026-11-11T15:00:00.000Z"), end: new Date("2026-11-11T17:00:00.000Z") }];
    expect(classifyMassVisit(facts(), ctx({ busy }))).toMatchObject({ outcome: "moves", conflict: true });
    expect(classifyMassVisit(facts(), ctx({ outsideHours: (id) => id === T2 }))).toMatchObject({ outcome: "moves", conflict: true });
  });
  it("a request moving in the same run never conflicts (two shared-band visits both move)", () => {
    const busy = [{ technicianId: T2, requestId: "r2", start: new Date("2026-11-11T14:00:00.000Z"), end: new Date("2026-11-11T16:00:00.000Z") }];
    expect(classifyMassVisit(facts(), ctx({ busy })).conflict).toBe(true);
    expect(classifyMassVisit(facts(), ctx({ busy, batchRequestIds: ["r1", "r2"] })).conflict).toBe(false);
  });
  it("its own request never conflicts", () => {
    const busy = [{ technicianId: T2, requestId: "r1", start: new Date("2026-11-11T15:00:00.000Z"), end: new Date("2026-11-11T17:00:00.000Z") }];
    expect(classifyMassVisit(facts(), ctx({ busy })).conflict).toBe(false);
  });
});

describe("days", () => {
  it("default to-day is the next weekday", () => {
    expect(massDefaultDay("2026-11-10")).toBe("2026-11-11"); // Tue → Wed
    expect(massDefaultDay("2026-11-13")).toBe("2026-11-16"); // Fri → Mon
    expect(massDefaultDay("2026-11-14")).toBe("2026-11-16"); // Sat → Mon
  });
  it("dayShift and whether anything changes", () => {
    expect(massDayShift("2026-11-10", "2026-11-12")).toBe(2);
    expect(massChanges({ fromDate: "2026-11-10", toDate: "2026-11-10", technicianId: T, toTechnicianId: null })).toBe(false);
    expect(massChanges({ fromDate: "2026-11-10", toDate: "2026-11-10", technicianId: T, toTechnicianId: T })).toBe(false);
    expect(massChanges({ fromDate: "2026-11-10", toDate: "2026-11-10", technicianId: T, toTechnicianId: T2 })).toBe(true);
  });
});
```

- [ ] **Step 3: Run them to verify they fail**

Run: `npx vitest run src/lib/admin/board-move.test.ts src/lib/admin/dispatch-copy.test.ts src/lib/admin/mass-reschedule-model.test.ts`
Expected: FAIL — unresolved imports.

- [ ] **Step 4: Implement** — `src/lib/admin/board-move.ts`:

```ts
/**
 * The calendar's move model (M2 spec §5.3, §7): which technicians a move
 * checks, the optimistic crew, helper copies, the post-move board, "did my
 * move land" after a STALE refetch, layout rules and the Move… dialog. Pure
 * and client-safe.
 */
import { ARRIVAL_WINDOWS, type ArrivalWindow } from "./arrival-window";
import { arrivalWindowUtcForBusinessDate, businessIsoDate, toBusinessWallClock, windowRowOfInstant } from "./calendar-time";
import { UNASSIGNED_SCOPE } from "./calendar-optimistic";
import { keepWindowOn, windowEqual, windowHasEndedAt } from "./move-window";
import { rowStarted } from "./visit-started";
import type { CrewMember, CrewState, MoveBand, MoveBody, MoveSuccessData, StartedDetail } from "./board-types";
import type { DashboardRequest, SchedulingCalendar } from "./types";

// ── needs ────────────────────────────────────────────────────────────────────

export interface NeedsRow {
  readonly technicianId: string;
  readonly isLead: boolean;
  readonly status: string;
  readonly hasTimestamp: boolean;
}

export interface MoveNeedsInput {
  readonly leadChanges: boolean;
  readonly windowChanges: boolean;
  readonly currentLeadId: string | null;
  readonly newLeadId: string | null;
  readonly rows: readonly NeedsRow[];
}

export interface MoveNeeds {
  /** Technicians the move assigns: checked for time off and overlaps. */
  readonly checked: readonly string[];
  readonly started: boolean;
  readonly startedRows: readonly NeedsRow[];
}

/**
 * The new lead when the lead changes; when the window changes, every live crew
 * member who stays (the old lead leaves on a lead change). `started`: the lead
 * changes and the current lead's row is started, or the window changes and any
 * live row is started.
 */
export function moveNeeds(i: MoveNeedsInput): MoveNeeds {
  const live = i.rows.filter((r) => r.status !== "cancelled");
  const checked = new Set<string>();
  if (i.leadChanges && i.newLeadId) checked.add(i.newLeadId);
  if (i.windowChanges) {
    for (const r of live) {
      if (i.leadChanges && r.technicianId === i.currentLeadId) continue;
      checked.add(r.technicianId);
    }
    if (i.newLeadId) checked.add(i.newLeadId);
  }
  const startedRows = live.filter(
    (r) => rowStarted(r) && (i.windowChanges || (i.leadChanges && r.isLead && r.technicianId === i.currentLeadId)),
  );
  return { checked: [...checked], started: startedRows.length > 0, startedRows };
}

const RESET_FROM: readonly string[] = ["en_route", "arrived", "in_progress", "on_hold"];

/** A lead change past a started lead resets a native request to scheduled when nobody else is started (spec §5.3 step 1). */
export function resetsToScheduled(p: {
  readonly status: string;
  readonly native: boolean;
  readonly oldLeadId: string | null;
  readonly started: readonly StartedDetail[];
  /** From the 409's details: a row other than the old lead's is started (a lead-only 409 lists only the lead in `started`). */
  readonly othersStarted?: boolean;
}): boolean {
  if (!p.native || !RESET_FROM.includes(p.status) || !p.oldLeadId || p.othersStarted) return false;
  return p.started.some((s) => s.technicianId === p.oldLeadId) && p.started.every((s) => s.technicianId === p.oldLeadId);
}

// ── crew and lanes ─────────────────────────────────────────────────────────────

/** The crew after a lead change: the new lead out of the helpers, the old lead off. */
export function optimisticCrew(crew: readonly CrewMember[], newLeadId: string, newLeadName: string | null): CrewMember[] {
  if (crew.find((c) => c.isLead)?.technicianId === newLeadId) return [...crew];
  const promoted = crew.find((c) => c.technicianId === newLeadId);
  const lead: CrewMember = { technicianId: newLeadId, name: promoted?.name ?? newLeadName, isLead: true, state: promoted?.state ?? "open" };
  return [lead, ...crew.filter((c) => !c.isLead && c.technicianId !== newLeadId)];
}

const byStart = (a: DashboardRequest, b: DashboardRequest) =>
  (a.arrivalWindowStart ?? "").localeCompare(b.arrivalWindowStart ?? "");
const isCopy = (j: DashboardRequest) => j.laneRole === "helper";

/** Day view: a non-draggable copy of each card in every helper's lane (spec §7.2). Idempotent. */
export function laneCards(board: SchedulingCalendar): SchedulingCalendar {
  const lanes0 = board.lanes.map((l) => ({ ...l, jobs: l.jobs.filter((j) => !isCopy(j)) }));
  const unassigned = board.unassigned.filter((j) => !isCopy(j));
  const laneIds = new Set(lanes0.map((l) => l.technicianId));
  const copies = new Map<string, DashboardRequest[]>();
  for (const job of [...lanes0.flatMap((l) => l.jobs), ...unassigned]) {
    if (job.visitEnded) continue;
    for (const m of job.crew ?? []) {
      if (m.isLead || !laneIds.has(m.technicianId)) continue;
      const list = copies.get(m.technicianId) ?? [];
      list.push({ ...job, laneRole: "helper", laneTechnicianId: m.technicianId });
      copies.set(m.technicianId, list);
    }
  }
  const lanes = lanes0.map((l) => {
    const extra = copies.get(l.technicianId);
    return extra ? { ...l, jobs: [...l.jobs, ...extra].sort(byStart) } : l;
  });
  return { ...board, lanes, unassigned };
}

/** React key for a card: a helper copy is `${requestId}:${technicianId}`. */
export function laneKey(job: DashboardRequest): string {
  return isCopy(job) && job.laneTechnicianId ? `${job.id}:${job.laneTechnicianId}` : job.id;
}

/** The request's lead card and where it sits: a technician id, "unassigned" or "unscheduled". */
export function findLeadCard(board: SchedulingCalendar, requestId: string): { readonly card: DashboardRequest; readonly scope: string } | null {
  for (const lane of board.lanes) {
    const hit = lane.jobs.find((j) => j.id === requestId && !isCopy(j));
    if (hit) return { card: hit, scope: lane.technicianId };
  }
  const placed = board.unassigned.find((j) => j.id === requestId && !isCopy(j));
  if (placed) return { card: placed, scope: UNASSIGNED_SCOPE };
  const queued = board.unscheduled.find((j) => j.id === requestId);
  return queued ? { card: queued, scope: "unscheduled" } : null;
}

/** Write the 200's version, window, status and lead into the board before the refetch (spec §7.4 step 7). */
export function applyMoveResult(
  board: SchedulingCalendar,
  requestId: string,
  data: MoveSuccessData,
  names: ReadonlyMap<string, string>,
): SchedulingCalendar {
  const found = findLeadCard(board, requestId);
  if (!found) return board;
  const prev = found.card;
  const prevLead = prev.crew?.find((c) => c.isLead)?.technicianId ?? null;
  const leadChanged = data.leadId !== null && data.leadId !== prevLead;
  const next: DashboardRequest = {
    ...prev,
    visitId: data.visitId,
    visitVersion: data.visitVersion,
    status: data.requestStatus,
    arrivalWindowStart: data.arrivalWindowStart,
    arrivalWindowEnd: data.arrivalWindowEnd,
    assignedToName: data.leadId ? (names.get(data.leadId) ?? prev.assignedToName) : prev.assignedToName,
    crew: leadChanged ? optimisticCrew(prev.crew ?? [], data.leadId!, names.get(data.leadId!) ?? null) : prev.crew,
    laneRole: "lead",
  };
  const target = data.leadId && board.lanes.some((l) => l.technicianId === data.leadId) ? data.leadId : null;
  const without = (jobs: readonly DashboardRequest[]) => jobs.filter((j) => j.id !== requestId);
  return {
    ...board,
    lanes: board.lanes.map((l) => ({ ...l, jobs: l.technicianId === target ? [...without(l.jobs), next].sort(byStart) : without(l.jobs) })),
    unassigned: target ? without(board.unassigned) : [...without(board.unassigned), next].sort(byStart),
    unscheduled: without(board.unscheduled),
  };
}

export type IntendedMove =
  | { readonly requestId: string; readonly leadId: string | null; readonly start: string; readonly end: string }
  | { readonly requestId: string; readonly unscheduled: true };

const sameInstant = (a: string | null | undefined, b: string) => a !== null && a !== undefined && Date.parse(a) === Date.parse(b);

/** After a STALE or a lost response: does the refetched board show the move as made? (spec §4.2) */
export function moveLanded(board: SchedulingCalendar, intended: IntendedMove): boolean {
  const found = findLeadCard(board, intended.requestId);
  if (!found) return false;
  if ("unscheduled" in intended) return found.scope === "unscheduled";
  if (found.scope === "unscheduled") return false;
  const lane = found.scope === UNASSIGNED_SCOPE ? null : found.scope;
  return lane === intended.leadId && sameInstant(found.card.arrivalWindowStart, intended.start) && sameInstant(found.card.arrivalWindowEnd, intended.end);
}

// ── layout ─────────────────────────────────────────────────────────────────────

/** Drag only at ≥ 1024 px with a fine pointer (spec §7.8). */
export function boardInteractive(width: number, finePointer: boolean): boolean {
  return width >= 1024 && finePointer;
}

export function showCrewChips(crew: readonly CrewMember[] | undefined): boolean {
  return (crew?.length ?? 0) >= 2;
}

/** Chips, or a people icon with the count: below 120 px wide, below 72 px high, or in Week view (spec §7.2). */
export function chipLayout(width: number, height: number, view: "day" | "week"): "chips" | "count" {
  return view === "week" || width < 120 || height < 72 ? "count" : "chips";
}

/** Lead first, then helpers; three chips and "+N" past three. */
export function crewChipModel(crew: readonly CrewMember[]): { readonly chips: readonly CrewMember[]; readonly more: number } {
  const ordered = [...crew.filter((c) => c.isLead), ...crew.filter((c) => !c.isLead)];
  return { chips: ordered.slice(0, 3), more: Math.max(0, ordered.length - 3) };
}

export function initials(name: string | null): string {
  const parts = (name ?? "").trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return "?";
  return parts.slice(0, 2).map((p) => p[0]!.toUpperCase()).join("");
}

const STATE_WORD: Record<CrewState, string> = { open: "not started", working: "working", done: "done" };
export function crewStateWord(state: CrewState): string {
  return STATE_WORD[state];
}

/** A card's width in a 224 px lane split into `columns` side-by-side slots (2 px gutters). */
export function cardWidthPx(columns: number): number {
  return 224 / Math.max(1, columns) - 4;
}

/** The FieldPulse pill: "FieldPulse" (md) on a Day card ≥ 160 px wide, else "FP" (sm). */
export function pillSize(view: "day" | "week", widthPx: number): "sm" | "md" {
  return view === "day" && widthPx >= 160 ? "md" : "sm";
}

// ── Move… dialog ───────────────────────────────────────────────────────────────

export interface MoveDialogForm {
  /** "" = Unassigned: keeps the card's current lead (a move never unassigns). */
  readonly technicianId: string;
  readonly day: string;
  readonly window: "keep" | ArrivalWindow;
}

export function bandEnded(day: string, window: ArrivalWindow, now: Date): boolean {
  return windowHasEndedAt(arrivalWindowUtcForBusinessDate(day, window), now);
}

function cardWindow(card: DashboardRequest): { start: Date; end: Date } | null {
  if (!card.arrivalWindowStart || !card.arrivalWindowEnd) return null;
  return { start: new Date(card.arrivalWindowStart), end: new Date(card.arrivalWindowEnd) };
}

function leadOf(card: DashboardRequest, fromUnscheduled: boolean): string {
  return fromUnscheduled ? "" : (card.crew?.find((c) => c.isLead)?.technicianId ?? "");
}

/** Defaults (spec §7.5): the lead (Unassigned for an unassigned or Unscheduled card), the card's day (else today), Keep (else the first band that hasn't ended). */
export function moveDialogDefaults(card: DashboardRequest, today: string, now: Date, fromUnscheduled = false): MoveDialogForm {
  const win = cardWindow(card);
  const day = win ? businessIsoDate(win.start) : today;
  if (win) return { technicianId: leadOf(card, fromUnscheduled), day, window: "keep" };
  const open = ARRIVAL_WINDOWS.find((w) => !bandEnded(day, w, now)) ?? "evening";
  return { technicianId: leadOf(card, fromUnscheduled), day, window: open };
}

/** The move body for the dialog's choices, or null while nothing changes (Move disabled). */
export function moveDialogBody(card: DashboardRequest, form: MoveDialogForm, fromUnscheduled = false): MoveBody | null {
  const win = cardWindow(card);
  const lead = leadOf(card, fromUnscheduled);
  const sameTech = form.technicianId === "" || form.technicianId === lead;
  const tech = sameTech ? {} : { technicianId: form.technicianId };
  const base = { visitId: card.visitId ?? null, expectedVersion: card.visitVersion ?? null, day: form.day, confirm: [] as const };
  if (form.window === "keep") {
    if (!win) return null;
    if (sameTech && form.day === businessIsoDate(win.start)) return null;
    const kept = keepWindowOn(win, form.day);
    const band: MoveBand = windowRowOfInstant(kept.start) ?? (toBusinessWallClock(kept.start).hour < 8 ? "morning" : "evening");
    return { ...base, band, windowRule: "keep", ...tech };
  }
  const picked = arrivalWindowUtcForBusinessDate(form.day, form.window);
  if (sameTech && win && windowEqual(win, picked)) return null;
  const band: MoveBand = form.window === "anytime" ? "morning" : form.window;
  return { ...base, band, windowRule: "pick", pick: form.window, ...tech };
}
```

`src/lib/admin/dispatch-copy.ts`:

```ts
/**
 * Every M2 board and dispatch string (spec §8; lead ruling 10: U+2019
 * apostrophes). Pure and client-safe; components and routes import from here
 * so copy never forks.
 */
import { BUSINESS_TIME_ZONE, businessIsoDate, formatBusinessTimeRange } from "./calendar-time";
import { WINDOW_ENDED_MESSAGE } from "./window-ended";
import type { ConflictDetail, CrewMember, MassReason, MoveNeedsDetails } from "./board-types";

export const MOVE_GENERIC = "Couldn’t move the request. Please try again.";
export const STALE_LINE = "This request changed. The calendar has been refreshed.";
export const MOVED = "Moved.";
export const CALL_THEM = "Technicians aren’t told about this move. Call them.";
export const PROMPT_FOOTNOTE = "The customer isn’t told about this change.";
export const INTERACTIVE_NOTICE = "Dragging needs a computer. Use Move… on a request, or open it.";
export const SR_INSTRUCTIONS = "Use Move… to move a request with the keyboard.";
export const STARTED_CUE_TITLE = "Started. Moving it asks first.";
export const FIELDPULSE_BOARD = "Change this request in FieldPulse.";
export const FIELDPULSE_SHEET_TECH = "Change the technician for this request in FieldPulse.";
export const FIELDPULSE_SHEET_CREW = "Change the technicians for this request in FieldPulse.";
export const FIELDPULSE_SHEET_STARTED = "A technician has started this visit. Change it in FieldPulse.";
export const SHEET_STARTED_NATIVE = "A technician has started this visit. To move it anyway, use Move… on the calendar.";
export const TIME_OFF_TITLE = "Can’t move this request";
export const TIME_OFF_FOOTER = "Pick another time or technician.";
export const OUT_OF_HOURS_LINE = "This window falls outside the technician’s configured working hours.";

export const UNSCHEDULE_COPY = {
  HAS_PROGRESS: "A technician has started this visit, so it can’t go back to Unscheduled.",
  WORK_LOGGED: "Work was logged on this visit, so it can’t go back to Unscheduled.",
  STALE: STALE_LINE,
} as const;

export const MASS_COPY = {
  previewFailed: "Couldn’t load the preview. Please try again.",
  tryAgain: "Try again",
  empty: "No requests to move on this day.",
  overlap: "Move them even where they overlap",
  commitFailed: "Couldn’t move the requests. Please try again.",
  keyReused: "This move was already sent with different choices. Open the preview again.",
  pushesNotSent: "Not sent to Housecall Pro. Open it to retry.",
  sameTechnician: "Same technician",
  moves: "Moves",
  menuItem: "Move this day…",
} as const;

export function firstName(name: string | null | undefined): string {
  const t = (name ?? "").trim();
  return t ? t.split(/\s+/)[0]! : "A technician";
}

/** "Tue, Nov 10" for a business-tz ISO day. */
export function dayLabel(isoDay: string): string {
  return new Date(`${isoDay}T12:00:00.000Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });
}

/** "Tue, Nov 10" for the business day an instant falls on. */
export function instantDayLabel(instant: Date): string {
  return instant.toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: BUSINESS_TIME_ZONE });
}

export function rangeLabel(start: string | Date, end: string | Date): string {
  return formatBusinessTimeRange(new Date(start), new Date(end));
}

export function coveredLine(range: string): string {
  return `Still ${range}. Use Move… to change the window.`;
}

const STARTED_VERB: Record<string, string> = {
  en_route: "is en route to this visit.",
  arrived: "has arrived.",
  in_progress: "is in progress on this visit.",
  on_hold: "is paused on this visit.",
  completed: "is done with this visit.",
};
const MARKED: Record<string, string> = { en_route: "en route", arrived: "arrived", in_progress: "in progress", completed: "done" };

/** Line 1 of the started confirm. A status with no timestamp is the office's mirror: "This visit is marked in progress." */
export function startedLine(fullName: string | null, status: string, hasTimestamp: boolean): string {
  if (!hasTimestamp && MARKED[status]) return `This visit is marked ${MARKED[status]}.`;
  return `${fullName ?? "A technician"} ${STARTED_VERB[status] ?? "has started this visit."}`;
}

export interface ConfirmContext {
  readonly names: ReadonlyMap<string, string>;
  readonly oldLeadId: string | null;
  readonly newLeadId: string | null;
  readonly leadChanges: boolean;
  readonly windowChanges: boolean;
  /** The new window, "12 PM–4 PM". */
  readonly range: string;
  /** "Wed, Nov 11" when the day changes, else null. */
  readonly dayLabel: string | null;
  readonly resetsToScheduled: boolean;
}

/** The "Move anyway?" body for a 409 HAS_PROGRESS (spec §8; lead ruling 10). */
export function confirmLines(details: MoveNeedsDetails, ctx: ConfirmContext): string[] {
  if (!details.needs.includes("started")) return [];
  const name = (id: string | null) => (id ? (ctx.names.get(id) ?? null) : null);
  const started = details.started ?? [];
  const moveLine = `It moves to ${ctx.range}${ctx.dayLabel ? ` on ${ctx.dayLabel}` : ""}.`;
  const lines: string[] = [];
  const oldStarted = ctx.leadChanges ? started.find((s) => s.technicianId === ctx.oldLeadId) : undefined;
  if (oldStarted) {
    const oldFirst = firstName(name(ctx.oldLeadId));
    lines.push(startedLine(name(oldStarted.technicianId), oldStarted.status, oldStarted.hasTimestamp));
    let handover = `${oldFirst} comes off the visit. ${firstName(name(ctx.newLeadId))} becomes the lead and takes over close-out, the invoice and estimates.`;
    if (ctx.resetsToScheduled) handover += " The request goes back to scheduled.";
    if (oldStarted.openTimeEntry) handover += ` ${oldFirst}’s time on it stops.`;
    lines.push(handover);
    for (const s of started) if (s !== oldStarted) lines.push(startedLine(name(s.technicianId), s.status, s.hasTimestamp));
    if (ctx.windowChanges) lines.push(moveLine);
  } else {
    for (const s of started) lines.push(startedLine(name(s.technicianId), s.status, s.hasTimestamp));
    lines.push(moveLine);
  }
  lines.push(CALL_THEM);
  return lines;
}

/** "Overlapping requests:" rows; first names only when more than one technician is involved. */
export function conflictRows(conflicts: readonly ConflictDetail[], names: ReadonlyMap<string, string>): string[] {
  const many = new Set(conflicts.map((c) => c.technicianId)).size > 1;
  return conflicts.map((c) => {
    const base = `${c.referenceNumber} · ${rangeLabel(c.arrivalWindowStart, c.arrivalWindowEnd)}`;
    return many ? `${base} · ${firstName(names.get(c.technicianId) ?? null)}` : base;
  });
}

/** One time-off dialog line (spec §8). `helper`: the technician is a helper the dispatcher could remove instead. */
export function timeOffLine(
  fullName: string | null,
  block: { readonly startsAt: string; readonly endsAt: string; readonly kind: "on_call" | "time_off" | "non_job" },
  helper: boolean,
): string {
  const who = firstName(fullName);
  const start = new Date(block.startsAt);
  const end = new Date(block.endsAt);
  const firstDay = businessIsoDate(start);
  const lastDay = businessIsoDate(new Date(end.getTime() - 1));
  const what = block.kind === "time_off" ? "is off" : "has a non-job event";
  const when = firstDay === lastDay ? `${rangeLabel(start, end)} on ${dayLabel(firstDay)}` : `${dayLabel(firstDay)} – ${dayLabel(lastDay)}`;
  return `${who} ${what} ${when}.${helper ? ` Or remove ${who} in the request.` : ""}`;
}

/** The banner for a refused move (spec §8 "Banners"). */
export function moveErrorBanner(code: string, details?: unknown, names?: ReadonlyMap<string, string>): string {
  const d = (details ?? {}) as { visitNumber?: number; status?: string; technicianId?: string };
  switch (code) {
    case "STALE":
      return STALE_LINE;
    case "VISIT_ENDED":
      return "This visit has ended. Add a new visit instead.";
    case "VISIT_PINNED":
      return `Visit #${d.visitNumber ?? 2}. Change its time in the request.`;
    case "REQUEST_TERMINAL":
      return d.status === "cancelled" ? "This request is cancelled, so it can’t be moved." : "This request is completed, so it can’t be moved.";
    case "TECHNICIAN_NOT_FOUND":
      return "That technician isn’t active any more.";
    case "TECHNICIAN_DONE":
      return `${firstName(d.technicianId ? (names?.get(d.technicianId) ?? null) : null)} has finished on this visit.`;
    case "WINDOW_ENDED":
      return WINDOW_ENDED_MESSAGE;
    case "MANAGED_EXTERNALLY":
      return FIELDPULSE_BOARD;
    default:
      return MOVE_GENERIC;
  }
}

/** The success banner: a lead change that takes the old lead off names both (spec §7.5). */
export function moveBanner(before: readonly CrewMember[], after: readonly CrewMember[]): string {
  const oldLead = before.find((c) => c.isLead);
  const newLead = after.find((c) => c.isLead);
  if (oldLead && newLead && oldLead.technicianId !== newLead.technicianId && !after.some((c) => c.technicianId === oldLead.technicianId)) {
    return `${firstName(newLead.name)} is now the lead. ${firstName(oldLead.name)} is off this visit.`;
  }
  return MOVED;
}

export function massReasonLabel(
  reason: MassReason | "conflict",
  ctx: { readonly visitNumber?: number; readonly toFirstName?: string; readonly leadFirstName?: string },
): string {
  switch (reason) {
    case "started": return "Started";
    case "ended": return "Visit ended";
    case "later_visit": return `Visit #${ctx.visitNumber ?? 2}. Change it in the request.`;
    case "time_off": return "Time off then";
    case "window_ended": return "That time has passed";
    case "already_on_visit": return `${ctx.toFirstName ?? "That technician"} is already on it`;
    case "fieldpulse": return "Change it in FieldPulse";
    case "helper": return `Helping ${ctx.leadFirstName ?? "another technician"}. Change it in the request.`;
    case "stale": return "Changed since you opened this";
    case "conflict": return "Overlaps another request";
  }
}

export function massResultHeadline(moved: number, fromFirst: string, toFirst: string | null, toDayLabel: string | null): string {
  if (moved === 0) return `None of ${fromFirst}’s requests moved.`;
  const to = [toFirst ? ` to ${toFirst}` : "", toDayLabel ? `${toFirst ? " on" : " to"} ${toDayLabel}` : ""].join("");
  return `Moved ${moved} of ${fromFirst}’s requests${to}.`;
}

export function massMoveButton(n: number): string {
  return n === 1 ? "Move 1 request" : `Move ${n} requests`;
}

export function massDialogTitle(technicianName: string, fromDayLabel: string): string {
  return `Move ${firstName(technicianName)}’s requests on ${fromDayLabel}`;
}
```

`src/lib/admin/mass-reschedule-model.ts`:

```ts
/**
 * Mass reschedule classification (M2 spec §5.6), pure: what happens to each
 * visit technician T is on that day when it moves to day D2 and/or lead T2.
 * Order: fieldpulse, helper, later_visit, ended, started, window_ended,
 * already_on_visit, time_off; else it moves, with a soft conflict flag.
 */
import { moveNeeds, type NeedsRow } from "./board-move";
import { keepWindowOn, timeOffHits, windowHasEndedAt, type TimeWindow } from "./move-window";
import type { BoardBlock, MassOutcome } from "./board-types";

export interface MassVisitFacts {
  readonly visitId: string;
  readonly requestId: string;
  readonly visitNumber: number;
  readonly window: TimeWindow;
  readonly fieldpulse: boolean;
  /** T is this visit's lead (else T is a helper on it). */
  readonly techIsLead: boolean;
  /** Visit cancelled, or a hold ended the request's visits. */
  readonly ended: boolean;
  /** Live rows on the visit. */
  readonly rows: readonly NeedsRow[];
  /** T2 has any row on the visit, cancelled included. */
  readonly toTechOnVisit: boolean;
}

export interface MassContext {
  readonly technicianId: string;
  readonly toTechnicianId: string | null;
  readonly fromDate: string;
  readonly toDate: string;
  readonly now: Date;
  readonly blocks: readonly BoardBlock[];
  /** Open rows of other requests' live visits, per technician. */
  readonly busy: readonly { readonly technicianId: string; readonly requestId: string; readonly start: Date; readonly end: Date }[];
  readonly outsideHours: (technicianId: string, window: TimeWindow) => boolean;
  /** Requests moving together in this run: they already sat together on D, so they never conflict with each other (plan v2, critic A MAJOR-1). */
  readonly batchRequestIds?: readonly string[];
}

export interface MassClassification {
  readonly outcome: MassOutcome;
  readonly conflict: boolean;
  readonly newWindow: TimeWindow;
}

export function classifyMassVisit(f: MassVisitFacts, ctx: MassContext): MassClassification {
  const dayChanges = ctx.toDate !== ctx.fromDate;
  const leadChanges = ctx.toTechnicianId !== null && ctx.toTechnicianId !== ctx.technicianId;
  const newWindow = dayChanges ? keepWindowOn(f.window, ctx.toDate) : f.window;
  const skip = (outcome: MassOutcome): MassClassification => ({ outcome, conflict: false, newWindow });
  if (f.fieldpulse) return skip("fieldpulse");
  if (!f.techIsLead) return skip("helper");
  if (f.visitNumber > 1) return skip("later_visit");
  if (f.ended) return skip("ended");
  const lead = leadChanges ? ctx.toTechnicianId! : ctx.technicianId;
  const needs = moveNeeds({ leadChanges, windowChanges: dayChanges, currentLeadId: ctx.technicianId, newLeadId: lead, rows: f.rows });
  if (needs.started) return skip("started");
  if (dayChanges && windowHasEndedAt(newWindow, ctx.now)) return skip("window_ended");
  if (leadChanges && f.toTechOnVisit) return skip("already_on_visit");
  if (timeOffHits(ctx.blocks, needs.checked, newWindow).length > 0) return skip("time_off");
  const checked = new Set(needs.checked);
  const batch = new Set(ctx.batchRequestIds ?? []);
  const overlap = ctx.busy.some(
    (b) => checked.has(b.technicianId) && b.requestId !== f.requestId && !batch.has(b.requestId) &&
      b.start.getTime() < newWindow.end.getTime() && b.end.getTime() > newWindow.start.getTime(),
  );
  const outside = checked.has(lead) && ctx.outsideHours(lead, newWindow);
  return { outcome: "moves", conflict: overlap || outside, newWindow };
}

function addDays(isoDay: string, n: number): string {
  const d = new Date(`${isoDay}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** The next weekday (Mon–Fri) after `fromDate` (spec §7.6 default). */
export function massDefaultDay(fromDate: string): string {
  let day = addDays(fromDate, 1);
  while ([0, 6].includes(new Date(`${day}T12:00:00.000Z`).getUTCDay())) day = addDays(day, 1);
  return day;
}

export function massDayShift(fromDate: string, toDate: string): number {
  return Math.round((Date.parse(`${toDate}T00:00:00.000Z`) - Date.parse(`${fromDate}T00:00:00.000Z`)) / 86_400_000);
}

/** Anything to move: another day, or another technician. */
export function massChanges(q: { readonly fromDate: string; readonly toDate: string; readonly technicianId: string; readonly toTechnicianId: string | null }): boolean {
  return q.toDate !== q.fromDate || (q.toTechnicianId !== null && q.toTechnicianId !== q.technicianId);
}
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `npx vitest run src/lib/admin/board-move.test.ts src/lib/admin/dispatch-copy.test.ts src/lib/admin/mass-reschedule-model.test.ts`
Expected: PASS.

- [ ] **Step 6: Gates and commit**

```bash
npx tsc --noEmit && npx eslint src/lib/admin/board-move.ts src/lib/admin/board-move.test.ts src/lib/admin/dispatch-copy.ts src/lib/admin/dispatch-copy.test.ts src/lib/admin/mass-reschedule-model.ts src/lib/admin/mass-reschedule-model.test.ts src/lib/admin/types.ts src/lib/admin/appointment-types.ts && npx vitest run
git add src/lib/admin/board-move.ts src/lib/admin/board-move.test.ts src/lib/admin/dispatch-copy.ts src/lib/admin/dispatch-copy.test.ts src/lib/admin/mass-reschedule-model.ts src/lib/admin/mass-reschedule-model.test.ts src/lib/admin/types.ts src/lib/admin/appointment-types.ts
git commit -m "$(cat <<'EOF'
feat(m2): board move model, dispatch copy and mass classification, pure

moveNeeds, optimisticCrew, laneCards, applyMoveResult, moveLanded, chip and
pill layout, the Move... dialog defaults and body; every spec 8 string in
one module; mass reschedule classification and default day.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01GuWoF63tQU1i7ELqyYU3A6
EOF
)"
```

---
### Task 3: Shared move SQL and the sheet writers — started guard, revive, lead not done, FieldPulse refusal

**Files:**
- Create: `src/lib/admin/visit-move-sql.ts`, `src/lib/admin/visit-move-sql.test.ts`
- Modify: `src/lib/admin/visit-one-guard.ts` (whole file below), `src/lib/admin/visit-one-guard.test.ts`, `src/lib/admin/queries.ts` (`assignTechnician`, `reassignTechnician`, imports), `src/lib/admin/queries.test.ts` (mocks + new cases), `src/lib/admin/scheduling-queries.ts` (`placeAndAssignRequest`, import), `src/lib/admin/scheduling-queries.test.ts` (mocks + the lock test), `src/app/api/admin/requests/[id]/assign/route.ts`, `src/app/api/admin/requests/[id]/assign/route.test.ts`, `src/app/api/admin/requests/[id]/route.ts` (schedule-edit refusal names FieldPulse), `src/app/api/admin/requests/[id]/route.test.ts`, `src/app/api/admin/requests/[id]/reschedule/route.test.ts` (its HAS_PROGRESS expectation follows the new copy until Task 8 deletes the route)

**Interfaces:**
- Consumes (Task 1): `startedRowSql`, `anyTimestampSql`; (Task 2): `FIELDPULSE_SHEET_STARTED`, `FIELDPULSE_SHEET_TECH`, `SHEET_STARTED_NATIVE`, `UNSCHEDULE_COPY`. Existing: `closeJobEntriesSql` (`src/lib/tech/time-entry-sql.ts`), `OPEN_ASSIGNMENT_STATUSES` (`src/lib/tech/ownership.ts`), `OPEN_STATUSES` (`request-status.ts`).
- Produces:
  - `visit-move-sql.ts` (pure SQL builders; every one binds `organization_id` as a parameter): `visitOneIdSql(org, rid)`, `requestXminGateSql(org, rid)`, `visitOneXminGateSql(org, rid)`, `versionGateSql(org, rid, visitId, version)`, `startedOnVisitOneSql(org, which: "lead" | "any")`, `otherStartedOnVisitOneSql(org, technicianId)`, `leadDoneSql(org, technicianId)`, `activeTechnicianSql(org, technicianId)`, `visitOneLiveSql(org)`, `noOverlapSql(org, rid, technicianIds, startIso, endIso)`, `overlapFromWhereSql(…same)`, `reviveLeadSql(org, rid, gate)`, `cancelDoneOldLeadSql(org, rid, oldLeadId, gate)`, `closeOldLeadEntriesSql(org, rid, oldLeadId, gate)`, `noWorkLoggedSql(org)`, `fieldpulseFreeSql`, `resetFromSql`.
  - `visit-one-guard.ts`: `visitOneStartedGuardSql(org)`; `classifyVisitOne(org, rid, rule?: "timestamp" | "started", technicianId?)` → `{ status, refusal, fieldpulse, technicianDone } | null`; `lockedUpdate(org, rid, update, after?: SQL[])`; `visitOneRefusalResponse(reason, opts?: { fieldpulse?, surface?: "sheet" | "unschedule" })`; `isFieldpulseMapped(org, rid)`. `visitOneGuardSql()` unchanged.
  - `assignTechnician` / `reassignTechnician` results add `{ ok: false, reason: "managed_externally" }` and `{ ok: false, reason: "technician_done" }`.
  - Assign routes: 409 `MANAGED_EXTERNALLY` "Change the technician for this request in FieldPulse."; 409 `TECHNICIAN_DONE` "That technician has finished on this visit." with `details: { technicianId }` (the sheet builds "<name> has finished on this visit.", Task 10); HAS_PROGRESS "A technician has started this visit. To move it anyway, use Move… on the calendar."

- [ ] **Step 1: Write the failing SQL render tests** — `src/lib/admin/visit-move-sql.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { sql, type SQL } from "drizzle-orm";
import {
  activeTechnicianSql, cancelDoneOldLeadSql, closeOldLeadEntriesSql, fieldpulseFreeSql, leadDoneSql, noOverlapSql, noWorkLoggedSql,
  otherStartedOnVisitOneSql, requestXminGateSql, reviveLeadSql, startedOnVisitOneSql, versionGateSql, visitOneIdSql,
  visitOneLiveSql, visitOneXminGateSql,
} from "./visit-move-sql";

const ORG = "00000000-0000-4000-8000-0000000000aa";
const RID = "11111111-1111-4111-8111-111111111111";
const VID = "22222222-2222-4222-8222-222222222222";
const ALEX = "33333333-3333-4333-8333-333333333333";
const SAM = "44444444-4444-4444-8444-444444444444";
const q = (s: SQL) => {
  const out = new PgDialect().sqlToQuery(s);
  return { text: out.sql.replace(/\s+/g, " ").trim(), params: out.params };
};
const GATE = sql`GATE_MARK`;

describe("visit #1 and gates", () => {
  it("visitOneIdSql binds the request and the org", () => {
    expect(q(visitOneIdSql(ORG, RID))).toEqual({
      text: "(SELECT v1.id FROM appointments v1 WHERE v1.service_request_id = $1::uuid AND v1.organization_id = $2::uuid AND v1.appointment_number = 1)",
      params: [RID, ORG],
    });
  });
  it("requestXminGateSql: this transaction wrote the org's request row", () => {
    expect(q(requestXminGateSql(ORG, RID))).toEqual({
      text: "EXISTS (SELECT 1 FROM service_requests xr WHERE xr.id = $1::uuid AND xr.organization_id = $2::uuid AND xr.xmin = pg_current_xact_id()::xid)",
      params: [RID, ORG],
    });
  });
  it("visitOneXminGateSql: this transaction wrote visit #1 (the trigger's version bump)", () => {
    expect(q(visitOneXminGateSql(ORG, RID))).toEqual({
      text: "EXISTS (SELECT 1 FROM appointments xp WHERE xp.service_request_id = $1::uuid AND xp.organization_id = $2::uuid AND xp.appointment_number = 1 AND xp.xmin = pg_current_xact_id()::xid)",
      params: [RID, ORG],
    });
  });
  it("versionGateSql compares the visit id AND its version, on #1 of this request in this org", () => {
    expect(q(versionGateSql(ORG, RID, VID, 7))).toEqual({
      text: "EXISTS (SELECT 1 FROM appointments g WHERE g.id = $1::uuid AND g.organization_id = $2::uuid AND g.service_request_id = $3::uuid AND g.appointment_number = 1 AND g.version = $4::int)",
      params: [VID, ORG, RID, 7],
    });
  });
  it("versionGateSql with a null visit: no visit #1 may exist", () => {
    expect(q(versionGateSql(ORG, RID, null, null))).toEqual({
      text: "NOT EXISTS (SELECT 1 FROM appointments g WHERE g.service_request_id = $1::uuid AND g.organization_id = $2::uuid AND g.appointment_number = 1)",
      params: [RID, ORG],
    });
  });
  it("visitOneLiveSql: #1 is the displayed visit, not ended, not cancelled", () => {
    const { text, params } = q(visitOneLiveSql(ORG));
    expect(text).toMatch(/^\(NOT \(/);
    expect(text).toContain("NOT EXISTS (SELECT 1 FROM appointments c1 WHERE c1.service_request_id = \"service_requests\".\"id\" AND c1.organization_id = $");
    expect(text).toContain("c1.appointment_number = 1 AND c1.cancelled_at IS NOT NULL)");
    expect(params).toContain(ORG);
  });
});

describe("started, done, active", () => {
  it("startedOnVisitOneSql(any) is correlated, org-bound, uses the started twin", () => {
    const { text, params } = q(startedOnVisitOneSql(ORG, "any"));
    expect(text).toBe(
      "EXISTS (SELECT 1 FROM appointment_assignments sa JOIN appointments sp ON sp.id = sa.appointment_id WHERE sp.service_request_id = \"service_requests\".\"id\" AND sp.organization_id = $1::uuid AND sa.organization_id = $2::uuid AND sp.appointment_number = 1 AND (sa.status <> 'cancelled'::request_status AND (sa.status IN ('en_route'::request_status, 'arrived'::request_status, 'in_progress'::request_status) OR (sa.status = 'on_hold'::request_status AND (sa.en_route_at IS NOT NULL OR sa.arrived_at IS NOT NULL OR sa.started_at IS NOT NULL OR sa.completed_at IS NOT NULL)) OR (sa.is_lead AND sa.status = 'completed'::request_status))))",
    );
    expect(params).toEqual([ORG, ORG]);
  });
  it("startedOnVisitOneSql(lead) looks at the lead row only", () => {
    expect(q(startedOnVisitOneSql(ORG, "lead")).text).toContain("AND sp.appointment_number = 1 AND sa.is_lead AND (sa.status <> 'cancelled'");
  });
  it("otherStartedOnVisitOneSql excludes one technician", () => {
    const { text, params } = q(otherStartedOnVisitOneSql(ORG, ALEX));
    expect(text).toContain("AND sp.appointment_number = 1 AND sa.technician_id <> $3::uuid AND (sa.status <> 'cancelled'");
    expect(params).toEqual([ORG, ORG, ALEX]);
  });
  it("leadDoneSql: the technician has a completed row on #1", () => {
    expect(q(leadDoneSql(ORG, SAM))).toEqual({
      text: "EXISTS (SELECT 1 FROM appointment_assignments d JOIN appointments dp ON dp.id = d.appointment_id WHERE dp.service_request_id = \"service_requests\".\"id\" AND dp.organization_id = $1::uuid AND d.organization_id = $2::uuid AND dp.appointment_number = 1 AND d.technician_id = $3::uuid AND d.status = 'completed'::request_status)",
      params: [ORG, ORG, SAM],
    });
  });
  it("step 1 requires the new lead to be an active technician of the org", () => {
    expect(q(activeTechnicianSql(ORG, SAM))).toEqual({
      text: "EXISTS (SELECT 1 FROM users u WHERE u.id = $1::uuid AND u.organization_id = $2::uuid AND u.role = 'technician' AND u.is_active)",
      params: [SAM, ORG],
    });
  });
});

describe("noOverlapSql (lead ruling 5)", () => {
  it("open rows of the checked technicians on live visits of other open requests, half-open, org-bound three times", () => {
    const { text, params } = q(noOverlapSql(ORG, RID, [ALEX, SAM], "2026-11-10T17:00:00.000Z", "2026-11-10T21:00:00.000Z"));
    expect(text).toMatch(/^NOT EXISTS \(SELECT 1 FROM appointment_assignments ca JOIN appointments cp ON cp\.id = ca\.appointment_id JOIN service_requests cr ON cr\.id = cp\.service_request_id/);
    expect(text).toContain("WHERE ca.organization_id = $1::uuid AND cp.organization_id = $2::uuid AND cr.organization_id = $3::uuid");
    expect(text).toContain("AND ca.technician_id = ANY($4::uuid[])");
    expect(text).toContain("AND ca.status IN ('assigned'::request_status, 'scheduled'::request_status, 'en_route'::request_status, 'arrived'::request_status, 'in_progress'::request_status, 'on_hold'::request_status)");
    expect(text).toContain("AND cp.cancelled_at IS NULL AND cr.id <> $5::uuid AND cr.status IN ('pending'::request_status,");
    expect(text).toContain("AND cp.arrival_window_start < $6::timestamptz AND cp.arrival_window_end > $7::timestamptz)");
    expect(params).toEqual([ORG, ORG, ORG, [ALEX, SAM], RID, "2026-11-10T21:00:00.000Z", "2026-11-10T17:00:00.000Z"]);
    expect(text).not.toContain("<> ALL(");
  });
  it("mass: the other requests of the run are excluded too", () => {
    const { text, params } = q(noOverlapSql(ORG, RID, [ALEX], "a", "b", [RID, VID]));
    expect(text).toMatch(/AND cr\.id <> ALL\(\$\d+::uuid\[\]\)\)$/);
    expect(params.at(-1)).toEqual([RID, VID]);
  });
});

describe("follow-on statements (spec §5.3 steps 2–4)", () => {
  it("reviveLeadSql: the request's lead row on #1, cancelled or a started status with no stamp, nulls the stamps", () => {
    const { text, params } = q(reviveLeadSql(ORG, RID, GATE));
    expect(text).toBe(
      "UPDATE appointment_assignments a SET status = CASE WHEN r.status IN ('en_route'::request_status, 'arrived'::request_status, 'in_progress'::request_status, 'on_hold'::request_status) THEN 'assigned'::request_status ELSE r.status END, en_route_at = NULL, arrived_at = NULL, started_at = NULL, completed_at = NULL FROM service_requests r, appointments p WHERE r.id = $1::uuid AND r.organization_id = $2::uuid AND p.id = a.appointment_id AND p.service_request_id = r.id AND p.organization_id = $3::uuid AND p.appointment_number = 1 AND a.organization_id = $4::uuid AND a.technician_id = r.assigned_to AND a.is_lead AND (a.status = 'cancelled'::request_status OR (a.status IN ('en_route'::request_status, 'arrived'::request_status, 'in_progress'::request_status, 'on_hold'::request_status) AND NOT (a.en_route_at IS NOT NULL OR a.arrived_at IS NOT NULL OR a.started_at IS NOT NULL OR a.completed_at IS NOT NULL))) AND (GATE_MARK) RETURNING a.id",
    );
    expect(params).toEqual([RID, ORG, ORG, ORG]);
  });
  it("cancelDoneOldLeadSql: only the old lead's kept completed helper row, gated", () => {
    expect(q(cancelDoneOldLeadSql(ORG, RID, ALEX, GATE))).toEqual({
      text: "UPDATE appointment_assignments a SET status = 'cancelled'::request_status FROM appointments p WHERE p.id = a.appointment_id AND p.service_request_id = $1::uuid AND p.organization_id = $2::uuid AND p.appointment_number = 1 AND a.organization_id = $3::uuid AND a.technician_id = $4::uuid AND NOT a.is_lead AND a.status = 'completed'::request_status AND (GATE_MARK) RETURNING a.id",
      params: [RID, ORG, ORG, ALEX],
    });
  });
  it("closeOldLeadEntriesSql: the old lead's open job time on #1 or with no visit link, gated", () => {
    const { text, params } = q(closeOldLeadEntriesSql(ORG, RID, ALEX, GATE));
    expect(text).toContain("WHERE u.id = t.technician_id AND t.organization_id = $");
    expect(text).toContain("AND t.technician_id = ANY($");
    expect(text).toContain("AND t.kind = 'job' AND t.clock_out_at IS NULL AND ((GATE_MARK) AND (t.appointment_id = (SELECT v1.id FROM appointments v1 WHERE v1.service_request_id = $");
    expect(text).toContain("v1.appointment_number = 1) OR t.appointment_id IS NULL))");
    expect(params).toEqual([ORG, RID, [ALEX], RID, ORG]);
  });
  it("noWorkLoggedSql: no job time on #1 of the correlated request, nor unlinked (WORK_LOGGED)", () => {
    expect(q(noWorkLoggedSql(ORG))).toEqual({
      text: "NOT EXISTS (SELECT 1 FROM technician_time_entries t WHERE t.organization_id = $1::uuid AND t.service_request_id = \"service_requests\".\"id\" AND t.kind = 'job' AND (t.appointment_id = (SELECT w1.id FROM appointments w1 WHERE w1.service_request_id = \"service_requests\".\"id\" AND w1.organization_id = $2::uuid AND w1.appointment_number = 1) OR t.appointment_id IS NULL))",
      params: [ORG, ORG],
    });
  });
  it("fieldpulseFreeSql is the correlated request's predicate", () => {
    expect(q(fieldpulseFreeSql()).text).toBe("\"service_requests\".\"fieldpulse_job_id\" IS NULL");
  });
});
```

Add to `src/lib/admin/visit-one-guard.test.ts` (keep the file's mocks; extend the import line to `import { classifyVisitOne, lockedUpdate, visitOneGuardSql, visitOneRefusalResponse, visitOneStartedGuardSql } from "./visit-one-guard";`, and replace the existing `classifyVisitOne` and `lockedUpdate` describes with these):

```ts
describe("visitOneStartedGuardSql", () => {
  it("refuses a started visit #1 (the M2 rule) or an ended one; org-bound", () => {
    const { sql: text, params } = new PgDialect().sqlToQuery(visitOneStartedGuardSql("org-1"));
    expect(text.startsWith("(NOT EXISTS (SELECT 1 FROM appointment_assignments sa JOIN appointments sp")).toBe(true);
    expect(text).toContain("sp.organization_id = $1::uuid AND sa.organization_id = $2::uuid AND sp.appointment_number = 1 AND (sa.status <> 'cancelled'::request_status");
    expect(text).toContain("AND (\"service_requests\".\"status\" = 'cancelled'::request_status OR NOT EXISTS (SELECT 1 FROM appointments p WHERE p.service_request_id = \"service_requests\".\"id\" AND p.appointment_number = 1 AND p.cancelled_at IS NOT NULL)))");
    expect(params).toEqual(["org-1", "org-1"]);
  });
});

describe("classifyVisitOne", () => {
  it("progress wins; an ended visit counts only while the request is not cancelled", async () => {
    selectQueue.push(
      [{ status: "on_hold", progressed: true, ended: true, fieldpulse: false, technicianDone: false }],
      [{ status: "on_hold", progressed: false, ended: true, fieldpulse: false, technicianDone: false }],
      [{ status: "cancelled", progressed: false, ended: true, fieldpulse: false, technicianDone: false }],
      [],
    );
    expect(await classifyVisitOne("o", "r")).toEqual({ status: "on_hold", refusal: "has_progress", fieldpulse: false, technicianDone: false });
    expect(await classifyVisitOne("o", "r")).toEqual({ status: "on_hold", refusal: "visit_ended", fieldpulse: false, technicianDone: false });
    expect(await classifyVisitOne("o", "r")).toEqual({ status: "cancelled", refusal: null, fieldpulse: false, technicianDone: false });
    expect(await classifyVisitOne("o", "r")).toBeNull();
  });
  it("reports FieldPulse and a done technician (started rule)", async () => {
    selectQueue.push([{ status: "in_progress", progressed: true, ended: false, fieldpulse: true, technicianDone: true }]);
    expect(await classifyVisitOne("o", "r", "started", "t")).toEqual({ status: "in_progress", refusal: "has_progress", fieldpulse: true, technicianDone: true });
  });
});

describe("lockedUpdate", () => {
  it("batches the request lock in front of the update and returns the update's rows", async () => {
    batch.mockResolvedValue([{ rows: [] }, [{ id: "r" }]]);
    const update = { marker: "update" };
    expect(await lockedUpdate("o", "r", update)).toEqual([{ id: "r" }]);
    const [lock, second] = batch.mock.calls[0]![0] as [SQL, unknown];
    expect(new PgDialect().sqlToQuery(lock).sql).toBe(
      "SELECT 1 FROM service_requests WHERE id = $1::uuid AND organization_id = $2::uuid FOR NO KEY UPDATE",
    );
    expect(second).toBe(update);
  });
  it("appends follow-on statements after the update, in order", async () => {
    batch.mockReset();
    batch.mockResolvedValue([{ rows: [] }, [{ id: "r" }], { rows: [] }]);
    const { sql } = await import("drizzle-orm");
    const after = sql`SELECT 'after'`;
    await lockedUpdate("o", "r", { marker: "update" }, [after]);
    const statements = batch.mock.calls[0]![0] as unknown[];
    expect(statements).toHaveLength(3);
    expect(statements[2]).toBe(after); // db.execute is the identity in this mock
  });
});

describe("visitOneRefusalResponse (spec §5.5, §8)", () => {
  it("native sheet: points to Move… on the calendar", async () => {
    const body = await visitOneRefusalResponse("has_progress").json();
    expect(body.error).toEqual({ code: "HAS_PROGRESS", message: "A technician has started this visit. To move it anyway, use Move… on the calendar." });
  });
  it("a FieldPulse request names FieldPulse", async () => {
    const body = await visitOneRefusalResponse("has_progress", { fieldpulse: true }).json();
    expect(body.error.message).toBe("A technician has started this visit. Change it in FieldPulse.");
  });
  it("drag to Unscheduled has its own line", async () => {
    const body = await visitOneRefusalResponse("has_progress", { surface: "unschedule" }).json();
    expect(body.error.message).toBe("A technician has started this visit, so it can’t go back to Unscheduled.");
  });
  it("visit_ended is unchanged", async () => {
    const res = visitOneRefusalResponse("visit_ended");
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("VISIT_ENDED");
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/lib/admin/visit-move-sql.test.ts src/lib/admin/visit-one-guard.test.ts`
Expected: FAIL — `./visit-move-sql` doesn't resolve; `visitOneStartedGuardSql` / `visitOneRefusalResponse` assertions fail.

- [ ] **Step 3: The builders** — `src/lib/admin/visit-move-sql.ts`:

```ts
/**
 * Shared SQL for the M2 writers (spec §4.1, §5.3–§5.5). Pure builders: every
 * table reference binds organization_id as a parameter; every fragment holding
 * OR is parenthesised; enum literals are cast. "Correlated" builders refer to
 * the unaliased outer `"service_requests"` row (an UPDATE service_requests or a
 * drizzle query on serviceRequests), like visit-one-guard.ts.
 */
import { sql, type SQL } from "drizzle-orm";
import { OPEN_ASSIGNMENT_STATUSES } from "@/lib/tech/ownership";
import { closeJobEntriesSql } from "@/lib/tech/time-entry-sql";
import { placedByVisitSql } from "./current-visit";
import { OPEN_STATUSES } from "./request-status";
import { anyTimestampSql, startedRowSql } from "./visit-started";

const statusList = (list: readonly string[]): SQL => sql.raw(list.map((s) => `'${s}'::request_status`).join(", "));
// Builders, not module constants: modules that mock drizzle-orm (tests/e2e/smoke.test.ts) import this file transitively.
const openRows = (): SQL => statusList(OPEN_ASSIGNMENT_STATUSES);
const openRequests = (): SQL => statusList(OPEN_STATUSES);
/** Statuses a lead change resets (spec §5.3 step 1) and the revive maps to `assigned` (step 3). */
export const resetFromSql = (): SQL => statusList(["en_route", "arrived", "in_progress", "on_hold"]);

/** The correlated request is not FieldPulse-mapped (spec §5.1: every FieldPulse refusal is a predicate). */
export const fieldpulseFreeSql = (): SQL => sql.raw(`"service_requests"."fieldpulse_job_id" IS NULL`);

/** Visit #1 of the request, as a uuid scalar subquery. */
export function visitOneIdSql(org: string, rid: string): SQL {
  return sql`(SELECT v1.id FROM appointments v1 WHERE v1.service_request_id = ${rid}::uuid AND v1.organization_id = ${org}::uuid AND v1.appointment_number = 1)`;
}

/** THIS transaction wrote the request row: gates every statement after the move's UPDATE. */
export function requestXminGateSql(org: string, rid: string): SQL {
  return sql`EXISTS (SELECT 1 FROM service_requests xr WHERE xr.id = ${rid}::uuid AND xr.organization_id = ${org}::uuid AND xr.xmin = pg_current_xact_id()::xid)`;
}

/** THIS transaction wrote visit #1 (the trigger bumped its version): the audit gate (M3c, equipment-writes.ts:89). */
export function visitOneXminGateSql(org: string, rid: string): SQL {
  return sql`EXISTS (SELECT 1 FROM appointments xp WHERE xp.service_request_id = ${rid}::uuid AND xp.organization_id = ${org}::uuid AND xp.appointment_number = 1 AND xp.xmin = pg_current_xact_id()::xid)`;
}

/**
 * The revision gate (spec §4.1): the card's visit is #1 of this request in
 * this org at this version. The id matters because a new #1 starts at 0. A
 * null visit means the card saw no visit #1: none may exist now.
 */
export function versionGateSql(org: string, rid: string, visitId: string | null, version: number | null): SQL {
  if (visitId === null) {
    return sql`NOT EXISTS (SELECT 1 FROM appointments g WHERE g.service_request_id = ${rid}::uuid AND g.organization_id = ${org}::uuid AND g.appointment_number = 1)`;
  }
  return sql`EXISTS (SELECT 1 FROM appointments g WHERE g.id = ${visitId}::uuid AND g.organization_id = ${org}::uuid AND g.service_request_id = ${rid}::uuid AND g.appointment_number = 1 AND g.version = ${version ?? -1}::int)`;
}

/** Visit #1 is what the office shows (not a later visit, not a hold-ended visit) and not cancelled. Correlated. */
export function visitOneLiveSql(org: string): SQL {
  return sql`(NOT ${placedByVisitSql()} AND NOT EXISTS (SELECT 1 FROM appointments c1 WHERE c1.service_request_id = "service_requests"."id" AND c1.organization_id = ${org}::uuid AND c1.appointment_number = 1 AND c1.cancelled_at IS NOT NULL))`;
}

/** A started live row on visit #1 of the correlated request; `lead`: the lead row only (spec §3.2). */
export function startedOnVisitOneSql(org: string, which: "lead" | "any"): SQL {
  const lead = which === "lead" ? sql` AND sa.is_lead` : sql``;
  return sql`EXISTS (SELECT 1 FROM appointment_assignments sa JOIN appointments sp ON sp.id = sa.appointment_id WHERE sp.service_request_id = "service_requests"."id" AND sp.organization_id = ${org}::uuid AND sa.organization_id = ${org}::uuid AND sp.appointment_number = 1${lead} AND ${startedRowSql("sa")})`;
}

/** A started live row on visit #1 belonging to anyone but `technicianId` (the reset arm: "no other live row is started"). */
export function otherStartedOnVisitOneSql(org: string, technicianId: string): SQL {
  return sql`EXISTS (SELECT 1 FROM appointment_assignments sa JOIN appointments sp ON sp.id = sa.appointment_id WHERE sp.service_request_id = "service_requests"."id" AND sp.organization_id = ${org}::uuid AND sa.organization_id = ${org}::uuid AND sp.appointment_number = 1 AND sa.technician_id <> ${technicianId}::uuid AND ${startedRowSql("sa")})`;
}

/** `technicianId` has a completed row on visit #1 of the correlated request: they never become its lead (TECHNICIAN_DONE). */
export function leadDoneSql(org: string, technicianId: string): SQL {
  return sql`EXISTS (SELECT 1 FROM appointment_assignments d JOIN appointments dp ON dp.id = d.appointment_id WHERE dp.service_request_id = "service_requests"."id" AND dp.organization_id = ${org}::uuid AND d.organization_id = ${org}::uuid AND dp.appointment_number = 1 AND d.technician_id = ${technicianId}::uuid AND d.status = 'completed'::request_status)`;
}

/** In-write twin of activeTechnicianIds: an active technician of the org. */
export function activeTechnicianSql(org: string, technicianId: string): SQL {
  return sql`EXISTS (SELECT 1 FROM users u WHERE u.id = ${technicianId}::uuid AND u.organization_id = ${org}::uuid AND u.role = 'technician' AND u.is_active)`;
}

/**
 * No checked technician has an open row on a live visit of ANOTHER open
 * request whose window overlaps [start, end) (half-open, as
 * checkScheduleConflict; lead ruling 5).
 */
export function noOverlapSql(
  org: string, rid: string, technicianIds: readonly string[], startIso: string, endIso: string, excludeRequestIds: readonly string[] = [],
): SQL {
  return sql`NOT EXISTS (SELECT 1 ${overlapFromWhereSql(org, rid, technicianIds, startIso, endIso, excludeRequestIds)})`;
}

/**
 * The FROM … WHERE shared by noOverlapSql (the in-write twin) and the move's
 * pre-read of the overlapping rows. `excludeRequestIds`: mass reschedule's
 * other candidates, which move in the same batch (plan v2, A MAJOR-1).
 */
export function overlapFromWhereSql(
  org: string, rid: string, technicianIds: readonly string[], startIso: string, endIso: string, excludeRequestIds: readonly string[] = [],
): SQL {
  const others = excludeRequestIds.length > 0 ? sql` AND cr.id <> ALL(${sql.param([...excludeRequestIds])}::uuid[])` : sql``;
  return sql`FROM appointment_assignments ca JOIN appointments cp ON cp.id = ca.appointment_id JOIN service_requests cr ON cr.id = cp.service_request_id
    WHERE ca.organization_id = ${org}::uuid AND cp.organization_id = ${org}::uuid AND cr.organization_id = ${org}::uuid
      AND ca.technician_id = ANY(${sql.param([...technicianIds])}::uuid[]) AND ca.status IN (${openRows()})
      AND cp.cancelled_at IS NULL AND cr.id <> ${rid}::uuid AND cr.status IN (${openRequests()})
      AND cp.arrival_window_start < ${endIso}::timestamptz AND cp.arrival_window_end > ${startIso}::timestamptz${others}`;
}

/**
 * Step 3: the new lead's row (a trigger insert, or an existing row the trigger
 * kept `cancelled`, 0050:134–145) starts clean: status = the request's status,
 * or `assigned` while the request is en route / on site / paused (someone
 * else's work); the four progress stamps nulled (spec §3.3 "revived rows start
 * clean"). The WHERE only matches a cancelled row or a started status with no
 * stamp, so a working helper promoted to lead keeps their progress.
 */
export function reviveLeadSql(org: string, rid: string, gate: SQL): SQL {
  return sql`UPDATE appointment_assignments a SET status = CASE WHEN r.status IN (${resetFromSql()}) THEN 'assigned'::request_status ELSE r.status END,
      en_route_at = NULL, arrived_at = NULL, started_at = NULL, completed_at = NULL
    FROM service_requests r, appointments p
    WHERE r.id = ${rid}::uuid AND r.organization_id = ${org}::uuid
      AND p.id = a.appointment_id AND p.service_request_id = r.id AND p.organization_id = ${org}::uuid AND p.appointment_number = 1
      AND a.organization_id = ${org}::uuid AND a.technician_id = r.assigned_to AND a.is_lead
      AND (a.status = 'cancelled'::request_status OR (a.status IN (${resetFromSql()}) AND NOT ${anyTimestampSql("a")}))
      AND (${gate})
    RETURNING a.id`;
}

/** Step 2: the trigger keeps a `completed` old lead as a helper (0050:125–133); M2 takes them off the crew too. */
export function cancelDoneOldLeadSql(org: string, rid: string, oldLeadId: string, gate: SQL): SQL {
  return sql`UPDATE appointment_assignments a SET status = 'cancelled'::request_status
    FROM appointments p
    WHERE p.id = a.appointment_id AND p.service_request_id = ${rid}::uuid AND p.organization_id = ${org}::uuid AND p.appointment_number = 1
      AND a.organization_id = ${org}::uuid AND a.technician_id = ${oldLeadId}::uuid AND NOT a.is_lead
      AND a.status = 'completed'::request_status AND (${gate})
    RETURNING a.id`;
}

/** Step 4: the old lead's open job time on visit #1 (or with no visit link) stops. */
export function closeOldLeadEntriesSql(org: string, rid: string, oldLeadId: string, gate: SQL): SQL {
  return closeJobEntriesSql({
    organizationId: org,
    requestId: rid,
    technicianIds: [oldLeadId],
    gate: sql`(${gate}) AND (t.appointment_id = ${visitOneIdSql(org, rid)} OR t.appointment_id IS NULL)`,
  });
}

/** No job time on visit #1 of the correlated request, nor any with no visit link (spec §5.4 WORK_LOGGED). */
export function noWorkLoggedSql(org: string): SQL {
  return sql`NOT EXISTS (SELECT 1 FROM technician_time_entries t WHERE t.organization_id = ${org}::uuid AND t.service_request_id = "service_requests"."id" AND t.kind = 'job' AND (t.appointment_id = (SELECT w1.id FROM appointments w1 WHERE w1.service_request_id = "service_requests"."id" AND w1.organization_id = ${org}::uuid AND w1.appointment_number = 1) OR t.appointment_id IS NULL))`;
}
```

`visitOneLiveSql` reuses `placedByVisitSql()` (`current-visit.ts:83`, the "displayed visit is not #1 or has ended" predicate the board already uses), so the move's "visit #1 is the displayed, live visit" guard can't drift from what the board shows.

- [ ] **Step 4: Rewrite `src/lib/admin/visit-one-guard.ts`** (whole file):

```ts
/**
 * Visit #1 guards for the admin writers that rewrite the request's schedule or
 * lead (assign, reassign, schedule, place, unschedule, move). The trigger
 * mirrors those columns onto visit #1, so once a technician has started it, or
 * a hold has ended it, the office must work through Move… or the Visits section.
 * Two rules (M2 spec §3.2): `visitOneGuardSql` (timestamps; the sheet's schedule
 * edit, unchanged) and `visitOneStartedGuardSql` (the started rule; assign,
 * reassign, place, unschedule). The SQL goes into each writer's guarded UPDATE
 * (atomic); the classifier is the re-read after a 0-row update.
 */
import { eq, sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { serviceRequests } from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
import { errorResponse } from "@/lib/api-response";
import { FIELDPULSE_SHEET_STARTED, SHEET_STARTED_NATIVE, UNSCHEDULE_COPY } from "./dispatch-copy";
import type { RequestStatus } from "./request-status";
import { leadDoneSql, startedOnVisitOneSql } from "./visit-move-sql";

export type VisitOneRefusal = "has_progress" | "visit_ended";
export type VisitOneRule = "timestamp" | "started";

// Literal qualified names, not column objects: Drizzle renders a column in a
// select list unqualified ("id"), which inside these subqueries would be
// ambiguous or bind to the inner table.

const progressed = () => sql<boolean>`EXISTS (SELECT 1 FROM appointment_assignments a JOIN appointments p ON p.id = a.appointment_id WHERE p.service_request_id = "service_requests"."id" AND p.appointment_number = 1 AND (a.en_route_at IS NOT NULL OR a.arrived_at IS NOT NULL OR a.started_at IS NOT NULL OR a.completed_at IS NOT NULL))`;

const ended = () => sql<boolean>`EXISTS (SELECT 1 FROM appointments p WHERE p.service_request_id = "service_requests"."id" AND p.appointment_number = 1 AND p.cancelled_at IS NOT NULL)`;

/**
 * Run a guarded service_requests UPDATE after locking the request row, in one
 * batch, followed by `after` statements (e.g. reviveLeadSql, gated on the
 * request's xmin). Under READ COMMITTED a lone UPDATE that waits on the row lock
 * re-checks only the target row; its NOT EXISTS subqueries keep the snapshot
 * taken before the wait. Locking first gives the UPDATE a fresh snapshot.
 */
export async function lockedUpdate<T>(organizationId: string, requestId: string, update: T, after: readonly SQL[] = []): Promise<Awaited<T>> {
  const lock = db.execute(sql`SELECT 1 FROM service_requests WHERE id = ${requestId}::uuid AND organization_id = ${organizationId}::uuid FOR NO KEY UPDATE`);
  const results = (await db.batch([lock, update, ...after.map((q) => db.execute(q))] as never)) as unknown as readonly unknown[];
  return results[1] as Awaited<T>;
}

/** Timestamp rule (unchanged): no progress stamp on visit #1, and #1 not ended. Parenthesised: it contains OR. */
export function visitOneGuardSql(): SQL {
  return sql`(NOT ${progressed()} AND ("service_requests"."status" = 'cancelled'::request_status OR NOT ${ended()}))`;
}

/** Started rule (M2 §3.2): no started live row on visit #1, and #1 not ended. */
export function visitOneStartedGuardSql(organizationId: string): SQL {
  return sql`(NOT ${startedOnVisitOneSql(organizationId, "any")} AND ("service_requests"."status" = 'cancelled'::request_status OR NOT ${ended()}))`;
}

/**
 * Re-read after a 0-row update: the request's status, which visit #1 guard
 * (if any) refuses it under `rule`, whether FieldPulse owns it, and whether
 * `technicianId` is done on visit #1.
 */
export async function classifyVisitOne(
  organizationId: string,
  requestId: string,
  rule: VisitOneRule = "timestamp",
  technicianId?: string,
): Promise<{ status: RequestStatus; refusal: VisitOneRefusal | null; fieldpulse: boolean; technicianDone: boolean } | null> {
  const [row] = await db
    .select({
      status: serviceRequests.status,
      progressed: rule === "started" ? sql<boolean>`${startedOnVisitOneSql(organizationId, "any")}` : progressed(),
      ended: ended(),
      fieldpulse: sql<boolean>`("service_requests"."fieldpulse_job_id" IS NOT NULL)`,
      technicianDone: technicianId ? sql<boolean>`${leadDoneSql(organizationId, technicianId)}` : sql<boolean>`false`,
    })
    .from(serviceRequests)
    .where(withTenant(serviceRequests, organizationId, eq(serviceRequests.id, requestId)));
  if (!row) return null;
  const refusal: VisitOneRefusal | null = row.progressed
    ? "has_progress"
    : row.ended && row.status !== "cancelled" ? "visit_ended" : null;
  return { status: row.status, refusal, fieldpulse: row.fieldpulse === true, technicianDone: row.technicianDone === true };
}

/** True when the request is FieldPulse-mapped (for refusal copy on paths whose writer doesn't report it). */
export async function isFieldpulseMapped(organizationId: string, requestId: string): Promise<boolean> {
  const [row] = await db
    .select({ fp: serviceRequests.fieldpulseJobId })
    .from(serviceRequests)
    .where(withTenant(serviceRequests, organizationId, eq(serviceRequests.id, requestId)));
  return Boolean(row?.fp);
}

/** 409 for a visit #1 refusal. FieldPulse first (spec §5.5): a FieldPulse request's refusal names FieldPulse. */
export function visitOneRefusalResponse(
  reason: VisitOneRefusal,
  opts: { readonly fieldpulse?: boolean; readonly surface?: "sheet" | "unschedule" } = {},
) {
  if (reason === "visit_ended") {
    return errorResponse("This visit has ended. Add a new visit instead.", "VISIT_ENDED", 409);
  }
  const message = opts.fieldpulse
    ? FIELDPULSE_SHEET_STARTED
    : opts.surface === "unschedule" ? UNSCHEDULE_COPY.HAS_PROGRESS : SHEET_STARTED_NATIVE;
  return errorResponse(message, "HAS_PROGRESS", 409);
}
```

- [ ] **Step 5: Run the two test files**

Run: `npx vitest run src/lib/admin/visit-move-sql.test.ts src/lib/admin/visit-one-guard.test.ts`
Expected: PASS.

- [ ] **Step 6: Failing writer tests.** In `src/lib/admin/queries.test.ts`, replace the visit-one-guard mock

```ts
vi.mock('./visit-one-guard', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./visit-one-guard')>()),
  visitOneGuardSql: () => 'VISIT_ONE_GUARD',
}));
```

with

```ts
vi.mock('./visit-one-guard', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./visit-one-guard')>()),
  visitOneGuardSql: () => 'VISIT_ONE_GUARD',
  visitOneStartedGuardSql: () => 'VISIT_ONE_STARTED_GUARD',
}));
// The shared move SQL uses sql.raw, which this file's drizzle mock lacks: markers instead.
vi.mock('./visit-move-sql', () => ({
  reviveLeadSql: () => 'REVIVE_LEAD',
  requestXminGateSql: () => 'XMIN_GATE',
  leadDoneSql: (_org: string, tech: string) => `LEAD_DONE:${tech}`,
  startedOnVisitOneSql: () => 'STARTED_ON_V1',
}));
```

and append these cases inside `describe('assignTechnician', …)`:

```ts
  it('guards on FieldPulse, the started rule and the new lead not being done; revives the lead row in the same batch', async () => {
    const { and, isNull, sql: sqlTag } = await import('drizzle-orm');
    vi.mocked(and).mockClear();
    vi.mocked(isNull).mockClear();
    vi.mocked(sqlTag).mockClear();
    batchCallArgs = [];
    selectResolutions = [[{ id: 'tech-1', name: 'John Tech' }], [{ status: 'pending', arrivalWindowStart: null, arrivalWindowEnd: null }]];
    updateResolution = [{ id: 'req-1', status: 'assigned', issueType: 'x', urgency: 'low', description: 'd', referenceNumber: 'HVAC-1', customerNameEncrypted: null, createdAt: new Date(), updatedAt: new Date() }];
    await assignTechnician(ORG_ID, 'req-1', 'tech-1');
    expect(vi.mocked(isNull).mock.calls.some((c) => (c[0] as unknown) === 'sr.fieldpulseJobId')).toBe(true);
    expect(JSON.stringify(vi.mocked(and).mock.calls)).toContain('VISIT_ONE_STARTED_GUARD');
    expect(JSON.stringify(vi.mocked(sqlTag).mock.calls)).toContain('LEAD_DONE:tech-1');
    const statements = batchCallArgs.at(-1)!;
    expect(statements).toHaveLength(3);
    expect((statements[2] as { __lock: unknown }).__lock).toBe('REVIVE_LEAD');
  });

  it('a FieldPulse-mapped request → managed_externally (checked first)', async () => {
    selectResolutions = [
      [{ id: 'tech-1', name: 'John Tech' }],
      [{ status: 'scheduled', arrivalWindowStart: null, arrivalWindowEnd: null }],
      [{ status: 'scheduled', progressed: true, ended: false, fieldpulse: true, technicianDone: false }],
    ];
    updateResolution = [];
    expect(await assignTechnician(ORG_ID, 'req-1', 'tech-1')).toEqual({ ok: false, reason: 'managed_externally' });
  });

  it('FieldPulse is answered before time off (spec §5.5)', async () => {
    selectResolutions = [
      [{ id: 'tech-1', name: 'John Tech' }],
      [{ status: 'scheduled', arrivalWindowStart: new Date('2026-07-01T12:00:00.000Z'), arrivalWindowEnd: new Date('2026-07-01T16:00:00.000Z'), fieldpulseJobId: 'fp-1' }],
    ];
    timeOffMock.mockResolvedValueOnce([TIME_OFF_SHIFT]);
    expect(await assignTechnician(ORG_ID, 'req-1', 'tech-1')).toEqual({ ok: false, reason: 'managed_externally' });
    timeOffMock.mockReset();
    timeOffMock.mockResolvedValue([]);
  });

  it('a technician done on visit #1 → technician_done', async () => {
    selectResolutions = [
      [{ id: 'tech-1', name: 'John Tech' }],
      [{ status: 'scheduled', arrivalWindowStart: null, arrivalWindowEnd: null }],
      [{ status: 'scheduled', progressed: false, ended: false, fieldpulse: false, technicianDone: true }],
    ];
    updateResolution = [];
    expect(await assignTechnician(ORG_ID, 'req-1', 'tech-1')).toEqual({ ok: false, reason: 'technician_done' });
  });
```

and inside `describe('reassignTechnician', …)`:

```ts
  it('reassign carries the same guards and the revive', async () => {
    const { and, isNull } = await import('drizzle-orm');
    vi.mocked(and).mockClear();
    vi.mocked(isNull).mockClear();
    batchCallArgs = [];
    selectResolutions = [[{ id: 'tech-2', name: 'Jane Tech' }], [{ arrivalWindowStart: null, arrivalWindowEnd: null }]];
    updateResolution = [{ id: 'req-1', status: 'scheduled', issueType: 'x', urgency: 'low', description: 'd', referenceNumber: 'HVAC-1', customerNameEncrypted: null, createdAt: new Date(), updatedAt: new Date() }];
    await reassignTechnician(ORG_ID, 'req-1', 'tech-2');
    expect(vi.mocked(isNull).mock.calls.some((c) => (c[0] as unknown) === 'sr.fieldpulseJobId')).toBe(true);
    expect(JSON.stringify(vi.mocked(and).mock.calls)).toContain('VISIT_ONE_STARTED_GUARD');
    expect((batchCallArgs.at(-1)![2] as { __lock: unknown }).__lock).toBe('REVIVE_LEAD');
  });

  it('reassign: FieldPulse → managed_externally; done → technician_done; started → has_progress', async () => {
    for (const [row, reason] of [
      [{ status: 'scheduled', progressed: false, ended: false, fieldpulse: true, technicianDone: false }, 'managed_externally'],
      [{ status: 'scheduled', progressed: false, ended: false, fieldpulse: false, technicianDone: true }, 'technician_done'],
      [{ status: 'scheduled', progressed: true, ended: false, fieldpulse: false, technicianDone: false }, 'has_progress'],
    ] as const) {
      selectCallIndex = 0;
      selectResolutions = [[{ id: 'tech-2', name: 'Jane Tech' }], [{ arrivalWindowStart: null, arrivalWindowEnd: null }], [row]];
      updateResolution = [];
      expect(await reassignTechnician(ORG_ID, 'req-1', 'tech-2')).toEqual({ ok: false, reason });
    }
  });
```

(`batchCallArgs` is the file's existing `let` — assignable from the tests.)

In the same file's `describe('visit-#1 guarded writers lock the request first', …)`, the assign/reassign loop now expects three statements and the started guard; replace

```ts
      expect(batchCallArgs[0]).toHaveLength(2);
      expect(lockText(batchCallArgs[0]![0])).toMatch(/SELECT 1 FROM service_requests WHERE id = \?::uuid AND organization_id = \?::uuid FOR NO KEY UPDATE/);
      expect(guardInWhere()).toBe(true);
    });
  }
```

with

```ts
      expect(batchCallArgs[0]).toHaveLength(3); // M2: + reviveLeadSql
      expect(lockText(batchCallArgs[0]![0])).toMatch(/SELECT 1 FROM service_requests WHERE id = \?::uuid AND organization_id = \?::uuid FOR NO KEY UPDATE/);
      expect(vi.mocked(and).mock.calls.some((c) => (c as unknown[]).includes('VISIT_ONE_STARTED_GUARD'))).toBe(true);
    });
  }
```

(the `scheduleRequest` case below it keeps 2 statements and `VISIT_ONE_GUARD`: the schedule edit is unchanged). In `src/lib/admin/scheduling-queries.test.ts`, replace the visit-one-guard mock block with

```ts
// Markers for the visit-#1 guards so tests can find them in the guarded WHERE.
vi.mock("./visit-one-guard", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./visit-one-guard")>()),
  visitOneGuardSql: () => "VISIT_ONE_GUARD",
  visitOneStartedGuardSql: () => "VISIT_ONE_STARTED_GUARD",
}));
vi.mock("./visit-move-sql", () => ({
  reviveLeadSql: () => "REVIVE_LEAD",
  requestXminGateSql: () => "XMIN_GATE",
  leadDoneSql: () => "LEAD_DONE",
  startedOnVisitOneSql: () => "STARTED_ON_V1",
  versionGateSql: () => "VERSION_GATE",
  noWorkLoggedSql: () => "NO_WORK_LOGGED",
  fieldpulseFreeSql: () => "FIELDPULSE_FREE",
}));
```

and replace the `isLockThenUpdate` helper and the `placeAndAssignRequest` case of `describe("visit-#1 guarded writers lock the request first", …)` with

```ts
  const isLockThenUpdate = (count: number, marker: string) => {
    expect(batchMock).toHaveBeenCalledTimes(1);
    const statements = batchMock.mock.calls[0]![0] as unknown[];
    expect(statements).toHaveLength(count);
    expect(statements[0]).toHaveProperty("__lock");
    expect(JSON.stringify(whereCalls)).toContain(marker);
  };

  it("placeAndAssignRequest: [lock, guarded update (started rule), revive]", async () => {
    selectQueue.push([{ status: "scheduled", assignedTo: null }]);
    updateQueue.push([{ status: "scheduled", assignedTo: null, scheduledDate: new Date(), arrivalWindowStart: new Date(), arrivalWindowEnd: new Date() }]);
    const window = { start: new Date("2026-07-01T12:00:00.000Z"), end: new Date("2026-07-01T16:00:00.000Z") };
    const result = await placeAndAssignRequest(ORG, REQ, window, { isoDay: "2026-07-01", window: "morning" });
    expect(result.ok).toBe(true);
    isLockThenUpdate(3, "VISIT_ONE_STARTED_GUARD");
    const statements = batchMock.mock.calls[0]![0] as unknown[];
    expect((statements[2] as { __lock: unknown }).__lock).toBe("REVIVE_LEAD");
  });
```

and change the `unscheduleRequest` case's helper call from `isLockThenUpdate();` to `isLockThenUpdate(2, "VISIT_ONE_GUARD");` (Task 4 rewrites that case).

In `src/app/api/admin/requests/[id]/assign/route.test.ts`, append:

```ts
describe("assign route — M2 refusals", () => {
  it.each([
    ["POST", POST, assignTechnician],
    ["PATCH", PATCH, reassignTechnician],
  ] as const)("%s maps managed_externally and technician_done; HAS_PROGRESS points to Move…", async (method, fn, writer) => {
    (writer as unknown as Mock).mockResolvedValue({ ok: false, reason: "managed_externally" });
    let body = await (await call(fn, method)).json();
    expect(body.error).toEqual({ code: "MANAGED_EXTERNALLY", message: "Change the technician for this request in FieldPulse." });
    (writer as unknown as Mock).mockResolvedValue({ ok: false, reason: "technician_done" });
    const res = await call(fn, method);
    expect(res.status).toBe(409);
    body = await res.json();
    expect(body.error).toEqual({ code: "TECHNICIAN_DONE", message: "That technician has finished on this visit.", details: { technicianId: TECH } });
    (writer as unknown as Mock).mockResolvedValue({ ok: false, reason: "has_progress" });
    body = await (await call(fn, method)).json();
    expect(body.error.message).toBe("A technician has started this visit. To move it anyway, use Move… on the calendar.");
    expect(logAudit).not.toHaveBeenCalled();
  });
});
```

Run: `npx vitest run src/lib/admin/queries.test.ts src/lib/admin/scheduling-queries.test.ts "src/app/api/admin/requests/[id]/assign/route.test.ts"`
Expected: FAIL — the new cases (no FieldPulse predicate, 2 statements, no `managed_externally` mapping).

- [ ] **Step 7: The sheet writers.** In `src/lib/admin/queries.ts` replace the import line

```ts
import { classifyVisitOne, lockedUpdate, visitOneGuardSql, type VisitOneRefusal } from "./visit-one-guard";
```

with

```ts
import { classifyVisitOne, lockedUpdate, visitOneGuardSql, visitOneStartedGuardSql, type VisitOneRefusal } from "./visit-one-guard";
import { leadDoneSql, requestXminGateSql, reviveLeadSql } from "./visit-move-sql";
```

In `AssignTechnicianResult` replace

```ts
  | { readonly ok: false; readonly reason: "time_off" }
  | { readonly ok: false; readonly reason: VisitOneRefusal };

/** True when the technician has a capacity-removing shift overlapping the
```

with

```ts
  | { readonly ok: false; readonly reason: "time_off" }
  | { readonly ok: false; readonly reason: "managed_externally" }
  | { readonly ok: false; readonly reason: "technician_done" }
  | { readonly ok: false; readonly reason: VisitOneRefusal };

/** True when the technician has a capacity-removing shift overlapping the
```

FieldPulse first (spec §5.5, plan v2 critic A m7): a FieldPulse request is refused before the time-off pre-check could answer `time_off`. In `assignTechnician`, replace

```ts
  const [before] = await db
    .select({
      status: serviceRequests.status,
      arrivalWindowStart: serviceRequests.arrivalWindowStart,
      arrivalWindowEnd: serviceRequests.arrivalWindowEnd,
    })
    .from(serviceRequests)
    .where(
      withTenant(serviceRequests, organizationId, eq(serviceRequests.id, requestId)),
    );

  if (
```

with

```ts
  const [before] = await db
    .select({
      status: serviceRequests.status,
      arrivalWindowStart: serviceRequests.arrivalWindowStart,
      arrivalWindowEnd: serviceRequests.arrivalWindowEnd,
      fieldpulseJobId: serviceRequests.fieldpulseJobId,
    })
    .from(serviceRequests)
    .where(
      withTenant(serviceRequests, organizationId, eq(serviceRequests.id, requestId)),
    );
  if (before?.fieldpulseJobId) return { ok: false, reason: "managed_externally" };

  if (
```

and in `reassignTechnician` replace

```ts
  const [windowed] = await db
    .select({
      arrivalWindowStart: serviceRequests.arrivalWindowStart,
      arrivalWindowEnd: serviceRequests.arrivalWindowEnd,
    })
    .from(serviceRequests)
    .where(
      withTenant(serviceRequests, organizationId, eq(serviceRequests.id, requestId)),
    );
  if (
```

with

```ts
  const [windowed] = await db
    .select({
      arrivalWindowStart: serviceRequests.arrivalWindowStart,
      arrivalWindowEnd: serviceRequests.arrivalWindowEnd,
      fieldpulseJobId: serviceRequests.fieldpulseJobId,
    })
    .from(serviceRequests)
    .where(
      withTenant(serviceRequests, organizationId, eq(serviceRequests.id, requestId)),
    );
  if (windowed?.fieldpulseJobId) return { ok: false, reason: "managed_externally" };
  if (
```

(The SQL predicate stays the race-proof refusal; this pre-check only orders the answer.)

In `assignTechnician`, replace from `  const [updated] = await lockedUpdate(organizationId, requestId, db` through the closing `}` of the `if (!updated) { … }` block (the code that ends with `reason: "request_not_assignable",\n      currentStatus,\n    };\n  }`) with

```ts
  const [updated] = await lockedUpdate(organizationId, requestId, db
    .update(serviceRequests)
    .set({
      assignedTo: technicianId,
      status: "assigned",
      updatedAt: now,
    })
    .where(
      withTenant(
        serviceRequests,
        organizationId,
        and(
          eq(serviceRequests.id, requestId),
          inArray(serviceRequests.status, [...ASSIGNABLE_STATUSES]),
          // FieldPulse owns a mapped request's technician (M2 §5.1).
          isNull(serviceRequests.fieldpulseJobId),
          // Visit #1 mirrors the lead: never rewrite a started or ended visit (M2 §3.2).
          visitOneStartedGuardSql(organizationId),
          // A technician who finished on visit #1 never becomes its lead (TECHNICIAN_DONE).
          sql`NOT ${leadDoneSql(organizationId, technicianId)}`,
        )!,
      ),
    )
    .returning(),
    // The new lead's row starts clean, never a cancelled leftover (M2 §5.5).
    [reviveLeadSql(organizationId, requestId, requestXminGateSql(organizationId, requestId))]);

  if (!updated) {
    if (!before) {
      return { ok: false, reason: "request_not_found" };
    }
    const now = await classifyVisitOne(organizationId, requestId, "started", technicianId);
    if (now?.fieldpulse) return { ok: false, reason: "managed_externally" };
    const currentStatus = now?.status ?? before.status;
    if ((ASSIGNABLE_STATUSES as readonly string[]).includes(currentStatus)) {
      if (now?.technicianDone) return { ok: false, reason: "technician_done" };
      if (now?.refusal) return { ok: false, reason: now.refusal };
    }
    return {
      ok: false,
      reason: "request_not_assignable",
      currentStatus,
    };
  }
```

In `ReassignTechnicianResult` add the same two members before `| { readonly ok: false; readonly reason: VisitOneRefusal };` (the second occurrence, in the reassign type). In `reassignTechnician`, replace from `  const [updated] = await lockedUpdate(organizationId, requestId, db` through the end of its `if (!updated) { … }` block with

```ts
  const [updated] = await lockedUpdate(organizationId, requestId, db
    .update(serviceRequests)
    .set({
      assignedTo: technicianId,
      updatedAt: new Date(),
    })
    .where(
      withTenant(
        serviceRequests,
        organizationId,
        and(
          eq(serviceRequests.id, requestId),
          inArray(serviceRequests.status, [...REASSIGNABLE_STATUSES]),
          isNull(serviceRequests.fieldpulseJobId),
          visitOneStartedGuardSql(organizationId),
          sql`NOT ${leadDoneSql(organizationId, technicianId)}`,
        )!,
      ),
    )
    .returning(),
    [reviveLeadSql(organizationId, requestId, requestXminGateSql(organizationId, requestId))]);

  if (!updated) {
    const existing = await classifyVisitOne(organizationId, requestId, "started", technicianId);

    if (!existing) {
      return { ok: false, reason: "request_not_found" };
    }
    if (existing.fieldpulse) return { ok: false, reason: "managed_externally" };
    // CAS miss first: a status that is no longer reassignable wins.
    if ((REASSIGNABLE_STATUSES as readonly string[]).includes(existing.status)) {
      if (existing.technicianDone) return { ok: false, reason: "technician_done" };
      if (existing.refusal) return { ok: false, reason: existing.refusal };
    }
    return {
      ok: false,
      reason: "request_not_reassignable",
      currentStatus: existing.status,
    };
  }
```

Both functions keep `scheduleRequest`'s `visitOneGuardSql()` untouched (spec §3.2).

In `src/lib/admin/scheduling-queries.ts`, replace the import

```ts
import { classifyVisitOne, lockedUpdate, visitOneGuardSql, type VisitOneRefusal } from "./visit-one-guard";
```

with

```ts
import { classifyVisitOne, lockedUpdate, visitOneGuardSql, visitOneStartedGuardSql, type VisitOneRefusal } from "./visit-one-guard";
import { requestXminGateSql, reviveLeadSql } from "./visit-move-sql";
```

In `placeAndAssignRequest`, replace

```ts
          // Visit #1 mirrors the window/lead: never rewrite a started or ended visit.
          visitOneGuardSql(),
        )!,
      ),
    )
    .returning({
      status: serviceRequests.status,
      assignedTo: serviceRequests.assignedTo,
      scheduledDate: serviceRequests.scheduledDate,
      arrivalWindowStart: serviceRequests.arrivalWindowStart,
      arrivalWindowEnd: serviceRequests.arrivalWindowEnd,
    }));
```

with

```ts
          // Visit #1 mirrors the window/lead: never rewrite a started or ended visit (M2 §3.2).
          visitOneStartedGuardSql(organizationId),
        )!,
      ),
    )
    .returning({
      status: serviceRequests.status,
      assignedTo: serviceRequests.assignedTo,
      scheduledDate: serviceRequests.scheduledDate,
      arrivalWindowStart: serviceRequests.arrivalWindowStart,
      arrivalWindowEnd: serviceRequests.arrivalWindowEnd,
    }),
    // Autopilot and office booking: a lead row starts clean (M2 §5.5).
    [reviveLeadSql(organizationId, requestId, requestXminGateSql(organizationId, requestId))]);
```

and in the same function replace `    const now = await classifyVisitOne(organizationId, requestId);\n    if (now?.refusal && now.status === currentStatus) {` with `    const now = await classifyVisitOne(organizationId, requestId, "started");\n    if (now?.refusal && now.status === currentStatus) {` (the first of the two `classifyVisitOne(organizationId, requestId)` calls in the file; the second, in `unscheduleRequest`, is Task 4's).

- [ ] **Step 8: The routes.** In `src/app/api/admin/requests/[id]/assign/route.ts`, in BOTH handlers' `switch (result.reason)`, replace

```ts
        case "has_progress":
        case "visit_ended":
          return visitOneRefusalResponse(result.reason);
```

with

```ts
        case "managed_externally":
          return errorResponse("Change the technician for this request in FieldPulse.", "MANAGED_EXTERNALLY", 409);
        case "technician_done":
          return errorResponse("That technician has finished on this visit.", "TECHNICIAN_DONE", 409, { technicianId });
        case "has_progress":
        case "visit_ended":
          return visitOneRefusalResponse(result.reason, { surface: "sheet" });
```

In `src/app/api/admin/requests/[id]/route.ts`, replace the import

```ts
import { visitOneRefusalResponse } from "@/lib/admin/visit-one-guard";
```

with

```ts
import { isFieldpulseMapped, visitOneRefusalResponse } from "@/lib/admin/visit-one-guard";
```

and, in the schedule branch (after `scheduleRequest(…)`), replace

```ts
        if (result.reason === "request_not_found") {
          return errorResponse("Request not found", "NOT_FOUND", 404);
        }
        return visitOneRefusalResponse(result.reason);
```

with

```ts
        if (result.reason === "request_not_found") {
          return errorResponse("Request not found", "NOT_FOUND", 404);
        }
        // The writer is unchanged (M2 §3.2); only the copy names FieldPulse for a mapped request.
        return visitOneRefusalResponse(result.reason, {
          fieldpulse: await isFieldpulseMapped(session.organizationId, id),
        });
```

In `src/app/api/admin/requests/[id]/route.test.ts` (it doesn't mock the guard module, and `isFieldpulseMapped` would reach the db), add right before its first `import {` line:

```ts
vi.mock("@/lib/admin/visit-one-guard", async (orig) => ({
  ...(await orig<typeof import("@/lib/admin/visit-one-guard")>()),
  isFieldpulseMapped: vi.fn(async () => false),
}));
```

and in its `"PATCH /api/admin/requests/[id] — schedule branch"` table change `["has_progress", "HAS_PROGRESS", "A technician has already started this visit."],` to `["has_progress", "HAS_PROGRESS", "A technician has started this visit. To move it anyway, use Move… on the calendar."],`. In `src/app/api/admin/requests/[id]/reschedule/route.test.ts` (deleted in Task 8; it must stay green until then), change the expectation `message: "A technician has already started this visit."` (line 136) to `message: "A technician has started this visit. To move it anyway, use Move… on the calendar."` — the old route calls `visitOneRefusalResponse(result.reason)` and now gets the sheet copy. The other two places that say "A technician has already started this visit." (`appointments/[aid]/route.ts:82`, the sheet's `VISIT_ERROR_COPY`) are not this response and stay until Task 10 changes the sheet copy.

- [ ] **Step 9: Run the tests to verify they pass**

Run: `npx vitest run src/lib/admin/visit-move-sql.test.ts src/lib/admin/visit-one-guard.test.ts src/lib/admin/queries.test.ts src/lib/admin/scheduling-queries.test.ts "src/app/api/admin/requests/[id]/assign/route.test.ts" "src/app/api/admin/requests/[id]/route.test.ts" "src/app/api/admin/requests/[id]/reschedule/route.test.ts"`
Expected: PASS.

- [ ] **Step 10: Gates and commit**

```bash
npx tsc --noEmit && npx eslint src/lib/admin/visit-move-sql.ts src/lib/admin/visit-move-sql.test.ts src/lib/admin/visit-one-guard.ts src/lib/admin/visit-one-guard.test.ts src/lib/admin/queries.ts src/lib/admin/queries.test.ts src/lib/admin/scheduling-queries.ts src/lib/admin/scheduling-queries.test.ts "src/app/api/admin/requests/[id]/assign/route.ts" "src/app/api/admin/requests/[id]/assign/route.test.ts" "src/app/api/admin/requests/[id]/route.ts" && npx vitest run
git add src/lib/admin/visit-move-sql.ts src/lib/admin/visit-move-sql.test.ts src/lib/admin/visit-one-guard.ts src/lib/admin/visit-one-guard.test.ts src/lib/admin/queries.ts src/lib/admin/queries.test.ts src/lib/admin/scheduling-queries.ts src/lib/admin/scheduling-queries.test.ts "src/app/api/admin/requests/[id]/assign/route.ts" "src/app/api/admin/requests/[id]/assign/route.test.ts" "src/app/api/admin/requests/[id]/route.ts" "src/app/api/admin/requests/[id]/route.test.ts" "src/app/api/admin/requests/[id]/reschedule/route.test.ts"
git commit -m "$(cat <<'EOF'
feat(m2): started guard, lead revive and FieldPulse refusal on the sheet writers

Shared move SQL builders (version gate, started arm, revive, overlap, work
logged) with org bound on every table; assign, reassign and
placeAndAssignRequest use the started rule, refuse a done technician and a
FieldPulse-mapped request, and revive the new lead's row clean in the same
batch. The schedule edit is unchanged apart from naming FieldPulse.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01GuWoF63tQU1i7ELqyYU3A6
EOF
)"
```

---
### Task 4: Helper writers and drag-to-Unscheduled

**Files:**
- Modify: `src/lib/admin/assignment-queries.ts` (`addVisitTechnician`, `classifyAddMiss`, `removeVisitTechnician`), `src/lib/admin/assignment-queries.test.ts`, `src/lib/admin/appointment-queries.ts` (`loadAppointments` adds `started` / `hasProgress`), `src/app/api/admin/requests/[id]/appointments/[aid]/assignments/route.ts` (NO_LEAD, VISIT_FULL), `src/app/api/admin/requests/[id]/appointments/[aid]/assignments/[tid]/route.ts` (`cancelled` in the 200), `src/lib/admin/scheduling-queries.ts` (`unscheduleRequest`, import), `src/lib/admin/scheduling-queries.test.ts` (the unschedule cases), `src/app/api/admin/requests/[id]/unschedule/route.ts`, `src/app/api/admin/requests/[id]/unschedule/route.test.ts`

**Interfaces:**
- Consumes (Task 1): `rowStarted`, `startedRowSql`, `anyTimestampSql`; (Task 2): `FIELDPULSE_BOARD`, `STALE_LINE`, `UNSCHEDULE_COPY`; (Task 3): `versionGateSql`, `noWorkLoggedSql`, `fieldpulseFreeSql`, `startedOnVisitOneSql`, `visitOneStartedGuardSql`, `classifyVisitOne`, `lockedUpdate`, `visitOneRefusalResponse`. Existing: `MAX_TECHNICIANS_PER_VISIT` (`appointment-types.ts:30`), `noTimeOffForVisit`.
- Produces:
  - `addVisitTechnician(org, rid, aid, tid, actor)` → `AppointmentRecord | { reason: … | "no_lead" | "visit_full" }`; request lock `FOR NO KEY UPDATE`; a cancelled non-lead row is revived clean; the visit's `version` bumps in the same statement when a row was written.
  - `removeVisitTechnician(org, rid, aid, tid)` → `{ ok: true; cancelled: boolean } | { reason: … }`; untouched → DELETE; timestamped but not started → `cancelled`; started → `has_progress`; version bump in the same statement.
  - `AppointmentAssignmentRecord.started` / `hasProgress` filled by `listAppointments` / `getAppointment`.
  - `unscheduleRequest(org, rid, gate: { visitId: string | null; expectedVersion: number | null })` (contract shape); `POST …/unschedule` body `{ visitId, expectedVersion }` → 409 `MANAGED_EXTERNALLY` / `STALE` / `HAS_PROGRESS` / `VISIT_ENDED` / `WORK_LOGGED`.

- [ ] **Step 1: Write the failing tests.** In `src/lib/admin/assignment-queries.test.ts`, replace the test `"runs ONE batch (lock then guarded insert) and returns the refreshed visit"` and `"wraps the open-assignment OR group in parentheses"` with:

```ts
  it("runs ONE batch: request lock FOR NO KEY UPDATE, then one statement (insert-or-revive + version bump)", async () => {
    const after = visit({ assignments: [] });
    m.getAppointment.mockResolvedValueOnce(visit()).mockResolvedValueOnce(after);
    m.batch.mockResolvedValueOnce([{ rows: [] }, { rows: [{ id: "row" }] }]);
    expect(await addVisitTechnician(ORG, RID, AID, TID, ACTOR)).toBe(after);
    expect(m.batch).toHaveBeenCalledTimes(1);
    expect(m.batch.mock.calls[0][0]).toHaveLength(2);
    const [lock, write] = m.executed.map((q) => new PgDialect().sqlToQuery(q as SQL).sql.replace(/\s+/g, " "));
    expect(lock).toBe("SELECT 1 FROM service_requests WHERE id = $1::uuid AND organization_id = $2::uuid FOR NO KEY UPDATE");
    expect(write).toContain("'assigned'::request_status");
    expect(write).toContain("cancelled_at IS NULL");
  });

  it("revives a cancelled non-lead row clean instead of DO NOTHING", async () => {
    m.getAppointment.mockResolvedValueOnce(visit()).mockResolvedValueOnce(visit());
    m.batch.mockResolvedValueOnce([{ rows: [] }, { rows: [{ id: "row" }] }]);
    await addVisitTechnician(ORG, RID, AID, TID, ACTOR);
    const write = new PgDialect().sqlToQuery(m.executed[1] as SQL).sql.replace(/\s+/g, " ");
    expect(write).toContain("ON CONFLICT (appointment_id, technician_id) DO UPDATE SET status = 'assigned'::request_status, assigned_by = EXCLUDED.assigned_by, assigned_at = now(), en_route_at = NULL, arrived_at = NULL, started_at = NULL, completed_at = NULL WHERE appointment_assignments.status = 'cancelled'::request_status AND NOT appointment_assignments.is_lead RETURNING id");
  });

  it("requires a live lead and an open row; enforces the five-technician cap in SQL; all org-bound", async () => {
    m.getAppointment.mockResolvedValueOnce(visit()).mockResolvedValueOnce(visit());
    m.batch.mockResolvedValueOnce([{ rows: [] }, { rows: [{ id: "row" }] }]);
    await addVisitTechnician(ORG, RID, AID, TID, ACTOR);
    const { sql: text, params } = new PgDialect().sqlToQuery(m.executed[1] as SQL);
    const t = text.replace(/\s+/g, " ");
    expect(t).toMatch(/AND EXISTS \(SELECT 1 FROM appointment_assignments x WHERE x\.appointment_id = \$\d+::uuid AND x\.organization_id = \$\d+::uuid AND x\.status IN \([^)]*\)\)/);
    expect(t).toMatch(/AND EXISTS \(SELECT 1 FROM appointment_assignments l WHERE l\.appointment_id = \$\d+::uuid AND l\.organization_id = \$\d+::uuid AND l\.is_lead AND l\.status <> 'cancelled'::request_status\)/);
    expect(t).toMatch(/AND \(SELECT count\(\*\) FROM appointment_assignments c WHERE c\.appointment_id = \$\d+::uuid AND c\.organization_id = \$\d+::uuid AND c\.status <> 'cancelled'::request_status AND c\.technician_id <> \$\d+::uuid\) < \$\d+::int/);
    expect(params).toContain(5);
    expect(params.filter((p) => p === ORG).length).toBeGreaterThanOrEqual(6);
  });

  it("bumps the visit's version in the same statement, only when a row was written", async () => {
    m.getAppointment.mockResolvedValueOnce(visit()).mockResolvedValueOnce(visit());
    m.batch.mockResolvedValueOnce([{ rows: [] }, { rows: [{ id: "row" }] }]);
    await addVisitTechnician(ORG, RID, AID, TID, ACTOR);
    const t = new PgDialect().sqlToQuery(m.executed[1] as SQL).sql.replace(/\s+/g, " ");
    expect(t).toMatch(/^WITH ins AS \(INSERT INTO appointment_assignments/);
    expect(t).toContain("bump AS (UPDATE appointments SET version = version + 1, updated_at = now() WHERE id = $");
    expect(t).toContain("AND EXISTS (SELECT 1 FROM ins) RETURNING id) SELECT id FROM ins");
  });
```

In the same file's `describe("classifies a 0-row insert", …)` add:

```ts
    it("no_lead when the visit has no live lead", async () => {
      expect(await miss({ assignments: [] })).toEqual({ reason: "no_lead" });
      expect(await miss({ assignments: [{ technicianId: "x", technicianName: "X", isLead: false, status: "assigned" }] })).toEqual({ reason: "no_lead" });
    });
    it("visit_full at five live technicians", async () => {
      const five = ["l", "a", "b", "c", "d"].map((id, i) => ({ technicianId: id, technicianName: id, isLead: i === 0, status: "assigned" }));
      expect(await miss({ assignments: five })).toEqual({ reason: "visit_full" });
    });
    it("a cancelled row of the same technician is not already_assigned", async () => {
      m.anyTimeOff.mockResolvedValueOnce(true);
      expect(await miss({ assignments: [
        { technicianId: "lead", technicianName: "L", isLead: true, status: "assigned" },
        { technicianId: TID, technicianName: "T", isLead: false, status: "cancelled" },
      ] })).toEqual({ reason: "time_off" });
    });
```

Replace the whole `describe("removeVisitTechnician", …)` with:

```ts
describe("removeVisitTechnician", () => {
  const removed = (deleted: number, cancelled: number) => m.batch.mockResolvedValueOnce([{ rows: [] }, { rows: [{ deleted, cancelled }] }]);

  it("one batch: lock, then delete-untouched / cancel-timestamped / bump in one statement", async () => {
    removed(1, 0);
    expect(await removeVisitTechnician(ORG, RID, AID, TID)).toEqual({ ok: true, cancelled: false });
    const [lock, write] = m.executed.map((q) => new PgDialect().sqlToQuery(q as SQL).sql.replace(/\s+/g, " "));
    expect(lock).toContain("FOR NO KEY UPDATE");
    expect(write).toContain("WITH del AS (DELETE FROM appointment_assignments a USING appointments p WHERE a.appointment_id = p.id AND p.id = $");
    expect(write).toContain("AND NOT a.is_lead AND EXISTS (SELECT 1 FROM service_requests r WHERE r.id = p.service_request_id AND r.organization_id = $");
    expect(write).toContain("'cancelled'::request_status)) AND a.status <> 'cancelled'::request_status AND NOT (a.en_route_at IS NOT NULL OR a.arrived_at IS NOT NULL OR a.started_at IS NOT NULL OR a.completed_at IS NOT NULL) RETURNING a.id)");
    expect(write).toContain("can AS (UPDATE appointment_assignments a SET status = 'cancelled'::request_status FROM appointments p WHERE a.appointment_id = p.id");
    expect(write).toContain("AND (a.en_route_at IS NOT NULL OR a.arrived_at IS NOT NULL OR a.started_at IS NOT NULL OR a.completed_at IS NOT NULL) AND NOT (a.status <> 'cancelled'::request_status AND (a.status IN ('en_route'::request_status,");
    expect(write).toContain("bump AS (UPDATE appointments SET version = version + 1, updated_at = now() WHERE id = $");
    expect(write).toContain("AND (EXISTS (SELECT 1 FROM del) OR EXISTS (SELECT 1 FROM can)) RETURNING id)");
    expect(write).toContain("r.fieldpulse_job_id IS NULL AND r.hcp_job_id IS NULL AND r.status NOT IN ('completed'::request_status, 'cancelled'::request_status)");
  });
  it("a timestamped helper who isn't started is cancelled, not deleted", async () => {
    removed(0, 1);
    expect(await removeVisitTechnician(ORG, RID, AID, TID)).toEqual({ ok: true, cancelled: true });
  });
  it("not_found when the technician has no live row on the visit", async () => {
    removed(0, 0);
    m.selectQueue.push([reqRow()], []);
    expect(await removeVisitTechnician(ORG, RID, AID, TID)).toEqual({ reason: "not_found" });
    removed(0, 0);
    m.selectQueue.push([reqRow()], [{ isLead: false, status: "cancelled" }]);
    expect(await removeVisitTechnician(ORG, RID, AID, TID)).toEqual({ reason: "not_found" });
  });
  it("not_found when the request is not in the org", async () => {
    removed(0, 0);
    m.selectQueue.push([]);
    expect(await removeVisitTechnician(ORG, RID, AID, TID)).toEqual({ reason: "not_found" });
  });
  it("managed_externally, request_completed, request_cancelled", async () => {
    removed(0, 0);
    m.selectQueue.push([reqRow({ fp: "fp-1" })]);
    expect(await removeVisitTechnician(ORG, RID, AID, TID)).toEqual({ reason: "managed_externally" });
    removed(0, 0);
    m.selectQueue.push([reqRow({ status: "completed" })]);
    expect(await removeVisitTechnician(ORG, RID, AID, TID)).toEqual({ reason: "request_completed" });
    removed(0, 0);
    m.selectQueue.push([reqRow({ status: "cancelled" })]);
    expect(await removeVisitTechnician(ORG, RID, AID, TID)).toEqual({ reason: "request_cancelled" });
  });
  it("is_lead and has_progress", async () => {
    removed(0, 0);
    m.selectQueue.push([reqRow()], [{ isLead: true, status: "assigned" }]);
    expect(await removeVisitTechnician(ORG, RID, AID, TID)).toEqual({ reason: "is_lead" });
    removed(0, 0);
    m.selectQueue.push([reqRow()], [{ isLead: false, status: "in_progress" }]);
    expect(await removeVisitTechnician(ORG, RID, AID, TID)).toEqual({ reason: "has_progress" });
  });
});
```

In `src/lib/admin/scheduling-queries.test.ts`, replace the `unscheduleRequest: [lock, guarded update]` case with:

```ts
  it("unscheduleRequest: [lock, guarded update] with the version gate, FieldPulse, started and work-logged guards", async () => {
    selectQueue.push([{ status: "assigned", fp: null }]);
    updateQueue.push([{ id: REQ }]);
    expect(await unscheduleRequest(ORG, REQ, { visitId: "v1", expectedVersion: 2 })).toEqual({ ok: true });
    isLockThenUpdate(2, "VISIT_ONE_STARTED_GUARD");
    const where = JSON.stringify(whereCalls);
    for (const marker of ["VERSION_GATE", "FIELDPULSE_FREE", "NO_WORK_LOGGED"]) expect(where).toContain(marker);
  });
```

and add a new describe:

```ts
describe("unscheduleRequest refusals (spec §5.4)", () => {
  const gate = { visitId: "v1", expectedVersion: 2 };
  const miss = (row: Record<string, unknown>) => {
    selectQueue.push([{ status: "scheduled", fp: null }]);
    updateQueue.push([]);
    selectQueue.push([{ status: "scheduled", fieldpulse: false, versionOk: true, started: false, ended: false, workLogged: false, ...row }]);
    return unscheduleRequest(ORG, REQ, gate);
  };
  it("FieldPulse first, then STALE, started, ended, work logged", async () => {
    expect(await miss({ fieldpulse: true, versionOk: false })).toEqual({ ok: false, reason: "managed_externally" });
    expect(await miss({ versionOk: false, started: true })).toEqual({ ok: false, reason: "stale" });
    expect(await miss({ started: true, workLogged: true })).toEqual({ ok: false, reason: "has_progress" });
    expect(await miss({ ended: true })).toEqual({ ok: false, reason: "visit_ended" });
    expect(await miss({ workLogged: true })).toEqual({ ok: false, reason: "work_logged" });
    expect(await miss({})).toEqual({ ok: false, reason: "stale" });
  });
  it("terminal and not found are decided before the write", async () => {
    selectQueue.push([{ status: "completed", fp: null }]);
    expect(await unscheduleRequest(ORG, REQ, gate)).toEqual({ ok: false, reason: "request_terminal", currentStatus: "completed" });
    selectQueue.push([]);
    expect(await unscheduleRequest(ORG, REQ, gate)).toEqual({ ok: false, reason: "request_not_found" });
  });
});
```

In `src/app/api/admin/requests/[id]/unschedule/route.test.ts`, replace `const req = () =>\n  new Request("http://t/api", { method: "POST" }) as never;` with

```ts
const GATE = { visitId: "22222222-2222-4222-8222-222222222222", expectedVersion: 3 };
const req = (body: unknown = GATE) =>
  new Request("http://t/api", { method: "POST", body: JSON.stringify(body) }) as never;
```

and append:

```ts
describe("POST unschedule — M2", () => {
  beforeEach(() => {
    (getAdminSession as unknown as Mock).mockResolvedValue({ userId: "u", organizationId: "o" });
  });
  it("passes the card's visit and version (lowercased) to the writer", async () => {
    (unscheduleRequest as unknown as Mock).mockResolvedValue({ ok: true });
    await POST(req({ visitId: GATE.visitId.toUpperCase(), expectedVersion: 3 }), ctx(VALID_ID.toUpperCase()) as never);
    expect(unscheduleRequest).toHaveBeenCalledWith("o", VALID_ID, { visitId: GATE.visitId, expectedVersion: 3 });
  });
  it("a null visit with a null version is allowed; a half-null body is 400", async () => {
    (unscheduleRequest as unknown as Mock).mockResolvedValue({ ok: true });
    expect((await POST(req({ visitId: null, expectedVersion: null }), ctx(VALID_ID) as never)).status).toBe(200);
    expect((await POST(req({ visitId: null, expectedVersion: 1 }), ctx(VALID_ID) as never)).status).toBe(400);
    expect((await POST(req({}), ctx(VALID_ID) as never)).status).toBe(400);
  });
  it.each([
    ["managed_externally", "MANAGED_EXTERNALLY", "Change this request in FieldPulse."],
    ["stale", "STALE", "This request changed. The calendar has been refreshed."],
    ["work_logged", "WORK_LOGGED", "Work was logged on this visit, so it can’t go back to Unscheduled."],
    ["has_progress", "HAS_PROGRESS", "A technician has started this visit, so it can’t go back to Unscheduled."],
  ])("%s → 409 %s", async (reason, code, message) => {
    (unscheduleRequest as unknown as Mock).mockResolvedValue({ ok: false, reason });
    const res = await POST(req(), ctx(VALID_ID) as never);
    expect(res.status).toBe(409);
    expect((await res.json()).error).toEqual({ code, message });
  });
});
```

Run: `npx vitest run src/lib/admin/assignment-queries.test.ts src/lib/admin/scheduling-queries.test.ts "src/app/api/admin/requests/[id]/unschedule/route.test.ts"`
Expected: FAIL (old SQL shapes, old signature, no body handling).

- [ ] **Step 2: Helper writers.** In `src/lib/admin/assignment-queries.ts`, replace the imports block's first three lines

```ts
import { and, eq, sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { appointmentAssignments, appointments, serviceRequests } from "@/lib/db/schema";
```

with

```ts
import { and, eq, sql, type SQL } from "drizzle-orm";
import { db } from "@/lib/db";
import { appointmentAssignments, appointments, serviceRequests } from "@/lib/db/schema";
import { MAX_TECHNICIANS_PER_VISIT } from "./appointment-types";
import { anyTimestampSql, startedRowSql } from "./visit-started";
```

Replace the two result types' reason unions:

```ts
        | "not_found" | "technician_not_found" | "already_assigned" | "visit_cancelled"
        | "visit_ended" | "request_cancelled" | "request_completed" | "time_off" | "managed_externally";
```

with

```ts
        | "not_found" | "technician_not_found" | "already_assigned" | "visit_cancelled"
        | "visit_ended" | "request_cancelled" | "request_completed" | "time_off" | "managed_externally"
        | "no_lead" | "visit_full";
```

and

```ts
export type RemoveVisitTechnicianResult =
  | { readonly ok: true }
```

with

```ts
export type RemoveVisitTechnicianResult =
  /** `cancelled`: the helper had progress stamps but wasn't working, so the row was kept as cancelled (M2 §3.3). */
  | { readonly ok: true; readonly cancelled: boolean }
```

Replace the body of `addVisitTechnician` from `  // The request row is locked FOR SHARE first` through `  if (inserted.rows.length === 0) return classifyAddMiss(organizationId, requestId, appointmentId, technicianId, window);` with

```ts
  // The request row is locked FOR NO KEY UPDATE first (M2 §3.3: two adds can't
  // both see four), so a concurrent cancel/complete/move either commits before
  // the statement's checks run, or waits for this batch. One statement inserts
  // (or revives a cancelled non-lead row clean) and bumps the visit's version
  // only when a row was written, so a stale board card answers STALE.
  const org = sql`${organizationId}::uuid`;
  const aid = sql`${appointmentId}::uuid`;
  const [, inserted] = await db.batch([
    db.execute(sql`SELECT 1 FROM service_requests WHERE id = ${requestId}::uuid AND organization_id = ${organizationId}::uuid FOR NO KEY UPDATE`),
    db.execute(sql`WITH ins AS (INSERT INTO appointment_assignments (organization_id, appointment_id, technician_id, is_lead, status, assigned_by)
      SELECT ${org}, ${aid}, ${technicianId}::uuid, false, 'assigned'::request_status, ${actorUserId}::uuid
      WHERE EXISTS (SELECT 1 FROM service_requests r WHERE r.id = ${requestId}::uuid AND r.organization_id = ${org}
          AND r.fieldpulse_job_id IS NULL AND r.hcp_job_id IS NULL AND r.status NOT IN ('completed'::request_status, 'cancelled'::request_status))
        AND EXISTS (SELECT 1 FROM appointments p WHERE p.id = ${aid} AND p.service_request_id = ${requestId}::uuid
          AND p.organization_id = ${org} AND p.cancelled_at IS NULL)
        AND EXISTS (SELECT 1 FROM appointment_assignments x WHERE x.appointment_id = ${aid} AND x.organization_id = ${org} AND x.status IN (${OPEN_LIST}))
        AND EXISTS (SELECT 1 FROM appointment_assignments l WHERE l.appointment_id = ${aid} AND l.organization_id = ${org} AND l.is_lead AND l.status <> 'cancelled'::request_status)
        AND (SELECT count(*) FROM appointment_assignments c WHERE c.appointment_id = ${aid} AND c.organization_id = ${org} AND c.status <> 'cancelled'::request_status AND c.technician_id <> ${technicianId}::uuid) < ${MAX_TECHNICIANS_PER_VISIT}::int
        AND ${noTimeOffForVisit(organizationId, technicianId, appointmentId)}
      ON CONFLICT (appointment_id, technician_id) DO UPDATE SET status = 'assigned'::request_status, assigned_by = EXCLUDED.assigned_by, assigned_at = now(),
        en_route_at = NULL, arrived_at = NULL, started_at = NULL, completed_at = NULL
        WHERE appointment_assignments.status = 'cancelled'::request_status AND NOT appointment_assignments.is_lead
      RETURNING id),
    bump AS (UPDATE appointments SET version = version + 1, updated_at = now() WHERE id = ${aid} AND organization_id = ${org} AND EXISTS (SELECT 1 FROM ins) RETURNING id)
    SELECT id FROM ins`),
  ]);
  if (inserted.rows.length === 0) return classifyAddMiss(organizationId, requestId, appointmentId, technicianId, window);
```

(The old guard "no rows at all OR an open row" is gone: a visit with no rows now answers `no_lead`.)

Replace `classifyAddMiss`'s body from `  if (visit.assignments.some((a) => a.technicianId === technicianId)) return { reason: "already_assigned" };` through `  if (visit.assignments.length > 0 && !hasOpen) return { reason: "visit_ended" };` with

```ts
  const live = visit.assignments.filter((a) => a.status !== "cancelled");
  if (live.some((a) => a.technicianId === technicianId)) return { reason: "already_assigned" };
  const hasOpen = visit.assignments.some((a) => (OPEN_ASSIGNMENT_STATUSES as readonly string[]).includes(a.status));
  if (visit.assignments.length > 0 && !hasOpen) return { reason: "visit_ended" };
  if (!live.some((a) => a.isLead)) return { reason: "no_lead" };
  if (live.filter((a) => a.technicianId !== technicianId).length >= MAX_TECHNICIANS_PER_VISIT) return { reason: "visit_full" };
```

Replace `removeVisitTechnician`'s first statement and its success check

```ts
  const deleted = await db.execute(sql`DELETE FROM appointment_assignments a USING appointments p
    WHERE a.appointment_id = p.id AND p.id = ${appointmentId}::uuid AND p.service_request_id = ${requestId}::uuid
      AND p.organization_id = ${organizationId}::uuid AND a.organization_id = ${organizationId}::uuid
      AND a.technician_id = ${technicianId}::uuid AND NOT a.is_lead
      AND a.en_route_at IS NULL AND a.arrived_at IS NULL AND a.started_at IS NULL AND a.completed_at IS NULL
      AND EXISTS (SELECT 1 FROM service_requests r WHERE r.id = p.service_request_id
        AND r.fieldpulse_job_id IS NULL AND r.hcp_job_id IS NULL AND r.status NOT IN ('completed'::request_status, 'cancelled'::request_status))
    RETURNING a.id`);
  if (deleted.rows.length > 0) return { ok: true };
```

with

```ts
  // One batch: request lock, then ONE statement — an untouched helper is
  // deleted (today), a helper with progress stamps who isn't working is kept
  // as cancelled (M2 §3.3), and the visit's version bumps when either landed.
  // A working (started) helper matches neither: has_progress below.
  const org = sql`${organizationId}::uuid`;
  const rowOnVisit = sql`a.appointment_id = p.id AND p.id = ${appointmentId}::uuid AND p.service_request_id = ${requestId}::uuid
      AND p.organization_id = ${org} AND a.organization_id = ${org}
      AND a.technician_id = ${technicianId}::uuid AND NOT a.is_lead
      AND EXISTS (SELECT 1 FROM service_requests r WHERE r.id = p.service_request_id AND r.organization_id = ${org}
        AND r.fieldpulse_job_id IS NULL AND r.hcp_job_id IS NULL AND r.status NOT IN ('completed'::request_status, 'cancelled'::request_status))`;
  const [, written] = await db.batch([
    db.execute(sql`SELECT 1 FROM service_requests WHERE id = ${requestId}::uuid AND organization_id = ${organizationId}::uuid FOR NO KEY UPDATE`),
    db.execute(sql`WITH del AS (DELETE FROM appointment_assignments a USING appointments p
        WHERE ${rowOnVisit} AND a.status <> 'cancelled'::request_status AND NOT ${anyTimestampSql("a")}
        RETURNING a.id),
      can AS (UPDATE appointment_assignments a SET status = 'cancelled'::request_status FROM appointments p
        WHERE ${rowOnVisit} AND a.status <> 'cancelled'::request_status AND ${anyTimestampSql("a")} AND NOT ${startedRowSql("a")}
        RETURNING a.id),
      bump AS (UPDATE appointments SET version = version + 1, updated_at = now()
        WHERE id = ${appointmentId}::uuid AND organization_id = ${org} AND (EXISTS (SELECT 1 FROM del) OR EXISTS (SELECT 1 FROM can)) RETURNING id)
      SELECT (SELECT count(*) FROM del)::int AS deleted, (SELECT count(*) FROM can)::int AS cancelled`),
  ]);
  const counts = (written.rows[0] ?? {}) as { deleted?: number; cancelled?: number };
  if (Number(counts.deleted ?? 0) > 0) return { ok: true, cancelled: false };
  if (Number(counts.cancelled ?? 0) > 0) return { ok: true, cancelled: true };
```

and at the end of `removeVisitTechnician` replace

```ts
  const [row] = await db.select({ isLead: appointmentAssignments.isLead }).from(appointmentAssignments)
```

with

```ts
  const [row] = await db.select({ isLead: appointmentAssignments.isLead, status: appointmentAssignments.status }).from(appointmentAssignments)
```

and

```ts
  if (!row) return { reason: "not_found" };
  if (row.isLead) return { reason: "is_lead" };
  return { reason: "has_progress" };
```

with

```ts
  if (!row || row.status === "cancelled") return { reason: "not_found" };
  if (row.isLead) return { reason: "is_lead" };
  return { reason: "has_progress" };
```

(The rendered `startedRowSql("a")` has the alias `a`, as in the expectations of Step 1.)

- [ ] **Step 3: Visits GET adds `started` / `hasProgress`.** In `src/lib/admin/appointment-queries.ts`, add `import { rowStarted } from "./visit-started";` after the `./appointment-types` import, and replace the `assigned` select and the mapping in `loadAppointments`:

```ts
  const assigned = await db
    .select({
      appointmentId: appointmentAssignments.appointmentId, technicianId: appointmentAssignments.technicianId,
      technicianName: users.name, isLead: appointmentAssignments.isLead, status: appointmentAssignments.status,
    })
```

with

```ts
  const assigned = await db
    .select({
      appointmentId: appointmentAssignments.appointmentId, technicianId: appointmentAssignments.technicianId,
      technicianName: users.name, isLead: appointmentAssignments.isLead, status: appointmentAssignments.status,
      enRouteAt: appointmentAssignments.enRouteAt, arrivedAt: appointmentAssignments.arrivedAt,
      startedAt: appointmentAssignments.startedAt, completedAt: appointmentAssignments.completedAt,
    })
```

and

```ts
    .map(({ technicianId, technicianName, isLead, status }) => ({ technicianId, technicianName, isLead, status }))));
```

with

```ts
    .map((a) => {
      const hasProgress = Boolean(a.enRouteAt || a.arrivedAt || a.startedAt || a.completedAt);
      return {
        technicianId: a.technicianId, technicianName: a.technicianName, isLead: a.isLead, status: a.status,
        started: rowStarted({ status: a.status, isLead: a.isLead, hasTimestamp: hasProgress }), hasProgress,
      };
    })));
```

Run `npx vitest run src/lib/admin/appointment-queries.test.ts` → PASS (the extra keys are optional; if a case uses `toEqual` on a whole assignment record, add `started: false, hasProgress: false` to its expectation).

- [ ] **Step 4: Helper routes.** In `src/app/api/admin/requests/[id]/appointments/[aid]/assignments/route.ts`, add inside the `switch (result.reason)` after the `time_off` case:

```ts
        case "no_lead":
          return errorResponse("Assign a technician to this request first.", "NO_LEAD", 409);
        case "visit_full":
          return errorResponse("This visit already has 5 technicians.", "VISIT_FULL", 409);
```

In `…/assignments/[tid]/route.ts`, replace `    return successResponse({ removed: true });` with `    return successResponse({ removed: true, cancelled: result.cancelled });`.

- [ ] **Step 5: Unscheduled.** In `src/lib/admin/scheduling-queries.ts`, add `import { fieldpulseFreeSql, noWorkLoggedSql, startedOnVisitOneSql, versionGateSql } from "./visit-move-sql";` (merge with Task 3's `requestXminGateSql, reviveLeadSql` import into one line), and replace the whole `unscheduleRequest` function (from its doc comment `/**\n * Clear a job's placement:` to its closing `}`) with:

```ts
export type UnscheduleResult =
  | { readonly ok: true }
  | { readonly ok: false; readonly reason: "request_not_found" }
  | { readonly ok: false; readonly reason: "request_terminal"; readonly currentStatus: string }
  | { readonly ok: false; readonly reason: "managed_externally" | "stale" | "has_progress" | "visit_ended" | "work_logged" };

/**
 * Clear a job's placement (drag back to Unscheduled): null its schedule and
 * window and unassign it (status → pending). One status-guarded UPDATE after
 * the request lock, carrying the M2 guards (spec §5.4): the card's version gate,
 * FieldPulse, the started rule, and no job time logged on visit #1 — a revive
 * clears stamps, and the trigger keeps #1 only for stamps or a form submission,
 * so time entries are what keep a worked visit from being deleted.
 */
export async function unscheduleRequest(
  organizationId: string,
  requestId: string,
  gate: { readonly visitId: string | null; readonly expectedVersion: number | null },
): Promise<UnscheduleResult> {
  const [existing] = await db
    .select({ status: serviceRequests.status, fp: serviceRequests.fieldpulseJobId })
    .from(serviceRequests)
    .where(
      withTenant(serviceRequests, organizationId, eq(serviceRequests.id, requestId)),
    );
  if (!existing) return { ok: false, reason: "request_not_found" };
  if (isTerminal(existing.status as RequestStatus)) {
    return { ok: false, reason: "request_terminal", currentStatus: existing.status };
  }

  const versionGate = versionGateSql(organizationId, requestId, gate.visitId, gate.expectedVersion);
  const [updated] = await lockedUpdate(organizationId, requestId, db
    .update(serviceRequests)
    .set({
      status: "pending",
      assignedTo: null,
      scheduledDate: null,
      arrivalWindowStart: null,
      arrivalWindowEnd: null,
      updatedAt: new Date(),
    })
    .where(
      withTenant(
        serviceRequests,
        organizationId,
        and(
          eq(serviceRequests.id, requestId),
          eq(serviceRequests.status, existing.status),
          fieldpulseFreeSql(),
          versionGate,
          visitOneStartedGuardSql(organizationId),
          noWorkLoggedSql(organizationId),
        )!,
      ),
    )
    .returning({ id: serviceRequests.id }));

  if (!updated) {
    const [now] = await db
      .select({
        status: serviceRequests.status,
        fieldpulse: sql<boolean>`("service_requests"."fieldpulse_job_id" IS NOT NULL)`,
        versionOk: sql<boolean>`${versionGate}`,
        started: sql<boolean>`${startedOnVisitOneSql(organizationId, "any")}`,
        ended: sql<boolean>`EXISTS (SELECT 1 FROM appointments e1 WHERE e1.service_request_id = "service_requests"."id" AND e1.organization_id = ${organizationId}::uuid AND e1.appointment_number = 1 AND e1.cancelled_at IS NOT NULL)`,
        workLogged: sql<boolean>`NOT ${noWorkLoggedSql(organizationId)}`,
      })
      .from(serviceRequests)
      .where(withTenant(serviceRequests, organizationId, eq(serviceRequests.id, requestId)));
    if (!now) return { ok: false, reason: "request_not_found" };
    if (isTerminal(now.status as RequestStatus)) return { ok: false, reason: "request_terminal", currentStatus: now.status };
    if (now.fieldpulse) return { ok: false, reason: "managed_externally" };
    if (!now.versionOk) return { ok: false, reason: "stale" };
    if (now.started) return { ok: false, reason: "has_progress" };
    if (now.ended) return { ok: false, reason: "visit_ended" };
    if (now.workLogged) return { ok: false, reason: "work_logged" };
    return { ok: false, reason: "stale" };
  }
  // Back to the unscheduled pile → its confirm-time capacity hold no longer
  // applies; free it so the band re-opens. Best-effort.
  await releaseReservationsForRequest(organizationId, requestId);
  return { ok: true };
}
```

Then drop `visitOneGuardSql` from the `./visit-one-guard` import (no use is left in the file; `placeAndAssignRequest` still uses `classifyVisitOne`, keep it): the line becomes `import { classifyVisitOne, lockedUpdate, visitOneStartedGuardSql, type VisitOneRefusal } from "./visit-one-guard";`. The pre-read selects `fp` only to keep the select shape the tests queue; the FieldPulse decision is the predicate and the re-read (spec §5.1).

- [ ] **Step 6: The unschedule route.** Replace `src/app/api/admin/requests/[id]/unschedule/route.ts` with:

```ts
import { NextRequest, after } from "next/server";
import { z } from "zod";
import { getAdminSession } from "@/lib/auth/session";
import { unscheduleRequest } from "@/lib/admin/scheduling-queries";
import { visitOneRefusalResponse } from "@/lib/admin/visit-one-guard";
import { syncRequestToCalendar } from "@/lib/integrations/google-calendar/sync";
import { pushJobToHcp } from "@/lib/integrations/housecall-pro/job-sync";
import { logAudit } from "@/lib/admin/audit";
import { FIELDPULSE_BOARD, STALE_LINE, UNSCHEDULE_COPY } from "@/lib/admin/dispatch-copy";
import { successResponse, errorResponse, readJsonBody } from "@/lib/api-response";
import { isUuid } from "@/lib/validation/uuid";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { errorCode, logger } from "@/lib/logger";
import { clientIp } from "@/lib/http/client-ip";

export const dynamic = "force-dynamic";

/** The card's revision (spec §4.1): both null (no visit #1) or both set. */
const bodySchema = z
  .object({
    visitId: z.uuid().nullable(),
    expectedVersion: z.number().int().min(0).nullable(),
  })
  .refine((b) => (b.visitId === null) === (b.expectedVersion === null), { path: ["expectedVersion"], message: "visitId and expectedVersion go together." });

/**
 * POST /api/admin/requests/[id]/unschedule — drag back to Unscheduled: clear
 * the placement and return the request to the queue. Admin session +
 * adminMutation rate limit + audit. Guards (M2 §5.4): version, FieldPulse,
 * started, work logged.
 */
export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await getAdminSession();
    if (!session) return errorResponse("Unauthorized", "UNAUTHORIZED", 401);

    const { id: rawId } = await params;
    if (!isUuid(rawId)) {
      return errorResponse("Invalid request ID format", "INVALID_ID", 400);
    }
    const id = rawId.toLowerCase();

    const rateCheck = slidingWindow(
      `admin:request-unschedule:${session.userId}`,
      RATE_LIMITS.adminMutation.maxRequests,
      RATE_LIMITS.adminMutation.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const raw = await readJsonBody(request);
    const parsed = raw.ok ? bodySchema.safeParse(raw.data) : null;
    if (!parsed?.success) {
      return errorResponse("Invalid request body", "VALIDATION_ERROR", 400);
    }
    const gate = { visitId: parsed.data.visitId?.toLowerCase() ?? null, expectedVersion: parsed.data.expectedVersion };

    const result = await unscheduleRequest(session.organizationId, id, gate);
    if (!result.ok) {
      switch (result.reason) {
        case "request_not_found":
          return errorResponse("Request not found", "NOT_FOUND", 404);
        case "request_terminal":
          return errorResponse(
            `This request is ${result.currentStatus === "cancelled" ? "cancelled" : "completed"}, so it can’t be moved.`,
            "REQUEST_TERMINAL",
            409,
            { status: result.currentStatus },
          );
        case "managed_externally":
          return errorResponse(FIELDPULSE_BOARD, "MANAGED_EXTERNALLY", 409);
        case "stale":
          return errorResponse(STALE_LINE, "STALE", 409);
        case "work_logged":
          return errorResponse(UNSCHEDULE_COPY.WORK_LOGGED, "WORK_LOGGED", 409);
        case "has_progress":
        case "visit_ended":
          return visitOneRefusalResponse(result.reason, { surface: "unschedule" });
      }
    }

    await logAudit({
      organizationId: session.organizationId,
      userId: session.userId,
      action: "request_unscheduled",
      entity: "service_request",
      entityId: id,
      details: JSON.stringify({
        cleared: ["scheduledDate", "arrivalWindow", "assignedTo"],
      }),
      ipAddress: clientIp(request),
    });

    // Mirror the cleared placement outward (idempotent, degrade-safe, no-op when
    // the org isn't connected). No FieldPulse call (M2 §5.1).
    after(() => syncRequestToCalendar(session.organizationId, id));
    after(() => pushJobToHcp(session.organizationId, id));

    return successResponse(result);
  } catch (error: unknown) {
    logger.error({ code: errorCode(error) }, "Failed to unschedule request");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
```

The route test's existing `"409 when the job is terminal"` case still passes (409); its `"409 HAS_PROGRESS / VISIT_ENDED"` loop still maps both codes.

- [ ] **Step 7: Run the tests to verify they pass**

Run: `npx vitest run src/lib/admin/assignment-queries.test.ts src/lib/admin/appointment-queries.test.ts src/lib/admin/scheduling-queries.test.ts "src/app/api/admin/requests/[id]/unschedule/route.test.ts"`
Expected: PASS. Then `npx tsc --noEmit`: the only caller of `unscheduleRequest` besides the route is none (`grep -rn "unscheduleRequest(" src`); `use-reschedule-job.ts` still POSTs without a body until Task 9b — between Tasks 4 and 9b a live drag to Unscheduled answers 400, which the current board shows as its generic error (acceptable inside the M2 branch; Task 9b replaces the hook).

- [ ] **Step 8: Gates and commit**

```bash
npx tsc --noEmit && npx eslint src/lib/admin/assignment-queries.ts src/lib/admin/assignment-queries.test.ts src/lib/admin/appointment-queries.ts "src/app/api/admin/requests/[id]/appointments/[aid]/assignments/route.ts" "src/app/api/admin/requests/[id]/appointments/[aid]/assignments/[tid]/route.ts" src/lib/admin/scheduling-queries.ts src/lib/admin/scheduling-queries.test.ts "src/app/api/admin/requests/[id]/unschedule/route.ts" "src/app/api/admin/requests/[id]/unschedule/route.test.ts" && npx vitest run
git add src/lib/admin/assignment-queries.ts src/lib/admin/assignment-queries.test.ts src/lib/admin/appointment-queries.ts "src/app/api/admin/requests/[id]/appointments/[aid]/assignments/route.ts" "src/app/api/admin/requests/[id]/appointments/[aid]/assignments/[tid]/route.ts" src/lib/admin/scheduling-queries.ts src/lib/admin/scheduling-queries.test.ts "src/app/api/admin/requests/[id]/unschedule/route.ts" "src/app/api/admin/requests/[id]/unschedule/route.test.ts"
git commit -m "$(cat <<'EOF'
feat(m2): helper writers revive clean and bump the visit; Unscheduled guards

Add technician locks the request FOR NO KEY UPDATE, revives a cancelled
helper with nulled stamps, needs a live lead (NO_LEAD) and caps at five in
SQL (VISIT_FULL); remove cancels a stamped but idle helper; both bump the
visit version. Drag to Unscheduled carries the version gate, FieldPulse,
started and work-logged guards (spec 5.4); the visits GET reports started.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01GuWoF63tQU1i7ELqyYU3A6
EOF
)"
```

---
### Task 5: `moveVisit` — pre-read, refusals, the guarded batch

**Files:**
- Create: `src/lib/admin/visit-move-plan.ts`, `src/lib/admin/visit-move-plan.test.ts`, `src/lib/admin/visit-move.ts`, `src/lib/admin/visit-move.test.ts`
- Modify: `src/lib/admin/availability-coverage.ts` (+`isSpanWithinAvailability`), `src/lib/admin/availability-coverage.test.ts`

**Interfaces:**
- Consumes: Task 1 (`resolveMoveWindow`, `windowEqual`, `windowHasEndedAt`, `namedWindowOf`, `anyTimestampSql`), Task 2 (`moveNeeds`, `NeedsRow`, `moveErrorBanner`, `FIELDPULSE_BOARD`, `STALE_LINE`), Task 3 (`versionGateSql`, `visitOneLiveSql`, `activeTechnicianSql`, `leadDoneSql`, `startedOnVisitOneSql`, `otherStartedOnVisitOneSql`, `overlapFromWhereSql`, `noOverlapSql`, `reviveLeadSql`, `cancelDoneOldLeadSql`, `closeOldLeadEntriesSql`, `requestXminGateSql`, `visitOneXminGateSql`, `fieldpulseFreeSql`, `resetFromSql`). Existing: `readRows`, `runBatch`, `lockRequestSql` (`invoice-field-writes.ts`), `activeTechnicianIds`, `noTimeOff` (`appointment-queries.ts`), `technicianTimeOffOverlapping` (`shift-queries.ts`), `getTechnicianAvailability` (`scheduling-queries.ts`), `displayVisitIdSql`, `visitEndedSql` (`current-visit.ts`), `recordStatusEvent`, `stampDispatchOverride`.
- Produces:
  - `visit-move-plan.ts`: `MoveCode`, `MoveRefusal`, `MoveRow`, `MoveState`, `MovePlan`, `parseMoveState(row)`, `planMove(state, body, now, facts)`, `moveNeedsResult(plan, checks, confirm)`, `timeOffRefusal(hits)`, `moveAuditDetails(…)`, `moveEvents(from, to, oldLead, newLead)`.
  - `visit-move.ts`: `MoveResult`, `moveVisit(org, actorUserId, requestId, body, opts?)` (contract), SQL builders `moveStateSql`, `overlapRowsSql`, `moveUpdateSql`, `moveAuditSql`, `visitOneVersionSql` (exported for render tests).
  - `availability-coverage.ts`: `isSpanWithinAvailability(slots, start, end)`.

- [ ] **Step 1: Failing tests for the span variant** — append to `src/lib/admin/availability-coverage.test.ts` (extend its import with `isSpanWithinAvailability`):

```ts
describe("isSpanWithinAvailability (a span variant, spec §5.3)", () => {
  // 2026-11-10 is a Tuesday (EST): 9 AM = 14:00Z.
  const nineEleven = [new Date("2026-11-10T14:00:00.000Z"), new Date("2026-11-10T16:00:00.000Z")] as const;
  it("unconfigured technician: the bounded weekday default", () => {
    expect(isSpanWithinAvailability([], ...nineEleven)).toBe(true);
    expect(isSpanWithinAvailability([], new Date("2026-11-14T14:00:00.000Z"), new Date("2026-11-14T16:00:00.000Z"))).toBe(false); // Saturday
  });
  it("covered by that weekday's slots; a gap or another weekday is not", () => {
    expect(isSpanWithinAvailability([slot({ dayOfWeek: 2, startMinute: 540, endMinute: 660 })], ...nineEleven)).toBe(true);
    expect(isSpanWithinAvailability([slot({ dayOfWeek: 2, startMinute: 600, endMinute: 720 })], ...nineEleven)).toBe(false);
    expect(isSpanWithinAvailability([slot({ dayOfWeek: 3, startMinute: 0, endMinute: 1440 })], ...nineEleven)).toBe(false);
  });
  it("a span ending at midnight is covered to 1440; past midnight is out of hours", () => {
    const allDay = [slot({ dayOfWeek: 2, startMinute: 0, endMinute: 1440 })];
    expect(isSpanWithinAvailability(allDay, new Date("2026-11-11T02:00:00.000Z"), new Date("2026-11-11T05:00:00.000Z"))).toBe(true); // 9 PM–12 AM
    expect(isSpanWithinAvailability(allDay, new Date("2026-11-11T04:00:00.000Z"), new Date("2026-11-11T06:00:00.000Z"))).toBe(false); // 11 PM–1 AM
  });
});
```

- [ ] **Step 2: Failing pure tests** — `src/lib/admin/visit-move-plan.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { moveAuditDetails, moveEvents, moveNeedsResult, parseMoveState, planMove, timeOffRefusal, type MoveState } from "./visit-move-plan";
import type { MoveBody } from "./board-types";

const ALEX = "a1111111-1111-4111-8111-111111111111";
const SAM = "b2222222-2222-4222-8222-222222222222";
const V1 = "c3333333-3333-4333-8333-333333333333";
const NOW = new Date("2026-11-10T12:00:00.000Z"); // 7 AM ET
const lead = (status = "scheduled", hasTimestamp = false, openTimeEntry = false) => ({ technicianId: ALEX, isLead: true, status, hasTimestamp, openTimeEntry });

function state(over: Partial<MoveState> = {}): MoveState {
  return {
    status: "scheduled", assignedTo: ALEX, fieldpulse: false, native: true,
    window: { start: new Date("2026-11-10T14:00:00.000Z"), end: new Date("2026-11-10T16:00:00.000Z") },
    visitOneId: V1, visitOneVersion: 3, visitOneCancelled: false, ended: false, displayedNumber: 1,
    rows: [lead()], ...over,
  };
}
const body = (over: Partial<MoveBody> = {}): MoveBody => ({
  visitId: V1, expectedVersion: 3, day: "2026-11-10", band: "afternoon", windowRule: "match", technicianId: SAM, confirm: [], ...over,
});
const active = { newLeadActive: true };
const code = (r: ReturnType<typeof planMove>) => (r.ok ? "ok" : r.code);

describe("parseMoveState", () => {
  it("reads the pre-read row; rows arrive as JSON text or parsed", () => {
    const row = {
      status: "arrived", assigned_to: ALEX, fieldpulse: false, hcp: true, window_start: "2026-11-10T14:00:00Z", window_end: "2026-11-10T16:00:00Z",
      ended: false, displayed_number: 1, v1_id: V1, v1_version: "4", v1_cancelled: false,
      rows: JSON.stringify([{ technicianId: ALEX, isLead: true, status: "arrived", hasTimestamp: true, openTimeEntry: true }]),
    };
    const s = parseMoveState(row)!;
    expect(s).toMatchObject({ status: "arrived", native: false, visitOneVersion: 4, displayedNumber: 1 });
    expect(s.rows).toEqual([{ technicianId: ALEX, isLead: true, status: "arrived", hasTimestamp: true, openTimeEntry: true }]);
    expect(parseMoveState(undefined)).toBeNull();
    expect(parseMoveState({ ...row, window_start: null })!.window).toBeNull();
  });
});

describe("planMove — refusal order (spec §5.3, lead ruling 8)", () => {
  it("404, terminal, ended, pinned, stale, FieldPulse in that order", () => {
    expect(planMove(null, body(), NOW, active)).toMatchObject({ ok: false, status: 404, code: "NOT_FOUND" });
    expect(planMove(state({ status: "completed", fieldpulse: true }), body(), NOW, active)).toMatchObject({ code: "REQUEST_TERMINAL", details: { status: "completed" } });
    expect(code(planMove(state({ ended: true, fieldpulse: true }), body(), NOW, active))).toBe("VISIT_ENDED");
    expect(code(planMove(state({ visitOneCancelled: true }), body(), NOW, active))).toBe("VISIT_ENDED");
    expect(planMove(state({ displayedNumber: 2, visitOneCancelled: true }), body(), NOW, active)).toMatchObject({ code: "VISIT_PINNED", details: { visitNumber: 2 } });
    expect(code(planMove(state({ fieldpulse: true }), body({ expectedVersion: 2 }), NOW, active))).toBe("STALE");
    expect(code(planMove(state({ fieldpulse: true }), body(), NOW, active))).toBe("MANAGED_EXTERNALLY");
  });
  it("STALE compares the visit id too: a new #1 starts at version 0", () => {
    expect(code(planMove(state({ visitOneId: "d4444444-4444-4444-8444-444444444444" }), body(), NOW, active))).toBe("STALE");
    expect(code(planMove(state({ visitOneId: null, visitOneVersion: null }), body(), NOW, active))).toBe("STALE");
    expect(code(planMove(state({ visitOneId: null, visitOneVersion: null }), body({ visitId: null, expectedVersion: null }), NOW, active))).toBe("ok");
  });
  it("keep with no window → 400 windowRule", () => {
    expect(planMove(state({ window: null, assignedTo: null, rows: [] }), body({ windowRule: "keep" }), NOW, active))
      .toMatchObject({ status: 400, code: "VALIDATION_ERROR", details: { path: ["windowRule"] } });
  });
  it("TECHNICIAN_NOT_FOUND, then TECHNICIAN_DONE, then WINDOW_ENDED", () => {
    expect(code(planMove(state(), body(), NOW, { newLeadActive: false }))).toBe("TECHNICIAN_NOT_FOUND");
    const done = state({ rows: [lead(), { technicianId: SAM, isLead: false, status: "completed", hasTimestamp: true, openTimeEntry: false }] });
    expect(planMove(done, body(), NOW, active)).toMatchObject({ code: "TECHNICIAN_DONE", details: { technicianId: SAM } });
    expect(planMove(state(), body({ band: "morning" }), new Date("2026-11-10T18:00:00.000Z"), active)).toMatchObject({ status: 400, code: "WINDOW_ENDED" });
  });
  it("a lead change keeping an ended window is allowed", () => {
    const r = planMove(state(), body({ windowRule: "keep" }), new Date("2026-11-10T22:00:00.000Z"), active);
    expect(r).toMatchObject({ ok: true, leadChanges: true, windowChanges: false });
  });
});

describe("planMove — what the move changes and checks", () => {
  it("an uppercase technicianId equal to the lead is not a lead change", () => {
    const r = planMove(state(), body({ technicianId: ALEX.toUpperCase(), band: "morning", windowRule: "keep" }), NOW, active);
    expect(r).toMatchObject({ ok: true, leadChanges: false, windowChanges: false, newLeadId: ALEX });
  });
  it("dropping on Unassigned (no technicianId) never unassigns", () => {
    expect(planMove(state(), body({ technicianId: undefined }), NOW, active)).toMatchObject({ ok: true, leadChanges: false, newLeadId: ALEX, oldLeadId: ALEX });
  });
  it("a lead change past a started lead needs 'started'; started details carry the open time entry", () => {
    const r = planMove(state({ status: "arrived", rows: [lead("arrived", true, true)] }), body({ windowRule: "keep" }), NOW, active);
    expect(r).toMatchObject({ ok: true, needsStarted: true, checked: [SAM] });
    if (r.ok) expect(r.started).toEqual([{ technicianId: ALEX, status: "arrived", hasTimestamp: true, openTimeEntry: true }]);
  });
  it("othersStarted: a working helper is reported even when only the lead's row is listed as started", () => {
    const r = planMove(state({ status: "arrived", rows: [lead("arrived", true), { technicianId: "h", isLead: false, status: "in_progress", hasTimestamp: true, openTimeEntry: false }] }), body({ windowRule: "keep" }), NOW, active);
    expect(r).toMatchObject({ ok: true, othersStarted: true });
    if (r.ok) expect(r.started.map((s) => s.technicianId)).toEqual([ALEX]);
  });
  it("a first assignment of an unassigned #1 (visitId = #1's id) is a lead change from null", () => {
    expect(planMove(state({ assignedTo: null, rows: [] }), body(), NOW, active)).toMatchObject({ ok: true, leadChanges: true, oldLeadId: null, newLeadId: SAM });
  });
});

describe("needs, time off, audit, events", () => {
  const plan = planMove(state({ status: "in_progress", rows: [lead("in_progress", true)] }), body(), NOW, active);
  if (!plan.ok) throw new Error("fixture");
  const conflict = { id: "r9", referenceNumber: "HVAC-9", technicianId: SAM, arrivalWindowStart: "2026-11-10T17:00:00.000Z", arrivalWindowEnd: "2026-11-10T19:00:00.000Z" };
  it("started unconfirmed → HAS_PROGRESS with every need listed; ids only", () => {
    const v = moveNeedsResult(plan, { conflicts: [conflict], outsideAvailability: false }, []);
    expect(v.refusal).toMatchObject({ status: 409, code: "HAS_PROGRESS", details: { needs: ["started", "conflict"], conflicts: [conflict], othersStarted: false } });
    expect(JSON.stringify(v.refusal)).not.toMatch(/Alex|Sam/);
  });
  it("only a conflict unconfirmed → SCHEDULE_CONFLICT; all confirmed → no refusal, confirmed listed", () => {
    expect(moveNeedsResult(plan, { conflicts: [], outsideAvailability: true }, ["started"]).refusal).toMatchObject({ code: "SCHEDULE_CONFLICT", details: { needs: ["conflict"], outsideAvailability: true } });
    expect(moveNeedsResult(plan, { conflicts: [conflict], outsideAvailability: false }, ["started", "conflict"])).toEqual({ refusal: null, confirmed: ["started", "conflict"] });
  });
  it("a confirm token nobody needed isn't reported as confirmed", () => {
    const calm = planMove(state(), body(), NOW, active);
    if (!calm.ok) throw new Error("fixture");
    expect(moveNeedsResult(calm, { conflicts: [], outsideAvailability: false }, ["started"])).toEqual({ refusal: null, confirmed: [] });
  });
  it("TIME_OFF details, never 'needs'", () => {
    const r = timeOffRefusal([{ technicianId: SAM, startsAt: "2026-11-10T21:00:00.000Z", endsAt: "2026-11-11T01:00:00.000Z", kind: "time_off" }]);
    expect(r).toMatchObject({ status: 409, code: "TIME_OFF", details: { timeOff: [{ technicianId: SAM, kind: "time_off" }] } });
    expect(JSON.stringify(r.details)).not.toContain("needs");
  });
  it("audit details: ids, enums, booleans, counts — no instants", () => {
    const d = moveAuditDetails({ requestId: "r1", plan, body: body(), confirmed: ["started"], conflictCount: 1, outsideAvailability: false });
    expect(d).toEqual({
      requestId: "r1", fromTechnicianId: ALEX, toTechnicianId: SAM, windowRule: "match", window: "afternoon",
      dayChanged: false, confirmed: ["started"], startedStatuses: ["in_progress"], conflictCount: 1, outsideAvailability: false,
    });
    expect(JSON.stringify(d)).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });
  it("events: a first assignment records → assigned once; any other change records from → to", () => {
    expect(moveEvents("pending", "assigned", null, SAM)).toEqual([{ from: "pending", to: "assigned" }]);
    expect(moveEvents("scheduled", "scheduled", null, SAM)).toEqual([{ from: "scheduled", to: "assigned" }]);
    expect(moveEvents("pending", "assigned", ALEX, ALEX)).toEqual([{ from: "pending", to: "assigned" }]);
    expect(moveEvents("arrived", "scheduled", ALEX, SAM)).toEqual([{ from: "arrived", to: "scheduled" }]);
    expect(moveEvents("scheduled", "scheduled", ALEX, SAM)).toEqual([]);
  });
});
```

- [ ] **Step 3: Failing writer tests** — `src/lib/admin/visit-move.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

const m = vi.hoisted(() => ({
  readRows: vi.fn(),
  runBatch: vi.fn(),
  active: vi.fn(),
  timeOff: vi.fn(),
  availability: vi.fn(),
  event: vi.fn(),
  stamp: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("./invoice-field-writes", async (orig) => ({ ...(await orig<typeof import("./invoice-field-writes")>()), readRows: m.readRows, runBatch: m.runBatch }));
vi.mock("./appointment-queries", async (orig) => ({ ...(await orig<typeof import("./appointment-queries")>()), activeTechnicianIds: m.active }));
vi.mock("./shift-queries", () => ({ technicianTimeOffOverlapping: m.timeOff }));
vi.mock("./scheduling-queries", () => ({ getTechnicianAvailability: m.availability }));
vi.mock("./status-events", () => ({ recordStatusEvent: m.event }));
vi.mock("./dispatch-override", () => ({ stampDispatchOverride: m.stamp }));

import { moveStateSql, moveUpdateSql, moveVisit, overlapRowsSql } from "./visit-move";
import type { MoveBody } from "./board-types";

const ORG = "00000000-0000-4000-8000-0000000000aa";
const RID = "11111111-1111-4111-8111-111111111111";
const ALEX = "a1111111-1111-4111-8111-111111111111";
const SAM = "b2222222-2222-4222-8222-222222222222";
const V1 = "c3333333-3333-4333-8333-333333333333";
const USER = "e5555555-5555-4555-8555-555555555555";
const NOW = new Date("2026-11-10T12:00:00.000Z");
const text = (s: SQL) => new PgDialect().sqlToQuery(s).sql.replace(/\s+/g, " ");
const params = (s: SQL) => new PgDialect().sqlToQuery(s).params;

const stateRow = (over: Record<string, unknown> = {}) => ({
  status: "scheduled", assigned_to: ALEX, fieldpulse: false, hcp: false,
  window_start: "2026-11-10T14:00:00.000Z", window_end: "2026-11-10T16:00:00.000Z",
  ended: false, displayed_number: 1, v1_id: V1, v1_version: 3, v1_cancelled: false,
  rows: [{ technicianId: ALEX, isLead: true, status: "scheduled", hasTimestamp: false, openTimeEntry: false }], ...over,
});
const body = (over: Partial<MoveBody> = {}): MoveBody => ({
  visitId: V1, expectedVersion: 3, day: "2026-11-10", band: "afternoon", windowRule: "match", technicianId: SAM, confirm: [], ...over,
});
const updated = (over: Record<string, unknown> = {}) => ({
  id: RID, status: "scheduled", assigned_to: SAM, arrival_window_start: "2026-11-10T17:00:00.000Z", arrival_window_end: "2026-11-10T21:00:00.000Z", ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  m.active.mockResolvedValue([SAM]);
  m.timeOff.mockResolvedValue([]);
  m.availability.mockResolvedValue([]);
});

describe("SQL renders", () => {
  it("the pre-read is one org-scoped query: request, visit #1, displayed visit, live rows with open time", () => {
    const t = text(moveStateSql(ORG, RID));
    expect(t).toContain("FROM service_requests LEFT JOIN appointments v1 ON v1.service_request_id = \"service_requests\".\"id\" AND v1.organization_id = $");
    expect(t).toContain("AND v1.appointment_number = 1 WHERE \"service_requests\".\"id\" = $");
    expect(t).toMatch(/AND "service_requests"\."organization_id" = \$\d+::uuid$/);
    expect(t).toContain("FROM appointment_assignments a WHERE a.appointment_id = v1.id AND a.organization_id = $");
    expect(t).toContain("AND a.status <> 'cancelled'::request_status");
    expect(t).toContain("FROM technician_time_entries t WHERE t.organization_id = $");
    expect(t).toContain("AND t.technician_id = a.technician_id AND t.kind = 'job' AND t.clock_out_at IS NULL AND (t.appointment_id = v1.id OR t.appointment_id IS NULL)");
    expect(params(moveStateSql(ORG, RID)).filter((p) => p === ORG).length).toBeGreaterThanOrEqual(5);
  });
  it("overlap rows reuse the in-write twin's FROM … WHERE", () => {
    const t = text(overlapRowsSql(ORG, RID, [SAM], "2026-11-10T17:00:00.000Z", "2026-11-10T21:00:00.000Z"));
    expect(t).toMatch(/^SELECT DISTINCT cr\.id, cr\.reference_number, ca\.technician_id, cp\.arrival_window_start, cp\.arrival_window_end FROM appointment_assignments ca/);
    expect(t).toContain("ORDER BY cp.arrival_window_start LIMIT 20");
  });

  const base = {
    org: ORG, rid: RID, visitId: V1, expectedVersion: 3,
    start: new Date("2026-11-10T17:00:00.000Z"), end: new Date("2026-11-10T21:00:00.000Z"),
    oldLeadId: ALEX, newLeadId: SAM, leadChanges: true, windowChanges: true, checked: [SAM], confirmStarted: false, confirmConflict: false,
  };
  it("step 1 carries every guard: id+org, FieldPulse, not terminal, version gate, #1 live, active lead not done, no time off, started arms, no overlap", () => {
    const t = text(moveUpdateSql(base));
    expect(t).toMatch(/^UPDATE service_requests SET assigned_to = \$1::uuid, scheduled_date = \$2::timestamptz, arrival_window_start = \$3::timestamptz, arrival_window_end = \$4::timestamptz, status = CASE/);
    expect(t).toContain("WHERE \"service_requests\".\"id\" = $");
    expect(t).toContain("AND \"service_requests\".\"organization_id\" = $");
    expect(t).toContain("AND \"service_requests\".\"fieldpulse_job_id\" IS NULL AND \"service_requests\".\"status\" NOT IN ('completed'::request_status, 'cancelled'::request_status)");
    expect(t).toContain("AND EXISTS (SELECT 1 FROM appointments g WHERE g.id = $");
    expect(t).toContain("AND (NOT ((\"service_requests\".\"status\" = 'on_hold'::request_status");
    expect(t).toContain("AND EXISTS (SELECT 1 FROM users u WHERE u.id = $");
    expect(t).toContain("AND NOT EXISTS (SELECT 1 FROM appointment_assignments d JOIN appointments dp");
    expect(t).toContain("AND NOT EXISTS (SELECT 1 FROM technician_shifts s WHERE s.organization_id = $");
    expect(t).toMatch(/AND NOT \(EXISTS \(SELECT 1 FROM appointment_assignments sa JOIN appointments sp ON sp\.id = sa\.appointment_id WHERE .* AND sa\.is_lead AND .* OR EXISTS \(SELECT 1 FROM appointment_assignments sa/);
    expect(t).toContain("AND NOT EXISTS (SELECT 1 FROM appointment_assignments ca JOIN appointments cp");
    expect(t).toMatch(/RETURNING id, status, assigned_to, arrival_window_start, arrival_window_end$/);
  });
  it("the status CASE: pending with a lead → assigned; a native reset past a started lead → scheduled, hold fields cleared", () => {
    const t = text(moveUpdateSql(base));
    expect(t).toContain("status = CASE WHEN \"service_requests\".\"status\" = 'pending'::request_status THEN 'assigned'::request_status WHEN (\"service_requests\".\"status\" IN ('en_route'::request_status, 'arrived'::request_status, 'in_progress'::request_status, 'on_hold'::request_status) AND \"service_requests\".\"hcp_job_id\" IS NULL AND EXISTS (SELECT 1 FROM appointment_assignments sa");
    expect(t).toContain("AND NOT EXISTS (SELECT 1 FROM appointment_assignments sa JOIN appointments sp ON sp.id = sa.appointment_id WHERE sp.service_request_id = \"service_requests\".\"id\" AND sp.organization_id = $");
    expect(t).toContain("THEN 'scheduled'::request_status ELSE \"service_requests\".\"status\" END, hold_reason = CASE WHEN (");
    expect(t).toContain("THEN NULL ELSE \"service_requests\".\"hold_reason\" END, follow_up_date = CASE WHEN (");
  });
  it("confirmed tokens drop their guards; no lead change drops the lead guards and the reset arm; no lead keeps NULL", () => {
    // The reset arm (two started subqueries) sits in three CASEs: 6 joins; the two started arms add 2 more.
    expect((text(moveUpdateSql(base)).match(/JOIN appointments sp/g) ?? []).length).toBe(8);
    const confirmed = text(moveUpdateSql({ ...base, confirmStarted: true, confirmConflict: true }));
    expect((confirmed.match(/JOIN appointments sp/g) ?? []).length).toBe(6);
    expect(confirmed).not.toContain("FROM appointment_assignments ca");
    expect(confirmed).toContain("FROM technician_shifts s"); // time off is never overridable
    const timeOnly = text(moveUpdateSql({ ...base, newLeadId: ALEX, leadChanges: false, checked: [ALEX] }));
    expect(timeOnly).not.toContain("FROM users u");
    expect(timeOnly).toContain("WHEN false THEN 'scheduled'::request_status");
    const unassigned = moveUpdateSql({ ...base, oldLeadId: null, newLeadId: null, leadChanges: false, checked: [] });
    expect(text(unassigned)).toMatch(/^UPDATE service_requests SET assigned_to = NULL,/);
    expect(text(unassigned)).toContain("status = CASE WHEN false THEN 'assigned'::request_status WHEN false THEN");
  });
});

describe("moveVisit", () => {
  it("a lead + window change: one batch [lock, update, cancel done old lead, revive, close old lead time, audit, version]; events and stamp after", async () => {
    m.readRows.mockResolvedValueOnce([stateRow()]).mockResolvedValueOnce([]);
    m.runBatch.mockResolvedValueOnce([[], [updated()], [], [], [], [{ id: "au" }], [{ id: V1, version: 4 }]]);
    const r = await moveVisit(ORG, USER, RID, body(), { now: NOW });
    expect(r).toEqual({ ok: true, pushes: true, data: {
      visitId: V1, visitVersion: 4, requestStatus: "scheduled", arrivalWindowStart: "2026-11-10T17:00:00.000Z",
      arrivalWindowEnd: "2026-11-10T21:00:00.000Z", leadId: SAM, confirmed: [],
    } });
    const statements = m.runBatch.mock.calls[0]![0] as SQL[];
    expect(statements).toHaveLength(7);
    expect(text(statements[0]!)).toContain("FOR NO KEY UPDATE");
    expect(text(statements[1]!)).toMatch(/^UPDATE service_requests/);
    expect(text(statements[2]!)).toMatch(/^UPDATE appointment_assignments a SET status = 'cancelled'::request_status/);
    expect(text(statements[3]!)).toMatch(/^UPDATE appointment_assignments a SET status = CASE WHEN r\.status/);
    expect(text(statements[4]!)).toMatch(/^UPDATE technician_time_entries t SET clock_out_at = now\(\)/);
    expect(text(statements[5]!)).toMatch(/^INSERT INTO audit_log/);
    expect(text(statements[5]!)).toContain("xp.xmin = pg_current_xact_id()::xid");
    expect(text(statements[6]!)).toMatch(/^SELECT id, version FROM appointments WHERE service_request_id = \$1::uuid AND organization_id = \$2::uuid AND appointment_number = 1$/);
    expect(m.event).not.toHaveBeenCalled(); // scheduled → scheduled, not a first assignment
    expect(m.stamp).toHaveBeenCalledWith(ORG, RID, SAM, USER);
  });

  it("a time-only move: [lock, update, audit, version]; no lead statements", async () => {
    m.readRows.mockResolvedValueOnce([stateRow()]).mockResolvedValueOnce([]);
    m.runBatch.mockResolvedValueOnce([[], [updated({ assigned_to: ALEX })], [{ id: "au" }], [{ id: V1, version: 4 }]]);
    const r = await moveVisit(ORG, USER, RID, body({ technicianId: undefined }), { now: NOW });
    expect(r.ok).toBe(true);
    expect((m.runBatch.mock.calls[0]![0] as SQL[])).toHaveLength(4);
    expect(m.active).not.toHaveBeenCalled();
  });

  it("an unconfirmed started visit answers 409 HAS_PROGRESS before any batch", async () => {
    m.readRows.mockResolvedValueOnce([stateRow({ status: "arrived", rows: [{ technicianId: ALEX, isLead: true, status: "arrived", hasTimestamp: true, openTimeEntry: true }] })]).mockResolvedValueOnce([]);
    const r = await moveVisit(ORG, USER, RID, body(), { now: NOW });
    expect(r).toMatchObject({ ok: false, status: 409, code: "HAS_PROGRESS", details: { needs: ["started"] } });
    expect(m.runBatch).not.toHaveBeenCalled();
  });

  it("time off of a checked technician → TIME_OFF before any batch", async () => {
    m.readRows.mockResolvedValueOnce([stateRow()]);
    m.timeOff.mockResolvedValueOnce([{ id: "s", technicianId: SAM, kind: "time_off", title: null, startsAt: "2026-11-10T19:00:00.000Z", endsAt: "2026-11-10T23:00:00.000Z", removesCapacity: true }]);
    const r = await moveVisit(ORG, USER, RID, body(), { now: NOW });
    expect(r).toMatchObject({ ok: false, code: "TIME_OFF", details: { timeOff: [{ technicianId: SAM, kind: "time_off" }] } });
    expect(m.runBatch).not.toHaveBeenCalled();
  });

  it("the test seam runs between the pre-read and the batch", async () => {
    const order: string[] = [];
    m.readRows.mockResolvedValueOnce([stateRow()]).mockResolvedValueOnce([]);
    m.runBatch.mockImplementationOnce(async () => { order.push("batch"); return [[], [updated()], [], [], [], [], [{ id: V1, version: 4 }]]; });
    await moveVisit(ORG, USER, RID, body(), { now: NOW, hooks: { afterPreRead: async () => { order.push("hook"); } } });
    expect(order).toEqual(["hook", "batch"]);
  });

  it("a 0-row batch re-reads and answers TECHNICIAN_NOT_FOUND (deactivated between pre-read and batch)", async () => {
    m.readRows.mockResolvedValueOnce([stateRow()]).mockResolvedValueOnce([]).mockResolvedValueOnce([stateRow()]);
    m.active.mockResolvedValueOnce([SAM]).mockResolvedValueOnce([]);
    m.runBatch.mockResolvedValueOnce([[], [], [], [], [], [], [{ id: V1, version: 3 }]]);
    expect(await moveVisit(ORG, USER, RID, body(), { now: NOW })).toMatchObject({ ok: false, code: "TECHNICIAN_NOT_FOUND" });
  });

  it("a 0-row batch whose re-read finds nothing failing → STALE; a deadlock → STALE", async () => {
    m.readRows.mockResolvedValueOnce([stateRow()]).mockResolvedValueOnce([]).mockResolvedValueOnce([stateRow()]).mockResolvedValueOnce([]);
    m.runBatch.mockResolvedValueOnce([[], [], [], [], [], [], [{ id: V1, version: 3 }]]);
    expect(await moveVisit(ORG, USER, RID, body(), { now: NOW })).toMatchObject({ ok: false, status: 409, code: "STALE", message: "This request changed. The calendar has been refreshed." });
    m.readRows.mockResolvedValueOnce([stateRow()]).mockResolvedValueOnce([]);
    m.runBatch.mockResolvedValueOnce({ ok: false, reason: "stale" });
    expect(await moveVisit(ORG, USER, RID, body(), { now: NOW })).toMatchObject({ code: "STALE" });
  });

  it("a first assignment records → assigned and stamps the pick", async () => {
    m.readRows.mockResolvedValueOnce([stateRow({ assigned_to: null, rows: [] })]).mockResolvedValueOnce([]);
    m.runBatch.mockResolvedValueOnce([[], [updated()], [], [{ id: "au" }], [{ id: V1, version: 4 }]]);
    await moveVisit(ORG, USER, RID, body(), { now: NOW });
    expect(m.runBatch.mock.calls[0]![0]).toHaveLength(5); // [lock, update, revive, audit, version]: no old lead
    expect(m.event).toHaveBeenCalledWith({ organizationId: ORG, serviceRequestId: RID, fromStatus: "scheduled", toStatus: "assigned", actorType: "human", actorId: USER });
  });
});
```

- [ ] **Step 4: Run them to verify they fail**

Run: `npx vitest run src/lib/admin/availability-coverage.test.ts src/lib/admin/visit-move-plan.test.ts src/lib/admin/visit-move.test.ts`
Expected: FAIL — unresolved imports / `isSpanWithinAvailability` is not a function.

- [ ] **Step 5: The span variant.** In `src/lib/admin/availability-coverage.ts`, replace

```ts
import { businessWallClockToUtc, toBusinessWallClock } from "./calendar-time";
```

with

```ts
import { businessIsoDate, businessMinutesOfDay, businessWallClockToUtc, toBusinessWallClock } from "./calendar-time";
```

and append:

```ts
/**
 * A span variant of isWindowWithinAvailability for any [start, end) (M2 spec
 * §5.3: kept and custom windows aren't bands). The span is read on its start's
 * business day; an end exactly at the next midnight counts as 1440; anything
 * later crosses midnight and is out of hours.
 */
export function isSpanWithinAvailability(
  slots: readonly AvailabilitySlot[],
  start: Date,
  end: Date,
): boolean {
  const isoDay = businessIsoDate(start);
  const winStart = businessMinutesOfDay(start);
  const endsAtMidnight = businessMinutesOfDay(end) === 0 && businessIsoDate(new Date(end.getTime() - 1)) === isoDay;
  if (!endsAtMidnight && businessIsoDate(end) !== isoDay) return false;
  const winEnd = endsAtMidnight ? 24 * MINUTES_PER_HOUR : businessMinutesOfDay(end);
  const weekday = businessWeekday(isoDay);
  if (slots.length === 0) {
    return DEFAULT_BUSINESS_WEEKDAYS.has(weekday) && spanIsCovered([DEFAULT_BUSINESS_DAY], winStart, winEnd);
  }
  return spanIsCovered(slots.filter((slot) => slot.dayOfWeek === weekday), winStart, winEnd);
}
```

- [ ] **Step 6: The decisions** — `src/lib/admin/visit-move-plan.ts`:

```ts
/**
 * moveVisit's decisions (M2 spec §5.2–§5.3), pure: the parsed pre-read, the
 * refusals in the spec's order (lead ruling 8), the resolved window, what the
 * move must confirm, the audit details and the status events.
 */
import { moveNeeds, type NeedsRow } from "./board-move";
import { businessIsoDate } from "./calendar-time";
import { rowStarted } from "./visit-started";
import { FIELDPULSE_BOARD, moveErrorBanner } from "./dispatch-copy";
import { namedWindowOf, resolveMoveWindow, windowEqual, windowHasEndedAt, type TimeWindow } from "./move-window";
import { WINDOW_ENDED_MESSAGE } from "./window-ended";
import type { ConflictDetail, MoveBody, MoveConfirm, MoveNeedsDetails, StartedDetail, TimeOffDetail } from "./board-types";

export type MoveCode =
  | "NOT_FOUND" | "REQUEST_TERMINAL" | "VISIT_ENDED" | "VISIT_PINNED" | "STALE" | "MANAGED_EXTERNALLY"
  | "VALIDATION_ERROR" | "TECHNICIAN_NOT_FOUND" | "TECHNICIAN_DONE" | "WINDOW_ENDED" | "TIME_OFF" | "HAS_PROGRESS" | "SCHEDULE_CONFLICT";

export interface MoveRefusal {
  readonly ok: false;
  readonly status: 400 | 404 | 409;
  readonly code: MoveCode;
  readonly message: string;
  readonly details?: unknown;
}

export interface MoveRow extends NeedsRow {
  readonly openTimeEntry: boolean;
}

export interface MoveState {
  readonly status: string;
  readonly assignedTo: string | null;
  readonly fieldpulse: boolean;
  /** Neither FieldPulse nor Housecall Pro (the override reset is native-only, lead ruling 6). */
  readonly native: boolean;
  /** The request's window (= visit #1's). */
  readonly window: TimeWindow | null;
  readonly visitOneId: string | null;
  readonly visitOneVersion: number | null;
  readonly visitOneCancelled: boolean;
  /** A hold ended the request's visits (visitEndedSql). */
  readonly ended: boolean;
  /** The displayed visit's number; null when no visit is displayed (e.g. an unassigned #1). */
  readonly displayedNumber: number | null;
  /** Live rows on visit #1. */
  readonly rows: readonly MoveRow[];
}

export interface MovePlan {
  readonly ok: true;
  readonly window: TimeWindow;
  readonly windowChanges: boolean;
  readonly leadChanges: boolean;
  readonly dayChanged: boolean;
  readonly oldLeadId: string | null;
  readonly newLeadId: string | null;
  readonly checked: readonly string[];
  readonly needsStarted: boolean;
  readonly started: readonly StartedDetail[];
  /** A live row other than the current lead's is started (the client's reset prediction, critic A m2). */
  readonly othersStarted: boolean;
}

const refuse = (status: MoveRefusal["status"], code: MoveCode, message: string, details?: unknown): MoveRefusal =>
  details === undefined ? { ok: false, status, code, message } : { ok: false, status, code, message, details };

const asDate = (v: unknown): Date | null => {
  if (v === null || v === undefined) return null;
  const d = new Date(v as string);
  return Number.isNaN(d.getTime()) ? null : d;
};

function jsonArray(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (typeof v !== "string") return [];
  try {
    const parsed: unknown = JSON.parse(v);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

/** moveStateSql's row → MoveState (null when the request isn't in the org). */
export function parseMoveState(row: Record<string, unknown> | undefined): MoveState | null {
  if (!row) return null;
  const start = asDate(row.window_start);
  const end = asDate(row.window_end);
  return {
    status: String(row.status),
    assignedTo: (row.assigned_to as string | null | undefined) ?? null,
    fieldpulse: row.fieldpulse === true,
    native: row.fieldpulse !== true && row.hcp !== true,
    window: start && end ? { start, end } : null,
    visitOneId: (row.v1_id as string | null | undefined) ?? null,
    visitOneVersion: row.v1_version === null || row.v1_version === undefined ? null : Number(row.v1_version),
    visitOneCancelled: row.v1_cancelled === true,
    ended: row.ended === true,
    displayedNumber: row.displayed_number === null || row.displayed_number === undefined ? null : Number(row.displayed_number),
    rows: jsonArray(row.rows).map((r) => {
      const o = r as Record<string, unknown>;
      return {
        technicianId: String(o.technicianId),
        isLead: o.isLead === true,
        status: String(o.status),
        hasTimestamp: o.hasTimestamp === true,
        openTimeEntry: o.openTimeEntry === true,
      };
    }),
  };
}

/**
 * Refusals in the spec's order: 404, REQUEST_TERMINAL, VISIT_ENDED,
 * VISIT_PINNED, STALE, MANAGED_EXTERNALLY, VALIDATION_ERROR (keep with no
 * window), TECHNICIAN_NOT_FOUND, TECHNICIAN_DONE, WINDOW_ENDED. TIME_OFF and
 * the needs follow in visit-move.ts (they need queries). `facts.newLeadActive`
 * is the caller's activeTechnicianIds answer for a requested lead change.
 */
export function planMove(state: MoveState | null, body: MoveBody, now: Date, facts: { readonly newLeadActive: boolean }): MovePlan | MoveRefusal {
  if (!state) return refuse(404, "NOT_FOUND", "Request not found");
  if (state.status === "completed" || state.status === "cancelled") {
    return refuse(409, "REQUEST_TERMINAL", moveErrorBanner("REQUEST_TERMINAL", { status: state.status }), { status: state.status });
  }
  const pinned = !state.ended && (state.displayedNumber ?? 1) > 1;
  if (state.ended || (!pinned && state.visitOneCancelled)) return refuse(409, "VISIT_ENDED", moveErrorBanner("VISIT_ENDED"));
  if (pinned) {
    return refuse(409, "VISIT_PINNED", moveErrorBanner("VISIT_PINNED", { visitNumber: state.displayedNumber }), { visitNumber: state.displayedNumber });
  }
  const visitId = body.visitId?.toLowerCase() ?? null;
  const fresh = visitId === null
    ? state.visitOneId === null
    : visitId === state.visitOneId && body.expectedVersion === state.visitOneVersion;
  if (!fresh) return refuse(409, "STALE", moveErrorBanner("STALE"));
  if (state.fieldpulse) return refuse(409, "MANAGED_EXTERNALLY", FIELDPULSE_BOARD);

  const resolved = resolveMoveWindow(state.window, body.day, body.band, body.windowRule, body.pick);
  if (!resolved.ok) {
    return refuse(400, "VALIDATION_ERROR", "Choose a window.", { path: [body.windowRule === "pick" ? "pick" : "windowRule"] });
  }
  const window: TimeWindow = { start: resolved.start, end: resolved.end };
  const requested = body.technicianId?.toLowerCase();
  const leadChanges = requested !== undefined && requested !== state.assignedTo;
  const newLeadId = leadChanges ? requested! : state.assignedTo;
  if (leadChanges && !facts.newLeadActive) return refuse(409, "TECHNICIAN_NOT_FOUND", moveErrorBanner("TECHNICIAN_NOT_FOUND"));
  if (leadChanges && state.rows.some((r) => r.technicianId === newLeadId && r.status === "completed")) {
    return refuse(409, "TECHNICIAN_DONE", "That technician has finished on this visit.", { technicianId: newLeadId });
  }
  const windowChanges = !state.window || !windowEqual(state.window, window);
  if (windowChanges && windowHasEndedAt(window, now)) return refuse(400, "WINDOW_ENDED", WINDOW_ENDED_MESSAGE);

  const needs = moveNeeds({ leadChanges, windowChanges, currentLeadId: state.assignedTo, newLeadId, rows: state.rows });
  const started: StartedDetail[] = needs.startedRows.map((r) => ({
    technicianId: r.technicianId,
    status: r.status,
    hasTimestamp: r.hasTimestamp,
    openTimeEntry: state.rows.find((x) => x.technicianId === r.technicianId)?.openTimeEntry ?? false,
  }));
  return {
    ok: true,
    window,
    windowChanges,
    leadChanges,
    dayChanged: !state.window || businessIsoDate(state.window.start) !== body.day,
    oldLeadId: state.assignedTo,
    newLeadId,
    checked: needs.checked,
    needsStarted: needs.started,
    started,
    othersStarted: state.rows.some((r) => r.technicianId !== state.assignedTo && rowStarted(r)),
  };
}

/** Unconfirmed needs → 409 HAS_PROGRESS (started among them) or SCHEDULE_CONFLICT; else the confirmed tokens that were needed. */
export function moveNeedsResult(
  plan: MovePlan,
  checks: { readonly conflicts: readonly ConflictDetail[]; readonly outsideAvailability: boolean },
  confirm: readonly MoveConfirm[],
): { readonly refusal: MoveRefusal | null; readonly confirmed: MoveConfirm[] } {
  const conflictNeeded = checks.conflicts.length > 0 || checks.outsideAvailability;
  const needs: MoveConfirm[] = [];
  if (plan.needsStarted && !confirm.includes("started")) needs.push("started");
  if (conflictNeeded && !confirm.includes("conflict")) needs.push("conflict");
  const confirmed: MoveConfirm[] = [];
  if (plan.needsStarted && confirm.includes("started")) confirmed.push("started");
  if (conflictNeeded && confirm.includes("conflict")) confirmed.push("conflict");
  if (needs.length === 0) return { refusal: null, confirmed };
  const details: MoveNeedsDetails = {
    needs,
    ...(plan.needsStarted ? { started: plan.started, othersStarted: plan.othersStarted } : {}),
    ...(checks.conflicts.length > 0 ? { conflicts: checks.conflicts } : {}),
    ...(checks.outsideAvailability ? { outsideAvailability: true } : {}),
  };
  const refusal = needs.includes("started")
    ? refuse(409, "HAS_PROGRESS", "A technician has started this visit.", details)
    : refuse(409, "SCHEDULE_CONFLICT", "This time overlaps another request or is outside the technician’s hours.", details);
  return { refusal, confirmed };
}

/** TIME_OFF is never overridable: details carry the blocks, never `needs` (spec §5.3). */
export function timeOffRefusal(hits: readonly TimeOffDetail[]): MoveRefusal {
  return refuse(409, "TIME_OFF", "A technician on this move is off then.", {
    timeOff: hits.map(({ technicianId, startsAt, endsAt, kind }) => ({ technicianId, startsAt, endsAt, kind })),
  });
}

/** Audit `visit_moved` details: ids, enums, booleans and counts only (spec §5.3). */
export function moveAuditDetails(p: {
  readonly requestId: string;
  readonly plan: MovePlan;
  readonly body: MoveBody;
  readonly confirmed: readonly MoveConfirm[];
  readonly conflictCount: number;
  readonly outsideAvailability: boolean;
}): Record<string, unknown> {
  const named = namedWindowOf(p.plan.window.start, p.plan.window.end);
  return {
    requestId: p.requestId,
    fromTechnicianId: p.plan.oldLeadId,
    toTechnicianId: p.plan.newLeadId,
    windowRule: p.body.windowRule,
    window: named ?? "custom",
    dayChanged: p.plan.dayChanged,
    confirmed: [...p.confirmed],
    startedStatuses: p.plan.started.map((s) => s.status),
    conflictCount: p.conflictCount,
    outsideAvailability: p.outsideAvailability,
  };
}

/** Status events after a move (lead ruling 7). */
export function moveEvents(from: string, to: string, oldLeadId: string | null, newLeadId: string | null): { from: string; to: string }[] {
  const first = oldLeadId === null && newLeadId !== null;
  const out: { from: string; to: string }[] = [];
  if (first) out.push({ from, to: "assigned" });
  if (to !== from && !(first && to === "assigned")) out.push({ from, to });
  return out;
}
```

- [ ] **Step 7: The writer** — `src/lib/admin/visit-move.ts`:

```ts
/**
 * moveVisit (M2 spec §5.3): the board's single move. One pre-read query, the
 * pure decisions (visit-move-plan.ts), the time-off / overlap / hours checks,
 * then ONE batch led by L_req: the guarded UPDATE of the request (every
 * pre-read check has its SQL twin there) that the trigger mirrors onto visit
 * #1, then — on a lead change — cancel a kept `completed` old lead, revive the
 * new lead's row clean, stop the old lead's open time, all gated on the
 * request's xmin; then the audit row (gated on #1's xmin) and #1's new version.
 * A 0-row UPDATE re-reads and re-decides; nothing failing → STALE. No message
 * to anyone; no FieldPulse call. Pushes are the route's (registerRequestPushes).
 */
import { sql, type SQL } from "drizzle-orm";
import { lockRequestSql, readRows, runBatch } from "./invoice-field-writes";
import { activeTechnicianIds, noTimeOff } from "./appointment-queries";
import { technicianTimeOffOverlapping } from "./shift-queries";
import { getTechnicianAvailability } from "./scheduling-queries";
import { isSpanWithinAvailability } from "./availability-coverage";
import { recordStatusEvent } from "./status-events";
import { stampDispatchOverride } from "./dispatch-override";
import { displayVisitIdSql, visitEndedSql } from "./current-visit";
import { anyTimestampSql } from "./visit-started";
import { STALE_LINE } from "./dispatch-copy";
import type { RequestStatus } from "./request-status";
import {
  activeTechnicianSql, cancelDoneOldLeadSql, closeOldLeadEntriesSql, fieldpulseFreeSql, leadDoneSql, noOverlapSql,
  otherStartedOnVisitOneSql, overlapFromWhereSql, requestXminGateSql, resetFromSql, reviveLeadSql,
  startedOnVisitOneSql, versionGateSql, visitOneLiveSql,
} from "./visit-move-sql";
import {
  moveAuditDetails, moveEvents, moveNeedsResult, parseMoveState, planMove, timeOffRefusal,
  type MovePlan, type MoveRefusal, type MoveState,
} from "./visit-move-plan";
import type { ConflictDetail, MoveBody, MoveConfirm, MoveSuccessData } from "./board-types";

export type { MoveCode, MoveRefusal } from "./visit-move-plan";

export type MoveResult =
  | { readonly ok: true; readonly data: MoveSuccessData; readonly pushes: boolean }
  | MoveRefusal;

// ---------------------------------------------------------------- SQL builders

/** The one pre-read (spec §5.3): request, visit #1, displayed visit, live rows on #1 with their open time. */
export function moveStateSql(org: string, rid: string): SQL {
  return sql`SELECT "service_requests"."status" AS status, "service_requests"."assigned_to" AS assigned_to,
      ("service_requests"."fieldpulse_job_id" IS NOT NULL) AS fieldpulse, ("service_requests"."hcp_job_id" IS NOT NULL) AS hcp,
      "service_requests"."arrival_window_start" AS window_start, "service_requests"."arrival_window_end" AS window_end,
      ${visitEndedSql()} AS ended,
      (SELECT dv.appointment_number FROM appointments dv WHERE dv.id = ${displayVisitIdSql()} AND dv.organization_id = ${org}::uuid) AS displayed_number,
      v1.id AS v1_id, v1.version AS v1_version, (v1.cancelled_at IS NOT NULL) AS v1_cancelled,
      COALESCE((SELECT json_agg(json_build_object('technicianId', a.technician_id, 'isLead', a.is_lead, 'status', a.status,
          'hasTimestamp', ${anyTimestampSql("a")},
          'openTimeEntry', EXISTS (SELECT 1 FROM technician_time_entries t WHERE t.organization_id = ${org}::uuid
            AND t.service_request_id = "service_requests"."id" AND t.technician_id = a.technician_id AND t.kind = 'job' AND t.clock_out_at IS NULL
            AND (t.appointment_id = v1.id OR t.appointment_id IS NULL))))
        FROM appointment_assignments a WHERE a.appointment_id = v1.id AND a.organization_id = ${org}::uuid AND a.status <> 'cancelled'::request_status), '[]'::json) AS rows
    FROM service_requests
    LEFT JOIN appointments v1 ON v1.service_request_id = "service_requests"."id" AND v1.organization_id = ${org}::uuid AND v1.appointment_number = 1
    WHERE "service_requests"."id" = ${rid}::uuid AND "service_requests"."organization_id" = ${org}::uuid`;
}

/** The overlapping rows for the confirm dialog (same FROM … WHERE as the in-write twin). */
export function overlapRowsSql(org: string, rid: string, technicianIds: readonly string[], startIso: string, endIso: string): SQL {
  return sql`SELECT DISTINCT cr.id, cr.reference_number, ca.technician_id, cp.arrival_window_start, cp.arrival_window_end
    ${overlapFromWhereSql(org, rid, technicianIds, startIso, endIso)}
    ORDER BY cp.arrival_window_start LIMIT 20`;
}

export interface MoveUpdateParams {
  readonly org: string;
  readonly rid: string;
  readonly visitId: string | null;
  readonly expectedVersion: number | null;
  readonly start: Date;
  readonly end: Date;
  readonly oldLeadId: string | null;
  readonly newLeadId: string | null;
  readonly leadChanges: boolean;
  readonly windowChanges: boolean;
  readonly checked: readonly string[];
  readonly confirmStarted: boolean;
  readonly confirmConflict: boolean;
  /** More guards ANDed in (mass reschedule: the lead is T, the visit starts on D, no audit row yet). */
  readonly extra?: readonly SQL[];
  /** Mass reschedule: the run's other requests, excluded from the overlap twin (they move together). */
  readonly excludeRequestIds?: readonly string[];
}

/** Step 1 (spec §5.3): every guard is the SQL twin of a pre-read check. */
export function moveUpdateSql(p: MoveUpdateParams): SQL {
  const startIso = p.start.toISOString();
  const endIso = p.end.toISOString();
  const guards: SQL[] = [
    sql`"service_requests"."id" = ${p.rid}::uuid`,
    sql`"service_requests"."organization_id" = ${p.org}::uuid`,
    fieldpulseFreeSql(),
    sql`"service_requests"."status" NOT IN ('completed'::request_status, 'cancelled'::request_status)`,
    versionGateSql(p.org, p.rid, p.visitId, p.expectedVersion),
    visitOneLiveSql(p.org),
  ];
  if (p.leadChanges && p.newLeadId) {
    guards.push(activeTechnicianSql(p.org, p.newLeadId));
    guards.push(sql`NOT ${leadDoneSql(p.org, p.newLeadId)}`);
  }
  if (p.checked.length > 0) guards.push(noTimeOff(p.org, p.checked, startIso, endIso));
  if (!p.confirmStarted) {
    const arms: SQL[] = [];
    if (p.leadChanges) arms.push(startedOnVisitOneSql(p.org, "lead"));
    if (p.windowChanges) arms.push(startedOnVisitOneSql(p.org, "any"));
    if (arms.length > 0) guards.push(sql`NOT (${sql.join(arms, sql` OR `)})`);
  }
  if (!p.confirmConflict && p.checked.length > 0) guards.push(noOverlapSql(p.org, p.rid, p.checked, startIso, endIso, p.excludeRequestIds ?? []));
  guards.push(...(p.extra ?? []));

  const lead = p.newLeadId ? sql`${p.newLeadId}::uuid` : sql`NULL`;
  const pendingArm = p.newLeadId ? sql`"service_requests"."status" = 'pending'::request_status` : sql`false`;
  const resetArm = p.leadChanges && p.oldLeadId
    ? sql`("service_requests"."status" IN (${resetFromSql()}) AND "service_requests"."hcp_job_id" IS NULL AND ${startedOnVisitOneSql(p.org, "lead")} AND NOT ${otherStartedOnVisitOneSql(p.org, p.oldLeadId)})`
    : sql`false`;
  return sql`UPDATE service_requests SET assigned_to = ${lead}, scheduled_date = ${startIso}::timestamptz,
      arrival_window_start = ${startIso}::timestamptz, arrival_window_end = ${endIso}::timestamptz,
      status = CASE WHEN ${pendingArm} THEN 'assigned'::request_status WHEN ${resetArm} THEN 'scheduled'::request_status ELSE "service_requests"."status" END,
      hold_reason = CASE WHEN ${resetArm} THEN NULL ELSE "service_requests"."hold_reason" END,
      follow_up_date = CASE WHEN ${resetArm} THEN NULL ELSE "service_requests"."follow_up_date" END,
      updated_at = now()
    WHERE ${sql.join(guards, sql` AND `)}
    RETURNING id, status, assigned_to, arrival_window_start, arrival_window_end`;
}

/** Step 5: the audit row, only when THIS transaction wrote visit #1 (the trigger's bump). */
export function moveAuditSql(org: string, rid: string, actorUserId: string, details: Record<string, unknown>): SQL {
  return sql`INSERT INTO audit_log (organization_id, user_id, actor_type, action, entity, entity_id, details)
    SELECT ${org}::uuid, ${actorUserId}::uuid, 'human', 'visit_moved', 'appointment', xp.id, ${JSON.stringify(details)}
    FROM appointments xp
    WHERE xp.service_request_id = ${rid}::uuid AND xp.organization_id = ${org}::uuid AND xp.appointment_number = 1
      AND xp.xmin = pg_current_xact_id()::xid
    RETURNING id`;
}

/** Step 6: visit #1's version after the trigger, for the 200. */
export function visitOneVersionSql(org: string, rid: string): SQL {
  return sql`SELECT id, version FROM appointments WHERE service_request_id = ${rid}::uuid AND organization_id = ${org}::uuid AND appointment_number = 1`;
}

// ---------------------------------------------------------------- writer

type Row = Record<string, unknown>;
const iso = (v: unknown): string => new Date(v as string).toISOString();
const stale = (): MoveRefusal => ({ ok: false, status: 409, code: "STALE", message: STALE_LINE });

interface Decided {
  readonly ok: true;
  readonly state: MoveState;
  readonly plan: MovePlan;
  readonly confirmed: MoveConfirm[];
  readonly conflictCount: number;
  readonly outsideAvailability: boolean;
}

function parseConflicts(rows: readonly Row[]): ConflictDetail[] {
  return rows.map((r) => ({
    id: String(r.id),
    referenceNumber: String(r.reference_number),
    technicianId: String(r.technician_id),
    arrivalWindowStart: iso(r.arrival_window_start),
    arrivalWindowEnd: iso(r.arrival_window_end),
  }));
}

/** Pre-read → refusal or a plan with its checks (also the re-read after a 0-row batch). */
async function decide(org: string, rid: string, body: MoveBody, now: Date): Promise<Decided | MoveRefusal> {
  const state = parseMoveState((await readRows(moveStateSql(org, rid)))[0]);
  const requested = body.technicianId?.toLowerCase();
  const newLeadActive = state && requested && requested !== state.assignedTo
    ? (await activeTechnicianIds(org, [requested])).length === 1
    : true;
  const plan = planMove(state, body, now, { newLeadActive });
  if (!plan.ok) return plan;

  const hits = (await Promise.all(
    plan.checked.map((id) => technicianTimeOffOverlapping(org, id, plan.window.start, plan.window.end)),
  )).flat();
  if (hits.length > 0) return timeOffRefusal(hits);

  const conflicts = plan.checked.length > 0
    ? parseConflicts(await readRows(overlapRowsSql(org, rid, plan.checked, plan.window.start.toISOString(), plan.window.end.toISOString())))
    : [];
  const lead = plan.newLeadId;
  const outsideAvailability = lead !== null && plan.checked.includes(lead)
    ? !isSpanWithinAvailability(await getTechnicianAvailability(org, lead), plan.window.start, plan.window.end)
    : false;
  const verdict = moveNeedsResult(plan, { conflicts, outsideAvailability }, body.confirm);
  if (verdict.refusal) return verdict.refusal;
  return { ok: true, state: state!, plan, confirmed: verdict.confirmed, conflictCount: conflicts.length, outsideAvailability };
}

export async function moveVisit(
  org: string,
  actorUserId: string,
  requestId: string,
  body: MoveBody,
  opts: { readonly now?: Date; readonly hooks?: { readonly afterPreRead?: () => Promise<void> } } = {},
): Promise<MoveResult> {
  const now = opts.now ?? new Date();
  const rid = requestId.toLowerCase();
  const decided = await decide(org, rid, body, now);
  if (!decided.ok) return decided;
  await opts.hooks?.afterPreRead?.();

  const { plan, state, confirmed } = decided;
  const gate = requestXminGateSql(org, rid);
  const statements: SQL[] = [
    lockRequestSql(org, rid),
    moveUpdateSql({
      org, rid, visitId: body.visitId?.toLowerCase() ?? null, expectedVersion: body.expectedVersion,
      start: plan.window.start, end: plan.window.end, oldLeadId: plan.oldLeadId, newLeadId: plan.newLeadId,
      leadChanges: plan.leadChanges, windowChanges: plan.windowChanges, checked: plan.checked,
      confirmStarted: body.confirm.includes("started"), confirmConflict: body.confirm.includes("conflict"),
    }),
  ];
  if (plan.leadChanges && plan.oldLeadId) statements.push(cancelDoneOldLeadSql(org, rid, plan.oldLeadId, gate));
  if (plan.leadChanges && plan.newLeadId) statements.push(reviveLeadSql(org, rid, gate));
  if (plan.leadChanges && plan.oldLeadId) statements.push(closeOldLeadEntriesSql(org, rid, plan.oldLeadId, gate));
  statements.push(moveAuditSql(org, rid, actorUserId, moveAuditDetails({
    requestId: rid, plan, body, confirmed, conflictCount: decided.conflictCount, outsideAvailability: decided.outsideAvailability,
  })));
  statements.push(visitOneVersionSql(org, rid));

  const rows = await runBatch(statements);
  if (!Array.isArray(rows)) return stale(); // deadlock
  const updated = rows[1]![0];
  if (!updated) {
    const again = await decide(org, rid, body, now);
    return again.ok ? stale() : again;
  }
  const visit = rows[rows.length - 1]![0];
  if (!visit) throw new Error("visit #1 missing after a move");

  // Best-effort, after the commit (as placeAndAssignRequest): events and override telemetry.
  const toStatus = String(updated.status);
  for (const e of moveEvents(state.status, toStatus, plan.oldLeadId, plan.newLeadId)) {
    await recordStatusEvent({
      organizationId: org, serviceRequestId: rid, fromStatus: e.from as RequestStatus, toStatus: e.to as RequestStatus,
      actorType: "human", actorId: actorUserId,
    });
  }
  if (plan.newLeadId) await stampDispatchOverride(org, rid, plan.newLeadId, actorUserId);

  return {
    ok: true,
    pushes: plan.windowChanges || plan.leadChanges,
    data: {
      visitId: String(visit.id),
      visitVersion: Number(visit.version),
      requestStatus: toStatus,
      arrivalWindowStart: iso(updated.arrival_window_start),
      arrivalWindowEnd: iso(updated.arrival_window_end),
      leadId: (updated.assigned_to as string | null) ?? null,
      confirmed,
    },
  };
}
```

`technicianTimeOffOverlapping` returns `ShiftRecord`s, which carry `technicianId`, `startsAt`, `endsAt` and `kind`: `timeOffRefusal` keeps only those four keys.

- [ ] **Step 8: Run the tests to verify they pass**

Run: `npx vitest run src/lib/admin/availability-coverage.test.ts src/lib/admin/visit-move-plan.test.ts src/lib/admin/visit-move.test.ts`
Expected: PASS.

- [ ] **Step 9: Gates and commit**

```bash
npx tsc --noEmit && npx eslint src/lib/admin/visit-move-plan.ts src/lib/admin/visit-move-plan.test.ts src/lib/admin/visit-move.ts src/lib/admin/visit-move.test.ts src/lib/admin/availability-coverage.ts src/lib/admin/availability-coverage.test.ts && npx vitest run
git add src/lib/admin/visit-move-plan.ts src/lib/admin/visit-move-plan.test.ts src/lib/admin/visit-move.ts src/lib/admin/visit-move.test.ts src/lib/admin/availability-coverage.ts src/lib/admin/availability-coverage.test.ts
git commit -m "$(cat <<'EOF'
feat(m2): moveVisit, the board's guarded single-batch move

One pre-read, refusals in the spec's order, time off and overlaps for the
technicians the move assigns, then L_req + a guarded request UPDATE (version
gate on id and version, FieldPulse, started arms, no time off, no overlap,
active lead not done) + gated follow-ons (cancel a kept done lead, revive the
new lead clean, stop the old lead's time) + the audit row + the version.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01GuWoF63tQU1i7ELqyYU3A6
EOF
)"
```

---
### Task 6: Mass reschedule — preview, keyed commit, SQL-computed audit, recovery

**Files:**
- Create: `src/lib/admin/mass-reschedule.ts`, `src/lib/admin/mass-reschedule.test.ts`
- Modify: `src/lib/admin/shift-queries.ts` (+`listShiftsInRange`)

**Interfaces:**
- Consumes: Task 1 (`keepWindowOn`), Task 2 (`classifyMassVisit`, `massDayShift`, `moveNeeds`, `MassCandidate`, `MassResult`, `MASS_PRESKIP_REASONS`), Task 3 (`cancelDoneOldLeadSql`, `reviveLeadSql`, `closeOldLeadEntriesSql`, `requestXminGateSql`), Task 5 (`moveUpdateSql` with `extra`, `isSpanWithinAvailability`). Existing: `readRows`, `runBatch` (`invoice-field-writes.ts`), `RunResult` (`@/lib/http/idempotency`), `getTechnicianAvailability`, `displayVisitIdSql`, `visitEndedSql`, `businessDayBounds`, `isRealIsoDate`, `businessIsoDate`, `decrypt` (`@/lib/crypto`), `syncRequestToCalendar`, `pushJobToHcp`, `getHousecallConfig` (`@/lib/integrations/housecall-pro/config`), `recordStatusEvent`, `stampDispatchOverride`.
- Produces:
  - `shift-queries.ts`: `listShiftsInRange(org, startIso, endIso): Promise<readonly ShiftRecord[]>` — every kind, org-wide, half-open overlap, `starts_at` order (lead ruling 2). Task 7 uses it for the day view's blocks.
  - `mass-reschedule.ts`: `MassQuery`, `MassCommitBody`, `massQuerySchema`, `massCommitSchema`, `massDateInRange(iso, today)`, `massDayVisitsSql(…)`, `massLockSql(…)`, `massAuditSql(…)`, `previewMassReschedule(org, q, now?)`, `commitMassReschedule(org, actorUserId, body, auditId, schedule?, now?)` → `RunResult` (200 `data` = `MassResult`).
- Recovery (spec §4.2, lead reading recorded in Task 11's docs): a re-run whose audit row exists writes nothing, rebuilds the 200 from that row and current versions, and schedules only `syncRequestToCalendar` for every moved request and `pushJobToHcp` for moved requests that already have `hcp_job_id`; `pushesNotSent` lists moved requests with no `hcp_job_id` when the org has a Housecall Pro config. A fresh run schedules the §5.3 after-calls (events for a status change, `stampDispatchOverride` when T2 is set, both pushes) and returns `pushesNotSent: []`.

- [ ] **Step 1: `listShiftsInRange`.** Append to `src/lib/admin/shift-queries.ts`:

```ts
/** Every shift (all kinds) overlapping [start, end) across the org, half-open (M2 spec §7.1 day-view blocks). */
export async function listShiftsInRange(
  organizationId: string,
  startIso: string,
  endIso: string,
): Promise<readonly ShiftRecord[]> {
  const rows = await db
    .select()
    .from(technicianShifts)
    .where(
      withTenant(
        technicianShifts,
        organizationId,
        lt(technicianShifts.startsAt, new Date(endIso)),
        gt(technicianShifts.endsAt, new Date(startIso)),
      ),
    )
    .orderBy(asc(technicianShifts.startsAt));
  return rows.map(toShiftRecord);
}
```

(`lt`, `gt`, `asc`, `withTenant`, `technicianShifts`, `toShiftRecord` are already imported or defined in that file.)

- [ ] **Step 2: Write the failing tests** — `src/lib/admin/mass-reschedule.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

const m = vi.hoisted(() => ({
  readRows: vi.fn(), runBatch: vi.fn(), shifts: vi.fn(), availability: vi.fn(),
  sync: vi.fn(), hcp: vi.fn(), hcpConfig: vi.fn(), event: vi.fn(), stamp: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/crypto", () => ({ decrypt: (v: string) => `dec(${v})` }));
vi.mock("./invoice-field-writes", async (orig) => ({ ...(await orig<typeof import("./invoice-field-writes")>()), readRows: m.readRows, runBatch: m.runBatch }));
vi.mock("./shift-queries", () => ({ listShiftsInRange: m.shifts, technicianTimeOffOverlapping: vi.fn(async () => []) }));
vi.mock("./scheduling-queries", () => ({ getTechnicianAvailability: m.availability }));
vi.mock("@/lib/integrations/google-calendar/sync", () => ({ syncRequestToCalendar: m.sync }));
vi.mock("@/lib/integrations/housecall-pro/job-sync", () => ({ pushJobToHcp: m.hcp }));
vi.mock("@/lib/integrations/housecall-pro/config", () => ({ getHousecallConfig: m.hcpConfig }));
vi.mock("./status-events", () => ({ recordStatusEvent: m.event }));
vi.mock("./dispatch-override", () => ({ stampDispatchOverride: m.stamp }));

import {
  commitMassReschedule, massAuditSql, massCommitSchema, massDateInRange, massDayVisitsSql, massLockSql, previewMassReschedule,
  type MassCommitBody,
} from "./mass-reschedule";

const ORG = "00000000-0000-4000-8000-0000000000aa";
const T = "a1111111-1111-4111-8111-111111111111";
const T2 = "b2222222-2222-4222-8222-222222222222";
const USER = "e5555555-5555-4555-8555-555555555555";
const AUDIT = "f6666666-6666-4666-8666-666666666666";
const v = (n: number) => `c${n}333333-3333-4333-8333-33333333333${n}`;
const r = (n: number) => `d${n}444444-4444-4444-8444-44444444444${n}`;
const NOW = new Date("2026-11-09T12:00:00.000Z");
const text = (s: SQL) => new PgDialect().sqlToQuery(s).sql.replace(/\s+/g, " ");
const params = (s: SQL) => new PgDialect().sqlToQuery(s).params;

/** One row of massDayVisitsSql. */
const dayRow = (n: number, over: Record<string, unknown> = {}) => ({
  visit_id: v(n), request_id: r(n), appointment_number: 1, version: 2, reference_number: `HVAC-${n}`,
  arrival_window_start: "2026-11-10T14:00:00.000Z", arrival_window_end: "2026-11-10T16:00:00.000Z",
  ended: false, fieldpulse: false, hcp: false, tech_is_lead: true, lead_name: "Alex Rivera", request_status: "scheduled",
  name_enc: `enc${n}`, customer_name_enc: null, to_tech_on_visit: false,
  rows: [{ technicianId: T, isLead: true, status: "scheduled", hasTimestamp: false }], ...over,
});
const body = (over: Partial<MassCommitBody> = {}): MassCommitBody => ({
  technicianId: T, fromDate: "2026-11-10", toDate: "2026-11-11", toTechnicianId: T2,
  visits: [{ visitId: v(1), expectedVersion: 2 }, { visitId: v(2), expectedVersion: 2 }],
  preSkipped: [{ visitId: v(3), reason: "started" }], confirmConflict: false, ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  m.shifts.mockResolvedValue([]);
  m.availability.mockResolvedValue([]);
  m.hcpConfig.mockResolvedValue(null);
});

describe("schemas and dates", () => {
  it("1–30 visits, unique ids, reasons from the enum", () => {
    expect(massCommitSchema.safeParse(body()).success).toBe(true);
    const many = Array.from({ length: 31 }, (_, i) => ({ visitId: `${String(i).padStart(8, "0")}-0000-4000-8000-000000000000`, expectedVersion: 0 }));
    expect(massCommitSchema.safeParse(body({ visits: many })).success).toBe(false); // a 31st visit is refused
    expect(massCommitSchema.safeParse(body({ visits: [] })).success).toBe(false);
    expect(massCommitSchema.safeParse(body({ visits: [{ visitId: v(1), expectedVersion: 2 }, { visitId: v(1), expectedVersion: 2 }] })).success).toBe(false); // duplicate visit ids are refused
    expect(massCommitSchema.safeParse({ ...body(), preSkipped: [{ visitId: v(3), reason: "forged" }] }).success).toBe(false);
  });
  it("dates: real ISO days, today − 1 … today + 365", () => {
    expect(massDateInRange("2026-11-08", "2026-11-09")).toBe(true);
    expect(massDateInRange("2026-11-07", "2026-11-09")).toBe(false);
    expect(massDateInRange("2027-11-09", "2026-11-09")).toBe(true);
    expect(massDateInRange("2027-11-10", "2026-11-09")).toBe(false);
    expect(massDateInRange("2026-02-30", "2026-11-09")).toBe(false);
  });
});

describe("SQL renders", () => {
  it("the day's visits: T's live rows on the displayed visit starting on D, open requests, org-bound everywhere", () => {
    const s = massDayVisitsSql(ORG, T, "2026-11-10T05:00:00.000Z", "2026-11-11T05:00:00.000Z", T2);
    const t = text(s);
    expect(t).toContain("FROM appointments p JOIN service_requests ON \"service_requests\".\"id\" = p.service_request_id AND \"service_requests\".\"organization_id\" = $");
    expect(t).toContain("JOIN appointment_assignments me ON me.appointment_id = p.id AND me.organization_id = $");
    expect(t).toContain("AND me.technician_id = $");
    expect(t).toContain("AND me.status <> 'cancelled'::request_status WHERE p.organization_id = $");
    expect(t).toContain("AND p.arrival_window_start >= $");
    expect(t).toContain("AND p.id = COALESCE(");
    expect(t).toContain("AND \"service_requests\".\"status\" IN ('pending'::request_status,");
    expect(t).toContain("EXISTS (SELECT 1 FROM appointment_assignments tw WHERE tw.appointment_id = p.id AND tw.organization_id = $");
    expect(params(s).filter((p) => p === ORG).length).toBeGreaterThanOrEqual(7);
  });
  it("the lock takes every request in id order", () => {
    expect(text(massLockSql(ORG, [r(2), r(1)]))).toBe("SELECT 1 FROM service_requests WHERE organization_id = $1::uuid AND id = ANY($2::uuid[]) ORDER BY id FOR NO KEY UPDATE");
  });
  it("the audit row is computed in SQL: moved from xmin, skipped = preSkipped + the rest as stale; never twice", () => {
    const s = massAuditSql({ org: ORG, auditId: AUDIT, actorUserId: USER, technicianId: T, toTechnicianId: T2, dayShift: 1, confirmConflict: false,
      candidateIds: [v(1), v(2)], preSkipped: [{ visitId: v(3), reason: "started" }] });
    const t = text(s);
    expect(t).toMatch(/^INSERT INTO audit_log \(id, organization_id, user_id, actor_type, action, entity, entity_id, details\) SELECT \$1::uuid, \$2::uuid, \$3::uuid, 'human', 'dispatch_mass_rescheduled', 'user', \$4::uuid/);
    expect(t).toContain("'movedVisitIds', COALESCE((SELECT json_agg(p.id ORDER BY p.id) FROM appointments p WHERE p.id = ANY($");
    expect(t).toContain("AND p.organization_id = $");
    expect(t).toContain("AND p.xmin = pg_current_xact_id()::xid), '[]'::json)");
    expect(t).toContain("FROM unnest($");
    expect(t).toContain("WITH ORDINALITY AS x(visit_id, reason, ord) UNION ALL SELECT c.id, 'stale', 1000 + c.ord FROM unnest($");
    expect(t).toContain("WHERE NOT EXISTS (SELECT 1 FROM appointments mp WHERE mp.id = c.id AND mp.organization_id = $");
    expect(t).toMatch(/WHERE NOT EXISTS \(SELECT 1 FROM audit_log WHERE id = \$\d+::uuid AND organization_id = \$\d+::uuid\) RETURNING id$/);
    expect(params(s)).toContainEqual([v(3)]);
    expect(params(s)).toContainEqual(["started"]);
  });
});

describe("previewMassReschedule", () => {
  it("lists every visit T is on that day with its outcome; names decrypted for the office", async () => {
    m.readRows
      .mockResolvedValueOnce([
        dayRow(1),
        dayRow(2, { rows: [{ technicianId: T, isLead: true, status: "en_route", hasTimestamp: true }] }),
        dayRow(3, { fieldpulse: true }),
        dayRow(4, { tech_is_lead: false, lead_name: "Kim Park" }),
        dayRow(5, { appointment_number: 2 }),
      ])
      .mockResolvedValueOnce([]); // busy rows on D2
    const out = await previewMassReschedule(ORG, { technicianId: T, fromDate: "2026-11-10", toDate: "2026-11-11", toTechnicianId: T2 }, NOW);
    expect(out.map((c) => c.outcome)).toEqual(["moves", "started", "fieldpulse", "helper", "later_visit"]);
    expect(out[0]).toMatchObject({ visitId: v(1), requestId: r(1), customerName: "dec(enc1)", expectedVersion: 2, conflict: false });
    expect(out[3]!.leadFirstName).toBe("Kim");
  });
});

describe("commitMassReschedule", () => {
  const fresh = (rows = [dayRow(1), dayRow(2), dayRow(3, { rows: [{ technicianId: T, isLead: true, status: "arrived", hasTimestamp: true }] })]) => {
    m.readRows
      .mockResolvedValueOnce([]) // recovery probe: no audit row
      .mockResolvedValueOnce([{ id: v(1) }, { id: v(2) }]) // the org's visits
      .mockResolvedValueOnce(rows)
      .mockResolvedValueOnce([]); // busy
  };
  const readBackOk = (moved: number[], skipped: [string, string][]) =>
    m.readRows
      .mockResolvedValueOnce([{ details: JSON.stringify({ movedVisitIds: moved.map(v), skipped }) }])
      .mockResolvedValueOnce(moved.map((n) => ({ id: v(n), service_request_id: r(n), version: 3, hcp: false })));

  it("one batch: lock all, per visit the move statements (+ lead follow-ons), then the SQL audit row; result read back from it", async () => {
    fresh();
    m.runBatch.mockResolvedValueOnce([[], [{ id: r(1), status: "scheduled" }], [], [], [], [{ id: r(2), status: "scheduled" }], [], [], [], [{ id: AUDIT }]]);
    readBackOk([1, 2], [[v(3), "started"]]);
    const scheduled: Array<() => unknown> = [];
    const out = await commitMassReschedule(ORG, USER, body(), AUDIT, (fn) => scheduled.push(fn), NOW);
    expect(out.status).toBe(200);
    expect(out.envelope).toEqual({ success: true, data: {
      moved: [{ visitId: v(1), requestId: r(1), visitVersion: 3 }, { visitId: v(2), requestId: r(2), visitVersion: 3 }],
      skipped: [{ visitId: v(3), reason: "started" }], pushesNotSent: [],
    } });
    const statements = m.runBatch.mock.calls[0]![0] as SQL[];
    expect(statements).toHaveLength(10); // lock + 2 × (update, cancel done, revive, close) + audit
    expect(text(statements[0]!)).toContain("ORDER BY id FOR NO KEY UPDATE");
    const update = text(statements[1]!);
    expect(update).toContain("AND \"service_requests\".\"assigned_to\" = $");
    expect(update).toContain("AND \"service_requests\".\"arrival_window_start\" >= $");
    expect(update).toContain("AND NOT EXISTS (SELECT 1 FROM audit_log al WHERE al.id = $");
    // `started` is never confirmed in bulk: the started arm is in the guard.
    expect(update).toContain("AND NOT (EXISTS (SELECT 1 FROM appointment_assignments sa");
    // The run's own requests never conflict with each other.
    expect(update).toContain("AND cr.id <> ALL($");
    expect(params(statements[1]!)).toContainEqual([r(1), r(2)]);
    expect(text(statements[2]!)).toContain("AND ((EXISTS (SELECT 1 FROM service_requests xr");
    expect(text(statements[2]!)).toContain("AND NOT EXISTS (SELECT 1 FROM audit_log al WHERE al.id = $");
    expect(text(statements[9]!)).toMatch(/^INSERT INTO audit_log/);
    for (const fn of scheduled) await fn();
    expect(m.sync).toHaveBeenCalledTimes(2);
    expect(m.hcp).toHaveBeenCalledTimes(2);
    expect(m.stamp).toHaveBeenCalledWith(ORG, r(1), T2, USER);
  });

  it("the commit reclassifies: a visit that started after the preview gets no statements and is skipped as started", async () => {
    fresh([dayRow(1), dayRow(2, { rows: [{ technicianId: T, isLead: true, status: "en_route", hasTimestamp: true }] }), dayRow(3)]);
    m.runBatch.mockResolvedValueOnce([[], [{ id: r(1), status: "scheduled" }], [], [], [], [{ id: AUDIT }]]);
    readBackOk([1], [[v(3), "started"], [v(2), "started"]]);
    const out = await commitMassReschedule(ORG, USER, body(), AUDIT, () => {}, NOW);
    expect(out.status).toBe(200);
    const statements = m.runBatch.mock.calls[0]![0] as SQL[];
    expect(statements).toHaveLength(6); // lock + v1 × 4 + audit
    const audit = params(statements[5]!);
    expect(audit).toContainEqual([v(3), v(2)]); // preSkipped ids: the client's, then the server's
    expect(audit).toContainEqual(["started", "started"]);
    expect(audit).toContainEqual([v(1)]); // candidates: only v1
  });

  it("a listed visit no longer among T's visits that day is audited stale, not a 400", async () => {
    fresh([dayRow(1), dayRow(3)]); // v2 was moved to another day by someone else
    m.runBatch.mockResolvedValueOnce([[], [{ id: r(1), status: "scheduled" }], [], [], [], [{ id: AUDIT }]]);
    readBackOk([1], [[v(3), "started"], [v(2), "stale"]]);
    const out = await commitMassReschedule(ORG, USER, body(), AUDIT, () => {}, NOW);
    expect(out.status).toBe(200);
    const statements = m.runBatch.mock.calls[0]![0] as SQL[];
    expect(statements).toHaveLength(6);
    expect(params(statements[5]!)).toContainEqual([v(1), v(2)]); // v2 is a candidate with no statements → stale in SQL
  });

  it("an id that isn't one of the org's visits → 400; a preSkipped id that isn't the day's → 400; nothing written", async () => {
    m.readRows.mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: v(1) }]);
    expect((await commitMassReschedule(ORG, USER, body(), AUDIT, () => {}, NOW)).status).toBe(400);
    m.readRows.mockResolvedValueOnce([]).mockResolvedValueOnce([{ id: v(1) }, { id: v(2) }]).mockResolvedValueOnce([dayRow(1), dayRow(2)]).mockResolvedValueOnce([]);
    const out = await commitMassReschedule(ORG, USER, body({ preSkipped: [{ visitId: v(9), reason: "started" }] }), AUDIT, () => {}, NOW);
    expect(out.status).toBe(400);
    expect(out.envelope).toMatchObject({ success: false, error: { code: "VALIDATION_ERROR" } });
    expect(m.runBatch).not.toHaveBeenCalled();
  });

  it("recovery: the audit row exists → rebuild the 200, write nothing, re-send update-style pushes only", async () => {
    m.hcpConfig.mockResolvedValue({ apiKey: "k", baseUrl: "x" });
    m.readRows
      .mockResolvedValueOnce([{ details: JSON.stringify({ movedVisitIds: [v(1), v(2)], skipped: [[v(3), "stale"]] }) }])
      .mockResolvedValueOnce([{ id: v(1), service_request_id: r(1), version: 5, hcp: true }, { id: v(2), service_request_id: r(2), version: 5, hcp: false }]);
    const scheduled: Array<() => unknown> = [];
    const out = await commitMassReschedule(ORG, USER, body(), AUDIT, (fn) => scheduled.push(fn), NOW);
    expect(m.runBatch).not.toHaveBeenCalled();
    expect(out.envelope).toEqual({ success: true, data: {
      moved: [{ visitId: v(1), requestId: r(1), visitVersion: 5 }, { visitId: v(2), requestId: r(2), visitVersion: 5 }],
      skipped: [{ visitId: v(3), reason: "stale" }], pushesNotSent: [r(2)],
    } });
    for (const fn of scheduled) await fn();
    expect(m.sync).toHaveBeenCalledTimes(2);
    expect(m.hcp).toHaveBeenCalledTimes(1);
    expect(m.hcp).toHaveBeenCalledWith(ORG, r(1));
    expect(m.event).not.toHaveBeenCalled();
    expect(m.stamp).not.toHaveBeenCalled();
  });

  it("a taken-over run whose audit INSERT matched nothing answers as recovery (no events, no stamps, no HCP create)", async () => {
    fresh();
    m.runBatch.mockResolvedValueOnce([[], [], [], [], [], [], [], [], [], []]);
    m.readRows
      .mockResolvedValueOnce([{ details: JSON.stringify({ movedVisitIds: [v(1)], skipped: [] }) }])
      .mockResolvedValueOnce([{ id: v(1), service_request_id: r(1), version: 3, hcp: false }]);
    const scheduled: Array<() => unknown> = [];
    const out = await commitMassReschedule(ORG, USER, body(), AUDIT, (fn) => scheduled.push(fn), NOW);
    expect(out.status).toBe(200);
    for (const fn of scheduled) await fn();
    expect(m.sync).toHaveBeenCalledTimes(1);
    expect(m.hcp).not.toHaveBeenCalled();
    expect(m.stamp).not.toHaveBeenCalled();
    expect(m.event).not.toHaveBeenCalled();
  });

  it("a deadlock answers 409 STALE (unstored), registers nothing", async () => {
    fresh();
    m.runBatch.mockResolvedValueOnce({ ok: false, reason: "stale" });
    const scheduled: Array<() => unknown> = [];
    const out = await commitMassReschedule(ORG, USER, body(), AUDIT, (fn) => scheduled.push(fn), NOW);
    expect(out.status).toBe(409);
    expect(scheduled).toHaveLength(0);
  });
});
```

- [ ] **Step 3: Run it to verify it fails**

Run: `npx vitest run src/lib/admin/mass-reschedule.test.ts`
Expected: FAIL — `./mass-reschedule` doesn't resolve.

- [ ] **Step 4: Implement** — `src/lib/admin/mass-reschedule.ts`:

```ts
/**
 * Mass reschedule (M2 spec §5.6): move every displayed visit #1 technician T
 * leads on business day D to day D2 and/or lead T2, keeping wall-clock times.
 * Preview classifies; commit runs under withIdempotency (the route) as ONE
 * batch: lock every request in id order, then per visit the move's guarded
 * statements (own version gate, lead = T, starts on D, never `started` in
 * bulk), then the audit row computed in SQL (moved = candidates this
 * transaction wrote; skipped = preSkipped + every other candidate as stale).
 * Each statement carries NOT EXISTS (the audit row): a recovered run whose
 * audit row exists writes nothing and rebuilds its 200 from that row.
 * After-calls are registered through `schedule` as the run's last step.
 */
import { sql, type SQL } from "drizzle-orm";
import { after } from "next/server";
import { z } from "zod";
import { decrypt } from "@/lib/crypto";
import type { RunResult } from "@/lib/http/idempotency";
import { syncRequestToCalendar } from "@/lib/integrations/google-calendar/sync";
import { pushJobToHcp } from "@/lib/integrations/housecall-pro/job-sync";
import { getHousecallConfig } from "@/lib/integrations/housecall-pro/config";
import { OPEN_ASSIGNMENT_STATUSES } from "@/lib/tech/ownership";
import { readRows, runBatch } from "./invoice-field-writes";
import { listShiftsInRange } from "./shift-queries";
import { getTechnicianAvailability } from "./scheduling-queries";
import { isSpanWithinAvailability } from "./availability-coverage";
import { recordStatusEvent } from "./status-events";
import { stampDispatchOverride } from "./dispatch-override";
import { displayVisitIdSql, visitEndedSql } from "./current-visit";
import { businessDayBounds, isRealIsoDate } from "./calendar-time";
import { OPEN_STATUSES, type RequestStatus } from "./request-status";
import { anyTimestampSql } from "./visit-started";
import { moveNeeds, type NeedsRow } from "./board-move";
import { firstName } from "./dispatch-copy";
import { classifyMassVisit, massDayShift, type MassContext, type MassVisitFacts } from "./mass-reschedule-model";
import { cancelDoneOldLeadSql, closeOldLeadEntriesSql, requestXminGateSql, reviveLeadSql } from "./visit-move-sql";
import { moveUpdateSql } from "./visit-move";
import { MASS_PRESKIP_REASONS, type BoardBlock, type MassCandidate, type MassReason, type MassResult } from "./board-types";

// ---------------------------------------------------------------- bodies

const isoDay = z.string().refine(isRealIsoDate, "Use a real date.");

export const massQuerySchema = z.object({
  technicianId: z.uuid(),
  fromDate: isoDay,
  toDate: isoDay,
  toTechnicianId: z.uuid().optional(),
});
export type MassQuery = z.infer<typeof massQuerySchema>;

const unique = (ids: readonly string[]) => new Set(ids.map((i) => i.toLowerCase())).size === ids.length;

export const massCommitSchema = massQuerySchema
  .extend({
    visits: z.array(z.object({ visitId: z.uuid(), expectedVersion: z.number().int().min(0) })).min(1).max(30),
    preSkipped: z.array(z.object({ visitId: z.uuid(), reason: z.enum(MASS_PRESKIP_REASONS) })).max(100),
    confirmConflict: z.boolean(),
  })
  .refine((b) => unique(b.visits.map((x) => x.visitId)), { path: ["visits"], message: "Each visit once." })
  .refine((b) => unique([...b.visits.map((x) => x.visitId), ...b.preSkipped.map((x) => x.visitId)]), { path: ["preSkipped"], message: "Each visit once." });
export type MassCommitBody = z.infer<typeof massCommitSchema>;

function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** A real ISO day within today − 1 … today + 365 (spec §6). */
export function massDateInRange(iso: string, today: string): boolean {
  return isRealIsoDate(iso) && iso >= addDays(today, -1) && iso <= addDays(today, 365);
}

// ---------------------------------------------------------------- SQL

const statusList = (list: readonly string[]) => sql.raw(list.map((s) => `'${s}'::request_status`).join(", "));

/** Every visit T has a live row on, displayed for its request, starting on the business day [dayStart, dayEnd). */
export function massDayVisitsSql(org: string, technicianId: string, dayStartIso: string, dayEndIso: string, toTechnicianId: string | null): SQL {
  const toTech = toTechnicianId
    ? sql`EXISTS (SELECT 1 FROM appointment_assignments tw WHERE tw.appointment_id = p.id AND tw.organization_id = ${org}::uuid AND tw.technician_id = ${toTechnicianId}::uuid)`
    : sql`false`;
  return sql`SELECT p.id AS visit_id, "service_requests"."id" AS request_id, p.appointment_number, p.version,
      p.arrival_window_start, p.arrival_window_end,
      (p.cancelled_at IS NOT NULL OR ${visitEndedSql()}) AS ended,
      "service_requests"."reference_number" AS reference_number, "service_requests"."status" AS request_status,
      ("service_requests"."fieldpulse_job_id" IS NOT NULL) AS fieldpulse, ("service_requests"."hcp_job_id" IS NOT NULL) AS hcp,
      "service_requests"."customer_name_encrypted" AS name_enc,
      (SELECT c.name_encrypted FROM customers c WHERE c.id = "service_requests"."customer_id" AND c.organization_id = ${org}::uuid) AS customer_name_enc,
      me.is_lead AS tech_is_lead,
      (SELECT CASE WHEN lu.is_active THEN lu.name END FROM appointment_assignments la JOIN users lu ON lu.id = la.technician_id AND lu.organization_id = ${org}::uuid
        WHERE la.appointment_id = p.id AND la.organization_id = ${org}::uuid AND la.is_lead AND la.status <> 'cancelled'::request_status LIMIT 1) AS lead_name,
      COALESCE((SELECT json_agg(json_build_object('technicianId', a.technician_id, 'isLead', a.is_lead, 'status', a.status, 'hasTimestamp', ${anyTimestampSql("a")}))
        FROM appointment_assignments a WHERE a.appointment_id = p.id AND a.organization_id = ${org}::uuid AND a.status <> 'cancelled'::request_status), '[]'::json) AS rows,
      ${toTech} AS to_tech_on_visit
    FROM appointments p JOIN service_requests ON "service_requests"."id" = p.service_request_id AND "service_requests"."organization_id" = ${org}::uuid
    JOIN appointment_assignments me ON me.appointment_id = p.id AND me.organization_id = ${org}::uuid AND me.technician_id = ${technicianId}::uuid AND me.status <> 'cancelled'::request_status
    WHERE p.organization_id = ${org}::uuid AND p.arrival_window_start >= ${dayStartIso}::timestamptz AND p.arrival_window_start < ${dayEndIso}::timestamptz
      AND p.id = COALESCE(${displayVisitIdSql()}, (SELECT q1.id FROM appointments q1 WHERE q1.service_request_id = "service_requests"."id" AND q1.organization_id = ${org}::uuid AND q1.appointment_number = 1))
      AND "service_requests"."status" IN (${statusList(OPEN_STATUSES)})
    ORDER BY p.arrival_window_start, p.id
    LIMIT 100`;
}

/** Open rows of `technicianIds` on live visits of open requests overlapping [start, end) — the preview's soft conflicts. */
function busyRowsSql(org: string, technicianIds: readonly string[], startIso: string, endIso: string): SQL {
  return sql`SELECT ca.technician_id, cr.id AS request_id, cp.arrival_window_start, cp.arrival_window_end
    FROM appointment_assignments ca JOIN appointments cp ON cp.id = ca.appointment_id JOIN service_requests cr ON cr.id = cp.service_request_id
    WHERE ca.organization_id = ${org}::uuid AND cp.organization_id = ${org}::uuid AND cr.organization_id = ${org}::uuid
      AND ca.technician_id = ANY(${sql.param([...technicianIds])}::uuid[]) AND ca.status IN (${statusList(OPEN_ASSIGNMENT_STATUSES)})
      AND cp.cancelled_at IS NULL AND cr.status IN (${statusList(OPEN_STATUSES)})
      AND cp.arrival_window_start < ${endIso}::timestamptz AND cp.arrival_window_end > ${startIso}::timestamptz`;
}

export function massLockSql(org: string, requestIds: readonly string[]): SQL {
  return sql`SELECT 1 FROM service_requests WHERE organization_id = ${org}::uuid AND id = ANY(${sql.param([...requestIds])}::uuid[]) ORDER BY id FOR NO KEY UPDATE`;
}

const noAuditYet = (org: string, auditId: string): SQL =>
  sql`NOT EXISTS (SELECT 1 FROM audit_log al WHERE al.id = ${auditId}::uuid AND al.organization_id = ${org}::uuid)`;

export interface MassAuditParams {
  readonly org: string;
  readonly auditId: string;
  readonly actorUserId: string;
  readonly technicianId: string;
  readonly toTechnicianId: string | null;
  readonly dayShift: number;
  readonly confirmConflict: boolean;
  readonly candidateIds: readonly string[];
  readonly preSkipped: readonly { readonly visitId: string; readonly reason: string }[];
}

/** The audit row, computed in SQL (spec §5.6, lead ruling L3-3). */
export function massAuditSql(p: MassAuditParams): SQL {
  const cand = sql`${sql.param([...p.candidateIds])}::uuid[]`;
  return sql`INSERT INTO audit_log (id, organization_id, user_id, actor_type, action, entity, entity_id, details)
    SELECT ${p.auditId}::uuid, ${p.org}::uuid, ${p.actorUserId}::uuid, 'human', 'dispatch_mass_rescheduled', 'user', ${p.technicianId}::uuid,
      json_build_object(
        'toTechnicianId', ${p.toTechnicianId}::uuid,
        'dayShift', ${p.dayShift}::int,
        'movedVisitIds', COALESCE((SELECT json_agg(p.id ORDER BY p.id) FROM appointments p WHERE p.id = ANY(${cand}) AND p.organization_id = ${p.org}::uuid AND p.xmin = pg_current_xact_id()::xid), '[]'::json),
        'skipped', (SELECT COALESCE(json_agg(json_build_array(s.visit_id, s.reason) ORDER BY s.ord), '[]'::json) FROM (
          SELECT x.visit_id, x.reason, x.ord FROM unnest(${sql.param(p.preSkipped.map((s) => s.visitId))}::uuid[], ${sql.param(p.preSkipped.map((s) => s.reason))}::text[]) WITH ORDINALITY AS x(visit_id, reason, ord)
          UNION ALL SELECT c.id, 'stale', 1000 + c.ord FROM unnest(${cand}) WITH ORDINALITY AS c(id, ord)
            WHERE NOT EXISTS (SELECT 1 FROM appointments mp WHERE mp.id = c.id AND mp.organization_id = ${p.org}::uuid AND mp.xmin = pg_current_xact_id()::xid)) s),
        'confirmConflict', ${p.confirmConflict}::boolean)::text
    WHERE NOT EXISTS (SELECT 1 FROM audit_log WHERE id = ${p.auditId}::uuid AND organization_id = ${p.org}::uuid)
    RETURNING id`;
}

// ---------------------------------------------------------------- reads

type Row = Record<string, unknown>;

interface DayVisit {
  readonly facts: MassVisitFacts;
  readonly referenceNumber: string;
  readonly customerName: string | null;
  readonly version: number;
  readonly requestStatus: string;
  readonly hcp: boolean;
  readonly leadName: string | null;
}

function safeName(enc: unknown): string | null {
  if (typeof enc !== "string" || enc === "") return null;
  try {
    return decrypt(enc);
  } catch {
    return null;
  }
}

function jsonRows(v: unknown): NeedsRow[] {
  const arr = Array.isArray(v) ? v : typeof v === "string" ? (JSON.parse(v) as unknown[]) : [];
  return arr.map((r) => {
    const o = r as Row;
    return { technicianId: String(o.technicianId), isLead: o.isLead === true, status: String(o.status), hasTimestamp: o.hasTimestamp === true };
  });
}

function toDayVisit(r: Row): DayVisit {
  return {
    facts: {
      visitId: String(r.visit_id),
      requestId: String(r.request_id),
      visitNumber: Number(r.appointment_number),
      window: { start: new Date(r.arrival_window_start as string), end: new Date(r.arrival_window_end as string) },
      fieldpulse: r.fieldpulse === true,
      techIsLead: r.tech_is_lead === true,
      ended: r.ended === true,
      rows: jsonRows(r.rows),
      toTechOnVisit: r.to_tech_on_visit === true,
    },
    referenceNumber: String(r.reference_number),
    customerName: safeName(r.name_enc) ?? safeName(r.customer_name_enc),
    version: Number(r.version),
    requestStatus: String(r.request_status),
    hcp: r.hcp === true,
    leadName: (r.lead_name as string | null) ?? null,
  };
}

async function readDay(org: string, q: MassQuery): Promise<{ visits: DayVisit[]; ctx: MassContext }> {
  const from = businessDayBounds(q.fromDate)!;
  const to = businessDayBounds(q.toDate)!;
  const rows = await readRows(massDayVisitsSql(org, q.technicianId, from.start.toISOString(), from.end.toISOString(), q.toTechnicianId ?? null));
  const visits = rows.map(toDayVisit);
  // D2 plus a day either side: a kept window can cross midnight.
  const rangeStart = new Date(to.start.getTime() - 86_400_000).toISOString();
  const rangeEnd = new Date(to.end.getTime() + 86_400_000).toISOString();
  const people = [...new Set([q.technicianId, ...(q.toTechnicianId ? [q.toTechnicianId] : []), ...visits.flatMap((v) => v.facts.rows.map((r) => r.technicianId))])];
  const [shifts, busyRows, slots] = await Promise.all([
    listShiftsInRange(org, rangeStart, rangeEnd),
    visits.length > 0 ? readRows(busyRowsSql(org, people, rangeStart, rangeEnd)) : Promise.resolve([] as Row[]),
    getTechnicianAvailability(org),
  ]);
  const blocks: BoardBlock[] = shifts.map((s) => ({ ...s }));
  const ctx: MassContext = {
    technicianId: q.technicianId,
    toTechnicianId: q.toTechnicianId ?? null,
    fromDate: q.fromDate,
    toDate: q.toDate,
    now: new Date(),
    blocks,
    busy: busyRows.map((b) => ({ technicianId: String(b.technician_id), requestId: String(b.request_id), start: new Date(b.arrival_window_start as string), end: new Date(b.arrival_window_end as string) })),
    outsideHours: (id, w) => !isSpanWithinAvailability(slots.filter((s) => s.technicianId === id), w.start, w.end),
  };
  return { visits, ctx };
}

// ---------------------------------------------------------------- preview

export async function previewMassReschedule(org: string, q: MassQuery, now: Date = new Date()): Promise<readonly MassCandidate[]> {
  const { visits, ctx } = await readDay(org, q);
  // The day's visits move together: they never conflict with each other (critic A MAJOR-1).
  const at = { ...ctx, now, batchRequestIds: visits.map((v) => v.facts.requestId) };
  return visits.map((v) => {
    const c = classifyMassVisit(v.facts, at);
    return {
      visitId: v.facts.visitId,
      requestId: v.facts.requestId,
      referenceNumber: v.referenceNumber,
      customerName: v.customerName,
      arrivalWindowStart: v.facts.window.start.toISOString(),
      arrivalWindowEnd: v.facts.window.end.toISOString(),
      visitNumber: v.facts.visitNumber,
      expectedVersion: v.version,
      outcome: c.outcome,
      conflict: c.conflict,
      leadFirstName: v.facts.techIsLead ? null : firstName(v.leadName),
    };
  });
}

// ---------------------------------------------------------------- commit

const ok200 = (data: MassResult): RunResult => ({ status: 200, envelope: { success: true, data: data as unknown as Record<string, unknown> } });
const fail = (status: number, code: string, message: string): RunResult => ({ status, envelope: { success: false, error: { code, message } } });

function parseDetails(raw: unknown): { moved: string[]; skipped: [string, string][] } {
  const d = (typeof raw === "string" ? JSON.parse(raw) : raw) as { movedVisitIds?: string[]; skipped?: [string, string][] };
  return { moved: d.movedVisitIds ?? [], skipped: d.skipped ?? [] };
}

async function readBack(org: string, auditId: string): Promise<{ moved: { visitId: string; requestId: string; visitVersion: number; hcp: boolean }[]; skipped: MassResult["skipped"] } | null> {
  const [audit] = await readRows(sql`SELECT details FROM audit_log WHERE id = ${auditId}::uuid AND organization_id = ${org}::uuid`);
  if (!audit) return null;
  const d = parseDetails(audit.details);
  const versions = d.moved.length > 0
    ? await readRows(sql`SELECT p.id, p.service_request_id, p.version, (r.hcp_job_id IS NOT NULL) AS hcp
        FROM appointments p JOIN service_requests r ON r.id = p.service_request_id AND r.organization_id = ${org}::uuid
        WHERE p.id = ANY(${sql.param(d.moved)}::uuid[]) AND p.organization_id = ${org}::uuid`)
    : [];
  const byId = new Map(versions.map((v) => [String(v.id), v]));
  return {
    moved: d.moved.flatMap((id) => {
      const v = byId.get(id);
      return v ? [{ visitId: id, requestId: String(v.service_request_id), visitVersion: Number(v.version), hcp: v.hcp === true }] : [];
    }),
    skipped: d.skipped.map(([visitId, reason]) => ({ visitId, reason: reason as MassReason | "conflict" })),
  };
}

/** Recovery (spec §4.2): rebuild the 200 from the audit row; re-send only update-style pushes; no events, no stamps. */
async function recover(
  org: string,
  recovered: NonNullable<Awaited<ReturnType<typeof readBack>>>,
  schedule: (fn: () => unknown) => void,
): Promise<RunResult> {
  const hcpConnected = (await getHousecallConfig(org)) !== null;
  const envelope = ok200({
    moved: recovered.moved.map(({ visitId, requestId, visitVersion }) => ({ visitId, requestId, visitVersion })),
    skipped: recovered.skipped,
    pushesNotSent: hcpConnected ? recovered.moved.filter((m) => !m.hcp).map((m) => m.requestId) : [],
  });
  for (const m of recovered.moved) {
    schedule(() => syncRequestToCalendar(org, m.requestId));
    if (m.hcp) schedule(() => pushJobToHcp(org, m.requestId));
  }
  return envelope;
}

export async function commitMassReschedule(
  org: string,
  actorUserId: string,
  body: MassCommitBody,
  auditId: string,
  schedule: (fn: () => unknown) => void = (fn) => after(fn as () => void),
  now: Date = new Date(),
): Promise<RunResult> {
  // Recovery (spec §4.2): the audit row is the record of a committed run.
  const recovered = await readBack(org, auditId);
  if (recovered) return recover(org, recovered, schedule);

  const q: MassQuery = { technicianId: body.technicianId.toLowerCase(), fromDate: body.fromDate, toDate: body.toDate, toTechnicianId: body.toTechnicianId?.toLowerCase() };
  const wanted = body.visits.map((x) => ({ ...x, visitId: x.visitId.toLowerCase() }));
  const preSkipped = body.preSkipped.map((x) => ({ ...x, visitId: x.visitId.toLowerCase() }));
  // Every listed visit must be one of this org's visits (a foreign or made-up id is a 400). A visit that
  // changed since the preview is NOT an error: it is recorded `stale` below (plan v2, critic A MAJOR-3).
  const known = await readRows(sql`SELECT id FROM appointments WHERE id = ANY(${sql.param(wanted.map((w) => w.visitId))}::uuid[]) AND organization_id = ${org}::uuid`);
  if (known.length !== wanted.length) return fail(400, "VALIDATION_ERROR", "Open the preview again.");

  const { visits, ctx } = await readDay(org, q);
  const byId = new Map(visits.map((v) => [v.facts.visitId, v]));
  // preSkipped carries reasons, so its ids must be the day's visits (spec §5.6 "validated").
  if (preSkipped.some((x) => !byId.has(x.visitId))) return fail(400, "VALIDATION_ERROR", "Open the preview again.");

  const T = q.technicianId;
  const T2 = q.toTechnicianId ?? null;
  const leadChanges = T2 !== null && T2 !== T;
  const dayChanges = q.toDate !== q.fromDate;
  const from = businessDayBounds(q.fromDate)!;
  const batchRequestIds = [...new Set(wanted.flatMap((w) => (byId.has(w.visitId) ? [byId.get(w.visitId)!.facts.requestId] : [])))];
  const at: MassContext = { ...ctx, now, batchRequestIds };

  // The commit never trusts the preview (plan v2, critic A MAJOR-2): each visit is reclassified here.
  // A visit no longer among T's visits that day gets no statements and is audited `stale`; one whose
  // fresh outcome isn't `moves` (or is an unconfirmed conflict) is skipped with its real reason.
  const moving: { visitId: string; expectedVersion: number; v: DayVisit; window: { start: Date; end: Date } }[] = [];
  const serverSkipped: { visitId: string; reason: string }[] = [];
  for (const w of wanted) {
    const v = byId.get(w.visitId);
    if (!v) continue; // stale
    const c = classifyMassVisit(v.facts, at);
    if (c.outcome !== "moves") serverSkipped.push({ visitId: w.visitId, reason: c.outcome });
    else if (c.conflict && !body.confirmConflict) serverSkipped.push({ visitId: w.visitId, reason: "conflict" });
    else moving.push({ ...w, v, window: c.newWindow });
  }
  const skippedIds = new Set(serverSkipped.map((x) => x.visitId));

  const statements: SQL[] = [];
  if (moving.length > 0) statements.push(massLockSql(org, [...new Set(moving.map((m) => m.v.facts.requestId))]));
  const updateIndex = new Map<string, number>();
  for (const m of moving) {
    const rid = m.v.facts.requestId;
    const needs = moveNeeds({ leadChanges, windowChanges: dayChanges, currentLeadId: T, newLeadId: leadChanges ? T2 : T, rows: m.v.facts.rows });
    const gate = sql`(${requestXminGateSql(org, rid)} AND ${noAuditYet(org, auditId)})`;
    updateIndex.set(m.visitId, statements.length);
    statements.push(moveUpdateSql({
      org, rid, visitId: m.visitId, expectedVersion: m.expectedVersion, start: m.window.start, end: m.window.end,
      oldLeadId: T, newLeadId: leadChanges ? T2 : T, leadChanges, windowChanges: dayChanges, checked: needs.checked,
      // `started` is never confirmed in bulk (spec §5.6); pinned by a render test.
      confirmStarted: false, confirmConflict: body.confirmConflict,
      excludeRequestIds: batchRequestIds,
      extra: [
        sql`"service_requests"."assigned_to" = ${T}::uuid`,
        sql`"service_requests"."arrival_window_start" >= ${from.start.toISOString()}::timestamptz AND "service_requests"."arrival_window_start" < ${from.end.toISOString()}::timestamptz`,
        noAuditYet(org, auditId),
      ],
    }));
    if (leadChanges) {
      statements.push(cancelDoneOldLeadSql(org, rid, T, gate));
      statements.push(reviveLeadSql(org, rid, gate));
      statements.push(closeOldLeadEntriesSql(org, rid, T, gate));
    }
  }
  statements.push(massAuditSql({
    org, auditId, actorUserId, technicianId: T, toTechnicianId: T2, dayShift: massDayShift(q.fromDate, q.toDate),
    confirmConflict: body.confirmConflict,
    candidateIds: wanted.map((w) => w.visitId).filter((id) => !skippedIds.has(id)),
    preSkipped: [...preSkipped, ...serverSkipped],
  }));

  const rows = await runBatch(statements); // any statement error throws: all rolled back, the route answers 500
  if (!Array.isArray(rows)) return fail(409, "STALE", "Changed since you opened this.");
  if (rows[rows.length - 1]!.length === 0) {
    // Our audit INSERT matched nothing: a taken-over run committed first (critic A m1). Answer as recovery.
    const theirs = await readBack(org, auditId);
    return theirs ? recover(org, theirs, schedule) : fail(409, "STALE", "Changed since you opened this.");
  }

  const done = await readBack(org, auditId);
  if (!done) throw new Error("mass reschedule committed without its audit row");
  const envelope = ok200({
    moved: done.moved.map(({ visitId, requestId, visitVersion }) => ({ visitId, requestId, visitVersion })),
    skipped: done.skipped,
    pushesNotSent: [],
  });

  // Registered last (spec §4.2): a run that threw above registered nothing.
  const movingById = new Map(moving.map((m) => [m.visitId, m]));
  for (const m of done.moved) {
    const v = movingById.get(m.visitId)?.v;
    if (!v) continue;
    const updated = rows[updateIndex.get(m.visitId)!]?.[0];
    const toStatus = updated ? String(updated.status) : v.requestStatus;
    if (toStatus !== v.requestStatus) {
      schedule(() => recordStatusEvent({
        organizationId: org, serviceRequestId: m.requestId, fromStatus: v.requestStatus as RequestStatus, toStatus: toStatus as RequestStatus,
        actorType: "human", actorId: actorUserId,
      }));
    }
    if (T2) schedule(() => stampDispatchOverride(org, m.requestId, T2, actorUserId));
    schedule(() => syncRequestToCalendar(org, m.requestId));
    schedule(() => pushJobToHcp(org, m.requestId));
  }
  return envelope;
}
```

Notes the implementer must keep: `preSkipped` reasons are validated by `massCommitSchema` (the route parses first) and its ids against the day's visits, so a forged reason or a foreign visit never reaches the audit row; `visits` ids are checked only as this org's visits, and the commit reclassifies every one (started, ended window, target technician already on it, time off, hours and overlap), never trusting the preview. The `extra` "starts on D" guard reads the request's columns (visit #1 = the request's window).

- [ ] **Step 5: Run the test to verify it passes**

Run: `npx vitest run src/lib/admin/mass-reschedule.test.ts`
Expected: PASS. In the fresh-run test the runBatch result arrays line up as: index 0 lock, 1/5 the two updates, 2–4 and 6–8 the lead follow-ons, 9 the audit; in the reclassification tests only v1's four statements remain (index 5 is the audit).

- [ ] **Step 6: Gates and commit**

```bash
npx tsc --noEmit && npx eslint src/lib/admin/mass-reschedule.ts src/lib/admin/mass-reschedule.test.ts src/lib/admin/shift-queries.ts && npx vitest run
git add src/lib/admin/mass-reschedule.ts src/lib/admin/mass-reschedule.test.ts src/lib/admin/shift-queries.ts
git commit -m "$(cat <<'EOF'
feat(m2): mass reschedule writer with an SQL-computed audit for recovery

Preview classifies every visit a technician is on that day; commit is one
batch (requests locked in id order, each visit's guarded move with its own
version gate, lead and start-day guards) whose audit row is built in SQL from
xmin. A recovered run writes nothing and re-sends only update-style pushes.
Adds listShiftsInRange.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01GuWoF63tQU1i7ELqyYU3A6
EOF
)"
```

---
### Task 7: Board read — visit, version, crew and movable on every card; blocks in Day view

**Files:**
- Create: `src/lib/admin/board-crew-queries.ts`, `src/lib/admin/board-crew-queries.test.ts`
- Modify: `src/lib/admin/queries.ts` (`getSchedulingCalendar` tail, imports), `src/lib/admin/queries.test.ts` (mocks + two cases)

**Interfaces:**
- Consumes: Task 1 (`rowStarted`, `anyTimestampSql`), Task 2 types (`CrewMember`, `Movable`, optional `DashboardRequest` fields, `SchedulingCalendar.blocks`), Task 6 (`listShiftsInRange`). Existing: `displayVisitIdSql`, `visitEndedSql` (`current-visit.ts`), `readRows` (`invoice-field-writes.ts`).
- Produces: `boardVisitsSql(org, requestIds)`, `BoardVisitRow`, `boardCardFields(row)`, `readBoardVisits(org, requestIds): Promise<ReadonlyMap<string, BoardCardFields>>`. `getSchedulingCalendar` (signature unchanged) gives every lane / unassigned / Unscheduled card `visitId`, `visitVersion`, `crew`, `started`, `movable`, `laneRole: "lead"`, `fieldpulse`, and adds `blocks` when it renders one day. The two new reads run after the existing five (spec §7.1); `queries.test.ts` keeps the visit feed at select index 4 (lead ruling 3).

- [ ] **Step 0: Latency, before (spec §11 "not verified").** Before editing anything in this task (the tree is at the Task 6 commit): dev server running, `m2-walk.mts seed` a throwaway org, time `GET /api/admin/calendar?view=day&date=<day>` five times with its admin cookie (`curl -s -o /dev/null -w "%{time_total}\n"`), record the median, delete the org with `m2-walk.mts delete <org>`. No `git stash`: the tree is shared.

- [ ] **Step 1: Write the failing tests** — `src/lib/admin/board-crew-queries.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { boardCardFields, boardVisitsSql } from "./board-crew-queries";

const ORG = "00000000-0000-4000-8000-0000000000aa";
const R1 = "11111111-1111-4111-8111-111111111111";
const ALEX = "a1111111-1111-4111-8111-111111111111";
const SAM = "b2222222-2222-4222-8222-222222222222";

const row = (over: Record<string, unknown> = {}) => ({
  request_id: R1, status: "scheduled", fieldpulse: false, visit_id: "v1", visit_number: 1, visit_version: 3,
  visit_cancelled: false, ended: false,
  crew: [{ technicianId: ALEX, name: "Alex Rivera", isLead: true, status: "scheduled", hasTimestamp: false }], ...over,
});

describe("boardVisitsSql (spec §7.1)", () => {
  it("one org-scoped query: the displayed visit else #1, its version, live rows with active names only", () => {
    const { sql, params } = new PgDialect().sqlToQuery(boardVisitsSql(ORG, [R1]));
    const t = sql.replace(/\s+/g, " ");
    expect(t).toContain("FROM service_requests LEFT JOIN appointments bv ON bv.organization_id = $");
    expect(t).toContain("AND bv.id = COALESCE(");
    expect(t).toContain("(SELECT b1.id FROM appointments b1 WHERE b1.service_request_id = \"service_requests\".\"id\" AND b1.organization_id = $");
    expect(t).toContain("CASE WHEN u.is_active THEN u.name END");
    expect(t).toContain("FROM appointment_assignments a JOIN users u ON u.id = a.technician_id AND u.organization_id = $");
    expect(t).toContain("WHERE a.appointment_id = bv.id AND a.organization_id = $");
    expect(t).toContain("AND a.status <> 'cancelled'::request_status");
    expect(t).toMatch(/WHERE "service_requests"\."organization_id" = \$\d+::uuid AND "service_requests"\."id" = ANY\(\$\d+::uuid\[\]\)$/);
    expect(params).toContainEqual([R1]);
    expect(params.filter((p) => p === ORG).length).toBeGreaterThanOrEqual(5);
  });
});

describe("boardCardFields", () => {
  it("a native visit #1: movable, lead card, crew states", () => {
    const f = boardCardFields(row({ crew: [
      { technicianId: ALEX, name: "Alex Rivera", isLead: true, status: "in_progress", hasTimestamp: true },
      { technicianId: SAM, name: null, isLead: false, status: "completed", hasTimestamp: true },
    ] }));
    expect(f).toEqual({
      visitId: "v1", visitVersion: 3, started: true, movable: "yes", laneRole: "lead", fieldpulse: false,
      crew: [
        { technicianId: ALEX, name: "Alex Rivera", isLead: true, state: "working" },
        { technicianId: SAM, name: null, isLead: false, state: "done" },
      ],
    });
  });
  it("movable 'no': FieldPulse, a displayed #2+, ended, a cancelled #1, a terminal request", () => {
    expect(boardCardFields(row({ fieldpulse: true })).movable).toBe("no");
    expect(boardCardFields(row({ visit_number: 2 })).movable).toBe("no");
    expect(boardCardFields(row({ ended: true })).movable).toBe("no");
    expect(boardCardFields(row({ visit_cancelled: true })).movable).toBe("no");
    expect(boardCardFields(row({ status: "completed" })).movable).toBe("no");
  });
  it("no visit #1 yet (Unscheduled): visitId null, movable, empty crew; JSON text crew parses", () => {
    expect(boardCardFields(row({ visit_id: null, visit_number: null, visit_version: null, crew: "[]" }))).toMatchObject({
      visitId: null, visitVersion: null, movable: "yes", crew: [], started: false,
    });
  });
  it("an untouched on_hold lead is open, a paused one working", () => {
    expect(boardCardFields(row({ crew: [{ technicianId: ALEX, name: "A", isLead: true, status: "on_hold", hasTimestamp: false }] })).crew[0]!.state).toBe("open");
    expect(boardCardFields(row({ crew: [{ technicianId: ALEX, name: "A", isLead: true, status: "on_hold", hasTimestamp: true }] })).crew[0]!.state).toBe("working");
  });
});
```

In `src/lib/admin/queries.test.ts`, replace the shift-queries mock

```ts
vi.mock('./shift-queries', () => ({
  technicianTimeOffOverlapping: timeOffMock,
}));
```

with

```ts
const { listShiftsMock, boardVisitsMock } = vi.hoisted(() => ({
  listShiftsMock: vi.fn(async (..._args: unknown[]) => [] as unknown[]),
  boardVisitsMock: vi.fn(async (..._args: unknown[]) => new Map<string, unknown>()),
}));
vi.mock('./shift-queries', () => ({
  technicianTimeOffOverlapping: timeOffMock,
  listShiftsInRange: listShiftsMock,
}));
// The board's crew read runs after the five selects (spec §7.1); the visit feed stays index 4.
vi.mock('./board-crew-queries', () => ({ readBoardVisits: boardVisitsMock }));
```

and append inside `describe('getSchedulingCalendar', …)`:

```ts
  it('M2: every card gets its visit, version, crew and movable; blocks only for a one-day view', async () => {
    selectResolutions = [
      [{ id: TECH_A, name: 'Ann', email: 'a@x.io', isActive: true, createdAt: new Date() }],
      [placedRow({ id: 'j1', referenceNumber: 'HVAC-1', assignedTo: TECH_A })],
      [placedRow({ id: 'u1', referenceNumber: 'HVAC-9', arrivalWindowStart: null, arrivalWindowEnd: null, status: 'pending' })],
      [],
      [],
    ];
    const fields = { visitId: 'v1', visitVersion: 2, crew: [], started: false, movable: 'yes', laneRole: 'lead', fieldpulse: false };
    boardVisitsMock.mockResolvedValueOnce(new Map<string, unknown>([['j1', fields], ['u1', { ...fields, visitId: null, visitVersion: null }]]));
    listShiftsMock.mockResolvedValueOnce([{ id: 's1', technicianId: TECH_A, kind: 'time_off', title: null, startsAt: START, endsAt: END, removesCapacity: true }]);
    const calendar = await getSchedulingCalendar(ORG_ID, START, END, ['2026-06-07']);
    expect(boardVisitsMock).toHaveBeenCalledWith(ORG_ID, ['j1', 'u1']);
    expect(calendar.lanes[0]!.jobs[0]).toMatchObject({ id: 'j1', visitId: 'v1', visitVersion: 2, movable: 'yes', laneRole: 'lead' });
    expect(calendar.unscheduled[0]).toMatchObject({ id: 'u1', visitId: null });
    expect(calendar.blocks).toEqual([{ id: 's1', technicianId: TECH_A, kind: 'time_off', title: null, startsAt: START, endsAt: END, removesCapacity: true }]);
    expect(listShiftsMock).toHaveBeenCalledWith(ORG_ID, START, END);
  });

  it('M2: a week view has no blocks and doesn\'t read shifts', async () => {
    selectResolutions = [[{ id: TECH_A, name: 'Ann', email: 'a@x.io', isActive: true, createdAt: new Date() }], [], [], [], []];
    listShiftsMock.mockClear();
    const calendar = await getSchedulingCalendar(ORG_ID, START, END, [...DAYS]);
    expect(calendar.blocks).toBeUndefined();
    expect(listShiftsMock).not.toHaveBeenCalled();
  });
```

Run: `npx vitest run src/lib/admin/board-crew-queries.test.ts src/lib/admin/queries.test.ts`
Expected: FAIL — `./board-crew-queries` unresolved; the cards carry no `visitId`.

- [ ] **Step 2: Implement** — `src/lib/admin/board-crew-queries.ts`:

```ts
/**
 * The board's per-card visit read (M2 spec §7.1): for each placed and
 * Unscheduled card, the displayed visit (else visit #1, spec §4.1), its
 * version, whether it ended or was cancelled, and its live rows joined to
 * users (an inactive technician's name withheld, as dashboardRequestSelect).
 * One query, org-bound on every table.
 */
import { sql, type SQL } from "drizzle-orm";
import { readRows } from "./invoice-field-writes";
import { displayVisitIdSql, visitEndedSql } from "./current-visit";
import { anyTimestampSql, rowStarted } from "./visit-started";
import type { CrewMember, CrewState, LaneRole, Movable } from "./board-types";

export function boardVisitsSql(org: string, requestIds: readonly string[]): SQL {
  return sql`SELECT "service_requests"."id" AS request_id, "service_requests"."status" AS status,
      ("service_requests"."fieldpulse_job_id" IS NOT NULL) AS fieldpulse,
      bv.id AS visit_id, bv.appointment_number AS visit_number, bv.version AS visit_version,
      (bv.cancelled_at IS NOT NULL) AS visit_cancelled, ${visitEndedSql()} AS ended,
      COALESCE((SELECT json_agg(json_build_object('technicianId', a.technician_id, 'name', CASE WHEN u.is_active THEN u.name END,
          'isLead', a.is_lead, 'status', a.status, 'hasTimestamp', ${anyTimestampSql("a")}) ORDER BY a.is_lead DESC, a.assigned_at)
        FROM appointment_assignments a JOIN users u ON u.id = a.technician_id AND u.organization_id = ${org}::uuid
        WHERE a.appointment_id = bv.id AND a.organization_id = ${org}::uuid AND a.status <> 'cancelled'::request_status), '[]'::json) AS crew
    FROM service_requests
    LEFT JOIN appointments bv ON bv.organization_id = ${org}::uuid
      AND bv.id = COALESCE(${displayVisitIdSql()},
        (SELECT b1.id FROM appointments b1 WHERE b1.service_request_id = "service_requests"."id" AND b1.organization_id = ${org}::uuid AND b1.appointment_number = 1))
    WHERE "service_requests"."organization_id" = ${org}::uuid AND "service_requests"."id" = ANY(${sql.param([...requestIds])}::uuid[])`;
}

export interface BoardCardFields {
  readonly visitId: string | null;
  readonly visitVersion: number | null;
  readonly crew: readonly CrewMember[];
  readonly started: boolean;
  readonly movable: Movable;
  readonly laneRole: LaneRole;
  readonly fieldpulse: boolean;
}

type Row = Record<string, unknown>;

function crewState(status: string, isLead: boolean, hasTimestamp: boolean): CrewState {
  if (status === "completed") return "done";
  return rowStarted({ status, isLead, hasTimestamp }) ? "working" : "open";
}

export function boardCardFields(row: Row): BoardCardFields {
  const raw = Array.isArray(row.crew) ? row.crew : typeof row.crew === "string" ? (JSON.parse(row.crew) as unknown[]) : [];
  const members = raw.map((m) => {
    const o = m as Row;
    const status = String(o.status);
    const isLead = o.isLead === true;
    const hasTimestamp = o.hasTimestamp === true;
    return { technicianId: String(o.technicianId), name: (o.name as string | null) ?? null, isLead, status, hasTimestamp };
  });
  const status = String(row.status);
  const visitNumber = row.visit_number === null || row.visit_number === undefined ? null : Number(row.visit_number);
  const fixed =
    row.fieldpulse === true ||
    (visitNumber !== null && visitNumber > 1) ||
    row.ended === true ||
    row.visit_cancelled === true ||
    status === "completed" || status === "cancelled";
  return {
    visitId: (row.visit_id as string | null) ?? null,
    visitVersion: row.visit_version === null || row.visit_version === undefined ? null : Number(row.visit_version),
    crew: members.map(({ technicianId, name, isLead, status: s, hasTimestamp }) => ({ technicianId, name, isLead, state: crewState(s, isLead, hasTimestamp) })),
    started: members.some((m) => rowStarted(m)),
    movable: fixed ? "no" : "yes",
    laneRole: "lead",
    fieldpulse: row.fieldpulse === true,
  };
}

export async function readBoardVisits(org: string, requestIds: readonly string[]): Promise<ReadonlyMap<string, BoardCardFields>> {
  if (requestIds.length === 0) return new Map();
  const rows = await readRows(boardVisitsSql(org, requestIds));
  return new Map(rows.map((r) => [String(r.request_id), boardCardFields(r)]));
}
```

In `src/lib/admin/queries.ts`, change the shift-queries import line to `import { listShiftsInRange, technicianTimeOffOverlapping } from "./shift-queries";`, add `import { readBoardVisits } from "./board-crew-queries";` below it, and replace the tail of `getSchedulingCalendar`

```ts
  const lanes: readonly CalendarTechnicianLane[] = activeTechs.map((tech) => ({
    technicianId: tech.id,
    technicianName: tech.name,
    jobs: byTech.get(tech.id) ?? [],
  }));

  return {
    days: [...days],
    lanes,
    unassigned,
    unscheduled: unscheduledRows.map(toDashboardRequest),
    availability: [...availability],
  };
}
```

with

```ts
  const unscheduled = unscheduledRows.map(toDashboardRequest);
  // M2 §7.1: after the five reads, the cards' visits and crew (one query) and,
  // for a day view, every shift overlapping the day (blocks, all kinds).
  const placedIds = [...[...byTech.values()].flat(), ...unassigned].map((j) => j.id);
  const [visits, shifts] = await Promise.all([
    readBoardVisits(organizationId, [...new Set([...placedIds, ...unscheduled.map((j) => j.id)])]),
    days.length === 1 ? listShiftsInRange(organizationId, startIso, endIso) : Promise.resolve(null),
  ]);
  const withVisit = (job: DashboardRequest): DashboardRequest => {
    const fields = visits.get(job.id);
    return fields ? { ...job, ...fields } : job;
  };

  const lanes: readonly CalendarTechnicianLane[] = activeTechs.map((tech) => ({
    technicianId: tech.id,
    technicianName: tech.name,
    jobs: (byTech.get(tech.id) ?? []).map(withVisit),
  }));

  return {
    days: [...days],
    lanes,
    unassigned: unassigned.map(withVisit),
    unscheduled: unscheduled.map(withVisit),
    availability: [...availability],
    ...(shifts ? { blocks: shifts.map((s) => ({ ...s })) } : {}),
  };
}
```

(`ShiftRecord` and `BoardBlock` have the same fields. A card the read missed — a race with a delete — keeps its fields absent; the client treats an absent `movable` as `"no"`, Task 9a.)

- [ ] **Step 3: Run the tests to verify they pass**

Run: `npx vitest run src/lib/admin/board-crew-queries.test.ts src/lib/admin/queries.test.ts`
Expected: PASS (the existing `getSchedulingCalendar` cases still pass: the default mocks return an empty map and no shifts).

- [ ] **Step 4: Latency, after.** Same throwaway-org recipe as Step 0 on this task's code: five timed `GET /api/admin/calendar?view=day&date=<day>`; record the median beside Step 0's. Delete the org. (Never `git stash` in this tree: other agents share it.)

- [ ] **Step 5: Gates and commit**

```bash
npx tsc --noEmit && npx eslint src/lib/admin/board-crew-queries.ts src/lib/admin/board-crew-queries.test.ts src/lib/admin/queries.ts src/lib/admin/queries.test.ts && npx vitest run
git add src/lib/admin/board-crew-queries.ts src/lib/admin/board-crew-queries.test.ts src/lib/admin/queries.ts src/lib/admin/queries.test.ts
git commit -m "$(cat <<'EOF'
feat(m2): board cards carry visit, version, crew and movable; day-view blocks

One extra org-scoped read after the calendar's five: the displayed visit
(else visit #1), its version and live crew with withheld inactive names;
movable is no for FieldPulse, later, ended, cancelled or terminal visits.
A one-day view also returns every shift overlapping the day.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01GuWoF63tQU1i7ELqyYU3A6
EOF
)"
```

---
### Task 8: Routes — move, mass preview and commit; `/reschedule` removed

**Files:**
- Create: `src/lib/admin/move-body.ts`, `src/lib/admin/move-body.test.ts`, `src/lib/admin/move-pushes.ts`, `src/app/api/admin/requests/[id]/move/route.ts`, `src/app/api/admin/requests/[id]/move/route.test.ts`, `src/app/api/admin/dispatch/mass-reschedule/route.ts`, `src/app/api/admin/dispatch/mass-reschedule/preview/route.ts`, `src/app/api/admin/dispatch/mass-reschedule/route.test.ts`, `src/lib/admin/m2-imports.test.ts`
- Delete: `src/app/api/admin/requests/[id]/reschedule/route.ts`, `src/app/api/admin/requests/[id]/reschedule/route.test.ts`, `tests/api/admin/reschedule.test.ts`

**Interfaces:**
- Consumes: Task 5 `moveVisit`, `MoveResult`; Task 6 `previewMassReschedule`, `commitMassReschedule`, `massQuerySchema`, `massCommitSchema`, `massDateInRange`; existing `withIdempotency`, `canonicalHash`, `parseIdempotencyKey`, `toResponse` (`@/lib/http/idempotency`), `syncRequestToCalendar`, `pushJobToHcp`, `businessIsoDate`, `isRealIsoDate`, `RESCHEDULE_WINDOW_ROWS`, `ARRIVAL_WINDOWS`.
- Produces: the three routes (contract shapes); `parseMoveBody(raw)` → `{ ok: true; body: MoveBody } | { ok: false; path: (string | number)[] }` (ids lowercased); `registerRequestPushes(org, requestIds, schedule?)`.
- Between this task and Task 9b, today's board still calls `/reschedule` (now 404) — drags on the old board show its generic error. The branch isn't deployed until Task 11; Task 9b replaces the hook.

- [ ] **Step 1: Write the failing tests** — `src/lib/admin/move-body.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { parseMoveBody } from "./move-body";

const V = "C3333333-3333-4333-8333-333333333333";
const T = "B2222222-2222-4222-8222-222222222222";
const ok = { visitId: V, expectedVersion: 3, day: "2026-11-10", band: "afternoon", windowRule: "match", technicianId: T, confirm: [] };

describe("parseMoveBody", () => {
  it("lowercases the path-independent ids", () => {
    expect(parseMoveBody(ok)).toEqual({ ok: true, body: { ...ok, visitId: V.toLowerCase(), technicianId: T.toLowerCase() } });
  });
  it("visitId and expectedVersion are both null or both set", () => {
    expect(parseMoveBody({ ...ok, visitId: null, expectedVersion: null }).ok).toBe(true);
    expect(parseMoveBody({ ...ok, visitId: null })).toEqual({ ok: false, path: ["expectedVersion"] });
  });
  it("a real day, a drop band, a rule; pick needs a pick", () => {
    expect(parseMoveBody({ ...ok, day: "2026-02-30" })).toMatchObject({ ok: false, path: ["day"] });
    expect(parseMoveBody({ ...ok, band: "anytime" })).toMatchObject({ ok: false, path: ["band"] });
    expect(parseMoveBody({ ...ok, windowRule: "exact" })).toMatchObject({ ok: false, path: ["windowRule"] });
    expect(parseMoveBody({ ...ok, windowRule: "pick" })).toEqual({ ok: false, path: ["pick"] });
    expect(parseMoveBody({ ...ok, windowRule: "pick", pick: "anytime" }).ok).toBe(true);
  });
  it("confirm: started and/or conflict, each once", () => {
    expect(parseMoveBody({ ...ok, confirm: ["started", "conflict"] }).ok).toBe(true);
    expect(parseMoveBody({ ...ok, confirm: ["started", "started"] })).toMatchObject({ ok: false, path: ["confirm"] });
    expect(parseMoveBody({ ...ok, confirm: ["override"] })).toMatchObject({ ok: false });
  });
  it("a non-uuid technician is refused", () => {
    expect(parseMoveBody({ ...ok, technicianId: "alex" })).toMatchObject({ ok: false, path: ["technicianId"] });
  });
});
```

`src/app/api/admin/requests/[id]/move/route.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/session", () => ({ getAdminSession: vi.fn() }));
vi.mock("@/lib/admin/visit-move", () => ({ moveVisit: vi.fn() }));
vi.mock("@/lib/admin/move-pushes", () => ({ registerRequestPushes: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({
  slidingWindow: () => ({ allowed: true }),
  RATE_LIMITS: { adminMutation: { maxRequests: 30, windowMs: 60000 } },
}));

import { POST } from "./route";
import { getAdminSession } from "@/lib/auth/session";
import { moveVisit } from "@/lib/admin/visit-move";
import { registerRequestPushes } from "@/lib/admin/move-pushes";

const RID = "11111111-1111-4111-8111-111111111111";
const V = "c3333333-3333-4333-8333-333333333333";
const body = { visitId: V, expectedVersion: 3, day: "2026-11-10", band: "afternoon", windowRule: "match", confirm: [] };
const call = (b: unknown = body, id = RID) =>
  POST(new Request("http://t/api", { method: "POST", body: JSON.stringify(b) }) as never, { params: Promise.resolve({ id }) } as never);
const data = { visitId: V, visitVersion: 4, requestStatus: "scheduled", arrivalWindowStart: "a", arrivalWindowEnd: "b", leadId: null, confirmed: [] };

beforeEach(() => {
  vi.clearAllMocks();
  (getAdminSession as unknown as Mock).mockResolvedValue({ userId: "u", organizationId: "o" });
});

describe("POST /api/admin/requests/[id]/move", () => {
  it("401 without an admin session (a technician cookie has none)", async () => {
    (getAdminSession as unknown as Mock).mockResolvedValue(null);
    expect((await call()).status).toBe(401);
  });
  it("400 on a non-UUID id or an invalid body; nothing moves", async () => {
    expect((await call(body, "nope")).status).toBe(400);
    const res = await call({ ...body, windowRule: "pick" });
    expect(res.status).toBe(400);
    expect((await res.json()).error).toMatchObject({ code: "VALIDATION_ERROR", details: { path: ["pick"] } });
    expect(moveVisit).not.toHaveBeenCalled();
  });
  it("lowercases the path id and every body id", async () => {
    (moveVisit as unknown as Mock).mockResolvedValue({ ok: true, data, pushes: false });
    await call({ ...body, visitId: V.toUpperCase(), technicianId: "B2222222-2222-4222-8222-222222222222" }, RID.toUpperCase());
    expect(moveVisit).toHaveBeenCalledWith("o", "u", RID, { ...body, technicianId: "b2222222-2222-4222-8222-222222222222" });
  });
  it("200 with the data; pushes registered only when the window or lead changed", async () => {
    (moveVisit as unknown as Mock).mockResolvedValue({ ok: true, data, pushes: true });
    const res = await call();
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual(data);
    expect(registerRequestPushes).toHaveBeenCalledWith("o", [RID]);
    (moveVisit as unknown as Mock).mockResolvedValue({ ok: true, data, pushes: false });
    await call();
    expect(registerRequestPushes).toHaveBeenCalledTimes(1);
  });
  it.each([
    [409, "HAS_PROGRESS", { needs: ["started"], started: [{ technicianId: "t", status: "arrived", hasTimestamp: true, openTimeEntry: true }] }],
    [409, "SCHEDULE_CONFLICT", { needs: ["conflict"], outsideAvailability: true }],
    [409, "TIME_OFF", { timeOff: [{ technicianId: "t", startsAt: "a", endsAt: "b", kind: "time_off" }] }],
    [409, "VISIT_PINNED", { visitNumber: 2 }],
    [409, "STALE", undefined],
    [400, "WINDOW_ENDED", undefined],
    [404, "NOT_FOUND", undefined],
  ])("a refusal keeps its status, code and details (%s %s); no pushes", async (status, code, details) => {
    (moveVisit as unknown as Mock).mockResolvedValue({ ok: false, status, code, message: "m", ...(details ? { details } : {}) });
    const res = await call();
    expect(res.status).toBe(status);
    const json = await res.json();
    expect(json.error.code).toBe(code);
    if (details) expect(json.error.details).toEqual(details);
    if (code === "TIME_OFF") expect(json.error.details.needs).toBeUndefined();
    expect(JSON.stringify(json)).not.toMatch(/Rivera|Lee/);
    expect(registerRequestPushes).not.toHaveBeenCalled();
  });
  it("500 with human copy when the writer throws", async () => {
    (moveVisit as unknown as Mock).mockRejectedValue(new Error("boom: secret"));
    const res = await call();
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("secret");
  });
});
```

`src/app/api/admin/dispatch/mass-reschedule/route.test.ts`:

```ts
import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/session", () => ({ getAdminSession: vi.fn() }));
vi.mock("@/lib/admin/mass-reschedule", async (orig) => ({
  ...(await orig<typeof import("@/lib/admin/mass-reschedule")>()),
  previewMassReschedule: vi.fn(async () => []),
  commitMassReschedule: vi.fn(async () => ({ status: 200, envelope: { success: true, data: { moved: [], skipped: [], pushesNotSent: [] } } })),
}));
vi.mock("@/lib/http/idempotency", async (orig) => ({
  ...(await orig<typeof import("@/lib/http/idempotency")>()),
  withIdempotency: vi.fn(async (_scope: unknown, _hash: string, run: (ids: { id: (n: string) => string }) => Promise<unknown>) => ({
    ...((await run({ id: (n) => `derived-${n}` })) as object), replayed: false,
  })),
}));
vi.mock("@/lib/rate-limit", () => ({
  slidingWindow: () => ({ allowed: true }),
  RATE_LIMITS: { adminMutation: { maxRequests: 30, windowMs: 60000 }, adminRead: { maxRequests: 60, windowMs: 60000 } },
}));

import { POST as COMMIT } from "./route";
import { POST as PREVIEW } from "./preview/route";
import { getAdminSession } from "@/lib/auth/session";
import { commitMassReschedule, previewMassReschedule } from "@/lib/admin/mass-reschedule";
import { withIdempotency } from "@/lib/http/idempotency";
import { businessIsoDate } from "@/lib/admin/calendar-time";

const T = "a1111111-1111-4111-8111-111111111111";
const today = businessIsoDate(new Date());
const plus = (n: number) => { const d = new Date(`${today}T00:00:00.000Z`); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const vid = (i: number) => `${String(i).padStart(8, "0")}-0000-4000-8000-000000000000`;
const commitBody = (over: Record<string, unknown> = {}) => ({
  technicianId: T, fromDate: plus(1), toDate: plus(2), visits: [{ visitId: vid(1), expectedVersion: 0 }], preSkipped: [], confirmConflict: false, ...over,
});
const req = (url: string, body: unknown, key?: string) =>
  Object.assign(new Request(url, { method: "POST", body: JSON.stringify(body), headers: key ? { "idempotency-key": key } : {} }), {
    nextUrl: new URL(url),
  }) as never;

beforeEach(() => {
  vi.clearAllMocks();
  (getAdminSession as unknown as Mock).mockResolvedValue({ userId: "u", organizationId: "o" });
});

describe("mass reschedule routes", () => {
  it("preview: 400 outside today − 1 … today + 365 or on a bad id; 200 candidates", async () => {
    expect((await PREVIEW(req("http://t/api/admin/dispatch/mass-reschedule/preview", { technicianId: T, fromDate: plus(-2), toDate: plus(1) }))).status).toBe(400);
    expect((await PREVIEW(req("http://t/api/admin/dispatch/mass-reschedule/preview", { technicianId: "x", fromDate: plus(1), toDate: plus(1) }))).status).toBe(400);
    const res = await PREVIEW(req("http://t/api/admin/dispatch/mass-reschedule/preview", { technicianId: T, fromDate: plus(1), toDate: plus(366) }));
    expect(res.status).toBe(400);
    const okRes = await PREVIEW(req("http://t/api/admin/dispatch/mass-reschedule/preview", { technicianId: T.toUpperCase(), fromDate: plus(1), toDate: plus(2) }));
    expect(okRes.status).toBe(200);
    expect((await okRes.json()).data).toEqual({ candidates: [] });
    expect(previewMassReschedule).toHaveBeenCalledWith("o", { technicianId: T, fromDate: plus(1), toDate: plus(2) });
  });
  it("commit: an Idempotency-Key is required", async () => {
    const res = await COMMIT(req("http://t/api/admin/dispatch/mass-reschedule", commitBody()));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("IDEMPOTENCY_KEY_MISSING");
  });
  it("commit: a 31st visit, a forged preSkipped reason, a duplicate id → 400 before any key is claimed", async () => {
    const many = Array.from({ length: 31 }, (_, i) => ({ visitId: vid(i), expectedVersion: 0 }));
    for (const b of [commitBody({ visits: many }), commitBody({ preSkipped: [{ visitId: vid(9), reason: "vip" }] }), commitBody({ visits: [{ visitId: vid(1), expectedVersion: 0 }, { visitId: vid(1), expectedVersion: 1 }] })]) {
      expect((await COMMIT(req("http://t/api/admin/dispatch/mass-reschedule", b, "k1"))).status).toBe(400);
    }
    expect(withIdempotency).not.toHaveBeenCalled();
  });
  it("commit: nothing to change (same day, same or no technician) → 400", async () => {
    for (const b of [commitBody({ toDate: plus(1) }), commitBody({ toDate: plus(1), toTechnicianId: T.toUpperCase() })]) {
      expect((await COMMIT(req("http://t/api/admin/dispatch/mass-reschedule", b, "k2"))).status).toBe(400);
    }
    expect(withIdempotency).not.toHaveBeenCalled();
  });
  it("commit: keyed by (org, user, path, key); the audit id is derivedId(scope, 'audit')", async () => {
    const res = await COMMIT(req("http://t/api/admin/dispatch/mass-reschedule", commitBody(), "key-1"));
    expect(res.status).toBe(200);
    expect((withIdempotency as unknown as Mock).mock.calls[0]![0]).toEqual({ organizationId: "o", userId: "u", route: "/api/admin/dispatch/mass-reschedule", key: "key-1" });
    expect((commitMassReschedule as unknown as Mock).mock.calls[0]![3]).toBe("derived-audit");
  });
});
```

`src/lib/admin/m2-imports.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

/** Spec §9 route tests: no M2 route or writer imports a FieldPulse client or push (lead ruling L3.1-1). */
const ROOT = join(__dirname, "..", "..", "..");
const M2_FILES = [
  "src/lib/admin/visit-move.ts", "src/lib/admin/visit-move-plan.ts", "src/lib/admin/visit-move-sql.ts",
  "src/lib/admin/mass-reschedule.ts", "src/lib/admin/mass-reschedule-model.ts", "src/lib/admin/board-move.ts",
  "src/lib/admin/board-crew-queries.ts", "src/lib/admin/move-pushes.ts", "src/lib/admin/move-body.ts",
  "src/app/api/admin/requests/[id]/move/route.ts", "src/app/api/admin/requests/[id]/unschedule/route.ts",
  "src/app/api/admin/requests/[id]/assign/route.ts", "src/app/api/admin/dispatch/mass-reschedule/route.ts",
  "src/app/api/admin/dispatch/mass-reschedule/preview/route.ts",
  // Writers M2 modifies (regression cover, critic A m8).
  "src/lib/admin/assignment-queries.ts", "src/lib/admin/scheduling-queries.ts", "src/lib/admin/queries.ts",
  "src/lib/admin/appointment-queries.ts",
];

describe("M2 makes no FieldPulse call", () => {
  it.each(M2_FILES)("%s imports nothing from integrations/fieldpulse", (f) => {
    const src = readFileSync(join(ROOT, f), "utf8");
    expect(src).not.toMatch(/integrations\/fieldpulse/);
    expect(src).not.toMatch(/pushJobToFieldpulse|pushScheduleToFieldpulse/);
  });
  it("the /reschedule route is gone (POST → 404)", () => {
    expect(existsSync(join(ROOT, "src/app/api/admin/requests/[id]/reschedule/route.ts"))).toBe(false);
  });
});
```

Run: `npx vitest run src/lib/admin/move-body.test.ts "src/app/api/admin/requests/[id]/move/route.test.ts" src/app/api/admin/dispatch/mass-reschedule/route.test.ts src/lib/admin/m2-imports.test.ts`
Expected: FAIL — modules don't exist; `/reschedule` still exists.

- [ ] **Step 2: Body and pushes.** `src/lib/admin/move-body.ts`:

```ts
/** The move route's body (M2 spec §5.3, §6), validated and with ids lowercased (lead ruling 18). */
import { z } from "zod";
import { ARRIVAL_WINDOWS } from "./arrival-window";
import { isRealIsoDate, RESCHEDULE_WINDOW_ROWS } from "./calendar-time";
import type { MoveBody } from "./board-types";

export const moveBodySchema = z
  .object({
    visitId: z.uuid().nullable(),
    expectedVersion: z.number().int().min(0).nullable(),
    day: z.string().refine(isRealIsoDate, "Use a real date."),
    band: z.enum(RESCHEDULE_WINDOW_ROWS),
    windowRule: z.enum(["match", "pick", "keep"]),
    pick: z.enum(ARRIVAL_WINDOWS).optional(),
    technicianId: z.uuid().optional(),
    confirm: z.array(z.enum(["started", "conflict"])).max(2).refine((c) => new Set(c).size === c.length, "Each once."),
  })
  .refine((b) => (b.visitId === null) === (b.expectedVersion === null), { path: ["expectedVersion"], message: "visitId and expectedVersion go together." })
  .refine((b) => b.windowRule !== "pick" || b.pick !== undefined, { path: ["pick"], message: "Pick a window." });

export function parseMoveBody(raw: unknown): { readonly ok: true; readonly body: MoveBody } | { readonly ok: false; readonly path: (string | number)[] } {
  const parsed = moveBodySchema.safeParse(raw);
  if (!parsed.success) return { ok: false, path: (parsed.error.issues[0]?.path ?? []) as (string | number)[] };
  const b = parsed.data;
  return {
    ok: true,
    body: {
      ...b,
      visitId: b.visitId?.toLowerCase() ?? null,
      ...(b.technicianId ? { technicianId: b.technicianId.toLowerCase() } : {}),
    },
  };
}
```

`src/lib/admin/move-pushes.ts`:

```ts
/**
 * The pushes after a board move (M2 spec §5.1 table): Google Calendar and
 * Housecall Pro, as today's drag did; never FieldPulse. Registered with
 * after() (serverless background work) once the response is built.
 */
import { after } from "next/server";
import { syncRequestToCalendar } from "@/lib/integrations/google-calendar/sync";
import { pushJobToHcp } from "@/lib/integrations/housecall-pro/job-sync";

export function registerRequestPushes(
  organizationId: string,
  requestIds: readonly string[],
  schedule: (fn: () => unknown) => void = (fn) => after(fn as () => void),
): void {
  for (const id of requestIds) {
    schedule(() => syncRequestToCalendar(organizationId, id));
    schedule(() => pushJobToHcp(organizationId, id));
  }
}
```

- [ ] **Step 3: The move route** — `src/app/api/admin/requests/[id]/move/route.ts`:

```ts
import type { NextRequest } from "next/server";
import { getAdminSession } from "@/lib/auth/session";
import { moveVisit } from "@/lib/admin/visit-move";
import { parseMoveBody } from "@/lib/admin/move-body";
import { registerRequestPushes } from "@/lib/admin/move-pushes";
import { successResponse, errorResponse, readJsonBody } from "@/lib/api-response";
import { isUuid } from "@/lib/validation/uuid";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { errorCode, logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

/**
 * POST /api/admin/requests/[id]/move — the board's move (M2 spec §5.3): day,
 * window and/or lead of visit #1, under the card's version, with the
 * started / conflict confirms. Unkeyed (absolute values under the version
 * gate; a re-send answers STALE). The audit row is written inside the batch.
 */
export async function POST(request: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  let requestId = "";
  try {
    const session = await getAdminSession();
    if (!session) return errorResponse("Unauthorized", "UNAUTHORIZED", 401);

    const { id } = await params;
    if (!isUuid(id)) return errorResponse("Invalid request ID format", "INVALID_ID", 400);
    requestId = id.toLowerCase();

    const rate = slidingWindow(`admin:visit-move:${session.userId}`, RATE_LIMITS.adminMutation.maxRequests, RATE_LIMITS.adminMutation.windowMs);
    if (!rate.allowed) return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);

    const raw = await readJsonBody(request);
    const parsed = raw.ok ? parseMoveBody(raw.data) : { ok: false as const, path: [] };
    if (!parsed.ok) return errorResponse("Couldn’t move the request. Please try again.", "VALIDATION_ERROR", 400, { path: parsed.path });

    const result = await moveVisit(session.organizationId, session.userId, requestId, parsed.body);
    if (!result.ok) return errorResponse(result.message, result.code, result.status, result.details);
    // Registered after the response is built (spec §4.2 discipline); no FieldPulse call.
    if (result.pushes) registerRequestPushes(session.organizationId, [requestId]);
    return successResponse(result.data);
  } catch (error: unknown) {
    logger.error({ code: errorCode(error), requestId }, "Failed to move request");
    return errorResponse("Couldn’t move the request. Please try again.", "INTERNAL_ERROR", 500);
  }
}
```

- [ ] **Step 4: The mass routes.** `src/app/api/admin/dispatch/mass-reschedule/preview/route.ts`:

```ts
import type { NextRequest } from "next/server";
import { getAdminSession } from "@/lib/auth/session";
import { massDateInRange, massQuerySchema, previewMassReschedule } from "@/lib/admin/mass-reschedule";
import { businessIsoDate } from "@/lib/admin/calendar-time";
import { successResponse, errorResponse, readJsonBody } from "@/lib/api-response";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { errorCode, logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

/** POST /api/admin/dispatch/mass-reschedule/preview — what Move this day… would do (spec §5.6). Writes nothing. */
export async function POST(request: NextRequest) {
  try {
    const session = await getAdminSession();
    if (!session) return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    const rate = slidingWindow(`admin:mass-preview:${session.userId}`, RATE_LIMITS.adminRead.maxRequests, RATE_LIMITS.adminRead.windowMs);
    if (!rate.allowed) return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);

    const raw = await readJsonBody(request);
    const parsed = raw.ok ? massQuerySchema.safeParse(raw.data) : null;
    const today = businessIsoDate(new Date());
    if (!parsed?.success || !massDateInRange(parsed.data.fromDate, today) || !massDateInRange(parsed.data.toDate, today)) {
      return errorResponse("Couldn’t load the preview. Please try again.", "VALIDATION_ERROR", 400);
    }
    const q = parsed.data;
    const candidates = await previewMassReschedule(session.organizationId, {
      technicianId: q.technicianId.toLowerCase(),
      fromDate: q.fromDate,
      toDate: q.toDate,
      ...(q.toTechnicianId ? { toTechnicianId: q.toTechnicianId.toLowerCase() } : {}),
    });
    return successResponse({ candidates });
  } catch (error: unknown) {
    logger.error({ code: errorCode(error) }, "Failed to preview mass reschedule");
    return errorResponse("Couldn’t load the preview. Please try again.", "INTERNAL_ERROR", 500);
  }
}
```

`src/app/api/admin/dispatch/mass-reschedule/route.ts`:

```ts
import type { NextRequest } from "next/server";
import { getAdminSession } from "@/lib/auth/session";
import { commitMassReschedule, massCommitSchema, massDateInRange } from "@/lib/admin/mass-reschedule";
import { massChanges } from "@/lib/admin/mass-reschedule-model";
import { businessIsoDate } from "@/lib/admin/calendar-time";
import { canonicalHash, parseIdempotencyKey, toResponse, withIdempotency } from "@/lib/http/idempotency";
import { errorResponse, readJsonBody } from "@/lib/api-response";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { errorCode, logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

/**
 * POST /api/admin/dispatch/mass-reschedule — commit Move this day… (spec
 * §5.6). Keyed: the client mints one Idempotency-Key per commit body. The
 * audit row id is derivedId(scope, "audit"), the run's recovery record.
 */
export async function POST(request: NextRequest) {
  try {
    const session = await getAdminSession();
    if (!session) return errorResponse("Unauthorized", "UNAUTHORIZED", 401);
    const rate = slidingWindow(`admin:mass-reschedule:${session.userId}`, RATE_LIMITS.adminMutation.maxRequests, RATE_LIMITS.adminMutation.windowMs);
    if (!rate.allowed) return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);

    const key = parseIdempotencyKey(request.headers.get("idempotency-key"));
    if (!key) return errorResponse("Couldn’t move the requests. Please try again.", "IDEMPOTENCY_KEY_MISSING", 400);

    const raw = await readJsonBody(request);
    const parsed = raw.ok ? massCommitSchema.safeParse(raw.data) : null;
    const today = businessIsoDate(new Date());
    if (!parsed?.success || !massDateInRange(parsed.data.fromDate, today) || !massDateInRange(parsed.data.toDate, today)) {
      return errorResponse("Couldn’t move the requests. Please try again.", "VALIDATION_ERROR", 400);
    }
    // Nothing to move (same day, no other technician): refused, never audited as a run of stale rows (critic A m3).
    if (!massChanges({ ...parsed.data, toTechnicianId: parsed.data.toTechnicianId?.toLowerCase() ?? null, technicianId: parsed.data.technicianId.toLowerCase() })) {
      return errorResponse("Couldn’t move the requests. Please try again.", "VALIDATION_ERROR", 400);
    }
    const scope = { organizationId: session.organizationId, userId: session.userId, route: request.nextUrl.pathname, key };
    const result = await withIdempotency(scope, canonicalHash(raw.ok ? raw.data : {}), (ids) =>
      commitMassReschedule(session.organizationId, session.userId, parsed.data, ids.id("audit")));
    return toResponse(result);
  } catch (error: unknown) {
    logger.error({ code: errorCode(error) }, "Failed to commit mass reschedule");
    return errorResponse("Couldn’t move the requests. Please try again.", "INTERNAL_ERROR", 500);
  }
}
```

- [ ] **Step 5: Remove `/reschedule`.** Its only caller is `src/hooks/use-reschedule-job.ts:99` (Task 9b deletes the hook):

```bash
git rm "src/app/api/admin/requests/[id]/reschedule/route.ts" "src/app/api/admin/requests/[id]/reschedule/route.test.ts" tests/api/admin/reschedule.test.ts
grep -rn "requests/\${[^}]*}/reschedule\|/reschedule'" src tests | grep -v use-reschedule-job.ts   # → nothing
```

- [ ] **Step 6: Run the tests to verify they pass**

Run: `npx vitest run src/lib/admin/move-body.test.ts "src/app/api/admin/requests/[id]/move/route.test.ts" src/app/api/admin/dispatch/mass-reschedule/route.test.ts src/lib/admin/m2-imports.test.ts`
Expected: PASS.

- [ ] **Step 7: Probe on a throwaway org.** Dev server running. `probe-m2-8.mts` at the repo root (deleted after):

```ts
import { execFileSync } from "node:child_process";
const env = { ...process.env, NODE_OPTIONS: "--conditions=react-server" };
const fx = JSON.parse(execFileSync("npx", ["tsx", "scripts/agent/m2-walk.mts", "seed"], { encoding: "utf8", env }).trim().split("\n").pop()!);
const BASE = "http://localhost:3000";
const admin = { "content-type": "application/json", cookie: `hvac_admin_session=${fx.tokens.admin}`, origin: BASE };
const log = (k: string, v: unknown) => console.log(k, JSON.stringify(v));
try {
  const board = await (await fetch(`${BASE}/api/admin/calendar?view=day&date=${fx.day}`, { headers: admin })).json();
  const card = [...board.data.lanes.flatMap((l: { jobs: unknown[] }) => l.jobs)].find((j: { id: string }) => j.id === fx.requests.nineEleven) as { visitId: string; visitVersion: number; movable: string; crew: unknown[] };
  log("card", { movable: card.movable, crew: card.crew.length, blocks: board.data.blocks.length }); // {"movable":"yes","crew":1,"blocks":1}
  const move = (b: object) => fetch(`${BASE}/api/admin/requests/${fx.requests.nineEleven}/move`, { method: "POST", headers: admin, body: JSON.stringify(b) });
  // Evening: Alex's afternoon holds Lee Afternoon (12–4) and Fran Pulse (1–3), an overlap → 409 (critic B B-1).
  const b = { visitId: card.visitId, expectedVersion: card.visitVersion, day: fx.day, band: "evening", windowRule: "match", confirm: [] };
  const first = await move(b);
  const again = await move(b);
  log("move", [first.status, (await again.json()).error.code]); // [200,"STALE"]
  const fp = await (await fetch(`${BASE}/api/admin/requests/${fx.requests.fieldpulse}/move`, { method: "POST", headers: admin, body: JSON.stringify({ ...b, visitId: null, expectedVersion: null }) })).json();
  log("fieldpulse", fp.error.code); // "MANAGED_EXTERNALLY" (or "STALE" if its visit #1 exists: re-read its card instead)
  const old = await fetch(`${BASE}/api/admin/requests/${fx.requests.nineEleven}/reschedule`, { method: "POST", headers: admin, body: "{}" });
  log("reschedule", old.status); // 404
  const prev = await (await fetch(`${BASE}/api/admin/dispatch/mass-reschedule/preview`, { method: "POST", headers: admin, body: JSON.stringify({ technicianId: fx.techs.alex, fromDate: fx.day, toDate: fx.day, toTechnicianId: fx.techs.sam }) })).json();
  log("preview", prev.data.candidates.map((c: { outcome: string }) => c.outcome)); // includes "moves", "started", "fieldpulse"
} finally {
  execFileSync("npx", ["tsx", "scripts/agent/m2-walk.mts", "delete", fx.org], { encoding: "utf8", env, stdio: "inherit" });
}
```

Run `npx tsx probe-m2-8.mts`. Expected: the commented values (for the FieldPulse line, send the FieldPulse card's own `visitId` / `visitVersion` from the board to see `MANAGED_EXTERNALLY`), then `{"deleted":"<org>"}`. Delete the probe.

- [ ] **Step 8: Gates and commit**

```bash
npx tsc --noEmit && npx eslint src/lib/admin/move-body.ts src/lib/admin/move-body.test.ts src/lib/admin/move-pushes.ts "src/app/api/admin/requests/[id]/move" src/app/api/admin/dispatch/mass-reschedule src/lib/admin/m2-imports.test.ts && npx vitest run
git add src/lib/admin/move-body.ts src/lib/admin/move-body.test.ts src/lib/admin/move-pushes.ts "src/app/api/admin/requests/[id]/move" src/app/api/admin/dispatch/mass-reschedule src/lib/admin/m2-imports.test.ts
git commit -m "$(cat <<'EOF'
feat(m2): move and mass reschedule routes; drop /reschedule

POST /requests/[id]/move maps moveVisit's refusals with their details and
registers the Google/HCP pushes only when the window or lead changed. Mass
preview and the keyed commit validate dates and bodies before a key is
claimed. The old drag route and its tests are removed; no M2 file imports
a FieldPulse module.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01GuWoF63tQU1i7ELqyYU3A6
EOF
)"
```

---
### Task 9a: UI pieces — radio group, move client, cards, chips, blocks, dialogs, banner

Every component the board (9b) and the mass dialog (10) compose, plus the network client. Nothing is wired into the board yet: the board still renders the old flow, and every changed component keeps its old call sites compiling (new props are optional), so the task compiles and the suite passes at its boundary.

**Files:**
- Create: `src/components/ui/radio-group.tsx`, `src/lib/admin/move-request-client.ts`, `src/lib/admin/move-request-client.test.ts`, `src/hooks/use-move-request.ts`, `src/components/admin/calendar/crew-chips.tsx`, `src/components/admin/calendar/lane-blocks.tsx`, `src/components/admin/calendar/window-prompt-dialog.tsx`, `src/components/admin/calendar/time-off-dialog.tsx`, `src/components/admin/calendar/move-dialog.tsx`, `src/components/admin/calendar/move-banner.tsx`
- Modify: `src/components/admin/calendar/calendar-job-card.tsx` (rewritten whole), `src/components/admin/calendar/draggable-job-card.tsx` (rewritten whole), `src/components/admin/calendar/droppable-window-band.tsx` (rewritten whole), `src/components/admin/calendar/conflict-dialog.tsx` (rewritten whole: the "Move anyway?" confirm; its time-off branch is gone), `src/lib/admin/calendar-dnd.ts`, `src/lib/admin/calendar-dnd.test.ts`

**Interfaces:**
- Consumes (Tasks 1–2, exact): `MoveBody`, `MoveSuccessData`, `MoveNeedsDetails`, `TimeOffDetail`, `CrewMember`, `BoardBlock`, `LaneRole` (`board-types.ts`); `chipLayout`, `crewChipModel`, `initials`, `crewStateWord`, `showCrewChips`, `pillSize`, `moveDialogDefaults`, `moveDialogBody`, `bandEnded`, `MoveDialogForm` (`board-move.ts`); `moveErrorBanner`, `UNSCHEDULE_COPY`, `MOVE_GENERIC`, `FIELDPULSE_BOARD`, `STARTED_CUE_TITLE`, `PROMPT_FOOTNOTE`, `TIME_OFF_TITLE`, `TIME_OFF_FOOTER`, `OUT_OF_HOURS_LINE`, `firstName`, `dayLabel`, `rangeLabel` (`dispatch-copy.ts`); `PromptPlan` (`move-window.ts`). Existing: `placeJobInLane`, `businessDayBounds`, `businessIsoDate`, `arrivalWindowUtcForBusinessDate`, `formatBusinessTimeRange`, `shortBusinessTime`, `RescheduleWindowRow` (`calendar-time.ts`); `ARRIVAL_WINDOWS`, `ArrivalWindow`; `SyncPill`; `UrgencyBadge`; `StatusBadge`; `Dialog*`, `Select*`, `Button`, `Input`; `selectLabel`; `WINDOW_ENDED_MESSAGE`.
- Produces (Task 9b and 10 use exactly these):
  - `radio-group.tsx`: `RadioGroup<V extends string>({ value, onValueChange, aria-label?, className, children })`, `RadioItem({ value, disabled?, children, id? })`.
  - `move-request-client.ts`: `MoveOutcome`, `UnscheduleOutcome`, `classifyMoveResponse(status, body, names)`, `classifyUnscheduleResponse(status, body)`, `parseNeedsDetails(v)`, `parseTimeOff(v)`, `PromptChoice`, `promptChoices({ day, band, current, now, offerKeep, dayChanges })`, `windowOptionLabel(day, w)`, `cardAriaLabel(job)`, `cardTitle(job)`, `focusSelectors(requestId, laneScope)`, `DATE_LABEL_ID`, `bannerAutoClearMs(banner)`, `BannerState`.
  - `use-move-request.ts`: `useMoveRequest(): { move(requestId, body, names) → Promise<MoveOutcome>; unschedule(requestId, gate) → Promise<UnscheduleOutcome>; inFlight: ReadonlySet<string> }`.
  - Components: `CrewChips({ crew, widthPx, heightPx, view })`; `LaneBlocks({ blocks, isoDay, gridPx, pinnedPx })`; `CalendarJobCard({ job, onSelect, compact?, view?, widthPx?, heightPx?, onMove?, moveDisabled? })`; `DraggableJobCard({ job, onSelect, compact?, view?, widthPx?, heightPx?, disabled?, onMove? })`; `DroppableWindowBand({ scope, isoDay, window, topPx, heightPx, outOfHours?, ended?, off? })`; `ConflictDialog({ open, lines, conflictRows, outsideAvailability, isSubmitting, onConfirm, onCancel })`; `WindowPromptDialog({ open, title?, description, choices, defaultChoice, onCancel, onMove })`; `TimeOffDialog({ open, lines, onClose })`; `MoveDialog({ open, card, fromUnscheduled, technicians, today, now, submitting, onCancel, onSubmit })`; `MoveBanner({ banner, onClose })`.
  - `calendar-dnd.ts`: `DragJobData.laneRole?`, `DropZoneData.ended?`, `DropZoneData.off?`; `describeDropTarget` appends ", <first> is off" and ", ended".

- [ ] **Step 1: Write the failing tests** — `src/lib/admin/move-request-client.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  bannerAutoClearMs, cardAriaLabel, cardTitle, classifyMoveResponse, classifyUnscheduleResponse, focusSelectors,
  parseNeedsDetails, parseTimeOff, promptChoices, windowOptionLabel, DATE_LABEL_ID,
} from "./move-request-client";
import { MOVE_GENERIC, STALE_LINE, UNSCHEDULE_COPY } from "./dispatch-copy";
import type { DashboardRequest } from "./types";

const names = new Map([["sam", "Sam Lee"]]);
const err = (code: string, details?: unknown) => ({ success: false, error: { message: "server words", code, details } });
const DATA = {
  visitId: "v1", visitVersion: 4, requestStatus: "scheduled", arrivalWindowStart: "2026-11-10T17:00:00.000Z",
  arrivalWindowEnd: "2026-11-10T21:00:00.000Z", leadId: "sam", confirmed: [],
};

describe("classifyMoveResponse", () => {
  it("200 → ok with the data", () => {
    expect(classifyMoveResponse(200, { success: true, data: DATA }, names)).toEqual({ kind: "ok", data: DATA });
  });
  it("409 HAS_PROGRESS / SCHEDULE_CONFLICT → needs with parsed details", () => {
    const details = { needs: ["started"], started: [{ technicianId: "alex", status: "arrived", hasTimestamp: true, openTimeEntry: true }] };
    expect(classifyMoveResponse(409, err("HAS_PROGRESS", details), names)).toEqual({ kind: "needs", code: "HAS_PROGRESS", details });
    expect(classifyMoveResponse(409, err("SCHEDULE_CONFLICT", { needs: ["conflict"], outsideAvailability: true }), names))
      .toEqual({ kind: "needs", code: "SCHEDULE_CONFLICT", details: { needs: ["conflict"], outsideAvailability: true } });
    expect(classifyMoveResponse(409, err("HAS_PROGRESS", { needs: ["started"], started: [], othersStarted: true }), names))
      .toMatchObject({ kind: "needs", details: { othersStarted: true } });
  });
  it("409 TIME_OFF → time_off; never `needs`", () => {
    const timeOff = [{ technicianId: "sam", startsAt: "2026-11-10T21:00:00.000Z", endsAt: "2026-11-11T01:00:00.000Z", kind: "time_off" }];
    expect(classifyMoveResponse(409, err("TIME_OFF", { timeOff }), names)).toEqual({ kind: "time_off", timeOff });
  });
  it("409 STALE → stale", () => {
    expect(classifyMoveResponse(409, err("STALE"), names)).toEqual({ kind: "stale" });
  });
  it("other codes → error with the board's own copy, never the server message", () => {
    expect(classifyMoveResponse(409, err("TECHNICIAN_DONE", { technicianId: "sam" }), names))
      .toEqual({ kind: "error", code: "TECHNICIAN_DONE", message: "Sam has finished on this visit." });
    expect(classifyMoveResponse(500, null, names)).toEqual({ kind: "error", code: "INTERNAL_ERROR", message: MOVE_GENERIC });
  });
  it("a success envelope without data is an error, not ok", () => {
    expect(classifyMoveResponse(200, { success: true }, names).kind).toBe("error");
  });
});

describe("classifyUnscheduleResponse", () => {
  it("ok, stale, and the Unscheduled copy", () => {
    expect(classifyUnscheduleResponse(200, { success: true, data: { ok: true } })).toEqual({ kind: "ok" });
    expect(classifyUnscheduleResponse(409, err("STALE"))).toEqual({ kind: "stale" });
    expect(classifyUnscheduleResponse(409, err("HAS_PROGRESS"))).toEqual({ kind: "error", code: "HAS_PROGRESS", message: UNSCHEDULE_COPY.HAS_PROGRESS });
    expect(classifyUnscheduleResponse(409, err("WORK_LOGGED"))).toEqual({ kind: "error", code: "WORK_LOGGED", message: UNSCHEDULE_COPY.WORK_LOGGED });
    expect(classifyUnscheduleResponse(409, err("MANAGED_EXTERNALLY")).kind).toBe("error");
    expect(UNSCHEDULE_COPY.STALE).toBe(STALE_LINE);
  });
});

describe("detail parsers drop anything that isn't the contract", () => {
  it("parseNeedsDetails", () => {
    expect(parseNeedsDetails({ needs: ["started", "nope"], conflicts: [{ id: "c", referenceNumber: "R", technicianId: "t", arrivalWindowStart: "a", arrivalWindowEnd: "b", name: "x" }] }))
      .toEqual({ needs: ["started"], conflicts: [{ id: "c", referenceNumber: "R", technicianId: "t", arrivalWindowStart: "a", arrivalWindowEnd: "b" }] });
    expect(parseNeedsDetails(null)).toEqual({ needs: [] });
  });
  it("parseTimeOff", () => {
    expect(parseTimeOff({ timeOff: [{ technicianId: "s", startsAt: "a", endsAt: "b", kind: "non_job" }, { kind: "x" }] }))
      .toEqual([{ technicianId: "s", startsAt: "a", endsAt: "b", kind: "non_job" }]);
  });
});

describe("prompt choices (spec §7.5 window prompt)", () => {
  const current = { start: new Date("2026-11-10T14:00:00.000Z"), end: new Date("2026-11-10T16:00:00.000Z") };
  const early = new Date("2026-11-10T12:00:00.000Z"); // 7 AM ET
  it("Keep (with the day when it changes), the band, then Choose", () => {
    const c = promptChoices({ day: "2026-11-11", band: "afternoon", current, now: early, offerKeep: true, dayChanges: true });
    expect(c.map((x) => [x.value, x.label, x.disabled])).toEqual([
      ["keep", "Keep 9 AM–11 AM on Wed, Nov 11", false],
      ["match", "Use the afternoon window · 12 PM–4 PM", false],
      ["choose", "Choose a window", false],
    ]);
  });
  it("no Keep when it isn't offered; an ended band is disabled 'Already ended'", () => {
    const late = new Date("2026-11-10T21:30:00.000Z"); // 4:30 PM ET
    const c = promptChoices({ day: "2026-11-10", band: "afternoon", current, now: late, offerKeep: false, dayChanges: false });
    expect(c.map((x) => x.value)).toEqual(["match", "choose"]);
    expect(c[0]).toMatchObject({ disabled: true, hint: "Already ended" });
  });
  it("window option labels carry hours", () => {
    expect(windowOptionLabel("2026-11-10", "morning")).toBe("Morning · 8 AM–12 PM");
    expect(windowOptionLabel("2026-11-10", "anytime")).toBe("Anytime · 8 AM–8 PM");
  });
});

describe("card labels", () => {
  const job = (over: Partial<DashboardRequest>): DashboardRequest => ({
    id: "r1", referenceNumber: "HVAC-1", customerName: "Pat Doe", issueType: "no_heat", urgency: "medium", status: "scheduled",
    isAfterHours: false, assignedToName: null, arrivalWindowStart: null, arrivalWindowEnd: null, followUpDate: null, holdReason: null,
    autoAssigned: false, createdAt: "2026-11-01T00:00:00.000Z", syncedSource: null, ...over,
  });
  it("plain, started, FieldPulse, visit #2, ended", () => {
    expect(cardAriaLabel(job({}))).toBe("Pat Doe · HVAC-1");
    expect(cardAriaLabel(job({ started: true, movable: "yes" }))).toBe("Pat Doe · HVAC-1, started");
    expect(cardAriaLabel(job({ fieldpulse: true, movable: "no" }))).toBe("Pat Doe · HVAC-1. Change this request in FieldPulse.");
    expect(cardAriaLabel(job({ visitNumber: 2, movable: "no" }))).toBe("Pat Doe · HVAC-1. Visit #2. Change its time in the request.");
    expect(cardAriaLabel(job({ visitEnded: true, visitNumber: 2 }))).toBe("Pat Doe · HVAC-1 · Visit ended");
  });
  it("a helper copy names the lead", () => {
    const helper = job({ laneRole: "helper", crew: [{ technicianId: "a", name: "Alex Rivera", isLead: true, state: "open" }, { technicianId: "s", name: "Sam Lee", isLead: false, state: "open" }] });
    expect(cardTitle(helper)).toBe("Pat Doe · HVAC-1. Helping Alex. Move it from Alex’s lane.");
    expect(cardAriaLabel(helper)).toBe("Pat Doe · HVAC-1. Helping Alex. Move it from Alex’s lane.");
  });
  it("Unknown customer", () => {
    expect(cardAriaLabel(job({ customerName: null }))).toBe("Unknown · HVAC-1");
  });
});

describe("focus and banner helpers", () => {
  it("focus targets: the lead card, else the lane header, and the date label id", () => {
    expect(focusSelectors("r1", "t1")).toEqual({ card: '[data-request-id="r1"][data-lane-role="lead"]', lane: '[data-lane-header="t1"]' });
    expect(DATE_LABEL_ID).toBe("calendar-date-label");
  });
  it("status banners clear after 4 s; errors stay", () => {
    expect(bannerAutoClearMs({ id: 1, message: "Moved.", tone: "status" })).toBe(4000);
    expect(bannerAutoClearMs({ id: 2, message: "x", tone: "error" })).toBeNull();
    expect(bannerAutoClearMs(null)).toBeNull();
  });
});
```

Append to `src/lib/admin/calendar-dnd.test.ts` (inside the existing `describe`, after the last `it`):

```ts
  it("speaks time off and an ended band (spec §7.3)", () => {
    expect(
      describeDropTarget({ kind: "window", scope: "tech-1", isoDay: "2026-11-05", window: "evening", off: true }, names),
    ).toBe("the evening window on Thursday, November 5 for Odessa Dagley, Odessa is off");
    expect(
      describeDropTarget({ kind: "window", scope: "unassigned", isoDay: "2026-11-05", window: "morning", ended: true }, names),
    ).toBe("the morning window on Thursday, November 5, ended");
  });
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/lib/admin/move-request-client.test.ts src/lib/admin/calendar-dnd.test.ts`
Expected: FAIL — unresolved `./move-request-client`; the new calendar-dnd case fails (no "is off" suffix; `off` is not in `DropZoneData`, a type error vitest ignores).

- [ ] **Step 3: Pure client module** — `src/lib/admin/move-request-client.ts`:

```ts
/**
 * Client-side move helpers (M2 spec §7.4–§7.5): classify the move and
 * unschedule responses into the board's outcomes (copy from dispatch-copy,
 * never the server's message), the window prompt's choices, card labels, the
 * focus targets and the banner timer. Pure and client-safe.
 */
import { ARRIVAL_WINDOWS, type ArrivalWindow } from "./arrival-window";
import { arrivalWindowUtcForBusinessDate, type RescheduleWindowRow } from "./calendar-time";
import { bandEnded } from "./board-move";
import {
  FIELDPULSE_BOARD, MOVE_GENERIC, UNSCHEDULE_COPY, dayLabel, firstName, moveErrorBanner, rangeLabel,
} from "./dispatch-copy";
import type { ConflictDetail, MoveConfirm, MoveNeedsDetails, MoveSuccessData, StartedDetail, TimeOffDetail } from "./board-types";
import type { TimeWindow } from "./move-window";
import type { DashboardRequest } from "./types";

export type MoveOutcome =
  | { readonly kind: "ok"; readonly data: MoveSuccessData }
  | { readonly kind: "needs"; readonly code: "HAS_PROGRESS" | "SCHEDULE_CONFLICT"; readonly details: MoveNeedsDetails }
  | { readonly kind: "time_off"; readonly timeOff: readonly TimeOffDetail[] }
  | { readonly kind: "stale" }
  | { readonly kind: "network" }
  | { readonly kind: "error"; readonly code: string; readonly message: string };

export type UnscheduleOutcome =
  | { readonly kind: "ok" }
  | { readonly kind: "stale" }
  | { readonly kind: "network" }
  | { readonly kind: "error"; readonly code: string; readonly message: string };

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);
const str = (v: unknown): v is string => typeof v === "string";

function errorOf(body: unknown): { code: string; details: unknown } {
  const e = isObj(body) && isObj(body.error) ? body.error : null;
  return { code: e && str(e.code) ? e.code : "INTERNAL_ERROR", details: e?.details };
}

function isSuccessData(v: unknown): v is MoveSuccessData {
  return isObj(v) && str(v.visitId) && typeof v.visitVersion === "number" && str(v.requestStatus)
    && str(v.arrivalWindowStart) && str(v.arrivalWindowEnd) && (v.leadId === null || str(v.leadId)) && Array.isArray(v.confirmed);
}

const CONFIRMS: readonly MoveConfirm[] = ["started", "conflict"];

export function parseNeedsDetails(v: unknown): MoveNeedsDetails {
  if (!isObj(v)) return { needs: [] };
  const needs = Array.isArray(v.needs) ? v.needs.filter((n): n is MoveConfirm => CONFIRMS.includes(n as MoveConfirm)) : [];
  const started: StartedDetail[] | undefined = Array.isArray(v.started)
    ? v.started.filter(isObj).filter((s) => str(s.technicianId) && str(s.status)).map((s) => ({
        technicianId: s.technicianId as string, status: s.status as string,
        hasTimestamp: s.hasTimestamp === true, openTimeEntry: s.openTimeEntry === true,
      }))
    : undefined;
  const conflicts: ConflictDetail[] | undefined = Array.isArray(v.conflicts)
    ? v.conflicts.filter(isObj).filter((c) => str(c.id) && str(c.referenceNumber) && str(c.technicianId) && str(c.arrivalWindowStart) && str(c.arrivalWindowEnd))
        .map((c) => ({
          id: c.id as string, referenceNumber: c.referenceNumber as string, technicianId: c.technicianId as string,
          arrivalWindowStart: c.arrivalWindowStart as string, arrivalWindowEnd: c.arrivalWindowEnd as string,
        }))
    : undefined;
  return {
    needs,
    ...(started ? { started } : {}),
    ...(conflicts ? { conflicts } : {}),
    ...(v.outsideAvailability === true ? { outsideAvailability: true } : {}),
    ...(v.othersStarted === true ? { othersStarted: true } : {}),
  };
}

const KINDS: readonly TimeOffDetail["kind"][] = ["on_call", "time_off", "non_job"];

export function parseTimeOff(v: unknown): TimeOffDetail[] {
  if (!isObj(v) || !Array.isArray(v.timeOff)) return [];
  return v.timeOff.filter(isObj)
    .filter((t) => str(t.technicianId) && str(t.startsAt) && str(t.endsAt) && KINDS.includes(t.kind as TimeOffDetail["kind"]))
    .map((t) => ({ technicianId: t.technicianId as string, startsAt: t.startsAt as string, endsAt: t.endsAt as string, kind: t.kind as TimeOffDetail["kind"] }));
}

export function classifyMoveResponse(status: number, body: unknown, names: ReadonlyMap<string, string>): MoveOutcome {
  if (status >= 200 && status < 300) {
    const data = isObj(body) ? body.data : undefined;
    return isSuccessData(data) ? { kind: "ok", data } : { kind: "error", code: "INTERNAL_ERROR", message: MOVE_GENERIC };
  }
  const { code, details } = errorOf(body);
  if (code === "HAS_PROGRESS" || code === "SCHEDULE_CONFLICT") return { kind: "needs", code, details: parseNeedsDetails(details) };
  if (code === "TIME_OFF") return { kind: "time_off", timeOff: parseTimeOff(details) };
  if (code === "STALE") return { kind: "stale" };
  return { kind: "error", code, message: moveErrorBanner(code, details, names) };
}

export function classifyUnscheduleResponse(status: number, body: unknown): UnscheduleOutcome {
  if (status >= 200 && status < 300) return { kind: "ok" };
  const { code, details } = errorOf(body);
  if (code === "STALE") return { kind: "stale" };
  if (code === "HAS_PROGRESS") return { kind: "error", code, message: UNSCHEDULE_COPY.HAS_PROGRESS };
  if (code === "WORK_LOGGED") return { kind: "error", code, message: UNSCHEDULE_COPY.WORK_LOGGED };
  if (code === "MANAGED_EXTERNALLY") return { kind: "error", code, message: FIELDPULSE_BOARD };
  return { kind: "error", code, message: moveErrorBanner(code, details) };
}

// ── window prompt ────────────────────────────────────────────────────────────

export type PromptChoiceValue = "keep" | "match" | "choose";
export interface PromptChoice {
  readonly value: PromptChoiceValue;
  readonly label: string;
  readonly disabled: boolean;
  readonly hint?: string;
}

const WINDOW_NAME: Record<ArrivalWindow, string> = { morning: "Morning", afternoon: "Afternoon", evening: "Evening", anytime: "Anytime" };

/** "Morning · 8 AM–12 PM" — a window with its hours on `day`. */
export function windowOptionLabel(day: string, w: ArrivalWindow): string {
  const b = arrivalWindowUtcForBusinessDate(day, w);
  return `${WINDOW_NAME[w]} · ${rangeLabel(b.start, b.end)}`;
}

/** The prompt's RadioGroup (spec §7.5): Keep (only when offered), the drop band, Choose a window. */
export function promptChoices(p: {
  readonly day: string;
  readonly band: RescheduleWindowRow;
  readonly current: TimeWindow;
  readonly now: Date;
  readonly offerKeep: boolean;
  readonly dayChanges: boolean;
}): PromptChoice[] {
  const choices: PromptChoice[] = [];
  if (p.offerKeep) {
    choices.push({
      value: "keep",
      label: `Keep ${rangeLabel(p.current.start, p.current.end)}${p.dayChanges ? ` on ${dayLabel(p.day)}` : ""}`,
      disabled: false,
    });
  }
  const b = arrivalWindowUtcForBusinessDate(p.day, p.band);
  const ended = bandEnded(p.day, p.band, p.now);
  choices.push({
    value: "match",
    label: `Use the ${p.band} window · ${rangeLabel(b.start, b.end)}`,
    disabled: ended,
    ...(ended ? { hint: "Already ended" } : {}),
  });
  choices.push({ value: "choose", label: "Choose a window", disabled: false });
  return choices;
}

/** The Select's options under "Choose a window", ended ones disabled. */
export function pickOptions(day: string, now: Date): { readonly value: ArrivalWindow; readonly label: string; readonly disabled: boolean }[] {
  return ARRIVAL_WINDOWS.map((w) => ({ value: w, label: windowOptionLabel(day, w), disabled: bandEnded(day, w, now) }));
}

// ── card labels ──────────────────────────────────────────────────────────────

function leadFirst(job: DashboardRequest): string {
  return firstName(job.crew?.find((c) => c.isLead)?.name ?? null);
}

/** The title on a card: a helper copy explains where to move it. */
export function cardTitle(job: DashboardRequest): string {
  const base = `${job.customerName ?? "Unknown"} · ${job.referenceNumber}`;
  if (job.laneRole === "helper") {
    const lead = leadFirst(job);
    return `${base}. Helping ${lead}. Move it from ${lead}’s lane.`;
  }
  if (!job.visitEnded && job.visitNumber && job.visitNumber > 1) return `${base}. Visit #${job.visitNumber}. Change its time in the request.`;
  if (job.fieldpulse) return `${base}. ${FIELDPULSE_BOARD}`;
  return base;
}

export function cardAriaLabel(job: DashboardRequest): string {
  const base = `${job.customerName ?? "Unknown"} · ${job.referenceNumber}`;
  if (job.visitEnded) return `${base} · Visit ended`;
  if (job.laneRole === "helper" || (job.visitNumber && job.visitNumber > 1) || job.fieldpulse) return cardTitle(job);
  return job.started && job.movable === "yes" ? `${base}, started` : base;
}

// ── focus and banner ─────────────────────────────────────────────────────────

/** The date stepper's label: focus lands here after a Move… to another day. */
export const DATE_LABEL_ID = "calendar-date-label";

export function focusSelectors(requestId: string, laneScope: string): { readonly card: string; readonly lane: string } {
  return { card: `[data-request-id="${requestId}"][data-lane-role="lead"]`, lane: `[data-lane-header="${laneScope}"]` };
}

export interface BannerState {
  /** Bumped per banner so a repeated message restarts its timer. */
  readonly id: number;
  readonly message: string;
  readonly tone: "status" | "error";
}

/** Status banners ("Moved.", the lead-change line, the covered line) clear after 4 s; errors stay until closed. */
export function bannerAutoClearMs(banner: BannerState | null): number | null {
  return banner && banner.tone === "status" ? 4000 : null;
}
```

- [ ] **Step 4: Drop-target words** — in `src/lib/admin/calendar-dnd.ts`, replace

```ts
export interface DragJobData {
  readonly kind: "job";
  readonly requestId: string;
```

with

```ts
export interface DragJobData {
  readonly kind: "job";
  readonly requestId: string;
  /** Always "lead": helper copies are never draggable. */
  readonly laneRole?: "lead" | "helper";
```

replace

```ts
  readonly isoDay: string;
  readonly window: RescheduleWindowRow;
}

/** The droppable payload for the "Unscheduled" queue panel — a drop here clears
```

with

```ts
  readonly isoDay: string;
  readonly window: RescheduleWindowRow;
  /** The band has ended (today only). */
  readonly ended?: boolean;
  /** The lane's technician has capacity-removing time off overlapping the band. */
  readonly off?: boolean;
}

/** The droppable payload for the "Unscheduled" queue panel — a drop here clears
```

and replace

```ts
  const who =
    data.scope === "unassigned"
      ? ""
      : ` for ${technicianNames.get(data.scope) ?? "a technician"}`;
  return `${WINDOW_SPOKEN[data.window]} on ${spokenDay(data.isoDay)}${who}`;
}
```

with

```ts
  const name = data.scope === "unassigned" ? null : (technicianNames.get(data.scope) ?? null);
  const who = data.scope === "unassigned" ? "" : ` for ${name ?? "a technician"}`;
  const off = data.off && data.scope !== "unassigned" ? `, ${name ? name.split(/\s+/)[0] : "the technician"} is off` : "";
  const ended = data.ended ? ", ended" : "";
  return `${WINDOW_SPOKEN[data.window]} on ${spokenDay(data.isoDay)}${who}${off}${ended}`;
}
```

- [ ] **Step 5: Run the pure tests to verify they pass**

Run: `npx vitest run src/lib/admin/move-request-client.test.ts src/lib/admin/calendar-dnd.test.ts`
Expected: PASS.

- [ ] **Step 6: The radio group** — `src/components/ui/radio-group.tsx` (Base UI 1.5: `RadioGroup` from `@base-ui/react/radio-group`, `Radio.Root` / `Radio.Indicator` from `@base-ui/react/radio`; check `node_modules/@base-ui/react/radio-group/RadioGroup.d.ts` and `radio/root/RadioRoot.d.ts` before editing):

```tsx
'use client';

import * as React from 'react';
import { RadioGroup as RadioGroupPrimitive } from '@base-ui/react/radio-group';
import { Radio } from '@base-ui/react/radio';
import { cn } from '@/lib/utils';

/** A labelled single-choice list (M2 dialogs). Arrow keys move between items (Base UI). */
function RadioGroup<V extends string>({
  className,
  value,
  onValueChange,
  ...props
}: Omit<RadioGroupPrimitive.Props<V>, 'onValueChange'> & { onValueChange?: (value: V) => void }) {
  return (
    <RadioGroupPrimitive
      data-slot="radio-group"
      value={value}
      onValueChange={(v) => onValueChange?.(v as V)}
      className={cn('flex flex-col gap-1.5', className)}
      {...props}
    />
  );
}

/** One option: a radio and its label; `hint` renders muted after the label ("Already ended"). */
function RadioItem({
  value,
  disabled,
  children,
  hint,
  id,
}: {
  readonly value: string;
  readonly disabled?: boolean;
  readonly children: React.ReactNode;
  readonly hint?: string;
  readonly id?: string;
}) {
  const autoId = React.useId();
  const labelId = id ?? `radio-${autoId}`;
  return (
    <label
      htmlFor={labelId}
      className={cn(
        'flex min-h-9 cursor-pointer items-center gap-2 rounded-md border border-border px-2.5 py-1.5 text-sm hover:bg-row-hover',
        disabled && 'cursor-not-allowed opacity-50 hover:bg-transparent',
      )}
    >
      <Radio.Root
        id={labelId}
        value={value}
        disabled={disabled}
        className="flex size-4 shrink-0 items-center justify-center rounded-full border border-border-strong outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring data-checked:border-primary"
      >
        <Radio.Indicator className="size-2 rounded-full bg-primary" />
      </Radio.Root>
      <span className="min-w-0 flex-1">{children}</span>
      {hint && <span className="shrink-0 text-xs text-muted-foreground">{hint}</span>}
    </label>
  );
}

export { RadioGroup, RadioItem };
```

- [ ] **Step 7: The move hook** — `src/hooks/use-move-request.ts` (replaces `useRescheduleJob` in 9b; per-request in-flight set, spec §7.4):

```ts
'use client';

import { useCallback, useState } from 'react';
import type { MoveBody } from '@/lib/admin/board-types';
import {
  classifyMoveResponse,
  classifyUnscheduleResponse,
  type MoveOutcome,
  type UnscheduleOutcome,
} from '@/lib/admin/move-request-client';

/**
 * POSTs board moves (`/move`) and drags back to Unscheduled (`/unschedule`).
 * The board owns the optimistic state; this hook only sends and classifies.
 * `inFlight` holds the request ids with a call outstanding, so only that
 * request's card (and its helper copies) is disabled.
 */
export function useMoveRequest(): {
  readonly move: (requestId: string, body: MoveBody, names: ReadonlyMap<string, string>) => Promise<MoveOutcome>;
  readonly unschedule: (
    requestId: string,
    gate: { readonly visitId: string | null; readonly expectedVersion: number | null },
  ) => Promise<UnscheduleOutcome>;
  readonly inFlight: ReadonlySet<string>;
} {
  const [inFlight, setInFlight] = useState<ReadonlySet<string>>(() => new Set());
  const mark = useCallback((id: string, on: boolean) => {
    setInFlight((prev) => {
      const next = new Set(prev);
      if (on) next.add(id);
      else next.delete(id);
      return next;
    });
  }, []);

  const move = useCallback(
    async (requestId: string, body: MoveBody, names: ReadonlyMap<string, string>): Promise<MoveOutcome> => {
      mark(requestId, true);
      try {
        const res = await fetch(`/api/admin/requests/${encodeURIComponent(requestId)}/move`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });
        const json: unknown = await res.json().catch(() => null);
        return classifyMoveResponse(res.status, json, names);
      } catch {
        return { kind: 'network' };
      } finally {
        mark(requestId, false);
      }
    },
    [mark],
  );

  const unschedule = useCallback(
    async (
      requestId: string,
      gate: { readonly visitId: string | null; readonly expectedVersion: number | null },
    ): Promise<UnscheduleOutcome> => {
      mark(requestId, true);
      try {
        const res = await fetch(`/api/admin/requests/${encodeURIComponent(requestId)}/unschedule`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(gate),
        });
        const json: unknown = await res.json().catch(() => null);
        return classifyUnscheduleResponse(res.status, json);
      } catch {
        return { kind: 'network' };
      } finally {
        mark(requestId, false);
      }
    },
    [mark],
  );

  return { move, unschedule, inFlight };
}
```

- [ ] **Step 8: Crew chips and blocks** — `src/components/admin/calendar/crew-chips.tsx`:

```tsx
'use client';

import { Check, Users } from 'lucide-react';
import { chipLayout, crewChipModel, crewStateWord, initials, showCrewChips } from '@/lib/admin/board-move';
import type { CrewMember } from '@/lib/admin/board-types';

/**
 * Crew on a card (spec §7.2): only with 2+ technicians. Chips — lead first with
 * the marker border, working filled, done with a check, "+N" past three — or,
 * on a narrow, short or Week card, a people icon and the count.
 */
export function CrewChips({
  crew,
  widthPx,
  heightPx,
  view,
}: {
  readonly crew: readonly CrewMember[] | undefined;
  readonly widthPx: number;
  readonly heightPx: number;
  readonly view: 'day' | 'week';
}) {
  if (!crew || !showCrewChips(crew)) return null;
  if (chipLayout(widthPx, heightPx, view) === 'count') {
    return (
      <span
        aria-label={`${crew.length} technicians`}
        className="inline-flex shrink-0 items-center gap-0.5 font-mono text-[10px] tabular-nums text-muted-foreground"
      >
        <Users className="size-3" aria-hidden />
        {crew.length}
      </span>
    );
  }
  const { chips, more } = crewChipModel(crew);
  return (
    <span className="flex shrink-0 items-center gap-0.5" role="list" aria-label="Technicians on this visit">
      {chips.map((c) => (
        <span
          key={c.technicianId}
          role="listitem"
          aria-label={`${c.name ?? 'Technician'}, ${c.isLead ? 'lead, ' : ''}${crewStateWord(c.state)}`}
          title={`${c.name ?? 'Technician'}${c.isLead ? ' (lead)' : ''}`}
          className={`inline-flex h-4 min-w-4 items-center justify-center gap-px rounded-full border px-1 text-[9px] font-semibold leading-none ${
            c.isLead ? 'border-marker' : 'border-border-strong'
          } ${c.state === 'working' ? 'bg-primary text-primary-foreground' : 'bg-surface-raised text-foreground'}`}
        >
          {initials(c.name)}
          {c.state === 'done' && <Check className="size-2.5" aria-hidden />}
        </span>
      ))}
      {more > 0 && (
        <span className="font-mono text-[9px] tabular-nums text-muted-foreground" aria-label={`and ${more} more`}>
          +{more}
        </span>
      )}
    </span>
  );
}
```

`src/components/admin/calendar/lane-blocks.tsx`:

```tsx
'use client';

import Link from 'next/link';
import { businessDayBounds, formatBusinessTimeRange, placeJobInLane } from '@/lib/admin/calendar-time';
import type { BoardBlock } from '@/lib/admin/board-types';

const KIND_LABEL: Record<BoardBlock['kind'], string> = {
  time_off: 'Time off',
  non_job: 'Non-job event',
  on_call: 'On call',
};

/**
 * Shifts in a technician's lane (spec §7.3), between the bands and the cards:
 * non-interactive except a small "Staff" link. A capacity-removing block is
 * hatched; one that keeps capacity is outlined (on-call as a 3 px rail). Bands
 * underneath stay droppable (the drop flow refuses time off itself).
 */
export function LaneBlocks({
  blocks,
  isoDay,
  gridPx,
  pinnedPx,
}: {
  readonly blocks: readonly BoardBlock[];
  readonly isoDay: string;
  readonly gridPx: number;
  readonly pinnedPx: number;
}) {
  const day = businessDayBounds(isoDay);
  if (!day) return null;
  return (
    <>
      {blocks.map((b) => {
        // Clip a multi-day block to this day before placing it.
        const start = new Date(Math.max(Date.parse(b.startsAt), day.start.getTime()));
        const end = new Date(Math.min(Date.parse(b.endsAt), day.end.getTime()));
        if (end <= start) return null;
        const placement = placeJobInLane(start, end, pinnedPx / gridPx);
        if (!placement) return null;
        const label = b.title?.trim() || KIND_LABEL[b.kind];
        const rail = !b.removesCapacity && b.kind === 'on_call';
        const look = b.removesCapacity
          ? 'border border-border-strong bg-[repeating-linear-gradient(45deg,transparent,transparent_5px,var(--hatch-ink)_5px,var(--hatch-ink)_10px)] [--hatch-ink:color-mix(in_oklch,var(--foreground)_14%,transparent)]'
          : rail
            ? 'border-l-[3px] border-l-info'
            : 'border border-dashed border-border-strong';
        return (
          <div
            key={b.id}
            className={`pointer-events-none absolute inset-x-0 z-[5] overflow-hidden rounded-sm ${look}`}
            style={{ top: placement.top * gridPx, height: Math.max(placement.height * gridPx, 18) }}
            title={`${label} · ${formatBusinessTimeRange(new Date(b.startsAt), new Date(b.endsAt))}`}
            data-block-kind={b.kind}
          >
            <span className="flex items-center gap-1 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
              <span className="truncate">{label}</span>
              <Link href="/admin/staff" className="pointer-events-auto shrink-0 underline underline-offset-2 hover:text-foreground">
                Staff
              </Link>
            </span>
          </div>
        );
      })}
    </>
  );
}
```

- [ ] **Step 9: Cards and bands** — replace the whole of `src/components/admin/calendar/calendar-job-card.tsx`:

```tsx
'use client';

import { Activity, Lock } from 'lucide-react';
import { UrgencyBadge } from '@/components/admin/urgency-badge';
import { StatusBadge } from '@/components/admin/status-badge';
import { SyncPill } from '@/components/admin/sync-pill';
import { CrewChips } from '@/components/admin/calendar/crew-chips';
import { formatBusinessTimeRange, shortBusinessTime } from '@/lib/admin/calendar-time';
import { urgencyAccent } from '@/lib/admin/urgency-accent';
import { issueTypeLabel } from '@/lib/admin/request-labels';
import { chipLayout, pillSize, showCrewChips } from '@/lib/admin/board-move';
import { FIELDPULSE_BOARD, STARTED_CUE_TITLE, firstName } from '@/lib/admin/dispatch-copy';
import { cardAriaLabel, cardTitle } from '@/lib/admin/move-request-client';
import type { DashboardRequest } from '@/lib/admin/types';

interface CalendarJobCardProps {
  readonly job: DashboardRequest;
  readonly onSelect: (id: string) => void;
  /** Compact variant for the dense week grid — hides secondary metadata. */
  readonly compact?: boolean;
  readonly view?: 'day' | 'week';
  /** Rendered size, for the chip and pill layout (spec §7.2). */
  readonly widthPx?: number;
  readonly heightPx?: number;
  /** Set on movable lead cards and Unscheduled rows: renders the Move… button. */
  readonly onMove?: (job: DashboardRequest) => void;
  readonly moveDisabled?: boolean;
}

/**
 * A request on the calendar grid. The card is a button (opens the sheet); the
 * Move… button is its sibling, never nested, so the tab order is card → Move….
 * Times in the business timezone. M2: crew row, FieldPulse pill with a lock,
 * the started cue, helper copies and visit #2+ titles (spec §7.2).
 */
export function CalendarJobCard({
  job,
  onSelect,
  compact,
  view = 'day',
  widthPx = 220,
  heightPx = 112,
  onMove,
  moveDisabled,
}: CalendarJobCardProps) {
  const start = job.arrivalWindowStart ? new Date(job.arrivalWindowStart) : null;
  const end = job.arrivalWindowEnd ? new Date(job.arrivalWindowEnd) : null;
  const validStart = start && !Number.isNaN(start.getTime()) ? start : null;
  const validEnd = end && !Number.isNaN(end.getTime()) ? end : null;
  const time = validStart ? (validEnd ? formatBusinessTimeRange(validStart, validEnd) : shortBusinessTime(validStart)) : '—';

  const accent = urgencyAccent(job.urgency);
  const ended = job.visitEnded === true;
  const helper = job.laneRole === 'helper';
  const visitTag = ended ? 'Visit ended' : job.visitNumber ? `Visit #${job.visitNumber}` : null;
  const lead = job.crew?.find((c) => c.isLead);
  const showStarted = job.started === true && job.movable === 'yes' && !helper;
  const label = cardAriaLabel(job);
  const title = cardTitle(job);
  const fieldpulse = job.fieldpulse === true || job.syncedSource === 'fieldpulse';
  // Narrow, short or Week cards show "people icon + count" in the TOP row (spec §7.2); full chips get their own row.
  const countMode = showCrewChips(job.crew) && chipLayout(widthPx, heightPx, view) === 'count';

  return (
    <div className="relative h-full w-full">
      <button
        type="button"
        aria-label={label}
        title={title !== `${job.customerName ?? 'Unknown'} · ${job.referenceNumber}` ? title : undefined}
        data-request-id={job.id}
        data-lane-role={job.laneRole ?? 'lead'}
        onClick={() => onSelect(job.id)}
        className={`flex h-full w-full flex-col overflow-hidden rounded-sm border border-l-[3px] ${accent.bar} px-2 py-1 text-left text-xs leading-tight transition-colors hover:bg-row-hover focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring ${
          ended
            ? 'border-dashed border-border-strong bg-surface-sunken text-muted-foreground'
            : helper
              ? 'border-dashed border-border bg-surface'
              : 'border-border bg-surface-raised'
        }`}
      >
        <div className="flex shrink-0 items-center gap-1">
          {/* The time never truncates before the pill (spec §7.2). */}
          <span className={`shrink-0 font-mono font-medium tabular-nums${ended ? ' line-through' : ''}`}>{time}</span>
          {job.isAfterHours && (
            <span
              title="After hours"
              className="inline-flex shrink-0 items-center rounded-[3px] border border-warning-border bg-warning-light px-1 text-[9px] font-medium text-warning-strong"
            >
              AH
            </span>
          )}
          {countMode && <CrewChips crew={job.crew} widthPx={widthPx} heightPx={heightPx} view={view} />}
          {showStarted && (
            <span title={STARTED_CUE_TITLE} className="inline-flex shrink-0 text-info">
              <Activity className="size-3" aria-hidden />
            </span>
          )}
          {fieldpulse ? (
            <span title={FIELDPULSE_BOARD} className="ml-auto flex shrink-0 items-center gap-0.5 text-muted-foreground">
              <SyncPill source="fieldpulse" size={pillSize(view, widthPx)} />
              <Lock className="size-3" aria-hidden />
            </span>
          ) : job.syncedSource ? (
            <span className="ml-auto flex shrink-0">
              <SyncPill source={job.syncedSource} size="sm" />
            </span>
          ) : null}
        </div>
        {/* shrink-0: on a short card the customer outranks the badges. */}
        <span className={`shrink-0 truncate font-medium ${ended ? 'text-muted-foreground' : 'text-foreground'}`}>
          {job.customerName ?? 'Unknown'}
        </span>
        {helper ? (
          <span className="shrink-0 truncate text-[11px] font-medium leading-[14px] text-muted-foreground">
            Helping {firstName(lead?.name ?? null)}
          </span>
        ) : (
          visitTag && (
            <span className="shrink-0 truncate text-[11px] font-medium leading-[14px] text-muted-foreground">{visitTag}</span>
          )
        )}
        {!countMode && (
          <span className="mt-0.5 flex shrink-0">
            <CrewChips crew={job.crew} widthPx={widthPx} heightPx={heightPx} view={view} />
          </span>
        )}
        {!compact && (
          <>
            <span className="truncate text-[11px] leading-[14px] text-muted-foreground">
              {issueTypeLabel(job.issueType)} · <span className="font-mono">{job.referenceNumber}</span>
            </span>
            <span className="mt-0.5 flex flex-wrap items-center gap-1">
              <UrgencyBadge urgency={job.urgency} />
              <StatusBadge status={job.status} />
            </span>
          </>
        )}
      </button>
      {onMove && (
        <button
          type="button"
          aria-label={`Move ${job.customerName ?? 'Unknown'} · ${job.referenceNumber}`}
          disabled={moveDisabled}
          onClick={() => onMove(job)}
          // Stop the drag sensor from starting on the button (pointer down bubbles to the wrapper).
          onPointerDown={(e) => e.stopPropagation()}
          className="absolute right-1 bottom-1 z-10 inline-flex h-6 items-center rounded-sm border border-transparent bg-surface-raised/90 px-1.5 text-[11px] font-medium text-foreground hover:border-border hover:bg-row-hover focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring disabled:opacity-50"
        >
          Move…
        </button>
      )}
    </div>
  );
}
```

Replace the whole of `src/components/admin/calendar/draggable-job-card.tsx`:

```tsx
'use client';

import { useDraggable } from '@dnd-kit/core';
import { CalendarJobCard } from '@/components/admin/calendar/calendar-job-card';
import type { DashboardRequest } from '@/lib/admin/types';
import { dragJobId, type DragJobData } from '@/lib/admin/calendar-dnd';

interface DraggableJobCardProps {
  readonly job: DashboardRequest;
  readonly onSelect: (id: string) => void;
  readonly compact?: boolean;
  readonly view?: 'day' | 'week';
  readonly widthPx?: number;
  readonly heightPx?: number;
  /** This request has a move in flight: no second drag can race it. */
  readonly disabled?: boolean;
  readonly onMove?: (job: DashboardRequest) => void;
}

/**
 * A movable lead card wrapped in useDraggable. Only pointer drags (spec §7.4):
 * the wrapper is out of the tab order (tabIndex -1, no aria-roledescription /
 * aria-describedby) — the card button and its Move… are the keyboard path.
 */
export function DraggableJobCard({ job, onSelect, compact, view, widthPx, heightPx, disabled, onMove }: DraggableJobCardProps) {
  const data: DragJobData = {
    kind: 'job',
    requestId: job.id,
    currentStartIso: job.arrivalWindowStart,
    label: `${job.customerName ?? 'Unknown customer'}, ${job.referenceNumber}`,
    laneRole: 'lead',
  };
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({ id: dragJobId(job.id), data, disabled });

  return (
    <div
      ref={setNodeRef}
      {...listeners}
      {...attributes}
      role={undefined}
      tabIndex={-1}
      aria-roledescription={undefined}
      aria-describedby={undefined}
      aria-disabled={undefined}
      className={`h-full w-full touch-none ${isDragging ? 'opacity-40' : ''} ${disabled ? 'cursor-progress' : 'cursor-grab active:cursor-grabbing'}`}
    >
      <CalendarJobCard
        job={job}
        onSelect={onSelect}
        compact={compact}
        view={view}
        widthPx={widthPx}
        heightPx={heightPx}
        onMove={onMove}
        moveDisabled={disabled}
      />
    </div>
  );
}
```

Replace the whole of `src/components/admin/calendar/droppable-window-band.tsx`:

```tsx
'use client';

import { useDroppable } from '@dnd-kit/core';
import { dropZoneId, type DropZoneData } from '@/lib/admin/calendar-dnd';
import type { RescheduleWindowRow } from '@/lib/admin/calendar-time';

interface DroppableWindowBandProps {
  /** Lane scope: a technicianId, or the literal "unassigned". */
  readonly scope: string;
  readonly isoDay: string;
  readonly window: RescheduleWindowRow;
  readonly topPx: number;
  readonly heightPx: number;
  /** Outside the technician's working hours: dim hatch (S4). */
  readonly outOfHours?: boolean;
  /** Today's band has ended: shaded; a drop into it is refused client-side (spec §5.2, §7.3). */
  readonly ended?: boolean;
  /** The lane's technician is off during the band (announced, spec §7.3). */
  readonly off?: boolean;
}

/**
 * An invisible drop target for one band of one lane and day. Stays droppable
 * even when off or ended (a disabled band would send the drop to a neighbour,
 * review log B-M3); the drop flow decides. `data-band-*` are the walk's hooks.
 */
export function DroppableWindowBand({ scope, isoDay, window, topPx, heightPx, outOfHours, ended, off }: DroppableWindowBandProps) {
  const data: DropZoneData = { kind: 'window', scope, isoDay, window, ...(ended ? { ended: true } : {}), ...(off ? { off: true } : {}) };
  const { setNodeRef, isOver } = useDroppable({ id: dropZoneId(scope, isoDay, window), data });

  const baseClass = ended
    ? 'bg-surface-sunken/70'
    : outOfHours
      ? 'bg-[repeating-linear-gradient(45deg,transparent,transparent_6px,var(--hatch-ink)_6px,var(--hatch-ink)_12px)]'
      : '';
  const overClass = isOver
    ? outOfHours || ended || off
      ? 'border-dashed border-warning bg-warning-light'
      : 'border-dashed border-marker bg-primary-soft'
    : '';

  return (
    <div
      ref={setNodeRef}
      className={`absolute inset-x-0 rounded-sm border border-transparent [--hatch-ink:color-mix(in_oklch,var(--foreground)_8%,transparent)] ${baseClass} ${overClass}`}
      style={{ top: topPx, height: heightPx }}
      data-window={window}
      data-band-scope={scope}
      data-band-day={isoDay}
      data-out-of-hours={outOfHours ? 'true' : undefined}
      data-ended={ended ? 'true' : undefined}
      aria-hidden
    />
  );
}
```

- [ ] **Step 10: Dialogs and banner.** Replace the whole of `src/components/admin/calendar/conflict-dialog.tsx` (spec §7.5 "Confirm": `ConflictDialog` generalised, its time-off branch deleted):

```tsx
'use client';

import { AlertTriangle, Clock } from 'lucide-react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { OUT_OF_HOURS_LINE } from '@/lib/admin/dispatch-copy';

interface ConflictDialogProps {
  readonly open: boolean;
  /** confirmLines(...) for a started visit; empty for an overlap-only confirm. */
  readonly lines: readonly string[];
  /** conflictRows(...): "HVAC-9 · 12 PM–4 PM[ · Sam]". */
  readonly conflictRows: readonly string[];
  readonly outsideAvailability: boolean;
  readonly isSubmitting: boolean;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}

/**
 * "Move anyway?" for a 409 HAS_PROGRESS / SCHEDULE_CONFLICT (spec §7.5, §8).
 * Time off never reaches here: it is never overridable (TimeOffDialog).
 * finalFocus={false}: the board moves focus itself (lead ruling 19).
 */
export function ConflictDialog({
  open,
  lines,
  conflictRows,
  outsideAvailability,
  isSubmitting,
  onConfirm,
  onCancel,
}: ConflictDialogProps) {
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next && !isSubmitting) onCancel();
      }}
    >
      <DialogContent className="sm:max-w-md" finalFocus={false}>
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <AlertTriangle className="size-4 text-warning" aria-hidden />
            Move anyway?
          </DialogTitle>
          {lines.length > 0 && (
            <DialogDescription render={<div className="space-y-1.5" />}>
              {lines.map((line) => (
                <p key={line}>{line}</p>
              ))}
            </DialogDescription>
          )}
        </DialogHeader>

        {conflictRows.length > 0 && (
          <div className="space-y-1.5">
            <p className="text-xs font-medium text-muted-foreground">Overlapping requests:</p>
            <ul className="space-y-1">
              {conflictRows.map((row) => (
                <li
                  key={row}
                  className="flex items-center gap-2 rounded-md border border-border/60 bg-muted/30 px-2.5 py-1.5 text-sm tabular-nums"
                >
                  <Clock className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
                  {row}
                </li>
              ))}
            </ul>
          </div>
        )}

        {outsideAvailability && (
          <p className="rounded-md bg-warning-light px-2.5 py-1.5 text-xs text-warning-foreground">{OUT_OF_HOURS_LINE}</p>
        )}

        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onCancel} disabled={isSubmitting}>
            Cancel
          </Button>
          <Button variant="destructive" size="sm" onClick={onConfirm} disabled={isSubmitting}>
            {isSubmitting ? 'Moving…' : 'Move anyway'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

(`DialogDescription` is Base UI's `Dialog.Description`, which takes `render`; check `src/components/ui/dialog.tsx` — if its wrapper doesn't forward `render`, render the lines in a `<div className="space-y-1.5 text-sm text-muted-foreground">` below `DialogHeader` instead and give `DialogDescription` the first line only. The `<p>`-inside-`<p>` nesting must not happen.)

`src/components/admin/calendar/time-off-dialog.tsx`:

```tsx
'use client';

import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { TIME_OFF_FOOTER, TIME_OFF_TITLE } from '@/lib/admin/dispatch-copy';

/** Time off is never overridable (spec §8): one line per technician, then OK. Nothing was sent or moved. */
export function TimeOffDialog({
  open,
  lines,
  onClose,
}: {
  readonly open: boolean;
  /** timeOffLine(...) per checked technician who is off. */
  readonly lines: readonly string[];
  readonly onClose: () => void;
}) {
  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onClose(); }}>
      <DialogContent className="sm:max-w-md" finalFocus={false} aria-describedby="m2-time-off-lines">
        <DialogHeader>
          <DialogTitle>{TIME_OFF_TITLE}</DialogTitle>
        </DialogHeader>
        {/* Spec §7.5 order: title, one line per technician, then the footer sentence. */}
        <ul id="m2-time-off-lines" className="space-y-1 text-sm">
          {lines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
        <p className="text-sm text-muted-foreground">{TIME_OFF_FOOTER}</p>
        <DialogFooter>
          <Button size="sm" onClick={onClose}>OK</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

(The footer sentence follows the lines, as spec §7.5 orders them; `aria-describedby` points at the list.)

`src/components/admin/calendar/window-prompt-dialog.tsx`:

```tsx
'use client';

import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { RadioGroup, RadioItem } from '@/components/ui/radio-group';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { selectLabel } from '@/lib/admin/select-label';
import { PROMPT_FOOTNOTE } from '@/lib/admin/dispatch-copy';
import type { PromptChoice, PromptChoiceValue } from '@/lib/admin/move-request-client';
import type { ArrivalWindow } from '@/lib/admin/arrival-window';

export type PromptResult = { readonly rule: 'keep' | 'match' } | { readonly rule: 'pick'; readonly pick: ArrivalWindow };

/**
 * "Arrival window" (spec §7.5): Keep / Use the <band> window / Choose a
 * window. Enter = Move except while the Select is open; Escape = Cancel.
 * Mounted per prompt (the board keys it), so the default is its initial state.
 */
export function WindowPromptDialog({
  open,
  description,
  choices,
  defaultChoice,
  pickOptions,
  onCancel,
  onMove,
}: {
  readonly open: boolean;
  /** "Moving Pat Doe · HVAC-1 to Sam’s afternoon." */
  readonly description: string;
  readonly choices: readonly PromptChoice[];
  readonly defaultChoice: 'keep' | 'match';
  readonly pickOptions: readonly { readonly value: ArrivalWindow; readonly label: string; readonly disabled: boolean }[];
  readonly onCancel: () => void;
  readonly onMove: (result: PromptResult) => void;
}) {
  const firstEnabled = choices.find((c) => !c.disabled)?.value ?? 'choose';
  const initial: PromptChoiceValue = choices.some((c) => c.value === defaultChoice && !c.disabled) ? defaultChoice : firstEnabled;
  const [choice, setChoice] = useState<PromptChoiceValue>(initial);
  const [pick, setPick] = useState<ArrivalWindow | ''>('');
  const [selectOpen, setSelectOpen] = useState(false);
  const canMove = choice !== 'choose' || pick !== '';

  function submit(): void {
    if (!canMove) return;
    if (choice === 'choose') onMove({ rule: 'pick', pick: pick as ArrivalWindow });
    else onMove({ rule: choice });
  }

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next) onCancel(); }}>
      <DialogContent
        className="sm:max-w-md"
        finalFocus={false}
        onKeyDown={(e) => {
          // Enter = Move, except while a Select is open or a button (Cancel, ×, Move) has focus:
          // a focused button keeps its own action, so Enter on Cancel never sends (critic B M-3).
          if (e.key === 'Enter' && !selectOpen && !(e.target as HTMLElement).closest('button:not([role="radio"])')) {
            e.preventDefault();
            submit();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>Arrival window</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        <RadioGroup<PromptChoiceValue> value={choice} onValueChange={setChoice} aria-label="Arrival window">
          {choices.map((c) => (
            <RadioItem key={c.value} value={c.value} disabled={c.disabled} hint={c.hint}>
              {c.label}
            </RadioItem>
          ))}
        </RadioGroup>
        {choice === 'choose' && (
          <Select
            value={pick}
            onValueChange={(v) => setPick((v ?? '') as ArrivalWindow | '')}
            onOpenChange={setSelectOpen}
          >
            <SelectTrigger aria-label="Window">
              <SelectValue>{(v: unknown) => selectLabel(pickOptions, v, 'Pick a window')}</SelectValue>
            </SelectTrigger>
            <SelectContent>
              {pickOptions.map((o) => (
                <SelectItem key={o.value} value={o.value} disabled={o.disabled}>
                  {o.label}
                  {o.disabled ? ' · Already ended' : ''}
                </SelectItem>
              ))}
            </SelectContent>
          </Select>
        )}
        <p className="text-xs text-muted-foreground">{PROMPT_FOOTNOTE}</p>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onCancel}>Cancel</Button>
          <Button size="sm" onClick={submit} disabled={!canMove}>Move</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

`src/components/admin/calendar/move-dialog.tsx`:

```tsx
'use client';

import { useState } from 'react';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { RadioGroup, RadioItem } from '@/components/ui/radio-group';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { selectLabel } from '@/lib/admin/select-label';
import { bandEnded, moveDialogBody, moveDialogDefaults, type MoveDialogForm } from '@/lib/admin/board-move';
import { rangeLabel } from '@/lib/admin/dispatch-copy';
import { windowOptionLabel } from '@/lib/admin/move-request-client';
import { ARRIVAL_WINDOWS, type ArrivalWindow } from '@/lib/admin/arrival-window';
import type { MoveBody } from '@/lib/admin/board-types';
import type { DashboardRequest } from '@/lib/admin/types';

function addDays(isoDay: string, n: number): string {
  const d = new Date(`${isoDay}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/**
 * Move… (spec §7.5): the keyboard and touch path. Technician, date and window;
 * Move is disabled while nothing changes. The board runs the same flow as a
 * drop (time-off check on the displayed day, the 409 confirm, the banner).
 * Mounted per card (the board keys it by request id), so defaults are its
 * initial state.
 */
export function MoveDialog({
  open,
  card,
  fromUnscheduled,
  technicians,
  today,
  now,
  submitting,
  onCancel,
  onSubmit,
}: {
  readonly open: boolean;
  readonly card: DashboardRequest;
  readonly fromUnscheduled: boolean;
  readonly technicians: readonly { readonly id: string; readonly name: string }[];
  readonly today: string;
  readonly now: Date;
  readonly submitting: boolean;
  readonly onCancel: () => void;
  readonly onSubmit: (body: MoveBody, form: MoveDialogForm) => void;
}) {
  const [form, setForm] = useState<MoveDialogForm>(() => moveDialogDefaults(card, today, now, fromUnscheduled));
  const hasWindow = Boolean(card.arrivalWindowStart && card.arrivalWindowEnd);
  const unassignedFirst = fromUnscheduled || !card.crew?.some((c) => c.isLead);
  const techOptions = [
    ...(unassignedFirst ? [{ value: '', label: 'Unassigned' }] : []),
    ...technicians.map((t) => ({ value: t.id, label: t.name })),
  ];
  const body = moveDialogBody(card, form, fromUnscheduled);
  const windowEnded = form.window !== 'keep' && bandEnded(form.day, form.window, now);
  const title = `Move ${card.customerName ?? 'Unknown'} · ${card.referenceNumber}`;

  return (
    <Dialog open={open} onOpenChange={(next) => { if (!next && !submitting) onCancel(); }}>
      <DialogContent className="min-w-0 sm:max-w-md" finalFocus={false}>
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          <DialogDescription>Pick a technician, a day and an arrival window.</DialogDescription>
        </DialogHeader>
        <div className="min-w-0 space-y-3">
          <div className="space-y-1.5">
            <label className="text-sm font-medium" htmlFor="move-tech">Technician</label>
            <Select
              value={form.technicianId}
              onValueChange={(v) => setForm((f) => ({ ...f, technicianId: (v ?? '') as string }))}
              items={techOptions}
            >
              <SelectTrigger id="move-tech" className="w-full">
                <SelectValue>{(v: unknown) => selectLabel(techOptions, v === '' ? '__unassigned' : v, 'Unassigned')}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {techOptions.map((o) => (
                  <SelectItem key={o.value || 'unassigned'} value={o.value}>{o.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="space-y-1.5">
            <label className="text-sm font-medium" htmlFor="move-day">Date</label>
            <Input
              id="move-day"
              type="date"
              value={form.day}
              min={today}
              max={addDays(today, 365)}
              onChange={(e) => {
                const day = e.target.value;
                if (day) setForm((f) => ({ ...f, day }));
              }}
            />
          </div>
          <div className="space-y-1.5">
            <p className="text-sm font-medium" id="move-window-label">Window</p>
            <RadioGroup<'keep' | ArrivalWindow>
              value={form.window}
              onValueChange={(w) => setForm((f) => ({ ...f, window: w }))}
              aria-labelledby="move-window-label"
            >
              {hasWindow && (
                <RadioItem value="keep">Keep {rangeLabel(card.arrivalWindowStart!, card.arrivalWindowEnd!)}</RadioItem>
              )}
              {ARRIVAL_WINDOWS.map((w) => {
                const ended = bandEnded(form.day, w, now);
                return (
                  <RadioItem key={w} value={w} disabled={ended} hint={ended ? 'Already ended' : undefined}>
                    {windowOptionLabel(form.day, w)}
                  </RadioItem>
                );
              })}
            </RadioGroup>
          </div>
        </div>
        <DialogFooter>
          <Button variant="outline" size="sm" onClick={onCancel} disabled={submitting}>Cancel</Button>
          <Button size="sm" disabled={!body || windowEnded || submitting} onClick={() => body && onSubmit(body, form)}>
            {submitting ? 'Moving…' : 'Move'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

(The `selectLabel` call maps the empty value through a sentinel because `selectLabel` treats `''` as "no value" and returns the fallback — which is exactly "Unassigned", the label we want.)

`src/components/admin/calendar/move-banner.tsx`:

```tsx
'use client';

import { useEffect } from 'react';
import { X } from 'lucide-react';
import { bannerAutoClearMs, type BannerState } from '@/lib/admin/move-request-client';

/**
 * The board's live region (spec §7.5): always mounted; fixed bottom-right
 * (top-centre below 640 px); role="status" for success lines, role="alert"
 * for errors; a close ×. Status lines clear after 4 s, errors stay until
 * closed; the board clears any banner on the next drag start.
 */
export function MoveBanner({ banner, onClose }: { readonly banner: BannerState | null; readonly onClose: () => void }) {
  const ms = bannerAutoClearMs(banner);
  useEffect(() => {
    if (ms === null) return;
    const t = window.setTimeout(onClose, ms);
    return () => window.clearTimeout(t);
  }, [banner?.id, ms, onClose]);

  const toast = (tone: 'status' | 'error') =>
    banner && banner.tone === tone ? (
      <div
        className={`pointer-events-auto flex max-w-sm items-start gap-2 rounded-md border px-3 py-2 text-sm shadow-[var(--shadow-pop)] ${
          tone === 'error' ? 'border-danger-border bg-danger-light text-danger-strong' : 'border-border-strong bg-surface-raised text-foreground'
        }`}
      >
        <span className="min-w-0 flex-1">{banner.message}</span>
        <button
          type="button"
          aria-label="Close"
          onClick={onClose}
          className="shrink-0 rounded-sm p-0.5 text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring"
        >
          <X className="size-3.5" aria-hidden />
        </button>
      </div>
    ) : null;

  return (
    <div className="pointer-events-none fixed inset-x-0 top-4 z-50 flex flex-col items-center gap-2 px-4 sm:inset-x-auto sm:top-auto sm:right-6 sm:bottom-6 sm:items-end">
      <div role="status" aria-live="polite">{toast('status')}</div>
      <div role="alert">{toast('error')}</div>
    </div>
  );
}
```

Check the danger tokens exist before using them: `grep -n "danger-border\|danger-light\|danger-strong" src/app/globals.css` — if one is missing, use the warning family (`border-warning-border bg-warning-light text-warning-strong`) for errors, as the old `Alert variant="destructive"` page banner's tokens.

- [ ] **Step 11: Old call sites still compile.** `interactive-scheduling-calendar.tsx` (unchanged until 9b) imports `ConflictDialog` with the old props and `RescheduleConflictDetail`; make the minimal edit so it compiles until 9b rewrites it — replace

```tsx
      <ConflictDialog
        conflict={conflict?.detail ?? null}
        message={conflict?.message ?? ''}
        isSubmitting={isRescheduling}
        onOverride={handleOverride}
        onCancel={() => {
          setConflict(null);
          onRefetch();
        }}
      />
```

with

```tsx
      <ConflictDialog
        open={conflict !== null}
        lines={conflict ? [conflict.message] : []}
        conflictRows={conflict?.detail.conflicts.map((c) => c.referenceNumber) ?? []}
        outsideAvailability={conflict?.detail.outsideAvailability ?? false}
        isSubmitting={isRescheduling}
        onConfirm={handleOverride}
        onCancel={() => {
          setConflict(null);
          onRefetch();
        }}
      />
```

(9b replaces this file whole; this bridge only keeps Task 9a's boundary green. `scheduling-calendar.tsx` keeps calling `CalendarJobCard` with `job`, `onSelect`, `compact` — all new props are optional.)

- [ ] **Step 11b: Contrast (spec §9, `contrast.py`).** The new chip, pill and hatch styles are this task's. `contrast.py` takes hex pairs, and the tokens are oklch, so resolve them in the browser first. Dev server running; seed a throwaway org (`m2-walk.mts seed`), open `/admin/calendar` with its token, and run this throwaway `contrast-m2.mts` at the repo root (deleted after):

```ts
import { execFileSync } from "node:child_process";
import { chromium } from "playwright";

const env = { ...process.env, NODE_OPTIONS: "--conditions=react-server" };
const fx = JSON.parse(execFileSync("npx", ["tsx", "scripts/agent/m2-walk.mts", "seed"], { encoding: "utf8", env }).trim().split("\n").pop()!);
// [label, text classes, background classes]; the hatch backgrounds are the stripe colour over the canvas.
const PAIRS: Array<[string, string, string]> = [
  ["working chip", "text-primary-foreground", "bg-primary"],
  ["open chip", "text-foreground", "bg-surface-raised"],
  ["+N / count", "text-muted-foreground", "bg-surface-raised"],
  ["pill sm/md", "text-muted-foreground", "bg-surface-raised"],
  ["block label on 14% hatch", "text-muted-foreground", "[background:color-mix(in_oklch,var(--foreground)_14%,var(--canvas))]"],
  ["band 8% hatch", "text-muted-foreground", "[background:color-mix(in_oklch,var(--foreground)_8%,var(--canvas))]"],
  ["ended band", "text-muted-foreground", "bg-surface-sunken/70"],
];
const browser = await chromium.launch();
try {
  for (const scheme of ["light", "dark"] as const) {
    const ctx = await browser.newContext({ colorScheme: scheme });
    await ctx.addCookies([{ name: "hvac_admin_session", value: fx.tokens.admin, domain: "localhost", path: "/" }]);
    const page = await ctx.newPage();
    await page.goto("http://localhost:3000/admin/calendar", { waitUntil: "load" });
    const hex = await page.evaluate((pairs) => {
      // Any CSS colour → #rrggbb through a 1×1 canvas (handles oklch and color-mix).
      const toHex = (css: string) => {
        const c = document.createElement("canvas"); c.width = c.height = 1;
        const g = c.getContext("2d")!; g.fillStyle = "#000"; g.fillStyle = css; g.fillRect(0, 0, 1, 1);
        const [r, gg, b] = g.getImageData(0, 0, 1, 1).data;
        return "#" + [r, gg, b].map((n) => n!.toString(16).padStart(2, "0")).join("");
      };
      return pairs.map(([label, fg, bg]) => {
        const el = document.createElement("span");
        el.className = `${fg} ${bg}`;
        document.body.appendChild(el);
        const cs = getComputedStyle(el);
        const out = [label, toHex(cs.color), toHex(cs.backgroundColor)];
        el.remove();
        return out;
      });
    }, PAIRS);
    for (const [label, fg, bg] of hex) {
      const res = execFileSync("python3", [".claude/skills/replica-design/contrast.py", fg!, bg!], { encoding: "utf8" }).trim();
      console.log(scheme, label, fg, bg, res);
    }
    await ctx.close();
  }
} finally {
  await browser.close();
  execFileSync("npx", ["tsx", "scripts/agent/m2-walk.mts", "delete", fx.org], { encoding: "utf8", env, stdio: "inherit" });
}
```

Run `npx tsx contrast-m2.mts`. Expected: every pair passes AA (4.5:1 for the 9–11 px text; the hatch and ended-band rows read as text on that background). `contrast.py` exits 1 on a failing pair, which throws here: change the failing token pair in this task's components (e.g. `text-foreground` for `text-muted-foreground` on the 14% hatch) and re-run until clean. Record every ratio in the task report; delete the script. If a Tailwind arbitrary class above isn't in the compiled CSS (a background of `rgba(0, 0, 0, 0)` → `#000000`), set the background with an inline `style` in the evaluate instead.

- [ ] **Step 12: Gates and commit**

```bash
npx tsc --noEmit && npx eslint src/components/ui/radio-group.tsx src/lib/admin/move-request-client.ts src/lib/admin/move-request-client.test.ts src/hooks/use-move-request.ts src/components/admin/calendar/crew-chips.tsx src/components/admin/calendar/lane-blocks.tsx src/components/admin/calendar/window-prompt-dialog.tsx src/components/admin/calendar/time-off-dialog.tsx src/components/admin/calendar/move-dialog.tsx src/components/admin/calendar/move-banner.tsx src/components/admin/calendar/calendar-job-card.tsx src/components/admin/calendar/draggable-job-card.tsx src/components/admin/calendar/droppable-window-band.tsx src/components/admin/calendar/conflict-dialog.tsx src/components/admin/calendar/interactive-scheduling-calendar.tsx src/lib/admin/calendar-dnd.ts src/lib/admin/calendar-dnd.test.ts && npx vitest run
git add src/components/ui/radio-group.tsx src/lib/admin/move-request-client.ts src/lib/admin/move-request-client.test.ts src/hooks/use-move-request.ts src/components/admin/calendar/crew-chips.tsx src/components/admin/calendar/lane-blocks.tsx src/components/admin/calendar/window-prompt-dialog.tsx src/components/admin/calendar/time-off-dialog.tsx src/components/admin/calendar/move-dialog.tsx src/components/admin/calendar/move-banner.tsx src/components/admin/calendar/calendar-job-card.tsx src/components/admin/calendar/draggable-job-card.tsx src/components/admin/calendar/droppable-window-band.tsx src/components/admin/calendar/conflict-dialog.tsx src/components/admin/calendar/interactive-scheduling-calendar.tsx src/lib/admin/calendar-dnd.ts src/lib/admin/calendar-dnd.test.ts
git commit -m "$(cat <<'EOF'
feat(m2): calendar UI pieces for board moves

Crew chips, lane blocks, cards with the FieldPulse pill and lock, the
started cue, helper copies and Move..., the window prompt, the Move anyway
confirm, the time-off dialog, the Move... dialog, the live-region banner,
a Base UI radio group and the move client and hook. Not wired yet (9b).

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01GuWoF63tQU1i7ELqyYU3A6
EOF
)"
```

---
### Task 9b: Board wiring — the drop flow, layout, focus, Unscheduled and the walk

The board switches from `POST …/reschedule` to the move route and the spec §7.4 drop flow: `pointerWithin`, the §7.2 layout (axis out of the lanes scroller), helper copies and blocks in Day view, the window prompt, "Move anyway?", the time-off dialog, `Move…`, optimistic moves keyed by request, `moveLanded` after a STALE or a lost response, focus after every drop and dialog, the interactivity rule, and the page's live-region banner. `useRescheduleJob` and `@dnd-kit/sortable` go.

**Files:**
- Modify: `src/components/admin/calendar/interactive-scheduling-calendar.tsx` (rewritten whole), `src/components/admin/calendar/draggable-unscheduled-panel.tsx` (rewritten whole), `src/app/admin/(dashboard)/calendar/page.tsx`, `src/lib/admin/calendar-optimistic.ts` (rewritten whole: `applyOptimisticReschedule` and `currentScopeOf` lose their only caller), `src/lib/admin/calendar-optimistic.test.ts`, `package.json`, `package-lock.json`
- Delete: `src/hooks/use-reschedule-job.ts`
- Temporary (never committed): `walk-m2-9b.mts` at the repo root

**Interfaces:**
- Consumes (Tasks 1–2, 9a, exact): `laneCards`, `laneKey`, `findLeadCard`, `applyMoveResult`, `moveLanded`, `IntendedMove`, `moveNeeds`, `optimisticCrew`, `resetsToScheduled`, `boardInteractive`, `bandEnded`, `cardWidthPx` (`board-move.ts`); `promptPlan`, `resolveMoveWindow`, `timeOffHits`, `windowEqual`, `TimeWindow` (`move-window.ts`); `confirmLines`, `conflictRows`, `coveredLine`, `dayLabel`, `firstName`, `moveBanner`, `rangeLabel`, `timeOffLine`, `INTERACTIVE_NOTICE`, `MOVE_GENERIC`, `SR_INSTRUCTIONS`, `STALE_LINE` (`dispatch-copy.ts`); `WINDOW_ENDED_MESSAGE`; `DATE_LABEL_ID`, `focusSelectors`, `pickOptions`, `promptChoices`, `BannerState`, `MoveOutcome` (`move-request-client.ts`); `useMoveRequest`; `CalendarJobCard`, `DraggableJobCard`, `DroppableWindowBand`, `LaneBlocks`, `ConflictDialog`, `WindowPromptDialog` (+`PromptResult`), `TimeOffDialog`, `MoveDialog`, `MoveBanner`. Task 7's `GET /api/admin/calendar` (cards carry `visitId`, `visitVersion`, `crew`, `started`, `movable`, `laneRole`, `fieldpulse`; day view carries `blocks`); Task 8's move route.
- Produces: `InteractiveSchedulingCalendar({ calendar, view, onSelect, onRefetch, onBanner, isLoading, onPickDay? })` — `onBanner(b: { message; tone } | null)`; `onRefetch: () => Promise<void> | void`. Lane header elements `[data-lane-header={scope}]` with `tabIndex={-1}`; a header slot Task 10 fills with the lane menu (`laneHeaderExtra?: (lane) => ReactNode` prop). `DraggableUnscheduledPanel({ jobs, isLoading, onSelect, inFlight, interactive, onMove })`.

- [ ] **Step 1: Trim `calendar-optimistic.ts` (failing test first).** In `src/lib/admin/calendar-optimistic.test.ts`, replace the import block

```ts
import {
  applyOptimisticReschedule,
  applyOptimisticUnschedule,
  currentScopeOf,
  UNASSIGNED_SCOPE,
} from "./calendar-optimistic";
```

with

```ts
import { applyOptimisticUnschedule, UNASSIGNED_SCOPE } from "./calendar-optimistic";
```

and delete the whole `describe("applyOptimisticReschedule", …)` block and the whole `describe("currentScopeOf", …)` block (the two blocks between the `board()` helper and `describe("applyOptimisticUnschedule", …)`). If `UNASSIGNED_SCOPE` is then unused in the test, add this case to the `applyOptimisticUnschedule` block so the constant stays pinned:

```ts
  it("the unassigned lane id is the literal used by the board", () => {
    expect(UNASSIGNED_SCOPE).toBe("unassigned");
  });
```

Run `npx vitest run src/lib/admin/calendar-optimistic.test.ts` → PASS (the remaining cases don't depend on the removed functions). Then replace the whole of `src/lib/admin/calendar-optimistic.ts`:

```ts
/**
 * Pure optimistic helper for dragging a request back to Unscheduled. Board
 * moves use applyMoveResult (board-move.ts), which places a card by its exact
 * window and lead. Immutable: every list is rebuilt.
 */
import type { SchedulingCalendar, DashboardRequest } from "./types";

/** The literal scope id for the unassigned (placed-but-no-tech) lane. */
export const UNASSIGNED_SCOPE = "unassigned";

/** Find a job by id across lanes, unassigned, and the unscheduled queue. */
function findJob(calendar: SchedulingCalendar, requestId: string): DashboardRequest | null {
  for (const lane of calendar.lanes) {
    const hit = lane.jobs.find((j) => j.id === requestId);
    if (hit) return hit;
  }
  return calendar.unassigned.find((j) => j.id === requestId) ?? calendar.unscheduled.find((j) => j.id === requestId) ?? null;
}

/**
 * Pull the job out of whatever lane it's in (helper copies included), clear
 * its window and assignee, and drop it into the unscheduled queue. Returns the
 * SAME reference when the job can't be found (caller skips).
 */
export function applyOptimisticUnschedule(calendar: SchedulingCalendar, requestId: string): SchedulingCalendar {
  const job = findJob(calendar, requestId);
  if (!job) return calendar;
  const cleared: DashboardRequest = { ...job, arrivalWindowStart: null, arrivalWindowEnd: null, assignedToName: null, laneRole: "lead" };
  const remove = (list: readonly DashboardRequest[]) => list.filter((j) => j.id !== requestId);
  return {
    ...calendar,
    lanes: calendar.lanes.map((lane) => ({ ...lane, jobs: remove(lane.jobs) })),
    unassigned: remove(calendar.unassigned),
    unscheduled: [...remove(calendar.unscheduled), cleared],
  };
}
```

Run `npx vitest run src/lib/admin/calendar-optimistic.test.ts` → PASS. (`npx tsc` fails until Step 3 replaces the board, which still imports the removed names — do Steps 2–5 before running tsc.)

- [ ] **Step 2: The Unscheduled panel** — replace the whole of `src/components/admin/calendar/draggable-unscheduled-panel.tsx`:

```tsx
'use client';

import { useDraggable, useDroppable } from '@dnd-kit/core';
import { Inbox, Lock } from 'lucide-react';
import { Card } from '@/components/ui/card';
import { Skeleton } from '@/components/ui/skeleton';
import { UrgencyBadge } from '@/components/admin/urgency-badge';
import { StatusBadge } from '@/components/admin/status-badge';
import { SyncPill } from '@/components/admin/sync-pill';
import {
  dragJobId,
  UNSCHEDULED_DROP_ID,
  type DragJobData,
  type UnscheduledDropZoneData,
} from '@/lib/admin/calendar-dnd';
import { urgencyAccent } from '@/lib/admin/urgency-accent';
import { FIELDPULSE_BOARD } from '@/lib/admin/dispatch-copy';
import { DASHBOARD_LIST_LIMIT, type DashboardRequest } from '@/lib/admin/types';
import { issueTypeLabel } from '@/lib/admin/request-labels';

interface DraggableUnscheduledPanelProps {
  /** Requests not yet placed: no technician and/or no arrival window. */
  readonly jobs: readonly DashboardRequest[];
  readonly isLoading: boolean;
  readonly onSelect: (id: string) => void;
  /** Request ids with a move in flight: only those rows are disabled. */
  readonly inFlight: ReadonlySet<string>;
  /** Pointer drags only at ≥ 1024 px with a fine pointer (spec §7.8). */
  readonly interactive: boolean;
  readonly onMove: (job: DashboardRequest) => void;
}

function reason(job: DashboardRequest): string {
  const noTech = !job.assignedToName;
  const noWindow = !job.arrivalWindowStart;
  if (noTech && noWindow) return 'No technician · no window';
  if (noTech) return 'No technician';
  return 'No arrival window';
}

/** One Unscheduled row: a drag source (a pointer drag onto a band moves it through the move route) plus Move…. */
function UnscheduledRow({
  job,
  onSelect,
  disabled,
  interactive,
  onMove,
}: {
  readonly job: DashboardRequest;
  readonly onSelect: (id: string) => void;
  readonly disabled: boolean;
  readonly interactive: boolean;
  readonly onMove: (job: DashboardRequest) => void;
}) {
  // One meaning everywhere: an absent `movable` is not movable (critic B M-7).
  const movable = job.movable === 'yes';
  const data: DragJobData = {
    kind: 'job',
    requestId: job.id,
    currentStartIso: job.arrivalWindowStart,
    label: `${job.customerName ?? 'Unknown customer'}, ${job.referenceNumber}`,
    laneRole: 'lead',
  };
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: dragJobId(job.id),
    data,
    disabled: disabled || !interactive || !movable,
  });
  const fieldpulse = job.fieldpulse === true || job.syncedSource === 'fieldpulse';

  return (
    <div className="relative">
      <button
        ref={setNodeRef}
        {...listeners}
        {...attributes}
        aria-roledescription={undefined}
        aria-describedby={undefined}
        // The row opens the sheet even when it can't be dragged: dnd-kit's spread aria-disabled
        // would announce it as unavailable (touch, FieldPulse). The drag is off via useDraggable's `disabled`.
        aria-disabled={undefined}
        type="button"
        data-unscheduled-id={job.id}
        data-request-id={job.id}
        data-lane-role="lead"
        onClick={() => onSelect(job.id)}
        className={`w-full touch-none rounded-sm border border-border border-l-[3px] ${urgencyAccent(job.urgency).bar} min-h-9 bg-surface-raised px-3 py-2 pb-7 text-left transition-colors hover:bg-row-hover focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring ${
          isDragging ? 'opacity-40' : ''
        } ${disabled ? 'cursor-progress' : interactive && movable ? 'cursor-grab active:cursor-grabbing' : ''}`}
      >
        <div className="flex items-center justify-between gap-2">
          <span className="truncate text-[13px] font-medium">{job.customerName ?? 'Unknown'}</span>
          {fieldpulse && (
            <span title={FIELDPULSE_BOARD} className="flex shrink-0 items-center gap-0.5 text-muted-foreground">
              <SyncPill source="fieldpulse" size="sm" />
              <Lock className="size-3" aria-hidden />
            </span>
          )}
          {job.isAfterHours && (
            <span
              title="After hours"
              className="inline-flex shrink-0 items-center rounded-[3px] border border-warning-border bg-warning-light px-1.5 py-0.5 text-[10px] font-medium text-warning-strong"
            >
              After-hrs
            </span>
          )}
        </div>
        <div className="truncate text-xs text-muted-foreground">
          {issueTypeLabel(job.issueType)} · <span className="font-mono">{job.referenceNumber}</span>
        </div>
        <div className="mt-1 flex items-center gap-1.5">
          <UrgencyBadge urgency={job.urgency} />
          <StatusBadge status={job.status} />
          <span className="ml-auto text-[10px] font-medium text-warning-strong">{reason(job)}</span>
        </div>
      </button>
      {movable && (
        <button
          type="button"
          aria-label={`Move ${job.customerName ?? 'Unknown'} · ${job.referenceNumber}`}
          disabled={disabled}
          onClick={() => onMove(job)}
          onPointerDown={(e) => e.stopPropagation()}
          className="absolute right-1.5 bottom-1.5 inline-flex h-6 items-center rounded-sm border border-transparent px-1.5 text-[11px] font-medium hover:border-border hover:bg-row-hover focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring disabled:opacity-50"
        >
          Move…
        </button>
      )}
    </div>
  );
}

/**
 * The "to place" queue inside the board's DndContext. Rows drag onto bands;
 * the panel is itself the Unscheduled drop zone (a drop here unschedules,
 * with the version gate, spec §5.4).
 */
export function DraggableUnscheduledPanel({ jobs, isLoading, onSelect, inFlight, interactive, onMove }: DraggableUnscheduledPanelProps) {
  const dropData: UnscheduledDropZoneData = { kind: 'unscheduled' };
  const { setNodeRef, isOver } = useDroppable({ id: UNSCHEDULED_DROP_ID, data: dropData });

  return (
    <Card
      ref={setNodeRef}
      className={`flex w-full flex-col p-3 lg:w-72 lg:shrink-0 ${isOver ? 'border-dashed border-marker bg-primary-soft' : ''}`}
    >
      <div className="mb-2 flex items-center gap-2">
        <Inbox className="size-4 text-warning-strong" />
        <h2 className="text-[13px] font-semibold">Unscheduled</h2>
        {!isLoading && (
          <span
            className="ml-auto font-mono text-xs tabular-nums text-muted-foreground"
            title={jobs.length >= DASHBOARD_LIST_LIMIT ? `Showing the first ${DASHBOARD_LIST_LIMIT}` : undefined}
          >
            {jobs.length}
            {jobs.length >= DASHBOARD_LIST_LIMIT ? '+' : ''}
          </span>
        )}
      </div>

      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 3 }, (_, i) => (
            <Skeleton key={`unsched-skeleton-${i}`} className="h-16 w-full" />
          ))}
        </div>
      ) : jobs.length === 0 ? (
        <p className="py-6 text-center text-xs text-muted-foreground">Nothing to place.</p>
      ) : (
        <ul className="space-y-2">
          {jobs.map((job) => (
            <li key={job.id}>
              <UnscheduledRow
                job={job}
                onSelect={onSelect}
                disabled={inFlight.has(job.id)}
                interactive={interactive}
                onMove={onMove}
              />
            </li>
          ))}
        </ul>
      )}
    </Card>
  );
}
```

- [ ] **Step 3: The board** — replace the whole of `src/components/admin/calendar/interactive-scheduling-calendar.tsx`. If Task 0 retuned the auto-scroll values, use its recorded values in the `AUTO_SCROLL` constant instead of `{ x: 0.06, y: 0.2 }, 5`.

```tsx
'use client';

import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import {
  DndContext,
  DragOverlay,
  PointerSensor,
  pointerWithin,
  rectIntersection,
  useSensor,
  useSensors,
  type Announcements,
  type CollisionDetection,
  type DragEndEvent,
  type DragStartEvent,
} from '@dnd-kit/core';
import { restrictToWindowEdges } from '@dnd-kit/modifiers';
import { Inbox, User } from 'lucide-react';
import { CalendarJobCard } from '@/components/admin/calendar/calendar-job-card';
import { DraggableJobCard } from '@/components/admin/calendar/draggable-job-card';
import { DroppableWindowBand } from '@/components/admin/calendar/droppable-window-band';
import { DraggableUnscheduledPanel } from '@/components/admin/calendar/draggable-unscheduled-panel';
import { LaneBlocks } from '@/components/admin/calendar/lane-blocks';
import { ConflictDialog } from '@/components/admin/calendar/conflict-dialog';
import { WindowPromptDialog, type PromptResult } from '@/components/admin/calendar/window-prompt-dialog';
import { TimeOffDialog } from '@/components/admin/calendar/time-off-dialog';
import { MoveDialog } from '@/components/admin/calendar/move-dialog';
import { Skeleton } from '@/components/ui/skeleton';
import {
  CALENDAR_END_HOUR,
  CALENDAR_START_HOUR,
  RESCHEDULE_WINDOW_ROWS,
  arrivalWindowUtcForBusinessDate,
  businessIsoDate,
  businessMinutesOfDay,
  hourRowLabels,
  placeJobInLane,
  toBusinessWallClock,
  windowBandPlacement,
  type RescheduleWindowRow,
} from '@/lib/admin/calendar-time';
import { UNASSIGNED_SCOPE, applyOptimisticUnschedule } from '@/lib/admin/calendar-optimistic';
import { isWindowWithinAvailability } from '@/lib/admin/availability-coverage';
import { overlapColumns } from '@/lib/admin/calendar-overlap';
import { describeDragJob, describeDropTarget, type CalendarDropData, type DragJobData, type DropZoneData } from '@/lib/admin/calendar-dnd';
import {
  applyMoveResult,
  bandEnded,
  boardInteractive,
  cardWidthPx,
  findLeadCard,
  laneCards,
  laneKey,
  moveLanded,
  moveNeeds,
  optimisticCrew,
  resetsToScheduled,
  type IntendedMove,
} from '@/lib/admin/board-move';
import { promptPlan, resolveMoveWindow, timeOffHits, windowEqual, type TimeWindow } from '@/lib/admin/move-window';
import {
  INTERACTIVE_NOTICE,
  MOVE_GENERIC,
  SR_INSTRUCTIONS,
  STALE_LINE,
  confirmLines,
  conflictRows,
  coveredLine,
  dayLabel,
  firstName,
  moveBanner,
  rangeLabel,
  timeOffLine,
} from '@/lib/admin/dispatch-copy';
import { WINDOW_ENDED_MESSAGE } from '@/lib/admin/window-ended';
import { DATE_LABEL_ID, focusSelectors, pickOptions, promptChoices, type BannerState } from '@/lib/admin/move-request-client';
import { useMoveRequest } from '@/hooks/use-move-request';
import type { MoveBody, MoveConfirm, MoveNeedsDetails, BoardBlock } from '@/lib/admin/board-types';
import type { AvailabilitySlot, CalendarTechnicianLane, DashboardRequest, SchedulingCalendar } from '@/lib/admin/types';
import type { CalendarView } from '@/hooks/use-scheduling-calendar';
import type { ArrivalWindow } from '@/lib/admin/arrival-window';

type BannerInput = Omit<BannerState, 'id'> | null;

interface InteractiveSchedulingCalendarProps {
  readonly calendar: SchedulingCalendar | null;
  readonly view: CalendarView;
  readonly onSelect: (id: string) => void;
  /** Re-pull the authoritative board (the page's hook). */
  readonly onRefetch: () => Promise<void> | void;
  /** Post (or clear) the page's live-region banner. */
  readonly onBanner: (banner: BannerInput) => void;
  readonly isLoading: boolean;
  readonly onPickDay?: (isoDay: string) => void;
  /** Extra controls in a technician lane header (Task 10: the lane menu). */
  readonly laneHeaderExtra?: (lane: CalendarTechnicianLane) => ReactNode;
}

const HOUR_PX = 56;
const GRID_HOURS = CALENDAR_END_HOUR - CALENDAR_START_HOUR;
const GRID_PX = GRID_HOURS * HOUR_PX;
const MIN_CARD_PX = 28;
const PINNED_CARD_PX = 44;
/** Spec §7.2 (Task 0 retuned these): a ~31 px edge zone at 766 px, 0.3 of dnd-kit's speed. */
const AUTO_SCROLL = { threshold: { x: 0.04, y: 0.2 }, acceleration: 3 } as const;
/** Spec §5.2: the band under the pointer, else the overlapped band (Task 0: keeps auto-scroll alive in a lane gap). */
const dropCollision: CollisionDetection = (args) => {
  const hits = pointerWithin(args);
  return hits.length > 0 ? hits : rectIntersection(args);
};

interface PositionedJob {
  readonly job: DashboardRequest;
  readonly topPx: number;
  readonly heightPx: number;
  readonly outside: 'before' | 'after' | null;
  readonly column: number;
  readonly columns: number;
}

function positionJobs(jobs: readonly DashboardRequest[], isoDay: string): readonly PositionedJob[] {
  const positioned: Omit<PositionedJob, 'column' | 'columns'>[] = [];
  for (const job of jobs) {
    if (!job.arrivalWindowStart || !job.arrivalWindowEnd) continue;
    const start = new Date(job.arrivalWindowStart);
    const end = new Date(job.arrivalWindowEnd);
    if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) continue;
    if (businessIsoDate(start) !== isoDay) continue;
    const placement = placeJobInLane(start, end, PINNED_CARD_PX / GRID_PX);
    if (!placement) continue;
    positioned.push({ job, topPx: placement.top * GRID_PX, heightPx: Math.max(placement.height * GRID_PX, MIN_CARD_PX), outside: placement.outside });
  }
  const slots = overlapColumns(positioned.map((p) => ({ top: p.topPx, bottom: p.topPx + p.heightPx })));
  return positioned.map((p, i) => ({ ...p, ...slots[i]! }));
}

/** Lane header count: helper copies count, visits a hold ended don't. */
function liveJobCount(jobs: readonly DashboardRequest[]): number {
  return jobs.filter((j) => !j.visitEnded).length;
}

function windowOf(card: DashboardRequest): TimeWindow | null {
  if (!card.arrivalWindowStart || !card.arrivalWindowEnd) return null;
  return { start: new Date(card.arrivalWindowStart), end: new Date(card.arrivalWindowEnd) };
}

/** The card's lead: its crew's lead, else the lane it sits in. */
function leadOf(card: DashboardRequest, scope: string): string | null {
  const crewLead = card.crew?.find((c) => c.isLead)?.technicianId;
  if (crewLead) return crewLead;
  return scope === UNASSIGNED_SCOPE || scope === 'unscheduled' ? null : scope;
}

function HourLines() {
  return (
    <div className="pointer-events-none absolute inset-0">
      {Array.from({ length: GRID_HOURS }, (_, i) => (
        <div key={`line-${i}`} className="border-b border-dashed border-border" style={{ height: HOUR_PX }} />
      ))}
    </div>
  );
}

function TimeAxis() {
  const labels = hourRowLabels();
  return (
    <div className="w-14 shrink-0 pr-2 text-right">
      {labels.map((label, i) => (
        <div key={label} className="relative font-mono text-[11px] leading-[14px] tabular-nums text-muted-foreground" style={{ height: HOUR_PX }}>
          <span className="absolute -top-1.5 right-0">{i === 0 ? '' : label}</span>
        </div>
      ))}
    </div>
  );
}

function NowLine() {
  const minutes = businessMinutesOfDay(new Date());
  const startMin = CALENDAR_START_HOUR * 60;
  const endMin = CALENDAR_END_HOUR * 60;
  if (minutes < startMin || minutes > endMin) return null;
  const topPx = ((minutes - startMin) / (endMin - startMin)) * GRID_PX;
  return (
    <div className="pointer-events-none absolute inset-x-0 z-20" style={{ top: topPx }} aria-hidden>
      <div className="relative h-px bg-danger">
        <div className="absolute -left-1 -top-0.5 size-[5px] rounded-[1px] bg-danger" />
      </div>
    </div>
  );
}

interface LaneCommon {
  readonly isoDay: string;
  readonly onSelect: (id: string) => void;
  readonly interactive: boolean;
  readonly inFlight: ReadonlySet<string>;
  readonly onMove: (job: DashboardRequest) => void;
  readonly today: string;
  readonly now: Date;
}

/** One droppable lane for one day: bands, then blocks, then cards (spec §7.3 z-order). */
function DayLane({
  scope,
  jobs,
  blocks,
  view,
  availability,
  isoDay,
  onSelect,
  interactive,
  inFlight,
  onMove,
  today,
  now,
}: LaneCommon & {
  readonly scope: string;
  readonly jobs: readonly DashboardRequest[];
  readonly blocks: readonly BoardBlock[];
  readonly view: 'day' | 'week';
  readonly availability?: readonly AvailabilitySlot[];
}) {
  const positioned = useMemo(() => positionJobs(jobs, isoDay), [jobs, isoDay]);
  const compact = view === 'week';
  return (
    <div className="relative shrink-0 rounded-sm border border-border bg-canvas" style={{ height: GRID_PX }}>
      <HourLines />
      {RESCHEDULE_WINDOW_ROWS.map((window: RescheduleWindowRow) => {
        const band = windowBandPlacement(window);
        if (!band) return null;
        const outOfHours =
          scope !== UNASSIGNED_SCOPE && availability !== undefined && !isWindowWithinAvailability(availability, isoDay, window as ArrivalWindow);
        const ended = isoDay === today && bandEnded(isoDay, window, now);
        const off = scope !== UNASSIGNED_SCOPE && timeOffHits(blocks, [scope], arrivalWindowUtcForBusinessDate(isoDay, window)).length > 0;
        return (
          <DroppableWindowBand
            key={`${scope}-${isoDay}-${window}`}
            scope={scope}
            isoDay={isoDay}
            window={window}
            topPx={band.top * GRID_PX}
            heightPx={band.height * GRID_PX}
            outOfHours={outOfHours}
            ended={ended}
            off={off}
          />
        );
      })}
      {blocks.length > 0 && <LaneBlocks blocks={blocks} isoDay={isoDay} gridPx={GRID_PX} pinnedPx={PINNED_CARD_PX} />}
      {positioned.map(({ job, topPx, heightPx, outside, column, columns }) => {
        const terminal = job.status === 'completed' || job.status === 'cancelled';
        const helper = job.laneRole === 'helper';
        const movable = job.movable === 'yes' && !helper && !terminal;
        const busy = inFlight.has(job.id);
        const widthPx = cardWidthPx(columns);
        const shared = { job, onSelect, compact, view, widthPx, heightPx } as const;
        return (
          <div
            key={laneKey(job)}
            className={`absolute z-10${outside ? ' rounded-sm outline-1 outline-dashed outline-offset-1 outline-warning-border' : ''}`}
            style={{ top: topPx, height: heightPx, left: `calc(${(column / columns) * 100}% + 2px)`, width: `calc(${100 / columns}% - 4px)` }}
            title={outside === 'after' ? 'After the calendar’s hours' : outside === 'before' ? 'Before the calendar’s hours' : undefined}
          >
            {terminal ? (
              <div className="h-full w-full opacity-50">
                <CalendarJobCard {...shared} />
              </div>
            ) : movable && interactive ? (
              <DraggableJobCard {...shared} disabled={busy} onMove={onMove} />
            ) : (
              <CalendarJobCard {...shared} onMove={movable ? onMove : undefined} moveDisabled={busy} />
            )}
          </div>
        );
      })}
    </div>
  );
}

function LaneHeader({
  scope,
  icon,
  name,
  count,
  extra,
}: {
  readonly scope: string;
  readonly icon: ReactNode;
  readonly name: string;
  readonly count: number;
  readonly extra?: ReactNode;
}) {
  return (
    <div
      data-lane-header={scope}
      tabIndex={-1}
      className="mb-1 flex h-6 items-center gap-1.5 rounded-sm bg-surface-sunken px-2 text-[13px] font-semibold outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring"
    >
      {icon}
      <span className="truncate">{name}</span>
      <span className="ml-auto font-mono text-xs tabular-nums text-muted-foreground">{count}</span>
      {extra}
    </div>
  );
}

/**
 * Day view (spec §7.2): the time axis stays put; the lanes scroll in their own
 * scroller. At 1440 px Unassigned plus two technician lanes are fully visible,
 * the third peeks, the rest scroll.
 */
function DayView({
  board,
  isoDay,
  availabilityByTech,
  laneHeaderExtra,
  ...common
}: LaneCommon & {
  readonly board: SchedulingCalendar;
  readonly availabilityByTech: ReadonlyMap<string, readonly AvailabilitySlot[]>;
  readonly laneHeaderExtra?: (lane: CalendarTechnicianLane) => ReactNode;
}) {
  const blocks = board.blocks ?? [];
  return (
    <div className="flex gap-2 pb-2">
      {/* pt-7 offsets the axis past the lane header row (h-6 + mb-1 = 28px). */}
      <div className="pt-7">
        <TimeAxis />
      </div>
      <div data-lanes-scroller className="flex min-w-0 flex-1 gap-2 overflow-x-auto">
        <div className="flex w-56 shrink-0 flex-col">
          <LaneHeader scope={UNASSIGNED_SCOPE} icon={<Inbox className="size-4 text-warning-strong" />} name="Unassigned" count={liveJobCount(board.unassigned)} />
          <DayLane {...common} isoDay={isoDay} scope={UNASSIGNED_SCOPE} jobs={board.unassigned} blocks={[]} view="day" />
        </div>
        {board.lanes.map((lane) => (
          <div key={lane.technicianId} className="flex w-56 shrink-0 flex-col">
            <LaneHeader
              scope={lane.technicianId}
              icon={<User className="size-4 text-foreground-faint" />}
              name={lane.technicianName}
              count={liveJobCount(lane.jobs)}
              extra={laneHeaderExtra?.(lane)}
            />
            <DayLane
              {...common}
              isoDay={isoDay}
              scope={lane.technicianId}
              jobs={lane.jobs}
              blocks={blocks.filter((b) => b.technicianId === lane.technicianId)}
              view="day"
              availability={availabilityByTech.get(lane.technicianId) ?? []}
            />
          </div>
        ))}
        {board.lanes.length === 0 && (
          <p className="self-center text-sm text-muted-foreground">No active technicians. Add technicians under Staff.</p>
        )}
      </div>
    </div>
  );
}

/**
 * Week view (spec §7.9): seven equal day columns under the unassigned scope,
 * so a drop never changes the technician; the prompt applies; one card per
 * request (no helper copies, no blocks).
 */
function WeekView({
  days,
  allJobs,
  onPickDay,
  ...common
}: Omit<LaneCommon, 'isoDay'> & {
  readonly days: readonly string[];
  readonly allJobs: readonly DashboardRequest[];
  readonly onPickDay?: (isoDay: string) => void;
}) {
  return (
    <div className="flex gap-2">
      <div className="pt-7">
        <TimeAxis />
      </div>
      <div className="grid min-w-0 flex-1 grid-cols-7 gap-1.5">
        {days.map((isoDay) => {
          const wall = toBusinessWallClock(new Date(`${isoDay}T12:00:00.000Z`));
          const weekday = new Date(Date.UTC(wall.year, wall.month - 1, wall.day)).toLocaleDateString('en-US', { weekday: 'short', timeZone: 'UTC' });
          const isToday = isoDay === common.today;
          return (
            <div key={isoDay} className="flex min-w-0 flex-col">
              <button
                type="button"
                onClick={() => onPickDay?.(isoDay)}
                title="Open this day"
                aria-label={`Open ${isoDay} in day view`}
                className={`mb-1 rounded-sm py-1 text-center text-xs font-semibold transition-colors hover:bg-row-hover ${
                  isToday ? 'bg-primary-soft text-foreground shadow-[inset_0_-2px_0_var(--marker)]' : 'text-foreground'
                }`}
              >
                {weekday}{' '}
                <span className={`font-mono tabular-nums ${isToday ? 'font-semibold' : 'font-normal text-muted-foreground'}`}>
                  {wall.month}/{wall.day}
                </span>
              </button>
              <div className="relative">
                {isToday && <NowLine />}
                <DayLane {...common} isoDay={isoDay} scope={UNASSIGNED_SCOPE} jobs={allJobs} blocks={[]} view="week" />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

/** A move ready to send (spec §7.4 steps 3–7). */
interface PendingMove {
  readonly card: DashboardRequest;
  readonly currentLeadId: string | null;
  readonly newLeadId: string | null;
  readonly body: MoveBody;
  readonly window: TimeWindow;
  /** Lane to focus when the card isn't on the board afterwards. */
  readonly dropLane: string;
  /** Move… to a day the board isn't showing: focus the date stepper. */
  readonly dayMovedAway: boolean;
  /** Check loaded blocks first (the displayed day only). */
  readonly localTimeOff: boolean;
}

interface FocusTarget {
  readonly requestId: string;
  readonly lane: string;
  readonly dayMovedAway: boolean;
}

/** Focus after a drop, a refusal or any dialog closing (spec §7.4), on the next frame. */
function focusAfterMove(t: FocusTarget): void {
  requestAnimationFrame(() => {
    if (t.dayMovedAway) {
      document.getElementById(DATE_LABEL_ID)?.focus();
      return;
    }
    const sel = focusSelectors(t.requestId, t.lane);
    const el = document.querySelector<HTMLElement>(sel.card) ?? document.querySelector<HTMLElement>(sel.lane);
    el?.focus();
  });
}

const focusOf = (p: PendingMove): FocusTarget => ({ requestId: p.card.id, lane: p.dropLane, dayMovedAway: p.dayMovedAway });

/** Crew → rows for moveNeeds (status only decides "live"; the crew is live rows). */
function crewRows(card: DashboardRequest) {
  return (card.crew ?? []).map((c) => ({ technicianId: c.technicianId, isLead: c.isLead, status: 'assigned', hasTimestamp: false }));
}

/**
 * The interactive day/week board (M2 spec §7). Cards are dnd-kit draggables
 * (pointer only), bands are droppables found by `pointerWithin`. A drop runs
 * the §7.4 flow: prompt if the window doesn't cover the band, check loaded
 * time off, move optimistically, POST the move route, then settle by the
 * response (confirm, time off, banner) or, after a STALE or a lost response,
 * by refetching and asking `moveLanded`. Move… runs the same flow.
 */
export function InteractiveSchedulingCalendar({
  calendar,
  view,
  onSelect,
  onRefetch,
  onBanner,
  isLoading,
  onPickDay,
  laneHeaderExtra,
}: InteractiveSchedulingCalendarProps) {
  // Optimistic copy of the board, reset whenever a new `calendar` arrives
  // (adjusting state during render, not in an effect).
  const [board, setBoard] = useState<SchedulingCalendar | null>(calendar);
  const [lastCalendar, setLastCalendar] = useState<SchedulingCalendar | null>(calendar);
  if (calendar !== lastCalendar) {
    setLastCalendar(calendar);
    setBoard(calendar);
  }
  const boardRef = useRef<SchedulingCalendar | null>(calendar);
  const calendarRef = useRef<SchedulingCalendar | null>(calendar);
  useEffect(() => {
    calendarRef.current = calendar;
  }, [calendar]);
  useEffect(() => {
    boardRef.current = board;
  }, [board]);
  const commit = useCallback((next: SchedulingCalendar) => {
    boardRef.current = next;
    setBoard(next);
  }, []);

  const { move, unschedule, inFlight } = useMoveRequest();
  const [activeJob, setActiveJob] = useState<DashboardRequest | null>(null);
  const [prompt, setPrompt] = useState<{
    readonly pending: Omit<PendingMove, 'body' | 'window'>;
    readonly bodyBase: Omit<MoveBody, 'windowRule' | 'pick'>;
    readonly description: string;
    readonly choices: ReturnType<typeof promptChoices>;
    readonly defaultChoice: 'keep' | 'match';
    readonly picks: ReturnType<typeof pickOptions>;
  } | null>(null);
  const [confirm, setConfirm] = useState<{ readonly pending: PendingMove; readonly details: MoveNeedsDetails } | null>(null);
  const [timeOff, setTimeOff] = useState<{ readonly lines: readonly string[]; readonly focus: FocusTarget } | null>(null);
  const [moveDialog, setMoveDialog] = useState<{ readonly card: DashboardRequest; readonly scope: string } | null>(null);
  const landedRef = useRef<{ readonly intended: IntendedMove; readonly failMessage: string; readonly focus: FocusTarget } | null>(null);

  // Interactive at ≥ 1024 px with a fine pointer (spec §7.8). Lazy init: the board is ssr:false.
  const [interactive, setInteractive] = useState<boolean>(
    () => typeof window !== 'undefined' && boardInteractive(window.innerWidth, window.matchMedia('(pointer: fine)').matches),
  );
  useEffect(() => {
    const mq = window.matchMedia('(pointer: fine)');
    const update = () => setInteractive(boardInteractive(window.innerWidth, mq.matches));
    window.addEventListener('resize', update);
    mq.addEventListener('change', update);
    return () => {
      window.removeEventListener('resize', update);
      mq.removeEventListener('change', update);
    };
  }, []);
  const pointer = useSensor(PointerSensor, { activationConstraint: { distance: 6 } });
  const sensors = useSensors(interactive ? pointer : undefined);

  const today = businessIsoDate(new Date());
  const now = new Date();
  const names = useMemo(
    () => new Map((board?.lanes ?? []).map((l) => [l.technicianId, l.technicianName] as const)) as ReadonlyMap<string, string>,
    [board],
  );
  const technicians = useMemo(() => (board?.lanes ?? []).map((l) => ({ id: l.technicianId, name: l.technicianName })), [board]);
  const availabilityByTech = useMemo(() => {
    const map = new Map<string, AvailabilitySlot[]>();
    for (const slot of board?.availability ?? []) {
      const list = map.get(slot.technicianId) ?? [];
      list.push(slot);
      map.set(slot.technicianId, list);
    }
    return map as ReadonlyMap<string, readonly AvailabilitySlot[]>;
  }, [board]);
  const dayBoard = useMemo(() => (board && view !== 'week' ? laneCards(board) : board), [board, view]);
  const allJobs = useMemo<readonly DashboardRequest[]>(
    () => (board ? [...board.lanes.flatMap((l) => l.jobs), ...board.unassigned] : []),
    [board],
  );
  const displayedDays = board?.days ?? [];

  /** After a STALE or a lost response: did the move land on the refetched board? */
  const settleLanded = useCallback(
    (latest: SchedulingCalendar | null) => {
      const pending = landedRef.current;
      if (!pending || !latest) return;
      landedRef.current = null;
      commit(latest);
      if (!moveLanded(latest, pending.intended)) onBanner({ message: pending.failMessage, tone: 'error' });
      focusAfterMove(pending.focus);
    },
    [commit, onBanner],
  );
  useEffect(() => {
    settleLanded(calendar);
  }, [calendar, settleLanded]);
  async function refetchThenSettle(intended: IntendedMove, failMessage: string, focus: FocusTarget): Promise<void> {
    landedRef.current = { intended, failMessage, focus };
    await onRefetch();
    // An identical payload doesn't re-render (the hook's equality guard): settle against the current one.
    requestAnimationFrame(() => settleLanded(calendarRef.current));
  }

  /** Steps 4–7: time off, no-op, optimistic, send, settle. Returns the outcome kind. */
  async function send(p: PendingMove): Promise<string> {
    const before = boardRef.current;
    if (!before) return 'error';
    const current = windowOf(p.card);
    const leadChanges = p.newLeadId !== p.currentLeadId;
    const windowChanges = !current || !windowEqual(current, p.window);
    if (!leadChanges && !windowChanges) {
      focusAfterMove(focusOf(p));
      return 'noop';
    }
    if (p.localTimeOff && p.body.confirm.length === 0) {
      const checked = moveNeeds({ leadChanges, windowChanges, currentLeadId: p.currentLeadId, newLeadId: p.newLeadId, rows: crewRows(p.card) }).checked;
      const hits = timeOffHits(before.blocks ?? [], checked, p.window);
      if (hits.length > 0) {
        const helpers = new Set((p.card.crew ?? []).filter((c) => !c.isLead).map((c) => c.technicianId));
        setTimeOff({ lines: hits.map((h) => timeOffLine(names.get(h.technicianId) ?? null, h, helpers.has(h.technicianId))), focus: focusOf(p) });
        return 'time_off';
      }
    }
    const crewBefore = p.card.crew ?? [];
    commit(
      applyMoveResult(before, p.card.id, {
        visitId: p.card.visitId ?? '',
        visitVersion: p.card.visitVersion ?? 0,
        requestStatus: p.card.status,
        arrivalWindowStart: p.window.start.toISOString(),
        arrivalWindowEnd: p.window.end.toISOString(),
        leadId: p.newLeadId,
        confirmed: [],
      }, names),
    );
    const outcome = await move(p.card.id, p.body, names);
    switch (outcome.kind) {
      case 'ok': {
        const latest = boardRef.current ?? before;
        commit(applyMoveResult(latest, p.card.id, outcome.data, names));
        const crewAfter =
          outcome.data.leadId && outcome.data.leadId !== p.currentLeadId
            ? optimisticCrew(crewBefore, outcome.data.leadId, names.get(outcome.data.leadId) ?? null)
            : crewBefore;
        onBanner({ message: moveBanner(crewBefore, crewAfter), tone: 'status' });
        void onRefetch();
        focusAfterMove(focusOf(p));
        return 'ok';
      }
      case 'needs':
        commit(before);
        setConfirm({ pending: p, details: outcome.details });
        return 'needs';
      case 'time_off': {
        commit(before);
        const helpers = new Set((p.card.crew ?? []).filter((c) => !c.isLead).map((c) => c.technicianId));
        setTimeOff({ lines: outcome.timeOff.map((h) => timeOffLine(names.get(h.technicianId) ?? null, h, helpers.has(h.technicianId))), focus: focusOf(p) });
        return 'time_off';
      }
      case 'stale':
      case 'network':
        await refetchThenSettle(
          { requestId: p.card.id, leadId: p.newLeadId, start: p.window.start.toISOString(), end: p.window.end.toISOString() },
          outcome.kind === 'stale' ? STALE_LINE : MOVE_GENERIC,
          focusOf(p),
        );
        return outcome.kind;
      case 'error':
        commit(before);
        onBanner({ message: outcome.message, tone: 'error' });
        void onRefetch();
        focusAfterMove(focusOf(p));
        return 'error';
    }
  }

  /** Step 3: resolve the window for a chosen rule, then send. */
  function proceed(pending: Omit<PendingMove, 'body' | 'window'>, body: MoveBody): void {
    const resolved = resolveMoveWindow(windowOf(pending.card), body.day, body.band, body.windowRule, body.pick);
    if (!resolved.ok) return;
    void send({ ...pending, body, window: { start: resolved.start, end: resolved.end } });
  }

  /** Steps 2–3 for a band drop (Day or Week). */
  function handleWindowDrop(card: DashboardRequest, scope: string, drop: DropZoneData): void {
    const currentLeadId = leadOf(card, scope);
    const leadChanges = drop.scope !== UNASSIGNED_SCOPE && drop.scope !== currentLeadId;
    const newLeadId = leadChanges ? drop.scope : currentLeadId;
    const current = windowOf(card);
    const pending: Omit<PendingMove, 'body' | 'window'> = {
      card, currentLeadId, newLeadId, dropLane: drop.scope, dayMovedAway: false, localTimeOff: true,
    };
    const bodyBase: Omit<MoveBody, 'windowRule' | 'pick'> = {
      visitId: card.visitId ?? null,
      expectedVersion: card.visitVersion ?? null,
      day: drop.isoDay,
      band: drop.window,
      confirm: [],
      ...(leadChanges && newLeadId ? { technicianId: newLeadId } : {}),
    };
    const plan = promptPlan(current, drop.isoDay, drop.window, leadChanges);
    switch (plan.kind) {
      case 'noop':
        if (plan.coveredLine && current) onBanner({ message: coveredLine(rangeLabel(current.start, current.end)), tone: 'status' });
        focusAfterMove({ requestId: card.id, lane: drop.scope, dayMovedAway: false });
        return;
      case 'use_band':
        // No window yet (Unscheduled): never send a drop into an ended band.
        if (bandEnded(drop.isoDay, drop.window, new Date())) {
          onBanner({ message: WINDOW_ENDED_MESSAGE, tone: 'error' });
          focusAfterMove({ requestId: card.id, lane: drop.scope, dayMovedAway: false });
          return;
        }
        proceed(pending, { ...bodyBase, windowRule: 'match' });
        return;
      case 'keep':
        proceed(pending, { ...bodyBase, windowRule: 'keep' });
        return;
      case 'prompt': {
        const laneName = leadChanges && newLeadId ? `${firstName(names.get(newLeadId) ?? null)}’s ` : 'the ';
        const dayChanges = businessIsoDate(current!.start) !== drop.isoDay;
        setPrompt({
          pending,
          bodyBase,
          description: `Moving ${card.customerName ?? 'Unknown'} · ${card.referenceNumber} to ${laneName}${drop.window}${dayChanges ? ` on ${dayLabel(drop.isoDay)}` : ''}.`,
          choices: promptChoices({ day: drop.isoDay, band: drop.window, current: current!, now: new Date(), offerKeep: plan.offerKeep, dayChanges }),
          defaultChoice: plan.defaultChoice,
          picks: pickOptions(drop.isoDay, new Date()),
        });
        return;
      }
    }
  }

  function handlePromptMove(result: PromptResult): void {
    if (!prompt) return;
    const { pending, bodyBase } = prompt;
    setPrompt(null);
    proceed(pending, result.rule === 'pick' ? { ...bodyBase, windowRule: 'pick', pick: result.pick } : { ...bodyBase, windowRule: result.rule });
  }

  async function handleConfirm(): Promise<void> {
    if (!confirm) return;
    const { pending, details } = confirm;
    // Close first: send()'s focus runs on the next frame and must not land while the modal is still mounted
    // (critic B minor 7). A new 409 with needs reopens the confirm through send().
    setConfirm(null);
    const tokens = [...new Set<MoveConfirm>([...pending.body.confirm, ...details.needs])];
    await send({ ...pending, body: { ...pending.body, confirm: tokens } });
  }

  /** Move… (spec §7.5): the same flow as a drop. */
  function handleDialogSubmit(body: MoveBody): void {
    if (!moveDialog) return;
    const { card, scope } = moveDialog;
    setMoveDialog(null);
    const currentLeadId = leadOf(card, scope === 'unscheduled' ? 'unscheduled' : scope);
    const newLeadId = body.technicianId ?? currentLeadId;
    proceed(
      {
        card,
        currentLeadId,
        newLeadId,
        dropLane: newLeadId ?? UNASSIGNED_SCOPE,
        dayMovedAway: !displayedDays.includes(body.day),
        localTimeOff: displayedDays.includes(body.day),
      },
      body,
    );
  }

  function openMove(job: DashboardRequest): void {
    const b = boardRef.current;
    if (!b) return;
    const found = findLeadCard(b, job.id);
    if (!found) return;
    setMoveDialog({ card: found.card, scope: found.scope });
  }

  function handleDragStart(event: DragStartEvent): void {
    onBanner(null); // any banner clears on the next drag start
    const data = event.active.data.current as DragJobData | undefined;
    const b = boardRef.current;
    if (data?.kind !== 'job' || !b) return;
    setActiveJob(findLeadCard(b, data.requestId)?.card ?? null);
  }

  async function handleDragEnd(event: DragEndEvent): Promise<void> {
    setActiveJob(null);
    const dragData = event.active.data.current as DragJobData | undefined;
    const dropData = event.over?.data.current as CalendarDropData | undefined;
    const b = boardRef.current;
    if (!b || dragData?.kind !== 'job' || !dropData) return;
    const found = findLeadCard(b, dragData.requestId);
    if (!found || found.card.movable === 'no') return;

    // Step 1: back to Unscheduled (§5.4), with the version gate.
    if (dropData.kind === 'unscheduled') {
      if (found.scope === 'unscheduled') return;
      const focus: FocusTarget = { requestId: found.card.id, lane: found.scope, dayMovedAway: false };
      const before = b;
      commit(applyOptimisticUnschedule(before, found.card.id));
      const outcome = await unschedule(found.card.id, { visitId: found.card.visitId ?? null, expectedVersion: found.card.visitVersion ?? null });
      if (outcome.kind === 'ok') {
        void onRefetch();
        focusAfterMove(focus);
      } else if (outcome.kind === 'stale' || outcome.kind === 'network') {
        await refetchThenSettle({ requestId: found.card.id, unscheduled: true }, outcome.kind === 'stale' ? STALE_LINE : MOVE_GENERIC, focus);
      } else {
        commit(before);
        onBanner({ message: outcome.message, tone: 'error' });
        void onRefetch();
        focusAfterMove(focus);
      }
      return;
    }
    handleWindowDrop(found.card, found.scope, dropData);
  }

  const showSkeleton = isLoading && !board;
  const jobName = (d: unknown) => describeDragJob(d as Partial<DragJobData> | undefined);
  const target = (d: unknown) => describeDropTarget(d as CalendarDropData | undefined, names);
  const announcements: Announcements = {
    onDragStart: ({ active }) => `Picked up ${jobName(active.data.current)}.`,
    onDragOver: ({ active, over }) =>
      over ? `${jobName(active.data.current)} is over ${target(over.data.current)}.` : `${jobName(active.data.current)} is no longer over a drop area.`,
    onDragEnd: ({ active, over }) =>
      over ? `${jobName(active.data.current)} was dropped on ${target(over.data.current)}.` : `${jobName(active.data.current)} was dropped.`,
    onDragCancel: ({ active }) => `Moving ${jobName(active.data.current)} was cancelled.`,
  };

  const common = { onSelect, interactive, inFlight, onMove: openMove, today, now } as const;
  const confirmCtx = confirm
    ? (() => {
        const p = confirm.pending;
        const current = windowOf(p.card);
        return {
          names,
          oldLeadId: p.currentLeadId,
          newLeadId: p.newLeadId,
          leadChanges: p.newLeadId !== p.currentLeadId,
          windowChanges: !current || !windowEqual(current, p.window),
          range: rangeLabel(p.window.start, p.window.end),
          dayLabel: current && businessIsoDate(current.start) !== businessIsoDate(p.window.start) ? dayLabel(p.body.day) : null,
          resetsToScheduled: resetsToScheduled({
            status: p.card.status,
            native: !p.card.syncedSource && p.card.fieldpulse !== true,
            oldLeadId: p.currentLeadId,
            started: confirm.details.started ?? [],
            othersStarted: confirm.details.othersStarted === true,
          }),
        };
      })()
    : null;

  return (
    <DndContext
      accessibility={{ announcements, screenReaderInstructions: { draggable: SR_INSTRUCTIONS } }}
      sensors={sensors}
      collisionDetection={dropCollision}
      autoScroll={AUTO_SCROLL}
      modifiers={[restrictToWindowEdges]}
      onDragStart={handleDragStart}
      onDragEnd={(e) => void handleDragEnd(e)}
    >
      {!interactive && <p className="mb-2 text-xs text-muted-foreground">{INTERACTIVE_NOTICE}</p>}
      <div className="flex flex-col gap-4 lg:flex-row">
        <div className="min-w-0 flex-1">
          {showSkeleton || !board || !dayBoard ? (
            <Skeleton className="h-[28rem] w-full" />
          ) : (
            <div className="rounded-lg border border-border-strong bg-surface p-3">
              {view === 'week' ? (
                <WeekView {...common} days={board.days} allJobs={allJobs} onPickDay={onPickDay} />
              ) : (
                <DayView
                  {...common}
                  board={dayBoard}
                  isoDay={board.days[0] ?? today}
                  availabilityByTech={availabilityByTech}
                  laneHeaderExtra={laneHeaderExtra}
                />
              )}
            </div>
          )}
        </div>
        <DraggableUnscheduledPanel
          jobs={board?.unscheduled ?? []}
          isLoading={showSkeleton}
          onSelect={onSelect}
          inFlight={inFlight}
          interactive={interactive}
          onMove={openMove}
        />
      </div>
      <DragOverlay dropAnimation={null}>
        {activeJob ? (
          <div className="w-52 rounded-sm border border-marker opacity-95 shadow-[var(--shadow-pop)]">
            <CalendarJobCard job={activeJob} onSelect={() => {}} />
          </div>
        ) : null}
      </DragOverlay>

      {prompt && (
        <WindowPromptDialog
          key={prompt.pending.card.id}
          open
          description={prompt.description}
          choices={prompt.choices}
          defaultChoice={prompt.defaultChoice}
          pickOptions={prompt.picks}
          onCancel={() => {
            const p = prompt.pending;
            setPrompt(null);
            focusAfterMove({ requestId: p.card.id, lane: p.dropLane, dayMovedAway: false });
          }}
          onMove={handlePromptMove}
        />
      )}
      <ConflictDialog
        open={confirm !== null}
        lines={confirm && confirmCtx ? confirmLines(confirm.details, confirmCtx) : []}
        conflictRows={confirm ? conflictRows(confirm.details.conflicts ?? [], names) : []}
        outsideAvailability={confirm?.details.outsideAvailability === true}
        isSubmitting={confirm ? inFlight.has(confirm.pending.card.id) : false}
        onConfirm={() => void handleConfirm()}
        onCancel={() => {
          if (!confirm) return;
          const f = focusOf(confirm.pending);
          setConfirm(null);
          void onRefetch();
          focusAfterMove(f);
        }}
      />
      <TimeOffDialog
        open={timeOff !== null}
        lines={timeOff?.lines ?? []}
        onClose={() => {
          const f = timeOff?.focus;
          setTimeOff(null);
          if (f) focusAfterMove(f);
        }}
      />
      {moveDialog && (
        <MoveDialog
          key={moveDialog.card.id}
          open
          card={moveDialog.card}
          fromUnscheduled={moveDialog.scope === 'unscheduled'}
          technicians={technicians}
          today={today}
          now={now}
          submitting={inFlight.has(moveDialog.card.id)}
          onCancel={() => {
            const { card, scope } = moveDialog;
            setMoveDialog(null);
            focusAfterMove({ requestId: card.id, lane: scope, dayMovedAway: false });
          }}
          onSubmit={handleDialogSubmit}
        />
      )}
    </DndContext>
  );
}
```

Notes for the implementer:
- `useSensors(interactive ? pointer : undefined)`: `useSensors(...sensors: (SensorDescriptor | undefined | null)[])` (checked in `node_modules/@dnd-kit/core/dist/sensors/useSensors.d.ts`), so a non-interactive board has no sensors and nothing drags; `Move…`, chips, blocks and the lane menu stay. The old `TouchSensor` and `KeyboardSensor` are gone (spec §7.4, §7.8).
- The focus target after a move is the card's lead button `[data-request-id][data-lane-role="lead"]` (set by `CalendarJobCard` and the Unscheduled row), else the drop lane's header, else (Move… to an undisplayed day) the date stepper label `#calendar-date-label`.
- `react-hooks` lint may warn on the `setInteractive` call inside the resize listener; it's in a subscription callback, not the effect body. If `react-hooks/purity` flags `new Date()` during render, wrap `today`/`now` in `useState(() => new Date())` refreshed by the 30 s poll's `calendar` change (`if (calendar !== lastCalendar) setNow(new Date())` in the same render-adjust block).

- [ ] **Step 4: The page** — in `src/app/admin/(dashboard)/calendar/page.tsx`:

Replace

```tsx
import { LoadErrorState } from '@/components/admin/ui/load-error-state';
import { useEffect, useState } from 'react';
```

with

```tsx
import { LoadErrorState } from '@/components/admin/ui/load-error-state';
import { useCallback, useEffect, useRef, useState } from 'react';
import { MoveBanner } from '@/components/admin/calendar/move-banner';
import { DATE_LABEL_ID, type BannerState } from '@/lib/admin/move-request-client';
```

Replace

```tsx
/** A transient banner the calendar surfaces after a reschedule (soft conflict
 * warning or a failure that triggered a rollback). */
interface CalendarStatus {
  readonly message: string;
  readonly tone: 'warning' | 'error';
}

```

with nothing (delete the block).

Replace

```tsx
  const [status, setStatus] = useState<CalendarStatus | null>(null);
```

with

```tsx
  // The board's live region (spec §7.5): always mounted; ids restart the 4 s timer.
  const [banner, setBanner] = useState<BannerState | null>(null);
  const bannerSeq = useRef(0);
  const postBanner = useCallback((b: Omit<BannerState, 'id'> | null) => {
    setBanner(b ? { ...b, id: ++bannerSeq.current } : null);
  }, []);
  const closeBanner = useCallback(() => setBanner(null), []);
```

Replace

```tsx
                <div className="min-w-0 text-center text-sm font-medium sm:min-w-44">
                  {formatRangeLabel(date, view)}
                </div>
```

with

```tsx
                <div
                  id={DATE_LABEL_ID}
                  tabIndex={-1}
                  className="min-w-0 rounded-sm text-center text-sm font-medium outline-none focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring sm:min-w-44"
                >
                  {formatRangeLabel(date, view)}
                </div>
```

Replace

```tsx
      {status && (
        <Alert variant={status.tone === 'error' ? 'destructive' : 'warning'}>
          <AlertCircle className="size-4" />
          <AlertDescription>{status.message}</AlertDescription>
        </Alert>
      )}

```

with nothing (delete the block; `Alert`, `AlertCircle` and `AlertDescription` stay imported for the load-error alert above it).

Replace

```tsx
            onRefetch={refetch}
            onStatus={(message, tone) => setStatus({ message, tone })}
```

with

```tsx
            onRefetch={refetch}
            onBanner={postBanner}
```

Replace

```tsx
      <UrgencyLegend />
```

with

```tsx
      <UrgencyLegend />

      <MoveBanner banner={banner} onClose={closeBanner} />
```

- [ ] **Step 5: Drop the old hook and `@dnd-kit/sortable`.**

```bash
git rm src/hooks/use-reschedule-job.ts
grep -rn "use-reschedule-job\|@dnd-kit/sortable\|RescheduleConflictDetail" src tests && echo "STILL REFERENCED — fix before continuing" || echo "clean"
npm uninstall @dnd-kit/sortable
```

Expected: `clean`; `package.json` loses `"@dnd-kit/sortable": "^10.0.0"`, `package-lock.json` updates. (Spec §7.4: its only import was the board's `sortableKeyboardCoordinates`; the v4.1 verification confirmed it is safe to remove.)

- [ ] **Step 6: Gates**

Run: `npx tsc --noEmit && npx eslint src/components/admin/calendar/interactive-scheduling-calendar.tsx src/components/admin/calendar/draggable-unscheduled-panel.tsx "src/app/admin/(dashboard)/calendar/page.tsx" src/lib/admin/calendar-optimistic.ts src/lib/admin/calendar-optimistic.test.ts && npx vitest run`
Expected: tsc 0, eslint 0 errors, vitest at or above the Task 9a count minus the removed `applyOptimisticReschedule` / `currentScopeOf` cases (report the delta).

- [ ] **Step 7: The board walk (spec §9).** Dev server running (`npm run dev`, background; stopped afterwards). Comms queue at 0 (the fixture checks). `walk-m2-9b.mts` at the repo root (deleted in Step 8):

```ts
import { execFileSync } from "node:child_process";
import { chromium, devices, type Page, type Response } from "playwright";
import { bandLocator, dragToBand, openBoard } from "./scripts/agent/m2-drag.mts";

const env = { ...process.env, NODE_OPTIONS: "--conditions=react-server" };
const fixture = (...args: string[]) =>
  JSON.parse(execFileSync("npx", ["tsx", "scripts/agent/m2-walk.mts", ...args], { encoding: "utf8", env }).trim().split("\n").pop()!);
type Span = { start: string; end: string };
const fx = fixture("seed") as {
  org: string; day: string; techs: { alex: string; sam: string }; requests: Record<string, string>;
  bands: { morning: Span; afternoon: Span; evening: Span }; tokens: { admin: string };
};
const BASE = "http://localhost:3000";
const OUT = process.env.WALK_OUT ?? "/tmp";
const state = (rid: string) => fixture("state", fx.org, rid) as { assignedTo: string | null; start: string | null; end: string | null; status: string };
let shot = 0;
const snap = async (page: Page, name: string) => page.screenshot({ path: `${OUT}/m2-9b-${String(++shot).padStart(2, "0")}-${name}.png` });
const assert = (cond: boolean, what: string, detail?: unknown) => {
  if (!cond) throw new Error(`${what}: ${JSON.stringify(detail)}`);
  console.log("ok", what);
};
const moveResponse = (page: Page) => page.waitForResponse((r) => r.url().includes("/move"), { timeout: 15_000 });
/** Every move in this walk lands on a free band: a 409 fails loudly here, with its code, not as a state mismatch. */
const landed = async (r: Response, what: string) => {
  const body = r.status() === 200 ? null : await r.json().catch(() => null);
  assert(r.status() === 200, `${what}: 200`, body?.error?.code ?? r.status());
};
const card = (page: Page, name: string) => page.locator(`[data-lane-role="lead"][aria-label^="${name} ·"]`);
/** Counts /move requests sent while `fn` runs (read-only and refusal checks). */
async function movesDuring(page: Page, fn: () => Promise<void>): Promise<number> {
  let n = 0;
  const on = (req: { url(): string }) => { if (req.url().includes("/move")) n += 1; };
  page.on("request", on);
  await fn();
  await page.waitForTimeout(500);
  page.off("request", on);
  return n;
}

// Fixture (m2-walk.mts seed) on the walk day: Alex — Pat Nine 9–11, Robin Route 8–12 (en route),
// Lee Afternoon 12–4, Fran Pulse 1–3 PM (FieldPulse); Sam — nothing, off 4–8 PM. Every move below
// targets a band that is free for the technicians it checks (critic B B-1 / M-1).
const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addCookies([{ name: "hvac_admin_session", value: fx.tokens.admin, domain: "localhost", path: "/" }]);
  const page = await ctx.newPage();
  await openBoard(page, BASE, fx.day);
  await snap(page, "board");

  // 1. 9–11 → Alex's own EVENING (his afternoon holds Lee and Fran): prompt, default "Use the evening window"
  //    (same day and lead), Keep not offered. Enter on a focused Cancel closes and sends nothing (critic B M-3).
  await dragToBand(page, card(page, "Pat Nine"), bandLocator(page, fx.techs.alex, fx.day, "evening"));
  let prompt = page.getByRole("dialog", { name: "Arrival window" });
  await prompt.waitFor();
  assert(await prompt.getByRole("radio", { name: /Use the evening window/ }).isChecked(), "prompt defaults to the evening window");
  assert((await prompt.getByRole("radio", { name: /^Keep/ }).count()) === 0, "Keep is not offered for the same day and lead");
  await snap(page, "prompt");
  const sentOnEnter = await movesDuring(page, async () => {
    await prompt.getByRole("button", { name: "Cancel" }).focus();
    await page.keyboard.press("Enter");
    await prompt.waitFor({ state: "hidden" });
  });
  assert(sentOnEnter === 0, "Enter on Cancel closes the prompt and sends nothing");
  assert(state(fx.requests.nineEleven!).start !== fx.bands.evening.start, "nothing moved");
  await dragToBand(page, card(page, "Pat Nine"), bandLocator(page, fx.techs.alex, fx.day, "evening"));
  prompt = page.getByRole("dialog", { name: "Arrival window" });
  let wait = moveResponse(page);
  await prompt.getByRole("button", { name: "Move" }).click();
  await landed(await wait, "prompt Move");
  assert(state(fx.requests.nineEleven!).start === fx.bands.evening.start, "moved to 4 PM–8 PM");
  await snap(page, "moved-evening");

  // 2. The en-route morning request → Sam's morning (free): "Move anyway?" → Cancel → again → Move anyway → banner.
  await dragToBand(page, card(page, "Robin Route"), bandLocator(page, fx.techs.sam, fx.day, "morning"));
  let confirm = page.getByRole("dialog", { name: "Move anyway?" });
  await confirm.waitFor();
  assert((await confirm.textContent())?.includes("is en route to this visit.") === true, "confirm names the en-route technician");
  await snap(page, "confirm");
  await confirm.getByRole("button", { name: "Cancel" }).click();
  assert(state(fx.requests.enRoute!).assignedTo === fx.techs.alex, "Cancel kept Alex");
  await dragToBand(page, card(page, "Robin Route"), bandLocator(page, fx.techs.sam, fx.day, "morning"));
  confirm = page.getByRole("dialog", { name: "Move anyway?" });
  await confirm.waitFor();
  wait = moveResponse(page);
  await confirm.getByRole("button", { name: "Move anyway" }).click();
  await landed(await wait, "Move anyway");
  const handed = state(fx.requests.enRoute!);
  assert(handed.assignedTo === fx.techs.sam && handed.status === "scheduled", "Move anyway handed over and reset to scheduled", handed);
  await page.getByRole("status").getByText("Sam is now the lead. Alex is off this visit.").waitFor();
  await snap(page, "move-anyway-banner");

  // 3. Drag it back to Alex's morning (Pat Nine is in his evening now): an ordinary move, no confirm.
  wait = moveResponse(page);
  await dragToBand(page, card(page, "Robin Route"), bandLocator(page, fx.techs.alex, fx.day, "morning"));
  await landed(await wait, "drag back");
  assert(state(fx.requests.enRoute!).assignedTo === fx.techs.alex, "dragged back without a confirm");
  assert((await page.getByRole("dialog", { name: "Move anyway?" }).count()) === 0, "no confirm on the way back");

  // 4. The afternoon request → Sam's evening: Use the new window → Move → time-off dialog, nothing sent.
  const beforeOff = state(fx.requests.afternoon!);
  const sentOnTimeOff = await movesDuring(page, async () => {
    await dragToBand(page, card(page, "Lee Afternoon"), bandLocator(page, fx.techs.sam, fx.day, "evening"));
    const p2 = page.getByRole("dialog", { name: "Arrival window" });
    await p2.getByRole("radio", { name: /Use the evening window/ }).check();
    await p2.getByRole("button", { name: "Move" }).click();
    const off = page.getByRole("dialog", { name: "Can’t move this request" });
    await off.waitFor();
    assert((await off.textContent())?.includes("Sam is off 4 PM–8 PM on") === true, "time-off line names Sam");
    await snap(page, "time-off");
    await off.getByRole("button", { name: "OK" }).click();
  });
  assert(sentOnTimeOff === 0, "time off is checked before sending");
  assert(JSON.stringify(state(fx.requests.afternoon!)) === JSON.stringify(beforeOff), "nothing moved");

  // 5. The FieldPulse card: pill and lock, no grab cursor, no Move….
  const fp = card(page, "Fran Pulse");
  assert((await fp.locator('[title="Change this request in FieldPulse."]').count()) === 1, "FieldPulse pill with its title");
  assert((await page.getByRole("button", { name: /^Move Fran Pulse ·/ }).count()) === 0, "no Move… on the FieldPulse card");
  assert((await fp.evaluate((el) => getComputedStyle(el.parentElement!.parentElement!).cursor)) !== "grab", "no grab cursor");
  await snap(page, "fieldpulse-card");

  // 6. Move… from the keyboard: Pat Nine → Sam's morning (free since step 3) → focus returns to the card.
  await card(page, "Pat Nine").focus();
  await page.keyboard.press("Tab"); // card → its Move…
  assert(await page.getByRole("button", { name: /^Move Pat Nine ·/ }).evaluate((el) => el === document.activeElement), "Tab reaches Move…");
  await page.keyboard.press("Enter");
  const md = page.getByRole("dialog", { name: /^Move Pat Nine ·/ });
  await md.locator("#move-tech").click();
  await page.getByRole("option", { name: "Sam Lee" }).click();
  await md.getByRole("radio", { name: /^Morning/ }).check();
  wait = moveResponse(page);
  await md.getByRole("button", { name: "Move" }).click();
  await landed(await wait, "Move… to Sam");
  const six = state(fx.requests.nineEleven!);
  assert(six.assignedTo === fx.techs.sam && six.start === fx.bands.morning.start, "Move… moved it to Sam's morning", six);
  await page.waitForFunction(() => document.activeElement?.getAttribute("aria-label")?.startsWith("Pat Nine ·") === true, null, { timeout: 5_000 });
  console.log("ok focus returned to the card");

  // 7. Week view, next day, same band → no prompt (covered keep). The fixture never seeds a Saturday,
  //    so the next day is always in the same Sunday-first week (critic B minor 9).
  await page.getByRole("tab", { name: "Week" }).click();
  const next = new Date(`${fx.day}T00:00:00.000Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  const nextDay = next.toISOString().slice(0, 10);
  const weekBand = bandLocator(page, "unassigned", nextDay, "afternoon");
  await weekBand.waitFor({ timeout: 15_000 });
  wait = moveResponse(page);
  await dragToBand(page, card(page, "Lee Afternoon"), weekBand);
  await landed(await wait, "week move");
  assert((await page.getByRole("dialog", { name: "Arrival window" }).count()) === 0, "no prompt for a covered day change");
  const expected = new Date(Date.parse(fx.bands.afternoon.start) + 86_400_000).toISOString();
  assert(state(fx.requests.afternoon!).start === expected, "kept the afternoon on the next day", state(fx.requests.afternoon!));
  await snap(page, "week");
  await ctx.close();

  // 8. Not interactive (spec §7.8). Pat Nine sits on Sam's morning after step 6.
  //    1023 px: the notice; a pointer drag sends nothing (read-only); Move… → Afternoon (Sam 12–4 is free) → 200.
  //    390 px, touch: the notice; no Move… on the FieldPulse card; Move… → Evening is refused locally (Sam is off
  //    4–8 PM, nothing sent); then Morning → 200.
  for (const width of [1023, 390] as const) {
    const opts = width === 1023
      ? { viewport: { width: 1023, height: 800 } }
      : { ...devices["iPhone 13"], viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true };
    const c = await browser.newContext(opts);
    await c.addCookies([{ name: "hvac_admin_session", value: fx.tokens.admin, domain: "localhost", path: "/" }]);
    const p = await c.newPage();
    await openBoard(p, BASE, fx.day);
    await p.getByText("Dragging needs a computer. Use Move… on a request, or open it.").waitFor();
    console.log("ok notice at", width);
    const mv = p.getByRole("button", { name: /^Move Pat Nine ·/ });
    assert(await mv.isVisible(), `Move… visible at ${width}`);
    const openMove = async () => {
      if (width === 390) await mv.tap();
      else await mv.click();
      return p.getByRole("dialog", { name: /^Move Pat Nine ·/ });
    };
    if (width === 1023) {
      const dragged = await movesDuring(p, async () => {
        await dragToBand(p, card(p, "Pat Nine"), bandLocator(p, fx.techs.sam, fx.day, "afternoon")).catch(() => undefined);
      });
      assert(dragged === 0 && state(fx.requests.nineEleven!).start === fx.bands.morning.start, "1023: a drag is read-only");
      const d = await openMove();
      await d.getByRole("radio", { name: /^Afternoon/ }).check();
      const w = moveResponse(p);
      await d.getByRole("button", { name: "Move" }).click();
      await landed(await w, "1023 Move…");
      assert(state(fx.requests.nineEleven!).start === fx.bands.afternoon.start, "1023: moved to the afternoon");
    } else {
      assert((await p.getByRole("button", { name: /^Move Fran Pulse ·/ }).count()) === 0, "390: no Move… on the FieldPulse card");
      const refused = await movesDuring(p, async () => {
        const d = await openMove();
        await d.getByRole("radio", { name: /^Evening/ }).check();
        await d.getByRole("button", { name: "Move" }).click();
        const off = p.getByRole("dialog", { name: "Can’t move this request" });
        await off.waitFor();
        await off.getByRole("button", { name: "OK" }).click();
      });
      assert(refused === 0 && state(fx.requests.nineEleven!).start === fx.bands.afternoon.start, "390: time off refused locally, nothing sent");
      const d = await openMove();
      await d.getByRole("radio", { name: /^Morning/ }).check();
      const w = moveResponse(p);
      await d.getByRole("button", { name: "Move" }).click();
      await landed(await w, "390 Move…");
      assert(state(fx.requests.nineEleven!).start === fx.bands.morning.start, "390: moved back to the morning");
    }
    await p.screenshot({ path: `${OUT}/m2-9b-${String(++shot).padStart(2, "0")}-narrow-${width}.png` });
    await c.close();
  }
} finally {
  await browser.close();
  fixture("delete", fx.org);
}
```

Run: `WALK_OUT=<session scratchpad> npx tsx walk-m2-9b.mts`
Expected: every `ok` line, then `{"deleted":"<org>"}`. Look at every screenshot (prompt copy and defaults, the confirm's three lines, the banner bottom-right, the time-off dialog, the FieldPulse pill + lock, the 1023 and 390 notices; the banner sits top-centre at 390). If a selector doesn't match the real markup (e.g. Base UI renders the radio's accessible name differently), fix the walk, not the copy; never loosen a `landed` (200) or a state assertion. Then delete the screenshots.

- [ ] **Step 8: Delete the walk, commit**

```bash
rm walk-m2-9b.mts
git status --short   # only this task's files
git add src/components/admin/calendar/interactive-scheduling-calendar.tsx src/components/admin/calendar/draggable-unscheduled-panel.tsx "src/app/admin/(dashboard)/calendar/page.tsx" src/lib/admin/calendar-optimistic.ts src/lib/admin/calendar-optimistic.test.ts package.json package-lock.json
git commit -m "$(cat <<'EOF'
feat(m2): board drop flow on the move route

pointerWithin with the spec 7.2 layout and auto-scroll, the window prompt,
Move anyway, the time-off dialog, Move..., helper copies and blocks in Day
view, optimistic moves keyed by request with moveLanded after STALE, focus
after every drop and dialog, the interactivity rule and the live-region
banner. use-reschedule-job and @dnd-kit/sortable are removed.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01GuWoF63tQU1i7ELqyYU3A6
EOF
)"
```

(`git rm` in Step 5 already staged the hook's deletion.)

---
### Task 10: Move this day… and the sheet's Visits crew and Change time

**Files:**
- Create: `src/lib/admin/sheet-visit-copy.ts`, `src/lib/admin/sheet-visit-copy.test.ts`, `src/lib/admin/mass-dialog-state.ts`, `src/lib/admin/mass-dialog-state.test.ts`, `src/lib/admin/mass-dialog-key.ts`, `src/lib/admin/mass-dialog-key.test.ts`, `src/hooks/use-mass-reschedule.ts`, `src/components/admin/calendar/mass-move-dialog.tsx`, `src/components/admin/calendar/lane-menu.tsx`, `src/components/admin/visit-crew-control.tsx`, `src/components/admin/visit-change-time-dialog.tsx`
- Modify: `src/components/admin/request-detail-sheet.tsx` (re-read right before editing: other workstreams touch it), `src/app/admin/(dashboard)/calendar/page.tsx` (fills 9b's `laneHeaderExtra` slot with `LaneMenu`, owns the `MassMoveDialog`)
- Temporary (never committed): `walk-m2-10.mts` at the repo root

**Interfaces:**
- Consumes: Task 1 `windowHasEndedAt`; Task 2 `massDefaultDay`, `massChanges`, `bandEnded`, `firstName`, `dayLabel`, `rangeLabel`, `massReasonLabel`, `massResultHeadline`, `massMoveButton`, `massDialogTitle`, `MASS_COPY`, `FIELDPULSE_SHEET_TECH`, `FIELDPULSE_SHEET_CREW`, `FIELDPULSE_SHEET_STARTED`, `SHEET_STARTED_NATIVE`; board types `MassCandidate`, `MassResult`, `MassPreSkipReason`; Task 4 `AppointmentAssignmentRecord.started` / `.hasProgress` (from `GET …/appointments`), the assignments routes' `NO_LEAD` / `VISIT_FULL`; Task 3 assign codes `MANAGED_EXTERNALLY`, `TECHNICIAN_DONE`, `HAS_PROGRESS`; Task 6 types `MassQuery`, `MassCommitBody` (type-only import from `@/lib/admin/mass-reschedule`); Task 8 routes `POST /api/admin/dispatch/mass-reschedule/preview` → `{ candidates }`, `POST /api/admin/dispatch/mass-reschedule` (`Idempotency-Key`) → `MassResult`; Task 9b's board prop `laneHeaderExtra?: (lane: CalendarTechnicianLane) => ReactNode`, the page's `refetch`, `todayBusiness()`, `calendar` and the `MoveBanner` block 9b added. Existing: `appointmentPatchSchema` body (`version`, `arrivalWindowStart`, `arrivalWindowEnd`, `technicianIds` lead first, `specialInstructions`), `selectLabel`, `windowOptionLabel` (Task 9a, `move-request-client.ts`), `arrivalWindowUtcForBusinessDate`, `businessIsoDate`, `windowRowOfInstant`.
- Produces:
  - `sheet-visit-copy.ts`: `CREW_CAP_LINE`, `CREW_NO_LEAD_LINE`, `CREW_HCP_LINE`, `CREW_GENERIC`, `CREW_ADD_LABEL`, `VISIT_ERROR_COPY`, `VISIT_GENERIC_ERROR`, `visitErrorCopy(code, technicianNames)`, `sheetCrewError(code, name, kind)`, `sheetAssignError(code, name, fieldpulse)`, `RequestKind`, `requestKindOf(syncedSource)`, `CrewControlModel`, `crewControlModel(visit, technicians, kind)`, `CHANGE_TIME_WINDOWS`, `changeTimeDefaults(visit, today)`, `changeTimeBlocked(visit)`, `changeTimeBody(visit, day, window)`.
  - `mass-dialog-state.ts`: `MassForm`, `massInitialForm`, `massPickTechnician`, `massPickDay`, `massQuery`, `MassRow`, `massRows`, `massMoveCount`, `massHasConflict`, `massCanCommit`, `massCommitBody`, `massResultLines`, `massDateBounds`, `nextCommitKey`.
  - `useMassReschedule()` → `{ preview(q), commit(body), committing }`; `<MassMoveDialog>`; `<LaneMenu>`; `<VisitCrewControl>`; `<VisitChangeTimeDialog>`.

- [ ] **Step 1: Write the failing tests** — `src/lib/admin/sheet-visit-copy.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  CREW_CAP_LINE, CREW_GENERIC, CREW_HCP_LINE, CREW_NO_LEAD_LINE, VISIT_GENERIC_ERROR,
  changeTimeBlocked, changeTimeBody, changeTimeDefaults, crewControlModel, requestKindOf,
  sheetAssignError, sheetCrewError, visitErrorCopy,
} from "./sheet-visit-copy";
import type { AppointmentRecord } from "./appointment-types";
import type { TechnicianRecord } from "./types";

const ALEX = "a1111111-1111-4111-8111-111111111111";
const SAM = "b2222222-2222-4222-8222-222222222222";
const KIM = "c3333333-3333-4333-8333-333333333333";
const tech = (id: string, name: string, isActive = true): TechnicianRecord => ({ id, name, email: `${name}@x.io`, isActive, createdAt: "2026-01-01T00:00:00.000Z" });
const TECHS = [tech(ALEX, "Alex Rivera"), tech(SAM, "Sam Lee"), tech(KIM, "Kim Ode"), tech("d", "Dee Gone", false)];

function visit(over: Partial<AppointmentRecord> = {}): AppointmentRecord {
  return {
    id: "v2", serviceRequestId: "r1", appointmentNumber: 2, scheduledDate: "2026-11-10T14:00:00.000Z",
    startsAt: "2026-11-10T14:00:00.000Z", endsAt: "2026-11-10T16:00:00.000Z",
    arrivalWindowStart: "2026-11-10T14:00:00.000Z", arrivalWindowEnd: "2026-11-10T16:00:00.000Z",
    isConfirmed: false, cancelledAt: null, specialInstructions: "Side gate", version: 4,
    assignments: [
      { technicianId: SAM, technicianName: "Sam Lee", isLead: false, status: "assigned", started: false, hasProgress: false },
      { technicianId: ALEX, technicianName: "Alex Rivera", isLead: true, status: "assigned", started: false, hasProgress: false },
    ],
    ...over,
  };
}

describe("sheet crew copy (spec §8 'Sheet crew')", () => {
  it("each code", () => {
    expect(sheetCrewError("ALREADY_ASSIGNED", "Sam Lee", "native")).toBe("Sam Lee is already on this visit.");
    expect(sheetCrewError("HAS_PROGRESS", "Sam Lee", "native")).toBe("Sam Lee has started, so they stay on this visit.");
    expect(sheetCrewError("TIME_OFF", "Sam Lee", "native")).toBe("Sam Lee is off during this visit.");
    expect(sheetCrewError("VISIT_ENDED", null, "native")).toBe("This visit has ended.");
    expect(sheetCrewError("NO_LEAD", null, "native")).toBe(CREW_NO_LEAD_LINE);
    expect(sheetCrewError("VISIT_FULL", null, "native")).toBe("This visit already has 5 technicians.");
    expect(sheetCrewError("INTERNAL_ERROR", null, "native")).toBe(CREW_GENERIC);
  });
  it("a synced refusal names the system", () => {
    expect(sheetCrewError("MANAGED_EXTERNALLY", null, "fieldpulse")).toBe("Change the technicians for this request in FieldPulse.");
    expect(sheetCrewError("MANAGED_EXTERNALLY", null, "housecall")).toBe(CREW_HCP_LINE);
  });
  it("lines", () => {
    expect(CREW_CAP_LINE).toBe("A visit can have up to 5 technicians.");
    expect(CREW_NO_LEAD_LINE).toBe("Assign a technician to this request first.");
    expect(CREW_HCP_LINE).toBe("Helpers aren’t available for Housecall Pro requests.");
    expect(CREW_GENERIC).toBe("Couldn’t change the technicians. Please try again.");
  });
});

describe("sheet reassign copy (spec §8 'Sheet reassign', §5.5)", () => {
  it("FieldPulse first, then the started rule, then TECHNICIAN_DONE", () => {
    expect(sheetAssignError("MANAGED_EXTERNALLY", "Sam Lee", true)).toBe("Change the technician for this request in FieldPulse.");
    expect(sheetAssignError("HAS_PROGRESS", "Sam Lee", false)).toBe("A technician has started this visit. To move it anyway, use Move… on the calendar.");
    expect(sheetAssignError("HAS_PROGRESS", "Sam Lee", true)).toBe("A technician has started this visit. Change it in FieldPulse.");
    expect(sheetAssignError("TECHNICIAN_DONE", "Sam Lee", false)).toBe("Sam Lee has finished on this visit.");
    expect(sheetAssignError("REQUEST_NOT_ASSIGNABLE", "Sam Lee", false)).toBeNull();
  });
  it("requestKindOf", () => {
    expect(requestKindOf("fieldpulse")).toBe("fieldpulse");
    expect(requestKindOf("housecall")).toBe("housecall");
    expect(requestKindOf(null)).toBe("native");
  });
});

describe("Change time copy (spec §8; lead ruling 11)", () => {
  it("the updated map", () => {
    expect(visitErrorCopy("HAS_PROGRESS", [])).toBe("Work has started on this visit, so its time can’t change. Cancel it and add a new visit instead.");
    expect(visitErrorCopy("VERSION_CONFLICT", [])).toBe("This visit changed. It has been refreshed.");
    expect(visitErrorCopy("TECHNICIAN_NOT_FOUND", [])).toBe("A technician on this visit isn’t active any more. Cancel it and add a new visit instead.");
    expect(visitErrorCopy("VISIT_ENDED", [])).toBe("This visit has ended. Add a new visit instead.");
    expect(visitErrorCopy(undefined, [])).toBe(VISIT_GENERIC_ERROR);
    expect(VISIT_GENERIC_ERROR).toBe("Couldn’t save the visit. Please try again.");
  });
  it("TIME_OFF names one technician, else says 'A technician'", () => {
    expect(visitErrorCopy("TIME_OFF", ["Sam Lee"])).toBe("Sam Lee is off during this time.");
    expect(visitErrorCopy("TIME_OFF", ["Sam Lee", "Alex Rivera"])).toBe("A technician on this visit is off during this time.");
  });
});

describe("crewControlModel (spec §7.7)", () => {
  it("edit: lead first, × only on a helper that hasn't started, add options = active technicians not live on the visit", () => {
    const m = crewControlModel(visit({ assignments: [
      ...visit().assignments,
      { technicianId: KIM, technicianName: "Kim Ode", isLead: false, status: "in_progress", started: true, hasProgress: true },
    ] }), TECHS, "native");
    expect(m.mode).toBe("edit");
    if (m.mode !== "edit") return;
    expect(m.members.map((x) => [x.technicianId, x.isLead, x.removable])).toEqual([[ALEX, true, false], [SAM, false, true], [KIM, false, false]]);
    expect(m.addOptions).toEqual([]);
    expect(m.full).toBe(false);
  });
  it("a cancelled row is not on the crew and can be added back", () => {
    const m = crewControlModel(visit({ assignments: [visit().assignments[1]!, { technicianId: SAM, technicianName: "Sam Lee", isLead: false, status: "cancelled", started: false, hasProgress: true }] }), TECHS, "native");
    if (m.mode !== "edit") throw new Error(m.mode);
    expect(m.addOptions.map((o) => o.value)).toEqual([SAM, KIM]);
  });
  it("full at 5", () => {
    const five = ["1", "2", "3", "4"].map((n) => ({ technicianId: n, technicianName: n, isLead: false, status: "assigned", started: false, hasProgress: false }));
    const m = crewControlModel(visit({ assignments: [visit().assignments[1]!, ...five] }), TECHS, "native");
    if (m.mode !== "edit") throw new Error(m.mode);
    expect(m.full).toBe(true);
  });
  it("no lead → hidden with the line; FieldPulse and HCP → their line", () => {
    expect(crewControlModel(visit({ assignments: [] }), TECHS, "native")).toEqual({ mode: "line", line: CREW_NO_LEAD_LINE });
    expect(crewControlModel(visit(), TECHS, "fieldpulse")).toEqual({ mode: "line", line: "Change the technicians for this request in FieldPulse." });
    expect(crewControlModel(visit(), TECHS, "housecall")).toEqual({ mode: "line", line: CREW_HCP_LINE });
  });
});

describe("Change time", () => {
  const now = new Date("2026-11-09T12:00:00.000Z");
  it("defaults to the visit's day and band", () => {
    expect(changeTimeDefaults(visit({ arrivalWindowStart: "2026-11-10T17:00:00.000Z", arrivalWindowEnd: "2026-11-10T21:00:00.000Z" }), "2026-11-09")).toEqual({ day: "2026-11-10", window: "afternoon" });
    expect(changeTimeDefaults(visit({ arrivalWindowStart: null, arrivalWindowEnd: null }), "2026-11-09")).toEqual({ day: "2026-11-09", window: "morning" });
  });
  it("blocked when any row has a progress timestamp", () => {
    expect(changeTimeBlocked(visit())).toBe(false);
    expect(changeTimeBlocked(visit({ assignments: [{ technicianId: ALEX, technicianName: "A", isLead: true, status: "cancelled", started: false, hasProgress: true }] }))).toBe(true);
  });
  it("body: version, the window, live technicians lead first, instructions kept", () => {
    expect(changeTimeBody(visit(), "2026-11-11", "afternoon", now)).toEqual({
      version: 4, arrivalWindowStart: "2026-11-11T17:00:00.000Z", arrivalWindowEnd: "2026-11-11T21:00:00.000Z",
      technicianIds: [ALEX, SAM], specialInstructions: "Side gate",
    });
  });
  it("null when nothing changes, the window ended, or nobody is on the visit", () => {
    expect(changeTimeBody(visit(), "2026-11-10", "morning", now)).not.toBeNull(); // 9–11 → 8–12 is a change
    const morning = visit({ arrivalWindowStart: "2026-11-10T13:00:00.000Z", arrivalWindowEnd: "2026-11-10T17:00:00.000Z" });
    expect(changeTimeBody(morning, "2026-11-10", "morning", now)).toBeNull();
    expect(changeTimeBody(visit(), "2026-11-08", "morning", now)).toBeNull();
    expect(changeTimeBody(visit({ assignments: [] }), "2026-11-11", "morning", now)).toBeNull();
  });
});
```

`src/lib/admin/mass-dialog-state.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import {
  massCanCommit, massCommitBody, massDateBounds, massHasConflict, massInitialForm, massMoveCount, massPickDay,
  massPickTechnician, massQuery, massResultLines, massRows, nextCommitKey,
} from "./mass-dialog-state";
import type { MassCandidate } from "./board-types";

const ALEX = "a1111111-1111-4111-8111-111111111111";
const SAM = "b2222222-2222-4222-8222-222222222222";
const FROM = "2026-11-10"; // Tuesday
const cand = (over: Partial<MassCandidate>): MassCandidate => ({
  visitId: "v1", requestId: "r1", referenceNumber: "HVAC-1", customerName: "Pat Doe",
  arrivalWindowStart: "2026-11-10T14:00:00.000Z", arrivalWindowEnd: "2026-11-10T16:00:00.000Z",
  visitNumber: 1, expectedVersion: 2, outcome: "moves", conflict: false, leadFirstName: null, ...over,
});
const CANDS = [
  cand({}),
  cand({ visitId: "v2", requestId: "r2", referenceNumber: "HVAC-2", outcome: "started" }),
  cand({ visitId: "v3", requestId: "r3", referenceNumber: "HVAC-3", conflict: true }),
  cand({ visitId: "v4", requestId: "r4", referenceNumber: "HVAC-4", outcome: "helper", leadFirstName: "Kim" }),
];

describe("form", () => {
  it("defaults to the next weekday, same technician", () => {
    expect(massInitialForm(FROM)).toEqual({ toDate: "2026-11-11", toTechnicianId: "", dayTouched: false, confirmConflict: false });
  });
  it("picking a technician sets the same day only while the day is untouched", () => {
    const f = massPickTechnician(massInitialForm(FROM), FROM, SAM);
    expect(f).toMatchObject({ toTechnicianId: SAM, toDate: FROM });
    expect(massPickTechnician(f, FROM, "").toDate).toBe("2026-11-11");
    const touched = massPickDay(massInitialForm(FROM), "2026-11-13");
    expect(massPickTechnician(touched, FROM, SAM).toDate).toBe("2026-11-13");
  });
  it("the query carries toTechnicianId only when set", () => {
    expect(massQuery(ALEX, FROM, massInitialForm(FROM))).toEqual({ technicianId: ALEX, fromDate: FROM, toDate: "2026-11-11" });
    expect(massQuery(ALEX, FROM, massPickTechnician(massInitialForm(FROM), FROM, SAM))).toEqual({ technicianId: ALEX, fromDate: FROM, toDate: FROM, toTechnicianId: SAM });
  });
  it("date bounds: today … today + 365", () => {
    expect(massDateBounds("2026-11-10")).toEqual({ min: "2026-11-10", max: "2027-11-10" });
  });
});

describe("rows and counts", () => {
  it("row labels and statuses; a conflict moves only when confirmed", () => {
    const f = massInitialForm(FROM);
    expect(massRows(CANDS, f, { toFirstName: null }).map((r) => [r.label, r.status, r.moves])).toEqual([
      ["9 AM–11 AM · Pat Doe · HVAC-1", "Moves", true],
      ["9 AM–11 AM · Pat Doe · HVAC-2", "Started", false],
      ["9 AM–11 AM · Pat Doe · HVAC-3", "Overlaps another request", false],
      ["9 AM–11 AM · Pat Doe · HVAC-4", "Helping Kim. Change it in the request.", false],
    ]);
    expect(massMoveCount(CANDS, f)).toBe(1);
    expect(massMoveCount(CANDS, { ...f, confirmConflict: true })).toBe(2);
    expect(massHasConflict(CANDS)).toBe(true);
  });
  it("commit is disabled when nothing changes or nothing moves", () => {
    expect(massCanCommit(ALEX, FROM, massInitialForm(FROM), CANDS)).toBe(true);
    expect(massCanCommit(ALEX, FROM, { ...massInitialForm(FROM), toDate: FROM }, CANDS)).toBe(false);
    expect(massCanCommit(ALEX, FROM, massInitialForm(FROM), [CANDS[1]!])).toBe(false);
  });
});

describe("commit body", () => {
  it("movers in visits; every other row in preSkipped with its reason, an unconfirmed conflict as 'conflict'", () => {
    expect(massCommitBody(ALEX, FROM, massInitialForm(FROM), CANDS)).toEqual({
      technicianId: ALEX, fromDate: FROM, toDate: "2026-11-11",
      visits: [{ visitId: "v1", expectedVersion: 2 }],
      preSkipped: [{ visitId: "v2", reason: "started" }, { visitId: "v3", reason: "conflict" }, { visitId: "v4", reason: "helper" }],
      confirmConflict: false,
    });
  });
  it("confirmConflict moves the conflicting row", () => {
    const b = massCommitBody(ALEX, FROM, { ...massInitialForm(FROM), confirmConflict: true }, CANDS);
    expect(b.visits.map((v) => v.visitId)).toEqual(["v1", "v3"]);
    expect(b.confirmConflict).toBe(true);
  });
});

describe("result lines", () => {
  it("headline, what stayed, pushes not sent", () => {
    const lines = massResultLines(
      { moved: [{ visitId: "v1", requestId: "r1", visitVersion: 3 }], skipped: [{ visitId: "v2", reason: "started" }, { visitId: "v3", reason: "stale" }], pushesNotSent: ["r1"] },
      CANDS, { fromName: "Alex Rivera", toName: "Sam Lee", fromDate: FROM, toDate: "2026-11-11" },
    );
    expect(lines).toEqual({
      headline: "Moved 1 of Alex’s requests to Sam on Wed, Nov 11.",
      stayed: ["9 AM–11 AM · Pat Doe · HVAC-2 · Started", "9 AM–11 AM · Pat Doe · HVAC-3 · Changed since you opened this"],
      notSent: ["9 AM–11 AM · Pat Doe · HVAC-1 · Not sent to Housecall Pro. Open it to retry."],
    });
  });
});

describe("nextCommitKey (one key per body; reused only for a retry of that body)", () => {
  const mint = () => "k-new";
  it("mints for a new body, reuses for the same body", () => {
    expect(nextCommitKey(null, "{a}", mint)).toEqual({ body: "{a}", key: "k-new" });
    expect(nextCommitKey({ body: "{a}", key: "k-old" }, "{a}", mint)).toEqual({ body: "{a}", key: "k-old" });
    expect(nextCommitKey({ body: "{a}", key: "k-old" }, "{b}", mint)).toEqual({ body: "{b}", key: "k-new" });
  });
});
```

- [ ] **Step 2: Run them to verify they fail**

Run: `npx vitest run src/lib/admin/sheet-visit-copy.test.ts src/lib/admin/mass-dialog-state.test.ts`
Expected: FAIL — `Failed to resolve import "./sheet-visit-copy"` / `"./mass-dialog-state"`.

- [ ] **Step 3: Implement the pure modules** — `src/lib/admin/sheet-visit-copy.ts`:

```ts
/**
 * The request sheet's Visits copy and models (M2 spec §5.5, §7.7, §8; lead
 * ruling 11). One copy map for the visit dialogs (VISIT_ERROR_COPY replaces the
 * sheet's local map), the crew control's refusals, the assign refusals, and the
 * pure models the Technicians control and Change time dialog render. Client-safe.
 */
import { ARRIVAL_WINDOWS, type ArrivalWindow } from "./arrival-window";
import { arrivalWindowUtcForBusinessDate, businessIsoDate, windowRowOfInstant } from "./calendar-time";
import { MAX_TECHNICIANS_PER_VISIT, type AppointmentRecord } from "./appointment-types";
import { bandEnded } from "./board-move";
import { FIELDPULSE_SHEET_CREW, FIELDPULSE_SHEET_STARTED, FIELDPULSE_SHEET_TECH, SHEET_STARTED_NATIVE } from "./dispatch-copy";
import type { TechnicianRecord } from "./types";

export const CREW_CAP_LINE = `A visit can have up to ${MAX_TECHNICIANS_PER_VISIT} technicians.`;
export const CREW_NO_LEAD_LINE = "Assign a technician to this request first.";
export const CREW_HCP_LINE = "Helpers aren’t available for Housecall Pro requests.";
export const CREW_GENERIC = "Couldn’t change the technicians. Please try again.";
export const CREW_ADD_LABEL = "Add technician";

export type RequestKind = "native" | "fieldpulse" | "housecall";

export function requestKindOf(syncedSource: "fieldpulse" | "housecall" | null | undefined): RequestKind {
  return syncedSource ?? "native";
}

/** The visit dialogs' one copy map (Add visit, Cancel visit, Change time). TIME_OFF goes through visitErrorCopy. */
export const VISIT_ERROR_COPY: Readonly<Record<string, string>> = {
  VERSION_CONFLICT: "This visit changed. It has been refreshed.",
  REQUEST_CANCELLED: "This request is cancelled.",
  VISIT_CANCELLED: "This visit is already cancelled.",
  IS_FIRST_VISIT: "The first visit follows the request. Change the request instead.",
  TECHNICIAN_NOT_FOUND: "A technician on this visit isn’t active any more. Cancel it and add a new visit instead.",
  HAS_PROGRESS: "Work has started on this visit, so its time can’t change. Cancel it and add a new visit instead.",
  REQUEST_COMPLETED: "This request is already completed.",
  VISIT_ENDED: "This visit has ended. Add a new visit instead.",
  WINDOW_ENDED: "That arrival window has already ended. Pick a later one.",
};
export const VISIT_GENERIC_ERROR = "Couldn’t save the visit. Please try again.";

/** `technicianNames`: the technicians the write sent (updateAppointment doesn't say who is off). */
export function visitErrorCopy(code: string | undefined, technicianNames: readonly string[]): string {
  if (code === "TIME_OFF") {
    return technicianNames.length === 1
      ? `${technicianNames[0]} is off during this time.`
      : "A technician on this visit is off during this time.";
  }
  return (code && VISIT_ERROR_COPY[code]) || VISIT_GENERIC_ERROR;
}

/** The Technicians control's refusals (spec §8 "Sheet crew"). */
export function sheetCrewError(code: string | undefined, name: string | null, kind: RequestKind): string {
  const who = name ?? "That technician";
  switch (code) {
    case "ALREADY_ASSIGNED": return `${who} is already on this visit.`;
    case "HAS_PROGRESS": return `${who} has started, so they stay on this visit.`;
    case "TIME_OFF": return `${who} is off during this visit.`;
    case "VISIT_ENDED": return "This visit has ended.";
    case "NO_LEAD": return CREW_NO_LEAD_LINE;
    case "VISIT_FULL": return `This visit already has ${MAX_TECHNICIANS_PER_VISIT} technicians.`;
    case "MANAGED_EXTERNALLY": return kind === "housecall" ? CREW_HCP_LINE : FIELDPULSE_SHEET_CREW;
    default: return CREW_GENERIC;
  }
}

/** The sheet's Assign/Reassign refusals (spec §5.5, §8). null → the route's own human message. */
export function sheetAssignError(code: string | undefined, name: string | null, fieldpulse: boolean): string | null {
  switch (code) {
    case "MANAGED_EXTERNALLY": return FIELDPULSE_SHEET_TECH;
    case "HAS_PROGRESS": return fieldpulse ? FIELDPULSE_SHEET_STARTED : SHEET_STARTED_NATIVE;
    case "TECHNICIAN_DONE": return `${name ?? "That technician"} has finished on this visit.`;
    default: return null;
  }
}

export interface CrewMemberRow {
  readonly technicianId: string;
  readonly name: string;
  readonly isLead: boolean;
  /** × shows only on a helper that hasn't started (spec §7.7). */
  readonly removable: boolean;
}

export type CrewControlModel =
  | { readonly mode: "line"; readonly line: string }
  | {
      readonly mode: "edit";
      readonly members: readonly CrewMemberRow[];
      readonly addOptions: readonly { readonly value: string; readonly label: string }[];
      /** At the cap: the add select is disabled with CREW_CAP_LINE. */
      readonly full: boolean;
    };

/** What the Technicians control shows on one live visit. */
export function crewControlModel(visit: AppointmentRecord, technicians: readonly TechnicianRecord[], kind: RequestKind): CrewControlModel {
  if (kind === "fieldpulse") return { mode: "line", line: FIELDPULSE_SHEET_CREW };
  if (kind === "housecall") return { mode: "line", line: CREW_HCP_LINE };
  const live = visit.assignments.filter((a) => a.status !== "cancelled");
  if (!live.some((a) => a.isLead)) return { mode: "line", line: CREW_NO_LEAD_LINE };
  const ordered = [...live.filter((a) => a.isLead), ...live.filter((a) => !a.isLead)];
  const onVisit = new Set(live.map((a) => a.technicianId));
  return {
    mode: "edit",
    members: ordered.map((a) => ({ technicianId: a.technicianId, name: a.technicianName, isLead: a.isLead, removable: !a.isLead && a.started !== true })),
    addOptions: technicians.filter((t) => t.isActive && !onVisit.has(t.id)).map((t) => ({ value: t.id, label: t.name })),
    full: live.length >= MAX_TECHNICIANS_PER_VISIT,
  };
}

/** Change time offers the four named windows. */
export const CHANGE_TIME_WINDOWS: readonly ArrivalWindow[] = ARRIVAL_WINDOWS;

export function changeTimeDefaults(visit: AppointmentRecord, today: string): { readonly day: string; readonly window: ArrivalWindow } {
  if (!visit.arrivalWindowStart) return { day: today, window: "morning" };
  const start = new Date(visit.arrivalWindowStart);
  return { day: businessIsoDate(start), window: windowRowOfInstant(start) ?? "morning" };
}

/** Today's timestamp rule (updateAppointment's gate, unchanged): any row with progress blocks Change time. */
export function changeTimeBlocked(visit: AppointmentRecord): boolean {
  return visit.assignments.some((a) => a.hasProgress === true);
}

export interface ChangeTimeBody {
  readonly version: number;
  readonly arrivalWindowStart: string;
  readonly arrivalWindowEnd: string;
  readonly technicianIds: readonly string[];
  readonly specialInstructions?: string;
}

/** PATCH …/appointments/[aid] body, or null while nothing changes, the band has ended, or nobody is on the visit. */
export function changeTimeBody(visit: AppointmentRecord, day: string, window: ArrivalWindow, now: Date): ChangeTimeBody | null {
  const live = visit.assignments.filter((a) => a.status !== "cancelled");
  if (live.length === 0 || bandEnded(day, window, now)) return null;
  const { start, end } = arrivalWindowUtcForBusinessDate(day, window);
  if (visit.arrivalWindowStart && visit.arrivalWindowEnd
    && Date.parse(visit.arrivalWindowStart) === start.getTime() && Date.parse(visit.arrivalWindowEnd) === end.getTime()) {
    return null;
  }
  const ids = [...live.filter((a) => a.isLead), ...live.filter((a) => !a.isLead)].map((a) => a.technicianId);
  return {
    version: visit.version,
    arrivalWindowStart: start.toISOString(),
    arrivalWindowEnd: end.toISOString(),
    technicianIds: ids,
    // updateAppointment writes `specialInstructions ?? null`: send it back so a time change keeps it.
    ...(visit.specialInstructions ? { specialInstructions: visit.specialInstructions } : {}),
  };
}
```

`src/lib/admin/mass-dialog-state.ts`:

```ts
/**
 * Move this day… dialog state (M2 spec §7.6), pure: the form, the preview rows,
 * the commit body, the result lines and the Idempotency-Key rule. Client-safe;
 * the server types are type-only imports.
 */
import { firstName, dayLabel, rangeLabel, massReasonLabel, massResultHeadline, MASS_COPY } from "./dispatch-copy";
import { massChanges, massDefaultDay } from "./mass-reschedule-model";
import type { MassCandidate, MassPreSkipReason, MassResult } from "./board-types";
import type { MassCommitBody, MassQuery } from "./mass-reschedule";

/** Spec §5.6: 1–30 visits per run. */
export const MASS_MAX_VISITS = 30;

export interface MassForm {
  readonly toDate: string;
  /** "" = Same technician. */
  readonly toTechnicianId: string;
  /** The dispatcher changed To day themselves. */
  readonly dayTouched: boolean;
  readonly confirmConflict: boolean;
}

export function massInitialForm(fromDate: string): MassForm {
  return { toDate: massDefaultDay(fromDate), toTechnicianId: "", dayTouched: false, confirmConflict: false };
}

/** Picking a technician sets To day to the same day, only if the dispatcher hasn't changed the day. */
export function massPickTechnician(form: MassForm, fromDate: string, technicianId: string): MassForm {
  if (form.dayTouched) return { ...form, toTechnicianId: technicianId };
  return { ...form, toTechnicianId: technicianId, toDate: technicianId ? fromDate : massDefaultDay(fromDate) };
}

export function massPickDay(form: MassForm, day: string): MassForm {
  return { ...form, toDate: day, dayTouched: true };
}

export function massQuery(technicianId: string, fromDate: string, form: MassForm): MassQuery {
  return { technicianId, fromDate, toDate: form.toDate, ...(form.toTechnicianId ? { toTechnicianId: form.toTechnicianId } : {}) };
}

export function massDateBounds(today: string): { readonly min: string; readonly max: string } {
  const d = new Date(`${today}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + 365);
  return { min: today, max: d.toISOString().slice(0, 10) };
}

export interface MassRow {
  readonly visitId: string;
  /** "9 AM–11 AM · <customer> · <ref>" */
  readonly label: string;
  /** "Moves" or the reason. */
  readonly status: string;
  readonly moves: boolean;
}

const rowLabel = (c: MassCandidate) =>
  `${rangeLabel(c.arrivalWindowStart, c.arrivalWindowEnd)} · ${c.customerName ?? "Unknown customer"} · ${c.referenceNumber}`;

const moves = (c: MassCandidate, form: MassForm) => c.outcome === "moves" && (!c.conflict || form.confirmConflict);

export function massRows(candidates: readonly MassCandidate[], form: MassForm, ctx: { readonly toFirstName: string | null }): MassRow[] {
  return candidates.map((c) => ({
    visitId: c.visitId,
    label: rowLabel(c),
    moves: moves(c, form),
    status: moves(c, form)
      ? MASS_COPY.moves
      : c.outcome === "moves"
        ? massReasonLabel("conflict", {})
        : massReasonLabel(c.outcome, { visitNumber: c.visitNumber, toFirstName: ctx.toFirstName ?? undefined, leadFirstName: c.leadFirstName ?? undefined }),
  }));
}

export function massMoveCount(candidates: readonly MassCandidate[], form: MassForm): number {
  return candidates.filter((c) => moves(c, form)).length;
}

export function massHasConflict(candidates: readonly MassCandidate[]): boolean {
  return candidates.some((c) => c.outcome === "moves" && c.conflict);
}

export function massCanCommit(technicianId: string, fromDate: string, form: MassForm, candidates: readonly MassCandidate[]): boolean {
  const n = massMoveCount(candidates, form);
  return massChanges({ fromDate, toDate: form.toDate, technicianId, toTechnicianId: form.toTechnicianId || null }) && n > 0 && n <= MASS_MAX_VISITS;
}

export function massCommitBody(technicianId: string, fromDate: string, form: MassForm, candidates: readonly MassCandidate[]): MassCommitBody {
  const visits = candidates.filter((c) => moves(c, form)).map((c) => ({ visitId: c.visitId, expectedVersion: c.expectedVersion }));
  const preSkipped = candidates
    .filter((c) => !moves(c, form))
    .map((c) => ({ visitId: c.visitId, reason: (c.outcome === "moves" ? "conflict" : c.outcome) as MassPreSkipReason }));
  return { ...massQuery(technicianId, fromDate, form), visits, preSkipped, confirmConflict: form.confirmConflict };
}

export function massResultLines(
  result: MassResult,
  candidates: readonly MassCandidate[],
  ctx: { readonly fromName: string; readonly toName: string | null; readonly fromDate: string; readonly toDate: string },
): { readonly headline: string; readonly stayed: readonly string[]; readonly notSent: readonly string[] } {
  const byVisit = new Map(candidates.map((c) => [c.visitId, c]));
  const byRequest = new Map(candidates.map((c) => [c.requestId, c]));
  const toFirst = ctx.toName ? firstName(ctx.toName) : null;
  return {
    headline: massResultHeadline(result.moved.length, firstName(ctx.fromName), toFirst, ctx.toDate !== ctx.fromDate ? dayLabel(ctx.toDate) : null),
    stayed: result.skipped.flatMap((s) => {
      const c = byVisit.get(s.visitId);
      if (!c) return [];
      return [`${rowLabel(c)} · ${massReasonLabel(s.reason, { visitNumber: c.visitNumber, toFirstName: toFirst ?? undefined, leadFirstName: c.leadFirstName ?? undefined })}`];
    }),
    notSent: result.pushesNotSent.flatMap((rid) => {
      const c = byRequest.get(rid);
      return c ? [`${rowLabel(c)} · ${MASS_COPY.pushesNotSent}`] : [];
    }),
  };
}

/** One Idempotency-Key per commit body; the same key only for a retry of that exact body (spec §4.2). */
export function nextCommitKey(
  prev: { readonly body: string; readonly key: string } | null,
  body: string,
  mint: () => string,
): { readonly body: string; readonly key: string } {
  return prev && prev.body === body ? prev : { body, key: mint() };
}
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `npx vitest run src/lib/admin/sheet-visit-copy.test.ts src/lib/admin/mass-dialog-state.test.ts`
Expected: PASS.

- [ ] **Step 5: The mass hook** — `src/hooks/use-mass-reschedule.ts`:

```ts
'use client';

import { useCallback, useRef, useState } from 'react';
import { canonicalJsonClient } from '@/lib/admin/mass-dialog-key';
import { nextCommitKey } from '@/lib/admin/mass-dialog-state';
import { MASS_COPY } from '@/lib/admin/dispatch-copy';
import type { MassCandidate, MassResult } from '@/lib/admin/board-types';
import type { MassCommitBody, MassQuery } from '@/lib/admin/mass-reschedule';

export type PreviewOutcome = { readonly status: 'ok'; readonly candidates: readonly MassCandidate[] } | { readonly status: 'error' };
export type CommitOutcome = { readonly status: 'ok'; readonly result: MassResult } | { readonly status: 'error'; readonly message: string };

/**
 * Network calls for Move this day…. The commit mints one Idempotency-Key per
 * body and reuses it only when the SAME body is re-sent after a network failure
 * or a 409 IN_PROGRESS (the server may have the first attempt); any other
 * answer forgets the key.
 */
export function useMassReschedule() {
  const keyRef = useRef<{ body: string; key: string } | null>(null);
  const [committing, setCommitting] = useState(false);

  const preview = useCallback(async (q: MassQuery): Promise<PreviewOutcome> => {
    try {
      const res = await fetch('/api/admin/dispatch/mass-reschedule/preview', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(q),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok || !body?.success) return { status: 'error' };
      return { status: 'ok', candidates: body.data.candidates as MassCandidate[] };
    } catch {
      return { status: 'error' };
    }
  }, []);

  const commit = useCallback(async (payload: MassCommitBody): Promise<CommitOutcome> => {
    const text = canonicalJsonClient(payload);
    keyRef.current = nextCommitKey(keyRef.current, text, () => crypto.randomUUID());
    setCommitting(true);
    try {
      const res = await fetch('/api/admin/dispatch/mass-reschedule', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': keyRef.current.key },
        body: text,
      });
      const body = await res.json().catch(() => null);
      if (res.status === 409 && body?.error?.code === 'IN_PROGRESS') return { status: 'error', message: MASS_COPY.commitFailed };
      keyRef.current = null;
      if (res.ok && body?.success) return { status: 'ok', result: body.data as MassResult };
      if (res.status === 422) return { status: 'error', message: MASS_COPY.keyReused };
      return { status: 'error', message: MASS_COPY.commitFailed };
    } catch {
      // Network failure: keep the key, so a retry of this body replays instead of moving twice.
      return { status: 'error', message: MASS_COPY.commitFailed };
    } finally {
      setCommitting(false);
    }
  }, []);

  return { preview, commit, committing };
}
```

The canonical JSON must be computed without `node:crypto` (the server's `canonicalJson` lives in `src/lib/http/idempotency.ts`, which imports `node:crypto`, `@/lib/db` and `next/server` — not client-safe). The client copy — `src/lib/admin/mass-dialog-key.ts`:

```ts
/** Client copy of idempotency.ts `canonicalJson`: keys sorted recursively, undefined dropped. Pure. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((v) => (v === undefined ? null : canonical(v)));
  if (value !== null && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    return Object.fromEntries(Object.keys(obj).sort().filter((k) => obj[k] !== undefined).map((k) => [k, canonical(obj[k])]));
  }
  return value;
}

export function canonicalJsonClient(value: unknown): string {
  return JSON.stringify(canonical(value ?? {}));
}
```

and its test, pinned against the server's own function — `src/lib/admin/mass-dialog-key.test.ts`:

```ts
import { describe, it, expect, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ db: {} }));

import { canonicalJsonClient } from "./mass-dialog-key";
import { canonicalJson } from "@/lib/http/idempotency";

describe("canonicalJsonClient", () => {
  it("matches the server's canonicalJson, so a retried body hashes the same", () => {
    const body = { visits: [{ visitId: "v1", expectedVersion: 2 }], technicianId: "t", toTechnicianId: undefined, confirmConflict: false };
    expect(canonicalJsonClient(body)).toBe(canonicalJson(body));
    expect(canonicalJsonClient({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });
});
```

Run: `npx vitest run src/lib/admin/mass-dialog-key.test.ts` → PASS.

- [ ] **Step 6: The lane menu** — `src/components/admin/calendar/lane-menu.tsx`:

```tsx
'use client';

import { MoreHorizontal } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger } from '@/components/ui/dropdown-menu';
import { MASS_COPY } from '@/lib/admin/dispatch-copy';

/** ⋯ on a technician lane header (not Unassigned): Move this day…. Shown also when the board isn't interactive (spec §7.6). */
export function LaneMenu({ technicianName, onMoveDay }: { readonly technicianName: string; readonly onMoveDay: () => void }) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={<Button variant="ghost" size="icon-xs" aria-label={`More for ${technicianName}`} className="shrink-0" />}
      >
        <MoreHorizontal className="size-3.5" />
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={onMoveDay}>{MASS_COPY.menuItem}</DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
```

(If `DropdownMenuContent` doesn't accept `align`, drop the prop: `grep -n "align" src/components/ui/dropdown-menu.tsx` first.)

- [ ] **Step 7: The mass dialog** — `src/components/admin/calendar/mass-move-dialog.tsx`:

```tsx
'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { selectLabel } from '@/lib/admin/select-label';
import { dayLabel, firstName, massDialogTitle, massMoveButton, MASS_COPY } from '@/lib/admin/dispatch-copy';
import {
  massCanCommit, massCommitBody, massDateBounds, massHasConflict, massInitialForm, massMoveCount, massPickDay,
  massPickTechnician, massQuery, massResultLines, massRows, type MassForm,
} from '@/lib/admin/mass-dialog-state';
import { useMassReschedule } from '@/hooks/use-mass-reschedule';
import type { MassCandidate, MassResult } from '@/lib/admin/board-types';

const SAME = '__same__';

type PreviewState =
  | { readonly kind: 'loading' }
  | { readonly kind: 'error' }
  | { readonly kind: 'ready'; readonly candidates: readonly MassCandidate[] };

export interface MassMoveDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly technicianId: string;
  readonly technicianName: string;
  /** The board's day (business ISO). */
  readonly fromDate: string;
  readonly today: string;
  readonly technicians: readonly { readonly technicianId: string; readonly technicianName: string }[];
  /** Refetch the board after a commit (the page's refetch). */
  readonly onMoved: () => Promise<void> | void;
}

/** "Move <name>'s requests on <day>" (spec §7.6). Keyed by the caller per open, so state starts fresh. */
export function MassMoveDialog(p: MassMoveDialogProps) {
  const { preview, commit, committing } = useMassReschedule();
  const [form, setForm] = useState<MassForm>(() => massInitialForm(p.fromDate));
  const [state, setState] = useState<PreviewState>({ kind: 'loading' });
  const [showSkeleton, setShowSkeleton] = useState(false);
  const [reload, setReload] = useState(0);
  const [result, setResult] = useState<MassResult | null>(null);
  const [error, setError] = useState<string | null>(null);
  const seq = useRef(0);
  const bounds = massDateBounds(p.today);
  const query = useMemo(() => massQuery(p.technicianId, p.fromDate, form), [p.technicianId, p.fromDate, form]);

  // Latest-wins preview; the skeleton shows only after 300 ms so a fast preview doesn't flash.
  useEffect(() => {
    if (!p.open || result) return;
    const mine = ++seq.current;
    setState({ kind: 'loading' });
    setShowSkeleton(false);
    const timer = setTimeout(() => { if (seq.current === mine) setShowSkeleton(true); }, 300);
    void preview(query).then((out) => {
      if (seq.current !== mine) return;
      clearTimeout(timer);
      setState(out.status === 'ok' ? { kind: 'ready', candidates: out.candidates } : { kind: 'error' });
    });
    return () => clearTimeout(timer);
  }, [p.open, query.toDate, query.toTechnicianId, reload, result]); // eslint-disable-line react-hooks/exhaustive-deps

  const candidates = state.kind === 'ready' ? state.candidates : [];
  const toName = form.toTechnicianId ? (p.technicians.find((t) => t.technicianId === form.toTechnicianId)?.technicianName ?? null) : null;
  const rows = massRows(candidates, form, { toFirstName: toName ? firstName(toName) : null });
  const count = massMoveCount(candidates, form);
  const canCommit = state.kind === 'ready' && massCanCommit(p.technicianId, p.fromDate, form, candidates) && !committing;
  const techOptions = [
    { value: SAME, label: MASS_COPY.sameTechnician },
    ...p.technicians.filter((t) => t.technicianId !== p.technicianId).map((t) => ({ value: t.technicianId, label: t.technicianName })),
  ];

  async function onCommit(): Promise<void> {
    setError(null);
    const out = await commit(massCommitBody(p.technicianId, p.fromDate, form, candidates));
    if (out.status === 'error') {
      setError(out.message);
      return;
    }
    setResult(out.result);
    void p.onMoved();
  }

  const lines = result
    ? massResultLines(result, candidates, { fromName: p.technicianName, toName, fromDate: p.fromDate, toDate: form.toDate })
    : null;

  return (
    <Dialog open={p.open} onOpenChange={(o) => { if (!committing) p.onOpenChange(o); }}>
      <DialogContent className="max-h-[90vh] min-w-0 overflow-y-auto sm:max-w-xl">
        <DialogHeader>
          <DialogTitle>{massDialogTitle(p.technicianName, dayLabel(p.fromDate))}</DialogTitle>
          <DialogDescription className="sr-only">Pick a day and a technician, check the preview, then move.</DialogDescription>
        </DialogHeader>

        {lines ? (
          <div className="space-y-3 text-sm" role="status">
            <p className="font-medium">{lines.headline}</p>
            {lines.stayed.length > 0 && (
              <ul className="space-y-1 text-muted-foreground">
                {lines.stayed.map((l) => <li key={l}>{l}</li>)}
              </ul>
            )}
            {lines.notSent.length > 0 && (
              <ul className="space-y-1 text-warning-strong">
                {lines.notSent.map((l) => <li key={l}>{l}</li>)}
              </ul>
            )}
          </div>
        ) : (
          <div className="min-w-0 space-y-3">
            <div className="grid gap-3 sm:grid-cols-2">
              <label className="space-y-1 text-sm font-medium">
                <span>To day</span>
                <Input
                  type="date"
                  min={bounds.min}
                  max={bounds.max}
                  value={form.toDate}
                  onChange={(e) => { if (e.target.value) setForm((f) => massPickDay(f, e.target.value)); }}
                />
              </label>
              <div className="space-y-1 text-sm font-medium">
                <span id="mass-to-tech">To technician</span>
                <Select
                  value={form.toTechnicianId || SAME}
                  onValueChange={(v) => setForm((f) => massPickTechnician(f, p.fromDate, v === SAME || !v ? '' : String(v)))}
                >
                  <SelectTrigger aria-labelledby="mass-to-tech" className="w-full">
                    <SelectValue>{(v: unknown) => selectLabel(techOptions, v, MASS_COPY.sameTechnician)}</SelectValue>
                  </SelectTrigger>
                  <SelectContent>
                    {techOptions.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
                  </SelectContent>
                </Select>
              </div>
            </div>

            {state.kind === 'loading' ? (
              showSkeleton ? (
                <div className="space-y-2" aria-label="Loading the preview">
                  <Skeleton className="h-5 w-full" />
                  <Skeleton className="h-5 w-5/6" />
                </div>
              ) : null
            ) : state.kind === 'error' ? (
              <p role="alert" className="text-sm text-destructive">
                {MASS_COPY.previewFailed}{' '}
                <button type="button" className="underline" onClick={() => setReload((n) => n + 1)}>{MASS_COPY.tryAgain}</button>
              </p>
            ) : rows.length === 0 ? (
              <p className="text-sm text-muted-foreground">{MASS_COPY.empty}</p>
            ) : (
              <ul className="divide-y rounded-md border text-sm">
                {rows.map((r) => (
                  <li key={r.visitId} className="flex items-start justify-between gap-3 px-3 py-2">
                    <span className="min-w-0 truncate">{r.label}</span>
                    <span className={r.moves ? 'shrink-0 font-medium' : 'shrink-0 text-muted-foreground'}>{r.status}</span>
                  </li>
                ))}
              </ul>
            )}

            {massHasConflict(candidates) && (
              <label className="flex items-center gap-2 text-sm">
                <input
                  type="checkbox"
                  checked={form.confirmConflict}
                  onChange={(e) => setForm((f) => ({ ...f, confirmConflict: e.target.checked }))}
                />
                {MASS_COPY.overlap}
              </label>
            )}
            {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
          </div>
        )}

        <DialogFooter>
          {lines ? (
            <Button type="button" onClick={() => p.onOpenChange(false)}>Done</Button>
          ) : (
            <>
              <Button type="button" variant="outline" onClick={() => p.onOpenChange(false)} disabled={committing}>Cancel</Button>
              <Button type="button" onClick={() => void onCommit()} disabled={!canCommit}>
                {committing ? 'Moving…' : massMoveButton(count)}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

- [ ] **Step 8: Mount the lane menu and the dialog from the page.** Task 9b's board takes an optional slot prop `laneHeaderExtra?: (lane: CalendarTechnicianLane) => ReactNode` that `DayView` renders inside each TECHNICIAN lane header (never the Unassigned one), in Day view only, whether or not the board is interactive. The page fills it and owns the dialog, so `interactive-scheduling-calendar.tsx` is not edited here. In `src/app/admin/(dashboard)/calendar/page.tsx` (as Task 9b left it):

Add imports after the `MoveBanner` import 9b added:

```tsx
import { LaneMenu } from '@/components/admin/calendar/lane-menu';
import { MassMoveDialog } from '@/components/admin/calendar/mass-move-dialog';
```

After the `closeBanner` callback 9b added, add:

```tsx
  // Move this day… (spec §7.6): which technician's day; `key` remounts the dialog fresh per open.
  const [massTarget, setMassTarget] = useState<{ readonly technicianId: string; readonly technicianName: string; readonly key: number } | null>(null);
```

Replace

```tsx
            onRefetch={refetch}
            onBanner={postBanner}
```

with

```tsx
            onRefetch={refetch}
            onBanner={postBanner}
            laneHeaderExtra={(lane) => (
              <LaneMenu
                technicianName={lane.technicianName}
                onMoveDay={() => setMassTarget({ technicianId: lane.technicianId, technicianName: lane.technicianName, key: Date.now() })}
              />
            )}
```

Replace

```tsx
      <MoveBanner banner={banner} onClose={closeBanner} />
```

with

```tsx
      <MoveBanner banner={banner} onClose={closeBanner} />

      {massTarget && calendar && (
        <MassMoveDialog
          key={massTarget.key}
          open
          onOpenChange={(o) => { if (!o) setMassTarget(null); }}
          technicianId={massTarget.technicianId}
          technicianName={massTarget.technicianName}
          fromDate={calendar.days[0] ?? date}
          today={todayBusiness()}
          technicians={calendar.lanes.map((l) => ({ technicianId: l.technicianId, technicianName: l.technicianName }))}
          onMoved={refetch}
        />
      )}
```

(`todayBusiness`, `date`, `calendar` and `refetch` already exist in the page.)

- [ ] **Step 9: The Technicians control** — `src/components/admin/visit-crew-control.tsx`:

```tsx
'use client';

import { useState } from 'react';
import { X } from 'lucide-react';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { selectLabel } from '@/lib/admin/select-label';
import {
  CREW_ADD_LABEL, CREW_CAP_LINE, crewControlModel, sheetCrewError, type RequestKind,
} from '@/lib/admin/sheet-visit-copy';
import type { AppointmentRecord } from '@/lib/admin/appointment-types';
import type { TechnicianRecord } from '@/lib/admin/types';

/**
 * "Technicians" on one live visit row (spec §7.7): the crew with "Lead", a ×
 * on each helper who hasn't started, and "Add technician". The lead changes
 * with Reassign below, or on the calendar. `onChanged` reloads the visits and
 * the board (the sheet passes a callback that also calls onAssigned).
 */
export function VisitCrewControl({
  requestId, visit, technicians, kind, onChanged,
}: {
  readonly requestId: string;
  readonly visit: AppointmentRecord;
  readonly technicians: readonly TechnicianRecord[];
  readonly kind: RequestKind;
  readonly onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const model = crewControlModel(visit, technicians, kind);
  const base = `/api/admin/requests/${requestId}/appointments/${visit.id}/assignments`;

  async function send(method: 'POST' | 'DELETE', technicianId: string, name: string | null): Promise<void> {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(method === 'POST' ? base : `${base}/${technicianId}`, {
        method,
        headers: { 'Content-Type': 'application/json' },
        ...(method === 'POST' ? { body: JSON.stringify({ technicianId }) } : {}),
      });
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        setError(sheetCrewError(body?.error?.code as string | undefined, name, kind));
        if (res.status === 409) onChanged();
        return;
      }
      onChanged();
    } catch {
      setError(sheetCrewError(undefined, name, kind));
    } finally {
      setBusy(false);
    }
  }

  if (model.mode === 'line') {
    return <p className="mt-1 text-xs text-muted-foreground">{model.line}</p>;
  }

  return (
    <div className="mt-1.5 space-y-1.5">
      <ul className="flex flex-wrap gap-1.5" aria-label={`Technicians on visit #${visit.appointmentNumber}`}>
        {model.members.map((m) => (
          <li key={m.technicianId} className="inline-flex items-center gap-1 rounded-sm border border-border bg-surface-raised px-1.5 py-0.5 text-xs">
            <span>{m.name}</span>
            {m.isLead && <span className="text-muted-foreground">Lead</span>}
            {m.removable && (
              <button
                type="button"
                aria-label={`Remove ${m.name} from this visit`}
                disabled={busy}
                onClick={() => void send('DELETE', m.technicianId, m.name)}
                className="rounded-sm p-0.5 hover:bg-row-hover focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-ring"
              >
                <X className="size-3" />
              </button>
            )}
          </li>
        ))}
      </ul>
      <Select
        value=""
        disabled={busy || model.full || model.addOptions.length === 0}
        onValueChange={(v) => {
          const id = typeof v === 'string' ? v : '';
          if (id) void send('POST', id, model.addOptions.find((o) => o.value === id)?.label ?? null);
        }}
      >
        <SelectTrigger size="sm" className="w-48" aria-label={`${CREW_ADD_LABEL} to visit #${visit.appointmentNumber}`}>
          <SelectValue>{(v: unknown) => selectLabel(model.addOptions, v, CREW_ADD_LABEL)}</SelectValue>
        </SelectTrigger>
        <SelectContent>
          {model.addOptions.map((o) => <SelectItem key={o.value} value={o.value}>{o.label}</SelectItem>)}
        </SelectContent>
      </Select>
      {model.full && <p className="text-xs text-muted-foreground">{CREW_CAP_LINE}</p>}
      {error && <p role="alert" className="text-xs text-destructive">{error}</p>}
    </div>
  );
}
```

(Check `SelectTrigger` takes `size`: `grep -n "function SelectTrigger" -A6 src/components/ui/select.tsx`; if not, drop `size="sm"` and use `className="h-7 w-48 text-xs"`.)

- [ ] **Step 10: Change time** — `src/components/admin/visit-change-time-dialog.tsx`:

```tsx
'use client';

import { useState } from 'react';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from '@/components/ui/select';
import { selectLabel } from '@/lib/admin/select-label';
import { windowOptionLabel } from '@/lib/admin/move-request-client';
import { businessIsoDate } from '@/lib/admin/calendar-time';
import { bandEnded } from '@/lib/admin/board-move';
import {
  CHANGE_TIME_WINDOWS, changeTimeBody, changeTimeDefaults, visitErrorCopy,
} from '@/lib/admin/sheet-visit-copy';
import type { ArrivalWindow } from '@/lib/admin/arrival-window';
import type { AppointmentRecord } from '@/lib/admin/appointment-types';

/** "Change visit #<n>" (spec §7.7): PATCH …/appointments/[aid] through updateAppointment, unchanged. */
export function VisitChangeTimeDialog({
  requestId, visit, open, onOpenChange, onSaved,
}: {
  readonly requestId: string;
  readonly visit: AppointmentRecord;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** Saved, or a 409 (the visit changed): reload visits and the board. */
  readonly onSaved: () => void;
}) {
  const now = new Date();
  const today = businessIsoDate(now);
  const [form, setForm] = useState(() => changeTimeDefaults(visit, today));
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const body = changeTimeBody(visit, form.day, form.window, now);
  const options = CHANGE_TIME_WINDOWS.map((w) => ({
    value: w,
    // Canon time format, as the board's dialogs: "Morning · 8 AM–12 PM" (critic B minor 8).
    label: bandEnded(form.day, w, now) ? `${windowOptionLabel(form.day, w)} · Already ended` : windowOptionLabel(form.day, w),
  }));
  const names = visit.assignments.filter((a) => a.status !== 'cancelled').map((a) => a.technicianName);

  async function save(): Promise<void> {
    if (!body) return;
    setSaving(true);
    setError(null);
    try {
      const res = await fetch(`/api/admin/requests/${requestId}/appointments/${visit.id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      if (!res.ok) {
        const json = await res.json().catch(() => null);
        setError(visitErrorCopy(json?.error?.code as string | undefined, names));
        if (res.status === 409) onSaved();
        return;
      }
      onOpenChange(false);
      onSaved();
    } catch {
      setError(visitErrorCopy(undefined, names));
    } finally {
      setSaving(false);
    }
  }

  return (
    <Dialog open={open} onOpenChange={(o) => { if (!saving) onOpenChange(o); }}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{`Change visit #${visit.appointmentNumber}`}</DialogTitle>
          <DialogDescription className="sr-only">Pick a new day and arrival window for this visit.</DialogDescription>
        </DialogHeader>
        <div className="grid gap-3 sm:grid-cols-2">
          <label className="space-y-1 text-sm font-medium">
            <span>Date</span>
            <Input type="date" min={today} value={form.day} onChange={(e) => { if (e.target.value) setForm((f) => ({ ...f, day: e.target.value })); }} />
          </label>
          <div className="space-y-1 text-sm font-medium">
            <span id={`ct-window-${visit.id}`}>Window</span>
            <Select value={form.window} onValueChange={(v) => { if (typeof v === 'string' && v) setForm((f) => ({ ...f, window: v as ArrivalWindow })); }}>
              <SelectTrigger aria-labelledby={`ct-window-${visit.id}`} className="w-full">
                <SelectValue>{(v: unknown) => selectLabel(options, v, 'Window')}</SelectValue>
              </SelectTrigger>
              <SelectContent>
                {options.map((o) => (
                  <SelectItem key={o.value} value={o.value} disabled={bandEnded(form.day, o.value, now)}>{o.label}</SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
        </div>
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)} disabled={saving}>Cancel</Button>
          <Button type="button" onClick={() => void save()} disabled={!body || saving}>{saving ? 'Saving…' : 'Save'}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
```

(`SelectItem` takes `disabled` as a Base UI item prop; verify with `grep -n "function SelectItem" -A6 src/components/ui/select.tsx`.)

- [ ] **Step 11: Wire the sheet** — `src/components/admin/request-detail-sheet.tsx` (re-read first). Six edits.

(a) Imports: add after the `RequestFormsSection` import

```tsx
import { VisitCrewControl } from '@/components/admin/visit-crew-control';
import { VisitChangeTimeDialog } from '@/components/admin/visit-change-time-dialog';
import {
  VISIT_ERROR_COPY, changeTimeBlocked, requestKindOf, sheetAssignError, visitErrorCopy, type RequestKind,
} from '@/lib/admin/sheet-visit-copy';
import { FIELDPULSE_SHEET_TECH } from '@/lib/admin/dispatch-copy';
```

(b) Replace the local copy map and `visitErrorFrom`:

```tsx
const VISIT_ERROR_COPY: Record<string, string> = {
  VERSION_CONFLICT: 'This visit changed. Reload and try again.',
  REQUEST_CANCELLED: 'This request is cancelled.',
  VISIT_CANCELLED: 'This visit is already cancelled.',
  IS_FIRST_VISIT: 'The first visit follows the request. Change the request instead.',
  TECHNICIAN_NOT_FOUND: 'One or more technicians aren’t active on your team.',
  TIME_OFF: 'One of those technicians is off during this window.',
  HAS_PROGRESS: 'A technician has already started this visit.',
  REQUEST_COMPLETED: 'This request is already completed.',
  VISIT_ENDED: 'This visit has ended. Add a new visit instead.',
  WINDOW_ENDED: 'That arrival window has already ended. Pick a later one.',
};
const VISIT_GENERIC_ERROR = 'Couldn’t save the visit. Try again.';
```

with nothing (the imports replace both), and replace

```tsx
async function visitErrorFrom(res: Response): Promise<string> {
  const body = await res.json().catch(() => null);
  const code = body?.error?.code as string | undefined;
  return (code && VISIT_ERROR_COPY[code]) || VISIT_GENERIC_ERROR;
}
```

with

```tsx
async function visitErrorFrom(res: Response, technicianNames: readonly string[] = []): Promise<string> {
  const body = await res.json().catch(() => null);
  return visitErrorCopy(body?.error?.code as string | undefined, technicianNames);
}
```

(`VISIT_GENERIC_ERROR` is not imported: `visitErrorCopy` applies it.)

In `saveVisit`, pass the picked technicians' names: replace `setAddError(await visitErrorFrom(res));` with

```tsx
        setAddError(await visitErrorFrom(res, techIds.map((id) => technicians.find((t) => t.id === id)?.name ?? '').filter(Boolean)));
```

(c) `VisitsSection` props: add `kind` after `technicians`:

```tsx
  readonly technicians: readonly TechnicianRecord[];
  /** native | fieldpulse | housecall: the crew control's mode. */
  readonly kind: RequestKind;
```

and add `kind,` to its destructuring (after `technicians,`). Add, next to the cancel-target state:

```tsx
  const [changeTarget, setChangeTarget] = useState<AppointmentRecord | null>(null);
```

(d) The visit row: replace

```tsx
                    <p className="text-xs text-muted-foreground">
                      {names || 'No technician'} · {cancelled ? 'Cancelled' : a.isConfirmed ? 'Confirmed' : 'Not confirmed'}
                    </p>
                  </div>
                  {a.appointmentNumber > 1 && !cancelled && (
                    <Button
                      type="button"
                      size="sm"
                      variant="ghost"
                      onClick={() => {
                        setCancelError(null);
                        setCancelTarget(a);
                      }}
                    >
                      Cancel visit
                    </Button>
                  )}
                </li>
```

with

```tsx
                    <p className="text-xs text-muted-foreground">
                      {names || 'No technician'} · {cancelled ? 'Cancelled' : a.isConfirmed ? 'Confirmed' : 'Not confirmed'}
                    </p>
                    {!cancelled && !terminal && (
                      <VisitCrewControl
                        requestId={requestId}
                        visit={a}
                        technicians={technicians}
                        kind={kind}
                        onChanged={() => {
                          void load();
                          onChanged();
                        }}
                      />
                    )}
                    {a.appointmentNumber > 1 && !cancelled && changeTimeBlocked(a) && (
                      <p className="mt-1 text-xs text-muted-foreground">{VISIT_ERROR_COPY.HAS_PROGRESS}</p>
                    )}
                  </div>
                  {a.appointmentNumber > 1 && !cancelled && (
                    <div className="flex shrink-0 flex-col items-end gap-1">
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        disabled={changeTimeBlocked(a)}
                        onClick={() => setChangeTarget(a)}
                      >
                        Change time
                      </Button>
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        onClick={() => {
                          setCancelError(null);
                          setCancelTarget(a);
                        }}
                      >
                        Cancel visit
                      </Button>
                    </div>
                  )}
                </li>
```

(keep `VISIT_ERROR_COPY` in the import for this line). `onChanged` is the sheet's callback, which already calls `refreshDetail()` and `onAssigned()` (spec §7.7: the board refetches).

Before the `<ConfirmDialog` that cancels a visit, add:

```tsx
      {changeTarget && (
        <VisitChangeTimeDialog
          key={changeTarget.id}
          requestId={requestId}
          visit={changeTarget}
          open
          onOpenChange={(o) => { if (!o) setChangeTarget(null); }}
          onSaved={() => {
            void load();
            onChanged();
          }}
        />
      )}
```

(e) Pass `kind` where the sheet renders `VisitsSection`: replace

```tsx
                requestId={detail.id}
                technicians={technicians}
                refreshKey=
```

with

```tsx
                requestId={detail.id}
                technicians={technicians}
                kind={requestKindOf(detail.syncedSource)}
                refreshKey=
```

(f) Assign refusals and the FieldPulse lock. In `handleAssign`, replace

```tsx
        setAssignError(body?.error?.message ?? 'Couldn’t assign the technician. Please try again.');
```

with

```tsx
        const pickedName = technicians.find((t) => t.id === techId)?.name ?? null;
        setAssignError(
          sheetAssignError(body?.error?.code as string | undefined, pickedName, detail?.syncedSource === 'fieldpulse') ??
            body?.error?.message ??
            'Couldn’t assign the technician. Please try again.',
        );
```

In the Assignment section, replace

```tsx
                  <div className="flex items-center gap-2">
                    <Select
                      value={selectedTechId}
                      onValueChange={(value) => setSelectedTechId(value ?? '')}
                    >
```

with

```tsx
                  <div className="flex items-center gap-2">
                    <Select
                      value={selectedTechId}
                      disabled={detail.syncedSource === 'fieldpulse'}
                      onValueChange={(value) => setSelectedTechId(value ?? '')}
                    >
```

and replace

```tsx
                        !selectedTechId ||
                        isAssigning ||
```

with

```tsx
                        !selectedTechId ||
                        isAssigning ||
                        detail.syncedSource === 'fieldpulse' ||
```

and replace

```tsx
                  {assignError && (
                    <p role="alert" className="text-xs text-destructive">{assignError}</p>
                  )}
```

with

```tsx
                  {detail.syncedSource === 'fieldpulse' && (
                    <p className="text-xs text-muted-foreground">{FIELDPULSE_SHEET_TECH}</p>
                  )}
                  {assignError && (
                    <p role="alert" className="text-xs text-destructive">{assignError}</p>
                  )}
```

The suggestion cards' Assign buttons go through `handleAssign` too, so a FieldPulse refusal from them shows the same line. Run `npx tsc --noEmit` → 0.

- [ ] **Step 12: Walk on a throwaway org.** Dev server running (`npm run dev`, background; stop it afterwards). `walk-m2-10.mts` at the repo root:

```ts
import { execFileSync } from "node:child_process";
import { chromium } from "playwright";
import { openBoard } from "./scripts/agent/m2-drag.mts";

const env = { ...process.env, NODE_OPTIONS: "--conditions=react-server" };
const fixture = (...args: string[]) =>
  JSON.parse(execFileSync("npx", ["tsx", "scripts/agent/m2-walk.mts", ...args], { encoding: "utf8", env }).trim().split("\n").pop()!);
const fx = fixture("seed") as { org: string; day: string; techs: Record<string, string>; requests: Record<string, string>; tokens: { admin: string } };
const BASE = "http://localhost:3000";
const OUT = process.env.WALK_OUT ?? "/tmp";
const state = (rid: string) => fixture("state", fx.org, rid) as { assignedTo: string | null };
const fail = (m: string) => { throw new Error(m); };

const browser = await chromium.launch();
try {
  const ctx = await browser.newContext({ viewport: { width: 1440, height: 900 } });
  await ctx.addCookies([{ name: "hvac_admin_session", value: fx.tokens.admin, domain: "localhost", path: "/" }]);
  const page = await ctx.newPage();
  await openBoard(page, BASE, fx.day);
  const helperCopy = page.locator(`[data-request-id="${fx.requests.nineEleven}"][data-lane-role="helper"]`);
  const leadCard = page.locator(`[data-request-id="${fx.requests.nineEleven}"][data-lane-role="lead"]`);

  // 1. Add Sam as helper through the sheet's Technicians control → both lanes, chips.
  await leadCard.click();
  const add = page.getByRole("combobox", { name: "Add technician to visit #1" });
  await add.waitFor({ timeout: 20_000 });
  await add.click();
  const added = page.waitForResponse((r) => r.url().includes("/assignments") && r.request().method() === "POST");
  await page.getByRole("option", { name: "Sam Lee" }).click();
  if ((await added).status() !== 201) fail("helper add was refused");
  await page.screenshot({ path: `${OUT}/walk10-1-sheet-crew.png` });
  await page.keyboard.press("Escape");
  await helperCopy.waitFor({ timeout: 20_000 });
  // Done-when (spec §9 (h)): two chips on the lead card, not only a screenshot.
  const chips = await leadCard.locator('[role="listitem"]').count();
  if (chips !== 2) fail(`expected two crew chips, got ${chips}`);
  await page.screenshot({ path: `${OUT}/walk10-2-both-lanes.png` });

  // 2. Remove Sam → the copy is gone.
  await leadCard.click();
  const removed = page.waitForResponse((r) => r.url().includes("/assignments/") && r.request().method() === "DELETE");
  await page.getByRole("button", { name: "Remove Sam Lee from this visit" }).click();
  if ((await removed).status() !== 200) fail("helper remove was refused");
  await page.keyboard.press("Escape");
  await helperCopy.waitFor({ state: "detached", timeout: 20_000 });

  // 3. Move this day… on Alex → Sam (same day): the en-route row is skipped "Started", FieldPulse "Change it in FieldPulse".
  await page.getByRole("button", { name: "More for Alex Rivera" }).click();
  await page.getByRole("menuitem", { name: "Move this day…" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("combobox").click();
  await page.getByRole("option", { name: "Sam Lee" }).click();
  await dialog.getByText("Started").waitFor({ timeout: 20_000 });
  await dialog.getByText("Change it in FieldPulse").waitFor();
  await page.screenshot({ path: `${OUT}/walk10-3-preview.png` });
  await dialog.getByRole("button", { name: /^Move \d+ requests?$/ }).click();
  await dialog.getByText(/^Moved 2 of Alex’s requests to Sam\.$/).waitFor({ timeout: 20_000 });
  await page.screenshot({ path: `${OUT}/walk10-4-result.png` });
  if (state(fx.requests.afternoon!).assignedTo !== fx.techs.sam) fail("afternoon request did not move to Sam");
  if (state(fx.requests.nineEleven!).assignedTo !== fx.techs.sam) fail("the 9–11 request did not move to Sam");
  if (state(fx.requests.enRoute!).assignedTo !== fx.techs.alex) fail("the started request moved");
  if (state(fx.requests.fieldpulse!).assignedTo !== fx.techs.alex) fail("the FieldPulse request moved");
  console.log("walk 10 ok");
} finally {
  await browser.close();
  fixture("delete", fx.org);
}
```

Run: `WALK_OUT=<session scratchpad> NODE_OPTIONS=--conditions=react-server npx tsx walk-m2-10.mts`
Expected: `walk 10 ok`, then `{"deleted":"<org>"}`. Look at all four screenshots: chips on both lanes in 2; the preview rows read "9 AM–11 AM · Pat Nine · WLK-…  Moves" and the en-route row "Started"; the result line in 4. The fixture's `afternoon` (12 PM–4 PM) touches Sam's 4 PM time off without overlapping it, so it moves. Delete the screenshots and `walk-m2-10.mts` afterwards.

- [ ] **Step 13: Gates and commit**

```bash
rm -f walk-m2-10.mts
npx tsc --noEmit && npx eslint src/lib/admin/sheet-visit-copy.ts src/lib/admin/sheet-visit-copy.test.ts src/lib/admin/mass-dialog-state.ts src/lib/admin/mass-dialog-state.test.ts src/lib/admin/mass-dialog-key.ts src/lib/admin/mass-dialog-key.test.ts src/hooks/use-mass-reschedule.ts src/components/admin/calendar/mass-move-dialog.tsx src/components/admin/calendar/lane-menu.tsx src/components/admin/visit-crew-control.tsx src/components/admin/visit-change-time-dialog.tsx src/components/admin/request-detail-sheet.tsx "src/app/admin/(dashboard)/calendar/page.tsx" && npx vitest run
git add src/lib/admin/sheet-visit-copy.ts src/lib/admin/sheet-visit-copy.test.ts src/lib/admin/mass-dialog-state.ts src/lib/admin/mass-dialog-state.test.ts src/lib/admin/mass-dialog-key.ts src/lib/admin/mass-dialog-key.test.ts src/hooks/use-mass-reschedule.ts src/components/admin/calendar/mass-move-dialog.tsx src/components/admin/calendar/lane-menu.tsx src/components/admin/visit-crew-control.tsx src/components/admin/visit-change-time-dialog.tsx src/components/admin/request-detail-sheet.tsx "src/app/admin/(dashboard)/calendar/page.tsx"
git commit -m "$(cat <<'EOF'
feat(m2): Move this day..., the sheet's crew control and Change time

Lane menu and mass reschedule dialog with preview, skip reasons and a
keyed commit; the request sheet's Visits rows add and remove helpers and
change a later visit's time; assign refusals name FieldPulse, the started
rule and a finished technician; the FieldPulse select is disabled.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01GuWoF63tQU1i7ELqyYU3A6
EOF
)"
```

---
### Task 11a: Integration suite (a)–(p) on the dev DB

**Files:**
- Create: `tests/integration/field-dispatch.test.ts`
- Modify: `vitest.config.ts` (append one line to `INTEGRATION_SUITES`; re-read the file right before the edit)

**Interfaces:**
- Consumes (exact, from the contract and Tasks 1–8): `moveVisit(org, actorUserId, requestId, body, opts?: { now?, hooks?: { afterPreRead? } })` → `MoveResult`; `unscheduleRequest(org, rid, { visitId, expectedVersion })`; `addVisitTechnician` / `removeVisitTechnician` (`@/lib/admin/assignment-queries`); `updateAppointment` (`@/lib/admin/appointment-queries`); `assignTechnician`, `reassignTechnician`, `scheduleRequest`, `getSchedulingCalendar` (`@/lib/admin/queries`); the assign and request PATCH route handlers (driven with a stubbed session); `previewMassReschedule`, `commitMassReschedule` (`@/lib/admin/mass-reschedule`); `registerRequestPushes(org, ids, schedule)` (`@/lib/admin/move-pushes`); `withIdempotency`, `canonicalHash` (`@/lib/http/idempotency`); `findReadableJob` (`@/lib/tech/ownership`); `saveFormDraft` (`@/lib/tech/form-writes`), `createForm` (`@/lib/admin/form-queries`); pure `laneCards` (`@/lib/admin/board-move`), `SHEET_STARTED_NATIVE`, `FIELDPULSE_SHEET_STARTED` (`@/lib/admin/dispatch-copy`); `MoveBody`, `MassResult` (`@/lib/admin/board-types`).
- Produces: the suite. No production code changes.

Design notes (binding for this file):
- Three throwaway orgs via `createOrgCore`: `org` (the cases), `org2` (tenancy), `orgF` (FieldPulse-connected by a DUMMY encrypted key; every FieldPulse module the move path could reach is mocked so a call fails the test loudly). The default org is never read or written. `afterAll` deletes all three even on failure.
- Every technician gets all-week, all-day availability, so no move is refused as out of hours, and every `it` books its own business day (`nextDay()`), so one case's requests never overlap another's (the overlap twin would otherwise answer `SCHEDULE_CONFLICT`).
- Technician taps are simulated by SQL in ONE `db.batch` (`tap()`): the row's status and stamp, the request's status for a lead tap (the trigger mirrors it and bumps visit #1's version, exactly like the tech writer), an open job time entry on arrival. Fixture UPDATEs are by id AND `organization_id`. No customer has a phone, nothing is queued.
- Pushes are mocked (`pushJobToHcp`, `syncRequestToCalendar`, `getHousecallConfig`); `registerRequestPushes` and `commitMassReschedule` get a collecting `schedule`, and the test runs what was collected.

- [ ] **Step 1: Write the suite** — `tests/integration/field-dispatch.test.ts`:

```ts
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { arrivalWindowUtcForBusinessDate, businessIsoDate, businessWallClockToUtc } from "@/lib/admin/calendar-time";
import { laneCards } from "@/lib/admin/board-move";
import { FIELDPULSE_SHEET_STARTED, FIELDPULSE_SHEET_TECH, SHEET_STARTED_NATIVE } from "@/lib/admin/dispatch-copy";
import type { MassResult, MoveBody } from "@/lib/admin/board-types";

vi.mock("server-only", () => ({}));

const h = vi.hoisted(() => ({
  after: [] as Array<() => unknown>,
  hcp: [] as Array<[string, string]>,
  cal: [] as Array<[string, string]>,
  fp: [] as string[],
  hcpConfigured: false,
  /** Replace every function export with a spy that records and throws: M2 must make no FieldPulse call. */
  fpSpies(mod: string, real: Record<string, unknown>): Record<string, unknown> {
    return Object.fromEntries(
      Object.entries(real).map(([k, v]) => [
        k,
        typeof v === "function"
          ? (..._args: unknown[]) => {
              h.fp.push(`${mod}.${k}`);
              throw new Error(`FieldPulse ${mod}.${k} was called`);
            }
          : v,
      ]),
    );
  },
}));

vi.mock("next/server", async (orig) => ({
  ...(await orig<typeof import("next/server")>()),
  after: (cb: () => unknown) => {
    h.after.push(cb);
  },
}));
vi.mock("@/lib/integrations/housecall-pro/job-sync", async (orig) => ({
  ...(await orig<typeof import("@/lib/integrations/housecall-pro/job-sync")>()),
  pushJobToHcp: async (org: string, rid: string) => {
    h.hcp.push([org, rid]);
  },
}));
vi.mock("@/lib/integrations/housecall-pro/config", async (orig) => ({
  ...(await orig<typeof import("@/lib/integrations/housecall-pro/config")>()),
  getHousecallConfig: async () => (h.hcpConfigured ? { apiKey: "dummy-not-a-key", baseUrl: "https://example.invalid" } : null),
}));
vi.mock("@/lib/integrations/google-calendar/sync", async (orig) => ({
  ...(await orig<typeof import("@/lib/integrations/google-calendar/sync")>()),
  syncRequestToCalendar: async (org: string, rid: string) => {
    h.cal.push([org, rid]);
  },
}));
// The sheet routes are driven for real in (e)/(f) (critic A m6): only the session is stubbed.
vi.mock("@/lib/auth/session", () => ({ getAdminSession: vi.fn() }));
vi.mock("@/lib/integrations/fieldpulse/client", async (orig) => h.fpSpies("client", await orig()));
vi.mock("@/lib/integrations/fieldpulse/config", async (orig) => h.fpSpies("config", await orig()));
vi.mock("@/lib/integrations/fieldpulse/job-sync", async (orig) => h.fpSpies("job-sync", await orig()));
vi.mock("@/lib/integrations/fieldpulse/scheduling-source", async (orig) => h.fpSpies("scheduling-source", await orig()));

/**
 * M2 dispatch integration suite (spec §9 (a)–(p), v4.1) against the DEV
 * database (`VITEST_INTEGRATION=1`). Drives the writers exactly as the routes
 * do, never HTTP. Throwaway orgs only (createOrgCore), deleted in afterAll even
 * on failure; never the default org; no FieldPulse call (mocked to throw); no
 * customer phone, so nothing is queued.
 */

type Row = Record<string, unknown>;
type Db = typeof import("@/lib/db");
type Sql = typeof import("drizzle-orm").sql;
type Status = "en_route" | "arrived" | "in_progress" | "on_hold" | "completed";

let db: Db["db"];
let sql: Sql;
let encrypt: typeof import("@/lib/crypto").encrypt;
let mv: typeof import("@/lib/admin/visit-move");
let sq: typeof import("@/lib/admin/scheduling-queries");
let aq: typeof import("@/lib/admin/assignment-queries");
let apq: typeof import("@/lib/admin/appointment-queries");
let q: typeof import("@/lib/admin/queries");
let mass: typeof import("@/lib/admin/mass-reschedule");
let pushesMod: typeof import("@/lib/admin/move-pushes");
let idem: typeof import("@/lib/http/idempotency");
let ownership: typeof import("@/lib/tech/ownership");
let fw: typeof import("@/lib/tech/form-writes");
let fq: typeof import("@/lib/admin/form-queries");

let org = "";
let org2 = "";
let orgF = "";
let admin = "";
let admin2 = "";
let adminF = "";
let alex = "";
let sam = "";
let kim = "";
let lee = "";
let max = "";
let ned = "";
let tech2 = "";
let alexF = "";

const F = { a: "f_aaaaaaaaa1", b: "f_aaaaaaaaa2" } as const;
const CUSTOMER_NAME = "Probe Customer Zed";

// ── days ─────────────────────────────────────────────────────────────────────
function addDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
const DAY0 = addDays(businessIsoDate(new Date()), 7);
let dayIdx = 0;
/** A fresh business day per case: no overlap with another case's requests. */
const nextDay = () => addDays(DAY0, ++dayIdx);
const at = (day: string, hour: number, minute = 0) => businessWallClockToUtc(day, hour, minute).toISOString();
const band = (day: string, w: "morning" | "afternoon" | "evening") => {
  const b = arrivalWindowUtcForBusinessDate(day, w);
  return { start: b.start.toISOString(), end: b.end.toISOString() };
};

// ── fixtures ─────────────────────────────────────────────────────────────────
async function run(statement: ReturnType<Sql>): Promise<Row[]> {
  return (await db.execute(statement)).rows as Row[];
}
const one = async (statement: ReturnType<Sql>): Promise<string> => String((await run(statement))[0]!.id);

async function newTech(inOrg: string, name: string): Promise<string> {
  const id = await one(sql`INSERT INTO users (organization_id,email,name,role,password_hash,is_active)
    VALUES (${inOrg},'tech-'||gen_random_uuid()||'@throwaway.example',${name},'technician','x',true) RETURNING id`);
  await run(sql`INSERT INTO technician_availability (organization_id, technician_id, day_of_week, start_minute, end_minute)
    SELECT ${inOrg}::uuid, ${id}::uuid, d, 0, 1440 FROM generate_series(0, 6) AS d`);
  return id;
}

interface JobOpts {
  readonly day: string;
  readonly lead?: string | null;
  readonly start?: string | null;
  readonly end?: string | null;
  readonly status?: string;
  readonly fieldpulse?: boolean;
  readonly hcp?: boolean;
  readonly inOrg?: string;
}

/** A request by SQL (the trigger makes visit #1 + the lead row). Default: Alex, 9–11, scheduled. */
async function newJob(o: JobOpts): Promise<string> {
  const o2 = o.inOrg ?? org;
  const cust = await one(sql`INSERT INTO customers (organization_id,name_encrypted) VALUES (${o2},${encrypt(CUSTOMER_NAME)}) RETURNING id`);
  const sess = await one(sql`INSERT INTO customer_sessions (organization_id,token) VALUES (${o2},gen_random_uuid()::text) RETURNING id`);
  const start = o.start === undefined ? at(o.day, 9) : o.start;
  const end = o.end === undefined ? at(o.day, 11) : o.end;
  return one(sql`INSERT INTO service_requests (organization_id,session_id,assigned_to,customer_id,issue_type,urgency,description,reference_number,
      scheduled_date,arrival_window_start,arrival_window_end,status,fieldpulse_job_id,hcp_job_id)
    VALUES (${o2},${sess},${o.lead === undefined ? alex : o.lead},${cust},'no_heat','medium','M2 dispatch probe','DSP-'||substr(md5(random()::text),1,8),
      ${start}::timestamptz,${start}::timestamptz,${end}::timestamptz,${o.status ?? "scheduled"}::request_status,
      ${o.fieldpulse ? `fp-probe-${randomUUID().slice(0, 8)}` : null},${o.hcp ? `hcp-probe-${randomUUID().slice(0, 8)}` : null})
    RETURNING id`);
}

async function v1(rid: string, inOrg = org): Promise<{ id: string; version: number } | null> {
  const [r] = await run(sql`SELECT id, version FROM appointments WHERE service_request_id = ${rid} AND organization_id = ${inOrg} AND appointment_number = 1`);
  return r ? { id: String(r.id), version: Number(r.version) } : null;
}

interface AssignmentRow {
  readonly technicianId: string;
  readonly isLead: boolean;
  readonly status: string;
  readonly stamped: boolean;
}
async function rowsOf(aid: string): Promise<AssignmentRow[]> {
  const rows = await run(sql`SELECT technician_id, is_lead, status,
      (en_route_at IS NOT NULL OR arrived_at IS NOT NULL OR started_at IS NOT NULL OR completed_at IS NOT NULL) AS stamped
    FROM appointment_assignments WHERE appointment_id = ${aid} AND organization_id = ${org} ORDER BY is_lead DESC, technician_id`);
  return rows.map((r) => ({ technicianId: String(r.technician_id), isLead: r.is_lead === true, status: String(r.status), stamped: r.stamped === true }));
}
const rowOf = async (aid: string, tech: string) => (await rowsOf(aid)).find((r) => r.technicianId === tech);

async function reqOf(rid: string, inOrg = org) {
  const [r] = await run(sql`SELECT status, assigned_to, arrival_window_start, arrival_window_end, hold_reason, follow_up_date
    FROM service_requests WHERE id = ${rid} AND organization_id = ${inOrg}`);
  const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);
  return {
    status: String(r!.status),
    assignedTo: (r!.assigned_to as string | null) ?? null,
    start: iso(r!.arrival_window_start),
    end: iso(r!.arrival_window_end),
    holdReason: (r!.hold_reason as string | null) ?? null,
    followUpDate: r!.follow_up_date ?? null,
  };
}

/** Add a row on a visit by SQL (fixture for states no office writer makes, e.g. a done helper). */
async function addRow(aid: string, tech: string, status: string, stamp: "en_route_at" | "started_at" | "completed_at" | null = null): Promise<void> {
  const col = stamp ? sql.raw(`, ${stamp}`) : sql``;
  const val = stamp ? sql`, now()` : sql``;
  await run(sql`INSERT INTO appointment_assignments (organization_id, appointment_id, technician_id, is_lead, status${col})
    VALUES (${org}, ${aid}, ${tech}, false, ${status}::request_status${val})`);
}

const STAMP: Record<Status, string> = {
  en_route: "en_route_at", arrived: "arrived_at", in_progress: "started_at", on_hold: "started_at", completed: "completed_at",
};

/**
 * A technician's status tap on visit #1, by SQL in one batch: the row's status
 * and stamp; for the lead (unless `request: false`) the request's status too
 * (the trigger mirrors it and bumps visit #1's version); an open job time
 * entry on arrival.
 */
async function tap(rid: string, tech: string, to: Status, o: { request?: boolean } = {}): Promise<void> {
  const v = (await v1(rid))!;
  const row = (await rowOf(v.id, tech))!;
  const col = sql.raw(STAMP[to]);
  const statements = [
    db.execute(sql`UPDATE appointment_assignments SET status = ${to}::request_status, ${col} = COALESCE(${col}, now())
      WHERE appointment_id = ${v.id} AND technician_id = ${tech} AND organization_id = ${org}`),
  ];
  if (o.request ?? (row.isLead && to !== "completed")) {
    statements.push(db.execute(sql`UPDATE service_requests SET status = ${to}::request_status, updated_at = now() WHERE id = ${rid} AND organization_id = ${org}`));
  }
  if (to === "arrived") {
    statements.push(db.execute(sql`INSERT INTO technician_time_entries (organization_id, service_request_id, technician_id, appointment_id, kind, clock_in_method, clock_in_at)
      VALUES (${org}, ${rid}, ${tech}, ${v.id}, 'job', 'auto', now())
      ON CONFLICT (service_request_id, technician_id) WHERE clock_out_at IS NULL DO NOTHING`));
  }
  await db.batch(statements as never);
}

async function timeOff(tech: string, start: string, end: string, kind = "time_off", removes = true): Promise<void> {
  await run(sql`INSERT INTO technician_shifts (organization_id, technician_id, kind, title, starts_at, ends_at, removes_capacity)
    VALUES (${org}, ${tech}, ${kind}::shift_kind, NULL, ${start}::timestamptz, ${end}::timestamptz, ${removes})`);
}

/** Drive a real sheet route as the org's admin (the session is the only stub). */
async function asAdmin(): Promise<void> {
  const { getAdminSession } = await import("@/lib/auth/session");
  vi.mocked(getAdminSession).mockResolvedValue({ userId: admin, organizationId: org, role: "super_admin", email: "probe@throwaway.example", name: "Probe Owner" } as never);
}
async function sheetReassign(rid: string, technicianId: string): Promise<{ status: number; code: string; message: string }> {
  await asAdmin();
  const { PATCH } = await import("@/app/api/admin/requests/[id]/assign/route");
  const res = await PATCH(new Request("http://t/api", { method: "PATCH", body: JSON.stringify({ technicianId }) }) as never, { params: Promise.resolve({ id: rid }) } as never);
  const json = await res.json();
  return { status: res.status, code: json.error?.code, message: json.error?.message };
}
async function sheetSchedule(rid: string, day: string, window: "morning" | "afternoon" | "evening"): Promise<{ status: number; code: string; message: string }> {
  await asAdmin();
  const { PATCH } = await import("@/app/api/admin/requests/[id]/route");
  const body = { scheduledDate: `${day}T00:00:00.000Z`, arrivalWindow: window };
  const res = await PATCH(new Request("http://t/api", { method: "PATCH", body: JSON.stringify(body) }) as never, { params: Promise.resolve({ id: rid }) } as never);
  const json = await res.json();
  return { status: res.status, code: json.error?.code, message: json.error?.message };
}

/** POST …/move as the route calls it: the card's visit #1 id and version, plus the drop. */
async function move(
  rid: string,
  over: Partial<MoveBody> & { day: string },
  o: { now?: Date; afterPreRead?: () => Promise<void>; inOrg?: string; actor?: string } = {},
) {
  const v = await v1(rid, o.inOrg ?? org);
  const body: MoveBody = {
    visitId: v?.id ?? null,
    expectedVersion: v?.version ?? null,
    band: "morning",
    windowRule: "match",
    confirm: [],
    ...over,
  };
  return mv.moveVisit(o.inOrg ?? org, o.actor ?? admin, rid, body, {
    now: o.now,
    hooks: o.afterPreRead ? { afterPreRead: o.afterPreRead } : undefined,
  });
}
const codeOf = (r: { ok: boolean; code?: string }) => (r.ok ? "ok" : r.code);

async function board(day: string, inOrg = org) {
  return q.getSchedulingCalendar(inOrg, at(day, 0), businessWallClockToUtc(addDays(day, 1), 0, 0).toISOString(), [day]);
}

async function events(rid: string, from: string | null, to: string): Promise<number> {
  const rows = await run(sql`SELECT count(*)::int AS n FROM request_status_events
    WHERE service_request_id = ${rid} AND organization_id = ${org} AND to_status = ${to}::request_status
      AND (${from}::text IS NULL OR from_status = ${from}::request_status)`);
  return Number(rows[0]!.n);
}

async function auditRows(action: string, entityId?: string): Promise<Row[]> {
  return run(sql`SELECT details FROM audit_log WHERE organization_id = ${org} AND action = ${action}
    AND (${entityId ?? null}::uuid IS NULL OR entity_id = ${entityId ?? null}::uuid)`);
}

async function entriesOf(rid: string, tech: string): Promise<Row[]> {
  return run(sql`SELECT appointment_id, clock_out_at FROM technician_time_entries
    WHERE service_request_id = ${rid} AND technician_id = ${tech} AND organization_id = ${org} AND kind = 'job'`);
}

async function newForm(): Promise<string> {
  const r = await fq.createForm(org, admin, randomUUID(), {
    name: `Dispatch checklist ${randomUUID().slice(0, 6)}`, description: null, jobTypeIds: [], required: false,
    fields: [
      { id: F.a, type: "checkbox", label: "Filter changed", required: false },
      { id: F.b, type: "checkbox", label: "Coil cleaned", required: false },
    ],
  });
  if (!r.ok) throw new Error(r.reason);
  return r.id;
}
const draft = (rid: string, aid: string, formId: string, me: string, base: number, changes: Record<string, true | null>) =>
  fw.saveFormDraft({ organizationId: org, requestId: rid, techUserId: me }, {
    formId, appointmentId: aid, formVersion: 1, baseRevision: base, saveId: randomUUID(), changes,
  });

async function runCollected(collected: Array<() => unknown>): Promise<void> {
  for (const fn of collected.splice(0)) await fn();
}

beforeAll(async () => {
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const m = line.match(/^([A-Z_0-9]+)=(.*)$/);
    if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.replace(/^"|"$/g, "");
  }
  const url = process.env.DATABASE_URL ?? "";
  if (!url) throw new Error("DATABASE_URL missing from .env.local");
  if (url.includes("ep-withered-hill")) throw new Error("Refusing to run against the production database");

  ({ sql } = await import("drizzle-orm"));
  ({ db } = await import("@/lib/db"));
  ({ encrypt } = await import("@/lib/crypto"));
  mv = await import("@/lib/admin/visit-move");
  sq = await import("@/lib/admin/scheduling-queries");
  aq = await import("@/lib/admin/assignment-queries");
  apq = await import("@/lib/admin/appointment-queries");
  q = await import("@/lib/admin/queries");
  mass = await import("@/lib/admin/mass-reschedule");
  pushesMod = await import("@/lib/admin/move-pushes");
  idem = await import("@/lib/http/idempotency");
  ownership = await import("@/lib/tech/ownership");
  fw = await import("@/lib/tech/form-writes");
  fq = await import("@/lib/admin/form-queries");
  const { createOrgCore } = await import("@/lib/admin/provisioning");

  const mkOrg = async (label: string) => {
    const out = await createOrgCore({
      name: `Probe Org Field Dispatch ${label} ${randomUUID().slice(0, 8)}`,
      createdBy: null,
      ownerEmail: null,
      ownerUser: { email: `owner-${randomUUID()}@throwaway.example`, name: "Probe Owner", googleId: `probe-${randomUUID()}` },
      skipOrgCountCheck: true,
    });
    if (!out.ok) throw new Error(`createOrgCore failed: ${JSON.stringify(out.error)}`);
    if (out.result.organizationId === "00000000-0000-0000-0000-000000000001") throw new Error("refusing the default org");
    return out.result;
  };
  const a = await mkOrg("A");
  org = a.organizationId;
  admin = a.ownerUserId!;
  const b = await mkOrg("B");
  org2 = b.organizationId;
  admin2 = b.ownerUserId!;
  const f = await mkOrg("F");
  orgF = f.organizationId;
  adminF = f.ownerUserId!;
  // FieldPulse-connected by a DUMMY key: the client and every FieldPulse module are mocked to throw.
  await run(sql`INSERT INTO fieldpulse_connections (organization_id, api_key_encrypted, connected)
    VALUES (${orgF}, ${encrypt("dummy-not-a-key")}, true)`);

  alex = await newTech(org, "Alex Rivera");
  sam = await newTech(org, "Sam Lee");
  kim = await newTech(org, "Kim Park");
  lee = await newTech(org, "Lee Moss");
  max = await newTech(org, "Max Grant");
  ned = await newTech(org, "Ned Shaw");
  tech2 = await newTech(org2, "Other Org Tech");
  alexF = await newTech(orgF, "Alex Fp");
}, 120_000);

afterAll(async () => {
  for (const id of [org, org2, orgF].filter(Boolean)) {
    try {
      await db.execute(sql`DELETE FROM organizations WHERE id = ${id}`);
    } catch (error) {
      console.error(`afterAll: could not delete probe org ${id}`, error);
    }
  }
}, 60_000);

describe("field dispatch (dev DB)", () => {
  it("(a) window: keep onto Sam's morning, afternoon match, pick, keep to another day, an ended band", async () => {
    const d = nextDay();
    const rid = await newJob({ day: d });
    expect(await move(rid, { day: d, band: "morning", windowRule: "keep", technicianId: sam })).toMatchObject({
      ok: true, data: { leadId: sam, arrivalWindowStart: at(d, 9), arrivalWindowEnd: at(d, 11) },
    });
    expect(await move(rid, { day: d, band: "afternoon", windowRule: "match" })).toMatchObject({
      ok: true, data: { arrivalWindowStart: band(d, "afternoon").start, arrivalWindowEnd: band(d, "afternoon").end },
    });
    expect(await move(rid, { day: d, band: "morning", windowRule: "pick", pick: "evening" })).toMatchObject({
      ok: true, data: { arrivalWindowStart: band(d, "evening").start },
    });
    const d1 = addDays(d, 1);
    expect(await move(rid, { day: d1, band: "evening", windowRule: "keep" })).toMatchObject({
      ok: true, data: { arrivalWindowStart: band(d1, "evening").start, arrivalWindowEnd: band(d1, "evening").end },
    });
    const ended = await move(rid, { day: d1, band: "morning", windowRule: "match" }, { now: new Date(at(d1, 13)) });
    expect(ended).toMatchObject({ ok: false, code: "WINDOW_ENDED", status: 400 });
    expect((await reqOf(rid)).start).toBe(band(d1, "evening").start);
  }, 90_000);

  it("(b) done-when: arrived + draft → 409 → Move anyway → handover; Sam edits the draft once on site", async () => {
    const d = nextDay();
    const formId = await newForm();
    const rid = await newJob({ day: d });
    const visit = (await v1(rid))!;
    await tap(rid, alex, "arrived");
    expect(await draft(rid, visit.id, formId, alex, 0, { [F.a]: true })).toMatchObject({ ok: true, revision: 1 });

    const refused = await move(rid, { day: d, windowRule: "keep", technicianId: sam });
    expect(refused).toMatchObject({ ok: false, status: 409, code: "HAS_PROGRESS" });
    if (refused.ok) return;
    expect(refused.details).toEqual({
      needs: ["started"],
      started: [{ technicianId: alex, status: "arrived", hasTimestamp: true, openTimeEntry: true }],
    });
    expect((await reqOf(rid)).assignedTo).toBe(alex); // nothing written

    const done = await move(rid, { day: d, windowRule: "keep", technicianId: sam, confirm: ["started"] });
    expect(done).toMatchObject({ ok: true, data: { requestStatus: "scheduled", leadId: sam, confirmed: ["started"] } });
    expect((await reqOf(rid)).status).toBe("scheduled");
    expect(await rowOf(visit.id, sam)).toEqual({ technicianId: sam, isLead: true, status: "scheduled", stamped: false });
    expect(await rowOf(visit.id, alex)).toEqual({ technicianId: alex, isLead: false, status: "cancelled", stamped: true });
    const alexEntries = await entriesOf(rid, alex);
    expect(alexEntries).toHaveLength(1);
    expect(alexEntries[0]!.clock_out_at).not.toBeNull();
    expect(await auditRows("visit_moved", visit.id)).toHaveLength(1);
    expect(await events(rid, "arrived", "scheduled")).toBe(1);
    expect(await ownership.findReadableJob(org, alex, rid)).not.toBeNull(); // Alex still reads the job

    // Sam's save of Alex's draft before arriving: M3d's on-site gate refuses it.
    expect(await draft(rid, visit.id, formId, sam, 1, { [F.b]: true })).toMatchObject({ ok: false, reason: "not_on_site" });
    await tap(rid, sam, "arrived");
    expect(await draft(rid, visit.id, formId, sam, 1, { [F.b]: true })).toMatchObject({ ok: true, revision: 2 });
  }, 90_000);

  it("(b2) drag back after Move anyway: no confirm; Alex revived clean, Sam (untouched) deleted", async () => {
    const d = nextDay();
    const rid = await newJob({ day: d });
    const visit = (await v1(rid))!;
    await tap(rid, alex, "arrived");
    expect(codeOf(await move(rid, { day: d, windowRule: "keep", technicianId: sam, confirm: ["started"] }))).toBe("ok");
    const back = await move(rid, { day: d, windowRule: "keep", technicianId: alex });
    expect(back).toMatchObject({ ok: true, data: { leadId: alex, confirmed: [] } });
    expect(await rowsOf(visit.id)).toEqual([{ technicianId: alex, isLead: true, status: "scheduled", stamped: false }]);
  }, 90_000);

  it("(b3) pause: an on_hold request overridden → scheduled, hold fields cleared", async () => {
    const d = nextDay();
    const rid = await newJob({ day: d });
    await tap(rid, alex, "in_progress");
    const visit = (await v1(rid))!;
    await db.batch([
      db.execute(sql`UPDATE appointment_assignments SET status = 'on_hold'::request_status
        WHERE appointment_id = ${visit.id} AND technician_id = ${alex} AND organization_id = ${org}`),
      db.execute(sql`UPDATE service_requests SET status = 'on_hold'::request_status, hold_reason = 'awaiting_parts'::hold_reason,
          follow_up_date = now() + interval '3 days'
        WHERE id = ${rid} AND organization_id = ${org}`),
    ] as never);
    expect(codeOf(await move(rid, { day: d, windowRule: "keep", technicianId: sam }))).toBe("HAS_PROGRESS");
    expect(codeOf(await move(rid, { day: d, windowRule: "keep", technicianId: sam, confirm: ["started"] }))).toBe("ok");
    expect(await reqOf(rid)).toMatchObject({ status: "scheduled", holdReason: null, followUpDate: null, assignedTo: sam });
  }, 90_000);

  it("(b4) the old lead's own time off never blocks a handover", async () => {
    const d = nextDay();
    const rid = await newJob({ day: d });
    await tap(rid, alex, "en_route");
    await timeOff(alex, new Date().toISOString(), at(addDays(d, 2), 0));
    expect(await move(rid, { day: d, windowRule: "keep", technicianId: sam, confirm: ["started"] })).toMatchObject({ ok: true, data: { leadId: sam } });
  }, 90_000);

  it("(c) a done lead, a done helper as new lead (board and sheet), a done tap between pre-read and batch", async () => {
    const d = nextDay();
    // 1. Alex done: a time move asks first; a lead change cancels his kept completed row.
    const r1 = await newJob({ day: d });
    const v1a = (await v1(r1))!;
    await tap(r1, alex, "completed", { request: false });
    expect(codeOf(await move(r1, { day: d, band: "afternoon", windowRule: "match" }))).toBe("HAS_PROGRESS");
    expect(codeOf(await move(r1, { day: d, band: "afternoon", windowRule: "match", confirm: ["started"] }))).toBe("ok");
    expect(codeOf(await move(r1, { day: d, windowRule: "keep", technicianId: sam, confirm: ["started"] }))).toBe("ok");
    expect(await rowOf(v1a.id, alex)).toEqual({ technicianId: alex, isLead: false, status: "cancelled", stamped: true });

    // 2. A done helper as the new lead: board, sheet assign and sheet reassign refuse.
    const r2 = await newJob({ day: d, start: at(d, 17), end: at(d, 19) });
    await addRow((await v1(r2))!.id, kim, "completed", "completed_at");
    const refused = await move(r2, { day: d, windowRule: "keep", technicianId: kim });
    expect(refused).toMatchObject({ ok: false, status: 409, code: "TECHNICIAN_DONE", details: { technicianId: kim } });
    expect(await q.assignTechnician(org, r2, kim, admin)).toMatchObject({ ok: false, reason: "technician_done" });
    expect(await q.reassignTechnician(org, r2, kim, admin)).toMatchObject({ ok: false, reason: "technician_done" });
    expect((await reqOf(r2)).assignedTo).toBe(alex);

    // 3. Sam (helper, working) taps done between the move's pre-read and batch.
    const r3 = await newJob({ day: d, start: at(d, 7), end: at(d, 8) });
    const v3 = (await v1(r3))!;
    await addRow(v3.id, sam, "in_progress", "started_at");
    const raced = await move(r3, { day: d, windowRule: "keep", technicianId: sam }, {
      afterPreRead: async () => {
        await run(sql`UPDATE appointment_assignments SET status = 'completed'::request_status, completed_at = now()
          WHERE appointment_id = ${v3.id} AND technician_id = ${sam} AND organization_id = ${org}`);
      },
    });
    expect(raced).toMatchObject({ ok: false, code: "TECHNICIAN_DONE", details: { technicianId: sam } });
    expect((await reqOf(r3)).assignedTo).toBe(alex);
    expect((await rowOf(v3.id, sam))!.isLead).toBe(false);
  }, 120_000);

  it("(d) helper working, lead untouched: board swap without confirm; sheet reassign 409; time move 409", async () => {
    const d = nextDay();
    const rid = await newJob({ day: d });
    await addRow((await v1(rid))!.id, sam, "in_progress", "started_at");
    expect(await move(rid, { day: d, windowRule: "keep", technicianId: kim })).toMatchObject({ ok: true, data: { leadId: kim, confirmed: [] } });
    expect(await q.reassignTechnician(org, rid, alex, admin)).toMatchObject({ ok: false, reason: "has_progress" });
    expect(codeOf(await move(rid, { day: d, band: "afternoon", windowRule: "match" }))).toBe("HAS_PROGRESS");
  }, 90_000);

  it("(e) office in_progress → board 409, sheet 409 with the Move… copy; A → B → A revives A; the schedule edit keeps today's rule", async () => {
    const d = nextDay();
    const r1 = await newJob({ day: d });
    await run(sql`UPDATE service_requests SET status = 'in_progress'::request_status WHERE id = ${r1} AND organization_id = ${org}`);
    expect(codeOf(await move(r1, { day: d, windowRule: "keep", technicianId: sam }))).toBe("HAS_PROGRESS");
    const sheet = await q.reassignTechnician(org, r1, sam, admin);
    expect(sheet).toMatchObject({ ok: false, reason: "has_progress" });
    // The sheet's own route answers with the Move… copy.
    expect(await sheetReassign(r1, sam)).toEqual({ status: 409, code: "HAS_PROGRESS", message: SHEET_STARTED_NATIVE });
    // Spec §9 (e): the schedule edit on THIS request behaves as today (timestamp rule): a status-only
    // in_progress row has no stamp, so the edit is still allowed while move and reassign refuse.
    const wE = arrivalWindowUtcForBusinessDate(d, "afternoon");
    expect(await q.scheduleRequest(org, r1, wE.start, wE)).toMatchObject({ ok: true });

    // A turned back (timestamp, status scheduled): not started, so the sheet may swap; the schedule edit refuses (timestamp rule, unchanged).
    const r2 = await newJob({ day: d, start: at(d, 13), end: at(d, 15) });
    const v2 = (await v1(r2))!;
    await run(sql`UPDATE appointment_assignments SET en_route_at = now()
      WHERE appointment_id = ${v2.id} AND technician_id = ${alex} AND organization_id = ${org}`);
    const window = arrivalWindowUtcForBusinessDate(d, "evening");
    expect(await q.scheduleRequest(org, r2, window.start, window)).toMatchObject({ ok: false, reason: "has_progress" });
    expect(await q.reassignTechnician(org, r2, sam, admin)).toMatchObject({ ok: true });
    expect(await q.reassignTechnician(org, r2, alex, admin)).toMatchObject({ ok: true });
    const status = (await reqOf(r2)).status;
    expect(await rowOf(v2.id, alex)).toEqual({ technicianId: alex, isLead: true, status, stamped: false });
  }, 90_000);

  it("(f) FieldPulse-mapped: every board and sheet path refuses, nothing written; GET movable no; no FieldPulse call anywhere", async () => {
    const d = nextDay();
    const rid = await newJob({ day: d, fieldpulse: true });
    const before = { req: await reqOf(rid), v: await v1(rid) };
    for (const over of [
      { day: d, band: "afternoon" as const, windowRule: "match" as const },
      { day: addDays(d, 1), band: "morning" as const, windowRule: "keep" as const },
      { day: d, band: "morning" as const, windowRule: "keep" as const, technicianId: sam },
    ]) {
      expect(await move(rid, over)).toMatchObject({ ok: false, status: 409, code: "MANAGED_EXTERNALLY" });
    }
    expect(await sq.unscheduleRequest(org, rid, { visitId: before.v!.id, expectedVersion: before.v!.version })).toEqual({ ok: false, reason: "managed_externally" });
    expect(await q.reassignTechnician(org, rid, sam, admin)).toMatchObject({ ok: false, reason: "managed_externally" });
    expect(await reqOf(rid)).toEqual(before.req);
    expect(await v1(rid)).toEqual(before.v);

    // A FieldPulse in_progress row with no timestamp: sheet refusals name FieldPulse.
    await run(sql`UPDATE service_requests SET status = 'in_progress'::request_status WHERE id = ${rid} AND organization_id = ${org}`);
    expect(await q.reassignTechnician(org, rid, sam, admin)).toMatchObject({ ok: false, reason: "managed_externally" });
    // Through the real routes (critic A m6): the reassign names FieldPulse; a stamped FieldPulse visit makes the
    // schedule edit (timestamp rule, writer unchanged) refuse, and its copy names FieldPulse too. Nothing is pushed:
    // the refusal returns before the route's after().
    expect(await sheetReassign(rid, sam)).toEqual({ status: 409, code: "MANAGED_EXTERNALLY", message: FIELDPULSE_SHEET_TECH });
    await run(sql`UPDATE appointment_assignments SET started_at = now()
      WHERE appointment_id = ${before.v!.id} AND technician_id = ${alex} AND organization_id = ${org}`);
    expect(await sheetSchedule(rid, d, "evening")).toEqual({ status: 409, code: "HAS_PROGRESS", message: FIELDPULSE_SHEET_STARTED });
    expect(h.fp).toEqual([]);

    const card = (await board(d)).lanes.flatMap((l) => l.jobs).find((j) => j.id === rid);
    expect(card).toMatchObject({ movable: "no", fieldpulse: true });

    // A native request in a FieldPulse-connected org moves, with no FieldPulse call.
    await run(sql`INSERT INTO technician_availability (organization_id, technician_id, day_of_week, start_minute, end_minute)
      SELECT ${orgF}::uuid, ${alexF}::uuid, d2, 0, 1440 FROM generate_series(0, 6) AS d2 ON CONFLICT DO NOTHING`);
    const native = await newJob({ day: d, inOrg: orgF, lead: alexF });
    expect(codeOf(await move(native, { day: d, band: "afternoon", windowRule: "match" }, { inOrg: orgF, actor: adminF }))).toBe("ok");
    const collected: Array<() => unknown> = [];
    pushesMod.registerRequestPushes(orgF, [native], (fn) => {
      collected.push(fn);
    });
    await runCollected(collected);
    expect(h.cal).toContainEqual([orgF, native]);
    expect(h.fp).toEqual([]);

    // Housecall Pro: lane and time moves land and push.
    const hcp = await newJob({ day: d, hcp: true, start: at(d, 17), end: at(d, 19) });
    expect(codeOf(await move(hcp, { day: d, windowRule: "keep", technicianId: sam }))).toBe("ok");
    expect(codeOf(await move(hcp, { day: d, band: "afternoon", windowRule: "match" }))).toBe("ok");
    pushesMod.registerRequestPushes(org, [hcp], (fn) => {
      collected.push(fn);
    });
    await runCollected(collected);
    expect(h.hcp).toContainEqual([org, hcp]);
    expect(h.fp).toEqual([]);
  }, 120_000);

  it("(g) races: one version, two moves → one STALE; a lead tap → STALE; a helper tap → HAS_PROGRESS; a helper add → STALE", async () => {
    const d = nextDay();
    const r1 = await newJob({ day: d });
    // One read of the card, two sends of it (critic A m4): both carry the same visit and version.
    const v0 = (await v1(r1))!;
    const from = (b: "afternoon" | "evening"): MoveBody => ({ visitId: v0.id, expectedVersion: v0.version, day: d, band: b, windowRule: "match", confirm: [] });
    const both = await Promise.all([mv.moveVisit(org, admin, r1, from("afternoon")), mv.moveVisit(org, admin, r1, from("evening"))]);
    expect(both.map(codeOf).sort()).toEqual(["STALE", "ok"]);

    const stale = async (rid: string, between: () => Promise<void>, over: Partial<MoveBody> = {}) => {
      const v = (await v1(rid))!;
      await between();
      return mv.moveVisit(org, admin, rid, {
        visitId: v.id, expectedVersion: v.version, day: d, band: "afternoon", windowRule: "match", confirm: [], ...over,
      });
    };
    const r2 = await newJob({ day: d, start: at(d, 7), end: at(d, 8), lead: kim });
    expect(codeOf(await stale(r2, () => tap(r2, kim, "en_route")))).toBe("STALE"); // the trigger bumps #1 on the request status

    const r3 = await newJob({ day: d, start: at(d, 18), end: at(d, 19), lead: lee });
    await addRow((await v1(r3))!.id, max, "assigned");
    expect(codeOf(await stale(r3, () => tap(r3, max, "en_route")))).toBe("HAS_PROGRESS"); // a helper tap bumps nothing

    const r4 = await newJob({ day: d, start: at(d, 19), end: at(d, 20), lead: ned });
    expect(codeOf(await stale(r4, async () => {
      const added = await aq.addVisitTechnician(org, r4, (await v1(r4))!.id, sam, admin);
      expect("reason" in added).toBe(false);
    }))).toBe("STALE");
  }, 120_000);

  it("(g') Unscheduled then re-placed: an old card → STALE; a stale Unscheduled drop → STALE", async () => {
    const d = nextDay();
    const rid = await newJob({ day: d });
    const old = (await v1(rid))!;
    expect(await sq.unscheduleRequest(org, rid, { visitId: old.id, expectedVersion: old.version })).toEqual({ ok: true });
    expect(await v1(rid)).toBeNull(); // untouched #1 is deleted by the trigger
    expect(await move(rid, { day: d, windowRule: "match", technicianId: alex })).toMatchObject({ ok: true, data: { leadId: alex } });
    const oldCard = await mv.moveVisit(org, admin, rid, {
      visitId: old.id, expectedVersion: old.version, day: d, band: "afternoon", windowRule: "match", confirm: [],
    });
    expect(codeOf(oldCard)).toBe("STALE");
    expect(await sq.unscheduleRequest(org, rid, { visitId: old.id, expectedVersion: old.version })).toEqual({ ok: false, reason: "stale" });
  }, 90_000);

  it("(h) done-when: two technicians, both lanes, chips; remove; revive; the cap (also concurrent); NO_LEAD; drop on the helper's lane", async () => {
    const d = nextDay();
    const rid = await newJob({ day: d });
    const visit = (await v1(rid))!;
    expect("reason" in (await aq.addVisitTechnician(org, rid, visit.id, sam, admin))).toBe(false);
    const b = await board(d);
    const lead = b.lanes.find((l) => l.technicianId === alex)!.jobs.find((j) => j.id === rid)!;
    expect(lead.crew?.map((c) => [c.technicianId, c.isLead])).toEqual([[alex, true], [sam, false]]);
    expect(laneCards(b).lanes.find((l) => l.technicianId === sam)!.jobs.map((j) => [j.id, j.laneRole])).toEqual([[rid, "helper"]]);

    expect(await aq.removeVisitTechnician(org, rid, visit.id, sam)).toEqual({ ok: true, cancelled: false });
    expect(await rowOf(visit.id, sam)).toBeUndefined();

    // Added again after a cancel (with old stamps): revived with null timestamps.
    await addRow(visit.id, sam, "cancelled", "en_route_at");
    expect("reason" in (await aq.addVisitTechnician(org, rid, visit.id, sam, admin))).toBe(false);
    expect(await rowOf(visit.id, sam)).toEqual({ technicianId: sam, isLead: false, status: "assigned", stamped: false });

    // The cap: lead + 3 helpers, then a 5th and a 6th at once → exactly one VISIT_FULL.
    expect("reason" in (await aq.addVisitTechnician(org, rid, visit.id, kim, admin))).toBe(false);
    expect("reason" in (await aq.addVisitTechnician(org, rid, visit.id, lee, admin))).toBe(false);
    const race = await Promise.all([
      aq.addVisitTechnician(org, rid, visit.id, max, admin),
      aq.addVisitTechnician(org, rid, visit.id, ned, admin),
    ]);
    expect(race.map((r) => ("reason" in r ? r.reason : "ok")).sort()).toEqual(["ok", "visit_full"]);
    expect((await rowsOf(visit.id)).filter((r) => r.status !== "cancelled")).toHaveLength(5);

    // An unassigned visit: no lead to help.
    const placed = await newJob({ day: d, lead: null, start: at(d, 13), end: at(d, 14) });
    expect(await aq.addVisitTechnician(org, placed, (await v1(placed))!.id, sam, admin)).toEqual({ reason: "no_lead" });
  }, 120_000);

  it("(h) drop the lead card on the helper's lane; a time move with the helper off → TIME_OFF naming Sam", async () => {
    const d = nextDay();
    const r1 = await newJob({ day: d });
    const v = (await v1(r1))!;
    await aq.addVisitTechnician(org, r1, v.id, sam, admin);
    expect(await move(r1, { day: d, windowRule: "keep", technicianId: sam })).toMatchObject({ ok: true, data: { leadId: sam } });
    expect(await rowsOf(v.id)).toEqual([{ technicianId: sam, isLead: true, status: "scheduled", stamped: false }]);

    const r2 = await newJob({ day: d, start: at(d, 13), end: at(d, 15), lead: kim });
    await aq.addVisitTechnician(org, r2, (await v1(r2))!.id, lee, admin);
    await timeOff(lee, at(d, 16), at(d, 20));
    const off = await move(r2, { day: d, band: "evening", windowRule: "match" });
    expect(off).toMatchObject({ ok: false, status: 409, code: "TIME_OFF" });
    if (off.ok) return;
    const details = off.details as { timeOff: Array<{ technicianId: string; kind: string }>; needs?: unknown };
    expect(details.timeOff.map((t) => [t.technicianId, t.kind])).toEqual([[lee, "time_off"]]);
    expect(details.needs).toBeUndefined();
  }, 90_000);

  it("(h2) a helper's time off doesn't block a lead swap that keeps the window", async () => {
    const d = nextDay();
    const rid = await newJob({ day: d });
    await aq.addVisitTechnician(org, rid, (await v1(rid))!.id, sam, admin);
    await timeOff(sam, at(d, 8), at(d, 12));
    expect(await move(rid, { day: d, windowRule: "keep", technicianId: kim })).toMatchObject({ ok: true, data: { leadId: kim } });
  }, 90_000);

  it("(i') a later visit: Change time shows on the board; a timestamped #2 refuses; the card is pinned", async () => {
    const d = nextDay();
    const rid = await newJob({ day: d, start: at(d, 7), end: at(d, 8) });
    await tap(rid, alex, "completed", { request: false }); // #1 has no open row: #2 becomes the displayed visit
    const aid2 = await one(sql`INSERT INTO appointments (organization_id, service_request_id, appointment_number, scheduled_date, starts_at, ends_at, arrival_window_start, arrival_window_end)
      VALUES (${org}, ${rid}, 2, ${at(d, 13)}::timestamptz, ${at(d, 13)}::timestamptz, ${at(d, 15)}::timestamptz, ${at(d, 13)}::timestamptz, ${at(d, 15)}::timestamptz) RETURNING id`);
    await run(sql`INSERT INTO appointment_assignments (organization_id, appointment_id, technician_id, is_lead, status)
      VALUES (${org}, ${aid2}, ${alex}, true, 'assigned'::request_status)`);
    const ver = async () => Number((await run(sql`SELECT version FROM appointments WHERE id = ${aid2} AND organization_id = ${org}`))[0]!.version);

    const changed = await apq.updateAppointment(org, rid, aid2, {
      arrivalWindowStart: at(d, 16), arrivalWindowEnd: at(d, 18), technicianIds: [alex], version: await ver(),
    }, admin);
    expect("reason" in changed).toBe(false);
    const card = (await board(d)).lanes.find((l) => l.technicianId === alex)!.jobs.find((j) => j.id === rid)!;
    expect(card).toMatchObject({ visitNumber: 2, arrivalWindowStart: at(d, 16), movable: "no", visitId: aid2 });

    await run(sql`UPDATE appointment_assignments SET en_route_at = now() WHERE appointment_id = ${aid2} AND organization_id = ${org}`);
    expect(await apq.updateAppointment(org, rid, aid2, {
      arrivalWindowStart: at(d, 17), arrivalWindowEnd: at(d, 19), technicianIds: [alex], version: await ver(),
    }, admin)).toEqual({ reason: "has_progress" });

    const pinned = await mv.moveVisit(org, admin, rid, {
      visitId: aid2, expectedVersion: await ver(), day: d, band: "evening", windowRule: "match", confirm: [],
    });
    expect(pinned).toMatchObject({ ok: false, status: 409, code: "VISIT_PINNED", details: { visitNumber: 2 } });
  }, 90_000);

  it("(j) pending with Alex dropped on Alex → assigned, one event; (j') a first assignment → one assigned event; (j'') an unassigned card's visitId is #1", async () => {
    const d = nextDay();
    const r1 = await newJob({ day: d, status: "pending" });
    expect(await move(r1, { day: d, band: "morning", windowRule: "match", technicianId: alex })).toMatchObject({ ok: true, data: { requestStatus: "assigned" } });
    expect(await events(r1, "pending", "assigned")).toBe(1);

    const r2 = await newJob({ day: d, lead: null, start: at(d, 13), end: at(d, 15) });
    expect(await move(r2, { day: d, windowRule: "keep", technicianId: alex })).toMatchObject({ ok: true, data: { requestStatus: "scheduled", leadId: alex } });
    expect(await events(r2, null, "assigned")).toBe(1);
    expect(await events(r2, "scheduled", "assigned")).toBe(1);

    const r3 = await newJob({ day: d, lead: null, start: at(d, 16), end: at(d, 18) });
    const card = (await board(d)).unassigned.find((j) => j.id === r3)!;
    expect(card.visitId).toBe((await v1(r3))!.id);
    const placed = await mv.moveVisit(org, admin, r3, {
      visitId: card.visitId ?? null, expectedVersion: card.visitVersion ?? null, day: d, band: "evening", windowRule: "keep", technicianId: kim, confirm: [],
    });
    expect(codeOf(placed)).toBe("ok");
  }, 90_000);

  it("(l) blocks: all three kinds in the day GET", async () => {
    const d = nextDay();
    await timeOff(sam, at(d, 8), at(d, 10), "time_off", true);
    await timeOff(sam, at(d, 12), at(d, 13), "non_job", true);
    await timeOff(sam, at(d, 17), at(d, 20), "on_call", false);
    const blocks = (await board(d)).blocks ?? [];
    expect(blocks.filter((b) => b.technicianId === sam).map((b) => [b.kind, b.removesCapacity])).toEqual([
      ["time_off", true], ["non_job", true], ["on_call", false],
    ]);
  }, 60_000);

  it("(m) mass reschedule: reasons, commit, SQL audit, stale inside the batch, replay, crash recovery", async () => {
    const d = nextDay();
    const d2 = nextDay();
    const m1 = await newJob({ day: d, start: at(d, 8), end: at(d, 9), hcp: true });
    const m2 = await newJob({ day: d, start: at(d, 9), end: at(d, 10) });
    const m3 = await newJob({ day: d, start: at(d, 10), end: at(d, 11) });
    const started = await newJob({ day: d, start: at(d, 11), end: at(d, 12) });
    await tap(started, alex, "en_route");
    const fpReq = await newJob({ day: d, start: at(d, 12), end: at(d, 13), fieldpulse: true });
    const helperReq = await newJob({ day: d, start: at(d, 13), end: at(d, 14), lead: sam });
    await aq.addVisitTechnician(org, helperReq, (await v1(helperReq))!.id, alex, admin);
    const laterDay = nextDay();
    const later = await newJob({ day: laterDay, start: at(laterDay, 7), end: at(laterDay, 8) });
    await tap(later, alex, "completed", { request: false });
    const later2 = await one(sql`INSERT INTO appointments (organization_id, service_request_id, appointment_number, scheduled_date, starts_at, ends_at, arrival_window_start, arrival_window_end)
      VALUES (${org}, ${later}, 2, ${at(d, 15)}::timestamptz, ${at(d, 15)}::timestamptz, ${at(d, 16)}::timestamptz, ${at(d, 15)}::timestamptz, ${at(d, 16)}::timestamptz) RETURNING id`);
    await run(sql`INSERT INTO appointment_assignments (organization_id, appointment_id, technician_id, is_lead, status)
      VALUES (${org}, ${later2}, ${alex}, true, 'assigned'::request_status)`);

    const ids = {
      m1: (await v1(m1))!.id, m2: (await v1(m2))!.id, m3: (await v1(m3))!.id,
      started: (await v1(started))!.id, fp: (await v1(fpReq))!.id, helper: (await v1(helperReq))!.id, later: later2,
    };
    const candidates = await mass.previewMassReschedule(org, { technicianId: alex, fromDate: d, toDate: d2 });
    const outcome = new Map(candidates.map((c) => [c.visitId, c.outcome]));
    expect(Object.fromEntries(Object.entries(ids).map(([k, id]) => [k, outcome.get(id)]))).toEqual({
      m1: "moves", m2: "moves", m3: "moves", started: "started", fp: "fieldpulse", helper: "helper", later: "later_visit",
    });

    // m3 changes after the preview: its version gate fails inside the batch → recorded stale.
    await run(sql`UPDATE service_requests SET arrival_window_end = arrival_window_end + interval '30 minutes' WHERE id = ${m3} AND organization_id = ${org}`);
    const moving = candidates.filter((c) => c.outcome === "moves");
    const body = {
      technicianId: alex, fromDate: d, toDate: d2,
      visits: moving.map((c) => ({ visitId: c.visitId, expectedVersion: c.expectedVersion })),
      preSkipped: candidates.filter((c) => c.outcome !== "moves").map((c) => ({ visitId: c.visitId, reason: c.outcome as Exclude<typeof c.outcome, "moves"> })),
      confirmConflict: false,
    };
    const key = randomUUID();
    const scope = { organizationId: org, userId: admin, route: "/api/admin/dispatch/mass-reschedule", key };
    const scheduled: Array<() => unknown> = [];
    const send = () => idem.withIdempotency(scope, idem.canonicalHash(body), (k) =>
      mass.commitMassReschedule(org, admin, body, k.id("audit"), (fn) => {
        scheduled.push(fn);
      }));

    h.cal.length = 0;
    h.hcp.length = 0;
    const first = await send();
    expect(first.status).toBe(200);
    if (!first.envelope.success) throw new Error("commit failed");
    const result = first.envelope.data as unknown as MassResult;
    expect(result.moved.map((m) => m.visitId).sort()).toEqual([ids.m1, ids.m2].sort());
    expect(result.skipped).toContainEqual({ visitId: ids.m3, reason: "stale" });
    for (const [k, reason] of [["started", "started"], ["fp", "fieldpulse"], ["helper", "helper"], ["later", "later_visit"]] as const) {
      expect(result.skipped).toContainEqual({ visitId: ids[k], reason });
    }
    expect(result.pushesNotSent).toEqual([]);
    expect(await reqOf(m1)).toMatchObject({ start: at(d2, 8), end: at(d2, 9), assignedTo: alex }); // wall-clock kept
    expect(await reqOf(m3)).toMatchObject({ start: at(d, 10) }); // not moved
    const audits = await auditRows("dispatch_mass_rescheduled", alex);
    expect(audits).toHaveLength(1);
    const details = JSON.parse(String(audits[0]!.details)) as { movedVisitIds: string[]; skipped: Array<[string, string]>; dayShift: number };
    expect([...details.movedVisitIds].sort()).toEqual([ids.m1, ids.m2].sort());
    expect(details.skipped).toContainEqual([ids.m3, "stale"]);
    expect(details.dayShift).toBe(1);
    await runCollected(scheduled);
    expect(h.cal.map(([, r]) => r).sort()).toEqual([m1, m2].sort());
    expect(h.hcp.map(([, r]) => r)).toContain(m1);

    // Same key → the stored 200, replayed.
    const replay = await send();
    expect(replay).toMatchObject({ status: 200, replayed: true });
    expect(replay.envelope).toEqual(first.envelope);

    // Crash between commit and the done row: the key row is gone, the audit row is the record.
    await run(sql`DELETE FROM idempotency_keys WHERE organization_id = ${org} AND user_id = ${admin} AND route = ${scope.route} AND key = ${key}`);
    const versionsBefore = [await v1(m1), await v1(m2)];
    const windowsBefore = [await reqOf(m1), await reqOf(m2)];
    h.cal.length = 0;
    h.hcp.length = 0;
    h.hcpConfigured = true; // an HCP-connected org: m2 (no hcp_job_id) would need an HCP create
    try {
      const recovered = await send();
      expect(recovered.status).toBe(200);
      if (!recovered.envelope.success) throw new Error("recovery failed");
      const again = recovered.envelope.data as unknown as MassResult;
      expect(again.moved.map((m) => [m.visitId, m.visitVersion]).sort()).toEqual(result.moved.map((m) => [m.visitId, m.visitVersion]).sort());
      expect(again.skipped).toEqual(result.skipped);
      expect(again.pushesNotSent).toEqual([m2]);
      expect([await v1(m1), await v1(m2)]).toEqual(versionsBefore); // nothing re-written
      expect([await reqOf(m1), await reqOf(m2)]).toEqual(windowsBefore);
      expect(await auditRows("dispatch_mass_rescheduled", alex)).toHaveLength(1);
      await runCollected(scheduled);
      expect(h.cal.map(([, r]) => r).sort()).toEqual([m1, m2].sort()); // calendar sync re-sent
      expect(h.hcp).toEqual([[org, m1]]); // the HCP update re-sent; no create for m2
    } finally {
      h.hcpConfigured = false;
    }
  }, 180_000);

  it("(m') mass, the commit reclassifies: shared-band visits both move; started after the preview → started; moved away → stale", async () => {
    const d = nextDay();
    const d2 = nextDay();
    const a1 = await newJob({ day: d, start: at(d, 8), end: at(d, 12) });
    const a2 = await newJob({ day: d, start: at(d, 8), end: at(d, 12) }); // the same band as a1
    const s1 = await newJob({ day: d, start: at(d, 13), end: at(d, 14) });
    const gone = await newJob({ day: d, start: at(d, 15), end: at(d, 16) });
    const candidates = await mass.previewMassReschedule(org, { technicianId: alex, fromDate: d, toDate: d2 });
    const byReq = new Map(candidates.map((c) => [c.requestId, c]));
    for (const rid of [a1, a2, s1, gone]) expect(byReq.get(rid)).toMatchObject({ outcome: "moves", conflict: false });

    // Between the preview and the commit: s1's lead taps en route; `gone` is moved to a far day by someone else.
    await tap(s1, alex, "en_route");
    expect(codeOf(await move(gone, { day: addDays(d, 60), band: "morning", windowRule: "keep" }))).toBe("ok");

    const body = {
      technicianId: alex, fromDate: d, toDate: d2,
      visits: candidates.map((c) => ({ visitId: c.visitId, expectedVersion: c.expectedVersion })),
      preSkipped: [], confirmConflict: false,
    };
    const scope = { organizationId: org, userId: admin, route: "/api/admin/dispatch/mass-reschedule", key: randomUUID() };
    const out = await idem.withIdempotency(scope, idem.canonicalHash(body), (k) => mass.commitMassReschedule(org, admin, body, k.id("audit"), () => {}));
    expect(out.status).toBe(200); // a changed visit is never a 400 for the whole commit
    if (!out.envelope.success) throw new Error("commit failed");
    const result = out.envelope.data as unknown as MassResult;
    expect(result.moved.map((m) => m.requestId).sort()).toEqual([a1, a2].sort());
    expect(result.skipped).toContainEqual({ visitId: byReq.get(s1)!.visitId, reason: "started" });
    expect(result.skipped).toContainEqual({ visitId: byReq.get(gone)!.visitId, reason: "stale" });
    expect(await reqOf(a1)).toMatchObject({ start: at(d2, 8), end: at(d2, 12) });
    expect(await reqOf(a2)).toMatchObject({ start: at(d2, 8), end: at(d2, 12) });
    expect(await reqOf(s1)).toMatchObject({ start: at(d, 13) }); // not moved
    expect((await rowOf((await v1(s1))!.id, alex))?.status).toBe("en_route"); // never confirmed in bulk
  }, 120_000);

  it("(n) a visit #1 holding a form submission survives a drop on Unscheduled", async () => {
    const d = nextDay();
    const formId = await newForm();
    const rid = await newJob({ day: d });
    const visit = (await v1(rid))!;
    await tap(rid, alex, "arrived");
    expect(await draft(rid, visit.id, formId, alex, 0, { [F.a]: true })).toMatchObject({ ok: true });
    // Fixture surgery: take the progress and the logged time away, keep the submission.
    await db.batch([
      db.execute(sql`UPDATE appointment_assignments SET status = 'scheduled'::request_status, en_route_at = NULL, arrived_at = NULL, started_at = NULL, completed_at = NULL
        WHERE appointment_id = ${visit.id} AND organization_id = ${org}`),
      db.execute(sql`DELETE FROM technician_time_entries WHERE service_request_id = ${rid} AND organization_id = ${org}`),
      db.execute(sql`UPDATE service_requests SET status = 'scheduled'::request_status WHERE id = ${rid} AND organization_id = ${org}`),
    ] as never);
    const now = (await v1(rid))!;
    expect(await sq.unscheduleRequest(org, rid, { visitId: now.id, expectedVersion: now.version })).toEqual({ ok: true });
    expect((await v1(rid))?.id).toBe(visit.id);
    const subs = await run(sql`SELECT count(*)::int AS n FROM form_submissions WHERE appointment_id = ${visit.id} AND organization_id = ${org}`);
    expect(Number(subs[0]!.n)).toBe(1);
  }, 90_000);

  it("(n2) arrive → Move anyway → drag back → Unscheduled is refused: WORK_LOGGED, the visit, rows and entries intact", async () => {
    const d = nextDay();
    const rid = await newJob({ day: d });
    const visit = (await v1(rid))!;
    await tap(rid, alex, "arrived");
    expect(codeOf(await move(rid, { day: d, windowRule: "keep", technicianId: sam, confirm: ["started"] }))).toBe("ok");
    expect(codeOf(await move(rid, { day: d, windowRule: "keep", technicianId: alex }))).toBe("ok");
    expect(await rowOf(visit.id, alex)).toEqual({ technicianId: alex, isLead: true, status: "scheduled", stamped: false });
    const gate = (await v1(rid))!;
    expect(await sq.unscheduleRequest(org, rid, { visitId: gate.id, expectedVersion: gate.version })).toEqual({ ok: false, reason: "work_logged" });
    expect((await v1(rid))?.id).toBe(visit.id);
    expect(await rowOf(visit.id, alex)).toMatchObject({ isLead: true });
    const entries = await entriesOf(rid, alex);
    expect(entries.length).toBeGreaterThan(0);
    expect(entries.every((e) => e.appointment_id === visit.id)).toBe(true);
    expect((await reqOf(rid)).assignedTo).toBe(alex);
  }, 90_000);

  it("(n3) a stale Unscheduled drop → STALE", async () => {
    const d = nextDay();
    const rid = await newJob({ day: d });
    const old = (await v1(rid))!;
    expect(codeOf(await move(rid, { day: d, band: "afternoon", windowRule: "match" }))).toBe("ok");
    expect(await sq.unscheduleRequest(org, rid, { visitId: old.id, expectedVersion: old.version })).toEqual({ ok: false, reason: "stale" });
    expect((await reqOf(rid)).start).toBe(band(d, "afternoon").start);
  }, 60_000);

  it("(o) tenancy: another org's ids → 404 / TECHNICIAN_NOT_FOUND", async () => {
    const d = nextDay();
    const rid = await newJob({ day: d });
    const v = (await v1(rid))!;
    const foreign = await mv.moveVisit(org2, admin2, rid, {
      visitId: v.id, expectedVersion: v.version, day: d, band: "afternoon", windowRule: "match", confirm: [],
    });
    expect(foreign).toMatchObject({ ok: false, status: 404, code: "NOT_FOUND" });
    expect(await move(rid, { day: d, windowRule: "keep", technicianId: tech2 })).toMatchObject({ ok: false, code: "TECHNICIAN_NOT_FOUND" });
    expect(await sq.unscheduleRequest(org2, rid, { visitId: v.id, expectedVersion: v.version })).toEqual({ ok: false, reason: "request_not_found" });
    expect(await aq.addVisitTechnician(org2, rid, v.id, tech2, admin2)).toEqual({ reason: "not_found" });
    expect(await reqOf(rid)).toMatchObject({ assignedTo: alex, start: at(d, 9) });
  }, 60_000);

  it("(p) audit rows carry ids, enums, booleans and counts only", async () => {
    const rows = [...(await auditRows("visit_moved")), ...(await auditRows("dispatch_mass_rescheduled"))];
    expect(rows.length).toBeGreaterThan(5);
    const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
    const ENUM = /^[a-z_]+$/;
    const walk = (v: unknown): void => {
      if (v === null || typeof v === "boolean" || typeof v === "number") return;
      if (typeof v === "string") {
        expect(UUID.test(v) || ENUM.test(v), `audit value ${v}`).toBe(true);
        return;
      }
      if (Array.isArray(v)) return v.forEach(walk);
      if (typeof v === "object") return Object.values(v as Record<string, unknown>).forEach(walk);
      throw new Error(`unexpected audit value ${String(v)}`);
    };
    const MOVED_KEYS = ["requestId", "fromTechnicianId", "toTechnicianId", "windowRule", "window", "dayChanged", "confirmed",
      "startedStatuses", "conflictCount", "outsideAvailability"].sort();
    for (const r of rows) {
      const text = String(r.details);
      expect(text).not.toContain(CUSTOMER_NAME);
      expect(text).not.toMatch(/\d{4}-\d{2}-\d{2}T/); // no instants
      const parsed = JSON.parse(text) as Record<string, unknown>;
      walk(parsed);
      if ("windowRule" in parsed) expect(Object.keys(parsed).sort()).toEqual(MOVED_KEYS);
    }
  }, 60_000);
});
```

Notes for the implementer (read before running):
- `shift_kind` is the enum name of `technician_shifts.kind` (`schema.ts`, `shiftKindEnum = pgEnum("shift_kind", …)`).
- `addRow` inserts helper rows with explicit stamps only for fixture states the office writers never produce (a done helper, a working helper, an old cancelled row). Every other row is made by the writers under test.
- (p) runs last on purpose: it reads every audit row the earlier cases wrote.

- [ ] **Step 2: Register the suite.** Re-read `vitest.config.ts`, then replace

```ts
  // M3d forms + site view: writers, trigger, erase and site reads against the dev DB (throwaway orgs).
  "tests/integration/field-forms.test.ts",
];
```

with

```ts
  // M3d forms + site view: writers, trigger, erase and site reads against the dev DB (throwaway orgs).
  "tests/integration/field-forms.test.ts",
  // M2 dispatch: move, Unscheduled, crew, sheet guards and mass reschedule against the dev DB (throwaway orgs).
  "tests/integration/field-dispatch.test.ts",
];
```

- [ ] **Step 3: Run it**

Run: `VITEST_INTEGRATION=1 npx vitest run tests/integration/field-dispatch.test.ts`
Expected: PASS, 22 tests (the suite refuses `ep-withered-hill`; it deletes its three orgs in `afterAll`). Then confirm no org was left behind: `SELECT count(*) FROM organizations WHERE name LIKE 'Probe Org Field Dispatch %'` → 0 (run through a one-off `npx tsx` probe at the repo root, deleted afterwards).

Run: `npx vitest run`
Expected: the unit gate does not pick the suite up (it is in `INTEGRATION_SUITES`); counts equal Task 10's.

- [ ] **Step 4: Gates and commit**

```bash
npx tsc --noEmit && npx eslint tests/integration/field-dispatch.test.ts vitest.config.ts && npx vitest run
git add tests/integration/field-dispatch.test.ts vitest.config.ts
git commit -m "$(cat <<'EOF'
test(m2): dispatch integration suite (a)-(p) on the dev DB

Move, Move anyway and drag back, the started rule across board and
sheet, revive, TECHNICIAN_DONE incl. a done tap injected between pre-read
and batch, FieldPulse read-only with no FieldPulse call, races, crew cap,
later visits, mass reschedule with SQL audit and crash recovery,
WORK_LOGGED, tenancy and audit contents. Throwaway orgs only.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01GuWoF63tQU1i7ELqyYU3A6
EOF
)"
```

---

### Task 11b: Docs (spec §13)

**Files:**
- Modify: `.claude/skills/page-calendar/SKILL.md`, `.claude/skills/page-requests/SKILL.md`, `.claude/skills/page-dispatch/SKILL.md`, `.claude/skills/admin-pages/SKILL.md`, `docs/DISPATCH.md`, `replica/features.csv` (lines 96, 97, 98, 102), `replica/parity.md` (regenerated), `replica/build-log.md` (one appended line), `replica/architecture.md` (reassign-guard bullet ~line 93, the mass-reschedule route row ~line 145, the M2 build-order item ~line 625)
- Not committed: `/Users/sizbei/.claude/projects/-Users-sizbei-Documents-GitHub-ai-hvac-agent/memory/replica-program-fp-st.md`

**Interfaces:** Consumes: everything above; the Task 0 report's final `autoScroll` values and measured lanes-scroller width (written below as `{ x: 0.06, y: 0.2 }, acceleration 5` and 766 px; substitute the recorded values if Task 0 retuned them). Produces: docs only.

- [ ] **Step 1: page-calendar.** In `.claude/skills/page-calendar/SKILL.md`:

Replace

```
`checkScheduleConflict`, `placeAndAssignRequest`, `assignTechnician` /
`reassignTechnician` / `scheduleRequest` (409 `TIME_OFF`),
`autoAssignBookedRequest` and `suggestTechnicians`. HCP/FieldPulse scheduling
sources ignore shifts. The calendar still renders requests only; visits #2+
(`appointments`) are rendered in M2. Known gap: the conflict dialog still
offers "Schedule anyway" for a time-off conflict (server refuses it).
```

with

```
`checkScheduleConflict`, `placeAndAssignRequest`, `assignTechnician` /
`reassignTechnician` / `scheduleRequest` (409 `TIME_OFF`),
`autoAssignBookedRequest` and `suggestTechnicians`. HCP/FieldPulse scheduling
sources ignore shifts. The day view draws every shift as a block (M2, below);
a time-off clash opens "Can’t move this request" with OK only — time off is
never overridable and the old "Schedule anyway" branch is gone.
```

Replace

```
`placedByVisitQuery` (driven from `appointments` in range, where the displayed
visit is #2+ or ended); a row the other feed owns is dropped. In queries.test.ts
the visit feed is the LAST select (calendar index 4, dispatch 2, month 1).
```

with

```
`placedByVisitQuery` (driven from `appointments` in range, where the displayed
visit is #2+ or ended); a row the other feed owns is dropped. In queries.test.ts
the visit feed is the LAST select (calendar index 4, dispatch 2, month 1). The
M2 crew/visit read (`src/lib/admin/board-crew-queries.ts`) and the day's
blocks (`listShiftsInRange` in `src/lib/admin/shift-queries.ts`) run after
those five and are mocked in queries.test.ts, so the indices don't move.
```

Replace

```
- `onStatus` callback surfaces a transient `CalendarStatus` banner (warning or
  error) from `InteractiveSchedulingCalendar` after a reschedule — a rollback
  posts an error tone, a soft conflict posts warning.
```

with

```
- Move banner (`src/components/admin/calendar/move-banner.tsx`): one always-
  mounted live region, fixed bottom-right (top-centre below 640 px), close ×;
  `role="status"`, errors `role="alert"`; "Moved." clears after 4 s, errors
  stay until closed, any banner clears on the next drag start. Copy from
  `src/lib/admin/dispatch-copy.ts` only.
```

Then insert this section right before the `**Verify changes:**` line:

```
**Dispatch (M2):** the board moves requests through ONE route,
`POST /api/admin/requests/[id]/move` (`moveVisit`, `src/lib/admin/visit-move.ts`);
`POST …/reschedule`, `use-reschedule-job.ts` and `@dnd-kit/sortable` are gone.
- Drop flow (`handleDragEnd`): `pointerWithin`, falling back to `rectIntersection`
  in a lane gap (Task 0); a drop over nothing does nothing.
  `promptPlan` (`src/lib/admin/move-window.ts`): no window → use the band;
  the window (moved onto the drop day) covers the band → keep (same lane and
  day → nothing is sent; "Still <range>. Use Move… to change the window." when
  the band only overlaps); else the "Arrival window" prompt (default "Use the
  new window" for a band window, Keep for anytime/custom; Keep isn't offered
  with the same day and lead). Then `timeOffHits` on loaded blocks (time-off
  dialog, nothing sent), the optimistic move (`optimisticCrew`, `laneCards`),
  the POST, `applyMoveResult` before the refetch.
- 409 `HAS_PROGRESS` / `SCHEDULE_CONFLICT` → "Move anyway?" (`confirmLines`);
  the resend carries `confirm: ['started' | 'conflict']`. Move anyway cancels
  the old lead's row (timestamps and time entries kept, open time stopped),
  revives the new lead clean, resets a native on-site request to scheduled when
  nobody else works; audit `visit_moved`. No Undo: drag the request back (an
  ordinary move that revives the old lead's row clean).
- `STALE` (version gate on visit id + version, also on Unscheduled drops) or a
  lost response → refetch; `moveLanded` keeps a landed move quiet.
- Cards carry `visitId` (displayed visit, else #1), `visitVersion`, `crew`,
  `started`, `movable`, `laneRole`. Only visit #1 moves; visits #2+ are pinned
  ("Visit #2"); FieldPulse-mapped cards are read-only (pill + lock, no grab, no
  `Move…`; the server answers 409 `MANAGED_EXTERNALLY` and makes no FieldPulse
  call). Helper copies sit in each helper's lane ("Helping <first name>", not
  draggable); crew chips only with 2+ crew (`chipLayout`); lane counts include
  helper copies.
- Blocks (`lane-blocks.tsx`): every `technician_shifts` kind, between the bands
  and the cards, non-interactive except a "Staff" link; only
  `removes_capacity` blocks refuse a move.
- `Move…` on every movable lead card and Unscheduled row is the keyboard and
  touch path (`move-dialog.tsx`, `moveDialogDefaults` / `moveDialogBody`); the
  drag wrapper is out of the tab order; no keyboard drag. Focus after a drop,
  refusal or dialog: the card button `[data-request-id][data-lane-role="lead"]`,
  else the drop lane's header (`tabIndex={-1}`), after a `Move…` to another day
  the date stepper's label. Base UI dialogs use `finalFocus={false}`.
- Layout: the time axis sits outside the lanes scroller (`data-lanes-scroller`);
  at 1440 with the sidebar expanded the scroller is 766 px: Unassigned plus two
  technician lanes are fully visible. `autoScroll={{ threshold: { x: 0.04, y:
  0.2 }, acceleration: 3 }}` (values proved by the Task 0 drag spike; the
  default 0.2 slid the board on a drop into the second technician lane).
- Interactive only at ≥ 1024 px with `(pointer: fine)` (`boardInteractive`);
  otherwise no sensors, notice "Dragging needs a computer. Use Move… on a
  request, or open it."
- Lane header `⋯` → `Move this day…` (`mass-move-dialog.tsx`): preview, then
  `POST /api/admin/dispatch/mass-reschedule` with an `Idempotency-Key`; skipped
  rows say why. Walk fixture: `scripts/agent/m2-walk.mts` (throwaway orgs) and
  `scripts/agent/m2-drag.mts` (Playwright drag helpers).
```

And replace the verify line

```
**Verify changes:** `npx vitest run src/lib/admin/scheduling-queries.test.ts`
· `src/lib/admin/calendar-time.test.ts`
· `src/lib/admin/calendar-optimistic.test.ts`.
```

with

```
**Verify changes:** `npx vitest run src/lib/admin/scheduling-queries.test.ts`
· `src/lib/admin/calendar-time.test.ts`
· `src/lib/admin/calendar-optimistic.test.ts`
· `src/lib/admin/move-window.test.ts` · `src/lib/admin/board-move.test.ts`
· `src/lib/admin/visit-move.test.ts`; dev DB:
`VITEST_INTEGRATION=1 npx vitest run tests/integration/field-dispatch.test.ts`.
```

- [ ] **Step 2: page-requests.** In `.claude/skills/page-requests/SKILL.md`:

Replace

```
`REQUEST_CANCELLED`, `VISIT_CANCELLED`. The detail sheet has a "Visits"
section using the shared `src/components/admin/window-picker.tsx`. Tech-app
ownership: see "Tech loop guards (M3a)"; the calendar does not render
visits #2+ yet (M2).
```

with

```
`REQUEST_CANCELLED`, `VISIT_CANCELLED`. The detail sheet has a "Visits"
section using the shared `src/components/admin/window-picker.tsx`. Tech-app
ownership: see "Tech loop guards (M3a)"; the calendar shows a visit #2+ in its
lead's lane, pinned (see "Dispatch (M2)" below).
```

Replace

```
- Once a technician has progress (en route / arrived / started / done) on a
  visit, schedule, assign, reassign and unschedule of visit #1
  (`src/lib/admin/visit-one-guard.ts`) and `PATCH` of any visit refuse with 409
  `HAS_PROGRESS`; a visit ended by a hold refuses with 409 `VISIT_ENDED` (use
  the Visits section).
```

with

```
- Two visit #1 guards (`src/lib/admin/visit-one-guard.ts`). The STARTED rule
  (`visitOneStartedGuardSql`, `src/lib/admin/visit-started.ts`): a live lead
  row en route / arrived / in progress / completed, or on hold with a
  timestamp; a live helper row working or paused; timestamps alone don't count.
  It guards the board move, drag-to-Unscheduled, assign, reassign and
  `placeAndAssignRequest`. The TIMESTAMP rule (`visitOneGuardSql`, unchanged)
  guards the sheet's schedule edit (`scheduleRequest`); `PATCH` of a visit #2+
  (`updateAppointment`) keeps `visitProgressed`. Refusals answer 409
  `HAS_PROGRESS`; a visit ended by a hold 409 `VISIT_ENDED`.
```

Replace

```
- Detail sheet: reassign (PATCH `/assign`) is allowed from any in-flight
  status incl. `scheduled` — `REASSIGNABLE_STATUSES` in
  `src/lib/admin/request-status.ts` (calendar-drag parity); the visit-one guard
  still refuses once a technician has progress. 409 copy uses
  `requestStatusLabel`, never the raw enum.
```

with

```
- Detail sheet: reassign (PATCH `/assign`) is allowed from any in-flight
  status incl. `scheduled` — `REASSIGNABLE_STATUSES` in
  `src/lib/admin/request-status.ts`; the started guard refuses once anyone on
  visit #1 has started (the sheet refuses a swap even when only a helper works;
  the board allows that one). 409 copy uses `requestStatusLabel`, never the raw
  enum.
```

Insert after the `**Forms section (M3d):**` paragraph:

```
**Dispatch (M2), sheet side:**
- Started-refusal copy (native): "A technician has started this visit. To move
  it anyway, use Move… on the calendar." `visitOneRefusalResponse(reason,
  { fieldpulse, surface })` names FieldPulse first on a FieldPulse-mapped
  request ("A technician has started this visit. Change it in FieldPulse."; the
  schedule-edit route reads `isFieldpulseMapped`).
- `assignTechnician` / `reassignTechnician` refuse FieldPulse-mapped requests
  in SQL (409 `MANAGED_EXTERNALLY`, "Change the technician for this request in
  FieldPulse."; the select is disabled) and a technician who already finished on
  visit #1 (409 `TECHNICIAN_DONE`). Every lead writer (move, assign, reassign,
  `placeAndAssignRequest`) appends `reviveLeadSql`: a cancelled row whose
  technician becomes lead again is revived clean (timestamps nulled), so A → B
  → A never leaves a cancelled lead.
- Visits section: a `Technicians` control per live visit (crew with "Lead", ×
  on helpers who haven't started, "Add technician"; disabled at 5; hidden with
  "Assign a technician to this request first." while the visit has no lead;
  FieldPulse "Change the technicians for this request in FieldPulse."; HCP
  "Helpers aren't available for Housecall Pro requests."); `Change time` on a
  live visit #2+ through `PATCH …/appointments/[aid]` (disabled when any row has
  `hasProgress`). Helper writers lock the request `FOR NO KEY UPDATE`, need a
  live lead (409 `NO_LEAD`), cap at 5 in SQL (409 `VISIT_FULL`), revive a
  cancelled helper clean, cancel (not delete) a timestamped helper who hasn't
  started, and bump `appointments.version`. The visits GET adds `started` and
  `hasProgress` per assignment.
- Drag-to-Unscheduled refuses a visit #1 with job time logged on it (or with no
  visit link): 409 `WORK_LOGGED` "Work was logged on this visit, so it can't go
  back to Unscheduled."
```

- [ ] **Step 3: page-dispatch.** In `.claude/skills/page-dispatch/SKILL.md`, replace

```
- Columns render busy-first (`busyColumnsFirst`,
  `src/lib/admin/dispatch-board-order.ts`).
```

with

```
- Columns render busy-first (`busyColumnsFirst`,
  `src/lib/admin/dispatch-board-order.ts`).
- Helpers (M2) show only in their lead's column here; the calendar's day view
  is where a visit also shows in each helper's lane. Moves happen on the
  calendar (`POST /api/admin/requests/[id]/move`), not on this board.
```

- [ ] **Step 4: admin-pages.** In `.claude/skills/admin-pages/SKILL.md`, replace

```
- Time off (`technician_shifts`, kind `time_off`) is never overridable: the
  schedule-conflict `override` flag does not bypass it (409 `TIME_OFF`).
```

with

```
- Time off (`technician_shifts`, kind `time_off`) is never overridable: the
  schedule-conflict `override` flag does not bypass it (409 `TIME_OFF`).
- "Started" (M2) has one definition: `rowStarted` / `startedRowSql` in
  `src/lib/admin/visit-started.ts` (live lead row en route, arrived, in
  progress, completed or paused; live helper row working or paused). Import it;
  the schedule edit and visits #2+ keep the older timestamp rule on purpose.
```

- [ ] **Step 5: docs/DISPATCH.md §5.** Replace

```
response and released once a real tech is committed. External-scheduler orgs
(`scheduling_source='external'`, FieldPulse/HCP own the calendar) are skipped entirely.
```

with

```
response and released once a real tech is committed. External-scheduler orgs
(`scheduling_source='external'`, FieldPulse/HCP own the calendar) are skipped entirely.

**Office moves (M2).** The calendar moves a request through
`POST /api/admin/requests/[id]/move` (`moveVisit`, `src/lib/admin/visit-move.ts`);
`POST …/reschedule` is removed. A move is one lock-first batch gated on visit
#1's id + version, so a move made after an autopilot placement answers `STALE`
and refetches. `placeAndAssignRequest` now uses the started guard and revives a
cancelled lead row (`reviveLeadSql`). Invariant kept: the autopilot places only
still-unassigned requests (`requireUnassigned`). Residual (not closed): after a
dispatcher moves a fresh, still-unassigned request within the Unassigned lane,
an autopilot run already scoring can re-place it at its held slot, because
`requireUnassigned` checks the assignee only.
```

- [ ] **Step 6: replica/features.csv.** Replace line 96

```
Edit arrival window prompt on move,dispatch,must,yes,partial,ST; calendar drag reschedules - no window prompt
```

with

```
Edit arrival window prompt on move,dispatch,must,yes,yes,ST; a drop into a window the current one doesn't cover asks which window; a drop into a covered band keeps it; FieldPulse-mapped requests are moved in FieldPulse
```

line 97

```
Block reassign of working or done jobs,dispatch,must,yes,no,ST
```

with

```
Block reassign of working or done jobs,dispatch,must,yes,yes,ST; a started visit refuses a move with 409 HAS_PROGRESS; Move anyway hands it over and is audited; drag it back to reverse
```

line 98

```
Multi-technician and team assignment with team grouping,dispatch,must,yes,partial,FP+ST; assignment rows + visits API; lane UI and guard in M2
```

with (quoted: the note holds commas)

```
Multi-technician and team assignment with team grouping,dispatch,must,yes,yes,"FP+ST; lead + helpers per visit, added in the request sheet; the visit shows in every crew member's lane with crew chips; no named teams (a visit's crew is its team)"
```

line 102

```
Mass reschedule,dispatch,could,yes,no,ST
```

with

```
Mass reschedule,dispatch,could,yes,yes,ST; move a technician's day to another day and/or technician after a preview; FieldPulse-mapped requests are skipped
```

Rows 82, 100, 79, 93, 101, 103 stay as they are (spec §1).

- [ ] **Step 7: Regenerate parity.** The replica-diff tool (`.claude/skills/replica-diff/SKILL.md`):

Run: `python3 .claude/skills/replica-diff/parity.py replica/features.csv --markdown > replica/parity.md && head -6 replica/parity.md`
Expected: the score rises from 47.9 and "must-haves 60 of 111 done" (57 + rows 96, 97, 98). `git diff --stat replica/parity.md` shows only score/list changes; if the old file carried a visual section, re-run with the same `--visual replica/diffs/*.json` arguments its header names instead.

- [ ] **Step 8: replica/build-log.md.** Append one line (the file's `ID | date | status | not built | notes` format):

```
M2 | <commit date> | done | FieldPulse time/technician moves from the board (follow-up: the owner verifies a schedule-only updateJob PUT first); Undo of a move (drag back instead); capacity strip and capacity adjustments (row 82), zones (100), skills, named teams, late outlines, route view; keyboard drag (Move… instead); blocks in Week view | Dispatch as deltas to /admin/calendar, no migration: one move route (POST /api/admin/requests/[id]/move) replacing /reschedule; window prompt via promptPlan/covers with pointerWithin drop bands; started rule (live lead working or done, live helper working; timestamps only tell a pause) on the move, Unscheduled, assign, reassign and placeAndAssignRequest while the schedule edit and visits #2+ keep the timestamp rule; Move anyway cancels the old lead (history kept, open time stopped) and revives the new lead clean, reset to scheduled when nobody else works, audited; reviveLeadSql on every lead writer; TECHNICIAN_DONE and WORK_LOGGED guards; version gate on visit id + version; FieldPulse-mapped requests read-only with no FieldPulse call; crew chips, helper copies, blocks, Move… dialog, focus rules, interactivity ≥ 1024 px fine pointer; helper writers lock, cap 5 (VISIT_FULL), NO_LEAD, revive, cancel branch, version bump; mass reschedule keyed with an SQL-computed audit row for crash recovery (update-style pushes only); integration suite tests/integration/field-dispatch.test.ts; drag spike (Task 0) set autoScroll threshold x 0.06, acceleration 5
```

(`<commit date>` = the date of this commit, YYYY-MM-DD; if Task 0 retuned `autoScroll`, write the recorded values.)

- [ ] **Step 9: replica/architecture.md.** Replace

```
- reassign guard: a move of an assignment whose status is `en_route`,
  `arrived` or `in_progress` needs an explicit override (data layer, 409,
  test); `REASSIGNABLE_STATUSES` in `queries.ts` changes in the same PR
```

with

```
- reassign guard: a move of an assignment whose status is `en_route`,
  `arrived` or `in_progress` needs an explicit override (data layer, 409,
  test); `REASSIGNABLE_STATUSES` in `queries.ts` changes in the same PR
  (As built, M2: the guard is the started rule in `visit-started.ts` and the
  409 is `HAS_PROGRESS` with a `confirm: ['started']` resend on the move route
  only; `REASSIGNABLE_STATUSES` stayed `IN_FLIGHT_STATUSES` and lives in
  `request-status.ts`; the sheet has no override.)
```

Replace

```
| POST /api/admin/dispatch/mass-reschedule | move a tech's day | admin | technicianId, date, deltaMinutes | count |
```

with

```
| POST /api/admin/dispatch/mass-reschedule | move a tech's day | admin | technicianId, fromDate, toDate, toTechnicianId?, visits, preSkipped, confirmConflict (As built, M2: Idempotency-Key, no deltaMinutes; a preview route first; the move itself is POST /api/admin/requests/[id]/move under the request) | moved, skipped, pushesNotSent |
```

Replace

```
   Done when: dragging across a window boundary prompts for the window, a
   working job refuses reassignment with a 409 unless overridden, and a
   two-tech job shows on both lanes.
```

(the one in item 5, M2) with

```
   Done when: dragging across a window boundary prompts for the window, a
   working job refuses reassignment with a 409 unless overridden, and a
   two-tech job shows on both lanes.
   As built: proved on native requests; FieldPulse-mapped requests are
   read-only on the board and Housecall Pro requests move and are pushed as
   before; the move route lives under the request (no `deltaMinutes`);
   `REASSIGNABLE_STATUSES` unchanged in `request-status.ts`; capacity (82) and
   zones (100) deferred to a capacity milestone; Undo cut (drag back).
```

- [ ] **Step 10: Memory (not committed).** In `/Users/sizbei/.claude/projects/-Users-sizbei-Documents-GitHub-ai-hvac-agent/memory/replica-program-fp-st.md`: update the frontmatter `description` to end with "…; M2 Dispatch built (parity <new score>)", replace the "Known gaps carried: calendar does not render visits #2+ (M2)" clause with "visits #2+ render pinned on the calendar (M2)", and append a paragraph:

```
**M2 Dispatch BUILT <date> (<first sha>..<last sha>, NOT deployed; no migration).** Parity 47.9 → <new> (must 57 → 60 of 111; rows 96, 97, 98 yes, 102 yes). Spec `docs/superpowers/specs/2026-11-08-replica-m2-dispatch.md` (v4.1), plan `docs/superpowers/plans/2026-11-08-replica-m2-dispatch.md`. One move route replaced /reschedule; started rule in visit-started.ts (board, Unscheduled, assign, reassign, placeAndAssign) vs the timestamp rule kept for the schedule edit and visits #2+; Move anyway cancels the old lead, reviveLeadSql on every lead writer, TECHNICIAN_DONE + WORK_LOGGED; FieldPulse-mapped requests read-only with NO FieldPulse call (dev default org's key is the owner's live account); mass reschedule keyed with SQL audit recovery. Integration `tests/integration/field-dispatch.test.ts` (throwaway orgs). Walk fixture `scripts/agent/m2-walk.mts` + `m2-drag.mts`. Follow-up needing the owner: a schedule-only FieldPulse PUT test on their own test job before FieldPulse time moves are enabled. Next per architecture.md: M4 money builder.
```

- [ ] **Step 11: Checks, gates and commit**

```bash
node scripts/agent/verify-skills.mjs        # → 0 missing paths
npx drizzle-kit generate                     # → "No schema changes"
npx tsc --noEmit && npx vitest run           # counts unchanged from Task 11a
git add .claude/skills/page-calendar/SKILL.md .claude/skills/page-requests/SKILL.md .claude/skills/page-dispatch/SKILL.md .claude/skills/admin-pages/SKILL.md docs/DISPATCH.md replica/features.csv replica/parity.md replica/build-log.md replica/architecture.md
git commit -m "$(cat <<'EOF'
docs(m2): calendar, requests, dispatch and admin skills; DISPATCH.md; replica rows 96-98, 102

Records the move route, prompt, Move anyway, Move..., crew, blocks,
FieldPulse read-only, the started rule and where it applies, the sheet crew
control and Change time, mass reschedule, and the spike's autoScroll values.
Parity regenerated.

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
Claude-Session: https://claude.ai/code/session_01GuWoF63tQU1i7ELqyYU3A6
EOF
)"
```

If `drizzle-kit generate` wrote a file, M2 changed the schema by mistake: stop, `git checkout -- drizzle/`, and find the edit.

---
## Self-review

**1. Spec coverage** (v4.1 section → task):
- §1 goal, done-when, feature rows → Tasks 5, 8, 9b (prompt, 409 + Move anyway, two lanes), Task 11b (features.csv 96/97/98/102, parity).
- §3.2 started rule, two guards and their callers → Tasks 1, 3 (`visitOneStartedGuardSql` in assign, reassign, place; `visitOneGuardSql` unchanged in `scheduleRequest`; `updateAppointment` untouched), 4 (Unscheduled), 5 (the move's arms).
- §3.3 crew writers (lock, revive, NO_LEAD, VISIT_FULL, cancel branch, version bump, `started`/`hasProgress`) → Task 4.
- §3.4 / §7.3 blocks → Tasks 6 (`listShiftsInRange`), 7 (day GET), 9a (`lane-blocks.tsx`).
- §4.1 revision gate on id + version, fallback to #1, Unscheduled gate → Tasks 3, 4, 5, 7.
- §4.2 single move unkeyed + `moveLanded`; mass keyed, SQL audit, recovery pushes, after() last → Tasks 2, 6, 8, 9b.
- §4.3 L_req first, mass id order → Tasks 5, 6.
- §5.1 FieldPulse predicate on every writer, no FieldPulse call → Tasks 3, 4, 5, 6, 8 (`m2-imports.test.ts`).
- §5.2 window resolution → Task 1; client prompt → 9a/9b.
- §5.3 `moveVisit` (pre-read, order, needs, batch steps 0–6, zero rows, deadlock, after-calls, audit, 200) → Task 5; route → Task 8.
- §5.4 Unscheduled (version, FieldPulse, started, WORK_LOGGED) → Task 4.
- §5.5 sheet writers, refusal copy, disabled select → Tasks 3, 10.
- §5.6 mass → Tasks 2, 6, 8, 10.
- §6 routes incl. `/reschedule` removal → Tasks 4, 8.
- §7.1 board data → Task 7; §7.2 lanes, chips, pill, started cue, layout, autoScroll → 9a/9b (values from Task 0); §7.4 drop flow and focus → 9b; §7.5 dialogs, banner, `Move…` → 9a; §7.6 → 10; §7.7 → 10; §7.8 interactivity → 9b; §7.9 Week view → 9b.
- §8 copy → Task 2 (`dispatch-copy.ts`), Task 10 (`sheet-visit-copy.ts`).
- §9 tests: pure (Tasks 1, 2, 5, 9a, 10), SQL renders (3, 4, 5, 6, 7), routes (3, 4, 8), integration (a)–(p) (11a), drag spike (0), walk (9b, 10).
- §13 docs → Task 11b.

**2. Placeholder scan:** no TBD/TODO; every code step carries the code; edits quote the current text they replace. Two "verify then fall back" notes remain where the repo's own primitives decide the shape (Task 10: `DropdownMenuContent align`, `SelectTrigger size`, `SelectItem disabled`; each with the grep and the fallback). The compile pass below found all three props present.

**3. Type consistency:** every import of an M2 module in Tasks 9a, 9b, 10 and 11 was checked mechanically against the exports defined in Tasks 1–10 (no missing names), and the compile pass confirms it.

**4. Review Focus:** the five lines at the top each have a test in the owning task (Tasks 1, 3, 5, 6, 8).

**Compilation and test run (v2; one scratch worktree of `b9cfba1`, removed afterwards):** every code block of Tasks 0–11 was re-applied in order by script (the Task 11 suite and Task 0's `.mts` scripts included; `tsconfig.json` covers `**/*.mts`); `npx tsc --noEmit` → 0; `npx eslint` → 0 errors (warnings: the repo's existing `set-state-in-effect` ones, `invoice-queries.ts`'s existing unused `count`, and `UNASSIGNED_SCOPE` in `calendar-optimistic.test.ts`, which Task 9b Step 1 already tells the implementer to pin with one case); `npx vitest run` → **549 unit files, 7 021 passed** (the integration suite is excluded by Task 11's `vitest.config.ts` line, which the scratch run didn't add, so it was type-checked only). v1's compile-pass fixes stay folded in. Not run: the integration suite against the dev DB, the drag spike, the walks, the contrast script and the probes (they need a dev server or the DB).

**Round 1 (v1 → v2):** critic A 0 blocker / 3 major / 9 minor; critic B 2 blocker / 7 major / 11 minor. Every finding was applied (lead rulings 1–8); none refuted. Spec §9 gained one line naming the integration file (the only spec edit).

**Spec findings (unbuildable as written, or contradictory), with the plan's choice:**
- `listShiftsInRange` (§7.1) does not exist → Task 6 creates it (lead ruling 2).
- `RadioGroup` (§7.5) doesn't exist in `src/components/ui/` → Task 9a adds a Base UI wrapper (ruling 20).
- `onCloseAutoFocus` (§7.4) is a Radix prop; the repo's dialogs are Base UI → `finalFocus={false}` + the board's focus helper (ruling 19).
- §5.3 lists `WINDOW_ENDED` in the 409 refusal order, §5.2 makes it 400 → 400 (ruling 8); `keep` with no window's 400 is placed after `MANAGED_EXTERNALLY`.
- §4.2 recovery "syncRequestToCalendar and pushJobToHcp for moved requests that already have hcp_job_id" is ambiguous → calendar sync for every moved request, the HCP update only for mapped ones (Task 6).
- §5.3's outside-hours check has no practical SQL twin → pre-read only (ruling 4).
- §9 names `tests/integration/dispatch-board.test.ts`; this plan uses `tests/integration/field-dispatch.test.ts` as instructed (ruling 1).

---

## Execution handoff

Plan complete and saved to `docs/superpowers/plans/2026-11-08-replica-m2-dispatch.md`. Please review the plan. Which execution approach would you prefer?

- **Subagent-driven** — a fresh subagent implements each task and a fresh reviewer checks it before the next one starts, then a whole-branch review at the end.
- **Native** — one session implements every task, then one fresh reviewer checks the whole branch.

For this plan I recommend **subagent-driven**, because the thirteen tasks hand exact interfaces forward (the move SQL, the writers' result shapes, the board's props) and a shipped mistake in the move batch or the mass audit corrupts live crew rows, so a gate per task is worth its cost.
