# map — target-state spec

`/admin/map` — the live dispatch map (technician locations, active-request
pins, accounts-receivable "money owed" layer).

## 1. Purpose

Give an owner/dispatcher one glanceable geographic view of where today's
active work and technicians are, and where the money is owed, so they can
spot a cluster of unassigned emergencies, a technician drifting
off-territory, or an AR hotspot worth a collections call — without
cross-referencing three list pages. One job: plot what's true on a map, and
never let a pin's absence be mistaken for "there's nothing there."

## 2. Brainstorm

Ideas considered, and what shipped or got cut:

- **Dual map provider (Apple MapKit primary, MapLibre fallback)** — shipped.
  Rejected alternative: MapLibre-only. Reason: the "Flighty" visual bar the
  org wants is Apple Maps' cartography, but a hosted admin panel can't demand
  every self-hosting operator buy Apple Developer credentials, so the page
  must render something excellent with zero configuration. verified
  (`.claude/skills/page-map/SKILL.md:12-14`, `apple-dispatch-map.tsx:1-9`).
- **Client-side runtime fallback when Apple fails mid-session** (token 401,
  script error, init throw, 8s watchdog, token-refresh failure) — shipped,
  never a blank pane. verified (`dispatch-map-provider.tsx:9-16`,
  `apple-dispatch-map.tsx:212-216,259-261,283-286`).
- **Cached-coordinates-first job geocoding** (read `customer_locations` set
  at intake, only live-geocode the tail) — shipped. Rejected alternative:
  geocode every job on every map load. Reason: bounds Photon calls and how
  much plaintext address ever leaves the system on a normal load (module
  doc, `route.ts:23-27`). The backfill cron closes most of the gap
  asynchronously (`booking-recovery/route.ts:23-74`) — but see Gmap-1: the
  map itself gives no signal when a job still has no coordinates.
- **Continuous polling / WebSocket live updates** — rejected. One fetch on
  load + manual Refresh (`dispatch-map.tsx:70-92`) is deliberate: a normal
  load can already issue up to 25 live Photon geocode calls plus 200+
  decrypts; polling that on an interval multiplies external-API load and
  decrypt cost for a page an operator checks, not stares at. No complaint on
  record. YAGNI.
- **MapLibre pin clustering at low zoom** (Apple's `clusteringIdentifier` has
  no MapLibre equivalent wired) — rejected. Jobs are capped at 200 rows and
  orgs run far below that (~60 seeded jobs per repo memory); no density
  problem to solve yet.
- **Drag-and-drop technician reassignment from the map** — rejected. Job
  placement already has a dedicated, conflict-checked surface
  (`/admin/dispatch`, `assignTechnician`/`reassignTechnician` per
  `docs/page-program/specs/dispatch.md:33-41`); duplicating that mutation
  path on a read-mostly page with no availability gate would let an
  operator drag a job onto a double-booked tech.
- **Route/travel-time overlays, historical playback/heatmap, filter/search**
  — all rejected. Travel/duration scoring already lives in the dispatch
  autopilot engine (`docs/DISPATCH.md`); the map API only ever queries
  `ACTIVE_STATUSES` (`route.ts:22`, no historical model to build a
  playback on); filter/search has the same no-demand-evidence rejection the
  dispatch board already made (`dispatch.md:53-58`). YAGNI across the board.
- **Surfacing "jobs that couldn't be plotted" instead of silently dropping
  them** — adopted (Gmap-1 / Rmap-1). The map already tracks which jobs
  failed to resolve coordinates (`needGeocode` in `route.ts:203-227`); it
  just never tells the client which ones, or how many were dropped.
- **Unit tests for the shared pin/popup pure-function module** — adopted
  (Gmap-2 / Rmap-2). `AGENTS.md:17` mandates "test component logic by
  extracting pure functions" — `map-pins.ts` is exactly that, including the
  sole XSS defense (`esc()`), and it has zero coverage today.

## 3. Current state

