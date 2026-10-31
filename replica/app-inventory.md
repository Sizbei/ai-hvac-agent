# ai-hvac-agent feature inventory (read-only audit)

Sources: all 31 `.claude/skills/page-*` + `admin-pages`, README, docs/INTEGRATIONS, INVOICES, DISPATCH, GUIDE, `src/lib/db/schema.ts`, route lists, plus targeted code greps. Status: yes / partial / no. "no" = not found in code or docs (absence of evidence after targeted grep, not proof).

Global facts: Next.js 16, Drizzle, Neon (neon-http, no transactions). Roles: super_admin > admin > technician (plus an env-var platform-admin tier). PII encrypted at rest (AES-256-GCM). Single "business timezone" (America/New_York) hardcoded via `BUSINESS_BASE_LOCATION`. Mock-first provider seams: payments, financing, SaaS billing, vendor ordering, accounting all return deterministic MOCKs.

## 1. Intake

| capability | status | where | notes |
|---|---|---|---|
| Web chat AI intake | yes | `/chat`, `/api/chat`, `/api/session*`, `src/lib/ai/` | Deterministic router + KB (~70% turns zero-LLM), Qwen fallback, streaming with guarded-flush safety layer |
| Embeddable widget | yes | `/embed`, `/api/widget/config`, `/api/admin/widget-keys`, `src/lib/widget/` | Publishable `pk_live_` keys, allowed origins, branding/launcher position in settings Embed tab |
| Voice (phone) AI agent | yes | `/api/voice/incoming|gather|dial-status|tts`, `src/lib/ai/voice-turn.ts` | Twilio, ElevenLabs TTS (Polly fallback), transfer number, ANI identity, do-not-service, chat parity |
| SMS AI intake (inbound text) | yes | `/api/sms/incoming` | Bot replies via voice-turn core; STOP/START/HELP keywords; human takeover sets `mode=human` |
| Online scheduling / booking with real open slots | partial | `/api/availability`, `src/lib/admin/availability-queries.ts`, `capacityReservations`, `/api/session/confirm` | Offers morning/afternoon/evening bands from tech availability minus booked; reserves a window. Bands only, no exact-time slot picker; no standalone public booking page (only via chat/widget) |
| Customer self-reschedule/cancel | partial | chat `account-data-*` intents (`src/lib/ai/account-verify.ts`), `/api/admin/customers/[id]/bookings` | Via chat with ZIP-verify gate; portal itself has no reschedule |
| Safety triage / emergency escalation | yes | `src/lib/ai/` triage, output-guardrail, escalate `/api/session/escalate` | Gas/CO/flooding screen first; FROZEN regex guardrails; dangerous-DIY backstop |
| Structured intake fields (ServiceTitan-style) | yes | `service_requests` cols, docs/INTAKE-FIELDS.md | job type, system type, brand, age band, warranty, access notes, preferred window, lead source, contact pref, SMS consent |
| Photo upload at intake | yes | `/api/upload` (R2/S3, magic-byte check) | |
| After-hours handling | yes | settings After-hours tab, `afterHoursConfig`, `isAfterHours` | |
| Missed-booking recovery | yes | `/api/cron/booking-recovery`, `src/lib/communication/booking-recovery.ts` | Also backfills geocodes |
| Returning-customer recognition | yes | blind-index hashes, `upsertCustomerByContact`, `/api/chat/history` | |
| Admin-created request (manual job entry) | no | no `POST /api/admin/requests`; routes are GET + `[id]` PATCH/POST(note) only | Staff cannot create a job from admin UI; jobs come from chat/voice/SMS/booking or FP/HCP sync |
| Custom FAQ / KB answers | yes | settings "Custom Q&A" tab, `/api/admin/settings/faqs` | |
| Escalate to human / human reply | yes | `/admin/conversations`, `/api/admin/conversations/[id]/message` | SMS only for reply |

## 2. CRM

