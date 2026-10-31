# Recon map: FieldPulse + ServiceTitan (web + mobile web)

Scope: the field-service-management core loop of both products, merged into
one target: **customer → job → schedule → dispatch → tech completes → invoice →
payment**, plus the three money loops that hang off it (estimates,
memberships/agreements, recurring billing) and the office loops that feed it
(call booking, two-way comms, follow-up queues, reporting).
For: our own team (an HVAC contractor on Spears Services data) running this
app instead of FieldPulse, with ServiceTitan's workflow depth at FieldPulse's
scale. The clone is built **into the existing `ai-hvac-agent` app**, not from
scratch.
Date: 2026-10-31

Companion files in this folder:

| file | what |
| --- | --- |
| `features.csv` | the merged feature matrix, `clone` column filled from the app inventory; scored by `replica-diff/parity.py` |
| `recon-fieldpulse.md` | full FieldPulse recon (49 web + 10 mobile screens, 7 flows, OpenAPI-derived data model, 162 features, 19 review quotes) |
| `recon-servicetitan.md` | full ServiceTitan recon (44 screens, 10 flows, v2-API-derived data model, 264 features, 27 review quotes) |
| `app-inventory.md` | what this app already has, by area, with routes (yes / partial / no) |
| `prior-servicetitan-plan-2026-06.md` | the earlier 10-stage ServiceTitan-class roadmap, recovered from git history; most of its Stages 1–9 have since shipped |
| `screens/` | reference screenshots of the originals. Empty so far: neither product publishes app URLs, and we hold no FieldPulse screenshots we are licensed to keep. Fill from the user's own FieldPulse account when wanted |

Rules followed: public sources only (help centers, pricing pages, changelogs,
app-store listings, the published FieldPulse OpenAPI spec, the public
ServiceTitan v2 API reference, review sites). No logins, no bundles, no
private endpoints. Source IDs like `[FP H7]` and `[ST #4]` resolve to the
sources tables in the two companion reports.

## Sources

| # | source | URL | notes |
| --- | --- | --- | --- |
| 1 | FieldPulse help center | https://help.fieldpulse.com (+ `/llms.txt` index of 428 pages) | the whole feature IA; per-feature articles cited as `[FP Hn]` |
| 2 | FieldPulse OpenAPI spec | https://help.fieldpulse.com/openapi/fieldpulse-api.json | 30 resources with request bodies and enums; data model is high confidence |
| 3 | FieldPulse pricing + changelog | https://www.fieldpulse.com/pricing, https://help.fieldpulse.com/changelog | add-on list (what they charge extra for), recent releases |
| 4 | FieldPulse reviews | App Store, Trustpilot, Capterra (second-hand via fervorstudio.ca; G2/Capterra blocked direct fetch) | 19 quotes |
| 5 | ServiceTitan help center | https://help.servicetitan.com | dispatch board, call booking, records, FMA, memberships, ACP, batching |
| 6 | ServiceTitan v2 API reference | https://developer.servicetitan.io/api/docs/apis/tenant-*-v2 | CRM, JPM, Dispatch, Accounting, Pricebook, Memberships, Sales, Settings, Inventory, Payroll, Equipment, Marketing |
| 7 | ServiceTitan pricing + Pro pages | https://www.servicetitan.com/pricing, /features/pro/* | tiers, Pro add-ons, Titan Intelligence gates |
| 8 | ServiceTitan reviews | Trustpilot, App Store, G2/Capterra via search snippets, Reddit via checkthat.ai | 27 quotes |
| 9 | This app | `app-inventory.md`, `.claude/skills/page-*`, `src/lib/db/schema.ts` | the `clone` column baseline |

## Core loop

An office person (or our AI agent) books a job for a customer at a location,
a dispatcher puts it on a technician's day, the technician drives, works,
quotes, invoices and collects on a phone, and the owner sees the money and
the KPIs the same day. Everything either product charges extra for is a loop
bolted onto that one.

What each original is best at, and what we take:

- **FieldPulse**: the simple, single-screen job form; status workflows with
  time-in-status; ClearPath guided tech flows; maintenance agreements with
  routines/occurrences; recurring billing; a plugin switchboard; a customer
  portal with ~20 visibility toggles; one API shape for estimates and invoices.
- **ServiceTitan**: Customer ≠ Location; Job ≠ Appointment; the dispatch board
  (status-coloured bubbles, jobs tray, arrival-window prompt on drag, no
  reassign of Working/Done); Follow Up queues (unsold estimates, recurring
  events, expiring memberships, leads); capacity planning; status timestamps
  that feed job costing; memberships as a type + recurring service events
  materialised a year ahead and bulk-booked.
- **This app already wins at** the top of the funnel (AI chat/voice/SMS intake
  that books against live capacity), auto-dispatch with shadow mode,
  collections with dunning, and a money-grade FieldPulse mirror.

## Screens

Unified target screens for the clone. `FP`/`ST` give the originals' screen
IDs from the companion reports. `today` is the route that exists now and its
status against the originals (`=` parity or better, `~` partial, `×` missing).