**Pages / components** (verified — read in full):
- `src/app/admin/(dashboard)/map/page.tsx` — server component;
  `resolveMapProvider()` (`:14-20`) returns `'apple'` only if all three
  `APPLE_TEAM_ID`/`APPLE_MAPKIT_KEY_ID`/`APPLE_MAPKIT_PRIVATE_KEY` env vars
  are set, else `'maplibre'`. None of the three are set in dev or (per the
  page skill's gotcha note) prod today, so the Apple branch is currently
  inert — the client never mounts `AppleDispatchMap`, never fetches the
  MapKit token, never loads `mapkit.core.js`. verified.
- `page-client.tsx:14-29` — `PageShell`/`PageHeader` chrome, subtitle states
  the tech-location-is-opt-in invariant, renders `DispatchMapProvider`.
- `dispatch-map-provider.tsx` — `resolveActiveMap(mapProvider, appleFailed)`
  (`:48-54`, pure, unit-tested) decides which of exactly one dynamically
  imported map to mount (`:60-68`); `appleFailed` flips via `onFail` from
  `AppleDispatchMap` on any unrecoverable error.
- `dispatch-map.tsx` (MapLibre, `openfreemap dark` style, `:42`) and
  `apple-dispatch-map.tsx` (MapKit JS v6) are feature-parity ports: both
  fetch `/api/admin/dispatch/map` on mount and on manual Refresh
  (`dispatch-map.tsx:70-92`, `apple-dispatch-map.tsx:218-235`) and render the
  same summary bar / layer toggle / legend / status chips via `map-pins.ts`.

**Server** (verified — read in full):
- `GET /api/admin/dispatch/map` (`route.ts`) — admin-session-gated (`:48-51`),
  rate-limited 60/min/user (`:56-63`), runs 3 parallel queries: active jobs
  (`ACTIVE_STATUSES = scheduled/assigned/in_progress/on_hold`, `:22`,
  tenant-scoped via `withTenant`, capped `.limit(200)`, `:117-124`),
  technicians' latest fix per tech via `DISTINCT ON` (`:130-146`, filtered to
  the last 4h in JS, `:29,229-246`), and AR customers with open invoices that
  have a geocoded `customer_locations` row (`:151-182`).
- Job coordinates: `cached` (from the joined `customer_locations` row,
  unlimited) vs. `needGeocode` (missing `locationId`/coords) is split at
  `:202-210`; only the **first 25** of `needGeocode` get a live Photon
  lookup (`MAX_GEOCODE = 25`, `:27,213-223`); anything beyond that, or any
  live lookup that returns no hit or fails to decrypt the address
  (`safeDecrypt` swallows decrypt errors to `null`, `:31-38`), is filtered
  out of the response entirely (`:224-227`) with **no record kept of how
  many, or which ones**.
- The only client-visible signal is `geocodeCapped: needGeocode.length >
  MAX_GEOCODE` (`:263`) — true only when *more than 25* jobs need a live
  geocode. It says nothing about jobs whose live geocode was *attempted and
  failed* (always silently dropped, cap or no cap), and its rendered label —
  `"Showing first 25 geocoded jobs"` (`dispatch-map.tsx:311-315`,
  `apple-dispatch-map.tsx:510-514`) — is inaccurate: cached jobs aren't
  capped at all, only the live-geocode fallback is.
- Async backfill: the daily `booking-recovery` cron geocodes up to 25
  missing-location requests per org, but only ones created in the last 14
  days, non-terminal, with a linked customer and address
  (`booking-recovery/route.ts:23-51`); older/customer-less rows never
  backfill. verified.
- Tenancy: every query scoped — `withTenant(serviceRequests, …)` (`:118`),
  `withTenant(technicianLocations, …)` (`:140`), `withTenant(invoices, …)`
  (`:176`), plus explicit `organizationId` equality on every join
  (`:107,114,164,170`). No unscoped read. verified.
- `GET /api/admin/mapkit-token` (`mapkit-token/route.ts`) — admin-gated
  (`:25-28`), 503s `NOT_CONFIGURED` if any of the 3 Apple env vars is absent
  (`:34-40`, all 4 combinations covered by `route.test.ts:74-122`), mints a
  30-min ES256 JWT, origin claim omitted for localhost (`:46-53`), never
  logs the private key. 7 tests total incl. full JWT-claim verification.

**Pin/popup escaping** (verified — read `map-pins.ts` in full): every
customer/FieldPulse-controlled string reaching `.innerHTML`/`setHTML` goes
through `esc()` (`:110-118`) — `jobPopupHTML`/`arPopupHTML` escape
`customerName`, `referenceNumber`, `issueType`, `urgency`, `status`,
`technicianName`, `ar.name` (`:181-211`); the inline tooltip builders escape
`tech.name` (`dispatch-map.tsx:171`, `apple-dispatch-map.tsx:374`) and
`data.base.name` in both files. No unescaped interpolation found — the XSS
fix noted in the page skill is intact.

