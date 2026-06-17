CREATE TYPE "public"."org_status" AS ENUM('active', 'suspended', 'trial');--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "status" "org_status" DEFAULT 'active' NOT NULL;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "created_by" uuid;--> statement-breakpoint
ALTER TABLE "organizations" ADD COLUMN "owner_email" text;