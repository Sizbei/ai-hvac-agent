-- GDPR backfill: apply the session scrub that anonymizeCustomer now performs
-- to customers erased BEFORE it existed. Erase used to detach only sessions
-- linked by customer_sessions.customer_id and left their metadata (plaintext
-- name/phone/email/address) and the "sms:<phone>" token in place; sessions
-- reached only through service_requests.session_id were not touched at all.
-- Only customers with anonymized_at IS NOT NULL are matched. Idempotent: the
-- deletes find nothing on a re-run and the update skips already-clean rows.
-- Note: R2 objects behind deleted chat-upload rows cannot be removed from SQL.
DELETE FROM "attachments" WHERE ("session_id", "organization_id") IN (SELECT r."session_id", r."organization_id" FROM "service_requests" r JOIN "customers" c ON c."id" = r."customer_id" AND c."organization_id" = r."organization_id" WHERE c."anonymized_at" IS NOT NULL UNION SELECT s."id", s."organization_id" FROM "customer_sessions" s JOIN "customers" c ON c."id" = s."customer_id" AND c."organization_id" = s."organization_id" WHERE c."anonymized_at" IS NOT NULL);
--> statement-breakpoint
DELETE FROM "messages" WHERE ("session_id", "organization_id") IN (SELECT r."session_id", r."organization_id" FROM "service_requests" r JOIN "customers" c ON c."id" = r."customer_id" AND c."organization_id" = r."organization_id" WHERE c."anonymized_at" IS NOT NULL UNION SELECT s."id", s."organization_id" FROM "customer_sessions" s JOIN "customers" c ON c."id" = s."customer_id" AND c."organization_id" = s."organization_id" WHERE c."anonymized_at" IS NOT NULL);
--> statement-breakpoint
UPDATE "customer_sessions" SET "customer_id" = NULL, "summary" = NULL, "running_summary" = NULL, "next_steps" = NULL, "metadata" = NULL, "token" = CASE WHEN "token" LIKE 'sms:%' THEN 'erased:' || "id"::text ELSE "token" END WHERE ("id", "organization_id") IN (SELECT r."session_id", r."organization_id" FROM "service_requests" r JOIN "customers" c ON c."id" = r."customer_id" AND c."organization_id" = r."organization_id" WHERE c."anonymized_at" IS NOT NULL UNION SELECT s."id", s."organization_id" FROM "customer_sessions" s JOIN "customers" c ON c."id" = s."customer_id" AND c."organization_id" = s."organization_id" WHERE c."anonymized_at" IS NOT NULL) AND ("customer_id" IS NOT NULL OR "summary" IS NOT NULL OR "running_summary" IS NOT NULL OR "next_steps" IS NOT NULL OR "metadata" IS NOT NULL OR "token" LIKE 'sms:%');
