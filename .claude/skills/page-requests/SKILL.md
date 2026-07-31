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

**Data flow:** `useAdminRequests` fetches `/api/admin/requests` with a composite
cache key (all filter/sort/page params), polls every 10 s (not 30 s — the
request list is the operator's primary triage surface). SWR cache keeps the
prior page visible (dimmed) while a new filter/page loads — no skeleton flash
between page changes. Latest-wins monotonic counter: a filter change mid-poll
supersedes the in-flight fetch.

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
· `src/lib/admin/url-filters.test.ts`. Visual: admin-pages recipe; apply a
status filter and confirm the URL updates; navigate away and back, confirm
filters restore.
