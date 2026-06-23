-- META-SNAPSHOT RECONCILIATION (no-op against any DB that ran 0018/0019).
--
-- 0018_fieldpulse_invoice_mirror and 0019_hcp_invoice_mirror were HAND-AUTHORED
-- (with IF NOT EXISTS) and added these columns/indexes, but they did NOT update
-- drizzle's meta/ snapshots — so `drizzle-kit generate` kept re-proposing these
-- already-existing objects as spurious "drift". This migration carries the
-- regenerated snapshot (drizzle/meta/0020_snapshot.json) to bring the snapshot in
-- sync, and its SQL is IDEMPOTENT (IF NOT EXISTS) so applying it is a guaranteed
-- no-op on a real DB. After this, `drizzle-kit generate` reports no changes.
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "fieldpulse_invoice_id" text;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN IF NOT EXISTS "hcp_invoice_id" text;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "customers_org_fieldpulse_customer_id_unique" ON "customers" USING btree ("organization_id","fieldpulse_customer_id") WHERE "customers"."fieldpulse_customer_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "customers_org_hcp_customer_id_unique" ON "customers" USING btree ("organization_id","hcp_customer_id") WHERE "customers"."hcp_customer_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "invoices_org_fieldpulse_invoice_id_unique" ON "invoices" USING btree ("organization_id","fieldpulse_invoice_id") WHERE "invoices"."fieldpulse_invoice_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "invoices_org_hcp_invoice_id_unique" ON "invoices" USING btree ("organization_id","hcp_invoice_id") WHERE "invoices"."hcp_invoice_id" IS NOT NULL;
