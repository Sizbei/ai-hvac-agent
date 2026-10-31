# Architecture: ai-hvac-agent (a rebuild of FieldPulse's and ServiceTitan's core loops)

Reads `recon.md` and `features.csv`. The clone is not a new app. It is ten
milestones of additions to an app that already runs intake, dispatch,
estimates, invoices, memberships, a tech app and a FieldPulse mirror. The
parity score after the vertical slice is 40.4 (39 of 111 must-haves). This
plan orders the 72 missing must-haves into loops, each shippable on its
own. Revised 2026-11-01 after a four-lens adversarial review (see
`replica/review-log.md`).

## Stack

No change. Every layer is already chosen, deployed and documented in
`AGENTS.md`; the clone needs the originals' features, not their stack.

| layer | choice | why |
| --- | --- | --- |
| web | Next.js 16 App Router + TypeScript, Tailwind, the `src/components/admin/ui/` primitives | shipped; the 2026-08 design system is the token source |
| database | Neon Postgres via neon-http + Drizzle | shipped; `db.batch()` only, no transactions |
| auth | JWT cookie sessions, Google OIDC, roles super_admin > admin > technician | shipped; M9 adds dispatcher/office roles + per-user permission overrides |
| payments | Stripe (Payment Links, PaymentIntents, Terminal later) behind the existing `src/lib/payments/provider.ts` seam | the seam is mock today; Stripe is the only new vendor in the plan |
| email / SMS | Resend + Twilio adapters | shipped |
| jobs | Vercel daily crons + GitHub Actions for sub-daily | shipped; agreements and billing add two more cron routes |
| files | R2 via `/api/upload` | shipped |
| hosting | Vercel (`vercel deploy --prod --yes`, migrations run in the build) | shipped |
| accounting | QuickBooks Online REST (OAuth 2) behind `accounting-provider.ts` | M9; CSV/IIF export stays |

## Schema

Tables: 22 new, 15 extended, 1 enum extended (see `schema.sql`; M0 is 6
new tables, 2 extended, 1 enum). Access rule: data-layer checks. Every
query filters by the session `organizationId`; `withTenant` is the WHERE
helper for Drizzle reads (`src/lib/db/tenant.ts`), raw SQL repeats the
filter by hand, and **every id that arrives in a request body (customer,
location, technician, job type, tag, template, appointment) is re-read
under the session org before it is written**, as the shipped slice does
for customerId and technicianId. Nothing moves to row-level security.

Three modelling decisions carry the whole plan:

1. **Job stays `service_requests`. Appointments are a child table, and the
   request owns appointment #1.** `scheduledDate`, `arrivalWindowStart/End`,
   `assignedTo` and `status` stay the source of truth for the first visit;
   a Postgres trigger (precedent `drizzle/0044_last_admin_guard.sql`)
   mirrors them into `appointments` #1 and its lead assignment on every
   insert/update. That is what keeps the 25 request-update sites, the
   FieldPulse/HCP sync, the AI booking path, the calendar and the KPIs
   working without being touched. Visits #2+ are written only by the data
   layer and never touch the request columns. Backfill is one idempotent
   INSERT … SELECT after the trigger exists.
2. **One status vocabulary.** `request_status` gains `en_route` and
   `arrived`; per-technician progress on `appointment_assignments.status`
   uses the same enum. No display-status layer: `status_workflows` and
   guided flows are `should` rows (features.csv 57, 128) and move to M6+.
   Roll-up rule for multi-tech visits (M3): the request becomes
   `completed` only when every assignment is `completed` or `cancelled`;
   the lead's status mirrors the request until M3 writes per-tech rows.
   Job types become rows with a `kind` = the existing `job_type` enum; the
   enum's ~25 readers do not change, and the create path writes both.
3. **Money stays snapshot-based and source-guarded.** Line items snapshot
   the pricebook at write time (already true). Synced FieldPulse/HCP records
   stay read-only in every new money flow: the `fieldpulse_invoice_id IS NOT
   NULL` / `hcp_invoice_id IS NOT NULL` guards extend to the invoice builder,
   recurring billing and batches.

