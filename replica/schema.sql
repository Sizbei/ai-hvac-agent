-- replica/schema.sql
-- Target schema deltas for the FieldPulse + ServiceTitan replica, written as
-- Postgres DDL. These become Drizzle migrations (drizzle/00XX.sql with
-- statement-breakpoints + _journal.json + snapshot) one milestone at a time;
-- this file is the design, not the migration. Conventions match schema.ts:
-- uuid ids, organization_id on everything, timestamptz, integer cents,
-- enums as pg enums, org-scoped unique indexes, FKs with explicit on delete.
--
-- Access rule: no RLS. Every query goes through the data layer with the
-- session's organization_id (withTenant). Nothing in this file changes that.

-- ---------------------------------------------------------------------------
-- Migration conventions (verified against src/lib/db/migrate.ts and
-- node_modules/drizzle-orm/neon-http/migrator.js):
--   * the neon-http migrator runs each statement with its own autocommit and
--     records a file in __drizzle_migrations only after EVERY pending file
--     has run. A failure half-way leaves partial DDL with no record, and the
--     next build re-runs the file from the top. So every statement here is
--     idempotent: IF NOT EXISTS on tables/columns/indexes, DO $$ … EXCEPTION
--     WHEN duplicate_object $$ around CREATE TYPE / ADD CONSTRAINT,
--     CREATE OR REPLACE FUNCTION + DROP TRIGGER IF EXISTS (precedent:
--     drizzle/0042_perf_indexes.sql, drizzle/0044_last_admin_guard.sql).
--   * ALTER TYPE … ADD VALUE works (no transaction; precedent 0001, 0008,
--     0013). A new value is not USED in the same file; the backfill that
--     writes it is a later file.
--   * every index, unique, check AND foreign key is NAMED with the Drizzle
--     name (`<table>_<col>_<reftable>_<refcol>_fk`, `<table>_<cols>_unique`,
--     `<table>_<cols>_idx`) and the same name goes in schema.ts, so
--     `drizzle-kit generate` reports "No schema changes" (AGENTS.md) and a
--     later generated DROP CONSTRAINT finds the live name. Inline
--     `references` below is shorthand for the migration's
--     `DO $$ … ADD CONSTRAINT "<name>" FOREIGN KEY … EXCEPTION WHEN
--     duplicate_object $$` block; columns are added plain, the FK after.
--   * a new journal `when` must exceed the previous entry's.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- M0b  Config foundation: tags, contacts, primary location, job types.
--      No dual writes, no backfill of behaviour; ships first.
-- ---------------------------------------------------------------------------

-- must rows closed: 27 customer/location tags, 55 job tags with colour and
-- dispatch visibility.
do $$ begin
  create type tag_entity as enum ('customer','location','job');
exception when duplicate_object then null; end $$;

create table if not exists tag_types (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  entity tag_entity not null,
  name text not null,
  color text not null default 'graphite',    -- a status-colors.ts token name, never hex
  visible_on_board boolean not null default false,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint tag_types_org_entity_name_unique unique (organization_id, entity, name),
  -- lets entity_tags carry a composite FK so a tag can never cross orgs or kinds
  constraint tag_types_id_org_entity_unique unique (id, organization_id, entity)
);

-- one polymorphic link table; entity_id is not an FK on purpose (three
-- target tables). deleteCustomer, the request delete path and the location
-- delete path delete their entity_tags rows in the same batch.
create table if not exists entity_tags (
  organization_id uuid not null references organizations(id) on delete cascade,
  tag_type_id uuid not null,
  entity tag_entity not null,
  entity_id uuid not null,
  created_at timestamptz not null default now(),
  constraint entity_tags_pkey primary key (tag_type_id, entity, entity_id),
  constraint entity_tags_tag_type_fk foreign key (tag_type_id, organization_id, entity)
    references tag_types(id, organization_id, entity) on delete cascade
);
create index if not exists entity_tags_org_entity_idx
  on entity_tags (organization_id, entity, entity_id);

-- must rows closed: 22 multiple contacts with per-method preferences;
-- 49 create job with customer / contact / location (contact part).
-- PII encrypted + blind-indexed exactly like customers; the erase batch in
-- src/lib/admin/erasure-queries.ts anonymises these rows in the SAME PR
-- (erase updates the customer row, so the cascade never fires there;
-- deleteCustomer in crm-queries.ts hard-deletes and must also delete the
-- customer's and its locations' entity_tags).
create table if not exists customer_contacts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  customer_id uuid not null references customers(id) on delete cascade,
  location_id uuid references customer_locations(id) on delete set null,
  name_encrypted text not null,
  role text,                                 -- "tenant", "property manager", ...
  phone_encrypted text,
  phone_hash text,                           -- HMAC blind index like customers
  email_encrypted text,
  email_hash text,
  -- channel opt-outs stay in communication_preferences (one store); per-contact
  -- routing of reminders/invoices is M6 work, so row 22 closes as partial.
  is_primary boolean not null default false,
  position smallint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists customer_contacts_org_customer_idx
  on customer_contacts (organization_id, customer_id);
create index if not exists customer_contacts_org_phone_hash_idx
  on customer_contacts (organization_id, phone_hash);

