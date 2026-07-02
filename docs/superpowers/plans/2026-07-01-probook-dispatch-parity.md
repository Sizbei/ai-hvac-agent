# Probook Dispatch Parity — Research + Plan

> Goal: reach **dispatch parity with Probook** (probook.ai — a16z/Sequoia, $40M, "the AI OS for home services, built around dispatch"). This distills what their site + press actually reveal about *how their dispatch works*, maps it against our current engine, and lists the concrete gaps to close.

## 1. What Probook actually does on dispatch (the "secrets")

Founder **George Eliadis** (grew up pressure-washing, worked inside a $40M HVAC/plumbing/electrical shop) built the platform **dispatch-first**: *"dispatch is the hardest problem in home services and the piece most AI vendors ignored in favor of lead-gen."* The revealed mechanics:

1. **Unified context layer.** Intake, data-cleaning, messaging, and outbound all sit on **one shared context layer** — *"every customer stays on one text thread with one number from first touch through the front door."* Dispatch is the center; everything else hangs off it.
2. **Clean every booking BEFORE assignment.** An explicit **pre-assign data-quality gate** — *"cleaning every booking before it's assigned to a technician."*
3. **Multi-factor assignment, NOT just proximity.** Decisions incorporate **technician expertise, availability, performance history, and *expected job value*** — plus *"full booking history checks, forecasted ETA and revenue, job priority levels, technician availability windows, and geography."*
4. **Full autopilot; humans manage exceptions only.** *"Dispatch on autopilot… the right tech on every call."* Summers Plumbing booked **2,542 jobs in month one with zero human intervention**; tech-to-dispatcher ratios reach **100:1**; case studies cut dispatch staff 50%+ (22→10, 16→8).
5. **Book on the call.** Capture every lead (voice + web), full context, immediate dispatch. **82% true booking rate**, 90% of chats automated.
6. **Outbound "always working to fill your board."** Outbound automation converts owned demand into booked capacity. **+20% average ticket.**

**The real insight (thinking hard):** their moat is **architectural, not a proprietary solver.** It's (a) the context layer that keeps everything connected, (b) ranking by **expected job value + forecasted ETA/revenue** (not just distance/skills), (c) clean-before-assign, and (d) *trusting the autopilot* enough to run humans-on-exceptions-only. The 100:1 ratio comes from that trust + the context layer, not a magic algorithm.

**Sales/positioning:** targets **large brands (8+ locations, 100+ techs)**; *"Dispatch makes or breaks the customer experience. Probook is the only AI built around it."* Positions *against* ServiceTitan (end-to-end OS that treats dispatch as one feature) via a **dispatch-centric** architecture.

## 2. Where we ALREADY have parity

Our engine (built this session + prior) is genuinely close on the core loop:

| Probook capability | Us |
|---|---|
| Multi-factor scored assignment (expertise, availability, load) | ✅ `score.ts` — skills 40% + quality + conversion + load |
| Autopilot; humans on exceptions | ✅ confidence-gated auto-commit → `auto_dispatch_outcome` exception queue |
| Book-on-the-call (no double-book) | ✅ race-safe `capacity_reservations` CAS (just shipped) |
| The "why this tech" override loop | ✅ `dispatch_decisions` audit table (just shipped) |
| Real-time-ish behind detection | ✅ `delay-detection` + dispatcher SMS |
| Skills-gated eligibility | ✅ hard skill filter in scoring |

## 3. The dispatch GAPS to close for parity

Concrete, grounded in our code — each is bounded:

1. **Expected-job-VALUE as a weighted ranking signal (biggest gap).** Probook explicitly ranks by *"expected job value / forecasted revenue."* We compute `avgJobRevenueCents` in `signals.ts` but only surface it as a *reason string* — it is **not weighted** into `scoreTechnician`. Add a value/revenue term (weighted, tunable) so the engine prefers the tech likeliest to produce a high-value, closed job. *Beware the fairness trap the earlier review flagged — normalize for job-mix; keep it a modest weight, not dominant.*
2. **Forecasted ETA / travel (activate the dormant term).** `score.ts` already consumes optional `travelKm`, but it's never populated. Wire **geocode-at-intake** (persist job coords via the existing Photon seam → `customer_locations` + `location_id`) and compute `travelKm` in `loadDispatchSignals` from tech anchor (latest `technician_locations` fix or `home_base_lat/lng`) → job coords. This lights up proximity ranking **and** the dispatch map. *(One change, two payoffs — attempted; re-do it.)*
3. **Hard job-PRIORITY / urgency handling.** Probook uses *"job priority levels."* We have `urgency`/`emergency` but it isn't a ranking input — an emergency no-heat call should jump the queue, not be ranked by distance behind a tune-up. Add urgency as a hard pre-sort / eligibility tier above the score.
4. **Clean-before-assign gate.** Probook cleans **every booking before assignment**. We sanitize at intake but have no formal pre-assign data-quality gate (valid geocoded address, dedupe, required fields, spam/quality). Add a `needs_review` pre-assign gate so junk never reaches auto-dispatch.
5. **Unified context layer (dispatch reads a 360 view).** `getCustomerById` omits memberships/estimates/invoices/balances and hardcodes `lastServiceDate = null`. A `loadCustomerProfile()` that dispatch (and the agents) read is the connective tissue Probook's whole thesis rests on.
6. **Book-on-the-call, for real.** The capacity reservation is the prerequisite; the *conversational agents* still capture intent + soft-book rather than committing a tech on the last turn. Wire the voice/chat/SMS confirm to reserve + (confidence-gated) auto-commit so the customer leaves the call with a real slot.

## 4. Prioritized parity roadmap

- **P1 (highest leverage, bounded):** (2) geocode-at-intake + activate `travelKm` — lights up proximity/ETA ranking + the map. Then (1) expected-value weighted term + (3) hard urgency tier — all inside `score.ts`/`signals.ts`, our strongest, best-tested module.
- **P2:** (4) clean-before-assign gate (a `needs_review` state + validators feeding the exception queue).
- **P3:** (6) book-on-the-call — the conversational agents commit via the reservation + confidence gate (this is the revenue milestone; depends on P1).
- **P4 (largest, own effort):** (5) the unified `loadCustomerProfile()` context layer.

**Bottom line:** we already have Probook's *shape* (scored autopilot + exception queue + race-safe hold + decision audit). Parity is closing four concrete signal/gate gaps — **expected value, forecasted ETA/travel, hard priority, clean-before-assign** — most of them inside the scoring module we already own. What we can't shortcut is the *architectural* bets (context layer, book-on-the-call, outbound) that make their 100:1 ratio real.

## Sources
- [probook.ai](https://www.probook.ai/) · [GlobeNewswire — $40M raise](https://www.globenewswire.com/news-release/2026/06/23/3316215/0/en/probook-raises-40m-from-andreessen-horowitz-and-sequoia-to-scale-the-ai-operating-system-for-home-services.html) · [Shopifreaks — "built around dispatch"](https://www.shopifreaks.com/probook-an-ai-operating-system-for-home-service-businesses-raises-40m-from-andreessen-horowitz-and-sequoia-built-around-dispatch/) · [TechFundingNews — "reinvent dispatch"](https://techfundingnews.com/built-by-a-tradesman-backed-by-a16z-and-sequoia-probook-raises-40m-to-reinvent-dispatch-for-americas-home-service-businesses/) · [Unite.AI](https://www.unite.ai/probook-raises-34-million-series-a-to-bring-ai-into-the-operational-core-of-home-services/) · [phcppros](https://www.phcppros.com/articles/23645-probook-raises-40m-to-scale-ai-operating-system-for-home-services)
