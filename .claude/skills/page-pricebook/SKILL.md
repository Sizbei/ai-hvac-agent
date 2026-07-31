---
name: page-pricebook
description: Use when working on the /admin/pricebook page — 17.5k-item server-paginated service/material/equipment catalog with tax rates panel.
---

# Pricebook (/admin/pricebook)

**Purpose:** operators manage priced line items (services, materials, equipment)
and the org's tax rates. Items are used in estimate line items and invoice generation.

**Files:** page `src/app/admin/(dashboard)/pricebook/page.tsx` · table
`src/components/admin/pricebook/pricebook-table.tsx` · form
`src/components/admin/pricebook/pricebook-form-dialog.tsx` · tax panel
`src/components/admin/pricebook/tax-rates-panel.tsx` · hook
`src/hooks/use-pricebook.ts` · API `src/app/api/admin/pricebook/route.ts`
· tax API `src/app/api/admin/pricebook/tax-rates/route.ts` · queries
`src/lib/admin/pricebook-queries.ts` · tables `pricebook_items`
`pricebook_categories` (schema `src/lib/db/schema.ts`).

**Data flow:** client `usePricebook` hook fetches `/api/admin/pricebook` with
query params (page, search, type, sort, includeInactive, isLaborItem). 60s
SWR cache keyed on the full param set. PER_PAGE=50; `total` drives the Pager.
`useTaxRates` is a separate fetch so the tax panel can refresh independently.
Search is debounced 300ms. Filters persist to URL (?q=&type=&sort=&inactive=&labor=).

**Invariants (violate = bug):**
- Items are soft-deleted only (DELETE API sets `active=false`); never hard-delete
  a pricebook item — historical line items reference it.
- `fieldpulseItemId` is set on FP-synced items. Editing synced items writes
  through to the local row only; it does not push back to FieldPulse.
- `memberPriceCents` drives member-discount pricing for enrolled customers;
  keep null (not 0) when no member rate is defined — 0 and null are distinct.
- Page resets to 1 on every filter/search change; pager page is not persisted
  to URL (intentional — avoids stale deep links).
- `/` keyboard shortcut focuses search when focus is not already in a text field.
- Compose `PageShell`, `PageHeader`, `Pager` from `src/components/admin/ui/`;
  status colors via `src/lib/admin/status-colors.ts` only.

**Gotchas:**
- The `types` array returned by the server drives the type-filter dropdown;
  never hardcode type values — they come from actual db rows.
- Tax rates and pricebook items are fetched separately; `handleRefetchAll`
  must call both `refetch()` and `refetchTax()` after any mutation.
- 17.5k items means full-table fetches are expensive — the server must always
  paginate; never bypass the `page`/`limit` params.

**Verify changes:** `npx vitest run src/lib/admin/pricebook-list-helpers.test.ts
src/lib/admin/pricebook-queries.test.ts` · visual via admin-pages recipe.
