# Replica M3c: Sell on site

Status: v4 FINAL (2026-11-06) after adversarial review rounds 1–3 (6 critics; log in
`docs/superpowers/specs/2026-11-05-replica-m3c-review-log.md`). Owner: Raymond Chen.
Milestone source: `replica/architecture.md` build order "M3c Sell on site" and the M3c rows of the
F04 tech-loop route table. Builds on M3b Collect (field invoice draft, idempotency keys).

## 1. Goal

On site, the lead technician builds an estimate with up to three options from the pricebook, switches
the phone into a customer view, and the customer picks an option and signs with their typed name. The
estimate is sold. Back in the technician's view the lead adds the sold option's lines to the job's
invoice (exactly once, whatever is tapped twice or retried), or leaves it for the office to bill. Any
technician working the job can add a unit of equipment at the customer's address or replace an old
one; the old unit is retired and linked to the new one, and the office sees it as retired.

Done when (architecture.md): a two-option estimate is built, the customer picks and signs on the
device, the estimate is sold and its lines are on the draft invoice once even when signed and added
twice; a replaced unit shows `retired_at` and `replaced_by`.

Feature rows closed: 129 (equipment add / replace from field), 132 (present estimate with options on
site), 133 (sold items onto the invoice now — the job's invoice — or later — the office's existing
Generate invoice, with a new "Sold, not invoiced" filter so the office sees what is waiting).