| ID | screen | route / how to reach | purpose | key components | FP | ST | today |
| --- | --- | --- | --- | --- | --- | --- | --- |
| S01 | Dashboard | `/admin` | owner snapshot | KPI tiles, today's schedule, needs-attention, overdue invoices, onboarding checklist; **configurable widgets, default homepage** | S01 | S01 | `~` fixed layout, no widget config |
| S02 | Customers list | `/admin/customers` | find/manage customers | search, filters, tags, archived toggle, **by-pipeline kanban**, import/export | S03, S04 | S14 search | `~` no tags, no pipeline, no CSV import |
| S03 | Customer record | `/admin/customers/[id]` | bill-to party | header KPIs (lifetime revenue, avg ticket, balance due), locations, contacts, equipment, memberships, jobs, estimates, invoices, payments, notes, follow-ups, media, history timeline, merge | S05 | S14 | `~` no header KPIs, no contacts list, no merge, no timeline |
| S04 | Location record | `/admin/customers/[id]/locations/[locId]` (new) | service site | address, zone, tax zone, access notes, equipment (lives here), recurring services, jobs at this site, preferred tech | S05 (multi-location) | S15 | `×` table exists, no UI |
| S05 | Equipment detail | from S03/S04 | asset history | make/model/serial, warranties, install date, predicted replacement, service history, replace vs retire | S36 | S16 | `~` registry exists, no per-asset history view |
| S06 | Jobs list | `/admin/requests` | all work | filters by status/urgency/tech/date, tabs **Unassigned / Recurring / Holds**, saved views, archive | S06 | S07 (tray) | `~` filters exist; no saved views, no recurring tab, no archive |
| S07 | Job booking form | `/admin/requests/new` (new) | office creates a job | customer picker with inline create, location picker, job type, priority, summary, tags, **find availability**, conflict check, arrival window, assignees with skill chips, equipment attach, custom fields, save as template | S07, S09 | S02, S04 | `×` staff cannot create a job today |
| S08 | Job record | `/admin/requests/[id]` (promote the detail sheet to a page) | work hub | status bar with time-in-status, appointments, assignees, estimates, invoice, materials, timesheets, forms, media, notes vs field notes vs internal, history timeline, job actions (hold with reason, cancel with reason, recall, warranty, duplicate, create PO) | S08 | S17 | `~` sheet exists; no appointments, no recall/warranty, no forms |
| S09 | Calendar | `/admin/calendar` | day/week/month/agenda | drag-drop lanes, unscheduled panel, conflict dialog | S11, S10 | — | `=` |
| S10 | Dispatch board | `/admin/dispatch` | assign and move | tech rows × time grid, **status-coloured bubbles**, jobs tray with status tabs, holding area, **arrival-window prompt on drag**, reassign guard for in-progress/done, header status counts as filters, BU/team/skill filters, mass reschedule, tech row menu (route, memo, time off, call/text) | S12, S15 | S05–S10 | `~` kanban per tech; no time grid, no tray tabs, no window prompt |
| S11 | Dispatch map | `/admin/map` | geographic dispatch | job pins by status, tech last-known pins, unassigned/unscheduled filter, **schedule-route sequencing**, day/range modes | S13, S14, S16 | S11 | `~` pins + AR layer; no route sequencing, 25-pin cap |
| S12 | Capacity planning | `/admin/settings/capacity` (new) | bookable hours per window | per-day per-window base capacity, threshold, skill-aware availability, exceeding-ideal flag | S44 (smart scheduler) | S13 | `×` slot reservations only |
| S13 | Technician availability + shifts | `/admin/staff/[id]/schedule` (new) | hours, time off, on-call | weekly hours, shift exceptions, time off, non-job events on board | S41 | S10, shifts | `×` table exists, no UI |
| S14 | Recurring jobs / agreements | `/admin/agreements` (new; today `/admin/membership-plans`) | plans + routines + occurrences | agreement list with next-occurrence rows, templates, occurrences tab, 5-step create wizard (general, routines, billing, comms, review), contract e-sign, **bulk book events** | S17, S34, S35 | S24, S20 (events) | `~` plans + visit generation exist; no routines, occurrences tab, wizard, contract, bulk-book |
| S15 | Estimates list | `/admin/estimates` | pipeline | KPI band, status filters, stale filter, search | S19 | S19, S20 | `=` |
| S16 | Estimate builder | `/admin/estimates/[id]/edit` (new; today a create dialog) | build quote | add-item side panel (search pricebook, add-next), option tabs (good/better/best), groupings, bundles, add-on options, markup/margin tool, line photos, notes vs internal notes, files, contract, expiry, **import/save as template**, edit after send | S20 | S19 | `~` create-only dialog; no edit, no templates, no groupings/bundles |
| S17 | Estimate preview / present | `/admin/estimates/[id]` + `/estimates/[token]` | customer-facing render | dynamic link, PDF, present mode, sign/accept, deposit on signature | S21 | S39, S33 | `~` token page + e-sign exist; no PDF, no present mode, no deposit |
| S18 | Invoices list | `/admin/invoices` | collections | overdue-first, source pills, reminders, **recurring billing tab**, batch/export | S22 | S18, S29 | `~` no recurring tab, no batch |
| S19 | Invoice builder / detail | `/admin/invoices/[id]` + `/admin/invoices/new` (new) | bill | same builder as S16, finalize, lock-at-milestone, payment button (collect / send request / mark manual), payments tab, display toggles, amount-due display, expenses | S23 | S18 | `~` detail exists; no from-scratch or from-job builder, no line edit |
| S20 | Payment sheet | from S19 / tech app | take money | card keyed/tap, ACH, email request, mark cash/check with check number, deposit flag, surcharge | S25 | S40 | `~` record-payment exists; card = mock provider |
| S21 | Recurring billing form | from S14 / S18 | auto-invoicing | frequency, occurrence date, auto-send, default status, end method, card retry schedule | S24 | S24 (type billing table) | `×` |
| S22 | Pricebook | `/admin/pricebook` | catalog | categories tree (list or G/B/B), services / materials / equipment, member + add-on prices, labor + overhead rates, markup categories, bundles, add-on lists, flat-rate jobs, **CSV import**, client-specific pricing | S27, S28 | S23 | `~` 17.5k items, tax rates; no category UI, no import, no bundles UI |
| S23 | Inventory | `/admin/inventory` | stock | items, **hubs (truck/warehouse)**, counts, transfers, auto-deduct on invoice, reorder → PO | S28, S29 | S30 | `~` single location; no hubs, no deduct, no transfers |
| S24 | Purchase orders | `/admin/inventory/purchase-orders` | supplier ordering | supplier picker, link to job/project/invoice, delivery/pickup, statuses, receive, send email / PDF | S30 | S30 | `~` panel exists; vendor send is a mock, no suppliers table |
| S25 | Timesheets | `/admin/timesheets` (new) | hours review | general vs job time, clock locations, backdated entries, per-tech per-period, export | S32 | S31, S41 | `×` per-job tech entries only, no admin page |
| S26 | Reports | `/admin/reports` + `/admin/operations` | KPIs | revenue, AR, close rate, lead-source ROI, tech scorecards, operations KPIs, **raw-data exports with relative dates, saved reports** | S02, S33 | S27, S28 | `~` fixed reports; no builder/export |
| S27 | Settings hub | `/admin/settings` | configuration | 9 tabs today + **features/plugins switchboard, job types, tags, status workflows, arrival windows, zones, skills, cancel/hold reasons, business hours** | S37, S38 | S32 | `~` |
| S28 | Status workflow editor | `/admin/settings/workflows` (new) | job lifecycle | statuses with colour/type (travel, in progress, pause, complete), default, per-type workflow, time-in-status | S38 | — (fixed) | `×` fixed enum |
| S29 | Guided tech flow (ClearPath) config | `/admin/settings/workflows/[id]/flow` (new) | per-status instructions + buttons | status instructions, action buttons, focus-view widgets, required forms | S39 | S38 (close-out) | `×` |
| S30 | Automations / triggers | `/admin/communications/templates` → `/admin/communications` | comms automation | trigger (event, offset), action mode (auto / prompt / scheduled / confirm), template, channel | S40 | S26 | `~` 15 fixed triggers; no custom trigger builder |
| S31 | Team / roles | `/admin/staff` | users, permissions | roles, per-user permission toggles, skill tags, teams, schedule visibility | S41 | S32 | `~` 3 roles only |
| S32 | Inbox (two-way comms) | `/admin/conversations` | threads | SMS/chat/call/voicemail/email per customer, notes toggle, follow-up filter, sending-from line, link to job, AI summary | S45, S46 | S12, S20 | `~` chat/SMS/phone; no email, no follow-up filter, no polling |
| S33 | Follow Up hub | `/admin/follow-up` (new) | work queues | tabs: unsold estimates, sold-not-booked, recurring service events, expiring memberships, leads, unreached bookings; log follow-up with template + next date; initiate booking; bulk book | S04 (pipeline) | S20, S21 | `×` follow-ups exist per customer only |
| S34 | Bookings review | `/admin/requests?tab=bookings` | review web/portal bookings | accept / dismiss with reason, reclassify job type | S43 (queue) | S03 | `~` requests land as pending; no dismiss reason |
| S35 | Customer portal | `/portal/[token]` | self-service | profile edit, submit request, jobs, estimates (compare/accept/sign/deposit), invoices (pay, partial), payments, equipment, memberships, **visibility toggles** | S42 | S33, S34 | `~` read + pay (mock); no request, equipment, membership, toggles |
| S36 | Booking portal | `/book/[orgSlug]` (new; today chat/widget only) | online booking | service categories → service → slot from real capacity → details/photos → deposit → confirm; iframe embed; abandoned-session SMS recovery | S43, S44 | S35 | `~` chat books; no form-based page |
| S37 | Tech: today | `/tech/jobs` | my day | list by date, customizable job tile, clock in/out, upcoming / previous / paused | M01, M02, M08 | S36, S41 | `~` list only |
| S38 | Tech: job | `/tech/jobs/[id]` | do the work | status bar (en route → arrived → working → paused/held → done), navigate, info / files / comments / estimates / invoice tabs, **guided flow (instructions + buttons)**, forms, equipment, materials, timesheet, signature, close-out sheet | M04, M05, M09 | S37, S38 | `~` status/photos/notes/signature/materials; no en-route/arrived, no forms, no estimate/invoice |
| S39 | Tech: estimate presenter | `/tech/jobs/[id]/estimate` (new) | in-home sale | template picker, options, present, sign/accept, "do the work now" vs "book later", deposit | M07 | S39 | `×` |
| S40 | Tech: invoice + payment | `/tech/jobs/[id]/invoice` (new) | collect | items from job materials + pricebook, signature, add payment, email invoice | M04 (Create Invoice) | S40 | `×` |
| S41 | Tech: book a job / lead | `/tech/book` (new) | tech-generated work | customer search/add, job details, leave unassigned | M03 | S43 | `×` |
| S42 | AI assistant panel | admin global | NL search / create / report | chat panel over tenant data, create job from pasted text, refine notes | S49 | S44 | `~` AI insights page only |

