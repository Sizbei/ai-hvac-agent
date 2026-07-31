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
`src/lib/admin/crm-equipment-queries.ts` · APIs
`src/app/api/admin/customers/route.ts`,
`src/app/api/admin/customers/[id]/route.ts`,
`src/app/api/admin/customers/[id]/erase/route.ts` · tables `customers`,
`customer_notes`, `follow_ups`, `equipment`, `service_history`,
`service_requests`.

**Data flow:** list is server-paginated at 50/page via `useAdminCustomers`
(SWR-style fetch with debounced 300ms search). Filters (property type, customer
type, membership status, FieldPulse-synced, archived) are synced to URL via
`src/hooks/use-url-filter-sync.ts` for shareable links. View mode (cards/list)
is persisted to `localStorage` under key `customers:view`. Detail page fetches
`/api/admin/customers/[id]` on mount; `service_history` rows are from manual
work logs — real booking history is in `service_requests` via
`CustomerBookingsSection`.

**Invariants:**
- **Blind-index dedupe:** new customers are created via `upsertCustomerByContact`
  in `src/lib/admin/crm-queries.ts` which resolves duplicates using HMAC hashes
  (`emailHash`, `phoneHash`) before inserting. Never write a raw `INSERT` that
  bypasses this.
- **GDPR erase** (`POST /api/admin/customers/[id]/erase`) is gated to
  `isSuperAdmin` — a regular admin cannot call it. The UI shows the option in
  the overflow menu but the API enforces the gate. The erased row is retained
  (anonymized), financial history kept, blind-index columns nulled.
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

**Verify changes:** `npx vitest run src/lib/admin/crm-queries.test.ts
src/lib/admin/crm-equipment-queries.test.ts
src/lib/admin/crm-list-helpers.test.ts`. Visual via admin-pages recipe.
