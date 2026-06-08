-- ServiceTitan-style comprehensive intake.
--
-- Adds the work/customer/scheduling enums and the nullable columns the
-- overhauled chat intake captures (job type, system type, equipment age/brand,
-- property/owner, warranty, access notes, arrival window, contact preference,
-- SMS consent, lead source, triage signals) plus customer class / membership /
-- do-not-service and a labor-warranty column on equipment.
--
-- Hand-authored (not drizzle-kit generated): the meta journal carries a
-- pre-existing 0007/0008 snapshot collision (a trigger migration with no schema
-- diff), so drizzle-kit generate fails. The .sql + snapshot are written by hand,
-- matching the established project pattern (see migrations 0008, 0009).

CREATE TYPE "public"."job_type" AS ENUM('service_call', 'no_heat', 'no_cool', 'maintenance', 'install', 'estimate', 'warranty', 'diagnostic', 'inspection');
--> statement-breakpoint
CREATE TYPE "public"."customer_type" AS ENUM('residential', 'commercial');
--> statement-breakpoint
CREATE TYPE "public"."membership_status" AS ENUM('none', 'active', 'suspended', 'expired', 'cancelled');
--> statement-breakpoint
CREATE TYPE "public"."lead_source" AS ENUM('google', 'facebook', 'yelp', 'referral', 'repeat_customer', 'website', 'direct_mail', 'other');
--> statement-breakpoint
CREATE TYPE "public"."system_type" AS ENUM('central_ac', 'furnace', 'heat_pump', 'mini_split', 'boiler', 'packaged_unit', 'other');
--> statement-breakpoint
CREATE TYPE "public"."property_type" AS ENUM('residential', 'commercial');
--> statement-breakpoint
CREATE TYPE "public"."equipment_age_band" AS ENUM('under_5', '5_to_10', '10_to_15', 'over_15', 'unknown');
--> statement-breakpoint
CREATE TYPE "public"."system_down_status" AS ENUM('fully_down', 'partially_working', 'unknown');
--> statement-breakpoint
CREATE TYPE "public"."owner_occupant" AS ENUM('owner', 'renter', 'unknown');
--> statement-breakpoint
CREATE TYPE "public"."tri_state" AS ENUM('yes', 'no', 'unknown');
--> statement-breakpoint
CREATE TYPE "public"."preferred_window" AS ENUM('morning', 'afternoon', 'evening', 'asap');
--> statement-breakpoint
CREATE TYPE "public"."contact_preference" AS ENUM('call', 'text');
--> statement-breakpoint
ALTER TABLE "service_requests" ADD COLUMN "job_type" "job_type";
--> statement-breakpoint
ALTER TABLE "service_requests" ADD COLUMN "system_type" "system_type";
--> statement-breakpoint
ALTER TABLE "service_requests" ADD COLUMN "equipment_brand" text;
--> statement-breakpoint
ALTER TABLE "service_requests" ADD COLUMN "equipment_age_band" "equipment_age_band";
--> statement-breakpoint
ALTER TABLE "service_requests" ADD COLUMN "property_type" "property_type";
--> statement-breakpoint
ALTER TABLE "service_requests" ADD COLUMN "owner_occupant" "owner_occupant";
--> statement-breakpoint
ALTER TABLE "service_requests" ADD COLUMN "under_warranty" "tri_state";
--> statement-breakpoint
ALTER TABLE "service_requests" ADD COLUMN "access_notes" text;
--> statement-breakpoint
ALTER TABLE "service_requests" ADD COLUMN "system_down_status" "system_down_status";
--> statement-breakpoint
ALTER TABLE "service_requests" ADD COLUMN "problem_duration" text;
--> statement-breakpoint
ALTER TABLE "service_requests" ADD COLUMN "vulnerable_occupants" boolean;
--> statement-breakpoint
ALTER TABLE "service_requests" ADD COLUMN "preferred_window" "preferred_window";
--> statement-breakpoint
ALTER TABLE "service_requests" ADD COLUMN "arrival_window_start" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "service_requests" ADD COLUMN "arrival_window_end" timestamp with time zone;
--> statement-breakpoint
ALTER TABLE "service_requests" ADD COLUMN "contact_preference" "contact_preference";
--> statement-breakpoint
ALTER TABLE "service_requests" ADD COLUMN "sms_consent" boolean;
--> statement-breakpoint
ALTER TABLE "service_requests" ADD COLUMN "lead_source" "lead_source";
--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "customer_type" "customer_type" DEFAULT 'residential' NOT NULL;
--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "membership_status" "membership_status" DEFAULT 'none' NOT NULL;
--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "do_not_service" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "customer_equipment" ADD COLUMN "labor_warranty_expiration" timestamp with time zone;
