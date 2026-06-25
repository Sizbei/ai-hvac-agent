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
                    demand · revenue · capacity · pipeline · churn
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
| G4 | **Demand forecast beats seasonal-naïve baseline** | Backtested sMAPE of the chosen model < sMAPE of seasonal-naïve on held-out weeks (§9) |
| G5 | **Revenue forecast within a stated tolerance** | 30-day-ahead booked+pipeline revenue forecast within ±X% (target set after first backtest; see §9) |
| G6 | **Capacity gap surfaced before it bites** | The cockpit flags any forecast week where projected demand-hours > projected available tech-hours, ≥ N days out |
| G7 | Outbound fills forecasted-slow capacity with attributable bookings | Bookings attributable to a "fill-the-board" nudge on a forecast-slow day |
| G8 | Forecasts are trusted (not just present) | Each forecast carries a plain-language LLM explanation + the inputs it used; owner can drill into the underlying series |

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
   │  forecasters: demand · revenue · capacity · pipeline · churn   (deterministic→statistical→ML)    │
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
| Native invoiced/billed | `invoices.totalCents`, `state ∈ {open,paid,void,refunded}`, `amountPaidCents` | Balance/AR = `totalCents − amountPaidCents` (derived, not stored). |
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

**Net read:** we have *enough* to build genuinely useful demand, revenue, capacity, and pipeline forecasts today, provided we (a) build daily rollups, (b) respect the native/synced split, and (c) derive seasonality from dates. The gaps that matter (PTO, geo) are additive and already on the dispatch roadmap.

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
  summary         text    -- PII-free one-liner ("Booked no_cool, Tue PM") — NEVER raw PII
  at              timestamptz
  index(organizationId, customerId, at)
```

**Interfaces (`src/lib/context/thread.ts`, NEW):**

```ts
resolveThread(orgId, contactOrCustomerId): Promise<{ threadId; customerId } | null>
  // reuse findCustomerIdByContact; create the thread row lazily on first event

appendEvent(orgId, customerId, evt: { kind; refId?; summary }): Promise<void>
  // best-effort, try/catch, NEVER throws into the request path
  // (exact contract copied from recordStatusEvent in src/lib/admin/status-events.ts)

getThread(orgId, customerId): Promise<CustomerThread>
  // profile + recent events + open estimates/jobs + service history
