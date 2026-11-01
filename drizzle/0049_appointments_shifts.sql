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
  v_has_progress boolean;
BEGIN
  v_old_assigned := CASE WHEN TG_OP = 'UPDATE' THEN OLD.assigned_to ELSE NULL END;

  -- 0. Cancelling the request cancels every visit (frees the calendar and
  --    capacity). Runs first so it also covers requests with no visit #1.
  IF NEW.status = 'cancelled' THEN
    UPDATE appointments SET cancelled_at = COALESCE(cancelled_at, now()),
        version = version + 1, updated_at = now()
      WHERE service_request_id = NEW.id AND cancelled_at IS NULL;
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
        UPDATE appointment_assignments SET is_lead = false, status = 'cancelled'
          WHERE appointment_id = v_appt_id AND is_lead;
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
  --    cancelled_at follows the request: the FieldPulse import can reopen a
  --    cancelled request, so a non-cancelled status clears it on #1.
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
DROP TRIGGER IF EXISTS service_requests_sync_appointment_ins ON service_requests;
--> statement-breakpoint
CREATE TRIGGER service_requests_sync_appointment_ins
  AFTER INSERT ON service_requests
  FOR EACH ROW EXECUTE FUNCTION sync_request_appointment();
--> statement-breakpoint
DROP TRIGGER IF EXISTS service_requests_sync_appointment_upd ON service_requests;
--> statement-breakpoint
-- UPDATE OF fires on unchanged values (the FieldPulse sync rewrites every row
-- nightly), so the WHEN clause limits it to real changes.
CREATE TRIGGER service_requests_sync_appointment_upd
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
  AND NOT EXISTS (SELECT 1 FROM appointments a WHERE a.service_request_id = r.id AND a.appointment_number = 1)
ON CONFLICT ("service_request_id","appointment_number") DO NOTHING;
--> statement-breakpoint
INSERT INTO appointment_assignments (organization_id, appointment_id, technician_id, is_lead, status, assigned_at)
SELECT r.organization_id, a.id, r.assigned_to, true, r.status, r.updated_at
FROM service_requests r
JOIN appointments a ON a.service_request_id = r.id AND a.appointment_number = 1
WHERE r.assigned_to IS NOT NULL
ON CONFLICT ("appointment_id","technician_id") DO NOTHING;
