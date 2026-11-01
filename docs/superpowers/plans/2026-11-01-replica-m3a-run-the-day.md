# Replica M3a: Run the Day Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Prerequisite:** M0a merged (`drizzle/0049_appointments_shifts.sql`, `appointment_assignments` with per-tech `status` + four `*_at` columns, `technician_shifts`; HEAD ≥ `41ff718`).

**Goal:** A technician runs a native job from the phone with per-technician progress: en route → arrived → working → pause / hold with reason → done per technician → close-out that completes the request once every technician is done; job time is tracked automatically from those taps, a general clock exists, and the tech's list shows today / upcoming / past visits.

**Architecture:** Ownership moves from `service_requests.assigned_to = me` to assignment rows: any assignment on a non-cancelled visit grants read access; a tech writes only their own assignment row; only the **active lead** (the `is_lead` row on the earliest non-cancelled visit that still has an open assignment) changes the request status. Each tap is one `db.batch` (assignment CAS + optional request status update + auto time entry). Close-out is one guarded UPDATE. The 0049 trigger is replaced in place so it mirrors request status onto the lead row only until that row has a progress timestamp, keeps a demoted lead's `completed`, and cancels open assignments on every visit when the request is cancelled. M3a is native-jobs-only (`fieldpulse_job_id IS NULL AND hcp_job_id IS NULL`).

**Tech Stack:** Next.js 16, TypeScript, Drizzle 0.45.2 on Neon (neon-http, `db.batch()`), plpgsql, zod 4, vitest (pure helpers, mocked `@/lib/db`), Tailwind + `src/components/ui/*`.

**Spec:** `replica/architecture.md` ("### F04 Tech loop (M3a–M3d)": ownership rule, action → enum mapping, trigger change, route table, deferred list; build-order item 4 "M3a Run the day" with its done-when) and `replica/schema.sql` section "M3a". Companion: `replica/review-log.md` "Spec round 3", `replica/design/components.md` ("Close-out sheet", "Status bar with time-in-status").

## Global Constraints

All of the M0b/M0a Global Constraints apply (gates tsc 0 / eslint 0 errors / `npx vitest run` never below the live baseline — 4562 passed, 1 skipped on `41ff718`; mocked pure tests; `isUniqueViolation` from `@/lib/db/unique-violation`; `readJsonBody`; `withTenant` variadic; audit details ids/enums only; copy canon: "request", "technician", sentence case, "Couldn't … Please try again.", never `err.message`; migration conventions + the six-step drizzle recipe; DB probes via a temporary `probe.mts` at the repo root with `config({ path: ".env.local" })`; explicit `git add`; attribution `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`; skills `page-tech`, `page-staff`, `page-requests`, `admin-pages` read before editing those pages; `node scripts/agent/verify-skills.mjs` → 0 missing). Plus:

- **Native jobs only.** Every M3a tech write refuses a request with `fieldpulse_job_id IS NOT NULL OR hcp_job_id IS NOT NULL` → 409 `MANAGED_EXTERNALLY` "This job is managed in FieldPulse." Reads still work.
- **Tech targets** are exactly `en_route`, `arrived`, `in_progress`, `on_hold`, `completed` plus the actions `pause` and `close_out`. `cancelled` and `scheduled` are never accepted from a tech (400).
- **Helpers never change request status** and never produce a `request_status_events` row. Only the active lead does, through `updateRequestStatus` (actor type `human`, actorId = tech).
- **Replay safety without keys:** an action whose target equals the assignment's current status is a 200 no-op; `close_out` on a request already `completed` is a 200 no-op; neither fires side effects.
- **One batch per tap**, statement order: assignment CAS first, then the request update (so the trigger sees the progress timestamp and does not mirror), then the time-entry statement.
- **Tech sessions:** `TECH=$(npx tsx scripts/agent/mint-tech-session.mjs)` signs the FIRST active technician of the default org (no arguments); for a second technician, set the env var the script honours if it has one, otherwise create a test session the same way the script does (read it). Admin: `TOKEN=$(npx tsx scripts/agent/mint-admin-session.mjs)`. Dev server on `http://localhost:3000`.
- Two-technician visits can only exist on visits #2+ until M2 (visit #1's crew is the request's `assigned_to`); seed multi-tech scenarios by adding a visit #2 through `POST /api/admin/requests/[id]/appointments` with two technician ids.

## Review Focus

