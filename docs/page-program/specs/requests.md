# requests — target-state spec

`/admin/requests` — the service request queue.

## 1. Purpose

Give a dispatcher one screen to see every open service request across the
org, triage by urgency/status, and assign a technician — fast enough that a
winter no-heat emergency gets seen and staffed within minutes, not buried
under same-day routine calls. This is the operational heart of the product:
every other admin surface (dashboard, operations, calendar) is a different
lens on the rows this page lists.

## 2. Brainstorm

Ideas considered for a great version of this page, kept vs rejected:

- **Pin/highlight emergencies regardless of sort** — kept (R-1/R-2). Default
  sort is `newest`, which can bury an emergency called in hours ago under a
  wave of routine same-day bookings (`page.tsx:24` default `sortKey='newest'`).
- **Visually distinct emergency row (not just a badge)** — kept (R-1). The
  urgency badge (`urgency-badge.tsx:14`) only colors one cell; the row
  renders identically to a `low`-urgency row in `DataTableShell` (no
  `rowClassName`/urgency hook). Rejected alternative: audible/toast alert on
  new emergencies — this is a pull (poll) UI; a push alert needs a
  websocket/SSE channel this page doesn't have. Out of scope.
- **Search by customer name/phone, not just reference #** — REJECTED for
  this pass: `customerNameEncrypted`/`customerPhoneEncrypted` are encrypted
  at rest (`schema.ts:574-576`); ILIKE search needs plaintext or a blind
  index. A blind index exists for exact-match dedupe but not prefix search —
  building fuzzy search over encrypted PII is a project, not a page-spec fix.
  Non-goal (§6), not silently dropped.
- **Bulk actions (assign/cancel multiple rows)** — REJECTED: no evidence
  dispatchers batch-process; the detail sheet's single-row workflow matches
  how dispatch boards work one job at a time. Speculative. YAGNI.
- **Inline row-level status change (no sheet)** — REJECTED: `on_hold` needs
  hold-reason/follow-up context (`request-detail-sheet.tsx:1064-1095`) that
  doesn't fit a table cell; the sheet is the right density.
- **Saved filter presets** — REJECTED: URL-synced filters already give
  shareable/bookmarkable state (`use-url-filter-sync.ts`); a presets layer
  duplicates a problem bookmarks already solve. YAGNI.
