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

## Spec round 2 — 2026-11-01 (revised M0 only)

Two blind critics (DDL/trigger/backfill; runtime/feasibility/security).
Verdict: no sign-off on the round-1 text; 2 blockers, ~15 majors, all
applied the same day.

### Established
- Postgres `UPDATE OF` fires on unchanged values; the FP sync rewrites
  every row nightly → separate INSERT and UPDATE triggers, the UPDATE one
  with a `WHEN (OLD.x IS DISTINCT FROM NEW.x …)` clause; the function bumps
  `version` only on real changes, so CAS stays honest.
- Reassign A → B → A would hit the (appointment, technician) unique key
  if the old lead row is kept → new lead is an upsert; old lead deleted
  when it has no progress timestamps, else demoted with status
  `cancelled`.
- Date-only bookings (membership visits, `scheduleRequest` without a
  window) are "unscheduled" today → appointment #1 gets `starts_at` only
  from the arrival window; `scheduled_date` is mirrored as its own column.
- Unschedule nulls all columns → delete appointment #1 (no progress) or
  null its times.
- The existing lists differ (some include `pending`, ops-insights drops
  `scheduled`/`on_hold`) → six constants, no merging, byte-identical output.
- `findCustomerMatchByContact` feeds AI, voice caller-ID and SMS consent →
  contacts never join it.
- FKs need Drizzle names; `drizzle-orm` 0.45.2 supports `check`, composite
  `foreignKey`, partial `uniqueIndex().where()`.
- `deleteCustomer` hard-deletes; users are never deleted (`is_active`).
- The calendar renders requests keyed by request id → visits #2+ on the
  calendar is M2 work; M0a's done-when is API + detail sheet.
- Shifts must be subtracted in five places, not one; HCP-sourced orgs use
  HCP tech ids, so shifts apply to the DB scheduling source only.

### Rejected
- "Ownership = assigned_to OR assignment row" (my own round-1 text) —
  withdrawn for M0a: a visit-#2 tech would be able to complete the whole
  job through the request-status route. Ownership stays `assigned_to`
  until M3 defines per-visit status.
- "Fire en-route / arrived texts from the status tap" — M3 (needs the
  idempotency ledger key and copy review).
- "Fix the ops-insights status drift" — pre-existing; not in M0a.

Convergence: round 2 surfaced new blockers in text round 1 had added
(trigger rules, ownership), both now resolved by narrowing M0a. Round 3
on the spec is folded into the implementation-plan review, whose critics
read the spec and the plan together.
