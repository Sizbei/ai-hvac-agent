# FP Display Phase 1 — Report

## Summary

FieldPulse-synced estimates are now read-only end-to-end: server-side gates refuse every mutation path, and the UI hides affordances + shows a banner for synced rows.

---

## Mutation Paths Found and Gated (2 paths)

| Path | Location | Gate |
|------|----------|------|
| Mark as Sold | `PATCH /api/admin/estimates/[id]` → `markEstimateSold()` | `fieldpulseEstimateId != null` → `synced_read_only` before any write; `fieldpulse_estimate_id IS NULL` in atomic UPDATE WHERE |
| Generate Invoice | `POST /api/admin/invoices` → `createInvoiceFromSoldEstimate()` | `fieldpulseEstimateId != null` → `synced_read_only` before any insert |

No DELETE route exists on `/api/admin/estimates/[id]`. The `POST /api/admin/estimates` (create) is for new native estimates only and is not affected. The public e-sign `approveEstimate()` is protected by the existing `status !== 'open'` guard (FP-synced estimates arrive as `sold`).

---

## View-Type Changes

### `EstimateListRow` (estimate-queries.ts)
- Added `syncedSource: "fieldpulse" | null` (derived from `fieldpulseEstimateId`)
- `listEstimates()` now selects `fieldpulseEstimateId` and maps it off before returning

### `EstimateDetailView` (estimate-queries.ts)
- Added `syncedSource: "fieldpulse" | null`
- `getEstimateDetailById()` now selects `fieldpulseEstimateId`, destructures it out, and sets `syncedSource`

### `EstimateListItem` hook type (use-estimates.ts)
- Added `syncedSource: 'fieldpulse' | null`

---

## UI Changes

### Estimates list (`/admin/estimates`)
- Status column shows violet "FieldPulse" pill alongside the status badge for synced rows (matches invoice-row.tsx token exactly: `rounded border bg-violet-50 px-1.5 py-px text-[10px] font-medium text-violet-700`)

### Estimate detail (`/admin/estimates/[id]`)
- Header shows violet "FieldPulse" pill next to `EstimateStatusBadge`
- Read-only banner shown below header: `"Synced from FieldPulse — estimates are managed there."` (violet border/bg, matches invoice-detail-client.tsx banner)
- "Generate Invoice" card hidden when `isSynced`
- "Mark sold" card hidden when `isSynced`

---

## API Route Error Handling
- `PATCH /api/admin/estimates/[id]` — added `synced_read_only` → `409 SYNCED_READ_ONLY`
- `POST /api/admin/invoices` — added `synced_read_only` → `409 SYNCED_READ_ONLY`

---

## Test Evidence

**`src/lib/admin/estimate-queries.test.ts`** — 7 tests pass (6 existing + 1 new):
- Updated existing `markEstimateSold` fixtures to include `fieldpulseEstimateId: null` for native estimates
- New: `markEstimateSold` refuses synced estimate, never calls `db.update`

**`src/lib/admin/estimate-synced-guards.test.ts`** — 7 tests pass (new file):
- `markEstimateSold` refuses synced, passes native
- `createInvoiceFromSoldEstimate` refuses synced (never calls `db.batch`/`db.insert`), passes native
- `listEstimates` exposes correct `syncedSource` for both synced and native rows
- `getEstimateDetailById` exposes correct `syncedSource` for both cases

**`npx vitest run src/lib/admin`** — 698 tests, 695 pass, 3 pre-existing failures (invoice-queries leftJoin mock — confirmed baseline in main).
**`npx tsc --noEmit`** — 0 errors.
**`npx next build`** — compiles successfully.
