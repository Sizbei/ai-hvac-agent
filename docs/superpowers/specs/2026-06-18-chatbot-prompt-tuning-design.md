# Chatbot Prompt Tuning — Methodology & Targets Spec

**Date:** 2026-06-18 · **Status:** hardened after a 5-critic adversarial review.
**Scope:** the LLM-fallback persona **style/voice/knowledge-shape** text only. The deterministic router, the output guardrail, and the **safety blocks of the prompt are FROZEN** (see Invariants) — they are not "tuned" for quality.

## Why this exists
The bot's quality on the **LLM-fallback path** (general HVAC answers, ambiguous intake, anything the router defers) is governed by three prompt strings. "Tuning the prompt" is real work, but it must not (a) silently erode safety, or (b) pretend to a measurement rigor the harness can't deliver. This spec defines what "better" means, an **honest** account of what the harness can and cannot measure, a disciplined loop, and a small set of concrete, exemplified targets.

## What "better" means
A change must improve at least one of these without regressing the others or any Invariant:
- **Naturalness** — reads like a warm human dispatcher, not a robot or a template. (judge `naturalness` 1-5 + manual review)
- **Helpfulness** — actually advances the customer (answers / moves intake). (judge `helpfulness` 1-5)
- **Completion** — completes intake when there's a need, or answers a question fully. (judge `completion` 1-5 + `extractionCompletionRate`, `knowledgeAnswerRate` telemetry)
- **Conciseness** — 1-2 sentences, one question; tighter on voice. (manual review)

(The judge scores exactly these three — `src/lib/ai/eval/judge.ts` `JudgeScores`. "Conversion" is an *outcome*, not a tuning target — improve it via better intake quality, NEVER by nudging harder or implying a booking; see Invariants.)

## Invariants (NEVER cross — these gate every change)
1. **Frozen safety text.** The prompt blocks `SAFETY GATE`, `SUBMISSION`, `SCOPE BOUNDARY`, `ACCURACY DISCIPLINE`, `DANGEROUS-DIY REFUSAL`, `HAZARDS`, and `KEEP EXISTING GUARDRAILS` are **off-limits to quality tuning.** Reason (verified): the deterministic eval does NOT exercise the LLM-fallback reply, so it **cannot detect** a weakened scope/DIY/hazard instruction — only the output-guardrail regex (pricing / false-booking / dangerous-DIY *imperatives* / credentials) and the *deterministic* (canned-reply / router) paths are gated in CI. A keyless tuner who edits these blocks can erode safety with a green `npm run eval`. Therefore: tune ONLY the style/voice/knowledge-*shape*/exemplar text. Any edit that touches a frozen block requires (a) the LLM-judge with keys AND (b) an explicit manual safety review AND (c) a voice-transcript check (voice has thinner safety wording than web).
2. **Deterministic criticals stay 0.** `npm run eval` — `pricing-leak`, `false-booking`, `emergency-escalation`, `off-scope-deflection`, `dangerous-diy-refusal`, `injection-block` all pass. This is the hard CI gate.
3. **No conversion-nudging.** Never tune the bot to imply a need or imply a booking to close. Pure-education questions get NO booking pitch.
4. **Token-neutral-or-shorter.** The prompt is re-sent every fallback turn against a 40k/session budget (`token-budget.ts`); audit for cuts before/while adding. A change that bloats the prompt with no measured gain is a loss.

