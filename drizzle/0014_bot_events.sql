CREATE TABLE "bot_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"session_id" uuid,
	"turn" integer NOT NULL,
	"channel" text DEFAULT 'web' NOT NULL,
	"routed" boolean NOT NULL,
	"intent_id" text,
	"action" text,
	"category" text,
	"extraction_complete" boolean DEFAULT false NOT NULL,
	"escalated" boolean DEFAULT false NOT NULL,
	"model" text,
	"latency_ms" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "bot_events" ADD CONSTRAINT "bot_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "bot_events_org_created_idx" ON "bot_events" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "bot_events_org_intent_idx" ON "bot_events" USING btree ("organization_id","intent_id");