-- must row closed: 23 multiple service locations (the primary flag; the
-- table and the S04 UI exist). Backfill: the oldest location per customer
-- becomes primary. The create path (location-queries.ts persistJobLocation)
-- sets is_primary = NOT EXISTS (another location for the customer) with a
-- conflict target on customer_locations_customer_addr_unique, and the
-- delete path re-selects the oldest remaining location as primary.
alter table customer_locations
  add column if not exists is_primary boolean not null default false;
create unique index if not exists customer_locations_one_primary_idx
  on customer_locations (customer_id) where is_primary;
update customer_locations l set is_primary = true
  where not is_primary and l.id = (
    select id from customer_locations x
    where x.customer_id = l.customer_id order by created_at, id limit 1)
  and not exists (
    select 1 from customer_locations p where p.customer_id = l.customer_id and p.is_primary);

-- must rows closed: 56 org-configurable job types; 83 job-type default
-- duration. The job_type ENUM stays as the canonical "kind" that the AI
-- intake, duration table, FP/HCP mappers and forecasting read (about 25
-- files; none change). Every org gets one seeded row per enum value with
-- default_duration_minutes from JOB_DURATION_DEFAULTS in
-- src/lib/ai/dispatch/duration.ts (provisioning hook + a one-off backfill
-- for existing orgs);
-- service_requests.job_type_id is backfilled from job_type. The create
-- path writes BOTH job_type_id and job_type = job_types.kind.
create table if not exists job_types (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  name text not null,
  kind job_type not null,
  default_duration_minutes integer not null default 90,
  default_priority urgency not null default 'medium',
  active boolean not null default true,
  position smallint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint job_types_org_name_unique unique (organization_id, name),
  constraint job_types_duration_check check (default_duration_minutes between 15 and 1440)
);
alter table service_requests
  add column if not exists job_type_id uuid references job_types(id) on delete set null;
create index if not exists requests_job_type_id_idx on service_requests (job_type_id);

-- ---------------------------------------------------------------------------
-- M0a  Schedule foundation: two status values, appointments + assignments
--      (backfilled, kept in step by a trigger), shifts. Gets its own
--      adversarial review before merge.
-- ---------------------------------------------------------------------------

-- must row closed: 117 en route / arrived statuses. The enum is
-- `request_status` (schema.ts:55). Its own migration file; nothing in the
-- same file uses the values. Code changes in the same PR, enumerated in
-- architecture.md "Status enum readers" (22 readers; one shared constant).
alter type request_status add value if not exists 'en_route' after 'assigned';
alter type request_status add value if not exists 'arrived' after 'en_route';

-- must row closed: 64 multi-visit and multi-day jobs.
--
-- Ownership rule (the one that keeps the FP/HCP sync, the AI booking path,
-- 25 request-update sites and the calendar working unchanged):
--   * service_requests.scheduled_date / arrival_window_start / _end /
--     assigned_to / status REMAIN the source of truth for appointment #1.
--   * a trigger on service_requests mirrors them into
--     appointments(appointment_number = 1) and its lead assignment.
--   * appointments with appointment_number >= 2 are written only by the data
--     layer (never by the trigger) and never touch the request columns.
--   * the job status (request_status) is the job's status. Per-technician
--     progress lives on appointment_assignments.status and uses the SAME
--     enum, so there is one vocabulary.
create table if not exists appointments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  service_request_id uuid not null references service_requests(id) on delete cascade,
  appointment_number smallint not null default 1,
  scheduled_date timestamptz,                -- date-only booking (no window), mirrored from the request
  starts_at timestamptz,                     -- = arrival_window_start for #1; set directly for #2+
  ends_at timestamptz,                       -- = arrival_window_end for #1
  arrival_window_start timestamptz,
  arrival_window_end timestamptz,
  is_confirmed boolean not null default false,
  cancelled_at timestamptz,
  special_instructions text,                 -- free text; included in the erase batch
  version integer not null default 0,        -- optimistic concurrency (CAS on version, not updated_at); the trigger bumps it on every real change
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint appointments_request_number_unique unique (service_request_id, appointment_number),
  constraint appointments_window_check
    check (arrival_window_end is null or arrival_window_start is null or arrival_window_end > arrival_window_start),
  constraint appointments_span_check
    check (ends_at is null or starts_at is null or ends_at >= starts_at)
);
create index if not exists appointments_org_starts_at_idx on appointments (organization_id, starts_at);
create index if not exists appointments_request_idx on appointments (service_request_id);

create table if not exists appointment_assignments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  appointment_id uuid not null references appointments(id) on delete cascade,
  technician_id uuid not null references users(id) on delete cascade,
  is_lead boolean not null default false,
  status request_status not null default 'assigned',  -- per-tech progress, same vocabulary
  assigned_by uuid references users(id) on delete set null,
  assigned_at timestamptz not null default now(),
  en_route_at timestamptz,
  arrived_at timestamptz,
  started_at timestamptz,
  completed_at timestamptz,
  constraint appointment_assignments_unique unique (appointment_id, technician_id)
);
create unique index if not exists appointment_assignments_one_lead_idx
  on appointment_assignments (appointment_id) where is_lead;
