# Housecall Pro Invoice Mirror — Parity with FieldPulse

**Date:** 2026-06-19
**Status:** Draft → for agent sign-off
**Goal (user, 2026-06-19):** "same level as fieldpulse and hcp" — bring Housecall Pro's invoice handling to **full parity** with the FieldPulse money-grade invoice PULL mirror shipped earlier today (`957263f`), and close the one FieldPulse-internal gap that build left.

This spec is a **parity port**, so it inherits the FieldPulse spec's invariants verbatim (`docs/superpowers/specs/2026-06-19-fieldpulse-invoice-sync-design.md`). It documents only the HCP DELTAS and the shared-core refactor; everything not called out matches the FieldPulse mirror exactly.

## Current state (verified)

| Capability | FieldPulse | Housecall Pro |
|---|---|---|
| status-only path (`invoice.*` → `service_requests.invoiceStatus`) | ✅ `syncInvoiceStatus` | ✅ `applyInvoiceEvent` (`webhook-sync.ts:288`) |
| webhook idempotency ledger | ✅ `fieldpulseWebhookEvents` | ✅ `hcpWebhookEvents` (`schema.ts:1259`) |
| encrypted per-org connection + webhook secret | ✅ | ✅ `housecallProConnections` (`schema.ts:1130`) |
| client `getInvoice` / `listJobInvoices` | ✅ (`client.ts:534/547`) | ❌ **missing** |
| `HousecallInvoice` type | ✅ `FieldpulseInvoice` | ❌ **missing** |
| money-grade pull → native `invoices` | ✅ `pullInvoiceFromFieldpulse` | ❌ **missing** |
| `*_invoice_id` column + per-org unique index | ✅ `fieldpulse_invoice_id` | ❌ **missing** |
| webhook schedules the money pull | ✅ separate `invoice-webhook` route only ⚠️ | ❌ **missing** |
| reconcile cron | ✅ `sync-fieldpulse-invoices` | ❌ **missing** |
| money guards refuse synced | ✅ (checks `fieldpulse_invoice_id`) | ❌ (HCP id not checked) |
| UI source chip + read-only controls | ✅ ("FieldPulse") | ❌ |
| per-org unique index on `customers.<ext>CustomerId` | ✅ `fieldpulse_customer_id` | ❌ `hcpCustomerId` (`schema.ts:669`) unindexed |

**Two FieldPulse-internal gaps to fix here (so "parity" is real):**
1. The FieldPulse **main** webhook (`webhook/route.ts`) handles `invoice.*` events but only does `syncInvoiceStatus` — it does NOT schedule the money pull (my Phase 4 only wired the separate `invoice-webhook` route). HCP routes ALL events (job + invoice) through one webhook, so to match, the FP main webhook must also schedule the pull. Fix both.
2. (cosmetic) the UI `synced` flag is FieldPulse-specific; generalize so the chip labels the right source.

## Invariants (inherited — unchanged)

All 8 FieldPulse invariants hold identically. The load-bearing one generalizes:

> **Money authority stays with the FSM for synced invoices.** A synced invoice is now **`fieldpulse_invoice_id IS NOT NULL OR hcp_invoice_id IS NOT NULL`**. `takePayment` / `refundPayment` / `reconcilePayment` refuse ANY synced invoice (either source).

Plus: cents-only; org from server never payload; idempotent on `(org, <ext>_invoice_id)`; degrade-safe; no PII in logs; secrets encrypted; source-aware reporting.

## Architecture — shared core + per-integration adapters

The FieldPulse `upsertInvoiceRecord` is ~150 lines of money-grade upsert (resolve links org-scoped, map cents, find-or-create idempotent with lost-race re-select, db.batch audit). Duplicating it for HCP would fork the money-safety logic. **Extract a shared core** parameterized by the external-id column + source label; both integrations call it.

### Component 1 — Schema (`schema.ts` + migration `0019`)

- `invoices.hcpInvoiceId text("hcp_invoice_id")` (nullable; plaintext) — the HCP discriminator + idempotency key.
- Partial unique index `invoices_org_hcp_invoice_id_unique` on `(organizationId, hcpInvoiceId) WHERE hcpInvoiceId IS NOT NULL`.
- Partial unique index `customers_org_hcp_customer_id_unique` on `(organizationId, hcpCustomerId) WHERE hcpCustomerId IS NOT NULL` (HCP customer resolution, mirrors the FieldPulse one).

