# Latency Phase B — Implementation Report

**Branch:** `feat/latency-b`  
**Status:** DONE

## What was built

### 1. Shared skeleton components (`src/components/admin/skeletons.tsx`)
- `TableSkeleton` (configurable rows/cols, shimmer header bar + row bars)
- `StatTileSkeleton` (label + big number + delta chip placeholders)
- `CardSkeleton` (avatar circle + two text bars + right-side counts)
- All use `bg-muted` + `animate-pulse`; `motion-reduce:animate-none` applied throughout.

### 2. Wired into heavy pages
- **Invoices** (`invoices/page.tsx`): replaced 3 plain `<Skeleton>` bars with `StatTileSkeleton ×4` + `TableSkeleton rows=8` so the summary band area and list area both show structured skeletons on first load. SWR cache path still renders instantly (hook returns stale data; `isLoading` stays false).
- **Customers** (`customers/page.tsx`): replaced `Skeleton` import + 5 generic bars with `CardSkeleton ×6` matching the real card grid layout.
- **Requests**: already delegates loading to `RequestTable`, which has its own skeleton rows — no additional change needed.
- **Operations**: already handles loading inline per KPI card via its own `Skeleton` (`isLoading` prop passed to each `KpiCard`); frame renders immediately with preset buttons visible.

### 3. FP-import idle-poll stop (`src/hooks/use-fp-import-status.ts`)
- Extracted `nextPollDelay(runs): number | null` — pure helper, returns `2500` when any run is `'running'`, `null` otherwise.
- Hook stops scheduling the next tick when `nextPollDelay` returns `null` (no active run). Exposes `isPolling: boolean` + `refresh()` callback.
- FP-import page shows a **Refresh** button in the `PageHeader` actions slot when `!isPolling`.

### 4. Sidebar prefetch audit
No `prefetch={false}` found anywhere in `sidebar.tsx` or any admin `<Link>`. Next.js default prefetching is active for all nav items. Nothing to change.

### 5. Tests
- `src/hooks/use-fp-import-status.test.ts`: 6 unit tests for `nextPollDelay` — empty runs, all-completed, all-failed, mixed, single running. All pass.

## Verification

| Check | Result |
|---|---|
| `npx vitest run` (new tests) | 6/6 pass |
| `npx vitest run` (full suite) | 3589 pass, 4 fail — same 2 files as baseline (DB-dependent, pre-existing) |
| `npx tsc --noEmit` | 0 errors |
| `npx eslint` changed files | 0 errors; 1 pre-existing warning (`setIsLoading` in effect, same pattern as original hook) |
| `npx next build` | ✓ Compiled successfully in 12.9s, 124 pages |