| capability | status | where | notes |
|---|---|---|---|
| Customer directory (search, filters, card/list) | yes | `/admin/customers`, `/api/admin/customers` | Server-paginated 50; filters property type, customer type, membership, FP-synced, archived; URL-synced |
| Customer profile page | yes | `/admin/customers/[id]` | bookings, equipment, memberships, estimates, invoices, notes, follow-ups |
| Create / edit customer | yes | `/api/admin/customers` POST, `[id]` POST/PATCH-style, `customer-form-dialog` | 409 on native contact clash |
| Multiple service locations per customer | partial | `customer_locations` table (label, zone, propertyType, accessNotes); `service_requests.locationId` | ARCHITECTURE.md calls it a "soft split"; no dedicated locations management UI found; geocode cache is primary use |
| Equipment / asset registry | yes | `customer_equipment`, `equipment-form-dialog.tsx`, `crm-equipment-queries.ts` | type, make, model, serial, install date, warranty (parts + labor), replaced-by, retired; FP assets imported. No QR/barcode |
| Customer notes | yes | `customer_notes` (general/follow_up/complaint/compliment), `note-form-dialog.tsx` | |
| Follow-ups / reminders | yes | `follow_ups`, `follow-up-form-dialog.tsx` | no dedicated cross-customer follow-up queue page found |
| Service history | partial | `service_history` table is EMPTY org-wide; real history = `service_requests` via `CustomerBookingsSection` | |
| Custom fields | partial | `custom_field_definitions/values`, `/api/admin/custom-fields*`, `/api/admin/custom-field-values*`, shown in `customers/[id]/page.tsx` | 8 field types, customer/request scope. No definition-management page located in admin nav; request-level display unverified |
| Dedupe on create | yes | HMAC email/phone blind index, per-org unique (native rows), `pickCustomerMatch` | |
| Merge duplicate customers | no | none found | Shared-contact FP customers deliberately kept as separate rows |
| Archive / reactivate | yes | `archivedAt`, customers detail | auto-reactivates on re-contact |
| Hard delete | yes | `DELETE /api/admin/customers/[id]` | super_admin only |
| GDPR erase | yes | `POST /api/admin/customers/[id]/erase` (+GET sibling disclosure) | super_admin, anonymizes row, keeps financials; per-row only |
| Do-not-service flag | yes | customer match order, voice/chat gate | |
| Customer types / lead source | yes | `customer_type`, `lead_source` enums | |
| Customer portal | partial | `/portal/[token]`, `/api/portal/[token]/pay`, `/api/admin/customers/[id]/portal-token` | Tokenized, no login: invoices, estimates, upcoming jobs, history, pay balance (MOCK payment). No self-booking, no profile edit, no equipment/membership view |
| Data export | yes | `/api/admin/export`, `/api/platform/organizations/[id]/export` | |
| Global search | partial | `/api/admin/search`, `global-search.tsx` | Customer scan truncated at `SCAN_LIMIT_CUSTOMERS` (known gap) |
| Customer tags/segments | no | none native (FP tags only in jsonb) | |

## 3. Requests / Jobs