create index if not exists appointment_assignments_tech_appt_idx
  on appointment_assignments (technician_id, appointment_id);
create index if not exists appointment_assignments_org_tech_idx
  on appointment_assignments (organization_id, technician_id);

-- Triggers: request -> appointment #1 (+ lead assignment). Idempotent DDL
-- in the 0044 style. TWO triggers so the UPDATE one can carry a WHEN clause
-- (OLD is not allowed in the WHEN of a trigger that also fires on INSERT):
--   AFTER INSERT                                   -> sync_request_appointment()
--   AFTER UPDATE OF scheduled_date, arrival_window_start, arrival_window_end,
--     assigned_to, status
--     WHEN (OLD.scheduled_date IS DISTINCT FROM NEW.scheduled_date OR … each column)
--                                                  -> sync_request_appointment()
-- so the FP nightly sync, which rewrites identical values on every row,
-- does not fire it. The function, in order:
--   1. if NEW.scheduled_date, arrival_window_start, arrival_window_end and
--      assigned_to are all null: delete appointment #1 when no assignment on
--      it has a progress timestamp (en_route_at/arrived_at/started_at/
--      completed_at), otherwise null its times; return.
--   2. upsert appointments #1 (on conflict (service_request_id,
--      appointment_number) do update):
--        scheduled_date        = NEW.scheduled_date
--        arrival_window_start  = NEW.arrival_window_start
--        arrival_window_end    = NEW.arrival_window_end, or null when
--                                <= NEW.arrival_window_start
--        starts_at / ends_at   = the (possibly nulled) window; a date-only
--                                booking has starts_at null (it is listed as
--                                unscheduled today and stays so)
--        cancelled_at          = coalesce(cancelled_at, now()) when
--                                NEW.status = 'cancelled' (un-cancel is not a
--                                legal transition); the same UPDATE also
--                                stamps cancelled_at on every OTHER
--                                appointment of the request, so visits #2+
--                                leave the calendar and release capacity
--        version               = version + 1, updated_at = now()
--   3. lead assignment, when NEW.assigned_to is not null:
--        a. the current lead row with technician_id <> NEW.assigned_to:
--           delete it when all four progress timestamps are null (a dispatch
--           change, the FP sync, a drag), otherwise set is_lead = false,
--           status = 'cancelled' and keep it (history; a removed technician
--           never reads as active on the job);
--        b. insert (appointment #1, NEW.assigned_to, is_lead = true,
--           status = NEW.status, assigned_at = now())
--           on conflict (appointment_id, technician_id) do update set
--           is_lead = true, status = NEW.status   -- A -> B -> A works
--      when NEW.assigned_to is null: the current lead is deleted or demoted
--      by the same rule as 3a.
--   4. lead status mirror: when the lead's technician_id = NEW.assigned_to,
--      set lead.status = NEW.status (single-tech jobs stay in step; M3's
--      per-tech endpoints write non-lead rows and the roll-up).
-- Visits #2+ are touched by the function only for the cancel stamp above.
-- Tech-app ownership stays `service_requests.assigned_to = me` in M0a
-- (reads and writes); assignment rows grant nothing in the tech app until
-- M3 defines per-visit status and the roll-up.
create or replace function sync_request_appointment() returns trigger
  language plpgsql as $$ … see drizzle/00XX_appointments.sql … $$;
drop trigger if exists service_requests_sync_appointment_ins on service_requests;
create trigger service_requests_sync_appointment_ins
  after insert on service_requests
  for each row execute function sync_request_appointment();
drop trigger if exists service_requests_sync_appointment_upd on service_requests;
create trigger service_requests_sync_appointment_upd
  after update of scheduled_date, arrival_window_start, arrival_window_end, assigned_to, status
  on service_requests for each row
  when (old.scheduled_date is distinct from new.scheduled_date
     or old.arrival_window_start is distinct from new.arrival_window_start
     or old.arrival_window_end is distinct from new.arrival_window_end
     or old.assigned_to is distinct from new.assigned_to
     or old.status is distinct from new.status)
  execute function sync_request_appointment();

-- Backfill (separate file, after the triggers exist; idempotent via NOT
-- EXISTS): one appointment #1 per request that has a scheduled_date OR an
-- arrival_window_start OR an assigned_to, using the same formulas as the
-- function; lead assignment where assigned_to is not null with status =
-- request status; cancelled_at = updated_at where status = 'cancelled'.
-- Pre-flight in the PR: count rows where arrival_window_end <=
-- arrival_window_start (they get a null end). Done-when check:
-- count(requests with date OR window OR assignee) = count(appointments
-- where appointment_number = 1).

-- must rows closed: 85 shifts (on-call / time-off); 86 non-job events that
-- remove capacity. The weekly pattern stays in technician_availability
-- (already read by scheduling, FP availability sync, autodispatch); shifts
-- are date-bound exceptions only. No RRULE: a repeating PTO is N rows.
do $$ begin
  create type shift_kind as enum ('on_call','time_off','non_job');
exception when duplicate_object then null; end $$;
create table if not exists technician_shifts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  technician_id uuid not null references users(id) on delete cascade,
  kind shift_kind not null,
  title text,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  removes_capacity boolean not null default true,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  constraint technician_shifts_order_check check (ends_at > starts_at)
);
create index if not exists technician_shifts_org_tech_starts_idx
  on technician_shifts (organization_id, technician_id, starts_at);

