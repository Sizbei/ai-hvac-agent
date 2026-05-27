---
phase: 04-polish-deploy
plan: 01
subsystem: observability, database
tags: [pino, metrics, cron, session-cleanup, data-retention]

# Dependency graph
requires:
  - phase: 02-ai-chat
    provides: "AI extraction pipeline (extract.ts), logger, database schema"
provides:
  - "AI call metrics tracking (latency, tokens, error rate per extraction)"
  - "Session cleanup cron endpoint with 24h expiry and 90-day purge"
  - "CRON_SECRET env var for endpoint protection"
affects: [deployment, monitoring, infra]

# Tech tracking
tech-stack:
  added: []
  patterns: ["trackAICall wrapper for AI observability", "CRON_SECRET Bearer auth for cron endpoints"]

key-files:
  created:
    - src/lib/ai/metrics.ts
    - src/app/api/cron/cleanup/route.ts
    - src/lib/ai/metrics.test.ts
    - src/app/api/cron/cleanup/cleanup.test.ts
  modified:
    - src/lib/ai/extract.ts
    - .env.example

key-decisions:
  - "Used performance.now() for sub-millisecond latency tracking in metrics"
  - "Structured logging with aiMetrics key for queryable Pino output"
  - "90-day retention: delete messages first then sessions for referential integrity"

patterns-established:
  - "trackAICall pattern: wrap any AI SDK call with metrics/logging"
  - "CRON_SECRET Bearer auth pattern for all cron endpoints"

requirements-completed:
  - "AI metrics tracking (latency, tokens, error rate per call)"
  - "Session cleanup cron (expire sessions, 90-day data retention)"

# Metrics
duration: 3min
completed: 2026-05-27
---

# Phase 4 Plan 1: Metrics & Cleanup Summary

**AI call metrics with Pino structured logging wrapping extract.ts, plus session cleanup cron with 24h expiry and 90-day data purge**

## Performance

- **Duration:** 3 min
- **Started:** 2026-05-27T09:19:35Z
- **Completed:** 2026-05-27T09:22:46Z
- **Tasks:** 2
- **Files modified:** 6

## Accomplishments
- AI metrics module (trackAICall) tracks latency, tokens, and errors for every extraction call with structured Pino logging
- extract.ts wraps generateObject with trackAICall transparently (no external API change)
- Session cleanup cron endpoint at /api/cron/cleanup with CRON_SECRET auth guard
- Cleanup expires chatting/extracting sessions older than 24h and purges all data older than 90 days
- 13 new tests (6 metrics + 7 cleanup) bringing total to 208

## Task Commits

Each task was committed atomically (TDD RED/GREEN):

1. **Task 1: AI metrics module** - `ae1e5c6` (test: RED), `436749e` (feat: GREEN)
2. **Task 2: Session cleanup cron** - `457de3a` (test: RED), `273892b` (feat: GREEN)

## Files Created/Modified
- `src/lib/ai/metrics.ts` - AI call metrics wrapper with latency/token/error tracking
- `src/lib/ai/extract.ts` - Updated to wrap generateObject with trackAICall
- `src/app/api/cron/cleanup/route.ts` - Session cleanup cron endpoint with auth
- `src/lib/ai/metrics.test.ts` - 6 unit tests for trackAICall
- `src/app/api/cron/cleanup/cleanup.test.ts` - 7 unit tests for cleanup endpoint
- `.env.example` - Added CRON_SECRET entry

## Decisions Made
- Used performance.now() for latency tracking (not Date.now()) for sub-millisecond precision
- Structured logging with `aiMetrics` key enables querying metrics via Pino transport filters
- 90-day purge deletes messages before sessions to respect foreign key constraints
- Added CRON_SECRET to .env.example for developer onboarding (Rule 2: missing critical)

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 2 - Missing Critical] Added CRON_SECRET to .env.example**
- **Found during:** Task 2
- **Issue:** Plan specified CRON_SECRET env var but did not include adding it to .env.example
- **Fix:** Added `CRON_SECRET=generate-a-random-secret-for-cron-auth` to .env.example
- **Files modified:** .env.example
- **Verification:** File updated, build passes
- **Committed in:** 273892b (Task 2 GREEN commit)

---

**Total deviations:** 1 auto-fixed (1 missing critical)
**Impact on plan:** Essential for developer onboarding. No scope creep.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required. CRON_SECRET should be set in production environment (Vercel Cron sends this header automatically).

## Next Phase Readiness
- AI metrics tracking active on all extraction calls
- Cleanup endpoint ready for Vercel Cron scheduling (vercel.json cron config)
- Foundation for monitoring dashboard if needed in future

## TDD Gate Compliance

Verified in git log:
- Task 1: `test(04-01)` commit (ae1e5c6 RED) followed by `feat(04-01)` commit (436749e GREEN)
- Task 2: `test(04-01)` commit (457de3a RED) followed by `feat(04-01)` commit (273892b GREEN)

All TDD gates satisfied.

## Self-Check: PASSED

All 5 created/modified files exist on disk. All 4 commit hashes found in git log.

---
*Phase: 04-polish-deploy*
*Completed: 2026-05-27*
