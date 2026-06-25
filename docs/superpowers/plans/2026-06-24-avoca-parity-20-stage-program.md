# Avoca-Inspired AI Call-Center — 20-Stage Program (hardened v2)

**Date:** 2026-06-24
**Status:** roadmap (program-level) — hardened via adversarial review (round 1). Each stage becomes its own brainstorm → spec → `writing-plans` cycle before implementation.
**Goal:** Build, on our stack, the *measurable* core of what Avoca AI gives HVAC/home-services contractors — automated call QA, coaching, missed/unbooked-call recovery, and a CSR copilot — on top of our existing AI voice intake, **honestly scoped** against where we are vs where Avoca is.

> **Naming honesty (review correction):** this is **"Avoca-inspired," not "Avoca parity."** Avoca's defining product is a **real-time, streaming, full-duplex voice agent** (barge-in, sub-second latency) that books into the contractor's FSM. Ours is a **turn-based `<Gather>` Twilio IVR** — useful, but materially behind that bar. True real-time voice (Twilio Media Streams) and live-voice copilot are a **named deferred phase (Phase G)**, not a footnote. See §"Parity gaps / deliberate scope cuts."

---

## 0. What Avoca is (corrected) and our honest angle

**Avoca AI** sells contractors: (1) a **real-time AI voice agent** that answers/books inbound calls 24/7 (after-hours + overflow) **and writes the job into the FSM** (ServiceTitan-first) against live availability; (2) a **CSR copilot** (increasingly *live*-call assist); (3) **automated 100%-call QA** on a conversion-mechanic rubric; (4) **coaching analytics** per rep; (5) **missed/unbooked-call recovery** (trending toward AI outbound *voice*); (6) **training simulation**; plus **lead-source attribution** and (often) **Spanish**. Their headline ROI pitch is *"we answer the calls your team misses and book them."*

**Honest state of our stack:**
- We have a **turn-based** voice agent (not streaming) — so we have *an* answer path, **not** Avoca's voice quality. Closing that gap is real work (Phase G), not free.
- Our FSM integrations (FieldPulse/HCP) are **read-only invoice mirrors**; ServiceTitan is a *plan*. We have **no write-path booking** into a contractor's system of record. That is Avoca's booking moat and a first-class gap (Stage 19).
- We already have **the QA engine** (`eval/judge.ts`) — but it grades the *bot*, runs offline on fixtures, and is never persisted.

**Our realistic angle:** lead with the parts our AI-first stack makes cheap and high-leverage — **auto-QA of our own AI calls + recovery** — while being explicit that (a) **human-CSR QA/coaching/copilot (Phases C/D) only have users if the pilot has human reps** (decision gate below), and (b) **streaming voice + live-voice copilot is the genuine Avoca gap** we defer with eyes open.

### Decision gate (answer before committing past Phase B)
**Does the pilot org have human CSRs, or is it pure-AI intake?**
- **Pure-AI:** Phases C & D (copilot, takeover, per-rep coaching — 6 stages) have **no users**; this becomes an *AI receptionist + self-QA + recovery + booking* product. Front-load A→B→E→F.
- **Human CSRs:** front-load Phase C (the copilot is the Avoca wedge) and accept the recording/employee-monitoring compliance load early.

This fork is unresolved and **defunds 25% of the program if guessed wrong** — it is operator question #1, not a footnote.

---

## 1. Reuse foundation (verified against the code)

