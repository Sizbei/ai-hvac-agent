ALTER TYPE "public"."communication_trigger_type" ADD VALUE 'warranty_expiring';--> statement-breakpoint
ALTER TABLE "customer_equipment" ADD COLUMN "warranty_type" text;--> statement-breakpoint
ALTER TABLE "customer_equipment" ADD COLUMN "warranty_provider" text;