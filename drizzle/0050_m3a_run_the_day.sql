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
    -- Only an OPEN untouched row is mirrored, and never to a terminal value: a
    -- row a hold has cancelled must stay cancelled, and request 'completed'
    -- leaves rows alone (rule d).
    IF NEW.status NOT IN ('completed','cancelled') THEN
      UPDATE appointment_assignments SET status = NEW.status
        WHERE appointment_id = v_appt_id AND technician_id = NEW.assigned_to AND is_lead
          AND status IN ('assigned','scheduled','en_route','arrived','in_progress','on_hold')
          AND en_route_at IS NULL AND arrived_at IS NULL
          AND started_at IS NULL AND completed_at IS NULL;
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
