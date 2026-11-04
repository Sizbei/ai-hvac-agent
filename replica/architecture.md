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
   working without being touched. Appointment #1 has `starts_at` only
   when the request has an arrival window; a date-only booking stays
   "unscheduled" exactly as today. Visits #2+ are written only by the data
   layer, never touch the request columns, and are cancelled with the
   request. Backfill is one idempotent INSERT … SELECT after the trigger
   exists. The calendar keeps rendering requests until M2 unions visits.
2. **One status vocabulary.** `request_status` gains `en_route` and
   `arrived`; per-technician progress on `appointment_assignments.status`
   uses the same enum. No display-status layer: `status_workflows` and
   guided flows are `should` rows (features.csv 57, 128) and move to M6+.
   Roll-up rule for multi-tech visits (M3a): close-out is one guarded
   UPDATE that completes the request only when no assignment on a
   non-cancelled visit is still open; the trigger mirrors request status
   onto the lead row only until that row has a progress timestamp, then
   the tech app owns it (full rules in F04).
   New edges in `TRANSITIONS`: scheduled/assigned/on_hold → en_route;
   en_route → arrived, in_progress, scheduled, on_hold, cancelled;
   arrived → in_progress, on_hold, cancelled (no arrived → completed, so
   the response-time KPI stays anchored on being on site). Tech-app
   ownership stays `assigned_to = me` until M3; a tech on visit #2 only
   has rows, not access, before then. En-route / arrived customer texts
   are M3 work (the trigger function exists but has no caller today).
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
| PUT /api/admin/tags/[entity]/[id] | replace the tag set on a customer / location / job: `[id]` re-read in the entity's table under the org, tag ids re-read with `entity = [entity] and active` (400, never a FK 500), delete + insert in one `db.batch` | admin | tagTypeIds[] | tags |
| GET/POST /api/admin/customers/[id]/contacts, PATCH/DELETE …/contacts/[cid] | contacts (sanitise → encrypt → `computeContactHashes`; `locationId` must belong to the customer; deleted, not anonymised, by erase) | admin | name, role, phone, email, locationId, isPrimary | contact |
| PATCH /api/admin/customers/[id]/locations/[lid] | set primary | admin | isPrimary | location |
| GET/POST /api/admin/technicians/[id]/shifts, DELETE …/shifts/[sid] | on-call / time off / non-job events | admin | kind, title, start, end, removesCapacity | shift |
| POST /api/admin/requests/[id]/appointments, PATCH/DELETE …/appointments/[aid] | visits #2+ (CAS on version) | admin | start, end, window, technicianIds | appointment |
| POST /api/tech/jobs/[id]/status | extended with en_route, arrived (writes request status; the trigger mirrors the lead row; ownership = assigned_to) | tech | status | job |

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

### F04 Tech loop (M3a–M3d)

M3 applies to NATIVE requests only (`fieldpulse_job_id IS NULL AND
hcp_job_id IS NULL`): the nightly FieldPulse sync overwrites status and
assignee on synced rows and the money flow already refuses synced
invoices. The tech app shows a "Managed in FieldPulse" notice on synced
jobs and hides close-out, invoice and payment for them.

**Ownership rule (M3a, replaces "assigned_to only").** A technician can
READ a request when they hold any assignment on a non-cancelled visit of
it. A technician WRITES only their own assignment row (progress, pause,
done), plus notes, photos, materials and forms on jobs they can read.
**Open assignment** = status in (assigned, scheduled, en_route, arrived,
in_progress, on_hold). **Active visit** = the earliest non-cancelled
visit with an open assignment; if none, the latest non-cancelled visit.
**Active lead** = the `is_lead` row on the active visit, authorised even
when that row is already `completed` (so the lead can close out after
their own done). The REQUEST status is written only by the active lead.
Helpers never change request status and never send `cancelled` or
`scheduled` (not tech targets). Money (invoice create/finalize, payments,
estimate accept) stays with the active lead. Visit #1 can carry helpers
in M3a through an admin endpoint that inserts a non-lead row (refused once
that technician has progress) and removes a row without progress.

