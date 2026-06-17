CREATE TABLE "platform_audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"action" text NOT NULL,
	"actor_user_id" uuid,
	"actor_email" text,
	"target_org_id" uuid,
	"details" jsonb,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "attachments" DROP CONSTRAINT "attachments_organization_id_organizations_id_fk";
--> statement-breakpoint
ALTER TABLE "audit_log" DROP CONSTRAINT "audit_log_organization_id_organizations_id_fk";
--> statement-breakpoint
ALTER TABLE "bot_events" DROP CONSTRAINT "bot_events_organization_id_organizations_id_fk";
--> statement-breakpoint
ALTER TABLE "custom_faqs" DROP CONSTRAINT "custom_faqs_organization_id_organizations_id_fk";
--> statement-breakpoint
ALTER TABLE "customer_equipment" DROP CONSTRAINT "customer_equipment_organization_id_organizations_id_fk";
--> statement-breakpoint
ALTER TABLE "customer_notes" DROP CONSTRAINT "customer_notes_organization_id_organizations_id_fk";
--> statement-breakpoint
ALTER TABLE "customer_sessions" DROP CONSTRAINT "customer_sessions_organization_id_organizations_id_fk";
--> statement-breakpoint
ALTER TABLE "customers" DROP CONSTRAINT "customers_organization_id_organizations_id_fk";
--> statement-breakpoint
ALTER TABLE "fieldpulse_connections" DROP CONSTRAINT "fieldpulse_connections_organization_id_organizations_id_fk";
--> statement-breakpoint
ALTER TABLE "fieldpulse_webhook_events" DROP CONSTRAINT "fieldpulse_webhook_events_organization_id_organizations_id_fk";
--> statement-breakpoint
ALTER TABLE "follow_ups" DROP CONSTRAINT "follow_ups_organization_id_organizations_id_fk";
--> statement-breakpoint
ALTER TABLE "google_calendar_connections" DROP CONSTRAINT "google_calendar_connections_organization_id_organizations_id_fk";
--> statement-breakpoint
ALTER TABLE "hcp_webhook_events" DROP CONSTRAINT "hcp_webhook_events_organization_id_organizations_id_fk";
--> statement-breakpoint
ALTER TABLE "housecall_pro_connections" DROP CONSTRAINT "housecall_pro_connections_organization_id_organizations_id_fk";
--> statement-breakpoint
ALTER TABLE "messages" DROP CONSTRAINT "messages_organization_id_organizations_id_fk";
--> statement-breakpoint
ALTER TABLE "organization_settings" DROP CONSTRAINT "organization_settings_organization_id_organizations_id_fk";
--> statement-breakpoint
ALTER TABLE "request_notes" DROP CONSTRAINT "request_notes_request_id_service_requests_id_fk";
--> statement-breakpoint
ALTER TABLE "request_notes" DROP CONSTRAINT "request_notes_organization_id_organizations_id_fk";
--> statement-breakpoint
ALTER TABLE "saas_billing_events" DROP CONSTRAINT "saas_billing_events_organization_id_organizations_id_fk";
--> statement-breakpoint
ALTER TABLE "service_history" DROP CONSTRAINT "service_history_organization_id_organizations_id_fk";
--> statement-breakpoint
ALTER TABLE "service_requests" DROP CONSTRAINT "service_requests_organization_id_organizations_id_fk";
--> statement-breakpoint
ALTER TABLE "staff_invites" DROP CONSTRAINT "staff_invites_organization_id_organizations_id_fk";
--> statement-breakpoint
ALTER TABLE "technician_availability" DROP CONSTRAINT "technician_availability_organization_id_organizations_id_fk";
--> statement-breakpoint
ALTER TABLE "users" DROP CONSTRAINT "users_organization_id_organizations_id_fk";
--> statement-breakpoint
ALTER TABLE "widget_keys" DROP CONSTRAINT "widget_keys_organization_id_organizations_id_fk";
--> statement-breakpoint
ALTER TABLE "customers" ADD COLUMN "anonymized_at" timestamp with time zone;--> statement-breakpoint
CREATE INDEX "platform_audit_log_target_org_idx" ON "platform_audit_log" USING btree ("target_org_id");--> statement-breakpoint
CREATE INDEX "platform_audit_log_created_idx" ON "platform_audit_log" USING btree ("created_at");--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "bot_events" ADD CONSTRAINT "bot_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_faqs" ADD CONSTRAINT "custom_faqs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_equipment" ADD CONSTRAINT "customer_equipment_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_notes" ADD CONSTRAINT "customer_notes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_sessions" ADD CONSTRAINT "customer_sessions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fieldpulse_connections" ADD CONSTRAINT "fieldpulse_connections_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fieldpulse_webhook_events" ADD CONSTRAINT "fieldpulse_webhook_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follow_ups" ADD CONSTRAINT "follow_ups_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "google_calendar_connections" ADD CONSTRAINT "google_calendar_connections_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hcp_webhook_events" ADD CONSTRAINT "hcp_webhook_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "housecall_pro_connections" ADD CONSTRAINT "housecall_pro_connections_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_settings" ADD CONSTRAINT "organization_settings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_notes" ADD CONSTRAINT "request_notes_request_id_service_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."service_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_notes" ADD CONSTRAINT "request_notes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saas_billing_events" ADD CONSTRAINT "saas_billing_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_history" ADD CONSTRAINT "service_history_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_requests" ADD CONSTRAINT "service_requests_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_invites" ADD CONSTRAINT "staff_invites_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "technician_availability" ADD CONSTRAINT "technician_availability_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "widget_keys" ADD CONSTRAINT "widget_keys_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;