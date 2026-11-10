---
name: page-estimates
description: Use when working on the /admin/estimates page — sales pipeline workspace with open/stale/won/lost KPI band and FieldPulse-synced estimates.
---

# Estimates (/admin/estimates · /admin/estimates/[id])

**Purpose:** operators manage proposals sent to customers — tracking pipeline
value, following up on stale open estimates, and converting sold estimates to invoices.

**Files:** list page `src/app/admin/(dashboard)/estimates/page.tsx` · detail
page `src/app/admin/(dashboard)/estimates/[id]/page.tsx` · create dialog
`src/components/admin/estimates/estimate-create-dialog.tsx` · status badge
`src/components/admin/estimates/estimate-status-badge.tsx` · hook
`src/hooks/use-estimates.ts` · API `src/app/api/admin/estimates/route.ts`
· detail API `src/app/api/admin/estimates/[id]/route.ts` · regenerate-link API
`src/app/api/admin/estimates/[id]/regenerate-link/route.ts` · queries
`src/lib/admin/estimate-queries.ts` · tables `estimates` `estimate_options`
`estimate_line_items` (schema `src/lib/db/schema.ts`).

**Data flow:** `useEstimates` fetches `/api/admin/estimates` with bucket, page,
search params. 60s SWR cache. KPI stats (openCents, staleCents, wonCents,
lostCents, winRatePct, avgOpenAgeDays) come from the server in the same
response — no client-side reduce. PER_PAGE=50. Default tab is "Open" (the
actionable follow-up list). Stale = open >14 days. Search debounced 300ms.

**Invariants (violate = bug):**
- List rows carry only `LIST_ESTIMATE_FIELDS` (`src/lib/admin/estimate-queries.ts`;
  contract test in `estimate-list-pagination.test.ts`). No `fieldpulseData` in the
  list: an expanded FieldPulse row reads it on expand via
  `src/components/admin/lazy-fieldpulse-details.tsx` from the detail endpoint.
- FieldPulse-synced estimates (syncedSource='fieldpulse') are read-only in
  this UI — the detail page renders an InfoBanner and hides "Mark sold" and
  "Generate invoice" actions. Mutations are blocked on the server in
  `src/lib/admin/estimate-queries.ts` (fieldpulseEstimateId guard).
- `effectiveCreatedAt` (not `createdAt`) drives age and stale calculation;
  for FP imports it reflects the FP created date, not the local import time.
- The `isOpenEstimate` helper (in list page) mirrors the server's
  BUCKET_CASE_SQL open semantics — the ELSE arm — so custom FP status names
  also count as open; don't tighten to an allowlist.
- Generate invoice (`POST /api/admin/invoices` with `estimateId`) is idempotent:
  if an invoice already exists it is returned, not re-created; always navigate
  to the returned invoiceId.
- `rollUpMargin` from `src/lib/admin/margin.ts` computes margin on the detail
  page; only display this for admin eyes — never expose to customers.
- Compose `PageShell`, `PageHeader`, `StatCard`, `Pager`, `SegmentedControl`
  from `src/components/admin/ui/`; status colors via `src/lib/admin/status-colors.ts`.
- **Lazy-expiry sweep:** `GET /api/admin/estimates` calls
  `expireOverdueEstimates(organizationId)` before reading — it flips native
  (non-FieldPulse), still-`open` estimates past `expiresAt` to `expired`, CAS-
  guarded the same way as `markEstimateSold` (WHERE repeats `status='open' AND
  fieldpulseEstimateId IS NULL`, so a row a customer just approved is left
  alone). No cron exists for this (Vercel Hobby caps crons at daily) — the list
  fetch IS the trigger. Without this, `winRatePct` can only trend toward 100%.
- Detail page has an "Approval link" card (open + native estimates only) that
  calls `POST /api/admin/estimates/[id]/regenerate-link` to mint a fresh
  one-time link when the create dialog's original display was dismissed —
  `regenerateApprovalToken` overwrites `approvalTokenHash`, which is itself
  what invalidates the previous plaintext token (only the newest hash is ever
  stored). Blocked with `synced_read_only` / `already_decided` outside that
  window.
- Estimate line item `quantity` is capped at `MAX_QUANTITY = 1_000_000` and
  `unitPriceCents` at `MAX_PRICE_CENTS` (`src/lib/admin/money-format.ts`) in
  the create schema — an unbounded value overflowed the INT32 money column
  and 500'd on insert. **Capping the factors is not enough**: the create route
  also rejects (400) when a DERIVED value overflows — `lineTotalCents` or an
  option's `totalCents` past `INT32_MAX`. `22 × $999,999.99` passes both
  per-field caps and still overflows `line_total_cents`. The check runs after
  catalog prices are resolved server-side, so it covers catalog lines too.

