# Probook Teardown & Implementation Plan — "Why ~100 Engineers, and What We Build"

**Date:** 2026-06-24
**Author:** engineering (autonomous analysis)
**Status:** strategy / planning — for the operator to prioritize
**Scope:** (1) what Probook actually is and does, (2) a decomposition of the engineering surface that an org of its size builds and *why each part is hard*, (3) an honest gap analysis vs. our codebase, and (4) a phased, realistic implementation plan that reuses what we already have.

---

## 0. Honesty note on "100 engineers"

I researched this. **Public sources do not disclose Probook's exact engineering headcount.** What *is* verifiable as of June 2026:

- **$40M raised** — a **$34M Series A led by a16z** + a **$6M seed led by Sequoia**; the capital is explicitly earmarked for **engineering, customer success, and go-to-market**.
- The widely-quoted **"100"** is an **operational ratio — up to 100 technicians per *dispatcher*** (e.g., Summers Plumbing: 260 techs, **2,542 jobs booked in month one with zero human intervention**), **not** an engineer count.
- a16z's stated thesis: a founder who actually worked the trades (**George Eliadis**) + **"outlier technical depth."**

So the literal premise ("Probook has 100 engineers") is **unconfirmed** — the number you're likely recalling is the 100:1 tech-to-dispatcher ratio. The *useful* question, which this document answers, is: **what does a well-funded "AI operating system for home services, built around dispatch" actually require engineers to build, and which of it should we build given we are not a 100-person team?** A Series-A AI-ops company of this ambition is plausibly **40–100 in eng** when you sum the workstreams in Part 2 — but treat that as a decomposition-based estimate, not a disclosed fact.

