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

**Gotchas:**
- `winRatePct` can be null (no closed estimates yet); guard before rendering.
- `stats` may be null on partial server failures; the KpiBand must handle
  `stats=null` (all counts/amounts default to 0).
- The "Log follow-up" link prefers the customer page's #follow-ups section;
  falls back to the request page or the estimate detail — no new backend.

**Verify changes:** `npx vitest run src/lib/admin/estimate-queries.test.ts
src/lib/admin/estimate-list-pagination.test.ts
src/lib/admin/estimate-synced-guards.test.ts` · visual via admin-pages recipe.
