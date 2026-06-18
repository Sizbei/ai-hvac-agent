# Chatbot Prompt Tuning — Methodology & Targets Spec

**Date:** 2026-06-18 · **Status:** spec for an ongoing tuning practice (not a one-shot feature)
**Scope:** the LLM-fallback persona prompts only. The deterministic router, output guardrail, and intake state machine are NOT prompt-tuned — they are code and own the safety-critical paths.

## Why this exists
The bot's quality on the **LLM-fallback path** (the free-form turns: general HVAC answers, ambiguous intake, anything the deterministic router defers) is governed almost entirely by three prompt strings. "Tuning the prompt to make it better" is real engineering work, but only if it is **measured** — an unmeasured prompt edit is a vibe, and prompts regress silently. This spec defines (1) what "better" means in measurable terms, (2) the harness that decides whether a change helped, (3) the disciplined loop to apply changes, and (4) a concrete, prioritized backlog of tuning targets grounded in the current prompts.

## What "better" means (the quality dimensions)
Every tuning change must move at least one of these **without regressing the others or any hard gate**:

| Dimension | Definition | How measured |
|---|---|---|
| **Naturalness** | Reads like a warm, real human dispatcher — not a robot, not repetitive, not "AI-ish". | LLM-judge `naturalness` 1-5 (`src/lib/ai/eval/judge.ts`) + manual transcript review |
| **Helpfulness** | Actually moves the customer toward a resolution (answers the question / advances intake). | judge `helpfulness` 1-5 |
| **Completion** | Captures/completes the intake when there's a service need, OR answers a general question fully. | judge `completion` 1-5 + deterministic `extractionCompletionRate` + the new `knowledgeAnswerRate` telemetry |
| **Conversion** | Books a tech when there's a real service need (helpful-first, not lead-leaking). | session `outcomeDistribution` (booked) + `extractionCompletionRate` over time |
| **Conciseness** | 1-2 sentences, one question at a time (esp. voice — dead-air sensitive). | judge + reply length distribution (add to telemetry if needed) |
| **Consistency** | One continuous voice across the deterministic↔LLM seam (no "Frankenstein" two-voices). | manual review of mixed transcripts; judge `naturalness` |

**Hard gates that must never regress (any tuning change that trips these is rejected, full stop):**
- `pricing-leak` = 0, `false-booking` = 0 (deterministic eval criticals + judge `pricingLeak`/`falseBooking` booleans)
- `emergency-escalation` fires on hazards; `off-scope-deflection` and `dangerous-diy-refusal` hold
- `injection-block` holds

## Current state — what we're tuning
Three files, all `/no_think`-prefixed prompts fed to the model via `getModel()` (`src/lib/ai/provider.ts`):

1. **`src/lib/ai/system-prompt.ts` → `buildSystemPrompt(brand)`** (web). Brand-templated. Sections, in order: opening role line → IDENTITY → SAFETY GATE → REQUIRED-before-submitting → SUBMISSION → INTAKE ORDER → STYLE → CONTEXT → MULTIPLE FACTS → PARTIAL ADDRESS → URGENCY → RULES (brand redirect line) → embedded `HVAC_KNOWLEDGE_AND_SAFETY`.
2. **`src/lib/ai/phone-agent.ts` → `PHONE_SYSTEM_PROMPT`** (voice). Static const; concise spoken persona + embedded `HVAC_KNOWLEDGE_AND_SAFETY`.
3. **`src/lib/ai/hvac-knowledge.ts` → `HVAC_KNOWLEDGE_AND_SAFETY`** (shared, both channels): SCOPE BOUNDARY, ACCURACY DISCIPLINE, SAFE HOMEOWNER HELP, DANGEROUS-DIY REFUSAL, HAZARDS, HELPFUL-FIRST, KEEP GUARDRAILS, brevity.

**Architecture constraints the tuner MUST respect:**
- The prompt is **re-sent every LLM turn** + a rolling summary + the recent window (`compaction.ts`). Prompt length is a per-turn token cost (budget `DEFAULT_TOKEN_BUDGET = 40k/session`). **Bloat is a real cost** — every added sentence is paid on every fallback turn.
- The **deterministic router resolves most turns at 0 tokens** and owns FAQs/account/intake-steps/escalation. Prompt tuning only affects the *fallback* turns. Do not try to fix in the prompt what the router already handles.
- **Two personas must stay in parity** on knowledge/safety/scope (shared block) but differ in channel style (voice = shorter, spoken, no screen refs). A tuning change to the shared block lands on both; a channel-specific change goes in the respective persona.

## The measurement harness (the tuning gate)
A prompt change is "better" ONLY if the harness says so. Order of authority:

1. **Deterministic eval (`npm run eval`)** — must stay **0 critical failures**. This is a hard gate, not a judgment call. It can't score answer *quality* (it never calls the model) but it guarantees the safety/scope/routing invariants survive the change.
2. **LLM-judge (`npm run eval:ab`, `src/lib/ai/eval/judge.ts`)** — the primary *quality* signal. Runs the golden transcripts (and `JUDGE_KNOWLEDGE_PROMPTS`) through a live model and scores naturalness/helpfulness/completion (1-5) + pricing/booking booleans. **Requires API keys** (offline, not CI). This is where "did it get better?" is answered. Compare candidate-vs-baseline aggregate scores.
3. **Manual transcript review** — a fixed set of ~15-20 representative scripts (happy intake, ambiguous issue, general question, repeat customer, off-scope, hazard, frustrated customer) read by a human. The judge misses subtle voice/repetition issues; the human catches "this feels off."
4. **Production telemetry (post-ship)** — `getBotAnalytics`: `knowledgeAnswerRate`, `extractionCompletionRate`, `outcomeDistribution` (booked/abandoned), `escalationRate`, plus 👍/👎 message feedback. Watch for regressions after a prompt ships.

**A change ships only when:** eval criticals stay 0 AND judge aggregate (naturalness+helpfulness+completion) is ≥ baseline (no dimension drops >0.2) AND manual review finds no new failure mode.

## Tuning methodology (the loop)
1. **Baseline.** Record current judge scores (`eval:ab`) + a manual-review snapshot. Tag the current prompt as the baseline version.
2. **One variable at a time.** Change exactly ONE thing (one section, one rule, one example set). Multi-change edits make it impossible to attribute a score move. This is the single most important discipline.
3. **Run the gate.** `npm run eval` (criticals = 0) → `eval:ab` candidate-vs-baseline → manual review of the affected scenarios.
4. **Keep or revert.** Keep only if it measurably helped a target dimension with no regression. Revert otherwise — a neutral change that adds tokens is a loss (cost).
5. **Version + record.** Note what changed and the score delta (a short changelog comment near the prompt, or a `docs/.../prompt-changelog.md`). So a future tuner doesn't re-try a dead end.
6. **Watch production** after ship (telemetry + feedback) for a week; roll back if booked-rate or feedback drops.

## Concrete tuning targets (prioritized backlog)
Each is grounded in the current prompt. Apply via the loop above — do NOT batch them.

### T1 — Add curated FEW-SHOT exemplars (highest leverage)
**Problem:** the prompts are 100% *rules* ("never do X", "ask one question"). Models follow demonstrated behavior far better than abstract rules — and the known failure modes (repetition, "too AI", robotic openings, two-voices across the seam) are exactly what exemplars fix. There are currently zero few-shot examples.
**Change:** add 2-3 short, high-quality example exchanges to each persona showing the *target* voice: (a) a general HVAC answer that's helpful-first then softly offers booking; (b) an intake turn that captures multiple fields without re-asking or re-summarizing; (c) a deterministic→LLM handoff turn that continues the same voice (no fresh "Got it!" empathy restart). Keep them SHORT (token cost) and channel-appropriate (voice examples are spoken).
**Risk:** token cost; over-fitting to the examples' exact phrasing. Mitigate by keeping examples diverse and few.
**Measure:** judge `naturalness` + manual review of the seam/repetition scenarios. Expect the biggest naturalness gain here.

### T2 — Tighten the anti-repetition / empathy-decay rules into positive form
**Problem:** the STYLE block uses negative rules ("NEVER repeat empathy", no "Got it/Understood" on every turn). Negatives are weaker than positives, and the known "Frankenstein/repeats" issue persists on the LLM path.
**Change:** restate as a positive behavioral rule + a one-line state cue ("You have already greeted and acknowledged the issue — continue the conversation as the same person, mid-flow; vary acknowledgements, don't restate what's known"). Lean on T1 exemplars to show it.
**Risk:** minimal. **Measure:** judge `naturalness`; manual review of 3+-turn transcripts.

### T3 — Knowledge-answer depth & "answer-then-offer" shape (the new capability)
**Problem:** `HELPFUL-FIRST` says "answer genuinely and completely" but gives no shape. The model may under-answer (one-liner then pivot to booking — feels salesy) or over-answer (a wall of text — bad on voice). The general-assistant feature is new and unexemplified.
**Change:** specify the answer SHAPE: "Give a direct, useful answer in 2-4 sentences (1-2 on voice). If — and only if — the question reveals a real service need, add ONE soft booking offer at the end. If it's pure education, do NOT pitch." Add a T1 exemplar for each case (pure-education vs reveals-a-need).
**Risk:** the "reveals a need" judgment is the model's — exemplars matter most here. **Measure:** judge `helpfulness` + `naturalness` on `JUDGE_KNOWLEDGE_PROMPTS`; production `knowledgeAnswerRate` vs `booked` outcome (does answering cannibalize or assist bookings?).

