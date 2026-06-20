# FieldPulse Invoice Sync (Pull Mirror) — Design Spec

**Date:** 2026-06-19
**Status:** Hardened after 5-critic adversarial review (2026-06-19) → ready to execute
**Scope decision (user, 2026-06-19):** money-grade **PULL mirror** — read-only FieldPulse → us. FieldPulse is the source of truth for synced invoices; we never push or take payment on them.

## Why this exists

The repo already has three pieces that don't connect:

1. **FieldPulse integration template** — `src/lib/integrations/fieldpulse/{config,types,client,connection-queries,rate-limiter,webhook-signature}.ts` + per-entity `*-sync.ts` (customer, job, technician) + webhook/connect/status routes + a cron. This is the pattern to follow.
2. **Native invoice system** — `invoices` / `invoice_line_items` / `payments` / `refunds` tables (`schema.ts:2233+`), `invoice-queries.ts`, `/api/admin/invoices/*`, and `/admin/invoices` UI. Full money handling in **cents**. Source of truth for **native** invoices (materialized from sold estimates).
3. **Partial FieldPulse invoice path** — `invoice-sync.ts` (`syncInvoiceStatus`) + `invoice-webhook/route.ts` only mirror a `none|sent|paid|void` **status enum** onto `service_requests.invoiceStatus` (`schema.ts:544`). No money, no link to the native `invoices` table.

This spec completes #3 into a **money-grade pull mirror**: FieldPulse invoices (total, status, due/paid dates) land as rows in the native `invoices` table, idempotently, following the #1 template, so admins see real billed amounts in one place. The lightweight status path (#3) stays for the request-level badge.

## What "done" means

- A FieldPulse invoice for a connected org appears as an `invoices` row (with `fieldpulseInvoiceId` set) with the right `totalCents` and `state`, linked to the service request and customer when resolvable.
- Re-syncing the same FieldPulse invoice updates the existing row (idempotent on `fieldpulseInvoiceId`), never duplicates.
- A pulled invoice is **read-only** in native money flows: `takePayment` / `refundPayment` / `reconcilePayment` refuse to act on it.
- Missed/failed webhook pulls are recovered by a periodic reconcile cron (the durability backstop — see Component 6).
- All invariants below hold; `npm run test:unit`, `tsc`, `npm run eval` stay green.

## Invariants (NEVER cross)

1. **Money authority stays with FieldPulse for synced invoices.** A synced invoice (`fieldpulseInvoiceId IS NOT NULL`) is a read-only mirror. Native `payments`/`refunds` must never be created or reconciled against it. This is the load-bearing safety rule — it prevents double-charging a customer who already paid in FieldPulse. Enforced in code in **`takePayment`, `refundPayment`, AND `reconcilePayment`** (Component 4).
2. **Cents only**, integers, never floats (matches the native invoice system).
3. **Org from the server, never from the webhook payload.** Org is derived by looking up the FieldPulse job id, exactly as the existing webhook does (`invoice-webhook/route.ts:93-107`), and the HMAC signature is verified against that org's secret **before any state change, including scheduling the background pull**. (The existing job-id→org lookup and its narrow 401-vs-200 enumeration oracle are a pre-existing, accepted platform tradeoff documented at `invoice-webhook/route.ts:123-125`; this spec does not change it and does not widen it — the pull is org-scoped to the derived, signature-verified org.)
4. **Idempotent on `fieldpulseInvoiceId`** via a per-org partial unique index + `onConflictDoNothing` with a defined re-select outcome (Component 3). Discrimination of synced-vs-native is **`fieldpulseInvoiceId IS NOT NULL`** (the codebase convention — `fieldpulseCustomerId`/`fieldpulseJobId`/`fieldpulseUserId` are bare id columns, no `source` enum).
5. **Degrade-safe**: no client / not connected / API error → log at WARN and return an outcome, never throw, never block the webhook or cron.
6. **No PII in logs or audit** — ids, enums, cents only (matches existing `invoice_status_updated` audit).
7. **Secrets encrypted at rest** (existing `fieldpulse_connections` AES-256-GCM); never logged.
8. **Source-aware reporting.** A service request can legitimately have BOTH a native invoice (from a sold estimate) and a synced FieldPulse invoice. Revenue/aging queries MUST filter/group by source (native vs `fieldpulseInvoiceId IS NOT NULL`) so the two are never summed into a double count. (No DB constraint blocks the dual state — it is valid during migration; the rule is on the read side.)

