-- Make the technician_availability REPLACE (delete-then-insert in a db.batch,
-- see setTechnicianAvailability) safe at the DB level: one row per
-- (organization_id, technician_id, day_of_week, start_minute). A split shift
-- differs by start_minute, so it is still allowed; an accidental duplicate slot
-- (same start) is now rejected by the database rather than silently doubling a
-- tech's hours and corrupting the open-window math / out-of-hours shading.
--
-- Plain CREATE UNIQUE INDEX — no enum / ALTER TYPE, so no in-transaction hazard;
-- runs through the standard neon-http file migrator.
CREATE UNIQUE INDEX "tech_availability_org_tech_day_start_unique" ON "technician_availability" USING btree ("organization_id","technician_id","day_of_week","start_minute");
