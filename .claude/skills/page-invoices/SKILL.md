---
name: page-invoices
description: Use when working on the /admin/invoices page — collections workspace with one-tap reminders, pay links, multi-source (native/FieldPulse/HCP) invoices, and age-based overdue logic.
---

# Invoices (/admin/invoices · /admin/invoices/[id])

**Purpose:** operators collect outstanding balances — viewing overdue invoices
first, sending reminders, copying pay links, and voiding uncollectible invoices.

**Files:** list page `src/app/admin/(dashboard)/invoices/page.tsx` · detail page
`src/app/admin/(dashboard)/invoices/[id]/page.tsx` (server wrapper: reads
session for `canRefund`) · detail client
`src/components/admin/invoices/invoice-detail-client.tsx` · row
`src/components/admin/invoices/invoice-row.tsx` · summary band
`src/components/admin/invoices/summary-band.tsx` · hook `src/hooks/use-invoices.ts`
· API `src/app/api/admin/invoices/route.ts` · reminder API
`src/app/api/admin/invoices/[id]/send-reminder/route.ts` · void API
`src/app/api/admin/invoices/[id]/void/route.ts` · pay link API
`src/app/api/admin/invoices/[id]/pay-link/route.ts` · collectible helpers
`src/lib/admin/invoice-collectible.ts` · queries `src/lib/admin/invoice-queries.ts`
· tables `invoices` `payments` `invoice_line_items` (schema `src/lib/db/schema.ts`).

**Data flow:** `useInvoices` fetches `/api/admin/invoices` with page, state,
overdue, source, sort, search, unreminded, minCents, maxCents params. Stats
(outstandingCents, overdueCount, oldestOverdueDays, collectedThisMonthCents)
come from the server — SummaryBand never reduces over the client list. 60s SWR
cache. PER_PAGE=50. Default filter=overdue, sort=age-oldest. The ReconcileBanner
polls `/api/admin/payments/reconcile` on mount (best-effort, never throws).

**Invariants (violate = bug):**
- Multi-source money guard: `fieldpulseInvoiceId IS NOT NULL` → source=fieldpulse;
  `hcpInvoiceId IS NOT NULL` → source=housecall. Synced invoices are READ-ONLY
  in money flows — void, payment capture, and refund are blocked with
  `synced_read_only` error code. The UI shows a SyncPill and InfoBanner; the
  server enforces the gate regardless of UI.
- Reminder cooldown: `REMINDER_COOLDOWN_MS = 6h` (in `src/lib/admin/invoice-collectible.ts`).
  The route checks `canResend` before sending and returns code=`COOLDOWN` on
  409 if within cooldown. The UI maps COOLDOWN → "A reminder was already sent
  recently." — never surface the raw code.
- Overdue semantics (full-day boundary parity): an invoice with `dueDate` is
  overdue when `dueDate < today`; without `dueDate`, overdue when
  `coalesce(issuedAt, createdAt) <= now() - interval '30 days'`. Both FP and
  native invoices must use this same SQL expression.
- `issuedAt` is the source-system issue date for FP/HCP mirrors; age and sort
  always use `coalesce(issuedAt, createdAt)` — never raw `createdAt` alone.
- INT32 overflow guard in the list route: `minCents`/`maxCents` are clamped to
  `[0, INT32_MAX (2_147_483_647)]` before hitting SQL.
- Over-collection CAS: the refund route checks that `amountPaidCents - refundAmount
  >= 0` atomically before writing — never allow a refund that would exceed what
  was paid.
- Refund control is rendered only when `canRefund=true` (set server-side by the
  detail page wrapper reading `isSuperAdmin`); the API enforces the gate too.
- Compose `PageShell`, `PageHeader`, `Pager`, `SegmentedControl` from
  `src/components/admin/ui/`; status colors via `src/lib/admin/status-colors.ts`.

**Gotchas:**
- The SummaryBand is suppressed during initial load (`!isLoading`) to avoid the
  zero-data flash before stats arrive — do not remove the guard.
- Source segmented control is hidden when only one source type exists in
  `sourceCounts` — this is deliberate (no noise for single-source orgs).
- Void is a soft state change (`state='void'`); it can't be undone via the UI;
  the server blocks voiding synced invoices and invoices with payments.

**Verify changes:** `npx vitest run src/lib/admin/invoice-collectible.test.ts
src/lib/admin/invoice-list-pagination.test.ts src/lib/admin/invoice-queries.test.ts
src/lib/admin/invoice-synced-guards.test.ts src/lib/admin/invoice-queries-list.test.ts`
· visual via admin-pages recipe.
