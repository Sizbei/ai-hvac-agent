# Avoca-Parity — AI Call-Center 20-Stage Program

**Date:** 2026-06-24
**Status:** roadmap (program-level) — each stage becomes its own brainstorm → spec → `writing-plans` cycle before implementation.
**Goal:** Replicate Avoca AI's value for HVAC/home-services call centers on our stack — **AI voice intake (have) + automated 100%-call QA + CSR live copilot + coaching analytics + missed/unbooked-call recovery + training simulation** — reusing what already exists and adding the human-CSR-facing layer that is the real gap.

> Grounded in a full read of the voice/telephony + analytics/CSR surfaces (see "Reuse foundation" and "Gaps" below). Every stage names the concrete files/tables it builds on. This is a *program* roadmap; nothing here is implemented yet, and several stages are **compliance- or operator-gated** (call recording, outbound, migrations).

---

## 0. What Avoca is, and our angle

**Avoca AI** sells home-services contractors an AI call-center layer: (1) an **AI voice agent** that answers/books inbound calls 24/7; (2) a **CSR Copilot** that assists *human* reps live (transcription, suggested replies, objection handling, script adherence); (3) **automated QA** that scores 100% of calls on a rubric and surfaces coaching; (4) **coaching analytics** per rep; (5) **missed-call / unbooked-lead recovery**; (6) **training simulation** (AI roleplay). Their wedge is serving the *human* call center, not just full automation.

**Our angle:** we are already AI-first (a working voice agent + chat + dispatch + comms + FSM mirrors). So we get pillar (1) largely for free and differentiate by closing the loop: the *same* AI that handles calls also **scores** every call (human or AI), **coaches** the reps, and **recovers** the misses — one connected system, not bolted-on point tools.

## 1. Reuse foundation (what already exists — build on these)