```

**Key decisions:**
- **Reuse identity, don't rebuild it.** `customers` + HMAC blind-index (`upsertCustomerByContact`, `findCustomerIdByContact` in `crm-queries.ts`) is the identity spine. `customer_threads` hangs a thread/event log off it.
- **PII discipline** mirrors `audit_log`: `summary` is a non-PII one-liner; raw content stays in `messages`/`request_notes`, referenced by `refId`.
- **`appendEvent` is best-effort** — same pattern as `recordStatusEvent` (the event log is a *projection*, never the source of truth; FSM mirrors and native tables remain authoritative).
- **Wiring:** voice-turn, chat route, `submit-session-request`, status transitions, and comms sends each call `appendEvent` inside an existing `after()` block. Intake reads `getThread` at the same seam where `loadCustomerContextById` is called today (`chat/route.ts` after the contact slot fills; `voice-turn.ts` after ANI resolves), so a returning customer is recognized on **any** channel.
- **Migration:** 2 additive tables, authored via `drizzle-kit generate` (next number 0023+), operator applies.

### 6.2 Forecasting & Revenue Intelligence (the new pillar)

This is the largest new component. It is organized as: design philosophy (the ladder) → the five forecasters → methodology → data model → interfaces → compute model → LLM role → UI.

#### 6.2.1 Design philosophy: the maturity ladder

We refuse to ship a forecast we can't explain or backtest. So every forecaster climbs the same three-rung ladder, and **each rung is shippable on its own**:

- **Rung A — Deterministic baselines (no training data, useful day one).**
  - Demand: *seasonal-naïve* (this week ≈ same week last year, falling back to same-weekday-last-4-weeks when <1yr history) + trend-adjusted moving average.
  - Revenue: *pipeline-weighted* — booked/scheduled revenue + (open-estimate value × historical close rate) + contracted MRR.
  - Capacity: forecasted demand-hours vs `computeOpenWindows` projected availability.
  - These are the **baselines every later model must beat** (§9). They are not throwaway — for low-data orgs they may remain the production model indefinitely.

- **Rung B — Statistical seasonal models (TypeScript-native, no Python).**
  - Exponential smoothing / **Holt-Winters** (level + trend + seasonal) for demand and revenue — captures HVAC's annual cooling/heating cycle and weekly pattern. Fully implementable in TS (it's recurrence relations over the series).
  - Optional **STL-style decomposition** (trend + seasonal + residual) for explainability ("demand is up 12% on trend, +30% seasonal for July").
  - Selected per-series by **backtest**: we only promote B over A when B's held-out error is lower (§9).

- **Rung C — Learned models (only when justified).**
  - Gradient-boosted or regression models over engineered features (lead-source mix, weather, marketing spend, day-of-week, holiday flags) — **added only once (a) there's enough labeled history and (b) the deterministic/statistical baseline is the explicit thing to beat**, and only via the build-vs-buy decision in §10 (likely an external service, since there's no Python/ML runtime in the serverless app).
  - We do **not** start here. Rung C is a roadmap item gated on data volume and a measured baseline, not a launch feature.

**Why this ladder is "best":** it delivers owner value immediately (Rung A), improves measurably with a clear gate (Rung B), and keeps complexity honest (Rung C earns its way in). It also dodges the classic failure of forecasting features — an impressive model nobody trusts because it can't be explained or checked.

#### 6.2.2 Demand forecasting

**Question answered:** "How many bookings/jobs should we expect next week / next 30 days / next quarter, overall and by job type?"

- **Series:** daily booking count from `service_requests.createdAt`, bucketed by `businessIsoDate` (business TZ `America/New_York`), segmentable by `jobType` (`no_heat`/`no_cool` are the season proxies), `systemType`, `leadSource`.
- **Plus forward-known demand:** add scheduled `membership_visits.dueDate` as a *known* additive component (not predicted — it's already on the books).
- **Rung A:** seasonal-naïve + trend. **Rung B:** Holt-Winters with weekly seasonality (and annual once ≥1yr history).
- **Output:** point forecast + simple prediction interval (from backtest residual spread) per horizon (7/30/90 days).

#### 6.2.3 Revenue forecasting

**Question answered:** "What revenue should we expect, and are we on track this month/quarter?"

Revenue is decomposed into three additive streams (each forecast separately, then summed, so the cockpit can explain the mix):

1. **Booked/scheduled** — revenue from jobs already scheduled in the horizon (from scheduled `service_requests` joined to estimates/expected ticket).
2. **Pipeline-weighted** — open `estimates.totalCents` × historical close rate (from `reporting-queries.ts` close-rate logic), time-decayed by estimate age.
3. **Recurring (MRR)** — contracted recurring value from active memberships (derived per §5.1), recognized over the horizon.

- **Native vs synced:** forecast the **native** payment-date stream as the headline (it has a clean time base); show synced as a separate, clearly-labeled informational stream. **Never sum them into one series** (money-safety invariant).
- **Rung A:** the three-stream decomposition above (already a real forecast). **Rung B:** Holt-Winters on the historical collected-revenue series to capture seasonality, blended with the deterministic pipeline component.

#### 6.2.4 Capacity forecasting

**Question answered:** "Will we have enough technician-hours to meet forecasted demand? Where's the gap?"

- **Supply:** projected available tech-hours per future day/week from `technician_availability` (weekly template) minus `technician_time_off` (once `disp-2` lands) minus already-booked load (`getScheduledJobsForRange`). `computeOpenWindows` is the existing primitive.
- **Demand-hours:** forecasted job count (6.2.2) × average job duration (from `technician_time_entries.minutes` by jobType).
- **Gap signal (success criterion G6):** flag any horizon week where demand-hours > available-hours, ≥ N days out, so the owner can hire/schedule/redirect outbound.
- **Caveat (honest):** until `technician_time_off` exists, capacity uses the weekly template only; the forecast notes this limitation rather than silently over-stating supply.

#### 6.2.5 Pipeline / conversion forecasting

**Question answered:** "Of the open estimates, how much will convert, and when?"

- **Inputs:** `estimates` (open/sold/expired, `soldOptionId`, age, `totalCents`), historical close rate and time-to-close from existing reporting.
- **Output:** expected-converted-value and expected-conversion-timing — feeds the revenue pipeline stream (6.2.3) and the outbound unsold-estimate campaign (6.5).

#### 6.2.6 Membership churn & LTV (lighter, later rung)

**Question answered:** "Which memberships are at risk, and what's recurring value at risk?"

- **Inputs:** `customer_memberships` (status, `currentPeriodEnd`, `cancelledAt`), visit completion (`membership_visits.status`), service frequency.
- **Rung A:** rule-based risk flags (lapsing period end + no recent visit). Learned churn is Rung C, gated on data. Low priority versus demand/revenue/capacity; included for completeness.

#### 6.2.7 Methodology deep-dive (models, features, evaluation)

- **Granularity:** daily series, aggregated to weekly/monthly for display. Horizons: 7, 30, 90 days.
- **Features (Rung B/C):** day-of-week, week-of-year, month, holiday flag, lead-source mix, after-hours share, trailing demand, and (Rung C) weather + marketing spend if/when integrated.
- **Seasonality handling:** weekly seasonality is learnable from a few months; annual (the big HVAC effect) needs ≥1 year — until then, the seasonal-naïve baseline approximates annual seasonality from the prior year if any, else flags "insufficient history for annual seasonality" rather than faking it.
- **Cold-start:** orgs with <8 weeks of data get Rung A only, with an explicit "low-confidence, limited history" badge.
- **Evaluation metrics:** **sMAPE** (primary, scale-free, handles zeros better than MAPE), **MASE** (vs seasonal-naïve — directly tests "did we beat the baseline"), plus coverage of prediction intervals. (§9 details the backtest harness.)

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
  kind           text                 -- 'demand'|'revenue'|'capacity'|'pipeline'|'churn'
  model          text                 -- 'seasonal_naive'|'holt_winters'|...  (which rung/model ran)
  horizonDays    int
  segment        text (nullable)      -- e.g. jobType / revenue basis
  generatedAt    timestamptz
  payload        jsonb                -- {points:[{day,value,lo,hi}], inputs:{...}, explanation?:string}
  index(organizationId, kind, generatedAt)

forecast_accuracy                     -- realized-vs-predicted log (drift + model selection)
  id, organizationId, kind, model, segment
  forDay         date                 -- the day that was predicted
  predicted      int
  actual         int                  -- filled when the day passes
  errorPct       double precision
  index(organizationId, kind, forDay)
```

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

