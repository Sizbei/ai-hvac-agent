---
name: page-audit-log
description: Use when working on the /admin/audit-log page — paginated, filterable history of every admin action; details field contains field names/IDs/enums only, never PII values.
---

# Audit log (/admin/audit-log)

**Purpose:** immutable record of admin and safety-critical actions for the
organization. Lets operators trace who changed what and when. Filterable by action
and entity type; paginated at 50 rows.

**Files:** page `src/app/admin/(dashboard)/audit-log/page.tsx` · hook
`src/hooks/use-admin-audit-log.ts` · types
`src/lib/admin/audit-types.ts` · API
`src/app/api/admin/audit-log/route.ts` · queries
`src/lib/admin/audit-queries.ts` · table `audit_log`

**Data flow:** `useAdminAuditLog({ action, entity, page, limit })` fetches
`/api/admin/audit-log` with query params; re-fetches on any filter or page change.
No client cache. The API returns `{ entries, total, actions }` — `actions` is the
distinct action values present for the org, used to populate the action filter.
Entity filter uses the static `KNOWN_ENTITIES` enum in the page.

**Invariants:**
- `details` is a JSON string of field **names**, IDs, and enum values only — never
  PII values (no customer names, emails, addresses). The page renders it verbatim
  after `JSON.parse`. If `JSON.parse` throws, `formatDetails` returns
  `'(details unavailable)'` — not the raw string (which could contain a future
  leaked value).
- `minTableWidth="40rem"` on `DataTableShell` prevents the table columns from
  collapsing on narrow viewports. Do not remove.
- Actor is `actorName` (display name); null renders as `<span italic>System</span>`
  for automated/unauthenticated actions. Never show a raw user ID.
- `humanize()` converts `snake_case` to sentence case (only first word capitalised).
  This matches the copy canon.
- Tenancy: the API scopes all queries to `organizationId` from the session.
  `getAuditLog`'s actor join (`src/lib/admin/audit-queries.ts`) is ALSO scoped
  by `organizationId` on the `users` side (`and(eq(auditLog.userId, users.id),
  eq(users.organizationId, organizationId))`), not just `userId = users.id` —
  an unscoped join lets a cross-org row (e.g. `org_provisioned`, written by
  platform provisioning with a foreign `userId`) resolve and leak that actor's
  real name into a different org's audit page. A foreign actor must resolve to
  `null` (renders "System"), never to a name outside the org.
- Conversation delete (`DELETE /api/admin/conversations/[id]`) is
  `isSuperAdmin`-only, same tier as customer hard-delete/erase. It preserves
  `audit_log` rows referencing the deleted session — `sessionId` is set to
  `NULL` (nullable FK), never deleted — so the audit trail outlives the
  conversation it describes.
- `create_membership_plan` / `create_pricebook_item` audit `details` no longer
  interpolate the free-text `name` field — they log `billingPeriod`/`type`
  plus `Object.keys(parsed.data)` (field names only), matching the
  field-names-only invariant.

**Gotchas:**
- Action filter is populated from the live `actions` array returned by the API
  (actual actions for this org), not from a static enum. Entity filter IS static
  (`KNOWN_ENTITIES`). Mixing them up breaks the filter UI.
- Clearing filters resets `page` to 1. If you add a new filter dimension, include
  it in `hasFilters` and reset page in its `onValueChange`.

**Verify changes:** visual via the admin-pages recipe at `/admin/audit-log` ·
check action + entity filters, pagination, and that "details" renders as formatted
key-value pairs not raw JSON.
