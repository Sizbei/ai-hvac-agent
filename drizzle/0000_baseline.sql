CREATE TYPE "public"."actor_type" AS ENUM('human', 'ai', 'system');--> statement-breakpoint
CREATE TYPE "public"."availability_sync_status" AS ENUM('pending', 'in_progress', 'completed', 'failed');--> statement-breakpoint
CREATE TYPE "public"."communication_channel" AS ENUM('sms', 'email', 'voice');--> statement-breakpoint
CREATE TYPE "public"."communication_job_status" AS ENUM('pending', 'processing', 'sent', 'failed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."communication_template_type" AS ENUM('sms', 'email_html', 'email_text');--> statement-breakpoint
CREATE TYPE "public"."communication_trigger_type" AS ENUM('appointment_scheduled', 'appointment_reminder_24h', 'appointment_reminder_2h', 'appointment_rescheduled', 'appointment_cancelled', 'technician_enroute', 'technician_arrived', 'job_completed', 'review_request', 'follow_up', 'escalation');--> statement-breakpoint
CREATE TYPE "public"."contact_preference" AS ENUM('call', 'text');--> statement-breakpoint
CREATE TYPE "public"."custom_field_entity_type" AS ENUM('customer', 'service_request', 'both');--> statement-breakpoint
CREATE TYPE "public"."custom_field_type" AS ENUM('text', 'textarea', 'select', 'multiselect', 'number', 'currency', 'date', 'checkbox');--> statement-breakpoint
CREATE TYPE "public"."customer_type" AS ENUM('residential', 'commercial');--> statement-breakpoint
CREATE TYPE "public"."equipment_age_band" AS ENUM('under_5', '5_to_10', '10_to_15', 'over_15', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."equipment_type" AS ENUM('ac', 'furnace', 'heat_pump', 'boiler', 'mini_split', 'thermostat', 'other');--> statement-breakpoint
CREATE TYPE "public"."estimate_status" AS ENUM('open', 'sold', 'dismissed', 'expired');--> statement-breakpoint
CREATE TYPE "public"."financing_status" AS ENUM('pending', 'approved', 'declined', 'expired');--> statement-breakpoint
CREATE TYPE "public"."follow_up_status" AS ENUM('pending', 'completed', 'overdue', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."hold_reason" AS ENUM('awaiting_parts', 'awaiting_customer', 'awaiting_access', 'weather', 'other');--> statement-breakpoint
CREATE TYPE "public"."invoice_state" AS ENUM('draft', 'open', 'paid', 'void', 'refunded');--> statement-breakpoint
CREATE TYPE "public"."invoice_status" AS ENUM('none', 'sent', 'paid', 'void');--> statement-breakpoint
CREATE TYPE "public"."job_type" AS ENUM('service_call', 'no_heat', 'no_cool', 'maintenance', 'install', 'estimate', 'warranty', 'diagnostic', 'inspection');--> statement-breakpoint
CREATE TYPE "public"."lead_source" AS ENUM('google', 'facebook', 'yelp', 'referral', 'repeat_customer', 'website', 'direct_mail', 'other');--> statement-breakpoint
CREATE TYPE "public"."membership_status" AS ENUM('none', 'active', 'suspended', 'expired', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."message_role" AS ENUM('user', 'assistant', 'system');--> statement-breakpoint
CREATE TYPE "public"."note_type" AS ENUM('general', 'follow_up', 'complaint', 'compliment');--> statement-breakpoint
CREATE TYPE "public"."owner_occupant" AS ENUM('owner', 'renter', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."payment_status" AS ENUM('pending', 'succeeded', 'failed', 'refunded');--> statement-breakpoint
CREATE TYPE "public"."preferred_window" AS ENUM('morning', 'afternoon', 'evening', 'asap');--> statement-breakpoint
CREATE TYPE "public"."pricebook_item_type" AS ENUM('service', 'material', 'equipment');--> statement-breakpoint
CREATE TYPE "public"."property_type" AS ENUM('residential', 'commercial');--> statement-breakpoint
CREATE TYPE "public"."request_status" AS ENUM('pending', 'assigned', 'scheduled', 'in_progress', 'on_hold', 'completed', 'cancelled');--> statement-breakpoint
CREATE TYPE "public"."session_channel" AS ENUM('web', 'phone', 'sms');--> statement-breakpoint
CREATE TYPE "public"."session_mode" AS ENUM('ai', 'human');--> statement-breakpoint
CREATE TYPE "public"."session_outcome" AS ENUM('booked', 'escalated', 'info_provided', 'abandoned', 'unresolved');--> statement-breakpoint
CREATE TYPE "public"."session_status" AS ENUM('chatting', 'extracting', 'confirmed', 'submitted', 'escalated', 'abandoned');--> statement-breakpoint
CREATE TYPE "public"."system_down_status" AS ENUM('fully_down', 'partially_working', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."system_type" AS ENUM('central_ac', 'furnace', 'heat_pump', 'mini_split', 'boiler', 'packaged_unit', 'other');--> statement-breakpoint
CREATE TYPE "public"."tri_state" AS ENUM('yes', 'no', 'unknown');--> statement-breakpoint
CREATE TYPE "public"."urgency" AS ENUM('low', 'medium', 'high', 'emergency');--> statement-breakpoint
CREATE TABLE "attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"message_id" uuid,
	"service_request_id" uuid,
	"equipment_id" uuid,
	"filename" text NOT NULL,
	"mime_type" text NOT NULL,
	"size" integer NOT NULL,
	"storage_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "audit_log" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"user_id" uuid,
	"session_id" uuid,
	"actor_type" "actor_type" DEFAULT 'human' NOT NULL,
	"action" text NOT NULL,
	"entity" text NOT NULL,
	"entity_id" uuid,
	"details" text,
	"ip_address" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "communication_jobs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"template_id" uuid NOT NULL,
	"trigger_type" "communication_trigger_type" NOT NULL,
	"channel" "communication_channel" NOT NULL,
	"status" "communication_job_status" DEFAULT 'pending' NOT NULL,
	"priority" integer DEFAULT 50 NOT NULL,
	"recipient_phone_encrypted" text,
	"recipient_email_encrypted" text,
	"template_variables" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"scheduled_for" timestamp with time zone NOT NULL,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 3 NOT NULL,
	"error_message" text,
	"external_id" varchar(255),
	"customer_id" uuid,
	"service_request_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "communication_preferences" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"sms_enabled" boolean DEFAULT true NOT NULL,
	"email_enabled" boolean DEFAULT true NOT NULL,
	"voice_enabled" boolean DEFAULT false NOT NULL,
	"appointment_reminders" boolean DEFAULT true NOT NULL,
	"automated_confirmations" boolean DEFAULT true NOT NULL,
	"review_requests" boolean DEFAULT true NOT NULL,
	"marketing_messages" boolean DEFAULT false NOT NULL,
	"timezone" varchar(50) DEFAULT 'America/New_York',
	"do_not_contact" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "communication_templates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"key" varchar(100) NOT NULL,
	"name" varchar(255) NOT NULL,
	"description" text,
	"trigger_type" "communication_trigger_type" NOT NULL,
	"template_type" "communication_template_type" NOT NULL,
	"subject_template" text,
	"body_template" text NOT NULL,
	"variables" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"priority" integer DEFAULT 50 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "custom_faqs" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"question" text NOT NULL,
	"answer" text NOT NULL,
	"triggers" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "custom_field_definitions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"key" varchar(100) NOT NULL,
	"label" varchar(255) NOT NULL,
	"description" text,
	"entity_type" "custom_field_entity_type" NOT NULL,
	"field_type" "custom_field_type" NOT NULL,
	"options" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"required" boolean DEFAULT false NOT NULL,
	"placeholder" text,
	"default_value" jsonb,
	"validation" jsonb,
	"display_order" integer DEFAULT 0 NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "custom_field_values" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"field_definition_id" uuid NOT NULL,
	"entity_type" "custom_field_entity_type" NOT NULL,
	"entity_id" uuid NOT NULL,
	"value" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customer_equipment" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"equipment_type" "equipment_type" NOT NULL,
	"make" text,
	"model" text,
	"serial_number" text,
	"install_date" timestamp with time zone,
	"warranty_expiration" timestamp with time zone,
	"labor_warranty_expiration" timestamp with time zone,
	"location_in_home" text,
	"notes" text,
	"location_id" uuid,
	"replaced_by_equipment_id" uuid,
	"retired_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customer_locations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"address_encrypted" text NOT NULL,
	"address_hash" text,
	"label" text,
	"zone" text,
	"property_type" text,
	"access_notes" text,
	"latitude" double precision,
	"longitude" double precision,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customer_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"author_id" uuid,
	"content" text NOT NULL,
	"note_type" "note_type" DEFAULT 'general' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "customer_sessions" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"token" text NOT NULL,
	"status" "session_status" DEFAULT 'chatting' NOT NULL,
	"tokens_used" integer DEFAULT 0 NOT NULL,
	"token_budget" integer DEFAULT 10000 NOT NULL,
	"turn_count" integer DEFAULT 0 NOT NULL,
	"max_turns" integer DEFAULT 15 NOT NULL,
	"channel" "session_channel" DEFAULT 'web' NOT NULL,
	"metadata" text,
	"running_summary" text,
	"summary" text,
	"outcome" "session_outcome",
	"next_steps" jsonb,
	"mode" "session_mode" DEFAULT 'ai' NOT NULL,
	"customer_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone,
	CONSTRAINT "customer_sessions_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "customers" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name_encrypted" text NOT NULL,
	"phone_encrypted" text,
	"email_encrypted" text,
	"address_encrypted" text,
	"email_hash" text,
	"phone_hash" text,
	"property_type" text,
	"property_sqft" integer,
	"notes" text,
	"customer_type" "customer_type" DEFAULT 'residential' NOT NULL,
	"membership_status" "membership_status" DEFAULT 'none' NOT NULL,
	"do_not_service" boolean DEFAULT false NOT NULL,
	"hcp_customer_id" text,
	"fieldpulse_customer_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"archived_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "estimate_line_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"option_id" uuid NOT NULL,
	"pricebook_item_id" uuid,
	"name" text NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"unit_price_cents" integer DEFAULT 0 NOT NULL,
	"cost_cents" integer DEFAULT 0 NOT NULL,
	"line_total_cents" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "estimate_options" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"estimate_id" uuid NOT NULL,
	"name" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"subtotal_cents" integer DEFAULT 0 NOT NULL,
	"tax_cents" integer DEFAULT 0 NOT NULL,
	"total_cents" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "estimates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"service_request_id" uuid,
	"customer_id" uuid,
	"status" "estimate_status" DEFAULT 'open' NOT NULL,
	"total_cents" integer DEFAULT 0 NOT NULL,
	"approval_token_hash" text,
	"expires_at" timestamp with time zone,
	"signed_at" timestamp with time zone,
	"signature_name" text,
	"signature_ip" text,
	"sold_option_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fieldpulse_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"api_key_encrypted" text,
	"webhook_secret_encrypted" text,
	"account_info" jsonb,
	"connected" boolean DEFAULT false NOT NULL,
	"last_availability_sync_at" timestamp with time zone,
	"availability_sync_status" "availability_sync_status" DEFAULT 'pending' NOT NULL,
	"last_sync_error" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "fieldpulse_webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"fieldpulse_job_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "financing_applications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"customer_id" uuid,
	"estimate_id" uuid,
	"provider" text NOT NULL,
	"provider_app_id" text,
	"status" "financing_status" DEFAULT 'pending' NOT NULL,
	"requested_amount_cents" integer NOT NULL,
	"approved_amount_cents" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "follow_ups" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"assigned_to" uuid,
	"reason" text NOT NULL,
	"due_date" timestamp with time zone NOT NULL,
	"completed_at" timestamp with time zone,
	"status" "follow_up_status" DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
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
CREATE TABLE "hcp_webhook_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"event_id" text NOT NULL,
	"event_type" text NOT NULL,
	"hcp_job_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "housecall_pro_connections" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"api_key_encrypted" text,
	"webhook_secret_encrypted" text,
	"account_info" jsonb,
	"connected" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoice_line_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"name" text NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL,
	"unit_price_cents" integer DEFAULT 0 NOT NULL,
	"cost_cents" integer DEFAULT 0 NOT NULL,
	"line_total_cents" integer DEFAULT 0 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "invoices" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"service_request_id" uuid,
	"customer_id" uuid,
	"estimate_id" uuid,
	"state" "invoice_state" DEFAULT 'draft' NOT NULL,
	"subtotal_cents" integer DEFAULT 0 NOT NULL,
	"tax_cents" integer DEFAULT 0 NOT NULL,
	"total_cents" integer DEFAULT 0 NOT NULL,
	"amount_paid_cents" integer DEFAULT 0 NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"role" "message_role" NOT NULL,
	"content" text NOT NULL,
	"tokens_used" integer,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organization_settings" (
	"organization_id" uuid PRIMARY KEY NOT NULL,
	"company_name" text,
	"logo_url" text,
	"primary_color" varchar(9),
	"welcome_message" text,
	"launcher_position" text,
	"allowed_origins" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"disabled_issue_types" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"disabled_service_tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"business_info" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"chat_token_budget" integer,
	"chat_max_turns" integer,
	"after_hours_config" jsonb,
	"voice_transfer_number" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "organizations" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"name" text NOT NULL,
	"slug" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "organizations_slug_unique" UNIQUE("slug")
);
--> statement-breakpoint
CREATE TABLE "outbound_message_ledger" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"customer_id" uuid NOT NULL,
	"trigger_type" "communication_trigger_type" NOT NULL,
	"period_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "payments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"invoice_id" uuid NOT NULL,
	"provider" text NOT NULL,
	"provider_payment_id" text,
	"amount_cents" integer NOT NULL,
	"status" "payment_status" DEFAULT 'pending' NOT NULL,
	"is_deposit" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pricebook_categories" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"parent_id" uuid,
	"name" text NOT NULL,
	"sort_order" integer DEFAULT 0 NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pricebook_item_materials" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"item_id" uuid NOT NULL,
	"material_item_id" uuid NOT NULL,
	"quantity" integer DEFAULT 1 NOT NULL
);
--> statement-breakpoint
CREATE TABLE "pricebook_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"category_id" uuid,
	"type" "pricebook_item_type" NOT NULL,
	"name" text NOT NULL,
	"description" text,
	"sku" text,
	"cost_cents" integer DEFAULT 0 NOT NULL,
	"markup_pct" integer DEFAULT 0 NOT NULL,
	"price_cents" integer DEFAULT 0 NOT NULL,
	"member_price_cents" integer,
	"hours" integer,
	"warranty" text,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "refunds" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"payment_id" uuid NOT NULL,
	"amount_cents" integer NOT NULL,
	"reason" text,
	"provider_refund_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "request_notes" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"request_id" uuid NOT NULL,
	"organization_id" uuid NOT NULL,
	"author_id" uuid,
	"content" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "request_status_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"service_request_id" uuid NOT NULL,
	"from_status" "request_status",
	"to_status" "request_status" NOT NULL,
	"actor_type" "actor_type" DEFAULT 'system' NOT NULL,
	"actor_id" uuid,
	"at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "service_history" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"customer_id" uuid NOT NULL,
	"service_request_id" uuid,
	"organization_id" uuid NOT NULL,
	"equipment_id" uuid,
	"work_performed" text,
	"parts_used" text,
	"cost" integer,
	"technician_notes" text,
	"follow_up_needed" boolean DEFAULT false NOT NULL,
	"follow_up_date" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "service_requests" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"session_id" uuid NOT NULL,
	"customer_id" uuid,
	"location_id" uuid,
	"assigned_to" uuid,
	"status" "request_status" DEFAULT 'pending' NOT NULL,
	"issue_type" text NOT NULL,
	"urgency" "urgency" NOT NULL,
	"description" text NOT NULL,
	"job_type" "job_type",
	"system_type" "system_type",
	"equipment_brand" text,
	"equipment_age_band" "equipment_age_band",
	"property_type" "property_type",
	"owner_occupant" "owner_occupant",
	"under_warranty" "tri_state",
	"access_notes" text,
	"system_down_status" "system_down_status",
	"problem_duration" text,
	"vulnerable_occupants" boolean,
	"preferred_window" "preferred_window",
	"arrival_window_start" timestamp with time zone,
	"arrival_window_end" timestamp with time zone,
	"hold_reason" "hold_reason",
	"follow_up_date" timestamp with time zone,
	"contact_preference" "contact_preference",
	"sms_consent" boolean,
	"lead_source" "lead_source",
	"is_after_hours" boolean DEFAULT false NOT NULL,
	"customer_name_encrypted" text,
	"customer_phone_encrypted" text,
	"customer_email_encrypted" text,
	"address_encrypted" text,
	"reference_number" varchar(20) NOT NULL,
	"hcp_job_id" text,
	"fieldpulse_job_id" text,
	"invoice_status" "invoice_status" DEFAULT 'none' NOT NULL,
	"scheduled_date" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "service_requests_reference_number_unique" UNIQUE("reference_number")
);
--> statement-breakpoint
CREATE TABLE "staff_invites" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"email" text NOT NULL,
	"role" text NOT NULL,
	"token_hash" text NOT NULL,
	"invited_by_user_id" uuid NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"accepted_at" timestamp with time zone,
	"revoked_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "staff_invites_token_hash_unique" UNIQUE("token_hash")
);
--> statement-breakpoint
CREATE TABLE "tax_rates" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"name" text NOT NULL,
	"jurisdiction" text,
	"rate_bps" integer NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "technician_availability" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"technician_id" uuid NOT NULL,
	"day_of_week" integer NOT NULL,
	"start_minute" integer NOT NULL,
	"end_minute" integer NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"password_hash" text,
	"google_id" text,
	"fieldpulse_user_id" text,
	"role" text DEFAULT 'technician' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "widget_keys" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"key_hash" text NOT NULL,
	"key_prefix" text NOT NULL,
	"key_type" text NOT NULL,
	"scopes" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"label" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"revoked_at" timestamp with time zone,
	"last_used_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "widget_keys_key_hash_unique" UNIQUE("key_hash")
);
--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_session_id_customer_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."customer_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "audit_log" ADD CONSTRAINT "audit_log_session_id_customer_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."customer_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "communication_jobs" ADD CONSTRAINT "communication_jobs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "communication_jobs" ADD CONSTRAINT "communication_jobs_template_id_communication_templates_id_fk" FOREIGN KEY ("template_id") REFERENCES "public"."communication_templates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "communication_jobs" ADD CONSTRAINT "communication_jobs_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "communication_jobs" ADD CONSTRAINT "communication_jobs_service_request_id_service_requests_id_fk" FOREIGN KEY ("service_request_id") REFERENCES "public"."service_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "communication_preferences" ADD CONSTRAINT "communication_preferences_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "communication_templates" ADD CONSTRAINT "communication_templates_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_faqs" ADD CONSTRAINT "custom_faqs_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_field_definitions" ADD CONSTRAINT "custom_field_definitions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_field_values" ADD CONSTRAINT "custom_field_values_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "custom_field_values" ADD CONSTRAINT "custom_field_values_field_definition_id_custom_field_definitions_id_fk" FOREIGN KEY ("field_definition_id") REFERENCES "public"."custom_field_definitions"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_equipment" ADD CONSTRAINT "customer_equipment_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_equipment" ADD CONSTRAINT "customer_equipment_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_locations" ADD CONSTRAINT "customer_locations_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_locations" ADD CONSTRAINT "customer_locations_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_notes" ADD CONSTRAINT "customer_notes_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_notes" ADD CONSTRAINT "customer_notes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_notes" ADD CONSTRAINT "customer_notes_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_sessions" ADD CONSTRAINT "customer_sessions_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customer_sessions" ADD CONSTRAINT "customer_sessions_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "customers" ADD CONSTRAINT "customers_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estimate_line_items" ADD CONSTRAINT "estimate_line_items_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estimate_line_items" ADD CONSTRAINT "estimate_line_items_option_id_estimate_options_id_fk" FOREIGN KEY ("option_id") REFERENCES "public"."estimate_options"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estimate_options" ADD CONSTRAINT "estimate_options_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estimate_options" ADD CONSTRAINT "estimate_options_estimate_id_estimates_id_fk" FOREIGN KEY ("estimate_id") REFERENCES "public"."estimates"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "estimates" ADD CONSTRAINT "estimates_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fieldpulse_connections" ADD CONSTRAINT "fieldpulse_connections_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "fieldpulse_webhook_events" ADD CONSTRAINT "fieldpulse_webhook_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "financing_applications" ADD CONSTRAINT "financing_applications_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follow_ups" ADD CONSTRAINT "follow_ups_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follow_ups" ADD CONSTRAINT "follow_ups_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "follow_ups" ADD CONSTRAINT "follow_ups_assigned_to_users_id_fk" FOREIGN KEY ("assigned_to") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "google_calendar_connections" ADD CONSTRAINT "google_calendar_connections_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hcp_webhook_events" ADD CONSTRAINT "hcp_webhook_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "housecall_pro_connections" ADD CONSTRAINT "housecall_pro_connections_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_line_items" ADD CONSTRAINT "invoice_line_items_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoice_line_items" ADD CONSTRAINT "invoice_line_items_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "invoices" ADD CONSTRAINT "invoices_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_session_id_customer_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."customer_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "organization_settings" ADD CONSTRAINT "organization_settings_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_message_ledger" ADD CONSTRAINT "outbound_message_ledger_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "outbound_message_ledger" ADD CONSTRAINT "outbound_message_ledger_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "payments" ADD CONSTRAINT "payments_invoice_id_invoices_id_fk" FOREIGN KEY ("invoice_id") REFERENCES "public"."invoices"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pricebook_categories" ADD CONSTRAINT "pricebook_categories_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pricebook_item_materials" ADD CONSTRAINT "pricebook_item_materials_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pricebook_item_materials" ADD CONSTRAINT "pricebook_item_materials_item_id_pricebook_items_id_fk" FOREIGN KEY ("item_id") REFERENCES "public"."pricebook_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pricebook_item_materials" ADD CONSTRAINT "pricebook_item_materials_material_item_id_pricebook_items_id_fk" FOREIGN KEY ("material_item_id") REFERENCES "public"."pricebook_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "pricebook_items" ADD CONSTRAINT "pricebook_items_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "refunds" ADD CONSTRAINT "refunds_payment_id_payments_id_fk" FOREIGN KEY ("payment_id") REFERENCES "public"."payments"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_notes" ADD CONSTRAINT "request_notes_request_id_service_requests_id_fk" FOREIGN KEY ("request_id") REFERENCES "public"."service_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_notes" ADD CONSTRAINT "request_notes_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_notes" ADD CONSTRAINT "request_notes_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_status_events" ADD CONSTRAINT "request_status_events_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "request_status_events" ADD CONSTRAINT "request_status_events_service_request_id_service_requests_id_fk" FOREIGN KEY ("service_request_id") REFERENCES "public"."service_requests"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_history" ADD CONSTRAINT "service_history_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_history" ADD CONSTRAINT "service_history_service_request_id_service_requests_id_fk" FOREIGN KEY ("service_request_id") REFERENCES "public"."service_requests"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_history" ADD CONSTRAINT "service_history_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_history" ADD CONSTRAINT "service_history_equipment_id_customer_equipment_id_fk" FOREIGN KEY ("equipment_id") REFERENCES "public"."customer_equipment"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_requests" ADD CONSTRAINT "service_requests_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_requests" ADD CONSTRAINT "service_requests_session_id_customer_sessions_id_fk" FOREIGN KEY ("session_id") REFERENCES "public"."customer_sessions"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_requests" ADD CONSTRAINT "service_requests_customer_id_customers_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."customers"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "service_requests" ADD CONSTRAINT "service_requests_assigned_to_users_id_fk" FOREIGN KEY ("assigned_to") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_invites" ADD CONSTRAINT "staff_invites_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "staff_invites" ADD CONSTRAINT "staff_invites_invited_by_user_id_users_id_fk" FOREIGN KEY ("invited_by_user_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tax_rates" ADD CONSTRAINT "tax_rates_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "technician_availability" ADD CONSTRAINT "technician_availability_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "technician_availability" ADD CONSTRAINT "technician_availability_technician_id_users_id_fk" FOREIGN KEY ("technician_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "users" ADD CONSTRAINT "users_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "widget_keys" ADD CONSTRAINT "widget_keys_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attachments_org_id_idx" ON "attachments" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "attachments_session_id_idx" ON "attachments" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "attachments_message_id_idx" ON "attachments" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "attachments_service_request_idx" ON "attachments" USING btree ("service_request_id") WHERE "attachments"."service_request_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "audit_org_id_idx" ON "audit_log" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "audit_action_idx" ON "audit_log" USING btree ("action");--> statement-breakpoint
CREATE INDEX "audit_created_idx" ON "audit_log" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "communication_jobs_org_id_idx" ON "communication_jobs" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "communication_jobs_status_scheduled_idx" ON "communication_jobs" USING btree ("status","scheduled_for") WHERE "communication_jobs"."status" IN ('pending', 'failed');--> statement-breakpoint
CREATE INDEX "communication_jobs_service_request_idx" ON "communication_jobs" USING btree ("service_request_id");--> statement-breakpoint
CREATE INDEX "communication_jobs_customer_idx" ON "communication_jobs" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "communication_jobs_external_id_idx" ON "communication_jobs" USING btree ("external_id");--> statement-breakpoint
CREATE INDEX "communication_prefs_org_id_idx" ON "communication_preferences" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "communication_prefs_org_customer_unique" ON "communication_preferences" USING btree ("organization_id","customer_id");--> statement-breakpoint
CREATE INDEX "communication_templates_org_id_idx" ON "communication_templates" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "communication_templates_org_trigger_active_idx" ON "communication_templates" USING btree ("organization_id","trigger_type","is_active");--> statement-breakpoint
CREATE UNIQUE INDEX "communication_templates_org_key_unique" ON "communication_templates" USING btree ("organization_id","key");--> statement-breakpoint
CREATE INDEX "custom_faqs_org_id_idx" ON "custom_faqs" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "custom_faqs_org_active_idx" ON "custom_faqs" USING btree ("organization_id","is_active");--> statement-breakpoint
CREATE INDEX "custom_field_defs_org_id_idx" ON "custom_field_definitions" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "custom_field_defs_org_entity_active_idx" ON "custom_field_definitions" USING btree ("organization_id","entity_type","is_active");--> statement-breakpoint
CREATE UNIQUE INDEX "custom_field_defs_org_key_unique" ON "custom_field_definitions" USING btree ("organization_id","key") WHERE "custom_field_definitions"."is_active" = true;--> statement-breakpoint
CREATE INDEX "custom_field_values_org_id_idx" ON "custom_field_values" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "custom_field_values_field_def_idx" ON "custom_field_values" USING btree ("field_definition_id");--> statement-breakpoint
CREATE INDEX "custom_field_values_entity_idx" ON "custom_field_values" USING btree ("entity_type","entity_id");--> statement-breakpoint
CREATE UNIQUE INDEX "custom_field_values_field_entity_unique" ON "custom_field_values" USING btree ("field_definition_id","entity_type","entity_id");--> statement-breakpoint
CREATE INDEX "equipment_customer_id_idx" ON "customer_equipment" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "equipment_org_id_idx" ON "customer_equipment" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "customer_locations_customer_idx" ON "customer_locations" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "customer_locations_org_idx" ON "customer_locations" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "customer_locations_customer_addr_unique" ON "customer_locations" USING btree ("customer_id","address_hash") WHERE "customer_locations"."address_hash" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "notes_customer_id_idx" ON "customer_notes" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "notes_org_id_idx" ON "customer_notes" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "sessions_org_id_idx" ON "customer_sessions" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "sessions_token_idx" ON "customer_sessions" USING btree ("token");--> statement-breakpoint
CREATE INDEX "sessions_status_idx" ON "customer_sessions" USING btree ("status");--> statement-breakpoint
CREATE INDEX "sessions_org_created_idx" ON "customer_sessions" USING btree ("organization_id","created_at");--> statement-breakpoint
CREATE INDEX "sessions_org_channel_idx" ON "customer_sessions" USING btree ("organization_id","channel");--> statement-breakpoint
CREATE INDEX "sessions_customer_id_idx" ON "customer_sessions" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "customers_org_id_idx" ON "customers" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "customers_org_email_hash_unique" ON "customers" USING btree ("organization_id","email_hash") WHERE "customers"."email_hash" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "customers_org_phone_hash_unique" ON "customers" USING btree ("organization_id","phone_hash") WHERE "customers"."phone_hash" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "estimate_line_items_option_idx" ON "estimate_line_items" USING btree ("option_id");--> statement-breakpoint
CREATE INDEX "estimate_options_estimate_idx" ON "estimate_options" USING btree ("estimate_id");--> statement-breakpoint
CREATE INDEX "estimates_org_idx" ON "estimates" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "estimates_request_idx" ON "estimates" USING btree ("service_request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "estimates_approval_token_unique" ON "estimates" USING btree ("approval_token_hash") WHERE "estimates"."approval_token_hash" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "fieldpulse_connections_org_id_idx" ON "fieldpulse_connections" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "fieldpulse_connections_org_unique" ON "fieldpulse_connections" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "fieldpulse_connections_sync_status_idx" ON "fieldpulse_connections" USING btree ("availability_sync_status") WHERE "fieldpulse_connections"."connected" = true;--> statement-breakpoint
CREATE INDEX "fieldpulse_webhook_events_org_id_idx" ON "fieldpulse_webhook_events" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "fieldpulse_webhook_events_org_event_unique" ON "fieldpulse_webhook_events" USING btree ("organization_id","event_id");--> statement-breakpoint
CREATE INDEX "financing_applications_org_idx" ON "financing_applications" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "followups_customer_id_idx" ON "follow_ups" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "followups_org_id_idx" ON "follow_ups" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "followups_due_date_idx" ON "follow_ups" USING btree ("due_date");--> statement-breakpoint
CREATE INDEX "followups_status_idx" ON "follow_ups" USING btree ("status");--> statement-breakpoint
CREATE INDEX "gcal_connections_org_id_idx" ON "google_calendar_connections" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "gcal_connections_org_unique" ON "google_calendar_connections" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "hcp_webhook_events_org_id_idx" ON "hcp_webhook_events" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "hcp_webhook_events_org_event_unique" ON "hcp_webhook_events" USING btree ("organization_id","event_id");--> statement-breakpoint
CREATE INDEX "hcp_connections_org_id_idx" ON "housecall_pro_connections" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "hcp_connections_org_unique" ON "housecall_pro_connections" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "invoice_line_items_invoice_idx" ON "invoice_line_items" USING btree ("invoice_id");--> statement-breakpoint
CREATE INDEX "invoices_org_idx" ON "invoices" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "invoices_request_idx" ON "invoices" USING btree ("service_request_id");--> statement-breakpoint
CREATE UNIQUE INDEX "invoices_estimate_unique" ON "invoices" USING btree ("estimate_id") WHERE "invoices"."estimate_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "messages_org_id_idx" ON "messages" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "messages_session_id_idx" ON "messages" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "messages_session_created_idx" ON "messages" USING btree ("session_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "outbound_ledger_unique" ON "outbound_message_ledger" USING btree ("organization_id","customer_id","trigger_type","period_key");--> statement-breakpoint
CREATE INDEX "payments_invoice_idx" ON "payments" USING btree ("invoice_id");--> statement-breakpoint
CREATE UNIQUE INDEX "payments_provider_id_unique" ON "payments" USING btree ("provider","provider_payment_id") WHERE "payments"."provider_payment_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "pricebook_categories_org_idx" ON "pricebook_categories" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "pricebook_item_materials_item_idx" ON "pricebook_item_materials" USING btree ("item_id");--> statement-breakpoint
CREATE INDEX "pricebook_items_org_idx" ON "pricebook_items" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "pricebook_items_category_idx" ON "pricebook_items" USING btree ("category_id");--> statement-breakpoint
CREATE UNIQUE INDEX "pricebook_items_org_sku_unique" ON "pricebook_items" USING btree ("organization_id","sku") WHERE "pricebook_items"."sku" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "refunds_payment_idx" ON "refunds" USING btree ("payment_id");--> statement-breakpoint
CREATE INDEX "request_notes_request_id_idx" ON "request_notes" USING btree ("request_id");--> statement-breakpoint
CREATE INDEX "request_notes_org_id_idx" ON "request_notes" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "request_status_events_request_idx" ON "request_status_events" USING btree ("service_request_id");--> statement-breakpoint
CREATE INDEX "request_status_events_org_idx" ON "request_status_events" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "history_customer_id_idx" ON "service_history" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "history_org_id_idx" ON "service_history" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "history_equipment_id_idx" ON "service_history" USING btree ("equipment_id") WHERE "service_history"."equipment_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "requests_org_id_idx" ON "service_requests" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "requests_session_id_idx" ON "service_requests" USING btree ("session_id");--> statement-breakpoint
CREATE INDEX "requests_status_idx" ON "service_requests" USING btree ("status");--> statement-breakpoint
CREATE INDEX "requests_ref_idx" ON "service_requests" USING btree ("reference_number");--> statement-breakpoint
CREATE INDEX "requests_customer_id_idx" ON "service_requests" USING btree ("customer_id");--> statement-breakpoint
CREATE INDEX "requests_hcp_job_id_idx" ON "service_requests" USING btree ("hcp_job_id") WHERE "service_requests"."hcp_job_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "requests_org_fieldpulse_job_id_unique" ON "service_requests" USING btree ("organization_id","fieldpulse_job_id") WHERE "service_requests"."fieldpulse_job_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "staff_invites_org_id_idx" ON "staff_invites" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "staff_invites_token_hash_idx" ON "staff_invites" USING btree ("token_hash");--> statement-breakpoint
CREATE UNIQUE INDEX "staff_invites_live_unique" ON "staff_invites" USING btree ("organization_id","email") WHERE "staff_invites"."accepted_at" IS NULL AND "staff_invites"."revoked_at" IS NULL;--> statement-breakpoint
CREATE INDEX "tax_rates_org_idx" ON "tax_rates" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "tax_rates_org_default_unique" ON "tax_rates" USING btree ("organization_id") WHERE "tax_rates"."is_default" = true AND "tax_rates"."active" = true;--> statement-breakpoint
CREATE INDEX "tech_availability_org_id_idx" ON "technician_availability" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "tech_availability_org_tech_idx" ON "technician_availability" USING btree ("organization_id","technician_id");--> statement-breakpoint
CREATE INDEX "tech_availability_org_tech_day_idx" ON "technician_availability" USING btree ("organization_id","technician_id","day_of_week");--> statement-breakpoint
CREATE UNIQUE INDEX "tech_availability_org_tech_day_start_unique" ON "technician_availability" USING btree ("organization_id","technician_id","day_of_week","start_minute");--> statement-breakpoint
CREATE INDEX "users_org_id_idx" ON "users" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "users_email_idx" ON "users" USING btree ("email");--> statement-breakpoint
CREATE UNIQUE INDEX "users_org_email_unique" ON "users" USING btree ("organization_id","email");--> statement-breakpoint
CREATE UNIQUE INDEX "users_google_id_unique" ON "users" USING btree ("google_id") WHERE "users"."google_id" IS NOT NULL;--> statement-breakpoint
CREATE UNIQUE INDEX "users_org_fieldpulse_user_id_unique" ON "users" USING btree ("organization_id","fieldpulse_user_id") WHERE "users"."fieldpulse_user_id" IS NOT NULL;--> statement-breakpoint
CREATE INDEX "widget_keys_org_id_idx" ON "widget_keys" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "widget_keys_hash_idx" ON "widget_keys" USING btree ("key_hash");