- **Estimate value = sold option:** every pipeline sum and the list row total
  use `ESTIMATE_VALUE_SQL` (sold option's total, same estimate; else the
  headline/largest-option `total_cents`). Never sum raw `estimates.totalCents`
  for Won — a sold Good/Better/Best would count its Best price.
- **New estimate from the list requires a customer** (`pickCustomer` prop →
  `estimate-customer-picker.tsx`, org-scoped `/api/admin/customers?search=`).
  The API stays backward compatible (customerId/title optional) but returns
  400 when `customerId` is not the session org's (`customerInOrg`). Optional
  `title` (≤200, blank → null). The dialog shows running subtotal/tax/total per
  option (`src/lib/admin/estimate-draft.ts`, org default tax via `useTaxRates`).
- Detail: heading = title, else "Estimate for <customer>" (`customerName` from
  an org-scoped join). An office Mark sold stores `signature_name = "(admin)"`;
  the detail resolves `markedSoldBy` from the newest `estimate_marked_sold`
  audit row → "Marked sold in the office by <staff>". Generate invoice pushes
  `/admin/invoices/<id>?created=1` (banner on the invoice).
- New line items get uuid **v7** ids so `ORDER BY id` is insertion order
  (older estimates keep random v4 order — no sort column exists).
- **Round-2 fixes:** the New estimate dialog asks "Discard this estimate?"
  on Esc / click outside / Cancel once anything was built
  (`isEstimateDraftDirty`), validates manual line prices with
  `draftLinePriceError` (strict `parseMoneyInput`), and offers "Open
  estimate" after creating. List rows carry `optionCount` + `soldOptionId`;
  an undecided multi-option total reads "up to $X" (`estimateTotalLabel` in
  `estimate-list-display.ts`) and the Open pipeline sublabel says "highest
  option"; age is clamped at 0 (`estimateAgeDays`). A failed list or detail
  load shows `LoadErrorState` — no $0.00 KPI band; the detail tells a 404
  ("may have been removed") from a failed load (`detailLoadFailure`). The
  detail carries `invoiceId` (left join on `invoices.estimate_id`) and shows
  "View invoice" instead of Generate once one exists; `POST
  /api/admin/invoices` returns `created: false` (200, no audit) for an
  existing invoice and the page only adds `?created=1` for a real creation.
  Mark sold asks first. Financing is offered only with a customer
  (`canOfferFinancing`).

**Field estimates (M3c):** title 'Field estimate', no approval token, 30-day expiry, sold on the technician's phone. `estimates.sold_via` ('portal' | 'office' | 'field', NULL before M3c) and `sold_by` (technician for field, admin for office). Detail Approval card (names in bold as before): field → 'Signed by <name>.' + 'Signed on site with <technician> · <time>'; office → 'Marked sold by <admin>'; old rows unchanged (`approvalLines`, `src/lib/admin/estimate-approval-copy.ts`). `Sold, not invoiced` tab (`bucket=not_invoiced`): native sold, no invoice of any state with this `estimate_id`, not on the job's invoice. Generate (`createInvoiceFromSoldEstimate`) refuses while the field bill holds the lines and returns that invoice; both insert paths write `estimate_line_item_id` with v7 ids in line order. A voided office invoice ends office billing (Generate returns it). The detail carries a read-only `jobInvoiceId` (`billingInvoiceIdSql` when no office invoice exists); a billed estimate shows no Generate, only "Invoice created" or "On the job's invoice" with View invoice (`estimateInvoiceCard`, `src/lib/admin/estimate-detail-display.ts`). Approval and Created dates use the business timezone (`businessWhen`/`businessDay`). `useEstimates` guards fetches per key (`src/lib/admin/keyed-fetch.ts`), so a `?bucket=` deep link loads that bucket on first load.

**Gotchas:**
- `winRatePct` can be null (no closed estimates yet); guard before rendering.
- `stats` may be null on partial server failures; the KpiBand must handle
  `stats=null` (all counts/amounts default to 0).
- The "Log follow-up" link prefers the customer page's #follow-ups section;
  falls back to the request page or the estimate detail — no new backend.

**Verify changes:** `npx vitest run src/lib/admin/estimate-queries.test.ts
src/lib/admin/estimate-list-pagination.test.ts
src/lib/admin/estimate-synced-guards.test.ts src/lib/admin/estimate-value.test.ts
src/lib/admin/estimate-detail.test.ts src/lib/admin/estimate-draft.test.ts
src/lib/admin/estimate-list-display.test.ts src/lib/admin/detail-load.test.ts` · visual via admin-pages recipe.