- **Emergency count in the page header** — kept (R-2): the header currently
  only shows `{total} total` (`page.tsx:86`), with no way to know how many
  are emergencies without applying the urgency filter (which clobbers the
  dispatcher's current status/tech filter).
- **Composite DB index for the default query and urgency sort** —
  considered; no covering index exists for the no-filter `newest` query or
  the urgency CASE-sort (§4). At current scale this is invisible with no
  evidence of production slowness, so it stays a P2 backlog item, not a
  numbered requirement, per the severity gate.

## 3. Current state

**Files** (from `.claude/skills/page-requests/SKILL.md`, verified against
source): page `src/app/admin/(dashboard)/requests/page.tsx` · hooks
`src/hooks/use-admin-requests.ts`, `use-url-filter-sync.ts` · API
`src/app/api/admin/requests/route.ts` (list),
`.../[id]/route.ts` (GET/PATCH/POST note), `.../[id]/assign/route.ts` (POST
assign / PATCH reassign) · query layer `src/lib/admin/queries.ts`
(`getRequests`, `assignTechnician`, `reassignTechnician`,
`updateRequestStatus`) · state machine `src/lib/admin/request-status.ts` ·
eventing `src/lib/admin/status-events.ts` · components
`request-filters.tsx`, `request-table.tsx`, `request-detail-sheet.tsx`.

**Filtering, sort, pagination** — `verified`:
- Filters: status, urgency, assignedTo (technician), after-hours toggle,
  reference-number search (prefix, ILIKE, escaped) — all applied
  server-side (`queries.ts:126-158`); the client never fetches unfiltered
  data and filters in JS.
- Pagination is server-side: `LIMIT`/`OFFSET` in `getRequests`
  (`queries.ts:119-121`), `PER_PAGE=50` client-enforced (`page.tsx:17`),
  and the API re-clamps `limit` to max 100 independent of the client
  (`route.ts:36-38`) — a crafted request can't force an unbounded page.
- Sort: `newest` (default, createdAt desc), `oldest` (createdAt asc),
  `urgency` (CASE emergency→high→medium→low→other, then createdAt desc
  tiebreak) — `queries.ts:97-113`. Client and server validate against the
  same `VALID_SORTS` allowlist; an invalid value falls back to `newest`.
- Search is capped at 64 chars server-side and matches `referenceNumber`
  only via prefix ILIKE — `queries.ts:134-142`. No customer name/phone
  search exists (§2, §6).

**Tenancy** — `verified`: every query in `getRequests`, `assignTechnician`,
`reassignTechnician`, `updateRequestStatus`, `getRequestById` is wrapped in
`withTenant(table, organizationId, ...)` (`src/lib/db/tenant.ts:19-28`),
ANDing `eq(table.organizationId, organizationId)` into every WHERE clause.
`assignedTo` (a free-form UUID query param) is regex-validated before use
(`queries.ts:153`) so a malformed value yields zero rows, not a Postgres
error.

**Status state machine** — `verified`:
`pending → {scheduled, cancelled}`; `scheduled → {in_progress, on_hold,
cancelled}`; `assigned → {scheduled, in_progress, on_hold, cancelled}`;
`in_progress → {on_hold, completed, cancelled}`; `on_hold → {in_progress,
scheduled, completed, cancelled}`; `completed`/`cancelled` terminal
(`request-status.ts:28-41`). Enforced twice: `canTransition` gates the
in-memory check, and the DB `UPDATE` is guarded on
`eq(status, existingStatus)` so a stale/illegal transition matches zero
rows and the route returns `409 INVALID_TRANSITION` (`route.ts:182-190`,
`queries.ts:752-758`) — the UI's `allowedTransitions(current)` button set
(`request-detail-sheet.tsx:1024-1030`) is advisory; the server re-validates
independently. Assignment (`pending/scheduled/assigned → assigned`) is a
separate flow guarded by `ASSIGNABLE_STATUSES` (`queries.ts:437,509-529`);
reassignment preserves status (`REASSIGNABLE_STATUSES`,
`queries.ts:460,630-648`) via the same guarded-UPDATE pattern. Tests:
`request-status.test.ts`, `queries.test.ts:1345-1404`
(`updateRequestStatus`), `:540-600`/`:602-680` (`assignTechnician`/
`reassignTechnician`).

**Emergency/urgency surfacing** — `verified` + `inferred`:
`urgency` enum includes `emergency` (`request-filters.tsx:45-51`); it is
filterable and is a first-class sort key (`SORT_OPTIONS`,
`request-filters.tsx:15-19`). Neither the urgency filter nor `getRequests`
suppresses or down-ranks `emergency` rows (`queries.ts:97-158` read in
full) — `inferred` this matches the repo's prior-regression sensitivity
around emergency suppression elsewhere; no analogous suppression found
here. Gap: the row is not visually escalated beyond the small colored badge
(`urgency-badge.tsx:14-21`, `status-colors.ts:97-98`) and `newest` (not
`urgency`) is the default sort — see §4.

**Response-time instrumentation (`assigned` event)** — `verified`: the
requests page's own assignment path (`assignTechnician`,
`queries.ts:472-556`) calls `recordStatusEvent({..., toStatus: "assigned",
actorType: "human"})` (`queries.ts:547-553`) right after the guarded UPDATE
succeeds. `reassignTechnician` deliberately does NOT emit this event
(`queries.ts:604-681`) — it isn't a first assignment, and re-emitting would
double-count the KPI (status is left untouched). `/admin/operations`'s
first-response KPI reads exactly this signal:
`requestStatusEvents.toStatus = "assigned"`
(`operations-metrics-queries.ts:185`). A second assignment path outside
this page — the dispatch calendar's `placeAndAssignRequest`
(`scheduling-queries.ts:784-796`) — independently emits the same event only
on a genuine first assignment (`isFirstAssignment` guard), confirming the
KPI is fed consistently from both places a tech can be assigned.
`recordStatusEvent` is best-effort/non-throwing on failure
(`status-events.ts:30-47`) — an eventing failure can't block the
assignment, but a DB-write failure on the event table would silently
under-count the KPI with no retry/alerting (`inferred`).

