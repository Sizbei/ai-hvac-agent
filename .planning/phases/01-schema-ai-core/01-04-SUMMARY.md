---
phase: 01-schema-ai-core
plan: 04
subsystem: database
tags: [drizzle, postgresql, migration, seed, bcryptjs, neon]

# Dependency graph
requires:
  - phase: 01-01
    provides: Drizzle schema with 6 tables, enums, and DB connection
provides:
  - Initial migration SQL with all 6 tables, 4 enums, 10 foreign keys, 13 indexes
  - Migration runner script for Neon PostgreSQL
  - Seed script with demo org, admin user, and 3 technicians
  - npm scripts for db:generate, db:migrate, db:seed, db:push, db:studio
affects: [01-03, 01-05, 02-api-routes, 03-dashboard]

# Tech tracking
tech-stack:
  added: [bcryptjs, tsx]
  patterns: [drizzle-kit migration generation, neon-http migrator, idempotent seed with onConflictDoNothing]

key-files:
  created:
    - drizzle/0000_demonic_caretaker.sql
    - drizzle/meta/0000_snapshot.json
    - drizzle/meta/_journal.json
    - src/lib/db/migrate.ts
    - src/lib/db/seed.ts
  modified:
    - package.json
    - package-lock.json

key-decisions:
  - "Used drizzle-kit generate (not hand-written SQL) to ensure migration matches schema exactly"
  - "Well-known UUID 00000000-0000-0000-0000-000000000001 for demo org enables consistent API route references"
  - "bcryptjs with salt rounds 12 for password hashing (dev-only passwords: admin123, tech123)"

patterns-established:
  - "Migration runner: dotenv + neon + drizzle migrator pattern for applying migrations"
  - "Idempotent seeding: onConflictDoNothing on all inserts for safe re-runs"

requirements-completed: [SC-14]

# Metrics
duration: 2min
completed: 2026-05-27
---

# Phase 01 Plan 04: Database Migration + Seed Data Summary

**Drizzle Kit migration with 6 PostgreSQL tables and idempotent seed script for demo HVAC company with bcrypt-hashed users**

## Performance

- **Duration:** 2 min
- **Started:** 2026-05-27T06:14:36Z
- **Completed:** 2026-05-27T06:16:48Z
- **Tasks:** 2
- **Files modified:** 7

## Accomplishments
- Generated initial migration SQL from Drizzle schema with all 4 enums, 6 tables, 10 foreign keys, and 13 indexes
- Created migration runner that connects to Neon PostgreSQL and applies migrations from drizzle/ directory
- Built idempotent seed script that creates Demo HVAC Company org, admin user, and 3 technicians with bcrypt-hashed passwords
- Added 5 npm scripts for database operations (db:generate, db:migrate, db:seed, db:push, db:studio)

## Task Commits

Each task was committed atomically:

1. **Task 1: Generate database migration and create migration runner** - `14b96f3` (feat)
2. **Task 2: Create seed script with demo organization, admin user, and technicians** - `84218f3` (feat)

**Plan metadata:** (pending) (docs: complete plan)

## Files Created/Modified
- `drizzle/0000_demonic_caretaker.sql` - Initial migration SQL with all 6 tables, enums, FKs, and indexes
- `drizzle/meta/0000_snapshot.json` - Drizzle Kit schema snapshot for diffing
- `drizzle/meta/_journal.json` - Drizzle Kit migration journal
- `src/lib/db/migrate.ts` - Migration runner using neon-http migrator with dotenv
- `src/lib/db/seed.ts` - Seed script creating demo org, admin, and 3 technicians
- `package.json` - Added db:generate, db:migrate, db:seed, db:push, db:studio scripts; bcryptjs dependency
- `package-lock.json` - Lock file updated for new dependencies

## Decisions Made
- Used drizzle-kit generate rather than hand-writing SQL to ensure the migration exactly matches the Drizzle schema definition
- Chose well-known UUID (00000000-0000-0000-0000-000000000001) for demo organization so API routes and tests can reference it consistently
- Used bcryptjs (not node:crypto scrypt) for password hashing since bcryptjs is pure JS, works in all environments, and is the standard for password hashing
- Development-only passwords (admin123, tech123) with salt rounds 12 -- production will use NextAuth with proper credential management

## Deviations from Plan

None - plan executed exactly as written.

## Issues Encountered
None

## User Setup Required
None - no external service configuration required. Database migration and seed require DATABASE_URL in .env.local (already configured from Plan 01-01).

## Next Phase Readiness
- Migration SQL ready to apply against any Neon PostgreSQL database via `npm run db:migrate`
- Seed data ready to populate demo environment via `npm run db:seed`
- Demo org UUID (00000000-0000-0000-0000-000000000001) available for API route development in Plan 01-03
- All TypeScript compiles cleanly with zero errors

## Self-Check: PASSED

All created files verified present. All commit hashes verified in git log.

---
*Phase: 01-schema-ai-core*
*Completed: 2026-05-27*
