# Architecture: ai-hvac-agent (a rebuild of FieldPulse's and ServiceTitan's core loops)

Reads `recon.md` and `features.csv`. The clone is not a new app. It is nine
milestones of additions to an app that already runs intake, dispatch,
estimates, invoices, memberships, a tech app and a FieldPulse mirror. The
first parity score is 40.2 (39 of 111 must-haves). This plan orders the 72
missing must-haves into loops, each shippable on its own.

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

Tables: 24 new, 17 extended, 2 enums extended (see `schema.sql`). Access
rules: data-layer checks. Every query takes the session `organizationId`
through `withTenant`; nothing moves to row-level security.

Three modelling decisions carry the whole plan:

1. **Job stays `service_requests`. Appointments are a child table.** One
   appointment per request is backfilled from `scheduledDate`,
   `arrivalWindowStart/End` and `assignedTo`, and the request keeps those
   denormalised columns as "appointment #1". Everything that reads them
   today (calendar, dispatch, KPIs, the FieldPulse one-job-one-id sync, the
   AI booking path) keeps working; multi-visit jobs are additive. The data
   layer keeps the two in step on every write (`db.batch`).
2. **Canonical status stays an enum; display statuses are rows on top.**
   `service_requests.status` gains `en_route` and `arrived`, and
   `workflow_statuses.kind` maps every org-defined status to a canonical
   kind (`new`, `scheduled`, `travel`, `arrived`, `in_progress`, `pause`,
   `hold`, `complete`, `cancel`). The intake agent, the 15 trigger types,
   the operations KPIs and `FP_JOB_STATUS_MAP` go on reading the enum. The
   same shape holds for job types (`job_types.kind` = the existing enum).
3. **Money stays snapshot-based and source-guarded.** Line items snapshot
   the pricebook at write time (already true). Synced FieldPulse/HCP records
   stay read-only in every new money flow: the `fieldpulse_invoice_id IS NOT
   NULL` guard extends to the invoice builder, recurring billing and batches.

Hard constraints that live in the database, not the UI:

- one primary location per customer (partial unique index)
- one non-void draft invoice per job (partial unique index)
- one service event per membership × routine × period (unique index; this
  is what stops a re-run cron from flooding dispatch)
- one recurring-billing invoice per billing period (unique index)
- idempotency keys for every tech-app write (so the offline queue can replay)
- reassign guard: refuse an assignment move when its status is en_route,
  arrived, working or done (data layer, with a test)

## API

Routes are grouped by flow. `admin` = `getAdminSession()`; `tech` = the
technician JWT; `token` = a hashed single-purpose token; `cron` = bearer
`CRON_SECRET`. Inputs are zod-validated at the boundary, as today.

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
| GET/POST/PATCH /api/admin/settings/job-types, tags, zones | config | admin | rows | rows |

### F03 Dispatch (M2)

| method path | does | who | input | output |
| --- | --- | --- | --- | --- |
| GET /api/admin/dispatch/board | tech rows × time grid for a day | admin | date, teamIds, skills, status filters | techs with shifts, appointments with assignments, tray buckets by status |
| POST /api/admin/appointments/[id]/move | drag: time and/or tech | admin | startsAt, technicianIds, windowRule (keep/match/pick), windowId | appointment; 409 when guarded |
| POST /api/admin/appointments/[id]/confirm, /dispatch, /unassign | status actions | admin | — | appointment |
| POST /api/admin/requests/[id]/appointments | add a visit | admin | start, window | appointment |
| GET/POST/PATCH/DELETE /api/admin/staff/[id]/shifts | shifts, time off, non-job events | admin | kind, start, end, repeat | shift |
| GET/PUT /api/admin/settings/capacity | per-day window adjustments | admin | day, window, delta, threshold | rows |
| POST /api/admin/dispatch/mass-reschedule | move a tech's day | admin | technicianId, date, deltaMinutes | count |

### F04 Tech loop (M3)

| method path | does | who | input | output |
| --- | --- | --- | --- | --- |
| POST /api/tech/jobs/[id]/status | extended: en_route, arrived, working, paused, hold(reason), done (per tech), close_out | tech | status, reason, idempotencyKey | job + fired triggers |
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
  timezone; the recurrence engine (RRULE) evaluates in the org timezone so a
  "first Monday" does not drift across DST. Windows crossing midnight are
  stored as start/end timestamps, never as a day + window name.
- **Idempotency.** Stripe and Twilio deliver twice: the existing
  `*_webhook_events` pattern extends to a `stripe_events` ledger. Every tech
  POST carries an idempotency key the server stores with the response.
  Materialisation and billing crons are keyed by period (unique indexes).
- **Races.** Two dispatchers moving one appointment: optimistic concurrency
  on `appointments.updated_at` (409 + refetch). Booking the last slot: the
  existing `capacity_reservations` row is the lock, taken in the same
  `db.batch` as the appointment. Reassign of a working job: guarded in the
  data layer and covered by a test, not only hidden in the UI.
