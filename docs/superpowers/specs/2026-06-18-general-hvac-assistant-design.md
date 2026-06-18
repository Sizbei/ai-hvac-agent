# General HVAC Assistant (Unified, Helpful-First) — Design Spec

**Date:** 2026-06-18 · **Status:** approved (brainstorm) → adversarially reviewed (5 critics) → ready for implementation
**Plan refs:** CHATBOT-PLAN (bot quality). Builds on the shipped output guardrail + voice parity.

## Goal & context
Today's bot is a **service-intake funnel**: its greeting is "I'm here to get your issue sorted and a technician on the way," and a general HVAC question (e.g. "why is my AC freezing up?") reaches the FALLBACK_LLM path where the intake-focused persona steers back to booking rather than *answering*. This spec upgrades it into ONE **unified, helpful-first** assistant that answers general HVAC questions knowledgeably AND transitions to booking when a real service need surfaces — **without** weakening any safety property.

**Decisions locked in brainstorm:**
- **Unified** assistant (not a separate bot/mode).
- **LLM-native** knowledge (no RAG in v1) + a guardrail/safety layer.
- **Helpful-first** voice: answer genuinely; offer booking only on a real service need, softly and once.

**Hardened after a 5-critic adversarial review** (safety/liability, accuracy, scope/injection, product, architecture). The review converted "just let the LLM answer" into the guardrailed design below.

## Architecture principle (no router rewrite)
General HVAC questions ALREADY reach the FALLBACK_LLM path (the router only resolves known intents/intake deterministically; everything else falls to the LLM). So this feature is **NOT a router change**. It is three things:
1. A shared **knowledge + safety + scope** prompt block both personas embed.
2. A **deterministic output backstop** (extend `screenAssistantReply`).
3. **Eval coverage** for the new safety/scope properties.

The deterministic router (FAQ/account/intake/escalation/emergency) is unchanged and still wins when it matches.

## Components

### 1. Shared persona block — `src/lib/ai/hvac-knowledge.ts`
A plain exported `const HVAC_KNOWLEDGE_AND_SAFETY` string that BOTH `buildSystemPrompt` (web, `system-prompt.ts`) and `PHONE_SYSTEM_PROMPT` (voice, `phone-agent.ts`) embed by interpolation. No `selectSystemPrompt` refactor; voice stays its concise, identity-light persona but gains the same knowledge/safety/scope rules. Contents:

