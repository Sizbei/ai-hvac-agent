-- Customer soft-delete (archive).
--
-- Adds a nullable archived_at timestamp to customers. When set, the customer is
-- "archived" — hidden from the default admin list but fully retained, so it's
-- reversible (unlike the permanent DELETE). NULL for every existing row (all
-- active), so the column is added without a default and stays nullable.
--
-- Plain ALTER TABLE ADD COLUMN — no enum / ALTER TYPE, so no in-transaction
-- hazard; runs fine through the standard neon-http file migrator.
ALTER TABLE "customers" ADD COLUMN "archived_at" timestamp with time zone;
