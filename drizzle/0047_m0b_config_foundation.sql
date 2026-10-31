-- M0b config foundation: tags, contacts, primary location, job types.
-- Every statement is idempotent: the neon-http migrator autocommits per
-- statement and records the file only after all pending files succeed.
DO $$ BEGIN
  CREATE TYPE "public"."tag_entity" AS ENUM('customer', 'location', 'job');
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "tag_types" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "entity" "tag_entity" NOT NULL,
  "name" text NOT NULL,
  "color" text DEFAULT 'graphite' NOT NULL,
  "visible_on_board" boolean DEFAULT false NOT NULL,
  "active" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "tag_types_org_entity_name_unique" UNIQUE("organization_id","entity","name"),
  CONSTRAINT "tag_types_id_org_entity_unique" UNIQUE("id","organization_id","entity")
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "tag_types" ADD CONSTRAINT "tag_types_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "entity_tags" (
  "organization_id" uuid NOT NULL,
  "tag_type_id" uuid NOT NULL,
  "entity" "tag_entity" NOT NULL,
  "entity_id" uuid NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "entity_tags_tag_type_id_entity_entity_id_pk" PRIMARY KEY("tag_type_id","entity","entity_id")
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "entity_tags" ADD CONSTRAINT "entity_tags_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "entity_tags" ADD CONSTRAINT "entity_tags_tag_type_fk" FOREIGN KEY ("tag_type_id","organization_id","entity") REFERENCES "public"."tag_types"("id","organization_id","entity") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "entity_tags_org_entity_idx" ON "entity_tags" USING btree ("organization_id","entity","entity_id");
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "job_types" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "name" text NOT NULL,
  "kind" "job_type" NOT NULL,
  "default_duration_minutes" integer DEFAULT 90 NOT NULL,
  "default_priority" "urgency" DEFAULT 'medium' NOT NULL,
  "active" boolean DEFAULT true NOT NULL,
  "position" smallint DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "job_types_org_name_unique" UNIQUE("organization_id","name"),
  CONSTRAINT "job_types_duration_check" CHECK ("job_types"."default_duration_minutes" BETWEEN 15 AND 1440)
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "job_types" ADD CONSTRAINT "job_types_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "customer_contacts" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL,
  "customer_id" uuid NOT NULL,
  "location_id" uuid,
  "name_encrypted" text NOT NULL,
  "role" text,
  "phone_encrypted" text,
  "phone_hash" text,
  "email_encrypted" text,
  "email_hash" text,
  "is_primary" boolean DEFAULT false NOT NULL,
  "position" smallint DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "customer_contacts" ADD CONSTRAINT "customer_contacts_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "customer_contacts" ADD CONSTRAINT "customer_contacts_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "customer_contacts" ADD CONSTRAINT "customer_contacts_location_id_customer_locations_id_fk" FOREIGN KEY ("location_id") REFERENCES "public"."customer_locations"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "customer_contacts_org_customer_idx" ON "customer_contacts" USING btree ("organization_id","customer_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "customer_contacts_org_phone_hash_idx" ON "customer_contacts" USING btree ("organization_id","phone_hash");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "customer_contacts_one_primary_idx" ON "customer_contacts" USING btree ("customer_id") WHERE "customer_contacts"."is_primary" = true;
--> statement-breakpoint
ALTER TABLE "customer_locations" ADD COLUMN IF NOT EXISTS "is_primary" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "customer_locations_one_primary_idx" ON "customer_locations" USING btree ("customer_id") WHERE "customer_locations"."is_primary" = true;
--> statement-breakpoint
ALTER TABLE "service_requests" ADD COLUMN IF NOT EXISTS "job_type_id" uuid;
--> statement-breakpoint
ALTER TABLE "service_requests" ADD COLUMN IF NOT EXISTS "contact_id" uuid;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "service_requests" ADD CONSTRAINT "service_requests_job_type_id_job_types_id_fk" FOREIGN KEY ("job_type_id") REFERENCES "public"."job_types"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
DO $$ BEGIN
  ALTER TABLE "service_requests" ADD CONSTRAINT "service_requests_contact_id_customer_contacts_id_fk" FOREIGN KEY ("contact_id") REFERENCES "public"."customer_contacts"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION WHEN duplicate_object THEN NULL; END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "requests_job_type_id_idx" ON "service_requests" USING btree ("job_type_id");
--> statement-breakpoint
-- Backfill: the oldest location per customer becomes primary (runs against
-- the pre-update snapshot, so exactly one row per customer).
UPDATE "customer_locations" l SET "is_primary" = true
  WHERE NOT l."is_primary"
    AND l."id" = (SELECT x."id" FROM "customer_locations" x WHERE x."customer_id" = l."customer_id" ORDER BY x."created_at", x."id" LIMIT 1)
    AND NOT EXISTS (SELECT 1 FROM "customer_locations" p WHERE p."customer_id" = l."customer_id" AND p."is_primary");
--> statement-breakpoint
-- Seed one job type per enum value for every existing org (durations from
-- src/lib/ai/dispatch/duration.ts JOB_DURATION_DEFAULTS); ON CONFLICT makes
-- re-runs no-ops. New orgs are seeded by provisioning (Task 2).
INSERT INTO "job_types" ("organization_id","name","kind","default_duration_minutes","default_priority","position")
SELECT o."id", v.name, v.kind::"job_type", v.minutes, v.priority::"urgency", v.pos
FROM "organizations" o
CROSS JOIN (VALUES
  ('Service call','service_call',90,'medium',0),
  ('No heat','no_heat',105,'high',1),
  ('No cooling','no_cool',105,'high',2),
  ('Maintenance','maintenance',60,'low',3),
  ('Installation','install',480,'medium',4),
  ('Estimate','estimate',30,'low',5),
  ('Warranty','warranty',90,'medium',6),
  ('Diagnostic','diagnostic',75,'medium',7),
  ('Inspection','inspection',45,'low',8)
) AS v(name, kind, minutes, priority, pos)
ON CONFLICT ("organization_id","name") DO NOTHING;
--> statement-breakpoint
-- One-off: point existing requests at their org's row for their enum value.
-- AI, FieldPulse and HCP paths keep inserting with job_type_id NULL; readers
-- fall back by kind.
UPDATE "service_requests" r SET "job_type_id" = jt."id"
FROM "job_types" jt
WHERE r."job_type_id" IS NULL AND r."job_type" IS NOT NULL
  AND jt."organization_id" = r."organization_id" AND jt."kind" = r."job_type";
