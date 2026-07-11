# Task 1 Report — Operations headline = combined AR (native+synced split); Reports AR balance guard

## What was changed

### 1. `src/lib/admin/reporting-queries.ts` — Balance guard added to AR query
Added `sql\`${invoices.amountPaidCents} < ${invoices.totalCents}\`` as an additional condition in the AR `withTenant(...)` WHERE clause (line ~151). This prevents fully/over-paid invoices in state='open' from contributing zero or negative values to the outstanding AR total — matching the same guard already present in `operations-metrics-queries.ts:250`.

### 2. `src/lib/admin/operations-metrics-types.ts` — New `totalOutstandingAllCents` field
Added `readonly totalOutstandingAllCents: number` to the `OperationsMetrics` interface with doc comment: `/** Native + synced AR combined — the headline number. Native-only lives in totalOutstandingCents. */`

### 3. `src/lib/admin/operations-metrics-queries.ts` — Compute and return combined total
Added `const totalOutstandingAllCents = (b0 + b30 + b60) + syncedArTotalCents;` after the native aging reduction, and included it in the return object. This is the native bucket sum plus the synced AR total already computed at line 385.

### 4. `src/hooks/use-operations-metrics.ts` — Hook type updated
Added `readonly totalOutstandingAllCents: number` to the re-declared `OperationsMetrics` interface in the hook (the hook re-declares its own type; both must stay in sync).

### 5. `src/app/admin/(dashboard)/operations/page.tsx` — Headline uses combined total
Changed the "Total outstanding" stat to render `metrics?.totalOutstandingAllCents ?? agingTotal` (falls back to native-only during loading). Added a one-line split hint below: `Native {formatCentsExact(agingTotal)} · Synced (FieldPulse/HCP) {formatCentsExact(metrics?.syncedArTotalCents ?? 0)} — collected in the external system`. The aging buckets and the existing synced-AR section beneath them are unchanged.

### 6. Test additions
- **`src/lib/admin/operations-metrics-queries.test.ts`**: Added 2 new top-level tests:
  - `totalOutstandingAllCents = native (b0+b30+b60) + syncedArTotalCents` — seeds native 2800 + synced 15000, asserts combined = 17800
  - `totalOutstandingAllCents = 0 when both native and synced are zero` — default-empty queue, asserts 0
- **`src/lib/admin/reporting-queries.test.ts`**: Added 1 new test inside `getSalesReport`:
  - `AR where-clause includes the balance guard (amountPaidCents < totalCents)` — asserts the 3rd captured select's where contains a `sql`-tagged condition referencing both `invoices.amountPaidCents` and `invoices.totalCents`

## Test output

```
 Test Files  2 passed (2)
      Tests  32 passed (32)
   Start at  17:41:38
   Duration  186ms
```

`npx tsc --noEmit` — clean (no output).

## Prod verification (not run — would need live DB env)

Expected on prod: `totalOutstandingAllCents ≈ 15_206_100` (~$152,061), `arAging.totalOutstandingCents === 0` (all AR is synced), reports `outstandingArCents ≈ 15_206_100`.

## Concerns

None. The changes are minimal and surgical:
- The balance guard in reporting-queries is a one-line addition matching the existing operations query guard.
- `totalOutstandingAllCents` is a pure addition — it does not replace `arAging.totalOutstandingCents` (native-only, kept for the aging bar chart percentages and the split hint).
- The page still shows native aging buckets and the existing synced-AR due-date section unchanged; only the headline number changes.
- The hook type duplication (server types.ts + hook interface) is a pre-existing codebase pattern; both are now in sync.
