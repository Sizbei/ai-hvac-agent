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
· reminder trigger `src/lib/communication/money-triggers.ts`
· record payment card `src/components/admin/invoices/record-payment-card.tsx` ·
finalize button `src/components/admin/invoices/finalize-button.tsx` · document
`src/components/admin/invoices/invoice-document.tsx` + signature model
`invoice-signature-model.ts` · copy helpers `src/lib/admin/invoice-payment-copy.ts`
· payments API `src/app/api/admin/invoices/[id]/payments/route.ts` · finalize API
`src/app/api/admin/invoices/[id]/finalize/route.ts` · refund API
`src/app/api/admin/payments/[id]/refund/route.ts` · writers
`src/lib/admin/invoice-field-writes.ts` (finalize) and
`src/lib/admin/invoice-payment-writes.ts` (`recordManualPayment`,
`refundManualPayment`)
· tables `invoices` `payments` `invoice_line_items` (schema `src/lib/db/schema.ts`).

**Data flow:** `useInvoices` fetches `/api/admin/invoices` with page, state,
overdue, source, sort, search, unreminded, minCents, maxCents params. Stats
(outstandingCents, overdueCount, oldestOverdueDays, collectedThisMonthCents)
come from the server — SummaryBand never reduces over the client list. 60s SWR
cache (client-side only: the list route sends `Cache-Control: no-store`, so
the browser never replays a pre-payment body). PER_PAGE=50. Default filter=overdue, sort=age-oldest. The ReconcileBanner
polls `/api/admin/payments/reconcile` on mount (best-effort, never throws).

**Invariants (violate = bug):**
- Multi-source money guard: `fieldpulseInvoiceId IS NOT NULL` → source=fieldpulse;
  `hcpInvoiceId IS NOT NULL` → source=housecall. Synced invoices are READ-ONLY
  in money flows — void, payment capture, refund, AND `sendInvoiceReminder`
  (`src/lib/communication/money-triggers.ts`) are all blocked with the
  `synced_read_only` error code. The UI shows a SyncPill and InfoBanner; the
  server enforces the gate regardless of UI — a direct API call must not be
  able to double-text a customer whose invoice is collected by FP/HCP.
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
- `takePayment` writes the `paid`/`open` state as a SQL `case` evaluated
  against the row's own `amountPaidCents`/`totalCents` AT WRITE TIME — not as a
  JS-computed literal. Deriving it in JS is not enough even off the claim's
  `RETURNING` row, because `provider.createCharge()` sits between the claim and
  the write: two concurrent partial payments can resolve out of claim-order and
  the loser would overwrite `paid` back to `open`, stranding a fully-paid
  invoice in the collections queue forever. Money stays exact either way (the
  CAS holds) — this is a display-state bug class, and it goes live the moment a
  real network-latency provider replaces the mock. The returned `invoiceState`
  comes from that UPDATE's `RETURNING`, so callers see what was actually
  written.
- Refund control is rendered only when `canRefund=true` (set server-side by the
  detail page wrapper reading `isSuperAdmin`); the API enforces the gate too.
- Compose `PageShell`, `PageHeader`, `Pager`, `SegmentedControl` from
  `src/components/admin/ui/`; status colors via `src/lib/admin/status-colors.ts`.

**Collect (M3b) — office money controls:**
- `payments.method` (`card|cash|check|other`, check constraint; FieldPulse
  mirrors are `other`), `check_number` (only with `check`), `recorded_by`
  (user, `ON DELETE SET NULL`). Rows show a method chip ("Check · #1042").
  The accounting CSV memo is `Payment <id> (invoice <invoiceId>, <method>)`.