-- Deferred out of M0 (each moves to the milestone that first writes it):
--   service_zones / technician_zones / customer_locations.zone_id  -> M2 (should, row 100)
--   capacity_adjustments                                          -> M2 (should, row 82)
--   status_workflows / workflow_statuses / guided flows           -> M6+ (should, rows 57, 128)
--   customers.customer_status / parent / merged_to / payment_term -> M1 (leads, merge)
--   customer_locations.preferred_technician_id / merged_to_id     -> M1
--   service_requests: cancel_reason, cancel_memo, sold_by_id,
--     template_id, archived_at, booking_source                    -> M1
--   service_requests.created_from_estimate_id                     -> M4
--   service_requests.recall_for_id / warranty_of_id / no_charge   -> M3 (should)
--   project_id, recurring_series_id                               -> not in plan (no table)
--   customers.tax_exempt                                          -> dropped: is_tax_exempt exists
--   customer_locations.tax_zone_id                                -> M4, after tax_zones

-- ---------------------------------------------------------------------------
-- M1  Office booking loop: leads, bookings review, call reasons
-- ---------------------------------------------------------------------------

create table leads (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  customer_id uuid references customers(id) on delete set null,
  location_id uuid references customer_locations(id) on delete set null,
  session_id uuid references customer_sessions(id) on delete set null,
  source text not null,                    -- call|chat|sms|web|portal|tech|manual
  status text not null default 'open'
    check (status in ('open','contacted','unreachable','booked','dismissed')),
  priority urgency not null default 'medium',
  summary_encrypted text,                  -- free text can hold names/phones: AES-GCM like customers
  call_reason text,                        -- enum-like reason code, not free text
  follow_up_at timestamptz,
  dismiss_reason text,
  booked_request_id uuid references service_requests(id) on delete set null,
  assigned_to uuid references users(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on leads (organization_id, status, follow_up_at);

alter table service_requests
  add column dismiss_reason text;         -- bookings review: dismissed-with-reason

create table job_templates (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  name text not null,
  job_type_id uuid references job_types(id) on delete set null,
  defaults jsonb not null default '{}',    -- summary, duration, tags, skills, items
  created_at timestamptz not null default now(),
  unique (organization_id, name)
);

-- ---------------------------------------------------------------------------
-- M3a  Run the day: per-tech progress, general time, trigger changes
-- ---------------------------------------------------------------------------

-- technician_time_entries exists per job (clockIn/clockOut, labor cost,
-- tte_open_per_tech_job_unique on (service_request_id, technician_id)
-- WHERE clock_out_at IS NULL). Add general entries and the visit link.
-- GPS / backdating / timesheet codes are a `should` row and are not added.
alter table technician_time_entries
  add column if not exists kind text not null default 'job',
  add column if not exists appointment_id uuid references appointments(id) on delete set null,
  add column if not exists clock_in_method text not null default 'manual';
-- one DO block per constraint (a shared block would skip the rest after one duplicate)
do $$ begin alter table technician_time_entries add constraint tte_kind_check
  check (kind in ('job','general')); exception when duplicate_object then null; end $$;
do $$ begin alter table technician_time_entries add constraint tte_clock_in_method_check
  check (clock_in_method in ('auto','manual')); exception when duplicate_object then null; end $$;
-- a job entry always has a request; a general entry never does
do $$ begin alter table technician_time_entries add constraint tte_kind_request_check
  check ((kind = 'job') = (service_request_id is not null)); exception when duplicate_object then null; end $$;
alter table technician_time_entries alter column service_request_id drop not null;
-- NULL request ids never collide in tte_open_per_tech_job_unique:
create unique index if not exists tte_open_general_per_tech_idx
  on technician_time_entries (organization_id, technician_id)
  where kind = 'general' and clock_out_at is null;
-- Readers filter kind = 'job': the on-site KPI (operations-metrics), the
-- labor journal (accounting-export), reporting; general entries carry no
-- labor cost.

-- Trigger changes to sync_request_appointment (CREATE OR REPLACE, same
-- names): (a) step 4 mirrors request status onto the lead row only while
-- en_route_at, arrived_at, started_at and completed_at are all NULL, and
-- step 3's ON CONFLICT keeps a row's status when it has progress; (b) a
-- demoted lead keeps 'completed' (steps 1 and 3); (c) when NEW.status =
-- 'cancelled', every assignment on every visit of the request with status
-- not in ('completed','cancelled') becomes 'cancelled' and every open
-- kind='job' time entry on the request is closed (minutes; labor from
-- users.labor_rate_cents); (d) when NEW.status = 'completed' assignments
-- are left as they are. Admin edits that would rewrite a visit with
-- progress (updateAppointment for #2+, reschedule/assign/unschedule for
-- #1) refuse with 409 HAS_PROGRESS. Admin hold applies the hold rule to
-- the active visit; admin completed with open progressed rows → 409.
-- Hold rule, auto-entry ON CONFLICT and the close-out predicate: F04.

-- ---------------------------------------------------------------------------
-- M3b  Collect: manual payments, one native draft per request, idempotency
-- ---------------------------------------------------------------------------

-- payments today: provider ('mock'|'stripe'), provider_payment_id, is_deposit.
-- A manual payment skips the provider entirely and is told apart by method.
alter table payments
  add column if not exists method text not null default 'card',
  add column if not exists check_number text;
do $$ begin
  alter table payments add constraint payments_method_check
    check (method in ('card','cash','check','other'));
exception when duplicate_object then null; end $$;
-- provider gains the value 'manual' (text column; no enum). The portal
-- pay button and POST /api/portal/[token]/pay refuse while
-- getPaymentProvider().name = 'mock' (no fake card payments, ever).

-- Pulled forward from M4: one NATIVE DRAFT per request (synced and
-- finalised invoices excluded) so a double-tapped create adopts the draft.
create unique index if not exists invoices_one_native_draft_per_request_idx
  on invoices (service_request_id)
  where service_request_id is not null and state = 'draft'
    and fieldpulse_invoice_id is null and hcp_invoice_id is null;

-- Every money-moving tech POST carries an idempotency key. State machine:
--   rate check → INSERT key (state 'in_progress') ON CONFLICT DO NOTHING RETURNING
--   winner  → write with entity ids = uuid_v5(org|user|route|key) and
--             ON CONFLICT (id) DO NOTHING → UPDATE state='done', response
--   loser   → done + same hash: replay stored status/body (ids/enums only)
--           → different hash: 422
--           → in_progress younger than 2 min: 409 + Retry-After
--           → in_progress older than 2 min: CAS takeover + re-run
-- TTL 7 days (purged by the cleanup cron); multipart routes hash
-- (route, job id, sha256(file), name) and claim before the upload.
create table if not exists idempotency_keys (
  organization_id uuid not null references organizations(id) on delete cascade,
  user_id uuid not null references users(id) on delete cascade,
  route text not null,
  key text not null,
  request_hash text not null,
  state text not null default 'in_progress',
  response_status smallint,
  response_body jsonb,                     -- ids/enums only
  created_at timestamptz not null default now(),
  constraint idempotency_keys_pkey primary key (organization_id, user_id, route, key),
  constraint idempotency_keys_state_check check (state in ('in_progress','done'))
);
create index if not exists idempotency_keys_created_idx on idempotency_keys (created_at);

-- Erase (same PR): delete the R2 objects behind service_requests.signature_url
-- and any invoice signature for the customer's requests (today only
-- attachments.storage_key is collected).

-- ---------------------------------------------------------------------------
-- M3c  Sell on site: no new tables. Estimate accept = a markEstimateSold
--      variant (signer name + signature key, actor tech); sold lines →
--      draft invoice lines (exactly once: keyed on estimate option id).
--      Equipment add/replace uses customer_equipment.replaced_by_equipment_id
--      / retired_at, which exist.
-- ---------------------------------------------------------------------------

-- ---------------------------------------------------------------------------
-- M3d  Forms + site view
-- ---------------------------------------------------------------------------

create table if not exists forms (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  name text not null,
  description text,
  fields jsonb not null default '[]',      -- [{id,type,label,required,internal}] flat; no pages, no pull_from
  active boolean not null default true,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint forms_org_name_unique unique (organization_id, name)
);
create table if not exists form_submissions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  form_id uuid not null references forms(id) on delete restrict,
  form_version integer not null,
  service_request_id uuid not null references service_requests(id) on delete cascade,
  appointment_id uuid references appointments(id) on delete set null,
  submitted_by uuid references users(id) on delete set null,
  values_encrypted text not null,          -- free text can hold PII: AES-GCM like customers; erased with the customer
  status text not null default 'draft',
  submitted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint form_submissions_status_check check (status in ('draft','submitted')),
  -- a replayed PUT upserts instead of duplicating
  constraint form_submissions_request_visit_form_unique
    unique nulls not distinct (service_request_id, appointment_id, form_id)
);
create index if not exists form_submissions_org_request_idx
  on form_submissions (organization_id, service_request_id);
-- required_for_job_type_ids and "required forms block close-out" are a
-- `should` row and are not in M3.

-- ---------------------------------------------------------------------------
-- M4  Money builder: invoice/estimate editing, templates, discounts, tax zones,
--     payments
-- ---------------------------------------------------------------------------

alter table estimates
  add column template_id uuid,
  add column deposit_cents integer,
  add column deposit_pct smallint,
  add column require_deposit_on_signature boolean not null default false,
  add column is_change_order boolean not null default false,
  add column dismiss_reason text,
  add column internal_notes text,
  add column locked_at timestamptz,        -- lock-at-milestone (sent/sold)
  add column sold_by_id uuid references users(id) on delete set null,
  add column follow_up_status text not null default 'not_attempted'
    check (follow_up_status in ('not_attempted','unreachable','contacted','won','dismissed'));
alter table estimate_options
  add column is_recommended boolean not null default false,
  add column description text,
  add column position smallint not null default 0;
alter table estimate_line_items
  add column group_name text,
  add column is_optional boolean not null default false,
  add column is_selected boolean not null default true,
  add column price_visible boolean not null default true,
  add column photo_attachment_id uuid references attachments(id) on delete set null,
  add column position smallint not null default 0;

create table estimate_templates (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  name text not null,
  body jsonb not null,                     -- options + line items (sku refs + qty)
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, name)
);
alter table estimates add constraint estimates_template_fk
  foreign key (template_id) references estimate_templates(id) on delete set null;