Hand-authored migration `drizzle/0019_hcp_invoice_mirror.sql` (`--> statement-breakpoint` between statements; journal entry idx 19 — same mechanics as 0018). `ADD COLUMN IF NOT EXISTS` + two `CREATE UNIQUE INDEX IF NOT EXISTS ... WHERE`.

### Component 2 — Shared mirror core (`src/lib/integrations/invoice-mirror.ts`, NEW)

```
export type InvoicePullOutcome = "created" | "updated" | "skipped" | "failed";

/** Source-agnostic invoice shape the core consumes (both FP + HCP map to this). */
export interface MirrorInvoice {
  readonly externalId: string;        // FP/HCP invoice id
  readonly externalJobId?: string | null;
  readonly externalCustomerId?: string | null;
  readonly state: "draft" | "open" | "paid" | "void";   // already mapped by the adapter
  readonly totalCents: number;
  readonly amountPaidCents: number;
}

/** Which provenance column this invoice is keyed on. */
export type MirrorSource = {
  readonly invoiceIdColumn: "fieldpulseInvoiceId" | "hcpInvoiceId";
  readonly jobIdColumn: "fieldpulseJobId" | "hcpJobId";
  readonly customerIdColumn: "fieldpulseCustomerId" | "hcpCustomerId";
  readonly auditSource: string;       // e.g. "housecall_invoice_pull"
};

upsertSyncedInvoice(organizationId, mi: MirrorInvoice, src: MirrorSource): Promise<InvoicePullOutcome>
```

Body = the exact FieldPulse `upsertInvoiceRecord` logic, but column references come from `src` (Drizzle lets us index the table by column name; resolve to the column object once). Org-scoped link resolution, find-or-create idempotent on `(org, src.invoiceIdColumn = mi.externalId)`, lost-race re-select → `"updated"`, db.batch(upsert + audit with `src.auditSource`). **Refactor `fieldpulse/invoice-sync.ts` to call this core** (its tests must stay green — proves the refactor is behavior-preserving). This keeps the money-safety logic in ONE place.

### Component 3 — HCP adapter