1. A helper on visit #2 sends `{ action: "close_out" }` or `{ action: "completed" }` → the request status does not change; the helper's own row becomes `completed` on `completed`; `close_out` → 403 `NOT_LEAD`. (Task 3 probes.)
2. The lead taps `close_out` while a helper is still `in_progress` → 409 with `blockers: [{ kind: "technician_open", technicianName }]`, no status event, no review request; after the helper's `completed`, `close_out` → 200 once; a second `close_out` → 200 no-op with no second review request. (Task 3 probes.)
3. Admin cancels the request while two technicians have open assignments on visit #2 → both rows become `cancelled`; the tech list no longer shows the visit under "today". (Task 1 probe.)
4. A general clock-in sent twice → one open entry; closing it writes `minutes` but `laborCostCents` NULL; the on-site KPI and the labor export ignore it. (Task 5 tests + probe.)
5. The office `updateAppointment` on a visit whose assignment has `started_at` → 409 `HAS_PROGRESS`. (Task 9 test + probe.)

---

## File map

| file | responsibility |
| --- | --- |
| `drizzle/0050_m3a_run_the_day.sql` (+ journal, snapshot) | time-entry columns/checks/index; trigger function v2 |
| `src/lib/db/schema.ts` | `technicianTimeEntries.kind/appointmentId/clockInMethod`, nullable `serviceRequestId`, checks, partial index |
| `src/lib/tech/ownership.ts` (+ test) | `pickActiveAssignment` (pure), `findTechAssignments`, `findReadableJob`, `findActiveLead` |
| `src/lib/tech/field-queries.ts`, `timesheet-queries.ts`, `location-queries.ts`, `src/app/api/tech/jobs/route.ts`, `…/[id]/status/route.ts` | the seven ownership sites moved to the helper |
| `src/lib/tech/status-actions.ts` (+ test) | pure action resolution: `TECH_ACTIONS`, `resolveTechAction` |
| `src/lib/tech/status-writes.ts` | `applyTechAction` (batch), `closeOutRequest` (guarded update + blockers) |
| `src/app/api/tech/jobs/[id]/status/route.ts` | new body, errors, review once |
| `src/lib/tech/timesheet-queries.ts` (+ test) | auto entries (`clockInMethod: 'auto'`, `appointmentId`), `openGeneralEntry`/`closeGeneralEntry` |
| `src/app/api/tech/time/route.ts` | general clock |
| `src/lib/admin/operations-metrics-queries.ts`, `accounting-export.ts`, `reporting-queries.ts` (+ tests) | `kind = 'job'` filters |
| `src/app/api/tech/jobs/route.ts`, `src/components/tech/tech-jobs-list-client.tsx` | `?range=`, tabs, clock button |
| `src/lib/tech/field-queries.ts` `getTechJobSummary`, `src/components/tech/tech-job-summary.tsx`, `src/components/tech/close-out-sheet.tsx` | actions, blockers, synced notice, close-out sheet |
| `src/app/api/admin/timesheets/route.ts`, `src/components/admin/staff/timesheets-dialog.tsx`, `staff-table.tsx` | minimal S25 |
| `src/lib/admin/appointment-queries.ts` (+ test) | `HAS_PROGRESS` guard |
| skills, `replica/features.csv`, `parity.md`, `build-log.md` | docs |

---

### Task 1: Migration 0050 — time-entry columns + trigger v2

**Files:**
- Modify: `src/lib/db/schema.ts` (`technicianTimeEntries`)
- Create via the drizzle recipe (`--name m3a_run_the_day`): `drizzle/0050_m3a_run_the_day.sql`, `drizzle/meta/0050_snapshot.json`; modify `_journal.json`

**Interfaces:** `technicianTimeEntries.kind: "job" | "general"` (default `"job"`), `appointmentId: uuid | null`, `clockInMethod: "auto" | "manual"` (default `"manual"`), `serviceRequestId` nullable; new constraints `tte_kind_check`, `tte_clock_in_method_check`, `tte_kind_request_check`, partial unique `tte_open_general_per_tech_idx`. Trigger function `sync_request_appointment` v2 (same trigger names).

- [ ] **Step 1: `schema.ts`** — in `technicianTimeEntries`: make `serviceRequestId` nullable (drop `.notNull()`), add
```ts
    // M3a: 'job' entries belong to a request (and optionally a visit); 'general'
    // entries are a tech's clock with no job. A job entry opened by a status tap
    // has clockInMethod 'auto'.
    kind: text("kind").notNull().default("job"),
    appointmentId: uuid("appointment_id").references(() => appointments.id, { onDelete: "set null" }),
    clockInMethod: text("clock_in_method").notNull().default("manual"),
```
and to the table extras:
```ts
    check("tte_kind_check", sql`${table.kind} IN ('job','general')`),
    check("tte_clock_in_method_check", sql`${table.clockInMethod} IN ('auto','manual')`),
    check("tte_kind_request_check", sql`(${table.kind} = 'job') = (${table.serviceRequestId} IS NOT NULL)`),
    uniqueIndex("tte_open_general_per_tech_idx").on(table.organizationId, table.technicianId).where(sql`${table.kind} = 'general' AND ${table.clockOutAt} IS NULL`),
```
(`appointments` is declared after `technicianTimeEntries` in the file; the thunk is fine.)