-- sold-not-booked: which sold lines still need work booked
alter table estimate_line_items
  add column booked_request_id uuid references service_requests(id) on delete set null;

-- invoices already has service_request_id, due_date (timestamptz) and
-- state (invoice_state enum: draft/open/paid/void/...). Extend only:
alter table invoices
  add column location_id uuid references customer_locations(id) on delete set null,
  add column payment_term_days smallint,
  add column display_settings jsonb not null default '{}',   -- show qty/price/sku/tax toggles
  add column amount_due_display text not null default 'remaining_balance'
    check (amount_due_display in ('remaining_balance','set_amount','percent','none')),
  add column amount_due_value_cents integer,
  add column locked_at timestamptz,
  add column batch_id uuid,
  add column sync_status text not null default 'pending'
    check (sync_status in ('pending','posted','exported'));
alter table invoice_line_items
  add column group_name text,
  add column price_visible boolean not null default true,
  add column position smallint not null default 0,
  add column discount_fee_id uuid;
-- draft invoice auto-created at booking: invoices.state='draft',
-- service_request_id set, zero lines. One NATIVE DRAFT per request (synced
-- FP/HCP invoices and finalised invoices are excluded, so estimate-to-invoice,
-- deposit + final invoices and the mirrors keep working). The
-- estimate-to-invoice path ADOPTS the draft when one exists.
-- invoices_one_native_draft_per_request_idx: pulled forward into M3b.