- **Record payment** (`record-payment-card.tsx`): Cash / Check / Other (no
  Card while the provider is the mock), amount, check number for Check,
  Deposit. The form mints `clientToken = mintKey()` when it opens and sends
  `{ clientToken, method, amountCents, checkNumber?, isDeposit? }`. The server
  derives the payment id `officeId("payment", org, clientToken)`. This id is
  org-scoped, not invoice-scoped, so a double-click or a retry records once,
  and a token reused for another invoice/amount/method → 409 `ID_CONFLICT`
  (never a silent success). The token is re-minted after a success or an
  `ID_CONFLICT` (`shouldRemintToken`).
  - **Uncertain outcomes reload first:** on a network error (fetch threw) or
    an `ID_CONFLICT` the payment may already have landed, so the card calls
    the parent's `load()` (`onReload`, `shouldReloadAfterRecord`) BEFORE the
    message shows. Copy: `ID_CONFLICT` → "This payment may already be
    recorded. Check the payments list before recording it again." (spec §8
    said "That payment token was already used. Try again."; changed in the
    final wave because "token" is not office copy and "Try again" invited a
    double record); network → "Couldn't reach the server. The payment may have
    been recorded. Check the list before trying again." The refund form
    reloads on a network error the same way (`REFUND_NETWORK_COPY`).
  - `checkNumber` must match `/^[A-Za-z0-9-]{1,32}$/` on both the admin and
    tech payment routes (free text would carry names that erase never clears).
  - Shown only when
  `canRecordPayment` (state `open` + chargeable): drafts are never payable by
  hand (server: 409 `INVOICE_NOT_CHARGEABLE` "Finalize the invoice first.").
  201 when created, 200 on a replay (no audit/receipt). Audit
  `payment_recorded` (ids + method + state only). Receipt + `processPendingJobs`
  in `after()` only when the invoice has a customer.
- **Card gate:** `method: 'card'` → 409 `CARD_PAYMENTS_UNAVAILABLE` "Online
  payment isn't available yet." while `cardPaymentsEnabled()`
  (`src/lib/payments/card-enabled.ts`, provider ≠ mock) is false. The same gate
  covers the portal pay route and membership `chargeFirstPeriod`.
