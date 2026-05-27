---
phase: 03-admin-dashboard
plan: 01
subsystem: auth
tags: [jwt, jose, bcryptjs, admin-auth, proxy, cookies, next16]

# Dependency graph
requires:
  - phase: 01-schema-ai-core
    provides: users table with passwordHash, role, organizationId
provides:
  - JWT sign/verify via jose (signToken, verifyToken)
  - Admin session cookie management (createAdminSession, getAdminSession, deleteAdminSession)
  - Login/logout API endpoints
  - Route protection for /admin/* and /api/admin/*
  - proxy.ts replacing deprecated middleware.ts
affects: [03-02-admin-api, 03-03-admin-ui, 03-04-admin-pages]

# Tech tracking
tech-stack:
  added: [jose@6.2.3, server-only]
  patterns: [JWT stateless sessions, proxy-based route protection, httpOnly cookie auth]

key-files:
  created:
    - src/lib/auth/types.ts
    - src/lib/auth/config.ts
    - src/lib/auth/session.ts
    - src/app/api/auth/login/route.ts
    - src/app/api/auth/logout/route.ts
    - src/proxy.ts
  modified:
    - .env.example
    - package.json
    - package-lock.json

key-decisions:
  - "Used jose directly for JWT instead of NextAuth v5 -- Edge-compatible with Next.js 16 proxy.ts pattern"
  - "Migrated middleware.ts to proxy.ts per Next.js 16 deprecation"
  - "Generic 'Invalid credentials' error for both wrong email and wrong password (T-03-03 mitigation)"

patterns-established:
  - "Admin auth: jose JWT with HS256, 24h expiry, httpOnly cookie"
  - "Proxy-based route protection: verify JWT in proxy.ts for /admin/* and /api/admin/*"
  - "Admin session cookie name: hvac_admin_session"

requirements-completed: [SC-15, SC-16, SC-17]

# Metrics
duration: 3min
completed: 2026-05-27
---

# Phase 3 Plan 1: Admin Auth Summary

**JWT admin auth with jose HS256, login/logout API routes, and proxy.ts route protection for /admin/* and /api/admin/***

## Performance

- **Duration:** 3 min
- **Started:** 2026-05-27T08:49:28Z
- **Completed:** 2026-05-27T08:52:48Z
- **Tasks:** 3
- **Files modified:** 9

## Accomplishments
- Admin JWT session management with jose (HS256, 24h expiry, httpOnly secure cookie)
- Login endpoint validates credentials via bcrypt, checks role=admin and isActive status
- Migrated middleware.ts to proxy.ts per Next.js 16 convention with admin route protection

## Task Commits

Each task was committed atomically:

1. **Task 1: Create admin auth types, JWT config, and session management** - `5269c6a` (feat)
2. **Task 2: Create login and logout API routes** - `9128e0b` (feat)
3. **Task 3: Migrate middleware.ts to proxy.ts and add admin route protection** - `81ee52a` (feat)

## Files Created/Modified
- `src/lib/auth/types.ts` - AdminSessionPayload interface
- `src/lib/auth/config.ts` - signToken/verifyToken using jose with HS256
- `src/lib/auth/session.ts` - createAdminSession/getAdminSession/deleteAdminSession with httpOnly cookie
- `src/app/api/auth/login/route.ts` - POST login with Zod validation, bcrypt compare, role check
- `src/app/api/auth/logout/route.ts` - POST logout clearing session cookie
- `src/proxy.ts` - Route protection for /admin/* (redirect) and /api/admin/* (401), security headers preserved
- `.env.example` - Added AUTH_SECRET variable
- `package.json` - Added jose dependency
- `package-lock.json` - Updated lockfile

## Decisions Made
- Used jose directly for JWT instead of NextAuth v5 -- Next.js 16 proxy.ts runs in Edge-like context, jose is Edge-compatible, and direct JWT avoids NextAuth v5 compatibility issues with Next.js 16 breaking changes
- Migrated middleware.ts to proxy.ts per Next.js 16 deprecation (named export `proxy`, not default)
- Generic "Invalid credentials" error message for both wrong email and wrong password to prevent user enumeration (T-03-03)
- /admin redirects to /admin/requests as the default admin landing page
- /admin/login is exempted from auth checks to allow the login page to render

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered

- Pre-existing TypeScript error in `src/lib/admin/queries.ts` (untracked file from another plan) does not affect this plan's files. All auth and proxy files compile cleanly.

## User Setup Required

Users must set `AUTH_SECRET` environment variable (minimum 32 characters) in their `.env` file. See `.env.example` for the template.

## Next Phase Readiness
- Auth foundation complete for admin dashboard
- Login/logout endpoints ready for admin login UI (Plan 03-03)
- proxy.ts route protection active for /api/admin/* routes (Plan 03-02 API routes will be automatically protected)
- AdminSessionPayload available for extracting user context in admin API handlers

## Self-Check: PASSED

All 6 created files verified present. middleware.ts confirmed deleted. All 3 task commits verified in git log.

---
*Phase: 03-admin-dashboard*
*Completed: 2026-05-27*
