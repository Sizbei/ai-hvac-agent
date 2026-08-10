-- Re-author the durable last-admin guard trigger, deleted by the 2026-06-16
-- "squash migrations to a single baseline" commit (0cea181).
--
-- That squash removed BOTH drizzle/0008_last_admin_guard.sql (original guard,
-- OLD.role = 'admin' only) and drizzle/0027_last_admin_guard_super_admin.sql
-- (which superseded it, extending the guard to admin-TIER roles — 'admin' AND
-- 'super_admin' — after a real super_admin-lockout bug). Neither survived into
-- the current 44-file migration set, so a freshly provisioned database (new
-- dev branch, disaster recovery, CI) gets ZERO database-level protection
-- against an organization losing its last admin — only the racy,
-- non-transactional app-level check in staff-queries.ts's updateStaff.
--
-- This reproduces 0027's body exactly (the CORRECT, superseding semantics —
-- NOT 0008's, which would reintroduce the super_admin-lockout bug 0027 fixed):
-- an org must retain at least one active admin-tier ('admin' OR 'super_admin')
-- user at all times. It fires per-row on any UPDATE that would remove
-- admin-tier access from an active admin-tier user (role demoted out of
-- admin-tier, or deactivated) and raises if no other active admin-tier user
-- remains in the same organization. All other updates pass untouched.
--
-- IDEMPOTENT: the function and trigger already exist on dev and prod (those
-- databases predate the squash) — CREATE OR REPLACE + DROP TRIGGER IF EXISTS
-- make this safe to run again with zero effective change, so the Vercel
-- build's auto-migrate does not fail against an already-guarded database.
--
-- Keep the 'last_active_admin' RAISE marker string exactly as-is:
-- staff-queries.ts's isLastAdminViolation matches on it to map the trigger's
-- exception back to the app's `last_admin` sentinel.

CREATE OR REPLACE FUNCTION enforce_last_active_admin()
RETURNS TRIGGER AS $$
BEGIN
  -- Only relevant when the row WAS an active admin-tier user and the update
  -- removes that (role demoted below admin-tier, or deactivated).
  IF OLD.role IN ('admin', 'super_admin') AND OLD.is_active = true
     AND (NEW.role NOT IN ('admin', 'super_admin') OR NEW.is_active = false) THEN
    IF (
      SELECT count(*)
      FROM users
      WHERE organization_id = OLD.organization_id
        AND role IN ('admin', 'super_admin')
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
