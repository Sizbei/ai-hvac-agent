# Customers — `/admin/customers` + `/admin/customers/[id]`

## Purpose

Give an admin/dispatcher one place to find a customer (directory) and act on
everything known about them (profile): contact info, equipment, bookings,
money (estimates/invoices/membership), notes, follow-ups, and lifecycle
actions (archive, hard delete, GDPR erase).

## Brainstorm

Ideas for a great version of this page, including what was considered and
rejected:

- **Server-paginated directory with URL-synced filters** — done, keep. Shareable
  filtered links matter more here than saved presets, so no separate "saved
  views" feature was added (YAGNI — URL is already the saved view).
- **Card vs. list view toggle, persisted per-admin** — done, keep (localStorage).
- **Bulk actions (multi-select archive/export)** — considered, rejected: no
  evidence of an admin workflow needing it; the org's customer volume (~2,600,
  `docs/superpowers/plans/2026-07-09-fieldpulse-full-import.md:58`) is fully
  reachable through pagination + filters. Add only if requested.
- **CSV/PII export of the customer list** — considered, rejected: exporting PII
  in bulk needs its own compliance review (the codebase already treats
  cross-tenant export as platform-only, see `purgeOrganization`'s sibling
  export path); out of scope for a directory-page spec.
- **Unified activity timeline (notes+bookings+invoices interleaved)** —
  considered, rejected: the detail page already sections these by type
  (Bookings, Estimates, Invoices, Notes, Follow-ups) matching the copy canon;
  a timeline is a bigger redesign with no requirement evidence. YAGNI.
- **Trigram/searchable-hash index to remove the encrypted-search row cap** —
  considered as the "real" fix for the P2 search-cap gap below; rejected for
  *this* pass: it's a new indexing architecture (denormalized searchable
  tokens), not a page-level change. Left as a documented backlog item.
- **Role-aware overflow menu (hide "Erase data" for non-super-admins)** —
  considered; would remove a confusing 403, but it's cosmetic since the API
  already enforces the gate. P2, not a requirement.
- **Fix the destructive-action privilege ordering** (hard delete vs. GDPR
  erase) — kept in scope; see Gaps/Requirements below, this is a real hole.

## Current state

**List page** `src/app/admin/(dashboard)/customers/page.tsx` — client component;
search box (300 ms debounce, `page.tsx:155-158`), property-type / customer-type
/ membership-status / FieldPulse-synced / archived filters, card↔list toggle
persisted to `localStorage['customers:view']` (`page.tsx:121-127, 180-187`),
filters synced to the URL via `useUrlFilterSync` for shareable links
(`page.tsx:133-152`, `verified`). Page resets to 1 on any filter/search change
(`page.tsx:191-195`, `verified`).

**Data fetch** `useAdminCustomers` (`src/hooks/use-admin-customers.ts:32-112`)
hits `GET /api/admin/customers` with a 60s SWR-style cache
(`use-admin-customers.ts:14`), `verified`.

**List query** `getCustomers` (`src/lib/admin/crm-queries.ts:69-277`):
- No-search browse path: picks the page's customer ids first (indexed
  `created_at` LIMIT/OFFSET), *then* joins/aggregates equipment+request counts
  only for that page (`crm-queries.ts:182-243`) — the LIMIT sits below the
  join, `verified`. Page/count/property-types run via `Promise.all`
  (`crm-queries.ts:233-237`).
- Search path: encrypted `name/phone/email/address` columns aren't
  SQL-filterable, so it aggregates+decrypts the most recent **5,000** matching
  customers (`ORDER BY created_at DESC LIMIT 5000`, `crm-queries.ts:251-259`),
  filters in app code (`crm-queries.ts:262-270`), then paginates the matches.
  Comment explicitly documents the cap mirrors `SCAN_LIMIT_CUSTOMERS` in
  `src/lib/admin/search-queries.ts:28` (1,500 there), `verified`.
