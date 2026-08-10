# Spec: calendar (`/admin/calendar`)

## 1. Purpose

The dispatcher's scheduling surface: place, reassign, and reschedule service
requests onto technician lanes by dragging cards between time-window slots
(day/week), scan a month overview, or page through booking history (agenda).
Audience: dispatchers/office staff. It's the only page with drag-and-drop
writes, so the write path's correctness matters as much as the read grid.

## 2. Brainstorm

- **Non-drag reschedule path (button/menu fallback).** ACCEPTED →
  Rcalendar-1. Today drag is the *only* way to reschedule anywhere in the
  app; a keyboard/motor-impaired dispatcher is locked out entirely.
- **Harden dnd-kit screen-reader announcements + instructions.** ACCEPTED →
  Rcalendar-2. `KeyboardSensor` is wired with no `SortableContext` and no
  `accessibility` config — unverified whether it works, and silent either way.
- **Poll-vs-drag flicker fix** (a 30s poll can transiently clobber an
  in-flight optimistic move). REJECTED as a requirement — cosmetic,
  self-heals in one poll cycle, no data loss; not worth touching the
  render-time board-sync for a visual blip. Kept as P2 backlog.
- **Realtime (WebSocket/SSE) board sync** instead of 30s polling. REJECTED —
  no realtime infra exists in the repo; the atomic server-side double-book
  guard already makes concurrent drags safe, only ≤30s staleness remains,
  which is acceptable for a dispatcher tool. Large lift for a cosmetic win.
- **Undo button** beyond the existing conflict cancel/override. REJECTED —
  dragging back is already the undo path; no evidence of lost work.
- **Multi-select/batch drag.** REJECTED — no demand evidence, and dnd-kit's
  single-active-drag model needs a different data model for a workflow that
  doesn't exist anywhere else in the app either.
- **Recurring/multi-day jobs spanning midnight.** REJECTED — the schema has
  one `arrivalWindowStart/End` pair per request; `placeJobInGrid` already
  clamps an end-before-start window to end-of-day. Inventing multi-day spans
  here is scope creep.
- **De-dupe `todayBusiness()` (client) vs `businessTodayIso()` (server).**
  Real duplication, both individually correct — downgraded to P2 backlog, a
  pure refactor with no user-visible effect.
- **Per-view `showCompleted` toggle** instead of one global flag. REJECTED —
  a dispatcher checking "did today finish clean" thinks board-wide, not
  per-view; no evidence a split is wanted.

## 3. Current state

All claims `verified` by reading the cited lines unless tagged `inferred`.

**Views/data flow**: four views (day/week/month/agenda), three hooks each
`enabled` only for its active view — `useSchedulingCalendar` (day/week, 30s
poll, `src/hooks/use-scheduling-calendar.ts:26-121`), `useMonthCalendar`
(month, 30s poll, `src/hooks/use-month-calendar.ts:23-116`), `useAgenda`
(agenda, no poll, cursor-paged, `src/hooks/use-agenda.ts:34-109`). Both
polling hooks use a monotonic `runRef` latest-wins counter
(`use-scheduling-calendar.ts:41,53,61`) and a JSON `prevDataRef` equality
guard to skip no-op re-renders (`:47,78-82`). The dnd-kit board is
`next/dynamic(ssr:false)`-loaded so month/agenda never pay for its bundle
(`src/app/admin/(dashboard)/calendar/page.tsx:25-40`). `showCompleted`
persists to `localStorage`, SSR-safe `false` default synced post-mount
(`page.tsx:140-147`).

