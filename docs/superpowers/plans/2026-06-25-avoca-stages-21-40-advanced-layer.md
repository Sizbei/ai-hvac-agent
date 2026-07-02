# Avoca Program — Stages 21–40 (the advanced / deferred layer)

**Date:** 2026-06-25
**Status:** roadmap extension — the second-half stages the first 20 (both the QA-first plan `2026-06-24-avoca-parity-20-stage-program.md` and the revenue-moat council plan `2026-06-25-avoca-revenue-moat-council-plan.md`) explicitly **deferred**. Assumes Stages 0–20 of the revenue-moat spine are the base (book-on-the-call on FieldPulse + AI outbound voice + downstream QA). Each stage → its own brainstorm → spec → `writing-plans` cycle.

> **Honesty up front (the reviews keep flagging padding):** this is the *expensive, mostly-gated* half. The genuinely substantial workstreams are **real-time streaming voice (Phase H — a multi-quarter sub-program on its own), AI-outbound-voice-at-scale, multi-language, and FSM/CRM write breadth.** Several "stages" below are sub-tasks; the honest weight is **~12 heavy items**, two of which (H, the ServiceTitan write) are sub-programs. Stages tagged **[SPEC]** are speculative/low-grounding and should be cut unless a pilot need appears.
>
> **All Stages 0–20 invariants carry forward** (compliance spine: per-caller-jurisdiction recording, dual erasure+export cascades, retention/TTL, DPA; neon-http no-tx/`after()`; consent-gated + operator-enabled outbound; PURE-AI pilot so human-CSR copilot/coaching stay deferred).

---

## Phase H — Real-time streaming voice (the actual Avoca gap; was "Phase G deferred") — Stages 21–25
*This is a sub-program, not five tidy stages. It replaces the turn-based `<Gather>` loop with full-duplex audio. Off-Vercel infra required (websockets) — the #1 infra gate.*

**21. Media-stream gateway [GATE: infra].** Twilio `<Connect><Stream>` → a persistent websocket service (NOT Vercel serverless — needs a long-lived process; pick Fly/Render/a worker). The foundational gate for everything in H.
**22. Streaming STT [GATE: vendor/DPA].** Replace Twilio `SpeechResult` turns with a streaming transcription provider (Deepgram/AssemblyAI/etc.) over the gateway; cross-border + DPA per §compliance.
**23. Streaming TTS + barge-in [GATE].** Stream ElevenLabs audio back over the socket; support interruption (caller talks over the bot → cut TTS). The hardest UX bar and Avoca's real differentiator.
**24. Turn-taking / latency budget [PURE-ish].** Endpointing, sub-second response loop, and graceful fallback to the existing turn-based `<Gather>` path when the stream degrades (never drop a call). Reuses `voice-turn.ts` as the brain behind the new ears/mouth.
**25. Live overflow / after-hours real-time answering [GATE: config].** Route calls the human team misses (no-answer/busy) straight to the live AI agent in real time — Avoca's headline "we answer the overflow." (Distinct from Stage-17 *recovery*, which is after-the-fact.)

## Phase I — AI outbound voice at scale — Stages 26–29
*Extends the revenue-moat plan's marquee `calls.create` callback into a real campaign engine. OUTBOUND — hard consent/TCPA + operator-enable gates.*

**26. Outbound voice campaign engine [MIGRATION + GATE].** `outbound_call_jobs` queue (mirrors `communication_jobs`), driven off missed/unbooked detection; reuses `claimOutboundOnce` dedup + `checkSendAllowed`. Ships unscheduled.
**27. TCPA/consent basis for outbound voice [GATE: legal].** Stricter than SMS: define lawful basis to *call* an inbound number that never consented; quiet-hours; do-not-call honoring; per-state rules. The blocker that makes 26 sendable.
**28. Voicemail-drop + retry policy [PURE].** Detect machine vs human (AMD), drop a compliant voicemail, bounded retries with backoff — reuse the comms retry shape.
**29. Outbound script A/B + attribution [PURE].** Per-campaign script variants scored by booking outcome (reuse the eval/judge + the booking-outcome classifier); attribute recovered revenue.

## Phase J — Multi-language (Spanish) — Stages 30–32
*A real Avoca/category capability, omitted from the first 20.*

