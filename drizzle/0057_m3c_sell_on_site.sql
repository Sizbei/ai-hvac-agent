-- M3c Sell on site: the estimate-line link on invoice lines (the per-estimate
-- billed-once guard) and who sold an estimate through which path.
-- Idempotent throughout (one DO block per constraint).
ALTER TABLE "invoice_line_items" ADD COLUMN IF NOT EXISTS "estimate_line_item_id" uuid;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "invoice_line_items" ADD CONSTRAINT "invoice_line_items_estimate_line_fk" FOREIGN KEY ("estimate_line_item_id") REFERENCES "public"."estimate_line_items"("id") ON DELETE no action ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "invoice_line_items_estimate_line_idx" ON "invoice_line_items" USING btree ("estimate_line_item_id");
--> statement-breakpoint
ALTER TABLE "estimates" ADD COLUMN IF NOT EXISTS "sold_by" uuid;
--> statement-breakpoint
ALTER TABLE "estimates" ADD COLUMN IF NOT EXISTS "sold_via" text;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "estimates" ADD CONSTRAINT "estimates_sold_by_users_id_fk" FOREIGN KEY ("sold_by") REFERENCES "public"."users"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "estimates" ADD CONSTRAINT "estimates_sold_via_check" CHECK ("estimates"."sold_via" IN ('portal','office','field'));
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