**Timezone (verified solid — no P0 found)**: `calendar-time.ts` converts
wall-clock↔UTC only via real-instant `Intl.DateTimeFormat` probes
(`toBusinessWallClock`, `businessOffsetMinutes`, `businessWallClockToUtc` —
`src/lib/admin/calendar-time.ts:80-147`), never fixed-offset math.
`businessDayBounds` produces 23/24/25h spans across DST
(`calendar-time.ts:170-182`). The API route resolves its fetch range the
same way — business-midnight of the first day to business-midnight of the
day after the last (`src/app/api/admin/calendar/route.ts:78-85`) — so the
grid and query always agree on the exact instant span. `calendar-time.test.ts`
has 33 `it()` cases covering winter/summer offsets, both DST transitions,
23h/25h day bounds, and the half-open window-row boundary. `todayBusiness()`
(client, `page.tsx:52-61`) and `businessTodayIso()` (server,
`availability-queries.ts:88-93`) are two independent but equivalent
`Intl`/`America/New_York` implementations — no drift found, flagged only as
minor duplication. `page.tsx`'s `shiftDate`/`shiftMonth`/`formatRangeLabel`
correctly do whole-day/whole-month math on the ISO string via `Date.UTC`,
which is timezone-independent for whole calendar days (`page.tsx:63-95`).

