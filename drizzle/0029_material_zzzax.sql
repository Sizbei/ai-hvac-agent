ALTER TABLE "payments" ADD COLUMN "amount_refunded_cents" integer DEFAULT 0 NOT NULL;
--> statement-breakpoint
-- Backfill the running refunded total from existing refund rows so already
-- partially-refunded payments start with the correct claim baseline (the new
-- atomic refund guard reads this column, not a live SUM(refunds)).
UPDATE "payments" p
SET "amount_refunded_cents" = COALESCE(
  (SELECT SUM(r."amount_cents") FROM "refunds" r WHERE r."payment_id" = p."id"),
  0
);