- [ ] **Step 2: Generate** (`npx drizzle-kit generate --name m3a_run_the_day`), compare objects, then overwrite the SQL with:

```sql
-- M3a run the day: general time entries + visit link, and trigger v2 so the
-- tech app owns a lead row once it has progress. Idempotent throughout.
ALTER TABLE "technician_time_entries" ALTER COLUMN "service_request_id" DROP NOT NULL;
--> statement-breakpoint
ALTER TABLE "technician_time_entries" ADD COLUMN IF NOT EXISTS "kind" text DEFAULT 'job' NOT NULL;
--> statement-breakpoint
ALTER TABLE "technician_time_entries" ADD COLUMN IF NOT EXISTS "appointment_id" uuid;
--> statement-breakpoint
ALTER TABLE "technician_time_entries" ADD COLUMN IF NOT EXISTS "clock_in_method" text DEFAULT 'manual' NOT NULL;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "technician_time_entries" ADD CONSTRAINT "technician_time_entries_appointment_id_appointments_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointments"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "technician_time_entries" ADD CONSTRAINT "tte_kind_check" CHECK ("technician_time_entries"."kind" IN ('job','general'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "technician_time_entries" ADD CONSTRAINT "tte_clock_in_method_check" CHECK ("technician_time_entries"."clock_in_method" IN ('auto','manual'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "technician_time_entries" ADD CONSTRAINT "tte_kind_request_check" CHECK (("technician_time_entries"."kind" = 'job') = ("technician_time_entries"."service_request_id" IS NOT NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "tte_open_general_per_tech_idx" ON "technician_time_entries" USING btree ("organization_id","technician_id") WHERE "technician_time_entries"."kind" = 'general' AND "technician_time_entries"."clock_out_at" IS NULL;
--> statement-breakpoint
-- Trigger v2 (same trigger names; CREATE OR REPLACE swaps the body):
--   (a) step 4 mirrors request status onto the lead row ONLY while that row
--       has no progress timestamp;
--   (b) a demoted lead keeps 'completed' instead of becoming 'cancelled';
--   (c) request cancelled -> every open assignment on every visit of the
--       request becomes 'cancelled';
--   (d) request completed -> assignments untouched.
CREATE OR REPLACE FUNCTION sync_request_appointment()
RETURNS TRIGGER AS $$
DECLARE
  v_appt_id uuid;
  v_window_end timestamptz;
  v_old_assigned uuid;
  v_has_progress boolean;
BEGIN
  v_old_assigned := CASE WHEN TG_OP = 'UPDATE' THEN OLD.assigned_to ELSE NULL END;

  -- 0. Cancelling the request cancels every visit and every open assignment.
  IF NEW.status = 'cancelled' THEN
    UPDATE appointments SET cancelled_at = COALESCE(cancelled_at, now()),
        version = version + 1, updated_at = now()
      WHERE service_request_id = NEW.id AND cancelled_at IS NULL;
    UPDATE appointment_assignments a SET status = 'cancelled'
      FROM appointments p
      WHERE a.appointment_id = p.id AND p.service_request_id = NEW.id
        AND a.status NOT IN ('completed','cancelled');
  END IF;

  -- 1. Nothing to mirror: delete #1 when it has no progress, else null its
  --    times and demote the lead.
  IF NEW.scheduled_date IS NULL AND NEW.arrival_window_start IS NULL
     AND NEW.arrival_window_end IS NULL AND NEW.assigned_to IS NULL THEN
    SELECT id INTO v_appt_id FROM appointments
      WHERE service_request_id = NEW.id AND appointment_number = 1;
    IF v_appt_id IS NOT NULL THEN
      SELECT EXISTS (
        SELECT 1 FROM appointment_assignments a
        WHERE a.appointment_id = v_appt_id
          AND (a.en_route_at IS NOT NULL OR a.arrived_at IS NOT NULL
               OR a.started_at IS NOT NULL OR a.completed_at IS NOT NULL)
      ) INTO v_has_progress;
      IF NOT v_has_progress THEN
        DELETE FROM appointments WHERE id = v_appt_id;
      ELSE
        UPDATE appointments
          SET scheduled_date = NULL, starts_at = NULL, ends_at = NULL,
              arrival_window_start = NULL, arrival_window_end = NULL,
              version = version + 1, updated_at = now()
          WHERE id = v_appt_id;
        UPDATE appointment_assignments SET is_lead = false,
            status = CASE WHEN status = 'completed' THEN status ELSE 'cancelled' END
          WHERE appointment_id = v_appt_id AND is_lead;
      END IF;
    END IF;
    RETURN NEW;
  END IF;

  v_window_end := CASE
    WHEN NEW.arrival_window_end IS NOT NULL AND NEW.arrival_window_start IS NOT NULL
         AND NEW.arrival_window_end <= NEW.arrival_window_start THEN NULL
    ELSE NEW.arrival_window_end END;

  -- 2. Upsert visit #1 (starts_at/ends_at from the window only).
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
      cancelled_at = CASE WHEN NEW.status = 'cancelled'
                          THEN COALESCE(appointments.cancelled_at, now()) ELSE NULL END,
      version = appointments.version + 1,
      updated_at = now()
  RETURNING id INTO v_appt_id;

  -- 3. Lead assignment follows assigned_to.
  IF TG_OP = 'INSERT' OR v_old_assigned IS DISTINCT FROM NEW.assigned_to THEN
    DELETE FROM appointment_assignments a
      WHERE a.appointment_id = v_appt_id AND a.is_lead
        AND (NEW.assigned_to IS NULL OR a.technician_id <> NEW.assigned_to)
        AND a.en_route_at IS NULL AND a.arrived_at IS NULL
        AND a.started_at IS NULL AND a.completed_at IS NULL;
    UPDATE appointment_assignments a SET is_lead = false,
        status = CASE WHEN a.status = 'completed' THEN a.status ELSE 'cancelled' END
      WHERE a.appointment_id = v_appt_id AND a.is_lead
        AND (NEW.assigned_to IS NULL OR a.technician_id <> NEW.assigned_to);
    IF NEW.assigned_to IS NOT NULL THEN
      INSERT INTO appointment_assignments (organization_id, appointment_id, technician_id,
          is_lead, status, assigned_at)
      VALUES (NEW.organization_id, v_appt_id, NEW.assigned_to, true, NEW.status, now())
      ON CONFLICT (appointment_id, technician_id) DO UPDATE SET
          is_lead = true,
          status = CASE WHEN appointment_assignments.en_route_at IS NULL
                         AND appointment_assignments.arrived_at IS NULL
                         AND appointment_assignments.started_at IS NULL
                         AND appointment_assignments.completed_at IS NULL
                        THEN EXCLUDED.status ELSE appointment_assignments.status END;
    END IF;
  ELSIF NEW.assigned_to IS NOT NULL AND NEW.status <> 'cancelled' THEN
    -- 4. Status mirror for the lead, only until the tech app has written it.
    UPDATE appointment_assignments SET status = NEW.status
      WHERE appointment_id = v_appt_id AND technician_id = NEW.assigned_to AND is_lead
        AND en_route_at IS NULL AND arrived_at IS NULL
        AND started_at IS NULL AND completed_at IS NULL;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
```
The trigger definitions (`service_requests_sync_appointment_ins` / `_upd`) are unchanged and not repeated.

