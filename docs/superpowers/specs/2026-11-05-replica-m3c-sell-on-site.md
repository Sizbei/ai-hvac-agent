# Replica M3c: Sell on site

Status: v2 (2026-11-06) after adversarial review round 1 (3 critics; log in
`docs/superpowers/specs/2026-11-05-replica-m3c-review-log.md`). Owner: Raymond Chen.
Milestone source: `replica/architecture.md` build order "M3c Sell on site" and the M3c rows of
the F04 tech-loop route table. Builds on M3b Collect (field invoice draft, idempotency keys).

## 1. Goal

On site, the lead technician builds an estimate with up to three options from the pricebook,
switches the phone into a customer view, and the customer picks an option and signs with their
typed name. The estimate is sold. Back in the technician's view the lead chooses to add the sold
option's lines to today's invoice (exactly once, whatever is tapped twice or retried) or to leave
it for the office. Any technician working the job can add a unit of equipment at the customer's
address or replace an old one; the old unit is retired and linked to the new one, and the office
sees it as retired.

Done when (architecture.md): a two-option estimate is built, the customer picks and signs on the
device, the estimate is sold and its lines are on the draft invoice once even when signed and
added twice; a replaced unit shows `retired_at` and `replaced_by`.

Feature rows closed: 129 (equipment add / replace from field), 132 (present estimate with options
on site), 133 (sold items onto the invoice now — today's invoice — or later — the office's
existing "Generate invoice").

