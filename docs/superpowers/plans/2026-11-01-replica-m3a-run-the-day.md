# Replica M3a: Run the Day Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Prerequisite:** M0a merged (HEAD ≥ `41ff718`: `drizzle/0049_appointments_shifts.sql`, `appointment_assignments` with per-tech `status` + `enRouteAt/arrivedAt/startedAt/completedAt`, `technician_shifts`, the visits API in `src/lib/admin/appointment-queries.ts` with `landed()` / `insertAssignments()` / `classifyMiss()`). Spec at commit `35a7d7d` or later (round 4).

**Goal:** A technician runs a native job from the phone with per-technician progress (en route → arrived → working → pause / hold with reason → done per technician → close-out that completes the request once every technician is done), job time is tracked from those taps, a general clock exists, and the tech list shows today / upcoming / past visits.

**Architecture:** Ownership moves from `service_requests.assigned_to = me` to assignment rows. **Open assignment** = status in (assigned, scheduled, en_route, arrived, in_progress, on_hold). **Active visit** = the earliest non-cancelled visit with an open assignment, else the latest non-cancelled visit. **Active lead** = the `is_lead` row on the active visit (authorised even when that row is `completed`). Only the active lead writes the request status; helpers write only their own row. Every tap is ONE `db.batch` in a fixed order — [own-row CAS] → [xmin-gated inline request UPDATE, lead only] → [xmin-gated time-entry statement] — and `recordStatusEvent` + the review request run after the batch only when the request UPDATE returned a row. `updateRequestStatus` is never called on the tech path. Hold ends the visit (progressed rows → `completed`, untouched rows → `cancelled`, the visit's job time entries close, the request → `on_hold` with reason; resuming is a new visit from the office). Close-out is one batch ([own row → completed, gated on the request being in_progress/on_hold] → [guarded request UPDATE that sets `completed_at`, clears hold fields and refuses while any non-cancelled visit has an open row]). The 0049 trigger is replaced in place (mirror only until progress; keep `completed` on demote; cancel closes open assignments AND open job time entries). Admin paths follow the same rules through the app layer, never through new trigger logic. M3a is native-jobs-only.

**Tech Stack:** Next.js 16, TypeScript, Drizzle 0.45.2 on Neon (neon-http: `db.batch()` = one implicit transaction; separate calls are not), plpgsql, zod 4, vitest (pure helpers; `db.batch` mocked), Tailwind + `src/components/ui/*` (`sheet.tsx` has `side="bottom"`).

**Spec:** `replica/architecture.md` "### F04 Tech loop (M3a–M3d)" (ownership, actions, batch order, close-out, admin paths, trigger v2, auto entries, route table, deferred list) and build-order item 4 "M3a Run the day" with its done-when; `replica/schema.sql` section "M3a"; `replica/review-log.md` "Spec round 4". Design: `replica/design/components.md` "Close-out sheet".

## Global Constraints

Everything in the M0b/M0a plans' Global Constraints applies (gates tsc 0 / eslint 0 errors / `npx vitest run` never below the live baseline — 4562 passed, 1 skipped at `41ff718`; pure mocked tests; `isUniqueViolation` from `@/lib/db/unique-violation`; `readJsonBody` for every body; `withTenant` variadic; audit details ids/enums; copy canon — "request", "technician", sentence case, "Couldn't … Please try again.", never `err.message`; migration conventions + the six-step drizzle recipe; DB probes through a temporary `probe.mts` at the repo root with `config({ path: ".env.local" })`; explicit `git add`; attribution `Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>`; read `page-tech`, `page-staff`, `page-requests`, `admin-pages` skills before editing those pages; `node scripts/agent/verify-skills.mjs` → 0 missing). Plus:

- **Native jobs only** for every tech write and the admin hold/complete rules: `fieldpulse_job_id IS NULL AND hcp_job_id IS NULL`; otherwise 409 `MANAGED_EXTERNALLY` "This job is managed in FieldPulse." Reads work on synced jobs.
- **Tech targets**: `en_route`, `arrived`, `in_progress`, `pause`, `on_hold` (hold), `completed` (done), `close_out`. `cancelled`/`scheduled` → 400.
- **Done requires `started_at IS NOT NULL`** on the row (a helper cannot pause-then-done without arriving/working). The lead's done and close-out are refused with `request_not_started` unless the request is `in_progress` or `on_hold` (derive the allowed set from `canTransition(s, "completed")`).
- **Replay/stale/behind**: an own-row tap is a no-op (200, no side effects) only when the row is already at the target AND the target's `*_at` stamp is set; otherwise the CAS runs with `status = $target` and stamps it. For the active lead, when the row is at the target but the request is behind (`requestStatus !== target` and `canTransition(requestStatus, target)`), run a request-only batch whose request UPDATE is gated on `EXISTS (row id = $aid AND status = $target)` ("whichever is behind"). A stale CAS (0 rows) → re-read: at target → 200 no-op, else 409 `STALE`; close-out on an already-completed request → 200 `{ changed: false }`. `hold` and `close_out` are never no-ops by row equality and skip the row transition check (a paused lead can hold).
- **Lock order**: every tech batch (tap, hold, close-out) starts with `SELECT 1 FROM service_requests WHERE id = $rid AND organization_id = $org FOR NO KEY UPDATE` (child inserts keep their KEY SHARE); `holdVisit` then also locks the visit row (`SELECT 1 FROM appointments WHERE id = $appt FOR NO KEY UPDATE`) before touching assignment rows, matching `updateAppointment`/`cancelAppointment`'s visit → rows order so request → rows matches the admin paths (whose triggers write rows after locking the request). Any `40P01` deadlock that still surfaces maps to 409 `STALE`.
- **Every status literal in raw SQL is cast**: `'completed'::request_status`, `'cancelled'::request_status`, … (an untyped CASE yields `text`, which has no assignment cast to the enum; `appointment-queries.ts:91` shows the pattern). Every raw-SQL writer gets a live probe on dev before its task's gates, since the mocked `db.batch` tests cannot catch this.
- **Labor math is one formula everywhere** (trigger, builders, existing `clockOut`): `minutes = GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (now() - clock_in_at)) / 60))::int`, `labor_cost_cents = ROUND(minutes / 60.0 * COALESCE(u.labor_rate_cents, 0))::int`, `labor_rate_cents = COALESCE(u.labor_rate_cents, 0)`.
- **Every SQL fragment that contains `OR` is wrapped in its own parentheses** (Drizzle's `and()` does not parenthesise elements), with a `PgDialect` render test.
- **`appointmentId` lookup** is always scoped by the URL's request and the caller: `findTechAssignments(org, me, requestId)` then pick by id → 404 for another request, another technician's row or a cancelled visit. Legacy `{ status }` bodies (the current UI) resolve to `pickActiveAssignment` until Task 6 ships the new UI.
- **Read access** = any assignment on a non-cancelled visit whose row is not `cancelled` OR has a progress timestamp (a reassigned-away lead with no progress loses access).
- **Tech sessions**: `TECH=$(npx tsx scripts/agent/mint-tech-session.mjs)` signs `SELECT … FROM users WHERE role='technician' AND is_active LIMIT 1` with no org filter and no override. For a second technician, copy the script's signing code into a temporary `mint-tech-T.mts` that takes a user id, and confirm both technicians are in the admin token's org. Admin: `TOKEN=$(npx tsx scripts/agent/mint-admin-session.mjs)`. Dev server on `http://localhost:3000`.
- **Order of tasks is fixed**: 1 → 2 → 3 → 4a → 4b → 5 → 6 → 7 → 8.

## Review Focus

1. Helper B on visit #1 sends `close_out` → 403 `NOT_LEAD`; sends `on_hold` (hold) → 403; sends `cancelled` → 400; sends `completed` after working → B's row `completed`, request status unchanged, no status event. (Task 4b probes.)
2. Lead A: done while B is `in_progress` → A's row `completed`, request stays `in_progress`; A `close_out` → 409 `CLOSE_OUT_BLOCKED` with `{ kind: "technician_open", technicianName: "B…" }`, body `assignmentStatus: "completed"`, A's entry closed, no event, no review request; after B's done, A `close_out` → 200 `changed: true`, `completed_at` set, `hold_reason` NULL, exactly one `completed` event by A, one review request; A `close_out` again → 200 `changed: false`; two concurrent `close_out` → one `completed` event. (Task 4b probes.)
3. Admin cancels a request with two open rows and two open auto entries → every row `completed`/`cancelled`, every job entry closed with `minutes`; admin `on_hold` on a request whose lead is `in_progress` → the hold rule (lead row `completed`, untouched helper row `cancelled`, entries closed, request `on_hold` with reason). (Tasks 1 and 4b probes.)
4. General clock-in twice → one open entry; close → `minutes` set, `labor_cost_cents` NULL; the on-site KPI average excludes it. (Task 3.)
5. `updateAppointment` on a visit with a progressed row → 409 `HAS_PROGRESS`; reschedule / assign / unschedule of a request whose visit #1 has progress → 409 `HAS_PROGRESS`; `addAppointment` on a `completed` request → 409. (Task 8.)

---

## File map

| file | responsibility |
| --- | --- |
| `drizzle/0050_m3a_run_the_day.sql` (+ journal, snapshot) | time-entry columns/checks/index; trigger v2 incl. closing entries on cancel |
| `src/lib/db/schema.ts` | `technicianTimeEntries` changes |
| `src/lib/tech/ownership.ts` (+ test) | `OPEN_ASSIGNMENT_STATUSES`, `pickActiveVisit`, `pickActiveAssignment`, `findTechAssignments`, `findReadableJob`, `findActiveVisit`, `techCanReadSql` |
| `src/lib/tech/field-queries.ts`, `timesheet-queries.ts`, `location-queries.ts`, `src/app/api/tech/jobs/route.ts`, `…/[id]/status/route.ts` (+ their tests) | the seven ownership sites |
| `src/lib/admin/assignment-queries.ts` (+ test), `src/app/api/admin/requests/[id]/appointments/[aid]/assignments/route.ts`, `…/assignments/[tid]/route.ts` | visit helpers (incl. visit #1) |
| `src/lib/tech/time-entry-sql.ts` (+ test) | pure SQL builders: `openJobEntrySql`, `closeJobEntriesSql`; `openGeneralEntry`, `closeGeneralEntry` in `timesheet-queries.ts` |
| `src/app/api/tech/time/route.ts` | general clock |
| `src/lib/admin/operations-metrics-queries.ts` (+ test) | `kind = 'job'` filter (accounting/reporting are already safe; see Task 3) |
| `src/lib/tech/status-actions.ts` (+ test) | pure: `TECH_ACTIONS`, `resolveTechAction`, `allowedActions`, `Blocker` |
| `src/lib/tech/status-writes.ts` (+ test with mocked `db.batch`) | `applyTechAction`, `holdVisit`, `closeOutRequest`, `closeOutBlockers` |
| `src/app/api/tech/jobs/[id]/status/route.ts`, `src/app/api/tech/jobs/[id]/route.ts`, `src/app/tech/jobs/[id]/page.tsx` | new body; `?visit=` plumbing |
| `src/app/api/admin/requests/[id]/route.ts`, `…/assign/route.ts`, `…/reschedule/route.ts`, `…/unschedule/route.ts`, `src/lib/admin/queries.ts`, `src/lib/admin/scheduling-queries.ts` | admin hold rule, admin complete batch, `HAS_PROGRESS` on schedule/assign/reschedule/unschedule |
| `src/lib/tech/visit-range.ts` (+ test), `src/app/api/tech/jobs/route.ts`, `src/components/tech/tech-jobs-list-client.tsx` | `?range=` |
| `src/components/tech/close-out-sheet.tsx`, `tech-job-summary.tsx`, `tech-status-confirm.ts` (+ test), `tech-job-detail-client.tsx`, `src/lib/tech/field-queries.ts` (`getTechJobSummary`) | sheet + actions |
| `src/app/api/admin/timesheets/route.ts`, `src/components/admin/timesheets-dialog.tsx`, `src/components/admin/staff-table.tsx`, `src/app/admin/(dashboard)/staff/page.tsx` | minimal S25 |
| `src/lib/admin/appointment-queries.ts` (+ test), `…/appointments/[aid]/route.ts`, `…/appointments/route.ts` | `HAS_PROGRESS`, refuse completed, close entries on cancel |
| skills, `replica/features.csv`, `parity.md`, `build-log.md` | docs |

---

### Task 1: Migration 0050 — time-entry columns + trigger v2 (+ before/after capture)

**Files:** `src/lib/db/schema.ts`; via the drizzle recipe (`--name m3a_run_the_day`): `drizzle/0050_m3a_run_the_day.sql`, `drizzle/meta/0050_snapshot.json`, `_journal.json`.

**Interfaces:** `technicianTimeEntries.kind` (`"job" | "general"`, default `"job"`), `appointmentId` (nullable), `clockInMethod` (`"auto" | "manual"`, default `"manual"`), `serviceRequestId` nullable; constraints `tte_kind_check`, `tte_clock_in_method_check`, `tte_kind_request_check`; partial unique `tte_open_general_per_tech_idx`. Trigger function `sync_request_appointment` v2 (trigger names unchanged).

- [ ] **Step 0: "Before" capture** on dev for one single-tech native request R with a window today: `curl … "/api/admin/calendar?date=$D&view=day"` and `curl … "/api/admin/requests/$R"` saved to the scratchpad `m3a/` folder.

- [ ] **Step 1: `schema.ts`** — in `technicianTimeEntries` drop `.notNull()` from `serviceRequestId`; add
```ts
    // M3a: 'job' entries belong to a request (and optionally a visit); 'general'
    // entries are a technician's clock with no job. Status taps open 'auto' entries.
    kind: text("kind").notNull().default("job"),
    appointmentId: uuid("appointment_id").references(() => appointments.id, { onDelete: "set null" }),
    clockInMethod: text("clock_in_method").notNull().default("manual"),
```
and to the extras:
```ts
    check("tte_kind_check", sql`${table.kind} IN ('job','general')`),
    check("tte_clock_in_method_check", sql`${table.clockInMethod} IN ('auto','manual')`),
    check("tte_kind_request_check", sql`(${table.kind} = 'job') = (${table.serviceRequestId} IS NOT NULL)`),
    uniqueIndex("tte_open_general_per_tech_idx").on(table.organizationId, table.technicianId).where(sql`${table.kind} = 'general' AND ${table.clockOutAt} IS NULL`),
```
(`appointments` is declared earlier in the file; `check`/`uniqueIndex` are already imported.)

- [ ] **Step 2: Generate**, compare objects, overwrite the SQL with:

```sql
-- M3a run the day: general time entries + visit link, and trigger v2 so the
-- tech app owns a lead row once it has progress. Idempotent throughout
-- (one DO block per constraint so a partial re-run adds the rest).
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
-- Trigger v2 (same trigger names; CREATE OR REPLACE swaps the body). Changes
-- vs 0049: step 0 also cancels open assignments and closes open job time
-- entries; steps 1 and 3 keep 'completed' on demote; step 3's ON CONFLICT and
-- step 4 never overwrite a row that has progress or is cancelled; step 4 also
-- skips when the request is cancelled/completed and only touches OPEN rows;
-- step 2 keeps a visit's cancelled_at unless the request leaves 'cancelled'.
CREATE OR REPLACE FUNCTION sync_request_appointment()
RETURNS TRIGGER AS $$
DECLARE
  v_appt_id uuid;
  v_window_end timestamptz;
  v_old_assigned uuid;
  v_has_progress boolean;
BEGIN
  v_old_assigned := CASE WHEN TG_OP = 'UPDATE' THEN OLD.assigned_to ELSE NULL END;

  -- 0. Cancelling the request cancels every visit, every open assignment and
  --    closes every open job time entry on the request.
  IF NEW.status = 'cancelled' THEN
    UPDATE appointments SET cancelled_at = COALESCE(cancelled_at, now()),
        version = version + 1, updated_at = now()
      WHERE service_request_id = NEW.id AND cancelled_at IS NULL;
    UPDATE appointment_assignments a SET status = 'cancelled'
      FROM appointments p
      WHERE a.appointment_id = p.id AND p.service_request_id = NEW.id
        AND a.status NOT IN ('completed','cancelled');
    UPDATE technician_time_entries t
      SET clock_out_at = now(),
          minutes = GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (now() - t.clock_in_at)) / 60))::int,
          labor_rate_cents = COALESCE(u.labor_rate_cents, 0),
          labor_cost_cents = ROUND(GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (now() - t.clock_in_at)) / 60)) / 60.0 * COALESCE(u.labor_rate_cents, 0))::int,
          updated_at = now()
      FROM users u
      WHERE u.id = t.technician_id AND t.service_request_id = NEW.id
        AND t.kind = 'job' AND t.clock_out_at IS NULL;
  END IF;

  -- 1. Nothing to mirror: delete #1 when it has no progress, else null its
  --    times and demote the lead (keeping 'completed').
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
      -- a visit a hold ended (cancelled_at set while the request lives on) stays
      -- ended; only leaving 'cancelled' clears it
      cancelled_at = CASE WHEN NEW.status = 'cancelled'
                            THEN COALESCE(appointments.cancelled_at, now())
                          WHEN TG_OP = 'UPDATE' AND OLD.status = 'cancelled' THEN NULL
                          ELSE appointments.cancelled_at END,
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
          status = CASE WHEN appointment_assignments.status <> 'cancelled'
                         AND appointment_assignments.en_route_at IS NULL
                         AND appointment_assignments.arrived_at IS NULL
                         AND appointment_assignments.started_at IS NULL
                         AND appointment_assignments.completed_at IS NULL
                        THEN EXCLUDED.status ELSE appointment_assignments.status END;
    END IF;
  ELSIF NEW.assigned_to IS NOT NULL AND NEW.status <> 'cancelled' THEN
    -- 4. Status mirror for the lead, only until the tech app has written it.
    -- Only a NON-TERMINAL untouched row is mirrored (pending included: a lead
    -- row inserted while the request is pending must follow it to scheduled),
    -- and never to a terminal value: a row a hold has cancelled must stay
    -- cancelled, and request 'completed' leaves rows alone (rule d).
    IF NEW.status NOT IN ('completed','cancelled') THEN
      UPDATE appointment_assignments SET status = NEW.status
        WHERE appointment_id = v_appt_id AND technician_id = NEW.assigned_to AND is_lead
          AND status NOT IN ('completed','cancelled')
          AND en_route_at IS NULL AND arrived_at IS NULL
          AND started_at IS NULL AND completed_at IS NULL;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
```
(The two trigger definitions are unchanged and not repeated.)

- [ ] **Step 3:** `npx drizzle-kit generate` → "No schema changes"; `npm run db:migrate` twice.

- [ ] **Step 4: "After" capture + diff** of the two Step 0 responses → identical.

- [ ] **Step 5: Trigger probes** (throwaway native request via `POST /api/admin/requests` with `customerId` and `schedule` so visit #1 exists with lead T1; a second technician T2 added to visit #1 is Task 2 — here use SQL `insert into appointment_assignments (…) values (… is_lead false …)`):
```sql
-- (a) mirror stops after progress, and never revives a cancelled row
update appointment_assignments set started_at = now(), status = 'in_progress' where technician_id = '<T1>' and appointment_id = '<A1>';
update service_requests set status = 'on_hold' where id = '<rid>';
select status from appointment_assignments where technician_id = '<T1>' and appointment_id = '<A1>';   -- in_progress (not mirrored)
update appointment_assignments set status = 'cancelled' where technician_id = '<T2>' and appointment_id = '<A1>';   -- stand-in for a hold on T2's untouched row
update service_requests set status = 'arrived' where id = '<rid>';
select status from appointment_assignments where technician_id = '<T2>' and appointment_id = '<A1>';   -- stays cancelled (step 4 only touches non-terminal rows)
-- (a2) a pending lead row still follows the request (v1 behaviour kept)
update appointment_assignments set status = 'pending', started_at = null where technician_id = '<T1>' and appointment_id = '<A1>';
update service_requests set status = 'scheduled' where id = '<rid>';
select status from appointment_assignments where technician_id = '<T1>' and appointment_id = '<A1>';   -- scheduled
update appointments set cancelled_at = now() where id = '<A1>';   -- stand-in for a hold that ended the visit
update service_requests set status = 'in_progress' where id = '<rid>';
select cancelled_at is not null from appointments where id = '<A1>';   -- true (step 2 keeps it)
update appointments set cancelled_at = null where id = '<A1>';
-- (b) demoted completed lead keeps completed; a cancelled row is not revived by promotion
update appointment_assignments set status = 'completed', completed_at = now() where technician_id = '<T1>' and appointment_id = '<A1>';   -- T1 is still assigned_to
update service_requests set assigned_to = '<T2>' where id = '<rid>';
select technician_id = '<T1>' as is_t1, is_lead, status from appointment_assignments where appointment_id = '<A1>';   -- T1: false, completed; T2: true, cancelled (step 3 ON CONFLICT keeps cancelled)
-- (c) cancel closes open assignments and open job entries (Review Focus 3, first half)
insert into technician_time_entries (organization_id, service_request_id, technician_id, kind, clock_in_method, appointment_id) values ('<org>','<rid>','<T2>','job','auto','<A1>');
update service_requests set status = 'cancelled' where id = '<rid>';
select status from appointment_assignments where appointment_id = '<A1>';                       -- completed / cancelled only
select clock_out_at is not null, minutes from technician_time_entries where service_request_id = '<rid>';   -- true, >= 0
```
Clean up (request, events, stand-in session, entries cascade).

- [ ] **Step 6: Gates + commit** (`git add drizzle/0050_m3a_run_the_day.sql drizzle/meta/_journal.json drizzle/meta/0050_snapshot.json src/lib/db/schema.ts`): `feat(db): general time entries and trigger v2 — the tech app owns a lead row once it has progress`.

---

### Task 2: Ownership module, the seven sites, and visit helpers

**Files:**
- Create: `src/lib/tech/ownership.ts`, `src/lib/tech/ownership.test.ts`
- Create: `src/lib/admin/assignment-queries.ts`, `src/lib/admin/assignment-queries.test.ts`, `src/app/api/admin/requests/[id]/appointments/[aid]/assignments/route.ts` (POST), `…/assignments/[tid]/route.ts` (DELETE)
- Modify: `src/lib/tech/field-queries.ts` (`getTechJobSummary` ~78–105 and `findOwnedJob` ~150–172 and the signature UPDATE ~399), `src/lib/tech/timesheet-queries.ts` (~43), `src/lib/tech/location-queries.ts` (~73–89: link null silently, never 404), `src/app/api/tech/jobs/route.ts` (~51–62: the set query uses `techCanReadSql`), `src/app/api/tech/jobs/[id]/status/route.ts` (~52–66: needs `customerId`); their tests `field-queries.test.ts`, `timesheet-queries.test.ts`, `location-queries.test.ts`: `vi.mock("@/lib/tech/ownership", async (importOriginal) => ({ ...(await importOriginal()), findReadableJob: vi.fn(), findActiveVisit: vi.fn() }))` (a partial factory throws on any other import) and drop the first queued select result; test `ownership.ts` on its own.

**Interfaces (`ownership.ts`):**
```ts
export const OPEN_ASSIGNMENT_STATUSES = ["assigned","scheduled","en_route","arrived","in_progress","on_hold"] as const;
export interface TechAssignmentRow { assignmentId: string; appointmentId: string; appointmentNumber: number; isLead: boolean; status: RequestStatus; cancelledAt: Date | null; enRouteAt: Date | null; arrivedAt: Date | null; startedAt: Date | null; completedAt: Date | null; technicianId: string }
export function hasProgress(r: Pick<TechAssignmentRow,"enRouteAt"|"arrivedAt"|"startedAt"|"completedAt">): boolean
export function isOpen(status: RequestStatus): boolean
/** Pure. Earliest non-cancelled visit with an open row; else the latest non-cancelled visit that still has at least one non-cancelled row; null when none. Input: every assignment row of the request (all technicians). */
export function pickActiveVisit(rows: readonly TechAssignmentRow[]): { appointmentId: string; leadTechnicianId: string | null } | null
/** Pure. The caller's row to act on: their row on the active visit if any; else their earliest open row; else their latest non-cancelled row. */
export function pickActiveAssignment(mine: readonly TechAssignmentRow[], activeVisitId: string | null): TechAssignmentRow | null
export async function findAllAssignments(organizationId: string, requestId: string): Promise<readonly TechAssignmentRow[]>   // all technicians, non-cancelled visits, ordered by appointmentNumber
export async function findActiveVisit(organizationId: string, requestId: string): Promise<{ appointmentId: string; leadTechnicianId: string | null } | null>   // = pickActiveVisit(await findAllAssignments(...))
export async function findTechAssignments(organizationId: string, techUserId: string, requestId: string): Promise<readonly TechAssignmentRow[]>
export async function findReadableJob(organizationId: string, techUserId: string, requestId: string): Promise<{ id: string; customerId: string | null; native: boolean; status: RequestStatus } | null>   // read rule: a non-cancelled-visit row that is not cancelled or has progress; OR assigned_to = me
export function techCanReadSql(organizationId: string, techUserId: string): SQL   // EXISTS fragment for set queries over service_requests
```
`assignment-queries.ts`: `addVisitTechnician(org, requestId, appointmentId, technicianId, actorUserId) → AppointmentRecord | { reason: "not_found" | "technician_not_found" | "already_assigned" | "visit_cancelled" | "visit_ended" | "request_cancelled" | "request_completed" | "time_off" }` — refuses a `completed`/`cancelled` request, a cancelled visit, a visit that has rows but no open row (`visit_ended`: a hold ended it), and time off (`anyTimeOff` over the visit window when it has one — M0a "time off is never overridable"); one `db.batch`: [`SELECT 1 FROM service_requests WHERE id=$rid AND organization_id=$org FOR SHARE`] then [`INSERT … SELECT $org, $appt, $tid, false, 'assigned'::request_status, now() WHERE EXISTS (request native, status NOT IN ('completed','cancelled')) AND EXISTS (visit not cancelled) AND (NOT EXISTS (any row on the visit) OR EXISTS (open row on the visit)) AND <noTimeOff over the visit window, or the business day for a date-only visit> ON CONFLICT (appointment_id, technician_id) DO NOTHING RETURNING id`] — the checks live in the second statement so they see a post-lock snapshot; 0 rows → re-read to classify (`already_assigned` incl. the lead, `visit_ended`, `request_completed`, `time_off`, …); works on visit #1 too. Export `noTimeOff`, `anyTimeOff`, `activeTechnicianIds` and `getAppointment` from `appointment-queries.ts` for this module. `removeVisitTechnician(org, requestId, appointmentId, technicianId) → { ok: true } | { reason: "not_found" | "has_progress" | "is_lead" }` (DELETE only when no progress and not the lead). 409 codes: `VISIT_ENDED`, `REQUEST_COMPLETED`, `TIME_OFF`, `ALREADY_ASSIGNED`, `HAS_PROGRESS`, `IS_LEAD`. Routes in the faqs shape; audits `add_visit_technician` / `remove_visit_technician` with ids only.

- [ ] **Step 1: Failing tests** — `pickActiveVisit`: (i) one open row → that visit; (ii) #1 completed, #2 assigned → #2; (iii) all completed → the latest non-cancelled; (iv) cancelled visits ignored; (v) #1 has a paused (`on_hold`) helper, #2 in progress → #1 (earliest open; the `earlier_visit_open` blocker surfaces in Task 4a); (vi) #2's rows all `cancelled` (an ended visit), #1 all completed → #1; `pickActiveAssignment`: on the active visit → that row; not on it → earliest open; none open → latest; `isOpen`/`OPEN_ASSIGNMENT_STATUSES` exclude pending/completed/cancelled; `hasProgress`.
- [ ] **Step 2: Implement** the queries: `appointmentAssignments` ⋈ `appointments` (`eq(appointments.id, appointmentAssignments.appointmentId)`) under `withTenant(appointmentAssignments, org, …)`, `isNull(appointments.cancelledAt)`, ordered by `appointments.appointmentNumber`; `techCanReadSql` = `sql\`(EXISTS (SELECT 1 FROM appointment_assignments a JOIN appointments p ON p.id = a.appointment_id WHERE p.service_request_id = ${serviceRequests.id} AND a.organization_id = ${org} AND a.technician_id = ${tech} AND p.cancelled_at IS NULL AND (a.status <> 'cancelled' OR a.en_route_at IS NOT NULL OR a.arrived_at IS NOT NULL OR a.started_at IS NOT NULL OR a.completed_at IS NOT NULL)) OR ${serviceRequests.assignedTo} = ${tech})\`` — outer parentheses are mandatory (test renders `and(techCanReadSql(...), inArray(...))` and asserts the `OR` is enclosed).
- [ ] **Step 3: Replace the seven sites** (behaviour otherwise identical; the signature stays with the ACTIVE LEAD: `src/app/api/tech/jobs/[id]/signature/route.ts` checks `(await findActiveVisit(org, id))?.leadTechnicianId === me` BEFORE the R2 upload (403 `NOT_LEAD`), and `recordSignature`'s UPDATE keeps an in-write guard `EXISTS (lead row for me on a non-cancelled visit)` in place of `assigned_to = me`).
- [ ] **Step 4: Visit helpers** (queries + routes).
- [ ] **Step 5: Probes**: add T2 to visit #1 of a throwaway request via `POST /api/admin/requests/<rid>/appointments/<A1>/assignments {"technicianId":"<T2>"}` → 201; T2 `GET /api/tech/jobs/<rid>` → 200 and `POST …/note` → 201; a technician on no visit → 404; a technician with time off today → 409 `TIME_OFF`; the lead again → 409 `ALREADY_ASSIGNED`; `DELETE …/assignments/<T2>` → 200; after T2 has progress (SQL) → 409 `HAS_PROGRESS`.
- [ ] **Step 6: Gates + commit** `feat(tech): job ownership follows visit assignments; visit helpers on any visit`.

---

### Task 3: Time-entry SQL builders, general clock, KPI filter

**Files:**
- Create: `src/lib/tech/time-entry-sql.ts`, `src/lib/tech/time-entry-sql.test.ts`
- Modify: `src/lib/tech/timesheet-queries.ts` (+ test): `openGeneralEntry`, `closeGeneralEntry`, `getOpenGeneralEntry`; align the existing `clockOut` labor math to the Global Constraints formula (it already floors minutes; only the rounding expression changes if it differs)
- Create: `src/app/api/tech/time/route.ts` (GET open entry; POST `{ action: "in" | "out" }`)
- Modify: `src/lib/admin/operations-metrics-queries.ts` (~236–249) + test: add `eq(technicianTimeEntries.kind, "job")`. (`accounting-export.ts` already requires `laborCostCents IS NOT NULL` and `reporting-queries.ts` inner-joins on the request id, so general entries never reach them — say so in the commit; no change there.)

**Interfaces (`time-entry-sql.ts`, pure builders returning `SQL`):**
```ts
/** Open an auto job entry for (request, tech) unless one is already open; gated on the caller's assignment row having been written in this transaction. */
export function openJobEntrySql(p: { organizationId; requestId; techUserId; appointmentId; gateAssignmentId }): SQL
// INSERT INTO technician_time_entries (organization_id, service_request_id, technician_id, appointment_id, kind, clock_in_method, clock_in_at)
// SELECT $org::uuid, $rid::uuid, $tech::uuid, $appt::uuid, 'job', 'auto', now()
// WHERE EXISTS (SELECT 1 FROM appointment_assignments a WHERE a.id = $gate::uuid AND a.xmin = pg_current_xact_id()::xid)
// ON CONFLICT (service_request_id, technician_id) WHERE clock_out_at IS NULL DO NOTHING
/** Close the open job entries on the request for the given technicians (all technicians when omitted); `gate` is any boolean SQL the caller supplies (an xmin test, a status test). Minutes + labor per the Global Constraints formula. */
export function closeJobEntriesSql(p: { organizationId; requestId; technicianIds?: readonly string[]; gate?: SQL }): SQL
// UPDATE technician_time_entries t SET clock_out_at = now(), minutes = GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (now() - t.clock_in_at))/60))::int,
//   labor_rate_cents = COALESCE(u.labor_rate_cents,0), labor_cost_cents = ROUND(GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (now() - t.clock_in_at))/60)) / 60.0 * COALESCE(u.labor_rate_cents,0))::int, updated_at = now()
// FROM users u WHERE u.id = t.technician_id AND t.organization_id = $org AND t.service_request_id = $rid [AND t.technician_id = ANY($ids::uuid[])] AND t.kind = 'job' AND t.clock_out_at IS NULL [AND (gate)]
```
Use `sql.param([...ids])::uuid[]` for arrays. Tests render with `PgDialect.sqlToQuery` (pattern in `appointment-queries.test.ts`) and assert the `ON CONFLICT (service_request_id, technician_id) WHERE clock_out_at IS NULL DO NOTHING` text, the single array param, and the `pg_current_xact_id` gate.

General clock: `openGeneralEntry(org, tech)` inserts `kind='general'`, `serviceRequestId: null`, `clockInMethod: 'manual'`; `isUniqueViolation(error, "tte_open_general_per_tech_idx")` → `{ reason: "already_open" }`; `closeGeneralEntry` sets `minutes`, leaves `laborCostCents` NULL and `laborRateCents` 0. Route: 201 / 409 `ALREADY_OPEN` "You're already clocked in." / 200 with `minutes` / 404 when nothing is open.

- [ ] Steps: failing tests (builders + general entry mapping) → implement → probe (Review Focus 4: twice `in` → 201, 409; `out` → 200 `minutes`; DB `labor_cost_cents IS NULL`; `GET /api/admin/operations-metrics` on-site average unchanged before/after) → gates → commit `feat(tech): time-entry SQL builders, general clock, job-only on-site KPI`.

---

### Task 4a: Pure status actions

**Files:** `src/lib/tech/status-actions.ts`, `src/lib/tech/status-actions.test.ts`

**Interfaces:**
```ts
export const TECH_ACTIONS = ["en_route","arrived","in_progress","pause","on_hold","completed","close_out"] as const;
export type TechAction = (typeof TECH_ACTIONS)[number];
export type Blocker =
  | { kind: "technician_open"; technicianName: string; technicianId: string; appointmentNumber: number }
  | { kind: "visit_planned"; appointmentNumber: number; date: string | null }        // untouched rows on a LATER visit → use Hold
  | { kind: "earlier_visit_open"; technicianName: string; appointmentNumber: number } // the caller's visit is later than the active visit
  | { kind: "request_not_started"; status: RequestStatus }
  | { kind: "not_lead" }
  | { kind: "managed_externally" };
export interface ResolveInput { action: TechAction; row: TechAssignmentRow; requestStatus: RequestStatus; activeVisitId: string | null; activeLeadId: string | null; native: boolean }
export type Resolved =
  | { kind: "noop" }
  | { kind: "refuse"; reason: "not_lead" | "invalid_transition" | "managed_externally" | "not_tech_target" | "request_not_started" | "not_started_row" }
  | { kind: "write"; assignmentTo: RequestStatus; stamp: "enRouteAt"|"arrivedAt"|"startedAt"|"completedAt"|null; requestTo: RequestStatus | null; timeEntry: "open"|"close"|"none" }
  | { kind: "hold" }        // active-lead hold: the visit ends (Task 4b holdVisit)
  | { kind: "request_only"; requestTo: RequestStatus }   // row already at target, request behind
  | { kind: "close_out" };
export function resolveTechAction(i: ResolveInput): Resolved
export function allowedActions(i: Omit<ResolveInput,"action">): readonly TechAction[]
export function closeOutAllowedStatuses(): readonly RequestStatus[]   // every s with canTransition(s, "completed") = in_progress, on_hold
```
Rules (evaluated in this order): `isActiveLead = i.row.isLead && i.row.appointmentId === i.activeVisitId`; non-native → refuse `managed_externally`; `close_out` and `on_hold` (hold) are resolved FIRST — active lead only (else `not_lead`), never a row-equality no-op, no row transition check; hold additionally requires `canTransition(requestStatus, "on_hold")` (else `invalid_transition`) and `holdReason` present (the route 400s without it); `en_route|arrived|in_progress|completed` → `assignmentTo` = action, stamp per action; `completed` additionally requires `row.startedAt !== null` (else `not_started_row`); for the active lead, `completed` requires `requestStatus ∈ closeOutAllowedStatuses()` (else `request_not_started`); `pause` → `assignmentTo on_hold`, no request change; target equal to `row.status` AND the target's stamp already set (pause has no stamp: equality alone) → `noop` — unless the action is `en_route`/`arrived`/`in_progress` (never `completed`, never `pause`), the caller is the active lead and the request is behind (`requestStatus !== target && canTransition(requestStatus, target)`), which yields `{ kind: "request_only"; requestTo: target }`; otherwise `canTransition(row.status, target)` else `invalid_transition` (a row at the target with a missing stamp — the trigger mirrored it — passes: the CAS sets `status = $target` again and stamps it); `requestTo` = target when `isActiveLead` and action ∈ {en_route, arrived, in_progress} and `requestStatus !== target` and `canTransition(requestStatus, target)`; else null (a lead whose visit is later than the active visit gets `requestTo: null` — the writer adds the `earlier_visit_open` blocker); `timeEntry`: `open` when target ∈ {arrived, in_progress}; `close` when target ∈ {on_hold, completed}; else `none` (both statements are idempotent — `ON CONFLICT DO NOTHING` / a 0-row UPDATE — so no pre-read of open entries). `allowedActions` filters `TECH_ACTIONS` through `resolveTechAction` ≠ refuse/noop (so `request_only` keeps the button visible), plus `close_out` for the active lead when their row is `completed` or open.

- [ ] Steps: failing tests pinning every rule above (helper completed → requestTo null; helper hold → not_lead; active lead hold → hold, even when the lead's row is `on_hold` (paused) or `completed`; a visit-#2 lead while #1 is active → `not_lead` on hold; lead hold with request `pending` → `invalid_transition`; lead `in_progress` with row `in_progress` + `startedAt` set and request `arrived` → `request_only`; lead `completed` with row `completed` + stamp and request `in_progress` → `noop` (never request_only); lead `pause` with row `on_hold` → `noop`; row `in_progress` with `startedAt` null (mirrored) → `write`; lead completed with request `arrived` → `request_not_started`; completed without startedAt → `not_started_row`; non-native; noop; invalid_transition `pending→arrived`; time-entry matrix; lead on a later visit → write with requestTo null; `allowedActions` for a completed lead row includes `close_out`) → implement → gates → commit `feat(tech): pure status action resolution`.

---

### Task 4b: Batch writer, hold, close-out, routes, admin paths

**Files:**
- Create: `src/lib/tech/status-writes.ts`, `src/lib/tech/status-writes.test.ts` (mock `db.batch`: assert statement count/order and that statements 2–3 contain `pg_current_xact_id`)
- Modify: `src/app/api/tech/jobs/[id]/status/route.ts`; `src/app/api/tech/jobs/[id]/route.ts` + `src/app/tech/jobs/[id]/page.tsx` (`?visit=` → `?appointmentId=` → `getTechJobSummary(org, tech, id, appointmentId?)`; update `route.test.ts`); `src/lib/tech/field-queries.ts` `getTechJobSummary` (returns `assignment`, `isActiveLead`, `allowedActions`, `blockers`, `native`, `requestStatus`, keeps `allowedNextStatuses` for the old UI until Task 6)
- Modify: `src/app/api/admin/requests/[id]/route.ts` (status branch ~165–176) + `src/lib/admin/queries.ts`: admin `on_hold` on a native request → `holdVisit` (same batch as the lead; `actorUserId` admin); admin `completed` on a native request → `completeRequestFromAdmin` (one batch: (0) lock; (1) `WITH prev AS (SELECT status FROM service_requests WHERE id=$rid AND organization_id=$org) UPDATE service_requests s SET status='completed', completed_at=now(), hold_reason=NULL, follow_up_date=NULL, updated_at=now() FROM prev WHERE s.id=$rid AND s.organization_id=$org AND s.status IN ('in_progress','on_hold') AND NOT EXISTS (open row WITH progress on a non-cancelled visit) RETURNING prev.status AS from_status`; (2) gated on the request xmin: `UPDATE appointment_assignments a SET status='cancelled' FROM appointments p WHERE p.id=a.appointment_id AND p.service_request_id=$rid AND a.status IN (open)` — untouched rows are cancelled so no open row survives on a completed request, matching the tech close-out invariant; (3) `closeJobEntriesSql({ organizationId, requestId })` (all technicians, same xmin gate); a returned row → `recordStatusEvent(from → completed, actorType human, actorId admin)` (KPIs/payroll keep admin completions); 0 rows → re-read: 409 `CLOSE_OUT_BLOCKED` with plain copy "A technician is still working this job." + blockers (progressed open rows), or 409 `INVALID_TRANSITION` with today's copy and `currentStatus` when the status is not in_progress/on_hold); synced requests keep today's `updateRequestStatus` path untouched; visit-#1 progress guard = `NOT EXISTS (SELECT 1 FROM appointment_assignments a JOIN appointments p ON p.id = a.appointment_id WHERE p.service_request_id = <id> AND p.appointment_number = 1 AND (a.en_route_at IS NOT NULL OR a.arrived_at IS NOT NULL OR a.started_at IS NOT NULL OR a.completed_at IS NOT NULL))` added atomically to the guarded UPDATEs of `scheduleRequest`, `assignTechnician`, `reassignTechnician` (`queries.ts` ~483/631/886), `placeAndAssignRequest` (`src/lib/admin/scheduling-queries.ts` ~598, UPDATE ~768–790) and `unscheduleRequest` (`scheduling-queries.ts` ~907), each returning a new `has_progress` reason that the admin PATCH schedule branch (`route.ts` ~252), `assign/route.ts` (~55, ~145), `reschedule/route.ts` (~94) and `unschedule/route.ts` (~42) map to 409 `HAS_PROGRESS` "A technician has already started this visit."; a `has_progress` classification is a re-read after a 0-row update (CAS miss first). The same five writers also refuse `visit_ended` → 409 `VISIT_ENDED` "This visit has ended. Add a new visit instead." when visit #1 has `cancelled_at` set while the request is not cancelled (a hold ended it; the office resumes through the Visits section, never by rewriting #1).

**Interfaces (`status-writes.ts`):**
```ts
export async function applyTechAction(p: { organizationId; techUserId; requestId; row: TechAssignmentRow; resolved: Extract<Resolved,{kind:"write"|"request_only"}>; requestStatus: RequestStatus; activeVisitId: string | null }): Promise<{ ok: true; assignmentStatus: RequestStatus; requestStatus: RequestStatus; requestBehind: boolean } | { ok: false; reason: "stale" }>
export async function holdVisit(p: { organizationId; actorUserId; requestId; appointmentId: string | null; holdReason: HoldReason | null; followUpDate: Date | null; requestStatus: RequestStatus }): Promise<{ ok: true } | { ok: false; reason: "stale" | "invalid_transition" }>   // tech route requires holdReason (400 without); admin route passes its existing `holdReason ?? null`
export async function closeOutRequest(p: { organizationId; techUserId; requestId; row: TechAssignmentRow }): Promise<{ ok: true; changed: boolean } | { ok: false; assignmentStatus: RequestStatus; blockers: Blocker[] }>
export async function completeRequestFromAdmin(p: { organizationId; actorUserId; requestId }): Promise<{ ok: true; changed: boolean } | { ok: false; reason: "blocked"; blockers: Blocker[] } | { ok: false; reason: "invalid_transition"; currentStatus: RequestStatus }>
export async function closeOutBlockers(organizationId: string, requestId: string, caller?: { technicianId; appointmentId }): Promise<Blocker[]>
```
`applyTechAction` batch (in order): (0) `SELECT 1 FROM service_requests WHERE id = $rid AND organization_id = $org FOR UPDATE` (lock order, see Global Constraints — every batch below starts with it); (1) `UPDATE appointment_assignments SET status = $to, <stamp> = COALESCE(<stamp>, now()) WHERE id = $aid AND organization_id = $org AND status = $expected RETURNING id`; (2) only when `requestTo`: `UPDATE service_requests SET status = $to, completed_at = NULL, hold_reason = NULL, follow_up_date = NULL, updated_at = now() WHERE id = $rid AND organization_id = $org AND status = $from AND fieldpulse_job_id IS NULL AND hcp_job_id IS NULL AND EXISTS (SELECT 1 FROM appointment_assignments a WHERE a.id = $aid AND a.xmin = pg_current_xact_id()::xid) RETURNING status`; (3) `openJobEntrySql` / `closeJobEntriesSql({ technicianIds: [me], gate: sql\`EXISTS (SELECT 1 FROM appointment_assignments a WHERE a.id = ${aid} AND a.xmin = pg_current_xact_id()::xid)\` })` / nothing. After the batch: statement 1 returned 0 rows → re-read the row: at target → `{ ok: true, …, requestBehind }` no-op; else `stale`. Statement 2 returned a row → `recordStatusEvent({ fromStatus: $from, toStatus, actorType: "human", actorId: me })`; `requestBehind = (Boolean(requestTo) && !updatedRequest) || (row.isLead && row.appointmentId !== activeVisitId)` (the later-visit lead sees the notice and the `earlier_visit_open` blocker). For `resolved.kind === "request_only"`: batch = [(0) lock] + [the request UPDATE with its EXISTS gate replaced by `EXISTS (SELECT 1 FROM appointment_assignments a WHERE a.id = $aid AND a.status = $to)`]; event when it returned a row; 0 rows → `requestBehind: true` 200.
`holdVisit` (pre-check `canTransition(requestStatus, "on_hold")`, else `invalid_transition`) batch: (0) lock request, (0b) lock the visit row; (1) gated on `EXISTS (SELECT 1 FROM service_requests r WHERE r.id=$rid AND r.status IN ('scheduled','assigned','en_route','arrived','in_progress') AND r.fieldpulse_job_id IS NULL AND r.hcp_job_id IS NULL)`: `UPDATE appointment_assignments SET status = CASE WHEN (en_route_at IS NOT NULL OR arrived_at IS NOT NULL OR started_at IS NOT NULL OR completed_at IS NOT NULL) THEN 'completed'::request_status ELSE 'cancelled'::request_status END, completed_at = CASE WHEN … progress … THEN COALESCE(completed_at, now()) ELSE completed_at END WHERE appointment_id = $appt AND organization_id = $org AND status IN (open) RETURNING id, technician_id` (0 rows is fine: a lead who already tapped done can still hold); (2) `UPDATE service_requests SET status='on_hold', hold_reason=$r, follow_up_date=$d, updated_at=now() WHERE id=$rid AND organization_id=$org AND status IN ('scheduled','assigned','en_route','arrived','in_progress') AND fieldpulse_job_id IS NULL AND hcp_job_id IS NULL AND NOT EXISTS (SELECT 1 FROM appointment_assignments a WHERE a.appointment_id = $appt AND a.status IN (open)) RETURNING (SELECT status FROM prev)` written as `WITH prev AS (SELECT status FROM service_requests WHERE id=$rid) UPDATE … FROM prev … RETURNING prev.status AS from_status` (no `status=$from`: the lock serialises writers; post-condition gate, not xmin); (3) `closeJobEntriesSql({ technicianIds: <all technicians on the visit> })` with the same NOT EXISTS gate; (4) `UPDATE appointments SET cancelled_at = now(), version = version + 1, updated_at = now() WHERE id = $appt AND cancelled_at IS NULL AND NOT EXISTS (SELECT 1 FROM appointment_assignments a WHERE a.appointment_id = $appt AND a.status <> 'cancelled')` (a visit where nobody started ends as a cancelled visit, so it never becomes the active visit). After: event `from → on_hold` when (2) returned a row; (2) empty → re-read: `on_hold` → `{ ok: true }` idempotent, else `stale`. Admin hold = the same function with `actorUserId` = admin; with no active visit (`pickActiveVisit` null) the batch is [(0), (2) without the NOT EXISTS gate].
`closeOutRequest` batch: (0) lock; (1) `UPDATE appointment_assignments SET status='completed', completed_at=COALESCE(completed_at, now()) WHERE id=$aid AND organization_id=$org AND status IN (open) AND started_at IS NOT NULL AND EXISTS (SELECT 1 FROM service_requests r WHERE r.id=$rid AND r.status IN ('in_progress','on_hold'))`; (2) `WITH prev AS (SELECT status FROM service_requests WHERE id=$rid AND organization_id=$org FOR UPDATE) UPDATE service_requests s SET status='completed', completed_at=now(), hold_reason=NULL, follow_up_date=NULL, updated_at=now() FROM prev WHERE s.id=$rid AND s.status IN ('in_progress','on_hold') AND s.fieldpulse_job_id IS NULL AND s.hcp_job_id IS NULL AND NOT EXISTS (SELECT 1 FROM appointment_assignments a JOIN appointments p ON p.id=a.appointment_id WHERE p.service_request_id=$rid AND p.cancelled_at IS NULL AND a.status IN (open)) RETURNING prev.status AS from_status`; (3) `closeJobEntriesSql({ technicianIds: [me] })` gated on `EXISTS (SELECT 1 FROM appointment_assignments a WHERE a.id = $aid AND a.status = 'completed')` (never closes a working lead's entry when close-out is refused before their done). After: (2) returned → `recordStatusEvent(from → completed, actor me)` → `{ changed: true }` (the ROUTE then calls `after(() => createReviewRequest(org, rid, customerId))` exactly as today, only when `changed`); (2) empty → re-read: `completed` → `{ changed: false }`; else `{ ok: false, assignmentStatus, blockers: await closeOutBlockers(...) }` (the 409 body carries the row's new status since statement 1 may have landed; blockers: open rows with names — the caller's own untouched row reads as `request_not_started`-style "Tap Working first", never "<self> is still working"; `visit_planned` for untouched rows on later visits; `request_not_started` whenever `!closeOutAllowedStatuses().includes(requestStatus)`, i.e. pending/scheduled/assigned/en_route/arrived too).
Pre-checks before any batch: `findReadableJob` (404), native (409 `MANAGED_EXTERNALLY`), the row by `appointmentId` from `findTechAssignments` (404), `findAllAssignments` → `pickActiveVisit`, `isActiveLead`.

Route body: `z.object({ appointmentId: z.uuid().optional(), action: z.enum(TECH_ACTIONS).optional(), status: z.enum([...]).optional(), expectedStatus: z.enum(requestStatusEnum.enumValues).optional(), holdReason: z.enum(HOLD_REASONS).optional(), followUpDate: z.string().datetime().optional() })` via `readJsonBody`; legacy `{ status }` (old UI until Task 6) → `on_hold` maps to `pause`, `completed` from the active lead with no other open row maps to `close_out`, otherwise `action = status`; `action: "on_hold"` without `holdReason` → 400; `expectedStatus` when given replaces the read status in the CAS. Until Task 6, `getTechJobSummary.allowedNextStatuses` is built from the CALLER'S ROW status (not the request's), minus `scheduled` and `cancelled`, so the old buttons still advance the row (Tasks 4b and 6 ship in one push regardless). Responses: 200 `{ assignmentStatus, requestStatus, requestBehind, allowedActions, blockers, changed? }`; 400 `NOT_TECH_TARGET` for cancelled/scheduled; 403 `NOT_LEAD` "Only the lead technician can do that."; 409 `INVALID_TRANSITION` (existing copy), `MANAGED_EXTERNALLY`, `STALE` "This job changed. Refresh and try again.", `CLOSE_OUT_BLOCKED` (+ blockers), `REQUEST_NOT_STARTED` "Tap Working before marking done."

- [ ] **Step 1: Failing tests** (`status-writes.test.ts` with `db.batch` mocked to capture statements, rendered via `PgDialect`): `applyTechAction` for a lead `in_progress` → 4 statements [lock, CAS, request UPDATE containing `pg_current_xact_id`, INSERT containing `ON CONFLICT (service_request_id, technician_id) WHERE clock_out_at IS NULL DO NOTHING`]; a helper `in_progress` → 3 statements and no `service_requests` UPDATE; `request_only` → [lock, request UPDATE with `a.status =`]; `closeOutRequest` → statement 2 has the NOT EXISTS predicate, `completed_at = now()`, `hold_reason = NULL`, and statement 3 is gated on `status = 'completed'`; `holdVisit` → the CASE statement, the request UPDATE with `hold_reason` and `NOT EXISTS`, the appointments `cancelled_at` statement; `completeRequestFromAdmin` → the cancel-untouched-rows statement gated on xmin.
- [ ] **Step 2: Implement** writer + route + `getTechJobSummary` fields + the admin paths.
- [ ] **Step 3: Probes (Review Focus 1–3)** on a throwaway native request R scheduled today with lead T1 (`assigned_to`) and helper T2 added via the Task 2 endpoint; tokens for T1 and T2: T2 `close_out` → 403; T2 `cancelled` → 400; T1 `en_route` → request `en_route`, 1 event; T2 `en_route` → T2 row en_route, request unchanged, still 1 event; both `arrived`, both `in_progress` (request `in_progress`; auto entries open for both: `clock_in_method='auto'`); T1 `completed` → T1 row completed + entry closed, request `in_progress`; T1 `close_out` → 409 with `technician_open` T2 and no new event/review; T2 `completed`; `Promise.all` of two T1 `close_out` → one 200 `changed:true` + one 200 `changed:false` (or both 200 with exactly one `changed:true`), `completed_at` set, `hold_reason` NULL, exactly one `completed` event, one review request; double `in_progress` tap in `Promise.all` on a fresh request → one write, one no-op, one open entry. Hold: new request, T1 `in_progress`, T2 untouched; T1 `{ action: "on_hold", holdReason: "awaiting_parts" }` → request `on_hold` + reason, T1 row `completed`, T2 row `cancelled`, entries closed, visit #1 NOT cancelled (T1 had progress); a second hold on a fresh request where T1 already tapped done and T2 is paused → 200, request `on_hold`; a hold where nobody started → visit `cancelled_at` set; then `PATCH` admin `{"status":"in_progress"}` on that on_hold request → T1's cancelled row stays `cancelled` (trigger step 4 skips non-open rows). "Whichever is behind": set the request to `arrived` via SQL while T1's row is `in_progress` with `started_at` → T1 taps `in_progress` → 200, request `in_progress`, one event. Admin: `PATCH /api/admin/requests/<R>` `{"status":"on_hold","holdReason":"awaiting_parts"}` on a request with a working lead → same outcome; `{"status":"completed"}` with a working lead → 409 `CLOSE_OUT_BLOCKED`; `{"status":"completed"}` with lead done and an untouched helper → 200, helper row `cancelled`, no open row remains; `POST …/reschedule`, `POST …/unschedule`, `POST …/assign` and PATCH `{ schedule }` on a request whose visit #1 has progress → 409 `HAS_PROGRESS`. Live-probe `holdVisit` and `completeRequestFromAdmin` first (enum casts). Clean up all throwaway data.
- [ ] **Step 4: Gates + commit** `feat(tech): per-technician status taps, hold ends the visit, lead-only close-out; admin paths follow the same rules`.

---

### Task 5: The tech list by visit — today / upcoming / past

**Files:** `src/lib/tech/visit-range.ts` (+ test: `classifyVisit(row, businessTodayIso) → "today" | "upcoming" | "past" | "hidden"`), `src/app/api/tech/jobs/route.ts`, `src/components/tech/tech-jobs-list-client.tsx`.

Query: `appointmentAssignments` ⋈ `appointments` ⋈ `serviceRequests` under `withTenant(appointmentAssignments, org, eq(technicianId, me))`, excluding cancelled visits, rows `cancelled` without progress (they 404 on tap), and for today/upcoming requests whose status is `completed`/`cancelled`; visit window = `COALESCE(appointments.starts_at, service_requests.arrival_window_start)` / end likewise; `scheduledDate = COALESCE(appointments.scheduled_date, service_requests.scheduled_date)`; `classifyVisit`: terminal rows (`completed`/`cancelled`) → `past` when `COALESCE(row.completedAt, scheduledDate) >= now − 30 days`, else `hidden` (cancelled visits are excluded from the query, consistent with the read rule); open rows: date on the business day (`businessTodayIso` from `src/lib/admin/availability-queries.ts:90`; the pure test takes the ISO string as an argument) OR date before today (overdue, still reachable) OR no date → `today`; date after today → `upcoming`; response rows gain `appointmentId`, `appointmentNumber`, `assignmentStatus`, `isLead`; decrypt address/name as today. Client: three tabs; the card links to `/tech/jobs/<id>?visit=<appointmentId>`; Review Focus 3's "the visit no longer shows under today after cancel" is probed here.

- [ ] Steps: tests → implement → probe each range → `node scripts/agent/screenshot-page.mjs /tech/jobs 390 /tmp/tech-list.png --tech` and look → gates → commit `feat(tech): visits list with today, upcoming and past`.

---

### Task 6: Close-out sheet and actions in the job summary

**Files:** `src/components/tech/close-out-sheet.tsx` (`Sheet side="bottom"` from `src/components/ui/sheet.tsx`: large buttons Done / Pause / Hold (reason select from `HOLD_REASONS` + optional follow-up date; copy explains the visit ends) / Close out (active lead only); blocked state lists `blockers` in plain words — "Ben is still working", "Visit #2 on Nov 12 is planned — put this job on hold", "Tap Working first"), `tech-job-summary.tsx` (buttons from `allowedActions` via `techStatusLabel` + "Pause", "Hold", "Close out"; "Managed in FieldPulse" notice when `!native`; drop `allowedNextStatuses`), `tech-status-confirm.ts` (+ test), `tech-job-detail-client.tsx` (refresh after an action; `requestBehind` notice "Your status is saved; the request is waiting on an earlier visit").

- [ ] Steps: label tests → implement → Playwright at 390 as T1 on a working job: open the sheet, screenshot; Hold with a reason, screenshot; look at both → gates → commit `feat(tech): close-out sheet with done, pause, hold and close out`.

---

### Task 7: Clock button + minimal admin timesheets

**Files:** `tech-jobs-list-client.tsx` (Clock in / Clock out header button on `/api/tech/time`), `src/app/api/admin/timesheets/route.ts` (GET `?technicianId=&from=&to=` → `{ entries: [{ id, kind, clockInAt, clockOutAt, minutes, laborCostCents, referenceNumber | null, appointmentNumber | null, clockInMethod }] }` ordered by `clockInAt` desc, ≤ 500 rows, UUID + range checks, `adminRead` limit), `src/components/admin/timesheets-dialog.tsx` (date range, grouped by business day, general rows labelled "General"), `src/components/admin/staff-table.tsx` (`onTimeOff` at ~25/141 is the pattern) + `src/app/admin/(dashboard)/staff/page.tsx` (row action "Timesheets" wired like "Time off").

- [ ] Steps: implement → probe GET → screenshot 1440 → gates → commit `feat(staff): technician timesheets with general time`.

---

### Task 8: Visit-edit guards + docs

**Files:** `src/lib/admin/appointment-queries.ts` (+ test): `updateAppointment` → `{ reason: "has_progress" }` (add to `UpdateAppointmentResult` only; `classifyMiss` checks progress behind a flag; `case "has_progress"` → 409 `HAS_PROGRESS` "A technician has already started this visit." in `[aid]/route.ts`) and the CAS gains `AND NOT EXISTS (progressed row)`; `addAppointment` refuses `completed` requests (`{ reason: "request_completed" }` → 409 `REQUEST_COMPLETED` "This request is already completed."); `cancelAppointment` adds `closeJobEntriesSql` for the visit's technicians to its batch and its assignment UPDATE gains `AND status NOT IN ('completed','cancelled')` (today it turns completed rows into cancelled). Docs: `page-tech` (ownership, actions, hold semantics, close-out, time), `page-staff` (timesheets), `page-requests` (`HAS_PROGRESS`, `REQUEST_COMPLETED`, admin hold/complete rules, visit helpers), `admin-pages`; `replica/features.csv` rows 115, 118, 120, 137, 138 → `yes`; `parity.md`; `build-log.md` S37/S38/S25 lines.

- [ ] Steps: failing test → implement → probe (Review Focus 5) → docs → `verify-skills` 0 missing → gates → commit `feat(requests): visits with progress are locked; M3a docs and parity`.

---

## Self-review notes

- Spec coverage: migration + trigger v2 incl. entries (T1), ownership + visit helpers (T2), time SQL + general clock + KPI filter (T3), pure actions (T4a), writer/hold/close-out/routes/admin paths (T4b), list ranges (T5), sheet (T6), clock + S25 (T7), guards + docs (T8). Deferred per spec: en-route texts, required forms, GPS/backdating, offline, trigger step 4b (rejected: admin paths go through the app layer).
- Review Focus pins: 1–2 → T4b step 3; 3 → T1 step 5(c) + T4b step 3 (admin hold); 4 → T3; 5 → T8.
- Cross-task names: `TechAssignmentRow`, `pickActiveVisit`, `pickActiveAssignment`, `findAllAssignments`, `findTechAssignments`, `findActiveVisit`, `findReadableJob`, `techCanReadSql`, `openJobEntrySql`, `closeJobEntriesSql`, `resolveTechAction`, `allowedActions`, `closeOutAllowedStatuses`, `Blocker`, `applyTechAction`, `holdVisit`, `closeOutRequest`, `closeOutBlockers`, `completeRequestFromAdmin` — each defined once (T2, T3, T4a, T4b) and consumed by name.