- [ ] **Step 3:** `npx drizzle-kit generate` → "No schema changes". `npm run db:migrate` twice on dev.

- [ ] **Step 4: Probes** (DB probe + a throwaway request via `POST /api/admin/requests`, two technician ids T1/T2 from the default org):
```sql
-- (a) mirror stops after progress
update service_requests set assigned_to = '<T1>' where id = '<rid>';            -- lead row status pending
update appointment_assignments set started_at = now(), status = 'in_progress' where technician_id = '<T1>' and appointment_id = (select id from appointments where service_request_id = '<rid>' and appointment_number = 1);
update service_requests set status = 'on_hold' where id = '<rid>';              -- admin hold
select status from appointment_assignments where technician_id = '<T1>' and appointment_id = (select id from appointments where service_request_id = '<rid>' and appointment_number = 1);   -- still in_progress
-- (b) demoted completed lead keeps completed
update appointment_assignments set status = 'completed', completed_at = now() where technician_id = '<T1>' and appointment_id = (select id from appointments where service_request_id = '<rid>' and appointment_number = 1);
update service_requests set assigned_to = '<T2>' where id = '<rid>';
select technician_id = '<T1>' as is_t1, is_lead, status from appointment_assignments where appointment_id = (select id from appointments where service_request_id = '<rid>' and appointment_number = 1) order by is_lead desc;   -- T1 row: is_lead false, status completed
-- (c) cancel closes open assignments on all visits (add visit #2 with T1+T2 via the admin API first)
update service_requests set status = 'cancelled' where id = '<rid>';
select a.status from appointment_assignments a join appointments p on p.id = a.appointment_id where p.service_request_id = '<rid>';   -- every row completed or cancelled
```
Clean up the throwaway request (+ status events + stand-in session).

- [ ] **Step 5: Gates + commit** (`git add drizzle/0050_m3a_run_the_day.sql drizzle/meta/_journal.json drizzle/meta/0050_snapshot.json src/lib/db/schema.ts`), message `feat(db): general time entries and trigger v2 — the tech app owns a lead row once it has progress`.

---

### Task 2: Ownership helper and the seven sites

