CREATE TYPE "public"."purchase_order_status" AS ENUM('draft', 'ordered', 'received', 'cancelled');--> statement-breakpoint
CREATE TABLE "inventory_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"pricebook_item_id" uuid NOT NULL,
	"quantity_on_hand" integer DEFAULT 0 NOT NULL,
	"reorder_point" integer,
	"unit_cost_cents" integer DEFAULT 0 NOT NULL,
	"location" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "po_line_items" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"purchase_order_id" uuid NOT NULL,
	"pricebook_item_id" uuid,
	"description" text NOT NULL,
	"quantity" integer NOT NULL,
	"unit_cost_cents" integer NOT NULL,
	"line_total_cents" integer NOT NULL
);
--> statement-breakpoint
CREATE TABLE "purchase_orders" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"organization_id" uuid NOT NULL,
	"vendor_name" text NOT NULL,
	"status" "purchase_order_status" DEFAULT 'draft' NOT NULL,
	"total_cents" integer DEFAULT 0 NOT NULL,
	"notes" text,
	"ordered_at" timestamp with time zone,
	"received_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "inventory_items" ADD CONSTRAINT "inventory_items_pricebook_item_id_pricebook_items_id_fk" FOREIGN KEY ("pricebook_item_id") REFERENCES "public"."pricebook_items"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "po_line_items" ADD CONSTRAINT "po_line_items_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "po_line_items" ADD CONSTRAINT "po_line_items_purchase_order_id_purchase_orders_id_fk" FOREIGN KEY ("purchase_order_id") REFERENCES "public"."purchase_orders"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "po_line_items" ADD CONSTRAINT "po_line_items_pricebook_item_id_pricebook_items_id_fk" FOREIGN KEY ("pricebook_item_id") REFERENCES "public"."pricebook_items"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "purchase_orders" ADD CONSTRAINT "purchase_orders_organization_id_organizations_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organizations"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "inventory_items_org_idx" ON "inventory_items" USING btree ("organization_id");--> statement-breakpoint
CREATE UNIQUE INDEX "inventory_items_org_item_unique" ON "inventory_items" USING btree ("organization_id","pricebook_item_id");--> statement-breakpoint
CREATE INDEX "po_line_items_org_idx" ON "po_line_items" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "po_line_items_po_idx" ON "po_line_items" USING btree ("purchase_order_id");--> statement-breakpoint
CREATE INDEX "purchase_orders_org_idx" ON "purchase_orders" USING btree ("organization_id");