## Data shape reality (honest constraints)

- `FieldpulseInvoice` (`types.ts:111`, verified) carries **`id, jobId, customerId, status, total (cents), dueDate, paidAt, createdAt`** — **no line items, no partial-paid amount**. Therefore the mirror is **invoice-level only**: `totalCents = total`, `subtotalCents = total`, `taxCents = 0`, and **no `invoice_line_items`** for synced invoices.
- `amountPaidCents`: `totalCents` when state is `paid`, else `0`. ⚠️ **This is binary, not authoritative for partial payments** — FieldPulse's type exposes no paid amount. The invoice detail UI must show a "synced from FieldPulse — see FieldPulse for the authoritative balance" note (Component 7). This is acceptable because synced invoices are read-only (no native collection acts on the balance).
- Client methods already exist and are verified: `getInvoice(invoiceId)` (`client.ts:534`) and `listJobInvoices(fieldpulseJobId)` (`client.ts:547`). **No new client methods needed.**

## Architecture

Read-only pull, two live entry points (webhook, cron), one core function. **The pull always fetches CURRENT state from FieldPulse via `client.getInvoice()`**, so webhook event *ordering* is irrelevant — a stale `invoice.sent` arriving after `invoice.paid` still re-syncs the row to FieldPulse's true current state. The webhook event only names *which* invoice to (re)pull.

```
invoice.* webhook (after signature+replay+idempotency pass) ──┐
reconcile cron (durability backstop) ────────────────────────┼──> pullInvoiceFromFieldpulse(org, fieldpulseInvoiceId)
                                                              │      │
                                                              │      ├─ getFieldpulseClient(org) → null? "skipped"
                                                              │      ├─ client.getInvoice(id) → null? "skipped"
                                                              │      ├─ resolve serviceRequestId  (org-scoped: (org, fieldpulseJobId))
                                                              │      │  + customerId             (org-scoped: (org, fieldpulseCustomerId))
                                                              │      ├─ map status → invoiceStateEnum; compute totals (cents)
                                                              │      ├─ find-or-create invoices row, idempotent on (org, fieldpulseInvoiceId):
                                                              │      │    db.batch([ upsert-or-insert, audit ])
                                                              │      ├─ best-effort syncInvoiceStatus(jobId, status, org)  (request badge)
                                                              │      └─ return "created" | "updated" | "skipped" | "failed"
```

### Component 1 — Schema (`schema.ts` + hand-authored migration)

