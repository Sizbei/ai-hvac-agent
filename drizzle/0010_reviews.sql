CREATE TYPE "public"."review_request_status" AS ENUM('pending', 'sent', 'responded');--> statement-breakpoint
CREATE TABLE "review_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"service_request_id" uuid NOT NULL,
	"customer_id" uuid,
	"status" "review_request_status" DEFAULT 'pending' NOT NULL,
	"review_token_hash" text NOT NULL,
	"rating" integer,
	"feedback" text,
	"public_clicked" boolean DEFAULT false NOT NULL,
	"sent_at" timestamp with time zone,
	"responded_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "review_requests" ADD CONSTRAINT "review_requests_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_requests" ADD CONSTRAINT "review_requests_service_request_id_service_requests_id_fk" FOREIGN KEY ("service_request_id") REFERENCES "public"."service_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "review_requests" ADD CONSTRAINT "review_requests_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "review_requests_org_idx" ON "review_requests" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "review_requests_token_hash_unique" ON "review_requests" USING btree ("review_token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "review_requests_service_request_unique" ON "review_requests" USING btree ("service_request_id");