**Signature downgrade, accepted.** architecture.md promised "signer name + signature". v1 records
the customer's typed full name (≥ 2 letters, labelled "Type your full name to sign", with the
portal's consent sentence) plus `signed_at`, the selling technician (`sold_by`) and `sold_via =
'field'`. A drawn signature on the estimate is deferred (it needs object storage, which dev lacks,
and the job's drawn signature is captured again on the invoice the same visit). This is weaker
evidence than the portal's remote e-sign (no IP) and is stated as such in the office view
("Signed on site with <technician>").

Non-goals (v1): estimate templates, groupings, add-ons, deposits, discounts, editing or un-selling
an estimate after save (M4 builder); a drawn signature on the estimate; "book later" scheduling of
the sold work (M4 sold-not-booked — "later" here means the office bills it); manual
(non-pricebook) estimate lines; selling a FieldPulse/Housecall Pro estimate; texting the estimate
link from the field; equipment photos, barcode scan, warranty fields; the location-info tab (M3d).

## 2. Surfaces

| surface | who | what |
| --- | --- | --- |
| Job page `Estimates` card (`/tech/jobs/[id]`, directly under the Invoice card) | every technician who can read the job | the request's native estimates, newest first. Row label `Estimate · Nov 6 · 2 options` (creation date, business timezone), status chip `Open` / `Sold` / `Expired` (derived from `expires_at` for open rows) / `Declined`, the sold option's total or the option range. Lead only: `New estimate` (request status `arrived`, `in_progress`, `on_hold`), rows link to the estimate page, sold rows show `On today's invoice` / `Billed by the office` / `Not billed yet`. Helper rows are plain text (not links). Shown on native jobs once the request is `arrived` or later |
| Builder `/tech/jobs/[id]/estimates/new` | lead | see §7.1 |
| Estimate page `/tech/jobs/[id]/estimates/[eid]` | lead | technician view of one estimate (§7.3). Helpers see "Only the lead technician can open this." |
| Customer view (full-screen layer on the estimate page) | the customer, holding the lead's phone | §7.2 — no technician chrome |
| Job page `Equipment` card (after Materials) | technicians with a non-cancelled assignment on a non-cancelled visit of the request | live units of the customer (at the request's location or with no location), `Add equipment`, per unit `Replace`; a bottom sheet with type, make, model, serial, location in home, install date (default today on Replace), and `Describe it` when the type is `Other` |
| Office estimate detail (`/admin/estimates/[id]`) | admin | a field-sold estimate reads "Signed on site with <technician name> · <time>" (`sold_via`/`sold_by`); portal-sold reads as today; office-sold reads "Marked sold by <admin>" from `sold_via='office'` + `sold_by` (old rows keep the `(admin)` reading) |
| Office customer page equipment list | admin | retired units listed last, muted, `Replaced <date>`, linked to the replacement; the equipment count counts live units only |

## 3. Data model

Migration `drizzle/0057_m3c_sell_on_site.sql` (hand-authored, idempotent; journal entry with a
fresh `when`; snapshot copied from the latest snapshot with the changes below, new `id`, `prevId` =
the previous snapshot's id; `drizzle-kit generate` → "No schema changes"; the implementer re-checks
`_journal.json` for the next free number when writing it):

- `invoice_line_items.estimate_line_item_id uuid NULL REFERENCES estimate_line_items(id)` (default
  `NO ACTION`: deleting a billed estimate line fails, which keeps the once-guard armed; an org-delete
  cascade removes both sides in one statement, which NO ACTION allows) + index
  `invoice_line_items_estimate_line_idx`.
- `estimates.sold_by uuid NULL REFERENCES users(id) ON DELETE SET NULL` and `estimates.sold_via text
  NULL CHECK (sold_via IN ('portal','office','field'))` (declared with `check()` in schema.ts).
  Written from now on by the field sell (`'field'`, tech id), `approveEstimate` (`'portal'`, NULL)
  and `markEstimateSold` (`'office'`, the admin id — the admin route passes it). Existing rows stay
  NULL; readers treat NULL as before.

No backfill: the once-guard (§5.3) also treats `invoices.estimate_id = $eid` (set on every office
estimate-born invoice, old and new) as billed.

## 4. Ids and idempotency

Every field write carries an `Idempotency-Key` and runs through `withIdempotency` (M3b §4).
- estimate id = `derivedId(scope, "estimate")`, INSERT `ON CONFLICT (id) DO NOTHING`. Option and line
  ids are `uuidv7()` generated in build order (sortable: every reader orders lines by id); they are
  inserted only when this transaction wrote the estimate row (xmin gate), so a takeover re-run adds
  nothing.
- invoice line ids for a bill are `uuidv7()` in option order. Exactly-once does NOT rely on line ids:
  it is the per-estimate once-guard under the request lock (§5.3).
- equipment id = `derivedId(scope, "equipment")`, `ON CONFLICT (id) DO NOTHING`.
- New stored codes (terminal for that body): `ALREADY_DECIDED`, `ESTIMATE_EXPIRED`, `INVALID_OPTION`,
  `ALREADY_BILLED`, `EQUIPMENT_RETIRED`. Not stored (transient): `NO_CUSTOMER`, `STALE`, `NOT_LEAD`,
  `NOT_ON_SITE`, `INVOICE_LOCKED` stays as M3b has it.

## 5. Writers (`src/lib/tech/estimate-writes.ts`, `src/lib/tech/equipment-writes.ts`)

Money in integer cents; derived values checked against `INT32_MAX` before writing (→ 400
`INVALID_INPUT` "That total is too large.").

### 5.1 Create (`createFieldEstimate`)
Input `{ options: [{ name (1–40, trimmed), lines: [{ pricebookItemId, quantity 1–999 }] (1–40) }] (1–3) }`.
The request must have a customer (409 `NO_CUSTOMER` "Add the customer to this job before quoting." —
erasure scrubs estimates by customer). The server snapshots each line's name, regular unit price and
cost from the org's ACTIVE pricebook item (missing/inactive → 400 `INVALID_INPUT` "One of these items
is no longer in the pricebook."). Option subtotal = Σ line totals; tax = round(subtotal × default tax
bps / 10000); total = subtotal + tax. One batch: `L_req`; the estimate INSERT whose `WHERE`
re-checks lead (`stillLeadSql`) and request status in (`arrived`,`in_progress`,`on_hold`), with
`service_request_id`, `customer_id`, `status='open'`, `expires_at = now() + 30 days`,
`title='Field estimate'`, `total_cents = max(option totals)` (the office's headline rule),
`approval_token_hash = NULL` (the office's regenerate-link mints one on demand); options and lines
gated on the estimate's xmin; tail `SELECT` of `still_lead`. Returns `{ estimateId, created }` (route
201 when created, 200 on a re-run).

### 5.2 Sell (`sellFieldEstimate`)
Input `{ estimateId, optionId, signatureName (2–200 chars, trimmed, ≥ 2 letters, not the literal
"(admin)") }`. One batch, `L_req` → estimate row `FOR NO KEY UPDATE` → `UPDATE estimates SET
status='sold', sold_option_id=$opt, signed_at=now(), signature_name=$name, signature_ip=NULL,
sold_via='field', sold_by=$me, updated_at=now() WHERE id=$eid AND organization_id=$org AND
service_request_id=$rid AND status='open' AND fieldpulse_estimate_id IS NULL AND (expires_at IS NULL
OR expires_at > now()) AND EXISTS (option $opt of $eid in $org) AND stillLead AND request status in
(arrived, in_progress, on_hold) RETURNING id`, then tail reads of the row and `still_lead`. Zero rows
→ map in this order: missing / other request → 404; `status='sold' AND sold_option_id=$opt AND
sold_via='field' AND sold_by=$me AND signature_name=$name` → success `{ created:false }` (a true
replay); `status='expired'` OR (`status='open'` AND past `expires_at`) → 409 `ESTIMATE_EXPIRED` "This
estimate expired. Build a new one."; any other decided state → 409 `ALREADY_DECIDED` "This estimate
was already decided." (same code as the office/public routes); bad option → 400 `INVALID_OPTION`;
not lead → 403 `NOT_LEAD`; wrong status → 409 `NOT_ON_SITE` "Arrive at the job first." Sell never
bills.

### 5.3 Bill (`billSoldEstimate`)
Input `{ estimateId }`, lead, request status in (`arrived`,`in_progress`,`on_hold`,`completed`) (the
invoicing rule). Exactly once PER ESTIMATE.
- **billed(eid)** = `EXISTS (invoice_line_items x JOIN invoices i ON i.id = x.invoice_id WHERE
  x.organization_id = $org AND i.organization_id = $org AND x.estimate_line_item_id IN (lines of
  $eid's sold option) AND i.state <> 'void' AND P_NATIVE)` OR `EXISTS (invoices WHERE
  organization_id = $org AND estimate_id = $eid AND state <> 'void')`.
1. **Pre-check** (read): missing / other request → 404; not sold → 409 `ESTIMATE_NOT_SOLD` "Approve the
   estimate first."; FieldPulse → 409 `MANAGED_EXTERNALLY`; billed(eid) → 409 `ALREADY_BILLED` "This
   estimate is already on an invoice." with `details.invoiceId`. Never touch or create an invoice in
   these cases.
2. **Draft**: the request's newest live native invoice must be a draft (adopt it); an open one → 409
   `INVOICE_LOCKED` "Today's invoice is already finalized. The office will bill this estimate."; none
   → create an UNSEEDED draft (M3b create with `seedMaterials: false` — this path never seeds job
   materials) with id `derivedId(scope,"invoice")`.
3. **One batch**: `L_req` → `L_inv` → INSERT the sold option's lines (`uuidv7` ids in option order,
   name, quantity, unit price, cost, line total, `estimate_line_item_id`) `SELECT … WHERE` the invoice
   is a native draft of this request with `amount_paid_cents = 0` AND stillLead AND request status
   allowed AND the estimate is sold, native, of this request AND NOT billed(eid); then
   `totalsSql(org, inv, taxBps, LINE_GATE)` (the draft-state gate — never `XMIN_GATE`); then tail
   `SELECT`s: rows inserted, `still_lead`, the invoice's state, billed(eid) with its invoice id.
