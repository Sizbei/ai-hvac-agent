All sign-off claims are verified against the actual code:
- `holdConcreteSlot`/`pickBookableSlot` exist in submit-session-request.ts; `placeAndAssignRequest` is NOT called there (intake places a window but assigns no tech). Confirmed.
- `triggers.ts` has ZERO consent/quiet-hours/doNotContact gating. Confirmed.
- No `<Dial>` anywhere in voice routes. Confirmed.
- No status-transition log table. Confirmed.
- R2 client is hard-restricted to image/jpeg + image/png by magic bytes. Confirmed.
- `attachments` has sessionId/messageId only, no serviceRequestId/equipmentId. Confirmed.
- conversations/[id] route is GET + DELETE only (no human reply). Confirmed.
- customerSessions has `runningSummary` only, no summary/outcome columns. Confirmed.

Now I have everything grounded. Here is the roadmap.

---

# ServiceTitan-Class Roadmap for an AI-First HVAC Platform
*Lead-architect implementation plan — 10 dependency-ordered stages*

## Strategy

We do not win by cloning ServiceTitan's back office; we win at the **top of the funnel**. Our chat + Twilio voice agent already runs a full deterministic-router + slot-extraction + state-machine intake that resolves repeat customers (blind index), and — verified in `submit-session-request.ts` — `holdConcreteSlot()`/`pickBookableSlot()` already writes a **live-capacity-consuming arrival window**, not a "we'll follow up" note. That is our moat: ServiceTitan needs a human CSR + Dispatch Pro to do what our agent does in one conversation. So the build order is: **(1) close the two real gaps in that moat** (assign a tech during the call; add human `<Dial>` transfer — neither exists today), **(2) ship the cheap AI-native surfaces that compound the existing transcript/agent infra** (call/conversation summaries, staffed two-way inbox), and only **then** build the heavy sales-money spine (pricebook → estimates → invoicing/financing/memberships) — and that spine is **conditional on the org having no connected FSM**, because for FSM-connected orgs native invoicing creates dual-source-of-truth. Two cross-cutting primitives that the research under-scoped are **promoted to a foundational Stage 0-equivalent**: a **consent/quiet-hours enforcement gate** (today `triggers.ts` enforces nothing) and an **outbound-dedupe ledger + status-transition event log** — without these, every outbound-AI stage ships TCPA violations or double-sends, and payroll/reporting have no source data.

A note on naming the stages honestly: the research's "Audit logging" and "consent enforcement" are not standalone features — they are **acceptance criteria attached to every agentic stage**, and the plan treats them that way.

---

## Stage 1 — Compliance & Eventing Foundation
**Goal:** Build the shared safety/eventing primitives every later AI and money stage depends on, so nothing downstream ships a compliance violation or loses auditability.

**ServiceTitan capabilities folded in:** STOP/HELP keyword handling, customer notification consent/quiet-hours, A2P 10DLC readiness, audit/activity trail, recording-consent config.

**Prerequisites:** None. This is the root.

**Scope:**
- **`checkSendAllowed(customerId, channel, triggerType, nowInTz)`** gate module, wired into `triggers.ts` and the `process-communications` cron drain path (currently un-gated). Reads the existing-but-dormant `communicationPreferences` columns (doNotContact, quietHours, per-channel, marketingMessages).
- **Inbound STOP/HELP handler** in `sms/incoming` — a "STOP" today is answered *conversationally by the bot*; this is a live compliance bug. STOP must set doNotContact and suppress, before the AI brain runs.
- **`outboundMessageLedger`** table: unique `(organizationId, customerId, triggerType, periodKey)` — the dedupe primitive for all cron-driven sends (warranty, recovery, renewal). Existing ledgers (`fieldpulseWebhookEvents`/`hcpWebhookEvents`) are *inbound* webhook ledgers and cannot be reused for this.
- **`requestStatusEvents`** table: `(serviceRequestId, fromStatus, toStatus, actorType, actorId, at)` written by `request-status.ts` on every transition. Verified absent today; it is the source data for payroll hours, on-time KPIs, and tech-on-the-way automation.
- **`auditLog.actorType`** column (human|ai|system); every later agentic action logs here.
- **A2P 10DLC** brand/campaign registration kicked off (business gate, runs in parallel — calendar item, not code).