create table discounts_fees (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  kind text not null check (kind in ('discount','fee')),
  code text, name text not null,
  amount_type text not null check (amount_type in ('fixed','percent')),
  amount integer not null,                 -- cents or basis points
  taxable boolean not null default false,
  allow_custom_amount boolean not null default false,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (organization_id, name)
);
alter table invoice_line_items add constraint ili_discount_fk
  foreign key (discount_fee_id) references discounts_fees(id) on delete set null;

create table tax_zones (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  name text not null,
  rates jsonb not null default '[]',       -- [{name, rate_bps}]
  total_rate_bps integer not null,
  zip_codes text[] not null default '{}',
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  unique (organization_id, name)
);

alter table payments
  add column check_number text,
  add column memo text,
  add column batch_id uuid;
-- payment splits across invoices (ST): keep payments 1:1 with invoice for
-- now; a split is modelled as N payments sharing a `group_id`.
alter table payments add column group_id uuid;

create table customer_payment_methods (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  customer_id uuid not null references customers(id) on delete cascade,
  provider text not null,                  -- 'stripe'
  provider_customer_id text not null,
  provider_method_id text not null,
  kind text not null check (kind in ('card','ach')),
  brand text, last4 text, exp_month smallint, exp_year smallint,
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  unique (organization_id, provider_method_id)
);

create table accounting_batches (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  number serial,
  status text not null default 'pending' check (status in ('pending','posted','exported','locked')),
  period_start date, period_end date,
  posted_at timestamptz, exported_at timestamptz,
  export_target text,                      -- 'csv' | 'qbo'
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now()
);
alter table invoices add constraint invoices_batch_fk
  foreign key (batch_id) references accounting_batches(id) on delete set null;
alter table payments add constraint payments_batch_fk
  foreign key (batch_id) references accounting_batches(id) on delete set null;

-- Stripe webhook ledger, same pattern as the existing *_webhook_events tables:
create table stripe_events (
  organization_id uuid references organizations(id) on delete cascade,
  event_id text primary key,               -- Stripe evt_… ; a duplicate delivery is a no-op
  type text not null,
  received_at timestamptz not null default now(),
  processed_at timestamptz
);
-- refunds dedupe on the provider id (webhook charge.refunded after an in-app refund is a no-op):
create unique index refunds_provider_refund_unique
  on refunds (provider_refund_id) where provider_refund_id is not null;

-- ---------------------------------------------------------------------------
-- M5  Agreements: types with billing table, routines, service events,
--     recurring billing
-- ---------------------------------------------------------------------------

-- membership_plans exists (name, price, billingPeriod, visitsPerYear,
-- benefits). Extend into a membership *type* with a duration x billing table
-- and routines.
alter table membership_plans
  add column billing_options jsonb not null default '[]',
    -- [{duration_months, frequency: one_time|monthly|quarterly|annual, sale_price_cents, billing_price_cents, renewal_price_cents}]
  add column discount_pct smallint not null default 0,
  add column auto_renew boolean not null default true,
  add column show_savings boolean not null default true,
  add column contract_template text;

create table agreement_routines (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  plan_id uuid not null references membership_plans(id) on delete cascade,
  name text not null,                      -- "Spring AC tune-up"
  kind text not null default 'scheduled' check (kind in ('scheduled','on_demand')),
  recurrence text not null,                -- RRULE: FREQ=YEARLY;BYMONTH=4
  offset_days integer not null default 0,
  job_type_id uuid references job_types(id) on delete set null,
  job_template_id uuid references job_templates(id) on delete set null,
  duration_minutes integer,
  generation_rule text not null default 'unscheduled'
    check (generation_rule in ('none','unscheduled','auto_schedule','fixed')),
  visit_allowance smallint,                -- on_demand only
  position smallint not null default 0
);

