# Probook-Parity Master Design Spec (v3) — Context Layer + Forecasting Intelligence

**Date:** 2026-06-24
**Status:** design — awaiting operator review → per-component implementation plans (`writing-plans`)
**Supersedes / extends:**
- `docs/superpowers/plans/2026-06-24-probook-competitive-analysis-and-plan.md` — the *why ~100 engineers / what they do* teardown.
- `docs/superpowers/specs/2026-06-24-probook-parity-design.md` (v2) — the *context-layer-as-spine* design. v3 keeps that spine and **promotes Forecasting & Revenue Intelligence from a deferred non-goal to a first-class pillar** at the operator's direction.

> **What changed since v2, in one line:** v2 said "context layer first, defer forecasting." v3 says "context layer is still the spine, **and forecasting is the intelligence layer that sits on top of it** — built as a deterministic→statistical→ML maturity ladder, not ML-first." This document is grounded in a full read of the actual schema, queries, comms, and AI infrastructure (see §5, Data Reality), so every component maps directly to a buildable plan.

---

## Table of contents

0. Executive summary & what's different in v3
1. Strategic thesis (the moat, restated)
2. Goals & measurable success criteria
3. Competitive grounding — what Probook actually sells, and where forecasting fits
4. System architecture (full picture)
5. Data reality assessment — what we can forecast *from* today
6. Component specs
   - 6.1 Context Layer (the spine)
   - 6.2 Forecasting & Revenue Intelligence (the new pillar)
   - 6.3 Dispatch Intelligence
   - 6.4 Data-Quality pre-assign gate
   - 6.5 Outbound Engine (forecast-driven)
   - 6.6 Staffed Inbox
7. Data model summary (all migrations)
8. Build sequence (phased)
9. Forecasting evaluation, backtesting & monitoring
10. AI/ML stack decisions & build-vs-buy
11. Risks & explicit anti-goals
12. Open questions for the operator

---

## 0. Executive summary & what's different in v3

We are building toward the Probook outcome — *"one customer, one thread, one context, from first touch through the job; every booking cleaned before it's assigned; the AI runs the majority of the operation and a human handles the exceptions"* — on our existing stack (Next.js + Drizzle/neon-http + Qwen/GLM LLM + Twilio/Resend), scoped to **one HVAC pilot org**, not a 100-engineer breadth play.

v3 makes three changes versus v2:

1. **Forecasting is now a first-class pillar — the "intelligence layer."** The system has two structural halves: the **context layer** (the connected substrate — one record per customer, every interaction logged) and the **intelligence layer** (forecasting — turning that history plus operational data into forward-looking demand, revenue, and capacity projections). Dispatch, outbound, and the staffed inbox are *consumers* of both.

2. **Forecasting is built as a maturity ladder, not ML-first.** Phase A is deterministic baselines (seasonal-naïve, moving averages, pipeline-weighted revenue) that are *useful on day one* and need no training data. Phase B adds statistical seasonal models (exponential smoothing / Holt-Winters / STL-style decomposition) — all implementable in TypeScript, no Python. Phase C adds learned models **only once we have enough labeled outcomes and the deterministic baseline is the thing to beat.** We never ship a black box we can't backtest.

