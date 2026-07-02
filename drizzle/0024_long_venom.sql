CREATE TABLE "demand_daily" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"day" date NOT NULL,
	"job_type" text DEFAULT '__all__' NOT NULL,
	"bookings" integer DEFAULT 0 NOT NULL,
	"sessions" integer DEFAULT 0 NOT NULL,
	"booked" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "forecast_accuracy" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"model" text NOT NULL,
	"segment" text,
	"horizon_days" integer NOT NULL,
	"for_day" date NOT NULL,
	"predicted" integer NOT NULL,
	"actual" integer,
	"abs_error" integer
);
--> statement-breakpoint
CREATE TABLE "forecast_snapshots" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"model" text NOT NULL,
	"horizon_days" integer NOT NULL,
	"segment" text,
	"generated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"payload" jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "revenue_daily" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"day" date NOT NULL,
	"basis" text NOT NULL,
	"collected_cents" integer DEFAULT 0 NOT NULL,
	"invoiced_cents" integer DEFAULT 0 NOT NULL,
	"refunded_cents" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
ALTER TABLE "demand_daily" ADD CONSTRAINT "demand_daily_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forecast_accuracy" ADD CONSTRAINT "forecast_accuracy_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "forecast_snapshots" ADD CONSTRAINT "forecast_snapshots_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "revenue_daily" ADD CONSTRAINT "revenue_daily_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "demand_daily_org_day_jobtype_unique" ON "demand_daily" USING btree ("organization_id","day","job_type");--> statement-breakpoint
CREATE UNIQUE INDEX "forecast_accuracy_unique" ON "forecast_accuracy" USING btree ("organization_id","kind","segment","horizon_days","for_day");--> statement-breakpoint
CREATE INDEX "forecast_snapshots_org_kind_gen_idx" ON "forecast_snapshots" USING btree ("organization_id","kind","generated_at");--> statement-breakpoint
CREATE UNIQUE INDEX "revenue_daily_org_day_basis_unique" ON "revenue_daily" USING btree ("organization_id","day","basis");