| capability | status | where | notes |
|---|---|---|---|
| Request list with filters/sort/pager | yes | `/admin/requests`, `/api/admin/requests` | status, urgency, technician, after-hours, ref search; polls 10s |
| Request statuses | yes | enum `pending, assigned, scheduled, in_progress, on_hold, completed, cancelled` | no "en route"/"arrived" status (trigger types exist for technician_enroute/arrived) |
| Status change by admin | yes | `PATCH /api/admin/requests/[id]` | manual target statuses |
| Status event log / timeline | yes | `request_status_events`, `/api/tech/jobs/[id]/timeline`, `request-detail-sheet.tsx` | used by Operations response-time KPI |
| Job types | yes | enum `service_call, no_heat, no_cool, maintenance, install, estimate, warranty, diagnostic, inspection` | fixed enum, not org-configurable |
| Tags | no | none native | `disabledServiceTags` only scopes the bot |
| Assignment | yes | `POST /api/admin/requests/[id]/assign`, detail sheet | override telemetry captured |
| Reschedule / unschedule | yes | `/api/admin/requests/[id]/reschedule|unschedule`, calendar drag | |
| Hold with reason + follow-up date | yes | `hold_reason` enum (awaiting_parts/customer/access/weather/other), `followUpDate` | |
| Notes on request | yes | `request_notes`, `POST /api/admin/requests/[id]` | tech notes via `/api/tech/jobs/[id]/note` |
| Attachments / photos | yes | `attachments`, `attachments-section.tsx`, `/api/admin/attachments*`, R2 | per request/equipment/customer |
| Signature capture | yes | `service_requests.signatureUrl/Name/signedAt`, `/api/tech/jobs/[id]/signature` | |
| Job duration estimate | yes | `estimatedDurationMinutes/Source` | |
| Urgency levels | yes | low/medium/high/emergency | |
| Recurring jobs | partial | membership visits generate jobs only | no generic recurring-job series |
| Multi-visit / multi-day jobs, sub-jobs | no | none (FP `is_multiday_job` stored read-only) | |
| Job checklists / forms | no | none | |
| Job cost / margin on job | partial | `job_materials` cost+price snapshot, time entries labor cost, `rollUpMargin` on estimate detail | no job-costing report page |
| Dashboard | yes | `/admin` | KPI stat cards, today schedule, needs-attention, awaiting follow-up, overdue invoices, onboarding checklist |

## 4. Scheduling & Dispatch

| capability | status | where | notes |
|---|---|---|---|
| Calendar day/week with drag-drop | yes | `/admin/calendar`, dnd-kit, `interactive-scheduling-calendar.tsx` | technician lanes, conflict dialog, optimistic rollback |
| Month and agenda views | yes | `month-grid.tsx`, `agenda-view.tsx`, `/api/admin/agenda` | |
| Unscheduled-jobs panel | yes | `unscheduled-panel.tsx`, `/api/admin/calendar/unscheduled-count` | |
| Dispatch board (kanban per technician) | yes | `/admin/dispatch`, `/api/admin/dispatch` | active technicians + unassigned pile |
| Dispatch map | yes | `/admin/map`, `/api/admin/dispatch/map` | Apple MapKit (env-gated, inert w/o creds) + MapLibre fallback; tech pins (opt-in), request pins, service radius, AR "money owed" layer; capped at 25 geocoded requests |
| Suggested technician scoring | yes | `/api/admin/dispatch/suggest/[id]`, `src/lib/ai/dispatch/` | skills proxy, travel (ORS optional), load, rating, chain-aware origin, duration-fit |
| Confidence-gated auto-dispatch | yes | `autoDispatchEnabled`, `dispatch_decisions`, `/api/admin/requests/[id]/decision` | shadow mode, exceptions rail, override telemetry, weekly digest cron |
| Arrival windows | yes | `arrivalWindowStart/End`, `ARRIVAL_WINDOWS`, `capacity_reservations` | named bands (morning/afternoon/evening), no custom window length |
| Technician availability (weekly hours) | partial | `technician_availability`, `availability-queries.ts`, FP availability sync cron | Consumed by scheduling/booking; no admin UI or API to edit hours found (set via seed/FP sync) |
| Capacity limits | partial | `capacity_reservations` (day, window, slotOrdinal) | slot-count reservation; no per-tech or per-job-type capacity config UI |
| Service zones / territories | partial | `customer_locations.zone` column; 50 km base radius `BUSINESS_BASE_LOCATION` | no zone-based assignment/routing found |
| Technician skills / certifications matrix | no | proxy via `skillJobsCompleted` (DISPATCH.md lists as roadmap) | |
| Route optimization / drive-time | partial | OpenRouteService adapter (`ROUTING_PROVIDER`) feeds travel score | no multi-stop route optimizer |
| Delay / behind-schedule alerts | yes | `/api/cron/delay-sweep` | SMS alerts (daily cron on Hobby) |
| Google Calendar sync | yes | `/api/admin/integrations/google*`, `src/lib/integrations/google-calendar`, settings tab | OAuth, two-way event sync (OAuth-gated; live-verification not documented) |
| Real-time tech GPS tracking | partial | `technician_locations`, `/api/tech/location`, consent endpoint, map | opt-in, request-linked captures; not continuous live tracking, no customer-facing ETA link |
| Customer ETA notifications | partial | `technician_enroute` / `technician_arrived` trigger types and templates | no confirmed en-route trigger action in tech UI (status flow lacks en-route) |

