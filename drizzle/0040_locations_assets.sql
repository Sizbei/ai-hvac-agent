-- Stage 5: customer locations + per-asset history + equipment replacement chains.

CREATE TABLE "customer_locations" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "customer_id" uuid NOT NULL REFERENCES "customers"("id") ON DELETE cascade,
  "address_encrypted" text NOT NULL,
  "address_hash" text,
  "label" text,
  "zone" text,
  "property_type" text,
  "access_notes" text,
  "latitude" double precision,
  "longitude" double precision,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX "customer_locations_customer_idx" ON "customer_locations" ("customer_id");
CREATE INDEX "customer_locations_org_idx" ON "customer_locations" ("organization_id");
CREATE UNIQUE INDEX "customer_locations_customer_addr_unique"
  ON "customer_locations" ("customer_id", "address_hash")
  WHERE "address_hash" IS NOT NULL;

-- Per-asset service history.
ALTER TABLE "service_history" ADD COLUMN "equipment_id" uuid REFERENCES "customer_equipment"("id");

-- Equipment: location link + replacement chain.
ALTER TABLE "customer_equipment" ADD COLUMN "location_id" uuid;
ALTER TABLE "customer_equipment" ADD COLUMN "replaced_by_equipment_id" uuid;
ALTER TABLE "customer_equipment" ADD COLUMN "retired_at" timestamp with time zone;

-- Service requests: physical location link.
ALTER TABLE "service_requests" ADD COLUMN "location_id" uuid;