- **Nightly cron** (`/api/cron/run-forecasts`, mirroring the existing `generate-membership-visits` / `process-communications` cron pattern with `CRON_SECRET`): refresh rollups → run forecasters → write snapshots → (optionally) request LLM explanations → backfill `forecast_accuracy` for the day that just closed.
- **All math runs in-process in TypeScript** (Rung A/B). No Python, no separate compute service for the launch rungs. This is a deliberate constraint-driven choice (§10).
- **neon-http discipline:** aggregates coerced with `Number()`; multi-write via `db.batch`; no transactions.

#### 6.2.11 Where the LLM fits (and where it must not)

- **The LLM does NOT compute the numeric forecast.** Numbers come from deterministic/statistical math we can backtest. Putting prediction in an LLM would be unexplainable and unbacktestable — the opposite of this pillar's whole philosophy.
- **The LLM explains the forecast.** A `generateText` pass (Qwen/GLM via the existing `getModel`/provider seam) turns `{forecast points + inputs + deltas}` into a plain-language "why" for the cockpit: *"Bookings are forecast up ~28% over the next 30 days, driven mostly by the seasonal cooling spike; capacity is tight the week of July 14 — consider opening evening slots or an outbound fill for the prior slow week."* This is grounded summarization of numbers we already trust, and it is the trust mechanism (G8).
- **Guardrail:** explanations are owner-facing (admin), not customer-facing — they bypass the customer output guardrail but must not invent numbers; the prompt is constrained to summarize the provided payload only.

#### 6.2.12 UI — the owner cockpit

A new admin section (`/admin/forecast` or folded into the existing dashboard) showing:
- Demand forecast (next 7/30/90 days) with the historical series and prediction band.
- Revenue forecast with the three-stream breakdown (booked / pipeline / recurring) and month-to-date pacing vs forecast.
- Capacity gap view (forecast demand-hours vs available-hours per week; red where short — G6).
- The plain-language explanation per forecast.
- A confidence/limited-history badge for cold-start orgs.

Follows the existing Spears-branded admin design conventions (navy sidebar, elevated cards). Built as client components; verified by `tsc` + `build` (consistent with the tech-portal UI precedent).

### 6.3 Dispatch Intelligence (EXTEND — `src/lib/ai/dispatch/`)

**Responsibility:** assign on **skill + conversion + load + proximity + forecast-capacity awareness**, explainable, gated by the existing `organization_settings.auto_dispatch_enabled` (default false).

