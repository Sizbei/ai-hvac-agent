# Probook-Parity Build — Design Spec (v2)

**Date:** 2026-06-24
**Status:** design — awaiting review → implementation plans (one per component)
**Supersedes (sharpens):** `docs/superpowers/plans/2026-06-24-probook-competitive-analysis-and-plan.md` (the competitive teardown). That doc answered *why ~100 engineers / what they do*. **This** is the buildable design for *what we ship* — more opinionated, with architecture, data model, and interfaces.

---

## 0. What's different / better in v2

The v1 plan followed Probook's marketing and treated **dispatch** as the wedge, phasing dispatch-intelligence *before* the context layer. That's backwards. Re-reading the primary sources, Probook's actual, repeated claim is **"one customer, one text thread, one context, from first touch through the job — every booking cleaned before it's assigned."** The **unified context layer is the moat**; dispatch, messaging, data-scrubbing, and outbound are all *consumers* of it.

So v2's three improvements:
1. **Build the context layer as the spine first.** It's what makes dispatch smart (full history pre-assign), messaging coherent (one thread), and outbound targeted (one history). Everything else hangs off it.
2. **Be ruthlessly scoped.** One vertical (HVAC), one pilot org, the triad **context layer → dispatch intelligence → outbound**. Explicitly defer ML forecasting, ServiceTitan, and breadth. We are not 100 engineers; we win by depth on the spine.
3. **Concrete, reuse-first design** — data model, interfaces, file paths, all extending existing code, so each component becomes a `writing-plans` plan directly.

---

## 1. Goal

Make a pilot HVAC org run **intake → cleaned booking → best-tech dispatch → outbound follow-up** as **one connected system on a single per-customer context**, with the AI handling the majority of bookings end-to-end and a human only handling exceptions — Probook's outcome, on our stack.

**Success criteria (measurable):**
- A pilot org books classified jobs with **zero human dispatch** (we already auto-assign; this makes it *smart* + *trusted*).
- Every channel (voice, SMS, web) reads/writes **one customer thread**; no re-asking known facts.
- Dispatch assigns on **skill + conversion + load + proximity**, with an **explainable reason** a dispatcher trusts/overrides.
- Outbound **closes unsold estimates** and **fills open capacity** with attributable bookings.

**Non-goals (v2):** ML revenue-forecasting platform; ServiceTitan; a native mobile app; multi-vertical. (All tracked, deliberately later.)

---

## 2. Architecture

```
                ┌──────────────────────── CONTEXT LAYER (the spine) ────────────────────────┐
                │  customer_threads (1 per resolved customer)                                │
   voice ──┐    │  customer_events  (append-only: call|sms|web|booking|status|outbound|note) │
   sms   ──┼──▶ │  identity resolution (blind-index, existing) + dedup/merge                 │
   web   ──┘    │  read API: getThread(customerId) → {profile, history, openItems}           │
                └───────────▲───────────────▲───────────────▲───────────────▲────────────────┘
                            │               │               │               │
                     ┌──────┴─────┐  ┌───────┴──────┐ ┌──────┴──────┐ ┌──────┴──────────┐
                     │  Intake AI │  │   Dispatch    │ │ Data-Quality │ │    Outbound      │
                     │ (voice+chat│  │ Intelligence  │ │  pre-assign  │ │     Engine       │
                     │  — have)   │  │  (extend score│ │     gate     │ │ (unsold/fill)    │
                     └────────────┘  └───────────────┘ └──────────────┘ └─────────────────┘
                            │               │               │               │
                            └───────────────┴──────┬────────┴───────────────┘
                                                    ▼
                              FSM mirrors (FieldPulse / HCP — have)  +  comms queue (have)
```

Every component **emits to** and **reads from** the context layer. The layer is the single source of "what do we know about this customer right now."

---

## 3. Component specs

### 3.1 Context Layer (NEW — the spine)

**Responsibility:** one canonical, real-time record per resolved customer, with the full cross-channel interaction history, that every other component reads/writes.