## 5. Technician app (/tech)

| capability | status | where | notes |
|---|---|---|---|
| Separate tech login (password + Google) | yes | `/tech-login`, `/api/auth/tech/login|logout` | `hvac_tech_session` JWT, CSRF guarded |
| Assigned job list | yes | `/tech/jobs`, `/api/tech/jobs` | assignee + tenant scoped |
| Job detail | yes | `/tech/jobs/[id]`, `tech-job-detail-client.tsx` | |
| Status flow | yes | `/api/tech/jobs/[id]/status` | scheduled / in_progress / on_hold / completed / cancelled; terminal ones need confirm |
| Photos | yes | `/api/tech/jobs/[id]/photo` -> R2 `attachments` | |
| Notes | yes | `/api/tech/jobs/[id]/note` | |
| Customer signature | yes | `/api/tech/jobs/[id]/signature` | data-URI blob |
| Materials used (from pricebook) | yes | `/api/tech/jobs/[id]/materials`, `/api/tech/pricebook` | cost/price snapshotted server-side |
| Timesheet (clock in/out per job) | partial | `technician_time_entries`, `/api/tech/jobs/[id]/timesheet`, `timesheet-queries.ts` | per-job entries with labor rate; no admin timesheet/payroll page; labor cost only in accounting export + reports |
| Location sharing with consent | yes | `tech-location-tracker.tsx`, `/api/tech/location`, `/consent` | |
| Build estimate / quote on site | no | tech has no estimate API | admin-only estimates |
| Take payment / generate invoice on site | no | none under `/api/tech` | |
| View customer equipment history on site | partial | job detail summary only; equipment registry not exposed in tech routes | unverified |
| Offline mode / PWA | no | none found | |
| Native mobile app | no | web only (mobile-first, 44px targets) | |
| Tech pricebook lookup | yes | `/api/tech/pricebook` | |

## 6. Estimates

| capability | status | where | notes |
|---|---|---|---|
| Estimate builder | yes | `estimate-create-dialog.tsx`, `POST /api/admin/estimates` | 1-10 options, catalog or manual lines, qty/price caps, server-derived tax |
| Good / better / best options | yes | `estimate_options`, `estimate_line_items` | customer picks one option |
| Member pricing in estimate | yes | `useMemberPrice`, `pricebook_items.memberPriceCents` | |
| AI line-item suggestions | yes | `/api/admin/estimates/suggest`, `src/lib/ai/estimate-suggester.ts` | suggestions only |
| Estimate templates / reusable packages | no | none found | |
| Edit estimate after creation | no | `[id]` PATCH only marks sold; no line edit | recreate instead |
| Send to customer | partial | `sendToCustomer` -> `triggerEstimateSent` (consent-gated comms queue) | SMS template confirmed; email path depends on template/contact (unverified) |
| Customer approval via token + e-sign | yes | `/estimates/[token]`, `/api/estimates/approve` | signature name/IP, expiry, SHA-256 token; regenerate-link supported |
| Mark sold / dismiss / expire | yes | `PATCH /api/admin/estimates/[id]`, lazy-expiry sweep in list GET | no cron (list fetch triggers) |
| Convert to invoice | yes | `POST /api/admin/invoices {estimateId}` | idempotent |
| Estimate follow-ups | partial | "Log follow-up" link -> customer `follow_ups` | no automated stale-estimate nudges found |
| Pipeline KPIs | yes | `/admin/estimates` | open/stale/won/lost $, win rate, avg open age |
| Margin display | yes | `src/lib/admin/margin.ts` | admin only |
| Deposits on estimate approval | no | `payments.isDeposit` exists on invoice payments only | |
| Financing offer on estimate | partial | `financing-panel.tsx`, `/api/admin/financing`, `/api/financing/webhook`, `financing_applications` | MOCK lender provider; no real Wisetack/GreenSky |
| FieldPulse estimate mirror | yes | `estimates.fieldpulseEstimateId`, import phase `estimates` | read-only in UI |