Hard constraints that live in the database, not the UI:

- one primary location per customer (partial unique index, backfilled to
  the oldest location)
- one lead technician per appointment (partial unique index)
- one native draft invoice per job (partial unique index that excludes
  synced and finalised invoices; estimate-to-invoice adopts the draft)
- one service event per membership × routine × period (unique index,
  `NULLS NOT DISTINCT`, replacing the (membership, period) index; this is
  what stops a re-run cron from flooding dispatch)
- one recurring-billing invoice per billing period (unique index) plus a
  Stripe idempotency key per retry stage
- idempotency keys for every tech-app write, keyed (org, user, route,
  key) with a request hash, claimed before the write
- tags can never cross orgs or entity kinds (composite FK into tag_types)
- reassign guard: a move of an assignment whose status is `en_route`,
  `arrived` or `in_progress` needs an explicit override (data layer, 409,
  test); `REASSIGNABLE_STATUSES` in `queries.ts` changes in the same PR

Migration conventions (verified against the neon-http migrator): every
statement idempotent, every index and constraint named and mirrored in
`schema.ts`, enum values added in their own file, backfills in a later
file. Details at the top of `schema.sql`.

## API

Routes are grouped by flow. `admin` = `getAdminSession()`; `tech` = the
technician JWT; `token` = a hashed single-purpose token; `cron` = bearer
`CRON_SECRET`. Inputs are zod-validated at the boundary, as today.

### M0 Foundation

