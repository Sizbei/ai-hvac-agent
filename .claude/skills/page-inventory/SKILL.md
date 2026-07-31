---
name: page-inventory
description: Use when working on the /admin/inventory page — track stock levels for pricebook materials, filter by reorder threshold, manage purchase orders.
---

# Inventory (/admin/inventory)

**Purpose:** track on-hand stock for pricebook materials and manage purchase orders
for replenishment. Inventory items link to the pricebook — there is no separate
material catalog.

**Files:** page `src/app/admin/(dashboard)/inventory/page.tsx` · components
`src/components/admin/inventory/inventory-table.tsx` ·
`src/components/admin/inventory/inventory-form-dialog.tsx` ·
`src/components/admin/inventory/purchase-orders-panel.tsx` · hook
`src/hooks/use-inventory.ts` · secondary hook `src/hooks/use-pricebook.ts` ·
APIs `src/app/api/admin/inventory/route.ts` ·
`src/app/api/admin/inventory/purchase-orders/route.ts` · tables
`inventory_items`, `purchase_orders`

**Data flow:** `useInventory` fetches inventory list and purchase orders via
`db.batch` in a single round-trip. Pagination at 50 rows per page (`PER_PAGE`).
`usePricebook` fetches up to 20,000 items to populate the material picker dropdown
(materials filtered to `type === 'material' && active` in the component).
Filters (`q`, `sort`, `belowReorder`) are URL-synced via `useUrlFilterSync` for
shareable links. Search is debounced 300 ms.

**Invariants:**
- Inventory tracks pricebook materials only — `inventoryItems` rows must reference
  a pricebook item via `pricebookItemId`. Do not create a separate material entity.
- "Below reorder only" filter: toggling it resets `page` to 1 (same as search/sort
  changes).
- Sort options are `name` (default), `qty_asc`, `qty_desc`. Default (`name`) is
  dropped from the URL to keep links clean.
- `safePage = Math.min(page, totalPages)` prevents stale page state if a filter
  narrows the result set.
- Pager renders only when `inventoryTotal > 0`; an empty list shows no pager.

**Gotchas:**
- The `usePricebook({ limit: 20000 })` call is intentionally large — it powers
  the material-picker dropdown and must cover the full catalog. Leave the limit as-is.
- `materials` array is derived from pricebook items via `useMemo` — do not move
  the filter into `usePricebook`.

**Verify changes:** visual via the admin-pages recipe at `/admin/inventory` ·
test "Below reorder only" toggle and search debounce. `npx vitest run
src/app/api/admin/inventory` if API tests exist.
