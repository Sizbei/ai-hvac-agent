-- Go-live (Spears): per-org feature flags, hidden_from_org on the five history
-- tables, and the un-hide triggers. Idempotent throughout: ADD COLUMN IF NOT
-- EXISTS, a jsonb || merge for the seed, CREATE OR REPLACE for the function and
-- DROP TRIGGER IF EXISTS before every CREATE TRIGGER.
ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "feature_flags" jsonb DEFAULT '{}'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN IF NOT EXISTS "hidden_from_org" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "service_requests" ADD COLUMN IF NOT EXISTS "hidden_from_org" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "hidden_from_org" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "estimates" ADD COLUMN IF NOT EXISTS "hidden_from_org" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "customer_sessions" ADD COLUMN IF NOT EXISTS "hidden_from_org" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
-- Spears' live org starts with review requests and pay links off. The defaults
-- sit on the left of ||, so any value already set (a platform-owner toggle
-- before a retried run) wins, and re-running it changes nothing.
UPDATE organizations SET feature_flags = '{"reviewRequests":false,"payLinks":false}'::jsonb || feature_flags WHERE id = '00000000-0000-0000-0000-000000000001';
--> statement-breakpoint
-- A visible child attached to a hidden parent brings the parent back into the
-- org's view. Each un-hide only touches a row that is hidden, and none of them
-- changes customer_id/service_request_id, so no un-hide cascades further.
CREATE OR REPLACE FUNCTION unhide_parents() RETURNS trigger AS $$
DECLARE
  v_request_id uuid;
  v_session_id uuid;
  v_customer_id uuid;
BEGIN
  IF TG_TABLE_NAME = 'service_requests' THEN
    UPDATE customers SET hidden_from_org = false WHERE id = NEW.customer_id AND hidden_from_org;
    UPDATE customer_sessions SET hidden_from_org = false WHERE id = NEW.session_id AND hidden_from_org;
  ELSIF TG_TABLE_NAME IN ('invoices', 'estimates') THEN
    UPDATE customers SET hidden_from_org = false WHERE id = NEW.customer_id AND hidden_from_org;
    v_request_id := NEW.service_request_id;
  ELSIF TG_TABLE_NAME = 'customer_sessions' THEN
    UPDATE customers SET hidden_from_org = false WHERE id = NEW.customer_id AND hidden_from_org;
  ELSIF TG_TABLE_NAME = 'messages' THEN
    SELECT customer_id INTO v_customer_id FROM customer_sessions WHERE id = NEW.session_id;
    UPDATE customer_sessions SET hidden_from_org = false WHERE id = NEW.session_id AND hidden_from_org;
    UPDATE customers SET hidden_from_org = false WHERE id = v_customer_id AND hidden_from_org;
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
DROP TRIGGER IF EXISTS trg_unhide_parents ON service_requests;
--> statement-breakpoint
CREATE TRIGGER trg_unhide_parents
  AFTER INSERT ON service_requests
  FOR EACH ROW
  WHEN (NEW.hidden_from_org = false)
  EXECUTE FUNCTION unhide_parents();
--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_unhide_parents_on_update ON service_requests;
--> statement-breakpoint
-- UPDATE OF fires on unchanged values (FieldPulse re-sync re-SETs them), so the
-- WHEN clause limits every update trigger to a real change of a parent column.
CREATE TRIGGER trg_unhide_parents_on_update
  AFTER UPDATE OF customer_id ON service_requests
  FOR EACH ROW
  WHEN (NEW.hidden_from_org = false AND OLD.customer_id IS DISTINCT FROM NEW.customer_id)
  EXECUTE FUNCTION unhide_parents();
--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_unhide_parents ON invoices;
--> statement-breakpoint
CREATE TRIGGER trg_unhide_parents
  AFTER INSERT ON invoices
  FOR EACH ROW
  WHEN (NEW.hidden_from_org = false)
  EXECUTE FUNCTION unhide_parents();
--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_unhide_parents_on_update ON invoices;
--> statement-breakpoint
CREATE TRIGGER trg_unhide_parents_on_update
  AFTER UPDATE OF customer_id, service_request_id ON invoices
  FOR EACH ROW
  WHEN (NEW.hidden_from_org = false AND (OLD.customer_id IS DISTINCT FROM NEW.customer_id OR OLD.service_request_id IS DISTINCT FROM NEW.service_request_id))
  EXECUTE FUNCTION unhide_parents();
--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_unhide_parents ON estimates;
--> statement-breakpoint
CREATE TRIGGER trg_unhide_parents
  AFTER INSERT ON estimates
  FOR EACH ROW
  WHEN (NEW.hidden_from_org = false)
  EXECUTE FUNCTION unhide_parents();
--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_unhide_parents_on_update ON estimates;
--> statement-breakpoint
CREATE TRIGGER trg_unhide_parents_on_update
  AFTER UPDATE OF customer_id, service_request_id ON estimates
  FOR EACH ROW
  WHEN (NEW.hidden_from_org = false AND (OLD.customer_id IS DISTINCT FROM NEW.customer_id OR OLD.service_request_id IS DISTINCT FROM NEW.service_request_id))
  EXECUTE FUNCTION unhide_parents();
--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_unhide_parents ON customer_sessions;
--> statement-breakpoint
CREATE TRIGGER trg_unhide_parents
  AFTER INSERT ON customer_sessions
  FOR EACH ROW
  WHEN (NEW.hidden_from_org = false)
  EXECUTE FUNCTION unhide_parents();
--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_unhide_parents_on_update ON customer_sessions;
--> statement-breakpoint
CREATE TRIGGER trg_unhide_parents_on_update
  AFTER UPDATE OF customer_id ON customer_sessions
  FOR EACH ROW
  WHEN (NEW.hidden_from_org = false AND OLD.customer_id IS DISTINCT FROM NEW.customer_id)
  EXECUTE FUNCTION unhide_parents();
--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_unhide_from_message ON messages;
--> statement-breakpoint
CREATE TRIGGER trg_unhide_from_message
  AFTER INSERT ON messages
  FOR EACH ROW
  EXECUTE FUNCTION unhide_parents();
--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_unhide_from_appointment ON appointments;
--> statement-breakpoint
CREATE TRIGGER trg_unhide_from_appointment
  AFTER INSERT ON appointments
  FOR EACH ROW
  WHEN (NEW.cancelled_at IS NULL)
  EXECUTE FUNCTION unhide_parents();