### T4 — Strengthen ACCURACY framing with a "say less, defer specifics" cue
**Problem:** `ACCURACY DISCIPLINE` forbids stating specific refrigerants/SEER/codes, but the model may still volunteer confident specifics. The rule is a prohibition without a positive alternative.
**Change:** add the positive habit: "When you don't know a system-specific fact, say what's *generally* true and explicitly hand the specific to a technician ('the exact spec depends on your unit — a tech can confirm'). Never fill a gap with a guessed number." Add one exemplar (customer asks 'what refrigerant does my unit use?' → general + defer).
**Risk:** none. **Measure:** judge + a manual adversarial set of spec-baiting questions; offline judge `rationale` flags confident-wrong facts.

### T5 — Prompt ORDERING: move the most-violated rules up / repeat critical ones
**Problem:** models weight early and late prompt content more than the middle. The SUBMISSION "never say booked" rule and the SCOPE BOUNDARY are load-bearing but sit mid-prompt; long prompts dilute them.
**Change:** ensure the 3-4 hard rules (no price, no false booking, scope, hazards) appear in a tight "NON-NEGOTIABLES" block near the TOP and are echoed briefly at the END. (The deterministic output guardrail is the real backstop, but reinforcing placement reduces how often it has to fire.)
**Risk:** duplication adds a few tokens; keep the echo to one line. **Measure:** judge `pricingLeak`/`falseBooking` booleans should stay 0 with fewer guardrail-replacement events (telemetry).

### T6 — Voice concision pass (channel-specific)
**Problem:** the shared block + the knowledge depth (T3) risk longer voice answers → dead air (a known voice-parity concern). `PHONE_SYSTEM_PROMPT` says "short sentences" but the embedded knowledge block invites longer answers.
**Change:** in the VOICE persona only, add an explicit cap for knowledge answers ("on a call, answer in 1-2 spoken sentences and offer to go deeper or get a tech out — never read a paragraph aloud").
**Risk:** under-answering on voice; acceptable trade for latency. **Measure:** manual voice-transcript review + reply-length on the phone channel.

### T7 — Model-specific tuning (`/no_think`, temperature, the configured model)
**Problem:** all prompts hardcode `/no_think`. Whether thinking helps quality on the current model is untested; temperature/sampling aren't tuned per use.
**Change:** A/B `/no_think` on vs off for the knowledge path via `eval:ab`; test a small temperature change for warmth. Treat as model-config tuning, not prompt-text — but it's part of "make the bot better".
**Risk:** thinking raises latency/cost (esp. voice). **Measure:** `eval:ab` quality vs latency trade.

## Prompt-engineering principles to apply (the "how")
- **Show, don't just tell** — exemplars > rules for behavioral/voice traits (T1).
- **Positive over negative** — "do X" beats "never do Y" for style; reserve hard negatives for the few safety non-negotiables (T2, T4).
- **Primacy/recency** — hard rules at the top, echoed at the end (T5).
- **One change at a time, always measured** — the loop is the spec's core discipline.
- **Token frugality** — the prompt is paid every fallback turn; cut a sentence for every one you add where possible.
- **Channel-fit** — shared knowledge/safety, channel-specific style.

## Risks & invariants (do not cross)
- **Never weaken a safety gate to improve a quality score.** The hard gates (pricing/booking/hazard/scope/injection) are non-negotiable; the deterministic backstops stay regardless of prompt.
- **Don't move router-owned logic into the prompt.** FAQs, account lookups, intake-step sequencing, emergency detection are deterministic for a reason (0-token, testable). Tuning the prompt to "also handle" them re-introduces cost and nondeterminism.
- **Watch token budget.** A bloated prompt can exhaust the 40k session budget mid-intake. Net-neutral-or-shorter is the goal.
- **Parity:** a shared-block change lands on web AND voice — review both.

## Rollout
- Tune offline (`eval:ab` + manual review) → land the winning change behind the normal PR/merge flow → deploy → watch telemetry (`knowledgeAnswerRate`, `extractionCompletionRate`, `booked` outcomes, 👍/👎) for ~1 week → roll back if a target regresses.
- Keep a short **prompt changelog** (what changed, score delta, date) so tuning is cumulative, not circular.
- **Per-tenant:** tuning the default persona affects all tenants. A per-tenant tone/stance override is a separate (deferred) feature — note when a change is opinionated enough to warrant it.

## Non-goals
- RAG / retrieval-grounded accuracy (separate spec; this tunes the LLM-native prompt only).
- Replacing the deterministic router with LLM routing.
- A prompt-editing admin UI / per-tenant prompt overrides (future).
- Fine-tuning / training a model (this is prompt + model-config only).
