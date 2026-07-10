# FieldPulse Field Parity P3 — Implementation Report

**Date:** 2026-07-11  
**Branch:** `feat/fp-parity-p3` (from `origin/main`)

## What was built

### 1. Shared `FieldpulseDetails` component + pure format helpers
- `src/lib/admin/fieldpulse-details-format.ts` — pure helpers: `humanizeKey` (snake_case→Title Case), `formatValue` (bool→Yes/No, ISO dates→readable, arrays→CSV), `buildFieldpulseEntries` (null/empty guard, skip plain objects, alphabetical sort).
- `src/components/admin/fieldpulse-details.tsx` — collapsible "FieldPulse details" panel. Violet-tinted toggle, `aria-expanded`, `motion-reduce` aware, renders nothing when data is null/empty.
- `src/lib/admin/fieldpulse-details-format.test.ts` — 20 pure unit tests.

### 2. Invoice detail
- `InvoiceDetailView` extended with `fieldpulseData: Record<string,unknown>|null`.
- `getInvoiceDetailById` selects `invoices.fieldpulseData` and exposes it (cast from jsonb `unknown`).
- `invoice-detail-client.tsx` adds `fieldpulseData` to `ApiInvoice` and wires `<FieldpulseDetails>` at bottom of left column.

### 3. Estimate detail + list
- `EstimateListRow` + `EstimateDetailView` extended with `title: string|null` and (detail only) `fieldpulseData`.
- `listEstimates` selects `estimates.title`; `getEstimateDetailById` selects `title` + `fieldpulseData`.
- `EstimateListItem` hook type updated with `title`.
- Estimates list page (`/admin/estimates`) shows title as subtitle under status badges.
- `scoped-estimates-section.tsx` (used on customer profile + request sheet) shows title in estimate rows.
- Estimate detail page shows `estimate.title ?? 'Estimate'` in the h1; wires `<FieldpulseDetails>`.

### 4. Customer profile
- `CustomerDetail` extended with `isTaxExempt`, `billingAddress`, `fieldpulseData`.
- `getCustomerById` maps `row.isTaxExempt`, decrypts `billingAddressEncrypted` via `safeDecrypt`, casts `fieldpulseData`.
- Customer detail page header: Residential/Commercial badge + Tax-exempt chip (conditional on `isTaxExempt === true`).
- Contact card: billing address displayed when present and differs from service address.
- `<FieldpulseDetails>` wired after the FieldPulse custom fields card.

### 5. Request detail sheet
- `AdminRequestDetail` extended with `fieldpulseData`.
- `getRequestDetail` query selects `serviceRequests.fieldpulseData` and maps it.
- `request-detail-sheet.tsx` imports `FieldpulseDetails` and wires it after the FP metrics section.

## Test / build summary
- `npx vitest run src/lib/admin/ src/components/admin/`: 814 passed, 3 pre-existing failures (invoice mock missing `leftJoin` — existed before this PR, confirmed by `git stash` baseline check).
- `npx tsc --noEmit`: 0 errors.
- `npx eslint` on all new/modified lib files: 0 errors (pre-existing warnings on React hook patterns in untouched sections of unchanged files).
- `npx next build`: ✓ Compiled successfully, 0 errors.

## P3 review fixes (amend ade2abe)

### Fix 1 — pricebook edit dialog fieldpulseData surface
- `PricebookItemAdminRow` interface: added `readonly fieldpulseData: Record<string, unknown> | null`.
- `ADMIN_ITEM_PROJECTION`: added `fieldpulseData: pricebookItems.fieldpulseData`.
- `getPricebookItemById` + `listPricebookItemsForAdmin`: cast return from drizzle `unknown` to `PricebookItemAdminRow` (jsonb typed as `unknown` upstream).
- `PricebookItem` hook type (`use-pricebook.ts`): added `readonly fieldpulseData: Record<string, unknown> | null`.
- `pricebook-form-dialog.tsx`: imported `FieldpulseDetails`; added `<FieldpulseDetails data={editing?.fieldpulseData ?? null} />` between the sync hint and the form. Renders nothing for native/FP items without spillover — correct per spec.
- `field-queries.test.ts` (2 fixtures): added `fieldpulseData: null` to satisfy the now-required type property.

### Fix 2 — fieldpulse-details.tsx a11y cleanup
- Removed dead `aria-hidden={!open}` attribute (panel unmounts when collapsed — no DOM node means no aria-hidden needed).
- Updated JSDoc comment to say content unmounts rather than is aria-hidden.

## Concerns / notes
- The 3 `invoice-queries.test.ts` failures are pre-existing (mock chain missing `leftJoin`) — not regressions.
- `billingAddress` is shown only when it differs from `customer.address`; if both are null the condition is correctly `null !== null === false` (not shown), matching spec intent.
- No migration needed — all columns (isTaxExempt, billingAddressEncrypted, fieldpulseData, title) were added in P1.