**Tech actions → enum values.** `en_route`, `arrived`, `in_progress`
(working), `pause` (own row → `on_hold`; blocks close-out), `completed`
(done, own row only), `on_hold` as **hold = the visit ends for now**
(active lead only: the request goes `on_hold` with `holdReason` +
`followUpDate`; every open row on the visit with progress becomes
`completed`, without progress becomes `cancelled`; open auto time
entries on the visit close; resuming is a new visit from the office),
and `close_out` (active lead only). There is no `paused` value.

**One batch per tap, fixed order.** (1) the caller's assignment CAS
`WHERE status = $expected`, stamping the matching `*_at` with COALESCE;
(2) for the active lead only, an inline guarded request UPDATE (`status`,
`completed_at`, `hold_reason`, `follow_up_date`) `WHERE id = $1 AND status
= $from AND EXISTS (the assignment row with xmin = pg_current_xact_id()::xid)`
— never `updateRequestStatus` inside the batch (it is multi-statement);
(3) the auto time-entry statement. `recordStatusEvent` (actor = tech) and
the review request run after the batch, only when the request UPDATE
returned a row. No-op rule: own-row taps compare against the row,
request transitions against the request; a lead tap does whichever is
behind; `close_out` on an already-completed request → 200 `changed:
false`. If the row lands but the request CAS misses → 200 with
`requestBehind: true`. A stale own-row CAS (double tap) → re-read; at
target → 200 no-op, else 409.

**Close-out** is one batch: [own row → `completed` if open] then `UPDATE
service_requests SET status='completed', completed_at=now(),
hold_reason=NULL, follow_up_date=NULL WHERE id=$1 AND status IN
('in_progress','on_hold') AND fieldpulse_job_id IS NULL AND hcp_job_id IS
NULL AND NOT EXISTS (open row on a non-cancelled visit)`. 0 rows → re-read:
already completed → 200 no-op; else 409 with blockers (open rows with
technician names; `request_not_started` when the request is
assigned/en_route/arrived — the lead must tap working first).

**Admin paths (M3a).** Admin `completed` on a native request with open
rows that have progress → 409 with the same blockers. Admin `on_hold`
applies the hold rule to the active visit. Request-level schedule and
assignment writes that would rewrite visit #1 (reschedule, assign,
unschedule) → 409 `HAS_PROGRESS` once any row on #1 has progress, the
same as `updateAppointment` for visits #2+.

**Trigger change (M3a migration, `sync_request_appointment` v2).** (a)
step 4 mirrors request status onto the lead row ONLY while that row has
no progress timestamp, and step 3's `ON CONFLICT` keeps a row's status
when it has progress; (b) a demoted lead keeps `completed` (steps 1 and
3); (c) request `cancelled` → every open assignment on every visit
becomes `cancelled` AND every open `kind='job'` time entry on the request
is closed (minutes + labor from `users.labor_rate_cents`); (d) request
`completed` leaves assignments as they are (the close-out guard has
already proven they are closed). `cancelAppointment` also closes the open
job entries of its visit.

**Auto time entries.** `arrived` / `in_progress` open a job entry with
`INSERT … ON CONFLICT (service_request_id, technician_id) WHERE
clock_out_at IS NULL DO NOTHING` (an open manual entry is adopted);
done / pause / hold close whatever job entry is open for that technician
and request.