**Data model (2 new tables + reuse identity):**
```
customer_threads
  id uuid pk
  organizationId uuid (withTenant)
  customerId uuid → customers.id        -- the resolved identity (reuse blind-index resolution)
  lastChannel text                       -- 'voice'|'sms'|'web'
  lastEventAt timestamptz
  openEstimateCount int                  -- denormalized for fast "open items"
  status text                            -- 'active'|'dormant'
  createdAt/updatedAt
  UNIQUE(organizationId, customerId)

customer_events                          -- append-only event stream
  id uuid pk
  organizationId uuid (withTenant)
  customerId uuid
  threadId uuid → customer_threads.id
  kind text       -- 'call'|'sms_in'|'sms_out'|'web_msg'|'booking'|'status_change'|'outbound'|'note'
  refId uuid      -- serviceRequestId / messageId / estimateId, by kind (nullable)
  summary text    -- PII-free one-liner (e.g. "Booked no_cool, Tue PM") — NEVER raw PII
  at timestamptz
  index(organizationId, customerId, at)
```
**Interfaces (`src/lib/context/thread.ts`, NEW):**
```ts
resolveThread(orgId, contact|customerId): Promise<{ threadId, customerId } | null>  // reuse findCustomerIdByContact
appendEvent(orgId, customerId, evt: { kind; refId?; summary }): Promise<void>       // best-effort, like recordStatusEvent
getThread(orgId, customerId): Promise<CustomerThread>  // profile + recent events + open estimates/jobs + service history
```
**Key decisions:**
- **Reuse, don't rebuild, identity.** `customers` + the HMAC blind-index (`upsertCustomerByContact`, `findCustomerIdByContact`) is already our identity spine — `customer_threads` just hangs a thread/event-log off it.
- **PII discipline:** `customer_events.summary` holds field names / enums / a non-PII one-liner only (mirrors `audit_log` discipline). Raw content stays in `messages`/`request_notes`, referenced by `refId`.
- **`appendEvent` is best-effort** (try/catch, never throws into the request path) — same contract as `recordStatusEvent`.
- **Migration:** 2 additive tables; author via `drizzle-kit generate`, operator applies (consistent with `0021`/`0022`).

**Wiring (existing emitters):** voice-turn, chat route, `submit-session-request`, status transitions, comms sends each call `appendEvent`. The intake agents call `getThread` at session start so a returning customer is recognized on **any** channel (we already do per-channel context; this unifies it).

### 3.2 Dispatch Intelligence (EXTEND — `src/lib/ai/dispatch/`)

**Responsibility:** assign on **skill + conversion + load + proximity**, explainable, gated by org opt-in (existing `auto_dispatch_enabled`).

**Extend `signals.ts`** — add per-tech, read from EXISTING tables (no migration for the signals):
```ts
conversionRate: number   // sold estimates / assigned jobs (estimates.soldOptionId + serviceRequests.assignedTo)
avgJobRevenueCents: number  // invoices.totalCents on the tech's completed jobs (reuse getTechnicianScorecards shape)
```
**Extend `score.ts`** (pure, unit-tested) — re-weight to add a **conversion** term and (later) **proximity**:
```
score = skillDepth*0.40 + quality*0.20 + conversion*0.25 + load*0.15   // weights are tunable constants
```
**Proximity (needs migration):** add `users.baseLat/baseLng` (+ geocode on save — we already geocode addresses); add a distance term once tech locations exist. Separate migration/slice.

**Key decisions:**
- **Weights are explicitly provisional** and must be **tuned against live pilot data after deployment** — do NOT hand-tune as gospel pre-launch. Ship deterministic + explainable; the `reasons[]` already exist and are the trust mechanism.
- **Exceptions queue:** the dispatch board's "Unassigned" column *is* the queue. Add the **top-3 scored suggestions + one-click assign** to the request detail sheet (read-only suggestion; human commits).
- **Real-time availability (PTO/live-load):** a `technician_time_off` table folded into the conflict gate (separate migration/slice).

### 3.3 Data-Quality Pre-Assign Gate (NEW — small)

**Responsibility:** "clean every booking before it hits the board." A pre-dispatch gate run inside the existing intake `after()`:
```ts
assessBookingQuality(orgId, requestId): { ok: boolean; issues: string[]; enriched?: {...} }
```
- Address validate (have: `address-validation.ts`), dedup (have: blind-index), pull equipment/warranty + prior-job history (have: FSM mirrors), completeness score.
- **On low quality → route to the exceptions queue (flag), not auto-assign.** Emits a `note` event to the context layer.
**Decision:** this is mostly *composition* of existing checks into one pre-assign gate + a `quality_flag` on the request (1 nullable column).

### 3.4 Outbound Engine (EXTEND — `src/lib/communication/`)

**Responsibility:** proactive, attributable revenue — **close unsold estimates** + **fill open capacity** — on consent/quiet-hours rails we already have.

**Two campaigns (v2), both cron-driven (`after()`/Vercel cron, like existing comms):**
1. **Unsold-estimate follow-up:** find `estimates` open > N days with no sold option → enqueue a consent-gated nudge (reuse `queueCommunicationJob` + a new `estimate_followup` trigger/template) → record an `outbound` event; attribute a booking if one follows within a window.
2. **Fill-the-board:** when a near-future day has open capacity (we have availability + scheduled load), select maintenance-due / recurring customers (we have membership visit generation) → enqueue a consent-gated offer.