- **Extend `signals.ts`** — add per-tech, from existing tables: `conversionRate` (sold estimates / assigned jobs), `avgJobRevenueCents` (from invoices on completed jobs, reuse `getTechnicianScorecards` shape). No migration for these signals.
- **Extend `score.ts`** (currently `W_SKILL=0.5, W_QUALITY=0.3, W_LOAD=0.2`) — add a **conversion** term; keep weights as **tunable constants, explicitly provisional, tuned on pilot data post-launch** (do not hand-tune as gospel pre-launch). The `reasons[]` are the trust/override mechanism.
- **Capacity-aware:** consult the capacity forecast (6.2.4) so dispatch doesn't pack a day already forecast to be over capacity; surface this in `reasons[]`.
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

| Phase | Component | New migration? | Reuses | Gate / success |
|---|---|---|---|---|
| **0** | *Make dispatch v1 live* (apply 0021/0022, pilot org, roster sync) | applies existing | dispatch v1, roster sync | pilot books w/ zero human dispatch (G2) |
| **1** | **Context layer** (6.1) — tables, `thread.ts`, wire emitters + intake readers | ctx-1 | identity, status-events | one thread/customer across channels (G1) |
| **2** | **Forecasting rollups + Rung A baselines** (6.2.1–6.2.3 deterministic) + cockpit v1 | fc-1, fc-2 | reporting-queries, cron pattern | demand+revenue baseline forecasts visible |
| **3** | **Capacity forecast + gap view** (6.2.4) | none (uses disp-2 if present) | computeOpenWindows, time-entries | capacity gap flagged ≥N days out (G6) |
| **4** | **Rung B statistical models + backtest harness** (6.2.7, §9) | none | Rung A series | chosen model beats seasonal-naïve (G4/G5) |
| **5** | **Forecast LLM explanations** (6.2.11) | none | provider seam | each forecast has a trusted "why" (G8) |
| **6** | **Dispatch conversion scoring + capacity-aware** (6.3) | none | score.ts/signals.ts | scored, capacity-aware assignments (G3) |
| **7** | **Exceptions queue UI + top-3 suggestions** (6.3) | none | dispatch board | dispatcher trusts/overrides |
| **8** | **Outbound: unsold estimates** (6.5.1) | none | comms, estimates, ledger | attributable re-bookings |
| **9** | **Outbound: forecast-driven fill-the-board** (6.5.2) | none | capacity forecast, membership | forecast-slow slots filled (G7) |
| **10** | **Data-quality gate** (6.4) | dq-1 | address/dedup/FSM | bad bookings flagged pre-assign |
| **11** | **Proximity + PTO** (6.3, 6.2.4) | disp-1, disp-2 | score.ts, conflict gate | route-aware, PTO-aware |
| **12** | **Staffed inbox UI** (6.6) | none | reply endpoint, context layer | humans handle the ~10% |
| **(later)** | **Rung C learned models** (6.2.1) | TBD (likely external service) | backtest harness, feature store | only if it beats Rung B on backtest (§10) |

Forecasting (Phases 2–5) is sequenced **right after the context layer** to honor its first-class status, and **before** the dispatch/outbound extensions that *consume* its capacity/demand signals.

---

## 9. Forecasting evaluation, backtesting & monitoring

Forecasting is the one pillar where "it runs" ≠ "it's right." So evaluation is built in, not bolted on.

- **Backtest harness (`backtest()` in `src/lib/forecasting/`):** rolling-origin (walk-forward) cross-validation — train on weeks 1..k, predict week k+1, slide forward. Pure function over a series; unit-testable with synthetic seasonal series.
- **Metrics:** **sMAPE** (primary), **MASE** vs seasonal-naïve (the "did we beat the baseline" test — G4), and prediction-interval coverage. A model is only promoted from Rung A→B for a given series/segment when MASE < 1 (beats naïve) on held-out folds.
- **Production drift:** `forecast_accuracy` logs predicted-vs-actual each day. The nightly cron computes rolling error; if a deployed model's error degrades past a threshold (e.g. seasonal break, new marketing channel), the cockpit flags it and the system can fall back to the deterministic baseline automatically.
- **Accuracy SLOs:** set after the first real backtest on pilot data (we will not invent a number pre-data). The *commitment* is: never ship a model that loses to seasonal-naïve on backtest; always show a confidence/limited-history badge when history is thin.
- **Cold-start honesty:** orgs with <8 weeks of data get Rung A + an explicit low-confidence badge; we don't fabricate seasonality we can't yet see.

