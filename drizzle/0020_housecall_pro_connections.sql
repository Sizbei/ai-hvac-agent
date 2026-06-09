-- Per-organization Housecall Pro (HCP) API connection.
--
-- The app integrates with a business's Housecall Pro account (MAX plan) over
-- the HCP REST API. This table holds ONE connection per org: the HCP API key
-- (stored ENCRYPTED at rest — AES-256-GCM via @/lib/crypto, NEVER plaintext,
-- NEVER logged, because an HCP key grants FULL account access) and a cache of
-- NON-secret account metadata (company name, account id) for the settings
-- panel. `connected` lets an org disconnect (clear the key) without losing the
-- row.
--
-- Plain CREATE TABLE + indexes — no enum / ALTER TYPE, so no in-transaction
-- hazard; runs fine through the standard neon-http file migrator (db:migrate).
CREATE TABLE "housecall_pro_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"api_key_encrypted" text,
	"account_info" jsonb,
	"connected" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "housecall_pro_connections" ADD CONSTRAINT "housecall_pro_connections_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "hcp_connections_org_id_idx" ON "housecall_pro_connections" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "hcp_connections_org_unique" ON "housecall_pro_connections" USING btree ("organization_id");