42 target screens. 4 at parity, 27 partial, 11 missing.

## Flows

```
F01 Office books a job for a new customer (the ST call-booking loop, FP's form)
    S02 search -> (no match) inline create -> S07 form: location, job type,
    priority, summary, find availability -> pick slot -> arrival window ->
    assignees -> save -> S08
    happy path clicks: FP ~12-15, ST ~10-14, target <= 10
    edge: duplicate customer at same address (FP duplicate-dispatch checker,
    ST merge); window crosses midnight; no capacity this week; customer has
    two locations; job needs two techs; tags on customer vs location
    today: impossible, staff cannot create a job

F02 AI agent books a job (our loop, kept)
    /chat or phone -> triage -> slots from capacity -> confirm -> S06 pending
    -> auto-dispatch (shadow or live) -> S10
    happy path: 0 office clicks
    edge: after-hours; repeat customer with a new address; emergency

F03 Dispatcher assigns and moves (ST board)
    S10 tray Unassigned -> drag bubble onto tech row at time -> arrival-window
    prompt (keep / match / pick) -> confirm -> dispatch (fires on-the-way SMS)
    happy path clicks: 2-4 per job
    edge: reassign blocked when working/done; two dispatchers moving the same
    job (refresh or poll); tech off shift; skill mismatch; Dispatch Pro-style
    auto-assign inside shift extension
    today: kanban move + assign exist; no time grid or window prompt

F04 Technician works the job (ST FMA + FP ClearPath)
    S37 -> S38 en route (SMS) -> arrived -> working (clock) -> photos, forms,
    notes, materials, equipment -> S39 estimate (optional) -> S40 invoice ->
    signature -> payment -> close-out sheet: done / pause / hold / schedule
    another visit
    happy path taps: FP ~10, ST ~15-25, target <= 12
    edge: offline; required form blocks completion; other tech not done;
    skipped "working" loses job-costing time; customer not home; payment
    declined; signature immutable after invoice
    today: status/photos/notes/signature/materials; no en-route, estimate,
    invoice, payment, forms, close-out options

F05 Estimate -> sold -> work (both)
    S16 build (options, add-ons, groupings) -> S17 send dynamic link or present
    on site -> customer picks option, signs, pays deposit -> sold ->
    "do it now" (lines onto current invoice) or "book later" (S33 sold-not-booked
    -> S07 initiate booking)
    happy path clicks: ~15-25 for 3 options; target: AI-suggested lines + template
    edge: expiry; edit after send (FP locks at milestones); partial-item
    booking; change order; dismiss with reason; multiple estimates per job
    today: create + token approve + mark sold + convert; no edit, template,
    present, deposit, sold-not-booked queue

F06 Membership / maintenance agreement -> recurring visits -> billing (both)
    S14 create: plan type (duration x billing table, discounts) -> routines
    (frequency, offset, preferred tech, job template) -> billing (recurring
    invoice or one-time) -> comms (occurrence + renewal reminders) -> activate
    -> events materialise ~12 months -> S33 recurring-events tab -> bulk book
    -> S07/S10 -> renewal at expiry (auto-renew creates a new record)
    happy path clicks: FP ~30-40 (wizard), ST ~8 sell + 3-4 bulk book
    edge: overlapping routines combine into one visit; 5th weekday skip;
    editing series overwrites occurrence edits (FP bug to avoid); card retry
    D0/3/7/14; suspended; on-demand visit allowance; cannot complete until
    all jobs done and invoices paid
    today: plans + enrol + yearly visit generation; no routines, events tab,
    bulk book, recurring billing, renewal flow

F07 Invoice -> payment -> books (both)
    S19 (auto-created from job or converted from estimate) -> finalize ->
    S20 collect (card/ACH/pay link/manual) -> paid / partially paid ->
    S18 batch -> post -> export to QuickBooks (invoices, then payments)
    happy path clicks: 6-8
    edge: partial + deposit; refund; void with payments; $0 payment does not
    export; QBO throttling (batches of 3-4); locked batch; tax by location
    today: estimate->invoice, pay link (mock card), record/refund/void,
    dunning; no builder, batch, QBO push

F08 Two-way texting + automations (FP Engage, ST inbox)
    inbound SMS -> S32 thread matched to customer -> AI replies until human
    claims -> reply from chosen line -> internal note -> follow-up flag;
    automations: trigger (event + offset) -> action mode -> template
    edge: STOP; 10DLC; quiet hours; no-reply number when no two-way line;
    attach file; link thread to job
    today: SMS reply + 15 fixed triggers; no custom trigger builder, email
    threads, follow-up filter

F09 Follow-up queues (ST)
    S33 tab -> row -> call / log follow-up (template, next date) -> outcome
    (not attempted / unreachable / contacted / won / dismissed) -> initiate
    booking or dismiss with reason
    edge: estimate visibility by owner; expiring membership renew with
    adjusted start; lead from call with no booking
    today: per-customer follow-ups only

F10 Online booking portal (FP, ST Scheduling Pro)
    S36 pick service -> slot from capacity -> details + photos -> deposit ->
    confirm -> S34 review (or auto-schedule) -> S06
    edge: abandoned with contact -> recovery SMS; duplicate customer match;
    general availability vs real capacity; lead time + buffers per service
    today: chat/widget books; recovery cron exists; no form page

F11 Owner reviews the day (both dashboards)
    S01 widgets -> S26 reports (revenue, AR, close rate, scorecards) ->
    raw export with relative dates -> saved view
    edge: synced vs native money never blended (already enforced)
    today: fixed dashboard + reports; no configuration or export
```

