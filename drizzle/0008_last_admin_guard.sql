-- Durable last-admin guard.
--
-- The application layer (staff-queries.updateStaff) rejects demoting or
-- deactivating an org's last active admin, but neon-http has no transactions,
-- so two admins demoting each OTHER concurrently could both pass the
-- application check and leave the org with zero active admins. This trigger is
-- the authoritative backstop: it fires per-row on any UPDATE that would remove
-- admin access (role change away from 'admin', or deactivation) and raises if
-- no other active admin remains in the same organization.
--
-- It only blocks the lockout case; all other updates pass untouched.

CREATE OR REPLACE FUNCTION enforce_last_active_admin()
RETURNS TRIGGER AS $$
BEGIN
  -- Only relevant when the row WAS an active admin and the update removes that.
  IF OLD.role = 'admin' AND OLD.is_active = true
     AND (NEW.role <> 'admin' OR NEW.is_active = false) THEN
    IF (
      SELECT count(*)
      FROM users
      WHERE organization_id = OLD.organization_id
        AND role = 'admin'
        AND is_active = true
        AND id <> OLD.id
    ) = 0 THEN
      RAISE EXCEPTION 'last_active_admin: organization % must retain at least one active admin', OLD.organization_id
        USING ERRCODE = 'check_violation';
    END IF;
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
DROP TRIGGER IF EXISTS trg_enforce_last_active_admin ON users;
--> statement-breakpoint
CREATE TRIGGER trg_enforce_last_active_admin
  BEFORE UPDATE ON users
  FOR EACH ROW
  EXECUTE FUNCTION enforce_last_active_admin();
