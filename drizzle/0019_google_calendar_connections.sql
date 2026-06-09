-- Per-organization Google Calendar OAuth connection.
--
-- The app syncs scheduled service requests to a business's Google Calendar as
-- events. This table holds ONE connection per org: the target calendar, the
-- long-lived OAuth refresh token (stored ENCRYPTED at rest — AES-256-GCM via
-- @/lib/crypto, NEVER plaintext, NEVER logged), and a short-lived access-token
-- cache the client refreshes from the refresh token before each Calendar API
-- call. `connected` lets an org disconnect without losing the row.
--
-- Plain CREATE TABLE + indexes — no enum / ALTER TYPE, so no in-transaction
-- hazard; runs fine through the standard neon-http file migrator (db:migrate).
CREATE TABLE "google_calendar_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"calendar_id" text DEFAULT 'primary' NOT NULL,
	"refresh_token_encrypted" text,
	"access_token" text,
	"access_token_expires_at" timestamp with time zone,
	"connected" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "google_calendar_connections" ADD CONSTRAINT "google_calendar_connections_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "gcal_connections_org_id_idx" ON "google_calendar_connections" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "gcal_connections_org_unique" ON "google_calendar_connections" USING btree ("organization_id");