-- customer_memberships exists (customer, plan, status, startedAt,
-- currentPeriodEnd, cancelledAt, providerSubscriptionId). Extend:
alter table customer_memberships
  add column location_id uuid references customer_locations(id) on delete set null,
  add column billing_option jsonb,         -- the chosen row from billing_options
  add column ends_at timestamptz,
  add column auto_renew boolean not null default true,
  add column renewal_of_id uuid references customer_memberships(id) on delete set null,
  add column preferred_technician_id uuid references users(id) on delete set null,
  add column contract_signed_name text, add column contract_signed_at timestamptz,
  add column contract_signed_ip text,
  add column sold_by_id uuid references users(id) on delete set null,
  add column follow_up_status text not null default 'not_attempted',
  add column suspended_at timestamptz;

-- membership_visits exists (dueDate, periodKey, status, generatedServiceRequestId).
-- Extend into service events:
alter table membership_visits
  add column routine_id uuid references agreement_routines(id) on delete set null,
  add column event_status text not null default 'unscheduled'
    check (event_status in ('no_job','unscheduled','scheduled','completed','skipped','auto_failed','claimed','expired')),
  add column window_start date, add column window_end date;
-- period_key + routine_id is the idempotency key for materialisation. The
-- existing membership_visits_membership_period_unique (membership, period)
-- is DROPPED in the same migration (it forbids two routines per period);
-- legacy rows get routine_id backfilled to the plan's first routine so NULLs
-- never bypass the index; the generate-membership-visits cron is retired in
-- the same PR (one writer).
drop index if exists membership_visits_membership_period_unique;
create unique index membership_visits_idem
  on membership_visits (customer_membership_id, routine_id, period_key) nulls not distinct;

create table recurring_billing (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  customer_id uuid not null references customers(id) on delete cascade,
  customer_membership_id uuid references customer_memberships(id) on delete cascade,
  frequency text not null check (frequency in ('monthly','every_other_month','quarterly','biannual','annual')),
  amount_cents integer not null,
  occurrence_day smallint not null default 1,
  starts_on date not null,
  ends_on date,
  end_method text not null default 'never' check (end_method in ('never','date','count')),
  occurrences_total smallint,
  occurrences_done smallint not null default 0,
  auto_send boolean not null default true,
  default_invoice_status text not null default 'open',
  payment_method_id uuid references customer_payment_methods(id) on delete set null,
  next_at date not null,
  status text not null default 'active' check (status in ('active','paused','ended','failed')),
  retry_stage smallint not null default 0,  -- 0,3,7,14 days
  last_invoice_id uuid references invoices(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on recurring_billing (organization_id, status, next_at);
alter table invoices
  add column recurring_billing_id uuid references recurring_billing(id) on delete set null,
  add column billing_period_key text;
create unique index recurring_billing_period_idem
  on invoices (recurring_billing_id, billing_period_key) where recurring_billing_id is not null;
-- Charging is idempotent at Stripe with key rb:{recurring_billing_id}:{period_key}:{retry_stage};
-- every retry first re-reads the invoice and skips when state <> 'open' or
-- amount_paid_cents >= total_cents (a cheque on D2 stops the D3 card retry).

-- ---------------------------------------------------------------------------
-- M6  Follow-up hub, automations, inbox
-- ---------------------------------------------------------------------------

-- follow_ups exists (customer, assignedTo, reason, dueDate, status). Extend:
alter table follow_ups
  add column entity text check (entity in ('estimate','membership','lead','booking','invoice','customer')),
  add column entity_id uuid,
  add column outcome text check (outcome in ('not_attempted','unreachable','contacted','won','dismissed')),
  add column template_id uuid references communication_templates(id) on delete set null,
  add column notes text;
create index on follow_ups (organization_id, entity, entity_id);

create table automation_triggers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  name text not null,
  event text not null,                     -- job.status_changed | appointment.status_changed | estimate.sent | invoice.overdue | payment.recorded | time.before_start | ...
  condition jsonb not null default '{}',   -- {to_kind:'travel'} | {days:3} | {job_type_ids:[...]}
  action_mode text not null default 'auto' check (action_mode in ('auto','prompt','scheduled','scheduled_confirm')),
  channel text not null check (channel in ('sms','email','both')),
  template_id uuid not null references communication_templates(id) on delete restrict,
  offset_minutes integer not null default 0,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, name)
);
-- the 15 fixed trigger types become seeded rows; communication_jobs keeps
-- its trigger_type enum and gains:
alter table communication_jobs add column automation_trigger_id uuid references automation_triggers(id) on delete set null;

alter table customer_threads
  add column needs_follow_up boolean not null default false,
  add column linked_entity text, add column linked_entity_id uuid,
  add column ai_summary text,
  add column last_inbound_at timestamptz, add column last_outbound_at timestamptz;
alter table messages add column is_internal_note boolean not null default false;

