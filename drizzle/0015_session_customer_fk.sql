-- Repeat-customer awareness: link a session to a known customer.
--
-- Adds a nullable customer_id FK to customer_sessions so a session that resolves
-- to an existing customer (via blind-index email/phone lookup mid-chat) can be
-- linked durably. NULL for anonymous sessions and for sessions that never match
-- a known customer, so the column is added without a default and stays nullable;
-- existing rows are unaffected.
--
-- Plain ALTER TABLE ADD COLUMN + CREATE INDEX — no enum / ALTER TYPE, so there
-- is no in-transaction hazard and this runs fine through the standard
-- neon-http file migrator. The FK and index mirror service_requests.customer_id
-- (requests_customer_id_idx + service_requests_customer_id_customers_id_fk).
ALTER TABLE "customer_sessions" ADD COLUMN "customer_id" uuid;--> statement-breakpoint
ALTER TABLE "customer_sessions" ADD CONSTRAINT "customer_sessions_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "sessions_customer_id_idx" ON "customer_sessions" USING btree ("customer_id");
