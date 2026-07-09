ALTER TABLE "invoices" ADD COLUMN "issued_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "invoices" ADD COLUMN "due_date" timestamp with time zone;