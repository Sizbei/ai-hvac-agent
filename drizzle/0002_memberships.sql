CREATE TYPE "public"."membership_billing_period" AS ENUM('monthly', 'annual');--> statement-breakpoint
CREATE TABLE "customer_memberships" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"plan_id" uuid NOT NULL,
	"status" "membership_status" DEFAULT 'active' NOT NULL,
	"started_at" timestamp with time zone DEFAULT now() NOT NULL,
	"current_period_end" timestamp with time zone,
	"cancelled_at" timestamp with time zone,
	"provider_subscription_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "membership_plans" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"price_cents" integer NOT NULL,
	"billing_period" "membership_billing_period" DEFAULT 'monthly' NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "customer_memberships" ADD CONSTRAINT "customer_memberships_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_memberships" ADD CONSTRAINT "customer_memberships_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_memberships" ADD CONSTRAINT "customer_memberships_plan_id_membership_plans_id_fk" FOREIGN KEY ("plan_id") REFERENCES "public"."membership_plans"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership_plans" ADD CONSTRAINT "membership_plans_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "customer_memberships_org_idx" ON "customer_memberships" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "customer_memberships_customer_idx" ON "customer_memberships" USING btree ("customer_id");--> statement-breakpoint
CREATE UNIQUE INDEX "customer_memberships_org_customer_active_unique" ON "customer_memberships" USING btree ("organization_id","customer_id") WHERE "customer_memberships"."status" = 'active';--> statement-breakpoint
CREATE INDEX "membership_plans_org_idx" ON "membership_plans" USING btree ("organization_id");