- Current known scale: **2,597** FieldPulse-synced customers
  (`docs/superpowers/plans/2026-07-09-fieldpulse-full-import.md:58`,
  `verified` from the import plan doc), well under the 5,000 cap.

**Blind-index dedupe:** `upsertCustomerByContact` (`crm-queries.ts:741-825`)
is the atomic, race-safe path used by chat/booking flows — HMAC hashes
(`emailHash`/`phoneHash`) via `computeContactHashes` (`crm-queries.ts:620-630`),
`ON CONFLICT DO UPDATE` on a per-org partial unique index, reactivating an
archived match. `findCustomerIdByContact` (`crm-queries.ts:643-720`) has a
legacy fallback that decrypts or scans rows with no hash yet.
`createCustomer` (`crm-queries.ts:471-518`, used by the admin "Add customer"
dialog via `POST /api/admin/customers`) is a **different, simpler path**: a
raw `INSERT` that still writes the hash columns, and relies on the unique
constraint + `isUniqueViolation` catch in the route
(`src/app/api/admin/customers/route.ts:120-129`) to surface a clean 409
instead of silently merging — appropriate for an explicit manual add
(an admin typing in a duplicate contact should see a conflict, not a silent
merge), `verified`.

**Detail page** `src/app/admin/(dashboard)/customers/[id]/page.tsx` — contact
info, FieldPulse spillover panel, membership card, portal-link card, equipment
(CRUD), Bookings (from `service_requests` via `CustomerBookingsSection`,
`[id]/page.tsx:512-513`), Service history (native `service_history` rows,
hidden when empty — empty for all FieldPulse imports per
`crm-queries.ts:... service_history` join and the section's own comment
`customer-bookings-section.tsx:14-16`, `verified`), Estimates, Invoices, Notes,
Follow-ups. Overflow menu: Archive / Delete / Erase data (GDPR)
(`[id]/page.tsx:349-380`).

**GDPR erase** `POST /api/admin/customers/[id]/erase/route.ts` gates on
`isSuperAdmin(session)` only (`erase/route.ts:35-37`, `verified`).
`anonymizeCustomer` (`src/lib/admin/erasure-queries.ts:91-389`) scrubs PII,
nulls blind indexes, deletes genuinely-personal child rows (messages, notes,
attachments, follow-up reasons), and explicitly **keeps** invoices/estimates/
service-request `customerId` links de-identified (`erasure-queries.ts:85-90,
218-237`). Audit records counts only (`erasure-queries.ts:372-383`).

**Hard delete** `DELETE /api/admin/customers/[id]/route.ts:439-475` requires
only a valid admin session — **no `isSuperAdmin` check**, `verified`
(no `isSuperAdmin`/`isDemoAccount` import in that file). `deleteCustomer`
(`crm-queries.ts:854-929`) deletes `service_history`, `follow_ups`,
`customer_notes`, `customer_equipment`, nulls `service_requests.customerId`
(preserving the request), then deletes the `customers` row. It does **not**
touch `invoices.customerId` or `estimates.customerId` — both columns are bare
`uuid` with no FK (`src/lib/db/schema.ts:2750`, `verified` — no
`.references()` on that column), so a hard delete leaves those money rows
permanently pointing at a non-existent customer id, with none of
`anonymizeCustomer`'s de-identification care.

**Demo-account defense-in-depth:** `isDemoAccount` is used as an explicit
extra guard in two other destructive-adjacent admin routes —
`src/app/api/admin/invoices/[id]/send-reminder/route.ts:31` and
`src/app/api/admin/conversations/[id]/message/route.ts:37` — but **not** in
the customer erase or delete routes, `verified` (grep of all `isDemoAccount`
call sites). Today the public demo account is protected only because its
seeded role is `"admin"`, not `"super_admin"` (`src/lib/db/seed.ts:53`,
`verified`), which the erase route's `isSuperAdmin` gate happens to block.