**30. Language detection + routing [PURE].** Detect caller language early (STT hint / first-turn) and branch; default English.
**31. Spanish TTS voice + translated scripts [MIGRATION: per-org].** Spanish ElevenLabs voice; translate the 106 `cannedResponse` scripts + safety disclosures (the frozen-safety-text must be professionally translated, NOT machine-translated — compliance).
**32. Bilingual transcript + QA [PURE-ish].** Ensure the judge/flags handle non-English transcripts (the judge prompt is English-framed — needs a language-aware rubric); transcript adapter is language-agnostic already.

## Phase K — Advanced QA / coaching / training — Stages 33–36
*Builds on the pure QA primitives already shipped (`src/lib/ai/qa/`). Coaching is PURE-AI-deferred where it targets humans.*

**33. Per-org rubric tuning loop [GATE: rubric weights].** The Stage-7 per-org rubric becomes a managed, versioned config with a calibration workflow (operator sets weights/thresholds; the unweighted `summarizeCallQa` stays the neutral core).
**34. QA drift / accuracy monitoring [MIGRATION].** Persist judge-vs-deterministic agreement over time; alert on rubric drift or model regression (reuse the `forecast_accuracy` logging shape from Probook).
**35. Training simulator scenarios [PURE].** AI-plays-customer roleplay scored by judge/behavior-probe — internal-only, low risk; useful even pure-AI (tune the bot against scenarios). 
**36. AI self-improvement loop (human-reviewed) [GATE].** Recurring QA misses → human-reviewed suggestions to prompts/scripts/KB — NEVER auto-applied, NEVER touching frozen safety text (the hard invariant).

## Phase L — FSM/CRM write breadth + owner BI — Stages 37–39
*Extends the FieldPulse write spine to other systems + the ROI story.*

**37. HCP write-path booking [GATE: MAX-plan + key].** Mirror the verified FieldPulse `createJob` write path into Housecall Pro — blocked on the HCP MAX plan + API key (per memory). Code pattern is proven (duplicate-not-abstract, per the invoice-mirror precedent).
**38. ServiceTitan write adapter [SPEC / sub-program].** The enterprise wedge — but ServiceTitan is only a *plan* today; large, partner-gated. Keep as a named sub-program, not a stage, until a deal needs it.
**39. Owner ROI / revenue-attribution BI [PURE-ish].** Lead-source → booking-rate → recovered-revenue dashboards (built on Stage-0 `inbound_numbers` attribution + booking-outcome labels). The number that renews the contract.

## Phase M — Reliability, scale & ops — Stage 40
**40. Call-data ops hardening [MIGRATION + GATE].** Automated recording retention/TTL purge (the §compliance storage-limitation duty), recording/transcript access-audit logging, websocket-gateway observability + cost controls, and load/rate-limit hardening for the streaming path. The unglamorous prerequisite to running real call volume.

---

## Sequencing & honest dependency note
- **Phase H is the long pole** and gates the *quality* half of Avoca parity; it needs off-Vercel infra (Stage 21) before anything else in H. It can proceed in parallel with the revenue-moat Stages 0–20 (different surface).
- **Phases I/J/K mostly build on Stages 0–20** (booking spine + QA primitives + comms) and are individually shippable once their gate clears.
- **Phase L** depends on the Stage-0 attribution + booking-outcome labels; ServiceTitan (38) is explicitly out until partnered.
- **Phase M** is continuous, not last — recording-retention (40) is actually a §compliance duty the moment recording (Stage 3) ships.

## Parity gaps still NOT closed even after 40 stages
Genuine human-CSR live copilot/whisper (deferred under PURE-AI); a native mobile app; ACD/PBX replacement; deep insurer/warranty integrations. These remain deliberate non-goals.

## Open questions for the operator
1. **Phase H infra:** are you willing to run an off-Vercel websocket service (the hard prerequisite for real-time voice)? If no, H is impossible and "Avoca voice parity" stays out of reach — be explicit.
2. **Outbound voice (Phase I):** legal appetite for AI *calling* customers (TCPA is stricter than SMS)?
3. **Spanish (Phase J):** real pilot demand, or cut?
4. **HCP/ServiceTitan writes (Phase L):** is the HCP MAX plan + key available? Any ServiceTitan deal in sight, or keep 38 shelved?
5. **Which to start:** H (close the voice-quality gap) vs L (extend the revenue moat) — they're independent; H is far heavier.
