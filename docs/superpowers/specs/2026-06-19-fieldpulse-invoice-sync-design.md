# FieldPulse Invoice Sync (Pull Mirror) — Design Spec

**Date:** 2026-06-19
**Status:** Draft → for agent sign-off
**Scope decision (user, 2026-06-19):** money-grade **PULL mirror** — read-only FieldPulse → us. FieldPulse is the source of truth for synced invoices; we never push or take payment on them.

## Why this exists

The repo already has three pieces that don't connect:

1. **FieldPulse integration template** — `src/lib/integrations/fieldpulse/{config,types,client,connection-queries,rate-limiter,webhook-signature}.ts` + per-entity `*-sync.ts` (customer, job, technician) + webhook/connect/status routes + a cron. This is the pattern to follow.
2. **Native invoice system** — `invoices` / `invoice_line_items` / `payments` / `refunds` tables (`schema.ts:2233+`), `invoice-queries.ts`, `/api/admin/invoices/*`, and `/admin/invoices` UI. Full money handling in **cents**. Source of truth for **native** invoices (materialized from sold estimates).
3. **Partial FieldPulse invoice path** — `invoice-sync.ts` (`syncInvoiceStatus`) + `invoice-webhook/route.ts` only mirror a `none|sent|paid|void` **status enum** onto `service_requests.invoiceStatus` (`schema.ts:544`). No money, no link to the native `invoices` table.

This spec completes #3 into a **money-grade pull mirror**: FieldPulse invoices (total, status, due/paid dates) land as rows in the native `invoices` table, idempotently, following the #1 template, so admins see real billed amounts in one place. The lightweight status path (#3) stays for the request-level badge.

## What "done" means

- A FieldPulse invoice for a connected, invoice-sync-enabled org appears as an `invoices` row (`source = "fieldpulse"`) with the right `totalCents` and `state`, linked to the service request and customer when resolvable.
- Re-syncing the same FieldPulse invoice updates the existing row (idempotent on `fieldpulseInvoiceId`), never duplicates.
- A pulled invoice is **read-only** in native money flows: `takePayment` / `refundPayment` / `createInvoiceFromSoldEstimate` refuse to act on `source = "fieldpulse"`.
- Missed webhooks are recovered by a periodic reconcile cron.
- All invariants below hold; `npm run test:unit`, `tsc`, `npm run eval` stay green.

## Invariants (NEVER cross)

1. **Money authority stays with FieldPulse for synced invoices.** A `source = "fieldpulse"` invoice is a read-only mirror. Native `payments`/`refunds` must never be created against it. This is the load-bearing safety rule — it prevents double-charging a customer who already paid in FieldPulse.
2. **Cents only**, integers, never floats (matches the native invoice system).
3. **Org from the server, never from the webhook payload.** Org is derived by looking up the FieldPulse job/invoice id, exactly as the existing webhook does (`invoice-webhook/route.ts:93-107`).
4. **Idempotent on `fieldpulseInvoiceId`** via a per-org partial unique index + an `... IS NULL` / `onConflictDoNothing` guard (mirrors `customers.fieldpulseCustomerId`, `requests.fieldpulseJobId`).
5. **Degrade-safe**: no client / not connected / API error → log at WARN and return an outcome, never throw, never block the webhook or cron.
6. **No PII in logs or audit** — ids, enums, cents only (matches existing `invoice_status_updated` audit).
7. **Secrets encrypted at rest** (existing `fieldpulse_connections` AES-256-GCM); never logged.

## Data shape reality (honest constraints)

