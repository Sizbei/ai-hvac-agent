-- M3d Forms: office-built job forms, per-visit submissions, and the visit
-- trigger keeping a visit that has a submission. Idempotent throughout (one DO
-- block per constraint so a partial re-run adds the rest).
CREATE TABLE IF NOT EXISTS "forms" (
	"id" uuid PRIMARY KEY NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"fields" jsonb NOT NULL,
	"job_type_ids" uuid[] DEFAULT '{}'::uuid[] NOT NULL,
	"required" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"version" integer DEFAULT 1 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "form_submissions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"form_id" uuid NOT NULL,
	"service_request_id" uuid NOT NULL,
	"appointment_id" uuid NOT NULL,
	"form_name" text NOT NULL,
	"form_version" integer NOT NULL,
	"fields" jsonb NOT NULL,
	"values_encrypted" text,
	"status" text DEFAULT 'draft' NOT NULL,
	"revision" integer DEFAULT 0 NOT NULL,
	"last_save_id" uuid,
	"submit_key" uuid,
	"started_by" uuid,
	"updated_by" uuid,
	"submitted_by" uuid,
	"submitted_at" timestamp with time zone,
	"erased_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "forms" ADD CONSTRAINT "forms_fields_array_check" CHECK (jsonb_typeof("forms"."fields") = 'array');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "forms" ADD CONSTRAINT "forms_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "forms" ADD CONSTRAINT "forms_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "form_submissions" ADD CONSTRAINT "form_submissions_fields_array_check" CHECK (jsonb_typeof("form_submissions"."fields") = 'array');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "form_submissions" ADD CONSTRAINT "form_submissions_status_check" CHECK ("form_submissions"."status" IN ('draft','submitted'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "form_submissions" ADD CONSTRAINT "form_submissions_revision_check" CHECK ("form_submissions"."revision" >= 0);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "form_submissions" ADD CONSTRAINT "form_submissions_submitted_check" CHECK (("form_submissions"."status" = 'submitted') = ("form_submissions"."submitted_at" IS NOT NULL));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "form_submissions" ADD CONSTRAINT "form_submissions_erased_check" CHECK ("form_submissions"."erased_at" IS NULL OR "form_submissions"."values_encrypted" IS NULL);
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "form_submissions" ADD CONSTRAINT "form_submissions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "form_submissions" ADD CONSTRAINT "form_submissions_form_id_forms_id_fk" FOREIGN KEY ("form_id") REFERENCES "public"."forms"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "form_submissions" ADD CONSTRAINT "form_submissions_service_request_id_service_requests_id_fk" FOREIGN KEY ("service_request_id") REFERENCES "public"."service_requests"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "form_submissions" ADD CONSTRAINT "form_submissions_appointment_id_appointments_id_fk" FOREIGN KEY ("appointment_id") REFERENCES "public"."appointments"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "form_submissions" ADD CONSTRAINT "form_submissions_started_by_users_id_fk" FOREIGN KEY ("started_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "form_submissions" ADD CONSTRAINT "form_submissions_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "form_submissions" ADD CONSTRAINT "form_submissions_submitted_by_users_id_fk" FOREIGN KEY ("submitted_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "forms_org_active_idx" ON "forms" USING btree ("organization_id","active");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "forms_org_name_active_unique" ON "forms" USING btree ("organization_id",lower("name")) WHERE "forms"."active";
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "form_submissions_visit_form_unique" ON "form_submissions" USING btree ("appointment_id","form_id","service_request_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "form_submissions_org_request_idx" ON "form_submissions" USING btree ("organization_id","service_request_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "form_submissions_form_idx" ON "form_submissions" USING btree ("form_id");
--> statement-breakpoint
-- Trigger v3: 0050's body VERBATIM except one predicate. v_has_progress also
-- counts any form_submissions row on visit #1 (an empty draft included), so an
-- unassigned, undated request keeps a visit that holds answers (times nulled,
-- lead demoted) instead of deleting it. A render test diffs this body against
-- drizzle/0050_m3a_run_the_day.sql and allows only that line.
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
      ) OR EXISTS (SELECT 1 FROM form_submissions s WHERE s.appointment_id = v_appt_id) INTO v_has_progress;
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