## 7. Invoices & Payments

| capability | status | where | notes |
|---|---|---|---|
| Invoice document / detail | yes | `/admin/invoices/[id]`, `invoice-document.tsx` | |
| Manual invoice builder (from scratch / from job) | no | `POST /api/admin/invoices` requires `estimateId` | only path to a native invoice is estimate -> invoice; no line editing UI |
| Line items, tax | yes | `invoice_line_items`, `tax_rates` (default rate), subtotal/tax/total | single default tax rate applied; no per-line/jurisdiction tax engine |
| Invoice states | yes | draft / open / paid / void / refunded | |
| Send invoice to customer | partial | pay-link + reminder SMS; portal lists invoices | no explicit "email/send invoice" action found; email reminders not built (INVOICES.md deferred) |
| Pay link | yes | `POST /api/admin/invoices/[id]/pay-link`, `/portal/[token]` | |
| Online card payment | partial | `/api/portal/[token]/pay`, `src/lib/payments/provider.ts` | MOCK provider; Stripe adapter not built |
| Record payment | yes | `POST /api/admin/invoices/[id]/payments` | CAS/atomic, partial payments, deposit flag; method set limited by provider seam (no check/cash method tracking confirmed) |
| Refund | yes | `POST /api/admin/payments/[id]/refund` | super_admin; over-refund CAS guard |
| Void | yes | `POST /api/admin/invoices/[id]/void` | blocked with payments / synced |
| Reminders (manual) | yes | `send-reminder` route, 6h cooldown | SMS only |
| Automated dunning | yes | `/api/cron/dunning` | one `invoice_overdue` reminder per 7-day bucket, consent-gated |
| Payment receipt | yes | `triggerPaymentReceipt` | |
| Reconcile payments | yes | `/api/cron/reconcile-payments`, `/api/admin/payments/reconcile`, ReconcileBanner | |
| Collections workspace + AR aging | yes | `/admin/invoices`, `/admin/operations` | overdue-first, summary band, filters by source/amount/unreminded |
| Financing | partial | see Estimates | MOCK |
| Accounting export | partial | `/admin/accounting`, `/api/admin/accounting/export`, `accounting-provider.ts` | CSV/IIF download of invoices, payments, refunds, labor; super_admin; no QuickBooks Online push (adapter not built) |
| Multi-source invoices (FP/HCP mirror) | yes | `fieldpulse_invoice_id`, `hcp_invoice_id`, crons | read-only mirrors, money-grade |
| Recurring/automatic membership invoicing | no | memberships "recurring billing is mocked in v1" (schema comment) | |
| Late fees, payment plans, batch invoicing | no | none | |
| Bulk actions (bulk chase) | no | INVOICES.md deferred | |
| Inline record payment from list | no | INVOICES.md deferred | |
| Org mailing address on invoice | no | INVOICES.md deferred | |

## 8. Pricebook

| capability | status | where | notes |
|---|---|---|---|
| Items (service/material/equipment) | yes | `/admin/pricebook`, `pricebook_items`, `/api/admin/pricebook*` | 17.5k items, server-paginated, soft delete |
| Categories | partial | `pricebook_categories` (tree) table | no category management UI found |
| Member price | yes | `memberPriceCents` | |
| Labor-item flag | yes | `isLaborItem` filter | |
| Cost / margin | yes | unit cost + price | |
| Tax rates | yes | `tax-rates-panel.tsx`, `/api/admin/pricebook/tax-rates*` | default rate drives estimates |
| Bundles / item materials | partial | `pricebook_item_materials` table | no bundle UI confirmed |
| Import | partial | FieldPulse `items` import phase (nightly) | no CSV/spreadsheet import UI found |
| Search / filter / sort | yes | q, type, sort, inactive, labor filters, `/` shortcut | |
| Flat-rate price books by tier/region | no | none | |
| Push edits back to FieldPulse | no | edits local only | |