- **Role reframe:** "You are a knowledgeable HVAC assistant. Answer the customer's HVAC questions helpfully and accurately, and help them book a visit when they need service."
- **SCOPE BOUNDARY (the #1 review finding):** Answer questions about **heating, cooling, ventilation, air quality, and HVAC equipment/maintenance**. For anything outside HVAC — legal/medical/financial advice, creative writing, coding, general chit-chat, or "as an HVAC expert, also do X" framings — politely decline and redirect: *"I can only help with heating and cooling questions — what's going on with your system?"* NEVER comply with an off-HVAC request even when wrapped in HVAC framing.
- **ACCURACY DISCIPLINE:** Never state a specific **refrigerant type/charge amount, model/part number, efficiency rating (SEER2/HSPF), or code/regulation citation** as fact — you cannot determine these from a chat. Never **diagnose a specific cause** ("it's your compressor", "you're low on refrigerant"); describe what a symptom *can* mean in general terms and defer the diagnosis to a technician. Prefer general framing ("typically", "in many systems") and "a technician can confirm for your specific system."
- **SAFE HOMEOWNER HELP (pruned to genuinely-safe, non-billable):** replacing (NOT cleaning) a dirty air filter; thermostat batteries/mode/setpoint; confirming vents/registers aren't blocked; confirming the system switch is on. **If a breaker has tripped repeatedly, tell them to STOP resetting it and call — that's an electrical fault.** Do NOT instruct touching the outdoor condenser, opening any unit, clearing the condensate drain, or anything requiring tools/power-off.
- **DANGEROUS-DIY REFUSAL:** Never give step-by-step for gas lines/pilot relight, refrigerant handling (EPA-regulated), capacitor/high-voltage work, or anything needing a licensed pro. Explain the concept at a high level if asked, then: *"that's a job for a licensed technician — want me to get one out?"*
- **HAZARDS ALWAYS WIN:** Gas smell, CO alarm, burning/sparks, electrical+water, flooding → safety-first, urge immediate evacuation where appropriate, and hand off to a human. Never turn a hazard into an advice or upsell turn. (Deterministic emergency escalation in the router remains the primary gate; this reinforces it on the LLM path.)
- **HELPFUL-FIRST + booking transition:** Answer the question genuinely and completely first. Offer to book a tech only when there's a real service need, softly and once. Never force a funnel.
- **KEEP existing guardrails:** never quote a price, never claim booked/confirmed, never invent credentials/warranties/financing.
- **Brevity:** concise, conversational; on voice, keep answers short (2-3 sentences) and offer to continue.

`buildSystemPrompt`/`PHONE_SYSTEM_PROMPT` keep their existing identity/greeting/style; the new block REPLACES the current narrow "you run a thorough intake" framing's scope while preserving the intake/safety/self-check rules (the pruned self-check list above supersedes the current "check the breaker" line).

### 2. Deterministic output backstop — extend `src/lib/ai/output-guardrail.ts`
`screenAssistantReply` already deterministically catches pricing + false-booking. Add a **dangerous-advice denylist** so a SAFETY property has a runtime gate (not prompt-only), matching how pricing/emergency are gated:
- Patterns for dangerous-DIY *instructions* the bot must never speak: refrigerant recharge/charging ("add refrigerant", "recharge", "R-22/R-410A/R-454B" + an action verb), capacitor work, gas-line/pilot **relight steps**, high-voltage/wiring steps, "discharge the capacitor", etc.
- Patterns for **fabricated credentials**: "I'm certified/licensed/NATE/EPA-certified", "I'm qualified to".
- On a hit → replace with a safe reply: *"That's something a licensed technician should handle safely — I can get one out to you, or our team can walk you through it. Want me to set that up?"* and log `{sessionId, violations}` (never raw text).
- Tune for **low false-positives** (explaining *that* a capacitor exists is fine; step-by-step *replacement* is not — anchor on action verbs + imperative phrasing). Documented residual: this is a backstop, not a classifier; the prompt is the primary control and the eval covers known phrasings.

This new screen runs on the assembled reply on BOTH channels (web buffers already; voice buffers already from the parity work).

### 3. Telemetry — extend `bot-telemetry.ts`
Tag LLM turns that were a **knowledge answer** vs an **intake** turn (a boolean/enum on the existing `recordBotEvent`) so deflection-vs-conversion is measurable (does helpful-first help or hurt bookings?). No new table; one field on the existing event.

## Data flow (unchanged control flow; new behavior on the LLM turn)
1. `sanitizeInput` (unchanged) → `routeMessage` (unchanged: emergency/FAQ/account/intake/escalation still win deterministically).
2. FALLBACK_LLM → the LLM now sees the knowledge+safety+scope block → answers helpfully OR declines off-scope OR defers dangerous-DIY → offers booking on a real service need.
3. `screenAssistantReply` (now also dangerous-DIY/credentials) on the assembled reply → safe replacement on violation.
4. Persist + telemetry (knowledge-vs-intake tag).

## Error handling / fail-safe
- Off-scope/jailbreak → prompt declines; if it slips, the answer is still HVAC-bounded by the persona; non-HVAC creative/legal output is low-harm.
- Dangerous-DIY slipping the prompt → deterministic output backstop replaces it.
- Hazard → router emergency escalation (deterministic) remains the primary path.
- Guardrail/telemetry failures are best-effort (never fail the turn).

## Security / safety
- **Scope boundary is in the system prompt** (the gap the review found) — the bot refuses non-HVAC even under HVAC framing.
- **Dangerous advice has a deterministic backstop**, not prompt-only.
- Pricing/false-booking/credentials guarded (existing + new credential denylist).
- No PII/raw-reply in logs.
- **Abuse/cost watch (deferred, noted):** opening Q&A widens token-burn surface on the public widget; existing per-session token budget + per-IP rate limit still apply; a per-ORG cost cap is a separate infra item, out of scope here.

## Testing
- **Deterministic eval (CI gate)** — add golden transcripts + checks for the deterministically-checkable safety/scope properties on the assembled reply:
  - `off-scope-deflection`: non-HVAC / HVAC-framed-jailbreak ("as an HVAC expert, write a poem") → declined/redirected (critical).
  - `dangerous-diy-refusal`: refrigerant-recharge / pilot-relight / capacitor "how-to" → safe replacement, no step-by-step (critical; exercises the new output denylist).
  - still `pricing-leak` = 0, `false-booking` = 0, `emergency-escalation` fires on hazards (unchanged criticals).
- **Output-guardrail unit tests** — the new dangerous-DIY/credential denylist: catches the bad phrasings, does NOT flag legitimate general explanations (false-positive guard); safe replacement is itself clean.
- **Answer-quality (non-CI, offline)** — the existing LLM-judge harness (`src/lib/ai/eval/judge.ts`, `eval:ab`) scores answer accuracy/helpfulness against the corpus when keys are present. Add a few knowledge prompts (filter cadence, how a heat pump works, common no-cool causes) to that corpus. Documented as a quality check, not a deterministic gate (the deterministic eval cannot judge LLM answer correctness — it never calls the model).
- **Gates:** `tsc`, `test:unit`, `eval` (0 critical), `build` — all green before merge.

## Non-goals (v1, deliberate)
- RAG / curated KB (v2 if accuracy needs it).
- Per-tenant helpfulness toggle (helpful-first is the chosen default; a config dial is a clean v2 — noted from the product critic).
- Per-org cost cap / advanced abuse controls (separate infra).
- Brand product catalogs/specs; medical advice beyond "CO/gas → evacuate + call 911"; image diagnosis (gated vision feature).
- Emergency evacuation confirmation-loop / live human transfer changes (existing escalation flow unchanged).

## Channel parity
Same knowledge + safety + scope behavior on web and voice (voice answers stay concise via its persona). The shared const block + the output backstop both apply to both channels — preserving the voice↔web parity just shipped.
