---
phase: 03-admin-dashboard
plan: 02
subsystem: api
tags: [drizzle, next-api-routes, zod, bcryptjs, audit-log, multi-tenancy]

requires:
  - phase: 01-foundation
    provides: database schema (serviceRequests, users, messages, auditLog), withTenant helper, crypto module, api-response envelope, logger
  - phase: 03-admin-dashboard plan 01
    provides: getAdminSession from auth/session for JWT cookie verification
provides:
  - Admin API routes for service request management (list, detail, assign)
  - Technician CRUD API routes (list, create, update)
  - Dashboard stats endpoint (pending, assigned today, in progress, completed today)
  - Audit logging helper for all admin mutations
  - Admin types module (AdminRequest, AdminRequestDetail, TechnicianRecord, DashboardStats)
  - Admin query module with withTenant enforcement on every query
affects: [03-admin-dashboard plans 03-05 (UI consumes these APIs), 04-polish]

tech-stack:
  added: []
  patterns: [admin query module with withTenant enforcement, safeDecrypt wrapper for PII, logAudit on all mutations, Zod validation on all request bodies]

key-files:
  created:
    - src/lib/admin/types.ts
    - src/lib/admin/audit.ts
    - src/lib/admin/queries.ts
    - src/app/api/admin/requests/route.ts
    - src/app/api/admin/requests/[id]/route.ts
    - src/app/api/admin/requests/[id]/assign/route.ts
    - src/app/api/admin/technicians/route.ts
    - src/app/api/admin/technicians/[id]/route.ts
    - src/app/api/admin/stats/route.ts
  modified: []

key-decisions:
  - "Used safeDecrypt wrapper that returns null on failure instead of throwing, for resilient PII decryption"
  - "Status filter validated against requestStatusEnum values before casting to enum type for type safety"
  - "assignTechnician verifies technician belongs to same org before assignment (T-03-06 mitigation)"

patterns-established:
  - "Admin query pattern: every function takes organizationId first, uses withTenant, returns typed readonly interfaces"
  - "Admin route pattern: getAdminSession check, Zod validation, query call, logAudit on mutations, try-catch with 500"
  - "safeDecrypt: null-safe decrypt wrapper for encrypted PII fields"

requirements-completed: [SC-17, SC-18, SC-19, SC-20, SC-21, SC-22, SC-23]

duration: 3min
completed: 2026-05-27
---

# Phase 3 Plan 2: Admin API Routes Summary

**Multi-tenant admin API with 7 endpoints for request management, technician CRUD, dashboard stats, and audit-logged mutations**

## Performance

- **Duration:** 3 min
- **Started:** 2026-05-27T08:49:53Z
- **Completed:** 2026-05-27T08:53:32Z
- **Tasks:** 2
- **Files modified:** 9

## Accomplishments
- Created typed admin query module with 7 database functions, all enforcing multi-tenancy via withTenant
- Built 6 API route files (7 HTTP handlers) with session verification, Zod input validation, and audit logging
- PII decryption implemented only in authorized detail view (getRequestById) per threat model T-03-07
- All mutations (assign, create tech, update tech) write to audit_log table per T-03-09

## Task Commits

Each task was committed atomically:

1. **Task 1: Create admin types, audit helper, and query module** - `5f6cac2` (feat)
2. **Task 2: Create all admin API route handlers** - `f831e03` (feat)

## Files Created/Modified
- `src/lib/admin/types.ts` - AdminRequest, AdminRequestDetail, TechnicianRecord, DashboardStats, RequestFilters, CreateTechnicianInput, UpdateTechnicianInput
- `src/lib/admin/audit.ts` - logAudit helper that inserts into audit_log table
- `src/lib/admin/queries.ts` - getRequests, getRequestById, assignTechnician, getTechnicians, createTechnician, updateTechnician, getDashboardStats
- `src/app/api/admin/requests/route.ts` - GET /api/admin/requests with status filter and pagination
- `src/app/api/admin/requests/[id]/route.ts` - GET /api/admin/requests/[id] with decrypted PII and transcript
- `src/app/api/admin/requests/[id]/assign/route.ts` - POST assign technician with audit log
- `src/app/api/admin/technicians/route.ts` - GET list and POST create technician with audit log
- `src/app/api/admin/technicians/[id]/route.ts` - PATCH update technician with audit log
- `src/app/api/admin/stats/route.ts` - GET dashboard stats (pending, assigned today, in progress, completed today)

## Decisions Made
- Used safeDecrypt wrapper that returns null on failure instead of throwing, for resilient PII decryption in admin views
- Validated status filter against requestStatusEnum values before casting to enum type for drizzle-orm type safety
- assignTechnician verifies technician belongs to same org before allowing assignment (cross-tenant protection per T-03-06)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Fixed TypeScript enum type mismatch for status filter**
- **Found during:** Task 1 (query module)
- **Issue:** `filters.status` is `string` but drizzle-orm `eq()` on a pgEnum column requires the literal union type
- **Fix:** Validated status against `requestStatusEnum.enumValues` array then cast to enum type
- **Files modified:** src/lib/admin/queries.ts
- **Verification:** `npx tsc --noEmit` passes with zero errors
- **Committed in:** 5f6cac2 (Task 1 commit)

---

**Total deviations:** 1 auto-fixed (1 bug)
**Impact on plan:** Type safety fix necessary for compilation. No scope creep.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required.

## Next Phase Readiness
- All 7 admin API endpoints are ready for the admin dashboard UI (Plans 03-03 through 03-05)
- Auth session module from Plan 03-01 is integrated and working
- Query module provides typed, tenant-scoped data for all admin views

## Self-Check: PASSED

All 9 files verified present. Both task commits (5f6cac2, f831e03) verified in git log.

---
*Phase: 03-admin-dashboard*
*Completed: 2026-05-27*