**Data-model changes:** new `outboundMessageLedger`, `requestStatusEvents`; alter `auditLog` (+actorType); no PII in either (per the no-PII-in-details rule).

**AI leverage:** Lets every later AI-initiated send (recovery SMS, renewal nudge, voice booking) be auto-suppressed by consent and auto-audited as `actorType=ai` — turning "autonomous AI" from a liability into an auditable trust feature.

**Risks/unknowns:** quiet-hours needs a reliable customer timezone (we store one, but coverage may be sparse — default to org timezone). 10DLC approval latency is external and can block Stages 4/6 go-live even when code is done.

**Success criteria:** an inbound "STOP" suppresses all channels and is never answered by the bot; a doNotContact customer receives zero sends across all triggers (integration test); re-running any outbound cron twice produces one send; every status change appears in `requestStatusEvents`.

**Effort:** **M**

---

## Stage 2 — Close the AI-Intake Booking Loop (tech assignment + human transfer)
**Goal:** Upgrade the existing voice/chat booking from "arrival window, unassigned" to "arrival window + assigned tech, with a real human-transfer escape hatch."

**ServiceTitan capabilities folded in:** Inbound Call Booking, AI Voice Agent (Contact Center Pro) live booking, warm transfer to a human.

**Prerequisites:** Stage 1 (audit actorType for autonomous bookings).

**Scope:**
- Wire **`placeAndAssignRequest()`** (already exists in `scheduling-queries.ts`, with conflict check + audit) into the submit path. Today `submit-session-request.ts` calls only the **soft** `holdConcreteSlot()` and **never assigns a tech** — verified. Bookings land in the unassigned pile with a window but no tech. Use a **hold-then-confirm-async** pattern: the soft hold confirms the window in-turn; `placeAndAssignRequest` (which runs `checkScheduleConflict`, extra round-trips) runs in `after()` to keep the latency-bound voice turn fast.
- **`<Dial>` warm-transfer** path in `/api/voice/gather` — verified: today an escalated call only emits `sayThenHangupTwiML`/`hangupTwiML` and **hangs up**. Add a dial-to-human leg gated on configured availability; fall back to async escalation when no human answers.
- Lead-source/campaign capture defaulted from the inbound DID; booking-rate KPI (phone sessions → serviceRequest).

**Data-model changes:** `serviceRequests.leadSource`/`campaign` already partly present; add nullable `assignedTo` write from the async path (column exists). `organizationSettings` gets a transfer-target number + hours.

**AI leverage:** This *is* the differentiator. The agent moves from "books a window a human must assign" to "books a fully-dispatched job in one conversation" — the thing ST needs a CSR + Dispatch Pro for.

**Risks/unknowns:** `placeAndAssignRequest`'s conflict check adds latency — async-confirm is **mandatory, not optional**. If async assignment fails (conflict), need a clean fallback to the soft-held window + admin alert. `<Dial>` dead-ends if no human is staffed — gate on real availability.

**Success criteria:** a completed voice booking produces a serviceRequest with both an arrival window **and** an assignedTo; an escalated call connects to a human via `<Dial>` (or cleanly falls back); booking-rate KPI visible in ops-insights.

**Effort:** **L**

---

## Stage 3 — AI Conversation Summaries & Outcomes (cheapest high-value win)
**Goal:** Give managers searchable AI summaries + structured outcomes for every chat AND voice session, beating ST's call-only scope.

**ServiceTitan capabilities folded in:** AI Call & Conversation Summaries, outcome auto-classification, summary email-to-staff.

**Prerequisites:** Stage 1 (no-PII audit rule for any logged summary). Independent of everything else — can run in parallel with Stage 2.

**Scope:** add `summary text`, `outcome enum`, `nextSteps jsonb` to `customerSessions` (verified: only `runningSummary` exists today). On session close/escalation/booking, fire an `after()` economy-tier LLM pass that writes summary + outcome via `db.batch`; reuse `compaction.ts` summarization prompts. Render in the existing Conversations admin. Optional Resend email-to-staff on escalation/booking.

**Data-model changes:** alter `customerSessions` (3 cols). One migration — must run `db:migrate` on deploy (known Vercel gotcha).