**Sources:** [GlobeNewswire release](https://www.globenewswire.com/news-release/2026/6/23/3316215/0/en/Probook-Raises-40M-from-Andreessen-Horowitz-and-Sequoia-to-Scale-the-AI-Operating-System-for-Home-Services.html) · [probook.ai](https://www.probook.ai/) · [Shopifreaks analysis](https://www.shopifreaks.com/probook-an-ai-operating-system-for-home-service-businesses-raises-40m-from-andreessen-horowitz-and-sequoia-built-around-dispatch/) · [TechFundingNews](https://techfundingnews.com/built-by-a-tradesman-backed-by-a16z-and-sequoia-probook-raises-40m-to-reinvent-dispatch-for-americas-home-service-businesses/) · [HackerNoon](https://hackernoon.com/probook-raises-$40m-from-a16z-and-sequoia-to-build-an-ai-dispatch-layer-for-home-services)

---

## 1. Executive summary

Probook's wedge is **dispatch** — "the hardest problem in home services and the piece most AI vendors ignored in favor of lead-gen." Around that wedge they wrap a **single context layer**: one customer, one text thread, from first touch (voice/web lead) → data-scrubbed booking → the *right* technician (skills/conversion/expertise, not proximity) → outbound follow-up to fill the board and close unsold estimates. They sell **outcomes** (jobs booked, EBITDA points), deploy **in person**, and stay "on the hook" for results.

**The reason this needs a lot of engineers is not the dispatch algorithm — it's everything around it being production-grade, multi-tenant, real-time, voice-grade, integration-heavy, and *trusted with money and a customer's reputation*.** The algorithm is ~1 team; the *operating system* is ~10.

**Our position is far better than a blank slate.** We already have, in this repo: an AI **intake** agent on **two channels** (voice + web chat) with shared safety/guardrails, a **scored skill-gated dispatch** engine (v1, default-off), **FieldPulse + Housecall Pro** integrations (customer/job/invoice/roster/availability), a **money loop** (estimates → invoices → payments → financing), a **communications** queue with consent/quiet-hours, **membership** automation, and an **admin + tech-portal** surface. The gaps vs. Probook are concrete and mostly about **depth, real-time-ness, the unified context layer, outbound, and data-quality** — not green-field.

This document gives the workstream decomposition (Part 2), maps each to our code with a "have / partial / lack" verdict (Part 3), and proposes a **phased plan that a small team can actually execute** by extending what exists (Part 4–6).

---

## 2. Why so many engineers — the workstream decomposition (what they do)

An "AI OS built around dispatch" is ~12 distinct engineering surfaces. For each: **what it is**, **why it's genuinely hard** (the reason it consumes a team, not a sprint), and a **rough team size** for a company at their scale. This is the "what they do" half of your ask.

### 2.1 The Dispatch Decision Engine — *~1–2 teams*
**What:** assign the *right tech to the right job, in what order, at what time* — scoring on **skill/certification, historical conversion (close rate / revenue per call), expertise match, current load, route/proximity, SLA/priority, membership, and capacity**. Continuous re-optimization as the day changes (cancellations, runovers, emergencies).
**Why hard:** it's a constrained optimization over a live, changing graph; it touches money (a wrong assignment is lost revenue or an unhappy customer); it must be **explainable** (a dispatcher must trust/override it); it needs per-tech **performance models** trained on historical outcomes; and "re-optimize the whole day" is a routing/VRP problem. Plus a human-in-the-loop **exceptions queue** and override UX.

### 2.2 The Unified Context Layer — *~1 team*
**What:** one canonical, real-time record per customer that *every* surface reads/writes — "one text thread from first touch through the job." Identity resolution across phone/email/address, dedup, merge, the full interaction history, and a consistent event stream.
**Why hard:** identity resolution and dedup at scale are notoriously messy (typos, shared numbers, multi-site customers); it must be real-time and consistent across voice, SMS, web, and the FSM; it's the substrate everything else depends on, so its data model and event bus are load-bearing.

### 2.3 Conversational AI — Voice — *~1 team*
**What:** a phone agent that handles inbound calls end-to-end: ASR, turn-taking/barge-in, low-latency TTS, intent + slot extraction, knowledge answers, booking, **warm transfer** to humans, and after-hours.
**Why hard:** **latency budget is brutal** (caller silence is failure); telephony plumbing (Twilio, DTMF, call state, recordings); robustness to noise/accents; safety (never quote a price / confirm a booking it can't); and it must share state with the context layer mid-call.

### 2.4 Conversational AI — Messaging (SMS/web) — *~1 team*
**What:** the "90% of chats automated" two-way text agent — the single thread per customer, intake + scheduling + reschedule + status + Q&A, with human handoff to a staffed inbox.
**Why hard:** TCPA/consent + quiet hours, deliverability, conversation-state management across long-lived threads, prompt-injection/safety, and a **staffed-inbox** product for the 10% that needs a human.

### 2.5 Data Scrubbing / Booking Quality — *~0.5–1 team*
**What:** "clean every booking before it hits the board" — address validation/geocoding, duplicate detection, equipment/warranty lookup, **full history checks**, completeness scoring, and triage classification.
**Why hard:** garbage-in is the #1 cause of bad dispatch; address/geo normalization is its own rabbit hole; "history check" implies pulling and reconciling prior jobs/equipment from the FSM in real time.

### 2.6 Outbound Engine — *~1 team*
**What:** proactive revenue motion — "fill the board" (fill open capacity), **close unsold estimates** (follow-up sequences), recurring/maintenance reminders, win-back, review requests.
**Why hard:** it's a campaign/sequencing system with consent, timing, throttling, attribution ("did the outbound cause the booking?"), and A/B testing — basically a vertical marketing-automation product wired to live capacity.

### 2.7 FSM / Integrations Platform — *~1–2 teams*
**What:** bi-directional sync with the systems of record — **ServiceTitan, Housecall Pro, FieldPulse, etc.** — for customers, jobs, invoices, technicians, availability, plus calendars, payments, telephony, and review platforms.
**Why hard:** every FSM API is different, rate-limited, partially-documented, and *authoritative for money* — so sync must be idempotent, conflict-aware, money-safe, and degrade-safe. Each integration is effectively a mini-product with its own maintenance burden. This is where a *lot* of headcount quietly goes.

### 2.8 Scheduling & Capacity / Calendar — *~1 team*
**What:** real availability (working hours, PTO/sick, live load, drive-time), the bookable-windows engine, the dispatch board / calendar UI, drag-to-assign, capacity holds.
**Why hard:** timezone/DST correctness, real-time capacity, and the UX of a board dispatchers live in all day.

### 2.9 Web / Admin / Mobile front-ends — *~1–2 teams*
**What:** the dispatcher board, admin/config, reporting dashboards, and the **technician mobile** experience (jobs, materials, photos, signatures, time, navigation).
**Why hard:** these are big, stateful, real-time UIs; the tech app is mobile/offline-tolerant; multi-tenant theming and RBAC.

### 2.10 Platform / Infra / Data — *~1 team*
**What:** multi-tenant data platform, event bus, the analytics/warehouse that powers "revenue forecasting" and per-tech conversion models, observability, secrets, CI/CD, scaling.
**Why hard:** real-time + analytical workloads, tenant isolation, and the ML feature store behind dispatch scoring and forecasting.

### 2.11 AI/ML Platform & Evals — *~0.5–1 team*
**What:** model orchestration, prompt management, **offline evals + guardrails**, the dispatch/forecast/conversion models, retrieval/knowledge.
**Why hard:** quality regressions are silent; you need golden datasets, eval gates in CI, safety screening, and model-cost management — a discipline, not a feature.

### 2.12 Security / Compliance / Trust — *~0.5 team*
**What:** SOC2, PII handling, TCPA/telephony compliance, payments/PCI surface, tenant isolation audits, auth.
**Why hard:** they're trusted with a business's customers, money, and phone line; one breach or a TCPA class action is existential.

**Plus:** Customer Success / Forward-Deployed Engineering. Probook explicitly "deploys in person and configures alongside frontline teams." That's a **forward-deployed eng** function (config, data migration, white-glove onboarding) — headcount that isn't "product eng" but is real engineering.

**Tally:** even at lean staffing those workstreams sum to **~10–14 teams' worth of surface**, which is exactly why a Series-A company "doubling down" lands in the **dozens-to-~100** engineer range. **The takeaway for us: the moat is the *operating system* (context layer + integrations + outbound + real-time), not any single clever algorithm.**

---

## 3. Gap analysis — what we already have vs. each workstream

We are **not** starting from zero. Verdicts below are grounded in this repo.

| # | Workstream | Our status | Evidence in our code |
|---|---|---|---|
| 2.1 | Dispatch decision engine | **PARTIAL** | `src/lib/ai/dispatch/score.ts` (skill/quality/load weighted, explainable `reasons[]`), `signals.ts`, `autoAssignBookedRequest` (scored, skill-gated, default-OFF via `auto_dispatch_enabled`). **Lacks:** conversion/revenue scoring, proximity (no tech geo), day re-optimization, PTO/live-load. |
| 2.2 | Unified context layer | **PARTIAL** | Customer dedupe via HMAC blind-index (`upsertCustomerByContact`), `customer-context.ts`, `request_status_events` log. **Lacks:** one canonical real-time thread across all channels; a true event bus. |
| 2.3 | Voice agent | **HAVE (strong)** | `voice-turn.ts` (full intake, knowledge, after-hours, account-verify, ElevenLabs TTS, Twilio), shared guardrail. **Lacks:** richer warm-transfer fallback, live availability offering parity. |
| 2.4 | Messaging agent | **HAVE (strong)** | `src/app/api/chat/route.ts` (router + LLM-fallback, slot/triage, safety), consent (`checkSendAllowed`). **Lacks:** a true single-thread-per-customer model + staffed-inbox UI. |
| 2.5 | Data scrubbing / booking quality | **PARTIAL** | Address validation (`fieldpulse/address-validation.ts` Photon+geocode), triage classification, intake completeness. **Lacks:** pre-assign "clean every booking + full history check" as a first-class gate. |
| 2.6 | Outbound engine | **PARTIAL** | Comms triggers (`triggers.ts`: reminders, review requests, dunning, warranty-expiring), membership visit generation, the `outbound_message_ledger`. **Lacks:** "fill the board" capacity-driven outbound + "close unsold estimates" sequences + attribution. |
| 2.7 | FSM / integrations | **HAVE (strong)** | FieldPulse + Housecall Pro: customer/job/invoice mirrors, roster sync, availability, webhooks (signed), rate limiter, bulk ops. **Lacks:** ServiceTitan (planned — `SERVICETITAN-PLAN.md`). |
| 2.8 | Scheduling / capacity | **HAVE (good)** | `scheduling-queries.ts`, dispatch board, calendar, capacity holds, availability coverage. **Lacks:** PTO/live-load, drive-time. |
| 2.9 | Front-ends (admin + tech) | **HAVE (good)** | Branded admin, dispatch board, tech portal (jobs/materials/notes/signature/timesheet/**timeline**/**photos**). **Lacks:** a dispatcher "command center" depth; offline tech app. |
| 2.10 | Platform / infra / data | **PARTIAL** | Next.js 16 + Drizzle/Neon, multi-tenant `withTenant`, `after()` background work. **Lacks:** an analytics warehouse / feature store for forecasting + conversion models. |
| 2.11 | AI/ML platform & evals | **HAVE (good)** | `output-guardrail.ts` (shared safety net, just hardened), promptfoo evals, frozen-safety-text invariant, model registry. **Lacks:** trained conversion/forecast models + a feature store. |
| 2.12 | Security / compliance | **PARTIAL** | Auth/JWT/RBAC, tenant isolation, consent gates, PII encryption + blind indexes, CSRF guard. **Lacks:** SOC2 program, formal PCI scoping. |

**Headline:** we are **strong** on the conversational AI (both channels), the FSM integrations, and the front-ends; **partial** on the dispatch *intelligence*, the unified context layer, outbound, and data/forecasting; and **lacking** the analytics/ML platform and formal compliance. **We have ~60–70% of the surface in skeletal-to-solid form** — the work is depth and the connective "OS" tissue, not net-new pillars.

---

## 4. Implementation plan — what *we* build (prioritized, reuse-first)

Principle: **we are not 100 engineers, so we win by depth on the wedge, not breadth.** Copy Probook's *strategy* (own dispatch + the context layer + outbound, sell outcomes), not its headcount. Every item below extends code we already have.

### Phase 0 — Make what we have *live* (no new pillars; weeks)
The single highest-leverage move: **our dispatch v1, HCP roster sync, and the bulk-ops are built and tested but behind unapplied migrations (`0021`, `0022`) and default-off flags.** Nothing competes with Probook until this is deployed and validated.
1. Apply migrations `0021`/`0022`; enable `auto_dispatch_enabled` for one pilot org; validate scored auto-assign end-to-end on real bookings.
2. Wire the existing "Sync Technicians" path to an admin button (FieldPulse + HCP) so rosters are real.
3. Instrument dispatch decisions (we already log `reasons[]`) → a simple "why this tech" audit view.
**Verify:** a pilot org books jobs with zero human dispatch on classified requests; dispatcher can see + override.

### Phase 1 — Dispatch intelligence to parity with the wedge (the moat)
This is where we must go *deep*, because it's Probook's whole thesis.
1. **Conversion/revenue scoring** — extend `score.ts`/`signals.ts` with per-tech close-rate and revenue-per-call from our own `reviewRequests`/`invoices`/job history. (We already have the scorecard query shape.)
2. **Proximity** — add `users.baseLat/Lng` + geocode (we already geocode addresses) + a distance term; re-balance weights (note: breaks 3 existing score tests — update them).
3. **Real-time availability** — PTO/sick table + live-load beyond same-day; fold into the conflict gate.
4. **Tunable threshold + the exceptions queue** — org-level confidence threshold; the "Unassigned" column *is* the exceptions queue — add the top-3 scored suggestions + one-click assign in the detail sheet.
5. **Day re-optimization (stretch)** — a sweep that re-suggests assignments as the day changes (cancellations/runovers). This is the VRP-flavored hard part; scope as a later epic.
**These are exactly Group C of our existing parity program (Stages 12–18), which are already planned + reviewed — they just need the migrations applied.**

### Phase 2 — The Unified Context Layer (the connective tissue)
1. **One thread per customer** — unify voice + SMS + web into a single `customer_thread` keyed on the resolved customer (we have blind-index identity resolution already); every channel appends to it.
2. **Event stream** — promote `request_status_events` into a broader per-customer event log (calls, messages, bookings, status) so every surface reads one history.
3. **Staffed inbox** — an admin thread view + reply (we have the reply endpoint; needs the mode-aware list/thread UI).
**Why this order:** the context layer makes dispatch *and* outbound smarter; it's the substrate Probook leads with.

### Phase 3 — Outbound revenue engine
1. **Close unsold estimates** — a sequence over open estimates (we have estimates + comms + consent); attribute bookings back to the nudge.
2. **Fill-the-board** — capacity-aware outbound: when tomorrow has open slots, proactively reach maintenance-due / recurring customers (we have membership visit generation + recurring).
3. **Campaign primitives** — throttling, quiet-hours (have), A/B, attribution.

### Phase 4 — Data-quality pre-assign gate
1. **"Clean every booking"** — a pre-dispatch gate: address-validate (have), dedup (have), pull equipment/warranty + prior-job history from the FSM (have the mirrors), completeness score; block/flag low-quality bookings to the exceptions queue before they hit the board.

### Phase 5 — Forecasting & analytics (needs platform investment)
1. **Revenue forecasting + per-tech conversion models** — requires a small analytics/feature layer over our data. Start with simple aggregates (we have the queries); graduate to models only if it pays off. This is the most "100-engineer" item — **deliberately last and lean.**

### Cross-cutting (continuous)
- **ServiceTitan integration** (per `SERVICETITAN-PLAN.md`) — the biggest FSM in the space; the integrations platform we built for FP/HCP is the template.
- **Evals + safety** — keep the guardrail/eval discipline as each AI surface deepens (we just hardened the pricing detector).
- **Compliance** — begin a SOC2 path before enterprise deals demand it.

---

## 5. Sequencing & rough effort

| Phase | Outcome | Rough effort (our team) | Depends on |
|---|---|---|---|
| 0 | Dispatch v1 **live** on a pilot org | days | operator applies `0021`/`0022` |
| 1 | Dispatch intelligence (conversion/proximity/PTO/threshold/exceptions) | 4–8 wks | Phase 0 + migrations per stage |
| 2 | Unified context layer + staffed inbox | 4–6 wks | identity resolution (have) |
| 3 | Outbound (unsold-estimate + fill-the-board) | 3–5 wks | context layer + comms (have) |
| 4 | Pre-assign data-quality gate | 2–3 wks | FSM mirrors (have) |
| 5 | Forecasting / conversion models | 6+ wks | a real analytics layer |
| X | ServiceTitan integration | 4–8 wks | integrations platform (have) |

**The first 80% of competitive value is Phases 0–3, and almost all of it is *extending existing code*, not new pillars.** Phase 5 is the only part that genuinely wants more headcount — keep it lean/last.

---

## 6. Strategy, build-vs-buy, and what NOT to copy

- **Copy the wedge, not the breadth.** Probook wins by owning dispatch + context + outbound and *selling outcomes*. We should pick **one vertical (HVAC) + one pilot** and be visibly better at dispatch there, rather than chase 12 workstreams.
- **Sell outcomes / deploy hands-on.** Their forward-deployed, "on the hook for outcomes" model is a *go-to-market* moat as much as a tech one. Our equivalent: white-glove one pilot org, measure jobs-booked-with-zero-human-dispatch, publish the number.
- **Don't out-integrate them on day one.** Integrations are where headcount disappears. We already have FP + HCP; add ServiceTitan deliberately, not a long-tail.
- **Don't build the ML forecasting platform early.** Start with deterministic, explainable scoring (we have it) + simple aggregates; models later. Explainability is a *feature* dispatchers trust — our `reasons[]` is an asset.
- **Buy, don't build:** telephony (Twilio — have), TTS/ASR (ElevenLabs — have), geocoding (Photon — have), payments/financing (have). Keep building only the wedge + the context layer.
- **Biggest risk for us:** spreading thin. The plan above is ordered so a small team compounds on the wedge instead of cloning an org chart.

---

## 7. Bottom line

- **"Why ~100 engineers"** = an "AI OS for home services" is ~10–14 production-grade, real-time, money-and-reputation-critical workstreams (Part 2); the dispatch algorithm is the smallest part. (The literal "100" in the press is the tech-to-dispatcher *ratio*, not a headcount.)
- **We already hold ~60–70% of the surface**, and our conversational AI + FSM integrations are genuinely strong.
- **The win is depth on the wedge:** get dispatch v1 *live* (Phase 0, blocked only on applying `0021`/`0022`), deepen the dispatch intelligence (Phase 1 = our already-planned Group C), build the unified context layer (Phase 2) and the outbound engine (Phase 3) — all by extending existing code. Forecasting/ML (Phase 5) is the only true headcount sink; do it last and lean.
- **Most immediate operator action:** apply the two pending migrations and pick a pilot org — that converts a lot of already-built, already-tested code into live, Probook-comparable capability.
