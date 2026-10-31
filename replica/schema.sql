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
-- M0  Foundation: tags, contacts, locations, job types, status kinds,
--     appointments + assignments, shifts
-- ---------------------------------------------------------------------------

create type tag_entity as enum ('customer','location','job','invoice','item','user');

create table tag_types (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  entity tag_entity not null,
  name text not null,
  color text not null default 'graphite',
  importance smallint not null default 0,
  visible_on_board boolean not null default false,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, entity, name)
);

-- one polymorphic link table; entity + entity_id are not FKs on purpose
create table entity_tags (
  organization_id uuid not null references organizations(id) on delete cascade,
  tag_type_id uuid not null references tag_types(id) on delete cascade,
  entity tag_entity not null,
  entity_id uuid not null,
  created_at timestamptz not null default now(),
  primary key (tag_type_id, entity, entity_id)
);
create index on entity_tags (organization_id, entity, entity_id);

create table customer_contacts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  customer_id uuid not null references customers(id) on delete cascade,
  location_id uuid references customer_locations(id) on delete set null,
  name_encrypted text not null,
  role text,                              -- "tenant", "property manager", ...
  phone_encrypted text, phone_hash text,  -- blind index like customers
  email_encrypted text, email_hash text,
  do_not_text boolean not null default false,
  job_reminders boolean not null default true,
  marketing boolean not null default false,
  invoice_notifications boolean not null default true,
  is_primary boolean not null default false,
  position smallint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on customer_contacts (organization_id, customer_id);
create index on customer_contacts (organization_id, phone_hash);

-- customer_locations exists (address, label, zone text, property type,
-- access notes, lat/lng). Extend:
alter table customer_locations
  add column is_primary boolean not null default false,
  add column tax_zone_id uuid references tax_zones(id) on delete set null,
  add column zone_id uuid references service_zones(id) on delete set null,
  add column preferred_technician_id uuid references users(id) on delete set null,
  add column merged_to_id uuid references customer_locations(id) on delete set null;
create unique index customer_locations_one_primary
  on customer_locations (customer_id) where is_primary;

alter table customers
  add column customer_status text not null default 'customer'
    check (customer_status in ('lead','opportunity','customer','lost','inactive')),
  add column parent_customer_id uuid references customers(id) on delete set null,
  add column merged_to_id uuid references customers(id) on delete set null,
  add column payment_term_days smallint,
  add column tax_exempt boolean not null default false;

create table service_zones (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  name text not null,
  color text,
  zip_codes text[] not null default '{}',
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (organization_id, name)
);
create table technician_zones (
  technician_id uuid not null references users(id) on delete cascade,
  zone_id uuid not null references service_zones(id) on delete cascade,
  is_main boolean not null default false,
  primary key (technician_id, zone_id)
);

-- job types become rows; the job_type enum stays as the "kind" the AI and
-- the FP status map read. Every org gets seeded rows, one per enum value.
create table job_types (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  name text not null,
  kind job_type not null,                 -- existing enum = canonical kind
  default_duration_minutes integer not null default 90,
  default_priority urgency not null default 'medium',
  required_skills text[] not null default '{}',
  workflow_id uuid,                       -- fk added after status_workflows
  required_form_ids uuid[] not null default '{}',
  active boolean not null default true,
  position smallint not null default 0,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, name)
);
alter table service_requests
  add column job_type_id uuid references job_types(id) on delete set null,
  add column project_id uuid,
  add column recall_for_id uuid references service_requests(id) on delete set null,
  add column warranty_of_id uuid references service_requests(id) on delete set null,
  add column cancel_reason text,
  add column cancel_memo text,
  add column sold_by_id uuid references users(id) on delete set null,
  add column created_from_estimate_id uuid references estimates(id) on delete set null,
  add column template_id uuid,
  add column recurring_series_id uuid,
  add column no_charge boolean not null default false,
  add column archived_at timestamptz,
  add column booking_source text
    check (booking_source in ('chat','voice','sms','widget','portal','booking_page','admin','tech','fieldpulse','housecall','agreement'));

-- Status workflows: display statuses an org defines, each mapped to a
-- canonical kind. service_requests.status (the enum) stays the source of
-- truth that the AI intake, triggers, KPIs and the FP status map read; the
-- workflow adds a display status id on top. Two new canonical values are
-- added to the enum for the tech loop: en_route, arrived.
alter type service_request_status add value if not exists 'en_route' after 'scheduled';
alter type service_request_status add value if not exists 'arrived' after 'en_route';

create type status_kind as enum
  ('new','scheduled','travel','arrived','in_progress','pause','hold','complete','cancel');

create table status_workflows (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  entity text not null check (entity in ('job','estimate','invoice','agreement')),
  name text not null,
  is_default boolean not null default false,
  active boolean not null default true,
  created_at timestamptz not null default now(),
  unique (organization_id, entity, name)
);
create table workflow_statuses (
  id uuid primary key default gen_random_uuid(),
  workflow_id uuid not null references status_workflows(id) on delete cascade,
  name text not null,
  kind status_kind not null,              -- what the enum readers see
  color text not null,
  position smallint not null,
  is_default boolean not null default false,
  instructions text,                      -- guided flow (ClearPath) text
  action_buttons jsonb not null default '[]',   -- [{action,label}] max 10
  required_form_ids uuid[] not null default '{}',
  unique (workflow_id, name)
);
alter table job_types
  add constraint job_types_workflow_fk foreign key (workflow_id)
  references status_workflows(id) on delete set null;
alter table service_requests
  add column workflow_status_id uuid references workflow_statuses(id) on delete set null;

