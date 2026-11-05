# Replica M3c: Sell on site

Status: v1 DRAFT, PARKED (2026-11-05) — not reviewed; the user redirected to a UX pass. Owner: Raymond Chen.
Milestone source: `replica/architecture.md` build order "M3c Sell on site" and the M3c rows of
the F04 tech-loop route table. Builds on M3b Collect (field invoice draft, idempotency keys).

## 1. Goal

On site, the lead technician builds an estimate with up to three options from the pricebook,
hands the phone to the customer, who picks an option and signs with their name. The estimate
is sold, and the sold option's lines land on the job's draft invoice exactly once, even when
the approve tap is sent twice. Any technician on the job can add a unit of equipment at the
customer's address or replace an old one, and the old unit is retired and linked to the new
one.

Done when (architecture.md): a two-option estimate is built, the customer picks and signs on
the device, the estimate is sold and its lines are on the draft invoice once even when signed
twice; a replaced unit shows `retired_at` and `replaced_by`.

Feature rows closed: 129 (equipment add / replace from field), 132 (present estimate with
options on site), 133 (sold items onto invoice now or later).

Non-goals (v1): estimate templates, groupings, add-ons, deposits, discounts, editing an
estimate after it is saved (M4 builder); a drawn signature image on the estimate (the typed
name is the e-signature, the same as the customer portal today; the job's drawn signature
stays on the job and the invoice); "book later" / sold-not-booked (M4); manual (non-pricebook)
estimate lines; selling a FieldPulse/Housecall Pro estimate; sending the estimate link by text
from the field; equipment photos, barcode scan, warranty fields; the location-info tab (M3d).

## 2. Surfaces

| surface | who | what |
| --- | --- | --- |
| Job page `Estimates` card (`/tech/jobs/[id]`) | every reader of the job | the request's native estimates, newest first: title (`Estimate` + short number), status chip (`Open` / `Sold` / `Expired` / `Dismissed`), total of the sold option or the option range, and for a sold one `On the invoice` or (lead) `Add to invoice`. Lead on site: `New estimate` button. Shown once the request is on site (same rule as the Invoice card) |
| Builder `/tech/jobs/[id]/estimates/new` | lead, on site | option tabs (`Option 1`…`3`, name editable, default names `Good` / `Better` / `Best` when a second and third are added), per option a line list with the M3b add-item search (`GET /api/tech/pricebook?scope=invoice&q=`), quantity stepper, remove; running total per option; `Save estimate` |
| Present `/tech/jobs/[id]/estimates/[eid]` | lead, on site | the customer-facing view: options side by side on a phone as stacked cards (name, lines with quantity and price, total), tap to choose, `Customer name` input, `Approve option` button; after approval a sold view with the chosen option and `Added to the invoice` / the retry |
| Job page `Equipment` card | every assigned technician, on site | live units at the customer's address (type, make, model, serial), `Add equipment` and per unit `Replace`; a bottom sheet with type (select), make, model, serial, location in home, install date (defaults to today on Replace) |

Helpers see the Estimates card read-only (no `New estimate`, no `Add to invoice`, open estimates
are not openable for presenting). The office sees field estimates in `/admin/estimates` as today
(they are ordinary native estimates).

## 3. Data model

Migration `drizzle/0055_m3c_sell_on_site.sql` (hand-authored, idempotent, journal + real
snapshot, `drizzle-kit generate` → "No schema changes"):

- `invoice_line_items.estimate_line_item_id uuid NULL REFERENCES estimate_line_items(id) ON
  DELETE SET NULL` + index `invoice_line_items_estimate_line_idx` on it. Mirrors
  `job_material_id`: an estimate line is billed at most once per request across non-void
  native invoices.
- `estimates.sold_by uuid NULL REFERENCES users(id) ON DELETE SET NULL` and `estimates.sold_via
  text NULL CHECK (sold_via IN ('portal','office','field'))`. The field sale writes
  `('field', <tech id>)`; `approveEstimate` writes `'portal'` and `markEstimateSold` writes
  `('office', <admin id>)` from now on (the admin route passes the session user id). Existing
  rows stay NULL.

No new equipment columns: `customer_equipment.location_id`, `replaced_by_equipment_id` and
`retired_at` already exist.

