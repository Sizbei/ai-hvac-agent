CREATE TYPE "public"."equipment_type" AS ENUM('ac', 'furnace', 'heat_pump', 'boiler', 'mini_split', 'thermostat', 'other');--> statement-breakpoint
CREATE TYPE "public"."follow_up_status" AS ENUM('pending', 'completed', 'overdue', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."note_type" AS ENUM('general', 'follow_up', 'complaint', 'compliment');--> statement-breakpoint
CREATE TABLE "customer_equipment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"equipment_type" "equipment_type" NOT NULL,
	"make" text,
	"model" text,
	"serial_number" text,
	"install_date" timestamp with time zone,
	"warranty_expiration" timestamp with time zone,
	"location_in_home" text,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customer_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"author_id" uuid,
	"content" text NOT NULL,
	"note_type" "note_type" DEFAULT 'general' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name_encrypted" text NOT NULL,
	"phone_encrypted" text,
	"email_encrypted" text,
	"address_encrypted" text,
	"property_type" text,
	"property_sqft" integer,
	"notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "follow_ups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"assigned_to" uuid,
	"reason" text NOT NULL,
	"due_date" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"status" "follow_up_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "service_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"service_request_id" uuid,
	"organization_id" uuid NOT NULL,
	"work_performed" text,
	"parts_used" text,
	"cost" integer,
	"technician_notes" text,
	"follow_up_needed" boolean DEFAULT false NOT NULL,
	"follow_up_date" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "service_requests" ADD COLUMN "customer_id" uuid;--> statement-breakpoint
ALTER TABLE "customer_equipment" ADD CONSTRAINT "customer_equipment_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_equipment" ADD CONSTRAINT "customer_equipment_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_notes" ADD CONSTRAINT "customer_notes_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_notes" ADD CONSTRAINT "customer_notes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_notes" ADD CONSTRAINT "customer_notes_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follow_ups" ADD CONSTRAINT "follow_ups_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follow_ups" ADD CONSTRAINT "follow_ups_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follow_ups" ADD CONSTRAINT "follow_ups_assigned_to_users_id_fk" FOREIGN KEY ("assigned_to") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_history" ADD CONSTRAINT "service_history_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_history" ADD CONSTRAINT "service_history_service_request_id_service_requests_id_fk" FOREIGN KEY ("service_request_id") REFERENCES "public"."service_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_history" ADD CONSTRAINT "service_history_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "equipment_customer_id_idx" ON "customer_equipment" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "equipment_org_id_idx" ON "customer_equipment" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "notes_customer_id_idx" ON "customer_notes" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "notes_org_id_idx" ON "customer_notes" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "customers_org_id_idx" ON "customers" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "followups_customer_id_idx" ON "follow_ups" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "followups_org_id_idx" ON "follow_ups" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "followups_due_date_idx" ON "follow_ups" USING btree ("due_date");--> statement-breakpoint
CREATE INDEX "followups_status_idx" ON "follow_ups" USING btree ("status");--> statement-breakpoint
CREATE INDEX "history_customer_id_idx" ON "service_history" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "history_org_id_idx" ON "service_history" USING btree ("organization_id");--> statement-breakpoint
ALTER TABLE "service_requests" ADD CONSTRAINT "service_requests_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;