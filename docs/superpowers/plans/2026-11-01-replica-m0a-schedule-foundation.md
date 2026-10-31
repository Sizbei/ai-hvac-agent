# Replica M0a: Schedule Foundation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add `en_route` / `arrived` to the job lifecycle, give every job an `appointments` row (visits, backfilled and kept in step by a database trigger) with per-technician `appointment_assignments`, and let the office record technician time off / on-call / non-job events that every availability path respects.

**Architecture:** The request columns (`scheduled_date`, `arrival_window_start/end`, `assigned_to`, `status`) stay the source of truth for visit #1; two Postgres triggers (INSERT, and UPDATE with a `WHEN` clause) mirror them into `appointments` #1 and its lead assignment, so the 25 existing request-update sites, the FieldPulse/HCP sync, the AI booking path, the calendar and the KPIs are untouched. Visits #2+ are written only by the data layer. The two new enum values are added in their own migration and the ~25 hard-coded status lists move onto shared constants without merging lists that differ today. Shifts are date-bound rows (no RRULE) subtracted in the five availability paths.

**Tech Stack:** Next.js 16 App Router, TypeScript, Drizzle ORM 0.45 on Neon (neon-http, `db.batch()` only), plpgsql triggers, zod, vitest (pure helpers only).

**Spec:** `replica/architecture.md` (Schema decisions 1–2, hard constraints, "M0 Foundation" API table, "The parts that bite" → Races, Status enum readers, Stand-in sessions; build-order item 3) and `replica/schema.sql` section "M0a" (trigger rules, backfill rules). Companion: `replica/review-log.md` (what the critics established), `replica/design/components.md` ("Time-off editor", status token note).

## Global Constraints

- Gates before every commit: `npx tsc --noEmit` → 0; `npx eslint <changed>` → 0 errors; `npx vitest run` → capture the live baseline FIRST and never let the pass count drop. No jsdom/RTL.
- neon-http: no `db.transaction()`; `db.batch([...])` for multi-statement writes. Background work via `after()`.
- Tenancy: `withTenant(table, orgId, ...)`; every body/path id re-read under the org before a write; technician ids re-read as `role = 'technician' AND is_active`.
- Migration conventions (`replica/schema.sql` header): idempotent statements, Drizzle-style names on every index/unique/check/FK, `--> statement-breakpoint`, journal `when` > the previous entry, snapshot copy, `npx drizzle-kit generate` → "No schema changes". Enum values in their own file; nothing in that file uses them.
- Tech-app ownership stays `service_requests.assigned_to = session.userId` in M0a. Assignment rows grant nothing in the tech app.
- Byte-identical rule: an existing status list gets the new values added where they belong and is pointed at the constant whose members equal it; lists that differ today are NOT merged.
- FROZEN: `src/lib/ai` prompt text and `output-guardrail.ts` untouched. Copy canon as in M0b. Audit details ids/enums only.
- Commits end with `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`.
- Read `.claude/skills/page-requests/SKILL.md`, `page-tech/SKILL.md`, `page-staff/SKILL.md`, `page-calendar/SKILL.md` before touching those pages; run `node scripts/agent/verify-skills.mjs` after adding routes.

## Review Focus

1. Reassign A → B → A on one job (three `PATCH`/assign calls) → the lead row ends on A, no unique-key error, exactly one `is_lead` row. (Pinned in Task 3 step 6.)
2. The FieldPulse nightly import re-writes identical values on 1,500 rows → `appointments.version` does not change on any of them. (Pinned in Task 3 step 6.)
3. A membership visit (date only, no window, no tech) → appointment #1 exists with `scheduled_date` set and `starts_at` NULL; it is still listed as unscheduled. (Pinned in Task 3 step 6.)
4. A technician on time off is dragged onto a job in the calendar, or auto-dispatch considers them → the placement is refused (409) and the tech is not a candidate. (Pinned in Task 6 step 7.)
5. A tech taps "En route" → the job stays in their list, the admin sheet shows "En route", the AI account reply says the technician is on the way, the delay sweep still considers the job not started. (Pinned in Tasks 2 and 4.)

---

## File map

| file | responsibility |
| --- | --- |
| `drizzle/0048_request_status_en_route.sql` | the two `ADD VALUE`s, nothing else |
| `drizzle/0049_appointments_shifts.sql` | tables, triggers, backfill |
| `drizzle/meta/_journal.json`, `0048_snapshot.json`, `0049_snapshot.json` | journal + snapshots |
| `src/lib/db/schema.ts` | enum values, `appointments`, `appointmentAssignments`, `shiftKindEnum`, `technicianShifts` |
| `src/lib/admin/request-status.ts` (+ test) | TRANSITIONS edges, MANUAL_TARGET_STATUSES, the six shared constants, coverage test |
| 25 reader files (Task 2 table) | point at constants / add values |
| `src/lib/admin/appointment-queries.ts` (+ test) | list/add/update/cancel visits #2+ with CAS on `version` |
| `src/app/api/admin/requests/[id]/appointments/route.ts`, `…/[aid]/route.ts` | visits API |
| `src/components/admin/request-detail-sheet.tsx` | "Visits" section |
| `src/lib/admin/shift-queries.ts` (+ test) | shifts CRUD + `listCapacityBlocks` |
| `src/app/api/admin/technicians/[id]/shifts/route.ts`, `…/[sid]/route.ts` | shifts API |
| `src/components/admin/staff/time-off-dialog.tsx`, `src/components/admin/staff-table.tsx` | time-off editor on the staff page |
| `src/lib/admin/scheduling-source.ts`, `availability-queries.ts`, `scheduling-queries.ts`, `create-request-queries.ts`, `src/lib/ai/dispatch/signals.ts` | shifts subtracted |
| `src/lib/admin/status-colors.ts`, `src/components/admin/request-filters.tsx`, `src/app/admin/(dashboard)/requests/page.tsx`, `src/components/admin/insights/ops-insights-section.tsx` | UI readers |
| `src/lib/ai/account-reply.ts` | wording for en_route / arrived (NOT prompt text; a deterministic reply helper) |
| `.claude/skills/page-*/SKILL.md`, `replica/features.csv`, `replica/parity.md`, `replica/build-log.md` | docs |

---

### Task 1: Enum migration + status constants + transitions

**Files:**
- Create: `drizzle/0048_request_status_en_route.sql`, `drizzle/meta/0048_snapshot.json`; modify `drizzle/meta/_journal.json`
- Modify: `src/lib/db/schema.ts` (`requestStatusEnum` values), `src/lib/admin/request-status.ts`, `src/lib/admin/request-status.test.ts`

**Interfaces:**
- Produces (all exported from `@/lib/admin/request-status`):
  ```ts
  export const IN_FLIGHT_STATUSES = ["scheduled","assigned","en_route","arrived","in_progress","on_hold"] as const;
  export const OPEN_STATUSES = ["pending","scheduled","assigned","en_route","arrived","in_progress","on_hold"] as const;
  export const ON_SITE_STATUSES = ["arrived","in_progress"] as const;
  export const NOT_STARTED_STATUSES = ["scheduled","assigned","en_route"] as const;
  export const UNASSIGNED_OPEN_STATUSES = ["pending","scheduled"] as const;
  export const NEEDS_PLACEMENT_STATUSES = ["pending","scheduled","assigned","en_route","arrived","in_progress"] as const;
  export const TERMINAL_STATUSES = ["completed","cancelled"] as const;
  export const MANUAL_TARGET_STATUSES = ["scheduled","en_route","arrived","in_progress","on_hold","completed","cancelled"] as const;
  ```