| method path | does | who | input | output |
| --- | --- | --- | --- | --- |
| GET /api/tech/jobs?range=today\|upcoming\|past | the tech's visits (assignment rows joined to appointments), with the visit's window; past = completed/cancelled rows, 30 days | tech | range | visits |
| GET /api/tech/jobs/[id] | job detail incl. the caller's assignment, the active lead flag, `allowedActions` computed from the assignment status, the close-out blockers | tech | — | job |
| POST /api/tech/jobs/[id]/status | `{ appointmentId, action, expectedStatus?, holdReason?, followUpDate? }`; the batch, no-op, hold and close-out rules above; the review request fires only when close-out changed the row | tech | see left | assignment + request status + blockers + `requestBehind` |
| POST /api/admin/requests/[id]/appointments/[aid]/assignments, DELETE …/assignments/[tid] | add a non-lead technician to a visit (incl. visit #1); remove a row without progress | admin | technicianId | assignments |
| POST /api/tech/time, GET /api/tech/time | general clock in/out (`kind = 'general'`, one open entry per tech enforced by a partial unique index) | tech | action | entry |
| GET /api/admin/timesheets (S25, minimal) | entries per tech per day incl. general | admin | from, to | rows |
| **M3b** (SHIPPED 2026-11-04, see the M3b build-order entry for deviations; money rules: `recordManualPayment` = one batch [invoice claim `… AND NOT EXISTS (SELECT 1 FROM payments WHERE id = $pid)`] then [INSERT payment `status='succeeded'`, `provider='manual'`, id = uuid v5 of the key, gated on the invoice xmin]; `refundPayment` on `provider='manual'` records without a provider call; the mock gate (`getPaymentProvider().name === 'mock'`) also covers the admin payments route and membership charges, not only the portal; FieldPulse-mirrored payments backfill `method='other'`) POST /api/tech/jobs/[id]/invoice | adopt or create the single native draft for the request (`invoices_one_native_draft_per_request_idx` pulled into M3b); lines seeded from the job's materials; 409 when a FP/HCP invoice exists | lead | idempotencyKey | invoice (no cost fields) |
| POST …/invoice/lines, DELETE …/lines/[lid] | `{ pricebookItemId, quantity }` while `draft`; the server snapshots name/price/cost; totals recomputed in the same batch | lead | idempotencyKey | invoice |
| POST …/invoice/finalize | CAS `draft → open` (freezes lines) | lead | idempotencyKey | invoice |
| POST …/invoice/payments | `{ method: 'cash'\|'check', amountCents, checkNumber? }` against `state = 'open'` only, through `recordManualPayment` (atomic balance claim, no provider call, `provider = 'manual'`, `payments.method`); payment id derived from the idempotency key (uuid v5) so a replay reuses the row | lead | idempotencyKey | payment + invoice |
| POST …/invoice/pay-link | SMS/email the portal link (tech version of the admin pay-link); shipped SMS only, `{ invoiceId }`, 2-minute cooldown on `invoices.pay_link_sent_at` | lead | channel | sent |
| **M3c** POST /api/tech/jobs/[id]/estimates, POST …/estimates/[eid]/present, POST …/sign | build options from the pricebook (no templates, no deposit), present on device, accept with signer name + signature via a `markEstimateSold` variant (actor tech), then sold lines append to the draft invoice exactly once | lead | options; signature | estimate |
| POST /api/tech/jobs/[id]/equipment | add / replace equipment at the location (`replaced_by_equipment_id`, `retired_at`) | tech | fields, replacesId | equipment |
| **M3d** GET /api/tech/forms, GET/PUT /api/tech/jobs/[id]/forms/[formId] | fill a form; PUT upserts on `(service_request_id, appointment_id, form_id)` | tech | values | submission |
| GET /api/tech/jobs/[id]/location-info | past jobs at the location, open estimates, membership | tech | — | info |

**Idempotency (M3b onward, `idempotency_keys`).** Rate check first; then
`INSERT … ON CONFLICT DO NOTHING RETURNING`. Winner: run the write with
entity ids derived from `uuidv5(org|user|route|key)` and `ON CONFLICT (id)
DO NOTHING`, then `UPDATE state='done', response`. Loser: `done` + same
hash → replay the stored status/body (ids and enums only; the client
re-GETs the job); different hash → 422; `in_progress` younger than 2
minutes → 409 with Retry-After; older → CAS takeover and re-run (safe
because ids are derived). TTL 7 days (longer than the 24h tech session);
the client drops queued items older than 72h. Multipart routes (signature,
photo) hash `(route, jobId, sha256(file), name)` and claim the key BEFORE
the upload. Status taps need no key: "already at target" is a no-op.

**Deferred out of M3** (with the row left open): offline queue + `GET
/api/tech/sync` + cached pricebook (row 124; size L, nothing exists; a
later M3e after M4); video / direct-to-storage uploads (row 122 stays
partial; photos + PDFs work); sold-not-booked "later" (M4); card payment
in the field (M4 Stripe); tech book-a-job / lead (row 119 is a should and
`leads` is M1); estimate templates, deposit, finalize lock (M4); "schedule
another visit" from the field (should); required-forms-block-close-out and
guided flows (should); GPS/backdating/timesheet codes (should); en-route /
arrived customer texts (M6, with a ledger key `enroute:{appointmentId}`).

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
  not apply. Contacts are searchable by phone/email hash in admin global
  search ONLY: they never join `findCustomerMatchByContact` /
  `upsertCustomerByContact`, which feed the AI, voice caller-ID and SMS
  consent paths (a tenant calling from a contact phone must not be greeted
  as the landlord). Fuzzy search stays open.
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
  `agreement-`); `notStandInSession` in `stand-in-session.ts` hard-codes
  three LIKE patterns today and must be rebuilt as an OR over the whole
  prefix array (with a test) before a fourth prefix is added. The cleanup
  cron's 90-day `customer_sessions` delete must also exclude stand-ins
  (requests reference them without a cascade).