| method path | does | who | input | output |
| --- | --- | --- | --- | --- |
| GET/POST /api/admin/settings/job-types, PATCH …/[id] | configurable job types (name, kind, default duration, priority, active, order) | admin | row | row |
| GET/POST /api/admin/settings/tags, PATCH …/[id] | tag types per entity | admin | row | row |
| PUT /api/admin/tags/[entity]/[id] | replace the tag set on a customer / location / job (ids re-read under the org) | admin | tagTypeIds[] | tags |
| GET/POST /api/admin/customers/[id]/contacts, PATCH/DELETE …/contacts/[cid] | contacts | admin | name, role, phone, email, prefs | contact |
| PATCH /api/admin/customers/[id]/locations/[lid] | set primary | admin | isPrimary | location |
| GET/POST /api/admin/technicians/[id]/shifts, DELETE …/shifts/[sid] | on-call / time off / non-job events | admin | kind, title, start, end, removesCapacity | shift |
| POST /api/admin/requests/[id]/appointments, PATCH/DELETE …/appointments/[aid] | visits #2+ (CAS on version) | admin | start, end, window, technicianIds | appointment |
| POST /api/tech/jobs/[id]/status | extended with en_route, arrived (writes request status + the caller's assignment row) | tech | status | job |

### F01 Office books a job (M1)

| method path | does | who | input | output |
| --- | --- | --- | --- | --- |
| POST /api/admin/requests | create a job (+ appointment #1, + draft invoice) | admin | customerId or inline customer, locationId, jobTypeId, priority, summary, tags, window, assignees, equipmentIds, templateId | request + appointment |
| GET /api/admin/requests/availability | find availability | admin | from, to, durationMinutes, skills[], technicianIds[], count | slots grouped by day with capacity + conflicts |
| POST /api/admin/customers/[id]/contacts, PATCH/DELETE …/contacts/[cid] | contacts | admin | name, role, phone, email, prefs | contact |
| POST /api/admin/customers/[id]/locations, PATCH …/locations/[lid] | locations | admin | address, label, zone, access notes, primary | location |
| POST /api/admin/customers/merge | merge two customers or locations | super_admin | sourceId, targetId | re-pointed counts |
| GET/POST /api/admin/leads, PATCH /api/admin/leads/[id] | leads + call reasons | admin | source, summary, reason, follow_up_at, dismiss | lead |
| POST /api/admin/leads/[id]/book | convert a lead | admin | job fields | request |
| POST /api/admin/requests/[id]/dismiss | bookings review: dismiss with reason | admin | reason | request |

### F03 Dispatch (M2, as deltas to the existing calendar)

| method path | does | who | input | output |
| --- | --- | --- | --- | --- |
| GET /api/admin/scheduling/calendar (exists) | extended: appointments with assignments, shifts and non-job blocks per lane | admin | date | lanes |
| POST /api/admin/appointments/[id]/move | drag: time and/or tech | admin | startsAt, technicianIds, windowRule (keep/match/pick), windowId | appointment; 409 when guarded |
| POST /api/admin/appointments/[id]/confirm, /dispatch, /unassign | status actions | admin | — | appointment |
| POST /api/admin/requests/[id]/appointments | add a visit | admin | start, window | appointment |
| GET/PUT /api/admin/settings/zones | service zones (should) | admin | rows | rows |
| GET/PUT /api/admin/settings/capacity | per-day window adjustments | admin | day, window, delta, threshold | rows |
| POST /api/admin/dispatch/mass-reschedule | move a tech's day | admin | technicianId, date, deltaMinutes | count |

### F04 Tech loop (M3)

| method path | does | who | input | output |
| --- | --- | --- | --- | --- |
| POST /api/tech/jobs/[id]/status | extended: working, paused, hold(reason), done (per tech; the request completes only when every assignment is done or cancelled), close_out | tech | status, reason, idempotencyKey | job + fired triggers |
| GET /api/tech/forms, GET/PUT /api/tech/jobs/[id]/forms/[formId] | fill a form | tech | values | submission |
| POST /api/tech/jobs/[id]/equipment | add/replace equipment at the location | tech | fields, replacesId | equipment |
| GET/POST /api/tech/jobs/[id]/estimates, POST …/estimates/[eid]/present, /sign | build + present + accept | tech | template, options, signature | estimate |
| GET/POST /api/tech/jobs/[id]/invoice, POST …/invoice/lines, /finalize, /sign, /payments | invoice + collect | tech | lines, signature, payment (card via Stripe PaymentIntent, manual) | invoice |
| POST /api/tech/time | general clock in/out | tech | kind, at, lat/lng | entry |
| POST /api/tech/book | tech-generated job or lead | tech | customer, summary, leaveUnassigned | request or lead |
| GET /api/tech/sync | offline bundle: today's jobs, pricebook top-N, forms | tech | since | bundle (ETag) |

### F05 Estimates, F07 Invoices and payments (M4)

| method path | does | who | input | output |
| --- | --- | --- | --- | --- |
| PATCH /api/admin/estimates/[id] | edit lines/options/groupings/add-ons/deposit until locked | admin | body | estimate; 409 when locked |
| POST /api/admin/estimates/[id]/lock, /duplicate, /dismiss | milestones | admin | reason | estimate |
| GET/POST/PATCH /api/admin/estimate-templates | templates | admin | body | template |
| GET /api/admin/estimates/sold-unbooked, POST /api/admin/estimates/[id]/book | sold-not-booked queue | admin | lineItemIds, job fields | request |
| POST /api/admin/invoices | from scratch, from job, or from estimate (existing) | admin | serviceRequestId or estimateId or customerId + lines | invoice |
| PATCH /api/admin/invoices/[id], POST …/lines, …/finalize | line editor + lock | admin | lines, display settings, due date | invoice |
| POST /api/admin/invoices/[id]/payments | extended: method, check number, deposit, group | admin | body | payment |
| POST /api/admin/invoices/[id]/pay-request | email/SMS a Stripe pay link | admin | channels | sent |
| GET/POST/PATCH /api/admin/settings/discounts-fees, tax-zones | config | admin | rows | rows |
| POST /api/admin/customers/[id]/payment-methods | save a card/ACH via Stripe SetupIntent | admin | setupIntent | method |
| POST /api/webhooks/stripe | payment_intent.succeeded/failed, charge.refunded, invoice.* | Stripe | signed event | 200 (idempotent) |

### F06 Agreements (M5)

| method path | does | who | input | output |
| --- | --- | --- | --- | --- |
| POST/PATCH /api/admin/membership-plans/[id]/routines | routines | admin | rrule, offset, job type, generation rule | routine |
| POST /api/admin/customers/[id]/membership | extended: location, billing option, preferred tech, contract | admin | body | membership |
| GET /api/admin/agreements/events, POST /api/admin/agreements/events/book | the recurring-events tab + bulk book | admin | filters; eventIds, window | requests created |
| POST /api/admin/agreements/[id]/renew, /suspend, /resume, /cancel | lifecycle | admin | adjustedStart | membership |
| POST /api/admin/recurring-billing, PATCH …/[id] | set up or pause billing | admin | body | row |
| GET/POST /api/cron/materialize-service-events | 12-month horizon, idempotent | cron | — | counts |
| GET/POST /api/cron/recurring-billing | invoice + charge saved method, retry D0/3/7/14 | cron | — | counts |

### F08 Comms, F09 Follow-up (M6)

| method path | does | who | input | output |
| --- | --- | --- | --- | --- |
| GET /api/admin/follow-up | tabs: unsold, sold-unbooked, service events, expiring, leads, unreached bookings | admin | tab, filters | rows |
| POST /api/admin/follow-ups | log with template, next date, outcome; link to entity | admin | body | follow-up |
| GET/POST/PATCH/DELETE /api/admin/automations | user-defined triggers | admin | event, condition, action mode, template | row |
| POST /api/admin/conversations/[id]/message | extended: channel email, internal note, follow-up flag, link | admin | body | message |
| GET /api/admin/conversations?since= | polling delta | admin | since | threads |

### M7–M9 (pricebook, inventory, portals, team, reporting, accounting)

| method path | does | who |
| --- | --- | --- |
| POST /api/admin/pricebook/import (CSV, dry-run + commit), GET/POST/PATCH /api/admin/pricebook/categories, POST …/bundles | catalog | admin |
| GET/POST /api/admin/inventory/hubs, POST /api/admin/inventory/movements, POST /api/admin/inventory/purchase-orders/[id]/receive, GET/POST /api/admin/suppliers | stock | admin |
| GET /api/book/[orgSlug]/services, GET …/availability, POST …/book | booking page | public (rate-limited) |
| POST /api/portal/[token]/request, GET …/equipment, GET …/memberships, POST …/pay (Stripe) | portal | token |
| GET/PUT /api/admin/settings/portal, /features, /dashboard | toggles, plugin switchboard, widget layout | admin |
| GET/POST/PATCH /api/admin/staff/[id]/permissions, /api/admin/saved-views | roles, views | admin |
| GET /api/admin/reports/export?report=&from=&to= | raw-data CSV with relative dates | admin |
| POST /api/admin/accounting/batches, POST …/[id]/post, /export | batch → post → export (CSV or QBO) | super_admin |
| GET /api/admin/integrations/quickbooks/connect, /callback, POST /sync | QBO OAuth + push customers/items/invoices/payments | super_admin |

Webhooks in: Stripe (new), Twilio (exists), Resend (exists), FieldPulse +
HCP (exist), QuickBooks (optional, M9). Webhooks out: none in this plan
(the prior plan deferred a public API; still deferred).

Jobs (crons): `materialize-service-events` daily, `recurring-billing` daily,
`booking-recovery` (exists), `dunning` (exists), `delay-sweep` (exists),
`process-communications` (exists, now also drains automation rows),
`fp-nightly-sync` (exists; learns the appointment table in M0).

## The parts that bite

- **Time zones.** One business timezone today (`BUSINESS_BASE_LOCATION`).
  Appointments and shifts store timestamptz; the board renders in the org
  timezone. No RRULE engine in the plan: weekly hours stay in
  `technician_availability`, shifts are date-bound rows, service events
  are materialised by the cron in the org timezone. Capacity keys reuse the
  existing `capacity_reservations` shape (`day` text `YYYY-MM-DD` in the
  business timezone + band name).
- **Idempotency.** Stripe and Twilio deliver twice: `stripe_events` is a
  ledger like the existing `*_webhook_events` tables, refunds dedupe on the
  provider refund id. Every tech POST claims its idempotency key before the
  write (see `schema.sql` M3). Materialisation and billing crons are keyed
  by period (unique indexes) and every billing retry re-reads the invoice.
- **Races.** Two dispatchers moving one appointment: CAS on
  `appointments.version` (409 + refetch), never on `updated_at` (the app
  sets it by hand at ~110 sites and SQL `now()` carries microseconds).
  Booking the last slot: `reserveCapacitySlot` is a compare-and-swap loop
  that needs each insert's result, so it runs as its own step BEFORE the
  placement batch, as the intake path does today; the known gap that
  "placed + reserved can briefly exceed capacity" (`capacity-hold.ts`) is
  not closed by this plan and is listed in M2. Reassign of a working job:
  guarded in the data layer with a test, not only hidden in the UI.
- **Rate limits.** Stripe and QBO (QBO throttles; batches of 3–4 invoices,
  as ServiceTitan's help warns). The existing sliding-window limiter is
  per-instance memory (`src/lib/rate-limit.ts`), so public booking writes
  (M8) need a DB-backed limiter and holds that expire unless confirmed.
- **Offline.** No service worker in the first pass: form state autosaves to
  IndexedDB per job, writes queue with idempotency keys and replay on
  reconnect, and the job bundle is cached with an ETag. Payments and new
  records stay online-only (FieldPulse's rule). Tech line items are SKU +
  quantity; prices come from the server snapshot and cost fields never
  enter the tech bundle.
- **Search.** The customer scan cap in global search (`SCAN_LIMIT_CUSTOMERS`)
  is a known gap. Name/phone/address are ciphertext, so trigram indexes do
  not apply; M0b adds contacts to the blind-index lookup (phone/email
  hash) and leaves fuzzy search open.
- **Multi-tenancy.** Every new table carries `organization_id`; every
  body id is re-read under the org before a write; public endpoints
  resolve the org from the slug or token, never from the body.
- **GDPR deletion.** The erase batch updates the customer row rather than
  deleting it, so cascades never fire: contacts join the erase batch in
  M0b, `appointments.special_instructions` in M0a, leads in M1, form
  submissions, signatures and saved payment methods (detach at Stripe) in
  M3/M4, each in the PR that adds the table.
- **Merge (M1).** Merging A into B moves A's blind-index hashes to B where
  B has none, nulls them on A, archives A, and match resolution follows
  `merged_to_id`; erase runs over the chain.
- **PII and audit.** New tables that hold names, phones, emails, addresses
  or free text about a person (contacts, leads) encrypt with the existing
  AES-GCM helpers and blind-index the lookups. Audit details stay ids/enums
  only.
- **Money.** Cents everywhere. Snapshot at write time. Synced records
  read-only. No blended totals of native and synced money (already a rule).
- **Stand-in sessions.** `service_requests.session_id` is NOT NULL, so
  every non-chat creation path (office, tech book, lead convert, agreement
  bulk book) inserts a stand-in `customer_sessions` row with a prefixed
  token (`admin-`, `mvisit-`, `fp-import-`, and new `tech-`, `lead-`,
  `agreement-`) and the shared predicate keeps them out of conversations
  and analytics.
- **Status enum readers.** Adding `en_route`/`arrived` touches 22
  hard-coded status lists, not one. M0a replaces them with shared
  constants exported from `src/lib/admin/request-status.ts`
  (`ACTIVE_STATUSES`, `UNSCHEDULED_STATUSES`, `ON_SITE_STATUSES`) and adds
  a test that fails when an enum value appears in no list. The readers:
  `queries.ts` (OPEN/ASSIGNABLE/UNASSIGNED_OPEN/REASSIGNABLE + raw SQL at
  the in-progress KPI), `scheduling-queries.ts` (ACTIVE_BOOKING,
  UNSCHEDULED, the raw-SQL double-book guard), `api/tech/jobs/route.ts`
  ACTIVE_STATUSES, `api/admin/dispatch/map/route.ts`, `portal-queries.ts`,
  `ai/account-tools.ts`, `ai/account-reply.ts` (switch default),
  `ai/dispatch/signals.ts`, `dispatch/delay-detection.ts`
  (NOT_STARTED_STATUSES must include en_route), `ops-insights-queries.ts`,
  `operations-metrics-queries.ts`, `status-colors.ts`, the requests page
  whitelist + `request-filters.tsx`, `request-status.ts` TRANSITIONS +
  MANUAL_TARGET_STATUSES (feeds the tech status zod enum), the FP import
  `FP_JOB_STATUS_MAP` (FP "on the way" → `en_route`; the sync preserves
  native `en_route`/`arrived` like it preserves `on_hold`), the FP webhook
  mapper and the HCP webhook mapper (`job.on_my_way` → `en_route`).

## Build order

Each milestone lists its screens (S-IDs from `recon.md`), tables and
routes, has a one-line "done when", and is shippable on its own. The order
puts the loop the technicians use every hour (status → close-out →
collect) before office tooling, because the team cannot leave FieldPulse
until a tech can finish and collect on a job here.

1. **Vertical slice: office books a job.** SHIPPED 2026-10-31. S07 job
   form, `POST /api/admin/requests`, `GET /api/admin/requests/availability`.
   Done when: a dispatcher creates and schedules a job in under 10 clicks
   and it appears on the calendar, the dispatch board and the tech app.
2. **M0b Config foundation.** Tags (customer, location, job), contacts
   (S04 customer page), primary location, configurable job types with
   default duration (settings page), `job_type_id` on requests, contacts in
   the erase batch, S07 uses all three. Tables: 4 new, 2 extended. No dual
   writes. Must-haves closed: 22, 23, 27, 55, 56, 83.
   Done when: an admin creates a job type with a default duration, tags a
   customer and a job, adds a second contact, and the New request dialog
   offers all three; erase anonymises contacts.
3. **M0a Schedule foundation.** `en_route`/`arrived` with the 22 readers
   on shared constants, appointments + assignments backfilled and kept in
   step by the trigger, tech ownership = `assigned_to` OR an assignment
   row, shifts (on-call / time off / non-job) removing capacity, tech taps
   en route / arrived. Tables: 2 new (+ shifts = 3), 1 enum. Gets its own
   adversarial review before merge. Must-haves closed: 64, 85, 86, 98
   (data), 117.
   Done when: every request with a date or assignee has appointment #1 and
   a lead assignment matching its columns; the calendar, dispatch, tech
   app and FieldPulse nightly sync produce identical output before and
   after; a second visit on a job shows on the calendar; a tech taps en
   route then arrived and the customer-facing status reads the same.
4. **M3 Tech close-out loop.** S38 en route → arrived → working → paused /
   hold → done per tech (roll-up rule) → close-out sheet; forms (S29
   config + fill); equipment from the field; S39 present estimate; S40
   invoice + payment on the existing payment seam (mock until M4's Stripe
   adapter); general timeclock (S25); offline autosave + replay with
   idempotency keys; tech book-a-job (S41). Must-haves closed: 14.
   Done when: a tech goes en route → arrived → working → done, gets a
   signature, records a payment and closes out from the phone with no
   office action, and a replayed request creates nothing twice.
5. **M2 Dispatch, as deltas to `/admin/calendar`.** The dnd-kit day view
   (`interactive-scheduling-calendar.tsx` DayLane) already covers the
   timeline, status colours, tray and drag. Add: arrival-window prompt in
   the drop handler, reassign guard (409 + override), multi-assignee chips
   on the job card, shift and non-job blocks in the lane, zones (rows 100)
   and capacity adjustments (82) as `should` extras, mass reschedule, the
   placed + reserved capacity gap. No second board. Must-haves closed: 96,
   97, 98 (UI).
   Done when: dragging across a window boundary prompts for the window, a
   working job refuses reassignment with a 409 unless overridden, and a
   two-tech job shows on both lanes.
6. **M4 Money builder.** S16 estimate editor (edit after send, lock at
   milestone, templates, groupings, add-ons, deposit), sold-not-booked
   queue, S19 invoice builder from scratch / from job, line editor,
   discounts and fees, tax zones, payment methods, real Stripe adapter +
   `stripe_events`, pay requests. Must-haves closed: 9.
   Done when: the office builds an invoice from scratch with a discount and
   a tax zone, a customer pays it through a live Stripe link, and a
   duplicate webhook changes nothing.
7. **M1 Office booking loop, rest.** Leads + call reasons, bookings review
   with dismiss reason (S34), job templates, draft invoice at booking,
   sold-by, cancel reasons, merge customers (hash rules above). Must-haves
   closed: 9.
   Done when: a lead logged from a call is booked into a job with sold-by
   set, a cancelled job shows its reason, and a merged customer's next call
   resolves to the survivor.
8. **M5 Agreements.** Billing table on plans, routines, service events
   materialised 12 months out (replacing `generate-membership-visits`),
   recurring-events tab + bulk book (S14, S33 tab), renewal / suspend /
   cancel, recurring billing with retry schedule (S21). Must-haves closed: 6.
   Done when: a plan with two routines materialises 12 months of events
   exactly once across two cron runs and bills monthly with retries that
   never double-charge.
9. **M6 Follow-up hub + automations + inbox.** S33 tabs, follow-up drawer
   with outcome enum, S30 trigger builder (seeded from the 16 fixed types),
   S32 email threads, follow-up flag, polling, on-the-way text with tracking
   link; status workflows + guided flows (rows 57, 128) land here if still
   wanted. Must-haves closed: 6.
   Done when: the unsold-estimate tab lists every open estimate and a
   logged follow-up schedules the next date.
10. **M7 Pricebook + inventory.** Category UI, CSV import with dry run,
    add-on prices, bundles, hubs/trucks, movements, auto-deduct on invoice,
    suppliers, receive flow. Must-haves closed: 3 (plus 12 shoulds).
    Done when: a CSV import dry run reports the diff and an invoice deducts
    truck stock.
11. **M8 Portals.** S36 booking page on booking services + real capacity +
    deposit + DB-backed limiter + expiring holds; S35 portal: submit
    request, equipment, memberships, pay (Stripe), visibility toggles.
    Must-haves closed: 4.
    Done when: a customer books from the public page against real capacity
    and pays in the portal.
12. **M9 Team, reporting, accounting.** Dispatcher/office roles + per-user
    overrides, business units (single default row), dashboard widgets +
    saved views, raw-data export, accounting batches, QBO OAuth push
    (reconcile with `feat/quickbooks-cleanup` first). Must-haves closed: 5.
    Done when: a dispatcher role cannot open reports and a batch posts to
    QuickBooks Online without duplicates.
13. **Fixes from `replica-entrepreneur`** (not run yet). The recon reports'
    review sections already list the targets: no contract lock-in, day-one
    pricebook from the FieldPulse mirror, onboarding in hours by import,
    light mobile web with autosave, one-screen booking, readable default
    reports, editable field notes, route sequencing that is an actual
    solver, webhooks for customers and payments, series edits that do not
    overwrite occurrence edits.

Design: `replica-design` is satisfied by the shipped 2026-08 design system
(`src/components/admin/ui/`, `status-colors.ts`); M0 needs only the
assignment-status badge map plus four small specs (tag chip picker,
contacts editor, job-type row editor, time-off editor) in
`replica/design/components.md`; the board, option presenter and add-item
panel specs there apply from M2/M3 on.

Three riskiest parts: (1) the appointment trigger and backfill under the
live FieldPulse sync; (2) the 22 status-list readers when `en_route` and
`arrived` land; (3) real money (Stripe cards, recurring billing with
retries, batches) replacing the mock seam. Each gets its own adversarial
review before merge.

Next step: implementation plan for M0b + M0a (`replica/plan-m0.md`), then
`/replica-build`.
