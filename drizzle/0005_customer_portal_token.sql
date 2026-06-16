ALTER TABLE "customers" ADD COLUMN "portal_token_hash" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "portal_token_created_at" timestamp with time zone;--> statement-breakpoint
CREATE UNIQUE INDEX "customers_portal_token_hash_unique" ON "customers" USING btree ("portal_token_hash") WHERE "customers"."portal_token_hash" IS NOT NULL;