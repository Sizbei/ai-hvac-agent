# Latency Phase C — Parallelize Admin Query Chains

## Audit Results

| Route / Function | Before | After | Round Trips Saved |
|---|---|---|---|
| `GET /api/admin/invoices` | `listInvoices` → `collectedThisMonthCents` (2 sequential) | `Promise.all([listInvoices, collectedThisMonthCents])` (1) | −1 |
| `GET /api/admin/invoices/[id]` | `getInvoiceDetailById` → `Promise.all([org, reminders])` (2 sequential batches) | `Promise.all([detail, org, reminders])` (1) | −1 |
| `getRequestById` (queries.ts) | main row → `messageRows` → `noteRows` (2 sequential after main) | main row → `Promise.all([messageRows, noteRows])` (1 after main) | −1 |
| `getCustomerById` (crm-queries.ts) | `Promise.all([equip, notes, followUps, history])` → `requestCount` (sequential) | `Promise.all([equip, notes, followUps, history, requestCount])` (1 parallel batch) | −1 |
| `getDashboardOverview` | already `Promise.all` | no change | — |
| `getDispatchBoard` | already `Promise.all` | no change | — |
| `getSchedulingCalendar` | already `Promise.all` | no change | — |
| `getOperationsMetrics` | already `Promise.all` (9 aggregates) | no change | — |
| `searchAllEntities` | already `Promise.all` (4 entity searches) | no change | — |

## Files Changed

- `src/app/api/admin/invoices/route.ts` — parallel list + collectedThisMonth
- `src/app/api/admin/invoices/[id]/route.ts` — parallel detail + org + reminders
- `src/lib/admin/queries.ts` — parallel transcript + notes in `getRequestById`
- `src/lib/admin/crm-queries.ts` — fold `requestCount` into existing `Promise.all` in `getCustomerById`

## Verification

- `npx tsc --noEmit`: 0 errors
- `npx eslint` on changed files: 0 warnings/errors
- `npx vitest run`: 4 pre-existing failures (baseline); 0 new failures; 12 new tests passing (from booking-quality.test.ts + score.ts)
- `npx next build`: clean (all pages compile)
