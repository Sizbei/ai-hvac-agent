# Round 1 — Missed-risk audit: dashboard / calendar / dispatch / requests / technicians / map

Lens: not "is what the spec says true" but **what did the spec never look
at**. Method: read all six specs in full, then independently hunted the
underlying code — `queries.ts`'s dashboard/dispatch/calendar aggregations,
`scheduling-queries.ts`'s assignment/placement writes, `staff-queries.ts`'s
deactivation path, and the map route — for the six named risk classes
(scheduling correctness, emergency safety, timezone, data honesty, tenancy,
concurrency), independent of what each spec already flagged.

This program's specs are unusually thorough — each one already runs a
lens-by-lens pass over its own page and cross-checks two or three sibling
pages (dashboard.md vs. `insights-ai`'s `OPEN_STATUSES`; technicians.md vs.
dispatch board and calendar bucketing; map.md vs. the dispatch page's
mutation surface). The three findings below all survived for the same
structural reason: each is a place where a spec verified an invariant
*holds on the pages it checked* and generalized that verification to a
sibling page it never actually opened for that specific query. The gap is
never inside a page's own file — it's in the join between two pages that
share a data shape (`assignedTo`, `technicianId`) but not a query.

## Findings

### O-R-1 — An emergency assigned to a technician who is later deactivated becomes permanently invisible on the dashboard's "needs attention" list, and misleadingly shows as covered on "today's schedule"

**Severity:** blocker · **Tag:** verified

`getDashboardOverview`'s "needs attention" query (`src/lib/admin/queries.ts:1217-1241`)
requires both `isNull(serviceRequests.assignedTo)` (`:1230`) **and**
`inArray(status, UNASSIGNED_OPEN_STATUSES)` where
`UNASSIGNED_OPEN_STATUSES = ["pending", "scheduled"]` (`:455`). Deactivating a
technician (`updateStaff`, `src/lib/admin/staff-queries.ts:312-325`) only ever
writes `users.isActive = false` — it never touches
`serviceRequests.assignedTo` for that technician's already-assigned rows
(confirmed by reading the full function body, `:255-341`; no
`serviceRequests` table reference anywhere in it). So a real sequence — a
technician is dispatched to a winter no-heat `emergency` (status flips to
`assigned`, `assignedTo` set), then gets deactivated before completing it
(fired, quits, account suspended, or an admin fat-fingers the wrong row on
`/admin/staff`) — leaves the request with `assignedTo` still pointing at a
now-`isActive:false` user and `status='assigned'`. That row can **never**
satisfy `assignedTo IS NULL`, so it can never appear in "needs attention"
again, for the rest of its lifecycle, even though the technician who was
supposed to be working it no longer has an account.

It gets worse on "today's schedule" (`queries.ts:1199-1215`), which has no
`assignedTo`/`isActive` predicate at all — it matches purely on
`arrivalWindowStart` falling today. If the stranded job's window is today,
it renders in that list with the deactivated technician's name still shown
(`assignedToName: users.name` via an unfiltered `leftJoin(users, …)`,
`queries.ts:1126`; rendered verbatim as `request.assignedToName ?? 'Unassigned'`
in `src/components/admin/dashboard/dashboard-list-card.tsx:165`) — actively
telling the owner the emergency is covered, when the "technician" on it
cannot be reached through the app anymore. If the window isn't today (or
isn't set), the dashboard shows nothing about it at all.

Contrast this with the dispatch board and scheduling calendar, which both
correctly detect exactly this condition and reroute the job to their
"unassigned" bucket: `getDispatchBoard` and `getSchedulingCalendar` both
seed technician buckets only from `technicians.filter(t => t.isActive)`
(`queries.ts:1320`, `:1441`) and fall any job whose assignee isn't in that
active set through to `unassigned` (`:1326-1334`, `:1447-1455`-equivalent).
The dashboard — the page whose own Purpose statement is "in the first five
seconds… see what needs them right now — unassigned urgent/emergency
requests" — is the one page of the three that shares this exact data shape
and does *not* implement the same fallback.

**Which spec should have caught it:** `technicians.md`. Its "Deactivation
semantics (lens c)" section explicitly set out to check this exact failure
mode across the app and signed off clean:

> "deactivating a technician does NOT silently orphan their already-assigned
> jobs. Both the dispatch board (`getDispatchBoard`, `src/lib/admin/queries.ts:1316-1320`)
> and the scheduling calendar (`getSchedulingCalendar`, `:1441-1445`) seed a
> column only for *active* technicians and explicitly fall a job whose
> assignee is 'missing, deactivated, or otherwise not a visible active
> tech' through to the unassigned pile — a deliberate, commented decision —
> so a dispatcher always sees the job and can reassign it… No drift found
> here." (`technicians.md:85-95`)

