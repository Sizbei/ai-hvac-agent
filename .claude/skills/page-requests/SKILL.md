---
name: page-requests
description: Use when working on the /admin/requests page — full service-request list with filters, search, sort, and server-side pagination.
---

# Service requests (/admin/requests)

**Purpose:** paginated, filterable list of all service requests in the org.
An operator can filter by status, urgency, technician, and after-hours flag,
search by reference number, sort, and open a detail sheet to assign or update.

**Files:** page `src/app/admin/(dashboard)/requests/page.tsx` · hook
`src/hooks/use-admin-requests.ts` · `src/hooks/use-url-filter-sync.ts` ·
API `src/app/api/admin/requests/route.ts` ·
query `src/lib/admin/queries.ts` (`getRequests`) ·
components `src/components/admin/request-filters.tsx` ·
`src/components/admin/request-table.tsx` ·
`src/components/admin/request-detail-sheet.tsx` ·
`src/components/admin/ui/pager.tsx` ·
types `src/lib/admin/types.ts` (`RequestSortKey`, `AdminRequest`) ·
tables `serviceRequests`, `users`

**Create (office booking):** dialog `src/components/admin/request-create-dialog.tsx`
(opened by the header "New request" button) · pure helpers + labels
`src/lib/admin/create-request.ts` (tests `create-request.test.ts`) · step order
`src/lib/admin/create-request-flow.ts` (`runCreateRequest`, injected deps; tests
`create-request-flow.test.ts`) · real deps
`src/lib/admin/create-request-queries.ts` (`createAdminRequest`) · stand-in
session predicate `src/lib/admin/stand-in-session.ts` · availability
API `src/app/api/admin/requests/availability/route.ts`.

**Open requests:** the status filter covers every source; "open" everywhere
means `OPEN_STATUSES` (see page-dashboard "Open requests" for how the
dashboard and insights split and total it).

