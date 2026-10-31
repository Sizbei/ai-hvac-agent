-- M0a: two new canonical job statuses for the tech loop. Own file: nothing
-- here USES the values. Precedent: 0001, 0008, 0013.
ALTER TYPE "public"."request_status" ADD VALUE IF NOT EXISTS 'en_route' AFTER 'assigned';
--> statement-breakpoint
ALTER TYPE "public"."request_status" ADD VALUE IF NOT EXISTS 'arrived' AFTER 'en_route';
