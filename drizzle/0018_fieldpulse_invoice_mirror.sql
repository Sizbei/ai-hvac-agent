-- FieldPulse invoice pull-mirror (Stage: invoice sync).
-- Adds the synced-invoice idempotency key + the per-org indexes the pull relies on.
-- Hand-authored (the repo runs migrations manually: npm run db:migrate).
-- Idempotent: safe to re-run.

ALTER TABLE invoices ADD COLUMN IF NOT EXISTS fieldpulse_invoice_id text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS invoices_org_fieldpulse_invoice_id_unique
  ON invoices (organization_id, fieldpulse_invoice_id)
  WHERE fieldpulse_invoice_id IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS customers_org_fieldpulse_customer_id_unique
  ON customers (organization_id, fieldpulse_customer_id)
  WHERE fieldpulse_customer_id IS NOT NULL;
