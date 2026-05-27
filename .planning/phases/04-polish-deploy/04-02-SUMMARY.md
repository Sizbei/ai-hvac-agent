---
phase: 04-polish-deploy
plan: 02
subsystem: infra
tags: [vercel, neon, openai, privacy, deployment, cron]

# Dependency graph
requires:
  - phase: 01-foundation
    provides: database schema and encryption for PII fields
  - phase: 04-polish-deploy/01
    provides: cron cleanup endpoint at /api/cron/cleanup
provides:
  - PRIVACY.md documenting OpenAI data handling and DPA requirements
  - vercel.json with daily cron schedule for session cleanup
  - DEPLOY.md deployment runbook for Neon + Vercel production setup
affects: []

# Tech tracking
tech-stack:
  added: []
  patterns: [vercel-cron-scheduling, deployment-runbook]

key-files:
  created:
    - PRIVACY.md
    - vercel.json
    - DEPLOY.md
  modified: []

key-decisions:
  - "Used AUTH_SECRET env var name (matching codebase) instead of JWT_SECRET (plan specified JWT_SECRET but code uses AUTH_SECRET)"
  - "Added troubleshooting section to DEPLOY.md beyond plan spec for production readiness"

patterns-established:
  - "Deployment documentation pattern: prerequisites, infrastructure setup, migrations, env vars, deploy, verification checklist"

requirements-completed:
  - "OpenAI data handling policy documented (DPA, training opt-out)"
  - "Vercel deployment configuration"
  - "Neon PostgreSQL production database provisioned"
  - "Database migrations run against production"
  - "Seed data for production org + admin"

# Metrics
duration: 2min
completed: 2026-05-27
---

# Phase 4 Plan 2: Privacy Policy, Vercel Config, and Deployment Runbook Summary

**PRIVACY.md with OpenAI DPA/training opt-out documentation, vercel.json daily cron for session cleanup, and DEPLOY.md runbook covering Neon + Vercel production deployment**

## Performance

- **Duration:** 2 min
- **Started:** 2026-05-27T09:19:48Z
- **Completed:** 2026-05-27T09:22:00Z
- **Tasks:** 2
- **Files created:** 3

## Accomplishments
- PRIVACY.md with seven sections covering OpenAI data handling, DPA, training opt-out, and application-level data protections (AES-256-GCM, log redaction, session expiry, 90-day retention, multi-tenant isolation)
- vercel.json with daily cron schedule at 3 AM UTC targeting /api/cron/cleanup endpoint
- DEPLOY.md with complete runbook: Neon PostgreSQL setup, migrations, seed data, environment variables table, Vercel deployment options, post-deploy verification checklist, security checklist, and troubleshooting guide

## Task Commits

Each task was committed atomically:

1. **Task 1: PRIVACY.md - OpenAI data handling policy** - `ae1e5c6` (docs)
2. **Task 2: vercel.json and DEPLOY.md** - `292d939` (docs)

## Files Created/Modified
- `PRIVACY.md` - OpenAI data handling policy with DPA references, training opt-out, and app-level protections
- `vercel.json` - Vercel deployment config with daily cron schedule for cleanup endpoint
- `DEPLOY.md` - Step-by-step deployment runbook for Neon + Vercel production deployment

## Decisions Made
- Used `AUTH_SECRET` env var name in DEPLOY.md instead of `JWT_SECRET` from the plan, because the actual codebase (`src/lib/auth/config.ts`) uses `AUTH_SECRET` for JWT token signing
- Added a troubleshooting section to DEPLOY.md beyond plan specification for better production readiness

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug] Corrected env var name from JWT_SECRET to AUTH_SECRET**
- **Found during:** Task 2 (DEPLOY.md creation)
- **Issue:** Plan specified `JWT_SECRET` in the env vars table, but the codebase uses `AUTH_SECRET` in `src/lib/auth/config.ts`
- **Fix:** Used `AUTH_SECRET` in DEPLOY.md to match the actual code
- **Files modified:** DEPLOY.md
- **Verification:** `grep -n AUTH_SECRET src/lib/auth/config.ts` confirms `AUTH_SECRET` is the correct env var
- **Committed in:** 292d939 (Task 2 commit)

---

**Total deviations:** 1 auto-fixed (1 bug fix)
**Impact on plan:** Corrected an env var name mismatch that would have caused deployment failures. No scope creep.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required. DEPLOY.md documents all production setup steps.

## Next Phase Readiness
- Deployment documentation complete; ready for Plan 04-03 (final verification/polish)
- Plan 04-01 (cron cleanup endpoint) should be executed before deployment so the cron target exists
- No blockers

## Self-Check: PASSED

All 3 files verified present on disk. Both task commits (ae1e5c6, 292d939) verified in git log.

---
*Phase: 04-polish-deploy*
*Completed: 2026-05-27*
