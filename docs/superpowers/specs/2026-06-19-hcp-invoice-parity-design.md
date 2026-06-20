# Housecall Pro Invoice Mirror — Parity with FieldPulse

**Date:** 2026-06-19
**Status:** Hardened after 4-critic adversarial review → ready to execute
**Goal (user, 2026-06-19):** "same level as fieldpulse and hcp" — bring Housecall Pro's invoice handling to **full parity** with the FieldPulse money-grade invoice PULL mirror shipped earlier today (`957263f`).

This is a **parity port**: it inherits the FieldPulse spec's invariants verbatim (`docs/superpowers/specs/2026-06-19-fieldpulse-invoice-sync-design.md`) and copies its proven, test-covered pull logic into HCP with hardcoded HCP columns. It documents only the HCP deltas.

## Decision: DUPLICATE, do not abstract (hardened from review)

The first draft proposed a shared, column-name-parameterized `upsertSyncedInvoice` core. **Cut on review** — three independent reasons:
1. Drizzle columns are typed objects, not string-indexable; `invoices[colName]` / `.set({[colName]:…})` fights the type system and has no precedent in this repo.
2. The shared core would silently drop FieldPulse's `syncInvoiceStatus` request-badge call (FP's pull relies on it; the FP tests don't assert it, so the regression would ship green).
3. Two integrations don't justify the indirection; the logic is ~150 mechanical lines already battle-tested.

→ **HCP gets its own `upsertHcpInvoiceRecord` with hardcoded `hcpInvoiceId` / `hcpJobId` / `hcpCustomerId`. FieldPulse code is NOT touched.** A third FSM (Stripe/Square) would be the time to extract; not now.

## Current state (verified)

HCP already has: status-only path (`applyInvoiceEvent` → `service_requests.invoiceStatus`), webhook idempotency ledger (`hcpWebhookEvents`), encrypted per-org connection (`housecallProConnections`), org-scoped lookups, `customers.hcpCustomerId` (`schema.ts:669`, **unindexed**), `serviceRequests.hcpJobId` (per-org unique index).

HCP is MISSING (the parity gaps): client `getInvoice`/`listJobInvoices`; a `HousecallInvoice` type; the money-grade pull → native `invoices`; an `hcp_invoice_id` column + per-org unique index; webhook scheduling of the pull; a reconcile cron; money-guard coverage; the UI source chip. Its webhook event parser extracts only `hcpJobId`, **not** the invoice id.

HCP is key-blocked (memory `housecall-pro-integration`) — built **mock-first** like the rest of it. Everything is degrade-safe: no key → `getHousecallClient` returns null → pulls skip. Nothing runs live until a key exists; the `toInvoice` narrower tolerates whatever shape HCP returns.

## Invariants (inherited)

All 8 FieldPulse invariants hold. The load-bearing one generalizes to two sources:

> **Money authority stays with the FSM for synced invoices.** A synced invoice is **`fieldpulse_invoice_id IS NOT NULL OR hcp_invoice_id IS NOT NULL`**. `takePayment` / `refundPayment` / `reconcilePayment` refuse ANY synced invoice (either source). These three guards must be updated to check `hcpInvoiceId` **in the same commit that adds the column** (no window where the column exists but a guard ignores it).