**Apple fallback correctness** (verified): with all 3 Apple env vars absent
(current dev/prod state per the page skill), `resolveMapProvider()` returns
`'maplibre'` server-side (`page.tsx:14-20`) *before* any client code runs —
`AppleDispatchMap` is never mounted, so no MapKit script load, no
`mapkit-token` fetch, and no 8s watchdog delay occur. The fallback is not a
runtime recovery path in this state; it's the only path taken. verified.

## 4. Gaps

| Gap | Severity | Evidence |
|---|---|---|
| Gmap-1: Active jobs with no resolvable coordinates are silently dropped from the map, with no signal distinguishing "no active jobs" from "some jobs exist but aren't shown" | P0 | `route.ts:202-227` drops every job whose cached coords are missing and whose live-geocode attempt (capped at 25, `:213-223`) either wasn't reached, returned no hit, or failed address decrypt — none of that is tracked or returned. The one flag, `geocodeCapped` (`:263`), is `true` only when more than 25 jobs need geocoding, so a load with, say, 3 ungeocoded jobs (all under the cap, one of which fails the Photon lookup) reports `geocodeCapped: false` and simply shows fewer pins with zero indication anything is missing. The rendered chip text itself is also wrong: `"Showing first 25 geocoded jobs"` (`dispatch-map.tsx:311-315`) implies a 25-job ceiling on the whole map, but cached jobs (the majority) aren't capped — only the live-geocode fallback is. |
| Gmap-2: `map-pins.ts` — the sole XSS defense (`esc()`) plus every color/format/radius helper both map providers depend on — has zero automated test coverage | P1 | No test file exists: `find src -iname "*map-pins*"` returns only `src/components/admin/dispatch/map-pins.ts` itself. The page skill documents "16 exports" (`page-map/SKILL.md:16`) and `AGENTS.md:17` mandates "test component logic by extracting pure functions" — this module is exactly that pattern, already extracted, just untested. A future edit that weakens `esc()`'s regex (`map-pins.ts:110-118`) — the only thing standing between a customer-supplied name and both maps' `innerHTML`/`setHTML` calls — would ship with no automated gate catching it. |
| Gmap-3: The jobs query hard-caps at 200 rows (`route.ts:124`) with no count or signal if an org exceeds it | P2 | `.limit(200)` with no `count(*)` comparison or truncation flag returned. Inferred low risk today: repo memory records ~60 seeded jobs for the demo org, well under the cap; flagged for the backlog, not this run. |

That's the full list. Tenancy, provider-swap logic, pin escaping, and the
Apple-absent fallback path are solid and evidenced above; this spec does not
invent additional work to pad it out.

## 5. Requirements

Only Gmap-1 and Gmap-2 clear the P0/P1 bar.

- **Rmap-1**: The map API and both map UIs must let the operator tell "there
  are no active jobs to show" apart from "some active jobs exist but
  couldn't be plotted." The route must track, distinctly from
  `geocodeCapped`, how many active jobs in the current result set have no
  coordinates after both the cache lookup and the capped live-geocode
  attempt — this must be non-zero whenever *any* job is dropped, not only
  when the 25-job cap is exceeded. Both `DispatchMap` and `AppleDispatchMap`
  must render a chip whenever that count is greater than zero, worded to
  reflect what actually happened (not the current "first 25 geocoded"
  phrasing, which misdescribes the cache-vs-live-fallback split).
  **Acceptance criterion**: a `vitest` test on the route handler (mocking the
  three queries) asserts that when N active jobs exist and M have no cached
  coordinates and fail/skip live geocoding, the response carries a count
  equal to M regardless of whether M exceeds `MAX_GEOCODE`; a pure-function
  test on the chip-message derivation confirms distinct messages for "0
  undisplayed" (no chip), "some undisplayed, under cap," and "some
  undisplayed, over cap" (existing `geocodeCapped` case). Manual: seed a
  request with a garbage `addressEncrypted` and confirm the new chip appears
  instead of a silently lower job count.
- **Rmap-2**: `map-pins.ts`'s pure functions must have unit test coverage,
  priority on `esc()`.
  **Acceptance criterion**: `npx vitest run
  src/components/admin/dispatch/map-pins.test.ts` exists and passes,
  covering: `esc()` escapes all 5 XSS-relevant chars (`&<>"'`) and leaves
  safe text unchanged; `arRadius()` clamps to `[10,34]`; `formatCents()`
  renders whole-dollar USD; `formatWindow()` returns `'Unscheduled'` for
  `null`/invalid ISO; `jobColor()`/`arColor()` map each band to its color.

