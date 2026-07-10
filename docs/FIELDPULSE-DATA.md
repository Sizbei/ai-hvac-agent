# FieldPulse Data — what's imported, where it displays, what's read-only

The production database carries a full mirror of the org's FieldPulse account,
established by a one-shot backfill and kept fresh by webhooks (real-time) + a
nightly GitHub-Actions sweep. This page is the operator's map: every imported
entity, the surface it displays on, its mutability, and the metric semantics.

> Run inventory + live progress: **`/admin/fieldpulse-import`** (2-second ledger
> flushes during any run). Import runner: `npm run fp:import` (see
> `src/lib/integrations/fieldpulse/import/run-import.ts`; `--dry-run` first).

## Entity map

| FieldPulse | Native table (key) | Volume¹ | Displays at | Mutable? |
|---|---|---|---|---|
| Users (role 4 + self-heals) | `users.fieldpulse_user_id` | 8 | Staff page (FP pill, "no local login" hint) | yes — native users; Reset-Password creates a local login (warned) |
| Customers | `customers.fieldpulse_customer_id` | 2,232² | CRM (paginated, archived toggle, FP pills), profile (custom fields block) | yes — same person, both systems |
| Jobs (+schedules = the calendar) | `service_requests.fieldpulse_job_id` | 53 | Requests queue (real names, FP pills, transcript banner), dispatch calendar ("Show completed" toggle) | yes — status/assignment sync back via the outbound push |
| Job metrics (per-id `status_log`, `total_price`, `map`) | `service_requests.fieldpulse_metrics` jsonb | 53/53 | Request detail — "FieldPulse metrics" block (price, time on the way / in progress) | n/a (derived) |
| Invoices (+line items) | `invoices.fieldpulse_invoice_id` | 2,849 | Invoices workspace (source filter, pills, read-only banner) | **NO** — reminder/pay-link/void/payment all refuse synced |
| Estimates (+187 line items, FP status names) | `estimates.fieldpulse_estimate_id`, `fieldpulse_status_name` | 36 | Estimates list/detail (pills, FP status name, read-only banner) | **NO** — mark-sold / generate-invoice refuse synced (server-side) |
| Payments | `payments.fieldpulse_payment_id` (provider `fieldpulse`) | 2,363 | Invoice detail payment history; accounting export (separate synced section) | **NO** — record-only |
| Assets | `customer_equipment.fieldpulse_asset_id` | 4 | Customer profile equipment card (FP pill) | yes (attributed) |
| **Pricebook items** | `pricebook_items.fieldpulse_item_id` | **17,536** | Pricebook page (`/admin/pricebook`) | yes (attributed) — catalog, not ledger data |
| Job comments | `customer_notes.fieldpulse_comment_id` | 8 | Customer profile notes (FP pill) | yes (attributed) |
| Customer custom fields + lead source | `customers.fieldpulse_custom_fields` jsonb | sparse | Profile "FieldPulse details" block | n/a (overwritten on sync) |
| Locations | (address enrichment only) | 411 filled | Customer profile address | fills NULL addresses only, never overwrites |

¹ As of the 2026-07-09 backfill; the nightly sweep keeps counts current.
² Includes 6 archived placeholders for customers hard-deleted in FieldPulse whose
jobs still exist ("FieldPulse customer (deleted #id)").

## Metric semantics (the money rules)

- **Native money metrics NEVER blend synced records.** `collectedThisMonthCents`,
  the sales report, and lead-source revenue all filter `fieldpulse_payment_id IS
  NULL` (and `hcp`/`fieldpulse` invoice ids where applicable).
- **Accounting export** emits two sections: `# NATIVE — import into your ledger`
  and `# SYNCED FROM FIELDPULSE (already booked in FieldPulse — do NOT import)`,
  each with its own subtotal; there is deliberately no blended grand total.
- **AR aging** (operations page): native buckets are the headline; synced AR is a
  separate one-line summary ("managed in FieldPulse").
- **Dunning/collections:** synced invoices are never reminded, never dunned, and
  carry no pay links — enforced server-side, not just hidden buttons.

## Status vocabulary (evidence-based)

FP job `status` is an integer; the account's `status_log` (seconds per stage)
revealed the pipeline: **1=pending, 2=on the way (→ native `assigned`),
3=in progress, 4=completed** (4 proven by `completed_at` on 9/9). `6` is a
custom status still unnamed — imports as `pending` and is tallied in every run
log; map it in `FP_JOB_STATUS_MAP` (`src/lib/integrations/fieldpulse/import/jobs.ts`)
when named. FP payment status `4` = succeeded (proven by exact to-the-cent
reconciliation across 2,249 fully-paid invoices). Estimate statuses carry real
names via per-id `custom_status` (Sent / Completed / Draft / Accepted / Lost…).

## Sync architecture

- **Real-time:** FieldPulse webhooks (job status, invoice events) — HMAC-verified,
  idempotency-ledgered, org derived server-side.
- **Nightly (08:30 UTC):** `.github/workflows/fp-nightly-sync.yml` runs the full
  import (all 11 phases incl. `items` and `job-metrics`; `timeout-minutes: 150` —
  the full sweep exceeds the old 45; manual runs can pass a `phases` input for a
  single-phase dispatch)
  — idempotent full re-page (FP ignores server-side date filters), current-FP-state-wins.
  Secrets: `DATABASE_URL`, `FIELDPULSE_API_KEY`, `ENCRYPTION_KEY`; org id in the
  `FP_SYNC_ORG_ID` repo variable.
- **Daily Vercel crons:** technicians+availability (10:00 UTC), invoices-for-tracked-jobs
  (11:00 UTC). Sub-daily crons (comms queue, delay sweep) run from GitHub Actions
  (Vercel Hobby is daily-only).
- **Self-heals** (all in the jobs importer): missing customer → per-id fetch (FP
  list pagination is unstable); per-id 404 (hard-deleted) → archived placeholder;
  unknown assignee who holds job assignments → technician upsert.

## API quirks that shaped the code (hard-won — do not relearn)

- `page_size` is ALWAYS ignored (fixed 50/page customers; 20/page everything else);
  paging must walk until an empty page — a wrong expected size silently truncates
  to page 1 (live-verified failure on invoices).
- FP list pagination is UNSTABLE — rows slip between pages mid-walk; per-id
  self-heal is the reliable closer.
- Bare timestamps are UTC (live-verified via schedule-hour histograms).
- Per-id objects are RICHER than list rows (`status_log`, `custom_status`,
  `customfields` details); `custom_status` is an OBJECT (`{name, …}`); custom-field
  entries carry NO name (only `field_instance_id` — displayed under fallback labels).
- Money is dollar-strings (`dollarsToCents`), ids are numbers (`idStr`).
- `/items` (the pricebook, ~17.5k rows = the "articles") pages at a fixed 20/page
  with NULL total_count over ~877 pages — the API does NOT cap at 10k, but our
  client walks now guard against their own `maxPages` ceilings: any walk that
  ends AT the cap with a full page logs a loud truncation warning
  (`cappedByMaxPages`) in every importer.

## Finding things

**⌘K** anywhere in the admin opens global search across customers (name/phone/
email), invoices (ref), jobs (ref/title), and estimates — org-scoped, grouped,
keyboard-first.
