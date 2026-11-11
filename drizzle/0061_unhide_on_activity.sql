-- Go-live final fix (I1, M1, M6): real activity on hidden work brings it back
-- into the org's view. Additive and idempotent: CREATE OR REPLACE for 0059's
-- function (every 0059 branch kept), DROP TRIGGER IF EXISTS before every
-- CREATE TRIGGER. No column or table changes.
--
-- New in the function:
-- - service_requests / invoices: an UPDATE trigger can now fire on a HIDDEN row
--   (0059's only fire on visible ones), and then the row un-hides itself first.
-- - messages: the session's requests (and their customers) come back too.
--
-- No recursion: each un-hide SETs only hidden_from_org, and every trigger is
-- UPDATE OF other columns (status, scheduled_date, starts_at, state,
-- customer_id, service_request_id), so a flag-only UPDATE fires none of them.
-- Each WHEN also needs a real change (IS DISTINCT FROM), so a FieldPulse
-- re-sync that re-sets the same values fires nothing.
CREATE OR REPLACE FUNCTION unhide_parents() RETURNS trigger AS $$
DECLARE
  v_request_id uuid;
  v_session_id uuid;
  v_customer_id uuid;
BEGIN
  IF TG_TABLE_NAME = 'service_requests' THEN
    -- 0061 activity trigger: a hidden request with a change to a live status or a
    -- reschedule to yesterday or later.
    IF NEW.hidden_from_org THEN
      UPDATE service_requests SET hidden_from_org = false WHERE id = NEW.id AND hidden_from_org;
    END IF;
    UPDATE customers SET hidden_from_org = false WHERE id = NEW.customer_id AND hidden_from_org;
    UPDATE customer_sessions SET hidden_from_org = false WHERE id = NEW.session_id AND hidden_from_org;
  ELSIF TG_TABLE_NAME IN ('invoices', 'estimates') THEN
    -- 0061 reopen trigger: a hidden invoice that becomes open.
    IF TG_TABLE_NAME = 'invoices' AND NEW.hidden_from_org THEN
      UPDATE invoices SET hidden_from_org = false WHERE id = NEW.id AND hidden_from_org;
    END IF;
    UPDATE customers SET hidden_from_org = false WHERE id = NEW.customer_id AND hidden_from_org;
    v_request_id := NEW.service_request_id;
  ELSIF TG_TABLE_NAME = 'customer_sessions' THEN
    UPDATE customers SET hidden_from_org = false WHERE id = NEW.customer_id AND hidden_from_org;
  ELSIF TG_TABLE_NAME = 'messages' THEN
    SELECT customer_id INTO v_customer_id FROM customer_sessions WHERE id = NEW.session_id;
    UPDATE customer_sessions SET hidden_from_org = false WHERE id = NEW.session_id AND hidden_from_org;
    UPDATE customers SET hidden_from_org = false WHERE id = v_customer_id AND hidden_from_org;
    -- 0061 (M6): the session's requests, and their customers, come back too.
    UPDATE customers SET hidden_from_org = false
      WHERE id IN (SELECT sr.customer_id FROM service_requests sr WHERE sr.session_id = NEW.session_id AND sr.hidden_from_org)
        AND hidden_from_org;
    UPDATE service_requests SET hidden_from_org = false WHERE session_id = NEW.session_id AND hidden_from_org;
  ELSIF TG_TABLE_NAME = 'appointments' THEN
    v_request_id := NEW.service_request_id;
  END IF;

  -- invoices / estimates / appointments: the request, its session and its customer.
  IF v_request_id IS NOT NULL THEN
    SELECT session_id, customer_id INTO v_session_id, v_customer_id FROM service_requests WHERE id = v_request_id;
    UPDATE service_requests SET hidden_from_org = false WHERE id = v_request_id AND hidden_from_org;
    UPDATE customer_sessions SET hidden_from_org = false WHERE id = v_session_id AND hidden_from_org;
    UPDATE customers SET hidden_from_org = false WHERE id = v_customer_id AND hidden_from_org;
  END IF;

  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_unhide_on_activity ON service_requests;
--> statement-breakpoint
-- Technician or office activity (a real status change to a live status), or a
-- reschedule to yesterday or later (FieldPulse moves the job, or the office
-- does). Closing out old work (to completed or cancelled) never un-hides it, so
-- tidying FieldPulse doesn't bring history back.
CREATE TRIGGER trg_unhide_on_activity
  AFTER UPDATE OF status, scheduled_date ON service_requests
  FOR EACH ROW
  WHEN (NEW.hidden_from_org AND ((OLD.status IS DISTINCT FROM NEW.status AND NEW.status NOT IN ('completed'::request_status, 'cancelled'::request_status)) OR (NEW.scheduled_date IS DISTINCT FROM OLD.scheduled_date AND NEW.scheduled_date >= now() - interval '1 day')))
  EXECUTE FUNCTION unhide_parents();
--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_unhide_on_reschedule ON appointments;
--> statement-breakpoint
-- A live visit whose date really moves to yesterday or later. The visit's time
-- is starts_at, else its date-only scheduled_date (as the marking reads it).
CREATE TRIGGER trg_unhide_on_reschedule
  AFTER UPDATE OF scheduled_date, starts_at ON appointments
  FOR EACH ROW
  WHEN (NEW.cancelled_at IS NULL AND (OLD.scheduled_date IS DISTINCT FROM NEW.scheduled_date OR OLD.starts_at IS DISTINCT FROM NEW.starts_at) AND COALESCE(NEW.starts_at, NEW.scheduled_date) >= now() - interval '1 day')
  EXECUTE FUNCTION unhide_parents();
--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_unhide_on_reopen ON invoices;
--> statement-breakpoint
-- A hidden invoice that becomes open (sent, or reopened). invoice_state has no
-- partial value: a part-paid invoice is open with amount_paid_cents > 0.
CREATE TRIGGER trg_unhide_on_reopen
  AFTER UPDATE OF state ON invoices
  FOR EACH ROW
  WHEN (NEW.hidden_from_org AND OLD.state IS DISTINCT FROM NEW.state AND NEW.state = 'open'::invoice_state)
  EXECUTE FUNCTION unhide_parents();