**Data flow:** `useAdminRequests` fetches `/api/admin/requests` with a composite
cache key (all filter/sort/page params), polls every 10 s (not 30 s — the
request list is the operator's primary triage surface). SWR cache keeps the
prior page visible (dimmed) while a new filter/page loads — no skeleton flash
between page changes. Latest-wins monotonic counter: a filter change mid-poll
supersedes the in-flight fetch.

**POST /api/admin/requests contract:** body = `customerId` (uuid) XOR inline
`customer: { name, phone?, email? }` (deduped via `upsertCustomerByContact`),
`address`, `issueType`, `urgency`, `description` (≤2000), optional `jobType`
(derived from the issue when omitted), `accessNotes`, `systemType`,
`preferredWindow`, `schedule: { isoDay, window: morning|afternoon|evening,
technicianId? }` (isoDay within today−1 … today+365), `override`. 201 →
`{ request (AdminRequest row, or null if the best-effort read-back failed),
requestId, referenceNumber, schedule: none | placed | failed }`. 400 validation
(human copy), 404 customer/technician, 422 do-not-service.
- **M0b additions to the body:** optional `jobTypeId` (uuid of an org
  `job_types` row; the row's `kind` becomes `jobType` and its default duration
  and priority apply), `contactId` (a `customer_contacts` row of the chosen
  customer; saved as `service_requests.contact_id`), `locationId` (a
  `customer_locations` row of the customer, used instead of creating an
  address-derived one), `tagTypeIds` (job-entity tag type ids, written to
  `entity_tags`). 400 codes: `JOB_TYPE_NOT_FOUND`, `CONTACT_NOT_OWNED`,
  `LOCATION_NOT_OWNED`, `UNKNOWN_TAG`. Ownership is checked against the
  session org/customer before the insert.
- The New request dialog has job type, contact, service location and tag
  pickers (contact/location load once a customer is picked); the request detail
  sheet has a read-only "Tags" row.
- **Once the batch commits the response is always 201.** Anything after it
  (status event, placement, pending→assigned flip, read-back) is caught and
  logged; a scheduling failure is `schedule.kind === "failed"`, never a 500 —
  a 500 would make the office resubmit and duplicate the request.
- **409 SCHEDULE_CONFLICT** (with `details: { conflicts, outsideAvailability }`)
  is decided BEFORE the insert, so nothing is written; the dialog shows
  "Schedule anyway?" and resubmits with `override: true`. `schedule.kind ===
  "failed"` means the slot was lost after the pre-check (or a post-save step
  threw): the request exists, unscheduled.
- With a technician: `placeAndAssignRequest` (`assignmentActor: "system"`, so
  the human first-response KPI ignores at-creation assignments) then a guarded
  pending→assigned flip (the tech app hides `pending`). Window without technician: placed +
  a best-effort capacity reservation so the band count drops.
- `session_id` is NOT NULL → each office booking gets a synthetic submitted
  session (token `admin-<uuid>`). Conversations, AI insights and bot analytics
  exclude these (and `mvisit-` / `fp-import-`) via `notStandInSession`.
- Inline customer name/phone/email and the address are sanitised with the
  `sanitize-fields` helpers before encrypting, matching the customer row. Audit row (`service_request_created`,
  details ids/enums only) is in the same `db.batch` as the insert.
- The route lazy-imports the create modules: `tests/e2e/smoke.test.ts` mocks
  `@/lib/ai/extraction-schema` without `jobTypeValues` and imports this route.
- Dialog: `<fieldset>`/form inside the grid `DialogContent` need `min-w-0` or
  the 14 day chips widen the dialog past the viewport.

**Statuses (M0a):** `request_status` includes `en_route` and `arrived`
(migration 0048). Shared lists live in `src/lib/admin/request-status.ts`
(`IN_FLIGHT_STATUSES`, `OPEN_STATUSES`, `ON_SITE_STATUSES`,
`NOT_STARTED_STATUSES`, `UNASSIGNED_OPEN_STATUSES`, `NEEDS_PLACEMENT_STATUSES`,
`TERMINAL_STATUSES`) — import these, never hand-write status arrays.
Transitions: scheduled/assigned/on_hold → `en_route` → `arrived` →
`in_progress` (no `arrived` → `completed`). `PATCH /api/admin/requests/[id]`
accepts both new values. Dashboard tiles fold en_route/arrived into "in
progress"; the response-time KPI stops at arrival.

**Visits (M0a):** `appointments` + `appointment_assignments` (migration 0049).
Visit #1 is mirrored from the request by two triggers
(`service_requests_sync_appointment_ins/_upd`) and backfilled — never write
visit #1 directly. Visits #2+ go through `GET/POST
/api/admin/requests/[id]/appointments` and `PATCH/DELETE …/[aid]` (route files
under `src/app/api/admin/requests/[id]/appointments/`; queries
`src/lib/admin/appointment-queries.ts`, types `appointment-types.ts`). PATCH
is CAS on `version`: 409 `VERSION_CONFLICT`; other errors `IS_FIRST_VISIT`,
`REQUEST_CANCELLED`, `VISIT_CANCELLED`. The detail sheet has a "Visits"
section using the shared `src/components/admin/window-picker.tsx`. Tech-app
ownership: see "Tech loop guards (M3a)"; the calendar does not render
visits #2+ yet (M2).

**Tech loop guards (M3a):** native requests only.
- Admin `PATCH` status `on_hold` follows the tech hold rule (visit ends, open
  rows close); native `completed` is a guarded batch that cancels untouched
  assignment rows (`completeRequestFromAdmin`). FieldPulse/HCP jobs keep the old path.
- Once a technician has progress (en route / arrived / started / done) on a
  visit, schedule, assign, reassign and unschedule of visit #1
  (`src/lib/admin/visit-one-guard.ts`) and `PATCH` of any visit refuse with 409
  `HAS_PROGRESS`; a visit ended by a hold refuses with 409 `VISIT_ENDED` (use
  the Visits section). Adding a visit to a completed request: 409
  `REQUEST_COMPLETED`. Cancelling a visit closes the job time opened on that
  visit (other visits' entries stay open). Visit edit/cancel batches lock the
  request first (request -> visit -> rows).
- Visit helpers: `POST …/appointments/[aid]/assignments` and `DELETE
  …/assignments/[tid]` (`src/app/api/admin/requests/[id]/appointments/[aid]/assignments/`,
  queries `src/lib/admin/assignment-queries.ts`) add/remove non-lead helpers on
  any visit incl. #1. 409 codes: `TIME_OFF`, `VISIT_ENDED`, `REQUEST_COMPLETED`,
  `ALREADY_ASSIGNED`, `HAS_PROGRESS`, `IS_LEAD`, `MANAGED_EXTERNALLY`,
  `REQUEST_CANCELLED` (remove refuses on a synced, completed or cancelled request too). Tech
  ownership is now the assignment-row rule (page-tech), not `assigned_to` alone.

**Invariants:**
- `PER_PAGE = 50`; limit is enforced server-side too (max 100). The pager uses
  `safePage = Math.min(page, totalPages)` so an out-of-bounds page never renders.
- Filter state is URL-synced (`useUrlFilterSync`) with defaults dropped
  (`status=''` is omitted). Page number and the selected detail sheet ID are
  intentionally NOT synced.
- Page resets to 1 on every filter, sort, or search change — the effect
  depends on `debouncedSearch`, not `searchInput`, so it fires once per 300 ms
  debounce window, not on every keystroke.
- Search is capped at 64 chars server-side (reference numbers are ≤20 chars;
  the cap is a defensive guard, not a feature).
- `sort` accepted values: `newest` (default, omitted from URL), `oldest`,
  `urgency`. Any other value is rejected; the server re-validates with
  `VALID_SORTS`.
- `assignedTo` is a free UUID persisted to the URL as-is; the server UUID-
  guards it before querying, so no client-side UUID check is needed.
- The "after hours" filter maps to `isAfterHours=true` in the query string
  (`?afterHours=1` in the URL for brevity).

**Gotchas:**
- `refetch` on `useAdminRequests` busts the SWR cache (`bust: true`) so a
  status change committed via the detail sheet always fetches fresh data, not
  the cached page.
- Do not pass `hasActiveFilters` as true when only the sort differs from the
  default — the "Clear filters" button should not appear for sort-only changes.

**Verify changes:** `npx vitest run src/lib/admin/queries.test.ts`
· `src/lib/admin/create-request.test.ts` · `create-request-flow.test.ts`
· `stand-in-session.test.ts`
· `src/lib/admin/url-filters.test.ts`. Visual: admin-pages recipe; apply a
status filter and confirm the URL updates; navigate away and back, confirm
filters restore.

**Setup guide:** `?new=1&from=setup` opens the New request dialog with the
schedule panel already open (`initialScheduleOpen` on `request-create-dialog.tsx`,
set only for the deep-link open) and shows the `book_first_request` banner. See
page-setup.

**Deep link to one request:** `/admin/requests?request=<uuid>` opens that
request's detail sheet (read in `restoreFiltersFromUrl`, UUID-guarded, not
persisted). Customer history rows, reviews, estimates and invoices link here.