## 9. Inventory & Purchasing

| capability | status | where | notes |
|---|---|---|---|
| Stock items linked to pricebook materials | yes | `/admin/inventory`, `inventory_items` | qty on hand, reorder point, unit cost, location (free text) |
| Below-reorder filter | yes | URL-synced `belowReorder` | |
| Purchase orders | partial | `purchase_orders`, `po_line_items`, `/api/admin/inventory/purchase-orders*`, `purchase-orders-panel.tsx` | statuses draft/ordered/received/cancelled; vendor submission is a no-op MOCK |
| Auto-decrement stock on job materials | no | `field-queries.ts` has no `quantityOnHand` writes (grep) | unverified end-to-end; job_materials not tied to inventory |
| Multi-warehouse / truck stock / transfers | no | single `location` text only | |
| Job materials | yes | `job_materials` + tech materials API | cost/price snapshot |
| Vendors / supplier catalog | no | no vendors table | |

## 10. Memberships / maintenance plans

| capability | status | where | notes |
|---|---|---|---|
| Plan catalog | yes | `/admin/membership-plans`, `membership_plans` | price, monthly/annual, visits/year, benefits JSONB; soft-deactivate/reactivate |
| Enrol / cancel customer | yes | `/api/admin/customers/[id]/membership` (GET/POST/DELETE), `customer-membership-card.tsx` | derived `customers.membershipStatus` cache updated atomically |
| Visit generation | yes | `/api/cron/generate-membership-visits`, `membership_visits` | creates service requests; `visitsPerYear=0` skipped |
| Member pricing | yes | pricebook `memberPriceCents` | |
| Recurring billing of plan fee | no | `providerSubscriptionId` placeholder, billing mocked | |
| Renewal / expiry reminders | partial | `warranty_expiring` trigger exists; no membership-renewal trigger | |
| Membership reporting (MRR, churn) | no | none | |
| Contract / agreement document | no | none | |

## 11. Communications

| capability | status | where | notes |
|---|---|---|---|
| Template manager (SMS / email html / email text) | yes | `/admin/communications/templates`, `communication_templates` | 15 trigger types, priority, activate/deactivate, delete blocked if history |
| Triggered automation | yes | `communication_jobs`, `/api/cron/process-communications` (daily drain), `triggers.ts` | confirmations, reminders 24h/2h, reschedule, cancel, en-route, arrived, completed, review, follow-up, estimate sent, receipt, overdue, warranty |
| SMS send | yes | `twilio-adapter.ts`, `/api/communications/send` | |
| Email send | yes | `resend-adapter.ts`, `/api/webhooks/resend` | delivery webhook |
| Two-way inbox | partial | `/admin/conversations`, `/api/admin/conversations/[id]/message` | chat/SMS/phone threads; staff reply SMS only; no polling; no email thread, no unified customer timeline thread UI (`customer_threads` table exists) |
| Delivery outcomes | partial | `/api/admin/communications/outcomes` | API only; no UI page found |
| Consent / opt-out | yes | `communication_preferences`, `consent.ts`, STOP/START | do-not-contact |
| Quiet hours | yes | 21:00-08:00 customer-local for non-transactional | |
| Outbound dedupe ledger | yes | `outbound_message_ledger` | |
| Review requests | yes | auto on completion, `review_requests`, `/review/[token]`, `/admin/reviews` | no sentiment gating (compliance); read-only dashboard; no review-site sync |
| Marketing campaigns / bulk SMS / email blasts | no | none (warranty nudge only) | |
| Call recording / call log | partial | phone sessions appear in conversations | no recordings UI |
| Customer notification preferences UI | partial | `contactPreference` on request | |

## 12. Reporting & Insights