- [ ] **Step 1: Migration 0048**

```sql
-- M0a: two new canonical job statuses for the tech loop. Own file: nothing
-- here USES the values (Postgres forbids using a new enum value in the same
-- transaction; the neon-http migrator autocommits per statement, but keep the
-- rule so a future runner change cannot break it). Precedent: 0001, 0008, 0013.
ALTER TYPE "public"."request_status" ADD VALUE IF NOT EXISTS 'en_route' AFTER 'assigned';
--> statement-breakpoint
ALTER TYPE "public"."request_status" ADD VALUE IF NOT EXISTS 'arrived' AFTER 'en_route';
```
`schema.ts`: `requestStatusEnum` values become `["pending","assigned","en_route","arrived","scheduled","in_progress","on_hold","completed","cancelled"]` — keep the array order equal to the Postgres enum order (`assigned`, then `en_route`, `arrived`, then `scheduled`) so the snapshot matches. Journal entry idx 48 with `when` > 0047's; snapshot via the probe-generate-rename recipe from the M0b plan Task 1 Step 3; `npx drizzle-kit generate` → "No schema changes".

- [ ] **Step 2: Failing tests**

```ts
// append to src/lib/admin/request-status.test.ts (and add 'en_route','arrived' to the vi.mock enumValues)
import { IN_FLIGHT_STATUSES, OPEN_STATUSES, ON_SITE_STATUSES, NOT_STARTED_STATUSES, TERMINAL_STATUSES } from './request-status';

describe('en_route / arrived', () => {
  it('tech taps follow assigned → en_route → arrived → in_progress', () => {
    expect(canTransition('assigned', 'en_route')).toBe(true);
    expect(canTransition('scheduled', 'en_route')).toBe(true);
    expect(canTransition('on_hold', 'en_route')).toBe(true);
    expect(canTransition('en_route', 'arrived')).toBe(true);
    expect(canTransition('en_route', 'in_progress')).toBe(true);
    expect(canTransition('en_route', 'scheduled')).toBe(true);
    expect(canTransition('arrived', 'in_progress')).toBe(true);
    expect(canTransition('arrived', 'completed')).toBe(false);
    expect(canTransition('en_route', 'completed')).toBe(false);
  });
  it('are manual targets', () => {
    expect(MANUAL_TARGET_STATUSES).toContain('en_route');
    expect(MANUAL_TARGET_STATUSES).toContain('arrived');
  });
  it('every enum value is in OPEN or TERMINAL, and the derived lists are subsets', () => {
    const all = ['pending','assigned','en_route','arrived','scheduled','in_progress','on_hold','completed','cancelled'];
    for (const s of all) expect([...OPEN_STATUSES, ...TERMINAL_STATUSES]).toContain(s);
    for (const s of IN_FLIGHT_STATUSES) expect(OPEN_STATUSES).toContain(s);
    for (const s of ON_SITE_STATUSES) expect(IN_FLIGHT_STATUSES).toContain(s);
    for (const s of NOT_STARTED_STATUSES) expect(IN_FLIGHT_STATUSES).toContain(s);
    expect(NOT_STARTED_STATUSES).toContain('en_route');
    expect(ON_SITE_STATUSES).not.toContain('en_route');
  });
});
```

- [ ] **Step 3: Run** — `npx vitest run src/lib/admin/request-status.test.ts` → FAIL (exports missing; TRANSITIONS is `Record<RequestStatus,…>` so tsc also fails until the rows exist).

- [ ] **Step 4: Implement** in `request-status.ts`:

```ts
const TRANSITIONS: Record<RequestStatus, readonly RequestStatus[]> = {
  pending: ["scheduled", "cancelled"],
  scheduled: ["en_route", "in_progress", "on_hold", "cancelled"],
  assigned: ["scheduled", "en_route", "in_progress", "on_hold", "cancelled"],
  // Driving to the site. Can turn back (scheduled), arrive, start, pause, cancel.
  en_route: ["arrived", "in_progress", "scheduled", "on_hold", "cancelled"],
  // On site, not yet working. No arrived → completed: the response-time KPI is
  // anchored on reaching the site, completion still goes through in_progress.
  arrived: ["in_progress", "on_hold", "cancelled"],
  in_progress: ["on_hold", "completed", "cancelled"],
  on_hold: ["en_route", "in_progress", "scheduled", "completed", "cancelled"],
  completed: [],
  cancelled: [],
};

export const MANUAL_TARGET_STATUSES = ["scheduled", "en_route", "arrived", "in_progress", "on_hold", "completed", "cancelled"] as const satisfies readonly RequestStatus[];

// ── Shared status lists (M0a) ────────────────────────────────────────────────
// One place for the lists that used to be hand-written in ~25 readers. Lists
// that differed before (some include `pending`, ops-insights drops
// scheduled/on_hold) keep their own members; nothing is merged.
/** A job somebody is working toward: booked through paused. */
export const IN_FLIGHT_STATUSES = ["scheduled", "assigned", "en_route", "arrived", "in_progress", "on_hold"] as const satisfies readonly RequestStatus[];
/** Non-terminal: IN_FLIGHT plus pending intake. */
export const OPEN_STATUSES = ["pending", ...IN_FLIGHT_STATUSES] as const satisfies readonly RequestStatus[];
/** The technician is physically at the site. */
export const ON_SITE_STATUSES = ["arrived", "in_progress"] as const satisfies readonly RequestStatus[];
/** Not yet on site (the delay sweep's "could still be late"). */
export const NOT_STARTED_STATUSES = ["scheduled", "assigned", "en_route"] as const satisfies readonly RequestStatus[];
/** Open and nobody owns it yet (dashboard "needs attention"). */
export const UNASSIGNED_OPEN_STATUSES = ["pending", "scheduled"] as const satisfies readonly RequestStatus[];
/** Can sit in the unscheduled sidebar when it has no arrival window. */
export const NEEDS_PLACEMENT_STATUSES = ["pending", "scheduled", "assigned", "en_route", "arrived", "in_progress"] as const satisfies readonly RequestStatus[];
export const TERMINAL_STATUSES = ["completed", "cancelled"] as const satisfies readonly RequestStatus[];
```

- [ ] **Step 5: Run** the test file → PASS. `npx tsc --noEmit` now fails in `request-detail-sheet.tsx` (`STATUS_ACTION_LABELS`) — that is Task 2; proceed there before committing, or commit with the labels fix included (preferred: include it here: add `en_route: 'Mark en route', arrived: 'Mark arrived'`).

- [ ] **Step 6: Apply + gates + commit**

