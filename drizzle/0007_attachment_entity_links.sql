ALTER TABLE "attachments" ALTER COLUMN "session_id" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "attachments" ADD COLUMN "customer_id" uuid;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_service_request_id_service_requests_id_fk" FOREIGN KEY ("service_request_id") REFERENCES "public"."service_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_equipment_id_customer_equipment_id_fk" FOREIGN KEY ("equipment_id") REFERENCES "public"."customer_equipment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attachments_equipment_idx" ON "attachments" USING btree ("equipment_id") WHERE "attachments"."equipment_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "attachments_customer_idx" ON "attachments" USING btree ("customer_id") WHERE "attachments"."customer_id" IS NOT NULL;