-- Appointments: a job can have N visits. Backfill one appointment per
-- existing request from scheduledDate + arrivalWindowStart/End + assignedTo.
-- The request keeps its denormalised first-appointment columns so the
-- FieldPulse/HCP one-job-one-id sync, the calendar and the KPIs keep reading
-- what they read today. appointment_number 1 == the request's own columns.
create type appointment_status as enum
  ('scheduled','confirmed','en_route','arrived','working','paused','hold','done','cancelled','unused');

create table appointments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  service_request_id uuid not null references service_requests(id) on delete cascade,
  appointment_number smallint not null default 1,
  starts_at timestamptz,
  ends_at timestamptz,
  arrival_window_start timestamptz,
  arrival_window_end timestamptz,
  status appointment_status not null default 'scheduled',
  is_confirmed boolean not null default false,
  special_instructions text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (service_request_id, appointment_number),
  constraint appt_window check (arrival_window_end is null or arrival_window_end > arrival_window_start)
);
create index on appointments (organization_id, starts_at);
create index on appointments (organization_id, status);

create table appointment_assignments (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  appointment_id uuid not null references appointments(id) on delete cascade,
  technician_id uuid not null references users(id) on delete cascade,
  is_lead boolean not null default true,
  status appointment_status not null default 'scheduled',  -- per-tech done
  assigned_by uuid references users(id) on delete set null,
  assigned_at timestamptz not null default now(),
  dispatched_at timestamptz, arrived_at timestamptz, done_at timestamptz,
  unique (appointment_id, technician_id)
);
create index on appointment_assignments (organization_id, technician_id, assigned_at);
-- Reassign guard is enforced in the data layer: refuse when the assignment
-- status is in ('en_route','arrived','working','done').

-- Shifts and non-job events: technician_availability (weekly) stays as the
-- baseline; shifts override per date.
create type shift_kind as enum ('normal','on_call','time_off','non_job');
create table technician_shifts (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  technician_id uuid not null references users(id) on delete cascade,
  kind shift_kind not null,
  title text,
  starts_at timestamptz not null,
  ends_at timestamptz not null,
  removes_capacity boolean not null default true,
  show_on_board boolean not null default true,
  repeat_rule text,                        -- RRULE or null
  created_at timestamptz not null default now(),
  constraint shift_order check (ends_at > starts_at)
);
create index on technician_shifts (organization_id, technician_id, starts_at);

create table capacity_adjustments (
  organization_id uuid not null references organizations(id) on delete cascade,
  day date not null,
  "window" text not null,                  -- morning|afternoon|evening|custom id
  delta_minutes integer not null default 0,
  threshold_pct smallint not null default 100,
  primary key (organization_id, day, "window")
);

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
  summary text,
  call_reason text,
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
-- M3  Tech close-out loop: forms, general timesheets, field equipment
-- ---------------------------------------------------------------------------

create table forms (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  name text not null,
  description text,
  pages jsonb not null default '[]',       -- [{title, fields:[{id,type,label,required,internal,pull_from}]}]
  required_for_job_type_ids uuid[] not null default '{}',
  active boolean not null default true,
  version integer not null default 1,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (organization_id, name)
);
create table form_submissions (
  id uuid primary key default gen_random_uuid(),
  organization_id uuid not null references organizations(id) on delete cascade,
  form_id uuid not null references forms(id) on delete restrict,
  form_version integer not null,
  service_request_id uuid not null references service_requests(id) on delete cascade,
  appointment_id uuid references appointments(id) on delete set null,
  submitted_by uuid references users(id) on delete set null,
  values jsonb not null default '{}',
  status text not null default 'draft' check (status in ('draft','submitted')),
  submitted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index on form_submissions (organization_id, service_request_id);

-- technician_time_entries exists per job. Add general time + status stamps.
alter table technician_time_entries
  add column kind text not null default 'job' check (kind in ('job','general')),
  add column appointment_id uuid references appointments(id) on delete set null,
  add column clock_in_method text check (clock_in_method in ('auto','manual')),
  add column clock_in_lat double precision, add column clock_in_lng double precision,
  add column is_backdated boolean not null default false,
  add column timesheet_code text;

-- offline: a client-side queue, no server table. Every tech POST carries an
-- idempotency key; the server stores it:
create table idempotency_keys (
  organization_id uuid not null,
  key text not null,
  route text not null,
  response_status smallint not null,
  response_body jsonb,
  created_at timestamptz not null default now(),
  primary key (organization_id, key)
);

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

alter table invoices
  add column service_request_id uuid references service_requests(id) on delete set null,
  add column location_id uuid references customer_locations(id) on delete set null,
  add column due_date date,
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
-- draft invoice auto-created at booking: invoices.status='draft',
-- service_request_id set, zero lines. One draft per request:
create unique index invoices_one_per_request
  on invoices (service_request_id) where service_request_id is not null and status <> 'void';

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
-- period_key + routine_id is the idempotency key for materialisation:
create unique index membership_visits_idem
  on membership_visits (customer_membership_id, routine_id, period_key);

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
create unique index recurring_billing_period_idem
  on invoices (recurring_billing_id, billing_period_key) where recurring_billing_id is not null;
alter table invoices
  add column recurring_billing_id uuid references recurring_billing(id) on delete set null,
  add column billing_period_key text;

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
  add column hours numeric(6,2),
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
  add column expected_at timestamptz, add column received_at timestamptz,
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
create unique index inventory_items_hub_item on inventory_items (hub_id, pricebook_item_id);

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

alter type user_role add value if not exists 'dispatcher';
alter type user_role add value if not exists 'office';
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