- **Status enum readers.** Adding `en_route`/`arrived` touches 25
  hard-coded status lists, not one. M0a adds shared constants to
  `src/lib/admin/request-status.ts` (`OPEN` = in flight + pending,
  `IN_FLIGHT` = scheduled/assigned/en_route/arrived/in_progress/on_hold,
  `UNASSIGNED_OPEN`, `NEEDS_PLACEMENT`, `ON_SITE` = arrived/in_progress,
  `NOT_STARTED` = scheduled/assigned/en_route) and a test that fails when
  an enum value appears in no list. Rule: each existing list gets the new
  values added where they belong and is pointed at the constant whose
  members are byte-identical to it; lists that differ today (some include
  `pending`, some not; ops-insights drops `scheduled`/`on_hold`) are NOT
  merged in M0a, so output stays identical. The readers:
  `queries.ts` (OPEN/ASSIGNABLE/UNASSIGNED_OPEN/REASSIGNABLE + raw SQL at
  the in-progress KPI), `scheduling-queries.ts` (ACTIVE_BOOKING,
  UNSCHEDULED, the raw-SQL double-book guard), `api/tech/jobs/route.ts`
  ACTIVE_STATUSES, `api/admin/dispatch/map/route.ts`, `portal-queries.ts`,
  `ai/account-tools.ts`, `ai/account-reply.ts` (switch default),
  `ai/dispatch/signals.ts`, `dispatch/delay-detection.ts`
  (NOT_STARTED_STATUSES must include en_route), `ops-insights-queries.ts`,
  `operations-metrics-queries.ts` (response time becomes the first
  event into `ON_SITE`, backward compatible), `status-colors.ts`, the
  requests page whitelist + `request-filters.tsx`, `request-status.ts`
  TRANSITIONS + MANUAL_TARGET_STATUSES (feeds the tech status zod enum and
  `STATUS_ACTION_LABELS` in `request-detail-sheet.tsx`, which fails to
  compile until "Mark en route" / "Mark arrived" exist),
  `insights/ops-insights-section.tsx` STATUS_LABELS, the FP import
  `FP_JOB_STATUS_MAP` (FP stage "2" → `en_route`; no preserve clause: FP
  jobs are FP's, and a preserved `en_route` would block FP's later
  `in_progress`), the FP webhook mapper and the HCP webhook mapper
  (`job.on_my_way` → `en_route`), and `account-reply.ts`, which needs
  en_route/arrived wording instead of the "being scheduled" default.

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
   default duration (settings page; `color` is a zod enum of
   status-colors tokens), `job_type_id` on requests (the server derives
   `job_type` from `kind` and sets `estimatedDurationMinutes` with source
   `job_type` in the create batch; `locationId`/`contactId` must belong to
   the customer and are null for an inline customer), primary location set
   by a separate guarded UPDATE on create and re-selected on delete,
   contacts deleted and tags removed in the erase / hard-delete paths, S07
   uses all three. Tables: 4 new, 2 extended. No dual
   writes. Must-haves closed: 22, 23, 27, 55, 56, 83.
   Done when: an admin creates a job type with a default duration, tags a
   customer and a job, adds a second contact, and the New request dialog
   offers all three; erase anonymises contacts.
