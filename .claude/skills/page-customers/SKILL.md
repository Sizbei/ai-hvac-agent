---
name: page-customers
description: Use when working on the /admin/customers or /admin/customers/[id] pages — customer directory with search/filter/view toggle and a full profile with bookings, equipment, memberships, estimates, invoices, notes, and follow-ups.
---

# Customers (/admin/customers + /admin/customers/[id])

**Purpose:** operators browse and manage the customer base; the detail page is
the single source of truth for a customer's contact info, equipment, service
history, open money items, and lifecycle actions (archive, delete, GDPR erase).

**Files:** list page `src/app/admin/(dashboard)/customers/page.tsx` · detail
page `src/app/admin/(dashboard)/customers/[id]/page.tsx` · components
`src/components/admin/customers/customer-people-cards.tsx` (card view),
`src/components/admin/customers/customer-drawer.tsx` (quick-peek sheet),
`src/components/admin/customers/customer-bookings-section.tsx` · dialogs
`src/components/admin/customer-form-dialog.tsx`,
`src/components/admin/customer-edit-dialog.tsx` · hooks
`src/hooks/use-admin-customers.ts` · queries `src/lib/admin/crm-queries.ts`,
`src/lib/admin/crm-equipment-queries.ts`, `src/lib/admin/customer-match.ts`
(pure identity pick order), `src/lib/admin/erasure-queries.ts` (erase +
sibling disclosure) · APIs `src/app/api/admin/customers/route.ts`,
`src/app/api/admin/customers/[id]/route.ts`,
`src/app/api/admin/customers/[id]/erase/route.ts` (GET = sibling disclosure,
POST = erase) · tables `customers`, `customer_notes`, `follow_ups`,
`equipment`, `service_history`, `service_requests`.

**Data flow:** list is server-paginated at 50/page via `useAdminCustomers`
(SWR-style fetch with debounced 300ms search). Filters (property type, customer
type, membership status, FieldPulse-synced, archived) are synced to URL via
`src/hooks/use-url-filter-sync.ts` for shareable links. View mode (cards/list)
is persisted to `localStorage` under key `customers:view`. Detail page fetches
`/api/admin/customers/[id]` on mount; `service_history` rows are from manual
work logs — real booking history is in `service_requests` via
`CustomerBookingsSection`.

**Invariants:**
- **`customers` is one row per FieldPulse customer, not one row per contact.**
  Several unrelated businesses can legitimately share one email/phone (a
  shared accounts-payable contact), so the per-org uniqueness on `emailHash`
  / `phoneHash` applies **only to native rows** (`fieldpulseCustomerId IS
  NULL`) — FP-linked rows are unique on `fieldpulseCustomerId` and are allowed
  to share contact hashes freely. New native customers are still created via
  `upsertCustomerByContact` in `src/lib/admin/crm-queries.ts`, which resolves
  duplicates using the HMAC hashes before inserting — never write a raw
  `INSERT` that bypasses this. Any lookup that can return more than one row
  for a contact resolves through the deterministic pick order in
  `src/lib/admin/customer-match.ts` (`pickCustomerMatch`) rather than a bare
  `LIMIT 1` — do-not-service wins first (fail-closed), then email over phone,
  live over archived, most-recently-active, newest, id as a determinism
  backstop. A resolution is `ambiguous` when more than one live candidate
  survives; ambiguous results still return the do-not-service winner's id, so
  a blocked business can never be bypassed by sharing a contact with an
  unblocked one.
- **Directory headline count grows after the identity backfill runs — this is
  the split, not new business.** A shared-contact FieldPulse customer that
  used to collapse onto one row gets its own row once the backfill claims or
  inserts it; split siblings show identical contact sub-labels on the
  people-cards. Do not treat a jump in the customer count as a data bug.