Run: `npm run db:migrate` (dev) → ok; `npx drizzle-kit generate` → No schema changes; `npx tsc --noEmit` → 0; vitest ≥ baseline.
```bash
git add drizzle/0048_request_status_en_route.sql drizzle/meta src/lib/db/schema.ts src/lib/admin/request-status.ts src/lib/admin/request-status.test.ts src/components/admin/request-detail-sheet.tsx
git commit -m "feat(status): en_route and arrived job statuses with shared status lists

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 2: Point every status reader at the constants

**Files (each with the exact change):**

| file | today | change |
| --- | --- | --- |
| `src/lib/admin/queries.ts:446` `OPEN_STATUSES` | 5 values | delete the local const; `import { OPEN_STATUSES, UNASSIGNED_OPEN_STATUSES } from "./request-status"`; `TERMINAL_STATUSES` → import too |
| `queries.ts:442` `ASSIGNABLE_STATUSES` | pending/scheduled/assigned | unchanged |
| `queries.ts:465` `REASSIGNABLE_STATUSES` | assigned/in_progress/on_hold | add `"en_route", "arrived"` (the 409 guard is M2) |
| `queries.ts:1073` raw SQL in-progress KPI | `status = 'in_progress'`-style | read it; if it is an "in progress" count keep as is; if it is an "active" list add `'en_route','arrived'` |
| `src/lib/admin/scheduling-queries.ts:67` `ACTIVE_BOOKING_STATUSES` | 5 values | replace with `OPEN_STATUSES` import (same members + the two new) |
| `scheduling-queries.ts:81` `UNSCHEDULED_STATUSES` | 4 values | replace with `NEEDS_PLACEMENT_STATUSES` |
| `scheduling-queries.ts:721` raw SQL guard | `IN ('pending','assigned','scheduled','in_progress','on_hold')` | `IN ('pending','assigned','scheduled','en_route','arrived','in_progress','on_hold')` |
| `src/app/api/tech/jobs/route.ts:19` `ACTIVE_STATUSES` | scheduled/assigned/in_progress/on_hold | `IN_FLIGHT_STATUSES` |
| `src/app/api/admin/dispatch/map/route.ts:22` | same 4 | `IN_FLIGHT_STATUSES` |
| `src/lib/portal/portal-queries.ts:199` `ACTIVE_JOB_STATUSES` | 5 incl. pending | `OPEN_STATUSES` |
| `src/lib/ai/account-tools.ts:85` `UPCOMING_STATUSES` | 5 incl. pending | `OPEN_STATUSES` |
| `src/lib/ai/account-reply.ts:44` `statusLabel` switch | default "being scheduled" | add `case "en_route": return "on the way (your technician is driving to you)"; case "arrived": return "on site (your technician has arrived)";` |
| `src/lib/ai/dispatch/signals.ts:91` `SAME_DAY_LOAD_STATUSES` | 4 | add `"en_route", "arrived"` |
| `src/lib/dispatch/delay-detection.ts:17` `NOT_STARTED_STATUSES` | scheduled/assigned | `NOT_STARTED_STATUSES` import (adds en_route) |
| `src/lib/admin/ops-insights-queries.ts:29` + raw SQL `:83` | pending/assigned/in_progress | add `en_route`, `arrived` to both (same spelling in the SQL literal) |
| `src/lib/admin/operations-metrics-queries.ts:160` | `eq(toStatus, "in_progress")` | `inArray(requestStatusEvents.toStatus, [...ON_SITE_STATUSES])`; the JS reducer that picks the first event per request must take the MIN `at` across both statuses (read the reducer; it groups by request already) |
| `src/lib/admin/status-colors.ts:25,40` | 7 keys | add `en_route: 'bg-info-light text-info-strong border-info-border'`, `arrived: 'bg-success-light text-success-strong border-success-border'`; DOT `en_route: 'bg-info'`, `arrived: 'bg-success'`. Run `npx vitest run src/lib/admin/status-colors-contrast.test.ts`; if `info` tokens are missing from `globals.css` or fail 4.5:1, use the `marker` pair for en_route instead and note it in the commit |
| `src/app/admin/(dashboard)/requests/page.tsx:47` whitelist | 7 | add `'en_route','arrived'` |
| `src/components/admin/request-filters.tsx:35` `STATUS_OPTIONS` | 7 | add `{ label: 'En route', value: 'en_route' }, { label: 'Arrived', value: 'arrived' }` after Assigned |
| `src/components/admin/request-detail-sheet.tsx:56` | 5 labels | done in Task 1 |
| `src/components/admin/insights/ops-insights-section.tsx:45` `STATUS_LABELS` | — | add `en_route: 'En route', arrived: 'Arrived'` |
| `src/lib/integrations/fieldpulse/import/jobs.ts:66` `FP_JOB_STATUS_MAP` | `"2": "assigned"` | `"2": "en_route"`; update the comment block above it (FP stage 2 = "on the way"); the `on_hold` CASE at `:531` stays exactly as is (no preserve for en_route/arrived) |
| `src/app/api/admin/integrations/fieldpulse/webhook/route.ts:94` | en_route/on_site → in_progress | `case "en_route": return "en_route"; case "on_site": return "arrived";` and widen the function's return union |
| `src/lib/integrations/housecall-pro/webhook-events.ts:118` | `job.on_my_way` → in_progress | `case "job.on_my_way": return "en_route";` (keep `job.started` → in_progress); update the doc comment |
| `src/components/tech/tech-job-summary.tsx:29` `humanize` | generic | fine ("En route", "Arrived"); check `isTerminalStatus` and `buildStatusConfirmCopy` tolerate the new values (they key on completed/cancelled) |

- [ ] **Step 1: Grep to confirm the list is complete**

Run: `grep -rnE "\"on_hold\"|'on_hold'" src --include='*.ts' --include='*.tsx' | grep -v '\.test\.' | grep -v 'request-status.ts'`
Expected: every hit is in the table above or is a `hold_reason` / FP-availability / seed-demo context. Add any genuine miss to the table and fix it.

- [ ] **Step 2: Apply the table.** Existing tests that mock `requestStatusEnum.enumValues` (grep `enumValues: \[` in `src --include='*.test.ts'`) need the two new values added to the mock.

- [ ] **Step 3: Tests**

Add to `src/lib/dispatch/delay-detection.test.ts` (exists? if not, create with the same vi.mock pattern as `request-status.test.ts`): an en_route job whose window end has passed is flagged late. Add to `src/lib/integrations/housecall-pro/webhook-events.test.ts` (exists per the module's style; if not, create): `eventTypeToStatus("job.on_my_way") === "en_route"`. Add to the FP import test (`src/lib/integrations/fieldpulse/import/jobs.test.ts` if present) or `jobs-status-map.test.ts`: stage `"2"` → `en_route`.

- [ ] **Step 4: Gates**

Run: `npx tsc --noEmit && npx eslint $(git diff --name-only | tr '\n' ' ') && npx vitest run 2>&1 | tail -3`

- [ ] **Step 5: Probe (Review Focus 5, first half)**

With the dev server running: mint a tech session (read `scripts/agent/mint-admin-session.mjs`; if it cannot mint a technician JWT, use the admin status route instead: `PATCH /api/admin/requests/<id>/status` with `{ "status": "en_route" }` — read `src/app/api/admin/requests/[id]/status/route.ts` for the exact body). Then:
```bash
curl -s -b "hvac_admin_session=$TOKEN" http://localhost:3000/api/admin/requests/<id> | grep -o '"status":"[a-z_]*"'
```
Expected: `en_route`; the requests list filter "En route" shows it; `GET /api/tech/jobs` for the assigned tech still lists it.

- [ ] **Step 6: Commit**

```bash
git add -A src
git commit -m "feat(status): every status reader learns en_route and arrived

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 3: Appointments + assignments + shifts migration with triggers and backfill

**Files:**
- Create: `drizzle/0049_appointments_shifts.sql`, `drizzle/meta/0049_snapshot.json`; modify `_journal.json`
- Modify: `src/lib/db/schema.ts`

**Interfaces:**
- Produces Drizzle tables `appointments`, `appointmentAssignments`, `technicianShifts`; enum `shiftKindEnum` (`on_call | time_off | non_job`).

- [ ] **Step 1: Migration**

```sql
-- M0a schedule foundation: appointments (visits) + per-technician assignments,
-- mirrored from service_requests by trigger, backfilled; technician shifts.
-- Idempotent throughout (see replica/schema.sql header).
CREATE TABLE IF NOT EXISTS "appointments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "service_request_id" uuid NOT NULL,
  "appointment_number" smallint DEFAULT 1 NOT NULL,
  "scheduled_date" timestamp with time zone,
  "starts_at" timestamp with time zone,
  "ends_at" timestamp with time zone,
  "arrival_window_start" timestamp with time zone,
  "arrival_window_end" timestamp with time zone,
  "is_confirmed" boolean DEFAULT false NOT NULL,
  "cancelled_at" timestamp with time zone,
  "special_instructions" text,
  "version" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "appointments_request_number_unique" UNIQUE("service_request_id","appointment_number"),
  CONSTRAINT "appointments_window_check" CHECK ("appointments"."arrival_window_end" IS NULL OR "appointments"."arrival_window_start" IS NULL OR "appointments"."arrival_window_end" > "appointments"."arrival_window_start"),
  CONSTRAINT "appointments_span_check" CHECK ("appointments"."ends_at" IS NULL OR "appointments"."starts_at" IS NULL OR "appointments"."ends_at" >= "appointments"."starts_at")
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "appointments" ADD CONSTRAINT "appointments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "appointments" ADD CONSTRAINT "appointments_service_request_id_service_requests_id_fk" FOREIGN KEY ("service_request_id") REFERENCES "public"."service_requests"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "appointments_org_starts_at_idx" ON "appointments" USING btree ("organization_id","starts_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "appointments_request_idx" ON "appointments" USING btree ("service_request_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "appointment_assignments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "appointment_id" uuid NOT NULL,
  "technician_id" uuid NOT NULL,
  "is_lead" boolean DEFAULT false NOT NULL,
  "status" "request_status" DEFAULT 'assigned' NOT NULL,
  "assigned_by" uuid,
  "assigned_at" timestamp with time zone DEFAULT now() NOT NULL,
  "en_route_at" timestamp with time zone,
  "arrived_at" timestamp with time zone,
  "started_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  CONSTRAINT "appointment_assignments_unique" UNIQUE("appointment_id","technician_id")
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "appointment_assignments" ADD CONSTRAINT "appointment_assignments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "appointment_assignments" ADD CONSTRAINT "appointment_assignments_appointment_id_appointments_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointments"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "appointment_assignments" ADD CONSTRAINT "appointment_assignments_technician_id_users_id_fk" FOREIGN KEY ("technician_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "appointment_assignments" ADD CONSTRAINT "appointment_assignments_assigned_by_users_id_fk" FOREIGN KEY ("assigned_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "appointment_assignments_one_lead_idx" ON "appointment_assignments" USING btree ("appointment_id") WHERE "appointment_assignments"."is_lead" = true;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "appointment_assignments_tech_appt_idx" ON "appointment_assignments" USING btree ("technician_id","appointment_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "appointment_assignments_org_tech_idx" ON "appointment_assignments" USING btree ("organization_id","technician_id");
--> statement-breakpoint
DO $$ BEGIN
  CREATE TYPE "public"."shift_kind" AS ENUM('on_call', 'time_off', 'non_job');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "technician_shifts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "technician_id" uuid NOT NULL,
  "kind" "shift_kind" NOT NULL,
  "title" text,
  "starts_at" timestamp with time zone NOT NULL,
  "ends_at" timestamp with time zone NOT NULL,
  "removes_capacity" boolean DEFAULT true NOT NULL,
  "created_by" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "technician_shifts_order_check" CHECK ("technician_shifts"."ends_at" > "technician_shifts"."starts_at")
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "technician_shifts" ADD CONSTRAINT "technician_shifts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "technician_shifts" ADD CONSTRAINT "technician_shifts_technician_id_users_id_fk" FOREIGN KEY ("technician_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "technician_shifts" ADD CONSTRAINT "technician_shifts_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "technician_shifts_org_tech_starts_idx" ON "technician_shifts" USING btree ("organization_id","technician_id","starts_at");
--> statement-breakpoint
-- Request -> appointment #1 (+ lead assignment). The request columns stay the
-- source of truth for visit #1; this mirrors them. Rules: replica/schema.sql M0a.
CREATE OR REPLACE FUNCTION sync_request_appointment()
RETURNS TRIGGER AS $$
DECLARE
  v_appt_id uuid;
  v_window_end timestamptz;
  v_old_assigned uuid;
BEGIN
  v_old_assigned := CASE WHEN TG_OP = 'UPDATE' THEN OLD.assigned_to ELSE NULL END;

  -- 1. Nothing to mirror: delete #1 when it has no progress, else null its times.
  IF NEW.scheduled_date IS NULL AND NEW.arrival_window_start IS NULL
     AND NEW.arrival_window_end IS NULL AND NEW.assigned_to IS NULL THEN
    SELECT id INTO v_appt_id FROM appointments
      WHERE service_request_id = NEW.id AND appointment_number = 1;
    IF v_appt_id IS NOT NULL THEN
      IF NOT EXISTS (
        SELECT 1 FROM appointment_assignments a
        WHERE a.appointment_id = v_appt_id
          AND (a.en_route_at IS NOT NULL OR a.arrived_at IS NOT NULL
               OR a.started_at IS NOT NULL OR a.completed_at IS NOT NULL)
      ) THEN
        DELETE FROM appointments WHERE id = v_appt_id;
      ELSE
        UPDATE appointments
          SET scheduled_date = NULL, starts_at = NULL, ends_at = NULL,
              arrival_window_start = NULL, arrival_window_end = NULL,
              version = version + 1, updated_at = now()
          WHERE id = v_appt_id;
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  -- A window whose end is not after its start is treated as no end.
  v_window_end := CASE
    WHEN NEW.arrival_window_end IS NOT NULL AND NEW.arrival_window_start IS NOT NULL
         AND NEW.arrival_window_end <= NEW.arrival_window_start THEN NULL
    ELSE NEW.arrival_window_end END;

  -- 2. Upsert visit #1. starts_at/ends_at come from the window ONLY: a
  --    date-only booking keeps starts_at NULL (it is "unscheduled" today).
  INSERT INTO appointments (organization_id, service_request_id, appointment_number,
      scheduled_date, starts_at, ends_at, arrival_window_start, arrival_window_end, cancelled_at)
  VALUES (NEW.organization_id, NEW.id, 1, NEW.scheduled_date,
      NEW.arrival_window_start, v_window_end, NEW.arrival_window_start, v_window_end,
      CASE WHEN NEW.status = 'cancelled' THEN now() ELSE NULL END)
  ON CONFLICT (service_request_id, appointment_number) DO UPDATE SET
      scheduled_date = EXCLUDED.scheduled_date,
      starts_at = EXCLUDED.starts_at,
      ends_at = EXCLUDED.ends_at,
      arrival_window_start = EXCLUDED.arrival_window_start,
      arrival_window_end = EXCLUDED.arrival_window_end,
      cancelled_at = COALESCE(appointments.cancelled_at, EXCLUDED.cancelled_at),
      version = appointments.version + 1,
      updated_at = now()
  RETURNING id INTO v_appt_id;

  -- Cancelling the job cancels every visit (frees the calendar and capacity).
  IF NEW.status = 'cancelled' THEN
    UPDATE appointments SET cancelled_at = COALESCE(cancelled_at, now()),
        version = version + 1, updated_at = now()
      WHERE service_request_id = NEW.id AND cancelled_at IS NULL;
  END IF;

  -- 3. Lead assignment follows assigned_to.
  IF TG_OP = 'INSERT' OR v_old_assigned IS DISTINCT FROM NEW.assigned_to THEN
    -- Old lead (different tech, or no tech now): delete when it never
    -- progressed, otherwise keep it demoted and cancelled (history).
    DELETE FROM appointment_assignments a
      WHERE a.appointment_id = v_appt_id AND a.is_lead
        AND (NEW.assigned_to IS NULL OR a.technician_id <> NEW.assigned_to)
        AND a.en_route_at IS NULL AND a.arrived_at IS NULL
        AND a.started_at IS NULL AND a.completed_at IS NULL;
    UPDATE appointment_assignments a SET is_lead = false, status = 'cancelled'
      WHERE a.appointment_id = v_appt_id AND a.is_lead
        AND (NEW.assigned_to IS NULL OR a.technician_id <> NEW.assigned_to);
    IF NEW.assigned_to IS NOT NULL THEN
      INSERT INTO appointment_assignments (organization_id, appointment_id, technician_id,
          is_lead, status, assigned_at)
      VALUES (NEW.organization_id, v_appt_id, NEW.assigned_to, true, NEW.status, now())
      ON CONFLICT (appointment_id, technician_id) DO UPDATE SET
          is_lead = true, status = EXCLUDED.status;   -- A -> B -> A works
    END IF;
  ELSIF NEW.assigned_to IS NOT NULL THEN
    -- 4. Status mirror for the lead (single-tech jobs stay in step).
    UPDATE appointment_assignments SET status = NEW.status
      WHERE appointment_id = v_appt_id AND technician_id = NEW.assigned_to AND is_lead;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_sync_request_appointment_ins ON service_requests;
--> statement-breakpoint
CREATE TRIGGER trg_sync_request_appointment_ins
  AFTER INSERT ON service_requests
  FOR EACH ROW EXECUTE FUNCTION sync_request_appointment();
--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_sync_request_appointment_upd ON service_requests;
--> statement-breakpoint
-- UPDATE OF fires on unchanged values (the FieldPulse sync rewrites every row
-- nightly), so the WHEN clause limits it to real changes.
CREATE TRIGGER trg_sync_request_appointment_upd
  AFTER UPDATE OF scheduled_date, arrival_window_start, arrival_window_end, assigned_to, status
  ON service_requests
  FOR EACH ROW
  WHEN (OLD.scheduled_date IS DISTINCT FROM NEW.scheduled_date
     OR OLD.arrival_window_start IS DISTINCT FROM NEW.arrival_window_start
     OR OLD.arrival_window_end IS DISTINCT FROM NEW.arrival_window_end
     OR OLD.assigned_to IS DISTINCT FROM NEW.assigned_to
     OR OLD.status IS DISTINCT FROM NEW.status)
  EXECUTE FUNCTION sync_request_appointment();
--> statement-breakpoint
-- Backfill visit #1 for every request that has a date, a window or a tech.
-- Same formulas as the function; idempotent via NOT EXISTS.
INSERT INTO appointments (organization_id, service_request_id, appointment_number,
    scheduled_date, starts_at, ends_at, arrival_window_start, arrival_window_end,
    cancelled_at, created_at)
SELECT r.organization_id, r.id, 1, r.scheduled_date,
    r.arrival_window_start,
    CASE WHEN r.arrival_window_end IS NOT NULL AND r.arrival_window_start IS NOT NULL
              AND r.arrival_window_end <= r.arrival_window_start THEN NULL ELSE r.arrival_window_end END,
    r.arrival_window_start,
    CASE WHEN r.arrival_window_end IS NOT NULL AND r.arrival_window_start IS NOT NULL
              AND r.arrival_window_end <= r.arrival_window_start THEN NULL ELSE r.arrival_window_end END,
    CASE WHEN r.status = 'cancelled' THEN r.updated_at ELSE NULL END,
    r.created_at
FROM service_requests r
WHERE (r.scheduled_date IS NOT NULL OR r.arrival_window_start IS NOT NULL
       OR r.arrival_window_end IS NOT NULL OR r.assigned_to IS NOT NULL)
  AND NOT EXISTS (SELECT 1 FROM appointments a WHERE a.service_request_id = r.id AND a.appointment_number = 1);
--> statement-breakpoint
INSERT INTO appointment_assignments (organization_id, appointment_id, technician_id, is_lead, status, assigned_at)
SELECT r.organization_id, a.id, r.assigned_to, true, r.status, r.updated_at
FROM service_requests r
JOIN appointments a ON a.service_request_id = r.id AND a.appointment_number = 1
WHERE r.assigned_to IS NOT NULL
ON CONFLICT ("appointment_id","technician_id") DO NOTHING;
```

- [ ] **Step 2: `schema.ts` mirror** (place after `serviceRequests`; the trigger is SQL-only):

```ts
export const shiftKindEnum = pgEnum("shift_kind", ["on_call", "time_off", "non_job"]);

// M0a: a visit. #1 is mirrored from the request by trigger (drizzle/0049);
// #2+ are written by appointment-queries.ts only. starts_at/ends_at = the
// arrival window; a date-only booking has scheduled_date and NULL starts_at.
export const appointments = pgTable(
  "appointments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    serviceRequestId: uuid("service_request_id").notNull().references(() => serviceRequests.id, { onDelete: "cascade" }),
    appointmentNumber: smallint("appointment_number").notNull().default(1),
    scheduledDate: timestamp("scheduled_date", { withTimezone: true }),
    startsAt: timestamp("starts_at", { withTimezone: true }),
    endsAt: timestamp("ends_at", { withTimezone: true }),
    arrivalWindowStart: timestamp("arrival_window_start", { withTimezone: true }),
    arrivalWindowEnd: timestamp("arrival_window_end", { withTimezone: true }),
    isConfirmed: boolean("is_confirmed").notNull().default(false),
    cancelledAt: timestamp("cancelled_at", { withTimezone: true }),
    specialInstructions: text("special_instructions"),
    // Optimistic concurrency token (CAS on version, never on updated_at).
    version: integer("version").notNull().default(0),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
    updatedAt: timestamp("updated_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    unique("appointments_request_number_unique").on(table.serviceRequestId, table.appointmentNumber),
    check("appointments_window_check", sql`${table.arrivalWindowEnd} IS NULL OR ${table.arrivalWindowStart} IS NULL OR ${table.arrivalWindowEnd} > ${table.arrivalWindowStart}`),
    check("appointments_span_check", sql`${table.endsAt} IS NULL OR ${table.startsAt} IS NULL OR ${table.endsAt} >= ${table.startsAt}`),
    index("appointments_org_starts_at_idx").on(table.organizationId, table.startsAt),
    index("appointments_request_idx").on(table.serviceRequestId),
  ],
);

// M0a: who is on a visit. One lead per visit; status uses the job enum so
// there is one vocabulary. Progress timestamps are written by M3.
export const appointmentAssignments = pgTable(
  "appointment_assignments",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    appointmentId: uuid("appointment_id").notNull().references(() => appointments.id, { onDelete: "cascade" }),
    technicianId: uuid("technician_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    isLead: boolean("is_lead").notNull().default(false),
    status: requestStatusEnum("status").notNull().default("assigned"),
    assignedBy: uuid("assigned_by").references(() => users.id, { onDelete: "set null" }),
    assignedAt: timestamp("assigned_at", { withTimezone: true }).defaultNow().notNull(),
    enRouteAt: timestamp("en_route_at", { withTimezone: true }),
    arrivedAt: timestamp("arrived_at", { withTimezone: true }),
    startedAt: timestamp("started_at", { withTimezone: true }),
    completedAt: timestamp("completed_at", { withTimezone: true }),
  },
  (table) => [
    unique("appointment_assignments_unique").on(table.appointmentId, table.technicianId),
    uniqueIndex("appointment_assignments_one_lead_idx").on(table.appointmentId).where(sql`${table.isLead} = true`),
    index("appointment_assignments_tech_appt_idx").on(table.technicianId, table.appointmentId),
    index("appointment_assignments_org_tech_idx").on(table.organizationId, table.technicianId),
  ],
);

// M0a: date-bound exceptions to technician_availability (on call, time off,
// non-job events). No RRULE: a repeating absence is N rows.
export const technicianShifts = pgTable(
  "technician_shifts",
  {
    id: uuid("id").defaultRandom().primaryKey(),
    organizationId: uuid("organization_id").notNull().references(() => organizations.id, { onDelete: "cascade" }),
    technicianId: uuid("technician_id").notNull().references(() => users.id, { onDelete: "cascade" }),
    kind: shiftKindEnum("kind").notNull(),
    title: text("title"),
    startsAt: timestamp("starts_at", { withTimezone: true }).notNull(),
    endsAt: timestamp("ends_at", { withTimezone: true }).notNull(),
    removesCapacity: boolean("removes_capacity").notNull().default(true),
    createdBy: uuid("created_by").references(() => users.id, { onDelete: "set null" }),
    createdAt: timestamp("created_at", { withTimezone: true }).defaultNow().notNull(),
  },
  (table) => [
    check("technician_shifts_order_check", sql`${table.endsAt} > ${table.startsAt}`),
    index("technician_shifts_org_tech_starts_idx").on(table.organizationId, table.technicianId, table.startsAt),
  ],
);
```

- [ ] **Step 3: Journal/snapshot** (idx 49; probe-generate-rename as before) → `npx drizzle-kit generate` prints "No schema changes".

- [ ] **Step 4: Pre-flight on dev, then apply twice**

```bash
npx tsx -e 'import {neon} from "@neondatabase/serverless"; import "dotenv/config"; const s=neon(process.env.DATABASE_URL);
console.log("bad windows", await s`select count(*) from service_requests where arrival_window_end <= arrival_window_start`);
console.log("to backfill", await s`select count(*) from service_requests where scheduled_date is not null or arrival_window_start is not null or arrival_window_end is not null or assigned_to is not null`);'
npm run db:migrate && npm run db:migrate
```
(`dotenv/config` reads `.env`; this repo uses `.env.local` — pass `DATABASE_URL` from `.env.local` with `set -a; source .env.local; set +a` first.)
Expected: both runs succeed.

- [ ] **Step 5: Done-when counts**

```sql
select (select count(*) from service_requests where scheduled_date is not null or arrival_window_start is not null or arrival_window_end is not null or assigned_to is not null) as expected,
       (select count(*) from appointments where appointment_number = 1) as actual;
select count(*) from service_requests r join appointments a on a.service_request_id = r.id and a.appointment_number = 1
  where r.assigned_to is not null and not exists (select 1 from appointment_assignments x where x.appointment_id = a.id and x.technician_id = r.assigned_to and x.is_lead);
select count(*) from appointments a group by a.id having count(*) filter (where true) > 1;  -- sanity: 0 rows
```
Expected: `expected = actual`; second count `0`.

- [ ] **Step 6: Trigger behaviour probes (Review Focus 1–3)** — run as SQL against dev with a throwaway request row (insert one via `POST /api/admin/requests` or the seed), then:

```sql
-- (1) A -> B -> A: three updates; expect one lead row on A, no error.
update service_requests set assigned_to = '<techA>' where id = '<rid>';
update service_requests set assigned_to = '<techB>' where id = '<rid>';
update service_requests set assigned_to = '<techA>' where id = '<rid>';
select technician_id, is_lead, status from appointment_assignments where appointment_id = (select id from appointments where service_request_id='<rid>' and appointment_number=1);
-- (2) identical rewrite: version unchanged
select version from appointments where service_request_id='<rid>' and appointment_number=1;
update service_requests set assigned_to = assigned_to, status = status, scheduled_date = scheduled_date, updated_at = now() where id = '<rid>';
select version from appointments where service_request_id='<rid>' and appointment_number=1;  -- same number
-- (3) date-only: starts_at null, scheduled_date set
update service_requests set arrival_window_start = null, arrival_window_end = null, scheduled_date = now() + interval '3 days' where id = '<rid>';
select scheduled_date, starts_at from appointments where service_request_id='<rid>' and appointment_number=1;
-- unschedule: row deleted
update service_requests set scheduled_date = null, assigned_to = null where id = '<rid>';
select count(*) from appointments where service_request_id='<rid>';  -- 0
-- cancel cascades
```
Record the outputs in the commit body. Then delete the throwaway request.

- [ ] **Step 7: Before/after check for the calendar, dispatch and tech app**

Before applying 0049 (i.e. do this step's "before" capture right after Task 2's commit), capture: `curl -s …/api/admin/calendar?date=<today>` and `…/api/admin/dispatch/board?date=<today>` (read the real query params in their routes) to files in the scratchpad; after 0049, capture again and `diff`. Expected: no diff.

- [ ] **Step 8: Gates + commit**

```bash
git add drizzle/0049_appointments_shifts.sql drizzle/meta src/lib/db/schema.ts
git commit -m "feat(db): appointments, assignments and shifts; visit #1 mirrored by trigger and backfilled

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 4: Tech taps en route / arrived (and the admin sheet)

**Files:**
- Modify: `src/app/api/tech/jobs/[id]/status/route.ts` (no change needed if `MANUAL_TARGET_STATUSES` already drives the zod enum — verify; the ownership check stays `assignedTo = userId`)
- Modify: `src/components/tech/tech-job-summary.tsx` (button labels: `en_route` → "On my way", `arrived` → "I've arrived"; keep `humanize` as the fallback; read `buildStatusConfirmCopy` and `isTerminalStatus` to make sure the two new values are non-terminal and need no confirm)
- Modify: `src/lib/tech/field-queries.ts` only if `allowedNextStatuses` is computed there from `allowedTransitions` (it should already pick up the new edges).

- [ ] **Step 1:** Extract the label map as a pure function `techStatusLabel(status: string): string` in `src/components/tech/tech-status-copy.ts` (no React), with a vitest file asserting `en_route → "On my way"`, `arrived → "I've arrived"`, `in_progress → "Start work"` (keep whatever labels exist today for the others; read `buildStatusConfirmCopy` first and put both helpers in the same module if they already live outside the component).
- [ ] **Step 2:** Probe with a technician session: the `page-tech` skill documents how to mint one (`mint-admin-session.mjs` with role technician, or the tech sign-in route). Tap sequence via curl: `POST /api/tech/jobs/<id>/status {"status":"en_route"}` → 200; `{"status":"arrived"}` → 200; `{"status":"completed"}` → 409 `INVALID_TRANSITION`; `{"status":"in_progress"}` → 200. `GET /api/tech/jobs` lists the job at every step (Review Focus 5). Screenshot `/tech/jobs/<id>` at 390 after the en_route tap and look at it.
- [ ] **Step 3: Gates + commit**

```bash
git add src/components/tech src/app/api/tech src/lib/tech
git commit -m "feat(tech): on my way and arrived taps

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 5: Visits #2+ — queries, API, detail sheet

**Files:**
- Create: `src/lib/admin/appointment-queries.ts`, `src/lib/admin/appointment-queries.test.ts`
- Create: `src/app/api/admin/requests/[id]/appointments/route.ts` (GET, POST), `…/appointments/[aid]/route.ts` (PATCH, DELETE = cancel)
- Modify: `src/components/admin/request-detail-sheet.tsx` ("Visits" section)

**Interfaces:**
- Produces:
  ```ts
  export interface AppointmentRecord { id: string; serviceRequestId: string; appointmentNumber: number; scheduledDate: string | null; startsAt: string | null; endsAt: string | null; arrivalWindowStart: string | null; arrivalWindowEnd: string | null; isConfirmed: boolean; cancelledAt: string | null; specialInstructions: string | null; version: number; assignments: readonly { technicianId: string; technicianName: string; isLead: boolean; status: string }[] }
  export const appointmentInputSchema  // arrivalWindowStart ISO, arrivalWindowEnd ISO > start, technicianIds uuid[] (≤5, first is lead), specialInstructions ≤1000
  export function listAppointments(organizationId, requestId): Promise<readonly AppointmentRecord[]>
  export function addAppointment(organizationId, requestId, input, actorUserId): Promise<AppointmentRecord | { reason: "request_not_found" | "technician_not_found" }>
  export function updateAppointment(organizationId, requestId, appointmentId, input & { version: number }, actorUserId): Promise<AppointmentRecord | { reason: "not_found" | "version_conflict" | "is_first_visit" | "technician_not_found" }>
  export function cancelAppointment(organizationId, requestId, appointmentId, version): Promise<{ ok: true } | { reason: "not_found" | "version_conflict" | "is_first_visit" }>
  export function nextAppointmentNumber(existing: readonly { appointmentNumber: number }[]): number  // pure: max + 1, min 2
  export function windowIsValid(start: string, end: string): boolean  // pure
  ```
- Visit #1 is read-only through this API (`is_first_visit` → 409 "Edit the first visit from the job itself."): it is owned by the request columns.

- [ ] **Step 1: Failing tests (pure)** for `nextAppointmentNumber` ([] → 2; [{1},{2}] → 3) and `windowIsValid` (end ≤ start false; both ISO true) and `appointmentInputSchema` (rejects >5 technicians, rejects end before start).

- [ ] **Step 2: Implement.** `addAppointment`: verify request in org; verify every technician id (`role='technician' AND is_active`, `withTenant(users, …)`); compute number from a `select appointmentNumber` of existing rows; `db.batch([insert appointments (startsAt = window start, endsAt = window end, arrivalWindow* = window), insert appointmentAssignments (first id is_lead true, status 'assigned', assigned_by actor)])`, then read back. `updateAppointment`: `update appointments set … , version = version + 1 where id and organization_id and version = $version and appointment_number > 1` → 0 rows → re-read: missing → not_found, number = 1 → is_first_visit, else version_conflict; then replace assignments in a batch (delete all for the appointment + insert). `cancelAppointment`: same CAS, sets `cancelledAt = now()`.

- [ ] **Step 3: Routes** in the Task-3 (M0b) shape; `PATCH` body includes `version`; map reasons: `version_conflict` → 409 `VERSION_CONFLICT` "This visit changed. Reload and try again."; `is_first_visit` → 409; `technician_not_found` → 400. Audit `add_appointment` / `update_appointment` / `cancel_appointment`, entity `appointments`, details `{ serviceRequestId, appointmentNumber, technicianIds }`.

- [ ] **Step 4: Detail sheet**: a "Visits" `SectionCard` listing `listAppointments` rows: "#n · <date> <window> · <tech names> · Confirmed/Cancelled", visit #1 flagged "(from the job)"; "Add visit" button → small dialog: day + window (reuse the dialog's day/window chips from `request-create-dialog.tsx` by extracting them into `src/components/admin/window-picker.tsx` if they are not already shared) + technician multi-select; cancel action per visit #2+ with `ConfirmDialog`.

- [ ] **Step 5: Probe**

```bash
curl -s -b "hvac_admin_session=$TOKEN" -H 'content-type: application/json' -X POST http://localhost:3000/api/admin/requests/<rid>/appointments -d '{"arrivalWindowStart":"2026-11-10T13:00:00Z","arrivalWindowEnd":"2026-11-10T17:00:00Z","technicianIds":["<techA>"]}'
curl -s -b "hvac_admin_session=$TOKEN" http://localhost:3000/api/admin/requests/<rid>/appointments
# cancel the job → both visits cancelled
curl -s -b "hvac_admin_session=$TOKEN" -H 'content-type: application/json' -X PATCH http://localhost:3000/api/admin/requests/<rid>/status -d '{"status":"cancelled"}'
curl -s -b "hvac_admin_session=$TOKEN" http://localhost:3000/api/admin/requests/<rid>/appointments | grep -o '"cancelledAt":"[^"]*"' | wc -l   # 2
```
Screenshot the detail sheet with two visits at 1440.

- [ ] **Step 6: Gates + commit**

```bash
git add src/lib/admin/appointment-queries.ts src/lib/admin/appointment-queries.test.ts 'src/app/api/admin/requests/[id]/appointments' src/components/admin/request-detail-sheet.tsx src/components/admin/window-picker.tsx
git commit -m "feat(requests): additional visits with per-technician assignments

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 6: Shifts — queries, API, staff UI, and the five availability paths

**Files:**
- Create: `src/lib/admin/shift-queries.ts`, `src/lib/admin/shift-queries.test.ts`
- Create: `src/app/api/admin/technicians/[id]/shifts/route.ts` (GET `?from=&to=`, POST), `…/shifts/[sid]/route.ts` (DELETE)
- Create: `src/components/admin/staff/time-off-dialog.tsx`; modify `src/components/admin/staff-table.tsx` (row action "Time off" for technician rows)
- Modify: `src/lib/admin/scheduling-source.ts` (interface + DB impl `getCapacityBlocks`), `src/lib/admin/availability-queries.ts` (`readSchedulingFacts` concatenates blocks into `jobs`), `src/lib/admin/scheduling-queries.ts` (`checkScheduleConflict` + the raw guard in `placeAndAssignRequest`), `src/lib/admin/create-request-queries.ts` (`technicianWindowClash` — read it; if it calls `checkScheduleConflict` nothing changes), `src/lib/ai/dispatch/signals.ts` (hard-exclude candidates with an overlapping capacity-removing shift)

**Interfaces:**
- Produces:
  ```ts
  export type ShiftKind = "on_call" | "time_off" | "non_job";
  export interface ShiftRecord { id: string; technicianId: string; kind: ShiftKind; title: string | null; startsAt: string; endsAt: string; removesCapacity: boolean }
  export const shiftInputSchema  // kind enum, title? ≤80, startsAt ISO, endsAt ISO > startsAt, ≤ 31 days long, removesCapacity? (default: kind !== "on_call")
  export function defaultRemovesCapacity(kind: ShiftKind): boolean  // pure: on_call → false
  export function listShifts(organizationId, technicianId, fromIso, toIso): Promise<readonly ShiftRecord[]>
  export function createShift(organizationId, technicianId, input, createdBy): Promise<ShiftRecord | { reason: "technician_not_found" }>
  export function deleteShift(organizationId, technicianId, shiftId): Promise<boolean>
  export function listCapacityBlocks(organizationId, startIso, endIso): Promise<readonly ScheduledJob[]>  // removes_capacity rows as ScheduledJob { id: shift.id, referenceNumber: "TIME-OFF", status: "assigned", assignedTo: technicianId, arrivalWindowStart: startsAt, arrivalWindowEnd: endsAt }
  export function shiftOverlapSql(organizationId: string, technicianId: SQL | string, startIso: Date, endIso: Date): SQL  // `NOT EXISTS (… technician_shifts … removes_capacity AND starts_at < end AND ends_at > start)`
  ```
- `SchedulingSource` gains `getCapacityBlocks(startIso, endIso): Promise<readonly ScheduledJob[]>`; `DbSchedulingSource` returns `listCapacityBlocks`; the HCP source returns `[]` (HCP tech ids are not `users.id`).

- [ ] **Step 1: Failing tests** for `defaultRemovesCapacity`, `shiftInputSchema` (end before start rejected; 32-day shift rejected; on_call default false), and a pure `blocksToScheduledJobs(rows)` mapper.

- [ ] **Step 2: Implement queries + routes** (routes: verify `[id]` is an active technician in the org as `reassignTechnician` does at `queries.ts:616-630`; audit `create_shift` / `delete_shift`, entity `technician_shifts`, details `{ technicianId, kind, removesCapacity }`). A date-range POST (`days` ≥ 2) creates one row per business day: the dialog sends one request per day; the API stays single-row.

- [ ] **Step 3: Five subtraction points**
  1. `availability-queries.ts` `readSchedulingFacts`: `const [activeTechIds, availability, jobs, blocks] = await Promise.all([…, source.getCapacityBlocks(rangeStartIso, rangeEndIso)]); return { …, jobs: [...jobs, ...blocks] }`.
  2. `scheduling-queries.ts` `checkScheduleConflict`: after `rows`, also `select` overlapping `technicianShifts` for the tech with `removesCapacity = true` and append them mapped as `ScheduledJob` with `referenceNumber: "Time off"` (or the shift title). Callers surface `referenceNumber` in the 409 copy, so a clash reads "Conflicts with Time off".
  3. `placeAndAssignRequest` guard (`:715-726`): add `AND NOT EXISTS (SELECT 1 FROM technician_shifts s WHERE s.organization_id = ${organizationId} AND s.technician_id = ${targetTech} AND s.removes_capacity AND s.starts_at < ${arrivalWindow.end} AND s.ends_at > ${arrivalWindow.start})` inside the same `sql` fragment, so an override-less placement onto PTO lands 0 rows and returns the existing conflict result.
  4. `create-request-queries.ts` `technicianWindowClash`: read it; if it delegates to `checkScheduleConflict`, done; otherwise add the same shift query.
  5. `signals.ts`: next to the `technicianAvailability` read (`:346-356`), read `technicianShifts` for `ids` overlapping the candidate window with `removesCapacity`, and drop those technicians from the candidate set before scoring (a hard filter; log the exclusion reason as `"time_off"` in the existing decision telemetry if the structure has a reasons list — read `src/lib/ai/dispatch/` first).

- [ ] **Step 4: Staff UI** (`replica/design/components.md` "Time-off editor"): on the staff table's technician rows, a "Time off" action opens `TimeOffDialog`: kind (segmented: Time off / On call / Non-job event), title, start date + time, end date + time, "Removes capacity" switch (default from `defaultRemovesCapacity`), and a list of the technician's upcoming shifts with a remove button. Multi-day: when the end date is a later day than the start, send one POST per day using the same clock times.

- [ ] **Step 5: Tests for the subtraction**: `src/lib/admin/availability.test.ts` already tests `computeOpenWindows` with jobs; add a case: a block (`ScheduledJob` from a shift) covering a tech's morning band removes that tech's morning capacity (same assertion style as the existing job-overlap tests).

- [ ] **Step 6: Probe (Review Focus 4)**

```bash
# time off for tech A tomorrow 08:00–17:00 Eastern (adjust the ISO instants)
curl -s -b "hvac_admin_session=$TOKEN" -H 'content-type: application/json' -X POST http://localhost:3000/api/admin/technicians/<techA>/shifts -d '{"kind":"time_off","title":"PTO","startsAt":"2026-11-03T13:00:00Z","endsAt":"2026-11-03T22:00:00Z"}'
# availability for that day drops by one tech per band
curl -s -b "hvac_admin_session=$TOKEN" "http://localhost:3000/api/admin/requests/availability?start=2026-11-03&days=1"
# office booking assigned to tech A in the morning → 409 conflict naming Time off
curl -s -b "hvac_admin_session=$TOKEN" -H 'content-type: application/json' -X POST http://localhost:3000/api/admin/requests -d '{"customerId":"<cid>","address":"1 Main St","description":"test","issueType":"maintenance","urgency":"low","schedule":{"isoDay":"2026-11-03","window":"morning","technicianId":"<techA>"}}'
```
Expected: 201; the morning count is one lower than yesterday's; 409 `SCHEDULE_CONFLICT` (or the slice's existing code) whose message names the time off. Then delete the shift and the test request.

- [ ] **Step 7: Gates + commit**

```bash
git add src/lib/admin/shift-queries.ts src/lib/admin/shift-queries.test.ts 'src/app/api/admin/technicians/[id]/shifts' src/components/admin/staff src/components/admin/staff-table.tsx src/lib/admin/scheduling-source.ts src/lib/admin/availability-queries.ts src/lib/admin/availability.test.ts src/lib/admin/scheduling-queries.ts src/lib/admin/create-request-queries.ts src/lib/ai/dispatch/signals.ts
git commit -m "feat(scheduling): technician time off, on call and non-job events remove capacity everywhere

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>"
```

---

### Task 7: Docs, skills, parity

- [ ] Update `.claude/skills/page-requests/SKILL.md` (visits API, new statuses), `page-tech/SKILL.md` (taps), `page-staff/SKILL.md` (time off), `page-calendar/SKILL.md` (shifts subtracted; visits #2+ not rendered until M2), `admin-pages/SKILL.md` (status constants live in `request-status.ts`). `node scripts/agent/verify-skills.mjs` → 0 missing.
- [ ] `replica/features.csv`: flip 117 ("En route / arrived / working statuses") → yes; 64 ("Multi-visit and multi-day jobs") → partial, note "visits via API + detail sheet; calendar rendering is M2"; 85 ("Technician shifts…") → yes; 86 ("Non-job events…") → yes; 98 ("Multi-technician…") → partial, note "assignment rows; UI + guard in M2". Regenerate `replica/parity.md`. Append `replica/build-log.md` lines for S08 (visits), S13 (shifts), S38 (taps).
- [ ] Commit: `docs(replica): M0a in page skills, feature matrix and build log`.

---

## Self-review notes

- Spec coverage: enum + readers (Tasks 1–2), appointments/assignments/trigger/backfill (3), taps (4), visits API + sheet (5), shifts + five paths (6), docs (7). Ownership unchanged (spec). En-route texts: out of scope (spec). Calendar rendering of visits #2+: M2 (spec).
- Type consistency: `ScheduledJob` is the existing type in `src/lib/admin/types.ts:262`; `AppointmentRecord`, `ShiftRecord`, the six constants are defined once and consumed by name.
- Review Focus pins: 1–3 → Task 3 step 6; 4 → Task 6 step 6; 5 → Task 2 step 5 + Task 4 step 2.