4. **Result**: inserted > 0 → 200 `{ invoiceId, added }`; inserted = 0 → re-map: billed →
   `ALREADY_BILLED`; not lead → `NOT_LEAD`; invoice no longer a draft → `INVOICE_LOCKED`; else
   `STALE`. Lines carry the estimate's snapshot prices; the invoice's tax is recomputed by
   `totalsSql` at the current default rate over all its lines, and the technician's sold view says
   "Tax is recalculated on the invoice."

Two concurrent bills serialize on `L_req`; the second sees billed(eid) and adds nothing.

### 5.4 Office generate guard
`createInvoiceFromSoldEstimate` keeps its estimate-id early return; its batch INSERT's `WHERE` gains
`AND NOT` (the line-link half of billed(eid)) under the existing `L_req`; on 0 rows it re-reads: a
billing invoice exists → `{ ok:true, invoiceId: <it> }`; else the existing `request_has_draft`
answer. Both of its insert paths now write `estimate_line_item_id` on the copied lines.

### 5.5 Decline (`declineFieldEstimate`)
Input `{ estimateId }`, lead. `UPDATE estimates SET status='dismissed', updated_at=now() WHERE …
status='open' AND native AND of this request AND stillLead`; zero rows → `ALREADY_DECIDED` / 404 /
`NOT_LEAD`. Shown as `Declined`. (The office pipeline already excludes dismissed.)