## What the harness can and cannot measure (honest)
- **`npm run eval` (deterministic, offline, CI):** gates the Invariant-2 criticals. **Cannot** score answer quality (never calls the model) and **cannot** see the LLM-fallback reply's scope/DIY adherence (Invariant 1). This is the only gate that runs without keys.
- **`npm run eval:ab` (needs API keys, offline):** compares **MODELS** against each other (`ab-compare.ts` → `compareModels(modelIds)`), NOT a candidate prompt vs a baseline prompt.
- **`npm run eval:prompts` / `npm run eval:behavior` (needs keys, offline) — BUILT 2026-06-18:** the prompt-A/B tools this spec called a follow-up. They are the inverse of `eval:ab` (model held fixed, **prompt** varied vs the live `SYSTEM_PROMPT` + any `prompt-variants/*.txt`). `eval:prompts` = generic 1-5 quality; `eval:behavior` = **binary** tuned-behaviors (no-pitch-on-education, offer-on-symptom, defer-specifics) — far less noisy, so prefer it for tuning decisions. Self-judging caveat applies (generation + judge share one model → trust deltas, not absolutes). See `EVAL.md`.
- **LLM-judge (`judge.ts`):** an LLM scoring an LLM — useful signal, but **noisy** (non-deterministic, ~±0.3-0.5 on a 1-5 scale over a ~34-item corpus: 31 golden transcripts + 3 `JUDGE_KNOWLEDGE_PROMPTS`). Treat it as a coarse not-worse check, NOT a precise metric. Do not gate on sub-0.5 deltas — they're noise.
- **Manual transcript review:** the real quality judge for naturalness/voice. A fixed ~10-15 scenario set (happy intake, ambiguous issue, general question, repeat customer, off-scope, hazard, frustrated, deterministic→LLM seam).
- **Production telemetry:** `getBotAnalytics` (`knowledgeAnswerRate`, `extractionCompletionRate`, `outcomeDistribution`, `escalationRate`) + 👍/👎 feedback. **Only meaningful once there's real traffic** — this is a single-tenant demo today, so the "watch booked-rate for a week / roll back" loop is DEFERRED until traffic exists. Don't pretend to measure it at zero volume.

