# Replica M3b — Collect (field invoice, manual payment, idempotency)

Status: v4 FINAL (spec review rounds 1–3, 6 critics, converged; see
`replica/review-log.md` "Spec round 5", "Spec round 6", "Spec round 7"). Parent:
`replica/architecture.md` "F04 Tech loop" M3b rows + build-order item 4 "M3b
Collect"; `replica/schema.sql` section "M3b"; `replica/review-log.md` spec rounds
3–4 (established facts carried forward). Design: `replica/design/components.md`
"Payment sheet", "Add-item side panel", "Signature pad". Code facts as of `a3c2b23`.

## 1. Goal

A technician on site turns the job into money without the office: create the
job's invoice from the materials already captured, add pricebook lines, finalize
it with the customer's signature, record a cash or check payment, and the invoice
reads paid. Every money POST from the phone carries an idempotency key so a
retried tap (flaky signal at the furnace) creates exactly one invoice, one line,
one payment. No fake card payments anywhere: while the payment provider is the
mock, no surface offers a card.

**Done when** (architecture): a tech creates an invoice from the job's materials,
the customer signs on the phone (in the approval sheet on the invoice page; the
signature is snapshotted onto the invoice at finalize), the tech records a check
payment, the invoice reads paid with no office action; replaying
invoice-create and payment with the same key creates one of each; a different
body with the same key gets 422; no card option appears on the mock.

Must-have rows closed: 134 (invoice presentation + signature on site), 135 (take
payment in the field, manual), 185 (record manual payments with method). Row 168
stays `partial` (tech invoice adds pricebook lines; the office line editor is M4).

## 2. Scope and non-goals

In scope: migrations 0052/0053; `idempotency_keys` + helper; `createInvoiceFromJob`
(adopt-or-create), line add/remove on a draft, finalize, `recordManualPayment`,
manual refunds as one batch; the tech routes + GET; the S40 page; the mock gate on
every card surface; admin record-payment gains a method and a client-minted id;
method shown on the admin invoice detail and in the accounting CSV; the signature
route gains the key claim and the native guard; the invoice carries its own
signature snapshot from finalize; an admin finalize route; erase deletes
signature objects in R2; small correctness fixes the review surfaced in the
existing money code (reconcile state write, estimate-invoice duplication);
skills, parity, build log.

