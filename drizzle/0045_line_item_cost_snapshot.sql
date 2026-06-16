-- Snapshot cost onto estimate + invoice line items for historical margin accuracy.
ALTER TABLE "estimate_line_items" ADD COLUMN "cost_cents" integer DEFAULT 0 NOT NULL;
ALTER TABLE "invoice_line_items" ADD COLUMN "cost_cents" integer DEFAULT 0 NOT NULL;