- `FieldpulseInvoice` (`types.ts:111`) carries **`id, jobId, customerId, status, total (cents), dueDate, paidAt, createdAt`** — **no line items**. Therefore the mirror is **invoice-level only**: we set `totalCents = total`, `subtotalCents = total`, `taxCents = 0`, and create **no `invoice_line_items`** for synced invoices. (If FieldPulse later exposes line items, extend `toInvoice` + this module; out of scope now.)
- `amountPaidCents`: `totalCents` when state is `paid`, else `0` (FieldPulse's type exposes no partial-payment amount).
- The existing client methods already exist: `getInvoice(invoiceId)` (`client.ts:534`) and `listJobInvoices(fieldpulseJobId)` (`client.ts:547`). No new client methods needed.

## Architecture

Read-only pull, three entry points, one core function:

```
invoice.* webhook ──┐
reconcile cron ─────┼──> pullInvoiceFromFieldpulse(org, fieldpulseInvoiceId)
manual (future) ────┘         │
                              ├─ getFieldpulseClient(org) → null? no-op
                              ├─ client.getInvoice(id) → null? skip
                              ├─ resolve serviceRequestId (via fieldpulseJobId, org-scoped)
                              │  + customerId (via fieldpulseCustomerId, org-scoped)
                              ├─ map status → invoiceStateEnum
                              ├─ find-or-create invoices row (source="fieldpulse",
                              │  idempotent on (org, fieldpulseInvoiceId))
                              ├─ also update request.invoiceStatus (reuse syncInvoiceStatus)
                              └─ audit "invoice_synced" (ids/enums/cents only)
```

### Component 1 — Schema (`schema.ts` + migration)

Add to the `invoices` table:
- `source invoiceSourceEnum("source").notNull().default("native")` where `invoiceSourceEnum = pgEnum("invoice_source", ["native", "fieldpulse"])`. Existing rows default to `native`.
- `fieldpulseInvoiceId text("fieldpulse_invoice_id")` (nullable; plaintext — FieldPulse's public resource id, not a secret).
- Partial unique index `invoices_org_fieldpulse_invoice_id_unique` on `(organizationId, fieldpulseInvoiceId) WHERE fieldpulseInvoiceId IS NOT NULL` (per-org, like `users_org_fieldpulse_user_id_unique` at `schema.ts:322`).

Add to `fieldpulse_connections` (`schema.ts:1168`):
- `invoiceSyncEnabled boolean("invoice_sync_enabled").notNull().default(false)` — opt-in gate, mirrors how availability sync is gated.

Hand-authored migration in `drizzle/` (the repo runs migrations manually; see memory "migrations-not-run-on-deploy" — `npm run db:migrate` after adding). Two `ALTER TABLE`s + `CREATE TYPE` + `CREATE UNIQUE INDEX ... WHERE`. Idempotent column adds (`ADD COLUMN IF NOT EXISTS`).

### Component 2 — Status mapping (`invoice-sync.ts`)

Add `mapFieldpulseStatusToInvoiceState(status): "draft"|"open"|"paid"|"void"`:
- `sent|viewed|emailed|overdue` → `open`
- `paid|payment_received|complete` → `paid`
- `void|voided|cancelled|canceled` → `void`
- `draft|pending|null` → `draft`

(The existing `mapInvoiceStatus` → request enum stays; this is the parallel map to the native `invoiceStateEnum`. `refunded` is native-only — FieldPulse refunds aren't modeled, so we never map *to* `refunded`.)

### Component 3 — Pull module (`invoice-sync.ts`, extend)

```
export type InvoicePullOutcome = "created" | "updated" | "skipped" | "failed";

pullInvoiceFromFieldpulse(
  organizationId: string,
  fieldpulseInvoiceId: string,
  fetchImpl?: typeof fetch,
): Promise<InvoicePullOutcome>
```

Follows the customer-sync anatomy (`customer-sync.ts:188`):
1. `getFieldpulseClient(organizationId, fetchImpl)` → `null` ⇒ return `"skipped"`.
2. `client.getInvoice(fieldpulseInvoiceId)` → `null` ⇒ `"skipped"`.
3. Resolve links (org-scoped, both optional):
   - `serviceRequestId`: `serviceRequests` where `(org, fieldpulseJobId = invoice.jobId)`.
   - `customerId`: `customers` where `(org, fieldpulseCustomerId = invoice.customerId)`.
4. Compute `state`, `totalCents = invoice.total ?? 0`, `amountPaidCents`.
5. Find existing `invoices` row by `(org, fieldpulseInvoiceId)`:
   - exists ⇒ `UPDATE` `state/subtotalCents/totalCents/amountPaidCents/updatedAt`, guarded by `eq(source,"fieldpulse")`; return `"updated"`.
   - none ⇒ `INSERT` `{org, source:"fieldpulse", fieldpulseInvoiceId, serviceRequestId, customerId, state, subtotal/total/amountPaid}` with `.onConflictDoNothing()` on the unique index (race-safe; a lost race ⇒ re-select and treat as `"updated"`/`"skipped"`); return `"created"`.
6. Best-effort `syncInvoiceStatus(invoice.jobId, invoice.status, org)` to keep the request badge in step (only if `jobId` present).
7. Audit `invoice_synced` with `{ from, to, source:"fieldpulse_invoice_pull", fieldpulseInvoiceId, totalCents }` — no PII.
8. Wrap in try/catch ⇒ log WARN, return `"failed"`.

Add `pullInvoicesForJob(organizationId, fieldpulseJobId, fetchImpl?)`: `client.listJobInvoices(jobId)` → `pullInvoiceFromFieldpulse` for each; returns a `{created,updated,skipped,failed}` summary (for the cron).

### Component 4 — Money-safety guards (`invoice-queries.ts`)

In `takePayment`, `refundPayment`, and `createInvoiceFromSoldEstimate`: after loading the target invoice, if `invoice.source === "fieldpulse"` ⇒ throw a typed `InvoiceSyncedReadOnlyError` (mapped to HTTP 409 by the routes). This is invariant #1 enforced in code. (`createInvoiceFromSoldEstimate` can't collide via `estimateId` since synced invoices have none, but the guard is cheap defense-in-depth.) Each guard gets a unit test.

### Component 5 — Webhook extension (`invoice-webhook/route.ts`)

- Extend `invoiceWebhookSchema` to add `invoiceId: z.string()` (the event carries it — `FieldpulseInvoiceEvent.invoiceId`, `types.ts:128`). Keep `jobId` for org resolution; keep all existing signature/replay/idempotency logic unchanged.
- After the existing status update, if the org has `invoiceSyncEnabled`, schedule the money-grade pull in the background so the webhook still returns fast:
  `after(() => pullInvoiceFromFieldpulse(organizationId, invoiceId))`.
  Use `after()` from `next/server` — NOT a detached promise (Vercel freezes the lambda on response; see memory "serverless-background-work").
- Still returns `204`. Pull failures are logged inside the module, never surfaced.

### Component 6 — Reconcile cron (`/api/cron/sync-fieldpulse-invoices`)

Mirror `/api/cron/sync-fieldpulse-availability/route.ts`:
- Auth via the existing cron-secret gate.
- For each `fieldpulse_connections` row with `connected = true AND invoiceSyncEnabled = true`: select that org's `serviceRequests` having a non-null `fieldpulseJobId`, call `pullInvoicesForJob(org, jobId)` for each (rate-limiter already inside the client), accumulate a summary, log it.
- Register in `vercel.json` crons (daily — Vercel hobby limit; matches the availability cron cadence).

### Component 7 — Config + UI

- `connect`/`status` routes already gate on `getAdminSession()`. Add an `invoiceSyncEnabled` toggle endpoint (or fold into the existing status/connect payload) and surface it in `fieldpulse-panel.tsx` as a checkbox (admin-only). Default off.
- Synced invoices already render in `/admin/invoices` (same table). Add:
  - a **"FieldPulse"** source chip in the list + detail (read from `source`),
  - **hide/disable** the take-payment and refund controls when `source === "fieldpulse"` (read-only mirror) — defense-in-depth on top of Component 4's server guard,
  - empty line-items section is fine (synced invoices have none).

## Components as isolated units

| Unit | Responsibility | Depends on | Tested by |
|---|---|---|---|
| `invoiceSourceEnum` + cols | provenance + idempotency key | migration | schema compiles, migration applies |
| `mapFieldpulseStatusToInvoiceState` | FP status → native state | — | pure unit test (table-driven) |
| `pullInvoiceFromFieldpulse` | one-invoice find-or-create mirror | client, db, syncInvoiceStatus | unit test w/ mock client (created/updated/skip/fail/degrade) |
| `pullInvoicesForJob` | per-job batch | pullInvoice | unit test (summary aggregation) |
| money guards | reject native ops on synced | invoices row | unit test per guard |
| webhook ext | capture invoiceId, schedule pull | pullInvoice, after() | route test (schema, after scheduled) |
| reconcile cron | recover missed webhooks | pullInvoicesForJob, connections | route test (auth, enabled-only) |
| panel toggle + chips | opt-in + read-only UX | status route, source col | component/manual |

## Error handling

Every external touch is degrade-safe (invariant #5): client null, `getInvoice` null, network error, malformed payload → WARN + outcome, never throw. The webhook never fails because of a pull (pull is in `after()`). The cron isolates per-job failures (one bad job doesn't abort the sweep), matching `batchSyncInvoiceStatuses`. Money guards are the one place we *do* throw — to refuse an unsafe native mutation — surfaced as 409, not 500.

## Testing

- **Pure:** `mapFieldpulseStatusToInvoiceState` (all FP statuses incl. unknown → draft).
- **Unit (mock client):** `pullInvoiceFromFieldpulse` — created, updated (re-sync idempotency), skipped (no client / null invoice), failed (client throws), link resolution (job/customer present vs absent), cents mapping, `amountPaidCents` on paid.
- **Unit:** money guards reject `source="fieldpulse"` for takePayment/refundPayment/createInvoiceFromSoldEstimate.
- **Route:** invoice-webhook still 204, now parses `invoiceId`, schedules pull when enabled / skips when disabled; signature/replay/idempotency unchanged.
- **Route:** reconcile cron — rejects without secret, processes only `connected && invoiceSyncEnabled` orgs.
- **Gate:** `npm run eval` 30/30 (unaffected — no bot change), `tsc`, full `test:unit`.

## Phases (implementation order)

1. **Schema + migration** — `invoiceSourceEnum`, `fieldpulseInvoiceId`, partial unique index, `invoiceSyncEnabled`; run `npm run db:migrate`.
2. **Mapping + pull module** — `mapFieldpulseStatusToInvoiceState`, `pullInvoiceFromFieldpulse`, `pullInvoicesForJob` + tests.
3. **Money-safety guards** — reject native money ops on synced invoices + tests.
4. **Webhook extension** — capture `invoiceId`, `after()` pull behind the enable flag + test.
5. **Reconcile cron** — new cron route + `vercel.json` + test.
6. **Config + UI** — toggle endpoint, panel checkbox, source chip, disabled money controls.

Phases 1-4 deliver the working pull mirror; 5 adds resilience; 6 adds opt-in + UX. Each phase is independently testable and commits cleanly.

## Deferred (explicitly NOT in this pass — YAGNI)

- **Push (us → FieldPulse)** and bidirectional sync — the user chose pull-only; FieldPulse stays money authority.
- **Line-item mirroring** — FieldPulse's invoice payload has none.
- **Native refund reflection into FieldPulse** — synced invoices are read-only; refunds happen in FieldPulse.
- **HCP invoice pull** — `hcpJobId` exists but is a separate integration; same template applies later.
- **Sub-second / real-time** — webhook (`after()`) + daily cron is sufficient for a billing mirror.

## Non-goals

Changing the native estimate→invoice→payment money flow; a new invoices table (reuse the existing one); per-line-item FieldPulse data; multi-currency.
