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
