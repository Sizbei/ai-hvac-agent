-- Extend the durable last-admin guard to admin-TIER roles.
--
-- Migration 0008 added a trigger that prevents an org from losing its last
-- active 'admin'. Now that a 'super_admin' role exists (the top admin tier), the
-- guard must treat BOTH 'admin' and 'super_admin' as admin-tier: an org must
-- never be left with zero active admin-tier users. Without this, an org whose
-- only privileged user is a super_admin (e.g. the seeded owner) could be demoted
-- or deactivated into a lockout, and a super_admin would not "count" as an admin
-- for the backstop.
--
-- This REPLACES the trigger function in place (same trigger name) so the change
-- is a pure function-body swap — no trigger drop/recreate churn.

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