**Legacy `notes` field:** `customers.notes` (a single free-text column,
distinct from the structured `customer_notes` list) is accepted by
`CreateCustomerInput.notes`/`UpdateCustomerInput.notes`
(`src/lib/admin/crm-types.ts:123, 187`) and returned by `getCustomerById`
(`crm-queries.ts:408`), but no UI writes or displays it: `CustomerFormDialog`
has no notes field (`src/components/admin/customer-form-dialog.tsx`),
`CustomerEditDialog` has no notes field
(`src/components/admin/customer-edit-dialog.tsx`), and the detail page never
renders `customer.notes` (grep of `[id]/page.tsx` for `customer.notes` — no
match), `verified`.

## Gaps

| Gap | Severity | Evidence |
|---|---|---|
| Hard delete (`DELETE /api/admin/customers/[id]`) requires only a plain admin session, while the softer GDPR erase requires `super_admin` — yet hard delete is *more* destructive to money data (orphans `invoices.customerId`/`estimates.customerId` permanently, no FK, no de-identification) than erase (which keeps those links de-identified). | P1 | `src/app/api/admin/customers/[id]/route.ts:439-475` (no role check) vs. `src/app/api/admin/customers/[id]/erase/route.ts:35-37` (`isSuperAdmin`); `src/lib/db/schema.ts:2750` (no FK on `invoices.customerId`); `src/lib/admin/erasure-queries.ts:218-237` (erase keeps links) |
| GDPR erase has no `isDemoAccount` defense-in-depth guard, unlike two sibling destructive-adjacent routes. Protection today is incidental (demo seed role happens to be `"admin"`). A future role-management bug or manual promotion silently opens real erasure on the public demo. | P1 | `src/app/api/admin/customers/[id]/erase/route.ts` (no `isDemoAccount` import); `src/app/api/admin/invoices/[id]/send-reminder/route.ts:31`, `src/app/api/admin/conversations/[id]/message/route.ts:37` (the pattern elsewhere); `src/lib/db/seed.ts:53` (`role: "admin"`) |
| Encrypted-column search caps the scan at the 5,000 most-recently-created customers; older customers become silently unsearchable past that point with no error or indicator. Currently safe (2,597 of 5,000) but latent. | P2 | `src/lib/admin/crm-queries.ts:251-259` |
| `customers.notes` legacy field is writable via API but has no UI to set or view it — dead surface, confusing alongside the fully-functional `customer_notes` list. | P2 | `src/lib/admin/crm-types.ts:123,187`; `src/components/admin/customer-form-dialog.tsx`; `src/components/admin/customer-edit-dialog.tsx`; `[id]/page.tsx` (no render site) |
| "Erase data (GDPR)" is visible in every admin's overflow menu regardless of role; a non-super-admin sees a network-error-shaped 403 instead of the option being absent/disabled. | P2 | `.claude/skills/page-customers/SKILL.md:41-44`; `[id]/page.tsx:370-379` |

## Requirements

- **Rcustomers-1**: `DELETE /api/admin/customers/[id]` must require
  `isSuperAdmin(session)`, matching the GDPR-erase privilege level.
  *Acceptance:* a session with role `admin` (not `super_admin`) calling
  `DELETE /api/admin/customers/[id]` receives `403 FORBIDDEN`; an existing
  `super_admin` session's delete still succeeds and behaves exactly as today
  (equipment/notes/follow-ups/service_history deleted, `service_requests`
  detached). A test in `crm-queries.test.ts` or a new route test covers both
  cases.
- **Rcustomers-2**: `POST /api/admin/customers/[id]/erase` must add an
  `isDemoAccount(session)` check (mirroring
  `send-reminder/route.ts:31`/`conversations/[id]/message/route.ts:37`) that
  returns `403 FORBIDDEN` even for a session that somehow holds
  `super_admin`. *Acceptance:* a session with `email === "admin@demo-hvac.com"`
  gets `403` from the erase route regardless of role; a non-demo super_admin
  session is unaffected.