It checked the two pages that already handle this correctly and generalized
"no drift found" from them. It never opened `getDashboardOverview`, the
third and most-trafficked consumer of `assignedTo`, to check the same
invariant there. `dashboard.md`'s own invariants section states *""Needs
attention" must filter on `assignedTo IS NULL`, never status alone'*
(`dashboard.md:209-210`) and calls the query "correctly implemented" — true
for the leak it was checking (an assigned-but-still-urgent job incorrectly
appearing), but it never considered the inverse: a job whose `assignedTo`
is stale-but-non-null being incorrectly *excluded* forever.

---

### O-R-2 — The calendar's "Unscheduled" queue is capped at 50 and sorted oldest-first with no urgency awareness, so a fresh emergency phoned in during a backlog is silently excluded from the panel dispatchers use to place jobs

**Severity:** major · **Tag:** verified

`getSchedulingCalendar`'s unscheduled-jobs query
(`src/lib/admin/queries.ts:1419-1436`) has no day-range filter (it's the
entire org's backlog of `pending`/`scheduled` requests missing a tech and/or
a window), orders `asc(serviceRequests.createdAt)` (`:1435`, oldest first),
and caps at `.limit(DASHBOARD_LIST_LIMIT)` = 50 (`:1436`, `types.ts:201`).
Unlike the dashboard's "needs attention" list — which orders
emergency-before-high before the oldest-first tiebreak
(`queries.ts:1237-1240`) — this query has **no** urgency `CASE` in its
`ORDER BY` at all. Once an org's backlog of unplaced jobs exceeds 50, the
50 shown are strictly the 50 oldest by `createdAt`; anything created after
that point — including a brand-new `emergency` call — is permanently
excluded from the panel until enough of the older 50 get placed/resolved to
let it age into view.

The rendered component (`DraggableUnscheduledPanel`,
`src/components/admin/calendar/draggable-unscheduled-panel.tsx:132-144`,
the one actually mounted in the live interactive calendar at
`interactive-scheduling-calendar.tsx:647`) does show a truncation signal —
`jobs.length >= DASHBOARD_LIST_LIMIT` renders "50+" with a
"Showing the first 50" tooltip — so this isn't a *silent* cap the way the
map's geocode drop is (Gmap-1, already caught by `map.md`). But the
disclosure is misleading in the specific way that matters here: "first 50"
reads as "the 50 that arrived earliest," which is exactly backwards from
what a dispatcher needs during exactly the scenario this matters most — a
volume spike (a cold snap, a multi-day FieldPulse import of historical
unplaced jobs) that pushes the backlog over 50 and is disproportionately
likely to be generating new emergencies. There is no pagination or
"load more" on this panel, so the excluded jobs aren't one click away —
they're invisible to this workflow entirely (an operator would have to
independently know to check `/admin/requests` and filter by urgency to
find them).

**Which spec should have caught it:** `calendar.md`. Its "Views/data flow"
paragraph inventories every data source feeding the page in detail —
`useSchedulingCalendar`, `useMonthCalendar`, `useAgenda`, each hook's poll
interval, equality guard, and `next/dynamic` loading
(`calendar.md:47-58`) — but never mentions the unscheduled-jobs queue at
all, despite `DraggableUnscheduledPanel` being an always-visible, primary
panel on the exact page whose Purpose statement is "place… service requests
onto technician lanes." The spec's emergency-safety attention went entirely
to the *placed* board's timezone/overlap/CAS correctness (verified solid,
correctly) and to accessibility (Rcalendar-1/2); the *unplaced* queue — the
one place a request sits before any of those placed-board guarantees even
apply — was never opened.

---

### O-R-3 — The dispatch map plots a deactivated technician's last known location exactly like an active one, with no `isActive` filter anywhere in the query

**Severity:** major · **Tag:** verified

`GET /api/admin/dispatch/map`'s technician-location query
(`src/app/api/admin/dispatch/map/route.ts:130-146`) is:

```ts
db.selectDistinctOn([technicianLocations.technicianId], {
  technicianId: technicianLocations.technicianId,
  name: users.name,
  latitude: technicianLocations.latitude,
  longitude: technicianLocations.longitude,
  capturedAt: technicianLocations.capturedAt,
})
  .from(technicianLocations)
  .innerJoin(users, eq(technicianLocations.technicianId, users.id))
  .where(withTenant(technicianLocations, session.organizationId))
  .orderBy(asc(technicianLocations.technicianId), desc(technicianLocations.capturedAt))
```