**AI leverage:** Pure additive LLM layer over infra we already own (`messages`, `provider.ts`). Uniform over chat+voice because both share `customerSessions`.

**Risks/unknowns:** per-session LLM cost (gate to meaningful sessions, economy tier); summaries may surface PII — label AI-generated, never log to audit details.

**Success criteria:** every closed session has a summary + pinned outcome enum, visible and searchable in admin; escalations email staff within the cron cycle.

**Effort:** **S**

---

## Stage 4 — Two-Way Texting & Staffed Conversation Inbox
**Goal:** Turn the read-only Conversations area into a staffed inbox where humans (AI-assisted) can reply, and seamlessly take over from the bot.

**ServiceTitan capabilities folded in:** Business Texting, unified inbox, AI-to-human handoff, quick replies/templates, inbound MMS.

**Prerequisites:** Stage 1 (consent gate on manual sends — easy to bypass in an agent UI), Stage 3 (summaries help triage the inbox). **Hard external gate: A2P 10DLC.**

**Scope:**
- Verified: `conversations/[id]/route.ts` is **GET + DELETE only**. Add **`POST /api/admin/conversations/[id]/message`** — inserts an agent message, sends via channel adapter (`sendSms`), tenant-scoped, consent-checked, audited.
- **Session `mode` (ai|human)**: when a human takes over, the `sms/incoming` webhook stops auto-replying (checked before the AI brain runs, to win the race).
- Inbox UX: unread/needs-reply filter, assignee, template/quick-reply insertion (reuse `communicationTemplates`).
- Inbound **MMS → attachments** (broaden R2 MIME — see Stage 7).
- AI-assist: draft a suggested reply from the existing sub-agent so CSRs send AI-drafted texts.

**Data-model changes:** `customerSessions.mode` enum; reuse `communicationJobs` for outbound send tracking.

**AI leverage:** Human-in-the-loop applied to our strength — CSRs send AI-drafted replies; the bot handles everything until a human claims the thread.

**Risks/unknowns:** AI-reply vs human-takeover race — the `mode` check must run **before** the AI brain in the inbound webhook. No native websockets on serverless — poll or push-channel for near-real-time. Media = PII + cost.

**Success criteria:** an admin sends a text from the UI that arrives on the customer's phone and is consent-gated; flipping a session to human stops bot auto-replies; STOP still suppresses (Stage 1).

**Effort:** **M**

---

## Stage 5 — Customer & Multi-Location CRM + Equipment Asset Linkage
**Goal:** Introduce the Location entity and per-asset service history so jobs, equipment, and (later) projects hang off a physical site — the structural prerequisite for the rest.

**ServiceTitan capabilities folded in:** Customer-vs-Location split, equipment-as-asset-on-location, per-asset history, duplicate-customer merge, equipment-aging/warranty surfacing.

**Prerequisites:** Stage 1 (status events feed history). Sequence **only when** multi-location or per-asset demand is real — value is *high-as-enabler, low-as-standalone* for SMB-residential buyers. The independent sub-item (`serviceHistory.equipmentId`) can land anytime, early.

**Scope:**
- **`customerLocations`** (customerId FK, addressEncrypted, addressHash blind index, label, zone, lat/lng); nullable `locationId` FK on `serviceRequests` + `customerEquipment`. Ship FK columns **nullable, populate lazily** to avoid a deploy-time gap.
- **`serviceHistory.equipmentId`** FK (independent, do first) → per-asset timeline.
- `customerEquipment.replacedByEquipmentId`/`retiredAt` for replacement chains.
- **Admin merge-duplicates** workflow — AI-extracted noisy contact data *will* accumulate duplicates that blind-index dedupe misses.
- Warranty-expiry cron → consent-gated, dedupe-ledgered (Stage 1) lead-gen comms.

**Data-model changes:** new `customerLocations`; FKs on serviceRequests/customerEquipment/serviceHistory; merge requires careful re-pointing of FKs via `db.batch`.

**AI leverage:** Intake agent already extracts an address — extend extraction to disambiguate *"same address as last time, or a different property?"* conversationally for repeat customers, auto-selecting/creating the location a ST CSR picks manually.

