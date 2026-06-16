-- Stage 8/9 sign-off fixes: idempotency + determinism guards.
CREATE UNIQUE INDEX "invoices_estimate_unique"
  ON "invoices" ("estimate_id") WHERE "estimate_id" IS NOT NULL;
CREATE UNIQUE INDEX "tax_rates_org_default_unique"
  ON "tax_rates" ("organization_id") WHERE "is_default" = true AND "active" = true;
