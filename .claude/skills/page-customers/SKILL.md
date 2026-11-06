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

**Locations, contacts, tags (M0b):** the detail page has a "Service locations"
card (`src/components/admin/customers/locations-section.tsx`), a "Contacts" card
(`.../contacts-section.tsx`) and a tag picker (`src/components/admin/tag-chip-picker.tsx`,
pure logic `src/lib/admin/tag-picker-logic.ts`) in the header and on each
location row.
- Locations: `GET /api/admin/customers/[id]/locations`;
  `PATCH .../locations/[lid]` with `{ isPrimary: true }` moves the primary flag
  (409 on a lost race). Queries `src/lib/admin/location-queries.ts`;
  `customer_locations.is_primary`.
- Contacts: `GET/POST .../contacts`, `PATCH/DELETE .../contacts/[cid]`. Fields
  name, role, phone, email, optional `locationId`, `isPrimary`. 400 when the
  location is not owned by the customer, 409 `LIMIT_REACHED` at 20 contacts.
  Table `customer_contacts`: name/phone/email encrypted; contacts are NEVER part
  of identity lookup (no blind-index hashes, not used by `upsertCustomerByContact`
  or `pickCustomerMatch`). Queries `src/lib/admin/contact-queries.ts`, types
  `contact-types.ts`.
- Tags: `GET/PUT /api/admin/tags/customer/[id]` and `.../tags/location/[id]`
  (`entity_tags` rows; 400 `UNKNOWN_TAG`, 404). Tag types are configured on the
  Settings > Tags tab.
- Erase and hard-delete both cover contacts and tags (`erasure-queries.ts`,
  `crm-queries.ts`): erase removes contact rows + entity tags; delete cascades.

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
- **Erase reaches every chat session of the customer**, not just the
  directly linked ones: `anonymizeCustomer` takes the union of
  `customer_sessions.customer_id` and `service_requests.session_id` of their
  requests. For those sessions it deletes chat uploads (before their
  messages: `attachments.message_id` FK) and messages, and nulls `metadata`
  (plaintext name/phone/email/address slots), `summary`, `running_summary`,
  `next_steps` and the customer link. An `sms:<phone>` token becomes
  `erased:<session id>` (a later text from that number starts a fresh
  thread); other tokens carry no PII and stay (the FieldPulse import dedupes
  on `fp-import-`). All one `db.batch`. Customers erased before this were
  backfilled by `drizzle/0056_erased_session_scrub.sql`; sessions whose only
  link was the (already nulled) `customer_id` could not be found by it.
- After erase AND hard delete, `invalidateCustomerSearchCache(orgId)`
  (`src/lib/admin/crm-queries.ts`) drops that org's cached search scans on
  this instance; other instances age out within the 5-minute TTL, and every
  cache get/set sweeps all expired entries.
- **Hard delete** (`DELETE /api/admin/customers/[id]`) is ALSO `isSuperAdmin`-only
  — it permanently orphans `invoices.customerId`/`estimates.customerId` (no FK,
  no de-identification), so it is strictly more destructive than erase and must
  never be reachable by a plain admin.
- **Archive** soft-hides the customer (`archivedAt` set); the list hides
  archived by default. Re-contact auto-reactivates (per the confirm dialog copy),
  and the profile's Unarchive button restores it by hand.
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
- The list's own search (decrypt + filter, `src/lib/admin/crm-queries.ts`)
  correctly returns every sibling on a shared contact. Matching is
  `customerMatchesSearch` in `src/lib/admin/customer-search.ts`: phone-shaped
  queries compare DIGITS on both sides (`423-555-0187`, `4235550187`,
  `(423) 555-0187`, `1-423-…` all match). The scan (ciphertext only, never
  plaintext) is cached per instance in a `CustomerScanCache` keyed by org +
  filters and revalidated every search by a one-row md5 fingerprint of the
  filtered set, so a repeat search costs ~1 round trip instead of re-reading
  ~800 KB; counts are aggregated for the returned page ids only. Build keys
  with `customerScanKey` so the org-prefix invalidation keeps matching.
- Erased (`anonymized_at`) rows are hidden with archived ones by default and
  sort last when "Show archived" is on.
- Labels for issue/note/equipment types come from
  `src/lib/admin/display-labels.ts` — never render the raw code or add a
  per-page map. Request-history rows link to `/admin/requests?request=<id>`
  (the requests page opens that sheet).
- Unarchive: `POST /api/admin/customers/[id]` `{ action: "unarchive" }`
  (`unarchiveCustomer`, audit `customer_unarchived`, ids only). The profile
  shows an Archived banner with Unarchive; archiving stays on the profile.
- `POST /api/admin/customers` 409 `CUSTOMER_ALREADY_EXISTS` carries
  `details: { customerId, archived }` (`findNativeContactClash`) so the add
  form can link to the existing (possibly archived) row.
- Phone input is validated by `phoneInputError`
  (`src/lib/admin/customer-validation.ts`) on create and on a CHANGED number in
  `update_contact` (legacy short numbers on file don't block other edits).
  Form save errors go through `saveErrorMessage` (400/409 messages pass, the
  rest become "Couldn't save … Please try again."). Global command search
  (`src/lib/admin/search-queries.ts`) is a separate, pre-existing truncation
  (`SCAN_LIMIT_CUSTOMERS`) — it does not see the whole corpus and is a known,
  unfixed gap, not something this page's code controls.
- `POST /api/admin/customers` (`createCustomer`) still 409s
  `CUSTOMER_ALREADY_EXISTS` for a native-vs-native contact clash, but now
  succeeds when the clash is against an FP-linked row — that is intended (it
  is how an operator records the second business on a shared AP contact), not
  a dedupe regression.

**Verify changes:** `npx vitest run src/lib/admin/customer-search.test.ts
src/lib/admin/display-labels.test.ts src/lib/admin/customer-validation.test.ts
src/lib/admin/customer-display.test.ts src/lib/admin/crm-queries.test.ts
src/lib/admin/crm-equipment-queries.test.ts
src/lib/admin/crm-list-helpers.test.ts src/lib/admin/customer-match.test.ts
src/lib/admin/erasure-queries.test.ts`. Visual via admin-pages recipe.