**Risks/unknowns:** **Three** address sources to reconcile, not two — `customers.addressEncrypted`, the new location, **and** the per-request `addressEncrypted` snapshot (verified written in submit-session-request.ts). Backfill touches encrypted PII and must re-derive `addressHash` in a **separate cron/script** (migrations don't run on Vercel deploy). A wrong location-merge corrupts history.

**Success criteria:** one billing customer can hold N locations; a furnace's repair timeline renders from `serviceHistory.equipmentId`; merge tool combines two duplicates without losing history; backfill cron populates locations idempotently.

**Effort:** **L**

---

## Stage 6 — AI Online Booking Recovery + Notifications Two-Way Upgrade
**Goal:** Recover abandoned bookings via outbound AI SMS and make transactional notifications conversational, leaning entirely on shipped infra.

**ServiceTitan capabilities folded in:** Scheduling Pro abandoned-booking SMS recovery, Customer Notifications (reminders, tech-on-the-way, review requests, follow-ups), winback cadence.

**Prerequisites:** Stage 1 (consent + dedupe ledger — non-negotiable here), Stage 4 (inbound human-takeover path), A2P 10DLC.

**Scope:**
- **Abandoned-recovery cron**: find `customerSessions.status='abandoned'` with a captured phone + partial intent (already detected for ai-insights); fire a consent-gated, ledger-deduped Twilio SMS that opens a conversational thread driven by the *same* chat brain.
- **Tech-on-the-way**: wire `requestStatusEvents` (Stage 1) transitions to existing `technician_enroute`/`arrived` triggers; status-only public tracking page (no GPS dependency yet) via a tokenized link.
- **Review funnel done right** — *correction from sign-off*: send the public review request to **everyone**; add a **separate private feedback channel**; **never** branch the public-review ask on predicted sentiment (Google/FTC violation). A no-review nudge follows up once.
- **AI winback**: drive `followUps` + `communicationJobs` off `serviceHistory` + equipment-age signals.

**Data-model changes:** none new — reuses Stage 1 ledger/events + existing comms tables.

**AI leverage:** Outbound recovery reuses extract/triage/slot modules verbatim over SMS — ST markets this as a premium AI add-on; for us it's a cron + existing brain.

**Risks/unknowns:** over-aggressive recovery feels spammy — cap cadence (reuse existing anti-loop caps). Status-only tracking must not over-promise an ETA we can't back.

**Success criteria:** an abandoned session with a phone gets exactly one recovery SMS (ledger-deduped, consent-gated) and can complete the booking over text; every completed job triggers a public review ask to all + a private feedback path.

**Effort:** **M**

---

## Stage 7 — Technician Mobile Workflow + Secure Media
**Goal:** Ship a thin technician PWA for status/photos/signatures/notes, and add the missing secure-media plumbing.

**ServiceTitan capabilities folded in:** Field Mobile App (en-route/on-site status, photos, e-signature, on-site forms), GPS pings (optional).

**Prerequisites:** Stage 1 (status events), Stage 5 (link photos to location/equipment). **Storage is NOT net-new** — *correction from sign-off*: `r2-client.ts` + `/api/upload` + `attachments` exist; remaining work is small and runs in parallel.

**Scope:**
- `/tech` route group (existing JWT technician role): "my jobs today" from `serviceRequests where assignedTo=me`; status buttons writing the status enum + emitting `requestStatusEvents` + firing customer comms.
- **Broaden R2 MIME** beyond image/jpeg+png (verified magic-byte-gated) to add HEIC/PDF/audio; add **`attachments.serviceRequestId`/`equipmentId` FKs** (verified missing — only sessionId/messageId today).
- **Signed/expiring read-URL** serving path — genuinely absent today and required for PII access control on photos/recordings.
- E-signature via canvas → stored image; on-site forms built **on top of `customFieldDefinitions/Values`**, not a new engine.

**Data-model changes:** alter `attachments` (+FKs); new MIME signatures in r2-client.

**AI leverage:** Voice/chat **note dictation** routed through the extraction layer into `serviceHistory`/equipment, plus an auto-drafted post-visit customer summary — the adoption wedge (less typing) and a real differentiator vs phone-typing field apps.

**Risks/unknowns:** field connectivity needs optimistic UI + retry queue on a stateless backend. A half-built app techs won't adopt is worse than none — dictation is the wedge. Stay short of on-site payments (we don't have them).

