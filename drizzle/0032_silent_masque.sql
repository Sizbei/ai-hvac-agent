ALTER TABLE "customer_equipment" ADD COLUMN "fieldpulse_asset_id" text;--> statement-breakpoint
ALTER TABLE "estimates" ADD COLUMN "fieldpulse_estimate_id" text;--> statement-breakpoint
ALTER TABLE "payments" ADD COLUMN "fieldpulse_payment_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX "equipment_org_fieldpulse_asset_id_unique" ON "customer_equipment" USING btree ("organization_id","fieldpulse_asset_id") WHERE "customer_equipment"."fieldpulse_asset_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "estimates_org_fieldpulse_estimate_id_unique" ON "estimates" USING btree ("organization_id","fieldpulse_estimate_id") WHERE "estimates"."fieldpulse_estimate_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "payments_org_fieldpulse_payment_id_unique" ON "payments" USING btree ("organization_id","fieldpulse_payment_id") WHERE "payments"."fieldpulse_payment_id" IS NOT NULL;