- **Rate limits.** Stripe and QBO (QBO throttles; batches of 3–4 invoices,
  as ServiceTitan's help warns). Public booking endpoints go through the
  existing sliding-window limiter.
- **Offline.** No service worker in the first pass: form state autosaves to
  IndexedDB per job, writes queue with idempotency keys and replay on
  reconnect, and the job bundle is cached with an ETag. Payments and new
  records stay online-only (FieldPulse's rule).
- **Search.** The customer scan cap in global search (`SCAN_LIMIT_CUSTOMERS`)
  is a known gap; M0 adds trigram indexes on the blind-indexed hashes'
  display columns and searches contacts and locations too.
- **Multi-tenancy.** Every new table carries `organization_id`; every new
  query goes through `withTenant`. Public endpoints resolve the org from the
  slug or token, never from the body.
- **GDPR deletion.** The erase path must also anonymise contacts, form
  submissions, signatures on new estimates/invoices and saved payment
  methods (detach at Stripe). Add to the erase checklist in M3/M4.
- **PII and audit.** New tables that hold names, phones, emails and
  addresses (contacts, leads) encrypt with the existing AES-GCM helpers and
  blind-index the lookups. Audit details stay ids/enums only.
- **Money.** Cents everywhere. Snapshot at write time. Synced records
  read-only. No blended totals of native and synced money (already a rule).
- **Status enum readers.** `grep` for every reader of `service_request_status`
  and `job_type` before M0 lands; the FP status map, the intake agent, the
  triggers and the KPIs each get a one-line change plus a test.

## Build order

Each milestone lists its screens (S-IDs from `recon.md`), tables and
routes, and is shippable on its own. The vertical slice is the loop that is
impossible today.

1. **Vertical slice (M1-thin): office books a job.** S07 job form (customer
   picker with inline create, job type, priority, summary, window, assignee,
   find availability against the existing availability query), S08 job
   record page (promote the detail sheet). Tables: none new (uses the
   existing request columns; appointment #1 lands in M0). Routes:
   `POST /api/admin/requests`, `GET /api/admin/requests/availability`.
   Done when: a dispatcher creates and schedules a job in under 10 clicks
   and it appears on the calendar, the dispatch board and the tech app.
2. **M0 Foundation.** Tags, contacts, location records (S04), job types,
   zones, status workflows (S28) + guided flows (S29), appointments +
   assignments (backfilled), shifts (S13), capacity adjustments (S12).
   Tables: 12 new, 4 extended. Must-haves closed: tags, contacts,
   multi-tech, configurable job types, shifts/non-job events, multi-visit,
   business hours.
3. **M1 Office booking loop, full.** Leads + call reasons, bookings review
   with dismiss reason (S34), job templates, draft invoice at booking,
   sold-by, cancel reasons, merge customers. Must-haves closed: 9.
4. **M2 Dispatch board.** S10 time grid with status bubbles, jobs tray,
   arrival-window prompt, reassign guard, mass reschedule, tech row menu,
   non-job events on the board; S11 route sequencing. Must-haves closed:
   reassign guard, window prompt, team grouping.
5. **M3 Tech close-out loop.** S38 en route → arrived → working → paused /
   hold → done per tech → close-out sheet; forms (S29 config + M09 fill);
   equipment from the field; S39 present estimate; S40 invoice + payment
   (Stripe); general timeclock (S25 admin page); offline autosave + replay;
   tech book-a-job (S41). Must-haves closed: 14.
6. **M4 Money builder.** S16 estimate editor (edit after send, lock at
   milestone, templates, groupings, add-ons, deposit), sold-not-booked queue,
   S19 invoice builder from scratch / from job, line editor, discounts and
   fees, tax zones, payment methods, real Stripe adapter, pay requests.
   Must-haves closed: 9.
7. **M5 Agreements.** Billing table on plans, routines, service events
   materialised 12 months out, recurring-events tab + bulk book (S14, S33
   tab), renewal / suspend / cancel, recurring billing with retry schedule
   (S21). Must-haves closed: 6.
8. **M6 Follow-up hub + automations + inbox.** S33 tabs, follow-up drawer
   with outcome enum, S30 trigger builder (seeded from the 15 fixed types),
   S32 email threads, follow-up flag, polling, on-the-way text with tracking
   link. Must-haves closed: 6.
9. **M7 Pricebook + inventory.** Category UI, CSV import with dry run,
   add-on prices, bundles, hubs/trucks, movements, auto-deduct on invoice,
   suppliers, receive flow. Must-haves closed: 3 (plus 12 shoulds).
10. **M8 Portals.** S36 booking page on booking services + real capacity +
    deposit; S35 portal: submit request, equipment, memberships, pay
    (Stripe), visibility toggles. Must-haves closed: 4.
11. **M9 Team, reporting, accounting.** Dispatcher/office roles + per-user
    overrides, business units (single default row), dashboard widgets +
    saved views, raw-data export, accounting batches, QBO OAuth push.
    Must-haves closed: 5.
12. **Fixes from `replica-entrepreneur`** (not run yet). The recon reports'
    review sections already list the targets: no contract lock-in, day-one
    pricebook from the FieldPulse mirror, onboarding in hours by import,
    light mobile web with autosave, one-screen booking, readable default
    reports, editable field notes, route sequencing that is an actual
    solver, webhooks for customers and payments, series edits that do not
    overwrite occurrence edits.

Design: `replica-design` is satisfied by the shipped 2026-08 design system
(`src/components/admin/ui/`, `status-colors.ts`); new component specs for the
appointment bubble, jobs tray, arrival-window prompt, close-out sheet, option
presenter and add-item panel go in `replica/design/components.md` as each
milestone starts, composed from the existing primitives and tokens.

Three riskiest parts: (1) the appointments/assignments split under the live
FieldPulse sync; (2) replacing two fixed enums with workflow rows without
breaking the intake agent, triggers and KPIs; (3) real money (Stripe cards,
recurring billing with retries, batches) replacing the mock seam. Each gets
its own adversarial review before merge.

Next step: `/replica-design` (short, additive) then `/replica-build` on the
vertical slice.