- `housecall-pro/types.ts`: add `HousecallInvoice { id, jobId?, customerId?, status?, total?, dueDate?, paidAt?, createdAt? }` (mirrors `FieldpulseInvoice`; all optional/nullable to tolerate API drift). HCP's exact status vocabulary is unconfirmed (key-blocked) — the mapper below is tolerant + falls back to `draft`.
- `housecall-pro/client.ts`: add `getInvoice(invoiceId): Promise<HousecallInvoice | null>` and `listJobInvoices(hcpJobId): Promise<readonly HousecallInvoice[]>` to the interface + `RestHousecallProClient`, with a `toInvoice(raw)` narrower (returns null on missing id; cents passthrough), following the existing `toJob`/`toCustomer` pattern. Endpoint shape assumed `GET /invoices/{id}` and `GET /invoices?job_id=` — **flagged as inferred** (HCP is key-blocked/mock-first; the narrower tolerates whatever shape, and nothing runs live until a key exists, exactly like the rest of HCP).
- `housecall-pro/invoice-sync.ts` (NEW):
  - `mapHousecallStatusToInvoiceState(status): "draft"|"open"|"paid"|"void"` (sent/emailed/viewed/overdue→open; paid/payment_received→paid; void/voided/cancelled→void; else draft).
  - `pullInvoiceFromHousecall(org, hcpInvoiceId, fetchImpl?)`: `getHousecallClient` null→skipped; `getInvoice` null→skipped; map to `MirrorInvoice` (amountPaidCents binary on paid); `upsertSyncedInvoice(org, mi, HCP_SOURCE)`; best-effort mirror of the request badge (HCP's webhook already sets `invoiceStatus` directly, so this is optional — omit to avoid a redundant path; the webhook covers the badge). Degrade-safe.
  - `pullInvoicesForJob(org, hcpJobId, fetchImpl?)`: `listJobInvoices` → pull each; `{created,updated,skipped,failed}`.

### Component 4 — Money guards (generalize)

`invoice-queries.ts` `takePayment`/`refundPayment`/`reconcilePayment`: select `hcpInvoiceId` alongside `fieldpulseInvoiceId`; refuse when **either** is non-null (`synced_read_only`). One-line change per guard (the reason + route mapping already exist from the FieldPulse build).

### Component 5 — Webhooks (HCP + FieldPulse parity fix)

- **HCP** (`webhook-events.ts` + `webhook-sync.ts` + `webhooks/housecall/route.ts`): the parser currently extracts only `hcpJobId`. Extend `HcpWebhookEvent` with `hcpInvoiceId: string | null` (for an `invoice.*` event the resource `id` IS the invoice id). In `applyWebhookEvent`, after the existing `applyInvoiceEvent` status update AND after the idempotency-ledger insert has confirmed a fresh event, if `hcpInvoiceId` is present schedule `after(() => pullInvoiceFromHousecall(org, hcpInvoiceId))`. (HCP webhook already runs background work via `after()` for completion follow-up, so the seam exists.) Order: signature verify → idempotency → status update → schedule pull. Replays/duplicates never pull.
- **FieldPulse main webhook** (`webhook/route.ts`): it already parses `invoiceId` (`route.ts:58`). After its existing invoice status update, schedule `after(() => pullInvoiceFromFieldpulse(org, invoiceId))` under the same post-verify/idempotency guard — closing the gap so BOTH FP entry points (main + invoice-webhook) mirror money. (The separate `invoice-webhook` route stays as-is.)

### Component 6 — Reconcile cron

`/api/cron/sync-housecall-invoices/route.ts` mirroring `sync-fieldpulse-invoices`: cron-secret gate; for each `housecallProConnections` WHERE `connected = true`, org-scoped select of `serviceRequests` with non-null `hcpJobId`, `pullInvoicesForJob` each in `after()`, log totals. Register in `vercel.json` (`0 12 * * *` — staggered after the FP invoice cron at 11).

### Component 7 — UI (generalize the source)

- Replace the `synced: boolean` view field with `syncedSource: "fieldpulse" | "housecall" | null` on `InvoiceListRow` + `InvoiceDetailView` (derived server-side from which external id is set; raw ids stay server-side). `synced` becomes `syncedSource != null` at the call sites.
- The chip renders the correct label ("FieldPulse" / "Housecall Pro"); detail hides money controls + shows the authoritative-balance caveat whenever `syncedSource != null`.

## Phases

1. **Schema + migration 0019** (hcp_invoice_id + 2 indexes); `npm run db:migrate`.
2. **Shared core** `invoice-mirror.ts` + refactor `fieldpulse/invoice-sync.ts` onto it (FP tests stay green = behavior-preserving) + tests for the core.
3. **HCP adapter** — types + client methods + `housecall-pro/invoice-sync.ts` + tests.
4. **Money guards** — add `hcpInvoiceId` to the three guards + tests (extend the existing guard test with an HCP case).
5. **Webhooks** — HCP parser+webhook pull + FieldPulse main-webhook pull fix + tests.
6. **Cron** — `sync-housecall-invoices` + vercel.json + test.
7. **UI** — `syncedSource` + chip labels + read-only controls.

## Testing

Mirror the FieldPulse suite for HCP: pure mapper; pull outcomes (created/updated/skip/fail/lost-race→updated) against the shared core with a mock HCP client; money guards reject HCP-synced; HCP webhook schedules pull only post-verify; FP main-webhook now schedules pull; cron auth + connected-only. Plus: the FieldPulse refactor onto the shared core must leave all existing FP invoice tests green. Gates: `tsc`, full `test:unit`, `npm run eval` 30/30, `npm run build`.

## Deferred / non-goals (same as FieldPulse)

Push (us→FSM); line-item mirroring (neither FP nor HCP invoice payloads carry them in our type); native-refund→FSM; per-org opt-out (runs for all connected orgs); real-time (webhook `after()` + daily cron suffices). HCP API endpoint shapes are inferred (key-blocked) — `toInvoice` is tolerant and nothing runs live until a key exists.