## Components

| component | variants | states | used on |
| --- | --- | --- | --- |
| Appointment bubble / job card | 7 status colours (scheduled, confirmed, dispatched/en route, working, paused, done/hold, non-job), alert outline, multi-tech icon, configurable fields | default, hover card, dragging, dropped-invalid, locked (working/done) | S09, S10, S11, S37 |
| Status bar with time-in-status | job workflow (configurable), appointment, estimate, invoice, membership, PO, batch | current, elapsed, overdue, terminal | S08, S38, S14, S17, S19 |
| Jobs tray | tabs by status, column chooser, holding area, pop-out | empty per tab, loading, filled | S10 |
| Arrival-window prompt | keep / match / choose | — | S10 drag |
| Record shell | customer vs location vs job: header KPIs + left section nav + right details panel | loading skeleton, empty sections | S03, S04, S08 |
| Header KPI tiles | lifetime revenue, avg ticket, balance due, credit | zero, loading | S01, S03 |
| Global search | by name, phone, address, job #, invoice # | empty, truncated | all admin |
| Customer picker with inline create | search, recent, create | duplicate warning | S07, S16, S41 |
| Add-item side panel | search pricebook, category browse, add-and-next, create new line | empty catalog | S16, S19, S40 |
| Line-item table | groupings, option tabs, add-on options, eye/pen/trash, drag reorder, visibility toggles | editable, locked | S16, S19, S22 |
| Option card / presenter | good/better/best, recommended flag, savings, sign pad, deposit | selected, signed | S17, S39, S35 |
| Signature pad | finger / mouse | empty, signed (immutable) | S17, S38, S39, S40 |
| Payment sheet | card / ACH / pay link / manual (cash, check #) | processing, failed, succeeded | S20, S40, S35 |
| Payment status badge | processing / failed / succeeded / refunded | — | S18, S19, S35 |
| Find-availability panel | duration, buffers, starts-after, ends-before, techs, skills → suggested slots grouped by day | no slots | S07, S36, chat |
| Capacity cell | total vs open hours, exceeding-ideal, techs with has-required-skills | over, under | S12, S07, S36 |
| Tag chips | colour, per-entity type, visible-on-board flag | — | S02, S06, S08, S10 |
| Assignee multi-select | people + teams, skill chips, search by skill | conflict warning | S07, S08, S14 |
| Scope-of-change modal | only future / all / only past | — | S14 series edits |
| Follow-up drawer | template, next date, outcome enum, copy to notes | — | S33, S03 |
| Close-out action sheet | done / pause / hold (reason) / schedule another visit | blocked (required form, other tech) | S38 |
| Guided-flow focus view | per-status instructions, 0–10 action buttons, widgets | — | S38 |
| Notes field with AI refine | replace / add below, translate | — | all notes |
| Notes tiers | customer-visible, field (yellow), internal, comments with notify | — | S08, S38, S16 |
| Media grid | photo/video/file, markup, lightbox, team-manager visibility | empty, uploading, failed | S03, S08, S38 |
| History timeline | all / events / calls / notes / files / email, audit trail | empty | S03, S08 |
| Saved views | save as view, manage tabs | — | S06, S14, S18, S26 |
| Template import/save | job, estimate, invoice, agreement, routine, form | — | S07, S16, S19, S14 |
| Trigger row | event + offset, action mode (auto/prompt/scheduled/confirm), channel, template | active/inactive | S30 |
| Feature/plugin tile | enable/disable, gated | — | S27 |
| Dashboard widget | reorder, remove, date range | loading, empty | S01, S26 |
| Scope-of-tenant banner | "synced from FieldPulse, read-only" | — | S18, S15, S03 |

## Inferred data model

The two originals agree on the spine. Where they differ, ServiceTitan's
split is the more general one and is the target. Confidence comes from the
FieldPulse OpenAPI spec `[FP A1]` and the ServiceTitan v2 reference
`[ST #25–#36]`; both high unless noted. The right column is the delta against
`src/lib/db/schema.ts`.

```
Customer      name, type (residential|commercial), account_type, status
              (lead|opportunity|customer|lost|inactive), billing address,
              tags[], lead_source, assigned_to, do_not_service, do_not_mail,
              tax_exempt, payment_term, credit_limit, balance, parent_id
              (bill-to-parent), merged_to_id, custom fields
              evidence: FP customers, ST CRM Customer      confidence: high
              delta: + status, tags, parent_id, merged_to_id, payment_term

Contact       customer_id | location_id, name, methods[{type, value,
              do_not_text, preferences{reminders, marketing, invoice}}], order
              evidence: FP customer-contact, ST Contact/ContactMethod   high
              delta: NEW table (today: single phone/email on customer)

Location      customer_id, name, address, lat/lng, zone_id, tax_zone_id,
              access notes, is_primary, preferred_technician_id, merged_to_id
              evidence: FP locations, ST Location                     high
              delta: + zone_id FK, tax_zone_id, preferred_technician_id;
              customer_locations exists but has no UI and no job FK use

Equipment     location_id, sku_id, name, serial, barcode, manufacturer,
              model, install_date, warranties{mfr, labor}{start,end},
              predicted_replacement_date, status, parent_system_id,
              replaced_by_id
              evidence: FP assets, ST InstalledEquipment               high
              delta: + location_id (today customer_id), barcode,
              predicted_replacement, system grouping

Job           number, customer_id, location_id, job_type_id, business_unit_id
              (optional), priority, status (workflow), summary, tags[],
              campaign_id, lead_source, recall_for_id, warranty_id,
              no_charge, project_id, sold_by_id, created_from_estimate_id,
              invoice_id, membership_id, template_id, recurring_parent_id,
              hold_reason, cancel_reason, is_auto_dispatched, custom fields
              evidence: FP jobs, ST JPM Job                           high
              delta: service_requests has most; + job_type_id (configurable,
              today enum), tags, recall_for, warranty, project, template,
              recurring_parent, cancel_reason

Appointment   job_id, number, start, end, arrival_window_start/end, status
              (scheduled|confirmed|dispatched|working|paused|done|hold|
              canceled|unused), special_instructions, is_confirmed
              evidence: ST Appointment, FP visits[]                   high
              delta: NEW. Today one request = one visit. Ship as a child
              table with the request's own fields denormalised as
              appointment #1 so FP/HCP one-job-one-id sync keeps working.

Assignment    appointment_id, technician_id, status, is_paused, assigned_by,
              assigned_at
              evidence: ST AppointmentAssignment, FP assignments[]     high
              delta: NEW join table (today assignedTo on the request)

StatusEvent   entity, entity_id, from, to, actor_type, at
              evidence: ST JobHistory + Timesheet timestamps, FP time-in-status
              delta: request_status_events EXISTS; extend to appointments

StatusWorkflow org_id, entity (job|appointment|estimate|invoice|agreement),
              statuses[{name, color, kind (travel|in_progress|pause|
              complete|cancel), order, is_default}], is_default
              evidence: FP custom-status-workflows                    high
              delta: NEW (today fixed enums)

GuidedFlow    workflow_id, status_id, instructions, buttons[{action,
              label}], widgets[], required_form_ids[]
              evidence: FP ClearPath                                   high
              delta: NEW

JobType       org_id, name, default_duration, skills[], priority,
              business_units[], workflow_id, required_forms[]
              evidence: ST JobType (inferred med), FP job form        med
              delta: NEW (today enum)

Tag           org_id, type (customer|job|location|invoice|item|user), name,
              color, importance, visible_on_board
              evidence: FP tags, ST TagType                           high
              delta: NEW

Zone          org_id, name, polygon or zip list, technicians[]
              evidence: ST Zone, FP service areas                     med
              delta: NEW (today a text column)

Shift         technician_id, type (normal|on_call|time_off), start, end,
              repeat
              evidence: ST TechnicianShift                            high
              delta: technician_availability exists (weekly); + exceptions

Capacity      computed: per day × window: total hours, open hours, techs
              with skills, exceeding-ideal flag; + manual adjustment table
              evidence: ST Capacity, FP Smart Scheduler               high
              delta: capacity_reservations exists (slot counts); + per-tech
              hours model

Estimate      job_id, customer_id, location_id, name, status (draft|sent|
              accepted|dismissed|expired), options[{title, is_recommended,
              is_default, line_items[], add_ons[]}], groupings, expires_at,
              deposit_amount/percent, require_deposit_on_signature,
              sold_on/by, signed{name, ip, at}, is_change_order, template_id,
              dismiss_reason, internal_notes
              evidence: FP estimates, ST Estimate                     high
              delta: estimates/options/line_items EXIST; + groupings,
              add_ons, deposit fields, template_id, dismiss_reason, edit
              after send with lock-at-milestone

Invoice       job_id, customer_id, location_id, number, status (draft|
              open|paid|partially_paid|void|refunded), line_items[] with
              visibility flags, display settings, amount_due_display,
              expenses[], due_date, payment_term, locked_at, batch_id,
              sync_status (pending|posted|exported)
              evidence: FP invoices, ST Invoice                       high
              delta: invoices EXIST; + from-scratch/from-job creation,
              line edit, display toggles, batch_id/sync_status

Payment       invoice splits[], method (cash|check|card|ach|other), check_no,
              status, is_deposit, refunded_payment_id, batch_id
              evidence: FP payments, ST Payment                       high
              delta: payments EXIST; + splits across invoices, check_no

RecurringBilling  customer_id, agreement_id, frequency, occurrence_day,
              start, end_method, auto_send, default_status, next_at,
              payment_method_id, retry schedule (D0/3/7/14)
              evidence: FP recurring billing, ST durationBilling      high
              delta: NEW (today mocked)

MembershipType  name, duration × billing table [{duration, frequency,
              sale_price, billing_price, renewal_price}], discounts[],
              recurring_services[{type, offset, allocation}], auto_renew,
              show_savings
              evidence: ST MembershipType, FP MA templates            high
              delta: membership_plans EXISTS (flat); + billing table,
              routines

Agreement     customer_id, location_id, type_id, status (draft|active|
              suspended|expired|canceled|completed), from, to, auto_renew,
              routines[{frequency, offset, preferred_tech, job_template,
              generation_rule (none|unscheduled|auto_schedule|fixed),
              window, visit_allowance}], contract{signed}, renewal_of_id
              evidence: FP maintenance agreements, ST CustomerMembership  high
              delta: customer_memberships EXISTS; + routines, contract,
              renewal chain, suspended

ServiceEvent  agreement_id, routine_id, date, status (no_job|unscheduled|
              scheduled|completed|skipped|auto_failed), job_id
              evidence: ST RecurringServiceEvent, FP occurrences       high
              delta: membership_visits EXISTS (yearly batch); + statuses,
              12-month horizon, bulk book

PricebookItem  type (service|material|equipment), code, name, description,
              price, member_price, add_on_price, add_on_member_price, cost,
              hours, taxable, category_id, is_labor, track_inventory,
              vendor_parts[], recommendations[], upgrades[], materials[],
              markup_category_id, is_active, images[]
              evidence: FP items, ST Equipment/Service/Material        high
              delta: pricebook_items EXISTS; + add_on prices, hours,
              recommendations, category UI, CSV import

PricebookCategory  parent_id, name, display (list|gbb), position, image
              delta: EXISTS (table), no UI

FlatRateJob   category_id, labor_hours, labor_rate_id, overhead_rate,
              items[], markup_category
              evidence: FP pricebook builder                           high
              delta: NEW (optional, "could")

Discount/Fee  type, amount_type, amount, taxable
              evidence: ST DiscountAndFee                              high
              delta: NEW

TaxZone       name, rates[{name, rate}], location.tax_zone_id
              evidence: ST TaxZone, FP tax_rate                       high
              delta: tax_rates EXISTS (single default); + per-location

InventoryHub  name, type (warehouse|truck), assigned_user_id, is_default
InventoryLevel hub_id, item_id, qty, serials[]
Transfer / Adjustment / Receipt
              evidence: FP inventory hubs, ST Transfer/Adjustment      high
              delta: NEW (today qty on item, free-text location)

Supplier      name, email, phone, notes, items[]
              evidence: FP suppliers, ST Vendor                        high
              delta: NEW

PurchaseOrder  supplier_id, status (11 states), link (job|project|invoice),
              delivery_method, expected_at, received_at, items[{qty,
              qty_received, cost}], tax
              delta: purchase_orders EXIST; + supplier FK, receive flow

Timesheet     user_id, type (general|job), job_id, appointment_id, clock_in/
              out (+ method, location), dispatched_at, arrived_at, done_at,
              is_historical, code_id
              evidence: FP timesheets, ST Timesheet/TimesheetCode      high
              delta: technician_time_entries EXISTS (job only); + general,
              status timestamps, admin page

Form          org_id, name, pages[], fields[{type, required, internal,
              pulls_from}], required_for_job_types[]
FormSubmission form_id, job_id, values, signatures, photos
              evidence: FP custom forms, ST Forms (med)                med
              delta: NEW; build on custom_field_definitions

Trigger       org_id, event (job|appointment|estimate|invoice|payment
              status → X, time relative to start), offset, action_mode
              (auto|prompt|scheduled|scheduled_confirm), channel,
              template_id, active
              evidence: FP automatic triggers, ST notifications        high
              delta: communication_templates EXIST (15 fixed trigger
              types); + user-defined trigger rows

Thread / Message  customer_id, channel (sms|chat|call|voicemail|email),
              line_id, direction, body, internal_note, follow_up, linked
              entity, ai_summary
              evidence: FP Engage, ST inbox                            high
              delta: customer_threads + messages EXIST; + email, follow-up
              flag, link

FollowUp      entity (estimate|agreement|lead|booking), entity_id, status
              (not_attempted|unreachable|contacted|won|dismissed), next_at,
              template_id, notes
              evidence: ST Follow Up hub                               high
              delta: follow_ups EXISTS (customer-level); + entity link +
              outcome enum

Lead          customer_id?, location_id?, source, call_id, booking_id,
              status, priority, follow_up_at, dismiss_reason
              evidence: ST Lead, FP customer status=lead               high
              delta: NEW (today a pending request or an abandoned session)

Booking       source (web|portal|google|chat|voice), payload, status
              (pending|accepted|dismissed), dismiss_reason, job_id
              evidence: ST Booking, FP booking portal                  high
              delta: service_requests with status pending cover most;
              + dismiss_reason, source enum

Campaign      name, category, source, medium, tracking_numbers[], costs[]
              evidence: ST Campaign/CampaignCost, FP lead sources      high
              delta: NEW (today lead_source enum)

BusinessUnit  name, trade, invoice header, default tax, QB class
              evidence: ST BusinessUnit                                high
              delta: NEW, optional single-row default ("could")

Role / Permission  role, permissions[], per-user overrides, schedule
              visibility
              evidence: FP user roles (5 + matrix), ST Employee.permissions
              delta: 3 roles today; + dispatcher/office roles + toggles

Batch         period, status (pending|posted|exported), invoices[],
              payments[], exported_at
              evidence: ST Accounting batch                            high
              delta: NEW (accounting export exists, unbatched)

PortalSettings  ~20 visibility toggles, password protect
              evidence: FP customer portal                             high
              delta: NEW jsonb on organization_settings

BookingService  category, name, duration, buffers, lead_time, eligible
              techs, skills, windows[], deposit rule, items[]
              evidence: FP booking portal, ST Scheduling Pro           high
              delta: NEW

Feature flags  org_id, feature, enabled
              evidence: FP Features & Plugins                          high
              delta: NEW (entitlements exist for SaaS billing; reuse)
```

Relationships: Customer 1–n Location, Contact, Agreement, Invoice, Payment;
Location 1–n Job, Equipment, RecurringService, Contact; Job 1–n Appointment,
Estimate, Timesheet, FormSubmission, Media; Job 1–1 Invoice (ST) or 1–n (FP);
Appointment n–m Technician via Assignment; Agreement 1–n Routine 1–n
ServiceEvent 0–1 Job; Invoice 1–n Payment (via splits); PricebookItem n–m
Category; Hub 1–n InventoryLevel; Thread 1–n Message; Trigger n–1 Template.

Guesses: ST Invoice/Service/Material field lists were not visible in the
fetch window (inferred from Equipment and EstimateItem); ST Zone fields; ST
Form structure; FP GET response shapes beyond POST bodies.

## Feature matrix

See `features.csv` (merged and deduped from 162 FieldPulse + 264
ServiceTitan rows; `clone` filled from `app-inventory.md`). Run
`python3 .claude/skills/replica-diff/parity.py replica/features.csv` for the
live score; the counts and the first score are recorded in
`replica/parity.md` once the matrix is scored.

## Out of scope (cannot or should not be cloned)

- **Payment processing rails**: FieldPulse Payments and ServiceTitan Payments
  (merchant underwriting, next-day funding, Tap to Pay entitlement, certified
  card readers, chargebacks). Clone with Stripe (Payment Links + Terminal);
  the provider seam already exists as a mock.
- **Carrier telephony**: Engage / Contact Center Pro number porting, SIP desk
  phones, call tracking pools, 10DLC registration. Twilio is already in the
  stack; 10DLC is a business task, not code.
- **Consumer financing**: Wisetack / Acorn / GreenSky / Service Finance lender
  contracts. Keep the mock lender seam; link-out only.
- **Cross-tenant ML**: ServiceTitan's Job Value Predictor, Regional Pricing
  Averages, Smart Recommendations, Pricebook Pro's licensed content library.
  Per-tenant heuristics and our own LLM over tenant data only.
- **Fleet hardware**: Azuga / Surfsight GPS and dashcams. Accept GPS pings
  from a provider API; the opt-in phone location we have is the small-shop
  answer.
- **Partner feeds and marketplaces**: Angi, Thumbtack, Google LSA / Reserve
  with Google, supplier catalogs (Reece, Winsupply), Homh, Zapier listing.
- **QuickBooks certification maturity**: buildable (QBO OAuth + API), but the
  Intuit listing, QB Desktop Web Connector and two-week initial-sync tooling
  are not. Start with QBO invoices + payments push, keep the CSV/IIF export.
- **Native iOS/Android apps with full offline**: FieldPulse caches a week and
  50 photos; ServiceTitan's app is its worst-reviewed surface. Stay mobile
  web with autosave and a retry queue; no app-store build in this pass.
- **Multi-business-unit permission matrix, franchise roll-ups, payroll as
  system of record, Intacct**: enterprise back office the prior plan
  already deferred; export hours to a payroll provider instead.

## Size

Screens 42 (4 parity, 27 partial, 11 missing), flows 11, entities ~45 (of
which ~20 new tables, ~15 extended). Hard parts:

1. **Job ≠ Appointment with assignments as a join table**, without breaking
   the one-job-one-external-id FieldPulse/HCP sync.
2. **The dispatch board as a time grid** with status-coloured bubbles, a
   tabbed jobs tray, the arrival-window prompt and a reassign guard, on top
   of the dnd-kit calendar we have.
3. **Configurable status workflows + guided tech flows** replacing two fixed
   enums that the AI intake, triggers, KPIs and FP status map all read.
4. **Agreements with routines → materialised service events → bulk booking →
   recurring billing** (idempotent, 12-month horizon, retry schedule).
5. **Estimate/invoice builder with edit-after-send and lock-at-milestone**,
   shared by admin and the tech app, with deposits and real card payments.
6. **Tech app close-out loop** (en route → arrived → working → forms →
   estimate → invoice → payment → close-out sheet) with offline-tolerant
   autosave.
7. **Capacity model** (per-tech hours × windows × skills) feeding the office
   form, the booking portal and the AI agent from one function.

Size: **XL as a whole; L per loop.** Rescope into loops and ship them in the
order `replica-architect` sets: office booking + job record first (the loop
that is impossible today), then the dispatch board, then the tech close-out
loop, then agreements + recurring billing, then estimates/invoices builder,
then follow-up hub + automations, then portals and reporting polish.
