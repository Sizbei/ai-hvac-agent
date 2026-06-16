-- Stage 5 follow-up: index the per-asset history lookup (sign-off fail).
CREATE INDEX "history_equipment_id_idx"
  ON "service_history" ("equipment_id")
  WHERE "equipment_id" IS NOT NULL;
