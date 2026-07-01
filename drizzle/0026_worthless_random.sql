CREATE TABLE "capacity_reservations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"day" text NOT NULL,
	"window" text NOT NULL,
	"slot_ordinal" integer NOT NULL,
	"service_request_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "capacity_reservations" ADD CONSTRAINT "capacity_reservations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "capacity_reservations_slot_unique" ON "capacity_reservations" USING btree ("organization_id","day","window","slot_ordinal");--> statement-breakpoint
CREATE INDEX "capacity_reservations_org_day_window_idx" ON "capacity_reservations" USING btree ("organization_id","day","window");--> statement-breakpoint
CREATE INDEX "capacity_reservations_request_idx" ON "capacity_reservations" USING btree ("service_request_id");