Out of scope (rows unchanged): card payment in the field (M4 Stripe), estimate
deposit (161), payment splits (176), office invoice builder (M4), invoice
numbers, tax zones (M4; M3b uses the org's default rate), payment terms / due
dates (M4), offline queue (M3e), PDF/email of the invoice document (the pay link
opens the portal, which renders the invoice), an email pay-link channel (SMS
meets row 135; email in M6), a membership-form card control (none exists; the
route refuses), an admin "clear signature" action (the invoice's signature
snapshot is immutable evidence; the job-level signature can always be re-captured).

## 3. Data model

Two hand-authored migrations (repo precedent `0048`: an enum value is added in its
own file and never used in the same file; `0050`: FK/constraint names are
drizzle's, added inside `DO $$ … EXCEPTION WHEN duplicate_object` blocks).
Journal entries with `when` greater than 0051's; the snapshot is REGENERATED from
`schema.ts` (not copied — 0052 changes the schema) and `drizzle-kit generate` then
reports "No schema changes". The neon-http migrator executes each statement as
its own auto-committed call, so the "applies twice" test runs statements one at
a time, never through `db.batch`.

### 3.1 `drizzle/0052_m3b_collect.sql` (DDL only)

- `payments`: `method text NOT NULL DEFAULT 'card'`, `check_number text`,
  `recorded_by uuid` (FK `payments_recorded_by_users_id_fk` → users ON DELETE SET
  NULL); checks `payments_method_check` (`method IN ('card','cash','check','other')`)
  and `payments_check_number_check` (`check_number IS NULL OR method = 'check'`).
- `invoices`: `pay_link_sent_at timestamptz` (the pay-link cooldown claim column;
  never `last_reminder_sent_at`); `signature_url text`, `signature_name text`,
  `signed_at timestamptz` (the invoice's own evidence, copied from the request at
  finalize, never written afterwards); partial unique index
  `invoices_one_native_draft_per_request_idx ON invoices (service_request_id) WHERE
  service_request_id IS NOT NULL AND state = 'draft' AND fieldpulse_invoice_id IS
  NULL AND hcp_invoice_id IS NULL` (dev probe 2026-11-04: zero requests have two
  native drafts, so no pre-clean statement).
- `invoice_line_items`: `created_at timestamptz NOT NULL DEFAULT now()` (stable
  display order; existing rows get the migration time; the admin document keeps
  its current order), `job_material_id uuid` (FK
  `invoice_line_items_job_material_id_job_materials_id_fk` → job_materials ON
  DELETE SET NULL; set on lines seeded from or added from a material, so a
  material is billed at most once across the request's non-void invoices).
- `idempotency_keys` as in `replica/schema.sql` plus `attempt_id uuid NOT NULL`;
  PK named `idempotency_keys_pkey` (schema: `primaryKey({ name: "idempotency_keys_pkey", columns })`),
  FKs `idempotency_keys_organization_id_organizations_id_fk` /
  `idempotency_keys_user_id_users_id_fk`, check `idempotency_keys_state_check`,
  index `idempotency_keys_created_idx`.
- `ALTER TYPE "public"."communication_trigger_type" ADD VALUE IF NOT EXISTS 'invoice_sent';`

### 3.2 `drizzle/0053_m3b_backfill.sql` (data only)

- `UPDATE payments SET method = 'other' WHERE provider = 'fieldpulse' AND method = 'card';`
  (dev: 2,363 FieldPulse rows, 25 mock rows which stay `card`).
- Seed the `invoice_sent_sms` template for every existing org:
  `INSERT INTO communication_templates (organization_id, key, name, description, trigger_type, template_type, subject_template, body_template, variables, is_active, priority) SELECT o.id, 'invoice_sent_sms', 'Invoice ready (SMS)', 'Texts the customer a link to view a new invoice', 'invoice_sent'::communication_trigger_type, 'sms'::communication_template_type, NULL, $body, '{"customerName":"Customer name","amount":"Invoice total (formatted dollars)","invoiceNumber":"Invoice reference","payLink":"Portal link","companyName":"Company name","phoneNumber":"Company phone"}'::jsonb, true, 50 FROM organizations o ON CONFLICT (organization_id, key) DO NOTHING` (unique index `communication_templates_org_key_unique`; body in §6.4). The 0053 snapshot is a copy of 0052's with new `id`/`prevId` (data-only, as 0051 did).

### 3.3 Schema and registries (`src/lib/db/schema.ts` + the six trigger registries)

`payments.method/checkNumber/recordedBy`, both checks, `invoices.payLinkSentAt`,
`invoices.signatureUrl/signatureName/signedAt`, `invoiceLineItems.createdAt/jobMaterialId`,
the partial unique index, `idempotencyKeys`,
`communicationTriggerTypeEnum` + `invoice_sent`. Every registry keyed by the
trigger gains `invoice_sent`: `TRIGGER_RULES` in `consent.ts` (transactional, same
rule as `estimate_sent`: `automatedConfirmations`, no quiet hours),
`templateVariableSchemas`, `COMMUNICATION_TRIGGER_TYPES`, `defaultSmsTemplates` in
`sms-templates.ts`, the email subject map in `email-templates.tsx` (a subject is
required by the type even though M3b sends SMS only), `defaultTemplates` in
`seeds.ts` (so `createOrgCore` seeds new orgs). The FieldPulse
payment import writes `method: "other"` on insert and in its `onConflictDoUpdate`.
`payments.provider` comment: `"mock" | "stripe" | "fieldpulse" | "manual"`.
`PaymentView` and the admin `ApiPayment` type gain `method`, `checkNumber`, `provider`.
`InvoiceDetailView.issuedAt`'s comment is updated: set for field-finalized native invoices.

Purge: the daily cron `src/app/api/cron/cleanup/route.ts` gains
`DELETE FROM idempotency_keys WHERE created_at < now() - interval '7 days'`.

## 4. Idempotency — `src/lib/http/idempotency.ts` (+ test)

Used by every tech money POST: invoice create, line add, finalize, payments,
pay-link, and the signature route (multipart, §6.5). Line DELETE is naturally
idempotent and needs no key. Admin forms send a client token from which the
server derives the entity id (§8).

**Key.** Header `Idempotency-Key`: 1–64 chars of `[A-Za-z0-9_-]`. Missing or
malformed → 400 `IDEMPOTENCY_KEY_REQUIRED` "Missing idempotency key." (a client
bug; the UI always sends one — `crypto.randomUUID()` with a `getRandomValues`
v4 fallback for non-secure contexts such as a LAN dev server over http).

**Scope.** Row key = `(organization_id, user_id, route, key)`; `route` is the
literal request path. **Request hash** = sha256 of `JSON.stringify(canonical(body))`
(keys sorted recursively, `undefined` dropped; empty body → `"{}"`); multipart
routes hash `(route, requestId, sha256(file), name)`. The hash is one-way but a
4–6 digit check number is brute-forceable from it, so the spec makes no privacy
claim about the hash; the plaintext lives in `payments.check_number` anyway.
Route error logs carry codes and ids only, never SQL parameters.

**Derived ids.** `derivedId(scope, n)` = `uuidv5(`${org}|${user}|${route}|${key}|${n}`, M3B_NAMESPACE)` for the entity each route creates (`invoice`, `line`, `payment`, `refund`); seeded material lines use invoice-scoped ids (§5.1). Every insert is `ON CONFLICT (id) DO NOTHING` or gated on an EXISTS, so a re-run can never create a second row.

**Algorithm** (`withIdempotency(scope, hash, run)` where `run(ids) → { status, body }`,
`body` ids/enums/cents only, never names or check numbers):

1. Rate check happens in the route before this.
2. Claim: `INSERT … (…, request_hash, state='in_progress', attempt_id=$mine) ON CONFLICT DO NOTHING RETURNING key`.
3. **Winner:** `result = await run(ids)`.
   - `status` 2xx, or a DETERMINISTIC 4xx — the exported constant `STORED_CODES = {INVOICE_LOCKED, NO_LINES, ALREADY_BILLED, ITEM_NOT_FOUND, INVOICE_VOIDED, INVALID_INPUT, VALIDATION_ERROR}` in a dependency-free module shared with the client reducer (§7.5) → `UPDATE … SET state='done', response_status, response_body WHERE (pk) AND state='in_progress' AND attempt_id=$mine`; return `result`.
   - Any other outcome (409 `STALE`, state-dependent refusals such as `EXCEEDS_BALANCE`, `NOT_LEAD`, `INVOICE_NOT_CHARGEABLE`, `COOLDOWN`, `NO_CONTACT`, any 5xx, or `run` throws) → `DELETE … WHERE (pk) AND attempt_id=$mine` (best effort), return/rethrow. A retry with the same key re-runs; derived ids make that safe, and a refusal that depended on state is re-evaluated.
   - Pay-link exception: its side effect (a queued message) cannot be undone, so a throw after the queue step stores `done` with status 500; the client treats a stored 500 from pay-link as "spent" and mints a new key on the next deliberate Send (§7.6).
4. **Loser:** `SELECT state, request_hash, response_status, response_body, created_at, attempt_id`:
   - no row (the winner deleted it meanwhile) → go to step 2 once more; still no claim → 409 `IN_PROGRESS`.
   - `done` and same hash → stored `{ status, body }` with `replayed: true`; routes skip side effects on replay.
   - `done` and different hash → 422 `IDEMPOTENCY_KEY_REUSED` with `details: { storedStatus }` (the client's copy depends on whether the stored answer was a success).
   - `in_progress`: different hash → 422 regardless of age (a stale takeover never runs a different body; the stored result would misdescribe what happened); same hash and `created_at > now() − 2 min` → 409 `IN_PROGRESS` "Still saving your last tap. Try again in a moment." with `Retry-After: 2`; same hash and older → takeover `UPDATE … SET created_at = now(), attempt_id = $mine WHERE (pk) AND state='in_progress' AND created_at < now() − interval '2 minutes' RETURNING key` → a row → winner path; no row → re-SELECT and decide once more (it may have become `done`).
   - An attempt that finishes after being taken over matches 0 rows on its `done`/`DELETE` (attempt-gated) and its response is discarded.

**Pure tests**: canonical hashing; derived ids stable, distinct per `n`/route/user; `decideReplay(row, hash, now)` decision table (winner / replay / reused / in_progress / takeover / re-claim); `PgDialect` renders of claim, done, delete, takeover.

## 5. Money writers — `src/lib/admin/invoice-field-writes.ts` (+ test, mocked `db.batch`)

Rules: one `db.batch` per write, lock-first in the order request → invoice →
rows, xmin gates (`xmin = pg_current_xact_id()::xid`), every enum literal cast,
every `OR` fragment parenthesised with a render test, `organization_id = $org`
on EVERY table reference including subqueries and EXISTS bodies (render tests
assert the param count) — with ONE documented exception: the `NOT EXISTS
(payments|refunds WHERE id = $id)` guards are global by id because those ids are
global primary keys (§5.5). Writers take `(organizationId, requestId, techUserId, ids, input)`
and return discriminated unions; routes map reasons to codes (§6.3). Native
only: a request with `fieldpulse_job_id` or `hcp_job_id` → `managed_externally`
before any write. The in-write lead check `stillLead` =
`EXISTS (SELECT 1 FROM appointment_assignments a JOIN appointments p ON p.id = a.appointment_id WHERE p.service_request_id=$rid AND p.organization_id=$org AND a.organization_id=$org AND p.cancelled_at IS NULL AND a.technician_id=$me AND a.is_lead AND a.status IN SIGNABLE_IN)`
(`SIGNABLE_IN` is a raw SQL list, exported from `field-queries.ts`; this is "lead on any live
visit", deliberately weaker than the route's active-visit check — a reassignment
between the route read and the batch is refused, a completed earlier-visit lead
is not). Each batch ends with `SELECT ($stillLead) AS still_lead` and the writer
reports `not_lead` first when it is false.

Lock statements: `L_req` = `SELECT 1 FROM service_requests WHERE id=$rid AND organization_id=$org FOR NO KEY UPDATE`;
`L_inv` = `SELECT 1 FROM invoices WHERE id=$invoiceId AND organization_id=$org FOR NO KEY UPDATE`.

Adopt predicate `P_live` (parenthesised): `(state = 'draft'::invoice_state OR state = 'open'::invoice_state)`.
Native predicate `P_native`: `fieldpulse_invoice_id IS NULL AND hcp_invoice_id IS NULL`.

### 5.1 `createInvoiceFromJob` — adopt or create

Reads before the batch: the request is native and `customer_id` (nullable); no
FP/HCP invoice exists for the request (`external_invoice`); `taxBps =
getDefaultTaxBps(org)`; the job's UNBILLED materials — those with no
`invoice_line_items.job_material_id` link on any non-void native invoice of the
request — with `COALESCE(pi.name, m.description, 'Material')` as the line name
for catalog-linked rows (`pi` = the pricebook item) and `COALESCE(m.description, 'Material')`
for manual rows (so a deposit-then-final or a re-bill never seeds an item twice).

Adopt rule: the request's newest native invoice with `P_live` is THE invoice. An
estimate-born `open` invoice is adopted too, unseeded, shown as "From estimate":
the field can present it and record payment (its signature block shows the
estimate's acceptance — `signature.state = 'estimate'` with the estimate's
`signed_at`/`signature_name` — since finalize never runs on it), but cannot add lines
(ruling: materials on a job with a sold estimate are billed by the office; the
GET omits `materialsNotOnInvoice` for non-draft invoices). Any OTHER open native
invoice on the request is listed in `otherOpen` (id, total, balance) and shown as
"1 other open invoice on this job · $89 due" so money never disappears from view.
`paid`/`refunded`/`void` invoices are history: the GET lists the newest as
read-only and a new draft may be created (deposit-then-final and re-bill after a
refund stay possible; the one-draft index is the only uniqueness).

Batch: `L_req`;
`INSERT INTO invoices (id, organization_id, service_request_id, customer_id, state, subtotal_cents, tax_cents, total_cents, amount_paid_cents) SELECT $invoiceId, $org, $rid, $customerId, 'draft'::invoice_state, 0,0,0,0 WHERE ($stillLead) AND NOT EXISTS (SELECT 1 FROM invoices WHERE organization_id=$org AND service_request_id=$rid AND P_live AND P_native) ON CONFLICT DO NOTHING RETURNING id` (bare `ON CONFLICT DO NOTHING` absorbs both a pk hit and the one-draft index);
seed lines: `INSERT INTO invoice_line_items (id, organization_id, invoice_id, job_material_id, name, quantity, unit_price_cents, cost_cents, line_total_cents) SELECT v.* FROM (VALUES …) v(…) WHERE EXISTS (SELECT 1 FROM invoices WHERE id=$invoiceId AND organization_id=$org AND xmin = pg_current_xact_id()::xid) ON CONFLICT (id) DO NOTHING` — line ids `uuidv5(`${invoiceId}|material|${jobMaterialId}`, M3B_NAMESPACE)`;
totals `T(gate)`: `UPDATE invoices SET subtotal_cents = s.sub, tax_cents = ROUND(s.sub * $taxBps / 10000.0)::int, total_cents = s.sub + ROUND(s.sub * $taxBps / 10000.0)::int, updated_at = now() FROM (SELECT COALESCE(SUM(line_total_cents),0) AS sub FROM invoice_line_items WHERE invoice_id=$invoiceId AND organization_id=$org) s WHERE invoices.id=$invoiceId AND invoices.organization_id=$org AND <gate>` with gate = xmin here;
`SELECT id, state FROM invoices WHERE organization_id=$org AND service_request_id=$rid AND P_live AND P_native ORDER BY created_at DESC LIMIT 1`;
`SELECT ($stillLead)`.
Outcome: insert returned a row → `{ ok: true, invoiceId, state: 'draft', created: true }`; no row and the final SELECT found a live invoice → `{ ok: true, invoiceId: that, state, created: false }`; no row and no live invoice → read the row with `id = $invoiceId` (the first attempt's invoice): `paid`/`refunded` → `{ ok: true, invoiceId, state, created: false }` (history; the GET shows it), `void` → `invoice_voided` (409; the client mints a new key on the next tap, which derives a fresh id); `still_lead` false → `not_lead`.

Materials captured after the invoice exists are not mirrored. For a DRAFT the
GET lists `materialsNotOnInvoice` = unbilled materials (no `job_material_id`
link on any non-void native invoice) created after `invoice.created_at` (a seeded
line the technician deleted does not come back).

### 5.2 `addInvoiceLine` (draft only)

Body is one of `{ pricebookItemId, quantity }` or `{ jobMaterialId }`
(`quantity` 1–999 in both the API and the stepper). Reads before the batch:
pricebook item (`active`, tenant) → `item_not_found`, snapshot `name`,
`price_cents`, `cost_cents`; or the material with `service_request_id=$rid AND organization_id=$org`
→ `item_not_found`, name/price/cost as in 5.1, the invoice-scoped line id and
`job_material_id` (so the same material can never be added twice, whatever the
key; the INSERT also requires `NOT EXISTS` a link on any non-void native invoice
of the request). Line id for a pricebook line = `derivedId(scope, 'line')`. The
body also carries `invoiceId` (§6.2) and the writer requires
`i.id=$invoiceId AND i.service_request_id=$rid`.

Batch: `L_req`; `L_inv`;
`INSERT INTO invoice_line_items (…) SELECT … WHERE ($stillLead) AND EXISTS (SELECT 1 FROM invoices i WHERE i.id=$invoiceId AND i.organization_id=$org AND i.service_request_id=$rid AND i.state='draft'::invoice_state AND P_native) ON CONFLICT (id) DO NOTHING RETURNING id`;
`T(state = 'draft'::invoice_state AND amount_paid_cents = 0)`; `SELECT state FROM invoices WHERE id=$invoiceId AND organization_id=$org`; `SELECT ($stillLead)`.
Outcome: inserted → `{ ok: true, lineId }`; not inserted and the line exists → `{ ok: true, lineId, replayed: true }`; not inserted, draft intact, `jobMaterialId` already linked on another non-void invoice → `already_billed`; not inserted, state ≠ draft → `invoice_locked`; invoice missing → `invoice_not_found`; `still_lead` false → `not_lead`. The invoice lock (`L_inv`) serialises line edits against any payment or finalize on the same row, so the totals UPDATE always sees the state the INSERT saw.

### 5.3 `removeInvoiceLine` (draft only)

Batch: `L_req`; `L_inv`; `DELETE FROM invoice_line_items WHERE id=$lid AND invoice_id=$invoiceId AND organization_id=$org AND ($stillLead) AND EXISTS (draft check as 5.2, plus `amount_paid_cents = 0`) RETURNING id`; `T(state='draft' AND amount_paid_cents = 0)`; final SELECTs as 5.2. Returns `{ ok: true, removed: boolean }`; non-draft → `invoice_locked`.

### 5.4 `finalizeInvoice` — CAS draft → open

Key required (uniform client behaviour; CORS preflight on every money write).
Rules: at least one line (`no_lines`); a $0 total finalizes to `open` with a zero
balance (still voidable by the office; it never appears in collections because
`total > paid` is false; the field shows "Nothing to collect"). Finalize
SNAPSHOTS the request's signature onto the invoice in the same statement — but
ONLY a signature that is newer than the invoice's last change
(`r.signed_at >= invoices.updated_at`; `T` bumps `updated_at` on every line
edit), so a morning sign-off or a signature given before a line was added is
never frozen as approval of a different total; otherwise the snapshot columns
stay NULL and the invoice reads "No signature". The invoice's
`signature_url/signature_name/signed_at` are never written again; the request's
own signature stays re-capturable (job sign-off) and a later invoice snapshots
whatever is current and fresh then.
Batch: `L_req`; `L_inv`;
`UPDATE invoices SET state='open'::invoice_state, issued_at=now(), signature_url = CASE WHEN r.signed_at >= invoices.updated_at THEN r.signature_url END, signature_name = CASE WHEN r.signed_at >= invoices.updated_at THEN r.signature_name END, signed_at = CASE WHEN r.signed_at >= invoices.updated_at THEN r.signed_at END, updated_at=now() FROM service_requests r WHERE r.id=invoices.service_request_id AND r.organization_id=$org AND invoices.id=$invoiceId AND invoices.organization_id=$org AND invoices.service_request_id=$rid AND invoices.state='draft'::invoice_state AND P_native AND ($leadOrAdmin) AND EXISTS (SELECT 1 FROM invoice_line_items WHERE invoice_id=$invoiceId AND organization_id=$org) RETURNING state` (`$leadOrAdmin` = `$stillLead` for the tech route, `TRUE` for the admin finalize route, whose `$rid` is the invoice's own `service_request_id`; a request-less draft — none exist today, invoices from estimates carry the estimate's request — uses the same statement with the join made optional: `FROM invoices i LEFT JOIN service_requests r …` written as scalar subqueries `(SELECT r.signature_url FROM service_requests r WHERE r.id = invoices.service_request_id AND r.organization_id=$org AND r.signed_at >= invoices.updated_at)`; `L_req` is skipped when `service_request_id` is null; no `still_lead` SELECT on the admin path);
`SELECT state, (SELECT COUNT(*) FROM invoice_line_items WHERE invoice_id=$invoiceId AND organization_id=$org) AS lines FROM invoices WHERE id=$invoiceId AND organization_id=$org`; `SELECT ($stillLead)`.
Outcome: CAS row → `{ ok: true, state: 'open', changed: true }`; no row and state ∈ {open, paid, refunded} → `{ ok: true, state, changed: false }`; draft with 0 lines → `no_lines`; void → `invoice_locked`; missing → `invoice_not_found`; not lead → `not_lead`. `due_date` stays NULL (M4 terms; the overdue heuristic's 30-day fallback applies, like every native invoice today).

### 5.5 `recordManualPayment` — the money rule

Input `{ method: 'cash' | 'check' | 'other', amountCents ≥ 1, checkNumber? (1–32, only with check), isDeposit }`, `paymentId` (tech: `derivedId(scope,'payment')`; admin: `uuidv5(`${org}|payment|${clientToken}`, M3B_NAMESPACE)` from the dialog's token — org-scoped, NOT invoice-scoped, so a token reused on another invoice derives the SAME id and is caught by the match rule below; ids are always server-derived, never client-chosen), `recordedBy`. The field route allows `cash`/`check` and `isDeposit = false`; the admin route also `other` and passes `isDeposit` through.
Preconditions (read): invoice exists, tenant, native (`synced_read_only`), state `open` (`invoice_not_chargeable` — a draft is never payable by cash or check, field or office, so the customer signs what they pay and line edits can never race a credit), `amountCents ≤ total − paid` (`exceeds_balance`).
Batch: `L_req` (when the invoice has a request; else skipped); `L_inv`;
claim `UPDATE invoices SET amount_paid_cents = amount_paid_cents + $amt, updated_at = now() WHERE id=$invoiceId AND organization_id=$org AND ($ridPredicate) AND state='open'::invoice_state AND P_native AND amount_paid_cents + $amt <= total_cents AND NOT EXISTS (SELECT 1 FROM payments WHERE id=$paymentId) AND ($leadOrAdmin) RETURNING amount_paid_cents, total_cents` (`$ridPredicate` = `service_request_id=$rid` on the tech path, `TRUE` for the office; `$leadOrAdmin` = `$stillLead` for the tech, `TRUE` for the admin path; the NOT EXISTS is global by id — the documented exception);
`INSERT INTO payments (id, organization_id, invoice_id, provider, provider_payment_id, amount_cents, status, is_deposit, method, check_number, recorded_by) SELECT $paymentId, $org, $invoiceId, 'manual', NULL, $amt, 'succeeded'::payment_status, $isDeposit, $method, $checkNumber, $by WHERE EXISTS (SELECT 1 FROM invoices WHERE id=$invoiceId AND organization_id=$org AND xmin = pg_current_xact_id()::xid) ON CONFLICT (id) DO NOTHING`;
`UPDATE invoices SET state = (CASE WHEN amount_paid_cents >= total_cents THEN 'paid' ELSE 'open' END)::invoice_state, updated_at = now() WHERE id=$invoiceId AND organization_id=$org AND EXISTS (SELECT 1 FROM payments WHERE id=$paymentId AND xmin = pg_current_xact_id()::xid) RETURNING state` (gated on the PAYMENT row being this transaction's — never on the invoice xmin, which the claim alone would satisfy);
`SELECT id, invoice_id, amount_cents, method, check_number, is_deposit FROM payments WHERE id=$paymentId`; `SELECT state FROM invoices WHERE id=$invoiceId AND organization_id=$org`; `SELECT ($stillLead)`.
Outcome: claim row → `{ ok: true, paymentId, invoiceState, created: true }`; claim empty and the payment row exists with the same `invoice_id`, `amount_cents`, `method`, `check_number`, `is_deposit` → `{ ok: true, paymentId, invoiceState, created: false }` (the first run landed); exists but differs in any of those → `payment_id_conflict` (409; the office dialog mints a new token); claim empty, no payment row: not lead → `not_lead`; state open → `exceeds_balance`; else `invoice_not_chargeable`. The claim's global NOT EXISTS runs in the same transaction, so the payment INSERT can be skipped only by a concurrent insert of the same derived id between the two statements, which the org-scoped derivation makes impossible in practice; the INSERT carries `RETURNING id` and the writer logs an invariant violation (ids only) if the claim returned a row and the INSERT did not.
Why the NOT EXISTS: a re-run after a crash between the first run's commit and its `done` row must not credit twice; the payment row proves the credit happened (review-log round 4). Manual payments are never `pending`; `listStuckPayments` adds `provider <> 'manual'`. The receipt is sent by whichever attempt observed `created: true` (in its own `after()`), independent of the key row.

### 5.6 `refundPayment` on a manual payment (one batch, SQL state)

For `pay.provider === 'manual'` the existing two-phase path (claim, provider call,
batch) is replaced by ONE batch with `refundId = uuidv5(`${org}|refund|${clientToken}`)` (admin dialog token; org-scoped, not payment-scoped, same reasoning as payments):
`L_req` (if any) → `L_inv` → `SELECT 1 FROM payments WHERE id=$pid AND organization_id=$org FOR NO KEY UPDATE` →
claim `UPDATE payments SET amount_refunded_cents = amount_refunded_cents + $amt, status = (CASE WHEN amount_refunded_cents + $amt >= amount_cents THEN 'refunded' ELSE 'succeeded' END)::payment_status, updated_at=now() WHERE id=$pid AND organization_id=$org AND provider='manual' AND status='succeeded'::payment_status AND amount_refunded_cents + $amt <= amount_cents AND NOT EXISTS (SELECT 1 FROM refunds WHERE id=$refundId) RETURNING id` →
`INSERT INTO refunds (id, organization_id, payment_id, amount_cents, reason, provider_refund_id) SELECT $refundId, $org, $pid, $amt, $reason, NULL WHERE EXISTS (SELECT 1 FROM payments WHERE id=$pid AND organization_id=$org AND xmin = pg_current_xact_id()::xid) ON CONFLICT (id) DO NOTHING RETURNING id` →
`UPDATE invoices SET amount_paid_cents = GREATEST(0, amount_paid_cents - $amt), state = (CASE WHEN GREATEST(0, amount_paid_cents - $amt) >= total_cents THEN 'paid' ELSE 'open' END)::invoice_state, updated_at=now() WHERE id=$inv AND organization_id=$org AND EXISTS (SELECT 1 FROM refunds WHERE id=$refundId AND xmin = pg_current_xact_id()::xid)` →
final SELECTs (`SELECT payment_id, amount_cents FROM refunds WHERE id=$refundId`; invoice state). Replay only when the refund row matches `payment_id`, `amount_cents` and `reason`, else `refund_id_conflict` (409).
Ruling: a manual refund is "undo the recording" — the invoice returns to `open`
whenever a balance remains and never becomes `refunded` (the office voids a
fully-refunded, now `open` $0-paid invoice with the existing void action). Card
refunds keep the established semantics (fully refunded → `refunded`; partial of a
fully-paid invoice stays `paid`) but their invoice state is now computed in SQL
from the row being updated — `(CASE WHEN GREATEST(0, amount_paid_cents - $amt) <= 0 THEN 'refunded' WHEN GREATEST(0, amount_paid_cents - $amt) >= total_cents OR state = 'paid'::invoice_state THEN 'paid' ELSE 'open' END)::invoice_state`
— so a concurrent manual payment can no longer be overwritten by a stale JS literal (render test). Admin copy on a manual refund: "Refund recorded.
Return the money to the customer yourself."

### 5.7 The mock gate — `src/lib/payments/card-enabled.ts`

`cardPaymentsEnabled()` = `getPaymentProvider().name !== 'mock'` (today always
false; it exists so M4 flips one function). Applied at the routes only (no in-function gates — `takePayment`'s default
parameter makes a "provider undefined" check dead code):
- `POST /api/portal/[token]/pay` → 409 `CARD_PAYMENTS_UNAVAILABLE` "Online payment isn't available yet." after the rate check and before the token resolves (no token information is needed to refuse). The portal page hides Pay now and shows "Pay your technician in person{, or call <phone>}." with the org's phone as a `tel:` link when one is configured.
- `POST /api/admin/invoices/[id]/payments` with `method: 'card'` → 409 `CARD_PAYMENTS_UNAVAILABLE`; the admin dialog's method control shows Cash / Check / Other (no Card in M3b; M4 adds it behind the flag).
- `enrollCustomer({ chargeFirstPeriod: true })` → the membership route refuses 409 `CARD_PAYMENTS_UNAVAILABLE` before calling it (no form control exists; API-only gate).
- `reconcilePayment`: the SELECT also reads `provider`; BEFORE `getCharge`, a `pending` payment whose `provider` is `mock` while cards are disabled is treated as a FAILED charge in ONE batch (the mock never moved money and the claim already credited the invoice — a permanent `noop` would leave a phantom credit): `UPDATE payments SET status='failed'::payment_status, updated_at=now() WHERE id=$pid AND organization_id=$org AND status='pending'::payment_status` then `UPDATE invoices SET amount_paid_cents = GREATEST(0, amount_paid_cents - $amt), state = (CASE WHEN GREATEST(0, amount_paid_cents - $amt) >= total_cents THEN 'paid' ELSE 'open' END)::invoice_state, updated_at=now() WHERE id=$inv AND organization_id=$org AND state IN ('open'::invoice_state,'paid'::invoice_state) AND EXISTS (SELECT 1 FROM payments WHERE id=$pid AND xmin = pg_current_xact_id()::xid)` (the existing two-statement failed branch is replaced by this batch for every provider); and the succeeded branch's invoice state write becomes SQL: `state = (CASE WHEN amount_paid_cents >= total_cents THEN 'paid' ELSE 'open' END)::invoice_state WHERE … AND state IN ('open'::invoice_state,'paid'::invoice_state)` (a stale JS literal could overwrite a concurrent manual payment's `paid`).
- `integrations-status` keeps reporting `mock`; `seed-org.mjs` keeps writing `provider='mock'` rows (fictional history, not a charge path).
Tests to update for the route gates: `tests/api/portal-pay-route.test.ts`, `tests/api/money-routes.test.ts` (the payments schema now requires `method`), `src/lib/portal/portal-queries.test.ts` is unaffected (no in-function gate).

### 5.8 Estimate-born invoices

`createInvoiceFromSoldEstimate` keeps its estimate-id early return FIRST (a
re-click returns the existing invoice id), then takes `L_req` (when the estimate
has a request) and inserts with `… WHERE NOT EXISTS (SELECT 1 FROM invoices WHERE organization_id=$org AND service_request_id=$rid AND state='draft'::invoice_state AND P_native)`
→ 0 rows → `request_has_draft` (route 409 `INVOICE_ALREADY_EXISTS` "This request
has a draft invoice in the field. Finalize or void it first."). Only a DRAFT
refuses (that is where seeded materials could duplicate the estimate's lines); an
open field invoice (say an $89 diagnostic) coexists with the estimate invoice and
the field GET lists it under `otherOpen` (§5.1). The reverse order adopts the
estimate-born invoice.

### 5.9 Receipts, queue drain, audit

On `created: true` payments (tech and admin) with a non-null `customer_id`: `after(async () => { await triggerPaymentReceipt(...); await processPendingJobs(); })` — the drain is mandatory (Hobby's daily cron would deliver the receipt next morning). Pay-link likewise drains in `after()` and returns `{ queued: true }`. Nothing on replay. Audit (ids/enums only): `invoice_created` (`invoiceId created:bool`), `invoice_line_added`/`invoice_line_removed` (`invoiceId lineId`), `invoice_finalized` (`invoiceId`), `payment_recorded` (`paymentId invoiceId method invoiceState`), `pay_link_sent` (`invoiceId`), `signature_recorded` (`requestId`), admin `invoice_finalized` (`invoiceId`); the admin payments route's action becomes `payment_recorded` with `method`.

## 6. Tech API

### 6.1 Authorisation (every route under `/api/tech/jobs/[id]/invoice`)

In order: tech session (401) → `isSameOriginRequest` on writes (403 `FORBIDDEN`; the money routes get the same guard the tech login has) → `isUuid(id)` (400 `INVALID_ID`) → rate limit `tech:invoice:write:${userId}` (`RATE_LIMITS.adminMutation`) / `tech:invoice:read:${userId}` (`adminRead`) → `findReadableJob` (404 `NOT_FOUND` "This job isn't yours.") → native (409 `MANAGED_EXTERNALLY`) → writes: active lead (`findActiveVisit(org, rid).leadTechnicianId === me`, else 403 `NOT_LEAD`) → on site: request status ∈ {`arrived`, `in_progress`, `on_hold`, `completed`} else 409 `NOT_ON_SITE` → body (`readJsonBody` → 400 `INVALID_INPUT`) → idempotency (§4) → writer (in-write `stillLead`, §5).

### 6.2 Routes

| method path | body | does | returns |
| --- | --- | --- | --- |
| GET …/invoice | — | §6.2.1 | 200 |
| POST …/invoice | `{}` + key | adopt or create the draft, lines seeded from materials | 201 `{ invoiceId, state, created }` (200 on adopt/replay) |
| POST …/invoice/lines | `{ invoiceId, pricebookItemId, quantity }` or `{ invoiceId, jobMaterialId }` + key | add a line while draft | 201 `{ lineId, invoiceId }` |
| DELETE …/invoice/lines/[lid]?invoiceId= | — | remove a line while draft | 200 `{ removed }` |
| POST …/invoice/finalize | `{ invoiceId }` + key | CAS draft → open, snapshots the signature | 200 `{ invoiceId, state, changed }` |
| POST …/invoice/payments | `{ invoiceId, method: 'cash'\|'check', amountCents, checkNumber? }` + key | manual payment on an open invoice | 201 `{ paymentId, invoiceId, invoiceState, created }` |
| POST …/invoice/pay-link | `{ invoiceId }` + key | queue the portal link by SMS (§6.4) | 200 `{ queued: true }` |
| GET /api/tech/pricebook?scope=invoice&q= | — | active items of every type, server search (name/sku/description), `q` ≥ 2 chars, limit 50, `{ id, name, type, priceCents, sku }`, rate-limited `tech:pricebook:${userId}` (`adminRead`) | 200 |

Every write names the invoice it targets (`invoiceId` in the body, so it is part
of the request hash). Lines and finalize require it to be the request's newest
live invoice (else 409 `STALE`: the office voided it, or a newer one exists);
payments and pay-link accept ANY non-void native invoice of the request (so an
older open invoice listed in `otherOpen` can still be collected) and let the
writer refuse (`invoice_not_chargeable`). Both checks run INSIDE the
idempotency `run`, after the replay lookup — a retry of the payment that just
flipped the invoice to `paid` replays `created: true` instead of meeting STALE. The existing `GET /api/tech/pricebook` (materials picker) is unchanged, and
`addJobMaterial` now rejects `type = 'service'` items server-side (`item_not_found`)
since service ids reach the client through the invoice search.

#### 6.2.1 GET contract

```
{ invoice: null | { id, state, subtotalCents, taxCents, taxBps /* draft only; derived tax_cents/subtotal on open+ */, totalCents, amountPaidCents, balanceCents,
                    issuedAt, fromEstimate: boolean,
                    lines: [{ id, name, quantity, unitPriceCents, lineTotalCents }],      // lead only; ordered created_at, id
                    payments: [{ id, method, checkNumber, amountCents, status, createdAt }], // lead only
                    signature: { state: 'none'|'present'|'erased'|'unavailable'|'estimate', signedAt, signatureName, url, fresh: boolean } }, // the INVOICE's snapshot once open/paid; while draft, the request's current signature with fresh = signedAt >= invoice.updatedAt (the approval sheet shows the pad unless fresh)
  otherOpen: [{ id, totalCents, balanceCents }],                   // other open native invoices on the request
  history: null | { id, state, totalCents },                       // newest paid/refunded/void when no live invoice
  materialsNotOnInvoice: [{ id, name, quantity, unitPriceCents }], // lead only, draft only
  pendingWrite: boolean,                                           // EXISTS an in_progress key younger than 2 min for (org, user) whose route LIKE '/api/tech/jobs/<rid>/%' (invoice AND signature routes; PK-prefix lookup)
  customerHasPhone,                                                 // boolean, no value
  isLead, onSite, externalInvoice,
  allowed: ('create'|'add_line'|'remove_line'|'finalize'|'record_payment'|'pay_link'|'sign')[] }
```
No cost field ever appears (`cost_cents`, `unitCostCents`, `markupPct` are not
selected; a route test asserts no key containing `cost`). Non-leads get
`invoice` reduced to `{ id, state, totalCents, balanceCents }` and no lines,
payments, signature name/url or materials. The signed read URL is built in a
try/catch (`getStorageClient()` throws without R2 env) → `state: 'unavailable'`;
`erased` = `signed_at` set and `signature_url` null. `allowed` comes from the pure
`invoiceAllowedActions({ state, isLead, requestStatus, balanceCents, signed, lines })`.

### 6.3 Reason → code map (`src/lib/tech/invoice-errors.ts`, tested)

| reason | status code | message |
| --- | --- | --- |
| `managed_externally` | 409 `MANAGED_EXTERNALLY` | This job is managed in FieldPulse. |
| `external_invoice` | 409 `EXTERNAL_INVOICE` | This job's invoice lives in FieldPulse. |
| `not_lead` | 403 `NOT_LEAD` | Only the lead technician can do that. |
| `not_on_site` | 409 `NOT_ON_SITE` | Arrive at the job before invoicing. |
| `invoice_not_found` | 404 `NOT_FOUND` | No invoice on this job yet. |
| `invoice_voided` | 409 `INVOICE_VOIDED` | The office voided that invoice. Create a new one. |
| `invoice_locked` | 409 `INVOICE_LOCKED` | This invoice is finalized. Changes need the office. |
| `no_lines` | 409 `NO_LINES` | Add at least one item first. |
| `already_billed` | 409 `ALREADY_BILLED` | That material is already on an invoice. |
| `item_not_found` | 404 `ITEM_NOT_FOUND` | That item isn't available. |
| `invoice_not_chargeable` | 409 `INVOICE_NOT_CHARGEABLE` | This invoice can't take a payment right now. |
| `exceeds_balance` | 422 `EXCEEDS_BALANCE` | That's more than the balance due. |
| `synced_read_only` | 409 `INVOICE_SYNCED_READ_ONLY` | This invoice is managed in FieldPulse. |
| `no_contact` | 409 `NO_CONTACT` | No phone (or email) on file for this customer. |
| `no_template` | 409 `NO_TEMPLATE` | Pay link messages aren't set up. Ask the office. |
| `cooldown` | 409 `COOLDOWN` | A link went out a moment ago. |
| `demo_restricted` | 403 `DEMO_RESTRICTED` | Messages are off on the demo account. |
| `payment_id_conflict` / `refund_id_conflict` | 409 `ID_CONFLICT` | That payment token was already used. Try again. (office only) |
| `stale` / 40P01 | 409 `STALE` | This job changed. Refresh and try again. |

Copy ruling: the technician app says "job" (M3a's established tech copy), the
office says "request"; UI spelling is "finalize".

### 6.4 Pay link (tech)

`sendInvoicePayLink(org, invoiceId)` (SMS only) in `money-triggers.ts` shares the
private contact lookup and portal-token mint with `sendInvoiceReminder` but:
trigger type `invoice_sent` (template `invoice_sent_sms`: "{{companyName}}: your
invoice {{invoiceNumber}} ({{amount}}) is ready to view: {{payLink}}"), a null
`customer_id` or no phone → `no_contact`, a missing template → `no_template`, the
demo org (`organizationId === DEMO_ORG_ID`, from `@/lib/tenancy/organization`;
`isDemoAccount` is an email check on an admin session and does not apply to
technicians) → `demo_restricted`, and ORDER: (1) read `$previous = pay_link_sent_at`, then claim the per-invoice
5-minute cooldown (longer than the 2-minute idempotency takeover window, so a crashed first send is never followed by a second text) with a JS timestamp `$now` and the in-write lead check: `UPDATE invoices SET pay_link_sent_at = $now WHERE id=$i AND organization_id=$org AND (pay_link_sent_at IS NULL OR pay_link_sent_at < $now - interval '5 minutes') AND (stillLead) RETURNING id` (0 rows → `COOLDOWN` while still lead, else `NOT_LEAD`)
(0 rows → `cooldown`, BEFORE any token mint so a refused tap never rotates the
link just sent; the same pattern `sendInvoiceReminder` uses), (2) mint the
portal token, (3) queue. A definite failure in (2) or before the queue insert
releases the claim with `SET pay_link_sent_at = $previous WHERE pay_link_sent_at = $now`;
a failure after the insert does not. No touch of `last_reminder_sent_at`.
The link is sent regardless of the provider: the portal shows the invoice and,
while the mock is active, "Pay your technician in person" (§5.7); the SMS copy says
"view", never "pay". Receipt and pay-link messages drain through
`processPendingJobs()` in `after()`.

### 6.5 Signature route changes (`POST /api/tech/jobs/[id]/signature`)

Order: session → same-origin → UUID → rate → readable → native (new: 409
`MANAGED_EXTERNALLY`) → active lead → `Idempotency-Key` claim with the multipart
hash BEFORE the upload (architecture rule; the client captures the PNG Blob once
per intent so a retry hashes the same bytes, and mints a new key when the pad is
redrawn) → upload → `recordSignature` (unchanged guard). The request's signature
is always re-capturable: it is the job sign-off. The evidence that matters for
money is the snapshot finalize copies onto the invoice (§5.4), which no route
writes afterwards. `recordSignature` returns the previous URL atomically
(`UPDATE service_requests … FROM (SELECT id, signature_url AS old FROM service_requests WHERE id=$rid AND organization_id=$org FOR UPDATE) o WHERE service_requests.id = o.id … RETURNING o.old`),
and the route deletes that object in `after()` unless an invoice snapshot
references it (`EXISTS (SELECT 1 FROM invoices WHERE organization_id=$org AND signature_url=$old)`).
`getTechJobSummary` exposes `signedAt`; the job detail page shows the existing
signature with "Sign again" instead of a bare pad.

## 7. UI — S40 `/tech/jobs/[id]/invoice`

`src/app/tech/jobs/[id]/invoice/page.tsx` (server shell, awaits `params`) +
`src/components/tech/invoice/*` (client). Base shadcn primitives only, `h-11`/`h-12`
targets, `font-mono tabular-nums` money via `formatCentsExact`, inline
`role="alert"` errors, sentence case. The signature pad moves to
`src/components/tech/signature-pad.tsx`, shared with the job detail page.

Entry: the job detail page shows an **Invoice** card for native jobs once the
request is `arrived`/`in_progress`/`on_hold`/`completed`: state chip (No invoice
yet / Draft / Open · $balance due / Paid) and a 44 px "Open invoice" link; a
helper sees the chip and "The lead technician handles the invoice."; a synced job
shows "Invoice in FieldPulse."

Happy path from the card to paid, counted: Open invoice (1) → Create invoice (2)
→ [Add item → search → tap result → Add: 4, only when something is missing] →
Customer approval (3) → sign + name + "Approve and finalize" (4) → the record
sheet opens itself → Check (5, remembers the last method in `localStorage`) →
check number (typing) → "Record $x" (6). Six taps plus typing on the common
path; ten with one added item. Target ≤ 12 met.

Sections:
1. Header: back link, customer name, reference number, state chip.
2. **No invoice yet**: "Start from the N materials on this job." + "Create invoice" (h-12). History line when `history` is present ("Previous invoice: Paid $x").
3. **Draft**: lines (`name · qty × unit · total`), 44 px remove per row; "Add item" bottom sheet (search ≥ 2 chars, 300 ms debounce, 44 px result rows with price, quantity stepper 1–999, "Add" keeps the sheet open for the next item); "Materials not on this invoice" rows with "Add"; totals (subtotal, tax with rate, total).
   **Customer approval** (h-12 primary, draft with ≥ 1 line): one bottom sheet with the signature pad, printed name, the total, and "Approve and finalize" → the client posts the SIGNATURE first (the request-level capture, its own key and Blob), then finalize (which snapshots it onto the invoice). If the signature step fails, nothing is finalized and the sheet shows the error with "Try again"; if finalize fails after the signature landed, the invoice is still a draft carrying the fresh job signature and "Approve and finalize" retries only finalize (the sheet shows the captured signature instead of the pad). $0 draft: sheet copy "Nothing to collect. This closes the invoice at $0 and locks the lines."
4. **Open / Paid**: lines read-only, totals, "Balance due $x" / "Paid"; signature block (the invoice's snapshot: image + name + time; "No signature" when it was finalized without one, "Signature removed" when erased, "Signature unavailable" when R2 is unreachable); payments list ("Cash", "Check #1234", amount, time); **Record payment** (open, balance > 0): bottom sheet with a Cash | Check segmented control (Card absent), amount defaulting to the balance (`parseDollarsToCents`, max = balance with an inline error), check number (Check only, optional), "Record $x"; processing disables the sheet; success closes it, re-fetches, and shows "Payment recorded. A receipt is texted if the customer accepts texts." when `customerHasPhone`. **Send pay link** (open, balance > 0, `customerHasPhone`): secondary h-11 → confirmation sheet "Text the invoice link to the customer?" → "Send".
5. Keys: a pure reducer `nextKeyState(state, event)` (tested in node) behind a thin `useIdempotencyKey` hook. States: `idle` → `armed(key, bodyHash)` when a sheet opens or a primary action is first tapped → `sent` → `resolved` (2xx or a deterministic 4xx: the key is spent) / `unknown` (network error, 5xx, `IN_PROGRESS`). Rules: the same key is reused for every retry while `armed`/`unknown`; **a changed body never gets a new key while the previous intent is `unknown`** — the client first re-sends the OLD body with the OLD key until the answer is definitive (a `done` replay shows the result; a 4xx spends the key; `IN_PROGRESS` keeps waiting), and only then mints a new key for the new body. The GET's `pendingWrite` shows "Still saving your last tap…" and disables primary actions while true. `unknown` intents (key, body hash, body) are persisted in `sessionStorage` per job so a reload cannot mint a fresh key while a request may still be in flight; the reducer rehydrates them on mount. The spent-vs-unknown decision uses the same `STORED_CODES` constant as the server (§4).
6. Error handling: network error / 5xx → GET; if the state advanced (new invoice/line/payment/signature), show it and drop the intent; else "Try again" with the same key. 409 `IN_PROGRESS` → wait 2 s, GET, same rule (the server takes over after 2 minutes). 409 `STALE`/`INVOICE_LOCKED`/`INVOICE_VOIDED` → re-fetch and show the message. 422 `EXCEEDS_BALANCE` → re-fetch (the balance changed), new key. 422 `IDEMPOTENCY_KEY_REUSED` → re-fetch; when `details.storedStatus` is 2xx: "Your last change was already saved. Check the invoice and try again."; otherwise: "That tap didn't go through. Try again." with a new key. A stored 500 from pay-link → "Couldn't send the link. Try again." with a new key on the next tap. The signature image re-fetches the GET on `onError` (the signed URL expires after 15 minutes).

## 8. Admin and portal surfaces

- Admin invoice detail: "Record payment" card with method (Cash / Check / Other), check number for Check, amount, deposit checkbox; the dialog mints a `clientToken = crypto.randomUUID()` when it opens (new token after a success or an `ID_CONFLICT`) and sends it; the server derives `paymentId` from it (§5.5), so a double-click or a browser retry records once. Draft invoices are not payable by cash/check (409 `INVOICE_NOT_CHARGEABLE` "Finalize the invoice first."); a new **Finalize** button on native drafts calls `POST /api/admin/invoices/[id]/finalize` (admin session, `isUuid`, rate key `admin:invoice-finalize:${userId}`, `finalizeInvoice` with `$leadOrAdmin = TRUE` and `$rid` = the invoice's request, reason map `no_lines` → 409 `NO_LINES`, `invoice_locked` → 409 `INVOICE_LOCKED`, `invoice_not_found` → 404, `synced_read_only` → 409 `INVOICE_SYNCED_READ_ONLY`; audit `invoice_finalized`, underscore convention like `invoice_created`/`payment_taken`) so a draft a technician left behind is never stranded; `card` on a draft keeps today's `takePayment` behaviour behind the gate; because `T` and line removal require `amount_paid_cents = 0`, lines freeze once any card deposit lands (relevant in M4). Payment rows show the method chip and check number. The refund dialog mints its token the same way; manual refunds use §5.6 and show the manual copy.
- Admin payments route schema: `{ clientToken: uuid, method: 'card'|'cash'|'check'|'other', amountCents, checkNumber?, isDeposit? }` via `readJsonBody`; audit `payment_recorded`. Test budget: `tests/api/money-routes.test.ts` (7 payment cases + 5 refund cases rewritten for the new bodies and the `recordManualPayment` mock), `tests/api/portal-pay-route.test.ts` (token-path cases now need a non-mock provider stub via a `cardPaymentsEnabled` mock to keep their coverage, plus one new gate case).
- Accounting CSV: payment memo `Payment <id> (invoice <invoiceId>, <method>)`; header unchanged.
- Portal: button hidden + route gate + phone line (§5.7). The admin invoice document renders the INVOICE's own signature snapshot (signed read URL) for open/paid/refunded/void invoices; for a draft it shows the request's current signature labelled "Job signature (not yet on the invoice)".
- Aggregates: no change (they filter `status`/`fieldpulse_payment_id`, so manual payments count as collected); `listStuckPayments` adds `provider <> 'manual'`.
- `scripts/agent/mint-tech-session.mjs` honours `MINT_ORG_ID` (deviation from v3's "unchanged": without it every probe minted a technician from another org, usually the FieldPulse-connected default); probes insert a technician in the throwaway org by SQL and a request with `assigned_to` so the trigger makes the lead row; probe fetches send an `Origin` header (the same-origin guard denies a missing one); any probe that drains the communication queue first asserts zero pending jobs.

## 9. Erase (same PR)

`storageKeyFromPublicUrl(url)` (pure: strips `R2_PUBLIC_URL + '/'`; unknown
prefix → null, logged by id). `anonymizeCustomer` reads the signature URLs (requests AND invoices) BEFORE
the scrub, nulls `signature_url` and `signature_name` on both (keeping
`signed_at`) and schedules the objects' deletion; the GET shows "Signature
removed".
`purgeOrganization` passes keys, not URLs (today it passes the full URL, which
never matches — a verified defect).

## 10. Tests, probes, gates

- Pure vitest (mocked `db.batch`, `PgDialect` renders): idempotency hashing and decision table; every writer's statement order, lock order, casts, xmin gates, NOT EXISTS guards, tenant params (count asserted), the parenthesised `P_live`; reason→code map; `invoiceAllowedActions`; `useIdempotencyKey`; `storageKeyFromPublicUrl`; admin route schema; portal/admin/membership gates; reconcile's SQL state write; the estimate creator's refusal; `addJobMaterial` service rejection; updated `tests/api/portal-pay-route.test.ts` and `tests/api/money-routes.test.ts`.
- Integration suite `tests/integration/field-invoice.test.ts` (in `INTEGRATION_SUITES`; throwaway org via `createOrgCore`; requests by SQL only): the done-when through the writers (create → line → finalize → check payment → paid); replay of create and payment with the same key → one each; different body, same key → 422; two concurrent creates with different keys → one draft, the second adopts; two concurrent payments above the balance → one lands; takeover of a 3-minute-old `in_progress` row credits once; a crashed first run (payment row present, key deleted) re-run credits once; manual refund returns the invoice to `open`; estimate creator refuses on a field draft and coexists with an open one; a second invoice after a paid one seeds only unbilled materials; finalize snapshots the signature and a later re-sign leaves the invoice's copy intact; an office token reused on another invoice → `ID_CONFLICT` with no credit; migrations 0052 and 0053 apply twice statement by statement; the one-draft index refuses a second draft.
- Live probes per task (dev server, `mint-tech-session --user <lead>`, admin token): every raw-SQL writer once for real (the cast rule); 390 px screenshots: no invoice / draft with lines / approval sheet / open with signature + record sheet / paid.
- Gates: tsc 0, eslint 0 errors, `npx vitest run` ≥ 4964 passed / 1 skipped (baseline `a3c2b23`, rewritten tests included), `node scripts/agent/verify-skills.mjs` 0 missing, `drizzle-kit generate` "No schema changes".

## 11. Docs and parity

`replica/features.csv`: 134 → yes, 135 → yes (manual; card M4), 185 → yes, 168 note updated (stays partial). `replica/build-log.md` rows S40 and S20. `replica/architecture.md` M3b rows annotated with deviations (invoice signature snapshot, `invoiceId` in every body, pay-link cooldown column and SMS only, manual refund semantics, $0 → open, no due date, admin finalize). Skills: `page-tech`, `page-invoices`, `page-portal`, `admin-pages` (idempotency recipe, mock-gate rule, client-minted ids for office money forms). Memory: `replica-program-fp-st`.

## 12. Rulings (v3; critics: attack them)

1. Cash/check payments require `open` for the field AND the office; drafts are never payable by hand; an admin finalize route exists so no draft is stranded.
2. Adopt only draft/open; paid/refunded/void are history and a new draft may follow; an estimate-born open invoice is adopted unseeded and cannot take field lines; other open invoices are listed, never hidden.
3. Manual refunds undo the recording (invoice back to `open` while a balance remains, never `refunded`); card refunds keep their semantics with the state computed in SQL.
4. $0 drafts finalize to `open` (voidable), not `paid`.
5. No due date in M3b; `issued_at` is set.
6. The invoice carries its own signature snapshot from finalize — only a signature newer than the invoice's last change; otherwise "No signature" (immutable evidence); the job-level signature is always re-capturable. The approval sheet signs first, then finalizes.
7. A key with a different hash is 422, stale or not; only 2xx and deterministic 4xx are stored; everything else deletes the row so a retry re-evaluates.
8. Office money forms send a client token; the server derives org-scoped (not invoice-scoped) ids from it; a token reused for a different invoice, amount, method, check number or deposit flag is `ID_CONFLICT`, never a silent success.
9. The pay link is SMS only, sent regardless of the provider; cooldown 5 minutes per invoice claimed BEFORE the token mint.
10. Every tech write names its `invoiceId`; lines/finalize require the newest live invoice (else 409 `STALE`); payments/pay-link accept any non-void native invoice of the request; replay precedes both checks.
11. Materials are billed at most once per request across non-void invoices (`job_material_id` link); a sold-estimate job bills materials through the office.
12. Tech copy says "job"; office copy says "request".
