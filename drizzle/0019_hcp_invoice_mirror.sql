-- Housecall Pro invoice pull-mirror — parity with FieldPulse (0018).
-- Adds the synced-invoice idempotency key + the per-org indexes the pull relies on.
-- Hand-authored (the repo runs migrations manually: npm run db:migrate). Idempotent.

ALTER TABLE invoices ADD COLUMN IF NOT EXISTS hcp_invoice_id text;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS invoices_org_hcp_invoice_id_unique
  ON invoices (organization_id, hcp_invoice_id)
  WHERE hcp_invoice_id IS NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS customers_org_hcp_customer_id_unique
  ON customers (organization_id, hcp_customer_id)
  WHERE hcp_customer_id IS NOT NULL;
