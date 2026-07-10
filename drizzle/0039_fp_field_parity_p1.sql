ALTER TABLE "customer_equipment" ADD COLUMN "fieldpulse_data" jsonb;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "is_tax_exempt" boolean;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "billing_address_encrypted" text;--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "fieldpulse_data" jsonb;--> statement-breakpoint
ALTER TABLE "estimates" ADD COLUMN "due_date" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "estimates" ADD COLUMN "title" text;--> statement-breakpoint
ALTER TABLE "estimates" ADD COLUMN "fieldpulse_data" jsonb;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "fieldpulse_data" jsonb;--> statement-breakpoint
ALTER TABLE "pricebook_items" ADD COLUMN "is_labor_item" boolean DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE "pricebook_items" ADD COLUMN "quantity_available" integer;--> statement-breakpoint
ALTER TABLE "pricebook_items" ADD COLUMN "vendor_type" text;--> statement-breakpoint
ALTER TABLE "pricebook_items" ADD COLUMN "fieldpulse_data" jsonb;--> statement-breakpoint
ALTER TABLE "service_requests" ADD COLUMN "fieldpulse_data" jsonb;