## 6. Non-goals

- Not enabling Apple MapKit or adding Apple credentials — the fallback
  already renders correctly with creds absent (see Current state).
- Not adding polling/WebSocket live updates, drag-and-drop reassignment,
  MapLibre pin clustering, route/travel overlays, historical playback, or
  filter/search (Brainstorm — all rejected: cost, duplicated mutation
  surface, or no demand evidence/YAGNI).
- Not raising or instrumenting the 200-job hard cap (Gmap-3, P2) — recorded
  in Gaps and left in the backlog per METHOD.md's severity gate.
- Not touching MapKit v6 API usage, provider-swap watchdog/fail logic, or
  either map's visual/DOM styling — no evidence any of it is broken.

## 7. Invariants

- **Exactly one map renders at a time, never both, never blank** —
  `DispatchMapProvider` conditional-renders a single dynamically-imported
  branch (`dispatch-map-provider.tsx:14-16,60-68`); any Apple failure swaps
  to MapLibre. Rmap-1's new chip must not introduce a state where neither
  map nor an explanatory chip renders.
- **Shared `map-pins.ts` builders, never forked per-provider** — both maps
  import the same pin/popup/color/format functions
  (`apple-dispatch-map.tsx:47-59`, `dispatch-map.tsx:7-20`) so styling stays
  in sync on both dark basemaps (white rings, not black shadows —
  deliberate). Rmap-2's tests must not require forking this module.
- **All popup/callout HTML goes through `esc()`** — the sole XSS defense for
  customer/FieldPulse-controlled text reaching `innerHTML`/`setHTML`
  (`map-pins.ts:110-118`, consumed at `:181-211` and both providers' inline
  tooltip builders). Rmap-2 exists to keep this true under future edits —
  do not weaken the regex to make a test pass.
- **Tenancy**: every query in `GET /api/admin/dispatch/map` scopes by the
  admin session's `organizationId` (`route.ts:107,114,118,140,164,170,176`).
  Rmap-1's new "undisplayed count" must be computed from the same
  tenant-scoped query results — never a second unscoped query.
- **MapKit JS v6 API facts stay as documented** — `colorScheme: "dark"`
  lowercase, `map.showItems` for fit-to-bounds, `mapkit.CircleOverlay` with
  rgba-encoded opacity (`apple-dispatch-map.tsx:11-41`). Out of scope for
  this spec's changes but must not regress incidentally.
- **Apple env-gated and inert without credentials** — `resolveMapProvider()`
  (`page.tsx:14-20`) must keep failing closed to `'maplibre'` when any of the
  3 env vars is absent; do not change this gate as part of Rmap-1/2. Mobile
  layer-toggle positioning (`max-[480px]:right-2 max-[480px]:top-16`) must
  be preserved if Rmap-1's chip joins the bottom-right status-chip stack
  (`dispatch-map.tsx:309-321`, `apple-dispatch-map.tsx:508-520`).

## 8. Verification

- `npx tsc --noEmit` → 0.
- `npx eslint src/app/api/admin/dispatch/map/route.ts src/components/admin/dispatch/map-pins.ts src/components/admin/dispatch/dispatch-map.tsx src/components/admin/dispatch/apple-dispatch-map.tsx` → 0 errors.
- `npx vitest run` → must not drop below the live baseline (297 files ·
  4022 passed · 1 skipped, per `docs/page-program/README.md`).
- Targeted regression pack (proves Rmap-1/2 didn't break provider-swap,
  tenancy, or the Apple token gate): `npx vitest run
  src/components/admin/dispatch src/app/api/admin/mapkit-token/route.test.ts`
- New tests required: `map-pins.test.ts` (Rmap-2) and the route/derivation
  tests for the undisplayed-job signal (Rmap-1).
- Manual/visual, per the admin-pages recipe: `npm run dev` (background) →
  mint a session → seed one request with a garbage `addressEncrypted` value
  (forces a decrypt failure, lands in the silently-dropped path today) →
  `node scripts/agent/screenshot-page.mjs /admin/map` and confirm the new
  chip appears instead of a lower, unexplained job count. Zoom out ~3 clicks
  to check the service ring renders. Repeat at 390px width.
- After deploy: `bash scripts/agent/prod-smoke.sh` (covers the
  `mapkit-token` route's 503/200, unaffected by this spec).