(P2 gaps are recorded above and in `README.md`'s backlog table; not built in
this pass per the severity gate.)

## Non-goals

- Bulk actions (multi-select archive/export) — no evidenced workflow need at
  current customer volume; directory pagination+filters already cover it.
- CSV/PII export of the customer list — needs its own compliance design,
  distinct from a single-page target-state spec.
- A new searchable-index architecture to remove the 5,000-row search cap —
  real fix for the P2 gap, but an indexing-layer change, not a page change.
  Left as backlog.
- Deprecating/removing the legacy `customers.notes` column — a schema
  decision with call sites outside this page; flagged as a gap, not resolved
  here.
- Redesigning the detail page into a unified activity timeline — current
  section-per-type layout matches the copy canon and has no requirement
  evidence for change.
- Hiding the "Erase data" menu item by role client-side — cosmetic fix for a
  P2, not required since the API already enforces the gate.

## Invariants

- **Tenancy**: every customer/equipment/note/follow-up query is scoped by
  `session.organizationId` via `withTenant` — prevents cross-org data leakage
  (repo-wide invariant, `AGENTS.md`).
- **Blind-index dedupe**: chat/booking-created customers go through
  `upsertCustomerByContact`; never write a raw `INSERT` on that path — it
  would race under concurrency (TOCTOU) and could create duplicate customers.
- **Admin-created customers use `createCustomer`** (raw insert + 409 on
  conflict) deliberately, not `upsertCustomerByContact` — an explicit manual
  add should surface a conflict to the admin, not silently merge into an
  existing customer.
- **GDPR erase is terminal and super_admin-gated**: PII is scrubbed, blind
  indexes nulled (contact becomes un-re-resolvable), financial history is
  KEPT de-identified. Never make erase reversible or let a non-super-admin
  trigger it — this is the regulatory basis for the feature.
- **`service_history` is empty for FieldPulse imports**; real booking history
  lives in `service_requests` via `CustomerBookingsSection`. Do not resurrect
  the native Service History card as a primary history source — it's a
  secondary/manual-log card, correctly hidden when empty.
- **Archive reactivation**: a rebooking customer is auto-reactivated
  (`archivedAt` cleared) by `upsertCustomerByContact` — do not require a
  manual un-archive for a returning customer.
- **Audit log details are field names/ids/counts only, never PII values**
  (repo-wide invariant; `logAudit` calls in this page's routes follow it).
- **neon-http has no interactive transactions**: `deleteCustomer` and
  `anonymizeCustomer` both use `db.batch()` for their multi-statement atomic
  writes — never introduce `db.transaction()` on this page's write paths.
- **Demo account** (`admin@demo-hvac.com`) must never be able to erase or
  (after Rcustomers-1) hard-delete real customer data — currently true only
  incidentally (role); Rcustomers-2 makes it true by design.

## Verification

- `npx tsc --noEmit` → 0.
- `npx eslint src/app/api/admin/customers/[id]/route.ts src/app/api/admin/customers/[id]/erase/route.ts` (plus any other changed files) → 0 errors.
- `npx vitest run src/lib/admin/crm-queries.test.ts src/lib/admin/crm-equipment-queries.test.ts src/lib/admin/crm-list-helpers.test.ts` → must not drop below the live baseline captured at program start (`README.md`).
- New coverage for Rcustomers-1/Rcustomers-2: a route- or query-level test
  asserting `DELETE .../[id]` 403s for a non-super-admin session and the
  erase route 403s for `admin@demo-hvac.com` regardless of role.
- Visual: `node scripts/agent/screenshot-page.mjs /admin/customers` and
  `/admin/customers/[id]` (a real id) per the `admin-pages` recipe — confirm
  no regression to the directory or profile layout.
- Manual/API check: as a plain-admin dev session, attempt
  `DELETE /api/admin/customers/[id]` and confirm `403`; as the demo session,
  attempt `POST /api/admin/customers/[id]/erase` and confirm `403`.