-- ---------------------------------------------------------------------------
-- M7  Pricebook + inventory
-- ---------------------------------------------------------------------------

alter table pricebook_items
  add column add_on_price_cents integer,
  add column add_on_member_price_cents integer,
  -- hours already exists (integer); keep it
  add column markup_pct smallint,
  add column images jsonb not null default '[]',
  add column recommendations uuid[] not null default '{}',
  add column upgrades uuid[] not null default '{}',
  add column track_inventory boolean not null default false,
  add column reorder_point integer, add column reorder_qty integer;
alter table pricebook_categories
  add column display text not null default 'list' check (display in ('list','gbb')),
  add column image_url text,
  add column position smallint not null default 0;

create table suppliers (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  name text not null, email text, phone text, notes text,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (organization_id, name)
);
alter table purchase_orders add column supplier_id uuid references suppliers(id) on delete set null,
  add column delivery_method text check (delivery_method in ('delivery','pickup')),
  add column expected_at timestamptz,      -- received_at already exists
  add column linked_request_id uuid references service_requests(id) on delete set null,
  add column hub_id uuid;
alter table po_line_items add column qty_received integer not null default 0;

create table inventory_hubs (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  name text not null,
  kind text not null check (kind in ('warehouse','truck')),
  assigned_user_id uuid references users(id) on delete set null,
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  unique (organization_id, name)
);
alter table purchase_orders add constraint po_hub_fk foreign key (hub_id) references inventory_hubs(id) on delete set null;
-- inventory_items exists (item, qty on hand, reorder point, unit cost, location text).
-- Re-key per hub:
alter table inventory_items add column hub_id uuid references inventory_hubs(id) on delete cascade;
-- the existing inventory_items_org_item_unique (org, item) is replaced by a per-hub key:
drop index if exists inventory_items_org_item_unique;
create unique index inventory_items_hub_item on inventory_items (organization_id, hub_id, pricebook_item_id);

create table inventory_movements (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  pricebook_item_id uuid not null references pricebook_items(id) on delete restrict,
  from_hub_id uuid references inventory_hubs(id) on delete set null,
  to_hub_id uuid references inventory_hubs(id) on delete set null,
  qty integer not null,
  kind text not null check (kind in ('receive','transfer','adjust','deduct_job','count')),
  ref_entity text, ref_id uuid,            -- po | job | count
  memo text,
  created_by uuid references users(id) on delete set null,
  created_at timestamptz not null default now()
);
create index on inventory_movements (organization_id, pricebook_item_id, created_at);

-- ---------------------------------------------------------------------------
-- M8  Portals: booking services, portal settings
-- ---------------------------------------------------------------------------

create table booking_services (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  category text not null,
  name text not null,
  description text,
  job_type_id uuid references job_types(id) on delete set null,
  duration_minutes integer not null,
  buffer_before_minutes integer not null default 0,
  buffer_after_minutes integer not null default 0,
  lead_time_hours integer not null default 2,
  required_skills text[] not null default '{}',
  eligible_technician_ids uuid[] not null default '{}',
  windows text[] not null default '{morning,afternoon}',
  booking_mode text not null default 'request' check (booking_mode in ('request','auto_schedule')),
  price_display text not null default 'none' check (price_display in ('none','from','fixed')),
  price_cents integer,
  deposit_cents integer,
  active boolean not null default true,
  position smallint not null default 0,
  unique (organization_id, name)
);
-- portal visibility toggles live in organization_settings.portal_settings jsonb
alter table organization_settings add column portal_settings jsonb not null default '{}';
alter table organization_settings add column features jsonb not null default '{}';  -- plugin switchboard

-- ---------------------------------------------------------------------------
-- M9  Team, reporting, accounting
-- ---------------------------------------------------------------------------

-- users.role is plain text (no pg enum); the role union lives in
-- src/lib/auth/authz.ts. Add 'dispatcher' and 'office' there + a check:
alter table users add constraint users_role_check
  check (role in ('super_admin','admin','dispatcher','office','technician'));
alter table users add column permissions jsonb not null default '{}';   -- per-user overrides
alter table users add column skills text[] not null default '{}';
alter table users add column team text;

create table saved_views (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  user_id uuid references users(id) on delete cascade,   -- null = shared
  page text not null,                      -- requests | invoices | agreements | reports
  name text not null,
  query jsonb not null,
  position smallint not null default 0,
  created_at timestamptz not null default now(),
  unique (organization_id, user_id, page, name)
);
alter table organization_settings add column dashboard_layout jsonb not null default '[]';

create table quickbooks_connections (
  organization_id uuid primary key references organizations(id) on delete cascade,
  realm_id text not null,
  access_token_encrypted text not null,
  refresh_token_encrypted text not null,
  token_expires_at timestamptz not null,
  refresh_expires_at timestamptz not null,
  connected boolean not null default true,
  default_income_account_id text, default_tax_code_id text,
  last_sync_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table quickbooks_sync_map (
  organization_id uuid not null references organizations(id) on delete cascade,
  entity text not null,                    -- customer | item | invoice | payment
  local_id uuid not null,
  qbo_id text not null,
  qbo_sync_token text,
  synced_at timestamptz not null default now(),
  primary key (organization_id, entity, local_id)
);