3. **M0a Schedule foundation.** `en_route`/`arrived` with the 25 readers
   on shared constants, appointments + assignments backfilled and kept in
   step by the trigger, visits #2+ through the API + detail sheet, shifts
   (on-call / time off / non-job) subtracted in `readSchedulingFacts`,
   `checkScheduleConflict`, the `placeAndAssignRequest` guard,
   `technicianWindowClash` and autodispatch `signals.ts` (DB scheduling
   source only; HCP-sourced orgs ignore shifts), tech taps en route /
   arrived. Tables: 2 new (+ shifts = 3), 1 enum. Gets its own
   adversarial review before merge. Must-haves closed: 64, 85, 86, 98
   (data), 117.
   Done when: every request with a date, window or assignee has
   appointment #1 (and a lead assignment when assigned) matching its
   columns; the calendar, dispatch and tech app produce identical output
   before and after, and the FieldPulse nightly sync is identical except
   FP stage 2 now reads `en_route`; a second visit added through the API
   is listed on the request detail sheet and cancelled with the request;
   a tech (the request's `assigned_to`) taps en route then arrived, the
   admin sheet shows the same, and the AI account reply describes it
   correctly; a technician on time off is skipped by availability, the
   conflict check, placement and auto-dispatch.
4. **M3 Tech close-out loop, in four shippable loops** (native jobs only;
   see F04 for the ownership rule, the action → enum mapping and the
   trigger change). Must-haves: 12 closed, 122 and 133 partial, 124
   deferred.
   - **M3a Run the day.** Migration: `technician_time_entries.kind`
     (`job|general`), nullable `service_request_id` with a check, 
     `appointment_id`, partial unique "one open general entry per tech";
     trigger changes (a)–(d). Ownership helper replacing the seven
     `assigned_to = me` sites; `POST …/status` redesigned (appointment id,
     action, hold reason, close-out guard, review fires once); auto job time
     entries opened on `in_progress`/`arrived` and closed on hold/pause/done;
     general clock API + `kind = 'job'` filters in the on-site KPI, the
     labor export and reporting; `/tech/jobs` tabs today / upcoming / past;
     S38 close-out sheet (Done / Pause / Hold with reason; blocked list);
     clock button; minimal admin timesheets list. Admin edits of a visit
     with progress → 409. Must-haves closed: 115, 118, 120, 137, 138.
     Adversarial review before merge (authorization + roll-up).
     Done when: on a native request whose visit #1 has lead A
     (`assigned_to`) and helper B (added through the admin assignments
     endpoint), A taps en route → arrived → working, B taps en route →
     arrived → working; A taps done while the request stays
     `in_progress`; A's close-out returns 409 naming B; B taps done; A's
     close-out completes the request with one review request, one
     completed status event by A, and all eight `*_at` stamps set; B's
     taps never change the request status or add a status event; B
     cannot send cancelled/scheduled (400) or close_out (403); a lead hold
     with `awaiting_parts` stores the reason, completes A's row, cancels
     an untouched helper row and closes the open auto entries; admin
     cancel leaves no open assignment and no open job time entry; a
     general clock-in sent twice leaves one open entry with no labor
     cost, invisible to on-site minutes and the labor export; a synced
     FieldPulse job refuses every tech status write and the signature
     with 409 (notes, photos, materials and manual job time stay
     allowed on readable jobs); for a single-tech
     native job the JSON of `GET /api/admin/calendar?date=D` and `GET
     /api/admin/requests/[id]` is identical before and after the
     migration.
   - **M3b Collect.** Migration: `payments.method` + `check_number`,
     `invoices_one_native_draft_per_request_idx` (pulled from M4),
     `idempotency_keys`. `createInvoiceFromJob` (materials → lines),
     `recordManualPayment`, the idempotency helper, the invoice/lines/
     finalize/payments/pay-link tech routes, S40 invoice view with the job
     signature and a Cash / Check payment sheet; the portal pay button and
     `/pay` route refuse while the provider is the mock; erase deletes
     signature objects in R2. Must-haves closed: 134, 135 (manual).
     Adversarial review (money).
     Done when: a tech creates an invoice from the job's materials, the
     customer signs on the phone, the tech records a check payment, the
     invoice reads paid with no office action; replaying invoice-create
     and payment with the same key creates one of each; a different body
     with the same key gets 422; no card option appears on the mock.
     **SHIPPED 2026-11-04 (main, not deployed; parity 44.9 → 45.9; 134,
     135 and 185 closed, 168 still partial).** Deviations from the plan
     above and from spec §4–§5:
     (1) the invoice carries its own signature snapshot
     (`invoices.signature_url/name/signed_at`). Finalize copies the request
     signature only when it is newer than the invoice's last change, and
     nothing rewrites it afterwards. The approval sheet signs first, then
     finalizes.
     (2) Every tech write names its `invoiceId` in the body, so it is part
     of the hash. Lines and finalize need the newest live invoice (else
     409 `STALE`); payments and pay link accept any non-void native
     invoice.
     (3) The pay link is SMS only, with a 2-minute cooldown claimed on
     `invoices.pay_link_sent_at` before the token mint (never
     `last_reminder_sent_at`).
     (4) Manual refunds record without a provider call and put the invoice
     back to `open` (never `refunded`).
     (5) $0 drafts finalize to `open`. There is no due date (`issued_at`
     is set). An admin finalize route exists (`POST
     /api/admin/invoices/[id]/finalize`).
     (6) `STORED_CODES` includes `SEND_FAILED` ("The link may not have gone
     out. Try again in 2 minutes.").
     (7) The totals statement `T` keeps `updated_at` when a retry leaves
     the subtotal unchanged, so a fresh signature survives a no-op.
     (8) Reconcile's un-claim of a failed or mock-pending card payment
     includes drafts and keeps them drafts.
     (9) `scripts/agent/mint-tech-session.mjs` honours `MINT_ORG_ID`.
     (10) Office money forms send a client token; ids are
     `officeId(kind, org, token)` (org-scoped), and a reused token is
     `ID_CONFLICT`.
     (11) Materials are billed at most once per request across non-void
     invoices (`invoice_line_items.job_material_id`). Sold-estimate jobs
     bill materials through the office, and the estimate creator refuses
     while the request has a field draft.
     (12) Keys live 7 days (the cleanup cron deletes older rows). The
     client keeps in-flight intents in `sessionStorage` per job rather than
     in a 72 h queue, because there is no offline queue yet.
     Erase now nulls and deletes the signature on both requests and
     invoices, and `purgeOrganization` passes object keys (it used to pass
     URLs).
   - **M3c Sell on site.** Tech estimates with options from the pricebook,
     present + sign (`markEstimateSold` variant, signer + signature), sold
     lines appended to the draft invoice exactly once; equipment add /
     replace from the field. Must-haves closed: 129, 132, 133 (now).
     Adversarial review (estimate → invoice money path).
     Done when: a two-option estimate is built, the customer picks and
     signs on the device, the estimate is sold and its lines are on the
     draft invoice once even when signed twice; a replaced unit shows
     `retired_at` and `replaced_by`.
   - **M3d Forms + site view.** `forms` (flat `fields` jsonb) +
     `form_submissions` (unique per request/visit/form; values encrypted;
     erased), an admin forms builder under Settings, tech fill with draft
     autosave, the location-info tab, a photo quality toggle. Must-haves
     closed: 125, 131, 122 (photos/files).
     Done when: an admin creates a checklist, the tech fills half,
     reloads, sees the draft, submits; the submission shows on the admin
     job and is anonymised by erase; the location tab lists past jobs,
     open estimates and the membership.
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