---

## 10. AI/ML stack decisions & build-vs-buy

- **Numeric forecasting = TypeScript-native classical stats (build).** Moving averages, exponential smoothing, Holt-Winters, linear regression, STL-style decomposition, and the backtest harness are all recurrence/array math — fully implementable in TS, no Python, no extra service. This fits the serverless runtime (no ML runtime exists today) and keeps everything backtestable and unit-tested. **This is the launch choice (Rungs A/B).**
- **LLM = explanation only (reuse).** Qwen/GLM via the existing `@ai-sdk/openai` provider seam (`getModel`) for plain-language forecast narration. No new provider; no LLM in the numeric path.
- **Learned models (Rung C) = buy/external, later.** If/when Rung B is the measured baseline and data justifies a learned model, run it in an **external service** (a small Python worker or a managed forecasting API) invoked by the cron — *not* embedded in the Next.js serverless app. Gate: it must beat Rung B on the same backtest harness. Until then, not built.
- **Weather / marketing-spend features (Rung C inputs) = buy when needed.** Weather is the single highest-value external demand signal for HVAC; integrate a weather API only when we reach Rung C (it's a feature, not a launch dependency).
- **Buy, don't build (unchanged):** telephony (Twilio), TTS/ASR (ElevenLabs), geocoding (Photon), payments/financing — all integrated. Build only the spine + the intelligence head + the wedge.

---

## 11. Risks & explicit anti-goals

- **Spreading thin** — still the #1 risk. v3 adds a whole pillar; mitigate by sequencing forecasting as deterministic-first (small, shippable rungs) and keeping everything else scoped to one pilot/vertical.
- **Forecasting before data** — the canonical forecasting trap. Mitigated by the maturity ladder + backtest gate + cold-start badge. We ship deterministic baselines first *precisely because* they need no history.
- **Unexplainable forecasts** — mitigated by keeping numbers deterministic/statistical (not LLM) and adding the LLM explanation pass; the owner can always drill into the underlying series.
- **Blending native + synced revenue** — a money-safety violation; the data model keeps `revenue_daily.basis` separate and forecasts them as distinct streams.
- **Context-layer consistency** — `appendEvent` is best-effort/async; the event log is a projection, not the source of truth (FSM/native tables remain authoritative). Avoids a distributed-consistency rabbit hole.
- **Capacity over-statement** — until `technician_time_off` exists, capacity uses the weekly template; the forecast *says so* rather than silently over-promising.
- **Anti-goals (explicit):** multi-vertical breadth; ServiceTitan-scale marketplace; native mobile; a research-grade ML platform; any forecast we can't backtest; real-time/intraday forecasting (daily granularity is enough for the decisions owners make).

---

## 12. Open questions for the operator (before plans)

1. **Pilot org** — which org do we target, and is `auto_dispatch_enabled` acceptable to flip there?
2. **Migrations** — confirm you'll apply `0021`/`0022` then `ctx-1`/`fc-1`/`fc-2`/`dq-1`/`disp-1`/`disp-2` as we land them (same `npm run db:migrate` flow).
3. **Revenue basis for the headline forecast** — confirm **native payment-date** is the headline revenue stream, with synced shown separately/informationally (per the money-safety split). If the pilot is a FieldPulse/HCP-synced shop with little native revenue, we may need to forecast the synced creation-cohort basis as the headline instead — your call.
4. **Forecast accuracy targets** — agree we set numeric SLOs *after* the first backtest on pilot data (not pre-data), with the standing commitment "never lose to seasonal-naïve."
5. **Outbound consent posture** — confirm consent/quiet-hours defaults are acceptable for proactive outbound (it rides existing `checkSendAllowed`, but proactive outreach is a policy call).
6. **Rung C appetite** — do you want learned models on the roadmap (external service + weather data) once Rung B is the baseline, or is deterministic+statistical forecasting sufficient for the pilot?
7. **Scope confirmation** — agree to the v3 scope (context layer + forecasting + dispatch/outbound for one pilot) and defer multi-vertical/ServiceTitan/mobile?

---

*End of v3 master spec. Next step on approval: per-component `writing-plans` plans, starting with the context layer (Phase 1) and forecasting rollups + Rung A (Phase 2). No implementation begins until this spec is approved and the operator applies the gating migrations.*