**Success criteria:** a tech advances a job through statuses (each logged to `requestStatusEvents`, each firing the right customer SMS) and uploads a photo linked to the serviceRequest, served via a signed expiring URL.

**Effort:** **L**

---

## Stage 8 — Pricebook (sales-money spine root)
**Goal:** Build the priced catalog that estimates, invoicing, financing, and memberships all draw from.

**ServiceTitan capabilities folded in:** Flat-rate Pricebook (services/materials/equipment + category tree), member/non-member pricing, **tax-rate model**, basic dynamic pricing.

**Prerequisites:** None hard (data root). **Decision gate before building:** document revenue source-of-truth — for FSM-connected orgs, prefer mirroring; build native only where a validated segment has no FSM. *This decision is currently unmade and must precede Stages 8–10.*

**Scope:**
- `pricebookCategories` (self-referential tree), `pricebookItems` (type service|material|equipment; **cost_cents, markup_pct, member_price_cents, price_cents**, hours, sku, warranty, active), `pricebookItemMaterials` link table.
- **`taxRates`** table (jurisdiction, rate, taxable flag) — *gap from sign-off*: invoicing is not credible without it; it's a silent dependency of the whole cluster, so it lands here.
- `/admin/pricebook` CRUD. Seed a small HVAC starter catalog (empty pricebook = dead AI-pricing differentiator).
- Money as integer cents everywhere (matches `serviceHistory.cost`).

**Data-model changes:** all new tables, org-scoped, `db.batch` writes.

**AI leverage:** Feed the catalog to chat/voice so the agent gives **non-binding ballpark ranges** during intake and pre-attaches likely line items from extracted symptom + system type — intake becomes a priced lead.

**Risks/unknowns:** catalog data-entry is a heavy onboarding burden — ship seed content or import. AI quoting a number is a liability — frame as non-binding with guardrails.

**Success criteria:** an org has a browsable priced catalog with member/non-member + tax; the intake agent can quote a guardrailed range for a common repair.

**Effort:** **L**

---

## Stage 9 — Estimates / Proposals + Native Invoicing & Payments + Financing
**Goal:** Turn priced line items into signable good-better-best estimates and (for non-FSM orgs) native invoices/payments with point-of-sale financing.

**ServiceTitan capabilities folded in:** Estimates/Proposals (good-better-best, e-sign, conversion KPI), Invoicing & Payments (deposits, card/ACH, **refunds/credits/adjustments**), GreenSky/Wisetack financing (standalone, not on the invoice).

**Prerequisites:** Stage 8 (pricebook + tax). Native invoicing/payments is **conditional** on the source-of-truth decision; financing needs a lender partner contract (business gate).