### 5.6 Equipment (`addFieldEquipment`)
Input `{ equipmentType (enum), make?, model?, serialNumber?, locationInHome?, notes? (each trimmed,
≤ 120; `notes` required when type is `other`, labelled "Describe it"), installDate? (YYYY-MM-DD, not
in the future; stored as noon in the business timezone), replacesId? }`.
Gate `techEquipmentPreamble`: session → same-origin → uuid → rate `tech:equipment:write:<user>` →
native job → the caller has a non-cancelled assignment row on a non-cancelled visit of the request
(not merely "readable") → request status in (`arrived`,`in_progress`,`on_hold`,`completed`) — a late
record after completion is allowed — → key. The request's `customer_id` is required (409
`NO_CUSTOMER`); `location_id` = the request's `location_id`. One batch, the assignment check repeated
inside each statement's `WHERE`:
- with `replacesId`: lock the old row (`FOR NO KEY UPDATE`; same org, same customer, its
  `location_id` equals the request's or is NULL, `fieldpulse_asset_id IS NULL`); INSERT the new row
  `WHERE EXISTS (old row, retired_at IS NULL)` `ON CONFLICT (id) DO NOTHING RETURNING id`; `UPDATE`
  old `SET retired_at=now(), replaced_by_equipment_id=$new, updated_at=now() WHERE id=$old AND
  retired_at IS NULL AND EXISTS (new row with xmin = current)`. Zero rows → map: old row's
  `replaced_by = $new` → success (replay); retired by another → 409 `EQUIPMENT_RETIRED` "That unit was
  already replaced."; FieldPulse unit → 409 `MANAGED_EXTERNALLY` "That unit is managed in
  FieldPulse."; missing / other customer or location → 404.
- without: INSERT `ON CONFLICT (id) DO NOTHING`.
Returns `{ equipmentId, created }`.
Office side (same milestone): the customer page lists retired units last with `Replaced <date>`,
linked to the replacement, and counts live units only; chat-intake dedupe
(`recordCustomerEquipment`) ignores retired rows. Erase handling is unchanged (equipment holds no
contact PII).

## 6. Routes (all `force-dynamic`)

Estimate writes use `techWritePreamble` with a per-surface rate bucket and not-on-site copy (an
options argument, e.g. `{ bucket: "estimate", notOnSite: "Arrive at the job first." }`; the invoice
routes keep today's values).

| route | gate | body | success |
| --- | --- | --- | --- |
| `GET /api/tech/jobs/[id]/estimates` | session, readable job, native (409 `MANAGED_EXTERNALLY`), read rate limit | — | `{ estimates: [{ id, label, status (derived), createdAt, expiresAt, soldOptionId, soldVia, billing: 'today' \| 'office' \| 'none', billingInvoiceId, options: [{ id, name, sortOrder, subtotalCents, taxCents, totalCents, lines: [{ id, name, quantity, unitPriceCents, lineTotalCents }] }] }], isLead, canCreate, taxBps, hasOtherSold }` — never cost fields, never `signature_name` |
| `POST /api/tech/jobs/[id]/estimates` | write preamble + key | §5.1 | 201/200 `{ estimateId }` |
| `POST …/estimates/[eid]/sell` | write preamble + key | `{ optionId, signatureName }` | 200 `{ estimateId, status:'sold' }` |
| `POST …/estimates/[eid]/bill` | write preamble (invoicing status rule) + key | `{}` | 200 `{ invoiceId, added }` |
| `POST …/estimates/[eid]/decline` | write preamble + key | `{}` | 200 `{ estimateId, status:'dismissed' }` |
| `GET /api/tech/jobs/[id]/equipment` | session, readable job, native, read rate limit | — | `{ units: [{ id, equipmentType, make, model, serialNumber, locationInHome, notes, installDate }], canWrite }` — live units of the request's customer with `location_id = request.location_id OR location_id IS NULL` (all units when the request has no location) |
| `POST /api/tech/jobs/[id]/equipment` | `techEquipmentPreamble` + key | §5.6 | 201/200 `{ equipmentId }` |

`billing`: `today` when billed through a field invoice line link, `office` when an invoice with
`estimate_id = $eid` exists, else `none`.
Audit (ids/enums only, written only when the write created or changed something, never on a replay):
`estimate_created`, `estimate_sold` (via field), `estimate_billed` (invoiceId, added),
`estimate_declined`, `equipment_added` / `equipment_replaced`. No route queues a message.

## 7. Client

Tech conventions (base primitives, `h-11` targets, sentence case, human errors, shared label helpers
for enums). Keys use the M3b `useIdempotencyKey` reducer and `classifyWriteError`.

### 7.1 Builder
- One option to start, named `Option 1` (a value, not a placeholder). Adding a second renames them
  `Good` / `Better` (a third `Best`) unless the tech already edited a name. `Remove option` when
  there are two or more.
- The active option's name field; its lines (name, quantity stepper 1–999, line total, remove with a
  5-second `Undo`); `Add item` opens the pricebook search through an adapter around the M3b add-item
  sheet (selection is local; an item selected but not yet added is added on Done, never dropped).
- Footer per option: `Subtotal $X · Tax $Y · Total $Z` from `taxBps` (the server recomputes on save).
- `Save estimate` enabled only when valid; otherwise an inline line says what is missing ("Good
  needs an item."). When `hasOtherSold`: "This job already has a sold estimate."
- Draft in `sessionStorage` (`tech:estimate:<rid>:draft`, try/catch), cleared on a successful save;
  `Discard draft` asks first. Save → the estimate page.

### 7.2 Customer view
A full-screen opaque layer (`fixed inset-0 z-50`) over the whole page: the technician header, Guide,
Sign out and location card are covered and unreachable.
- Header: the shop's company name and "Estimate for <customer first name>".
- `Choose an option`: a `role="radiogroup"` of option cards with native radio semantics; nothing
  pre-selected when there are two or more options, the only option pre-selected when there is one.
  Each card: name, the first 3 lines then `Show all N items`, `Subtotal`, `Tax`, `Total` (17 px
  semibold mono).
- Sticky footer: `<Option> · $total` (or "Choose an option"), the input "Type your full name to
  sign" (≥ 2 letters), the portal's consent sentence copied from the public approval form, and
  `Approve` (`h-12`).
- `Approve` opens a confirm "Approve Better for $4,812.00?" with `Approve` / `Go back`.
- Success: "Approved. Thank you, <name>." and one button `Hand back to technician` (closes the
  layer). Errors in the layer are customer-safe only ("Something went wrong. Please hand the phone
  back to your technician."); the technician sees the real reason after hand-back.
- `Not now` (top corner) closes the layer without changes.

### 7.3 Estimate page (technician)
Open: options with totals, `Show to customer`, `Customer declined` (confirm "Mark this estimate as
declined?"). Sold: "Approved · <time> · <option>", then the billing state: `Add to today's invoice` /
`Leave for the office` (closes; the office's Generate invoice bills it later), or `On today's
invoice` + `Open invoice`, or `Billed by the office`. Bill errors in technician copy (§5.3). After an
add: "Added. Get the customer's signature on the invoice before finalizing." (adding lines makes an
earlier invoice signature stale — the M3b freshness rule). Expired / declined: the state, no actions.

### 7.4 Materials overlap
When the request has a sold estimate whose lines include the pricebook item being added as a job
material, the material form warns before saving: "This part is on the sold estimate. Add it only if
it's extra." (the material still saves).

### 7.5 Equipment
Card and sheet per §2; Replace pre-fills the old unit's type and reads "Replacing <make if any>
<type label>"; selects use the shared equipment type labels.

## 8. Tests

Pure: builder validation, option naming, totals with `taxBps`, draft persistence parse, radio
pre-select rule (one option → selected; two+ → none), confirm copy, billing-state mapping,
customer-safe error mapping, equipment form validation (notes for `other`, no future date, noon
storage), label helpers, reason → copy maps.
SQL renders: org predicate counts per statement; both halves of billed(eid); the bill's `LINE_GATE`
totals; the replace CAS with its location and FieldPulse predicates.
Route tests for every gate, code and the 201/200 split.
Integration (`tests/integration/field-estimate.test.ts`, dev DB, throwaway org): (a) create two
options → ordered ids, `total_cents` = max, re-run creates nothing; no customer → NO_CUSTOMER;
(b) sell → sold `sold_via='field'`; same option + name + tech → success; other option or name →
ALREADY_DECIDED; portal-sold same option → ALREADY_DECIDED; (c) bill → lines once with links, totals
= Σ lines + tax; bill again (same key, new key) → ALREADY_BILLED, no new invoice; (d) two concurrent
bills with different keys and NO existing draft → one draft, lines once; (e) office
`createInvoiceFromSoldEstimate` after a field bill → returns the field invoice; (f) office invoice
first (open) → field bill ALREADY_BILLED; after that invoice is paid → still ALREADY_BILLED, no new
draft; (g) live invoice open and the estimate unbilled → INVOICE_LOCKED, no draft created; (h) two
sold estimates on one request bill independently; (i) replace → new live, old `retired_at` +
`replaced_by`; replay → success; a second key on the same old unit → EQUIPMENT_RETIRED; a located
request lists and can replace a NULL-location legacy unit; FieldPulse unit → MANAGED_EXTERNALLY;
(j) tenancy: another org's estimate/equipment id → 404; (k) expired → ESTIMATE_EXPIRED; decline →
dismissed, then sell → ALREADY_DECIDED; (l) bill does not seed job materials.

Browser walk (throwaway org via `createOrgCore`; technician, customer, request, assignment, pricebook
items and a tax rate inserted by SQL — never through the API on the FieldPulse-connected default
org; mint with `MINT_ORG_ID` and assert the token's user and org; queue guard before, zero
`communication_jobs` after; 390×844): arrive → New estimate with two options → Show to customer →
the technician header is covered → choose Better, type a name, Approve, confirm → Hand back → Add to
today's invoice → the invoice page shows the lines once → POST bill again with a new key → 409
ALREADY_BILLED → double-tap Add under a throttled network on a second estimate → still once → add
equipment, replace it → the old unit leaves the card and shows `Replaced` on the office customer
page.

## 9. Docs

`page-tech` (estimates, customer view, billing choice, equipment), `page-estimates` (`sold_via` /
`sold_by`, field estimates, the office generate guard, decline), `page-customers` (retired units),
`replica/features.csv` rows 129/132/133 → yes (133 notes "now = today's invoice; later = the office's
Generate invoice"), `replica/parity.md`, `replica/build-log.md` (S38/S39 rows),
`replica/architecture.md` annotation (signature downgrade), memory.