3. **The whole thing is grounded in the real data surface.** §5 is an honest inventory of exactly which tables, columns, and timestamps exist (and which critically *don't* — e.g. no seasonality dimension, no tech geo, no call-duration). Every forecasting input is traced to a real column. This is what makes v3 buildable rather than aspirational.

The honest framing: forecasting is **strategically the highest-leverage differentiator** (it's what an owner *feels* — "will I have enough techs in July? is revenue on track? which slow day should I fill?") and is currently a **total gap** in the codebase. But forecasting quality is bounded by data history, so we ship value immediately with deterministic baselines and let the models earn their complexity.

---

## 1. Strategic thesis (the moat, restated)

The moat is **not any single feature** — competitors can copy a dispatch screen or a forecast chart. The moat is the **connected loop**: a single per-customer context feeding an intelligence layer feeding automated action (dispatch + outbound) feeding new context. Each turn of the loop makes the next turn smarter. Specifically:

```
   intake (voice/SMS/web) ─┐
                           ▼
                    CONTEXT LAYER  ──────────► history accrues per customer
                           │
                           ▼
                  INTELLIGENCE LAYER (forecasting)
                    demand · revenue · capacity
                           │
              ┌────────────┼─────────────┐
              ▼            ▼              ▼
          DISPATCH     OUTBOUND      OWNER COCKPIT
        (capacity-     (fill        (forecasts +
         aware,         forecast-     explanations)
         scored)        slow days)
              │            │
              └─────┬──────┘
                    ▼
            action creates new events → CONTEXT LAYER (loop closes)
```

A competitor must build *all of it, connected,* to match the experience — not just the parts. Our advantage is that the substrate (identity, comms, consent, FSM mirrors, dispatch scoring) already exists; v3 wires it into a loop and adds the missing intelligence head.

**Why forecasting is the right thing to add now (not later):** the existing product is reactive — it answers "what happened" (backward-looking reports). The owner's actual decisions are forward-looking: staffing, marketing spend, capacity, cash. Forecasting is the first feature that speaks to those decisions, and HVAC's extreme seasonality (summer cooling spike, winter heating spike, shoulder-season slack) makes a naïve "last 30 days" view actively misleading. The codebase today has **no seasonality concept at all** — so even a simple seasonal-naïve forecast is a step-change improvement.

---

## 2. Goals & measurable success criteria

**Primary goal:** a pilot HVAC org runs **intake → cleaned booking → capacity-aware dispatch → forecast-driven outbound** as one connected system on a single per-customer context, with an owner-facing forecast cockpit, the AI handling the majority of bookings, and a human handling only exceptions.

**Measurable success criteria:**

| # | Criterion | How measured |
|---|---|---|
| G1 | One customer thread across all channels; no re-asking known facts | A returning customer is recognized on voice *and* SMS *and* web from one `customer_threads` row |
| G2 | Zero-human dispatch on classified jobs at the pilot | Count of `service_requests.autoAssigned=true` with no manual reassignment |
| G3 | Dispatch is explainable + capacity-aware | Each assignment carries a `reasons[]`; assignments respect forecasted day capacity |
| G4 | **Forecast beats the production baseline (when evaluable)** | On rolling-origin backtest with **≥k folds**, the chosen model's MASE is **lower than the incumbent's** on the same folds (per series, per horizon; MASE<1 vs naïve as a floor) (§9). This is the only *hard* quantitative gate, but it is **conditional**: until enough folds exist it evaluates to **"N/A — insufficient folds,"** and **Rung A remaining the production model is an acceptable pilot outcome** (§6.2.7). It never silently "passes" without folds. |
| G5 | *(folded into G4)* | There is no separate pre-set tolerance; setting a "±X%" target after seeing the backtest would be circular. The standing commitment is "beat the incumbent/naïve on backtest." |
| G6 | **Capacity gap surfaced before it bites** | The cockpit flags any forecast week, **≥14 days out**, where projected demand-hours (with a duration buffer) exceed projected available tech-hours (utilization-haircut applied), as an **advisory** signal — never a hard block on dispatch. |
| G7 | Outbound fills forecasted-slow capacity with attributable bookings | Bookings attributable to a "fill-the-board" nudge on a forecast-slow day |
| G8 | **Every forecast is explainable + inspectable** | Each forecast snapshot carries a **numeric-fidelity-checked** plain-language explanation *and* drill-down to its underlying series. (Presence + correctness check — not a trust survey; "trust" is earned by G4 + transparency, not asserted.) |

**Non-negotiable invariants (carried from memory; any plan must preserve):**
- **Frozen safety text** in `hvac-knowledge.ts` is not edited as a side effect.
- **Money-safety:** synced invoices (`fieldpulseInvoiceId`/`hcpInvoiceId IS NOT NULL`) are read-only in money flows; native vs synced revenue series are never blended (§5.1).
- **`metadata.verify` survival** across metadata rebuilds (the financial-verify gate).
- **PII discipline:** event/forecast records hold field-names/enums/non-PII summaries only; raw PII stays encrypted in `customers`/`messages`, referenced by id.
- **neon-http reality:** no interactive transactions (`db.batch`), aggregate functions return strings (coerce with `Number()`), background work via `after()` — never detached promises.

---

## 3. Competitive grounding — what Probook sells, and where forecasting fits

The teardown doc decomposed Probook's ~100-person org into ~10–14 workstreams. The ones relevant to v3:

- **Unified customer context / one-thread messaging** → our Context Layer (6.1).
- **AI intake + booking** → we already have voice + web + SMS intake with a deterministic router + LLM fallback.
- **Intelligent dispatch** → our Dispatch Intelligence (6.3), already scored, default-off.
- **Data scrubbing / clean bookings** → our Data-Quality gate (6.4).
- **Proactive outbound / revenue recovery** → our Outbound Engine (6.5).
- **Business intelligence / forecasting / "revenue command center"** → **the gap v3 closes** (6.2). This is a large slice of what dedicated FSM platforms (ServiceTitan, Probook) market to *owners* — demand prediction, revenue projection, capacity planning, "are we on track" dashboards. It is the feature that justifies the platform to the person who signs the check.

What we deliberately do **not** chase (still): multi-vertical breadth, a ServiceTitan-scale marketplace, native mobile, or a research-grade ML platform. We win by closing the loop deeply for one vertical, with forecasting that is *correct and explainable* rather than impressively complex.

---

## 4. System architecture (full picture)

```
            ┌──────────────────────────── CONTEXT LAYER (the spine) ─────────────────────────────┐
 voice ─┐   │  customer_threads (1 per resolved customer)                                          │
 sms  ──┼─► │  customer_events (append-only: call|sms|web|booking|status|outbound|forecast_note)   │
 web  ──┘   │  identity = existing blind-index (upsertCustomerByContact / findCustomerIdByContact)  │
            │  read API: getThread(orgId, customerId) → {profile, history, openItems}               │
            └───────────────────────────────────────▲──────────────────────────────────────────────┘
                                                     │ reads/writes
   ┌─────────────────────────────────────────────── INTELLIGENCE LAYER (forecasting) ───────────────┐
   │  daily rollups (demand/revenue/capacity series, built from raw timestamps)                       │
   │  forecasters: demand · revenue · capacity   (deterministic→statistical→ML maturity ladder)       │
   │  forecast_snapshots (versioned outputs) + backtest harness + accuracy log                        │
   │  LLM explanation pass (Qwen/GLM) → plain-language "why"                                           │
   └───────────▲───────────────────▲───────────────────▲───────────────────────▲─────────────────────┘
               │                    │                   │                        │
        ┌──────┴──────┐      ┌──────┴──────┐     ┌──────┴───────┐        ┌───────┴────────┐
        │  Intake AI   │     │  Dispatch    │     │  Data-Quality │        │   Outbound      │
        │ (voice+chat  │     │ Intelligence │     │  pre-assign   │        │   Engine        │
        │  — have)     │     │ (capacity-   │     │     gate      │        │ (forecast-      │
        │              │     │  aware,scored│     │   (NEW small) │        │  driven fill)   │
        └──────────────┘     └──────────────┘     └──────────────┘        └─────────────────┘
               │                    │                   │                        │
               └────────────────────┴───────┬───────────┴────────────────────────┘
                                             ▼
                  FSM mirrors (FieldPulse / HCP — have)  +  comms queue + consent + ledger (have)
                                             │
                                             ▼
                            OWNER COCKPIT (forecast dashboard + explanations) — NEW UI
```

Two structural layers (context = what we know; intelligence = what we expect), four operational consumers (intake, dispatch, data-quality, outbound), one owner-facing cockpit. Everything emits events back into the context layer, and the daily rollups feed the forecasters — closing the loop.

---

## 5. Data reality assessment — what we can forecast *from* today

This section is the foundation: forecasting is only as good as its inputs, and **every input below is traced to a real column** (verified by reading `src/lib/db/schema.ts` and the `src/lib/admin/*-queries.ts` files). It also lists the critical gaps a plan must fill with a migration.

### 5.1 Revenue inputs (money in cents — all integer `*_cents`)

| Signal | Source | Notes |
|---|---|---|
| Collected revenue (actual) | `payments` where `status='succeeded'`, by `createdAt` (payment-date) | The only true payment-date revenue series. |
| Native invoiced/billed | `invoices.totalCents`, `state ∈ {draft,open,paid,void,refunded}` (column **defaults to `draft`**), `amountPaidCents` | Balance/AR = `totalCents − amountPaidCents` (derived, not stored). **The revenue rollup must exclude `draft` and `void`** — they are not real revenue. |
| **Synced revenue** | `invoices` where `fieldpulseInvoiceId` or `hcpInvoiceId IS NOT NULL` | **Different time base** — creation-cohort, paid-to-date, no per-payment date. **Never blend with native payment-date series.** Forecast native and synced as two streams or pick one basis explicitly. |
| Refunds | `refunds.amountCents` by `createdAt` | Subtract from collected. |
| Pipeline (unsold) | `estimates` where `status='open'` (re-bucket `expired` if `expiresAt<now`), `totalCents`, `soldOptionId` | Conversion = `sold / (open+sold+expired)` (already computed in `reporting-queries.ts`). |
| Margin | `invoice_line_items.costCents`, `estimate_line_items.costCents` | Enables margin (not just revenue) forecasting later. |
| Recurring (MRR) | `customer_memberships` (status='active') × `membership_plans.priceCents`, normalized by `billingPeriod` (annual ÷ 12) | **MRR is NOT precomputed anywhere — must derive.** Recurring billing is currently mocked (`providerSubscriptionId` NULL); treat MRR as *contracted* recurring value, not collected cash, until Stripe recurring lands. |

### 5.2 Demand inputs (the time-series)

| Signal | Source | Notes |
|---|---|---|
| Inbound conversations | `customer_sessions` (`channel ∈ {web,phone,sms}`, `createdAt`, `outcome ∈ {booked,escalated,info_provided,abandoned,unresolved}`) | Indexed `(org, createdAt)` and `(org, channel)` — already optimized for time-bucketing. This is the demand funnel top. |
| Bookings (converted demand) | `service_requests.createdAt` | The dominant cohort key in all existing reporting. Segment by `jobType`, `systemType`, `urgency`, `leadSource`, `isAfterHours`. |
| Per-turn telemetry | `bot_events` (`channel`, `intentId`, `action`, `createdAt`, `latencyMs`), indexed `(org, createdAt)` | Finest demand-funnel grain (intents/day). |
| Predictable future demand | `membership_visits.dueDate` (status='scheduled') | **The one forward-known demand feed** — maintenance visits due before they become jobs. Materialized to `service_requests` (jobType=maintenance) by the existing daily cron. |

### 5.3 Capacity inputs

| Signal | Source | Notes |
|---|---|---|
| Scheduled capacity (working hours) | `technician_availability` (`dayOfWeek`, `startMinute`, `endMinute`) | Recurring weekly template only — no date-specific shifts. |
| Actual utilization | `technician_time_entries` (`clockInAt`, `clockOutAt`, `minutes`) | True realized hours per tech per job. Compare vs scheduled to get utilization. |
| Open-window computation | `availability.ts:computeOpenWindows(...)` → `{day, window, capacity, available}` | Existing per-day×band capacity/booked/available primitive — the capacity-forecast baseline. |
| Booked load | `getScheduledJobsForRange(...)`, `ACTIVE_BOOKING_STATUSES` | Existing scheduled-job feed. |
| Labor economics | `users.laborRateCents`, `technician_time_entries.laborCostCents` | Enables revenue-per-tech-hour. |

### 5.4 Critical gaps (must be filled by a migration, or scoped out)

| Gap | Impact on forecasting | v3 decision |
|---|---|---|
| **No seasonality dimension** (only hour-of-day histogram + rolling-7-day count) | Can't do seasonal forecasting without it | Build daily rollups + derive season from date (§6.2). No migration needed — derive from `createdAt`. |
| **No pre-bucketed time series** (no `date_trunc` rollups, no materialized views) | Every forecast recompute would re-scan raw rows | Add a `demand_daily` / `revenue_daily` rollup table refreshed nightly (§6.2.8). Migration. |
| **No tech geo** (`users` has no `baseLat/baseLng`) | No drive-time/routing in dispatch or capacity | Proximity deferred to a later dispatch slice (migration `disp-1`); not a forecasting blocker. |
| **No PTO/time-off table** | Capacity forecast can't subtract planned absences | Add `technician_time_off` (migration `disp-2`); until then capacity forecast uses the weekly template only and notes the caveat. |
| **No call-duration / missed-call data** (phone = a session row) | Can't forecast call-center staffing precisely | Out of scope; forecast booking volume, not call-handle-time. |
| **No actual-arrival timestamp** (only arrival window) | Can't forecast job duration precisely | Use `technician_time_entries.minutes` as the duration signal instead. |
| **No stored skills** (inferred from completed-job history) | Fine for dispatch; fine for capacity-by-skill later | Keep history-derived; optional `technician_skills` table is a separate dispatch slice. |

**Net read:** we have *enough* to build genuinely useful demand, revenue, and capacity forecasts today, provided we (a) build daily rollups, (b) respect the native/synced split, and (c) derive seasonality from dates. The gaps that matter (PTO, geo) are additive and already on the dispatch roadmap.

### 5.5 Build notes from the feasibility review (must hold in plans)

- **Forecasting is strictly read-only against money/operational tables.** It reads `invoices`/`payments`/`estimates`/`service_requests`/`customer_sessions` and writes *only* the new rollup/snapshot tables (`demand_daily`, `revenue_daily`, `forecast_snapshots`, `forecast_accuracy`). It never updates a synced (`fieldpulseInvoiceId`/`hcpInvoiceId IS NOT NULL`) row — preserving the money-safety read-only invariant for synced invoices.
- **Business-TZ bucketing helper is required.** `createdAt` is stored UTC; a naïve `date_trunc('day', createdAt)` would mis-assign late-evening Eastern bookings to the next day. The daily rollups must bucket via a business-TZ (`America/New_York`) date helper (the `calendar-time.ts` `businessIsoDate` derivation), not raw UTC.
- **`ACTIVE_BOOKING_STATUSES` is currently a `const`, not exported** (`scheduling-queries.ts:52`); the forecasting/capacity module needs a one-line `export` to reuse it (surgical change, not a re-implementation).
- **`address-validation.ts` is FieldPulse-namespaced** (`src/lib/integrations/fieldpulse/address-validation.ts`), not a neutral helper — the data-quality gate (§6.4) must confirm it's usable org-agnostically or note the coupling.
- **Estimate-side margin is a 2-hop join** (`estimate_line_items → estimate_options → estimates`); invoice-side is direct. Margin is deferred, so this is informational.

---

## 6. Component specs

### 6.1 Context Layer (the spine)

**Responsibility:** one canonical, real-time record per resolved customer, with the full cross-channel interaction history, that every other component reads and writes. (Unchanged in intent from v2; restated here so v3 is self-contained.)

**Data model (2 new tables; identity reused):**

```
customer_threads
  id              uuid pk
  organizationId  uuid    -- withTenant; FK organizations cascade
  customerId      uuid    -- → customers.id (resolved via blind-index)
  lastChannel     text    -- 'voice'|'sms'|'web'
  lastEventAt     timestamptz
  openEstimateCount int   -- denormalized for fast "open items"
  status          text    -- 'active'|'dormant'
  createdAt, updatedAt
  UNIQUE(organizationId, customerId)

customer_events                       -- append-only event stream
  id              uuid pk
  organizationId  uuid
  customerId      uuid
  threadId        uuid    -- → customer_threads.id
  kind            text    -- 'call'|'sms_in'|'sms_out'|'web_msg'|'booking'|'status_change'|'outbound'|'forecast_note'|'note'
  refId           uuid    -- serviceRequestId / messageId / estimateId, by kind (nullable)
  -- STRUCTURED, enum-only fields (the status-events model, NOT free-text) so PII leakage is
  -- structurally impossible. The human one-liner is RENDERED at read-time from these.
  jobType         text    -- enum label, nullable
  window          text    -- enum label (e.g. arrival window), nullable
  labelKey        text    -- a fixed code-template key (e.g. 'booked', 'reassigned'), nullable
  at              timestamptz
  index(organizationId, customerId, at)
```

**Interfaces (`src/lib/context/thread.ts`, NEW):**

```ts
resolveThread(orgId, contactOrCustomerId): Promise<{ threadId; customerId } | null>
  // reuse findCustomerIdByContact; create the thread row lazily on first event

appendEvent(orgId, customerId, evt: { kind; refId?; jobType?; window?; labelKey }): Promise<void>
  // STRUCTURED params only — NO free-text `summary`. Matches the customer_events table and the
  // recordStatusEvent precedent (which takes enums/ids, no free text). `labelKey` is from a
  // CLOSED enum (see below). best-effort, try/catch, NEVER throws into the request path.

getThread(orgId, customerId): Promise<CustomerThread>
  // profile + recent events + open estimates/jobs + service history.
  // FAILS OPEN INTERNALLY: wraps its body in try/catch and returns a benign EMPTY CustomerThread
  // on any DB error/timeout (not null, not a throw) — so every call site is fail-open by
  // construction, not by remembering to add a .catch(). The empty thread = {profile: minimal,
  // events: [], openItems: []}.
```

**Key decisions:**
- **Reuse identity, don't rebuild it.** `customers` + HMAC blind-index (`upsertCustomerByContact`, `findCustomerIdByContact` in `crm-queries.ts`) is the identity spine. `customer_threads` hangs a thread/event log off it.
- **PII discipline follows the `status-events` model, NOT `audit_log.details`.** The review flagged that `audit_log.details` is free text kept clean only by caller discipline — too weak for paths (chat, voice, submit) that handle raw name/address/phone. So `customer_events` stores **structured enum/label fields only** (`kind`, `jobType`, `window`, `labelKey`, `refId`); the human one-liner shown in the UI is **rendered at read-time** from those fields via a fixed code template. Raw content stays in `messages`/`request_notes`, referenced by `refId`. **The event summary is never LLM-generated and never interpolates a raw `customers`/`messages` field** — making PII leakage structurally impossible rather than convention-dependent.
- **`labelKey` is a CLOSED enum with an exhaustive renderer.** Define `labelKey` as a TS union (e.g. `'booked' | 'reassigned' | 'completed' | 'sms_in' | 'sms_out' | 'outbound_sent' | 'quality_missing_address' | 'quality_dup_suspected' | …`) — the data-quality `note` case uses fixed **issue codes**, never a message string. The read-time renderer is an exhaustive `switch` with a compile-time `never` check; for an unknown/absent label it emits a generic non-PII string ("Activity recorded"), and it **never dereferences `refId` into `messages`/`customers` content fields**. `(kind, labelKey)` validity is a documented matrix. This closes the "structured table but free-text-shaped interface / unrenderable label" gap.
- **`appendEvent` is best-effort** — same pattern as `recordStatusEvent` (try/catch, logs non-fatally, never throws into the request path; the event log is a *projection*, never the source of truth; FSM mirrors and native tables remain authoritative).
- **`getThread` on the intake path must FAIL OPEN.** The read seam (where `loadCustomerContextById` is called today, on the synchronous reply path) must degrade to "no thread context" on any read error or timeout and let the reply proceed — exactly as `loadCustomerContextById` does today. A context read must never block or fail a customer reply.
- **Wiring:** voice-turn, chat route, `submit-session-request`, status transitions, and comms sends each call `appendEvent` inside an existing `after()` block. Intake reads `getThread` at the same seam where `loadCustomerContextById` is called today (`chat/route.ts` after the contact slot fills; `voice-turn.ts` after ANI resolves), so a returning customer is recognized on **any** channel.
- **Migration:** 2 additive tables, authored via `drizzle-kit generate` (next number 0023+), operator applies.

### 6.2 Forecasting & Revenue Intelligence (the new pillar)

This is the largest new component. It is organized as: design philosophy (the ladder) → the **three** forecasters (demand, revenue, capacity — plus two explicitly-cut candidates, pipeline and churn) → methodology → data model → interfaces → compute model → LLM role → UI.

#### 6.2.1 Design philosophy: the maturity ladder

We refuse to ship a forecast we can't explain or backtest. So every forecaster climbs the same three-rung ladder, and **each rung is shippable on its own**:

- **Rung A — Deterministic baselines (no training data, useful day one).**
  - Demand: *seasonal-naïve* — same-weekday-last-4-weeks (the credible signal at pilot scale); use same-week-last-year **only** once ≥1yr of history exists. **No standalone trend extrapolation** at pilot scale (a trend fit on a few months that straddle a seasonal ramp will run away — see B-note below).
  - Revenue: the **partitioned three-stream** model (booked + pipeline + recurring), defined to avoid double-counting (§6.2.3). Largely deterministic and known, so it's a real forecast on day one.
  - Capacity: forecasted demand-hours (with a buffer) vs `computeOpenWindows` projected availability (utilization-haircut) — **advisory** (§6.2.4).
  - These are the **baselines every later model must beat head-to-head** (§9). Not throwaway — for low-data orgs they may remain the production model indefinitely.

- **Rung B — Statistical short-horizon refinement (TypeScript-native, no Python).**
  - Exponential smoothing / **Holt-Winters with weekly seasonality (period = 7)** and a **damped (or omitted) trend** — refines the **7-day** (and cautiously 30-day) demand/revenue forecast by modeling the Mon–Sun pattern. **It does NOT model the annual cooling/heating cycle** — a single Holt-Winters model has one seasonal period, and the annual signal needs ≥1yr (ideally ≥2yr) of history we will not have at pilot launch. The damped/omitted trend is deliberate: it prevents the confidently-wrong runaway forecast across the spring→summer ramp.
  - **Annual seasonality is explicitly out of reach until the data exists.** Until then the cockpit *says so* rather than faking it; the seasonal-naïve baseline approximates annual effects from the prior year *only if* a prior year is present.
  - Optional **STL-style weekly decomposition** for explainability.
  - Promoted per-series **and per-horizon** only when it beats the **incumbent** model head-to-head on backtest (§9) — not merely "beats naïve."

- **Rung C — Learned models: OUT OF SCOPE for the pilot.**
  - One line, by design: learned models (gradient-boosting/regression), external compute (a Python worker or managed forecasting API), and weather/marketing-spend features are **not built for the pilot** — a pilot starting from <8 weeks of data will never reach the gate that would justify them. Revisit only once Rung B is the measured production baseline *and* data volume justifies it. Tracked in §11 anti-goals; not a launch design surface.

**Why this ladder is "best":** it delivers owner value immediately (Rung A), improves measurably with a clear gate (Rung B), and keeps complexity honest (Rung C earns its way in). It also dodges the classic failure of forecasting features — an impressive model nobody trusts because it can't be explained or checked.

#### 6.2.2 Demand forecasting

**Question answered:** "How many bookings/jobs should we expect next week / next 30 days, overall and by job type?"

- **Series:** daily booking count from `service_requests.createdAt`, bucketed by the **business-TZ date helper** (§5.5), segmentable by `jobType` (`no_heat`/`no_cool` are the season proxies), `systemType`, `leadSource`.
- **Plus forward-known demand:** add scheduled `membership_visits.dueDate` as a *known* additive component (not predicted — it's already on the books).
- **Rung A:** seasonal-naïve (same-weekday-last-4-weeks). **Rung B:** Holt-Winters weekly (damped/no trend) — short-horizon refinement only.
- **Output:** point forecast + prediction interval at the **launch horizons 7 and 30 days.** The **90-day horizon is gated** on ≥1yr history AND a per-horizon backtest showing the model beats naïve at 90 days; until then the cockpit shows "90-day: insufficient history," not a line.
- **Count-data handling (the series is non-negative and zero-heavy):** demand forecasts **and** prediction-interval bounds are **floored at 0** (a negative "expected bookings" is a bug). Holt-Winters is **additive** (multiplicative is undefined on a zero-heavy series); for very sparse jobType series Rung A seasonal-naïve is preferred and Rung B is simply ineligible (ties to the min-train gate, §6.2.7).
- **Prediction intervals use horizon-specific (h-step) empirical residual quantiles**, not 1-step residuals (a 1-step band on a 30-day forecast is far too narrow and would fail the interval-coverage check). The per-horizon backtest (§9) produces these.

#### 6.2.3 Revenue forecasting

**Question answered:** "What revenue should we expect, and are we on track this month/quarter?"

Revenue is decomposed into three streams that form a **strict partition** — every unit of expected revenue is attributed to **exactly one** stream, with explicit precedence so the streams can be summed without double-counting:

1. **Booked/scheduled** (precedence 1) — revenue from jobs already scheduled in the horizon (scheduled `service_requests`), valued by expected ticket. The contributing set is the set of `serviceRequestId`s. **Define the exact estimate↔job join** that supplies "expected ticket": a scheduled job's ticket is taken from its linked estimate via `estimates.serviceRequestId` (the bidirectional key), and that `estimateId` is recorded as *consumed by stream 1*.
2. **Pipeline** (precedence 2) — open estimates **excluded from** {estimates consumed by stream 1 (any `estimateId` whose `serviceRequestId` is in stream 1's set)} ∪ {estimates already linked to a scheduled job}. Each remaining estimate contributes `estimates.totalCents` × **P(converts within [now, now+horizon] | survived to its current age a)** — a single conditional probability read directly off an empirical survival curve as `S(a) − S(a+Δ)` over estimate age (from `reporting-queries.ts` data). This is **one** quantity: no flat-rate-times-separate-age-decay (double-discount) and no renormalization. **Conversion mass that the survival curve places beyond the horizon is simply not added** (not redistributed into the in-horizon buckets).
3. **Recurring (MRR)** (precedence 3) — contracted recurring value from active memberships (derived per §5.1) for periods **not already represented as a materialized scheduled visit** in stream 1.

- **Double-counting guard = per-entity set-disjointness, not sum-vs-realized.** The real invariant is that each `serviceRequestId`/`estimateId`/membership-period appears in **at most one** stream's contributing set; a unit assertion checks set-disjointness over those entity IDs. (A sum-vs-realized check can't detect double-attribution — over-count correlates with busy months and hides inside any tolerance — so it is kept only as a loose smoke test, not the guard.)
- **Native vs synced — pick the data-richest basis as the headline, don't run two thin seasonal models.** The money-safety rule (never *blend* native + synced) is non-negotiable, but forecasting *both* as separate seasonal series would starve each of data on an FSM-synced shop (where most revenue is synced). **Decision:** forecast only the single basis with the most history for the pilot org as the headline (likely synced creation-cohort for an FSM shop); present the other basis as a deterministic roll-forward (not a seasonal model), clearly labeled. Note that synced *creation-cohort* seasonality ≠ cash-*collection* seasonality — the headline forecast predicts whichever the chosen basis measures, and the cockpit labels it as such. (The basis choice is operator Q3, but the *rule* — forecast the data-richest basis, single seasonal model — is fixed here.)
- **Rung A:** the partitioned three-stream model (already a real forecast). **Rung B:** Holt-Winters weekly (damped) on the historical series of the chosen basis, blended with the deterministic pipeline/MRR components.

#### 6.2.4 Capacity forecasting

**Question answered:** "Will we have enough technician-hours to meet forecasted demand? Where's the gap?"

The review flagged that a naïve version of this model is biased toward under-flagging the gap (the one thing the gap detector exists to catch), because all three errors point the same way: template supply overstates real supply, mean duration understates busy-day hours, and missing PTO inflates supply. So the model corrects for direction:

- **Supply (haircut, not raw template):** start from `technician_availability` (weekly template) via `computeOpenWindows`, minus already-booked load (`getScheduledJobsForRange`), minus `technician_time_off` (once `disp-2` lands), then apply a **realized-utilization haircut** derived from `technician_time_entries` (actual minutes vs scheduled) so supply reflects real, not theoretical, hours.
- **Demand-hours (buffered, not mean):** forecasted job count (6.2.2) × job duration from `technician_time_entries.minutes` by jobType — durations are right-skewed, so the mean understates the hours risk. Carry the gap as a **band with two explicit endpoints**, not a single relabeled point: the **pessimistic edge** pairs (haircut-supply, high-quantile-demand-duration) and the **optimistic edge** pairs (full-template-supply, mean-demand-duration). The ≥14-day flag (G6) fires when the **pessimistic edge** shows a shortfall.
- **Gap signal (G6):** flag any horizon week, **≥14 days out**, where buffered demand-hours exceed haircut supply-hours, as an **advisory** the owner acts on (hire / schedule / redirect outbound).
- **Honest limitation, stated in-product:** until `technician_time_off` (`disp-2`) lands, supply omits planned absences and is therefore optimistic; the cockpit **states the bias direction** ("supply may be over-stated; PTO not yet modeled"), not just "limited history." `disp-2` is therefore sequenced as a near-term prerequisite to upgrade the gap flag from advisory-with-caveat to dependable.

#### 6.2.5 Pipeline conversion — NOT a separate forecaster

The review correctly noted that "open estimates × close rate" is **not a fifth forecaster** — it already exists in `reporting-queries.ts`, and its forward use is exactly the **revenue pipeline stream (6.2.3, stream 2)** plus **outbound unsold-estimate prioritization (6.5.1)**. So the age-conditional close-rate / time-to-close logic lives **inline** in those two places, not as its own `forecast_snapshots.kind`. There are **three** forecast kinds: `demand`, `revenue`, `capacity`.

#### 6.2.6 Membership churn & LTV — OUT OF SCOPE for the pilot

Cut from v3's launch. At pilot scale membership counts are tiny and recurring billing is mocked (`providerSubscriptionId` NULL; MRR is *contracted*, not *collected*), so a churn forecast would be modeling noise. A lightweight **rule-based membership-risk flag** (lapsing `currentPeriodEnd` + no recent visit) is a fine *deterministic* feature to add later, but it is **not a forecaster** and is explicitly out of Phases 2–5. Tracked in §11.

#### 6.2.7 Methodology deep-dive (models, features, evaluation)

- **Granularity:** daily series, aggregated to weekly/monthly for display. **Launch horizons: 7 and 30 days** (90-day gated on ≥1yr history + a per-horizon backtest).
- **Features (Rung B):** day-of-week, trailing demand, holiday flag. (Week-of-year/month only become useful with ≥1yr history; weather + marketing spend are Rung C and out of pilot scope.)
- **Seasonality handling:** weekly seasonality is learnable from a few months; **annual (the dominant HVAC effect) needs ≥1yr and is not modeled at pilot launch** — the cockpit flags "insufficient history for annual seasonality" rather than faking it (no trend extrapolation stands in for it; see B-note in §6.2.1).
- **Evaluation metrics:** **MASE is the PRIMARY metric and the promotion gate.** MASE normalizes by the in-sample naïve error (a scale, defined even when daily counts are zero), so it is robust on the **sparse, zero-heavy** daily-by-jobType series this pillar produces. **sMAPE is demoted to a secondary display metric and computed only on aggregated (weekly/total) series where zeros are rare** — on sparse daily series it degenerates (it saturates at max for any nonzero error against a zero actual). Also report prediction-interval coverage.
- **Promotion gate (head-to-head, per series, per horizon, with a minimum fold count):** a candidate model replaces the incumbent only when its held-out error is **lower than the incumbent's on the same folds** *and* there are **≥ k non-trivial folds** (so the decision isn't a coin-flip on 2–3 points; pin k in the plan). MASE < 1 vs naïve is a sanity *floor*, not the decision (a model can beat plain naïve yet still lose to the Rung A baseline). The non-headline revenue basis (the deterministic roll-forward, §6.2.3) has no statistical challenger and is **exempt from this gate** (G4 does not apply to it).
- **Pilot reality — Rung A is the accepted production model; G4 is conditional.** The cold-start "show" threshold and the backtest "promote" threshold are *different* and the spec is explicit that they don't line up: a 30-day forecast can be **shown** (≥~8.6 weeks history) well before a fold-sufficient head-to-head backtest is **evaluable** (~17+ weeks for ≥3 folds at a 30-day horizon). During that window **Rung A is the production model** (it may remain so indefinitely — that is a success, not a failure), and **G4 evaluates to "N/A — insufficient folds," never to "pass."** G4 is the only *hard* gate *when it can run*; while it can't, the pillar's pilot success is G1/G6/G7 (the loop works) plus "Rung A baselines are shown with honest per-horizon credibility badges," not a forecast-accuracy number. A shown-but-not-yet-backtestable horizon is **labeled as such** in the cockpit (never presented as validated).
- **Cold-start, tied to horizon (not a single switch):** require ≥ (2 × horizon-in-weeks) of history before showing a forecast *at that horizon*, plus a weekly-seasonality minimum before any Rung B model is eligible. 8 weeks is the floor for showing *any* forecast; the badge reflects **which horizons are credible** and **whether each shown horizon has cleared a backtest yet** — not a binary rung switch.

#### 6.2.8 Data model

Minimal new tables — forecasting reads existing tables for raw signals and persists only **rollups** (for performance) and **snapshots** (for accuracy tracking + UI).

```
demand_daily                          -- nightly rollup (perf: avoid re-scanning raw rows)
  id, organizationId
  day            date                 -- businessIsoDate bucket
  jobType        text (nullable)      -- null = all types
  bookings       int                  -- count(service_requests by createdAt)
  sessions       int                  -- count(customer_sessions)
  booked         int                  -- sessions with outcome='booked'
  UNIQUE(organizationId, day, jobType)

revenue_daily                         -- nightly rollup; native + synced kept SEPARATE
  id, organizationId
  day            date
  basis          text                 -- 'native_payment' | 'synced_creation'  (never blended)
  collectedCents int
  invoicedCents  int
  refundedCents  int
  UNIQUE(organizationId, day, basis)

forecast_snapshots                    -- versioned forecast outputs (for UI + backtest)
  id, organizationId
  kind           text                 -- 'demand'|'revenue'|'capacity'  (3 kinds — pipeline folds into revenue; churn cut)
  model          text                 -- 'seasonal_naive'|'holt_winters'|...  (which rung/model ran)
  horizonDays    int
  segment        text (nullable)      -- e.g. jobType / revenue basis
  generatedAt    timestamptz
  payload        jsonb                -- {points:[{day,value,lo,hi}], inputs:{...}, explanation?:string}
  index(organizationId, kind, generatedAt)

forecast_accuracy                     -- realized-vs-predicted LOG (for backtest + human model selection)
  id, organizationId, kind, model, segment, horizonDays
  forDay         date                 -- the day that was predicted
  predicted      int
  actual         int                  -- filled when the day passes (idempotent upsert on UNIQUE)
  absError       int                  -- |actual − predicted| (the MASE numerator; defined on zero actuals)
  -- NOTE: store raw absolute error, NOT a percentage. errorPct (sMAPE-style) is undefined when
  -- actual=0, which is exactly the sparse daily case here; MASE aggregation needs absError + the
  -- naïve-error scale, not a per-row percentage.
  UNIQUE(organizationId, kind, segment, horizonDays, forDay)
```

> **No automatic model failover.** `forecast_accuracy` is a *logging* table — it records predicted-vs-actual so a human can read the backtest and decide promotions. The earlier "auto-fall-back to the deterministic baseline on drift" idea is **cut**: at pilot scale a few weeks of daily points can't distinguish drift from noise, and an auto-failover presumes a deployed Rung B model that may never ship. Model selection is a human reading `forecast_accuracy`, not an automated threshold.

- **Why rollups:** the codebase has **no pre-bucketed series**; recomputing forecasts by re-scanning `service_requests`/`payments` each time is wasteful and slow on neon-http. Nightly rollups make recompute cheap and make the UI a single indexed read.
- **Why snapshots + accuracy:** forecasts must be *evaluated over time*; `forecast_accuracy` is how we know whether Rung B actually beats Rung A in production (model selection by evidence, not vibes).
- **PII:** all forecasting tables hold counts/cents/enums only. No customer PII.

#### 6.2.9 Interfaces (`src/lib/forecasting/`, NEW)

```ts
// rollups (cron-driven)
refreshDailyRollups(orgId, sinceDay?): Promise<void>   // demand_daily + revenue_daily upsert

// pure forecasters (unit-testable, no I/O) — series in, forecast out
seasonalNaive(series: DailyPoint[], horizonDays: number): ForecastPoint[]
holtWinters(series: DailyPoint[], opts): ForecastPoint[]
forecastRevenue(orgId, horizonDays): Promise<RevenueForecast>   // composes the 3 streams
forecastCapacity(orgId, horizonDays): Promise<CapacityForecast> // supply vs demand-hours

// orchestration (cron-driven): run forecasters, write forecast_snapshots, request explanation
runForecasts(orgId, { kinds, horizons }): Promise<void>

// backtest harness (§9)
backtest(series: DailyPoint[], models: ForecastModel[], folds): BacktestResult

// read API for the cockpit
getForecast(orgId, kind, horizonDays): Promise<ForecastSnapshot | null>
```

The **forecasting math is pure and unit-tested** (series-in/forecast-out), exactly like `dispatch/score.ts` — this is what makes it trustworthy and testable without a DB.

#### 6.2.10 Compute model

- **Nightly cron** (`/api/cron/run-forecasts`, mirroring the existing `generate-membership-visits` / `process-communications` cron pattern with `CRON_SECRET`): refresh rollups → run forecasters → write snapshots → request LLM explanations → backfill `forecast_accuracy` for the day that just closed.
- **Every sub-step is independently idempotent and re-runnable** (upserts keyed by the `UNIQUE` constraints — `(org,day,jobType)`, `(org,day,basis)`, `(org,kind,segment,horizonDays,forDay)`), so a partial run (cron timeout / Vercel freeze mid-batch) self-heals on the next run. **No step assumes cross-step atomicity** — `db.batch` is *not* a transaction on neon-http (this matches the existing `generate-membership-visits` "safe to re-run / self-heals" contract).
- **All math runs in-process in TypeScript** (Rung A/B). No Python, no separate compute service for the launch rungs. Deliberate constraint-driven choice (§10).
- **neon-http discipline:** aggregates coerced with `Number()`; multi-write via `db.batch`; no transactions.

#### 6.2.11 Where the LLM fits (and where it must not)

- **The LLM does NOT compute the numeric forecast.** Numbers come from deterministic/statistical math we can backtest. Putting prediction in an LLM would be unexplainable and unbacktestable — the opposite of this pillar's philosophy.
- **The LLM only narrates pre-computed numbers.** A `generateText` pass (Qwen/GLM via `getModel`) turns `{forecast points + inputs + deltas}` into a plain-language description: *"Bookings are forecast up ~28% over the next 30 days, concentrated mid-month; the capacity band is tight that week."*
- **Numeric fidelity is ENFORCED, not requested.** The review correctly noted that "the prompt is constrained to summarize" is the exact prompt-level mitigation the codebase's own `output-guardrail.ts` declares insufficient ("a prompt is a request, not a guarantee"). So either (a) the explanation is **extractive/templated** — code injects the pre-formatted number tokens and the LLM only writes glue prose around them — or (b) a **post-generation numeric-fidelity check** extracts every numeral/percentage from the output and rejects/regenerates if any value is not present in (or within tolerance of) the source payload. **A plan must implement one of these; the prompt instruction alone is not acceptable.**
- **No LLM prescriptions.** Action recommendations ("open evening slots", "run an outbound fill") are emitted by **deterministic rules driven by the capacity-gap flag**, not by the LLM — keeping the LLM to description so it can never recommend something that contradicts the numbers.
- **Admin-only is structural, via a branded type — no escape hatch.** The explanation is admin-channel-only and **must never reach a customer channel** (chat reply, TTS, SMS/email body, widget). This is enforced by a **nominal branded type `AdminOnlyText`** (the *only* acceptable mechanism — the earlier "or just keep it out of a DTO" alternative is dropped, because "keep it out by convention" is exactly the `audit_log.details` weakness we rejected). `getForecast` returns the explanation as `AdminOnlyText`; the customer comms builder (`queueCommunicationJob` body param) and any customer serializer **type-reject** `AdminOnlyText`, so leaking it into outbound/inbox is a **compile error**. (Load-bearing: the intelligence layer feeds OUTBOUND in the architecture.)
- **Defense-in-depth: screen it anyway.** Because the numeric-fidelity check only validates numbers (not false-booking / dangerous-DIY / credential phrasing), the explanation is **also run through `screenAssistantReply` before persist** — the detectors are pure, exported, no-I/O, and a safety-phrase in a forecast narration is nonsensical so false-positive risk is ~0. So even if the branded-type barrier were ever bypassed, the text has still passed the four hard safety detectors. (The brand is the primary guarantee; this is the backstop.)

#### 6.2.12 UI — the owner cockpit

A new admin section (`/admin/forecast` or folded into the existing dashboard) showing:
- Demand forecast (next 7/30 days; 90-day shown only when history qualifies) with the historical series and prediction band.
- Revenue forecast with the three-stream breakdown (booked / pipeline / recurring) on the chosen single basis (clearly labeled native-collected vs synced-creation), and month-to-date pacing vs forecast.
- Capacity **advisory** view (buffered demand-hours vs haircut available-hours per week; flagged where short, with the PTO-not-modeled caveat — G6).
- The numeric-fidelity-checked plain-language explanation per forecast.
- A per-horizon credibility badge (which horizons the history supports) for cold-start orgs.

Follows the existing Spears-branded admin design conventions (navy sidebar, elevated cards). Built as client components; verified by `tsc` + `build` (consistent with the tech-portal UI precedent).

### 6.3 Dispatch Intelligence (EXTEND — `src/lib/ai/dispatch/`)

**Responsibility:** assign on **skill + conversion + load + proximity + forecast-capacity awareness**, explainable, gated by the existing `organization_settings.auto_dispatch_enabled` (default false).

- **Extend `signals.ts`** — add per-tech, from existing tables: `conversionRate` (sold estimates / assigned jobs), `avgJobRevenueCents` (from invoices on completed jobs, reuse `getTechnicianScorecards` shape). No migration for these signals.
- **Extend `score.ts`** (currently `W_SKILL=0.5, W_QUALITY=0.3, W_LOAD=0.2`) — add a **conversion** term; keep weights as **tunable constants, explicitly provisional, tuned on pilot data post-launch** (do not hand-tune as gospel pre-launch). The `reasons[]` are the trust/override mechanism.
- **Capacity-aware — soft signal, FAIL OPEN.** Capacity is a **penalty term in `score.ts` / a `reasons[]` annotation, never a hard exclusion.** A missing, stale, or low-confidence forecast is treated as "no capacity signal" and assignment proceeds exactly as today. This preserves the existing documented invariant that *"opting in never strands a job that first-fit would have placed"* (`scheduling-queries.ts:849-860`). To make the proof airtight: **the capacity term only adjusts ordering among candidates that have already passed the skill gate inside `rankedTechnicianOrder`; it never removes a candidate from the set, and no score floor/threshold is ever applied to it** (so it cannot empty the `order` list). The spec deliberately avoids "doesn't pack" hard-gating language.
- **Proximity (later slice):** `users.baseLat/baseLng` (`disp-1`) + a distance term; geocode-on-save reuses existing address geocoding.
- **Exceptions queue:** the dispatch board's "Unassigned" column *is* the queue; add **top-3 scored suggestions + one-click assign** to the request detail sheet (suggestion is read-only; human commits).
- **Real-time availability:** `technician_time_off` (`disp-2`) folded into the conflict gate.

### 6.4 Data-Quality pre-assign gate (NEW — small)

**Responsibility:** "clean every booking before it hits the board." A pre-dispatch gate run inside the existing intake `after()`:

```ts
assessBookingQuality(orgId, requestId): { ok: boolean; issues: string[]; enriched?: BookingEnrichment }
```

- Address validate (have: `address-validation.ts`), dedup (have: blind-index), pull equipment/warranty + prior-job history (have: FSM mirrors + context layer), completeness score.
- **On low quality → route to the exceptions queue (flag), not auto-assign.** Emit a `note` event to the context layer.
- **Decision:** mostly *composition* of existing checks into one pre-assign gate + a `service_requests.quality_flag` (1 nullable column, migration `dq-1`).

### 6.5 Outbound Engine (EXTEND — `src/lib/communication/`) — forecast-driven

**Responsibility:** proactive, attributable revenue, on the consent/quiet-hours/ledger rails we already have — now **driven by forecasts**.

Two campaigns (v3), both cron-driven, both using `claimOutboundOnce` (dedup) + `checkSendAllowed` (consent) + `queueCommunicationJob`:

1. **Unsold-estimate follow-up:** open `estimates` older than N days with no sold option → consent-gated nudge (new `estimate_followup` trigger/template) → record an `outbound` event → attribute a booking if one follows within a window. Prioritized by the pipeline forecast (6.2.5) — chase the estimates most likely to convert.
2. **Forecast-driven fill-the-board:** when the **capacity forecast** (6.2.4) shows a near-future day/week with open capacity *and* demand forecast is soft, select maintenance-due / recurring customers (reuse membership visit generation) → consent-gated offer to fill the slack. This is the synergy that makes forecasting *operational*, not just informational (G7).

- **Data model:** reuse `outbound_message_ledger` + `communication_jobs`. Add `outbound_campaigns` only if attribution demands it (start with the event log + ledger).
- **Decision:** outbound rides entirely on existing comms/consent/ledger; the new part is the **forecast-informed selection logic** (who/when) + attribution.

### 6.6 Staffed Inbox (EXTEND — for the ~10% the AI hands off)

**Responsibility:** a human picks up the threads the AI escalates. We have the reply endpoint + `mode='human'` flip; this adds a **mode-aware thread-list + thread-view UI** in admin, reading the context layer (6.1).

---

## 7. Data model summary (all migrations)

| Migration | Adds | For |
|---|---|---|
| 0021 *(pending, operator)* | `organization_settings.auto_dispatch_enabled`, `service_requests.auto_assigned` | Dispatch v1 unlock |
| 0022 *(pending, operator)* | `users.housecall_pro_user_id` + partial unique | HCP roster sync |
| ctx-1 (0023) | `customer_threads`, `customer_events` | Context layer (6.1) |
| fc-1 | `demand_daily`, `revenue_daily` | Forecasting rollups (6.2.8) |
| fc-2 | `forecast_snapshots`, `forecast_accuracy` | Forecast outputs + accuracy (6.2.8) |
| dq-1 | `service_requests.quality_flag` (1 col) | Data-quality gate (6.4) |
| disp-1 | `users.baseLat/baseLng` | Proximity scoring (6.3) |
| disp-2 | `technician_time_off` | Real-time availability + capacity forecast (6.2.4, 6.3) |
| (signals / outbound need **no** migration — read existing tables) | — | 6.3 conversion signals, 6.5 |

All additive; authored via `drizzle-kit generate`; **operator applies** (`npm run db:migrate`) — migrations are not auto-run on deploy. Forecasting needs only `fc-1`/`fc-2` to start (rollups + snapshots); everything else compounds.

---

## 8. Build sequence (each phase → its own `writing-plans` plan)

Resequenced **loop-first** (per review): operational consumers that need no migration are interleaved early so we're not building four straight phases of read-only analytics before anything *acts* — while still landing Rung A demand+revenue forecasting early to honor its first-class status. The capacity forecast ships with an **owner-facing advisory view immediately (Phase 5 — the owner reading the gap *is* a consumer), and its automated consumers one phase later (Phase 6: capacity-aware dispatch + fill-the-board).** Two notes a plan must honor: **(i)** Phase 4 (revenue) is gated on operator **Q3** (which basis is the headline) being answered first; **(ii)** the `customer_events` contract (`labelKey` enum + renderer, §6.1) is locked in **Phase 1**, before any consumer phase (3, 6) emits events.

| Phase | Component | New migration? | Reuses | Gate / success |
|---|---|---|---|---|
| **0** | *Make dispatch v1 live* (apply 0021/0022, pilot org, roster sync) | applies existing | dispatch v1, roster sync | pilot books w/ zero human dispatch (G2) |
| **1** | **Context layer** (6.1) — tables, `thread.ts`, wire emitters + fail-open intake readers | ctx-1 | identity, status-events | one thread/customer across channels (G1) |
| **2** | **Dispatch conversion scoring + exceptions queue + top-3 suggestions** (6.3) | none | score.ts/signals.ts, board | scored, explainable assignments; trust/override (G3) |
| **3** | **Outbound: unsold estimates** (6.5.1) | none | comms, estimates, ledger | attributable re-bookings |
| **4** | **Forecasting rollups + Rung A demand+revenue** (6.2.1–6.2.3) + cockpit v1 | fc-1, fc-2 | reporting-queries, cron pattern | partitioned demand+revenue baseline visible |
| **5** | **Capacity advisory + gap view** (6.2.4) | disp-2 | computeOpenWindows, time-entries, time-off | capacity gap flagged ≥14 days out (G6) |
| **6** | **Capacity-aware (soft) dispatch + forecast-driven fill-the-board** (6.3, 6.5.2) | none | capacity forecast, membership | forecast-slow slots filled (G7); fail-open preserved |
| **7** | **Forecast LLM explanations** (6.2.11) — numeric-fidelity-checked, admin-only branded | none | provider seam | each forecast has a fidelity-checked "why" (G8) |
| **8** | **Rung B statistical models + backtest harness** (6.2.7, §9) | none | Rung A series | chosen model beats the **incumbent** head-to-head (G4) |
| **9** | **Data-quality gate** (6.4) | dq-1 | address/dedup/FSM | bad bookings flagged pre-assign |
| **10** | **Proximity** (6.3) | disp-1 | score.ts | route-aware ranking |
| **11** | **Staffed inbox UI** (6.6) | none | reply endpoint, context layer | humans handle the ~10% |
| **(out of pilot)** | Rung C learned models, external compute, weather features (§11) | — | — | revisit only if Rung B is the measured baseline + data justifies |

**Phases 2/3/6/7/8/11 need no new migration.** Phase 0 is the operator's unlock; the context layer (Phase 1) is the spine everything compounds on; forecasting lands at Phase 4 (early) and gets its consumer at Phase 6.

> **On keeping this as one spec (not three).** The review argued for splitting into separate context / forecasting / operational specs. The three subsystems *are* independently approvable, and each phase gets its own `writing-plans` plan — so they can be sequenced and approved on their own merits. It is kept as **one master document by explicit request** ("write out a long spec"). The false-dependency concern (forecasting artificially gating operational work) is resolved by the loop-first resequence above, not by document structure: nothing operational waits on forecasting except Phase 6, which genuinely consumes it.

---

## 9. Forecasting evaluation, backtesting & monitoring

Forecasting is the one pillar where "it runs" ≠ "it's right." So evaluation is built in, not bolted on.

- **Backtest harness (`backtest()` in `src/lib/forecasting/`):** rolling-origin (walk-forward) cross-validation. Two refinements the review required: (1) a **minimum train size** before a seasonal model is eligible in a fold (you can't fit weekly seasonality on 2 weeks, and early under-trained folds would unfairly penalize Rung B); (2) **per-horizon, multi-step evaluation** — predict k+1 *and* k+1..k+4 (and the 90-day window where eligible), so each shipped horizon (7/30) is actually validated, not just the 1-step. Pure function over a series; unit-testable with synthetic seasonal series.
- **Metrics:** **MASE is primary and the promotion gate** (scale-normalized, defined on zero-heavy daily series); **sMAPE secondary, on aggregated weekly/total series only** (it degenerates on sparse daily-by-jobType data); plus prediction-interval coverage. Promotion is **head-to-head per series and per horizon** — a candidate replaces the incumbent only when its held-out error is lower than the incumbent's on the same folds (MASE < 1 vs naïve is a sanity floor, not the decision).
- **Production logging (no auto-failover):** `forecast_accuracy` logs predicted-vs-actual each day for human review. There is **no automatic drift-fallback** — at pilot scale a few weeks can't distinguish drift from noise, and an auto-failover presumes a deployed Rung B model that may never ship. A human reads the log and decides.
- **Accuracy SLOs:** set after the first real backtest on pilot data (a "±X%" target invented pre-data would be circular). The standing commitment: **never ship a model that loses to the incumbent (or to seasonal-naïve) on backtest**; always show the per-horizon credibility badge when history is thin. This is the *only* hard quantitative gate (G4); accuracy SLOs are advisory until there's data to set them on.
- **Cold-start honesty:** credibility is tied to horizon (≥ 2×horizon-in-weeks of history per horizon; 8-week floor for any forecast). We don't fabricate seasonality we can't yet see.

---

## 10. AI/ML stack decisions & build-vs-buy

- **Numeric forecasting = TypeScript-native classical stats (build).** Moving averages, exponential smoothing, Holt-Winters, linear regression, STL-style decomposition, and the backtest harness are all recurrence/array math — fully implementable in TS, no Python, no extra service. This fits the serverless runtime (no ML runtime exists today) and keeps everything backtestable and unit-tested. **This is the launch choice (Rungs A/B).**
- **LLM = explanation only (reuse).** Qwen/GLM via the existing `@ai-sdk/openai` provider seam (`getModel`) for plain-language forecast narration. No new provider; no LLM in the numeric path.
- **Learned models / external compute / weather features = OUT OF PILOT SCOPE** (one line, per review — see §11). They would only be revisited once Rung B is the measured production baseline and data volume justifies it, and would run in an external service (not the serverless app). Not a launch design surface.
- **Buy, don't build (unchanged):** telephony (Twilio), TTS/ASR (ElevenLabs), geocoding (Photon), payments/financing — all integrated. Build only the spine + the intelligence head + the wedge.

---

## 11. Risks & explicit anti-goals

- **Spreading thin** — still the #1 risk. v3 adds a whole pillar; mitigate by sequencing forecasting as deterministic-first (small, shippable rungs) and keeping everything else scoped to one pilot/vertical.
- **Forecasting before data** — the canonical forecasting trap. Mitigated by the maturity ladder + backtest gate + cold-start badge. We ship deterministic baselines first *precisely because* they need no history.
- **Unexplainable / fabricated-number forecasts** — numbers stay deterministic/statistical (not LLM); the LLM only narrates and is **numeric-fidelity-checked** (extractive templating or post-gen validation), with prescriptions emitted by deterministic rules. The explanation is **admin-only by type**, never reaching a customer channel.
- **Forecast over-counting revenue** — the three streams are a **strict partition with precedence** (§6.2.3), not three overlapping estimates; a backtest assertion guards against structural over-count.
- **Blending native + synced revenue** — a money-safety violation; `revenue_daily.basis` is kept separate and only the **data-richest single basis** is forecast as the headline (not two thin seasonal models). Forecasting is **read-only** against money tables (§5.5).
- **Capacity gap biased toward silence** — corrected by a utilization-haircut on supply + a duration buffer on demand + an explicit "PTO not modeled" caveat; the gap is **advisory and fail-open** in dispatch, never a hard exclusion that could strand a job.
- **Context-layer consistency** — `appendEvent` is best-effort/async and `getThread` fails open; the event log is a projection (FSM/native tables authoritative); summaries are structured enum/label fields (no free-text PII, no LLM). Avoids a distributed-consistency rabbit hole.
- **Anti-goals (explicit, expanded per review):** multi-vertical breadth; ServiceTitan-scale marketplace; native mobile; a research-grade ML platform; **learned/ML forecasting, external compute, and weather features (Rung C)**; **churn/LTV forecasting** and **pipeline as a standalone forecaster**; **automatic model drift-failover**; the **90-day horizon** until ≥1yr history; any forecast we can't backtest; real-time/intraday forecasting (daily granularity suffices).

---

## 12. Open questions for the operator (before plans)

1. **Pilot org** — which org do we target, and is `auto_dispatch_enabled` acceptable to flip there?
2. **Migrations** — confirm you'll apply `0021`/`0022` then `ctx-1`/`fc-1`/`fc-2`/`dq-1`/`disp-1`/`disp-2` as we land them (same `npm run db:migrate` flow).
3. **Revenue basis for the headline forecast** — the *rule* is fixed (forecast the **single data-richest basis** as the headline, never two thin seasonal models; the other basis is a labeled deterministic roll-forward). The *choice* is yours per the pilot: is the pilot a mostly-**native** shop (headline = native payment-date / collected) or a mostly-**FSM-synced** shop (headline = synced creation-cohort / *invoiced*, with the caveat that creation-cohort ≠ cash-collection)?
4. **Forecast accuracy targets** — agree we set numeric SLOs *after* the first backtest on pilot data (not pre-data), with the standing commitment "never lose to seasonal-naïve."
5. **Outbound consent posture** — confirm consent/quiet-hours defaults are acceptable for proactive outbound (it rides existing `checkSendAllowed`, but proactive outreach is a policy call).
6. **Rung C appetite** — do you want learned models on the roadmap (external service + weather data) once Rung B is the baseline, or is deterministic+statistical forecasting sufficient for the pilot?
7. **Scope confirmation** — agree to the v3 scope (context layer + forecasting + dispatch/outbound for one pilot) and defer multi-vertical/ServiceTitan/mobile?

---

*End of v3 master spec (hardened via adversarial review — round 1). Next step on approval: per-component `writing-plans` plans, starting with the context layer (Phase 1) and the no-migration operational wins (Phases 2–3: dispatch scoring + outbound), then forecasting rollups + Rung A (Phase 4). No implementation begins until this spec is approved and the operator applies the gating migrations.*
