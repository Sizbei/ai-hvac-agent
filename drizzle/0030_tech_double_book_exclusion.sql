-- HAND-AUTHORED (drizzle-kit cannot represent EXCLUDE constraints). Not in
-- schema.ts / the meta snapshot, so `drizzle-kit generate` — which diffs
-- schema.ts against its snapshot, NOT the live DB — will not try to drop it
-- (same approach as the 0008 last-admin trigger).
--
-- Prevents a technician from being double-booked: no two ACTIVE jobs for the
-- same tech may have OVERLAPPING arrival windows. This is the atomic guard the
-- app-level checkScheduleConflict (a read) couldn't provide under neon-http's
-- no-row-locks — two concurrent placements both passed the read and double-booked.
-- tstzrange defaults to '[)' (half-open), matching the app's strict-end overlap
-- (a back-to-back booking that ends exactly when the next starts is NOT a
-- conflict). btree_gist supplies the `=` operators for the uuid columns.
CREATE EXTENSION IF NOT EXISTS btree_gist;
--> statement-breakpoint
-- Conditional add: only if no EXISTING active overlap violates it, so a deploy
-- against data with legacy double-books is NOT blocked (it logs + skips instead;
-- clean the rows and add the constraint manually). New writes are still guarded
-- once the constraint exists.
DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM service_requests a
    JOIN service_requests b
      ON a.organization_id = b.organization_id
     AND a.assigned_to = b.assigned_to
     AND a.id < b.id
     AND a.arrival_window_start < b.arrival_window_end
     AND b.arrival_window_start < a.arrival_window_end
    WHERE a.assigned_to IS NOT NULL
      AND a.arrival_window_start IS NOT NULL
      AND a.arrival_window_end IS NOT NULL
      AND b.arrival_window_start IS NOT NULL
      AND b.arrival_window_end IS NOT NULL
      AND a.status IN ('pending', 'assigned', 'scheduled', 'in_progress', 'on_hold')
      AND b.status IN ('pending', 'assigned', 'scheduled', 'in_progress', 'on_hold')
  ) THEN
    ALTER TABLE service_requests
      ADD CONSTRAINT service_requests_no_tech_double_book
      EXCLUDE USING gist (
        organization_id WITH =,
        assigned_to WITH =,
        tstzrange(arrival_window_start, arrival_window_end) WITH &&
      )
      WHERE (
        assigned_to IS NOT NULL
        AND arrival_window_start IS NOT NULL
        AND arrival_window_end IS NOT NULL
        AND status IN ('pending', 'assigned', 'scheduled', 'in_progress', 'on_hold')
      );
  ELSE
    RAISE NOTICE 'Skipped service_requests_no_tech_double_book: existing active overlapping bookings present. Resolve them, then add the constraint manually.';
  END IF;
END $$;