Add to the `invoices` table:
- `fieldpulseInvoiceId text("fieldpulse_invoice_id")` (nullable; plaintext — FieldPulse's public resource id, not a secret). This column **is** the synced-vs-native discriminator. **No `source` enum** (cut on review — redundant with the nullable id, and inconsistent with the codebase convention).
- Partial unique index `invoices_org_fieldpulse_invoice_id_unique` on `(organizationId, fieldpulseInvoiceId) WHERE fieldpulseInvoiceId IS NOT NULL` (per-org, mirrors `users_org_fieldpulse_user_id_unique` at `schema.ts:322`).

Add to the `customers` table (hardening — currently `fieldpulseCustomerId` at `schema.ts:674` has **no index**, so customer resolution relies on it being unique-per-org but nothing enforces it):
- Partial unique index `customers_org_fieldpulse_customer_id_unique` on `(organizationId, fieldpulseCustomerId) WHERE fieldpulseCustomerId IS NOT NULL`.

**No `invoiceSyncEnabled` toggle** (cut on review). The cited "availability sync is toggle-gated" precedent is false — the availability cron runs for **all** `connected = true` orgs with no enable flag (`sync-fieldpulse-availability/route.ts:45-47`, verified). Invoice sync matches: it runs for all connected orgs. (Pulling is read-only and low-risk, same risk profile as availability.)

**Exact migration SQL** (hand-authored in `drizzle/00NN_fieldpulse_invoice_mirror.sql`; the repo runs migrations manually — memory "migrations-not-run-on-deploy" — `npm run db:migrate` after adding; verified other hand-authored migrations exist, e.g. `0017_gdpr_deletion.sql`):

```sql
ALTER TABLE invoices ADD COLUMN IF NOT EXISTS fieldpulse_invoice_id text;
CREATE UNIQUE INDEX IF NOT EXISTS invoices_org_fieldpulse_invoice_id_unique
  ON invoices (organization_id, fieldpulse_invoice_id)
  WHERE fieldpulse_invoice_id IS NOT NULL;
CREATE UNIQUE INDEX IF NOT EXISTS customers_org_fieldpulse_customer_id_unique
  ON customers (organization_id, fieldpulse_customer_id)
  WHERE fieldpulse_customer_id IS NOT NULL;
```

(No `CREATE TYPE`, no enum, no `fieldpulse_connections` change.) Keep the Drizzle schema (`schema.ts`) in sync with these two columns/indexes so `tsc` and queries match.

### Component 2 — Status mapping (`invoice-sync.ts`)

Add a **named export** `mapFieldpulseStatusToInvoiceState(status): "draft"|"open"|"paid"|"void"`:
- `sent|emailed|viewed|overdue` → `open`
- `paid|payment_received|complete` → `paid`
- `void|voided|cancelled|canceled` → `void`
- `draft|pending|null|unknown` → `draft`

Kept SEPARATE from the existing `mapInvoiceStatus` (which returns the *request* enum `none|sent|paid|void`) — they target different enums and consolidating would refactor working code for marginal gain (review suggestion rejected). Add a one-line comment cross-referencing the two so a future status change updates both. `refunded` (native-only) is never produced here.

### Component 3 — Pull module (`invoice-sync.ts`, named exports)

```
export type InvoicePullOutcome = "created" | "updated" | "skipped" | "failed";

pullInvoiceFromFieldpulse(
  organizationId: string,
  fieldpulseInvoiceId: string,
  fetchImpl?: typeof fetch,
): Promise<InvoicePullOutcome>
```

Follows the customer-sync anatomy (`customer-sync.ts:188`):
1. `getFieldpulseClient(organizationId, fetchImpl)` → `null` ⇒ `"skipped"`.
2. `client.getInvoice(fieldpulseInvoiceId)` → `null` ⇒ `"skipped"`.
3. Resolve links (both optional, **explicit org-scoped compound keys**):
   - `serviceRequestId`: `serviceRequests` where `and(eq(organizationId), eq(fieldpulseJobId, invoice.jobId))`.
   - `customerId`: `customers` where `and(eq(organizationId), eq(fieldpulseCustomerId, invoice.customerId))`.
4. `state = mapFieldpulseStatusToInvoiceState(invoice.status)`; `totalCents = invoice.total ?? 0`; `subtotalCents = totalCents`; `amountPaidCents = state === "paid" ? totalCents : 0`.
5. Find-or-create, idempotent on `(org, fieldpulseInvoiceId)`:
   - SELECT existing by `(org, fieldpulseInvoiceId)`.
   - **exists** ⇒ `db.batch([ UPDATE state/subtotalCents/totalCents/amountPaidCents/updatedAt WHERE (org, id), audit-insert ])`; return `"updated"`.
   - **none** ⇒ `INSERT {org, fieldpulseInvoiceId, serviceRequestId, customerId, state, subtotal/total/amountPaid}` `.onConflictDoNothing()` on the unique index, `.returning({id})`:
     - inserted ⇒ `db.batch`-pair the audit insert (or insert audit in the same batch as the invoice insert); return `"created"`.
     - **zero rows (lost race)** ⇒ a concurrent pull won; **re-SELECT** by `(org, fieldpulseInvoiceId)` and **return `"updated"`** (never `"created"` — keeps batch metrics honest). If the re-select is somehow empty, return `"skipped"`.
6. Best-effort `syncInvoiceStatus(invoice.jobId, invoice.status, org)` (only if `jobId` present) to keep the request badge in step. This is a SEPARATE call (its own audit) — **not** atomic with step 5. That is acceptable: both are idempotent, and the cron re-pull reconciles any partial state. Document this.
7. Audit `invoice_synced` (in the step-5 batch) with `{ from, to, fieldpulseInvoiceId, totalCents }` — no PII.
8. Wrap the whole function in try/catch ⇒ log WARN, return `"failed"`.

**Atomicity note (neon-http has no interactive transactions):** the invoice write + its audit are grouped in one `db.batch` (single implicit txn, mirrors `createInvoiceFromSoldEstimate` at `invoice-queries.ts:119-127`). The request-status update (step 6) is intentionally outside the batch (separate module/audit); a crash between them leaves the invoice mirrored but the request badge stale — self-healing on the next webhook/cron pull.

**Concurrency:** because the pull reads current FieldPulse state and writes idempotently on `(org, fieldpulseInvoiceId)`, two concurrent pulls of the same invoice converge (one creates, the other re-selects → `"updated"`); amountPaidCents/state are never written by native flows (Invariant #1), so there is no lost-update race with payments.

Add `pullInvoicesForJob(organizationId, fieldpulseJobId, fetchImpl?)`: `client.listJobInvoices(jobId)` → `pullInvoiceFromFieldpulse` for each; returns `{created,updated,skipped,failed}` (for the cron).

### Component 4 — Money-safety guards (`invoice-queries.ts`)

In **`takePayment`, `refundPayment`, AND `reconcilePayment`** (the review caught `reconcilePayment` was missed — it re-reads the invoice at `invoice-queries.ts:428-432` and would otherwise advance `amountPaidCents` on a synced invoice, double-crediting): after loading the target invoice, also select `fieldpulseInvoiceId`; if it is non-null ⇒ throw a typed `InvoiceSyncedReadOnlyError` (mapped to HTTP 409 by the routes; `reconcilePayment` returns its existing failure-result shape with a `synced_invoice_read_only` reason rather than throwing, matching its non-throwing contract). This enforces Invariant #1.

**Do NOT** add a guard to `createInvoiceFromSoldEstimate` (review: the collision is impossible — synced invoices have no `estimateId`, and that function is keyed on `estimateId`; a guard there protects against nothing). Each of the three real guards gets a unit test.

### Component 5 — Webhook extension (`invoice-webhook/route.ts`)

- Extend `invoiceWebhookSchema` to add `invoiceId: z.string()` (the event carries it — `FieldpulseInvoiceEvent.invoiceId`, `types.ts:128`). Keep `jobId` for org resolution. **Keep all existing signature/replay/idempotency logic and ORDER unchanged.**
- **Order is load-bearing:** parse → replay-guard → org lookup → rate-limit → **HMAC signature verify (fail-closed in prod)** → idempotency ledger insert (`onConflictDoNothing`). Only **after** all of these pass and the ledger row is freshly inserted (not a replay) do we schedule the pull:
  `after(() => pullInvoiceFromFieldpulse(organizationId, invoiceId))` — `after()` from `next/server` (verified in use at `chat/route.ts`/`sms/incoming/route.ts`), NOT a detached promise (Vercel freezes the lambda on response; memory "serverless-background-work").
- Still returns `204`. Pull failures are logged inside the module, never surfaced.
- **Durability gap (documented, accepted):** the ledger marks the event processed before the `after()` pull runs; if the pull fails (transient API/DB error), the event is not re-queued. The reconcile cron (Component 6) is the backstop — it re-pulls every connected org's job invoices and will pick up the missed/failed one. Worst-case staleness = one cron interval. This is why the cron is in-scope, not optional.

### Component 6 — Reconcile cron (`/api/cron/sync-fieldpulse-invoices`) — durability backstop

Mirror `/api/cron/sync-fieldpulse-availability/route.ts` (verified pattern):
- Auth via the existing `verifyCronAuth(request.headers.get("Authorization"))` gate.
- For each `fieldpulse_connections` row with `connected = true`: select that org's `serviceRequests` having a non-null `fieldpulseJobId` (org-scoped query: `where eq(organizationId, conn.organizationId)`), call `pullInvoicesForJob(conn.organizationId, jobId)` for each (rate-limiter is inside the client), accumulate a `{created,updated,skipped,failed}` summary, log it. Run the work inside `after(...)` like the availability cron so the route returns fast.
- Register in `vercel.json` crons, daily (`"schedule": "0 11 * * *"` — staggered off the 10:00 availability cron; Vercel hobby daily-limit, matches that cron's cadence).
- Org boundary: the cron iterates `fieldpulse_connections` (org-scoped) and passes each `conn.organizationId` explicitly into every query/pull — no cross-tenant path.

### Component 7 — UI (no toggle)

- Synced invoices already render in `/admin/invoices` (same table). Add:
  - a **"FieldPulse"** source chip in the list + detail, derived from `fieldpulseInvoiceId != null` (no new column to read),
  - **hide/disable** the take-payment and refund controls when `fieldpulseInvoiceId != null` (read-only mirror) — defense-in-depth UX on top of Component 4's server guard,
  - a one-line **"Synced from FieldPulse — see FieldPulse for the authoritative paid balance"** note on synced invoice detail (the partial-payment caveat),
  - empty line-items section is fine (synced invoices have none).
- No connect/status/panel change (no toggle). Sync is automatic for connected orgs.

## Components as isolated units

| Unit | Responsibility | Depends on | Tested by |
|---|---|---|---|
| `fieldpulseInvoiceId` col + indexes | provenance + idempotency key | migration | schema compiles, migration applies |
| `mapFieldpulseStatusToInvoiceState` | FP status → native state | — | pure unit test (table-driven, incl. unknown→draft) |
| `pullInvoiceFromFieldpulse` | one-invoice find-or-create mirror | client, db, syncInvoiceStatus | unit test w/ mock client (created/updated/skip/fail/degrade/lost-race→updated/link-resolution/cents) |
| `pullInvoicesForJob` | per-job batch | pullInvoice | unit test (summary aggregation) |
| money guards | reject native ops on synced (×3 fns) | invoices row + fieldpulseInvoiceId | unit test per fn (takePayment/refundPayment/reconcilePayment) |
| webhook ext | capture invoiceId, schedule pull post-verify | pullInvoice, after() | route test (schema, signature/replay/idempotency precede pull) |
| reconcile cron | recover missed/failed pulls | pullInvoicesForJob, connections | route test (auth, connected-only, org-scoped) |
| UI chips/disabled controls/note | read-only UX + caveat | fieldpulseInvoiceId | component/manual |

## Error handling

Every external touch is degrade-safe (Invariant #5): client null, `getInvoice` null, network error, malformed payload → WARN + outcome, never throw. The webhook never fails because of a pull (pull is in `after()`, post-verify). The cron isolates per-job failures (one bad job doesn't abort the sweep), matching `batchSyncInvoiceStatuses`. Money guards are the one place we refuse (409 / failure-result) — to block an unsafe native mutation, not a 500.

## Testing

- **Pure:** `mapFieldpulseStatusToInvoiceState` (all FP statuses incl. unknown → draft).
- **Unit (mock client):** `pullInvoiceFromFieldpulse` — created; updated (re-sync idempotency); skipped (no client / null invoice); failed (client throws); **lost-race → re-select returns "updated"**; link resolution (job/customer present vs absent, org-scoped); cents mapping; `amountPaidCents` binary on paid; audit batched with the write.
- **Unit:** money guards reject synced (`fieldpulseInvoiceId != null`) for takePayment / refundPayment / reconcilePayment.
- **Route:** invoice-webhook still 204; parses `invoiceId`; schedules the pull ONLY after signature+replay+idempotency pass; replay/duplicate does NOT schedule a pull.
- **Route:** reconcile cron — rejects without secret; processes only `connected` orgs; org-scoped.
- **Gate:** `npm run eval` 30/30 (unaffected — no bot change), `tsc`, full `test:unit`.

## Phases (implementation order)

1. **Schema + migration** — `fieldpulseInvoiceId` + both partial unique indexes (invoices, customers); run `npm run db:migrate`.
2. **Mapping + pull module** — `mapFieldpulseStatusToInvoiceState`, `pullInvoiceFromFieldpulse` (with the lost-race re-select + db.batch audit), `pullInvoicesForJob` + tests.
3. **Money-safety guards** — reject native ops on synced in takePayment/refundPayment/reconcilePayment + tests.
4. **Webhook extension** — capture `invoiceId`, `after()` pull strictly after verify+idempotency + test.
5. **Reconcile cron** — new cron route + `vercel.json` + test (the durability backstop — in-scope, not optional).
6. **UI** — source chip, disabled money controls, synced-balance caveat note.

Phases 1-4 deliver the working webhook-driven mirror; 5 makes it durable (recovers failed pulls); 6 adds the read-only UX + caveat. Each phase is independently testable and commits cleanly.

## Hardening applied from agent review (2026-06-19)

Accepted: missed `reconcilePayment` guard (blocker); find-or-create lost-race must return `"updated"` not `"created"` (blocker); batch invoice-write + audit (non-atomic multi-write); signature/replay/idempotency strictly before the `after()` pull; **cut `invoiceSourceEnum`** (discriminate by `fieldpulseInvoiceId IS NOT NULL`); **cut `invoiceSyncEnabled` toggle** (false precedent — availability is always-on for connected); **drop the impossible `createInvoiceFromSoldEstimate` guard**; add `customers (org, fieldpulseCustomerId)` partial unique index; exact migration SQL; document pull-fetches-current-state (ordering-safe), durability/cron-backstop, source-aware reporting, and the binary `amountPaidCents` caveat.

Rejected (with reason): "columns don't exist yet" blockers — that is the deliverable; webhook job-id→org enumeration oracle / global job-id lookup — pre-existing, accepted, no state change without a valid signature, out of scope to redesign here; status-mapping consolidation — the two maps target different enums, consolidating refactors working code for marginal gain; deferring the cron — it is the retry backstop for silently-failed webhook pulls, not optional polish.

## Deferred (explicitly NOT in this pass — YAGNI)

- **Push (us → FieldPulse)** and bidirectional sync — the user chose pull-only; FieldPulse stays money authority.
- **Line-item mirroring** — FieldPulse's invoice payload has none.
- **Native refund reflection into FieldPulse** — synced invoices are read-only.
- **HCP invoice pull** — `hcpJobId` exists but is a separate integration; the same template (and a future generalized `*InvoiceId IS NOT NULL` discriminator) applies later.
- **Per-org opt-out toggle** — sync runs for all connected orgs (matches availability); add later only if a tenant asks.
- **Sub-second / real-time** — webhook (`after()`) + daily cron is sufficient for a billing mirror.

## Non-goals

Changing the native estimate→invoice→payment money flow; a new invoices table (reuse the existing one); per-line-item FieldPulse data; multi-currency.
