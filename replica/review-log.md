# Adversarial review log

## Spec round 1 — 2026-11-01 (architecture.md + schema.sql)

Four blind critics (feasibility vs codebase, database/migration, edge
cases/races/security, scope/simplicity). Verdict: no sign-off; 3 shared
blockers, ~25 majors. Revised the same day.

### Established (verified, carried forward)
- The status enum is `request_status` (`schema.ts:55`), values
  pending/assigned/scheduled/in_progress/on_hold/completed/cancelled.
- The neon-http migrator runs statements one by one with autocommit and
  records files only after all pending files succeed; ADD VALUE works
  (precedent 0001/0008/0013); DDL must be idempotent (precedent 0042, 0044).
- `scheduledDate`, `arrivalWindowStart/End` are timestamptz; the FP import
  can produce window end == start.
- 25 `update(serviceRequests)` sites in 17 files, ~11 schedule/assignee
  write sites, 22 hard-coded status lists → appointment #1 is mirrored by
  a trigger, not by hand; status lists move to shared constants.
- `withTenant` is a WHERE helper, not a gate; body ids must be re-read
  under the org (the slice already does this for customer/technician).
- `reserveCapacitySlot` is a CAS loop and cannot run inside a batch; the
  "placed + reserved can exceed capacity" gap is pre-existing.
- `customers.is_tax_exempt`, `invoices.service_request_id`, `invoices.due_date`
  (timestamptz), `invoices.state`, `pricebook_items.hours`,
  `purchase_orders.received_at` already exist; `users.role` is text.
- Existing calendar day view (dnd-kit DayLane) already covers rows 88/90/92/95.
- Status workflows / guided flows close no must row (57, 128 are should).

### Applied
Enum name; forward FKs removed (zones, tax zones deferred); trigger +
idempotent backfill; one status vocabulary (assignments reuse
`request_status`, no `appointments.status`, no workflow tables in M0);
M0 split into M0b (config) and M0a (schedule); speculative
service_requests columns moved to the milestone that writes them; shifts
without RRULE; capacity adjustments deferred; composite FK on entity_tags;
organization_id everywhere; named idempotent DDL; CAS on `version`;
idempotency-key protocol; stripe_events + refund unique; invoice draft
index predicate; membership_visits index replacement + NULLS NOT DISTINCT;
recurring-billing ordering + Stripe idempotency key; leads encrypted;
contacts in erase batch in M0b; merge hash rules; M2 retargeted to calendar
deltas; build order M0b → M0a → M3 → M2 → M4 → M1 → M5+; done-when per
milestone; business-hours claim dropped; trigram-on-ciphertext removed.

### Rejected (with reason)
- "Make request columns derived from appointment #1" — inverted ownership
  would require rewriting 25 write sites and the FP/HCP sync; the trigger
  direction keeps CAS guards intact. Appointment #1 moves go through the
  existing request update paths.
- "Make session_id nullable" — larger change than the stand-in rule it
  replaces; documented the stand-in token prefixes instead.
- "Count assigned jobs as reservation ordinals" — a redesign of capacity
  holds; recorded as the M2 known gap, not an M0 change.
- "Add appointment_id to capacity_reservations in M0" — visits #2+ do not
  hold band capacity until M2.
- Build-order proposal "M4 money before M2 calendar" — kept M2 (small
  calendar deltas) before M4 because the reassign guard and multi-tech UI
  are needed as soon as M0a's assignments exist.
