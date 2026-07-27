-- Migration 0042: performance indexes — Bucket A (additive, no data change)
-- Tables are ≤~11k rows; standard CREATE INDEX (brief AccessShareLock) is fine.
-- All statements are idempotent via IF NOT EXISTS.

-- ── invoices ──────────────────────────────────────────────────────────────────
-- Expression index for the default list sort (org + coalesce(issued_at, created_at) DESC).
-- The planner uses this for ORDER BY coalesce(issued_at, created_at) DESC queries
-- scoped by organization_id, avoiding a sequential scan + sort.
CREATE INDEX IF NOT EXISTS invoices_org_issued_created_idx
  ON invoices (organization_id, coalesce(issued_at, created_at) DESC);--> statement-breakpoint

-- Partial index: customer_id lookups (customer invoice history; AR per-customer).
CREATE INDEX IF NOT EXISTS invoices_customer_id_idx
  ON invoices (customer_id)
  WHERE customer_id IS NOT NULL;--> statement-breakpoint

-- Composite index: org + state filter (draft/sent/paid/void counts, AR rails).
CREATE INDEX IF NOT EXISTS invoices_org_state_idx
  ON invoices (organization_id, state);--> statement-breakpoint

-- ── service_requests ──────────────────────────────────────────────────────────
-- Partial index: arrival window start for the dispatch board day-view query.
CREATE INDEX IF NOT EXISTS requests_org_arrival_start_idx
  ON service_requests (organization_id, arrival_window_start)
  WHERE arrival_window_start IS NOT NULL;--> statement-breakpoint

-- Partial index: org + assigned_to + status for the tech workload rail.
CREATE INDEX IF NOT EXISTS requests_org_assigned_status_idx
  ON service_requests (organization_id, assigned_to, status)
  WHERE assigned_to IS NOT NULL;--> statement-breakpoint

-- Composite index: org + status for the queue/status filter queries.
CREATE INDEX IF NOT EXISTS requests_org_status_idx
  ON service_requests (organization_id, status);--> statement-breakpoint

-- Partial index: exceptions rail — unassigned queued_* non-terminal requests, oldest-first.
-- Predicate mirrors getDispatchExceptions: assigned_to IS NULL, outcome LIKE 'queued_%',
-- status NOT IN ('completed','cancelled').
CREATE INDEX IF NOT EXISTS requests_dispatch_exceptions_idx
  ON service_requests (organization_id, created_at)
  WHERE assigned_to IS NULL
    AND auto_dispatch_outcome LIKE 'queued_%'
    AND status NOT IN ('completed', 'cancelled');--> statement-breakpoint

-- ── dispatch_decisions ────────────────────────────────────────────────────────
-- Composite index: org + created_at for the decision audit / telemetry time-range queries.
CREATE INDEX IF NOT EXISTS dispatch_decisions_org_created_idx
  ON dispatch_decisions (organization_id, created_at);--> statement-breakpoint

-- ── request_status_events ─────────────────────────────────────────────────────
-- Composite index: org + to_status + at for the operations metrics page
-- (response-time, days-to-completed aggregates filtered by org + status transitions).
CREATE INDEX IF NOT EXISTS request_status_events_org_status_at_idx
  ON request_status_events (organization_id, to_status, at);--> statement-breakpoint

-- ── payments ──────────────────────────────────────────────────────────────────
-- Composite index: org + created_at for AR aging / payment timeline queries.
-- NOTE: payments previously had NO organization_id index (only payments_invoice_idx
-- and two unique partial indexes). This is the first org-scoped index on this table.
CREATE INDEX IF NOT EXISTS payments_org_created_idx
  ON payments (organization_id, created_at);
