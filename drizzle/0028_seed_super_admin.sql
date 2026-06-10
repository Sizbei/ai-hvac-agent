-- Provision rchen.workmail@gmail.com as a super_admin (Google-only, no password)
-- in the demo organization. Idempotent: if the row exists it is promoted +
-- reactivated; otherwise it is created. password_hash stays NULL so this account
-- can only sign in via "Sign in with Google" (OIDC).
--
-- This mirrors src/lib/db/seed-super-admin.ts so a `db:migrate` against prod
-- (which is the manual deploy step — Vercel build does not run migrations)
-- provisions the owner account without a separate seed run.

-- Insert only if no row exists for this org+email (there is no unique
-- constraint on (organization_id, email), so we guard with NOT EXISTS rather
-- than ON CONFLICT — that avoids creating a duplicate on re-run).
INSERT INTO "users" ("organization_id", "email", "name", "password_hash", "role", "is_active")
SELECT
  '00000000-0000-0000-0000-000000000001',
  'rchen.workmail@gmail.com',
  'Raymond Chen',
  NULL,
  'super_admin',
  true
WHERE NOT EXISTS (
  SELECT 1 FROM "users"
  WHERE "organization_id" = '00000000-0000-0000-0000-000000000001'
    AND "email" = 'rchen.workmail@gmail.com'
);
--> statement-breakpoint
-- Promote/reactivate if the row already existed (the INSERT above no-ops then).
-- Scoped to the demo org + exact email; leaves name/google_id/password_hash as-is.
UPDATE "users"
SET "role" = 'super_admin', "is_active" = true
WHERE "organization_id" = '00000000-0000-0000-0000-000000000001'
  AND "email" = 'rchen.workmail@gmail.com';