— tenant-scoped, but with no `eq(users.isActive, true)` predicate anywhere
in the file (confirmed: `grep -n "isActive" route.ts` returns nothing). The
only other filter applied is a client-independent 4-hour staleness cutoff
(`TECH_FRESH_MS`, `:28`, applied in JS at `:237-238`). Every other write
path that touches `assignedTo`/technician identity in this program checks
`isActive` before trusting a technician row —
`assignTechnician`/`reassignTechnician` (`queries.ts:490,621`),
`placeAndAssignRequest` (`scheduling-queries.ts:654`), the dispatch-board
and scheduling-calendar bucketing (`queries.ts:1320,1441`) — but the map's
live-location layer is the one place in these six pages that plots a named
technician pin without checking whether that technician can still be
dispatched anything. A technician deactivated (fired for cause, quit,
suspended) minutes after their last GPS ping keeps appearing on the map,
indistinguishable from a genuinely available technician, for up to 4 hours
— exactly the window in which a dispatcher glancing at the map to "spot a
technician drifting off-territory" or free capacity near an emergency
cluster (the page's own stated purpose) could reasonably read that pin as
a live, assignable resource.

**Which spec should have caught it:** `map.md`. Its Current State section
verifies tenancy on this exact query in detail:

> "Tenancy: every query scoped — `withTenant(serviceRequests, …)` (`:118`),
> `withTenant(technicianLocations, …)` (`:140`), `withTenant(invoices, …)`
> (`:176`), plus explicit `organizationId` equality on every join
> (`:107,114,164,170`). No unscoped read. verified." (`map.md:117-120`)

The spec read this exact `:130-146` block closely enough to cite line `:140`
by number, and closely enough to independently derive and flag the 4-hour
staleness window (`map.md:92-95`, `"technicians' latest fix per tech via
DISTINCT ON… filtered to the last 4h in JS"`) — but never asked whether the
technician on the other end of that fresh location row is still an active
technician, the exact check every sibling assignment/bucketing query in
this program applies to the same `users` join.

## Not flagged (checked, found solid)

For completeness: the requests page's status-transition CAS
(`request-status.ts`/`queries.ts:752-782`), the dispatch board's
auto-assign confidence gate and shadow-mode isolation (already exhaustively
verified by `dispatch.md` and independently spot-checked here), the
calendar's placed-board double-book guard and business-day timezone math
(`calendar-time.ts`, re-derived independently and found sound), every
`assignTechnician`/`reassignTechnician`/`placeAndAssignRequest` call site's
active-technician + same-org check (all three verified present, all three
consistent), and every `db.transaction()` grep across the whole repo (zero
hits outside comments explaining why it's avoided) were all read and are
sound. No cross-tenant leak was found anywhere in these six pages' query
layer.

## Per-spec verdict

- **dashboard.md** — blocked (O-R-1: the page's own headline promise —
  "see unassigned urgent/emergency requests in five seconds" — has a
  verified, reachable path to permanently hiding exactly that)
- **calendar.md** — blocked (O-R-2: the unscheduled-jobs queue, entirely
  absent from the spec's data-source inventory, can silently exclude a
  fresh emergency once the backlog passes 50)
- **dispatch.md** — sign-off (no missed risk found in this pass; the
  page's own P2 gaps list already reflects the spec's own thorough
  self-audit)
- **requests.md** — sign-off (no missed risk found in this pass)
- **technicians.md** — blocked (O-R-1: the spec's own "Deactivation
  semantics" section checked two of the three pages that read `assignedTo`
  against `isActive` and generalized "no drift found" from an incomplete
  set)
- **map.md** — blocked (O-R-3: the technician-location query the spec
  verified line-by-line for tenancy and staleness has no `isActive` gate)

## Summary

3 findings: 1 blocker, 2 major, 0 minor. All three tagged `verified` (each
traced end-to-end through real, currently-shipped code — no reproduction
under live concurrency was needed since none of the three depend on a race,
only on an ordinary sequence of already-supported actions: assign → later
deactivate; backlog grows past 50; a technician's account is deactivated
within 4 hours of their last ping).

The single most dangerous thing the specs missed: **O-R-1**. It is the only
one of the three that can make a live, previously-surfaced, already-assigned
winter no-heat emergency disappear from the one screen this whole page
program's dashboard exists to answer — "what needs them right now" — with
no code path left anywhere in the app that will ever re-surface it on that
screen, and no cross-page consistency check catches it because the two
pages that *do* handle this condition correctly (dispatch board, calendar)
are exactly the two `technicians.md` checked before writing "no drift found
here."