- **Voice (turn-based):** `voice/{incoming,gather,tts}/route.ts` + `voice-turn.ts`; ElevenLabs/Polly TTS; signature-verified; warm transfer (`dialThenHangupTwiML` + `organization_settings.voiceTransferNumber`). **Caveat:** `voice/incoming` hardcodes `DEMO_ORG_ID` → **voice is single-tenant today** (see Stage 0).
- **Transcript/telemetry:** `messages` (caller+assistant turns; **plaintext** — see §3), `bot_events` (PII-free per-turn: routed/intent/`latencyMs`), `customer_sessions` (`channel='phone'`, `token=CallSid`, `mode`, 5-way `outcome`), `session-outcome.ts`.
- **QA engine (already written):** `eval/judge.ts` `judgeTranscript()` → `JudgeScores{naturalness,helpfulness,completion,pricingLeak,falseBooking,rationale}`, degrade-safe, **offline-on-fixtures only, never persisted**, and it **POSTs the transcript to an external OpenAI-compatible LLM** (compliance implication — §3). Input is a `GoldenTranscript` + a parallel `botReplies[]` array (index-zipped) — **real calls need an adapter**, not a drop-in.
- **Deterministic detectors (truly no-LLM):** `output-guardrail.ts` regexes (`screenAssistantReply`). **Note:** `eval/behavior-probe.ts` is **LLM-graded** (calls `generateText`), *not* deterministic — it belongs with the judge, not the no-LLM flags.
- **CSR-adjacent:** read-only conversations inbox; an **orphaned reply endpoint** (`/api/admin/conversations/[id]/message`) that flips `mode='human'` — but is **SMS-ONLY** (`UNSUPPORTED_CHANNEL` for web/chat) and has no UI composer.
- **Recovery/comms:** `booking-recovery.ts` (abandoned chat/SMS/web), `communication_jobs` + `checkSendAllowed` (consent/quiet-hours) + `claimOutboundOnce` (ledger) + templates.
- **Scripts/reviews/roles:** ~106-entry `knowledge-base.ts` (`cannedResponse`); `review_requests` (1–5 + private feedback); `getTechnicianScorecards` (tech jobs only); roles = `super_admin|admin|technician` (`role` is a **text-enum, not a pgEnum** → adding `csr` is code-only, no migration).
- **Erasure reality:** `anonymizeCustomer` (`erasure-queries.ts`) is a **hand-enumerated `db.batch` over ~16 named tables** — it does **NOT** auto-cover new tables. Every new PII table MUST be added to it (§3, hard rule).

---

## 2. Cross-cutting invariants (apply to EVERY stage)

neon-http (no transactions / `db.batch` / `after()` not detached promises); migrations authored via `db:generate`, **operator applies**; consent-gated outbound, crons ship unscheduled; preserve frozen-safety-text, money-safety, the financial-verify gate, output guardrail.

## 3. Compliance & privacy — the program's load-bearing spine (ruthless, per review)

This is the weakest area of any call-intelligence build and the worst place to be wrong. **These are hard, tested acceptance criteria on the named stages, not aspirations.**

1. **Erasure cascade (BLOCKER — every new PII table).** `anonymizeCustomer` will silently skip new tables. **Acceptance criterion on Stages 1, 3, 5, 16:** add the table's PII columns / R2 keys to `anonymizeCustomer`'s `db.batch` **and** `scheduleStorageCleanup`, with a test asserting the row/object is scrubbed after erasure. New PII surfaces: `call_records.fromAni` (encrypted), `call_scores.rationale` (quotes customer speech), recording audio in R2 + the **Twilio-side copy**.
2. **Recording consent is PER-CALL, by the CALLER's jurisdiction (BLOCKER).** Not a per-org flag. Derive the consent regime from the caller's number (ANI area code → state); **default to the strictest (two-party) regime** when ANI is absent/blocked/VoIP; play the spoken disclosure **before `<Record>` starts** (recording a disclosure-and-decline is itself recording). TN base being one-party is irrelevant to an out-of-state caller.
3. **External-LLM PII export (BLOCKER — Stage 6).** Feeding real transcripts to `judgeTranscript` POSTs customer speech to a third-party LLM. **Acceptance criterion:** a signed DPA / zero-retention (no-training) config with the provider, the provider on a subprocessor list, **per-org opt-in to AI-QA (separate from recording opt-in)**, or run only on redacted transcripts. Until then Stage 6 is operator+legal-gated like recording.
4. **Employee monitoring (CSRs are a recorded + scored party).** Recording captures the CSR's voice; per-rep QA scoring/leaderboards are automated employee monitoring → require **CSR notice/consent**, jurisdiction checks where reps work, and **AI scores must be advisory + contestable** (Stage 16 is the contest mechanism, not just QA hygiene).
5. **Transcript store is plaintext.** `messages.content` is `text` (not encrypted), unlike `customers.*Encrypted`. The "encrypt at rest" goal is **not currently met** at the source. Decide explicitly: accept DB-at-rest-only posture, or add a remediation stage. Don't hold `call_scores.rationale` to a stricter bar than its plaintext source while pretending the source is encrypted.
6. **Recording storage & access.** Delete the **Twilio-side** recording after pull (or set Twilio retention to 0/short) — your R2 erasure doesn't reach it; state the R2 encryption key model; **role-gate playback** (who may listen to a customer's / another rep's call?).
7. **Missed-call SMS ≠ TCPA consent.** "They dialed us" is not consent to be texted. Stage 17 must define the consent basis and `TRIGGER_RULES['missed_call']` must require a real grant, not just an inbound dial.

---

