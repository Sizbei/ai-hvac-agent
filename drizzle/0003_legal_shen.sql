ALTER TABLE "customers" ADD COLUMN "email_hash" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "phone_hash" text;--> statement-breakpoint
CREATE UNIQUE INDEX "customers_org_email_hash_unique" ON "customers" USING btree ("organization_id","email_hash") WHERE "customers"."email_hash" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "customers_org_phone_hash_unique" ON "customers" USING btree ("organization_id","phone_hash") WHERE "customers"."phone_hash" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "requests_customer_id_idx" ON "service_requests" USING btree ("customer_id");