| capability | status | where | notes |
|---|---|---|---|
| Reports (revenue, AR, close rate, lead-source ROI, location, tech scorecards) | yes | `/admin/reports`, `reporting-queries.ts` | 30/90/365d presets; revenue = billed, synced collected included |
| Operations KPIs | yes | `/admin/operations` | response time, time-to-paid, jobs booked, dispatcher first response, dispatch health, AR aging, period-over-period trends |
| AI assistant analytics | yes | `/admin/insights`, `/api/admin/ai-insights|bot-analytics|ops-insights` | deflection, outcomes, tokens; all-time not windowed |
| Technician scorecards | yes | reports | |
| Lead-source ROI | yes | reports | |
| Revenue forecasting | partial | `src/lib/forecasting/`, tables `demand_daily`, `revenue_daily`, `forecast_snapshots`, `forecast_accuracy` | computation + tables exist; not wired to any page/route found |
| Custom report builder / scheduled reports / CSV export of reports | no | none | |
| Call tracking / marketing attribution | partial | `leadSource` enum only | |
| Job costing / profitability report | no | none (margin on estimate detail only) | |
| Payroll / commission reports | no | none | |
| Customer satisfaction | partial | `/admin/reviews` avg rating, response rate | |

## 13. Team & settings

| capability | status | where | notes |
|---|---|---|---|
| Staff roster | yes | `/admin/staff` (`/admin/technicians` redirects) | edit, role change, deactivate, self-protection |
| Roles | partial | `super_admin`, `admin`, `technician` | no dispatcher/office/custom roles or granular permissions |
| Invites | yes | `/api/admin/invites*`, `/admin/invite/[token]` | hashed, 72h, single-use, revocable, admin/technician only |
| Password reset by admin | yes | `/api/admin/staff/[id]/reset-password` | no self-serve email reset (documented) |
| Last-admin guard | yes | DB trigger `0044_last_admin_guard.sql` | |
| Technician profile (labor rate, FP/HCP ids) | yes | `/api/admin/technicians/[id]`, `users.laborRateCents` | |
| Org settings (9 tabs) | yes | `/admin/settings` | branding, services, business info, custom Q&A, embed/keys, limits, after-hours, dispatch, integrations |
| Widget keys | yes | settings Embed tab, `/api/admin/widget-keys*` | |
| AI model selection | yes | `/api/admin/ai/model|test`, AiModelPanel | super_admin |
| SaaS billing (org subscription) | partial | `/admin/settings/billing`, `/api/platform/billing`, `/api/webhooks/saas-billing`, `src/lib/billing/` | entitlements/plan model exist; Stripe adapter is MOCK |
| Platform/super-admin console | yes | `/admin/platform`, `/api/platform/organizations*` | env-var gated; provision org + owner invite, purge, export |
| Multi-tenant org signup | yes | `/signup`, `/api/auth/signup/*` | |
| Onboarding checklist | yes | dashboard + `/api/admin/onboarding` | |
| Multi-branch / multi-location business units | no | single org = single business | |
| Business hours / holidays config | partial | `businessInfo`, `afterHoursConfig` | not a full holiday calendar |
| Auth: Google OIDC + password | yes | `/admin/login`, `/api/auth/google/*` | |
| SSO/SAML, MFA | no | none found | |

## 14. Integrations

| capability | status | where | notes |
|---|---|---|---|
| FieldPulse | yes | `/admin/integrations`, `/admin/fieldpulse-import`, `src/lib/integrations/fieldpulse/`, webhooks, nightly import | 11-phase full import (techs, customers, jobs, invoices, estimates, payments, assets, comments, locations, items, job-metrics); money-grade invoice mirror; availability sync. READ path live-verified; WRITE paths (create job/customer) NOT live-verified; synced records read-only |
| Housecall Pro | partial | `src/lib/integrations/housecall-pro/`, `/api/webhooks/housecall`, cron | built on inferred API shapes, key-blocked, UNVERIFIED against live API |
| Google Calendar | yes | see Scheduling | |
| QuickBooks | partial | accounting CSV/IIF export only | no QBO OAuth/API adapter |
| Twilio (SMS + voice) | yes | webhooks signed, adapters | |
| Resend (email) | yes | adapter + webhook | |
| Payments (Stripe etc.) | no | MOCK provider only | `STRIPE_SECRET_KEY` present still returns mock |
| Consumer financing | partial | MOCK provider | |
| Vendor/supplier ordering | partial | MOCK no-op | |
| Mapping/geocoding | yes | Apple MapKit (optional), MapLibre, Photon autocomplete, Nominatim backfill, ORS routing (optional) | |
| Storage | yes | R2/S3 uploads | |
| Public API / outbound webhooks for customers | no | only inbound webhooks | |
| Zapier / marketplace | no | none | |
| Analytics | yes | Vercel Analytics (token path masked), Sentry dep | |

