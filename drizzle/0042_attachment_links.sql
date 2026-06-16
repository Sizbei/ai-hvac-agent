-- Stage 7: link attachments to a service request and/or a specific asset.
ALTER TABLE "attachments" ADD COLUMN "service_request_id" uuid;
ALTER TABLE "attachments" ADD COLUMN "equipment_id" uuid;
CREATE INDEX "attachments_service_request_idx"
  ON "attachments" ("service_request_id")
  WHERE "service_request_id" IS NOT NULL;
