# Probook-Class AI Home-Services Platform — Master Build Plan

> Generated 2026-07-01 by a 25-agent workflow: 12 domain experts each authored a repo-grounded build chapter, each was adversarially reviewed against the live code, then synthesized. ~78 pages. Total estimated effort: **~189.5 engineer-weeks**.

## Table of contents

- [Front matter (executive summary, gap analysis, sequencing)](#front-matter)
- [Effort & review scoreboard](#effort--review-scoreboard)
- [1. The AI Auto-Dispatch Decision Engine: Scored, Confidence-Gated Assignment with Travel, Capacity, and Real-Time Re-Optimization](#1-dispatch-engine)
- [2. The Brain: A Unified Customer/Job Context Layer with Entity Resolution and a 360 View](#2-context-layer)
- [3. Voice AI: From Turn-Based IVR Replacement to Full-Duplex Booking + Outbound Revenue Calls](#3-voice-ai)
- [4. The Messaging Brain: One Conversational Core Across Web Chat, SMS, and Voice](#4-messaging-ai)
- [5. Clean Every Booking Before It Hits the Board: A Pre-Assign Data-Quality Gate](#5-booking-quality)
- [6. Outbound Revenue Engine: Campaign Orchestration over the Existing Comms Queue](#6-outbound-engine)
- [7. The Integrations Platform: From Two Hand-Built FSM Twins to a Reusable, Money-Safe, Bidirectional Connector Fabric](#7-integrations-platform)
- [8. Scheduling & Capacity: From Band-Level Soft Holds to a Race-Safe, Duration- and Drive-Time-Aware Capacity Engine](#8-scheduling-capacity)
- [9. Front-End Surfaces: Admin Console, Technician Field App, Customer Portal + Widget, and the Live Dispatch Map](#9-frontend-mobile)
- [10. The Operating Substrate: Multi-Tenancy, Durable Jobs, Migrations Discipline, Observability, and the Analytics Seam](#10-platform-infra)
- [11. The AI/ML Platform & Evals Layer: Model Routing, Guardrails, Offline+Online Evals, and the Dispatch/Duration Learning Loops](#11-aiml-evals)
- [12. Security, Compliance & Trust: From a Well-Built Single-Tenant Auth Model to a SOC2-Attestable, TCPA-Safe Multi-Tenant Platform](#12-security-compliance)

## Effort & review scoreboard

| # | Domain | Effort (wk) | Reviewer verdict | Blockers/Majors |
|---|--------|-------------|------------------|-----------------|
| 1 | The AI Auto-Dispatch Decision Engine: Scored, Confidence-Gated Assignment with Travel, Capacity, and Real-Time Re-Optimization | 9.5 | needs-work | 3 |
| 2 | The Brain: A Unified Customer/Job Context Layer with Entity Resolution and a 360 View | 7 | needs-work | 2 |
| 3 | Voice AI: From Turn-Based IVR Replacement to Full-Duplex Booking + Outbound Revenue Calls | 20 | needs-work | 2 |
| 4 | The Messaging Brain: One Conversational Core Across Web Chat, SMS, and Voice | 29 | needs-work | 2 |
| 5 | Clean Every Booking Before It Hits the Board: A Pre-Assign Data-Quality Gate | 6.5 | needs-work | 2 |
| 6 | Outbound Revenue Engine: Campaign Orchestration over the Existing Comms Queue | 14 | needs-work | 2 |
| 7 | The Integrations Platform: From Two Hand-Built FSM Twins to a Reusable, Money-Safe, Bidirectional Connector Fabric | 26 | needs-work | 2 |
| 8 | Scheduling & Capacity: From Band-Level Soft Holds to a Race-Safe, Duration- and Drive-Time-Aware Capacity Engine | 16.5 | over-scoped | 2 |
| 9 | Front-End Surfaces: Admin Console, Technician Field App, Customer Portal + Widget, and the Live Dispatch Map | 16 | needs-work | 1 |
| 10 | The Operating Substrate: Multi-Tenancy, Durable Jobs, Migrations Discipline, Observability, and the Analytics Seam | 22 | needs-work | 2 |
| 11 | The AI/ML Platform & Evals Layer: Model Routing, Guardrails, Offline+Online Evals, and the Dispatch/Duration Learning Loops | 8 | needs-work | 1 |
| 12 | Security, Compliance & Trust: From a Well-Built Single-Tenant Auth Model to a SOC2-Attestable, TCPA-Safe Multi-Tenant Platform | 15 | needs-work | 2 |
| | **TOTAL** | **~189.5** | | |

---

<a name="front-matter"></a>
# Probook-Class AI Home-Services Platform — Master Build Plan (Front Matter)

## 1. Executive Summary — The Bet, The Moat, The Reuse-First Thesis

**The bet.** The winning AI home-services platform is not the one with the best chatbot — it is the one that turns an inbound contact into a *committed, well-dispatched appointment* without a human touching it, and that proactively *manufactures* demand from the customer base it already owns. Everything else (portals, maps, reporting) is table stakes that follows. We are building a Probook/ServiceTitan-class operating system for the trades where AI is not a bolt-on feature but the dispatcher, the CSR, and the outbound sales rep.

**The moat is two mechanisms, and they compound:**

1. **AI auto-dispatch that book-on-the-call.** Today the platform can *talk* but deliberately *refuses to book* — every conversational path (`account-tools.ts` "must not self-book", the `FALSE_BOOKING_REGEX` guard in messaging-ai) offers windows and hands a service *request* to a human. The moat is closing that loop: a scored, confidence-gated `dispatch-engine` assignment married to a race-safe `scheduling-capacity` hold so the voice/chat/SMS agent locks a real slot on the last turn. Nobody wins the trades with a smarter LLM; they win by removing the human scheduler.

2. **AI outbound revenue.** The `outbound-engine` and outbound `voice-ai`/`messaging-ai` motions turn the customer database into recurring revenue: unsold-estimate follow-up, membership renewals, maintenance recalls, win-back, and capacity-aware "fill-the-board" campaigns. This is the ServiceTitan Marketing Pro / Probook revenue story, and it is the highest-margin thing an AI can do because the leads are already owned.

**The reuse-first thesis.** This is a brownfield build, not a greenfield one. The digest repeatedly shows the *substrate already exists and is stranded*: `travelKm` is plumbed through `score.ts` but never populated; `canHoldSlot` exists with zero callers; `estimatedDurationMinutes` is computed and stored with zero consumers; `technicianLocations.serviceRequestId` exists but no geofence uses it; `estimates.status` has an open/sold lifecycle but nothing sweeps it; a model registry exists but prompts are unversioned. **The dominant unit of work is wiring, not inventing.** Our sequencing is deliberately biased to "activate dead code and persist what we already compute" first (cheap, high-leverage) before net-new systems. We build the connector *fabric* once (`integrations-platform` Phase 0 shared port) rather than hand-copying a third FSM twin, and we buy rather than build the commodity layers (see §5).

## 2. Where This Repo Already Is vs. Probook-Class (Honest)

**What is genuinely strong (keep, extend):**
- A real multi-tenant, encrypted, RBAC'd Next.js app with JWT sessions, Google OIDC, per-route `getAdminSession`, HMAC blind-index customer dedupe, and an `authz.ts` policy. This is a well-built *single-tenant-grade* foundation.
- Two working FSM invoice mirrors (HCP + FieldPulse), an atomic-claim `communication_jobs` queue, a deterministic KB router, an output guardrail (`screenAssistantReply`), a disciplined model registry, and a promptfoo eval seam.
- A scored dispatch *skeleton* (`score.ts`, `suggestTechnicians`, `auto_dispatch_outcome`) and a capacity *skeleton* (availability slots, arrival windows).

**Where it is not yet Probook-class (the honest gaps):**
- **It talks but won't book.** No booking hold on any channel; the capacity CAS is aspirational (`holdConcreteSlot` has no `WHERE available > 0` re-assertion → concurrent voice+web double-books the last slot). This is the single biggest gap between "demo" and "product."
- **Dispatch is one-shot and blind.** Travel term is dead code; no hard eligibility gate (license/EPA-608/brand cert); capacity is a raw job count with no drive-time day-packing; zero real-time re-optimization on cancel/no-show; no exception queue UI; no decision audit.
- **Three forked conversational brains** (voice-turn, web route.ts, SMS→voiceReply) that drift and ship every fix 2-3×. Turn-based IVR only — no barge-in, no full-duplex, single hardcoded `DEMO_ORG_ID` (one phone line for the whole platform).
- **No outbound engine, no attribution.** Every trigger is a one-shot `queueCommunicationJob`; no sequences, no unsold-estimate sweep, no renewal sweep.
- **No unified customer brain.** `getCustomerById` omits memberships/estimates/invoices/balances; `lastServiceDate` is hardcoded null; entity resolution is exact-match only; no merge; no rollups.
- **Operating substrate has sharp edges.** Migrations don't run on deploy (schema-drift 500s); comms cron runs daily despite "every minute" intent; tenancy is app-level only (no RLS backstop); traces default off; single Neon HTTP endpoint for OLTP + analytics.
- **Compliance is not shippable-for-outbound.** No consent ledger, no DNC/litigator scrub, no MFA, no key rotation, no session revocation. These are **hard gates** on the outbound moat.

Net: this is a strong ~35% of a Probook-class product where the strong 35% is the *hard security/tenancy/FSM plumbing*, and the missing 65% is disproportionately the *revenue moat* (booking + outbound) plus the operating hardening to run it multi-tenant.

## 3. Cross-Cutting Build Sequencing (Phase 0..6)

Sequencing is dependency- and value-ordered, not domain-by-domain. Domains advance in parallel tracks; the rule is **you cannot ship the moat on a substrate that will double-book, leak tenants, or violate TCPA.**

### Phase 0 — Un-break the substrate & activate stranded code (foundational, ~4–6 wks calendar)
*Nothing revenue-facing is safe until these land.*
- **platform-infra Ph0**: migrations-run-on-deploy gate + comms cron cadence (daily→minutely). Unblocks everything.
- **scheduling-capacity Ph0**: make the capacity CAS real (`WHERE available > 0` + reservation/unique constraint). **This is the prerequisite for the entire booking moat** — do not build booking on a racey hold.
- **dispatch-engine Ph0–1**: wire the travel term (activate `W_TRAVEL`); add the decision-audit table. Cheap wiring, unlocks tuning + the override loop later.
- **context-layer Ph0**: unify the read — one `loadCustomerProfile()` (memberships, balances, last service). Every downstream agent depends on this "brain."
- **aiml-evals Ph0** + **security-compliance Ph0**: persist guardrail hits; route-guard consolidation + session revocation. Both are cheap, both are prerequisites for trust.

### Phase 1 — The booking moat, part 1: clean input → committed slot (~6–8 wks)
- **booking-quality Ph0–2**: persist geocoded/validated address (already computed, thrown away), scrub+scoring module, needs_review exceptions queue. A pre-assign gate is required before auto-dispatch can trust its input.
- **dispatch-engine Ph2–3**: hard eligibility gate (exclude unqualified, don't soft-penalize) + exception-queue UI.
- **scheduling-capacity Ph1–2**: PTO/blackout model + org-configurable hours; duration-aware capacity (activate `estimatedDurationMinutes`).
- **messaging-ai Ph0 + Ph3 / voice-ai Ph0**: **unify the brain** (one conversational core), add the **booking hold** (the "book-on-the-call" revenue moat), and multi-tenant number routing (kill `DEMO_ORG_ID`). *This is the milestone where the demo becomes a product.*

### Phase 2 — The outbound moat, gated on compliance (~6–8 wks)
- **security-compliance Ph2–3**: consent ledger + provenance, then **DNC / litigator scrub — HARD GATE. No outbound campaign ships before this.**
- **outbound-engine Ph0–1**: unsold-estimate follow-up (direct), then generalize into the sequence engine over the existing comms queue.
- **voice-ai Ph1–2 / messaging-ai Ph4**: call recording + retention; outbound missed-call callback (Vercel-friendly); outbound conversational SMS threading back into the unified brain.
- **integrations-platform Ph0–1**: extract the shared FSM connector port; add the outbound delivery guarantee (outbox/retry/dead-letter) so pushes to the FSM stop being fire-and-forget.

### Phase 3 — Scale the moat & harden the platform (~8–10 wks)
- **integrations-platform Ph2**: ServiceTitan connector (flagship — largest FSM; OAuth2 client-credentials breaks the single-key assumption, plan for it).
- **outbound-engine Ph2–3**: membership renewal + maintenance recall + win-back + attribution (touch→booking→revenue).
- **scheduling-capacity Ph3 + dispatch-engine Ph4–5**: drive-time/geo placement, arrival-window feasibility, and **real-time re-optimization** (re-solve the board on cancel/no-show/runover). These are co-dependent and should ship together.
- **context-layer Ph1–4**: rollups/write-back, external-id map, fuzzy resolution + review queue, merge.
- **platform-infra Ph1–3**: tenancy defense-in-depth (RLS), generic durable queue, observability depth.

### Phase 4 — Front-end surfaces & field revenue (~6–8 wks, parallelizable earlier)
- **frontend-mobile Ph0–4**: real-time backbone (kill setInterval polling), map hardening + geocache, tech PWA shell + offline queue, **on-site money** (present estimates, take card at the truck), geofence auto-arrival + "on my way."
- **outbound-engine Ph4**: fill-the-board capacity-aware outbound (joins live availability — depends on Phase 3 scheduling).

### Phase 5 — Intelligence flywheels & accounting (~6–8 wks)
- **aiml-evals Ph1–5**: AI health dashboard/online eval, structured-output contract, prompt registry + canary, **close the duration loop** (`job_duration_actuals` → recalibrate), golden-set flywheel + independent judge.
- **dispatch-engine Ph6**: override-learning loop (tune weights from dispatcher overrides — depends on Ph1 audit table + real production travel signal).
- **integrations-platform Ph3–4**: reconciliation/initial-import/provenance + QBO accounting connector.
- **messaging-ai Ph6**: Spanish deterministic layer + KB self-improvement.

### Phase 6 — Enterprise trust & the deferred frontier (ongoing)
- **security-compliance Ph4–7**: envelope encryption + key rotation, RLS backstop (with platform-infra), tamper-evident audit, SOC2 evidence scaffolding.
- **voice-ai Ph4** [GATE: off-Vercel infra]: real-time gateway with barge-in / full-duplex.
- **platform-infra Ph4–5**: analytics via materialized views, then read replica + feature store (deferred).

## 4. Total Effort & Team Shape

Summed raw domain estimates ≈ **185–190 person-weeks** (`messaging-ai` 29, `integrations-platform` 26, `platform-infra` 22, `voice-ai` 20, `scheduling-capacity` 16.5 [flagged over-scoped — trim to ~11], `frontend-mobile` 16, `security-compliance` 15, `outbound-engine` 14, `dispatch-engine` 9.5, `aiml-evals` 8, `context-layer` 7, `booking-quality` 6.5). Trimming the over-scoped scheduling work and accounting for the heavy *reuse* discount (much is wiring, not building) puts realistic scope at **~150–170 person-weeks**.

**Team shape (7–8 engineers) → ~9–11 months calendar** to a Probook-competitive product (Phases 0–4), with Phases 5–6 continuing after GA:
- **2 × Backend/AI (conversational)** — messaging/voice unification, booking hold, outbound engine.
- **2 × Backend/platform** — infra, scheduling CAS, dispatch, integrations fabric + ServiceTitan.
- **1 × Full-stack/front-end** — admin, dispatch map, tech PWA, portal.
- **1 × ML/evals** — dispatch/duration loops, prompt registry, guardrail/health dashboards.
- **1 × Security/compliance** (can be 0.5 + fractional external SOC2 auditor).
- **1 × Tech lead / architect** (this role) holding the cross-domain sequencing and the "wire don't rebuild" discipline.

## 5. Top Risks & What NOT to Build (Build-vs-Buy)

**Top risks:**
1. **Shipping the moat on an unsafe substrate.** Booking before the CAS is real → double-books; outbound before DNC/consent → TCPA liability (statutory damages per violation). These are *ordering* risks, mitigated by the Phase 0 / compliance-gate discipline above. Non-negotiable.
2. **Conversational drift across three brains.** Every week we delay `messaging-ai` Ph0 unification, fixes ship 2-3× and diverge. Unify early (Phase 1).
3. **Off-Vercel infra for full-duplex voice.** Barge-in (`voice-ai` Ph4) needs persistent websockets Vercel can't host. Explicitly gated and deferred — do not let it block turn-based revenue.
4. **ServiceTitan OAuth2 breaking the single-API-key assumption** in `config.ts` — design the connector port (Ph0) to accommodate client-credentials *before* building ST.
5. **Multi-tenant blast radius** — app-only `withTenant` across ~103 call sites; one forgotten filter is a breach. RLS backstop is insurance, sequenced once outbound/multi-line makes us a bigger target.

**What NOT to build (buy/adopt instead):**
- **Real-time voice gateway** — use Twilio ConversationRelay / Media Streams, not a hand-rolled media server.
- **Accounting** — sync to QuickBooks Online; never build a ledger.
- **Payments** — Stripe (already the assumption); do not build a processor or vault cards.
- **TTS/STT/LLMs** — ElevenLabs + model registry; keep provider-swappable, build none.
- **DNC/litigator list & phone reputation** — subscribe to a compliance data vendor; do not curate litigator lists in-house.
- **Warehouse/BI at Phase 4-scale** — materialized views on Neon first; defer a real warehouse + read replica (`platform-infra` Ph5) until analytical load actually contends with OLTP.
- **Address/geocode** — keep Photon/FieldPulse geocode; just *persist* the result. Don't build geocoding.

## 6. Success Metrics

**North-star (the moat working):**
- **Book-on-the-call rate**: % of inbound contacts that leave with a *committed slot* (target 60%+ voice/chat), up from 0% today (deliberate no-book).
- **Autonomous dispatch rate**: % of bookings auto-assigned above confidence gate with no human touch (target 70%+), with **exception-queue size** trending down.
- **Outbound-attributed revenue**: revenue tied touch→booking within window (unsold-estimate recovery %, renewal capture %, win-back conversion).

**Operational quality:**
- Double-book incidents = **0** (CAS correctness).
- Dispatch quality: on-time arrival %, drive-time per job, reassignment churn after re-optimization.
- Duration calibration error (predicted vs. `job_duration_actuals`) trending down.
- Conversational: fallback/low-confidence turn rate, guardrail-hit rate (now persisted), sub-800ms voice latency SLO.

**Trust/scale gates:**
- 100% of outbound sends pass consent + DNC scrub (hard gate, auditable).
- Cross-tenant leakage incidents = 0; migrations-on-deploy = 100%; comms queue latency ≤ 1 min.
- MFA coverage on admin/super_admin = 100%; SOC2 evidence scaffolding in place before enterprise sales.

---
*This front matter governs the 12 domain chapters that follow; each chapter's internal Phase 0..N maps onto the cross-cutting Phase 0..6 above, and no domain-phase may land ahead of its named prerequisite (capacity CAS before booking; consent+DNC before outbound; shared connector port before ServiceTitan; unified brain before per-channel booking).*

---

# Domain Build Chapters

<a name="1-dispatch-engine"></a>
## 1. The AI Auto-Dispatch Decision Engine: Scored, Confidence-Gated Assignment with Travel, Capacity, and Real-Time Re-Optimization

_Effort: ~9.5 engineer-weeks · Reviewer verdict: **needs-work**_

## 1. The bar: what a Probook-class dispatch engine does

In ServiceTitan/Avoca-class products, dispatch is a continuously-optimized assignment problem, not a one-shot "pick a tech." The bar has five pillars:

1. **Scored assignment with explainability.** Every candidate tech is scored on skill/eligibility, quality, revenue-conversion, current load, and — critically — *drive time* from where they'll actually be. The winner comes with a human-readable "why."
2. **Hard eligibility gates before soft scoring.** License/EPA-608, membership-tier entitlement, equipment-brand certification, and truck-stock are hard filters. A tech who *can't legally or physically* do the job is never ranked, no matter how good the score.
3. **Route/travel optimization + capacity.** The engine packs a tech's day to minimize windshield time, respects true capacity (drive-time-aware, not just a job count), and honors arrival-window promises.
4. **Real-time re-optimization.** A cancel, a reschedule, a "running behind," or a same-day emergency triggers re-solve of the *affected* techs' remaining routes — auto-filling the freed slot from the backlog and shuffling to preserve promises.
5. **Confidence-gated autopilot + an exception queue.** The system auto-commits only when it's confident; ambiguous or no-fit cases land in a triage queue where a dispatcher sees the ranked shortlist and one-taps a decision. Overrides feed back into weight tuning.

## 2. Current-state gap analysis

This repo already has a genuinely strong *deterministic core* — better than most first attempts — but it is a single-job, single-shot assigner with no travel wiring, no eligibility model, and no re-optimization.

**What exists and is good:**
- **Pure scorer** — `src/lib/ai/dispatch/score.ts`: `scoreTechnician`/`rankTechnicians` compute a composite from `W_SKILL=0.4`, `W_QUALITY=0.2`, `W_CONVERSION=0.25`, `W_LOAD=0.15`, with a `W_TRAVEL=0.45` overlay when `travelKm` is present, `TRAVEL_CAP_KM=40`. `classifyDispatch` gates auto-commit on `MIN_CONFIDENCE_GAP=0.08` (top-vs-second gap), emitting `committed | queued_ambiguous | queued_no_fit`. No IO, no LLM — explainable and hallucination-free by construction.
- **Signal loader** — `src/lib/ai/dispatch/signals.ts`: `loadDispatchSignals` runs 5 parallel tenant-scoped aggregates (skill-jobs-completed, avg rating, same-day load, estimate close-rate, avg invoice revenue), defaulting every tech so callers never null-check.
- **Duration model** — `src/lib/ai/dispatch/duration.ts`: deterministic `JOB_DURATION_DEFAULTS` table × system/age modifiers, clamped `[15,480]` and rounded to 15-min blocks, with an optional LLM refine bounded to `[0.5×,2×]` the base — dispatch never depends on the LLM.
- **Orchestrator** — `autoAssignBookedRequest` (`src/lib/admin/scheduling-queries.ts:1011`): org opt-in (`isAutoDispatchEnabled`), external-scheduler skip (`isExternallyScheduled` — avoids double-booking FieldPulse/HCP), first-fit fallback for unclassifiable jobs, confidence gate, `stampDispatchOutcome`, and a `markAutoAssigned` badge. Runs in `after()` from `src/lib/requests/submit-session-request.ts:337`, off the voice/chat latency path.
- **Advisory queue feed** — `suggestTechnicians` (`:966`) reuses the same ranking read-only regardless of the opt-in, backing `GET /api/admin/dispatch/suggest/[id]`.
- **Geo primitives already landed** — `technician_locations` table (`schema.ts:2232`), `users.home_base_lat/lng` (`:297`), `haversineKm` (`src/lib/address/photon.ts:211`), a live dispatch-map route, and `service_requests.estimated_duration_minutes/_source`, `auto_dispatch_outcome`, `organization_settings.auto_dispatch_enabled`/`scheduling_source` columns.

**The gaps (what's missing vs. the bar):**
- **Travel is dead code from the auto-assign path.** `score.ts` fully supports `travelKm`, but `rankedTechnicianOrder` (`:924`) builds candidates *without* it (the `tech` object at `:944-951` omits `travelKm`), and `signals.ts` never loads coordinates. So the location-primary `W_TRAVEL=0.45` overlay — the single most important dispatch factor — never fires in production. The plumbing exists on both ends; the pipe is unconnected.
- **No hard eligibility.** "Skill" is inferred purely from *completed-job history* (`skillJobsCompleted`). There is no license/EPA/certification/membership-tier/truck-stock gate. A brand-new tech, or one legally unqualified, is simply "no prior experience" (a soft penalty), not *ineligible*.
- **Capacity is a job count, not a schedule.** `sameDayJobCount` (capped at 6) plus availability-slot checks (`checkScheduleConflict`, `getTechnicianAvailability`) are the only capacity model. There is no drive-time-aware day packing, no arrival-window-feasibility check ("can this tech physically reach the 2–4pm window given their 1pm job across town?").
- **Zero re-optimization.** Assignment is one-shot at booking. `rescheduleRequest` is `@deprecated`/soft; `placeAndAssignRequest` is manual drag-and-drop. No cron and no event re-solves a tech's day on cancel/reschedule/no-show. The `delay-sweep` cron only *detects* lateness; it doesn't reassign.
- **No real exception queue.** `auto_dispatch_outcome` is stamped and `suggestTechnicians` exists, but there's no dedicated triage surface that lists `queued_ambiguous`/`queued_no_fit` jobs with shortlist + one-tap assign, and no override-capture loop for weight learning.

## 3. Target architecture + data model

Keep the deterministic pure-core philosophy — it's the right call for a money/ops decision. Layer eligibility, travel, capacity, and re-optimization *around* it without turning the scorer into an LLM.

**Data model additions (each = one additive Drizzle migration, hand-reconciled journal+snapshot, `npm run db:migrate` after deploy per repo memory):**

- `technician_skills` — `(org_id, technician_id, skill_key text, level enum('none','trained','certified'), cert_expires_at date null)`. `skill_key` spans `job_type`/`system_type` enums plus brand keys. Unique `(org, tech, skill_key)`.
- `technician_eligibility` (or reuse `technician_skills` for certs) — license flags: `epa_608 bool`, `state_license_expires_at`, `can_service_membership_tiers text[]`. Hard gates.
- `service_requests`: add `required_skill_keys text[]` (derived at intake from `job_type`/`system_type`/brand), `route_position int null` (day sequence), `travel_km_estimate double null` (cached at assign for audit).
- `dispatch_decisions` — append-only audit: `(id, org_id, service_request_id, technician_id null, outcome, score, gap, reasons jsonb, signals_snapshot jsonb, decided_by enum('auto','human'), overridden_from null, created_at)`. This is the learning substrate and the "why this tech?" record (today only a `logger.info`).
- `organization_settings`: `min_confidence_gap double null` (per-org tunable, defaults to the constant), `travel_weight double null`, `reoptimize_enabled bool default false`.

**Modules/endpoints:**
- Extend `signals.ts` with `loadTravelKm(orgId, requestId, techIds)` — read the job's `customer_locations.lat/lng` (via `location_id`) and each tech's *anchor* = freshest `technician_locations` fix within a freshness window (e.g. 20 min) else `users.home_base_lat/lng`, compute `haversineKm`. Return `Map<techId, number|null>`.
- New `src/lib/ai/dispatch/eligibility.ts` — pure `filterEligible(job, techEligibility[]): {eligible, rejected:[{techId,reason}]}` run *before* `rankTechnicians`.
- New `src/lib/ai/dispatch/reoptimize.ts` — `reoptimizeAffected(orgId, techId, isoDay)`: on a freed slot, pull `listUnscheduledRequests` + same-day backlog, re-rank against the gap, propose fills; auto-commit only under the same confidence gate, else enqueue.
- New `src/app/api/cron/dispatch-reoptimize` (or event-driven `after()` on cancel/reschedule routes) — batch re-solve.
- New `src/app/api/admin/dispatch/exceptions` + a board tab rendering `auto_dispatch_outcome IN ('queued_ambiguous','queued_no_fit')` with `suggestTechnicians` shortlist and a one-tap assign that writes a `dispatch_decisions` row with `decided_by='human'`.

## 4. Phased build plan

**Phase 0 — Wire the travel term (the highest-ROI fix; ~unblocks shipped code).** Add `loadTravelKm` to `signals.ts`; thread `travelKm` through `rankedTechnicianOrder` candidate construction (`scheduling-queries.ts:944`) and `suggestTechnicians`. No new tables (coords already exist). Ship behind the existing `auto_dispatch_enabled` opt-in so it's a no-op for opted-out orgs. Files: `signals.ts`, `scheduling-queries.ts`. Verify: a tech 2km away with weaker history now out-ranks a distant expert; confidence-gap regime still single-threshold-safe (the spec's stated risk — validate with a test matrix over travel-present vs -absent).

**Phase 1 — Decision audit table.** Add `dispatch_decisions`; write from `autoAssignBookedRequest` (replace the `logger.info` at `:1084`) and from the exception-queue assign. Pure additive; unblocks everything downstream (learning, "why?", override capture). Files: `schema.ts`, migration, `scheduling-queries.ts`.

**Phase 2 — Hard eligibility gate.** Add `technician_skills`/eligibility tables; derive `required_skill_keys` at intake; `eligibility.ts` filters candidates before ranking in `rankedTechnicianOrder`. Rejected techs and reason go into `dispatch_decisions.reasons`. This converts today's soft skill-history signal into a true gate while *retaining* history as a tiebreaker among eligible techs. Files: new `eligibility.ts`, `signals.ts` (load eligibility), `scheduling-queries.ts`, intake pipeline.

**Phase 3 — Exception queue UI.** Board tab + `api/admin/dispatch/exceptions` reading `auto_dispatch_outcome`; reuse `suggestTechnicians` for the shortlist; one-tap assign via existing `placeAndAssignRequest` + `dispatch_decisions` write. No new tables. This is the operator's daily driver and makes autopilot trustworthy (they see what it skipped and why). Files: new route, board component, reuse `suggest/[id]`.

**Phase 4 — Arrival-window feasibility (drive-time capacity).** Before committing, check the target tech can physically reach the window given their adjacent jobs' coords + `estimated_duration_minutes` (haversine → rough minutes, no external routing API yet). Fold into `placeAndAssignRequest`'s conflict gate as a soft warning first, then hard. Files: `scheduling-queries.ts`, a `travel-feasibility.ts` helper.

**Phase 5 — Real-time re-optimization.** `reoptimize.ts` + trigger from cancel/reschedule routes via `after()` (Vercel-safe per repo memory) and a daily `dispatch-reoptimize` cron backstop. On a freed slot, re-rank backlog, auto-fill under the confidence gate, else enqueue to the Phase 3 queue. Gate behind `reoptimize_enabled`. Files: new `reoptimize.ts`, new cron route, cancel/reschedule route hooks.

**Phase 6 — Override-learning loop.** Aggregate `dispatch_decisions` where `decided_by='human'` and `overridden_from` is set; surface a weekly "auto-pick was overridden N% for reason X" report; expose per-org `min_confidence_gap`/`travel_weight` knobs (already in settings). This closes the loop without ML infra — just a report + tunable constants. Files: analytics query, settings UI.

## 5. Effort, risks, reuse-first

**Effort (engineer-weeks):** Phase 0 ≈ 0.5 (mostly wiring + tests); Phase 1 ≈ 0.5; Phase 2 ≈ 2 (skill/cert data model + intake derivation is the real cost); Phase 3 ≈ 1.5 (UI); Phase 4 ≈ 1.5; Phase 5 ≈ 2.5 (event orchestration + idempotency); Phase 6 ≈ 1. Total ≈ 9.5 weeks.

**Risks:** (a) **Confidence-gap regime straddle** — the shipped `MIN_CONFIDENCE_GAP=0.08` was tuned without travel active; once Phase 0 lands, the score distribution shifts and one threshold must not misbehave across travel-present/absent jobs (the plan doc flags this explicitly). Mitigate with a regression test matrix and a per-org override. (b) **Coordinate NULLs** — jobs frequently lack lat/lng until intake geocoding backfills; `loadTravelKm` must degrade to the no-travel composite (score.ts already does this byte-identically — lean on it). (c) **Re-optimization thrash** — auto-shuffling committed jobs can break arrival-window promises made to customers; only re-solve *unpromised* backlog first, keep confirmed windows sticky. (d) **neon-http has no transactions** — every re-optimize write must be a guarded UPDATE or `db.batch`, matching the existing lost-update-race pattern in `placeAndAssignRequest`.

**Reuse-first — do NOT build:** No external route-optimization solver (OR-Tools/Google Routes) yet — haversine-minutes is good enough through Phase 5 and the repo already has `haversineKm`. No ML ranking model — the constant-weighted scorer + override report (Phase 6) is explainable and sufficient for a pilot; ML is a post-pilot bet on `dispatch_decisions` data. No new "auto badge" — `markAutoAssigned` + `auto_dispatch_outcome` already exist. No new geo/consent capture — `technician_locations` and `home_base_lat/lng` shipped. The single biggest win (Phase 0) is *connecting code that already exists on both ends*, not writing new systems.

**Key gaps vs. Probook-class:**

- Travel term is dead code from the auto-assign path: score.ts supports travelKm but rankedTechnicianOrder (scheduling-queries.ts:944) and signals.ts never populate it, so the location-primary W_TRAVEL=0.45 overlay never fires in production despite home_base_lat/lng and technician_locations both existing
- No hard eligibility gate: 'skill' is inferred only from completed-job history (skillJobsCompleted); no license/EPA-608, brand certification, membership-tier, or truck-stock filtering — unqualified techs are soft-penalized, not excluded
- Capacity is a raw same-day job count (capped at 6) plus availability slots; no drive-time-aware day packing and no arrival-window feasibility check (can this tech physically reach the promised window given adjacent jobs)
- Zero real-time re-optimization: assignment is one-shot at booking; rescheduleRequest is deprecated/soft, placeAndAssignRequest is manual drag, and no cron/event re-solves a tech's day on cancel/reschedule/no-show (delay-sweep only detects lateness)
- No real exception-queue surface: auto_dispatch_outcome is stamped and suggestTechnicians exists, but there's no triage UI listing queued_ambiguous/queued_no_fit jobs with shortlist + one-tap assign
- No decision-audit / override-learning loop: scored assignments are only logger.info'd, not persisted, so there's no substrate for 'why this tech?' history or weight tuning from dispatcher overrides
- Confidence thresholds (MIN_CONFIDENCE_GAP=0.08) are hardcoded guesses tuned without the travel term active and not per-org tunable

**Phased build:**

- **Phase 0 — Wire the travel term** — Add loadTravelKm to signals.ts (job coords via location_id + freshest technician_locations fix else home_base, haversineKm); thread travelKm through rankedTechnicianOrder candidates (scheduling-queries.ts:944) and suggestTechnicians. No new tables. Ship behind existing auto_dispatch_enabled opt-in. Highest-ROI fix: connects code that already exists on both ends. ~0.5 wk.
- **Phase 1 — Decision audit table** — Add append-only dispatch_decisions (request, tech, outcome, score, gap, reasons, signals snapshot, decided_by, overridden_from). Write from autoAssignBookedRequest (replace logger.info at :1084) and the exception queue. Additive migration; unblocks why-this-tech, override capture, and learning. ~0.5 wk.
- **Phase 2 — Hard eligibility gate** — Add technician_skills/eligibility tables (skill_key, level, cert_expires_at, epa_608, license, membership tiers); derive service_requests.required_skill_keys at intake; new eligibility.ts filterEligible() runs before rankTechnicians in rankedTechnicianOrder. Retain completed-job history as tiebreaker among eligible techs. ~2 wk.
- **Phase 3 — Exception queue UI** — Board tab + api/admin/dispatch/exceptions reading auto_dispatch_outcome IN (queued_ambiguous, queued_no_fit); reuse suggestTechnicians shortlist; one-tap assign via placeAndAssignRequest + dispatch_decisions write (decided_by=human). No new tables. Makes autopilot trustworthy. ~1.5 wk.
- **Phase 4 — Arrival-window feasibility (drive-time capacity)** — Before commit, verify target tech can physically reach the window given adjacent jobs' coords + estimated_duration_minutes (haversine-minutes, no external routing API). Add to placeAndAssignRequest conflict gate as soft warning then hard. New travel-feasibility.ts helper. ~1.5 wk.
- **Phase 5 — Real-time re-optimization** — New reoptimize.ts reoptimizeAffected(); trigger from cancel/reschedule routes via after() (Vercel-safe) + daily dispatch-reoptimize cron backstop. On freed slot, re-rank backlog, auto-fill under confidence gate else enqueue. Keep confirmed customer windows sticky. Gate behind reoptimize_enabled. Guarded UPDATE/db.batch (no neon-http txns). ~2.5 wk.
- **Phase 6 — Override-learning loop** — Aggregate dispatch_decisions where decided_by=human/overridden; weekly report of override rate by reason; expose per-org min_confidence_gap/travel_weight knobs (settings columns already present). Closes the tuning loop without ML infra. ~1 wk.

**Adversarial review findings:**

- _blocker_ — Phase 0's central premise is false. The chapter claims "Geo primitives already landed... The plumbing exists on both ends; the pipe is unconnected" and scopes Phase 0 as "No new tables (coords already exist)... ≈ 0.5 (mostly wiring + tests)", calling it "the highest-ROI fix; ~unblocks shipped code." But NO job or tech coordinate is actually produced by any live path: (a) createLocation (src/lib/admin/location-queries.ts:49) has ZERO callers in src, and its latitude is only set if a caller passes input.latitude (:77) — nobody does; (b) service_requests.locationId (schema.ts:503) is never written by any insert/update in the codebase — the schema comment even says "populated lazily"; (c) customer_locations.latitude/longitude (schema.ts:2048) are nullable and unset; (d) users.home_base_lat/lng (schema.ts:297-298) — the proposed anchor fallback — has NO writer anywhere in src. The service_request only stores addressEncrypted (schema.ts:74), not a geocoded point. So loadTravelKm would return null for every job and every tech, and the W_TRAVEL=0.45 overlay STILL never fires after Phase 0 ships. The verified no-op is the opposite of "highest-ROI." → **Fix:** Insert a prerequisite phase before Phase 0: at booking, decrypt the request address, geocode via the existing Photon helper, and persist lat/lng (on the request or by actually calling createLocation and setting service_requests.locationId); add an admin field + writer for users.home_base_lat/lng so the anchor fallback is non-null. Re-scope Phase 0 effort accordingly (it is a geocoding pipeline, not 0.5wk of wiring).
- _major_ — Over-scoped for the actual customer. This targets a single small HVAC shop (Spears Services, Johnson City TN, ~a handful of techs) yet specifies a full ServiceTitan/Avoca-class 9.5-engineer-week program: hard EPA-608/state-license/brand-cert/membership-tier/truck-stock eligibility gates with cert-expiry tracking (Phase 2, 2wk), drive-time day-packing (Phase 4, 1.5wk), real-time re-optimization with idempotency (Phase 5, 2.5wk), and an override-learning loop (Phase 6, 1wk). With 2-4 techs, scored assignment + re-optimization + an eligibility matrix is gold-plating that will rarely change the pick over the shipped first-fit/soft-score. → **Fix:** Ship the two phases with immediate payoff — Phase 1 (dispatch_decisions audit, replaces the logger.info) and Phase 3 (exception-queue UI over the already-stamped auto_dispatch_outcome) — and defer Phases 2/4/5/6 behind real multi-tenant/large-fleet demand from the SaaS roadmap.
- _major_ — Phase 2 hard-eligibility needs data that must be manually entered and has no source. technician_skills / technician_eligibility (epa_608, state_license_expires_at, can_service_membership_tiers, per-skill cert levels) require per-tech population, but the chapter proposes no admin UI, import, or backfill — while today's shipped model derives skill purely from completed-job history automatically. For a 2-3 tech shop this converts a zero-maintenance signal into an ongoing manual data-entry burden, and "derive required_skill_keys at intake" adds new coupling into the intake pipeline for marginal benefit. → **Fix:** Keep soft skill-history as the default ranking signal; make hard eligibility opt-in per org and start with a single epa_608 boolean plus an admin toggle, not a full skills/cert matrix with expiry.
- _minor_ — The self-identified confidence-gap risk cannot be validated as sequenced. The chapter says MIN_CONFIDENCE_GAP=0.08 "was tuned without travel active" and asks to "validate with a test matrix over travel-present vs -absent jobs" in Phase 0 — but per the blocker, travel is null for all production jobs, so there is no real travel-present distribution to validate the two-regime threshold against until geocoding exists. → **Fix:** Order geocoding first, then run travel-weighted scoring in shadow/log-only mode for a period to observe the real gap distribution before enabling travel-weighted auto-commit.
- _minor_ — Phase 5 auto-reassignment can silently break already-promised customer arrival windows. Re-optimizing a freed slot may shuffle jobs that customers were already told about; the chapter gates behind reoptimize_enabled (default false) but does not address re-notifying the customer or re-confirming the window when the system auto-moves a scheduled job. → **Fix:** On any auto-move of an already-scheduled job, require a customer re-notification and keep human-in-the-loop unless the new time stays within the originally promised window.

---

<a name="2-context-layer"></a>
## 2. The Brain: A Unified Customer/Job Context Layer with Entity Resolution and a 360 View

_Effort: ~7 engineer-weeks · Reviewer verdict: **needs-work**_

## 1. The bar: what a Probook-class product does here

Probook's own wedge is not the dispatch algorithm — it is the **single context layer** wrapped around it: "one customer, one text thread, from first touch → data-scrubbed booking → the right technician → outbound follow-up" (docs/superpowers/plans/2026-06-24-probook-competitive-analysis-and-plan.md). Every agent — the voice booker, the web chat, the lead-scrubber, the dispatcher, the outbound campaign engine — reads and writes the *same* canonical customer record. ServiceTitan formalizes this as a **Customer ↔ Location ↔ Equipment ↔ Job/Invoice ↔ Membership** graph with a hard **Customer-vs-Location** split (one billing payer, many service addresses), plus a de-duplicated identity resolved across phone, email, and address.

The bar has five properties: (a) **one canonical entity per real person/business**, resolved deterministically and probabilistically across noisy inbound identifiers; (b) a **360 read** any agent can call in <50ms that returns history, equipment, memberships, prior calls, invoices, balances, and flags (Do-Not-Service, VIP, unpaid); (c) a **single chronological thread** merging web/voice/SMS/job/estimate/invoice events; (d) **PII-safe projections** — the LLM sees non-identifying facts, humans see full detail, both from one source; (e) **write-back consistency** so a booking, a dispatch, or a payment updates the same record the next agent reads. This is the substrate; get it wrong and every downstream agent hallucinates a different customer.

## 2. Current-state gap analysis — strong bones, three real gaps

This repo is **far past green-field** on identity, and that is its biggest asset.

**What exists and is genuinely good:**
- **Encrypted-at-rest PII with a blind-index dedupe** already solved. `customers` (src/lib/db/schema.ts:676) stores `nameEncrypted/phoneEncrypted/emailEncrypted/addressEncrypted` (AES-256-GCM, random IV) alongside deterministic HMAC `emailHash`/`phoneHash` columns, backed by **partial unique indexes** `customers_org_email_hash_unique` / `customers_org_phone_hash_unique` (schema.ts:747-752). Dedupe is **atomic at the DB layer**: `upsertCustomerByContact` (src/lib/admin/crm-queries.ts:518) uses `onConflictDoUpdate` on the hash index so two concurrent submits for the same contact collide instead of double-inserting — the correct answer under neon-http's no-transaction constraint. Normalization is centralized (`normalizeEmail`/`normalizePhone`/`computeContactHashes`, crm-queries.ts:379-407) so read and write hash identically, with a legacy decrypt-and-compare fallback (crm-queries.ts:460-496) for pre-hash rows.
- **A working "brain" read for agents.** `lookupCustomerContext` / `loadCustomerContextById` (src/lib/ai/customer-context.ts:92,113) return a deliberately minimal, **PII-safe** `CustomerContext` (returning flag, prior-request count, membership, customerType, doNotService, first-name-only) and `buildCustomerContextHint` renders it into the system prompt. Both the **voice path** (src/lib/voice/resolve-voice-identity.ts resolves ANI→customer) and web chat consume it — real cross-channel reuse today.
- **A 360 read for humans.** `getCustomerById` (crm-queries.ts:99) fans out (`Promise.all`) to equipment, notes, follow-ups, and service_history joined to service_requests, rendered at src/app/admin/(dashboard)/customers/[id]/page.tsx.
- **The Customer-vs-Location split is already modeled.** `customer_locations` (schema.ts:2030) with its own `addressHash` blind index and per-customer address-unique index, and `customer_equipment.locationId` + replacement-chain columns (schema.ts:806-810), and `service_history.equipmentId` for a per-asset timeline (schema.ts:892).
- **An event/thread spine exists.** `customer_threads` + `customer_events` (schema.ts:1871-1923) with a fail-open read/append service (src/lib/context/thread.ts) already wired into chat, voice, and request submission (src/app/api/chat/route.ts, src/lib/ai/voice-turn.ts, src/lib/requests/submit-session-request.ts).

**The three real gaps:**

1. **The graph is not unified — it's a star of siloed reads.** `getCustomerById` returns native equipment/notes/history but **not** memberships, estimates, invoices, payments, balances, or the customer_events thread. `lastServiceDate` is **hardcoded `null`** (crm-queries.ts:217). HCP service history is bolted on only in the chat/voice enrichment path (`enrichWithServiceHistory`, customer-context.ts:189), never in the human 360. There is no single "load everything about this customer" module — each surface hand-rolls its own subset.

2. **Entity resolution is exact-match only.** Dedupe keys on **exact normalized email OR exact digits-only phone**. It cannot merge "555-123-4567 from voice" with "john@x.com from web" for the same human, cannot fuzzy-match names/addresses, has **no merge operation** for duplicates that slip through (the ON-CONFLICT edge case at crm-queries.ts:511-516 explicitly leaves rare dupes), and has **no cross-source identity map** — `hcpCustomerId`/`fieldpulseCustomerId` are 1:1 columns, not a general external-id table. Address is never used as an identity signal despite `customer_locations.addressHash` existing.

3. **No unified profile projection contract.** Each agent re-queries. There's no single `loadCustomerProfile()` that the dispatcher, outbound engine, and QA classifier all call, and no derived/rollup fields (lifetime value, open-balance, churn-risk, last-tech) — so "the brain every agent reads" is really "the fields chat happens to need."

## 3. Target architecture + data model

**Principle: one loader, one projection, one merge — additive to the existing tables.**

**New table `customer_external_ids`** (generalizes the 1:1 HCP/FP columns into an identity map):
```
customer_external_ids(id, organization_id, customer_id→customers,
  source text,        -- 'hcp' | 'fieldpulse' | 'stripe' | 'servicetitan'
  external_id text,
  UNIQUE(organization_id, source, external_id))
```
Keep `hcpCustomerId`/`fieldpulseCustomerId` as-is (do not break the invoice-mirror guards); backfill this table from them and dual-write. This lets one customer carry many source ids and future sources without a migration each.

**New table `customer_merges`** (audit + reversibility for dedupe):
```
customer_merges(id, organization_id, surviving_customer_id, merged_customer_id,
  merged_snapshot jsonb,  -- full de-dup'd copy for undo
  reason text, actor_type, actor_id, created_at)
```

**New identity columns on `customers`** (additive): `nameHash text` (HMAC over normalized name for candidate fuzzy-blocking — not unique), and reuse `customer_locations.addressHash` as a third identity signal. No new PII stored.

**New derived/rollup columns on `customers`** (maintained by write-back, not read-time compute): `lastServiceAt timestamptz`, `lifetimeValueCents integer`, `openBalanceCents integer`, `lastTechnicianId uuid`. These make the 360 and dispatch reads O(1) and kill the hardcoded-null.

**New module `src/lib/customer/profile.ts`** — the single loader. `loadCustomerProfile(orgId, customerId, opts)` returns a `CustomerProfile` that composes, via one `Promise.all`: the customer row, locations, equipment (by location), memberships (`customer_memberships` join `membership_plans`), the `customer_events` thread (via `getThread`), native invoices + balances, estimates, and — best-effort, degrade-safe like `enrichWithServiceHistory` — mirrored HCP/FP history. This is the human 360 **and** the agent brain, with a `projection: 'pii' | 'agent'` flag: `'agent'` reuses the exact PII-safe rules already in `buildCustomerContextHint` (first-name-only, counts/enums/flags, no raw contact).

**New module `src/lib/customer/resolve.ts`** — layered entity resolution: (1) exact blind-index (existing `findCustomerIdByContact`), (2) **candidate blocking** on `nameHash`/`addressHash`/partial-phone, (3) a deterministic scorer (email match=strong, phone=strong, name+address=medium) that returns `{customerId, confidence}`; auto-link above a high threshold, queue for human review below. This wraps, never replaces, the existing atomic upsert.

**New module `src/lib/customer/merge.ts`** — `mergeCustomers(orgId, surviving, merged)` re-points all FK children (service_requests, service_history, customer_equipment, customer_notes, follow_ups, customer_locations, customer_events/threads, invoices, estimates, memberships, external_ids) to the survivor and writes `customer_merges`, all via **`db.batch()`** (neon-http has no interactive transactions — MEMORY: neon-http-no-transactions).

**Endpoints:** `GET /api/admin/customers/[id]/profile` (full 360 JSON); `GET /api/admin/customers/duplicates` (review queue from the scorer); `POST /api/admin/customers/[id]/merge`. The `customer_events` write-back is already the seam — extend `appendEvent` callers to also bump the new `customers` rollups.

## 4. Phased build plan

**Phase 0 — Unify the read (no schema change, ship first).** Create `src/lib/customer/profile.ts` `loadCustomerProfile` that composes the existing reads plus memberships/invoices/estimates/thread, and fixes `lastServiceDate` by deriving `MAX(service_history.created_at)` in the same fan-out. Point `getCustomerById` and the admin detail page at it. Touches: crm-queries.ts, new profile.ts, customers/[id]/page.tsx. Shippable: the human 360 becomes complete. (~1 wk)

**Phase 1 — Rollup columns + write-back.** Migration adds `lastServiceAt/lifetimeValueCents/openBalanceCents/lastTechnicianId` to `customers`. Maintain them where events already fire: `submit-session-request.ts`, invoice/payment write paths, `service_history` insert — bump the rollup in the same `db.batch`. Run `npm run db:migrate` post-deploy (MEMORY: migrations-not-run-on-deploy). Backfill script mirrors backfill-customer-hashes.ts. (~1 wk)

**Phase 2 — External-id map.** Migration adds `customer_external_ids` + `customer_merges`; backfill from `hcpCustomerId`/`fieldpulseCustomerId`; dual-write in the two `customer-sync.ts` files. Non-breaking (old columns stay authoritative for the mirror guards). (~1 wk)

**Phase 3 — Fuzzy resolution + review queue.** Add `nameHash` column + backfill. Build `src/lib/customer/resolve.ts` (blocking + deterministic scorer) and `GET /api/admin/customers/duplicates`. No auto-merge yet — surface candidates only. (~1.5 wk)

**Phase 4 — Merge operation.** `src/lib/customer/merge.ts` (batched FK re-point + `customer_merges` audit + reversible snapshot), `POST /.../merge`, admin merge UI. Gate behind a super_admin action; audit via existing `auditLog` with `actorType`. (~1.5 wk)

**Phase 5 — Agent projection contract.** Refactor `lookupCustomerContext`/`resolveVoiceIdentity` to call `loadCustomerProfile(..., {projection:'agent'})` so voice, chat, dispatch, and outbound read one brain. Extend the agent projection with membership perks, open-balance flag, and last-tech for continuity ("your usual tech, Dave"). (~1 wk)

## 5. Effort, risks, reuse-first

**Total ≈ 7 engineer-weeks.** Reuse-first is the whole point here — this domain is 60% built.

**Do NOT build:** a new PII/crypto layer (src/lib/crypto.ts + blind-index is done and correct); a new dedupe primitive (the atomic `onConflictDoUpdate` upsert is the right pattern — layer fuzzy matching *around* it, never rip it out); a new event store (`customer_events`/thread.ts fail-open service is solid — just add write-back callers); a probabilistic ML matcher (a deterministic weighted scorer over email/phone/name/address is sufficient for HVAC-scale tenants and auditable — ML entity resolution is over-engineering here). Do not blend native and synced money in rollups (MEMORY: invoice mirrors are read-only, multi-source guards) — compute `openBalanceCents` from native invoices only, mirror synced separately.

**Risks:** (1) **Merge is destructive and un-transactional** — neon-http `db.batch` gives atomicity for the FK re-point, but a partial failure needs the `customer_merges` snapshot for manual recovery; keep merge super_admin-gated and always reversible. (2) **GDPR erasure interaction** — `anonymizedAt` rows (schema.ts:740) must be excluded from fuzzy-match candidates and never resurrected by a merge; the scorer must skip anonymized rows. (3) **Rollup drift** — write-back rollups can desync; ship a nightly reconciler (reuse the demand/revenue-daily cron pattern) that recomputes from source. (4) **Fuzzy false-positives merge two real people** — mitigate with a high auto-link threshold and human review below it; never auto-merge on name+address alone. (5) **Tenant isolation** — every new query MUST use `withTenant` (as all existing ones do); the review queue and merge are the highest-risk cross-tenant leak surface.

**Key gaps vs. Probook-class:**

- Unified graph read: getCustomerById omits memberships, estimates, invoices, payments, balances, and the customer_events thread; lastServiceDate is hardcoded null (crm-queries.ts:217). No single loadCustomerProfile() every agent calls.
- Entity resolution is exact-match only (exact email OR exact digits-phone). No fuzzy name/address matching, no cross-signal linking (voice phone + web email = same human), no address-as-identity despite addressHash existing.
- No merge operation for duplicates that slip past the ON-CONFLICT single-arbiter edge case (crm-queries.ts:511-516); no reversible merge audit.
- No general external-id identity map — hcpCustomerId/fieldpulseCustomerId are 1:1 columns, not a source-scoped table; adding a source needs a migration.
- No derived/rollup fields (lifetime value, open balance, last service, last tech, churn risk) — every read recomputes or returns null.
- Agent projection contract is ad hoc: voice/chat build CustomerContext, but dispatch/outbound/QA don't share one brain; no membership-perk / open-balance / last-tech continuity in the agent view.
- customer_events thread exists but is not surfaced in the human 360 nor merged with HCP/FP history into one chronological timeline.

**Phased build:**

- **Phase 0 — Unify the read** — src/lib/customer/profile.ts loadCustomerProfile composes existing reads + memberships/invoices/estimates/thread; derive real lastServiceDate. Repoint getCustomerById + admin detail page. No schema change, ships first. ~1wk.
- **Phase 1 — Rollup columns + write-back** — Migration adds lastServiceAt/lifetimeValueCents/openBalanceCents/lastTechnicianId to customers; maintain in existing event write paths via db.batch; backfill script; run db:migrate post-deploy. ~1wk.
- **Phase 2 — External-id map** — Migration adds customer_external_ids + customer_merges; backfill from hcp/fieldpulse columns; dual-write in both customer-sync.ts. Non-breaking (old columns stay authoritative for mirror guards). ~1wk.
- **Phase 3 — Fuzzy resolution + review queue** — Add nameHash + backfill; src/lib/customer/resolve.ts (blind-index blocking + deterministic weighted scorer over email/phone/name/address); GET /api/admin/customers/duplicates surfaces candidates. No auto-merge. Skip anonymized rows. ~1.5wk.
- **Phase 4 — Merge operation** — src/lib/customer/merge.ts batched FK re-point across all child tables + reversible customer_merges snapshot; POST /.../merge; super_admin-gated admin UI; audit via existing auditLog. ~1.5wk.
- **Phase 5 — Agent projection contract** — Refactor lookupCustomerContext/resolveVoiceIdentity onto loadCustomerProfile({projection:'agent'}) so voice, chat, dispatch, outbound read one brain; add membership perks, open-balance flag, last-tech continuity. ~1wk.

**Adversarial review findings:**

- _major_ — Headline capability vs. the encryption design it praises. Section 2 lists "cannot fuzzy-match names/addresses" as a gap and Section 3 proposes fixing it with `nameHash text (HMAC over normalized name for candidate fuzzy-blocking)` plus reusing `addressHash`. But an HMAC is an EXACT hash: it can only block on exact normalized-name/address equality, not typos ("Jon"/"John", "St"/"Street"). Names/addresses are encrypted at rest with a random IV (verified: customers.nameEncrypted/addressEncrypted, customer_locations.addressEncrypted), so genuine similarity scoring is impossible without decrypting each candidate — the same decrypt-and-compare scan the code already uses as its legacy fallback (crm-queries.ts:460-496). The plan's data model as written ("just add nameHash") does not deliver the stated "fuzzy-match names" goal, and the word "fuzzy-blocking" conflates exact-hash blocking with fuzzy matching. → **Fix:** Reframe: block on EXACT signals (nameHash, addressHash, phoneHash, partial-phone), then DECRYPT the small blocked candidate set inside resolve.ts and run true string-similarity (Levenshtein/Jaro/soundex) on plaintext there. Spell out the decrypt-to-score step in Phase 3 and drop the "fuzzy-blocking" framing — blocking is exact, fuzziness comes from combining weak signals over a decrypted candidate set.
- _major_ — Denormalized `openBalanceCents`/`lifetimeValueCents` rollups are drift-prone and premature. Section 3 proposes these as write-back columns "maintained by write-back, not read-time compute" to make reads O(1). But invoice/payment state changes happen across many paths, INCLUDING webhook-driven read-only PULLs of FieldPulse/HCP invoices (verified: invoices.customerId, fieldpulse/hcp invoice-mirror memories) that do NOT flow through a native write that could bump the rollup. Any missed path silently drifts a money number the agent then quotes to a customer ("your balance is $0" while a synced invoice is open). The chapter itself flags the native-vs-synced no-blend guard but that guard makes the rollup HARDER, not safer. Contradicts Simplicity-First: a per-customer indexed SUM over invoices is already well under the 50ms bar, so the denormalization buys little and adds a whole consistency surface. → **Fix:** Compute open-balance and lifetime-value at read time in loadCustomerProfile via an indexed SUM scoped to the customer (cheap for one customer). If a rollup is truly wanted for dispatch-board scans, keep ONLY lastServiceAt (low-stakes, easy: MAX(service_history.created_at)) and lastTechnicianId as denormalized, and add a nightly reconcile job — do NOT denormalize money that mutates via external webhooks.
- _minor_ — The <50ms agent-brain bar (Section 1) is in tension with the single-loader design (Section 3). loadCustomerProfile composes "best-effort mirrored HCP/FP history" — a network round-trip. The existing enrichWithServiceHistory is explicitly kept OFF the critical reply path (its own doc comment says so, customer-context.ts:189+), but the proposed unified loader that "is the human 360 AND the agent brain" would fold that external call into one function whose agent projection is supposed to answer in <50ms. → **Fix:** Make the external HCP/FP fetch strictly opt-in via opts (e.g. includeSyncedHistory: default false), off by default for the projection:'agent' path so the low-latency read stays purely native; only the human 360 endpoint sets it true, and even then via after()/non-blocking as the existing code already does.
- _minor_ — `customer_external_ids` is speculative generality for the current single-shop reality. The plan keeps hcpCustomerId/fieldpulseCustomerId as "authoritative for the mirror guards" and only dual-writes the new table, which for a shop connected to at most one PSA carries zero information the 1:1 columns don't already hold. Per the repo's own coding-style rule ("no flexibility/configurability that wasn't requested"), the general identity-map table is YAGNI until a customer actually carries two source ids. → **Fix:** Defer customer_external_ids (Phase 2) until a concrete second-source-per-customer need lands (e.g. Stripe + a PSA). It is cheap and non-breaking, so this is a sequencing note, not a redesign — just don't spend a week on it ahead of demand.
- _minor_ — Merge phase effort is optimistic. Phase 4 (1.5 wk) must re-point ~11 FK child tables (verified they exist: service_requests, service_history, customer_equipment, customer_notes, follow_ups, customer_locations, customer_events, customer_threads, invoices, estimates, customer_memberships), each tenant-scoped, plus a reversible merged_snapshot, super_admin gating, audit via auditLog, AND a merge UI — with tests. db.batch is correctly chosen (verified: used in provisioning/estimate/membership queries; neon-http has no interactive txns), but the surface is larger than 1.5 wk implies, especially reversibility (un-merge must re-split re-pointed rows, which the snapshot alone doesn't trivially enable). → **Fix:** Either budget ~2.5 wk for Phase 4 or scope v1 to forward-only merge (audit + snapshot for record, no automated un-merge) and state that undo is manual/deferred. Confirm the customer_threads unique(org,customer) index (verified schema.ts:1888) is handled on merge — two survivors' threads collide and must be consolidated, not just re-pointed.

---

<a name="3-voice-ai"></a>
## 3. Voice AI: From Turn-Based IVR Replacement to Full-Duplex Booking + Outbound Revenue Calls

_Effort: ~20 engineer-weeks · Reviewer verdict: **needs-work**_

## 1. The Probook/Avoca bar

A Probook-class voice agent is the front door to the business and it never sends a caller to voicemail. Inbound: it answers on the first ring 24/7, greets by name when it recognizes the ANI, holds a natural full-duplex conversation (the caller can interrupt mid-sentence — barge-in — and the bot stops talking), disambiguates the problem, scrubs the lead (address, urgency, system type, membership), offers *real* open appointment windows, and books the job into the FSM before hanging up. It replaces the phone tree entirely: no "press 1 for service." When it can't book (commercial, do-not-service, angry customer) it warm-transfers to a human with full context already gathered. Latency budget is brutal: sub-800ms from end-of-caller-speech to first audio, or the call feels robotic and callers hang up.

Outbound is the revenue moat Avoca actually sells: AI *calls out* to reactivate aged leads, follow up on unsold estimates, confirm/reschedule appointments, run membership-renewal and maintenance-due campaigns, and — the highest-value one — **missed-call callback within seconds** (a missed call to a home-services business is a $300+ lost job). Outbound needs answering-machine detection (AMD) so it leaves a voicemail vs. talks to a human, compliance (TCPA quiet-hours, consent, DNC), and campaign orchestration (who to call, when, retry logic, disposition tracking).

Under all of it sits call recording, transcription, per-call QA scoring, and retention/TTL compliance — you cannot run real call volume without it.

## 2. Current-state gap analysis

This repo has a genuinely strong **inbound turn-based** voice agent — the competitive plan rates it "HAVE (strong)" at `docs/superpowers/plans/2026-06-24-probook-competitive-analysis-and-plan.md:102`. What exists:

- **Two thin TwiML adapters.** `src/app/api/voice/incoming/route.ts` verifies the Twilio signature, creates a `phone`-channel `customerSessions` row keyed on `CallSid` (the globally-unique call id doubles as the session token, so `/gather` turns re-find it with no mapping table), persists the greeting, and returns a `<Gather>`. `src/app/api/voice/gather/route.ts` loads the session, runs one utterance through the agent, and returns the next `<Gather>` or a hangup.
- **A rich voice persona over the shared brain.** `src/lib/ai/voice-turn.ts` (1,036 lines) reuses the *same* deterministic `routeMessage` intent router, slot extraction, state machine (`determineNextState`), and safety guardrail (`screenAssistantReply`) as web chat — it's a voice adapter, not a second brain. It handles: do-not-service early gate, ANI-based returning-customer recognition, financial-account **ZIP verification** over DTMF (`<Gather input="dtmf speech" numDigits="5">`, engine `advanceVerify`), after-hours charge disclosure, spoken-address/spoken-phone extraction quirks (Twilio transcription drops commas/ZIPs), token-budget degradation, escalation, and **auto-submit** on intake completion (voice has no "Confirm" button, so completion creates the service request through the shared `submitSessionServiceRequest`).
- **TTS with graceful degradation.** `src/lib/voice/twiml.ts` + `src/lib/voice/elevenlabs.ts` + `src/app/api/voice/tts/route.ts`: ElevenLabs "Brian" (turbo_v2_5, `mp3_22050_32` narrowband) synthesized to a signed, HMAC-tokened `<Play>` URL, with a Polly-Neural `<Say>` default when no key is set. `resolveVoiceMode` (`src/lib/voice/request.ts`) picks the mode per request.
- **ANI identity.** `src/lib/voice/resolve-voice-identity.ts` resolves `From` to a customer via the blind-index lookup, degrading to null on withheld caller-ID.
- **Warm transfer.** `dialThenHangupTwiML` + the `voiceTransferNumber` org setting (`src/lib/db/schema.ts:1014`) `<Dial>`s a human on escalation.

**What's missing (the gaps):**

1. **No barge-in / full-duplex.** Everything is `<Gather>`/`<Say>` request-response. The caller cannot interrupt; every turn pays a synthesis + LLM round-trip of dead air. There is zero `<Connect><Stream>`/Media-Streams/ConversationRelay code anywhere in `src/` (verified: no websocket references). This is the single biggest UX gap vs. Avoca and, per `docs/superpowers/plans/2026-06-25-avoca-stages-21-40-advanced-layer.md:15`, requires **off-Vercel infra** because Vercel serverless can't hold a long-lived socket.
2. **Hardcoded single tenant.** `incoming/route.ts:60` sets `organizationId = DEMO_ORG_ID`. There is no mapping from the dialed number (`To`) → org, so the platform can only serve one business's phone line. Multi-tenant number routing is a prerequisite for *any* real customer.
3. **No outbound voice at all.** No `CreateCall` usage, no campaign runner, no missed-call callback, no AMD, no call/campaign tables in `schema.ts`. Outbound is 100% greenfield.
4. **No call recording / transcript retention.** Turns land in `messages`, but there's no `<Record>`, no `RecordingUrl` capture, no dedicated calls table, no retention/TTL. QA and compliance both need this.
5. **Booking is intake, not scheduling.** `fetchVoiceWindowQuestion` *offers* real availability windows, but auto-submit creates a service *request* for humans to schedule — it doesn't lock a calendar slot on the call. Probook books on the call.
6. **Latency unmeasured.** Synthesis is a per-turn blocking fetch inside the request; no streaming TTS, no first-token optimization, no latency telemetry.

## 3. Target architecture + data model

Keep the turn-based path as the **Vercel-hosted default and fallback**; layer real-time as an opt-in gateway. Two deployment planes:

- **Plane A (Vercel, exists):** `/api/voice/*` turn-based. Extend for multi-tenancy, outbound, recording.
- **Plane B (off-Vercel worker, new):** a long-lived Node/WS service (Fly.io/Render) fronting Twilio `<Connect><Stream>` for full-duplex + barge-in. Reuses `voice-turn.ts`'s decision core via an internal HTTP call or shared package so there is still **one brain**.

New tables (Drizzle, neon-http → `db.batch`/guarded UPDATE, no transactions):

- `phone_numbers` — `id`, `organizationId`, `e164` (unique), `label`, `inboundEnabled`, `outboundCallerId`. The `To`-number → org router.
- `voice_calls` — `id`, `organizationId`, `callSid` (unique), `direction` (`inbound`|`outbound`), `fromE164`, `toE164`, `sessionId` (fk `customerSessions`), `customerId`, `status`, `startedAt`, `endedAt`, `durationSec`, `recordingUrl`, `recordingSid`, `disposition` (`booked`|`transferred`|`voicemail`|`no_answer`|`abandoned`), `deleteAfter` (retention TTL).
- `outbound_campaigns` — `id`, `organizationId`, `type` (`missed_call`|`unsold_estimate`|`reactivation`|`appointment_confirm`|`maintenance_due`), `status`, `scriptConfig` (jsonb), `quietHours`, `maxAttempts`.
- `outbound_call_tasks` — `id`, `campaignId`, `organizationId`, `customerId`, `targetE164`, `state` (`queued`|`calling`|`done`|`failed`|`suppressed`), `attempts`, `nextAttemptAt`, `dispositionReason`, `callSid`. This is the work queue.

New endpoints: `/api/voice/status` (Twilio status-callback → close `voice_calls`, capture recording, fire QA), `/api/voice/amd` (AMD result for outbound), `/api/voice/outbound/twiml` (TwiML for an outbound leg), `/api/cron/outbound-dialer` (drains `outbound_call_tasks`, respects quiet-hours/consent), `/api/webhooks/twilio/missed-call` (inbound-status → enqueue callback).

## 4. Phased build plan

**Phase 0 — Multi-tenant number routing (unblocks everything).** Add `phone_numbers` table + migration. Replace `DEMO_ORG_ID` in `incoming/route.ts` and `gather/route.ts` with a lookup on `params.To` → `phone_numbers.e164` → `organizationId`, degrading to `DEMO_ORG_ID` only when a single number is configured (back-compat). Touches: `schema.ts`, new `src/lib/voice/resolve-org-by-number.ts`, both voice routes. Ship: one platform serves N businesses' lines. ~1 wk.

**Phase 1 — Call recording + retention + status callback.** Add `voice_calls` table. Add `record="record-from-answer-dual"` + `recordingStatusCallback` to the inbound `<Dial>`/call, and a `statusCallback` on the initial TwiML. New `/api/voice/status` closes the `voice_calls` row, stores `recordingUrl`/`recordingSid`, sets `disposition` from final state, and stamps `deleteAfter`. New `/api/cron/purge-recordings` enforces TTL (the storage-limitation duty, `avoca-stages-21-40:52`). Wire the existing booking-outcome QA classifier (commit `dbbb2a6`) to fire on call close. Touches: `schema.ts`, both voice routes, new status/cron routes. ~1.5 wks.

**Phase 2 — Outbound: missed-call callback (highest ROI, Vercel-friendly).** This needs no websocket — it's `CreateCall` + the existing turn-based `/gather` brain. Add `outbound_campaigns` + `outbound_call_tasks`. Inbound `/api/voice/status` with `no-answer`/`busy`/short-abandoned enqueues a `missed_call` task. `/api/cron/outbound-dialer` (runs every minute via Vercel cron, uses `after()` not detached promises per the serverless-freeze rule) drains the queue: checks consent + quiet-hours (reuse the comms-queue consent module), calls `mcp/Twilio CreateCall` with `machineDetection="Enable"` pointing at `/api/voice/outbound/twiml`, which greets ("Hi, we saw we missed your call…") and hands into the *existing* `voiceReply` intake flow. `/api/voice/amd` routes machine-answers to a voicemail drop. Touches: `schema.ts`, new outbound routes + dialer cron, small `voice-turn.ts` outbound-greeting variant. ~2.5 wks.

**Phase 3 — Outbound campaigns (revenue moat).** Generalize the dialer to `unsold_estimate` / `reactivation` / `appointment_confirm` / `maintenance_due` campaign types, sourcing targets from `invoices`/estimates/job history (the same signals the outbound-unsold-estimates plan uses). Add per-campaign `scriptConfig`, retry/backoff via `nextAttemptAt`, disposition analytics, and a suppression list (DNC + do-not-service + recently-contacted). Admin UI to launch/monitor campaigns. Touches: dialer cron, new `src/lib/voice/campaigns/*`, admin pages. ~3 wks.

**Phase 4 — Real-time gateway (barge-in) [GATE: off-Vercel infra].** Stand up Plane B: a Fly.io Node WS service. Inbound TwiML becomes `<Connect><Stream>` to `wss://voice-gw.…`. The gateway pipes caller audio → streaming STT (Deepgram) → **the same decision core** (call `voiceReply` over internal HTTP so the brain stays single-sourced) → streaming ElevenLabs TTS back over the socket, cutting TTS on detected caller speech (barge-in). Keep the turn-based path as automatic fallback when the gateway is unhealthy (Twilio `<Connect>` failover). This is the Avoca differentiator and the hard part (`avoca-stages-21-40:23`). Touches: new repo/service, `incoming/route.ts` (emit `<Connect>` when a per-org flag is on), shared decision package. ~5–6 wks + ongoing infra/observability (Phase 40 hardening).

## 5. Effort, risks, reuse-first

**Reuse, don't build:** the decision core (`voice-turn.ts`) already unifies router/state-machine/guardrail/verify/after-hours — every new surface (outbound, real-time) must call *it*, never fork it, or the two-brain drift the code comments repeatedly warn about (`voice-turn.ts:145`) becomes real. Reuse the existing consent/quiet-hours comms module for outbound TCPA compliance, the blind-index identity lookup for ANI/target resolution, the booking-outcome QA classifier (already merged) for call scoring, and `submitSessionServiceRequest` for any booking write. Use Twilio's built-in **AMD and `<Record>`** rather than hand-rolling voicemail detection or a media recorder. Prefer Deepgram/AssemblyAI hosted STT over self-hosted in Phase 4.

**Do NOT build:** a custom telephony stack, self-hosted TTS, a bespoke campaign scheduler (drive it off Vercel cron + a DB work queue), or a second conversational brain for outbound.

**Risks:** (1) **neon-http has no transactions** — every multi-write (enqueue task + mark suppressed, close call + capture recording) must be `db.batch` or a guarded conditional UPDATE, and the outbound dialer must claim tasks with a `WHERE state='queued'` guarded update to avoid double-dialing under concurrent cron. (2) **Vercel can't do real-time** — Phase 4 is explicitly gated on willingness to run off-Vercel infra; if that's a no, real-time voice is impossible and the plan tops out at Phase 3 (still a strong, revenue-generating product). (3) **TCPA/quiet-hours are legal, not cosmetic** — outbound without hardened consent + DNC + quiet-hours is a liability; gate Phase 2/3 launch on it. (4) **Recording retention** is a compliance duty (storage limitation) and a cost center — TTL purge (Phase 1) is not optional. (5) **Latency** on the turn-based path is already marginal; monitor before assuming Phase 4 is needed for a given customer.

Total: ~13–17 engineer-weeks through Phase 3 (shippable, monetizable), plus ~6+ for the real-time gateway.

**Key gaps vs. Probook-class:**

- No barge-in / full-duplex: 100% turn-based <Gather>/<Say>; no <Connect><Stream>/Media-Streams/ConversationRelay anywhere (needs off-Vercel websocket infra)
- Hardcoded single tenant: incoming/route.ts uses DEMO_ORG_ID with no dialed-number (To) -> org routing, so only one business's line can be served
- No outbound voice at all: no CreateCall, no missed-call callback, no campaign runner, no AMD, no call/campaign tables
- No call recording, transcript retention, or retention/TTL purge (turns land only in messages; no <Record>/RecordingUrl/voice_calls table)
- Books an intake request, not a calendar slot: fetchVoiceWindowQuestion offers real windows but auto-submit creates a service request for humans to schedule rather than locking the appointment on the call
- Per-turn synthesis round-trip with no streaming TTS and no latency telemetry; unmeasured against the sub-800ms bar
- No voicemail detection / AMD and no voicemail-drop path for outbound legs

**Phased build:**

- **Phase 0 — Multi-tenant number routing** — Add phone_numbers table + migration; replace DEMO_ORG_ID in incoming/gather routes with a To-number -> organizationId lookup (new resolve-org-by-number.ts), back-compat single-number fallback. Unblocks serving N businesses. ~1 wk.
- **Phase 1 — Call recording + retention + status callback** — Add voice_calls table; add record + recordingStatusCallback + statusCallback to TwiML; new /api/voice/status closes the call row, captures recordingUrl/disposition, stamps deleteAfter; /api/cron/purge-recordings enforces TTL; fire the existing booking-outcome QA classifier on call close. ~1.5 wks.
- **Phase 2 — Outbound missed-call callback (Vercel-friendly)** — Add outbound_campaigns + outbound_call_tasks; inbound no-answer/abandoned enqueues a missed_call task; /api/cron/outbound-dialer drains it (consent + quiet-hours), CreateCall with machineDetection into /api/voice/outbound/twiml handing to the existing voiceReply brain; /api/voice/amd handles voicemail drop. Guarded WHERE state='queued' claim to prevent double-dial. ~2.5 wks.
- **Phase 3 — Outbound campaigns (revenue moat)** — Generalize dialer to unsold_estimate/reactivation/appointment_confirm/maintenance_due, sourcing targets from invoices/estimates/job history; per-campaign scriptConfig, retry/backoff, suppression (DNC + do-not-service + recently-contacted), disposition analytics, admin launch/monitor UI. ~3 wks.
- **Phase 4 — Real-time gateway with barge-in [GATE: off-Vercel infra]** — Stand up an off-Vercel Fly/Render Node WS service fronting Twilio <Connect><Stream>: caller audio -> streaming STT -> the SAME voiceReply decision core over internal HTTP -> streaming ElevenLabs TTS with barge-in cut; keep turn-based path as automatic failover. The Avoca differentiator; hardest part + ongoing observability/cost hardening. ~5-6 wks.

**Adversarial review findings:**

- _major_ — The reuse claim for outbound TCPA compliance is broken by the actual consent module's defaults. Chapter §4 Phase 2 says the dialer 'checks consent + quiet-hours (reuse the comms-queue consent module)' and §5 says 'Reuse the existing consent/quiet-hours comms module for outbound TCPA compliance.' The real module (src/lib/communication/consent.ts) has DEFAULT_PREFS.voiceEnabled: false, so checkSendAllowed({channel:'voice'}) returns allowed:false (reason channel_disabled:voice) for ANY customer without an explicit voice opt-in — which is essentially every missed caller. That suppresses ~100% of missed-call callbacks, killing the feature the chapter calls 'the highest-value one.' Conversely, a brand-new missed caller has no customer record, so customerId is null and the module returns allowed:true with NO consent check at all — bypassing consent exactly where the referenced avoca plan flags a legal GATE (stage 27, 'lawful basis to call an inbound number that never consented'). The module supports a 'voice' channel and quiet-hours (so the structural reuse is real), but its defaults/semantics are wrong for cold outbound and the chapter treats reuse as solved. → **Fix:** Do not route outbound missed-call/campaign consent through checkSendAllowed as-is. Define an explicit outbound-voice basis: (a) a returned-call/opt-in rule for missed callers (the returned-call TCPA footing) rather than the customer-pref voiceEnabled gate, (b) deny-by-default for the null-customer path instead of allowed:true, and (c) either flip voiceEnabled semantics for the returned-call case or add a distinct trigger rule. Surface this as the Phase 2/27 legal GATE the avoca plan already calls out, not a one-line reuse.
- _major_ — The headline ROI feature's latency contradicts its own proposed mechanism. §1 sells 'missed-call callback within seconds (a missed call ... is a $300+ lost job)' as the highest-value outbound play, but §4 Phase 2 implements it as: status webhook enqueues a missed_call task, then '/api/cron/outbound-dialer (runs every minute via Vercel cron ...) drains the queue.' A per-minute cron is the finest Vercel granularity, so callback latency is up to ~60s + drain/CreateCall time — not 'within seconds.' (All 11 existing crons in vercel.json run once daily, and Vercel cron minimum is 1 minute even on Pro.) The mechanism cannot meet the stated bar. → **Fix:** Fire the callback inline from /api/voice/status via after() (kick CreateCall immediately when status is no-answer/busy/short-abandon), and keep /api/cron/outbound-dialer only as the retry/backstop sweep for failed/queued tasks and for scheduled campaigns. The chapter already mandates after() elsewhere — apply it to the missed-call hot path so 'within seconds' is actually achievable.
- _minor_ — Imprecise line citation. §5 says every surface must call the decision core 'never fork it, or the two-brain drift the code comments repeatedly warn about (voice-turn.ts:145)' becomes real. voice-turn.ts:145 is actually the VOICE_SUBMITTED_REPLY / auto-submit comment, not a two-brain warning. The one-brain reuse point is genuinely supported by the code (e.g. voice-turn.ts:369 '... the SAME engine (advanceVerify)'), so the argument holds, but the specific line reference is wrong. → **Fix:** Repoint the citation to voice-turn.ts:369 (or the actual 'SAME engine'/single-brain comments) so the reference backs the claim it's attached to.

---

<a name="4-messaging-ai"></a>
## 4. The Messaging Brain: One Conversational Core Across Web Chat, SMS, and Voice

_Effort: ~29 engineer-weeks · Reviewer verdict: **needs-work**_

## 1. The bar: what a Probook-class messaging agent does

A Probook/Avoca-class messaging agent is not a chatbot bolted onto a website. It is a single conversational operating system that (a) answers HVAC questions and triages symptoms, (b) qualifies and scrubs the lead (is this a real, in-territory, serviceable job?), (c) **books the appointment on the spot** — writing a real capacity hold, not "our team will follow up", (d) runs on **every text channel with one brain** (web widget, SMS/MMS, WhatsApp) so a customer who starts on the site and finishes over text never repeats themselves, (e) accepts **photos** (a nameplate model number, a frosted coil) and uses them in triage, (f) runs **outbound** conversational campaigns (reminders, "you're overdue for a tune-up", review requests, unsold-estimate follow-ups) that a human can seamlessly take over, and (g) is **self-improving** — the questions it fumbles today become deterministic intents tomorrow. Safety and revenue are both non-negotiable: never quote a price it can't honor, never fabricate a booking, never give dangerous DIY instructions, never leak one customer's account data to another.

## 2. Current-state gap analysis — strong but forked into three brains

This codebase already has the best-in-class *shape* of the brain. `src/app/api/chat/route.ts` (2,218 lines) is a genuine hybrid: a deterministic scored-keyword router (`routeMessage` in `src/lib/ai/intent-router.ts`) resolves common turns for **0 LLM tokens**, with an LLM fallback via `streamText`. The router is disciplined — emergency short-circuit before any org config (lines 392–411), a `requiredQualifiers` guard so a bare "gas" never trips the gas-leak intent, a compound-message detector that punts multi-intent turns, confidence bands (`ACT_THRESHOLD` 0.7 / `LOW_HARM_THRESHOLD` 0.45 / `EMERGENCY_THRESHOLD` 0.25 in `intent-router.ts`), and deterministic ambiguity probes (`AMBIGUITY_PROBES`). The knowledge base (`src/lib/ai/knowledge-base.ts`, ~53 intents) is safety-authored. The **output guardrail** (`src/lib/ai/output-guardrail.ts`) is the crown jewel: `screenAssistantReply` buffers the whole LLM reply and regex-screens it for `PRICE_REGEX`/`PRICE_WORD_REGEX`, `FALSE_BOOKING_REGEX`, `DANGEROUS_DIY_REGEX`, and `CREDENTIAL_REGEX`, substituting a safe on-brand reply — and the same detectors back the CI eval so runtime and gate can't drift. Input is screened by `sanitizeInput` (`src/lib/ai/guardrails.ts`) with hard/soft severity. There is a financial-account **verify gate** (`advanceVerify`, ZIP challenge) that chat and voice share, a do-not-service early gate, repeat-customer recognition (`lookupCustomerContext`), after-hours disclosure, frustration-aware human offers, lead-in warmth, real-availability window prompts (`buildWindowPrompt`), background extraction via `after()`, and telemetry to `bot_events` (`src/lib/db/schema.ts:2833`).

The critical gap is **architectural, not feature-level: there are three brains, not one.**

- **Web chat** runs the rich inline logic in `route.ts` (ambiguity probes, lead-ins, frustration offer, availability windows, attachments, address autocomplete).
- **SMS** (`src/app/api/sms/incoming/route.ts`) does *not* call that logic. It delegates to `voiceReply` (`src/lib/ai/voice-turn.ts`, 1,036 lines) — the **voice persona**. So an SMS customer gets the phone brain, missing the chat-only warmth/probe/window features, and every improvement must be made twice.
- **Voice** is `voice-turn.ts`.

All three re-import the *same primitives* (`routeMessage`, `extractAllContactFields`, `parseKnownSlots`, `mergeSlots`, `screenAssistantReply`, `advanceVerify`) but re-implement the *orchestration*. This is the exact drift the parity-program memory and the probook plan (`docs/superpowers/plans/2026-06-24-probook-competitive-analysis-and-plan.md` §2.4, which marks messaging "HAVE (strong)" but "Lacks a true single-thread-per-customer model") warn about.

Feature gaps that follow from the fork and from being inbound-reactive:

1. **No MMS/photo intake.** `sms/incoming/route.ts` reads only `From`/`Body`; the "empty MMS" comment (line 160) confirms `MediaUrl*`/`NumMedia` are dropped. Web chat *does* handle `attachments`. Photo triage (text a model number) is table-stakes for Probook.
2. **No real booking/hold.** Every code path deliberately refuses to book — `account-tools.ts` says "The bot must not self-book"; `FALSE_BOOKING_REGEX` exists *because* the bot can only offer windows and collect intake. The revenue moat ("book on the call") is absent.
3. **No outbound conversational SMS.** Everything is inbound webhook. No reminders, re-engagement, or unsold-estimate nudges that then thread back into the same brain.
4. **No unified customer thread.** `getThread` gives a cross-channel *hint* only; web sessions key on a cookie token, SMS on `sms:${from}`. There is no `customer_thread` merging voice+SMS+web onto the resolved customer.
5. **English-only router.** `latinAlphaRatio < 0.5` punts non-Latin to the LLM (`intent-router.ts:382`); no Spanish deterministic intents.
6. **Double LLM cost / lag.** The LLM path streams a text reply, then a *separate* async `extractServiceRequest` call re-reads the turn — no tool-calling, so extraction lags 10s+ and costs a second call.
7. **No KB self-improvement loop.** `bot_events` records routed-vs-fallback but nothing mines low-confidence/fallback turns into new intents.

## 3. Target architecture + data model

**One channel-agnostic core.** Extract a single `runConversationTurn(input): TurnResult` module (`src/lib/ai/conversation/run-turn.ts`) that owns the whole orchestration currently inlined in `route.ts`: gates → router dispatch (account/verify/escalate/slot-fill/clarify) → LLM fallback → output guardrail → persistence → telemetry. Inputs are a normalized `TurnContext { channel, sessionRef, history, userMessage, mediaUrls[], addressSelected }`; outputs are `{ reply, nextState, slots, escalated, actions[] }`. The three routes become **thin adapters**: `route.ts` streams the result, `sms/incoming/route.ts` wraps it in TwiML, `voice/gather` shapes it for TTS. `voiceReply` collapses into a `channel:"voice"` persona hook (spoken vs typed copy) inside the core. This is the load-bearing refactor — it kills the fork and makes every later feature ship once.

**Booking action + tool-calling.** Add a `bookingHold` capability the core can invoke when intake is complete and the customer picks a real window from `buildWindowPrompt`. New table `booking_holds` (org-scoped: `id, organizationId, sessionId, customerId, windowStart, windowEnd, status ['held','confirmed','released'], expiresAt`). A hold is a soft capacity reservation against the scheduling seam (`getOpenAvailability`), released by TTL via a cron. Only once a hold is written may the reply say "you're set for Tuesday morning" — so `FALSE_BOOKING_REGEX` gets a **provenance exception**: the guardrail passes booking language *only* when the turn carries a `booking_confirmed` action id (checked in `screenAssistantReply`'s caller, not by loosening the regex). Move the LLM path to **tool-calling** (`generateText` with tools `capture_slots`, `check_availability`, `hold_slot`, `lookup_account`), folding today's separate async extraction into the same call — one round-trip, no 10s lag, structured outputs replace regex extraction.

**MMS/photo.** SMS adapter reads `NumMedia`/`MediaUrl{n}`, downloads via the Twilio-signed URL into the existing `attachments` table (already keyed by session), and passes `mediaUrls` into `TurnContext`. A `photo_triage` step runs vision on nameplate images to extract model/serial into `extras`.

**Unified thread.** New `customer_thread` (`id, organizationId, customerId, lastChannel, lastMessageAt`) plus `thread_messages` appended by every channel on the resolved customer (promote `getThread` from hint to source of truth). Web/SMS/voice sessions become *views* onto one thread.

**Outbound.** New `outbound_campaigns` + `outbound_messages` (`customerId, channel, templateId, scheduledFor, status`), enqueued through the existing consent/quiet-hours layer (`checkSendAllowed`, `classifySmsKeyword`). Inbound replies to an outbound thread route into the *same* `runConversationTurn` core, so a "yes book it" to a reminder is handled by the same brain.

**Self-improvement.** A weekly job clusters `bot_events` where `routed=false` or low confidence, and drafts candidate `knowledge-base.ts` entries for human approval.

## 4. Phased build plan

**Phase 0 — Unify the brain (foundation, no new UX).** Extract `runConversationTurn` core; make `route.ts` and `sms/incoming/route.ts` adapters over it; fold `voiceReply` into a voice persona hook. Golden-transcript parity tests (`src/lib/ai/eval/golden-transcripts.ts`) must pass identically pre/post for all three channels. Ship behind a `UNIFIED_CORE` flag with the old paths as fallback. *Touches:* new `src/lib/ai/conversation/*`, `route.ts`, `sms/incoming/route.ts`, `voice-turn.ts`, `voice/gather/route.ts`.

**Phase 1 — SMS/MMS + chat photo parity.** SMS adapter ingests media into `attachments`; add `photo_triage` extraction. *Touches:* `sms/incoming/route.ts`, `src/lib/sms/*`, new `photo-triage.ts`, `conversation/run-turn.ts`.

**Phase 2 — Tool-calling LLM path.** Replace `streamText`+separate-extraction with `generateText` tools; keep `screenAssistantReply` on the final text. Measurably cuts per-turn cost and extraction lag. *Touches:* `conversation/run-turn.ts`, `src/lib/ai/extract.ts` (becomes a tool), `provider.ts`.

**Phase 3 — Booking hold.** `booking_holds` table + migration (remember: run `npm run db:migrate`, no auto-run on Vercel; use `db.batch`, no transactions), TTL-release cron, `hold_slot` tool, guardrail provenance exception. This lights up the revenue moat. *Touches:* `schema.ts`, migration, `conversation/run-turn.ts`, `output-guardrail.ts` caller, availability seam.

**Phase 4 — Outbound conversational SMS.** `outbound_campaigns`/`outbound_messages` + scheduler (`after()`/cron), templates through consent/quiet-hours; inbound replies re-enter the core. *Touches:* new `src/lib/outbound/*`, `sms/incoming` (thread resolution), consent module.

**Phase 5 — Unified thread + staffed inbox two-way.** `customer_thread`/`thread_messages`; promote `getThread`; extend SMS's `mode='human'` takeover to web. *Touches:* `schema.ts`, `src/lib/context/thread.ts`, inbox UI.

**Phase 6 — Spanish deterministic layer + KB self-improvement.** Locale-tagged `knowledge-base` entries; drop the non-Latin punt for `es`; weekly `bot_events` clustering → candidate intents. *Touches:* `knowledge-base.ts`, `intent-router.ts`, new `kb-miner.ts`.

## 5. Effort, risks, reuse-first

**Reuse, don't rebuild:** the router, both guardrails, verify gate, extraction, availability, consent, telemetry, and eval harness (`src/lib/ai/eval/*`, `promptfooconfig.yaml`) all stand. Phase 0 is pure consolidation of existing logic — the biggest risk is *behavioral regression during the merge*, mitigated by the golden-transcript suite and the flag. **Do NOT** loosen `FALSE_BOOKING_REGEX` for Phase 3 — gate on action provenance instead. **Do NOT** build a new outbound sender — thread it through `checkSendAllowed`. **Do NOT** hand-write a WhatsApp brain — it's another channel adapter over the same core. Biggest external dependency is the booking hold's coupling to the scheduling/dispatch domain (the availability seam already exists, so this is an integration, not a build). Rough effort: Phase 0 ≈ 5w, Phase 1 ≈ 3w, Phase 2 ≈ 3w, Phase 3 ≈ 5w, Phase 4 ≈ 6w, Phase 5 ≈ 4w, Phase 6 ≈ 3w.

**Key gaps vs. Probook-class:**

- Three forked brains: SMS delegates to voiceReply (the voice persona), web chat runs its own inline route.ts logic, voice runs voice-turn.ts — same primitives, re-implemented orchestration, so every improvement ships 2-3x and drifts
- No real booking/hold: every path deliberately refuses to book (account-tools.ts 'must not self-book'; FALSE_BOOKING_REGEX exists because the bot can only offer windows) — the 'book-on-the-call' revenue moat is absent
- No MMS/photo intake on SMS (route reads only From/Body) and no photo/nameplate triage anywhere — model-number-from-photo is Probook table stakes
- No outbound conversational SMS: everything is inbound-webhook; no reminders, re-engagement, unsold-estimate follow-ups that thread back into the same brain
- No unified customer_thread: getThread is a cross-channel hint only; web keys on cookie token, SMS on sms:${from}; no single thread merged on the resolved customer
- LLM path double-pays: streamText reply + a separate async extractServiceRequest call (10s+ lag, second LLM call) instead of tool-calling with structured outputs
- English-only router: latinAlphaRatio<0.5 punts non-Latin to the LLM; no Spanish deterministic intents for a large home-services demographic
- No KB self-improvement loop: bot_events records routed-vs-fallback but nothing mines low-confidence/fallback turns into new deterministic intents
- Web chat human handoff is escalate-only; SMS has mode='human' two-way takeover but web lacks the live staffed-inbox loop

**Phased build:**

- **Phase 0 — Unify the brain** — Extract a single channel-agnostic runConversationTurn core (src/lib/ai/conversation/run-turn.ts) owning all orchestration currently inlined in route.ts; make route.ts, sms/incoming/route.ts, and voice/gather thin adapters; fold voiceReply into a voice persona hook. Gate behind a UNIFIED_CORE flag; require the golden-transcript suite to pass identically pre/post for all three channels. Kills the fork; every later feature ships once.
- **Phase 1 — SMS/MMS + chat photo parity** — SMS adapter reads NumMedia/MediaUrl{n}, downloads via the Twilio-signed URL into the existing attachments table, and passes mediaUrls into TurnContext. Add a photo_triage step running vision on nameplate images to extract model/serial into extras. Touches sms/incoming/route.ts, src/lib/sms/*, new photo-triage.ts.
- **Phase 2 — Tool-calling LLM path** — Replace streamText + separate async extraction with generateText using tools (capture_slots, check_availability, hold_slot, lookup_account); structured outputs replace regex extraction and the second LLM call. Keep screenAssistantReply on the final assembled text. Cuts per-turn cost and removes the 10s+ extraction lag.
- **Phase 3 — Booking hold (revenue moat)** — New booking_holds table + migration (run npm run db:migrate; db.batch, no transactions on neon-http), TTL-release cron, hold_slot tool against the getOpenAvailability seam. Add a provenance exception so FALSE_BOOKING_REGEX passes booking language only when the turn carries a booking_confirmed action id — do NOT loosen the regex. Lights up 'book on the call'.
- **Phase 4 — Outbound conversational SMS** — New outbound_campaigns/outbound_messages tables + scheduler (after()/cron), templates enqueued through the existing consent/quiet-hours layer (checkSendAllowed, classifySmsKeyword). Inbound replies to an outbound thread re-enter the same runConversationTurn core so 'yes book it' is handled by one brain.
- **Phase 5 — Unified thread + staffed inbox two-way** — New customer_thread/thread_messages appended by every channel on the resolved customer; promote getThread from hint to source of truth. Extend SMS's mode='human' CSR takeover to the web widget for a live two-way handoff loop across all channels.
- **Phase 6 — Spanish layer + KB self-improvement** — Locale-tagged knowledge-base entries and dropping the non-Latin punt for es in intent-router.ts; plus a weekly job clustering bot_events where routed=false or confidence is low, drafting candidate knowledge-base.ts entries for human approval so the deterministic catalog grows from real misses.

**Adversarial review findings:**

- _major_ — Phase 5 proposes NEW tables "customer_thread" + "thread_messages" ("New `customer_thread` (`id, organizationId, customerId, lastChannel, lastMessageAt`) plus `thread_messages`"), but the codebase ALREADY ships `customer_threads` + `customer_events` (schema.ts:1871-1923, "Context layer (Probook v3, Phase 1) ... One thread per resolved customer") with a full service (resolveThread/ensureThreadId/appendEvent/getThread in src/lib/context/thread.ts). The existing customer_threads already merges onto the resolved customer via a (org,customer) unique index and is written by every channel via appendEvent — so the gap-analysis claim "There is no customer_thread merging voice+SMS+web onto the resolved customer" is factually wrong. The plan reinvents shipped infra under a near-identical name (singular vs plural) it did not check. Worse: the proposed `thread_messages` storing per-channel message content DIRECTLY CONFLICTS with the deliberate PII-free design of customer_events (schema comment line 1870: "Mirrors requestStatusEvents: ids + enums/label-keys only, no free text"; reinforced by the audit-no-PII invariant in memory). A message-content thread table would reintroduce PII the shipped design intentionally excludes. → **Fix:** Drop the new-table proposal. Extend the shipped customer_threads/customer_events instead: add lastMessageAt to customer_threads if needed, and if full transcript storage is truly required, reuse the existing `messages` table (already session-keyed) joined via session→customer rather than a PII-bearing thread_messages. Explicitly reconcile with the PII-free customer_events invariant and state whether transcript-level storage is even wanted.
- _major_ — Total effort is ~29 weeks (Phase 0 5w + 1 3w + 2 3w + 3 5w + 4 6w + 5 4w + 6 3w) — roughly 7 months — for one domain of a single-market small shop (memory: Spears Services, Johnson City TN, 5 services, one org / DEMO_ORG_ID). Several phases are speculative Probook-parity chrome with thin ROI for this shop: Phase 6 Spanish deterministic intents + weekly bot_events KB-mining clustering, and the WhatsApp channel adapter. There is no evidence of Spanish demand or WhatsApp usage in this codebase/market, yet they consume dedicated scope. The "self-improving" weekly kb-miner is an ML-adjacent build ("clusters bot_events ... drafts candidate knowledge-base.ts entries") justified only by the aspirational Probook bar. → **Fix:** Cut or defer Phase 6 (Spanish + kb-miner) and WhatsApp to an explicit "only if demand appears" backlog. Keep the high-ROI, shop-relevant core: Phase 0 (unify), Phase 1 (MMS/photo), Phase 3 (booking hold — the actual revenue moat). Re-baseline effort to the 3-4 phases that pay for themselves in this market.
- _minor_ — The plan calls the booking-hold's scheduling coupling "an integration, not a build" ("the availability seam already exists, so this is an integration"). getOpenAvailability/buildWindowPrompt are read-only availability surfaces (availability-queries.ts, availability-prompt.ts) — there is no write-side capacity-reservation seam. Writing a real hold that back-pressures dispatch (booking_holds with TTL release + reflecting the hold in subsequent getOpenAvailability reads so two customers can't grab the same slot) is a genuine build in the dispatch/scheduling domain, not a thin integration. → **Fix:** Re-scope Phase 3 to include the write-side: make getOpenAvailability subtract active holds, define the concurrency guard (neon-http has no txns — use an onConflict/CAS upsert like ensureThreadId does, or a unique (org,slot) constraint) and the TTL-release cron. Budget it as a build, not an integration.
- _minor_ — "The knowledge base (`src/lib/ai/knowledge-base.ts`, ~53 intents)" — the file has ~106 `id:`-keyed entries, roughly double the stated count. Minor and non-load-bearing, but signals the numbers weren't verified against the file. → **Fix:** Recount (grep -cE '^\s+id: "' src/lib/ai/knowledge-base.ts → 106) or clarify what "53 intents" counts (e.g. a category subset), so downstream sizing of the Phase 6 Spanish/mining work isn't based on a wrong base.

---

<a name="5-booking-quality"></a>
## 5. Clean Every Booking Before It Hits the Board: A Pre-Assign Data-Quality Gate

_Effort: ~6.5 engineer-weeks · Reviewer verdict: **needs-work**_

## 1. The bar: what a Probook-class product does here

Probook's own teardown (docs/superpowers/plans/2026-06-24-probook-competitive-analysis-and-plan.md, §2.5) states the goal bluntly: "clean every booking before it hits the board." In a ServiceTitan/Avoca-class stack, no lead becomes a dispatchable job until it passes a **pre-assign gate** that runs, deterministically, on every inbound booking regardless of channel (voice, web, SMS, FSM webhook):

- **Address validation & geocoding** — the address is real, drivable, inside the service area, and carries lat/lon so the dispatch engine can reason about proximity and drive time.
- **Identity resolution / dedup / merge** — the lead is matched to the one canonical customer across phone/email/address (typos, shared numbers, multi-site) so history and equipment attach correctly.
- **Full-history + equipment/warranty enrichment** — pull prior jobs, open balances, membership, warranty status, and the installed asset from the FSM so the tech arrives informed and the CSR can up-sell/warn.
- **Spam / quality / risk scoring** — filter junk leads (bot form-fills, wrong-number voice calls, out-of-area tire-kickers, duplicate re-submits) before they consume a dispatcher's attention or a truck-roll.
- **Completeness scoring + missing-field completion** — every field a tech needs at the door is present; anything missing is either auto-completed or routed to an **exceptions queue** for a human to fix, *not* silently dropped onto the board.

The defining move is that this is a **first-class, blocking, observable stage** with its own data model and audit trail — not a scatter of validations inside the intake prompt. A booking is either `clean → dispatchable`, or `flagged → exceptions queue`, and the reason is always recorded.

## 2. Current-state gap analysis

This repo already has most of the *primitives* but has not assembled them into a gate. Concretely:

**Address validation (have, partial).** `src/lib/address/photon.ts` gives keyless Photon autocomplete with US-preference, proximity bias, and haversine sort (`fetchAddressSuggestions`, `haversineKm`). `src/lib/integrations/fieldpulse/address-validation.ts` adds a quality score (`scoreAddressQuality`, 0–1 on street/city/state/ZIP/coords), a threshold filter, an FSM-geocode fallback (`fetchValidatedAddressSuggestions`), and a keyless completeness check (`hasMinimumAddressQuality`). `src/lib/ai/extraction-schema.ts:isAddressComplete` is a strict drivable-address heuristic (≥4 tokens, leading street number or named rural route, 5-digit ZIP). The gap: these run *inside intake* to help the customer type an address; nothing **canonicalizes and persists** a validated, geocoded address (lat/lon) onto the `service_requests` row. `addressEncrypted` is stored as free text; there is no `address_verified`, `latitude`, `longitude`, or normalized-components column on the request.

**Dedup (have, strong).** `src/lib/crypto.ts:blindIndex` (HMAC-SHA256, domain-separated) plus `customers.emailHash`/`phoneHash` with partial `uniqueIndex` constraints (schema.ts:747–752) give atomic, race-safe dedup. `upsertCustomerByContact` (src/lib/admin/crm-queries.ts:518) resolves one canonical customer id under concurrency. The gap: dedup is **exact-match only** on normalized email/phone. There is no fuzzy/typo match (e.g. `jon@` vs `john@`, transposed digits), no address-based match for a customer who calls from a new number, and **no merge** of two rows later found to be the same person.

**Sanitization (have).** `src/lib/ai/sanitize-fields.ts` normalizes name/phone/address/email for display and is applied at the persistence boundary inside `upsertCustomerByContact` (crm-queries.ts:534–539). This is presentation polish, explicitly "never invent or drop information" — not validation.

**Completeness (have, as a chat gate).** `isExtractionComplete` / `isVoiceExtractionComplete` (extraction-schema.ts:252, 281) and `REQUIRED_EXTRACTION_FIELDS` gate whether the *conversation* can confirm. The gap: this is a boolean at the end of a chat turn, not a scored, channel-agnostic assessment of a persisted booking. An FSM-originated or SMS booking never passes through it.

**Enrichment (have the mirrors, not the pull-at-booking).** `src/lib/ai/customer-context.ts` (`lookupCustomerContext`, `enrichWithServiceHistory`, `loadCustomerContextById`) and the `customerThreads`/`customerEvents` tables (schema.ts:1871, 1896) plus `appendEvent` give a context layer; FieldPulse/HCP mirrors hold prior invoices and equipment. `submit-session-request.ts` already records equipment from intake (`recordCustomerEquipment`) and appends a booking thread event. The gap: no **history/warranty pull is folded into a quality decision** — a repeat customer with an open balance or a Do-Not-Service history is not surfaced as a booking-quality signal (only the hard `doNotService` refuse at submit-session-request.ts:143 exists).

**Spam / quality / risk scoring (missing entirely).** A grep for `spam|lead_score|quality_score|risk|fraud` across `src` finds only TCPA/CAN-SPAM send-guards and triage risk copy — **no lead-quality or spam scoring exists.** There is no dedup-of-duplicate-submissions guard on the request table (a customer double-tapping "confirm" creates two requests), no out-of-area check against `BUSINESS_BASE_LOCATION.serviceRadiusKm` (src/lib/config/business-location.ts, 50km), no velocity/abuse signal.

**The gate itself (missing).** There is no exceptions queue. `service_requests.status` starts `pending` and goes straight onto the board; `holdReason` covers operational pauses (awaiting_parts, weather) not intake-quality holds. Everything the gate needs exists as scattered functions; nothing composes them into one scored, blocking, audited pass.

## 3. Target architecture + data model

Introduce one module — `src/lib/quality/` — that runs a **synchronous, deterministic scrub** before a request is insertable, plus a small set of columns and one enum value.

**Schema additions (one migration; remember migrations don't auto-run on Vercel — `npm run db:migrate` after deploy).**

On `service_requests`:
- `qualityScore integer` — 0–100 composite.
- `qualityFlags jsonb` — array of `{code, severity, detail}` (e.g. `address_unverified`, `out_of_area`, `possible_duplicate`, `missing_email`, `open_balance`, `spam_suspected`).
- `latitude`/`longitude double precision`, `addressVerified boolean default false`, `addressComponents jsonb` (street/city/state/zip normalized).
- Add `needs_review` to `requestStatusEnum` (a booking that failed the gate — visible only in the exceptions queue, never on the dispatch board).

New table `booking_quality_events` (append-only audit, mirrors `request_status_events`): `id, organizationId, serviceRequestId, score, flags jsonb, decision text ('clean'|'flagged'|'blocked'), createdAt`. Keeps the gate's decision explainable and testable.

New table `customer_merge_log`: `id, organizationId, survivingCustomerId, mergedCustomerId, mergedByUserId, createdAt` — records manual/auto merges so a merge is reversible-in-audit.

**The gate module** `src/lib/quality/scrub-booking.ts` exports one pure-ish orchestrator:

```
scrubBooking(orgId, data): {
  score: number, flags: Flag[], decision, canonicalAddress, customerId, enrichment
}
```

It composes existing primitives, deterministically, in this order:
1. **Sanitize** (`sanitizeContactFields`) — already at the boundary; make it explicit here.
2. **Address**: `hasMinimumAddressQuality` → `fetchValidatedAddressSuggestions` (Photon+FSM) → pick best, set lat/lon + components + `addressVerified`. Compute `haversineKm` to `BUSINESS_BASE_LOCATION`; if > `serviceRadiusKm`, flag `out_of_area`.
3. **Dedup**: `upsertCustomerByContact` (exact) then a new fuzzy pass (address + name similarity + phone edit-distance ≤1) → flag `possible_duplicate` with the candidate id rather than auto-merging.
4. **Request-level duplicate guard**: a new partial unique index on `(organizationId, customerId, issueType)` for open requests created in the last N minutes, or an idempotency check, to stop double-confirm.
5. **Enrichment**: `enrichWithServiceHistory` + FSM equipment/warranty; surface `open_balance`, `do_not_service`, `active_warranty` as flags/context (not just the existing hard DNS refuse).
6. **Completeness**: reuse `isExtractionComplete` field-by-field to produce per-field `missing_*` flags.
7. **Score**: weighted sum → `decision` (`>=80 clean`, `50–79 flagged`, `<50 blocked`). Thresholds in a config constant, tunable per org via `organizationSettings`.

**Wiring point:** `submit-session-request.ts`. `scrubBooking` runs *before* the `db.batch` insert. `clean` → insert as today with quality columns populated. `flagged`/`blocked` → insert with `status='needs_review'`, write a `booking_quality_events` row in the same batch, and return a distinct result so voice/web callers can say "our team will confirm the details." Auto-assign (`autoAssignBookedRequest`) is gated on `status !== 'needs_review'`, keeping dirty bookings off the board.

## 4. Phased build plan

**Phase 0 — Persist what we already compute (1 wk).** Add `latitude`, `longitude`, `addressVerified`, `addressComponents`, `qualityScore`, `qualityFlags` columns + migration. In `submit-session-request.ts`, call `fetchValidatedAddressSuggestions` once and persist the geocoded canonical address + `addressVerified`. No behavior change to routing yet — pure enrichment. Touches: `schema.ts`, new migration, `submit-session-request.ts`. Verify: a web booking lands with lat/lon populated; test against a known Johnson City address.

**Phase 1 — The scrub module + scoring (1.5 wks).** Build `src/lib/quality/scrub-booking.ts` and `score.ts` composing sanitize → address quality → out-of-area (`haversineKm` vs `BUSINESS_BASE_LOCATION`) → completeness flags. Unit-test the scorer exhaustively (it's pure — golden cases like out-of-area, missing email, unverified address). Wire it into `submit-session-request.ts` to *populate* `qualityScore`/`qualityFlags` but not yet block. Touches: new `quality/` files + tests, `submit-session-request.ts`.

**Phase 2 — Exceptions queue + `needs_review` (1 wk).** Add the enum value + `booking_quality_events` table. Route `blocked` bookings to `status='needs_review'`; gate `autoAssignBookedRequest` and the dispatch board query on it. Build a minimal admin exceptions view (reuse the dispatch-board list components) showing flags + a "resolve → pending" action that re-scrubs. Touches: `schema.ts`, migration, `submit-session-request.ts`, `scheduling-queries.ts`, an admin route/component.

**Phase 3 — Duplicate-booking guard + fuzzy dedup (1.5 wks).** Add the recent-open-request idempotency guard (partial unique index or app-side check) to kill double-confirm. Add a fuzzy customer-match pass (phone edit-distance, normalized-address match) emitting `possible_duplicate` with a candidate id, plus a `customer_merge_log` table and an admin merge action. Reuse `blindIndex` for the exact path; fuzzy stays advisory (never auto-merges). Touches: `crm-queries.ts`, `quality/dedup.ts`, `schema.ts`, migration.

**Phase 4 — Enrichment folded into the score (1 wk).** Pull FSM history/warranty/open-balance at booking via existing mirrors and `enrichWithServiceHistory`; add `open_balance`, `active_warranty`, `repeat_customer` flags feeding both the score and the CSR/tech context hint. Touches: `quality/enrichment.ts`, `customer-context.ts`, `scrub-booking.ts`.

**Phase 5 — Spam/velocity signals + per-org tuning (0.5–1 wk).** Add cheap deterministic spam heuristics (gibberish name, disposable-email domain list, impossible phone, submission velocity per IP/phone) and expose thresholds in `organizationSettings`. Touches: `quality/spam.ts`, `organizationSettings`.

## 5. Effort, risks, reuse-first shortcuts

**Total: ~6–7 engineer-weeks** (plan §4 estimates 2–3 wks for the gate alone; that undercounts fuzzy dedup, merge, and the exceptions UI).

**Reuse — do NOT build:** address geocoding (Photon + FSM fallback already exist — just persist their output); the atomic exact-dedup (`upsertCustomerByContact` is correct and race-safe); sanitization (`sanitize-fields.ts`); completeness heuristics (`isAddressComplete`/`isExtractionComplete` — reuse field-by-field, don't rewrite); the event-log pattern (copy `request_status_events`/`recordStatusEvent` for `booking_quality_events`); the DNS guard (already at submit-session-request.ts:143 — fold it into flags, don't duplicate). **Do NOT build** a USPS/SmartyStreets canonicalizer (the tech reads literal text; Photon+FSM is enough for v1), an ML spam classifier (deterministic heuristics first), or auto-merge (advisory + human confirm — auto-merge on fuzzy match is how you corrupt CRM data).

**Risks:** (1) *neon-http has no transactions* — the quality-event write must ride in the existing `db.batch` in `submit-session-request.ts`, and the request-duplicate guard must be a DB constraint, not read-then-write (same TOCTOU lesson as the customer dedup). (2) *Latency* — voice/chat turns are latency-bound; the address geocode call is a network hop, so cap it with the existing 5s Photon timeout and fall back to `addressVerified=false` + flag rather than blocking the turn. (3) *False-positive blocks* — a blocked legitimate booking is worse than a dirty one; start Phases 1–2 in *flag-only* (score but don't block) mode, watch `booking_quality_events`, and only turn on blocking per-org once thresholds are calibrated. (4) *Fuzzy-match precision* — keep it advisory; a wrong auto-merge is unrecoverable without the merge log. (5) *Migrations don't auto-run on Vercel* — every phase that adds columns needs `npm run db:migrate` post-deploy or `.returning()` writes 500 on schema drift.

**Key gaps vs. Probook-class:**

- No first-class pre-assign gate: intake completeness (isExtractionComplete) is a chat-turn boolean, not a channel-agnostic scored pass over a persisted booking — FSM/SMS-originated bookings bypass it entirely
- No spam/quality/risk scoring of any kind (grep for spam|lead_score|risk finds only TCPA send-guards); no out-of-area check against BUSINESS_BASE_LOCATION.serviceRadiusKm, no velocity/abuse signal
- Validated/geocoded address is never persisted: Photon + FieldPulse geocode run inside intake to help typing, but service_requests stores addressEncrypted as free text with no lat/lon, addressVerified, or normalized components
- No exceptions queue: bookings go straight to status='pending' onto the board; holdReasonEnum covers operational pauses, not intake-quality holds; no needs_review state
- Dedup is exact-match only (HMAC blind index on normalized email/phone) — no fuzzy/typo matching, no address-based identity match, and no customer merge for rows later found to be the same person
- No request-level duplicate guard: a double-tapped 'confirm' creates two service_requests (only the customer row is deduped)
- FSM history/warranty/open-balance mirrors exist but are not folded into a booking-quality decision — only the hard doNotService refuse is wired in
- No audit trail for quality decisions: request_status_events pattern exists but is not applied to why a booking was flagged/blocked

**Phased build:**

- **Phase 0 — Persist what we already compute** — Add latitude/longitude/addressVerified/addressComponents/qualityScore/qualityFlags columns + migration; in submit-session-request.ts call fetchValidatedAddressSuggestions once and persist the geocoded canonical address. Pure enrichment, no routing change. ~1 wk.
- **Phase 1 — Scrub module + scoring** — Build src/lib/quality/scrub-booking.ts + score.ts composing sanitize → address quality → out-of-area (haversineKm vs BUSINESS_BASE_LOCATION) → completeness flags. Exhaustive pure-function tests. Wire in to POPULATE qualityScore/qualityFlags in flag-only mode (no blocking yet). ~1.5 wks.
- **Phase 2 — Exceptions queue + needs_review** — Add needs_review enum value + booking_quality_events audit table; route blocked bookings there; gate autoAssignBookedRequest and the board query on it; minimal admin exceptions view reusing dispatch-board components with a resolve→re-scrub action. ~1 wk.
- **Phase 3 — Duplicate-booking guard + fuzzy dedup** — DB-constraint idempotency guard against double-confirm; advisory fuzzy customer match (phone edit-distance, normalized-address) emitting possible_duplicate with candidate id; customer_merge_log table + admin merge action. Never auto-merges. ~1.5 wks.
- **Phase 4 — Enrichment folded into the score** — Pull FSM history/warranty/open-balance via existing mirrors + enrichWithServiceHistory; add open_balance/active_warranty/repeat_customer flags feeding both the score and the CSR/tech context hint. ~1 wk.
- **Phase 5 — Spam/velocity signals + per-org tuning** — Deterministic spam heuristics (gibberish name, disposable-email domains, impossible phone, submission velocity per IP/phone); expose score thresholds in organizationSettings. ~0.5–1 wk.

**Adversarial review findings:**

- _major_ — The gate is specified as a "synchronous, deterministic scrub before a request is insertable" (§3) that runs "before the db.batch insert," and Phase 4 folds FSM history/warranty pull + enrichWithServiceHistory into that synchronous score. But submit-session-request.ts deliberately pushes enrichment and equipment recording into after() precisely because this runs in a "latency-bound voice/chat turn" (comments at lines 301, 328: "so it runs in after()"). fetchValidatedAddressSuggestions (Photon+FieldPulse) and enrichWithServiceHistory are network-bound external calls; making them blocking in the submit path reintroduces the exact latency the codebase engineered away, and couples booking success to FSM/Photon availability on a live phone call. → **Fix:** Keep the scrub's blocking portion to cheap local computation (sanitize, isAddressComplete, haversine out-of-area, completeness flags, exact dedup via blindIndex). Run geocoding and FSM history/warranty enrichment in after() and let them update qualityScore/qualityFlags post-insert (re-scrub asynchronously), or gate the board on a separate async-set addressVerified/qualityScore rather than blocking the intake turn. Never let a Photon/FSM timeout fail a voice booking.
- _major_ — Over-scoped for the target (a single small shop — Spears Services, one org, one dispatcher). Phase 3 (fuzzy phone edit-distance + address-similarity dedup, customer_merge_log, admin merge action) and Phase 5 (per-IP/phone velocity abuse scoring, disposable-email domain lists, per-org tunable thresholds in organizationSettings) are speculative pillars for a product doing low booking volume. The repo's exact-match blindIndex dedup already resolves the real duplicate case; the parent plan itself flags the analytics/scoring tier as the only "100-engineer" item to "keep lean/last." This conflicts with the user's Simplicity-First rule (no speculative flexibility/configurability). → **Fix:** Ship Phases 0-2 (persist geocode + scrub/score + needs_review exceptions gate) — that is the real value and is right-sized. Defer fuzzy dedup/merge-log and spam-velocity/per-org tuning until there is evidence of duplicate customers or spam volume. Make thresholds constants, not org-configurable, until a second org exists.
- _minor_ — Phase 3 proposes "a new partial unique index on (organizationId, customerId, issueType) for open requests created in the last N minutes" to stop double-confirm. A time-windowed partial unique index is not expressible in Postgres — the index predicate must be IMMUTABLE, and now()/created_at > now()-interval is not, so this DDL cannot be created. → **Fix:** Drop the time-windowed-unique-index option; use only the app-side idempotency check the chapter already offers as the alternative (e.g. reject/return-existing when an open request with the same customerId+issueType exists within the window, or an idempotency key on the confirm action).
- _minor_ — The claim "There is no exceptions queue" (§2, gate section) is imprecise: the codebase already uses the term "exceptions queue" for a different feature — scheduling-queries.ts:957-959 (suggestTechnicians) is documented as "the advisory 'exceptions queue' feed (Probook v3 Phase 2)," surfaced via /api/admin/dispatch/suggest. That is a dispatch tech-suggestion feed, not a booking-quality review queue, so the gate is genuinely missing — but the chapter's proposed "exceptions queue" name collides with an existing, differently-purposed one. → **Fix:** Rename the proposed surface (e.g. "booking review queue" / "intake exceptions") to avoid conflating it with the existing dispatch exceptions feed, and note the two are distinct when reusing dispatch-board list components.
- _minor_ — §2 cites scoreAddressQuality as an available primitive ("adds a quality score (scoreAddressQuality, 0-1...)"). It is a module-private function in address-validation.ts:32 (plain function, not exported); only fetchValidatedAddressSuggestions and hasMinimumAddressQuality are exported. Similarly §2 says sanitizeContactFields is "applied ... inside upsertCustomerByContact (crm-queries.ts:534-539)" but that path actually calls the individual sanitizeName/Phone/Address/Email helpers; sanitizeContactFields is used in chat-slots.ts/cleanup-conversations.ts, not crm-queries. → **Fix:** Either export scoreAddressQuality or compose via the already-exported hasMinimumAddressQuality/fetchValidatedAddressSuggestions. Correct the sanitize citation to the per-field helpers used in crm-queries.
- _minor_ — Effort is inflated relative to the chapter's own cited source. The phased plan sums to ~6.5-7 weeks (Phase0 1 + Phase1 1.5 + Phase2 1 + Phase3 1.5 + Phase4 1 + Phase5 0.5-1), but the parent plan it cites estimates this same "Phase 4 — Pre-assign data-quality gate" at 2-3 wks (docs/...competitive-analysis §5 sequencing table). → **Fix:** Reconcile with the cited 2-3 wk estimate: the delta is entirely the deferrable Phases 3 and 5. Trimming those (per the over-scope finding) brings the honest estimate back in line and matches the source's "extend existing code, keep lean" framing.

---

<a name="6-outbound-engine"></a>
## 6. Outbound Revenue Engine: Campaign Orchestration over the Existing Comms Queue

_Effort: ~14 engineer-weeks · Reviewer verdict: **needs-work**_

## 1. The bar: what a Probook-class outbound engine does

Outbound is where an AI home-services platform stops being a cost center (answering calls) and becomes a revenue engine. The bar has five money motions, each a *sequenced, consent-gated, attributed* campaign — not a single message:

1. **Unsold-estimate follow-up.** A tech quotes $8k for a new system; the customer says "let me think." A good shop closes 20-30% of these on follow-up. The engine runs a multi-touch sequence (e.g. day 2 SMS, day 5 email with financing, day 9 "price expires" nudge), *stops the instant the estimate is approved*, and attributes the booking back to the touch that caused it.
2. **Membership renewal.** Reach members ~30/14/3 days before `currentPeriodEnd`, offer one-tap renewal, escalate to a call for high-value plans.
3. **Maintenance recall.** Equipment-driven: "your AC tune-up is due" keyed off install date / last-service date, timed to season.
4. **Win-back.** Lapsed customers (no job in 12-18 months) get a reactivation offer.
5. **Dunning.** Unpaid-invoice escalation ladder (reminder → firmer → final notice → collections handoff).

Wrapping all five: **campaign primitives** — audience segmentation, step sequencing with wait/branch logic, throttling and daily send caps, quiet-hours, A/B variant testing, suppression on conversion, and **attribution** ("did the outbound cause the booking, and what revenue did it drive?"). Probook sells *outcomes* (EBITDA points), so attribution is not optional — it's the product.

## 2. Current-state gap analysis

This repo already owns the *hard, boring 60%* of the substrate. The competitive plan (`docs/superpowers/plans/2026-06-24-probook-competitive-analysis-and-plan.md`, section 2.6 and the Phase 3 rows) grades outbound **PARTIAL** for exactly this reason.

**What exists and is production-grade:**

- **A durable comms queue.** `communicationJobs` (`src/lib/db/schema.ts:1689`) with AES-256-GCM-encrypted recipient PII, `scheduledFor`/`attempts`/`maxAttempts`, a partial index on `(status, scheduledFor) WHERE status IN ('pending','failed')`, and provider-message-id correlation. Drained by `processPendingJobs`/`retryFailedJobs` in `src/lib/communication/job-queue.ts` via the `/api/cron/process-communications` route.
- **The single send chokepoint.** `checkSendAllowed` in `src/lib/communication/consent.ts` enforces global do-not-contact, per-channel toggles, per-type preference toggles, and quiet-hours (21:00-08:00 customer-local) — driven by the `TRIGGER_RULES` map. STOP/HELP/START keyword handling lives here too. **Every outbound must route through this.**
- **An idempotency primitive.** `outboundMessageLedger` (`schema.ts:1812`) + `claimOutboundOnce` (`src/lib/communication/outbound-ledger.ts`) atomically claim a `(org, customer, trigger, periodKey)` slot via `onConflictDoNothing().returning()` — the neon-http-safe way to dedupe cron retries with no transaction.
- **Three real outbound motions already wired.** Dunning (`sendOverdueInvoiceReminders` in `money-triggers.ts`, 7-day bucket periodKey), warranty-expiry lead-gen (`enqueueWarrantyReminders`), and abandoned-booking recovery (`booking-recovery.ts`) — all consent-gated, ledger-deduped, folded into daily crons in `vercel.json`.
- **Review requests** (`reviewRequests` table `schema.ts:2780`, enqueue in `src/lib/reviews/review-queries.ts`) — already idempotent via the ledger (`periodKey: review:<serviceRequestId>`).
- **Membership machinery.** `customerMemberships.currentPeriodEnd`, `membershipVisits` with `(membership, periodKey)` unique idempotency, and the `/api/cron/generate-membership-visits` cron.
- **Attribution raw material.** `customerEvents` (`schema.ts:1896`) — an append-only per-customer event log keyed by `kind`/`refId`/`at`.

**What's missing (the campaign layer):**

- **No sequence abstraction.** Every trigger is a *one-shot* `queueCommunicationJob`. There is no notion of "step 2 fires 3 days after step 1 *unless the estimate was approved*." `triggerJobCompleted` fakes a single 3-day follow-up by hardcoding a date (`triggers.ts:486`); that's the ceiling today.
- **No unsold-estimate motion at all.** `estimates.status` has `open|sold|dismissed|expired` (`schema.ts:2391`) and `estimate_sent` fires *once* on create — nothing sweeps `open` estimates and nurtures them.
- **No renewal, no recall, no win-back.** `currentPeriodEnd` is stored but never swept. No equipment-recall cron. No lapsed-customer query.
- **No attribution join.** We log sends and we log bookings, but nothing ties `outbound send X → booking Y → $Z` inside an attribution window.
- **No throttle governor, no A/B, no campaign UI.** The only admin surface is the template editor (`src/app/admin/(dashboard)/communications/templates`). There is no per-org daily send cap, no variant assignment, no campaign dashboard.

## 3. Target architecture + data model

Generalize the proven one-shot pattern (find template → consent-gate → enqueue → ledger-dedupe) into a **sequence engine** that reuses `communicationJobs`, `checkSendAllowed`, and `claimOutboundOnce` unchanged. Four new tables (all `organizationId`-scoped, neon-http-safe — no transactions, guarded upserts):

- **`campaigns`** — `id, organizationId, key, name, kind ('unsold_estimate'|'membership_renewal'|'maintenance_recall'|'win_back'|'dunning'|'fill_board'), isActive, throttlePerDay int, quietHoursRespected bool default true, createdAt`. One row per motion per org.
- **`campaign_steps`** — `id, campaignId, stepIndex, delayDays int, channel, templateId (→communicationTemplates), variantKey (nullable, for A/B), stopCondition text` (e.g. `estimate_sold`). Ordered steps.
- **`campaign_enrollments`** — `id, organizationId, campaignId, customerId, subjectType ('estimate'|'membership'|'equipment'|'customer'), subjectId, status ('active'|'converted'|'completed'|'cancelled'), currentStepIndex, nextRunAt timestamp, variantKey, enrolledAt, convertedAt, attributedRevenueCents int`. **This is the state machine.** Unique index on `(campaignId, subjectId)` → the DB-level guard against double-enroll (mirrors `membershipVisits`' idempotency pattern).
- **`campaign_touches`** — `id, enrollmentId, stepIndex, communicationJobId (→communicationJobs), sentAt`. Audit trail + attribution linkage.

**The engine** (`src/lib/communication/campaigns/`):
- `enrollment.ts::enrollSubject()` — idempotent enroll (insert `onConflictDoNothing`, like the ledger).
- `runner.ts::advanceEnrollments(orgId, now)` — the core cron worker. Selects `active` enrollments with `nextRunAt <= now`, for each: (a) re-check the stop condition (query live subject state — is the estimate still `open`? membership still active?); if converted, set `status='converted'`, stamp `convertedAt`, skip. (b) Otherwise claim the step via `claimOutboundOnce(periodKey: campaign:<enrollmentId>:step:<n>)`, `checkSendAllowed`, `queueCommunicationJob`, write a `campaign_touches` row, advance `currentStepIndex`, set `nextRunAt = now + nextStep.delayDays` or complete.
- `audiences/*.ts` — one pure query per motion that returns eligible subjects (open estimates aged > N days; memberships within renewal window; equipment due for recall; customers with no job in 18mo).
- `attribution.ts::attributeConversion(subjectType, subjectId, revenueCents)` — called from the estimate-approval, membership-renew, and booking paths; finds an active/recent enrollment for that subject within an **attribution window** (e.g. 14 days from last touch), stamps `convertedAt` + `attributedRevenueCents`, writes a `customerEvents` row (`kind: 'campaign_conversion'`).
- `governor.ts::withinThrottle(orgId, campaignId, now)` — counts today's `campaign_touches` for the campaign vs `throttlePerDay`; the runner stops enrolling/sending once the cap is hit (protects deliverability/reputation).

**Crons** (extend `vercel.json`; Hobby = daily only, so one consolidated `/api/cron/run-campaigns` route that loops orgs and calls each audience-builder + `advanceEnrollments`, failure-isolated per org exactly like the dunning route's warranty/dunning split). Sends still drain through the existing `process-communications` cron — the campaign runner only *enqueues*.

## 4. Phased build plan

**Phase 0 — Unsold-estimate follow-up (highest ROI, no new abstraction).** Ship the single most valuable motion directly, mirroring `money-triggers.ts`. Add trigger type `estimate_followup` to `communicationTriggerTypeEnum` + a `TRIGGER_RULES` entry (`toggle: 'marketingMessages'`, `quietHours: true`) + migration. New `src/lib/communication/estimate-followup.ts::sweepUnsoldEstimates(orgId)`: select `open` estimates aged into the next touch window (day 2/5/9 via three ledger periodKeys `estf:<estimateId>:t1|t2|t3`), consent-gate, enqueue, **skip any estimate not still `open`**. New `/api/cron/estimate-followup` route (loop orgs, like dunning). Attribution v0: on estimate approval, write a `customerEvents` row linking the approval to the last touch. Files: `schema.ts`, `consent.ts`, new lib + route, `vercel.json`, migration + `npm run db:migrate`. **~1.5 wks.**

**Phase 1 — Generalize into the sequence engine.** Add the four tables + migration. Build `campaigns/runner.ts`, `enrollment.ts`, `governor.ts`, `campaign_touches`. Port Phase 0's estimate motion onto it (seed an `unsold_estimate` campaign with 3 steps) as the proving ground; keep the old path behind a flag until parity is verified. Files: `schema.ts`, new `campaigns/` dir, `/api/cron/run-campaigns`, tests. **~3 wks.**

**Phase 2 — Renewal + recall.** Audience builders over `customerMemberships.currentPeriodEnd` and `customerEquipment` install/last-service dates; two seeded campaigns. Renewal step can deep-link the existing tokenized approval/portal surface. Files: `campaigns/audiences/renewal.ts`, `recall.ts`, template seeds. **~2 wks.**

**Phase 3 — Win-back + full attribution.** Lapsed-customer audience over `serviceHistory`/last job date. Build `attribution.ts` with the windowed join and wire `attributeConversion` into estimate-approval, membership-renew, and the booking-creation path; surface `attributedRevenueCents` per campaign. **~2.5 wks.**

**Phase 4 — Fill-the-board (capacity-aware).** Join `technicianAvailability` / FieldPulse availability: when tomorrow has open slots, enroll maintenance-due/recurring customers. This is the only motion coupled to live capacity and should come last. Files: `campaigns/audiences/fill-board.ts`. **~2 wks.**

**Phase 5 — A/B + campaign admin UI + throttle tuning.** `variantKey` assignment (hash of `enrollmentId`), conversion-by-variant reporting reusing `campaign_touches` + `campaign_enrollments`, and an admin dashboard under `src/app/admin/(dashboard)/communications/campaigns` (enroll counts, sent, converted, attributed $, per-variant lift). **~3 wks.**

## 5. Effort, risks, reuse-first shortcuts

**Total ~13-15 engineer-weeks** to Probook-class (the plan's 2.6 estimate of 3-5 weeks covers only Phase 0-1; the attribution + capacity + A/B + UI depth is the rest).

**Do NOT build:** a new queue (reuse `communicationJobs`), a new consent/quiet-hours system (reuse `checkSendAllowed`/`TRIGGER_RULES`), a new dedupe mechanism (reuse `claimOutboundOnce` — every step gets a periodKey), a new send-drainer (reuse `process-communications`), a new template system (reuse `communicationTemplates` + `sms-templates.ts`/`email-templates.tsx`), or a bespoke event store (reuse `customerEvents`). The runner is *orchestration over existing primitives* — that's the whole reuse thesis.

**Risks / gotchas:**
- **neon-http has no transactions** (per repo memory): the runner must not assume atomic multi-write. Advance `nextRunAt`/`currentStepIndex` with guarded single-row UPDATEs and lean on `claimOutboundOnce` for the "send exactly once" guarantee — never a read-modify-write across two tables expecting isolation.
- **Migrations don't auto-run on Vercel** (repo memory): every phase's migration needs an explicit `npm run db:migrate`, or `.returning()` writes 500. Ship each table *before* the code that reads it.
- **Compliance is the product's neck.** Unsold-estimate/renewal/win-back are marketing-adjacent; gate on `marketingMessages` (off by default) + quiet-hours, and honor the STOP suppression already in `consent.ts`. The `reviewRequests` no-sentiment-routing discipline (`schema.ts:2772` comment) sets the bar — don't cheat conversion by suppressing unhappy customers.
- **Stop-on-conversion must be checked at send time, not just enroll time.** The runner re-queries live subject status before every step; a race where a step fires seconds after approval is the classic "we texted a customer who already paid" embarrassment. The ledger dedupes retries, but only a live status re-check prevents the stale-send.
- **Attribution honesty.** A windowed last-touch join over-credits outbound. Ship it labeled as *last-touch within N days*, log the window, and keep native vs synced revenue separate (the `demandDaily`/`revenueDaily` `basis` convention already establishes this discipline) — don't let outbound claim credit for organic bookings.

**Key gaps vs. Probook-class:**

- No sequence/campaign abstraction — every trigger is a one-shot queueCommunicationJob; no multi-step day-0/day-3/day-7 nurture with stop-on-conversion
- No unsold-estimate follow-up motion — estimates.status open/sold/dismissed/expired exists and estimate_sent fires once, but nothing sweeps open estimates to nurture them
- No membership-renewal outbound — currentPeriodEnd is stored but never swept; renewals not auto-charged (Stripe-gated)
- No maintenance-recall (equipment-driven) or win-back (lapsed-customer) motions
- No attribution — sends and bookings are both logged but nothing ties outbound touch -> booking -> attributed revenue within a window
- No throttle governor / per-org daily send cap for deliverability protection
- No A/B variant testing on message content or timing
- No campaign management UI beyond the template editor
- No fill-the-board capacity-aware outbound joining live availability

**Phased build:**

- **Phase 0 — Unsold-estimate follow-up (direct, no new abstraction)** — Add estimate_followup trigger type + TRIGGER_RULES entry + migration. New src/lib/communication/estimate-followup.ts::sweepUnsoldEstimates mirroring money-triggers.ts: day 2/5/9 touches over open estimates, each ledger-deduped (estf:<id>:tN), consent-gated, skipped if estimate no longer open. New /api/cron/estimate-followup route looping orgs like dunning. Attribution v0 via a customerEvents row on approval. ~1.5 wks.
- **Phase 1 — Generalize into the sequence engine** — Add campaigns / campaign_steps / campaign_enrollments / campaign_touches tables + migration. Build campaigns/runner.ts (advanceEnrollments: re-check stop condition, claimOutboundOnce per step, enqueue, advance nextRunAt), enrollment.ts (idempotent enroll), governor.ts (per-day throttle). Port the Phase 0 estimate motion onto the engine as the proving ground. ~3 wks.
- **Phase 2 — Membership renewal + maintenance recall** — Audience builders over customerMemberships.currentPeriodEnd (30/14/3-day windows) and customerEquipment install/last-service dates. Two seeded campaigns; renewal steps deep-link the existing tokenized portal/approval surface. ~2 wks.
- **Phase 3 — Win-back + full attribution** — Lapsed-customer audience over serviceHistory / last job date (12-18mo). Build attribution.ts windowed last-touch join; wire attributeConversion into estimate-approval, membership-renew, and booking-creation paths; stamp attributedRevenueCents. ~2.5 wks.
- **Phase 4 — Fill-the-board (capacity-aware outbound)** — Join technicianAvailability / FieldPulse availability: when tomorrow has open slots, enroll maintenance-due / recurring customers. Last because it is the only motion coupled to live capacity. ~2 wks.
- **Phase 5 — A/B testing + campaign admin UI** — variantKey assignment (hash of enrollmentId), conversion-by-variant reporting over campaign_touches + enrollments, and an admin dashboard at src/app/admin/(dashboard)/communications/campaigns showing enrolled/sent/converted/attributed$ and per-variant lift. ~3 wks.

**Adversarial review findings:**

- _major_ — The reuse thesis leans on customerEvents as a no-schema-change event/attribution store: 'writes a customerEvents row (kind: campaign_conversion)' and Phase 0 'on estimate approval, write a customerEvents row linking the approval to the last touch.' But customerEvents (schema.ts:1896) has threadId: uuid('thread_id').notNull().references(customerThreads) — a NOT NULL FK to a customer text thread. Campaign conversions keyed off an estimate/membership/equipment subject have no guaranteed thread, so the attribution INSERT will fail its NOT NULL/FK constraint for any subject that isn't already tied to a thread. The claim that customerEvents can be reused unchanged as the attribution event store is not correct. → **Fix:** Either resolve/create a customerThreads row for the customer before writing the event (adds a lookup+possible insert to every conversion path), or make customerEvents.threadId nullable via a migration (run npm run db:migrate — Vercel does not auto-migrate). Pick one explicitly in the plan rather than assuming zero-schema reuse.
- _major_ — The runner design is 'claim the step via claimOutboundOnce → checkSendAllowed → queueCommunicationJob → write campaign_touches row → advance currentStepIndex, set nextRunAt.' Under neon-http (no transactions, correctly acknowledged) these are separate single-row writes. If the worker dies after claimOutboundOnce succeeds but before currentStepIndex/nextRunAt advance, the next run re-selects the same enrollment/step, claimOutboundOnce returns empty (ledger already claimed — no double send, good), but the chapter does not define what the runner does on an empty claim: if it skips, the enrollment stalls forever on that step; if it advances, that path must be spelled out. This recovery branch is the crux of a non-atomic state machine and is unspecified. → **Fix:** Specify runner behavior when claimOutboundOnce returns no row for the current step: treat 'already claimed' as success and still advance currentStepIndex/nextRunAt idempotently (advance guarded on currentStepIndex = n so a concurrent runner can't double-advance). Add a test for crash-between-claim-and-advance.
- _minor_ — Cron design rationale is factually wrong: 'Crons (extend vercel.json; Hobby = daily only, so one consolidated /api/cron/run-campaigns route).' vercel.json already defines ~11 cron jobs, all daily. Vercel Hobby caps cron jobs at 2 and daily frequency; 11 jobs means the project is on Pro, where sub-daily schedules are allowed. The 'Hobby' justification is incorrect, and it understates capability: on Pro the time-sensitive touches (the 'price expires day 9' nudge, dunning ladder) could run more than once daily. → **Fix:** Drop the Hobby framing. Consolidating into one run-campaigns route is still fine operationally, but justify it on failure-isolation/simplicity, and note that Pro permits finer cadence if a motion needs it.
- _minor_ — Attribution error in the current-state description: 'warranty-expiry lead-gen (enqueueWarrantyReminders) ... in money-triggers.ts.' enqueueWarrantyReminders actually lives in src/lib/admin/warranty-queries.ts (it is imported into the /api/cron/dunning route). Only sendOverdueInvoiceReminders is in money-triggers.ts. → **Fix:** Correct the file attribution to src/lib/admin/warranty-queries.ts.
- _minor_ — Maintenance-recall audience is described as 'keyed off install date / last-service date.' customerEquipment (schema.ts:774) has installDate and warrantyExpiration/laborWarrantyExpiration but no last-service-date column; last-service must be derived from serviceHistory (schema.ts:877). The 'last-service-date' field is implied to exist on the equipment row but does not. → **Fix:** State that last-service is derived by joining serviceHistory (MAX service date per equipment/customer), not read from a customerEquipment column.
- _minor_ — Scope for a single small shop (Spears Services): five money motions plus A/B variant testing, windowed attribution, capacity-aware fill-the-board, and a full campaign admin dashboard is a marketing-automation product. This is defensible only under the stated productization/SaaS goal (PRODUCT-PLAN), not for one HVAC shop's immediate needs — and the chapter's own 13-15wk total dwarfs the shipped one-shot motions. The phasing is disciplined (Phase 0 unsold-estimate is genuinely high-ROI and small), but Phases 4-5 (fill-the-board, A/B, full UI) are speculative depth ahead of demand. → **Fix:** Explicitly gate Phases 4-5 on evidence (conversion lift from Phases 0-3, real multi-tenant campaign volume) rather than committing the full 13-15wk up front; ship Phase 0 and measure attributed revenue before building the sequence engine's advanced layers.

---

<a name="7-integrations-platform"></a>
## 7. The Integrations Platform: From Two Hand-Built FSM Twins to a Reusable, Money-Safe, Bidirectional Connector Fabric

_Effort: ~26 engineer-weeks · Reviewer verdict: **needs-work**_

## 1. The bar: what a Probook-class product does here

For an AI dispatch OS, the FSM/CRM layer is the system of record for money and identity. A Probook-class product ships **bidirectional, idempotent, conflict-aware sync** with every major field-service platform — ServiceTitan, Housecall Pro, FieldPulse, Jobber, plus QuickBooks Online (QBO) for accounting — covering customers, jobs/appointments, invoices, payments, technicians, and availability. The competitive teardown at `docs/superpowers/plans/2026-06-24-probook-competitive-analysis-and-plan.md` §2.7 names this a **1–2 team** workstream and explains why: "every FSM API is different, rate-limited, partially-documented, and *authoritative for money* — so sync must be idempotent, conflict-aware, money-safe, and degrade-safe. Each integration is effectively a mini-product." The bar is not one connector; it is a **connector fabric**: a shared port that new FSMs plug into, an outbound delivery guarantee (retry/dead-letter, not fire-and-forget), a distributed rate-limit/backoff discipline that honors `Retry-After`, full initial import + ongoing drift reconciliation with per-field provenance, and connection-health observability with auto-reconnect. The scheduling-source seam must let the customer-facing slot-picker and the dispatch board consume availability from *whichever* system owns the calendar, transparently.

## 2. Current-state gap analysis

This repo is genuinely strong here — the teardown rates it **HAVE (strong)**. Two full FSM integrations exist, each a well-factored mini-product under `src/lib/integrations/{housecall-pro,fieldpulse}/` (~15k lines combined), plus `google-calendar/` and a `shared/rate-limiter.ts`.

**What exists and is good:**
- **Narrow client seams.** `housecall-pro/client.ts` defines a `HousecallProClient` interface (createCustomer/findCustomer/createJob/updateJob/cancelJob/addJobNote/listAvailability/listTechnicians/getInvoice…) with a concrete impl doing retry on 429/5xx (`MAX_ATTEMPTS=3`, exponential `BACKOFF_BASE_MS`), a 15s timeout, and an injectable `fetchImpl`. FieldPulse mirrors this.
- **Encrypted per-org credentials.** `housecall_pro_connections` and `fieldpulse_connections` tables store `apiKeyEncrypted` + `webhookSecretEncrypted` (AES-256-GCM), `accountInfo` cache, and `connected` flags; `config.ts` resolves per-org key then env fallback, returning `null` to degrade safely.
- **Idempotent inbound webhooks.** `hcp_webhook_events` and `fieldpulse_webhook_events` are per-(org, event_id) ledgers. `housecall-pro/webhook-sync.ts` `applyWebhookEvent()` does `insert…onConflictDoNothing().returning()` to claim an event, maps it via `webhook-events.ts` to a request-status target, transitions through the *shared* `updateRequestStatus` state machine, and — critically for the no-transaction constraint — does a **compensating `releaseEvent()` delete** if processing throws after the claim, so HCP's retry can reprocess. Completion fires a background follow-up via `after()`.
- **Money-grade invoice mirrors.** `{hcp,fieldpulse}/invoice-sync.ts` PULL full invoices into the native `invoices`/`invoiceLineItems` tables; `serviceRequests.invoiceStatus` mirrors sent/paid/void; reconcile crons (`cron/sync-housecall-invoices`, `cron/sync-fieldpulse-invoices`, `cron/reconcile-payments`) backstop dropped webhooks. Per project memory, synced invoices are read-only in money flows guarded by `fieldpulse_invoice_id IS NOT NULL`.
- **Scheduling-source seam.** `src/lib/admin/scheduling-source.ts` defines `SchedulingSource` (getAvailability/getJobs/getActiveTechnicianIds); `HcpSchedulingSource` (`housecall-pro/scheduling-source.ts`) implements it with a per-org TTL cache and **falls back to `DbSchedulingSource` on any HCP error**. `organizationSettings.schedulingSource` is a `native|external` enum.
- **External-id mapping columns.** `serviceRequests.hcpJobId`/`fieldpulseJobId`, `customers.hcpCustomerId`/`fieldpulseCustomerId`, `users.housecallProUserId`/`fieldpulseUserId`, each with a partial unique index scoped to the org — the idempotent "set once, re-push is a no-op" mapping the sync code relies on.

**What is missing (the real gaps):**
1. **No ServiceTitan connector** — the largest FSM in the space. `SERVICETITAN-PLAN.md` exists but is unbuilt. ST uses OAuth2 client-credentials + a tenant id + app key — a *different auth shape* than the single API key both current connectors assume.
2. **No QBO / accounting sync at all.** Invoices mirror one-way from the FSM; there is no push to an accounting ledger.
3. **Duplication, not abstraction.** HCP and FieldPulse are copy-pasted twins (memory: "duplicated not abstracted"). There is no shared `Connector` port beyond the ad-hoc `shared/rate-limiter.ts`. A third connector triples the maintenance surface — exactly the headcount sink the teardown warns about (§Part 6: "Integrations are where headcount disappears").
4. **Outbound push is fire-and-forget.** Pushes to the FSM run inline or via `after()`. There is **no outbox, no retry queue, no dead-letter** for a failed our→FSM write. If `createJob` fails after the customer booked, the mapping is simply never set and the reconcile crons only cover invoices.
5. **Rate limiter is in-memory per-process.** `shared/rate-limiter.ts` is a token bucket in a `Map` — on Vercel serverless each lambda instance has its own buckets, so real cross-instance 429 protection is weak, and `Retry-After` is not persisted/honored across requests.
6. **No initial bulk import or drift reconciliation.** `bulk-operations.ts` exists for outbound bulk pushes, but there is no "import this org's existing 5,000 customers/jobs on connect," and no periodic drift-detection sweep beyond invoices. `fieldpulse_connections.lastAvailabilitySyncAt` is the only cursor; there is no general `sync_cursors` watermark.
7. **No field-level conflict policy / provenance.** Mapping is set-once; there is no "who owns the phone number when both sides edited it" resolution, no per-field source-of-truth.
8. **Thin connection-health observability.** Only `fieldpulse_connections.lastSyncError`/`availabilitySyncStatus`. No unified health surface, no alerting, no auto-reconnect on a 401.

## 3. Target architecture + data model

**A shared FSM port.** Extract the *de-facto* interface the two twins already share into an explicit contract in `src/lib/integrations/core/`:
- `connector.ts` — `interface FsmConnector` unioning the existing client seams: `customers`, `jobs`, `invoices`, `technicians`, `availability` sub-interfaces. HCP and FieldPulse clients already satisfy ~90% of this; the extraction is mechanical.
- `port-types.ts` — canonical domain shapes (`CanonicalCustomer`, `CanonicalJob`, `CanonicalInvoice`) so each connector owns a `mapping.ts` (in↔canonical) and the sync engine speaks canonical only.
- `registry.ts` — `getConnector(provider, orgId)` returning the right client + config, generalizing today's `getHousecallClient`/`getFieldpulseClient` factories and the `config.ts` "org key then env" resolution.

**New tables (migration; remember Vercel does not auto-run migrations — `npm run db:migrate`):**
- `integration_connections` — generalize `{hcp,fieldpulse}_connections` into one table with `provider text`, `authKind text('api_key'|'oauth2_cc')`, `credentialsEncrypted`, `webhookSecretEncrypted`, `accountInfo jsonb`, `connected`, plus health columns `lastSyncAt`, `syncStatus`, `lastSyncError`, `tokenExpiresAt` (for ST OAuth). Keep the existing tables during migration; write the new connectors against the new table.
- `integration_outbox` — `id`, `organizationId`, `provider`, `operation` (`push_job`|`push_customer`|`push_invoice`), `payload jsonb`, `status('pending'|'processing'|'done'|'dead')`, `attempts`, `nextAttemptAt`, `lastError`, `dedupeKey` (unique per org+operation+entity). Claimed by a guarded UPDATE (`SET status='processing' WHERE status='pending' AND id=… RETURNING`) — the neon-http, no-transaction-safe analog of the inbound ledger's `onConflictDoNothing`.
- `integration_events` — generalize the two webhook ledgers into `(organizationId, provider, eventId)` unique. Preserves the exact idempotency + compensating-release semantics already proven in `webhook-sync.ts`.
- `sync_cursors` — `(organizationId, provider, resource)` → `watermark` (timestamp/opaque page token) for incremental pulls and drift sweeps.
- `field_provenance` (optional, Phase 3) — `(entityType, entityId, field)` → `source`, `updatedAt`, for conflict resolution.

**Distributed rate limiting.** Back the token bucket with a durable store keyed `(orgId, provider)` — a DB row (`SELECT … FOR UPDATE`-free guarded UPDATE consuming tokens) or an Upstash Redis if latency demands — persisting a `Retry-After`-derived `throttledUntil`. Keep `shared/rate-limiter.ts`'s interface; swap the backing store.

**Bidirectional booking write-back.** When `organizationSettings.schedulingSource='external'`, the customer booking enqueues an `integration_outbox` `push_job`; the FSM's webhook is the confirmation. When `'native'`, we own the calendar and only mirror status inbound. The `SchedulingSource` seam already abstracts the read side.

**ServiceTitan connector** (`integrations/servicetitan/`): reuse the Google OAuth refresh-token pattern (`google-calendar/oauth.ts`) for OAuth2 client-credentials, the HCP webhook idempotency ledger pattern verbatim, and the extracted port. Endpoints: CRM (customers/locations), JPM (jobs/appointments), Accounting (invoices), Settings (technicians). Admin routes mirror `app/api/admin/integrations/housecall/{connect,disconnect,status}`.

## 4. Phased build plan

**Phase 0 — Extract the port (no behavior change).** Create `integrations/core/{connector,port-types,registry}.ts`; make `HousecallProClient` and the FieldPulse client `implements FsmConnector`; route the two scheduling sources + invoice mirrors through canonical shapes. Pure refactor guarded by the existing test suites (`client.test.ts`, `webhook-sync.test.ts`, `scheduling-source.test.ts`). Ships nothing user-visible but is the prerequisite that stops connector #3 from tripling cost. *Files: new `core/`, edits to both clients.*

**Phase 1 — Outbound delivery guarantee.** Add `integration_outbox` (migration) + `integrations/core/outbox.ts` (enqueue) + `cron/process-integration-outbox/route.ts` (guarded-UPDATE claim, backoff, dead-letter). Replace inline/`after()` pushes in `job-sync.ts`/`customer-sync.ts` with enqueue. Back the rate limiter with a durable `(org,provider)` bucket honoring `Retry-After`. This makes every our→FSM write survive a transient failure. *Files: `core/outbox.ts`, cron route, `shared/rate-limiter.ts`, both `job-sync.ts`.*

**Phase 2 — ServiceTitan connector.** `integrations/servicetitan/{client,config,oauth,mapping,webhook-sync,scheduling-source,connection-queries}.ts` on the Phase-0 port + Phase-1 outbox. Generalize the webhook ledger to `integration_events`. Admin connect/status/disconnect routes. This is the flagship gap; the plan estimates 4–8 wks alone. *Files: new `servicetitan/`, `integration_events` migration, admin routes.*

**Phase 3 — Reconciliation + initial import.** `sync_cursors` table + `core/reconcile.ts` generalizing `reconcile-payments`; a `cron/reconcile-integrations` drift sweep (customers/jobs/invoices) that re-pulls anything changed past the watermark; an on-connect bulk import job. Add `field_provenance` + a last-write-wins-with-source policy. *Files: new cron, `core/reconcile.ts`, `core/import.ts`.*

**Phase 4 — QBO + health observability.** QBO connector (invoice/payment push) on the port; unified `/admin/integrations` health surface reading `integration_connections` health columns + outbox dead-letter count; alerting + OAuth auto-reconnect on 401. *Files: `integrations/quickbooks/`, admin health page, `cron/integration-health`.*

## 5. Effort, risks, reuse-first shortcuts

**Effort:** Phase 0 ~3 wks; Phase 1 ~3 wks; Phase 2 (ServiceTitan) ~6 wks; Phase 3 ~5 wks; Phase 4 (QBO + health) ~6 wks — **~23–28 engineer-weeks** for the domain, front-loaded on the ServiceTitan flagship.

**Risks:** (1) **No DB transactions** (neon-http) — every claim/apply must use the compensating-delete or guarded-UPDATE patterns already proven in `webhook-sync.ts`; do not introduce `db.transaction()`. (2) **Serverless in-memory state** — the current rate limiter and scheduling-source caches are per-instance; treat them as best-effort and make Phase 1's rate limit durable. (3) **Dual-source-of-truth for money** — for FSM-connected orgs, never let native invoicing/QBO fight the FSM; keep the existing `…_invoice_id IS NOT NULL` read-only guards and pick one authoritative source per org. (4) **Auth-shape divergence** — ST/QBO OAuth breaks the single-API-key assumption baked into `config.ts`; `integration_connections.authKind` must branch cleanly.

**Reuse-first — do NOT build:** Do not hand-roll a fourth webhook ledger — generalize the two that exist. Do not write new OAuth — reuse `google-calendar/oauth.ts`'s refresh/encrypt pattern. Do not build a job queue service — the `integration_outbox` + cron-claim pattern matches Vercel's constraints and the existing `cron/*` fleet. Do not chase the long tail of FSMs; the teardown is explicit (§Part 6): "Don't out-integrate them on day one… add ServiceTitan deliberately, not a long-tail." Extract the port, ship ServiceTitan and QBO, harden delivery — and stop.

**Key gaps vs. Probook-class:**

- No ServiceTitan connector (largest FSM in the space) — SERVICETITAN-PLAN.md exists but unbuilt; ST's OAuth2 client-credentials auth breaks the single-API-key assumption in config.ts
- No QuickBooks Online / accounting sync — invoices only mirror one-way inbound from the FSM, nothing pushes to an accounting ledger
- HCP and FieldPulse are copy-pasted twins with no shared Connector port beyond shared/rate-limiter.ts; a third connector triples maintenance surface
- Outbound our->FSM pushes are fire-and-forget (inline / after()); no outbox, retry queue, or dead-letter — a failed createJob/createCustomer is silently unmapped and only invoices are reconciled
- Rate limiter is an in-memory per-process token bucket (shared/rate-limiter.ts); on serverless each lambda has its own buckets so cross-instance 429 protection is weak and Retry-After is not persisted
- No initial bulk import on connect and no general drift-detection reconciliation; only invoices are reconciled and fieldpulse_connections.lastAvailabilitySyncAt is the sole cursor — no sync_cursors watermark
- No field-level conflict resolution or per-field provenance; external-id mapping is set-once with no 'who owns this field' policy
- Thin connection-health observability (only fieldpulse lastSyncError/availabilitySyncStatus); no unified health surface, alerting, or OAuth auto-reconnect on 401

**Phased build:**

- **Phase 0 — Extract the shared FSM port (no behavior change)** — Create src/lib/integrations/core/{connector,port-types,registry}.ts codifying the interface the HCP + FieldPulse client seams already share; make both clients implement FsmConnector and route the two scheduling sources + invoice mirrors through canonical shapes. Pure refactor guarded by existing client.test.ts / webhook-sync.test.ts / scheduling-source.test.ts. Prerequisite so connector #3 doesn't triple cost. ~3 wks.
- **Phase 1 — Outbound delivery guarantee** — Add integration_outbox table (migration) + core/outbox.ts enqueue + cron/process-integration-outbox with guarded-UPDATE claim (pending->processing RETURNING), exponential backoff, and dead-letter. Replace inline/after() pushes in job-sync.ts/customer-sync.ts with enqueue. Back shared/rate-limiter.ts with a durable (org,provider) bucket that persists and honors Retry-After. ~3 wks.
- **Phase 2 — ServiceTitan connector (flagship)** — integrations/servicetitan/{client,config,oauth,mapping,webhook-sync,scheduling-source,connection-queries}.ts on the Phase-0 port + Phase-1 outbox. Reuse google-calendar/oauth.ts refresh-token pattern for OAuth2 client-credentials + tenant/app-key; generalize the two webhook ledgers into integration_events; reuse the compensating-release idempotency pattern verbatim. Admin connect/status/disconnect routes mirroring the HCP ones. ~6 wks.
- **Phase 3 — Reconciliation + initial import + provenance** — sync_cursors watermark table + core/reconcile.ts generalizing reconcile-payments into a cron/reconcile-integrations drift sweep across customers/jobs/invoices; on-connect bulk import job; field_provenance table + last-write-wins-with-source conflict policy. ~5 wks.
- **Phase 4 — QBO accounting connector + health observability** — QuickBooks Online connector (invoice/payment push) on the port; unified /admin/integrations health surface reading integration_connections health columns + outbox dead-letter counts; alerting + OAuth auto-reconnect on 401. ~6 wks.

**Adversarial review findings:**

- _major_ — Phase 0 frames routing the money-grade invoice mirrors through a shared canonical layer as a low-risk refactor: "HCP and FieldPulse clients already satisfy ~90% of this; the extraction is mechanical" and "Pure refactor guarded by the existing test suites... route the two scheduling sources + invoice mirrors through canonical shapes." But this repo already ran a 4-critic adversarial review that REJECTED exactly this abstraction. Project memory (hcp-invoice-mirror): "The review killed a proposed shared column-name-parameterized core (Drizzle fights string-keyed dynamic columns; the shared core would have silently dropped FieldPulse's request-badge mirror; 2 integrations != enough to abstract)... A 3rd FSM would be the time to extract." The chapter's extract-at-connector-#3 sequencing actually AGREES with that guidance, but calling the invoice-mirror extraction "mechanical"/behavior-preserving understates the effort and the specific, documented failure mode (silent money-mirror drop). The canonical-shapes design must be proven to preserve FP's request-badge mirror and HCP/FP line-item divergence before it touches the money path. → **Fix:** Rename Phase 0 from "no behavior change / mechanical" to a risk-bearing money-path refactor. Scope the port extraction to the CLIENT seams and canonical customer/job/availability shapes only; explicitly EXCLUDE invoice-sync from canonicalization (leave the deliberately-duplicated invoice twins intact per the prior review) until connector #3 forces it, and gate any invoice-mirror change behind a diff test that asserts the FP request-badge mirror and line-item writes are byte-identical before/after.
- _major_ — The current-state analysis lists the HCP and FieldPulse invoice mirrors as done, working "Money-grade invoice mirrors" and builds Phase 0's port extraction on top of them, but omits that the HCP mirror is unvalidated and likely broken. Project memory (fieldpulse-invoice-mirror live-API remediation): "HCP mirror... built on the SAME wrong inferred assumptions - almost certainly broken; re-probe with a live HCP key + apply the same fixes," and HCP is separately BLOCKED on a MAX-plan API key. FP itself needed a full live-API remediation after shipping on inferred shapes. Meanwhile the plan makes ServiceTitan "the flagship gap" (4-8 wks) and adds a 4th connector (QBO) in Phase 4. The chapter's own cited source counsels the opposite: "add ServiceTitan deliberately, not a long-tail" and "we are not 100 engineers... win by depth on the wedge, not breadth." Extracting a shared port from, and stacking two new connectors on, a foundation where one of the two existing mirrors has never run against its real API is a sequencing/honesty gap. → **Fix:** Add a Phase 0.5 (or precede Phase 2) with an explicit "harden what ships" gate: live-validate the HCP mirror against a real key and apply the FP-style shape fixes before it becomes the template for the extracted port. Downgrade the HCP mirror from "money-grade" to "structurally complete, live-unvalidated" in the current-state section so the plan doesn't inherit a false baseline.
- _minor_ — The chapter says external-id mapping columns each have "a partial unique index scoped to the org." This is true for fieldpulseJobId (uniqueIndex on (organizationId, fieldpulseJobId)) but NOT for hcpJobId: schema.ts defines its unique index as .on(table.hcpJobId) WHERE hcpJobId IS NOT NULL — a GLOBAL unique, not org-scoped. A generalized integration_connections/mapping design that assumes uniform per-org scoping would silently mismatch the existing HCP index. → **Fix:** Correct the claim and, when generalizing mappings, decide the intended scope for hcpJobId (global vs per-org) explicitly rather than assuming the columns are uniform.
- _minor_ — Phase 2 says "Generalize the webhook ledger to integration_events" and §3 says integration_events "generalize[s] the two webhook ledgers," but §3's migration note also says "Keep the existing tables during migration; write the new connectors against the new table." Those are in tension: the safe path leaves hcp_webhook_events and fieldpulse_webhook_events in place and adds integration_events for ServiceTitan only, yielding THREE ledgers, not a unification. The word "generalize" oversells what actually ships. → **Fix:** State plainly that HCP/FP ledgers are NOT migrated (money-grade idempotency, not worth the risk); integration_events is the go-forward ledger for new connectors only. Drop the "generalize the two ledgers" framing or move it to an explicit, separately-justified Phase 5 with a dual-read migration test.

---

<a name="8-scheduling-capacity"></a>
## 8. Scheduling & Capacity: From Band-Level Soft Holds to a Race-Safe, Duration- and Drive-Time-Aware Capacity Engine

_Effort: ~16.5 engineer-weeks · Reviewer verdict: **over-scoped**_

## 1. The bar: what a Probook-class product does here

A ServiceTitan/Avoca-class scheduler is a live, minute-accurate model of "who can be where, when, doing what." Concretely it delivers: (a) **real availability** — recurring hours *minus* PTO/sick/blackouts *minus* live load, per technician; (b) a **bookable-windows engine** that offers a customer only slots that will actually fit the job's real duration, honoring drive time from the prior stop; (c) **race-safe capacity holds** so two simultaneous bookings (voice + web) can never both take the last slot; (d) a **dispatch board / calendar** dispatchers live in all day — drag-to-assign, drag-to-reschedule, conflict warnings, and continuous re-optimization as cancellations, runovers, and emergencies reshuffle the day; and (e) **route/drive-time awareness** so the board packs a tech's day geographically, not just chronologically. The plan's own teardown names this as workstream 2.8 and, tellingly, rates the repo "HAVE (good)... **Lacks: PTO/live-load, drive-time**" (`docs/superpowers/plans/2026-06-24-probook-competitive-analysis-and-plan.md:107`). The hard parts are timezone/DST correctness, *true* real-time capacity, and board UX.

## 2. Current-state gap analysis

This repo has an unusually clean, well-factored scheduling core — and it is honest about being pure-decision only. The strengths:

- **DST-correct time math** (`src/lib/admin/calendar-time.ts`): every UTC↔Eastern conversion probes the real offset via `Intl.DateTimeFormat` (`businessWallClockToUtc`, `toBusinessWallClock`, `businessMinutesOfDay`), so July jobs and the two 23h/25h days a year are handled by the tz database, not hand-rolled offsets. This is genuinely production-grade and is the foundation everything else leans on.
- **A clean scheduling-source seam** (`src/lib/admin/scheduling-source.ts`) with `SchedulingSource` (getAvailability/getJobs/getActiveTechnicianIds), a `DbSchedulingSource`, and `getSchedulingSource()` that resolves an HCP source when connected and degrades to DB on any error.
- **Pure open-window compute** (`src/lib/admin/availability.ts::computeOpenWindows`): capacity = active techs whose recurring hours cover a band that weekday, booked = of those, how many already overlap, available = capacity − booked, PII-free (counts only).
- **Half-open conflict detection** done correctly (`scheduling-queries.ts::checkScheduleConflict`), with the strict end-bound (`gt`, not `gte`) so back-to-back windows don't false-conflict — a subtle bug most teams get wrong.
- **A working dnd board** (`src/components/admin/calendar/interactive-scheduling-calendar.tsx` on `@dnd-kit`), optimistic moves (`calendar-optimistic.ts`), and a HARD server enforcement path: `placeAndAssignRequest` does one guarded UPDATE that can reassign+re-time together, blocks on conflict/out-of-hours with a 409, and supports `override` for the dispatcher (used by `src/app/api/admin/requests/[id]/reschedule/route.ts`).
- **Scored auto-dispatch** in `after()` (`autoAssignBookedRequest`), confidence-gated, with a first-fit fallback.

Now the gaps that separate this from the bar:

**Gap A — the capacity hold's CAS is aspirational, not real.** `capacity-hold.ts` carries a beautiful 33-line doc-comment describing a 5-step optimistic compare-and-swap ("re-read → `pickBookableSlot` → `arrivalWindowForSlot` → **conditionally write ONLY IF the band is still open** → retry on 0 rows"). But `canHoldSlot`, the CAS predicate, **has zero production callers** — only tests. The live path, `holdConcreteSlot` in `src/lib/requests/submit-session-request.ts:75`, executes steps 1–3 (read availability, pick a slot, compute the window) and then writes `arrivalWindowStart/End` straight into the request-insert `db.batch` (`:246`) with **no `WHERE available > 0` re-assertion**. Capacity is a *derived count* recomputed from jobs on every read; there is no reserved row and no unique constraint. So two concurrent confirms both observe `available = 1` and both write — the exact race the module claims to prevent. On serverless with voice + web + SMS hitting the same org, this is a real over-booking hole.

**Gap B — no PTO / time-off / blackout model.** Availability is purely recurring weekly rows (`technician_availability`). A tech on vacation keeps contributing capacity until someone deletes their rows. Worse, `availability-coverage.ts` falls back to a *hardcoded* `DEFAULT_BUSINESS_DAY` (Mon–Fri 8:00–20:00) for any tech with no rows — not org-configurable.

**Gap C — capacity is coarse: one job per tech per 4-hour band.** `bookedBandsForJob` (`availability.ts:57`) marks an entire band booked for a tech if *any* job overlaps it. A 30-minute filter swap consumes a tech's whole morning. And `estimatedDurationMinutes` — computed and stored at booking (`ensureEstimatedDuration`) — has **zero placement consumers** (grep confirms it's written but never read for scheduling). Duration exists as data but is not a packing constraint.

**Gap D — no drive-time / geo-aware placement or route ordering.** Placement is band-overlap only; the tech's geography and the prior stop are ignored. The plan explicitly flags this.

**Gap E — no live re-optimization.** `delay-detection.ts` sends "running behind" alerts but nothing re-packs the board on a cancellation/runover, and there's no capacity-driven "fill the board" hook.

**Gap F — fixed windows.** `WINDOW_HOURS` in `arrival-window.ts` hardcodes morning/afternoon/evening/anytime; no org-configurable windows or business hours.

## 3. Target architecture + data model

Keep the pure-compute + source-seam spine; add a **persisted reservation layer** and enrich the availability model. New/changed tables:

- **`capacity_ledger`** — the real CAS backing. One row per `(organization_id, iso_day, band)` with `capacity int`, `reserved int not null default 0`, unique on `(org, iso_day, band)`. A hold is a single guarded UPDATE: `SET reserved = reserved + 1 WHERE reserved < capacity` returning rows; 0 rows → band full → soft-book. This is the classic optimistic counter, and it is *composable in one neon-http statement* (no transaction needed). `capacity` is seeded/refreshed from `computeOpenWindows`. Release-on-cancel decrements guarded on `reserved > 0`.
- **`technician_time_off`** — `(org, technician_id, starts_at, ends_at, kind: 'pto'|'sick'|'blackout')`, UTC instants. Subtracted inside the availability source before capacity is computed.
- **`organization_settings`** additions: `business_hours jsonb` (per-weekday open/close, replacing the hardcoded default), `arrival_window_defs jsonb` (org-configurable band table), `default_job_capacity_per_band int`.
- **`serviceRequests`**: reuse existing `estimatedDurationMinutes`; add `travel_buffer_minutes int` (computed drive time from prior stop) — persisted so the board can render and enforce it.

New modules (all pure where possible, mirroring the existing style):
- `src/lib/admin/capacity-reserve.ts` — the guarded-UPDATE reserve/release helpers (the *impure* CAS half the doc-comment always promised; `capacity-hold.ts` stays the pure decision half).
- `src/lib/admin/time-off-coverage.ts` — pure "is this instant inside a PTO block?" folded into `computeOpenWindows` and `isWindowWithinAvailability`.
- `src/lib/admin/duration-capacity.ts` — pure duration-packing: given a band, a tech's slots, booked jobs *with durations*, and drive buffers, how many minutes are free → how many more jobs of size N fit.
- `src/lib/admin/drive-time.ts` — Photon/haversine estimate from the prior stop's geocode (reuse the existing Photon geocoder).

Endpoints: the availability seam (`getOpenAvailability`) and `placeAndAssignRequest` stay the public API; internally they consult the ledger and time-off. Add `POST /api/admin/technicians/[id]/time-off` and settings fields for business hours/windows.

## 4. Phased build plan

**Phase 0 — Make the CAS real (race-safety).** *Files:* new `capacity-ledger` migration (hand-authored journal+snapshot per the neon-http trigger-migration memory pattern), `src/lib/admin/capacity-reserve.ts`, wire into `holdConcreteSlot` (`submit-session-request.ts`) and the insert batch, decrement-on-cancel in the cancel/unschedule paths (`unscheduleRequest`, cancel route). The hold becomes: seed/read ledger → `pickBookableSlot` → guarded `reserved+1` UPDATE → on 0 rows, drop that band and re-pick → write window in the same `db.batch`. Ship with a concurrency test that fires N parallel confirms at a capacity-1 band and asserts exactly one wins. This closes Gap A — the highest-value, lowest-effort fix, and it finally uses `canHoldSlot`'s contract in production.

**Phase 1 — PTO/time-off + org-configurable hours.** *Files:* `technician_time_off` table + migration, `time-off-coverage.ts`, fold into `DbSchedulingSource.getAvailability`/`computeOpenWindows`/`isWindowWithinAvailability`, replace `DEFAULT_BUSINESS_DAY` with `organization_settings.business_hours`, a small admin time-off UI panel (reuse the availability panel patterns). Closes Gap B. Note: because capacity is recomputed from availability, PTO automatically shrinks ledger capacity on the next seed — the two phases compose cleanly.

**Phase 2 — Duration-aware capacity.** *Files:* `duration-capacity.ts`, change `bookedBandsForJob`/`computeOpenWindows` to subtract *booked minutes* (using `estimatedDurationMinutes`) rather than whole bands, and let a band hold multiple short jobs. `capacity_ledger` becomes minute-denominated per band, or keeps a job-count with per-band `capacity = floor(free_minutes / avg_job_minutes)`. This finally *consumes* the duration estimate that's already computed. Closes Gap C. Highest-risk phase for regressions — gate behind an org flag mirroring `auto_dispatch_enabled`.

**Phase 3 — Drive-time / geo placement.** *Files:* `drive-time.ts` (Photon reuse), persist `travel_buffer_minutes`, feed the buffer into `duration-capacity` and into `placeAndAssignRequest`'s conflict gate (a job now occupies window + trailing travel), and add drive-time to the dispatch `score.ts` signals (the plan already lists proximity as a scoring input). Board renders travel gaps. Closes Gap D.

**Phase 4 — Live re-optimization + fill-the-board.** *Files:* on cancel/runover, an `after()` job that releases ledger capacity and re-runs auto-assign for queued jobs; a capacity-aware outbound hook (ties into the outbound engine's "fill the board" — plan §2.6) that reads tomorrow's open ledger and triggers maintenance-due reminders. Closes Gap E. This is where scheduling meets the revenue engine.

## 5. Effort, risks, reuse-first shortcuts

**Effort:** Phase 0 ≈ 2 wks; Phase 1 ≈ 2.5 wks; Phase 2 ≈ 4 wks (the risky one); Phase 3 ≈ 4 wks; Phase 4 ≈ 4 wks. ~16–17 engineer-weeks for a credible parity band.

**Risks.** (1) The dual arrival-window interpretation is a latent footgun: `arrivalWindowForDate` applies hours in **UTC**, `arrivalWindowUtcForBusinessDate` in **Eastern**, and `formatArrivalWindow` renders in **UTC**. The hold path correctly uses the Eastern helper, but any new code touching windows must pick the Eastern one — write a lint/test guard. (2) neon-http has no transactions, so *every* new multi-write must be a `db.batch` or a guarded UPDATE; the ledger decrement must be idempotent (guarded on `reserved > 0`) so a double-fired cancel can't drive it negative. (3) Ledger capacity is a cache of a derived value — it can drift from `computeOpenWindows` if availability/PTO changes after seeding; run a reconciler in the existing FieldPulse-availability cron (`src/app/api/cron/sync-fieldpulse-availability`).

**Reuse-first — do NOT build:** don't touch `calendar-time.ts` (DST is already correct); don't rebuild the dnd board or `placeAndAssignRequest`'s guarded-UPDATE enforcement — extend them; don't invent an HCP scheduling source until the MAX-plan key lands (the seam is ready). Don't hand-roll a routing solver in Phase 3 — a haversine + Photon estimate through the existing geocoder is 80% of the value; a real VRP optimizer is a later, separate bet. Above all, Phase 0 is the one non-negotiable: the codebase *documents* a CAS it doesn't actually run, and that's the single most dangerous gap between this repo and a Probook-class product.

**Key gaps vs. Probook-class:**

- Capacity-hold CAS is aspirational: canHoldSlot has zero production callers and holdConcreteSlot writes the arrival window with no `WHERE available > 0` re-assertion, so concurrent voice+web confirms can double-book the last slot (no reservation row, no unique constraint — capacity is a derived count)
- No PTO/time-off/blackout model — availability is only recurring weekly rows; a vacationing tech keeps contributing capacity, and the pre-setup fallback (DEFAULT_BUSINESS_DAY Mon-Fri 8-8) is hardcoded, not org-configurable
- Coarse capacity: one job per tech per 4-hour band (bookedBandsForJob blocks a whole band for any overlap); estimatedDurationMinutes is computed and stored but has zero placement/capacity consumers
- No drive-time/travel/route awareness — placement is band-overlap only; geography and the prior stop are ignored
- No live re-optimization — delay-detection alerts but nothing re-packs the board on cancellation/runover, and no capacity-driven 'fill the board' hook
- Fixed arrival windows (morning/afternoon/evening/anytime hardcoded in WINDOW_HOURS); no org-configurable windows, custom lengths, or minute-level slots
- Latent dual-interpretation footgun: arrival windows are applied in UTC by arrivalWindowForDate but in Eastern by arrivalWindowUtcForBusinessDate, and formatArrivalWindow renders in UTC

**Phased build:**

- **Phase 0 — Make the capacity CAS real (race-safety)** — Add a capacity_ledger table (org, iso_day, band; capacity, reserved) via a hand-authored neon-http migration. New src/lib/admin/capacity-reserve.ts does a guarded UPDATE `SET reserved = reserved + 1 WHERE reserved < capacity` RETURNING (0 rows = full). Wire into holdConcreteSlot (submit-session-request.ts): read/seed ledger -> pickBookableSlot -> guarded reserve -> re-pick on loss -> write window in the same db.batch. Decrement (guarded reserved>0) on cancel/unschedule. Ship a parallel-confirm concurrency test asserting exactly one winner at capacity-1. Finally uses canHoldSlot's contract in production.
- **Phase 1 — PTO/time-off + org-configurable hours** — Add technician_time_off table + time-off-coverage.ts; fold into DbSchedulingSource.getAvailability, computeOpenWindows, and isWindowWithinAvailability. Replace hardcoded DEFAULT_BUSINESS_DAY with organization_settings.business_hours jsonb. Small admin time-off panel reusing availability UI patterns. Capacity auto-shrinks on next ledger seed.
- **Phase 2 — Duration-aware capacity** — New duration-capacity.ts; change bookedBandsForJob/computeOpenWindows to subtract booked MINUTES (using existing estimatedDurationMinutes) instead of whole bands, allowing multiple short jobs per band. Ledger becomes minute-denominated (or job-count with capacity=floor(free/avg)). Gate behind an org flag like auto_dispatch_enabled. Highest regression risk.
- **Phase 3 — Drive-time / geo placement** — drive-time.ts using the existing Photon geocoder (haversine + estimate, not a VRP solver). Persist travel_buffer_minutes; feed the trailing buffer into duration-capacity and placeAndAssignRequest's conflict gate; add proximity to dispatch score.ts signals. Board renders travel gaps.
- **Phase 4 — Live re-optimization + fill-the-board** — On cancel/runover, an after() job releases ledger capacity and re-runs auto-assign for queued jobs. Capacity-aware outbound hook reads tomorrow's open ledger and triggers maintenance-due reminders (ties into outbound engine 2.6). Add a ledger reconciler to the existing FieldPulse-availability cron to prevent cache drift.

**Adversarial review findings:**

- _minor_ — The chapter's factual diagnosis is accurate across the board — I verified every load-bearing citation. Gap A: `canHoldSlot` in src/lib/admin/capacity-hold.ts:128 has zero production callers (only capacity-hold.test.ts and capacity-hold-robustness.test.ts import it); the live path `holdConcreteSlot` (src/lib/requests/submit-session-request.ts:75-102) does steps 1-3 then writes arrivalWindowStart/End straight into the db.batch insert (:249-250) with no WHERE re-assertion. Gap B: DEFAULT_BUSINESS_DAY hardcoded 8*60/20*60 at availability-coverage.ts:32; no time_off/pto/blackout table exists in schema.ts. Gap C: bookedBandsForJob (availability.ts:56) marks the whole band; estimatedDurationMinutes is written by ensureEstimatedDuration (scheduling-queries.ts:830) but checkScheduleConflict (:224) and placeAndAssignRequest never read it. Gap F: WINDOW_HOURS hardcoded (arrival-window.ts:20). Risk-1 dual interpretation confirmed: arrivalWindowForDate uses setUTCHours (:59), arrivalWindowUtcForBusinessDate uses businessWallClockToUtc/Eastern (calendar-time.ts:250), formatArrivalWindow renders timeZone:UTC (:76). Plan §2.8 quote verbatim. neon-http no-txn confirmed. This is an honest, well-grounded teardown. → **Fix:** No correction needed — recorded to confirm the diagnosis is trustworthy and the code references are exact.
- _major_ — Over-scoped for the actual product. The target is a single small HVAC shop (Spears Services, Johnson City TN, ~5 services, a handful of techs — per project memory), yet the chapter prescribes a ~16-17 engineer-week program to reach 'ServiceTitan/Avoca-class' parity including drive-time geo-routing (Phase 3), minute-denominated duration packing (Phase 2), and live board re-optimization (Phase 4). For a shop with a few techs, band-level soft holds are largely adequate and the simultaneous-last-slot race is rare; Phases 3-4 build big-FSM machinery a small shop is unlikely to exercise while adding large regression surface. The chapter sequences Phase 0 first and flags the risk, but never asks the gut-check 'should this shop build Phases 3-4 at all.' → **Fix:** Scope down to Phase 0 (race-safe hold — cheap insurance, genuinely worth it) and optionally Phase 1 (PTO). Treat Phases 2-4 as explicitly deferred / demand-gated behind real evidence of double-booking pain or multi-tech routing need, not as a parity checklist. Add an off-ramp: 'stop after Phase 0/1 unless volume justifies more.'
- _major_ — Aggregate-count ledger vs per-tech placement mismatch — surfaces in Phase 2/3. The proposed capacity_ledger is keyed (org, iso_day, band) with a single reserved/capacity counter, but conflict enforcement (checkScheduleConflict/placeAndAssignRequest) is per-technician. Phase 2's minute-denominated variant ('capacity = floor(free_minutes / avg_job_minutes)' or minute reservation) can admit a booking against aggregate free minutes that no single tech actually has contiguously, so the CAS says 'room' while placeAndAssignRequest can't place it. The chapter treats the ledger as the capacity source of truth without reconciling it against the per-tech assignment model. → **Fix:** Either keep the ledger strictly count-based and band-level (Phase 0 only, which mirrors the existing derived available-count and is safe), or make reservation per-(tech, day, band) so the counter and the per-tech conflict gate model the same thing. Explicitly name that an aggregate minute-pool does not guarantee a placeable per-tech slot before committing to Phase 2.
- _minor_ — Phase 0 severity slightly overstated / a real existing backstop is omitted from the gap analysis. Auto-assign runs in after() via autoAssignBookedRequest -> placeAndAssignRequest, whose per-tech half-open conflict gate (scheduling-queries.ts:243, gt/lt) would reject the SECOND of two racing bookings from landing on the same tech in the same window, leaving it soft-held/unassigned. So the race is a band-level over-COMMIT (two customers both told 'booked morning'), not a silent double-ASSIGNMENT to one tech. The chapter calls it 'a real over-booking hole' without noting this downstream mitigation. → **Fix:** Reframe Gap A precisely: 'over-commits at the band count level; the async per-tech conflict gate prevents double-assignment but the customer promise is already made.' Still justifies Phase 0, but calibrates the stakes.
- _minor_ — Migration approach for capacity_ledger over-complicates. Phase 0 says author the migration 'hand-authored journal+snapshot per the neon-http trigger-migration memory pattern.' That pattern exists specifically because drizzle-kit cannot generate plpgsql triggers (last-admin guard, migration 0008). capacity_ledger is a plain table with a unique(org, iso_day, band) constraint — fully drizzle-kit-generatable. Hand-authoring the journal+snapshot here is unnecessary and error-prone. → **Fix:** Generate capacity_ledger and technician_time_off with normal drizzle-kit; reserve the hand-authored journal/snapshot pattern for anything needing raw SQL drizzle-kit can't express (none here).
- _minor_ — No mention of the Vercel deploy migration gotcha, which is acutely relevant to this specific design. Project memory notes Vercel build skips migrations and schema drift 500s .returning() writes; run npm run db:migrate manually. The ledger's core primitive is exactly a guarded UPDATE ... RETURNING rows — if the capacity_ledger migration isn't run post-deploy, the reserve statement fails or the table is missing, silently dropping back to the very overbooking Phase 0 exists to fix. → **Fix:** Add an ops step to each phase: run npm run db:migrate after deploy, and make capacity-reserve.ts fail-closed (or explicitly fall back to soft-book with a logged warning) if the ledger table/row is absent, so a missed migration degrades visibly rather than silently.
- _minor_ — Risk-1 (dual arrival-window) is likely an ALREADY-SHIPPED display bug, not merely a latent footgun for new code. The hold path stores windows via arrivalWindowForSlot -> businessWallClockToUtc (Eastern-anchored), but formatArrivalWindow renders with timeZone:UTC. A held morning slot (8:00 ET = 12:00 UTC in EDT) would render as '12:00 PM', not '8:00 AM'. The chapter frames this only as 'any NEW code touching windows must pick the Eastern one.' → **Fix:** Verify formatArrivalWindow's callers against Eastern-anchored held windows; if confirmed, this is a live display bug to fix now (render in the business timezone), independent of the capacity work — sharpen Risk-1 from 'latent' to 'verify/patch existing.'

---

<a name="9-frontend-mobile"></a>
## 9. Front-End Surfaces: Admin Console, Technician Field App, Customer Portal + Widget, and the Live Dispatch Map

_Effort: ~16 engineer-weeks · Reviewer verdict: **needs-work**_

## 1. The Bar: What a Probook-Class Product Ships Across Its Front-Ends

A ServiceTitan/Avoca-class platform is not one app — it is four coordinated surfaces, each tuned to a different user and hardware context:

- **Admin console** (CSR/dispatcher/owner): a dense, real-time operations cockpit. Live job board, drag-to-assign dispatch, a map that updates without a refresh, revenue KPIs, and an inbox that merges call/SMS/chat threads. The defining trait is *liveness* — a CSR watching a screen sees techs move and jobs change state in seconds, not on a manual reload.
- **Technician mobile app**: a phone-first, one-handed, frequently-offline field tool. My Day schedule, turn-by-turn to the job, on-site line-item estimate building with good-better-best options, photo capture, customer signature, payment collection at the truck, and "on my way" texts. ServiceTitan and Housecall Pro both ship native iOS/Android with **offline queues** because techs work in basements and rural crawlspaces.
- **Customer portal + booking widget**: a branded self-service surface — see upcoming visits, approve estimates, pay invoices, track the tech's live ETA ("Domino's tracker" for home services), and re-book. The widget is the top-of-funnel: an embeddable launcher on the contractor's marketing site that books a job in under a minute.
- **Dispatch map**: real-time AVL (automatic vehicle location) with tech breadcrumb trails, job pins colored by SLA risk, geofenced auto-arrival, and route optimization overlays.

The cross-cutting bar: **real-time push** (WebSocket/SSE, not polling), **offline-first** on the tech app, **installable PWA / native**, and **sub-second perceived latency** on every surface.

## 2. Current-State Gap Analysis

This repo already has all four surfaces *scaffolded* — which is a strong starting position — but every one is at "v1 read-mostly, poll-based" maturity.

**Admin console.** Solid. `src/components/admin/sidebar.tsx` is a polished navy grouped nav (Operations / Customers / Workspace / Integrations) with collapse, mobile overlay, and a live unscheduled badge via `useUnscheduledCount`. There is real breadth: `src/app/admin/(dashboard)/` has 25+ route folders (dispatch, calendar, map, invoices, estimates, pricebook, inventory, insights, reviews, accounting). Gap: **everything is client-polled**. The hooks (`use-dispatch-board.ts`, `use-admin-requests.ts`, `use-dashboard-overview.ts`) and `stats-cards.tsx` use `setInterval` fetches. There is no SSE/WebSocket anywhere (`grep` for `EventSource`/`WebSocket` returns nothing in front-end code). A dispatcher's board is stale between poll ticks.

**Technician app.** Real but thin. `src/app/tech/` has only a layout, a jobs list, and a job detail. `src/components/tech/tech-job-detail-client.tsx` (782 lines) is genuinely capable — clock in/out timesheet with a live-ticking elapsed clock, material add from pricebook, on-site notes, a pointer-drawn **signature canvas** with typed-name fallback, and photo capture via `<input capture="environment">`. `tech-location-tracker.tsx` streams throttled `watchPosition` fixes (60s coalesce) to `/api/tech/location`, consent-gated. Gaps: **(a) no offline support** — every action is a bare `fetch` that fails hard when the tech loses signal; there is no queue, no optimistic UI, no retry. **(b) Not a PWA** — no manifest, no service worker (`find` for `manifest*`/`sw.js` returns nothing), so it cannot be installed to a home screen or run offline. **(c) No on-site payment** and **no estimate presentation** — the tech can add materials but cannot build a good-better-best option and collect a card. **(d) No "on my way" / navigation** — no deep-link to Apple/Google Maps, no customer ETA text trigger.

**Customer portal + widget.** Portal exists at `src/app/portal/[token]/page.tsx` — a clean token-authed (not session) view of invoices, estimates, upcoming jobs, and history, with a Stripe-style `PayButton`. The widget is well-architected: `src/app/widget.js/route.ts` serves a vanilla-JS Shadow-DOM launcher IIFE that lazy-mounts an iframe, with a publishable-key model (`src/lib/widget/keys.ts`) and CORS/origin allowlisting (`src/lib/widget/cors.ts`, `origin.ts`). Gaps: the portal is **read + pay only** — no estimate *approval* action (estimates show "Awaiting your approval" but there is no approve button), no **live tech-ETA tracker**, no self-service reschedule/booking, no appointment reminders opt-in. The widget books via chat but has no structured **calendar slot picker**.

**Dispatch map.** Genuinely good bones. `dispatch-map.tsx` (266 lines) uses MapLibre GL with a keyless OpenFreeMap basemap, urgency-colored job pins, a pulsing live-tech marker, base marker, and a service-radius circle. Data comes from `/api/admin/dispatch/map` (`route.ts`), which geocodes job addresses on the fly via Photon and returns each tech's latest fresh (<4h) fix from `technicianLocations`. Gaps: **(a) geocode-on-read** is capped at 25 jobs (`MAX_GEOCODE`) and re-geocodes every load — no persisted lat/lng cache (the code comment even flags "a persistent geocode cache is the follow-up"). **(b) No real-time** — the map only updates on the manual refresh button; `technicianLocations` has fixes but the map doesn't stream them. **(c) No breadcrumb trails, no route lines, no click-to-assign** from the map. **(d) No geofence auto-arrival** — the `serviceRequestId` column on `technicianLocations` exists but is unused for arrival detection.

## 3. Target Architecture + Data Model

**Real-time transport (foundational, shared by admin + map + portal ETA).** Vercel serverless has no long-lived socket server, so use **SSE over a Vercel Edge/streaming route** for fan-out, or a hosted pub/sub (Ably/Pusher/Supabase Realtime) to avoid running our own socket infra — reuse-first favors the hosted option. Add `src/app/api/admin/stream/route.ts` (Edge runtime, `ReadableStream`) that emits `job.updated`, `tech.moved`, `request.created` events scoped by org. A tiny `src/hooks/use-live-events.ts` replaces the `setInterval` bodies inside existing hooks with an `EventSource` subscription, keeping their public API identical so no component changes. Server writes publish via `after()` (per the serverless-background-work memory) so ingestion latency is unaffected.

**Persisted geocache.** New table `geocoded_addresses` (org_id, address_hash [reuse the HMAC blind-index pattern already in the customer-dedupe memory], lat, lng, provider, geocoded_at). The map route reads cache-first, geocodes misses in a capped batch, and writes back with `after()`. This removes the 25-job cap and the per-load Photon hammer.

**Tech app offline layer.** Add a **PWA shell**: `public/manifest.webmanifest`, an `app/manifest.ts`, icons, and a service worker via `next-pwa` or a hand-rolled Workbox SW that (a) precaches the `/tech` shell, (b) runs a **Background Sync queue** for mutations. Introduce `src/lib/tech/offline-queue.ts` — an IndexedDB (via `idb`) outbox that wraps every tech mutation (`timesheet`, `materials`, `note`, `signature`, `photo`, `status`). UI writes optimistically to local state + enqueues; the SW drains on reconnect. Server routes must become **idempotent** — add a client-generated `Idempotency-Key` (UUID) column to `technician_time_entries`, `job_materials`, `attachments`, unique per (org, key), and a guarded insert (neon-http has no transactions — use the guarded-UPDATE / `ON CONFLICT DO NOTHING` pattern from the neon memory).

**On-site money (tech app).** New `src/app/tech/jobs/[id]/estimate` flow reusing the existing estimates tables (`estimates`, `estimateOptions`, `estimateLineItems` — already in schema) and pricebook. A `TechEstimateBuilder` component presents good-better-best `estimateOptions`; a `TechPayment` component reuses the same payment rails as `src/app/api/portal/[token]/pay`. Signature capture already exists and can attach to estimate approval.

**Geofence auto-arrival.** A pure function `src/lib/tech/geofence.ts` (haversine, reuse the circle math already in `dispatch-map.tsx`) run inside `recordTechnicianLocation`: when a fix lands within ~150m of the assigned job's geocoded address, transition the job to `in_progress` and fire the "tech arrived" customer notification via the existing `communicationJobs` queue. The unused `technicianLocations.serviceRequestId` becomes the arrival anchor.

**Customer live-ETA tracker.** Extend `portal/[token]/page.tsx` with a `LiveEtaMap` (dynamic-imported MapLibre, same as admin) that reads a **new PUBLIC, token-scoped** `/api/portal/[token]/tech-eta` returning only the assigned tech's coarse position + ETA (no other techs, no PII) — mirroring the map route's PII-light discipline. Subscribe via the same SSE channel, org+job-scoped.

**Portal actions.** Add estimate approve/decline (`/api/portal/[token]/estimate/[id]/approve`) writing status transitions, and a reschedule request path feeding `followUps`/`requestNotes`.

## 4. Phased Build Plan

**Phase 0 — Real-time backbone (unblocks admin + map + portal).** Stand up hosted pub/sub or an Edge SSE route `src/app/api/admin/stream/route.ts`; publish events from existing write paths via `after()`. Add `use-live-events.ts` and swap the polling bodies in `use-dispatch-board.ts`, `use-admin-requests.ts`, `use-dashboard-overview.ts`, `use-unscheduled-count.ts`. Ship: dispatcher board updates live. *Touches: 1 new route, 1 hook, 4 hook edits, ~3 write routes.*

**Phase 1 — Map hardening.** Add `geocoded_addresses` table + migration (remember: run `npm run db:migrate` post-deploy — migrations don't auto-run). Cache-first geocoding in `dispatch/map/route.ts`, remove the 25 cap. Add live-tech streaming to `dispatch-map.tsx` (marker diff instead of full redraw). *Touches: schema, 1 migration, map route, `dispatch-map.tsx`.*

**Phase 2 — Tech PWA shell + offline.** Add manifest, icons, service worker, install prompt. Build `src/lib/tech/offline-queue.ts` (IndexedDB outbox) + `Idempotency-Key` columns/migration. Wrap the six mutations in `tech-job-detail-client.tsx` with optimistic-write + enqueue. Ship: a tech can clock in, add materials, and shoot photos underground; it all syncs on reconnect. *Touches: `public/`, `app/manifest.ts`, SW, new lib, schema/migration, `tech-job-detail-client.tsx`, tech mutation routes.*

**Phase 3 — Tech on-site money + navigation.** `TechEstimateBuilder` (good-better-best via `estimateOptions`) and `TechPayment`; wire signature to estimate approval. Add "Navigate" deep-link and an "On my way" button firing a `communicationJobs` SMS. *Touches: new `src/app/tech/jobs/[id]/estimate`, 2 components, reuse payment + comms libs.*

**Phase 4 — Geofence auto-arrival.** `src/lib/tech/geofence.ts`; call it inside `recordTechnicianLocation`; auto-transition + arrival text. *Touches: 1 lib, `location-queries.ts`, comms queue.*

**Phase 5 — Portal upgrades.** Estimate approve/decline actions, reschedule request, live-ETA `LiveEtaMap` + token-scoped `tech-eta` route on the portal SSE channel. *Touches: `portal/[token]/page.tsx`, 2–3 new portal API routes, 1 map component.*

**Phase 6 — Widget slot picker + admin polish.** Add a structured calendar slot picker to the widget booking flow (reuse `technicianAvailability`); add admin map click-to-assign and breadcrumb trails. *Touches: widget iframe app, `dispatch-map.tsx`, dispatch assign route.*

## 5. Effort, Risks, Reuse-First Shortcuts

**Do NOT build:** a native iOS/Android app — the PWA path (Phase 2) delivers installable + offline at a fraction of the cost and reuses 100% of the existing React tech screens. Do NOT run our own WebSocket server on Vercel (serverless freeze kills it) — use SSE/Edge or a hosted pub/sub. Do NOT hand-roll an offline sync engine — use `idb` + Workbox Background Sync. Do NOT swap MapLibre/OpenFreeMap for a paid map SDK; the keyless basemap in `dispatch-map.tsx` already works and the circle/marker helpers are reusable for both the portal ETA and tech nav.

**Risks:** (1) **Idempotency is mandatory** before offline sync — without it, a queue replay double-charges labor/materials; this is the money-safety analog of the CAS guards the repo already uses. (2) **neon-http has no transactions** — every new multi-write (estimate approve, geofence transition) must use `db.batch()` or guarded UPDATEs. (3) **SSE connection limits** on serverless — cap concurrent streams per org and fall back to polling. (4) **Geofence privacy** — auto-arrival must remain consent-gated (the tracker already persists consent) and coarse in the customer-facing ETA.

**Effort:** Phase 0 ~2wk, Phase 1 ~1.5wk, Phase 2 ~4wk (offline is the tentpole), Phase 3 ~3wk, Phase 4 ~1wk, Phase 5 ~2.5wk, Phase 6 ~2wk. Roughly **16 engineer-weeks** to close the front-end gap to Probook parity, front-loaded on the real-time backbone and the offline tech PWA, which together unlock the majority of perceived-quality delta.

**Key gaps vs. Probook-class:**

- Tech app is not offline-capable: every action is a bare fetch with no queue, retry, or optimistic UI; loses data underground
- No PWA (no manifest, no service worker) — tech app cannot be installed to a home screen or run offline
- No real-time push anywhere — admin dashboard, dispatch board, and map are all setInterval-polled; map only updates on manual refresh
- Dispatch map geocodes addresses on every load capped at 25 jobs with no persisted geocache
- No on-site money in tech app: cannot present good-better-best estimates or collect card payment at the truck
- No geofence auto-arrival despite technicianLocations.serviceRequestId column existing; no 'on my way' text or navigation deep-link
- Customer portal is read+pay only: no estimate approve/decline action, no live tech-ETA tracker, no self-service reschedule/booking
- Embeddable widget books via chat but has no structured calendar slot picker
- Dispatch map has no breadcrumb trails, route lines, or click-to-assign from the map

**Phased build:**

- **Phase 0 — Real-time backbone** — Edge SSE route src/app/api/admin/stream/route.ts (or hosted pub/sub) publishing org-scoped job.updated/tech.moved/request.created via after(); new use-live-events.ts hook swaps the setInterval bodies in use-dispatch-board.ts, use-admin-requests.ts, use-dashboard-overview.ts, use-unscheduled-count.ts. Dispatcher board goes live.
- **Phase 1 — Map hardening** — New geocoded_addresses table (HMAC address hash) + migration; cache-first geocoding in dispatch/map/route.ts removing the 25-job cap; live-tech marker diffing (not full redraw) in dispatch-map.tsx subscribed to the SSE channel.
- **Phase 2 — Tech PWA shell + offline** — manifest.webmanifest/app/manifest.ts, icons, Workbox service worker with Background Sync; src/lib/tech/offline-queue.ts IndexedDB outbox; Idempotency-Key columns+migration on technician_time_entries/job_materials/attachments with guarded inserts; optimistic-write + enqueue for all six mutations in tech-job-detail-client.tsx.
- **Phase 3 — Tech on-site money + navigation** — New src/app/tech/jobs/[id]/estimate flow: TechEstimateBuilder (good-better-best via existing estimateOptions/estimateLineItems), TechPayment reusing portal pay rails, signature-to-approval wiring; Navigate deep-link + 'On my way' SMS via communicationJobs queue.
- **Phase 4 — Geofence auto-arrival** — src/lib/tech/geofence.ts (haversine, reusing dispatch-map circle math) invoked inside recordTechnicianLocation; auto-transition assigned job to in_progress on <150m fix and fire arrival notification; uses the unused technicianLocations.serviceRequestId anchor.
- **Phase 5 — Portal upgrades** — Estimate approve/decline (/api/portal/[token]/estimate/[id]/approve) + reschedule request; LiveEtaMap component + token-scoped PII-light /api/portal/[token]/tech-eta on the portal SSE channel showing only the assigned tech.
- **Phase 6 — Widget slot picker + admin map polish** — Structured calendar slot picker in the widget iframe booking flow reusing technicianAvailability; admin map click-to-assign and tech breadcrumb trails in dispatch-map.tsx.

**Adversarial review findings:**

- _major_ — The foundational real-time design does not fan out on Vercel's stateless functions as described. The plan says: 'Add src/app/api/admin/stream/route.ts (Edge runtime, ReadableStream) that emits job.updated, tech.moved... Server writes publish via after()' and scopes Phase 0 as '1 new route, 1 hook, 4 hook edits, ~3 write routes.' On Vercel every request is an isolated function instance, so an after() publish in write-instance A cannot reach an SSE ReadableStream held open in stream-instance B without a shared external broker. The plan names the hosted-pubsub alternative ('Ably/Pusher/Supabase Realtime') but then specifies the concrete implementation as a self-hosted Edge SSE route fed by after() — which is exactly the case that needs a broker behind it (or makes the SSE route redundant if clients subscribe to the broker directly). Verified: grep confirms zero EventSource/WebSocket in src, so this is genuinely net-new. The '1 new route' effort omits the broker (a new paid dependency, wiring, auth, and per-message cost) — the single most load-bearing phase is under-scoped and its central mechanism as written won't work. → **Fix:** Commit to one transport explicitly. Recommended: a hosted broker (Ably/Pusher/Supabase Realtime) that clients subscribe to directly; write paths publish to it via after(). Drop the self-hosted Edge SSE route, OR if kept, state that it must sit in front of the same broker (Redis pub/sub / Upstash) — an in-process emitter cannot bridge instances. Re-cost Phase 0 to include broker provisioning, channel auth/token endpoint (org-scoped), and reconnect handling.
- _minor_ — Long-lived SSE on Vercel serverless is bounded by function max-duration and streaming limits — not addressed. The plan describes an 'Edge runtime, ReadableStream' connection as the fan-out primitive but never mentions connection lifetime caps, heartbeats, or client reconnection/backoff. A dispatcher board left open all shift will see the stream terminated by the platform. → **Fix:** Specify heartbeat pings + client EventSource auto-reconnect with last-event-id resume, or lean on the hosted broker's SDK which handles this. Add it to Phase 0 scope.
- _minor_ — Over-scope relative to the actual customer. This repo is a single small shop (Spears Services, Johnson City TN, ~5 services). The chapter targets a 'ServiceTitan/Avoca-class' four-surface platform with an IndexedDB Background-Sync outbox wrapping six mutations + per-table Idempotency-Key columns, geofence auto-arrival, AVL breadcrumb trails, route-optimization overlays, and a Domino's-style live-ETA tracker. The offline-first outbox in particular (Phase 2) is the heaviest lift and its idempotency-column migrations touch three money/field tables. Some of this is justified (techs in basements — offline is real), but the full 7-phase program is a large multi-month build for one shop. → **Fix:** Since the plan is explicitly phased and reuse-first (correctly rejects native apps and self-hosted WS), keep it as a roadmap but front-load only Phase 0 (live board) and Phase 1 (map cache) as clearly-justified near-term wins; gate Phases 2-6 on real tech-count/offline-incident evidence rather than building the outbox speculatively. Note the SaaS-productization context makes the ambition defensible only if this becomes multi-tenant product surface.
- _minor_ — Minor over-engineering in the geocache key. The plan proposes geocoded_addresses.address_hash and says to 'reuse the HMAC blind-index pattern already in the customer-dedupe memory.' That pattern exists to make PII (email/phone) unlinkable while still uniquely indexable. A geocode cache key is a normalized address string, not sensitive-identity PII requiring a keyed blind index — a plain normalized-address unique key suffices and avoids dragging the HMAC secret into a non-security path. → **Fix:** Use a normalized-address unique key (lowercased/trimmed/collapsed) per org; only reach for HMAC if the cached address itself must be non-reversible at rest, which it need not be here.
- _minor_ — Slightly optimistic 'no component changes' claim for the hook swap: 'A tiny src/hooks/use-live-events.ts replaces the setInterval bodies inside existing hooks ... keeping their public API identical so no component changes.' The four hooks currently fetch-on-interval (verified: setInterval in use-dispatch-board/use-admin-requests/use-dashboard-overview/use-unscheduled-count). An event like 'job.updated' either must carry the full new payload or trigger a refetch — so the hook internals change materially (subscription lifecycle, event->refetch mapping, dedupe), even if the returned shape is stable. 'No component changes' is fair; 'tiny' understates the per-hook wiring. → **Fix:** Reframe as: hook return shape stays identical (consumers untouched), but each hook body is rewritten to subscribe + refetch/merge on relevant events. Budget per-hook work, not a trivial body swap.

---

<a name="10-platform-infra"></a>
## 10. The Operating Substrate: Multi-Tenancy, Durable Jobs, Migrations Discipline, Observability, and the Analytics Seam

_Effort: ~22 engineer-weeks · Reviewer verdict: **needs-work**_

## 1. The bar — what a Probook-class platform layer must do

A dispatch-centric AI operating system for home services is two workloads wearing one dress: a **real-time OLTP** system (intake, booking, dispatch, money) that must never leak one contractor's customers to another, and an **analytical** system (revenue forecasting, per-tech conversion models, the dispatch feature store) that grinds over history. The platform team owns the seam between them plus the connective tissue everyone else stands on:

- **Tenant isolation as an invariant, not a convention** — cross-tenant leakage is an existential bug; the platform enforces it in *depth* (app filter + DB-level guard), not by trusting every author to remember a `WHERE org_id = ?`.
- **Durable, retryable, idempotent background work** — a real queue with claim/lease/backoff/dead-letter, fan-out per tenant, and observability into depth and failure. "Fire a promise and hope" does not survive a serverless freeze.
- **Migrations discipline** — schema changes that are reviewed, ordered, reversible-ish, and *actually applied* in lockstep with the deploy that needs them; no drift.
- **Observability that is tenant-aware** — traces, metrics, and structured logs tagged with `org_id`/`request_id`, error budgets, SLOs on the money and dispatch paths, and PII kept out of the pipe.
- **A data platform** — a warehouse/read-path decoupled from OLTP so a forecasting query never contends with a live booking, plus a feature store the dispatch scorer and conversion models read from.
- **Scale headroom** — knowing, and engineering around, the ceilings of the chosen primitives (here: HTTP-per-query Neon, 60s serverless crons).

## 2. Current-state gap analysis

**Multi-tenancy — PARTIAL, app-level only.** Isolation is a single helper, `withTenant(table, orgId, ...conditions)` in `src/lib/db/tenant.ts`, that `AND`s `eq(table.organizationId, orgId)` onto a query's `WHERE`. Every one of the 62 tables in `src/lib/db/schema.ts` carries `organization_id uuid NOT NULL REFERENCES organizations(id) ON DELETE CASCADE`, with per-org indexes (`users_org_id_idx`, `sessions_org_created_idx`, etc.) and per-org unique constraints (`customers` email/phone blind-index uniqueness scoped by org). This is correct *when called* — but there is **no Postgres RLS, no session GUC, no defense-in-depth**. A single query that forgets `withTenant` silently returns cross-tenant rows and no guardrail catches it. `grep` for `set_config`/`current_setting`/RLS returns nothing. Tenant safety is 100% author-discipline.

**Database driver — hard constraints.** `src/lib/db/index.ts` builds `drizzle(neon(url), { schema })` over `drizzle-orm/neon-http`, lazily via a Proxy so `next build` never touches `DATABASE_URL`. Per the project memory `neon-http-no-transactions`, `db.transaction()` throws at runtime; the codebase already routes 23 call sites through `db.batch([...])` (one non-interactive transaction, statements known up front) and guarded `UPDATE ... WHERE status='pending' RETURNING` for atomic claims. Every query is one HTTP round trip — no pooled interactive session, no pipelining beyond `batch`.

**Background work — TWO mechanisms, one real queue.** (a) `after()` (Next 16, `next/server`) for post-response fire-and-forget, used across ~20 routes (`chat/route.ts`, `sms/incoming`, invoice/estimate writes, FieldPulse webhooks). (b) **11 Vercel crons** in `vercel.json`, all `nodejs`+`force-dynamic`, authenticated by `verifyCronAuth` against `CRON_SECRET` (timing-safe, fails closed). Crucially there is a genuine **DB-backed durable queue** already: `communication_jobs` (schema.ts:1689) with `status/priority/scheduledFor/startedAt/attempts/maxAttempts`, a partial index `communication_jobs_status_scheduled_idx ... WHERE status IN ('pending','failed')`, atomic claim (pending→processing guarded UPDATE + RETURNING so overlapping drains send once), exponential backoff, and a consent gate at send time. It is drained by `process-communications` **once daily** (`0 5 * * *`) despite the code comment claiming "every minute" — a scheduling gap. This queue is the reusable primitive; it's just hard-wired to comms.

**Migrations — PARTIAL, manual and drift-prone.** `drizzle/` holds 26 SQL migrations (`0000_baseline` … `0009_...`) applied by `npm run db:migrate` (`src/lib/db/migrate.ts`, a standalone tsx script). Per memory `migrations-not-run-on-deploy`, **Vercel build does NOT run migrations** — a deploy that adds a migration but forgets `db:migrate` produces schema drift that 500s any `.returning()` write. Some migrations are hand-authored (plpgsql triggers the money-loop and last-admin guard need, which drizzle-kit can't generate) with hand-copied journal/snapshot entries — fragile.

**Observability — GOOD skeleton, shallow depth.** `src/instrumentation.ts` calls `validateEnvVars()`, `registerOTel({serviceName})`, and degrade-safe Sentry init; `onRequestError` forwards to Sentry. `src/lib/observability/sentry.ts` is fully degrade-safe (no-op without DSN), scrubs PII in `beforeSend`, drops `event.user`, and defaults `tracesSampleRate` to **0**. `src/lib/logger.ts` is pino with PII redaction paths. What's missing: **traces are off by default**, there are **no custom spans, no tenant/request tagging, no metrics, no SLOs/error budgets, no dashboards, no dead-letter alerting**.

**Data platform — LACKING entirely.** No warehouse, no read replica, no materialized views, no feature store. `grep` for `materialized`/`warehouse`/`forecast` finds nothing. Every analytical read would hit the same Neon OLTP endpoint as live bookings. This is the honest "most 100-engineer" gap the strategy doc (§2.10, §5 row 5) flags as *deliberately last and lean*.

**Scale ceilings.** HTTP-per-query means N+1 loops cost N round trips; the `processPendingJobs` drain awaits several statements *per job sequentially* — a large org's daily comms/invoice-sync must fit one ~60s serverless invocation with zero fan-out. `generate-membership-visits`, `sync-fieldpulse-invoices`, `reconcile-payments` are all single-invocation loops with no tenant sharding.

## 3. Target architecture + data model

**3.1 Tenancy defense-in-depth.** Keep `withTenant` as the ergonomic path but add two backstops. (a) A dev/CI **lint rule** (`scripts/lint-tenant-scope.ts`) that flags any `db.select/update/delete` on an org-scoped table whose `.where` doesn't reference `withTenant` or `organizationId`. (b) A **Postgres RLS** rollout: `ALTER TABLE ... ENABLE ROW LEVEL SECURITY` with `CREATE POLICY org_isolation USING (organization_id = current_setting('app.org_id')::uuid)`, and a thin `withOrgSession(orgId, fn)` wrapper that issues `SELECT set_config('app.org_id', $1, true)` as the first statement in each `db.batch`. Because neon-http is stateless per request, the GUC must be set inside the same batch as the query — feasible for batched writes; reads get the lint rule + a `dbForOrg(orgId)` factory that pre-binds the filter.

**3.2 Generalize the queue.** Promote `communication_jobs` into a generic `jobs` table (or add `job_type` + polymorphic `payload jsonb` to a new `background_jobs`): columns `id, organization_id, job_type, payload jsonb, status(pending|processing|sent|failed|dead), priority, scheduled_for, started_at, completed_at, attempts, max_attempts, lease_expires_at, error_message, dedupe_key`. Add `uniqueIndex(org, job_type, dedupe_key)` for idempotent enqueue and a `background_jobs_claimable_idx ... WHERE status IN ('pending','failed')`. A single `drainJobs(handlers, limit)` reuses the existing atomic-claim pattern; a `lease_expires_at` reclaims jobs orphaned by a serverless timeout (the current queue lacks this). Add a **dead-letter** state and a `jobs` observability endpoint. New generic drain cron `/api/cron/process-jobs` at `* * * * *`; existing comms jobs migrate onto it.

**3.3 Analytics seam (lean).** Two increments, no new infra first. (a) **Materialized views** in a `analytics` schema (`mv_org_daily_metrics`, `mv_tech_conversion`, `mv_booking_funnel`) refreshed by a nightly `/api/cron/refresh-analytics` — hand-authored migrations (drizzle-kit can't emit MV) following the existing trigger-migration precedent. Admin dashboards read MVs, never live tables. (b) When it pays off: a **Neon read replica** (or logical-replication to a columnar store) so analytical reads never contend with OLTP, and a `feature_store` table (`org_id, entity_type, entity_id, features jsonb, computed_at`) the dispatch scorer and conversion model read.

**3.4 Observability depth.** Turn on tracing behind an env sample rate; add a `withSpan(name, {org_id}, fn)` helper and instrument the money + dispatch + queue-drain paths; emit queue-depth and job-failure **metrics**; wire a dead-letter alert. Tag every Sentry scope and log line with `org_id`/`request_id` via an `AsyncLocalStorage` context set in middleware.

**3.5 Migration gate.** Add a `predeploy` step (GitHub Action / Vercel deploy hook) that runs `db:migrate` before promoting the build, plus a startup **drift check** that compares `drizzle/meta` journal count to `__drizzle_migrations` and refuses (or loudly warns via Sentry) on mismatch.

## 4. Phased build plan

**Phase 0 — Migration safety + queue schedule (1 wk).** Fix `process-communications` cron to `* * * * *` in `vercel.json`. Add `predeploy` migration gate (CI action) and a boot-time drift check in `src/lib/db/migrate.ts` + a health route. *Touches:* `vercel.json`, `.github/workflows/`, `src/lib/db/migrate.ts`, `src/app/api/health/route.ts`.

**Phase 1 — Tenancy defense-in-depth (3 wks).** Ship the CI lint rule for un-scoped org queries; add `dbForOrg`/`withOrgSession` helpers; pilot RLS on the 5 highest-risk tables (`customers`, `service_requests`, `messages`, `invoices`, `customer_sessions`) via a hand-authored migration + GUC-in-batch. *Touches:* `scripts/lint-tenant-scope.ts`, `src/lib/db/tenant.ts`, new `drizzle/00XX_rls.sql`, batch call sites.

**Phase 2 — Generic durable queue (4 wks).** Add `background_jobs` table + `lease_expires_at` reclaim + dead-letter; extract `drainJobs`/`enqueueJob` from `job-queue.ts`; add `/api/cron/process-jobs`; migrate comms onto it. *Touches:* `src/lib/db/schema.ts`, `drizzle/`, `src/lib/jobs/*`, `src/lib/communication/job-queue.ts`, `src/app/api/cron/`.

**Phase 3 — Observability depth (3 wks).** `AsyncLocalStorage` request context with `org_id`; `withSpan` helper; instrument money/dispatch/drain; queue-depth + failure metrics; dead-letter Sentry alert; default `SENTRY_TRACES_SAMPLE_RATE` to a small non-zero in prod. *Touches:* `src/instrumentation.ts`, `src/lib/observability/*`, `src/lib/logger.ts`, `src/lib/jobs/*`.

**Phase 4 — Analytics via materialized views (4 wks).** `analytics` schema + MVs (hand-authored migration); `/api/cron/refresh-analytics`; repoint admin dashboards. *Touches:* `drizzle/`, `src/app/api/cron/refresh-analytics/`, `src/lib/admin/*-queries.ts`.

**Phase 5 — Read replica + feature store (6+ wks, deferred).** Neon read replica routing for analytical reads; `feature_store` table feeding dispatch scoring/conversion models. *Touches:* `src/lib/db/index.ts` (replica client), `schema.ts`, dispatch scorer.

## 5. Effort, risks, reuse-first

**Reuse, don't build:** the atomic-claim queue pattern already exists — generalize it, don't import BullMQ/a broker (no persistent process on Vercel anyway). Keep `after()` for intra-request work; keep Vercel crons as the scheduler. Reuse the hand-authored-trigger-migration precedent for MVs and RLS. Reuse Sentry+OTel wiring (already degrade-safe) — just deepen it. **Do NOT** build a Kafka/event-bus, a real-time streaming warehouse, or trained ML forecasting early (strategy doc §6: "don't build the ML forecasting platform early" — deterministic aggregates first).

**Risks:** (1) RLS + neon-http statelessness — the GUC must live in the same batch; get this wrong and reads silently bypass the policy, so lead with reads-via-`dbForOrg` and treat RLS as backstop, not primary. (2) Migration gate must fail the deploy, not just warn, or drift persists. (3) MV refresh contends with OLTP on the same Neon endpoint until Phase 5's replica — schedule off-peak. (4) Lease-reclaim can double-send if a job's side effect (SMS) succeeded before the timeout — keep provider-level idempotency (`external_id`) as the true guard.

**Key gaps vs. Probook-class:**

- No defense-in-depth for tenant isolation — withTenant is app-level only; a forgotten filter leaks cross-tenant rows with no RLS/GUC/lint backstop
- No generic durable job queue — the atomic-claim communication_jobs queue exists but is hard-wired to comms; no lease/reclaim for serverless-timeout orphans, no dead-letter, no per-tenant fan-out
- Migrations don't run on deploy — manual db:migrate causes schema drift that 500s .returning() writes; no predeploy gate or drift check
- process-communications cron scheduled daily (0 5 * * *) despite 'every minute' intent — comms latency ceiling
- Observability is shallow — traces default off (tracesSampleRate=0), no custom spans, no org_id/request_id tagging, no metrics, no SLOs, no queue-depth or dead-letter alerting
- No data platform — zero warehouse/read-replica/materialized views/feature store; analytical reads would contend with live OLTP on the same Neon HTTP endpoint
- Scale ceilings unmanaged — HTTP-per-query N+1 costs, single-invocation cron drains with no tenant sharding, sequential per-job awaits bound by ~60s serverless limit
- Monolithic 2909-line schema.ts (62 tables) — single-file coupling risk as the platform grows

**Phased build:**

- **Phase 0 — Migration safety + queue cadence** — Fix process-communications cron to every-minute in vercel.json; add a CI predeploy migration gate and a boot-time drift check (journal count vs __drizzle_migrations) surfaced on a health route. Touches vercel.json, .github/workflows, src/lib/db/migrate.ts.
- **Phase 1 — Tenancy defense-in-depth** — CI lint rule flagging un-scoped org queries; dbForOrg/withOrgSession helpers; pilot Postgres RLS + set_config GUC-in-batch on the 5 highest-risk tables via hand-authored migration. Touches scripts/lint-tenant-scope.ts, src/lib/db/tenant.ts, drizzle/.
- **Phase 2 — Generic durable queue** — Add background_jobs table with lease_expires_at reclaim + dead-letter; extract drainJobs/enqueueJob from the existing communication_jobs atomic-claim pattern; add /api/cron/process-jobs; migrate comms onto it. Touches schema.ts, drizzle/, src/lib/jobs/*, src/lib/communication/job-queue.ts.
- **Phase 3 — Observability depth** — AsyncLocalStorage request context with org_id/request_id; withSpan helper instrumenting money/dispatch/drain; queue-depth + job-failure metrics; dead-letter Sentry alert; enable a small prod trace sample rate. Touches src/instrumentation.ts, src/lib/observability/*, src/lib/logger.ts.
- **Phase 4 — Analytics via materialized views** — analytics schema + mv_org_daily_metrics / mv_tech_conversion / mv_booking_funnel (hand-authored migrations); /api/cron/refresh-analytics nightly; repoint admin dashboards to MVs instead of live tables. Touches drizzle/, src/app/api/cron/refresh-analytics/, src/lib/admin/*-queries.ts.
- **Phase 5 — Read replica + feature store (deferred)** — Route analytical reads to a Neon read replica so they never contend with OLTP; add a feature_store table feeding the dispatch scorer and per-tech conversion models. Deliberately last and lean per the strategy doc. Touches src/lib/db/index.ts, schema.ts, dispatch scorer.

**Adversarial review findings:**

- _major_ — The headline RLS 'defense-in-depth' (§3.1 / Phase 1) is internally inconsistent under neon-http and, as written, provides ~zero protection on the read path where leaks actually occur. The chapter proposes 'CREATE POLICY org_isolation USING (organization_id = current_setting(\'app.org_id\')::uuid)' with the GUC set via 'SELECT set_config(\'app.org_id\', $1, true)' as the first statement in each db.batch. But it then admits 'reads get the lint rule + a dbForOrg factory that pre-binds the filter.' Under neon-http every standalone SELECT is its own HTTP request = its own implicit transaction, so a set_config(...,true) [transaction-local] cannot be seen by a non-batched read. Net: RLS only covers batched writes; the majority of queries (single-statement reads) fall back to the app filter, so the DB-level guard sold as the invariant is absent exactly where 'a single query that forgets withTenant silently returns cross-tenant rows.' Worse, RLS does not apply to a table's owner role unless FORCE ROW LEVEL SECURITY is set and the app connects as a non-owner role — neither is mentioned. As written (owner role, no FORCE) 'ENABLE ROW LEVEL SECURITY' is a silent no-op (false security); if FORCE + non-owner role is added, every non-batched read runs with no GUC and current_setting('app.org_id') throws 'unrecognized configuration parameter', breaking the app. → **Fix:** Either drop RLS and invest the 3 weeks entirely in the CI lint rule (scripts/lint-tenant-scope.ts) + a dbForOrg factory that makes org-scoping non-optional (the genuinely effective backstop under a stateless HTTP driver), or if RLS is kept: (1) provision a dedicated non-owner app DB role and ALTER TABLE ... FORCE ROW LEVEL SECURITY; (2) write policies with current_setting('app.org_id', true) (missing_ok) so an unset GUC denies rather than errors; (3) accept that enforcement requires routing reads through db.batch([set_config, query]) — cost/benefit that per-read double round-trip vs. just trusting dbForOrg. Do not describe RLS as active defense-in-depth for reads until the driver constraint is resolved.
- _major_ — ROI / over-scope for the actual target. This is a single live shop (Spears Services, ai-hvac-agent-lovat.vercel.app) whose 11 crons all run once daily. The chapter budgets 22 weeks ('effortWeeks':22) with ~14 weeks of pre-deferral platform work framed as a 'Probook-class platform layer' — including the 3-week RLS pilot that (per the finding above) buys little real read protection under neon-http. The strategy doc it cites already flags the data platform as 'deliberately last and lean.' Building the operating substrate of a 100-engineer platform for one contractor risks spending the most weeks on the lowest-yield item (RLS) before the highest-yield, low-cost ones (lint rule, queue-schedule fix, dead-letter alerting). → **Fix:** Front-load the cheap high-yield wins (Phase 0 cron-schedule fix, the tenant lint rule, dead-letter/queue-depth alerting, migration gate) and gate RLS, the generic-queue rewrite, and analytics MVs behind an actual second tenant / scale trigger. Re-baseline effort against 'what a live single shop needs now' rather than the Probook bar.
- _minor_ — Factual overstatement: 'Every one of the 62 tables in src/lib/db/schema.ts carries organization_id uuid NOT NULL.' Two of the 62 tables do not — organizations (the tenant root) and platform_audit_log (platform-level, cross-org). This matters because the proposed blanket 'ALTER TABLE ... ENABLE ROW LEVEL SECURITY' and the lint rule must explicitly exclude platform-scoped tables or they will misfire on them. → **Fix:** Correct the claim to '60 of 62 tables are org-scoped; organizations and platform_audit_log are platform-level.' Have the lint rule and any RLS rollout key off an explicit org-scoped-table allowlist/denylist rather than 'every table.'
- _minor_ — Generalizing communication_jobs into a generic background_jobs with 'polymorphic payload jsonb' (§3.2 / Phase 2) risks regressing two properties the current table deliberately has: (a) recipient PII is stored as per-column AES-256-GCM ciphertext (recipient_phone_encrypted / recipient_email_encrypted) — a generic jsonb payload would tempt storing PII unencrypted in a blob; (b) FK columns (customerId/serviceRequestId with onDelete cascade) auto-purge orphaned jobs when a customer/request is deleted (documented in the schema comment 'a deleted customer/request auto-purges its orphan jobs') — a jsonb payload loses that cascade, which also has GDPR-erasure implications given the project's erasure work. → **Fix:** Keep encrypted recipient columns and the FK cascade columns as first-class columns on background_jobs (not inside payload), and restrict payload jsonb to non-PII template/context data. Add the GDPR-cascade requirement to the Phase 2 acceptance criteria.
- _minor_ — Phase 0 assumes per-minute crons are freely available ('Fix process-communications cron to * * * * *' plus a new /api/cron/process-jobs at '* * * * *'). This is feasible only because the project is on Vercel Pro (evidenced by 11 cron jobs — Hobby caps at 2), but the chapter never states the tier dependency, and per-minute polling means each drain cron fires 1440×/day issuing DB round-trips even when the queue is empty (2 such crons ≈ 2,880 idle invocations/day) for a shop that sends a handful of messages/day. → **Fix:** Note the Vercel-Pro dependency explicitly, and consider a coalesced cadence (e.g. every 5 min) or enqueue-time after() kick + a low-frequency safety-net cron, rather than blanket per-minute polling, to avoid burning invocations on an empty queue.
- _minor_ — The boot-time drift check (§3.5 / Phase 0) is described as living in 'src/lib/db/migrate.ts + a health route' and comparing 'drizzle/meta journal count to __drizzle_migrations.' instrumentation.ts register() runs at build time too and on every cold start; a DB round-trip there adds cold-start latency and could throw during next build (which is exactly why db/index.ts uses a lazy Proxy to avoid touching DATABASE_URL at build). → **Fix:** Put the drift check only in an on-demand health route (or a predeploy CI step), never in register()/build. Guard it behind a runtime check and make it warn-to-Sentry rather than refuse, to avoid taking the app down on a benign journal mismatch.

---

<a name="11-aiml-evals"></a>
## 11. The AI/ML Platform & Evals Layer: Model Routing, Guardrails, Offline+Online Evals, and the Dispatch/Duration Learning Loops

_Effort: ~8 engineer-weeks · Reviewer verdict: **needs-work**_

## 1. The bar: what a Probook-class product does here

An Avoca/ServiceTitan-class platform treats the LLM layer as an *operated discipline*, not a feature. Concretely it has: (a) **model & prompt management** — a registry of models with per-tenant selection, versioned prompts, staged/canary rollout, and cost budgets per surface; (b) **structured output** with schema validation and repair; (c) **layered guardrails** — input jailbreak/injection screening and output safety screening (pricing, false-booking, dangerous-DIY, PII cross-tenant leakage), enforced deterministically so a prompt jailbreak can't defeat them; (d) **offline evals** — golden datasets + CI gates that block a merge when a safety property regresses, plus an LLM-judge tier for quality; (e) **online evals** — production turn telemetry, drift detection, guardrail-hit dashboards, sampled real transcripts fed back into the golden set; and (f) **learning loops** — the duration/dispatch/conversion models are calibrated against *actual outcomes* (job actual minutes vs. estimate, tech assignment → job success), with the deterministic scorer as the always-safe fallback. The through-line: quality regressions are silent, so the moat is the harness that makes them loud.

## 2. Current-state gap analysis

This repo is already unusually strong on this axis — the competitive plan rates it "HAVE (good)" (`docs/superpowers/plans/2026-06-24-probook-competitive-analysis-and-plan.md` §2.11). What exists:

- **Model routing.** `src/lib/ai/provider.ts` has `resolveModelEntry(orgId)` → `getModel()`/`getExtractionModel()`. It reads `organizationSettings.aiModelId` (schema.ts:1021), resolves against a static `MODEL_REGISTRY` (`model-registry.ts`), and **silently falls back** to `DEFAULT_MODEL_ID` ("qwen-dashscope") on any misconfig — no orgId, unknown id, missing key (`hasKey`), or DB read failure. It explicitly uses `provider.chat(modelId)` (Chat Completions) because the newer Responses API 400s on qwen-max/GLM. Extraction can be forced to a cheaper model via `AI_EXTRACTION_MODEL`. The registry is a pure, no-I/O module; the API key lives ONLY as an env var referenced by name (`apiKeyEnv`), and `listModelChoices()` is a client-safe `{id,label}` projection — keys never cross to the client.

- **Output guardrail.** `output-guardrail.ts` `screenAssistantReply()` is a pure, deterministic net enforcing four hard properties via regex: `PRICE_REGEX`/`PRICE_WORD_REGEX` (pricing, incl. spoken "two hundred dollars" for the voice channel), `FALSE_BOOKING_REGEX`, `DANGEROUS_DIY_REGEX` (with negative lookbehinds so "a tech *will* recharge" doesn't match), and `CREDENTIAL_REGEX`. Violations are swapped for on-brand safe replacements that themselves pass the detectors. The chat route buffers the streamed reply and screens the *assembled* text before the customer sees it.

- **Offline eval / CI gate.** `eval/run-eval.ts` replays `GOLDEN_TRANSCRIPTS` through the *pure* deterministic surface (`routeMessage` + `sanitizeInput`) with zero LLM/DB/network, computing critical vs. non-critical checks (`CRITICAL_CHECKS`: pricing-leak, false-booking, emergency-escalation, injection-block, window-offer-preference, dangerous-diy-refusal, off-scope-deflection). Crucially it **imports the exact runtime regexes** from `output-guardrail.ts`, so the CI gate and runtime net can never drift. This runs in `eval.test.ts` (the 30/30 gate). Layered on top: `judge.ts` (degrade-safe LLM judge, returns `null` on missing key), `ab-compare.ts` (judge-model A/B), `compare-prompts.ts` (prompt A/B over `JUDGE_KNOWLEDGE_PROMPTS`), `behavior-probe.ts` (binary behavior A/B, less noisy than 1–5 scores), and `promptfooconfig.yaml` + `promptfoo/chat-provider.ts` — a real-path eval (buildSystemPrompt → DashScope → guardrail) covering the 6 critical guardrails, plus `promptfoo/redteam-probes.yaml`.

- **Online telemetry.** `bot-telemetry.ts` `recordBotEvent()` writes a PII-free `bot_events` row per turn (routed vs. LLM, intent, action, category, model, latencyMs, escalated) from `after()`, best-effort/never-throws.

- **Learning-loop scaffolding.** `dispatch/duration.ts` = deterministic base table refined by an LLM clamped to `[0.5×,2×] ∩ [15,480]` min, base fallback on any error. `dispatch/score.ts` = pure weighted scorer with an explainable `reasons[]`; `signals.ts` aggregates per-tech signals from real tables.

**The gaps** (what separates "good harness" from "operated platform"):

1. **No prompt versioning/registry.** Prompts are string constants in source; a prompt change ships with code, un-versioned, un-audited, with no canary/rollback. Contrast the disciplined model registry.
2. **Guardrail hits are ephemeral.** `screenAssistantReply` returns violations, but nothing persists them — there's no `guardrail_events` table, so you can't answer "how often did the model try to quote a price last week, and on which model?"
3. **Loops are open, not closed.** `duration.ts` estimates but no table stores *actual* on-site minutes, so the base table can never be recalibrated. `score.ts` weights are hardcoded "provisional" with no outcome table (dispatch → job success) to tune against.
4. **Online eval is shallow.** `bot_events` supports aggregates but there's no drift monitor, no sampling of real transcripts into the golden set, no alerting when critical-check pass-rate or guardrail-hit-rate moves.
5. **Judge bias + no cost governance.** The judge self-grades (disclosed in `compare-prompts.ts`); there's no independent judge and no per-surface token budget / cost ceiling.
6. **No structured-output validation contract.** Extraction parses free-text; there's no shared schema-validate-and-repair wrapper around `generateText`.

## 3. Target architecture + data model

Keep the reuse-first spine: **deterministic is the source of truth; the LLM is a clamped, degrade-safe refinement; the eval regexes are single-source-of-truth shared between runtime and CI.** Add three durable tables and three thin modules.

**Tables** (Drizzle, neon-http → `db.batch`/guarded UPDATE, migrations run manually via `npm run db:migrate`):

- `prompt_versions` — `id, organizationId (nullable=global), surface ('chat'|'voice'|'extraction'|'judge'), label, body (text), checksum, status ('draft'|'canary'|'active'|'retired'), rolloutPct (int), createdBy, createdAt`. Unique partial index on `(surface, organizationId) WHERE status='active'`.
- `guardrail_events` — `id, organizationId, sessionId, surface, channel, violations (text[]), model, createdAt`. PII-free (violation *tags* only, never the offending text), mirroring the `bot_events` contract. Indexed `(organizationId, createdAt)` and `(organizationId, surface)`.
- `job_duration_actuals` — `id, organizationId, serviceRequestId, jobType, systemType, equipmentAgeBand, estimatedMinutes, estimatedSource ('default'|'llm'), actualMinutes, createdAt`. Feeds recalibration of `JOB_DURATION_DEFAULTS`. (Pair with a `dispatch_outcomes` table later for the scorer loop.)

**Modules:**

- `src/lib/ai/prompts/registry.ts` — `resolvePrompt(surface, orgId)` mirroring `resolveModelEntry`: reads `prompt_versions`, deterministic-hash bucket on `sessionId` for canary `rolloutPct`, **silent fallback to the in-source frozen constant** on any miss. Preserves the FROZEN-safety-text invariant (memory: chatbot-prompt-tuning) by concatenating the immutable safety block server-side, never from the versioned body.
- `src/lib/ai/structured.ts` — `generateStructured(model, schema, prompt)`: `generateText` → tolerant JSON extract (reuse `judge.ts`'s `/\{[\s\S]*\}/` parse) → Zod validate → one repair retry → typed fallback. Wraps extraction + duration.
- `src/lib/ai/eval/online.ts` — nightly job: query `bot_events` + `guardrail_events` for period-over-period drift, sample N real (redacted) transcripts into a review queue for promotion to `golden-transcripts.ts`.

**Endpoints:** extend the super-admin panel (already model-switcher-capable) with `POST /api/admin/prompts` (create/promote/rollback a `prompt_version`, audited) and `GET /api/admin/ai/health` (guardrail-hit rate, critical-check pass rate, per-model cost/latency, drift deltas).

## 4. Phased build plan

**Phase 0 — Persist guardrail hits (1–2 days, highest ROI).** Add `guardrail_events` (migration + schema.ts). Where the chat/voice routes call `screenAssistantReply`, on `!safe` enqueue `recordGuardrailEvent({...violations, surface, model})` inside the existing `after()`, best-effort like `recordBotEvent`. Files: `schema.ts`, new migration, `src/lib/ai/guardrail-telemetry.ts`, `src/app/api/chat/route.ts`, voice turn handler. Ships observability with zero behavior change. Verify: unit test that a violating reply writes exactly one row with the right tags and no message text.

**Phase 1 — AI health dashboard / online eval (3–5 days).** Aggregate `bot_events` + `guardrail_events` into `GET /api/admin/ai/health`: LLM-fallback rate, per-model latency/volume, guardrail-hit rate by type, escalation rate. Add `eval/online.ts` drift deltas (this week vs. last). Files: `src/lib/ai/eval/online.ts`, admin route, an Insights panel component. Verify: seeded rows produce correct rollups; matches memory's "Bot analytics" intent.

**Phase 2 — Structured-output contract (2–3 days).** `src/lib/ai/structured.ts` with Zod + repair retry + typed fallback; migrate `extract.ts`/`extraction-schema.ts` and `duration.ts` to use it. Reuse the existing extraction-schema tests. Verify: fuzz malformed model outputs → always returns a valid typed object, never throws.

**Phase 3 — Prompt registry + canary (5–8 days).** `prompt_versions` table + `prompts/registry.ts` `resolvePrompt` (silent fallback + FROZEN-safety-text concatenation server-side). Wire `buildSystemPrompt` to consult the registry; add super-admin CRUD/promote/rollback with audit-log entries. Deterministic `sessionId`-hash bucketing for `rolloutPct`. Files: `schema.ts`, migration, `registry.ts`, `route.ts`, admin prompts route + UI. Verify: a canary at 10% routes ~10% of a hashed session sample to the candidate; rollback restores the active version atomically (guarded UPDATE, no transaction). **Gate: `compare-prompts`/`behavior-probe` must show non-regression before promote.**

**Phase 4 — Close the duration loop (3–4 days).** `job_duration_actuals` table; on job completion, `after()` writes estimated vs. actual. A weekly `recalibrate` script recomputes `JOB_DURATION_DEFAULTS` per org from actuals (median, min sample size guard), surfaced as a *suggested* override the admin approves — never auto-mutating the safe base blind. Files: `schema.ts`, migration, `dispatch/duration-actuals.ts`, `scripts/recalibrate-durations.ts`. Verify: with synthetic actuals the suggested base moves toward the median and is clamped.

**Phase 5 — Golden-set flywheel + independent judge (ongoing).** `online.ts` samples redacted production transcripts into a promotion queue → hand-curated additions to `golden-transcripts.ts` (grows the 30/30 gate). Add a second registry model as the judge to break the self-grading bias in `ab-compare.ts`/`compare-prompts.ts`. Add a per-surface token-budget check to `bot-telemetry` aggregates (alert, don't block).

## 5. Effort, risks, reuse-first shortcuts

**Effort:** ~6–9 engineer-weeks total. Phases 0–2 (~2 wks) are pure wins with near-zero regression risk and should go first. Phase 3 (prompt registry, ~1.5–2 wks) is the highest-value/highest-care item. Phases 4–5 are the genuine "learning loop" and can trail.

**Risks & mitigations.** (1) *Prompt registry defeating the frozen-safety invariant* — the single largest risk. Mitigation: the versioned `body` is NEVER the whole prompt; `resolvePrompt` returns only the tunable middle, and `buildSystemPrompt` concatenates the immutable safety block + scope block from source. The `promptfoo` 6-guardrail eval and the deterministic gate run against any candidate before promote. (2) *neon-http has no transactions* (memory) — canary promote/rollback and the active-version swap use `db.batch`/guarded UPDATE with a partial-unique index, not `db.transaction()`. (3) *Migrations don't auto-run on deploy* (memory) — each new table needs a manual `npm run db:migrate`; guard `.returning()` writes against schema drift. (4) *Recalibration poisoning* — never auto-apply a learned base; gate behind admin approval and a min-sample-size + clamp, keeping the deterministic table the trusted default.

**Reuse-first — do NOT build:** a bespoke eval framework (promptfoo is already wired, MIT, real-path); a vector store / RAG stack (the deterministic knowledge-base + router already covers FAQ; the plan defers this); a training/feature-store platform (the competitive plan §5 explicitly says start with aggregates, models "deliberately last and lean"); a new model-abstraction layer (`provider.ts` + `@ai-sdk/openai` `.chat()` already normalizes qwen/GLM); a separate guardrail library (the shared-regex single-source-of-truth pattern is the asset — extend it, don't replace it). The winning move is to *persist what you already compute* (guardrail hits, duration actuals) and *version what you already hardcode* (prompts), reusing the exact `resolveModelEntry`/`recordBotEvent`/`screenAssistantReply` patterns already proven in the codebase.

**Key gaps vs. Probook-class:**

- No prompt versioning/registry: prompts are un-versioned source constants with no canary, rollback, or audit — unlike the disciplined model registry in model-registry.ts
- Guardrail violations from screenAssistantReply are never persisted — no guardrail_events table, so no 'how often did the model try to quote a price' observability
- Duration/dispatch loops are open: dispatch/duration.ts estimates but no job_duration_actuals table exists to recalibrate JOB_DURATION_DEFAULTS; score.ts weights are hardcoded 'provisional' with no dispatch-outcome table
- Online eval is shallow: bot_events supports aggregates but there's no drift monitor, no alerting on critical-check pass-rate or guardrail-hit-rate movement, no sampling of real transcripts into the golden set
- LLM judge self-grades (disclosed bias in compare-prompts.ts) with no independent judge model; no per-surface token/cost budget governance
- No shared structured-output validate-and-repair contract around generateText (extraction parses free-text ad hoc)

**Phased build:**

- **Phase 0 — Persist guardrail hits** — Add guardrail_events table (schema.ts + migration, PII-free violation tags only) and record from after() when screenAssistantReply returns !safe, best-effort like recordBotEvent. Zero behavior change, highest ROI. Files: schema.ts, migration, src/lib/ai/guardrail-telemetry.ts, api/chat/route.ts, voice turn handler.
- **Phase 1 — AI health dashboard / online eval** — GET /api/admin/ai/health aggregating bot_events + guardrail_events (LLM-fallback rate, per-model latency/cost, guardrail-hit rate, escalation rate) plus eval/online.ts period-over-period drift deltas. Files: src/lib/ai/eval/online.ts, admin route, Insights panel.
- **Phase 2 — Structured-output contract** — src/lib/ai/structured.ts: generateText → tolerant JSON extract (reuse judge.ts parse) → Zod validate → one repair retry → typed fallback. Migrate extract.ts and duration.ts. Never throws. Reuse extraction-schema tests.
- **Phase 3 — Prompt registry + canary** — prompt_versions table + prompts/registry.ts resolvePrompt mirroring resolveModelEntry (silent fallback to frozen source constant, FROZEN-safety-text concatenated server-side, sessionId-hash canary bucketing). Super-admin CRUD/promote/rollback with audit. Gate promotion on compare-prompts/behavior-probe + promptfoo non-regression. Uses db.batch (no transactions).
- **Phase 4 — Close the duration loop** — job_duration_actuals table; on job completion write estimated vs actual from after(). Weekly recalibrate script recomputes JOB_DURATION_DEFAULTS per org (median, min-sample guard, clamp) as an admin-approved SUGGESTION, never auto-mutating the safe base. Files: schema.ts, migration, dispatch/duration-actuals.ts, scripts/recalibrate-durations.ts.
- **Phase 5 — Golden-set flywheel + independent judge** — online.ts samples redacted production transcripts into a promotion queue for curated addition to golden-transcripts.ts (grows the CI gate). Add a second registry model as judge to break self-grading bias in ab-compare/compare-prompts. Add per-surface token-budget alerting.

**Adversarial review findings:**

- _major_ — Phase 3 bundles canary rollout as the 'highest-value' item: 'Deterministic sessionId-hash bucketing for rolloutPct' and 'a canary at 10% routes ~10% of a hashed session sample to the candidate.' The repo serves one small shop (Spears Services, Johnson City TN). A 10% traffic split yields no statistically usable signal at single-shop volume, and the memory notes measurement is already thin ('eval:ab=models not prompts; judge needs keys'). The genuine win in Phase 3 is versioning + promote + rollback + audit; the % canary machinery is over-scoped relative to traffic. → **Fix:** Ship prompt_versions with versioning/promote/rollback/audit and the FROZEN-safety concatenation now; gate promotion on the OFFLINE compare-prompts/behavior-probe (already stated as the gate). Defer rolloutPct/sessionId-bucket canary until multi-tenant/SaaS volume exists (per productization roadmap), so effort tracks real traffic.
- _minor_ — Gap #6 overstates the current state: 'No structured-output validation contract. Extraction parses free-text; there's no shared schema-validate-and-repair wrapper around generateText.' extract.ts already runs extractionSchema.safeParse (Zod), then ONE bounded repair pass keyed off ok, then a typed fallback — covered by extract-repair.test.ts. Phase 2's 'migrate extract.ts/extraction-schema.ts... to use it' risks re-plumbing working, well-tested code for marginal gain. → **Fix:** Reframe the gap as 'no GENERIC wrapper; duration.ts parses free-text (Number.parseInt on model text) with no schema.' Scope structured.ts to duration.ts and any new callers; leave the shipped extraction validate+repair path intact rather than migrating it.
- _minor_ — Proposed prompt_versions index: 'Unique partial index on (surface, organizationId) WHERE status=\'active\''. organizationId is declared nullable (global prompts). Postgres treats NULL as distinct in unique indexes, so two GLOBAL (organizationId IS NULL) active rows for the same surface would NOT be rejected — the single-active invariant is unenforced exactly for the global fallback prompts. → **Fix:** Enforce global uniqueness explicitly: index on (surface, COALESCE(organization_id,'GLOBAL')) WHERE status='active', or a separate partial unique index for the org IS NULL case.
- _minor_ — Phase 3 verify step: 'rollback restores the active version atomically (guarded UPDATE, no transaction).' Under the single-active unique index, moving 'active' between two rows requires an ordered demote-then-promote (two row writes); a single guarded UPDATE cannot atomically relocate the active flag across rows, and neon-http has no interactive transaction. → **Fix:** Do the demote+promote pair via db.batch (single neon-http request), relying on resolvePrompt's frozen-source fallback to cover any momentary no-active window; drop the 'atomic single guarded UPDATE' phrasing.

---

<a name="12-security-compliance"></a>
## 12. Security, Compliance & Trust: From a Well-Built Single-Tenant Auth Model to a SOC2-Attestable, TCPA-Safe Multi-Tenant Platform

_Effort: ~15 engineer-weeks · Reviewer verdict: **needs-work**_

## 1. The bar: what a Probook-class product does here

A home-services "AI operating system" is trusted with two things that make security non-optional: **customer PII at population scale** (names, phones, addresses, service history for whole metros) and **money movement** (estimates, invoices, payments, financing). On top of that it runs **outbound revenue campaigns** — the exact activity that TCPA, the FCC's one-to-one consent rule, and state mini-TCPAs police most aggressively, with statutory damages of $500–$1,500 *per message*. So the security bar is not "we have login." It is:

- **Auth & session** — separate principals (platform operator, org admin tiers, field technician, customer-portal) with mutually non-aliasing sessions, MFA for privileged tiers, brute-force throttling, and short-lived + revocable tokens.
- **Encryption & key management** — PII encrypted at rest with envelope encryption and rotatable keys (KMS/DEK, not one static env var), searchable via blind indexes, TLS everywhere.
- **Consent as a first-class ledger** — every comms send gated by a consent record with **provenance** (who opted in, when, what language, from what channel), quiet-hours, STOP/HELP/START, and a **DNC/litigator scrub** on the outbound path.
- **Audit & non-repudiation** — an append-only, tamper-evident log of every mutation (human, AI, or system actor), retained years, exportable for a customer or regulator.
- **Tenancy isolation** — provably no cross-org read/write, ideally enforced at the database (RLS) not just in application code.
- **SOC2 Type II path** — access reviews, change management, vendor management, incident response, encrypted backups, and the evidence to attest it.
- **Location-data consent** — the newest surface: live technician GPS, which is worker-surveillance-regulated (BIPA-adjacent, state consent laws).

## 2. Current-state gap analysis — this repo is unusually strong here

This is the rare domain where the repo is *ahead* of the average Series-A codebase. The primitives are real and well-reasoned:

**Encryption + blind index — built and correct.** `src/lib/crypto.ts` does AES-256-GCM (`encrypt`/`decrypt`, IV+authTag+ciphertext base64) plus a domain-separated HMAC-SHA256 `blindIndex` (label `hvac-blind-index-v1`) so the deterministic search key can't collide with the AES key. `encryptFields`/`decryptFields` are immutable. The `customers` table (schema.ts:676) stores `nameEncrypted`/`phoneEncrypted`/`emailEncrypted`/`addressEncrypted` with `emailHash`/`phoneHash` backing **partial unique indexes** per org (`customers_org_email_hash_unique`) — atomic dedupe at the DB layer.

**Auth — two non-aliasing session types, done carefully.** Admin JWT (`src/lib/auth/config.ts`, HS256, 24h, `AUTH_SECRET` ≥32 chars) with runtime claim validation that *rejects* any non-admin role. The new **technician session** (`tech-config.ts`/`tech-session.ts`) is a distinct cookie (`hvac_tech_session`) AND a distinct `aud` claim (`hvac-tech`) so an admin token can't be replayed into the tech verifier and vice-versa. Cookies are `httpOnly`, `secure`, `sameSite: "strict"`. Role hierarchy and privilege-escalation guards live in `authz.ts` (`canManageRole`, `canAssignRole` — which *never* grants `super_admin`), plus an env-allowlisted `isPlatformAdmin` (cross-org operator, deliberately separate from in-app `super_admin`). Login (`api/auth/login/route.ts`) runs constant-time-ish bcrypt against a dummy hash for every ineligible case (no timing/enumeration leak) and per-IP throttling via `slidingWindow`.

**Consent — a genuine gate, not a flag.** `src/lib/communication/consent.ts` `checkSendAllowed` reads per-customer `communicationPreferences` (global `doNotContact`, per-channel, per-type toggles, timezone), enforces **quiet hours** with a per-trigger `TRIGGER_RULES` table distinguishing transactional (exempt) from marketing (gated), and `classifySmsKeyword`/`setDoNotContactByPhone` implement CTIA STOP/HELP/START via blind-index lookup.

**Location consent — opt-in and revocable.** `users.locationSharingEnabled` (default false) + `locationConsentUpdatedAt` (schema.ts:302), the `/api/tech/location/consent` route gated on `getTechSession`, and the ingest route re-checks per fix.

**Audit + erasure + export — present.** `logAudit` (audit.ts) with `actorType` human|ai|system; `auditLog` table with org/user/session/entity/ip. `platformAuditLog` (schema.ts:2889) is deliberately **not** org-FK'd so it survives a tenant-purge cascade. `erasure-queries.ts` `anonymizeCustomer` (GDPR right-to-erasure, retains de-identified financial history, nulls blind indexes) and `purgeOrganization`; `export-queries.ts` for portability. `session-csrf.ts` Origin-guards the SameSite=None widget endpoints; `cron-auth.ts` timing-safe Bearer; `observability/sentry.ts` scrubs PII before it leaves the process.

**The concrete gaps** (what's missing vs. the bar):

1. **No MFA** anywhere — a stolen admin password is total org compromise.
2. **Single static encryption key.** `ENCRYPTION_KEY` is one env var; there is **no key rotation, no envelope/DEK scheme, no versioned ciphertext**. Rotating the key today would require re-encrypting every row with no migration path (ciphertext carries no key-id).
3. **Tenancy is application-only.** `withTenant` (db/tenant.ts) is a discipline enforced by 103 hand-written `getAdminSession` call sites — one forgotten `withTenant` is a cross-tenant breach. No Postgres RLS backstop.
4. **No consent *provenance* / TCPA proof.** `communicationPreferences` stores *current state* (booleans) but **no immutable event trail**: when consent was captured, the exact disclosure language, channel, IP. For the **outbound revenue campaigns** the plan calls for, there is **no DNC/litigator scrub** and **no per-campaign one-to-one consent record** — this is the single biggest compliance blocker to shipping outbound voice/SMS.
5. **Audit log is not tamper-evident** (no hash chain), **no route-level enforcement** (each route calls `getAdminSession` manually; nothing *forces* it), and no defined retention.
6. **No session revocation.** JWTs are valid until 24h expiry; deactivating a user doesn't kill live sessions.
7. **No SOC2 evidence scaffolding** (access reviews, change log, vendor register, backup verification).

## 3. Target architecture & data model

**Envelope encryption with rotation.** Introduce a `crypto/kms.ts` layer: a **KEK** (from a real KMS — AWS KMS / a managed secret) wraps per-org or per-generation **DEKs** stored in a new `encryption_keys` table (`id`, `organizationId?`, `wrappedDek`, `keyVersion`, `status active|retiring|retired`, `createdAt`). Ciphertext gets a **version prefix** (`v2:<keyId>:<base64>`); `decrypt` dispatches on the prefix, so old `ENCRYPTION_KEY` ciphertext (treated as `v1`) still reads during a lazy re-encrypt-on-write migration. `blindIndex` gains a parallel key-version so index keys rotate too (dual-write both hashes during rotation, then drop v1). This is additive to `crypto.ts` — the `encrypt`/`decrypt`/`encryptFields` signatures don't change for callers.

**Consent ledger (the TCPA moat).** New append-only table `consent_events`: `id, organizationId, customerId, channel (sms|email|voice), scope (transactional|marketing|automated), action (grant|revoke), source (web_form|sms_start|voice_ivr|import|admin), disclosureText, disclosureVersion, ipAddress, capturedAt, actorType`. `communicationPreferences` becomes a **materialized projection** of this ledger (keep the fast-path booleans, but every write also inserts a `consent_events` row). `checkSendAllowed` stays the hot path; a new `assertOutboundConsent` wrapper additionally requires, for `scope=marketing`, a **matching non-revoked grant event** and a **DNC scrub** call.

**DNC / litigator scrub.** New `dnc_suppressions` table (`organizationId, phoneHash, source (internal_stop|national_dnc|litigator_list|reassigned_number), addedAt, expiresAt`) keyed by blind index — reuses the existing `blindIndex`. A `scrubPhone(orgId, phone)` module checks internal STOP + this table; integrate a vendor (Blacklist Alliance / DNC.com) as a scheduled sync (`after()`/cron) rather than a hot-path call.

**Tenancy at the DB.** Add Postgres **Row-Level Security** policies on every `organization_id` table, driven by a per-request `SET LOCAL app.current_org` GUC set in the db wrapper. `withTenant` stays (defense-in-depth), but RLS becomes the backstop so a forgotten filter fails closed.

**MFA + revocation.** `users.totpSecretEncrypted`, `users.mfaEnrolledAt`; a `session_revocations` table (or a `tokenVersion` int on `users` embedded in the JWT — bump to invalidate all sessions on deactivate/password-reset). TOTP via `otplib`.

**Route enforcement.** A single `withAdmin(handler, {minRole})` / `withTech(handler)` HOF wrapping the 103 routes so authz + rate-limit + audit-context are *structurally* guaranteed, not per-route discipline.

**Tamper-evident audit.** Add `auditLog.prevHash`/`rowHash` (SHA-256 over prior hash + row) — cheap hash chain making silent deletion detectable.

## 4. Phased build plan

**Phase 0 — Route-guard consolidation + session revocation (1 wk, shippable).** Add `src/lib/auth/with-admin.ts` and `with-tech.ts` HOFs (authz + `slidingWindow` + populates audit actor/ip). Migrate the 103 call sites incrementally (grep-driven). Add `users.tokenVersion` (migration), embed in both JWTs, check in `verifyToken`/`verifyTechToken`; bump on deactivate/reset. Files: `auth/config.ts`, `tech-config.ts`, `authz.ts`, new HOFs, migration. Verify: a deactivated admin's live cookie 401s.

**Phase 1 — MFA for admin/super_admin (1–2 wk).** `otplib` TOTP enroll/verify, `users.totpSecretEncrypted` (reuse `encryptFields`), recovery codes (hashed like portal tokens). Gate login route to require TOTP for admin-tier. Optional per-org "require MFA" policy. Verify: enroll → login demands code → wrong code 401s.

**Phase 2 — Consent ledger + provenance (1.5 wk).** `consent_events` table; dual-write from every preference mutation and from `setDoNotContactByPhone`; backfill an initial `import` event per existing pref row. Extend `checkSendAllowed`→`assertOutboundConsent`. Capture disclosure text/version at web/voice opt-in points. Files: `communication/consent.ts`, schema, submit-request + IVR paths. Verify: marketing send without a grant event is blocked with `reason: no_consent_record`.

**Phase 3 — DNC/litigator scrub for outbound (1.5 wk, HARD GATE before any outbound campaign).** `dnc_suppressions` table + `scrubPhone`; vendor sync cron (`cron-auth`-guarded); wire into the outbound send path in `communication/job-queue.ts` / `outbound-ledger.ts`. Verify: a listed number is suppressed and logged; STOP writes both the pref and a suppression.

**Phase 4 — Envelope encryption + rotation (2 wk).** `crypto/kms.ts`, `encryption_keys` table, versioned ciphertext prefix, lazy re-encrypt-on-write, dual blind-index during rotation. Backfill job re-encrypts under `after()`/cron in batches (`db.batch`, no transactions). Verify: rotate key, old + new rows both decrypt; blind-index lookups still hit.

**Phase 5 — Postgres RLS backstop (1.5 wk).** `SET LOCAL app.current_org` in the db request wrapper; enable RLS + policies per org table via a hand-authored migration (drizzle-kit can't generate policies — same pattern as the existing 0008 trigger migration in memory). Verify: a query missing `withTenant` still returns zero cross-org rows.

**Phase 6 — Tamper-evident audit + retention (1 wk).** Hash-chain columns on `auditLog`; a verify job; retention policy + encrypted-export of audit for a date range. Verify: mutating a historical row breaks chain verification.

**Phase 7 — SOC2 evidence scaffolding (2–3 wk, mostly process + light code).** Quarterly access-review export (users × roles × last-login), change-management via git+PR (already the workflow), vendor register doc, backup-restore verification runbook, incident-response runbook, encryption/consent/retention policy docs. This is the "attestable" layer — thin code, real paperwork.

## 5. Effort, risks, reuse-first shortcuts

**Total ~13–16 engineer-weeks** for the code phases (0–6); SOC2 (Phase 7) is largely non-eng and can run in parallel.

**Reuse-first — do NOT build:**
- **Don't hand-roll MFA/crypto** — `otplib` for TOTP, a managed KMS for the KEK. Don't invent a key-wrapping scheme.
- **Don't build a DNC list** — sync a vendor (Blacklist Alliance / DNC.com); you only build the `dnc_suppressions` cache + scrub call.
- **Don't rewrite the consent gate** — `checkSendAllowed` and `TRIGGER_RULES` are correct; *wrap*, don't replace.
- **Don't replace the blind-index/encryption design** — it's already sound; only add versioning.
- **Reuse existing patterns:** hashed-token-at-rest (portal/invite tokens) for MFA recovery codes; `after()` for backfills (per the serverless-background-work memory); `db.batch` not transactions (neon-http memory); hand-authored migrations for triggers/RLS (the 0008 precedent).

**Risks:**
- **Key rotation is the highest-risk change** — a bug bricks all PII reads. Mitigate with the versioned-prefix lazy scheme (never a big-bang re-encrypt) and a decrypt fallback path, plus a dry-run that decrypts a sample under both keys before cutover.
- **RLS can silently break legitimate queries** (background/cron jobs with no org context). Enroll RLS table-by-table behind a flag; give system jobs an explicit bypass role.
- **Consent backfill provenance is legally weak** — imported `consent_events` should be marked `source: import` (not fabricated as `web_form`) so an audit shows honest lineage; existing customers may need re-permission for *marketing* before outbound.
- **TCPA is the business-existential risk**, not a technical one: Phase 3 must gate outbound. Shipping outbound voice/SMS *before* the DNC scrub + one-to-one consent record is the mistake that ends the company, not a page-load regression.

The through-line: this repo already earns trust on *storage* (encryption, blind index, erasure, tenancy discipline). The work ahead is earning trust on *identity* (MFA, revocation, RLS) and *outbound* (consent provenance + DNC) — the two surfaces that a lead-scrubbing, campaign-running, money-moving AI platform lives or dies on.

**Key gaps vs. Probook-class:**

- No MFA/2FA for admin or super_admin tiers — a single stolen password is full org compromise
- Single static ENCRYPTION_KEY with no rotation, no envelope/DEK scheme, and no key-version prefix on ciphertext — key rotation is currently impossible without re-encrypting every row
- Tenancy isolation is application-only (withTenant discipline across ~103 hand-written call sites); no Postgres RLS backstop, so one forgotten filter is a cross-tenant breach
- No consent provenance / TCPA proof: communicationPreferences stores current-state booleans but no immutable consent_events ledger (who/when/what-disclosure/IP/channel)
- No DNC / litigator-list scrub on the outbound path — hard blocker for shipping outbound revenue campaigns (voice/SMS) safely
- No one-to-one consent record per marketing campaign (FCC one-to-one rule / mini-TCPAs)
- Audit log is not tamper-evident (no hash chain) and has no defined retention or route-level enforcement — each of 103 routes calls getAdminSession by convention, nothing forces it
- No session revocation — JWTs valid until 24h expiry; deactivating a user or resetting a password does not kill live sessions
- No SOC2 evidence scaffolding: access reviews, change management, vendor register, backup-restore verification, incident-response runbook

**Phased build:**

- **Phase 0 — Route-guard consolidation + session revocation** — Add withAdmin/withTech HOFs wrapping authz + rate-limit + audit-context so enforcement is structural, not per-route discipline; migrate the ~103 getAdminSession call sites incrementally. Add users.tokenVersion embedded in both JWTs and checked in verifyToken/verifyTechToken; bump on deactivate/password-reset to kill live sessions. Files: auth/config.ts, tech-config.ts, new HOFs, migration. ~1 wk.
- **Phase 1 — MFA for admin/super_admin** — otplib TOTP enroll/verify, users.totpSecretEncrypted (reuse encryptFields), recovery codes hashed like portal/invite tokens. Gate the login route to require TOTP for admin-tier; optional per-org require-MFA policy. ~1-2 wk.
- **Phase 2 — Consent ledger + provenance** — New append-only consent_events table (channel, scope, action, source, disclosureText/version, IP, capturedAt); dual-write from every preference mutation and setDoNotContactByPhone; backfill one import event per existing pref row. Extend checkSendAllowed to assertOutboundConsent requiring a matching grant for marketing scope. ~1.5 wk.
- **Phase 3 — DNC / litigator scrub (HARD GATE before any outbound campaign)** — dnc_suppressions table keyed by blindIndex + scrubPhone module; vendor list sync via cron-auth-guarded scheduled job; wire into communication/job-queue.ts and outbound-ledger.ts send path. STOP writes both a pref and a suppression. ~1.5 wk.
- **Phase 4 — Envelope encryption + key rotation** — crypto/kms.ts KEK-wraps per-generation DEKs in an encryption_keys table; versioned ciphertext prefix (v1 = existing ENCRYPTION_KEY); lazy re-encrypt-on-write + batched backfill under after()/cron (db.batch, no transactions); dual blind-index during index-key rotation. ~2 wk.
- **Phase 5 — Postgres RLS backstop** — SET LOCAL app.current_org GUC in the db request wrapper; enable RLS + per-org policies via a hand-authored migration (drizzle-kit can't generate policies — reuse the 0008 trigger-migration pattern). withTenant stays as defense-in-depth; system/cron jobs get an explicit bypass role. ~1.5 wk.
- **Phase 6 — Tamper-evident audit + retention** — Add prevHash/rowHash SHA-256 hash-chain columns to auditLog + a chain-verify job; define retention and an encrypted date-range export for regulators/customers. ~1 wk.
- **Phase 7 — SOC2 evidence scaffolding** — Quarterly access-review export (users x roles x last-login), change management via git+PR, vendor register, backup-restore verification runbook, incident-response runbook, and encryption/consent/retention policy docs. Mostly process, thin code, runs in parallel. ~2-3 wk.

**Adversarial review findings:**

- _major_ — Phase 5's RLS mechanism is architecturally incompatible with the driver the app actually runs. The plan says: 'SET LOCAL app.current_org GUC set in the db wrapper' and 'a query missing withTenant still returns zero cross-org rows.' But db/index.ts uses drizzle-orm/neon-http (confirmed: `import { drizzle } from "drizzle-orm/neon-http"`). neon-http is stateless per request — each single drizzle query is its own HTTP round-trip that autocommits; there is no persistent session/transaction to carry a `SET LOCAL` into the *next* query. `SET LOCAL` only lives inside one transaction, and the codebase's own comments (scheduling-queries.ts:161, 551) note neon-http 'does NOT support db.transaction()'. So a GUC set in a 'db request wrapper' would not be visible to the subsequent SELECT that RLS policies read via current_setting('app.current_org'). RLS would fail closed on EVERY query (empty results), not just cross-org ones. → **Fix:** Either (a) drop the GUC approach and keep tenancy in application code (withTenant) as the enforcement layer, or (b) wrap every query with the SET in a `db.batch([setStmt, query])` (heavy, touches all call sites), or (c) switch the RLS-scoped paths to the neon WebSocket Pool driver (drizzle-orm/neon-serverless) which holds a session — a real architecture change the plan must call out and budget for, and which contradicts the documented neon-http choice. Revisit the '1.5 wk' estimate accordingly.
- _major_ — Over-scoped for the actual deployment. The bar is framed as 'customer PII at population scale ... whole metros' and mandates SOC2 Type II, KMS/DEK envelope encryption, and a litigator-list vendor (Blacklist Alliance / DNC.com). The real system is a single small HVAC shop (Spears Services, Johnson City TN) with no outbound campaigns shipped yet and the existing STOP/HELP/START already implemented (classifySmsKeyword/setDoNotContactByPhone). Phases 4 (KMS), 6-7 (tamper-evident audit + SOC2 evidence scaffolding) are premature relative to current reality, and the per-phase '1-2 wk' estimates (esp. Phase 4 lazy re-encrypt of all rows, Phase 7 SOC2) are optimistic. → **Fix:** Explicitly tier the roadmap to gate the heavy phases behind real triggers: envelope/KMS + SOC2 only when a paying multi-tenant customer or a named auditor exists; DNC scrub only as a hard gate immediately before the first outbound marketing campaign (as Phase 3 already implies). Ship the genuinely cheap, high-value wins first (Phase 0 route-guard HOF + tokenVersion revocation, Phase 1 MFA, Phase 2 consent ledger) and mark 4-7 as conditional, not sequential.
- _minor_ — Phases 2 and 3 propose dual-writes (preference mutation + consent_events insert; STOP write + dnc_suppressions insert) but do not state they must be atomic. On neon-http two separate db.insert calls are two independent autocommitted HTTP statements, so a crash between them leaves the ledger and the projection inconsistent — undermining the 'consent as source of truth' design. Phase 4 correctly mentions db.batch but Phases 2/3 omit it. → **Fix:** Specify db.batch([prefUpdate, consentEventInsert]) (and db.batch for STOP→pref+suppression) so each dual-write is one neon-http transaction, matching the existing pattern in estimate-queries.ts / provisioning.ts.
- _minor_ — File-path/line citations are slightly off. The chapter attributes logAudit to 'audit.ts (audit.ts)' implying src/lib/audit.ts, but it lives at src/lib/admin/audit.ts (no src/lib/audit.ts exists). platformAuditLog is cited at schema.ts:2889; it is at ~2887. → **Fix:** Correct the path to src/lib/admin/audit.ts and treat schema line numbers as approximate/anchor on symbol names instead.

---
