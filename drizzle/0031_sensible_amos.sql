-- Custom Fields CRM System
-- Adds custom_field_definitions and custom_field_values tables for flexible CRM

-- Enums for field types and entity types
CREATE TYPE "custom_field_entity_type" AS ENUM ('customer', 'service_request', 'both');
CREATE TYPE "custom_field_type" AS ENUM ('text', 'textarea', 'select', 'multiselect', 'number', 'currency', 'date', 'checkbox');

-- Field definitions per organization
CREATE TABLE "custom_field_definitions" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "key" varchar(100) NOT NULL,
  "label" varchar(255) NOT NULL,
  "description" text,
  "entity_type" "custom_field_entity_type" NOT NULL,
  "field_type" "custom_field_type" NOT NULL,
  "options" jsonb DEFAULT '[]'::jsonb,
  "required" boolean NOT NULL DEFAULT false,
  "placeholder" text,
  "default_value" jsonb,
  "validation" jsonb,
  "display_order" integer NOT NULL DEFAULT 0,
  "is_active" boolean NOT NULL DEFAULT true,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now(),
  CONSTRAINT "custom_fields_key_format" CHECK ("key" ~ '^[a-z][a-z0-9_]*$')
);

-- Indexes for lookups
CREATE INDEX "custom_field_defs_org_id_idx" ON "custom_field_definitions"("organization_id");
CREATE INDEX "custom_field_defs_org_entity_active_idx" ON "custom_field_definitions"("organization_id", "entity_type", "is_active");
CREATE UNIQUE INDEX "custom_field_defs_org_key_unique" ON "custom_field_definitions"("organization_id", "key") WHERE "is_active" = true;

-- Field values per entity
CREATE TABLE "custom_field_values" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE CASCADE,
  "field_definition_id" uuid NOT NULL REFERENCES "custom_field_definitions"("id") ON DELETE CASCADE,
  "entity_type" "custom_field_entity_type" NOT NULL,
  "entity_id" uuid NOT NULL,
  "value" jsonb NOT NULL,
  "created_at" timestamp with time zone NOT NULL DEFAULT now(),
  "updated_at" timestamp with time zone NOT NULL DEFAULT now()
);

-- Indexes for lookups
CREATE INDEX "custom_field_values_org_id_idx" ON "custom_field_values"("organization_id");
CREATE INDEX "custom_field_values_field_def_idx" ON "custom_field_values"("field_definition_id");
CREATE INDEX "custom_field_values_entity_idx" ON "custom_field_values"("entity_type", "entity_id");

-- Ensure one value per field per entity
CREATE UNIQUE INDEX "custom_field_values_field_entity_unique" ON "custom_field_values"("field_definition_id", "entity_type", "entity_id");

-- Comments for documentation
COMMENT ON TABLE "custom_field_definitions" IS 'Organization-defined custom field schemas for CRM flexibility';
COMMENT ON TABLE "custom_field_values" IS 'Actual custom field values per customer or service request';
COMMENT ON COLUMN "custom_field_definitions"."key" IS 'Machine-readable identifier (snake_case, must match regex ^[a-z][a-z0-9_]*$)';
COMMENT ON COLUMN "custom_field_definitions"."entity_type" IS 'Which entity type this field applies to (customer, service_request, or both)';
COMMENT ON COLUMN "custom_field_definitions"."field_type" IS 'Data type of the field (text, textarea, select, multiselect, number, currency, date, checkbox)';
COMMENT ON COLUMN "custom_field_definitions"."options" IS 'Array of allowed values for select/multiselect field types';
COMMENT ON COLUMN "custom_field_definitions"."validation" IS 'JSON-encoded validation rules (min/max/length/pattern)';
COMMENT ON COLUMN "custom_field_values"."value" IS 'The actual value, typed according to the field definition';