**Polling / caching** — `verified`: `useAdminRequests` polls every 10s
(`use-admin-requests.ts:145-151`, faster than the 30s used elsewhere), uses
a module-level SWR cache keyed on the full filter/sort/page tuple so a
filter change dims the prior page instead of a skeleton flash, and a
monotonic run counter supersedes an in-flight fetch on rapid filter
changes (`use-admin-requests.ts:56-58,67,91,113`).

**Indexes** — `verified` (`schema.ts:634-669`): `requests_org_id_idx`,
`requests_status_idx` (not org-scoped), `requests_ref_idx`,
`requests_org_status_idx`, `requests_org_assigned_status_idx`. No index
covers `(organizationId, createdAt)` (default `newest` sort) or
`(organizationId, urgency)` (`urgency` sort) — both rely on
`requests_org_id_idx` plus a runtime sort.

## 4. Gaps

| Gap | Severity | Evidence |
|---|---|---|
| Emergency rows get no visual escalation beyond a small badge; row styling is identical to a `low`-urgency row | P1 | `data-table-shell.tsx` has no `rowClassName`/urgency hook; `urgency-badge.tsx:14-21` only colors one cell |
| Default sort is `newest`, not `urgency` — an emergency filed hours ago can sit below a page of same-day routine bookings with no indicator anything above it is more urgent | P1 | `page.tsx:24` `sortKey='newest'`; re-sorting requires a manual dispatcher action (`request-filters.tsx:15-19`) |
| No at-a-glance emergency count in the header — dispatcher must apply the urgency filter (clobbering their status/tech filter) to see how many emergencies are open | P1 | `page.tsx:84-87` header renders only `{total} total`; no emergency-count query exists |
| No index for the default (`newest`, no filter) query or the `urgency` sort; both runtime-sort behind a single-column org index | P2 | `schema.ts:634-669` — no `(organizationId, createdAt)` or `(organizationId, urgency)` composite index |
| Search only matches reference number; no customer name/phone lookup, so a dispatcher who only has a caller's name can't find their request here | P2 | `queries.ts:134-142`; PII is encrypted at rest (`schema.ts:574-576`), no blind-index-backed prefix search exists |
| `requests_status_idx` (status alone, not org-scoped) is redundant with `requests_org_status_idx`; unused since `getRequests` always applies `withTenant` | P2 | `schema.ts:637` vs `:663` |

## 5. Requirements

- **Rrequests-1**: The default sort (`newest`, no explicit `sort` in the
  URL) must still make open emergencies visually unmissable without the
  dispatcher taking any action. Acceptance: an `emergency`-urgency row in a
  non-terminal status renders with a distinct row treatment (e.g. a left
  accent border/background tint using the existing `danger` token from
  `status-colors.ts`) in `RequestTable`/`DataTableShell`, verified by
  screenshot with at least one seeded emergency + several lower-urgency rows
  on the same page.