**Signature downgrade, accepted.** architecture.md promised "signer name + signature". v1 records the
customer's typed full name (≥ 2 characters, the portal's rule and wording) plus `signed_at`, the
selling technician (`sold_by`) and `sold_via = 'field'`. A drawn signature on the estimate is deferred
(object storage; dev lacks it; the job's drawn signature is captured on the invoice the same visit).
This is weaker evidence than the portal's remote e-sign (no IP) and the office view says so ("Signed
on site with <technician>").

Non-goals (v1): estimate templates, groupings, add-ons, deposits, discounts, editing or un-selling an
estimate after save (M4 builder); a drawn signature on the estimate; scheduling the sold work for a
later visit (M4 sold-not-booked); manual (non-pricebook) estimate lines; selling a FieldPulse/Housecall
Pro estimate; texting the estimate link from the field; equipment photos, barcode scan, warranty
fields; the location-info tab (M3d); fixing name capture order in chat (unrelated).

## 2. Surfaces

| surface | who | what |
| --- | --- | --- |
| Job page `Estimates` card (`/tech/jobs/[id]`, rendered right after the job summary in `tech-job-detail-client.tsx`, refetched when a status tap changes the request status) | every technician who can read the job, native jobs, request `arrived` or later | the request's native estimates, newest first. Row label `Estimate · Nov 6 · 2 options` (creation date, business timezone). Status chip `Open` / `Sold` / `Expired` (open rows past `expires_at`) / `Declined`. The sold option's total or the option range. Sold rows show `On the job's invoice`, `Billed by the office` or `Not invoiced yet`. Lead: rows link to the estimate page; `New estimate` when `canCreate`, else the reason line (`createBlockedReason`). Helpers: rows are plain text; a sold row also shows the option name |
| Builder `/tech/jobs/[id]/estimates/new` | lead | §7.1 |
| Estimate page `/tech/jobs/[id]/estimates/[eid]` | lead | §7.3; helpers see "Only the lead technician can open this." |
| Customer view (`#customer` on the estimate page) | the customer, holding the lead's phone | §7.2 |
| Job page `Equipment` card (after Materials) | technicians with a non-cancelled assignment on a non-cancelled visit of the request | §7.5 |
| Office estimate detail (`/admin/estimates/[id]`) | admin | field-sold: "Signed on site with <technician name> · <time>"; office-sold: "Marked sold by <admin name>" when `sold_via='office'`; portal and old rows as today |
| Office estimates list | admin | a new `Sold, not invoiced` filter: native estimates with `status='sold'`, no invoice of any state with `estimate_id = $eid`, and not job-billed (the job half of billed(eid)) — consistent with Generate, which treats a voided office invoice as handled |
| Office customer page equipment list | admin | retired units listed last, muted, `Replaced <date>`, with a link to the replacement when it still exists; the equipment count counts live units only |

## 3. Data model

Migration `drizzle/0057_m3c_sell_on_site.sql` (hand-authored, idempotent; journal entry with a fresh
`when`; snapshot copied from the latest snapshot with the changes below, new `id`, `prevId` = the
previous snapshot's id; `drizzle-kit generate` → "No schema changes"; re-check `_journal.json` for the
next free number when writing it):

- `invoice_line_items.estimate_line_item_id uuid NULL REFERENCES estimate_line_items(id)` (default `NO
  ACTION`: deleting a billed estimate line fails, keeping the once-guard armed; an org-delete cascade
  removes both sides in one statement, which NO ACTION allows) + index
  `invoice_line_items_estimate_line_idx`.
- `estimates.sold_by uuid NULL REFERENCES users(id) ON DELETE SET NULL` and `estimates.sold_via text NULL
  CHECK (sold_via IN ('portal','office','field'))` (declared with `check()` in schema.ts). Written by
  the field sell (`'field'`, tech id), `approveEstimate` (`'portal'`, NULL) and `markEstimateSold`
  (`'office'`, the admin id passed by the admin route). Existing rows stay NULL; readers treat NULL as
  before.

No backfill: billed(eid) (§5.3) also counts `invoices.estimate_id = $eid`, which every office
estimate-born invoice (old and new) carries.

## 4. Ids and idempotency

Every field write carries an `Idempotency-Key` and runs through `withIdempotency` (M3b §4).
- estimate id = `derivedId(scope, "estimate")`, INSERT `ON CONFLICT (id) DO NOTHING`; option and line
  ids are `uuidv7()` in build order (readers order lines by id), inserted only when this transaction
  wrote the estimate row (xmin gate). The builder's key intent id is `estimate:create`, persisted by
  `useIdempotencyKey`, so a reload re-sends the same key; editing the draft after an unknown result
  re-sends the old body first (M3b rule).
- invoice line ids for a bill are `uuidv7()` in option order; exactly-once is the per-estimate guard
  under the request lock (§5.3), not the ids.
- equipment id = `derivedId(scope, "equipment")`, `ON CONFLICT (id) DO NOTHING`.
- Stored codes (terminal for that body), added: `ALREADY_DECIDED`, `ESTIMATE_EXPIRED`, `INVALID_OPTION`,
  `ALREADY_BILLED`, `NO_LINES`, `EQUIPMENT_RETIRED`. `INVOICE_LOCKED` remains stored (M3b). Not stored:
  `NO_CUSTOMER`, `STALE`, `NOT_LEAD`, `NOT_ON_SITE`, `JOB_CLOSED`, `ESTIMATE_NOT_SOLD`,
  `MANAGED_EXTERNALLY`, `NOT_FOUND`.

## 5. Writers (`src/lib/tech/estimate-writes.ts`, `src/lib/tech/equipment-writes.ts`)

Money in integer cents. Every write that sums money first checks the sum (including the existing
draft's totals for a bill) against `INT32_MAX` → 400 `INVALID_INPUT` "That total is too large."

### 5.1 Create (`createFieldEstimate`)
Input `{ options: [{ name (1–40, trimmed, unique case-insensitively within the estimate), lines: [{
pricebookItemId, quantity 1–999 }] (1–40) }] (1–3) }`. Preconditions (also exposed as `canCreate` /
`createBlockedReason` in the GET): lead, native, request status in (`arrived`,`in_progress`,`on_hold`),
request has a customer. Server snapshots each line's name, regular unit price and cost from the org's
ACTIVE pricebook item (missing/inactive → 400 `INVALID_INPUT` "One of these items is no longer in the
pricebook."). Option subtotal = Σ line totals; tax = round(subtotal × default tax bps / 10000); total
= subtotal + tax. One batch: `L_req`; estimate INSERT whose `WHERE` re-checks lead, status and
`service_requests.customer_id = $cust` (the customer read before the batch), with `service_request_id`,
`customer_id`, `status='open'`, `expires_at = now() + 30 days`, `title='Field estimate'`, `total_cents =
max(option totals)`, `approval_token_hash = NULL`; options and lines gated on the estimate's xmin; tail
`SELECT`s of `still_lead`, status and customer. Zero rows → first, an estimate row with this id already exists → 200 `{ created:false }` (re-run); else `NOT_LEAD` / `NOT_ON_SITE` ("Arrive at the
job first.") / `JOB_CLOSED` ("This job is closed.") / `NO_CUSTOMER` ("Ask the office to add the
customer before quoting.") / `STALE`. Returns `{ estimateId, created }` (201 created / 200 re-run).

### 5.2 Sell (`sellFieldEstimate`)
Input `{ estimateId, optionId, signatureName (trimmed, 2–200 characters, not the literal "(admin)") }`.
One batch, `L_req` → estimate row `FOR NO KEY UPDATE` → `UPDATE estimates SET status='sold',
sold_option_id=$opt, signed_at=now(), signature_name=$name, signature_ip=NULL, sold_via='field',
sold_by=$me, updated_at=now() WHERE id=$eid AND organization_id=$org AND service_request_id=$rid AND
status='open' AND fieldpulse_estimate_id IS NULL AND (expires_at IS NULL OR expires_at > now()) AND
EXISTS (option $opt of $eid in $org) AND stillLead AND request status in (arrived, in_progress,
on_hold) RETURNING id`; tail reads of the row and `still_lead`. Zero rows → in order: missing / other
request → 404; `status='sold' AND sold_option_id=$opt AND sold_via='field' AND sold_by=$me` → success
`{ created:false }` (a replay, whatever the typed name); `status='expired'` OR (`open` AND past
`expires_at`) → 409 `ESTIMATE_EXPIRED` "This estimate expired. Build a new one."; any other decided
state → 409 `ALREADY_DECIDED` "This estimate was already decided."; bad option → 400 `INVALID_OPTION`;
not lead → 403 `NOT_LEAD`; status → `NOT_ON_SITE` / `JOB_CLOSED`. Sell never bills.

### 5.3 Bill (`billSoldEstimate`, in `src/lib/admin/invoice-field-writes.ts` next to the M3b writers so it shares `LINE_GATE`)
Input `{ estimateId }`, lead, request status in (`arrived`,`in_progress`,`on_hold`,`completed`).
Exactly once PER ESTIMATE.
- **billed(eid)** = `EXISTS (invoices WHERE organization_id = $org AND estimate_id = $eid AND state <>
  'void')` (the **office** half) OR `EXISTS (invoice_line_items x JOIN invoices i ON i.id = x.invoice_id
  WHERE x.organization_id = $org AND i.organization_id = $org AND i.estimate_id IS NULL AND i.state <>
  'void' AND P_NATIVE AND x.estimate_line_item_id IN (lines of $eid's sold option))` (the **job**
  half).
1. **Pre-check** (read): missing / other request → 404; not sold → 409 `ESTIMATE_NOT_SOLD` "Approve
   the estimate first."; FieldPulse → 409 `MANAGED_EXTERNALLY`; the sold option has no lines → 409
   `NO_LINES` "This estimate has no items."; billed(eid) → 409 `ALREADY_BILLED` "This estimate is
   already on an invoice." with `details.invoiceId`. No invoice is touched or created in these cases.
2. **Draft**: call M3b `createInvoiceFromJob` with id `derivedId(scope,"invoice")` — it adopts the
   request's live native invoice or creates a draft seeded with the job's unbilled materials (the
   normal M3b rule, so parts logged before the sale are billed). When the job's earlier invoice is
   paid and no live invoice exists, this creates a new draft and the sale goes on that second invoice
   (accepted: it is new work). Map its result, re-checking billed(eid) first in every non-draft case
   (→ `ALREADY_BILLED`): `draft` with `amount_paid_cents = 0` → continue; `draft` with a payment or
   `open` → 409 `INVOICE_LOCKED` "The job's invoice is already finalized. The office will bill this
   estimate." (stored: terminal for this invoice); `paid` / `refunded` (the derived-id invoice is
   history), `invoice_voided`, `stale` (this includes a deadlock) → 409 `STALE` "This job changed. Try
   again." (not stored); `external_invoice` / `managed_externally` → 409 `MANAGED_EXTERNALLY`;
   `not_lead` → 403 `NOT_LEAD`. Accepted: if step 3 then fails, the created draft stays with the job's
   materials (it is the job's invoice anyway).
3. **One batch**: `L_req` → `L_inv` → INSERT the sold option's lines (`uuidv7` ids in line order, name,
   quantity, unit price, cost, line total, `estimate_line_item_id`) `SELECT … WHERE` the invoice is a
   native draft of this request with `amount_paid_cents = 0` AND stillLead AND request status allowed
   AND the estimate is sold, native, of this request AND NOT billed(eid); then `totalsSql(org, inv,
   taxBps, LINE_GATE)`; then tail `SELECT`s: rows inserted, `still_lead`, the invoice's state, billed(eid)
   with its invoice id.
4. **Result**: inserted > 0 → 200 `{ invoiceId, added }`; else billed → `ALREADY_BILLED` (this also
   answers a takeover re-run of the caller's own success; the client renders `ALREADY_BILLED` as the
   billed state after a refetch, never as an error); not lead → `NOT_LEAD`; the invoice is still a
   draft but has a payment, or is open → `INVOICE_LOCKED`; void or anything else → `STALE`. A numeric
   overflow (Postgres 22003) anywhere in the batch is caught → 400 `INVALID_INPUT` "That total is too
   large." Lines carry the estimate's snapshot prices; the invoice's tax is
   recomputed by `totalsSql` at the current default rate over all its lines.
- Linked lines are protected: M3b `removeInvoiceLine` refuses a line with `estimate_line_item_id` set
  (409 `FROM_ESTIMATE` "This item came from the approved estimate. Ask the office to change it."), so
  billed(eid) never covers a partial sale. The tech invoice view marks such lines (`fromEstimate:
  true`) and hides their Remove control; the client copy map includes `FROM_ESTIMATE`.
- The tech invoice view's `pendingWrite` check is narrowed to the invoice and signature routes
  (`/api/tech/jobs/<rid>/invoice%` and `/api/tech/jobs/<rid>/signature`), so estimate and equipment
  keys never mark the invoice page as busy.
Two concurrent bills serialize on `L_req`; the second sees billed(eid) and adds nothing.

### 5.4 Office generate guard
`createInvoiceFromSoldEstimate` keeps its estimate-id early return (which also returns a voided office
invoice: the unique index on `estimate_id` means a voided office invoice ends office billing of that
estimate — the office handled it); its batch INSERT's `WHERE` gains
`AND NOT` (the job half of billed(eid)) under the existing `L_req`; on 0 rows it re-reads: a billing
invoice exists → `{ ok:true, invoiceId }`; else the existing `request_has_draft` answer. Both insert
paths copy lines ordered by the estimate line's id, with `uuidv7()` ids, and write
`estimate_line_item_id`.

### 5.5 Decline (`declineFieldEstimate`)
Input `{ estimateId }`, lead. `UPDATE estimates SET status='dismissed', updated_at=now() WHERE …
status='open' AND native AND of this request AND stillLead`; zero rows → `status='dismissed'` → success
`{ created:false }` (replay); else `ALREADY_DECIDED` / 404 / `NOT_LEAD`. Shown as `Declined`. Allowed on
any open native estimate of the request; when the estimate has an approval link
(`approval_token_hash IS NOT NULL`) the estimate page notes "A link was also sent to the customer."

### 5.6 Equipment (`addFieldEquipment`)
Input `{ equipmentType (enum), make?, model?, serialNumber?, locationInHome?, notes? (each trimmed, ≤
120; `notes` required when type is `other`, labelled "Describe it"), installDate? (YYYY-MM-DD, not in
the future; stored as noon in the business timezone), replacesId? }`.
Gate `techEquipmentPreamble`: session → same-origin → uuid → rate `tech:equipment:write:<user>` →
native job → the caller has a non-cancelled assignment row on a non-cancelled visit of the request →
request status in (`arrived`,`in_progress`,`on_hold`,`completed`) → key. The request's `customer_id` is
required (409 `NO_CUSTOMER` "Ask the office to add the customer first."). `location_id` = the request's.
**Location rule** (shared by the GET and every write predicate): when the request has a location, units
with that location or with no location; when it has none, any unit of the customer. One batch, with the
assignment check and `service_requests.customer_id = $cust` repeated in each statement's `WHERE`:
- with `replacesId`: lock the old row (`FOR NO KEY UPDATE`; same org, same customer, the location rule,
  `fieldpulse_asset_id IS NULL`); INSERT the new row `WHERE EXISTS (old row, retired_at IS NULL)` `ON
  CONFLICT (id) DO NOTHING RETURNING id`; `UPDATE` old `SET retired_at=now(),
  replaced_by_equipment_id=$new, updated_at=now() WHERE id=$old AND retired_at IS NULL AND EXISTS (new
  row with xmin = current)`. Zero rows → old row's `replaced_by = $new` → success (replay); retired by
  another → 409 `EQUIPMENT_RETIRED` "That unit was already replaced."; FieldPulse unit → 409
  `MANAGED_EXTERNALLY` "That unit is managed in FieldPulse."; else 404.
- without: INSERT `ON CONFLICT (id) DO NOTHING`.
Returns `{ equipmentId, created }`.
Office side: the customer page lists retired units last with `Replaced <date>` (null-safe link to the
replacement) and counts live units only; chat-intake dedupe (`recordCustomerEquipment`) ignores retired
rows. Erase handling is unchanged (equipment holds no contact PII). Known gap, stated: `deleteCustomer`
leaves estimates (and a field-typed name) in place, as it does for portal-signed estimates today.

## 6. Routes (all `force-dynamic`)

`techWritePreamble` gains an options argument `{ bucket, statuses, beforeCopy, closedCopy }`: a status
of `completed` or `cancelled` not in `statuses` gets `closedCopy` (409 `JOB_CLOSED`); any other status
not in `statuses` (`pending`, `assigned`, `scheduled`, `en_route`) gets `beforeCopy` (409
`NOT_ON_SITE`). The invoice routes keep today's values (bucket `invoice`, statuses
arrived/in_progress/on_hold/completed, both copies "Arrive at the job before invoicing."). Estimate create/sell/decline: bucket `estimate`, statuses
arrived/in_progress/on_hold, "Arrive at the job first." / "This job is closed." Bill: the invoicing
statuses.

| route | gate | body | success |
| --- | --- | --- | --- |
| `GET /api/tech/jobs/[id]/estimates` | session, readable job, native (409 `MANAGED_EXTERNALLY`), read rate limit | — | `{ companyName (org settings; null when unset), customerDisplayName (the request's decrypted customer name; null when none), isLead, canCreate, createBlockedReason, taxBps, hasOtherSold, jobInvoice: { id, state, hasPayment } or null (the request's newest live native invoice), estimates: [{ id, label, status (derived), createdAt, expiresAt, signedAt, soldOptionId, soldVia, soldByMe, hasApprovalLink, billing: 'office' \| 'job' \| 'none', billingInvoiceId, options: [{ id, name, sortOrder, subtotalCents, taxCents, totalCents, lines: [{ id, pricebookItemId, name, quantity, unitPriceCents, lineTotalCents }] }] }] }` — never cost fields, never `signature_name`. `billing` = `office` when the office half of billed(eid) holds, else `job` when the job half holds, else `none` |
| `POST /api/tech/jobs/[id]/estimates` | write preamble + key | §5.1 | 201/200 `{ estimateId }` |
| `POST …/estimates/[eid]/sell` | write preamble + key | `{ optionId, signatureName }` | 200 `{ estimateId, status:'sold' }` |
| `POST …/estimates/[eid]/bill` | write preamble (invoicing statuses) + key | `{}` | 200 `{ invoiceId, added }` |
| `POST …/estimates/[eid]/decline` | write preamble + key | `{}` | 200 `{ estimateId, status:'dismissed' }` |
| `GET /api/tech/jobs/[id]/equipment` | session, readable job, native, read rate limit | — | `{ units: [{ id, equipmentType, make, model, serialNumber, locationInHome, notes, installDate, managedExternally }], canWrite }` — live units by the location rule |
| `POST /api/tech/jobs/[id]/equipment` | `techEquipmentPreamble` + key | §5.6 | 201/200 `{ equipmentId }` |

Audit (ids/enums only, only when a write created or changed something, never on a replay):
`estimate_created`, `estimate_sold` (via field), `estimate_billed` (invoiceId, added),
`estimate_declined`, `equipment_added` / `equipment_replaced`. No route queues a message.

## 7. Client

Tech conventions (base primitives, `h-11` targets, sentence case, human errors, shared label helpers).
Keys use the M3b `useIdempotencyKey` reducer and `classifyWriteError`, with intent ids
`estimate:create`, `estimate:sell:<eid>`, `estimate:bill:<eid>`, `estimate:decline:<eid>`,
`equipment:add`, `equipment:replace:<unitId>` in their own storage key (`tech:estimate:<rid>:intents`,
not the M3b invoice key); a reload during `Approving…` resends the persisted sell intent before the page
unlocks (M3b rule). The estimate page and the job page refetch the estimates GET on mount, after every write, when the customer view closes, and on
`visibilitychange` → visible.

### 7.1 Builder
- **Naming** (pure helper `nextOptionNames`): each option has an `edited` flag. Start: one option
  `Option 1`. On add: if no option is edited, rename all by position to `Good`/`Better`/`Best` (two
  options → `Good`, `Better`); else the new option is `Option N` (N = its position). On remove: if no
  remaining option is edited, rename by position the same way (one left → `Option 1`). Names must be
  unique (inline "Two options have the same name.").
- `Remove option` (two or more) with a 5-second `Undo`; lines: name, quantity stepper 1–999, line total,
  remove with a 5-second `Undo`.
- `Add item` opens the M3b add-item sheet with a local `onAdd`. The sheet changes for both uses:
  `Done` adds the pending selected item first (with its quantity) instead of dropping it; pure test.
- Footer per option: `Subtotal $X · Tax $Y · Total $Z` from `taxBps`.
- `Save estimate` enabled only when valid; otherwise an inline line says what is missing ("Better
  needs an item."). When `hasOtherSold`: "This job already has a sold estimate."
- Draft in `sessionStorage` (`tech:estimate:<rid>:draft`, try/catch), cleared on a successful save;
  `Discard draft` asks first. Save → the estimate page.

### 7.2 Customer view
Opened by `Show to customer` (open estimates, request `arrived`/`in_progress`/`on_hold`): it pushes a
history entry with `#customer` and renders an opaque full-screen layer (`fixed inset-0 z-50`) over the
technician header, Guide, Sign out and location card. **Back** (gesture, system back, browser back)
pops to the estimate page with the layer closed — never further. A **reload** with `#customer` in the
URL reopens the layer only while the estimate is still open and the request allows selling; otherwise
the hash is stripped with `history.replaceState`. It uses `history.pushState` / `popstate` directly
(Next 16 copies its own router state into pushed entries, so Back restores the same page); a layer
opened by a reload has no earlier entry, so closing it strips the hash with `replaceState` instead of
going back. `Not now` (top corner) shows the hand-back screen.
- Header: the company name (omitted when null) and `Estimate for <customerDisplayName>` (or `Your
  estimate` when null).
- `Choose an option`: a `role="radiogroup"` of option cards (native radios inside labels; nothing
  pre-selected with two or more options, the only option pre-selected). Each card: name, the first 3
  lines, `Subtotal`, `Tax`, `Total` (17 px semibold mono); `Show all N items` sits outside the radio
  label.
- In the scroll flow under the options: the input "Type your full name to sign", the portal's sentence
  "By typing your name and approving, you authorize the selected work.", and the portal's
  `approveBlockedHint` when Approve is disabled.
- Sticky footer, only `<Option> · $total` (or "Choose an option") and `Approve` (`h-12`); it hides while
  the name input has focus.
- `Approve` opens a confirm "Approve Better for $4,812.00?" with `Approve` / `Go back`; while sending,
  `Approving…` and locked.
- Result: success → "Approved. Thank you." then `Hand back to technician`. An unknown result (network,
  5xx) → "Checking…", refetch; `soldByMe` with the chosen option → success screen; else the
  customer-safe line "Something went wrong. Please hand the phone back to your technician." with `Hand
  back to technician`. The
  technician sees the real reason on the estimate page.
- Hand-back screen: "Please hand the phone back to your technician." and `I'm the technician`, which
  closes the layer (history back).

### 7.3 Estimate page (technician)
Open: options with totals, `Show to customer`, `Customer declined` (confirm "Mark this estimate as
declined?"), and the approval-link note when `hasApprovalLink`. Sold: "Approved · <time> · <option>",
then billing:
- `billing: none` and `jobInvoice` is null or a draft without a payment: `Add to the job's invoice` and
  `Leave for the office` (returns to the job page; the estimate shows in the office's `Sold, not
  invoiced` filter).
- `none` and `jobInvoice` is open or a draft with a payment: "The job's invoice is already finalized.
  The office will bill this estimate." (no Add). When `jobInvoice` is null and an earlier invoice is
  paid, Add creates a new invoice for the sale (the sold view says "This goes on a new invoice.").
- `job`: `On the job's invoice` + `Open invoice`. `office`: `Billed by the office`.
- After an add: "Added. Get the customer's signature on the invoice before finalizing." and, when the
  draft also holds job materials, "Check the invoice for parts that are also on the estimate."
Expired / declined: the state, no actions.

### 7.4 Materials overlap
When the request has a sold estimate whose lines include the pricebook item being added as a job
material, the material form warns before saving: "This part is on the sold estimate. Add it only if
it's extra." (the material still saves).

### 7.5 Equipment
Card: live units by the location rule (type label, make, model, serial), `Add equipment`, per unit
`Replace` (hidden on `managedExternally` units, which read "Managed in FieldPulse"). Sheet: type select
(shared labels), make, model, serial, location in home, install date, `Describe it` for `Other`.
Replace pre-fills the old unit's type and reads "Replacing <make if any> <type label in lower case>"
("Replacing Carrier air conditioner").

## 8. Tests

Pure: builder validation and `nextOptionNames` (every add/remove/edited case above), totals with
`taxBps`, draft persistence parse, radio pre-select rule, confirm copy, billing-state → copy, unknown
result handling, customer-safe errors, hash/popstate state machine for the customer view, add-item
sheet Done-adds-pending, equipment validation (notes for `other`, no future date, noon storage), label
helpers, reason → copy maps.
SQL renders: org predicate counts per statement; both halves of billed(eid); the bill's `LINE_GATE`
totals; the replace CAS with the location rule and FieldPulse predicate; `removeInvoiceLine`'s
estimate-line refusal.
Route tests for every gate, code and the 201/200 split.
Integration (`tests/integration/field-estimate.test.ts`, dev DB, throwaway org): (a) create two options
→ ordered ids, `total_cents` = max, re-run creates nothing; no customer → NO_CUSTOMER; (b) sell → sold
`sold_via='field'`; same option + same tech + any name → success; other option → ALREADY_DECIDED;
portal-sold same option → ALREADY_DECIDED; (c) bill → lines once with links, totals = Σ lines + tax;
same key → replayed 200; new key → ALREADY_BILLED, no new invoice; (d) two concurrent bills with
different keys and NO existing draft → one draft, lines once; (e) office `createInvoiceFromSoldEstimate`
after a field bill → returns the field invoice; (f) office invoice first (open) → field bill
ALREADY_BILLED and GET `billing='office'` (both halves true); after that invoice is voided → GET
`billing='none'` and a field bill works; (g) the job's invoice open and the estimate unbilled →
INVOICE_LOCKED, no draft created; (h) two sold estimates on one request bill independently; (i) replace
→ new live, old `retired_at` + `replaced_by`; replay → success; a second key on the same old unit →
EQUIPMENT_RETIRED; a located request lists and replaces a NULL-location unit; a request without a
location replaces a located unit; FieldPulse unit → MANAGED_EXTERNALLY; (j) tenancy: another org's
estimate/equipment id → 404; (k) expired → ESTIMATE_EXPIRED; decline → dismissed, replay → success, then
sell → ALREADY_DECIDED; (l) materials logged before the sale, no draft, then bill → the draft holds the
materials and the estimate lines; (m) removing an estimate-linked line → FROM_ESTIMATE; (n) a zero-line
sold estimate → NO_LINES; (o) a draft with a recorded payment → INVOICE_LOCKED, nothing added; (p) the
job's earlier invoice paid, no live invoice → bill creates a new draft with the sale; (q)
`createInvoiceFromJob` stale/void results map to STALE (not stored) — unit-tested with a mocked writer;
(r) office invoice voided → the office filter no longer lists the estimate, Generate returns the void
invoice, the tech GET shows `billing='none'` and a field bill works; (s) an estimate-linked line has
`fromEstimate` in the tech invoice view; (t) an in-flight estimate key does not set the invoice view's
`pendingWrite`.

Browser walk (throwaway org via `createOrgCore`; technician, customer, request, assignment, pricebook
items and a tax rate inserted by SQL — never through the API on the FieldPulse-connected default org;
mint with `MINT_ORG_ID` and assert the token's user and org; queue guard before, zero
`communication_jobs` after; 390×844): arrive → New estimate with two options → Show to customer →
assert `document.elementFromPoint` at the technician header and Sign out lands inside the layer →
`history.back()` closes the layer to the estimate page → Show to customer again → reload → the layer is
back → choose Better, type a name, Approve, confirm → Hand back → Add to the job's invoice → the
invoice page shows the lines once → POST bill again with a new key → 409 ALREADY_BILLED → build and
sell a second estimate → double-tap Add under a throttled network → still once → add equipment, replace
it → the old unit leaves the card and shows `Replaced` on the office customer page. The keyboard-open
layout is checked on a real phone (headless can't open a keyboard) and noted in the report.

## 9. Docs

`page-tech` (estimates, customer view, billing, equipment), `page-estimates` (`sold_via`/`sold_by`,
field estimates, the office guard, decline, the `Sold, not invoiced` filter), `page-customers` (retired
units), `page-invoices` (estimate-linked lines can't be removed in the field), `replica/features.csv`
rows 129/132/133 → yes (133: "now = the job's invoice; later = office Generate invoice"),
`replica/parity.md`, `replica/build-log.md` (S38/S39 rows), `replica/architecture.md` annotation
(signature downgrade), memory.
