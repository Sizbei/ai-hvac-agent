ALTER TABLE "customers" ALTER COLUMN "do_not_service" SET DEFAULT false;--> statement-breakpoint
ALTER TABLE "users" ALTER COLUMN "password_hash" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "users" ADD COLUMN "google_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "users_google_id_unique" ON "users" USING btree ("google_id") WHERE "users"."google_id" IS NOT NULL;