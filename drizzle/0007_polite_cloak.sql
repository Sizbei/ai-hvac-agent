ALTER TABLE "customer_sessions" ADD COLUMN "max_turns" integer DEFAULT 15 NOT NULL;--> statement-breakpoint
ALTER TABLE "organization_settings" ADD COLUMN "chat_token_budget" integer;--> statement-breakpoint
ALTER TABLE "organization_settings" ADD COLUMN "chat_max_turns" integer;
