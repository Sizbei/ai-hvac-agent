# Deferred Items - Phase 03

## Pre-existing Issues (Out of Scope)

### TypeScript error in src/lib/admin/queries.ts
- **Discovered during:** 03-01 Task 2 verification
- **Issue:** `src/lib/admin/queries.ts` (untracked file, likely from Plan 03-02 preparation) has a TS2769 error on `eq(serviceRequests.status, status)` where `status` is `string` but the column expects a union type
- **Impact:** Does not affect 03-01 files; only surfaces when running `npx tsc --noEmit` without file filtering
- **Action:** Should be fixed when 03-02 is executed (the file belongs to that plan)

### Untracked files from other plans
- `src/lib/admin/types.ts` - Pre-existing untracked file
- `src/app/api/admin/requests/route.ts` - Pre-existing untracked file
- `src/app/api/admin/requests/[id]/route.ts` - Pre-existing untracked file
- `src/app/api/admin/requests/[id]/assign/route.ts` - Pre-existing untracked file
