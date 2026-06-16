CREATE TABLE "job_materials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"service_request_id" uuid NOT NULL,
	"pricebook_item_id" uuid,
	"description" text,
	"quantity" integer DEFAULT 1 NOT NULL,
	"unit_cost_cents" integer DEFAULT 0 NOT NULL,
	"unit_price_cents" integer DEFAULT 0 NOT NULL,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "service_requests" ADD COLUMN "signature_url" text;--> statement-breakpoint
ALTER TABLE "service_requests" ADD COLUMN "signature_name" text;--> statement-breakpoint
ALTER TABLE "service_requests" ADD COLUMN "signed_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "job_materials" ADD CONSTRAINT "job_materials_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_materials" ADD CONSTRAINT "job_materials_service_request_id_service_requests_id_fk" FOREIGN KEY ("service_request_id") REFERENCES "public"."service_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_materials" ADD CONSTRAINT "job_materials_pricebook_item_id_pricebook_items_id_fk" FOREIGN KEY ("pricebook_item_id") REFERENCES "public"."pricebook_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "job_materials" ADD CONSTRAINT "job_materials_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "job_materials_org_idx" ON "job_materials" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "job_materials_request_idx" ON "job_materials" USING btree ("service_request_id");