## 4. Ids and idempotency

Every field write carries an `Idempotency-Key` and runs through `withIdempotency` (M3b §4:
claim, replay, 2-minute in-progress window, takeover). Entity ids derive from the key so a
takeover re-run never duplicates:

- estimate id = `derivedId(scope, "estimate")`; option i id = `uuidv5(estimateId|option|i)`;
  line j of option i id = `uuidv5(estimateId|line|i|j)` (all with `M3B_NAMESPACE`), inserted in
  one `db.batch` with `ON CONFLICT (id) DO NOTHING`.
- invoice id for an adopted-or-created draft = `derivedId(scope, "invoice")` (as M3b create).
- invoice line id for an estimate line = `estimateLineId(invoiceId, estimateLineItemId)` =
  `uuidv5(invoiceId|estimate|lineId)`.
- equipment id = `derivedId(scope, "equipment")`.

New `STORED_CODES`: `ESTIMATE_DECIDED`, `ESTIMATE_EXPIRED`, `INVALID_OPTION`, `NO_CUSTOMER`,
`EQUIPMENT_RETIRED`.

## 5. Writers (`src/lib/tech/estimate-writes.ts`, `src/lib/tech/equipment-writes.ts`)

### 5.1 Create (`createFieldEstimate`)
Input: `{ options: [{ name (1–40 chars, trimmed), lines: [{ pricebookItemId, quantity 1–999 }] (1–40) }] (1–3) }`.
Server snapshots each line's name, unit price and cost from the ACTIVE pricebook item of the org
(an inactive or missing item → 400 `INVALID_INPUT` "One of these items is no longer in the
pricebook."); `unit_price_cents` uses the item's regular price (member pricing is office-only);
option subtotal = Σ line totals, tax = `round(subtotal × default tax bps / 10000)`, total =
subtotal + tax, with the existing INT32 overflow guards (any derived value past `INT32_MAX` →
400). One batch: a lead + native + on-site re-check (`stillLeadSql` and `r.status IN ON_SITE`
inside the INSERT's `WHERE`), estimate row (`service_request_id`, `customer_id` from the
request, `status='open'`, `expires_at = now() + 30 days`, `title = 'Field estimate'`,
`approval_token_hash` of a fresh token that is never returned to the technician — the office
can regenerate a link), options and lines gated on the estimate row's xmin. Returns
`{ estimateId, created }`.

### 5.2 Sell (`sellFieldEstimate`)
Input: `{ estimateId, optionId, signatureName (1–200, trimmed) }`. One batch, lock order
`L_req` → estimate row (`FOR NO KEY UPDATE`):
`UPDATE estimates SET status='sold', sold_option_id=$opt, signed_at=now(), signature_name=$name,
signature_ip=NULL, sold_via='field', sold_by=$me, updated_at=now() WHERE id=$eid AND
organization_id=$org AND service_request_id=$rid AND status='open' AND fieldpulse_estimate_id IS
NULL AND (expires_at IS NULL OR expires_at > now()) AND EXISTS(option $opt of $eid in $org) AND
(stillLead) AND request on site`. Zero rows → read the row and map: missing / other request →
`not_found` 404; `status='sold'` with `sold_option_id=$opt` → success `{ created:false }` (a
replay of the same choice); other decided → 409 `ESTIMATE_DECIDED` "This estimate was already
decided."; expired → 409 `ESTIMATE_EXPIRED` "This estimate expired. Build a new one."; bad option
→ 400 `INVALID_OPTION`; not lead / not on site → the M3b codes.

### 5.3 Bill (`billSoldEstimate`)
Input: `{ estimateId }`, lead + on site. Steps:
1. Adopt or create the draft via M3b `createInvoiceFromJob` (seeds unbilled materials as today)
   with id `derivedId(scope,"invoice")`. If it returns an `open`/`paid`/`refunded` invoice
   (the request's live invoice is no longer a draft) → 409 `INVOICE_LOCKED` "The invoice is
   already approved. Add this estimate from the office." (code already in `STORED_CODES`); if
   the live invoice is estimate-born (`estimate_id` set) → the same 409.
2. One batch: `L_req` → `L_inv` → INSERT the sold option's lines `(estimateLineId(inv, l.id),
   org, inv, estimate_line_item_id=l.id, name, quantity, unit_price_cents, cost_cents,
   line_total_cents)` from `estimate_line_items` of `sold_option_id`, `WHERE` the invoice is a
   native draft of this request AND the estimate is `sold` AND native AND of this request AND
   `NOT EXISTS (invoice_line_items x JOIN invoices i … WHERE x.estimate_line_item_id = l.id AND
   i.state <> 'void' AND P_NATIVE AND i.service_request_id = $rid)` `ON CONFLICT (id) DO
   NOTHING`; then the M3b `totalsSql` (bumps `updated_at` only when totals change); then
   `SELECT count(*)` of this estimate's lines now on a non-void native invoice of the request.
3. Result `{ invoiceId, added: <rows inserted>, billed: <count> }`. `added = 0` with `billed >
   0` is success (already billed — the "exactly once" proof). Lines are priced at the estimate's
   snapshot (what the customer approved), never the current pricebook; tax is the invoice's
   own (recomputed by `totalsSql`).

Estimate not sold → 409 `ESTIMATE_NOT_SOLD` "Approve the estimate first."; FieldPulse estimate →
409 `MANAGED_EXTERNALLY`.

### 5.4 Office generate guard
`createInvoiceFromSoldEstimate` (office "Generate invoice"): after its estimate-id early return,
if any line of the sold option is already on a non-void native invoice (via
`estimate_line_item_id`), return `{ ok: true, invoiceId: <that invoice> }` instead of creating a
second invoice. The reverse (office first, then the field bill) is blocked by step 2's NOT
EXISTS only when lines carry the link: `createRequestEstimateInvoice` and the request-less path
now write `estimate_line_item_id` on the lines they copy, so a field bill after an office
invoice adds nothing (`added 0, billed n`).

### 5.5 Equipment (`addFieldEquipment`)
Input: `{ equipmentType (enum), make?, model?, serialNumber?, locationInHome? (each trimmed, ≤
120), installDate? (ISO date, not in the future), replacesId? }`. Any technician who can read
the job, request on site, native job. The request's `customer_id` is required (null → 409
`NO_CUSTOMER` "This job has no customer on file."). `location_id` = the request's `location_id`.
One batch:
- with `replacesId`: lock the old row (`FOR NO KEY UPDATE`, same org AND same customer); INSERT
  the new row `WHERE EXISTS (old row, retired_at IS NULL)` `ON CONFLICT (id) DO NOTHING
  RETURNING id`; `UPDATE` the old row `SET retired_at = now(), replaced_by_equipment_id = $new,
  updated_at = now() WHERE id = $old AND retired_at IS NULL AND EXISTS (new row xmin = current)`.
  Old row already retired (and not by this key's row) → 409 `EQUIPMENT_RETIRED` "That unit was
  already replaced." Missing / other customer → 404.
- without: INSERT `ON CONFLICT (id) DO NOTHING`.
Returns `{ equipmentId, created }`. Equipment rows hold no customer PII beyond what the office
already stores; erase handling is unchanged.

## 6. Routes (all `force-dynamic`, all write routes through the M3b `techWritePreamble` order,
except equipment which uses the reader preamble)

| route | gate | body | success |
| --- | --- | --- | --- |
| `GET /api/tech/jobs/[id]/estimates` | session, readable job | — | `{ estimates: [{ id, number, status, expiresAt, soldOptionId, signatureName? (lead only), billed: boolean, options: [{ id, name, sortOrder, subtotalCents, taxCents, totalCents, lines: [{ id, name, quantity, unitPriceCents, lineTotalCents }] }] }], canCreate, isLead, onSite }` — never cost fields; native estimates only; `number` = first 8 hex of the id uppercased |
| `POST /api/tech/jobs/[id]/estimates` | write preamble (lead, on site) + key | §5.1 | 201 `{ estimateId }` |
| `POST /api/tech/jobs/[id]/estimates/[eid]/sell` | write preamble + key | `{ optionId, signatureName }` | 200 `{ estimateId, status: 'sold' }`, then the route runs §5.3 in the same request (its own key scope `…/bill`-derived) and returns `{ …, bill: { invoiceId, added, billed } | { error: code } }` — a bill failure never undoes the sale |
| `POST /api/tech/jobs/[id]/estimates/[eid]/bill` | write preamble + key | `{}` | 200 `{ invoiceId, added, billed }` |
| `GET /api/tech/jobs/[id]/equipment` | session, readable job | — | `{ units: [{ id, equipmentType, make, model, serialNumber, locationInHome, installDate }] }` live units (`retired_at IS NULL`) of the request's customer, at the request's location when set (else all) |
| `POST /api/tech/jobs/[id]/equipment` | session → same-origin → uuid → rate `tech:equipment:write` → readable → native → on site + key | §5.5 | 201 `{ equipmentId }` |

Audit (ids/enums only, skipped on replay): `estimate_created` (estimateId, options count),
`estimate_sold` (estimateId, optionId, via field), `estimate_billed` (estimateId, invoiceId,
added), `equipment_added` / `equipment_replaced` (equipmentId, replacesId). No message is ever
queued by these routes.

## 7. Client

Tech conventions (base primitives, `h-11` targets, sentence case, human errors). Keys use the
M3b `useIdempotencyKey` reducer and `classifyWriteError`; a builder draft is kept in
`sessionStorage` (`tech:estimate:<rid>:draft`, try/catch) so a reload keeps the options.

- **Builder**: an option strip (`Option 1` `Option 2` `Option 3`, `+ Add option` until three);
  the active option's name input (placeholder `Good`), its lines (name, `× qty`, price, line
  total, remove), `Add item` opening the M3b add-item search sheet; footer `Total $X` and
  `Save estimate` (disabled until every option has a name and a line). Save → navigate to the
  present page.
- **Present**: heading `Choose an option`, one card per option (name, lines, `Total` in 17 px
  semibold mono), tap selects (ring `border-primary`, `aria-pressed`), `Customer name` input,
  copy "By tapping Approve you agree to this work and price.", button `Approve option` (`h-12`).
  On success: `Approved by <name>` with the option card, then `Added to the invoice` with an
  `Open invoice` link, or the bill error copy with `Add to invoice` retry. A sold estimate opened
  later shows the same sold view. An expired or dismissed estimate shows its state with no
  actions.
- **Estimates card** on the job page per §2; **Equipment card** per §2 with the sheet; Replace
  pre-fills the type of the old unit and shows "Replacing <make> <type>".
- Copy: errors from the route (human), `ESTIMATE_DECIDED` → reload the list first.

## 8. Tests

Pure: builder validation and totals (`estimate-builder.ts`), draft persistence parse, option
selection, sold-view state, equipment form validation, route reason → copy maps, SQL renders
(org predicate counts for every statement, the NOT EXISTS once-guard, the replace CAS).
Route tests for every gate and code. Integration (`tests/integration/field-estimate.test.ts`,
dev DB, throwaway org): (a) create with two options → rows with derived ids, replay creates
nothing; (b) sell → sold, `sold_via='field'`; selling again with the same option → success, with
another option → `ESTIMATE_DECIDED`; (c) bill → lines on the draft with `estimate_line_item_id`;
bill again (same and new key) → `added 0, billed n`; (d) office `createInvoiceFromSoldEstimate`
after the field bill returns the field invoice, no second invoice; (e) office invoice first, then
the field bill adds nothing; (f) bill when the live invoice is open → `INVOICE_LOCKED`;
(g) replace → new row live, old `retired_at` + `replaced_by`; replace the same old unit with a
second key → `EQUIPMENT_RETIRED`; (h) tenancy: another org's estimate/equipment id → 404;
(i) expired estimate → `ESTIMATE_EXPIRED`.

Browser walk (throwaway org, Playwright, 390 px): lead arrives → new estimate with two options →
present → choose option 2, name, approve → `Added to the invoice` → invoice page shows the lines
once → re-tap approve via a reload of the sold view (no duplicate) → add equipment, replace it →
the old unit is gone from the card. Queue guard before, zero `communication_jobs` after.

## 9. Docs

`page-tech` (estimates, equipment), `page-estimates` (sold_via/sold_by, field estimates, the
office generate guard), `replica/features.csv` rows 129/132/133 → yes, `replica/parity.md`,
`replica/build-log.md` (S38/S39 rows), `replica/architecture.md` annotation, memory.
