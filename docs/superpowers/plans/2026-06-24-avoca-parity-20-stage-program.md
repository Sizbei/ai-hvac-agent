# Avoca-Inspired AI Call-Center Program (hardened v3)

**Date:** 2026-06-24
**Status:** roadmap (program-level) — hardened via adversarial review (2 rounds). Each stage becomes its own brainstorm → spec → `writing-plans` cycle before implementation.
**Stage count (honest):** the original "20 stages" was the ask; the *real* weight is **~13 substantial stages + a deferred Phase G + a separate FSM-booking sub-program**. The numbers below are navigation labels, not a claim of 20 equal-sized stages (Stage 4 and Stage 8 are sub-tasks; Stage 19 is a sub-program — see §scope). The filename retains "20-stage"/"parity" for continuity only.
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

### Decision gate — RESOLVED (2026-06-25, operator-delegated): **PURE-AI pilot**
**Does the pilot org have human CSRs, or is it pure-AI intake? → PURE-AI.** Rationale: the stack is AI-first (voice + chat + dispatch) and the role model is `admin/technician` only — there is no human call-center to copilot or coach. Consequences (now binding on this program):
- **Build:** `0 → A → B → E → F`. Product = **AI receptionist + self-QA of our own AI calls + missed/unbooked recovery.**
- **Defer (no users in a pure-AI pilot):** Phase C (Stages 10–13, copilot/takeover/CSR role) and Phase D (Stages 14–16, per-rep coaching). The employee-monitoring compliance load (§3.4) is therefore **not on the critical path**.
- **Separate sub-program:** Stage 19 (FSM write-path booking) — access-blocked, unchanged.
- **Earliest safe, migration-free work** (loop can start now): the pure QA primitives — the **judge→real-transcript adapter** (Stage 6's pure half: split interleaved `messages` into `userTurns`/`botReplies`) and the **deterministic transcript QA flags** (Stage 8, `output-guardrail` reuse). Both are pure/tested/inert until wired, like the Probook forecasters. Everything touching the DB (Stage 0 number→org table, Stages 1/5 tables) or external data (recording, Stage 6 live run) stays operator/compliance-gated.

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

1. **Erasure AND access/portability cascades (BLOCKER — every new PII table joins BOTH hand-enumerated lists).** There are *two* independent hand-enumerated table lists: `anonymizeCustomer` (`erasure-queries.ts`, GDPR Art. 17 erasure) **and** `exportOrganization` (`export-queries.ts`, Art. 15/20 access+portability). Both silently skip new tables. **Acceptance criterion on Stages 1, 3, 5, 16:** add the table's PII columns / R2 keys to **(a)** `anonymizeCustomer`'s `db.batch` + `scheduleStorageCleanup` *and* **(b)** `exportOrganization`, each with a test (scrubbed-after-erasure; present-in-export). Otherwise a subject's call recordings/transcripts/QA scores are erasable but invisible to a subject-access request — the symmetric Art. 15/20 bug. New PII surfaces: `call_records.fromAni` (encrypted), `call_scores.rationale` (quotes customer speech), recording audio in R2 + the **Twilio-side copy**.
2. **Recording consent is PER-CALL, by the CALLER's jurisdiction (BLOCKER).** Not a per-org flag. **ANI area-code → state is only a heuristic** (number portability + mobile means the area code ≠ where the caller physically is, which is the legally-relevant location) — so the **operating default is "always play the disclosure"** (treat every call as two-party), with ANI used only to *upgrade* leniency where confidently safe, never to skip disclosure. Disclosure plays **before `<Record>` starts** (recording a disclosure-and-decline is itself recording). **Define the decline path (acceptance criterion on Stage 3):** if the caller declines, drop to a **non-recorded** call flow (the bot still works) — never hang up on them and never start the recording. TN base being one-party is irrelevant to an out-of-state caller.
3. **External-LLM PII export + cross-border transfer (BLOCKER — Stage 6).** Feeding real transcripts to `judgeTranscript` POSTs customer speech to a third-party LLM (`createOpenAI` baseURL — could be any jurisdiction). **Acceptance criterion:** a signed DPA / zero-retention (no-training) config with the provider, the provider on a subprocessor list, **per-org opt-in to AI-QA (separate from recording opt-in)**, or run only on redacted transcripts. **Plus a data-residency / cross-border check:** for any non-US (esp. EU/UK) caller, shipping the transcript to the judge LLM (and audio to ElevenLabs, calls to Twilio) is a cross-border transfer needing a lawful mechanism (SCCs/adequacy) — confirm the provider's processing region. Until all this is satisfied, Stage 6 is operator+legal-gated like recording.
4. **Employee monitoring — a real gate, not a notice (CSRs are a recorded + scored party).** Recording captures the CSR's voice; per-rep QA scoring/leaderboards are automated employee monitoring. **Acceptance criterion (Stage 10/3):** store a per-CSR `monitoringConsentAt` (on `users` or a consent table) and **enforce it at the code boundary** — a call leg involving a non-consented CSR is **not recorded and not scored** (test asserts this), mirroring §3.1's enforceability. Plus jurisdiction checks where reps work, and **AI scores must be advisory + contestable** (Stage 16 is the contest mechanism). Without the stored-consent gate this item is prose; §3 items must be enforced, not announced.
5. **Transcript store is plaintext.** `messages.content` is `text` (not encrypted), unlike `customers.*Encrypted`. The "encrypt at rest" goal is **not currently met** at the source. Decide explicitly: accept DB-at-rest-only posture, or add a remediation stage. Don't hold `call_scores.rationale` to a stricter bar than its plaintext source while pretending the source is encrypted.
6. **Recording storage & access (acceptance criteria, Stage 3).** Delete the **Twilio-side** recording after pull (or set Twilio retention to 0/short) — your R2 erasure doesn't reach it; state the R2 encryption key model; **role-gate playback with a tested authz check** (who may listen to a customer's / another rep's call — `admin`? the handling `csr` only? not other CSRs). Each of these is a stage-3 acceptance test, not prose.
7. **Missed-call SMS ≠ TCPA consent.** "They dialed us" is not consent to be texted. Stage 17 must define the consent basis and add `missed_call` to the **closed `CommTrigger` union** (a test asserts every trigger has a `TRIGGER_RULES` entry or `checkSendAllowed` throws) requiring a real grant, not just an inbound dial.
8. **Retention / storage-limitation (MAJOR — no indefinite call data).** Recordings, `messages` transcripts, and `call_scores.rationale` (customer speech) must have a **retention period + a scheduled purge cron** per data class (Art. 5(1)(e)) — "100% call QA" multiplies the corpus, and indefinite retention of two-party recordings is its own exposure. Acceptance criterion on Stage 3/5: a TTL + purge job, with the period an operator setting.
9. **Unbounded transcript/recording content (note).** Beyond `fromAni`, the corpus can contain anything a caller says — health info, a minor's details (COPPA-adjacent), third-party PII. Treat the recording/transcript store as unbounded-sensitive-content (minimization + the access controls above), not just "ANI is encrypted."

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
**7. Per-org CONVERSION-MECHANIC rubric** [H] — replace the AI-eval rubric (naturalness/helpfulness — largely irrelevant for a human CSR) with home-services conversion items: *asked for the appointment, offered the earliest available slot, confirmed address+contact, overcame the price objection, captured lead source, offered membership, collected deposit where required, followed the booking script.* **This is a code change, not just a migration:** the judge's `JudgeScores` interface + `JUDGE_SYSTEM` prompt are hardcoded, and the persisted `call_scores` columns (Stage 5) must match — so Stage 7 couples to Stages 5/6 code, plus a rubric-config migration. This is what makes QA Avoca-grade.
**8. Deterministic QA flags (truly no-LLM)** [M] — `output-guardrail.ts` regex detectors ONLY (price/false-booking/dangerous-DIY). **`behavior-probe.ts` is LLM-graded → it lives with the judge (Stage 6), not here.** Pure functions + tests.
**9. QA dashboard** [M] — distributions, flagged calls, trend (extend `bot-analytics-section`). No migration.

## Phase C — CSR enablement (GATED on the human-CSR decision) — Stages 10–13

**10. `csr` role + call attribution** [H] — add `csr` to **both** role text-enums (`users.role` *and* `staff_invites.role`) (**code-only, no migration**) + authz + invites; add `handlerUserId` (migration) to `call_records`/sessions; **+ the stored, enforced employee-monitoring consent gate (§3.4).**
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
**19 = its OWN sub-program (NOT a peer stage): FSM write-path booking + lead-source attribution** [the Avoca moat] — the gap between "captured a lead" and Avoca's "wrote a dispatchable job to the FSM." This bundles three large, partly-blocked systems and must NOT be counted as one stage:
- (a) **Write-path booking** into the system of record — **access-blocked today** (HCP write needs the MAX plan + API key per memory; ServiceTitan is only a *plan*, not built);
- (b) **real-time availability** matching;
- (c) a **call-tracking / lead-source attribution** subsystem (tracking-number → campaign, booking-rate-by-source — the owner-ROI story).
It is the single most important Avoca differentiator and deserves its own brainstorm → spec, sequenced when FSM write access is unblocked. Listed here for completeness, scoped out of the per-stage count.

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
- **The decision gate is a BLOCKING milestone, not a preference** — the order branches on its answer, so it must be answered before Phase C/D work is spec'd:
  - **Pure-AI pilot →** `0 → A → B → E → F`; **skip Phases C/D** (no human reps to copilot/coach). Stage 19 (FSM booking) runs as a separate sub-program in parallel.
  - **Human-CSR pilot →** `0 → A(1,2) → C(10,11,13) front-loaded` (the copilot is the wedge) → B/D/E, and accept the recording + employee-monitoring (§3.4) load early.
  - A→B→E is the recommendation **only for the pure-AI branch**; it is not a default to apply before the gate is answered.
- Don't pad to a round number: Stage 4 is a helper, Stage 8 is pure-funcs-+-tests — they're sub-tasks; **Stage 19 is a separate sub-program, not a peer stage** (see below). The honest weight is **~13 substantial stages + deferred Phase G + the Stage-19 sub-program**.

## Parity gaps / deliberate scope cuts (stated, not hidden)
1. **Real-time streaming voice + live-voice copilot** → Phase G (deferred). 2. **AI outbound *voice*** (vs SMS recovery) → not built; recovery is SMS/callback. 3. **Multi-language (Spanish)** → not addressed. 4. **FSM write-path booking** → Stage 19, large. 5. **Web-chat live takeover** → endpoint is SMS-only today. 6. Voice quality (barge-in/latency) is *measured* by QA but no stage *closes* it outside Phase G.

## Open questions for the operator (before Stage 0)
1. **Human CSRs or pure-AI?** (The decision gate — defunds Phases C/D if wrong.)
2. **Recording appetite + caller jurisdictions** + are reps in two-party / works-council regimes (employee monitoring)?
3. **External-LLM QA:** acceptable to send (redacted? consented?) transcripts to the judge's LLM provider, with a DPA?
4. **Multi-tenant voice:** is the pilot single-org (skip Stage 0) or multi-org?
5. **Scope order:** A→B→E (AI-first, my rec) vs C-first (human copilot)?