**Files:**
- Create: `src/lib/tech/ownership.ts`, `src/lib/tech/ownership.test.ts`
- Modify: `src/lib/tech/field-queries.ts` (`getTechJobSummary` ~95–110, `findOwnedJob` ~150–172, the signature UPDATE ~399), `src/lib/tech/timesheet-queries.ts` (~43 via `findOwnedJob`), `src/lib/tech/location-queries.ts` (~83), `src/app/api/tech/jobs/route.ts` (~57; Task 6 rewrites the list fully — here only switch the predicate), `src/app/api/tech/jobs/[id]/status/route.ts` (~60; Task 3 rewrites the route — here only switch the predicate)

**Interfaces (all exported from `ownership.ts`):**
```ts
export interface TechAssignmentRow { assignmentId: string; appointmentId: string; appointmentNumber: number; isLead: boolean; status: RequestStatus; cancelledAt: Date | null; enRouteAt: Date | null; arrivedAt: Date | null; startedAt: Date | null; completedAt: Date | null }
export const OPEN_ASSIGNMENT_STATUSES = ["pending","assigned","scheduled","en_route","arrived","in_progress","on_hold"] as const;  // = not completed/cancelled
/** Pure. The caller's assignment to act on: the earliest non-cancelled visit with an open assignment of the caller; else the latest non-cancelled visit the caller is on; else null. */
export function pickActiveAssignment(rows: readonly TechAssignmentRow[]): TechAssignmentRow | null
/** Pure. The active visit of the request: the earliest non-cancelled visit that still has ANY open assignment. */
export function pickActiveVisit(rows: readonly { appointmentId: string; appointmentNumber: number; cancelledAt: Date | null; status: RequestStatus }[]): string | null
export async function findTechAssignments(organizationId: string, techUserId: string, requestId: string): Promise<readonly TechAssignmentRow[]>   // the caller's rows on non-cancelled visits, ordered by appointmentNumber
export async function findReadableJob(organizationId: string, techUserId: string, requestId: string): Promise<{ id: string; native: boolean } | null>   // any assignment on a non-cancelled visit OR assigned_to (belt and braces during M3a)
export async function findActiveLead(organizationId: string, requestId: string): Promise<{ technicianId: string; appointmentId: string } | null>   // the is_lead row on pickActiveVisit
```

- [ ] **Step 1: Failing tests** for the pure functions: `pickActiveAssignment` — (i) one open row → it; (ii) visit #1 completed + visit #2 assigned → #2; (iii) all completed → the latest non-cancelled; (iv) cancelled visits ignored; `pickActiveVisit` — same cases returning the appointment id; `OPEN_ASSIGNMENT_STATUSES` excludes completed/cancelled.
- [ ] **Step 2: Implement** (queries: `appointmentAssignments` ⋈ `appointments` under `withTenant`, `isNull(appointments.cancelledAt)`, `eq(technicianId, me)`; `findReadableJob` also returns `native: isNull(fieldpulseJobId) && isNull(hcpJobId)` from the request row).
- [ ] **Step 3: Replace the seven sites** — every `eq(serviceRequests.assignedTo, techUserId)` ownership check becomes `findReadableJob(...)` (404 when null); the signature UPDATE's inline re-check becomes `EXISTS (assignment on a non-cancelled visit for me) OR assigned_to = me`. Keep behaviour otherwise identical. Existing tests that assert the old predicate (`field-queries.test.ts`, `timesheet-queries.test.ts`, `location-queries.test.ts`): update their mocks for the new select shape; keep assertions meaningful.
- [ ] **Step 4: Probe** — a technician on visit #2 only (added via the admin visits API) can `GET /api/tech/jobs/<id>` (200) and `POST …/note` (201); a technician on no visit gets 404.
- [ ] **Step 5: Gates + commit** `feat(tech): job ownership follows visit assignments`.

---

### Task 3: Tech status actions — pure resolution, batch write, close-out

**Files:**
- Create: `src/lib/tech/status-actions.ts`, `src/lib/tech/status-actions.test.ts`, `src/lib/tech/status-writes.ts`
- Modify: `src/app/api/tech/jobs/[id]/status/route.ts`, `src/lib/tech/field-queries.ts` (`getTechJobSummary` returns `assignment`, `isActiveLead`, `allowedActions`, `blockers`, `native`)

