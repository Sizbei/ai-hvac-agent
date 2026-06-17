# Chatbot Improvement Plan — 20 Real Steps

Concrete engineering steps to make the HVAC bot smarter, more natural, more capable,
and measurable. From the chatbot audit. The bot is already mature (deterministic
router → LLM fallback, safety gate, slot extraction, multi-field capture, correction
handling, after-hours, identity-gated account reads, voice parity, ~238 edge-case
tests). These close the real gaps. Ordered: quick naturalness wins → measurement →
capability → platform/voice.

Legend: effort **S/M/L** · `[gated: X]` = needs a model/contract/policy decision.
Key files: `src/app/api/chat/route.ts`, `src/lib/ai/{intent-router,knowledge-base,system-prompt,extract,voice-turn,triage,lead-ins,account-tools,customer-context,availability-prompt,metrics,model-registry,provider,estimate-suggester}.ts`.

---

## Phase 1 — Naturalness & reliability quick wins (cheap, high-impact)

### Step 1 — De-template lead-ins · S
- [ ] Drop the "Got it." / "Understood." openers in `lead-ins.ts:32-98`; vary by issue type AND rotate so two consecutive chats don't read identically.
- [ ] Apply the empathy-once rule to the **LLM path** too (today it's deterministic-only → the model re-acknowledges freely).
- [ ] Add a couple golden-transcript assertions that the same opener doesn't repeat across turns.

### Step 2 — Carry tone/voice state across the deterministic↔LLM seam · S
- [ ] Pass "conversation style so far" + an `empathyAlreadyGiven` flag into the LLM system prompt (extend `sessionSlotsHint`, `route.ts:1584-1599`).
- [ ] Goal: kill the Frankenstein two-voices feeling on chats that alternate deterministic + LLM turns.

### Step 3 — Generic re-ask-loop circuit breaker · S
- [ ] Track consecutive identical questions per slot; after N, switch phrasing + auto-offer "skip" / "talk to a human" (today only address/email have caps — `triage.ts:208,246`).
- [ ] Kills the recurring "asked for address 3×" bug class.

### Step 4 — Graceful injection handling instead of a hard 400 · S
- [ ] On a flagged message (`guardrails.ts` → `route.ts:633-643`), reply conversationally ("I can only help with HVAC requests — what's going on with your system?") and continue, instead of the dead-end error box (false positives currently break the chat).

### Step 5 — Frustration-aware human offer · S
- [ ] Detect rising frustration across turns; proactively offer a human before the turn-limit fallback (today mild repeated frustration just defers — `bot-edge-cases.test.ts:405-437`).

### Step 6 — Use (don't waste) the availability query · S → merge into Step 11
- [ ] (Re-verify first) the fetch is now gated behind `willAskWindow` (`route.ts:1316-1328`), so it's no longer an every-turn waste. Confirm whether `buildWindowPrompt` consumes the windows yet; if not, this IS Step 11 — do them together (offer real day/time-band chips, never a commitment).

### Step 7 — Richer returning-customer personalization on the deterministic path · S
- [ ] `customer-context.ts` already fetches membership/prior-count/HCP history but only the LLM path uses it (`route.ts:1550`). Greet by name / reference history deterministically too (repeat customers get a generic intake on fast turns today).

---

## Phase 2 — Measurement (you can't improve what you can't see)

### Step 8 — Conversation-quality eval harness + golden transcripts · M
- [ ] Replay 30–50 labeled conversations through the full route; score with an LLM judge on rubrics (re-asks, false "booked", pricing leak, naturalness, completion).
- [ ] Run in CI as a quality gate; fail on regression.

### Step 9 — A/B Qwen vs GLM on the harness · S · [gated: Step 8]
- [ ] Same transcripts, both registry models; compare judge scores + token cost + latency. Model selection is a blind guess today (`model-registry.ts` works; no eval).

### Step 10 — Intent / outcome analytics dashboard · M
- [ ] Aggregate the structured logs (`routed`, `intentId`, `action`, `extractionComplete`) + `session-outcome` into: per-day intent distribution, abandon rate, escalation rate, deterministic-vs-LLM ratio, re-ask-loop detection.
- [ ] Surface in admin (Insights) + alert on anomalies.

---

## Phase 3 — Capability (do more for the customer)

### Step 11 — Surface REAL bookable windows in chat · M · [gated: offer-not-commit policy]
- [ ] Make `buildWindowPrompt` consume `OpenAvailability` and offer 2–3 concrete day/time-band chips ("Tue AM", "Wed PM") capturing a *preference* (never a commitment; keep never-say-"confirmed").
- [ ] Removes the wasted query (Step 6) and makes scheduling feel real.

### Step 12 — Photo / vision triage · M · [gated: vision model in registry]
- [ ] Pass linked image attachments (already stored, `route.ts:611-706`) into a vision-capable model for issue classification + a triage hint ("looks like a frozen evaporator coil; ask if cooling is off").
- [ ] Biggest "looks capable but isn't" gap — photos are captured but no model ever sees them.

### Step 13 — Real end-to-end reschedule + cancel for identified customers · L · [gated: schedule-write + policy]
- [ ] Add safe, confirm-gated schedule mutation behind the identity gate (today reschedule is a staff hand-off `account-tools.ts:292`; cancel dead-ends `intent-router.ts:127`).

### Step 14 — Stronger / structured extraction · M · [gated: model choice/cost]
- [ ] Move extraction off the weak chat model to one that honors JSON schema (or add a retry/repair pass) — the stepper + completion gate depend entirely on extraction quality (`extract.ts:26-34` notes Qwen won't honor structured output; classification "sometimes returns other").
- [ ] De-US-center the regex fallbacks (`triage.ts:108-117` requires 5-digit ZIP + leading street digit).

### Step 15 — Smarter, issue-conditional triage questions · M
- [ ] Replace the fixed 2-question cap (`triage.ts:405`) with 1–2 *high-value* qualifiers chosen by issue type (age+brand for repair-vs-replace; vulnerable-occupants for no-heat) — richer dispatch context without dragging out every intake.

### Step 16 — Entity-resolution + ambiguity probes in the deterministic layer · M
- [ ] When categories tie or confidence is mid-band (`intent-router.ts:346-399` → FALLBACK), ask a crisp deterministic disambiguator ("home AC or a commercial cooler?") instead of always punting to the LLM.

### Step 17 — Guarded pricing ranges · M · [gated: org opt-in + legal]
- [ ] For common jobs, optionally offer a *range* from the org pricebook ("diagnostics typically run $X–$Y; tech confirms on site") — keep the never-*commit* rule. "How much" is a top intent; "I can't help" loses leads. Infra exists (`estimate-suggester.ts`, admin-only today).

---

## Phase 4 — Voice parity, outreach, FAQ depth

### Step 18 — Voice account-lookups via ANI identity gate · M
- [ ] Resolve caller by their phone number (ANI) → identity, then allow balance/next-visit/appointment on the phone (today `voice-turn.ts:173-176` coerces ACCOUNT_LOOKUP to a plain LLM punt — biggest web/voice parity gap).

### Step 19 — Barge-in + streaming TTS for voice · L · [gated: Twilio/ElevenLabs streaming]
- [ ] Let the caller interrupt; stream TTS to cut turn latency (today `voice-turn.ts` returns one finished utterance, no barge-in).

### Step 20 — Proactive re-engagement + data-driven FAQs · M
- [ ] Mirror the SMS `booking-recovery` cron for idle **web** sessions ("still there? want me to hold your spot?") + a consent-respecting tune-up/membership offer at natural close points for non-members.
- [ ] Make static FAQs (service-area, hours, licensing, brands — `knowledge-base.ts`) data-driven from org config so they answer definitively instead of "our team will confirm."

---

---

## Review revisions (architect sign-off — REVISE→addressed)
- **Step 4 (graceful injection) — keep the hard block for TRUE injection signatures; only soften the HVAC-scope false-positive class.** Converting a block into a continue is a security-boundary change — a real injection must NOT be softened into a served LLM turn. Add an explicit test that known-malicious patterns still hard-block.
- **Phase 2 needs plumbing before Steps 8 & 10:** (a) **define + persist a queryable bot-event record** (the `routed/intentId/action/extractionComplete` signals are pino→stdout today — nothing to aggregate); (b) **transcript capture** for the eval corpus (Step 8 needs 30–50 labeled real conversations stored for labeling). Sequence both before/with Steps 8/10.

## Sequence summary
**Now:** Steps 1–7 (naturalness/reliability quick wins — all S, immediate "less robotic" payoff). **Then:** 8–10 (measurement — so every later change is provable). **Then:** 11–17 (capability, gated items in parallel as models/policy land). **Then:** 18–20 (voice parity + outreach). Quick wins (1–7) need no external gating and can ship this week; vision (12), structured extraction (14), guarded pricing (17), and voice streaming (19) carry model/policy/contract gates — line those up early.
