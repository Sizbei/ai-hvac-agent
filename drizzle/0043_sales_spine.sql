-- Stage 8 (pricebook + tax) + Stage 9 (estimates, invoicing, payments, financing).

CREATE TYPE "pricebook_item_type" AS ENUM ('service', 'material', 'equipment');
CREATE TYPE "estimate_status" AS ENUM ('open', 'sold', 'dismissed', 'expired');
CREATE TYPE "invoice_state" AS ENUM ('draft', 'open', 'paid', 'void', 'refunded');
CREATE TYPE "payment_status" AS ENUM ('pending', 'succeeded', 'failed', 'refunded');
CREATE TYPE "financing_status" AS ENUM ('pending', 'approved', 'declined', 'expired');

CREATE TABLE "pricebook_categories" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "parent_id" uuid,
  "name" text NOT NULL,
  "sort_order" integer DEFAULT 0 NOT NULL,
  "active" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX "pricebook_categories_org_idx" ON "pricebook_categories" ("organization_id");

CREATE TABLE "pricebook_items" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "category_id" uuid,
  "type" "pricebook_item_type" NOT NULL,
  "name" text NOT NULL,
  "description" text,
  "sku" text,
  "cost_cents" integer DEFAULT 0 NOT NULL,
  "markup_pct" integer DEFAULT 0 NOT NULL,
  "price_cents" integer DEFAULT 0 NOT NULL,
  "member_price_cents" integer,
  "hours" integer,
  "warranty" text,
  "active" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX "pricebook_items_org_idx" ON "pricebook_items" ("organization_id");
CREATE INDEX "pricebook_items_category_idx" ON "pricebook_items" ("category_id");
CREATE UNIQUE INDEX "pricebook_items_org_sku_unique" ON "pricebook_items" ("organization_id","sku") WHERE "sku" IS NOT NULL;

CREATE TABLE "pricebook_item_materials" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "item_id" uuid NOT NULL REFERENCES "pricebook_items"("id") ON DELETE cascade,
  "material_item_id" uuid NOT NULL REFERENCES "pricebook_items"("id") ON DELETE cascade,
  "quantity" integer DEFAULT 1 NOT NULL
);
CREATE INDEX "pricebook_item_materials_item_idx" ON "pricebook_item_materials" ("item_id");

CREATE TABLE "tax_rates" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "name" text NOT NULL,
  "jurisdiction" text,
  "rate_bps" integer NOT NULL,
  "is_default" boolean DEFAULT false NOT NULL,
  "active" boolean DEFAULT true NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX "tax_rates_org_idx" ON "tax_rates" ("organization_id");

CREATE TABLE "estimates" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "service_request_id" uuid,
  "customer_id" uuid,
  "status" "estimate_status" DEFAULT 'open' NOT NULL,
  "total_cents" integer DEFAULT 0 NOT NULL,
  "approval_token_hash" text,
  "expires_at" timestamp with time zone,
  "signed_at" timestamp with time zone,
  "signature_name" text,
  "signature_ip" text,
  "sold_option_id" uuid,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX "estimates_org_idx" ON "estimates" ("organization_id");
CREATE INDEX "estimates_request_idx" ON "estimates" ("service_request_id");
CREATE UNIQUE INDEX "estimates_approval_token_unique" ON "estimates" ("approval_token_hash") WHERE "approval_token_hash" IS NOT NULL;

CREATE TABLE "estimate_options" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "estimate_id" uuid NOT NULL REFERENCES "estimates"("id") ON DELETE cascade,
  "name" text NOT NULL,
  "sort_order" integer DEFAULT 0 NOT NULL,
  "subtotal_cents" integer DEFAULT 0 NOT NULL,
  "tax_cents" integer DEFAULT 0 NOT NULL,
  "total_cents" integer DEFAULT 0 NOT NULL
);
CREATE INDEX "estimate_options_estimate_idx" ON "estimate_options" ("estimate_id");

CREATE TABLE "estimate_line_items" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "option_id" uuid NOT NULL REFERENCES "estimate_options"("id") ON DELETE cascade,
  "pricebook_item_id" uuid,
  "name" text NOT NULL,
  "quantity" integer DEFAULT 1 NOT NULL,
  "unit_price_cents" integer DEFAULT 0 NOT NULL,
  "line_total_cents" integer DEFAULT 0 NOT NULL
);
CREATE INDEX "estimate_line_items_option_idx" ON "estimate_line_items" ("option_id");

CREATE TABLE "invoices" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "service_request_id" uuid,
  "customer_id" uuid,
  "estimate_id" uuid,
  "state" "invoice_state" DEFAULT 'draft' NOT NULL,
  "subtotal_cents" integer DEFAULT 0 NOT NULL,
  "tax_cents" integer DEFAULT 0 NOT NULL,
  "total_cents" integer DEFAULT 0 NOT NULL,
  "amount_paid_cents" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX "invoices_org_idx" ON "invoices" ("organization_id");
CREATE INDEX "invoices_request_idx" ON "invoices" ("service_request_id");

CREATE TABLE "invoice_line_items" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "invoice_id" uuid NOT NULL REFERENCES "invoices"("id") ON DELETE cascade,
  "name" text NOT NULL,
  "quantity" integer DEFAULT 1 NOT NULL,
  "unit_price_cents" integer DEFAULT 0 NOT NULL,
  "line_total_cents" integer DEFAULT 0 NOT NULL
);
CREATE INDEX "invoice_line_items_invoice_idx" ON "invoice_line_items" ("invoice_id");

CREATE TABLE "payments" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "invoice_id" uuid NOT NULL REFERENCES "invoices"("id") ON DELETE cascade,
  "provider" text NOT NULL,
  "provider_payment_id" text,
  "amount_cents" integer NOT NULL,
  "status" "payment_status" DEFAULT 'pending' NOT NULL,
  "is_deposit" boolean DEFAULT false NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX "payments_invoice_idx" ON "payments" ("invoice_id");
CREATE UNIQUE INDEX "payments_provider_id_unique" ON "payments" ("provider","provider_payment_id") WHERE "provider_payment_id" IS NOT NULL;

CREATE TABLE "refunds" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "payment_id" uuid NOT NULL REFERENCES "payments"("id") ON DELETE cascade,
  "amount_cents" integer NOT NULL,
  "reason" text,
  "provider_refund_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX "refunds_payment_idx" ON "refunds" ("payment_id");

CREATE TABLE "financing_applications" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "organization_id" uuid NOT NULL REFERENCES "organizations"("id") ON DELETE cascade,
  "customer_id" uuid,
  "estimate_id" uuid,
  "provider" text NOT NULL,
  "provider_app_id" text,
  "status" "financing_status" DEFAULT 'pending' NOT NULL,
  "requested_amount_cents" integer NOT NULL,
  "approved_amount_cents" integer,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX "financing_applications_org_idx" ON "financing_applications" ("organization_id");