**Interfaces:**
```ts
// status-actions.ts (pure)
export const TECH_ACTIONS = ["en_route","arrived","in_progress","pause","on_hold","completed","close_out"] as const;
export type TechAction = (typeof TECH_ACTIONS)[number];
export interface ResolveInput { action: TechAction; assignmentStatus: RequestStatus; requestStatus: RequestStatus; isActiveLead: boolean; native: boolean; hasOpenJobEntry: boolean }
export type Resolved =
  | { kind: "noop" }
  | { kind: "refuse"; reason: "not_lead" | "invalid_transition" | "managed_externally" | "not_tech_target" }
  | { kind: "write"; assignmentTo: RequestStatus; stamp: "enRouteAt"|"arrivedAt"|"startedAt"|"completedAt"|null; requestTo: RequestStatus | null; holdScope: "none"|"visit"; timeEntry: "open"|"close"|"none" }
  | { kind: "close_out" };
export function resolveTechAction(i: ResolveInput): Resolved
export function allowedActions(i: Omit<ResolveInput,"action">): readonly TechAction[]
```
Rules (`resolveTechAction`): `native === false` → refuse `managed_externally` for any action; `en_route`/`arrived`/`in_progress`/`completed`: target = the action; `pause` → target `on_hold`, scope none; `on_hold` (hold) → lead only (else `not_lead`), target `on_hold`, scope visit; `close_out` → lead only, `{ kind: "close_out" }`; target equal to `assignmentStatus` → noop; transition checked with `canTransition(assignmentStatus, target)` else `invalid_transition`; `requestTo` = target when `isActiveLead` and the action is not `pause` and not `completed`, else null (a lead's `completed` only completes their row; the request completes on `close_out`); stamps: en_route→`enRouteAt`, arrived→`arrivedAt`, in_progress→`startedAt`, completed→`completedAt`; `timeEntry`: `open` when target ∈ {`arrived`,`in_progress`} and `!hasOpenJobEntry`; `close` when target ∈ {`on_hold`,`completed`} and `hasOpenJobEntry`; else none.

```ts
// status-writes.ts
export async function applyTechAction(params: { organizationId; techUserId; requestId; assignment: TechAssignmentRow; resolved: Extract<Resolved,{kind:"write"}>; holdReason?: HoldReason | null; followUpDate?: Date | null }): Promise<{ ok: true; assignmentStatus; requestStatus } | { ok: false; reason: "stale" | "invalid_transition" }>
export async function closeOutRequest(params: { organizationId; techUserId; requestId }): Promise<{ ok: true; changed: boolean } | { ok: false; blockers: Blocker[] }>
export type Blocker = { kind: "technician_open"; technicianName: string } | { kind: "request_status"; status: RequestStatus } | { kind: "not_lead" }
```
`applyTechAction` = one `db.batch`: (1) `UPDATE appointment_assignments SET status = $to, <stamp> = COALESCE(<stamp>, now()) WHERE id = $assignmentId AND organization_id = $org AND status = $from` (CAS; 0 rows → `stale`); (2) when `requestTo`: `updateRequestStatus(org, requestId, requestTo, holdDetails, { actorType: "human", actorId: techUserId })` — NOTE this function performs its own read + CAS + event and is not a batch item; call it AFTER the batch, and if it returns `invalid_transition` log and continue (the assignment write is the source of per-tech truth; the request may legitimately already be at that status because another lead-equivalent action happened); (3) when `holdScope === "visit"`: `UPDATE appointment_assignments SET status='on_hold' WHERE appointment_id = $appt AND status NOT IN ('completed','cancelled')`; (4) time entry: `open` → `clockInAuto(org, tech, requestId, appointmentId)`; `close` → `clockOut(org, tech, requestId)` (Task 4 adds the auto variant; in this task call the existing `clockIn`/`clockOut` and let Task 4 switch it — or implement Task 4 first; the controller orders Task 4 before this one's integration step if needed).
`closeOutRequest`: if the caller is not the active lead → `{ ok: false, blockers: [{ kind: "not_lead" }] }`; then
```sql
UPDATE service_requests SET status = 'completed', updated_at = now()
WHERE id = $1 AND organization_id = $2 AND status IN ('in_progress','arrived','on_hold')
  AND fieldpulse_job_id IS NULL AND hcp_job_id IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM appointment_assignments a JOIN appointments p ON p.id = a.appointment_id
    WHERE p.service_request_id = $1 AND p.cancelled_at IS NULL
      AND a.status NOT IN ('completed','cancelled'))
RETURNING id
```
0 rows → re-read: already `completed` → `{ ok: true, changed: false }`; else compute blockers (open assignments with technician names; `request_status` when the status is not in the allowed set) → `{ ok: false, blockers }`. On `changed: true`: `recordStatusEvent` (from → completed, actor tech), close any open job time entry of the caller, and the review request (`createReviewRequest`, already idempotent by ledger) via `after()`.

- [ ] **Step 1: Failing tests** for `resolveTechAction`/`allowedActions` covering: helper `completed` → write with `requestTo: null`; helper `on_hold` → refuse `not_lead`; lead `on_hold` → write scope visit + requestTo; lead `completed` → requestTo null; `close_out` by helper → refuse; non-native → `managed_externally`; `en_route` when already `en_route` → noop; `arrived` from `pending` → `invalid_transition` (check `canTransition`); time-entry open/close matrix.
- [ ] **Step 2: Implement** the three files; the route body `z.object({ appointmentId: z.uuid().optional(), action: z.enum(TECH_ACTIONS).optional(), status: z.enum([...]).optional(), holdReason: z.enum(HOLD_REASONS).optional(), followUpDate: z.iso.date().optional() })` — legacy `{ status }` (the current UI) maps to `action = status` with `appointmentId` = `pickActiveAssignment(...)`; when `appointmentId` is given, the caller's row on that visit must exist (404). Responses: 200 `{ assignmentStatus, requestStatus, allowedActions, blockers }`; 403 `NOT_LEAD` "Only the lead technician can do that."; 409 `INVALID_TRANSITION` (existing copy), 409 `MANAGED_EXTERNALLY`, 409 `CLOSE_OUT_BLOCKED` with `blockers`; 400 for `cancelled`/`scheduled`.
- [ ] **Step 3: Probes (Review Focus 1–2)** on a throwaway native request with visit #2 holding T1 (lead) and T2: T2 `close_out` → 403; T1 `en_route` → request `en_route` + one event; T2 `en_route` → T2 row `en_route`, request unchanged, event count unchanged; both `arrived`, both `in_progress`; T1 `completed` → T1 row completed, request still `in_progress`; T1 `close_out` → 409 with `technician_open` T2; T2 `completed`; T1 `close_out` → 200 `changed: true`, request `completed`, exactly one review request row; T1 `close_out` again → 200 no-op, still one review request. Clean up.
- [ ] **Step 4: Gates + commit** `feat(tech): per-technician status actions with lead-only close-out`.

---

### Task 4: Auto job time entries

**Files:**
- Modify: `src/lib/tech/timesheet-queries.ts` (+ `timesheet-queries.test.ts`): `clockIn` gains an options arg `{ appointmentId?: string | null; method?: "auto" | "manual" }`; add `hasOpenJobEntry(org, tech, requestId)`; `clockOut` unchanged in behaviour (closes the open entry whatever its method); `src/lib/tech/status-writes.ts` wires `open` → `clockIn(..., { appointmentId, method: "auto" })` and `close` → `clockOut`.

Rules: one open job entry per (request, technician) remains the invariant (`tte_open_per_tech_job_unique`); a manual entry already open counts as open (the tap does not open a second one); `clockOut` on `completed`/`on_hold` closes whichever is open; a tech who never tapped working and clocks out manually keeps today's behaviour.

- [ ] **Step 1: Failing tests**: `clockIn` passes `kind: 'job'`, `clockInMethod`, `appointmentId` into the insert; `hasOpenJobEntry` true/false; (the status-actions matrix already covers open/close decisions).
- [ ] **Step 2: Implement; Step 3: Probe**: T1 `in_progress` → one open entry with `clock_in_method='auto'` and `appointment_id` set; T1 `pause` → closed with `minutes`; T1 `in_progress` again → a second entry opens; `completed` → closed.
- [ ] **Step 4: Gates + commit** `feat(tech): job time entries open and close from status taps`.

---

### Task 5: General clock + reader filters

**Files:**
- Create: `src/app/api/tech/time/route.ts` (GET current open general entry; POST `{ action: "in" | "out" }`)
- Modify: `src/lib/tech/timesheet-queries.ts` (+ test): `openGeneralEntry(org, tech)` (insert `kind='general'`, `serviceRequestId: null`, `clockInMethod:'manual'`; `isUniqueViolation(error, "tte_open_general_per_tech_idx")` → `{ reason: "already_open" }`), `closeGeneralEntry(org, tech)` (closes the open general entry: `minutes` set, `laborCostCents` NULL, `laborRateCents` 0), `getOpenGeneralEntry`.
- Modify: `src/lib/admin/operations-metrics-queries.ts` (~236–249: add `eq(technicianTimeEntries.kind, "job")`), `src/lib/admin/accounting-export.ts` (~215–232: same), `src/lib/admin/reporting-queries.ts` (~709–718: same) + their tests (mocks gain `kind`; assert the filter is present where the existing tests inspect conditions).

- [ ] **Step 1: Failing tests** (pure where possible): `closeGeneralEntry` computes `minutes` and leaves `laborCostCents` null; `openGeneralEntry` maps the named unique violation to `already_open`.
- [ ] **Step 2: Implement; Step 3: Probe (Review Focus 4)**: `POST /api/tech/time {"action":"in"}` twice → 201 then 409 `ALREADY_OPEN`; `{"action":"out"}` → 200 with `minutes`; DB: `labor_cost_cents IS NULL`; `GET /api/admin/operations-metrics?…` on-site average unchanged by the entry (compare before/after).
- [ ] **Step 4: Gates + commit** `feat(tech): general clock in and out; job-only filters on labor readers`.

---

### Task 6: The tech list by visit — today / upcoming / past

**Files:**
- Modify: `src/app/api/tech/jobs/route.ts` (`?range=today|upcoming|past`, default `today`): rows = the caller's assignment rows ⋈ `appointments` (non-cancelled for today/upcoming) ⋈ `serviceRequests`; the visit's `startsAt/endsAt/arrivalWindow*` (fallback to the request's for visit #1); `today` = visits whose window/scheduled date falls on the business day (Eastern) OR open assignments with no date; `upcoming` = later dates; `past` = assignment `completed`/`cancelled` within 30 days; response gains `appointmentId`, `appointmentNumber`, `assignmentStatus`, `isLead`.
- Modify: `src/components/tech/tech-jobs-list-client.tsx`: three tabs, the card shows the visit window and the caller's status, `href` to `/tech/jobs/<id>?visit=<appointmentId>`.
- Pure helper `src/lib/tech/visit-range.ts` (+ test): `classifyVisit(row, businessTodayIso)` → `"today" | "upcoming" | "past" | "hidden"`.

- [ ] Steps: failing tests for `classifyVisit`; implement; probe each range with the throwaway request (visit #1 today, visit #2 in a week, a completed one); screenshot `/tech/jobs` at 390 with `--tech` and look at it; gates; commit `feat(tech): visits list with today, upcoming and past`.

---

### Task 7: Close-out sheet and actions in the job summary

**Files:**
- Create: `src/components/tech/close-out-sheet.tsx` (spec "Close-out sheet": four large buttons — Done, Pause, Hold (reason select from `HOLD_REASONS` + optional follow-up date), Close out (lead only); blocked state lists `blockers` above greyed buttons)
- Modify: `src/components/tech/tech-job-summary.tsx` (buttons from `allowedActions`; labels via `techStatusLabel` + `"Pause"`, `"Hold"`, `"Close out"`; opens the sheet for Done/Pause/Hold/Close out; "Managed in FieldPulse" notice when `!native`), `src/components/tech/tech-status-confirm.ts` (+ test: labels for the new actions), `src/components/tech/tech-job-detail-client.tsx` (pass `visit` query param through; refresh after an action), `src/lib/tech/field-queries.ts` `getTechJobSummary` (already returns `allowedActions` + `blockers` from Task 3).

- [ ] Steps: pure label tests; implement; Playwright at 390: open a job as T1 at `in_progress`, open the sheet, screenshot (`/tmp/closeout-390.png`), tap Hold with a reason, screenshot the result; look at both; gates; commit `feat(tech): close-out sheet with done, pause, hold and close out`.

---

### Task 8: Clock button + minimal admin timesheets

**Files:**
- Modify: `src/components/tech/tech-jobs-list-client.tsx` (a "Clock in" / "Clock out" button in the header using `/api/tech/time`)
- Create: `src/app/api/admin/timesheets/route.ts` (GET `?technicianId=&from=&to=` → entries incl. kind, request reference, minutes, labor cost), `src/components/admin/staff/timesheets-dialog.tsx`; modify `src/components/admin/staff-table.tsx` (row action "Timesheets" on technician rows). Read `page-staff` skill.

- [ ] Steps: implement; probe GET; screenshot the dialog at 1440; gates; commit `feat(staff): technician timesheets with general time`.

---

### Task 9: Visit-edit guard + docs

**Files:**
- Modify: `src/lib/admin/appointment-queries.ts` `updateAppointment` (+ test): before the batch, if any assignment on the visit has a progress timestamp → `{ reason: "has_progress" }` → 409 `HAS_PROGRESS` "A technician has already started this visit." in the `[aid]` route; also add `AND NOT EXISTS (progress)` to the CAS.
- Docs: `.claude/skills/page-tech/SKILL.md` (ownership rule, actions, close-out, time), `page-staff/SKILL.md` (timesheets), `page-requests/SKILL.md` (HAS_PROGRESS), `admin-pages/SKILL.md`; `replica/features.csv` rows 115, 118, 120, 137, 138 → `yes` with notes; `parity.md` regenerated; `build-log.md` S37/S38/S25 lines.

- [ ] Steps: failing test; implement; probe (Review Focus 5); docs; `verify-skills` 0 missing; gates; commit `feat(requests): visits with technician progress cannot be edited; M3a docs and parity`.

---

## Self-review notes

- Spec coverage: migration + trigger v2 (T1), ownership (T2), actions/close-out (T3), auto time (T4), general clock + filters (T5), list ranges (T6), sheet (T7), clock button + S25 (T8), visit guard + docs (T9). Deferred per spec: en-route texts, required-forms blocker, GPS/backdating, offline.
- Order note: Task 3 calls `clockIn` with options that Task 4 adds; the controller may run Task 4 before Task 3's integration, or Task 3 implements the minimal options and Task 4 completes them.
- Review Focus pins: 1–2 → T3 step 3; 3 → T1 step 4(c); 4 → T5 step 3; 5 → T9.
