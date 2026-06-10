CREATE TABLE IF NOT EXISTS "staff_invites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"email" text NOT NULL,
	"role" text NOT NULL,
	"token_hash" text NOT NULL,
	"invited_by_user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "staff_invites_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "staff_invites" ADD CONSTRAINT "staff_invites_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "staff_invites" ADD CONSTRAINT "staff_invites_invited_by_user_id_users_id_fk" FOREIGN KEY ("invited_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN null; END $$;--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "staff_invites_org_id_idx" ON "staff_invites" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "staff_invites_token_hash_idx" ON "staff_invites" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "staff_invites_live_unique" ON "staff_invites" USING btree ("organization_id","email") WHERE "staff_invites"."accepted_at" IS NULL AND "staff_invites"."revoked_at" IS NULL;--> statement-breakpoint
-- users_org_email_unique: per-org email uniqueness. This will fail if the live
-- DB already holds duplicate (organization_id, email) rows. The codebase has
-- always enforced per-org email uniqueness in createStaff, so no duplicates are
-- expected; CREATE UNIQUE INDEX CONCURRENTLY is avoided (transactional migration
-- runner). IF NOT EXISTS makes a re-run a no-op.
CREATE UNIQUE INDEX IF NOT EXISTS "users_org_email_unique" ON "users" USING btree ("organization_id","email");
