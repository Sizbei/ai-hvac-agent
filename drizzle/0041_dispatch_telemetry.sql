ALTER TABLE "dispatch_decisions" ADD COLUMN IF NOT EXISTS "overridden_technician_id" uuid;--> statement-breakpoint
ALTER TABLE "dispatch_decisions" ADD COLUMN IF NOT EXISTS "overridden_by_user_id" uuid;--> statement-breakpoint
ALTER TABLE "dispatch_decisions" ADD COLUMN IF NOT EXISTS "overridden_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "dispatch_decisions" ADD COLUMN IF NOT EXISTS "is_shadow" boolean DEFAULT false NOT NULL;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "dispatch_decisions" ADD CONSTRAINT "dispatch_decisions_overridden_technician_id_users_id_fk" FOREIGN KEY ("overridden_technician_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "dispatch_decisions" ADD CONSTRAINT "dispatch_decisions_overridden_by_user_id_users_id_fk" FOREIGN KEY ("overridden_by_user_id") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