`createInvoiceFromSoldEstimate` gets NO guard (settled in the FP build: synced invoices have NULL `estimateId`, so the estimate-keyed path can't collide). A request having both a native and a synced invoice stays the accepted **source-aware-reporting** trade-off (Invariant #8) — not a hard block.

## Components

### 1 — Schema (`schema.ts` + migration `0019`)
- `invoices.hcpInvoiceId text("hcp_invoice_id")` (nullable; plaintext) — HCP discriminator + idempotency key.
- Partial unique index `invoices_org_hcp_invoice_id_unique` on `(organizationId, hcpInvoiceId) WHERE hcpInvoiceId IS NOT NULL`.
- Partial unique index `customers_org_hcp_customer_id_unique` on `(organizationId, hcpCustomerId) WHERE hcpCustomerId IS NOT NULL`.
- Hand-authored `drizzle/0019_hcp_invoice_mirror.sql` (`--> statement-breakpoint` between statements; journal entry idx 19 — same mechanics as 0018). `ADD COLUMN IF NOT EXISTS` + two `CREATE UNIQUE INDEX IF NOT EXISTS … WHERE`. `npm run db:migrate`.

### 2 — HCP adapter: types + client
- `housecall-pro/types.ts`: add `HousecallInvoice { id; jobId?; customerId?; status?; total?; dueDate?; paidAt?; createdAt? }` (mirrors `FieldpulseInvoice`; all optional/nullable).
- `housecall-pro/client.ts`: add `getInvoice(invoiceId): Promise<HousecallInvoice | null>` and `listJobInvoices(hcpJobId): Promise<readonly HousecallInvoice[]>` to the interface + `RestHousecallProClient`, with a `toInvoice(raw)` narrower (null on missing id; cents passthrough), following the existing `toJob`/`toCustomer` pattern. Endpoints assumed `GET /invoices/{id}` and `GET /invoices?job_id=` — **inferred** (key-blocked); tolerant narrower; nothing live until a key exists.

### 3 — HCP invoice-sync (`housecall-pro/invoice-sync.ts`, NEW — duplicate of the FP pattern)
- `mapHousecallStatusToInvoiceState(status): "draft"|"open"|"paid"|"void"` (sent/emailed/viewed/overdue→open; paid/payment_received/complete→paid; void/voided/cancelled→void; else draft).
- `mapHousecallStatusToRequestInvoiceStatus(status): "none"|"sent"|"paid"|"void"` (for the request-badge mirror — keeps HCP's pull at parity with FP's, which mirrors the badge).
- `upsertHcpInvoiceRecord(org, invoice)` — copy of FP's `upsertInvoiceRecord` with hardcoded HCP columns: org-scoped link resolution (`(org, hcpJobId)`, `(org, hcpCustomerId)`), cents map, `amountPaidCents` binary on paid, find-or-create idempotent on `(org, hcpInvoiceId)`, **lost-race re-select → "updated"**, `db.batch(upsert + audit)` with `source:"housecall_invoice_pull"` + `hcpInvoiceId`; then best-effort request-badge update (`serviceRequests.invoiceStatus`) via the request-status mapper (matches FP).
- `pullInvoiceFromHousecall(org, hcpInvoiceId, fetchImpl?)`: client null→skipped; getInvoice null→skipped; else `upsertHcpInvoiceRecord`; degrade-safe (catch→failed).
- `pullInvoicesForJob(org, hcpJobId, fetchImpl?)`: `listJobInvoices` → pull each; `{created,updated,skipped,failed}`.

### 4 — Money guards (`invoice-queries.ts`)
`takePayment`/`refundPayment`/`reconcilePayment`: add `hcpInvoiceId: invoices.hcpInvoiceId` to each invoice select; refuse when `fieldpulseInvoiceId != null || hcpInvoiceId != null` (`synced_read_only`, already mapped to 409). One-line change per guard, **same commit as the schema**. Extend the existing guard test with an HCP-synced case.

### 5 — HCP webhook (parser + pull)
- `housecall-pro/webhook-events.ts`: add `hcpInvoiceId: string | null` to `HcpWebhookEvent`; in `parseWebhookEvent`, for an `invoice.*` event set `hcpInvoiceId = data.id` (the resource id IS the invoice id for invoice events), else null. Keep `hcpJobId` extraction unchanged (still `data.job_id`).
- `housecall-pro/webhook-sync.ts` `applyWebhookEvent`: after the existing `applyInvoiceEvent` status update **and** after the idempotency-ledger insert has confirmed a fresh (non-replay) event, if `event.hcpInvoiceId` is present schedule `after(() => pullInvoiceFromHousecall(org, event.hcpInvoiceId))`. (HCP already runs `after()` background work for completion follow-up, so the seam exists; confirm whether `after` is called in the route or in webhook-sync and place the schedule accordingly so it lands post-idempotency.) Replays/duplicates never pull.

**Deferred (NOT this task):** the FieldPulse **main** webhook (`webhook/route.ts`) still does `invoice.*` status-only and does not schedule the pull (the separate `invoice-webhook` route does). That is a FieldPulse-internal entry-point gap, not HCP parity — left as a noted follow-up rather than touching a working money path here.

### 6 — Reconcile cron (`/api/cron/sync-housecall-invoices`)
Mirror `sync-fieldpulse-invoices`: cron-secret gate; for each `housecallProConnections` WHERE `connected = true`, org-scoped select of `serviceRequests` with non-null `hcpJobId`, `pullInvoicesForJob` each in `after()`, log totals. Register in `vercel.json` (`0 12 * * *`, staggered after the FP invoice cron). Kept in scope: it IS part of "same level as FieldPulse," and it's fully degrade-safe (no connected HCP orgs → no-op).

### 7 — UI (`syncedSource`)
- Replace `synced: boolean` on `InvoiceListRow` + `InvoiceDetailView` with `syncedSource: "fieldpulse" | "housecall" | null`, derived server-side: `fieldpulseInvoiceId ? "fieldpulse" : hcpInvoiceId ? "housecall" : null` (**fieldpulse wins** the rare dual-source row). Raw ids stay server-side.
- Update the ~5 `.synced` consumers (compile-time caught): list page, scoped section, detail (chip + 3 control gates). Gate money controls on `syncedSource != null`; chip labels by source ("FieldPulse" / "Housecall Pro"); caveat note shown whenever `syncedSource != null`.

## Phases (reordered — HCP isolated first; no FP refactor)
1. **Schema + migration 0019** (hcp_invoice_id + 2 indexes) + **money guards** (add hcpInvoiceId to the 3 guards, atomic with the column) + guard test. `npm run db:migrate`.
2. **HCP types + client** invoice methods + narrower.
3. **HCP invoice-sync** (`upsertHcpInvoiceRecord`, pull fns, mappers) + tests (mirror the FP pull tests: created/updated/skip/fail/lost-race→updated/degrade).
4. **HCP webhook** — parser `hcpInvoiceId` + `after()` pull post-idempotency + tests.
5. **Cron** — `sync-housecall-invoices` + vercel.json + test.
6. **UI** — `syncedSource` enum + chip labels + read-only controls.

Each phase independently testable, commits cleanly. Gates per phase + final: `tsc`, full `test:unit`, `npm run eval` 30/30, `npm run build`.

## Hardening applied (from review)
Cut the shared-core abstraction → duplicate with hardcoded HCP columns (Drizzle dynamic-column risk + would drop FP's badge-sync + YAGNI); HCP parser must extract `hcpInvoiceId` (blocker); guards updated atomically with the schema; `syncedSource` with fieldpulse-wins tiebreaker for dual-source; HCP pull mirrors the request badge (consistency with FP); `customers (org, hcpCustomerId)` index added.

Rejected (with reason): FieldPulse main-webhook fix — FP-internal scope creep, deferred (noted); `createInvoiceFromSoldEstimate` guard — impossible estimateId collision (settled in FP build); defer-the-cron — the cron IS parity and is degrade-safe.

## Non-goals (same as FieldPulse)
Push (us→FSM); line-item mirror (no line items in either invoice type); native-refund→FSM; per-org opt-out; real-time. HCP endpoint shapes inferred (key-blocked); tolerant narrower; nothing live until a key exists.