**Data model:** reuse `outbound_message_ledger` (dedupe) + `communication_jobs`. Add `outbound_campaigns` only if needed for attribution (start with the event log + ledger; add a table only when attribution demands it).
**Decision:** outbound rides entirely on existing comms + consent + ledger infra — the new part is the *selection logic* (who/when) + attribution, not the sending.

### 3.5 Staffed Inbox (EXTEND — for the 10% the AI hands off)

**Responsibility:** a human picks up the threads the AI escalates. We have the reply endpoint + `mode='human'` flip; this adds the **mode-aware thread-list + thread-view UI** in admin, reading the context layer.

---

## 4. Data model summary (migrations)

| Migration | Adds | For |
|---|---|---|
| ctx-1 | `customer_threads`, `customer_events` (2 tables) | Context layer (3.1) |
| disp-1 | `users.baseLat/baseLng` | Proximity scoring (3.2) |
| disp-2 | `technician_time_off` | Real-time availability (3.2) |
| dq-1 | `service_requests.quality_flag` (1 col) | Data-quality gate (3.3) |
| (signals/outbound need **no** migration — read existing tables) | — | 3.2 conversion, 3.4 |

All additive; authored via `drizzle-kit generate`; **operator applies** (`npm run db:migrate`) — same convention as the pending `0021`/`0022`.

---

## 5. Build sequence (each phase → its own `writing-plans` plan)

| Phase | Component | New migration? | Reuses | Gate |
|---|---|---|---|---|
| **0** | *Make dispatch v1 live* (apply `0021`/`0022`, pilot org, roster sync button) | applies existing | dispatch v1, roster sync | pilot books w/ zero human dispatch |
| **1** | **Context layer** (3.1) — tables, `thread.ts`, wire emitters + intake readers | ctx-1 | identity, status-events | one thread per customer across channels |
| **2** | **Dispatch conversion scoring** (3.2, signals+score) — tune on pilot data | none | score.ts/signals.ts | scored assignments improve close rate |
| **3** | **Exceptions queue UI** + top-3 suggestions | none | dispatch board | dispatcher trusts/overrides |
| **4** | **Outbound: unsold estimates** (3.4.1) | none | comms, estimates, ledger | attributable re-bookings |
| **5** | **Data-quality gate** (3.3) | dq-1 | address/dedup/FSM | bad bookings flagged pre-assign |
| **6** | **Outbound: fill-the-board** (3.4.2) | none | availability, membership | open slots filled |
| **7** | **Proximity + PTO** (3.2) | disp-1, disp-2 | score.ts, conflict gate | route-aware, PTO-aware |
| **8** | **Staffed inbox UI** (3.5) | none | reply endpoint, context layer | humans handle the 10% |

**Phases 2/3/4/6/8 need no new migration** — they extend existing code/tables. Phase 0 is the operator's unlock; everything compounds on the context layer (Phase 1).

---

## 6. Risks, build-vs-buy, what NOT to build

- **Spreading thin** — the #1 risk. v2 is deliberately the spine + dispatch + outbound for ONE vertical/pilot. Resist breadth.
- **Tuning scores pre-data** — do NOT treat weights as final before pilot data (Phase 2 explicitly tunes on live outcomes).
- **Context-layer consistency** — `appendEvent` is best-effort and async; the event log is a *projection*, not the source of truth (the FSM/our tables remain authoritative for money/jobs). This avoids a distributed-consistency rabbit hole.
- **Buy, don't build:** telephony (Twilio), TTS/ASR (ElevenLabs), geocoding (Photon), payments/financing — all already integrated. Build only the spine + the wedge.
- **Defer:** ML forecasting/conversion models (start with deterministic aggregates), ServiceTitan (use our FP/HCP integration platform as the template when an enterprise deal needs it), native mobile.

## 7. Open questions for the operator (before plans)

1. **Pilot org** — which org do we target, and is `auto_dispatch_enabled` acceptable to flip there?
2. **Migrations** — confirm you'll apply `ctx-1`/`disp-1`/`disp-2`/`dq-1` as we land them (same flow as `0021`/`0022`).
3. **Outbound consent posture** — confirm the consent/quiet-hours defaults are acceptable for proactive outbound (it rides our existing `checkSendAllowed`, but proactive outreach is a policy call).
4. **Scope check** — agree to defer forecasting/ServiceTitan/mobile to keep the spine deep?