## The loop (demo-phase, honest)
1. **Baseline:** `npm run eval` green; if keys present, snapshot judge scores; capture a manual-review snapshot of the scenario set.
2. **One change at a time** — exactly one style/shape/exemplar edit. (Multi-edits can't be attributed.)
3. **Gate:** `npm run eval` (criticals = 0, mandatory) → manual review of the affected scenarios → judge not-worse (if keys).
4. **Keep or revert:** keep only if manual review reads better AND criticals hold AND it didn't bloat the prompt for nothing. Revert otherwise.
5. **Record** one line in `docs/superpowers/specs/prompt-changelog.md` (a plain markdown changelog — the "versioning" is git + this file, no special tooling): what changed, the read, the date.
6. **(Once real traffic exists)** watch telemetry + feedback; roll back on a sustained regression.

## Active targets (scoped to what moves the needle)
Apply via the loop, one at a time. All edits stay OUT of the frozen safety blocks (Invariant 1).

### T1 — Few-shot exemplars (highest leverage; the prompts are 100% rules today)
**Why:** models imitate demonstrated behavior far better than abstract rules; the known failure modes (robotic openings, repeated empathy, "two-voices" across the deterministic→LLM seam) are exactly what good exemplars fix.
**Risk (do not undersell — flagged by review):** few-shot can cause **parroting** — the model replays the exemplar's surface phrasing on every turn, making it MORE templated (the opposite of the goal). Mitigate: 2-3 exemplars max per persona, each a *different* scenario, and an explicit instruction to **generalize the manner, not copy the words** ("these show the manner; vary your wording — never reuse these sentences verbatim"). Keep them short (token cost; pair with a cut elsewhere to stay token-neutral).
**Concrete exemplars to add** (web; voice gets shorter spoken variants):
- *General answer, helpful-first, soft offer only on a real need:*
  - Customer: "My AC runs but the house stays warm — three weeks now."
  - Bot: "That combination usually points to airflow, low refrigerant, or a struggling compressor — a tech can pinpoint it quickly. Want me to get someone out?"
- *Pure education — NO pitch:*
  - Customer: "How often should I change my filter?"
  - Bot: "Usually every 1-3 months — sooner with pets or allergies. Easiest check: hold it to the light; if you can't see through it, swap it. (Replace, don't wash it.)"
- *Deterministic→LLM seam — continue as the same person, no fresh greeting/empathy restart:*
  - (assistant already greeted + acknowledged) Customer: "and how long does a furnace usually last?"
  - Bot: "Most run 15-20 years with maintenance — yours may vary. Anyway, back to getting you scheduled: what's the best callback number?"
**Measure:** manual review of the seam/repetition/education scenarios; judge `naturalness` not-worse (if keys). Watch specifically for parroting (do replies start reusing the exemplar lines?).

### T3 — Knowledge-answer shape (the new helpful-first capability)
**Why:** "answer completely" with no shape produces either a salesy one-liner-then-pitch or a voice-hostile wall of text.
**Change (style block, NOT a safety block):** "Give a direct, useful answer in 2-4 sentences (1-2 on voice). Add ONE soft booking offer ONLY when the question reveals a real service need (a symptom/fault), never for pure education. **Even when concise, keep the safety hand-off** — if the topic is a licensed-tech job, the 'a tech should handle that' line stays; cut other words first." (The last clause defends against the review's concision-drops-safety tension.) Anchor it with the T1 exemplars (need vs education).
**Measure:** judge `helpfulness`/`naturalness` on `JUDGE_KNOWLEDGE_PROMPTS` (if keys) + manual review; confirm no booking pitch on the pure-education exemplar.

### T4 — Accuracy "defer specifics" positive habit (low cost)
**Why:** `ACCURACY DISCIPLINE` (frozen) *forbids* stating specific specs; this adds the positive *alternative* in the style layer so the model has somewhere to go instead of guessing.
**Change (style layer):** "When you don't know a system-specific fact, give the general truth and hand the specific to a tech ('the exact spec depends on your unit — a tech can confirm'). Never fill a gap with a guessed number, model, or code." (Reinforces, does not weaken, the frozen accuracy rule.)
**Measure:** manual adversarial set of spec-baiting questions ("what refrigerant does my unit use?"); judge `rationale` flags confident-wrong facts (if keys).

## Deferred (explicitly NOT in this pass)
- **T-reorder (move/duplicate hard rules):** rejected — reordering risks editing frozen safety text for marginal position-bias gain at ~775 tokens; not worth the safety risk.
- **T-voice-concision as a separate target:** folded into T3 (the "keep the safety hand-off even when concise" clause), since a standalone concision push fights the safety language.
- **T2 anti-repetition rule rephrase:** subsumed by T1 exemplars (showing beats telling); revisit only if exemplars don't fix repetition.
- **T7 model-config (`/no_think`, temperature):** CUT — not actionable. Verified: `/no_think` is hardcoded in the prompt strings and `provider.ts`/the `streamText`/`generateText` calls expose no temperature or thinking toggle. This needs provider plumbing first; it's a separate model-config task, not prompt tuning.
- ~~**A real `compare-prompts` A/B harness:**~~ ✅ BUILT 2026-06-18 as `eval:prompts` + `eval:behavior` (see Outcome).
- **Production telemetry watch + rollback SOP:** deferred until real traffic exists (zero-traffic demo today).
- **Independent judge model:** the prompt-A/B tools self-judge (one model generates + grades). A second funded model as judge would remove the upward bias. Blocked on a working second key (the GLM key supplied 2026-06-18 was out-of-balance → 429).

## Outcome (executed 2026-06-18)
- **T1 + T3 + T4 shipped** (manner exemplars, answer-shape, defer-specifics) — all outside the frozen safety blocks; presence-guard tests added.
- **Prompt-A/B tooling built:** `eval:prompts` (generic 1-5) and `eval:behavior` (binary tuned-behaviors), plus the shared `eval-llm.ts` generator and the `prompt-variants/` drop-in dir. Degrade-safe; not in the CI gate.
- **Measured finding (the loop working):** the generic 1-5 scores showed "no measurable change" for T1/T3/T4 (deltas inside the ±0.3-0.5 noise floor — confirmed by 0.34 run-to-run variance on the *same* prompt). The **binary** probe instead surfaced a real regression: shipped-T3's "never pitch on a pure-education question" was **unhonored** — the live prompt ended education answers with a booking offer 100% of the time (`edu¬pitch` = 0% every run), confirmed by a manual read.
- **T3 fix shipped + deployed:** rewrote HELPFUL-FIRST as a binary decision rule (pure-education → answer and STOP, no offer / no problem-fishing close; real service need → exactly one soft offer). Measured (qwen self-judged, 3 replications + manual spot-check): `edu¬pitch` 0% → ~83%, `sympOffer` ~17% → ~67%, overall behavioral match ~27% → ~80% — the fixed prompt beat both the old-tuned and pre-tuning prompts on every run.
- **Lesson:** for behavioral/shape tuning, `eval:behavior` (binary) is the trustworthy signal; `eval:prompts` (1-5) is only a coarse not-worse check.

## Principles
Show-don't-tell (exemplars > rules for voice); positive over negative for *style* (hard negatives stay in the frozen safety blocks); one change at a time, criticals-green always; token-neutral-or-shorter; channel-fit (shared knowledge/safety, channel-specific style); **never tune the frozen safety text for quality.**

## Non-goals
RAG/retrieval accuracy; LLM routing; a prompt-editing admin UI / per-tenant prompt overrides; fine-tuning. This is style/shape prompt-text tuning with the safety text held constant.