- **Contact-edit clash check applies only between native rows.** Editing a
  customer's email/phone in `updateCustomerContact`
  (`src/lib/admin/crm-queries.ts`) only runs the clash check — and only
  refuses the edit — when the *edited* row is native
  (`fieldpulseCustomerId IS NULL`); an FP-linked row's email/phone can now be
  recorded on a second, unrelated business without a `contact_conflict`. Two
  *native* rows can still never collide on the same email/phone — that unique
  index is what keeps concurrent chat/voice intake race-safe.
- **GDPR erase never fans out to contact-sharing siblings.** Because a hash
  match now usually means a *different* data subject (the shared-AP-contact
  premise above), erasing every sibling on request would destroy a third
  party's records. Erase stays strictly per row. Before confirming, the UI
  (`src/app/admin/(dashboard)/customers/[id]/page.tsx`) calls
  `GET /api/admin/customers/[id]/erase`, which lists the other rows in the
  org sharing either hash with the target — id plus server-side decrypted
  name only, via `listContactSiblings` in
  `src/lib/admin/erasure-queries.ts` — so the operator can see "this contact
  appears on N rows" and deliberately erase each one that is genuinely the
  same person. `POST` still erases exactly one row.
- **GDPR erase** (`POST /api/admin/customers/[id]/erase`) is gated to
  `isSuperAdmin` — a regular admin cannot call it — plus an `isDemoAccount`
  defense-in-depth check (blocks the public demo account outright, even if it
  somehow held super_admin). The sibling-disclosure `GET` carries the same
  gate (it discloses other customers' names). The UI shows the option in the
  overflow menu but the API enforces the gate. The erased row is retained
  (anonymized), financial history kept, blind-index columns nulled.
- **Hard delete** (`DELETE /api/admin/customers/[id]`) is ALSO `isSuperAdmin`-only
  — it permanently orphans `invoices.customerId`/`estimates.customerId` (no FK,
  no de-identification), so it is strictly more destructive than erase and must
  never be reachable by a plain admin.
- **Archive** soft-hides the customer (`archivedAt` set); the list hides
  archived by default. Re-contact auto-reactivates (per the confirm dialog copy).
- Tenancy: all queries are scoped by `session.organizationId`.
- `service_history` is empty for FieldPulse-imported customers — real history
  lives in `service_requests`; the section is hidden when empty.
- Audit log details contain only field names/ids/counts — no PII.

**Gotchas:**
- Contacts (name/phone/email/address) are encrypted at rest; `crm-queries.ts`
  imports `sanitizeName`, `sanitizePhone`, `sanitizeEmail`, `sanitizeAddress`
  from `src/lib/ai/sanitize-fields` and applies them before encrypting.
- FieldPulse-synced customers show a `SyncPill`; their `fieldpulseCustomerId`
  is non-null. Equipment with `fieldpulseAssetId` is similarly tagged.
- Page-level filter resets to page 1 on any filter/search change via a
  `useEffect` — do not remove that reset effect.
- The list's own search (decrypt + substring filter, `src/lib/admin/crm-queries.ts`)
  correctly returns every sibling on a shared contact. Global command search
  (`src/lib/admin/search-queries.ts`) is a separate, pre-existing truncation
  (`SCAN_LIMIT_CUSTOMERS`) — it does not see the whole corpus and is a known,
  unfixed gap, not something this page's code controls.
- `POST /api/admin/customers` (`createCustomer`) still 409s
  `CUSTOMER_ALREADY_EXISTS` for a native-vs-native contact clash, but now
  succeeds when the clash is against an FP-linked row — that is intended (it
  is how an operator records the second business on a shared AP contact), not
  a dedupe regression.

**Verify changes:** `npx vitest run src/lib/admin/crm-queries.test.ts
src/lib/admin/crm-equipment-queries.test.ts
src/lib/admin/crm-list-helpers.test.ts src/lib/admin/customer-match.test.ts
src/lib/admin/erasure-queries.test.ts`. Visual via admin-pages recipe.