- **Voice agent:** `src/app/api/voice/{incoming,gather,tts}/route.ts` + `src/lib/ai/voice-turn.ts` (shared turn engine), ElevenLabs/Polly TTS (`src/lib/voice/twiml.ts`, `elevenlabs.ts`), Twilio-signature-verified webhooks, warm transfer (`dialThenHangupTwiML` + `organization_settings.voiceTransferNumber`).
- **Transcript + telemetry:** `messages` (full caller+assistant transcript per call), `bot_events` (per-turn `routed/intent/action/latencyMs`, PII-free), `customer_sessions` (`channel='phone'`, `token=CallSid`, `mode='ai'|'human'`, `outcome` 5-way), `session-outcome.ts` (summary/classify pass).
- **The LLM judge (the QA engine, already written):** `src/lib/ai/eval/judge.ts` — `judgeTranscript()` → `JudgeScores {naturalness, helpfulness, completion, pricingLeak, falseBooking, rationale}`, degrade-safe, OpenAI-compatible. Today it runs **only offline on `GoldenTranscript` fixtures** and is **never persisted**. Plus `behavior-probe.ts` (binary checks: pitched/deferred/guessedSpec) and `output-guardrail.ts` detectors (price/false-booking/dangerous-DIY) — reusable as deterministic QA flags.
- **CSR-adjacent:** conversations inbox (read-only) `src/components/admin/conversations/*`; an **orphaned reply endpoint** `src/app/api/admin/conversations/[id]/message/route.ts` (flips `mode='human'`, SMS-only, consent-gated) with **no UI composer wired**.
- **Recovery + comms:** `booking-recovery.ts` (abandoned chat/SMS/web), `communication_jobs` queue + `checkSendAllowed` (consent/quiet-hours) + `claimOutboundOnce` (ledger dedup) + templates.
- **Scripts/knowledge:** 106-entry `knowledge-base.ts` (`cannedResponse` = the copilot's scripts), intent router, `hvac-knowledge.ts`. **Reviews:** `review_requests` (1–5 + private feedback). **Scorecards:** `getTechnicianScorecards` (tech field-jobs only).

## 2. Gaps Avoca fills that we lack (what the 20 stages add)

- **Call-data foundation:** no call-detail table (duration/disposition/ANI/missed), **no call recording**, no missed-call detection.
- **Automated QA:** judge never runs on real calls; no scores table; no per-org rubric; no CSR attribution.
- **CSR copilot:** no live suggested-reply surface; reply UI un-wired; voice ignores `mode='human'` (no live takeover).
- **Coaching:** no per-agent (CSR *or* AI) call scorecard / QA trend.
- **Recovery:** no missed/unbooked **phone-call** recovery (only chat/SMS abandonment).
- **Org model:** no `csr`/`agent` role.

## 3. Cross-cutting invariants & compliance (apply to EVERY stage)

- **Recording = legal/compliance-gated.** Two-party-consent states require disclosure + consent before recording; recordings are PII. Recording is **off by default, per-org opt-in, with a spoken disclosure** (reuse the after-hours-disclosure pattern) and a **retention policy**. Treat as the single highest-risk stage.
- **PII:** transcripts/recordings/scores hold customer speech → encrypt at rest, scope by org, honor GDPR erasure (`anonymizedAt`), keep `bot_events`-style telemetry PII-free.
- **Preserve existing invariants:** frozen-safety-text, money-safety, the financial-verify gate, output guardrail, neon-http (no transactions / `db.batch` / `after()` not detached promises). Migrations authored via `db:generate`, **operator applies**.
- **Outbound is consent-gated + operator-enabled** (crons ship unscheduled), per the established outbound discipline.

---

## Phase A — Call-data foundation (QA needs data) — Stages 1–4

### Stage 1 — `call_records` table + populate from the voice webhook **[H, foundational]**
A per-call record (`callSid`, `organizationId`, `customerId`, `fromAni` (encrypted), `direction`, `startedAt`, `sessionId` link, `handlerUserId` nullable). Populate at `voice/incoming`. **Migration.** Today `CallSid` survives only as `customer_sessions.token` and ANI is never persisted — this is the spine every later stage joins on.

### Stage 2 — Twilio call-status callbacks → disposition + missed-call detection **[H]**
Add `statusCallback` (ring/answered/completed/no-answer/busy/canceled) to the call; a new `voice/status` route writes `disposition` + `durationSec` + `endedAt` onto `call_records`. **Unlocks missed-call detection** (no-answer/busy/abandoned-before-answer) — the input to Stage 17 recovery. Config + 1 route + columns (migration-light).

### Stage 3 — Call recording (opt-in, consent-gated) **[M, COMPLIANCE — highest risk]**
Per-org opt-in `<Record recordingStatusCallback>`; store `recordingUrl`/`recordingSid` (R2, encrypted) on `call_records`; **spoken two-party-consent disclosure** before recording; retention/erasure policy. **Gated on operator + legal sign-off.** Required for human-call QA audio review; AI-call QA can run on transcripts without it (so this is *not* a blocker for Phase B).

### Stage 4 — Canonical call-transcript API **[M]**
`getCallTranscript(orgId, callSid)` reconstructing the ordered caller+assistant transcript from `messages` (already stored) — the clean input both the QA judge (Phase B) and the copilot (Phase C) consume. Pure-ish read; no migration.

## Phase B — Automated 100%-call QA (the Avoca core) — Stages 5–9

### Stage 5 — `call_scores` schema **[H]**
Persist scores: `conversationId/callSid`, rubric dimensions (naturalness/helpfulness/completion 1–5), boolean flags (pricingLeak/falseBooking/greetingGiven/bookingAttempted/disclosureGiven), `rationale`, `model`, `scoredAt`, `handlerUserId`, `source` ('ai'|'human'). **Migration.** No score persistence exists today.

### Stage 6 — Run the existing judge on REAL transcripts **[H, highest-leverage]**
An `after()`/cron job that feeds completed calls' transcripts (Stage 4) into the **already-written** `judgeTranscript` (`eval/judge.ts`) and persists `JudgeScores` to `call_scores`. This is the single biggest leverage point — the QA engine exists; it just needs real input + a sink. Degrade-safe (no API key → skip). Reuse the `bot_events` best-effort pattern.

### Stage 7 — Per-org configurable QA rubric **[M]**
Move the hardcoded `JUDGE_SYSTEM` rubric into a per-org config (dimensions + weights + checklist items, e.g. "must offer a booking", "must confirm address"). **Migration** (rubric table or `organization_settings` jsonb). Lets each shop define "a good call."

### Stage 8 — Deterministic QA flags (cheap, no-LLM) **[M]**
Reuse `output-guardrail.ts` detectors + `behavior-probe.ts` binary checks over the transcript: greeting given? booking attempted? price quoted? compliance disclosure present? These are free, fast, and complement the LLM judge (and catch judge drift). Pure functions + tests.

### Stage 9 — QA dashboard **[M]**
Score distribution, flagged calls, pass-rate trend, worst/best calls — extend the insights page (`bot-analytics-section.tsx` pattern). Read-only; no migration.

## Phase C — CSR enablement (the human side) — Stages 10–13

### Stage 10 — `csr`/`agent` role + call attribution **[H, foundational for coaching]**
Add a `csr` role (users enum + authz policy + invite allowance) and attribute conversations/calls to a `handlerUserId`. **Migration.** Today only `super_admin|admin|technician` exist and a human reply is just "any admin" — coaching (Phase D) needs per-agent identity.

### Stage 11 — Wire the orphaned reply UI (chat/SMS takeover) **[M, quick win]**
Add a composer to `conversation-detail-content.tsx` calling the **existing** `/message` endpoint + live polling. The backend (mode-flip, consent, SMS send) already works — this is the un-wired front half. Real CSR takeover for chat/SMS.

### Stage 12 — Voice live-takeover (scoped) **[M]**
Enforce `mode='human'` in the `gather` route (the bot currently ignores it on voice) + a **warm-transfer-to-a-specific-CSR** action from the conversation view. True live barge/whisper needs Twilio Media Streams (a realtime websocket layer) — **explicitly deferred** as its own large sub-project; this stage delivers "stop the bot + route this caller to me."

### Stage 13 — CSR copilot (async-first suggested replies) **[H, the Avoca copilot]**
Surface, in the live conversation view, the **suggested next reply + relevant knowledge-base scripts** by running the intent router + the 106 `cannedResponse` entries against the live transcript. The human clicks-to-send (reuses Stage 11). This is the copilot without needing realtime voice — it works on chat/SMS now and on voice once Stage 12/Media-Streams lands.

## Phase D — Coaching analytics — Stages 14–16

### Stage 14 — Per-agent call scorecards (CSR + AI) **[H]**
Extend the `getTechnicianScorecards` pattern to a **handler scorecard**: call volume, booking rate, avg handle time (Stage 2 duration), QA score (Stage 6), deflection — keyed on `handlerUserId` (or 'AI'). No migration (reads `call_records` + `call_scores`).

### Stage 15 — Coaching insights **[M]**
Per agent: the specific rubric misses (from `call_scores` flags), QA trend over time, a leaderboard, and the lowest-scoring calls to review. Join `review_requests` ratings to the handler. Read-only.

### Stage 16 — QA review workflow **[M]**
A manager review queue: confirm/dispute an AI score, add a coaching note, mark "calibrated." Disposition columns on `call_scores`. **Migration-light.** Closes the human-in-the-loop QA loop Avoca sells.

## Phase E — Missed / unbooked-call recovery — Stages 17–18

### Stage 17 — Missed-call recovery **[H, revenue]**
From Stage 2's no-answer/busy/abandoned-call detection → a consent-gated callback/text via the **existing** comms+ledger+consent infra (new `missed_call` trigger). Mirrors `booking-recovery.ts`. Ships **unscheduled** (operator enables). This is Avoca's headline "recover missed revenue."

### Stage 18 — Unbooked-call recovery **[M, revenue]**
Calls that connected but didn't book (`outcome != 'booked'`, or the QA "should-have-booked" flag) → a context-aware follow-up. Reuse outbound infra + Stage 8 flags. Operator-enabled.

## Phase F — Training & the closed loop — Stages 19–20

### Stage 19 — AI training simulator **[M]**
CSR roleplay: the AI plays the customer through scenarios; the trainee's responses are scored with `behavior-probe.ts` + the judge against the rubric. Reuses the eval harness end-to-end; no customer-facing risk (internal only).

### Stage 20 — Avoca cockpit + closed loop **[M, synthesis]**
A manager command-center tying it together — call volume, booking rate, QA score, recovered revenue, agent coaching — **and** feed recurring QA misses back into the prompts/scripts/knowledge-base (the improvement loop). This is what makes it one connected system rather than point tools.

---

## Sequencing & dependencies

```
A (1→2→3,4) ──► B (5→6→7,8→9) ──► D (14→15→16)
        └─ 2 ──► E (17, 18)
C (10 ──► 11 ──► 12, 13)   [10 also feeds D's per-agent attribution]
F (19 reuses B's harness; 20 synthesizes everything)
```

- **Foundational first:** Stage 1 (call_records) and Stage 10 (csr role) are the two spines; almost everything joins on them.
- **Highest-leverage early win:** Stage 6 (run the *existing* judge on real transcripts) — the QA engine is already built; wiring it to real calls + a scores table is the cheapest path to Avoca's core value. Needs Stages 1/4/5.
- **Quick win:** Stage 11 (wire the orphaned reply UI) — backend already works.
- **Defer:** realtime voice barge/whisper (Twilio Media Streams) — its own large sub-project, called out in Stage 12; not required for the copilot (Stage 13 works async/chat/SMS first).

## Migrations (authored via `db:generate`, operator applies)
Stage 1 (`call_records`), 2 (disposition/duration cols), 3 (recording cols), 5 (`call_scores`), 7 (rubric), 10 (`csr` role enum + `handlerUserId`), 16 (review-workflow cols), 17/18 (recovery trigger enum values). Stages 4, 6, 8, 9, 11, 13, 14, 15, 19, 20 need **no** new migration (read existing / reuse infra).

## Anti-goals (this program)
Full PBX/ACD replacement; realtime media-stream voice copilot (deferred sub-project, Stage 12 note); multi-vertical; replacing the human call center entirely (Avoca *augments* it — so do we). Recording is opt-in/compliance-gated, never default-on.

## Open questions for the operator (before Stage 1)
1. **Recording appetite + jurisdictions** — do pilot orgs want call recording, and which consent regime (one-party vs two-party) applies? (Gates Stage 3; Phase B can proceed on transcripts without it.)
2. **CSR model** — are there human reps to model as `csr`, or is the pilot fully AI (which makes Phase C lower priority and Phase B/E the focus)?
3. **Scope order** — Avoca-core-first (Phases A→B→E: capture + auto-QA + recovery, mostly AI-side) vs CSR-first (Phase C: copilot for human reps)? My recommendation: **A→B→E first** (highest leverage on our AI-first stack; the judge already exists), then C/D once there are human reps to coach.
```