## 15. Audit & security

| capability | status | where | notes |
|---|---|---|---|
| Audit log | yes | `/admin/audit-log`, `audit_log`, `logAudit` | filter by action/entity, 50/page; details field names/ids only (no PII) |
| Platform audit log | yes | `platform_audit_log` | survives org purge |
| Tenancy scoping | yes | `withTenant`, session `organizationId` on every query | |
| PII encryption at rest | yes | AES-256-GCM, blind-index hashes | |
| CSRF / same-origin guard | yes | `src/lib/session-csrf.ts` | on auth + session POSTs |
| Rate limiting | yes | `src/lib/rate-limit.ts` sliding window, `RATE_LIMITS` | in-memory (per-instance) |
| Webhook signature + idempotency | yes | Twilio sig, FP/HCP HMAC + replay guard, `*_webhook_events` | |
| Token hashing | yes | SHA-256 for invites, portal, estimates, reviews | |
| Cron auth | yes | `CRON_SECRET` bearer, timing-safe | |
| Role gates for destructive ops | yes | `isSuperAdmin` on erase/delete/refund/credentials/export | |
| Demo-account guards | yes | `isDemoAccount` blocks outbound SMS/erase | |
| Output guardrails for AI | yes | FROZEN regexes | |
| Health probe | yes | `/api/health` | |
| Field-level change history (per-record versioning) | no | audit is action-level | |

## Known gaps and half-built items (from skill/doc notes)

- Payments, financing, SaaS billing, vendor ordering, accounting: all MOCK provider seams; no live Stripe, no lender, no QBO push. `/api/portal/[token]/pay` "is a mock payment path - not production billing."
- Housecall Pro integration unverified against the live API; FieldPulse WRITE paths and availability not live-verified.
- No admin-side manual request creation; no manual/standalone invoice builder (invoices only from estimates); no estimate editing or templates.
- Invoice roadmap deferred: email reminders, bulk chase, inline record payment from list, structured org address; "collected this month" uses UTC month boundary.
- Technician availability has no admin editing UI/API found; zones are a column only; skills matrix is a history proxy (DISPATCH.md roadmap); Phase 4/5 dispatch data-gated; confidence-gate weights provisional.
- `service_history` table is empty org-wide (real history is `service_requests`).
- Global search customer scan truncates at `SCAN_LIMIT_CUSTOMERS` (known, unfixed).
- AI insights and ops-insights counts are all-time (no date filter / period delta).
- Calendar/dispatch: delay-sweep and process-communications run only daily on Vercel Hobby, so reminders/alerts are coarse; estimate expiry is lazy (triggered by list fetch).
- Map caps at 25 geocoded requests; Apple map inert until Apple creds set; no polling.
- Forecasting module and tables are built but not surfaced in UI.
- Conversation inbox: no polling, SMS-only staff reply; communications outcomes are API-only.
- FP/Google Calendar/HCP settings panels do not self-hide for non-super_admin (action 403s at submit).
- Forgot-password is a guide only (no self-serve reset).
- Platform admin is env-var only (`PLATFORM_ADMIN_EMAILS`), no UI to grant.
- Customer count jump after identity split is expected (per-FP-customer rows); no merge tool.
- Single hardcoded business timezone and base location (Spears Services, Johnson City TN); marketing homepage is brand-hardcoded.
- Inventory is not decremented by job materials (unverified); single free-text location; no vendors table.
- Not found: tags, checklists/forms, multi-day jobs, offline/PWA, native app, marketing campaigns, MFA/SSO, custom roles, multi-branch, public API.
