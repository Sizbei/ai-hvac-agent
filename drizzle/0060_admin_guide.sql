-- Onboarding D1: per-user admin guide state (welcome dismissed, quick tour
-- progress). Nullable with no default, so the ALTER is metadata-only; IF NOT
-- EXISTS makes a re-run after a failed deploy a no-op.
ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "admin_guide_state" jsonb;