- **Rrequests-2**: The page header must show a live count of open
  (non-terminal) emergency requests, independent of the dispatcher's active
  filters. Acceptance: `PageHeader` actions render e.g. "N total · M
  emergency open" (sentence case per canon); the count reflects `status NOT
  IN (completed, cancelled) AND urgency = 'emergency'` scoped to the org,
  verified by a `queries.test.ts` case and a screenshot with a seeded
  emergency present.
- **Rrequests-3**: Sorting by urgency stays one click away and its
  precedence (emergency → high → medium → low) stays a regression-tested
  guarantee. Acceptance: existing `resolveRequestOrderBy` behavior for
  `sort=urgency` is unchanged, re-verified by the existing
  `queries.test.ts:502` case — a regression guard on R-1/R-2, not new logic.

(Only P0/P1 gaps become requirements. The P2 gaps — missing composite
indexes, no name/phone search, redundant status index — stay in the
program backlog, not built this run.)

## 6. Non-goals

- **Search by customer name/phone/address.** PII is encrypted at rest with
  no prefix-searchable blind index; building one is a cross-cutting
  encryption change, not a page-spec-sized fix (§2, §4 P2).
- **Bulk row actions** (multi-select assign/cancel). No evidence of demand;
  the one-row detail-sheet workflow matches the state machine/hold-reason
  model.
- **Inline (in-row) status editing.** `on_hold` needs a reason + optional
  follow-up date that don't fit a table cell.
- **Saved filter presets.** URL-synced filters already give shareable,
  bookmarkable state.
- **Real-time push alerting on new emergencies** (toast/sound). This page
  is poll-based (10s); a push alert needs a websocket/SSE channel it
  doesn't have. R-1/R-2 solve unmissability on the existing pull model.
- **New composite DB indexes for the default/urgency sort queries.** P2
  perf gap (§4); no evidence of production slowness yet.

## 7. Invariants

(Inherited from `admin-pages` and `page-requests` skills — must not break.)

- Every query scopes by `session.organizationId` via `withTenant`
  (repo-wide tenancy invariant, `AGENTS.md`) — cross-tenant leakage is a
  security incident, not a bug.
- `PER_PAGE = 50`; the server independently clamps `limit` to max 100
  regardless of client input (`route.ts:36-38`), and `sort`/`status`/
  `urgency` values are re-validated server-side against the same
  allowlists the client uses — an invalid/forged value degrades to a safe
  default, never a 500 or an unbounded/unfiltered query.
- Status transitions are guarded server-side by `canTransition` AND a
  status-matched UPDATE (`queries.ts:752-782`) — the UI's button set is
  advisory, not the actual gate; a forged PATCH to an illegal target
  returns `409 INVALID_TRANSITION`.
- `recordStatusEvent` for `toStatus: "assigned"` fires on every genuine
  first-assignment path (`assignTechnician` here; `placeAndAssignRequest`
  on the dispatch calendar) and only on a genuine first assignment, never
  on reassignment — `/admin/operations`'s first-response KPI depends on
  this being neither missed nor double-counted.
- Filter state is URL-synced with defaults dropped; page number and the
  selected detail-sheet id are intentionally NOT synced.
- Copy canon: "request" not job/booking, "technician" not tech, sentence
  case, Unicode `…`, human error copy — no `err.message` surfaced. FROZEN
  safety text/guardrail regexes in `src/lib/ai` are out of scope — this
  page never touches chat/voice prompt code.

## 8. Verification

- `npx tsc --noEmit` → 0. `npx eslint <changed files>` → 0 errors.
- `npx vitest run src/lib/admin/queries.test.ts src/lib/admin/url-filters.test.ts src/lib/admin/request-status.test.ts` → pass, plus a new
  `queries.test.ts` case asserting the emergency-open count (R-2) ignores
  the caller's other filters. Full `npx vitest run` must not drop below
  the run's baseline (`README.md`).
- Visual: per `admin-pages` skill recipe — mint a session, run
  `node scripts/agent/screenshot-page.mjs /admin/requests` with a seeded
  `emergency`-urgency, non-terminal request present. Confirm by eye: (a)
  the emergency row is visually distinct under `newest` sort, (b) the
  header shows the emergency-open count, (c) filters still restore via URL.
- Manual: PATCH an illegal transition (`completed → in_progress`); confirm `409 INVALID_TRANSITION`.
