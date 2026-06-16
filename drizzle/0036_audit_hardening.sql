-- Audit hardening migration.
-- Addresses confirmed findings H2/H3/H4/H5 + FK integrity from the security audit.

-- H4: dedicated per-org Fieldpulse user id (previously overloaded google_id, whose
-- unique index is GLOBAL and collides across tenants on Fieldpulse's small ids).
ALTER TABLE "users" ADD COLUMN "fieldpulse_user_id" text;
CREATE UNIQUE INDEX "users_org_fieldpulse_user_id_unique"
  ON "users" ("organization_id", "fieldpulse_user_id")
  WHERE "fieldpulse_user_id" IS NOT NULL;

-- H3: index external job-id webhook lookups (were full table scans).
-- H2: Fieldpulse job id is UNIQUE PER ORG so a cross-tenant collision can't resolve
-- to the wrong tenant's request.
CREATE INDEX "requests_hcp_job_id_idx"
  ON "service_requests" ("hcp_job_id")
  WHERE "hcp_job_id" IS NOT NULL;
CREATE UNIQUE INDEX "requests_org_fieldpulse_job_id_unique"
  ON "service_requests" ("organization_id", "fieldpulse_job_id")
  WHERE "fieldpulse_job_id" IS NOT NULL;

-- H5: encrypt recipient PII in communication_jobs. Rename to the *_encrypted
-- convention and widen recipient_phone to text to hold the AES-GCM ciphertext.
-- NOTE: the queue is transient (pending/sent jobs); pre-existing plaintext values
-- are NOT re-encrypted by this migration — any in-flight rows should be re-enqueued.
ALTER TABLE "communication_jobs" RENAME COLUMN "recipient_phone" TO "recipient_phone_encrypted";
ALTER TABLE "communication_jobs" ALTER COLUMN "recipient_phone_encrypted" TYPE text;
ALTER TABLE "communication_jobs" RENAME COLUMN "recipient_email" TO "recipient_email_encrypted";

-- LOW: referential integrity for communication_jobs related entities (NULLs allowed;
-- only non-null orphans would block — none expected for this recent feature).
ALTER TABLE "communication_jobs"
  ADD CONSTRAINT "communication_jobs_customer_id_fk"
  FOREIGN KEY ("customer_id") REFERENCES "customers"("id") ON DELETE cascade;
ALTER TABLE "communication_jobs"
  ADD CONSTRAINT "communication_jobs_service_request_id_fk"
  FOREIGN KEY ("service_request_id") REFERENCES "service_requests"("id") ON DELETE cascade;