- **Finalize** (native drafts, two-click confirm): `POST
  /api/admin/invoices/[id]/finalize` → `finalizeInvoice` with the office actor
  (lead check = TRUE, L_req = the invoice's request). 200 `{ invoiceId, state,
  changed }`; `NO_LINES` / `INVOICE_LOCKED` / `INVOICE_SYNCED_READ_ONLY` 409;
  audit `invoice_finalized` only when changed. This is how a draft a technician
  left behind gets unstuck. A $0 draft finalizes to `open` (voidable), not
  `paid`. No due date is set; `issued_at` is.
- **Refunds:** the refund form mints its own token each time it opens (`refundId
  = officeId("refund", …)`). `refundPayment` delegates `provider = 'manual'`
  to `refundManualPayment`. A manual refund only RECORDS the refund, with no
  provider call, and puts the invoice back to `open` while a balance remains:
  a full manual refund leaves `open` with `amount_paid_cents = 0`, never
  `refunded`. The payment row may read `refunded`. The success copy says
  "Refund recorded. Return the money to the customer yourself."
  (`refundSuccessCopy`). Card refunds keep their semantics, with the invoice
  state computed in SQL.
- **Signature in the document:** open/paid/refunded/void invoices render the
  INVOICE's own snapshot ("Customer signature", 900 s signed URL). A draft
  shows the request's current signature labelled "Job signature (not yet on
  the invoice)". Other states: `erased` → "Signature removed";
  `unavailable` → "Signature couldn't be loaded." (no R2 creds on dev);
  `none` → nothing. An image `onError` refetches up to 2 times; once the cap
  is hit the parent sets `signatureUnavailable` and the document renders the
  "Signature couldn't be loaded." note instead of a broken image
  (`signatureBlock(input, imageFailed)`).
- **Reconcile:** a pending `mock` payment while cards are disabled is a
  FAILED charge. One batch marks it failed and un-claims the invoice credit
  (gated on that write's xmin). Drafts are included and stay drafts; the
  state otherwise follows `CASE WHEN paid >= total THEN 'paid' ELSE 'open'`.
  The un-claim is native-only (`P_NATIVE`), so it never takes credit off a
  FieldPulse or Housecall Pro invoice.
- `createInvoiceFromSoldEstimate` on a request refuses while the request has a
  native field DRAFT (`request_has_draft`); it coexists with an open field
  invoice. `listStuckPayments` skips `provider IN ('manual', 'fieldpulse',
  'hcp')`: manual payments are never pending, and mirrored payments with an
  unknown status are not ours to reconcile.
- Erasing a customer nulls `signature_url`/`signature_name` on their requests
  AND invoices (`signed_at` kept) and deletes the R2 objects (see
  `src/lib/admin/erasure-queries.ts`).

**Office UX (fix wave 2026-11):**
- `cardPaymentsEnabled` reaches the detail via the server wrapper and the list
  via `GET /api/admin/invoices` (`data.cardPaymentsEnabled`). While false,
  Record payment shows `CARD_PAYMENTS_OFF_COPY` and the customer-link action
  reads "Copy portal link" (`invoiceLinkAction`): no link on drafts, settled,
  synced or customer-less invoices (the pay-link route 404s without a
  customer). Send reminder needs a customer too (`canSendReminder`).
- Record payment pre-fills the balance, scrolls into view, names the balance
  when over it, and says "We'll text the customer a receipt…" BEFORE
  recording when the invoice has a customer + phone (`receiptNoticeCopy`) —
  the receipt + drain themselves are by design (M3b).
- Payment chips via `paymentStatusLabel` (Received / Partly refunded /
  Refunded), refund reasons via `refundReasonLabel`; never raw enums.
- "Collected this month" = received (succeeded + refunded rows) − refunds
  given this month, native only, one `db.batch` (`collected-this-month.test.ts`).
- Phone list: `INVOICE_ROW_GRID` shows customer+age, balance, chevron below
  `sm`; Created shows the year outside the current year (`shortIssuedDate`).
- Document amount due is red only when past the due date
  (`invoiceDocModel(inv, now).isOverdue`).

**Round-2 fixes (2026-11):**
- Money inputs (Record payment, refund) use `parseMoneyInput`
  (`src/lib/admin/money-format.ts`): more than 2 decimals → "Use dollars and
  cents, like 12.50." — never rounded (1.999 used to record $2.00). Both are
  real `<form noValidate>`s, so Enter submits. The refund form pre-fills what
  is left to refund and names it when exceeded.
- A failed list load hides the SummaryBand and the empty state ("You're all
  caught up") and shows one `LoadErrorState`; the loading skeleton tiles sit
  above the filters like the loaded band. The detail tells a 404 from a
  failed load (`detailLoadFailure`, Try again) and keeps the invoice on
  screen when a later reload fails.
- `?created=1` is set only for a real creation (`created: true` from the
  POST) and is dropped from the URL after the banner shows.
- Financing panel only with a customer (`canOfferFinancing`).
- Activity rows: "Payment recorded · $200.00 · Check", "Refund issued · $50.00".
- Phones: the document drops the unit-price column below `sm`.

**Estimate-linked lines (M3c):** `invoice_line_items.estimate_line_item_id` marks lines copied from a sold estimate (field bill and office Generate); the field can't remove them (409 `FROM_ESTIMATE` 'This item came from the approved estimate. Ask the office to change it.'); the tech view marks them `fromEstimate` ('From the estimate').

**Gotchas:**
- The SummaryBand is suppressed during initial load (`!isLoading`) to avoid the
  zero-data flash before stats arrive — do not remove the guard.
- Source segmented control is hidden when only one source type exists in
  `sourceCounts` — this is deliberate (no noise for single-source orgs).
- Void is a soft state change (`state='void'`); it can't be undone via the UI;
  the server blocks voiding synced invoices and invoices with payments.

**Verify changes:** `npx vitest run src/lib/admin/money-format.test.ts src/components/admin/invoices/invoice-activity.test.ts src/app/api/admin/invoices/route.test.ts src/lib/admin/invoice-collectible.test.ts
src/lib/admin/invoice-list-pagination.test.ts src/lib/admin/invoice-queries.test.ts
src/lib/admin/invoice-synced-guards.test.ts src/lib/admin/invoice-queries-list.test.ts
src/lib/communication/send-invoice-reminder.test.ts src/lib/admin/invoice-payment-copy.test.ts
src/lib/admin/invoice-payment-writes.test.ts src/lib/admin/invoice-field-writes.test.ts
src/components/admin/invoices/invoice-signature-model.test.ts
tests/api/money-routes.test.ts tests/api/admin-invoice-finalize.test.ts`
· visual via admin-pages recipe.
