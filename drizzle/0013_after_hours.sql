-- After-hours pricing (ServiceTitan-style emergency/after-hours surcharge).
--
--  * organization_settings.after_hours_config (jsonb) — per-org window + fees.
--  * service_requests.is_after_hours (bool) + after_hours_surcharge (int) —
--    computed once at confirm time from the org config so dispatch/dashboard
--    read them off the row.
--
-- Plain ADD COLUMN + a nullable jsonb; the neon-http file-migrator handles this.
-- Hand-authored to match the project's migration pattern.

ALTER TABLE "organization_settings" ADD COLUMN "after_hours_config" jsonb;
--> statement-breakpoint
ALTER TABLE "service_requests" ADD COLUMN "is_after_hours" boolean DEFAULT false NOT NULL;
--> statement-breakpoint
ALTER TABLE "service_requests" ADD COLUMN "after_hours_surcharge" integer DEFAULT 0 NOT NULL;