## Stage 0 (PREREQUISITE) — Multi-tenant inbound voice **[H, blocks Stage 1]**
`voice/incoming` hardcodes `DEMO_ORG_ID`. Resolve `organizationId` from the **dialed (`To`) Twilio number** (number→org table). Without this, every `call_records`/`call_score`/per-org-rubric row is single-tenant and the Phase B/D "per-org" framing is fiction. (If the pilot is genuinely single-tenant, say so and strike "per-org" everywhere.)

## Phase A — Call-data foundation — Stages 1–4

**1. `call_records` table + populate** [H, foundational] — `callSid`, `orgId`, `customerId`, `fromAni` (encrypted), `direction`, `startedAt`, `sessionId`, `handlerUserId?`. **+erasure-cascade wiring (§3.1) as acceptance criterion.** Migration. (Gated on Stage 0.)
**2. Call-status callbacks → disposition + missed-call detection** [H] — `statusCallback` (ring/answered/completed/no-answer/busy/canceled) → `disposition`/`durationSec`/`endedAt`. **This is also Stage 6's "call complete, score it" trigger.** Migration-light.
**3. Call recording** [M, COMPLIANCE — highest risk] — per-CALLER-jurisdiction consent + disclosure-before-`<Record>` + Twilio-side deletion + R2 encryption + role-gated playback + erasure cascade + CSR-consent (§3.2/3.4/3.6). **Operator+legal-gated.** NOT a blocker for Phase B on *AI* calls (transcripts exist); but **human-CSR-call QA is recording-gated** — state that plainly.
**4. Canonical transcript API** [S] — `getCallTranscript()` from `messages`; small read helper (folds naturally into Stage 6's adapter).

## Phase B — Automated QA (AI calls first) — Stages 5–9

**5. `call_scores` schema** [H] — dimensions + flags + rationale + `handlerUserId` + `source('ai'|'human')`. **+erasure cascade.** Migration.
**6. Wire the judge to REAL transcripts** [H, highest-leverage *for AI calls*] — `after()`/cron over completed calls (trigger = Stage 2). **Requires 1/2/4/5 + an adapter** (split interleaved `messages` into the judge's `userTurns`/`botReplies` arrays) **+ the §3.3 external-LLM compliance gate.** Honest framing: early value = **self-QA of our own AI's calls**; human-CSR QA still waits on recording (3) + attribution (10).
**7. Per-org CONVERSION-MECHANIC rubric** [H] — replace the AI-eval rubric (naturalness/helpfulness — largely irrelevant for a human CSR) with home-services conversion items: *asked for the appointment, offered the earliest available slot, confirmed address+contact, overcame the price objection, captured lead source, offered membership, collected deposit where required, followed the booking script.* Migration (rubric config). This is what makes QA Avoca-grade.
**8. Deterministic QA flags (truly no-LLM)** [M] — `output-guardrail.ts` regex detectors ONLY (price/false-booking/dangerous-DIY). **`behavior-probe.ts` is LLM-graded → it lives with the judge (Stage 6), not here.** Pure functions + tests.
**9. QA dashboard** [M] — distributions, flagged calls, trend (extend `bot-analytics-section`). No migration.

## Phase C — CSR enablement (GATED on the human-CSR decision) — Stages 10–13

**10. `csr` role + call attribution** [H] — add `csr` to the `role` text-enum (**code-only, no migration**) + authz + invites; add `handlerUserId` (migration) to `call_records`/sessions; **+ employee-monitoring consent (§3.4).**
**11. Wire the orphaned reply UI — SMS ONLY** [M, quick win] — composer in `conversation-detail` → existing `/message` endpoint + polling. **The endpoint rejects web/chat (`UNSUPPORTED_CHANNEL`); web-widget live delivery is separate, larger work — do not claim "chat takeover" until a web-delivery channel exists.**
**12. Voice live-takeover (scoped)** [M] — enforce `mode='human'` in `gather` (it's ignored today) + warm-transfer-to-a-specific-CSR. Realtime barge/whisper = **Phase G** (deferred).
**13. CSR copilot (SMS/async first, measurable)** [H] — surface suggested reply + relevant `cannedResponse` scripts via the intent router on the live transcript; click-to-send (Stage 11, SMS). **Acceptance bar (don't ship vague):** suggestion latency < target, top-suggestion-accepted-rate measured, "relevant" = intent-matched. Live-voice copilot deferred (Phase G).

## Phase D — Coaching (GATED on human CSRs) — Stages 14–16

**14. Per-agent scorecards (CSR + AI)** [H] — volume, booking rate, AHT (Stage 2 duration), QA score, deflection by `handlerUserId`. No migration.
**15. Coaching insights** [M] — per-agent rubric misses, QA trend, leaderboard, lowest-scoring calls; join review ratings to handler. No migration.
**16. QA review/dispute workflow** [M] — confirm/dispute an AI score + coaching note + "calibrated." **Doubles as the employee right-to-contest (§3.4).** Migration-light.

## Phase E — Recovery + the booking moat — Stages 17–19

**17. Missed-call recovery** [H, revenue] — from Stage 2 detection → consent-gated callback/text via existing comms+ledger. **Define the TCPA consent basis (§3.7)** — an inbound dial is not consent. Ships unscheduled (operator-enabled).
**18. Unbooked-call recovery** [M] — connected-but-not-booked (`outcome!='booked'` or the QA "should-have-booked" flag) → context-aware follow-up. Operator-enabled.
**19. FSM write-path booking + lead-source attribution** [H, the Avoca moat — NEW per review] — the gap that separates "captured a lead" from Avoca's "wrote a dispatchable job to the FSM." Write-path booking into the contractor's system of record (HCP write / ServiceTitan-plan) against real availability, **plus** tracking-number → lead-source attribution + booking-rate-by-source (the owner-ROI story). Large; likely splits into its own sub-program.

## Phase F — Training & closed loop — Stage 20

**20. Training simulator + human-reviewed improvement loop** [M] — (a) CSR roleplay scored by the judge/behavior-probe (gated on a human-CSR base); (b) the closed loop: recurring QA misses surfaced as **human-reviewed suggestions** to prompts/scripts/KB — **NEVER auto-applied, and NEVER touching the frozen safety text** (the one place an auto-loop would violate a hard invariant). (Cockpit dashboards are re-skins of Phases B/D, not new work.)

## Phase G (DEFERRED, named — the real Avoca gap) — Real-time voice
Twilio **Media Streams** (full-duplex websocket audio): barge-in, sub-second latency, streaming STT/TTS, and the **live-voice CSR copilot** (whisper during a live human call). This is Avoca's defining capability and our biggest gap; it is a substantial sub-program, deliberately out of this program's scope. **Owning this deferral is why the program is titled "inspired," not "parity."**

---

## Sequencing & dependencies (corrected)
```
Stage 0 (multi-tenant voice) ──► A: 1 → 2 → 4     [3 (recording) is a SIDE branch → feeds 16 audio review only]
                                       │
                                       ▼
                              B: 5 → 6(needs 1,2,4,5 + compliance gate) → 7,8 → 9 ──► D: 14 → 15 → 16
                                       └─ 2 ──► E: 17, 18
C: 10 → 11(SMS) → 12, 13     [10 also supplies D's per-agent attribution]
E: 19 (FSM write-path) is its own large sub-program.   F: 20.   G: deferred.
```
- **Stage 0 is the true first move** (single-tenant voice blocks the call_records spine).
- **A→B→E first** is defensible (the judge exists) — but honestly delivers **AI self-QA + recovery** early; **human-CSR QA (the Avoca wedge) waits on recording(3)+attribution(10)+the human-CSR decision.**
- Don't pad to a round number: Stage 4 is a helper, Stage 8 is pure-funcs-+-tests — they're sub-tasks next to "build compliant call recording." The honest weight is ~12–14 substantial stages + the deferred Phase G.

## Parity gaps / deliberate scope cuts (stated, not hidden)
1. **Real-time streaming voice + live-voice copilot** → Phase G (deferred). 2. **AI outbound *voice*** (vs SMS recovery) → not built; recovery is SMS/callback. 3. **Multi-language (Spanish)** → not addressed. 4. **FSM write-path booking** → Stage 19, large. 5. **Web-chat live takeover** → endpoint is SMS-only today. 6. Voice quality (barge-in/latency) is *measured* by QA but no stage *closes* it outside Phase G.

## Open questions for the operator (before Stage 0)
1. **Human CSRs or pure-AI?** (The decision gate — defunds Phases C/D if wrong.)
2. **Recording appetite + caller jurisdictions** + are reps in two-party / works-council regimes (employee monitoring)?
3. **External-LLM QA:** acceptable to send (redacted? consented?) transcripts to the judge's LLM provider, with a DPA?
4. **Multi-tenant voice:** is the pilot single-org (skip Stage 0) or multi-org?
5. **Scope order:** A→B→E (AI-first, my rec) vs C-first (human copilot)?