**Scope:**
- `estimates` (status open|sold|dismissed|expired, expiresAt, signedAt, signatureName/IP, totalCents), `estimateOptions` (tiers), `estimateLineItems` (**snapshot** of pricebook item at quote time — critical so later catalog edits don't mutate sent quotes). Tokenized public approval page (reuse widgetKeys/staffInvites signed-token pattern); typed-name e-sign + IP/timestamp.
- **Native invoicing path (path B, conditional):** `invoices`, `invoiceLineItems` (snapshot from sold estimate), `payments` (Stripe PaymentIntents), plus **`refunds`/`creditMemos`** — *gap from sign-off*: refunds/chargebacks are the first thing that breaks a half-built payments path, so they're in scope, not deferred. Deposits = PaymentIntent for a % of a signed estimate.
- **Financing** as a thin hand-off: `financingApplications` (provider, providerAppId, status, approvedAmountCents) updated via lender webhook → Stage 1 ledger pattern. Lender owns underwriting.

**Data-model changes:** estimates/invoices/payments/refunds/financingApplications; Stripe secret encrypted per-org (reuse `apiKeyEncrypted` pattern).

**AI leverage:** The agent generates good-better-best **conversationally** during intake from pricebook + extracted equipment-age/down-status (repair-vs-replace signals we already capture), the customer approves **inside the chat thread**, and at sticker-shock the agent offers *"~$Y/month — here's a link to see if you prequalify"* (link only; no APR/Reg-Z terms until the lender API returns them). This collapses ST's tech-builds-then-emails loop into one conversation — our strongest wedge.

**Risks/unknowns:** typed-name e-sign must capture consent+timestamp+IP to be enforceable. **Line-item snapshotting is mandatory** — referencing live pricebook rows silently mutates signed quotes. AI good-better-best can recommend unsafe options (repair on a failed heat exchanger) — human-review gate on high-dollar tiers. Native payments invokes PCI/refunds/tax — only for no-FSM orgs; dual-source-of-truth otherwise.

**Success criteria:** an estimate with 3 tiers is approved + e-signed on a tokenized page, flipping to sold with a conversion KPI; (non-FSM) a sold estimate generates an invoice, takes a Stripe deposit, and processes a refund; a financing link is sent and its status mirrors back via webhook.

**Effort:** **XL**

---

## Stage 10 — Memberships, Reporting/Scorecards & Job Costing
**Goal:** Monetize recurring revenue and give owners trustworthy profit-per-job metrics — the capstone that depends on everything above.

**ServiceTitan capabilities folded in:** Memberships/Service Agreements (types, recurrences, auto-renew-creates-new-record, recurring billing), Reporting/KPIs/technician scorecards, **job costing/gross-margin** (*flagged-missing in sign-off — added here*), reporting snapshots.

**Prerequisites:** Stage 8 (pricebook for benefits/discounts), Stage 9 (payments for recurring billing + revenue source), Stage 5 (equipment/location for visit entitlements), Stage 1 (consent on renewal nudges + status events for labor hours).

**Scope:**
- **Memberships Phase A** (entitlements, no billing): `membershipTypes` (term, priceCents, cadence, benefits jsonb, visitsPerYear), `customerMemberships` (status, startsAt/endsAt, autoRenew, linked equipment/location). Migrate flat `customers.membershipStatus` enum to a derived view + denormalized cache. **Phase B** (AI sales/renewal): conversational post-repair upsell + renewal/winback via Stage 6 cadence, **ledger-deduped visit generation** into the scheduling queue. **Phase C** (billing): Stripe Subscriptions + dunning, mirror status onto `customerMemberships`. Auto-renew **creates a new record** (ST mechanic), not an extension.
- **`reportingSnapshots`** cron table — the single shared time-series layer the research re-derived three times (trends, anomaly detection, marketing ROI).
- **Technician scorecards** (`getTechnicianScorecards`): completed jobs, avg ticket, close rate (from estimates), on-time (from `requestStatusEvents`), callbacks, rating.
- **Job costing**: gross margin per job = revenue − (material cost from pricebook lines + labor cost from `requestStatusEvents`-derived hours × rate). Without it, scorecards and marketing ROI are revenue-only and mislead owners.
- **Marketing attribution** (campaigns + per-DID tracking + spend) rolling up against job-costed revenue.

**Data-model changes:** membershipTypes/customerMemberships/membershipVisits, reportingSnapshots, marketing_campaigns/campaign_spend; scorecards/costing are queries over existing + snapshot tables.

**AI leverage:** "Ask your data" NL endpoint over a **whitelisted, tenant-scoped** parameterized-query set + narrative phrasing; conversational membership upsell at the post-repair moment; agent auto-books entitled maintenance visits.

**Risks/unknowns:** recurring billing is PCI/dunning/refund-heavy — gate behind Stage 9's real Stripe integration; half-built is worse than none. Visit-recurrence must be idempotent (Stage 1 ledger) or it floods dispatch. Scorecards/costing are garbage-in unless `serviceHistory.cost` + completion are consistently captured (Stage 7 helps). NL-query endpoint must be sandboxed or it leaks cross-org data.

**Success criteria:** a membership sells, generates entitled visits idempotently, and (Phase C) self-bills via Stripe with dunning; an owner sees per-tech scorecards and per-job gross margin backed by snapshot trends; auto-renew creates a new linked record before expiry.

**Effort:** **XL**

---

## Dependency Graph (text)

```
Stage 1 (Compliance + Eventing)  ──┬─────────────────────────────────────────────┐
   │  (consent gate, dedupe ledger, status-events, audit actorType)               │
   ├──> Stage 2 (Close booking loop: tech-assign + <Dial>)                        │
   ├──> Stage 3 (AI summaries)   ── parallel with Stage 2                         │
   ├──> Stage 4 (Two-way inbox) ──< needs Stage 3 + A2P 10DLC                     │
   │        │                                                                     │
   ├──> Stage 5 (Multi-location CRM + equipment linkage)                          │
   │        │                                                                     │
   ├──> Stage 6 (Booking recovery + notifications) ──< Stage 4 + 10DLC            │
   │        │                                                                     │
   └──> Stage 7 (Tech mobile + secure media) ──< Stage 5 (link to loc/equip)      │
                                                                                  │
Stage 8 (Pricebook + tax)  [GATE: revenue source-of-truth decision] ─────────────┘
   └──> Stage 9 (Estimates → Invoicing/Payments/Refunds → Financing)  ──< Stage 8
            └──> Stage 10 (Memberships + Reporting/Scorecards + Job costing)
                          ──< Stage 8, 9, 5, 1
```
Cross-cutting (acceptance criteria on every agentic stage, not standalone stages): **audit `actorType=ai`** and **consent enforcement** — both delivered in Stage 1, enforced everywhere after.

---

## 3 Highest-Leverage Early Wins
1. **Stage 2 — assign a tech + add `<Dial>` during the call.** The product's core moat already books a live-capacity-consuming window (verified); the *only* real gaps are tech assignment (`placeAndAssignRequest` is never called) and human transfer (no `<Dial>`; calls hang up). Small, high-impact, sells the differentiator the deck was understating.
2. **Stage 3 — AI conversation summaries (S).** Cheapest item in the whole plan; pure additive columns + one `after()` LLM call over infra we already own; covers chat **and** voice (beats ST's call-only).
3. **Stage 1's consent gate + STOP handler.** Not glamorous, but every later outbound-AI stage is a TCPA violation without it (`triggers.ts` enforces nothing today; an inbound STOP is currently answered by the bot). It unblocks Stages 4, 6, 10 and converts "autonomous AI" into an auditable trust feature.

---

## Explicitly Deferred ServiceTitan Areas (honest scope)
- **Appointment/multi-visit split** — XL-in-disguise. Verified: FieldPulse/HCP sync maps **one serviceRequest → one external job id** via a guarded `isNull(fieldpulseJobId)` write. A `jobAppointments` child table breaks that one-to-one and requires migrating live integration state to a per-appointment external id. Defer until multi-visit demand is proven, and only with a parallel sync-key redesign.
- **Dispatch Pro (ML auto-dispatch / route optimization)** — XL, low SMB ROI (1–3 trucks). Customer-facing route-steering needs real-time tech GPS we don't collect; it's gated behind Stage 7 GPS, not a cheap early win. Heuristic assist-mode only, if ever.
- **Inventory & purchasing** — XL, weakest fit for an AI-CS product; FSM (FieldPulse/HCP) already owns it. Prefer reading truck stock from the FSM over a native two-cycle engine.
- **Payroll/timesheets/commissions** — now *unblocked* by Stage 1's `requestStatusEvents` (the missing prerequisite), but still low-differentiation, compliance-heavy back office. Defer; export to ADP/Gusto rather than be system-of-record.
- **Multi-BU permissions / Enterprise Hub** — YAGNI for single-location SMB; pervasive change to `withTenant` with cross-BU data-leak risk. Business Units ship as a simple optional reporting column (folded into later reporting), not the full ACP/BU-group/permission matrix.
- **Public API + outbound webhooks / Integration Marketplace** — long-term security/versioning/support commitment; build only on real partner demand. Premature connector abstraction = wrong abstraction. Refactor existing integrations behind a common interface only when a 3rd/4th integration confirms the shape.
- **Cloud PBX / call recording** — partially folded into Stage 2 (`<Dial>`) and Stage 7 (audio MIME + signed URLs); the full PBX (DID provisioning UI, hold queues, voicemail, telephony-STT of human legs) is deferred. Note: a Twilio recording webhook needs its **own** `twilioCallEvents` ledger — the existing FSM ledgers are not a generic primitive.