**Drag-and-drop write path**: the optimistic `board` copy re-syncs from the
`calendar` prop via React's "adjust state during render" pattern on any new
prop reference (`interactive-scheduling-calendar.tsx:410-417`).
`applyOptimisticReschedule`/`applyOptimisticUnschedule` immutably rebuild the
board (`src/lib/admin/calendar-optimistic.ts:85-158`; "does NOT mutate the
input" test at `calendar-optimistic.test.ts:65`). **Rollback on failure is
real**: both `conflict` (409) and `error` paths call `setBoard(prev)`
(`interactive-scheduling-calendar.tsx:544-566`); `error` also calls
`onRefetch()`. **Double-book is closed atomically server-side**:
`placeAndAssignRequest`'s UPDATE folds a `NOT EXISTS` overlap check directly
into its `WHERE` clause beside the status-CAS guard
(`src/lib/admin/scheduling-queries.ts:709-747`) — two concurrent drops onto
the same tech/window race safely; the loser's guarded UPDATE matches zero
rows and the route re-derives conflict-vs-moved
(`scheduling-queries.ts:757-777`). A drop cannot silently double-book. **Same-
client races are also closed**: `isRescheduling` disables every
`DraggableJobCard` while a request is in flight
(`interactive-scheduling-calendar.tsx:626,650`). **Known cosmetic race**: a
30s poll landing mid-`await reschedule(...)` can transiently overwrite the
optimistic board before the write resolves (`:410-417,505-539`) —
self-heals, no data loss. Hard conflicts open `ConflictDialog`
(cancel/override, server re-checks on override —
`conflict-dialog.tsx`, `:573-602`). The reschedule route: session auth, UUID
validation, `adminMutation` rate limit, Zod body validation, audit row,
`after()`-mirrored to Google Calendar + HCP
(`src/app/api/admin/requests/[id]/reschedule/route.ts:50-182`); unschedule
route mirrors the shape (`.../unschedule/route.ts:20-76`).

**Agenda keyset pagination**: correct **compound** cursor — sort key
`coalesce(arrivalWindowStart, createdAt) DESC, id DESC`
(`src/lib/admin/queries.ts:1590,1633`), predicate `bookedAt < cursor.ts OR
(bookedAt = cursor.ts AND id < cursor.id)` (`:1599-1604`) — a real
tiebreaker, so same-timestamp rows are neither skipped nor repeated. Page
size 50, `+1` over-fetch for `hasMore` (`:1553,1635-1637`). Client also
de-dupes appended pages by id (`use-agenda.ts:72-77`) as a defensive extra.

**Accessibility — dnd-kit keyboard path**: `DndContext` has `PointerSensor`,
`TouchSensor`, `KeyboardSensor` with `sortableKeyboardCoordinates`
(`interactive-scheduling-calendar.tsx:453-463,607-613`), but **no
`SortableContext` exists anywhere on this page** (grep: no matches) —
`inferred` (not runtime-tested) that arrow-key navigation likely doesn't
move focus to a sensible target without one. **No `accessibility`
(announcements/instructions) prop is passed to `DndContext`** (grep: no
matches) — a keyboard/screen-reader user gets no spoken pick-up/move/drop
feedback. `DraggableJobCard` clears `role={undefined}` after spreading
`{...attributes}` (correctly avoiding a nested-button violation, since the
inner `CalendarJobCard` is a real `<button>`) but keeps the wrapper's
`tabIndex=0`, producing two tab stops per card
(`draggable-job-card.tsx:43-51`). **No non-drag reschedule path exists
anywhere**: grep for "reschedule" in `request-detail-sheet.tsx` (opened by
clicking any card) → zero matches; no other component offers it. Drag is the
only way to change a job's date/window/technician — the single biggest gap.

**Other verified**: overlap uses the standard half-open test (strict `gt` on
the end bound) consistently on both the read-side check
(`scheduling-queries.ts:260-264`) and the write guard (`:719-725`). Agenda
has no stepper — hidden for `isAgenda` (`page.tsx:219-251`). Audit rows are
PII-free (ids/dates/flags only, `reschedule/route.ts:152-163`).

## 4. Gaps

| Gap | Severity | Evidence |
|---|---|---|
| No non-drag (keyboard/click) path to reschedule a job anywhere in the app | P1 | `request-detail-sheet.tsx` grep: no "reschedule" match; no reschedule UI outside `interactive-scheduling-calendar.tsx` |
| `KeyboardSensor` wired without a `SortableContext` or `DndContext.accessibility` config — keyboard drag unverified, and gives no spoken feedback even if functional | P1 | `interactive-scheduling-calendar.tsx:453-463,607-613`; grep for `SortableContext`/`accessibility` → no matches |
| Draggable wrapper keeps `tabIndex=0`/no `role` alongside the inner real `<button>`, giving two undifferentiated tab stops per card | P2 | `draggable-job-card.tsx:43-51` |
| A 30s poll mid-drag can transiently clobber the optimistic board (self-healing, no data loss) | P2 | `interactive-scheduling-calendar.tsx:410-417,505-539` |
| `todayBusiness()` (client) / `businessTodayIso()` (server) are duplicate implementations of the same calc | P2 | `page.tsx:52-61`; `availability-queries.ts:88-93` |

No P0s. Timezone handling, the agenda keyset cursor, and the server-side
double-book guard — the three highest-risk lenses here — are all verified
solid. The one real workflow hole is accessibility: a keyboard-only
dispatcher cannot reschedule at all today.

## 5. Requirements

- **Rcalendar-1**: Every job card exposes a non-drag reschedule action (e.g.
  a button/menu on the card or in `RequestDetailSheet`) letting a
  keyboard/mouse-only user pick a new business day + arrival window (and,
  day view, optionally reassign technician), submitted through the same
  `/api/admin/requests/[id]/reschedule` endpoint via `useRescheduleJob`, so
  conflict/override behavior stays identical to a drag. **Acceptance**: with
  a mouse disconnected, Tab to a job card, activate the action, change
  day/window, submit; confirm the move lands (screenshot or DB read of
  `arrivalWindowStart`); repeat targeting an already-booked technician/window
  and confirm the same `ConflictDialog` appears.
- **Rcalendar-2**: `DndContext` declares an `accessibility` config with
  `screenReaderInstructions` (Space/Enter to pick up, arrows to move,
  Space/Enter to drop, Escape to cancel) and `announcements`
  (dragStart/dragOver/dragEnd/dragCancel callbacks describing the job and its
  current/target slot in plain language). **Acceptance**: inspect the
  rendered DOM for dnd-kit's live region and confirm it updates with
  human-readable text on a simulated drag start/end; the announcement
  formatter is a pure function covered by `vitest` (no jsdom/RTL).

## 6. Non-goals

- Poll-vs-drag flicker (G4): cosmetic, self-heals, not touching the
  render-time sync for a visual blip.
- De-duplicating `todayBusiness()`/`businessTodayIso()` (G5): both correct;
  pure refactor, zero user-visible effect, out of scope this pass.
- Removing the extra draggable-wrapper tab stop (G3): real but minor; not
  folded into Rcalendar-1/2 to avoid scope creep. P2 backlog.
- Realtime (WebSocket/SSE) board sync, multi-select/batch drag, an explicit
  undo button, and recurring/multi-day job spans — see Brainstorm for each.
- Not attempting to fix/prove the existing `KeyboardSensor` arrow-key
  mechanics as part of this pass — Rcalendar-1 ships an independent non-drag
  path instead; Rcalendar-2 only hardens announcements so an attempted
  keyboard drag (working or not) at least gives feedback.

## 7. Invariants

- Date arithmetic renders in Eastern via `Intl`, never
  `new Date().toISOString()` for a day-boundary/"today" calc — DST is
  handled by the platform tz db. Source: `page-calendar/SKILL.md:38-40`;
  `calendar-time.ts:1-20`.
- Placed-job overlap is the half-open test (`start < rangeEnd AND end >
  rangeStart`), never a point test. Source: `page-calendar/SKILL.md:46-48`;
  `scheduling-queries.ts:260-264`.
- The server is always the gate on reschedule/reassign — a 409 must block
  unless `override:true`, and override is re-checked server-side. Source:
  `scheduling-queries.ts:667-690`; `conflict-dialog.tsx:56-60`.
- The atomic `NOT EXISTS` double-book guard in `placeAndAssignRequest`'s
  UPDATE must never become read-then-write (TOCTOU) or a DB unique
  constraint (would 500 the legitimate override path). Source:
  `scheduling-queries.ts:709-727`.
- Reschedule never changes lifecycle `status`, only WHEN/WHO. Source:
  `scheduling-queries.ts:552-556`.
- Agenda's keyset cursor must keep its `id` tiebreaker. Source:
  `queries.ts:1599-1604`.
- Tenancy: every calendar/agenda/reschedule query scopes by session
  `organizationId` via `withTenant`. Source: `admin-pages/SKILL.md:58`.
- `showCompleted` stays `localStorage`-backed with an SSR-safe `false`
  default synced post-mount. Source: `page-calendar/SKILL.md:41-43`;
  `page.tsx:140-147`.
- `InteractiveSchedulingCalendar` stays `next/dynamic(ssr:false)`-loaded.
  Source: `page-calendar/SKILL.md:33-35`; `page.tsx:25-40`.
- Copy canon (request/technician/sign in/cancelled/…/sentence case/human
  error copy) applies to any new UI. Source: `admin-pages/SKILL.md:48-54`.
- No jsdom/RTL — new pure logic (e.g. Rcalendar-2's announcement formatter)
  must be tested as an extracted pure function. Source: `AGENTS.md:13-17`.

## 8. Verification

1. `npx tsc --noEmit` → 0 errors.
2. `npx eslint <changed files>` → 0 errors.
3. `npx vitest run` → must not drop below baseline (297 files · 4022 passed
   · 1 skipped, `docs/page-program/README.md`); specifically re-run
   `scheduling-queries.test.ts`, `calendar-time.test.ts`,
   `calendar-optimistic.test.ts`, plus any new test backing Rcalendar-1/2.
4. Manual keyboard walkthrough (`admin-pages` recipe): `npm run dev`
   (background) → mint a session → open `/admin/calendar` → with a mouse
   disconnected, Tab to a card, invoke the new reschedule action, change
   day/window, submit; confirm the move lands.
5. Conflict path: repeat step 4 targeting an already-booked technician/
   window; confirm `ConflictDialog` appears identically to a drag.
6. Screen-reader spot check for Rcalendar-2: inspect the DOM during a
   simulated drag for the dnd-kit live region updating with descriptive text.
7. `node scripts/agent/verify-skills.mjs` → 0 missing paths (re-run after
   `page-calendar/SKILL.md` is updated for any new file).
