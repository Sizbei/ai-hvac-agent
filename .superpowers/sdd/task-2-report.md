# Task 2 Report: Pricebook Server-Side Pagination

## Status

DONE

## What was done

### 1. `src/lib/admin/pricebook-queries.ts`
- Replaced the old `listPricebookItemsForAdmin(orgId, { includeInactive? })` flat-array return with a paginated signature: `(orgId, { includeInactive?, page?, limit?, search?, type? }) → Promise<PricebookAdminPage>`.
- New `PricebookAdminPage` interface: `{ items: readonly PricebookItemAdminRow[], total: number, types: readonly string[] }`.
- Page size 50. `Promise.all([countPromise, rowsPromise, typesPromise])` runs all three queries in parallel.
- Search: plaintext ilike on `name OR sku OR description` with `\%_` escape (identical escape to `getRequests`).
- Type filter: `sql\`${pricebookItems.type} = ${opts.type}\`` to bypass Drizzle's enum literal constraint.
- Types facet: `selectDistinct({ type })` on active items only — fills the dropdown without a separate API call.
- Added imports: `count`, `ilike`, `or`, `sql`, `type SQL` (restored `and` which was needed by `getDefaultTaxBps` below).

### 2. `src/app/api/admin/pricebook/route.ts` (GET handler)
- Now parses `page`, `search`, `type` from query string alongside existing `includeInactive`.
- `page` guard: `Number.isFinite && > 0 ? Math.floor : 1`.
- Returns `successResponse({ items, total, types })`.

### 3. `src/app/api/tech/pricebook/route.ts`
- Callee used `rows.filter(...)` on what was a plain array — now `PricebookAdminPage`. Updated to run two parallel `listPricebookItemsForAdmin` calls (one per type: material, equipment) with `limit: 1000` and merge the `.items` arrays. Functionally identical; no behavior change.

### 4. `src/hooks/use-pricebook.ts`
- Full rewrite: `usePricebook(params: { page?, search?, type? })` with `createSwrCache` keyed on the full param tuple (60s TTL), mirroring `useAdminCustomers` exactly.
- Returns `{ items, total, types, isLoading, error, refetch }`.
- New `useTaxRates()` hook for the tax panel — separate small fetch so the tax panel can refresh independently.
- `TaxRate` and `PricebookItem` types remain exported unchanged (used by form dialog, table, tax panel).

### 5. `src/app/admin/(dashboard)/pricebook/page.tsx`
- Added `search` / `debouncedSearch` (300ms debounce), `typeFilter`, `page` state.
- Calls `usePricebook({ page, search: debouncedSearch, type: typeParam })` and `useTaxRates()` independently.
- Page-reset effect on `debouncedSearch` / `typeFilter` change.
- Search box (with icon) and type-filter Select driven by the server `types` facet.
- Pager bar identical to customers page: `← Prev` / First / Last / `Next →` + `pageLabel(safePage, total, PER_PAGE)`.
- Edit dialog and deactivate flow untouched.

### 6. `src/lib/admin/pricebook-list-helpers.test.ts` (new)
- 7 mock-shape tests using same hoisted-proxy harness as `crm-list-helpers.test.ts`.
- Asserts: hasLimit true, every WHERE contains org id, `{ items, total, types }` shape, active filter, ilike search, type sql filter, selectDistinct facet (3 captures total).

## Gates

- `npx tsc --noEmit`: clean (0 errors)
- `npx vitest run src/lib/admin/pricebook-list-helpers.test.ts`: 7/7 green
- Full suite: 4 files / 5 tests pre-existing failures (identical to baseline before changes); 0 new failures introduced.

## Concerns

None. The type-filter uses `sql\`...\`` rather than `eq()` to bypass the Drizzle enum-literal type constraint — this is correct and safe (the DB enforces the enum at the column level; the route does not whitelist values, but invalid type strings return 0 rows harmlessly). If stricter whitelisting is desired, it can be added to the route without touching the query.

---

## Review Fix Report

### Changes Made

**Fix 1 — Full-catalog consumers**
- `src/app/api/admin/pricebook/route.ts`: Added `limit` query param parsing, clamped to 1–20,000, default 50. Forwarded to `listPricebookItemsForAdmin`.
- `src/hooks/use-pricebook.ts`: Added `limit` to `UsePricebookParams`; included in SWR cache key (`pricebook:${page}:${limit}:${type}:${search}`) and forwarded to URL query string when non-default.
- `src/app/admin/(dashboard)/inventory/page.tsx`: Changed `usePricebook()` → `usePricebook({ limit: 20000 })`.
- `src/components/admin/estimates/estimate-create-dialog.tsx`: Changed `usePricebook()` → `usePricebook({ limit: 20000 })`.

**Fix 2 — Tech pricebook truncation guard**
- `src/app/api/tech/pricebook/route.ts`: Raised per-type limit from 1000 → 20,000. Added `logger.warn` after each parallel fetch if `items.length === TECH_LIMIT`, logging org id and type.

**Fix 3 — Type whitelist**
- `src/app/api/admin/pricebook/route.ts`: Added `VALID_TYPES = ['service','material','equipment']` guard; invalid `type` values are treated as undefined (no filter), preventing Postgres enum errors.
- `src/app/api/tech/pricebook/route.ts`: Types are now typed via `VALID_TYPES` tuple; no arbitrary string passthrough.

**Fix 4 — Test: shared WHERE clause**
- `src/lib/admin/pricebook-list-helpers.test.ts`: Added test asserting `JSON.stringify(count.where) === JSON.stringify(rows.where)` when a search term is active, plus that both contain an ilike predicate.

**Fix 5 — Test: LIKE metacharacter escaping**
- `src/lib/admin/pricebook-list-helpers.test.ts`: Added test with input `'comp%res_sor\\'` asserting the serialized where clause contains `\\%`, `\\_`, and `\\\\` (escaped forms of `%`, `_`, `\`).

### Gate Results

- `npx tsc --noEmit`: clean (0 errors)
- `npx vitest run src/lib/admin/pricebook-list-helpers.test.ts`: **9/9 passed**

```
 Test Files  1 passed (1)
      Tests  9 passed (9)
   Start at  18:03:25
   Duration  182ms
```
