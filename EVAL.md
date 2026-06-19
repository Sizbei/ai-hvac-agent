# Conversation-Quality Eval Harness

Makes bot quality **measurable** and **regression-gated** (CHATBOT-PLAN Steps 8
& 9). Three tools:

1. **Deterministic eval** — runs fully offline, gates CI. Replays labeled golden
   transcripts through the pure router (`routeMessage`) + guardrails
   (`sanitizeInput`) and asserts safety/quality properties **without any LLM, DB,
   or network**.
2. **LLM-judge + model A/B** — optional, degrade-safe. Scores the same corpus
   with a live model and compares two registry **models** (replies held fixed).
3. **Prompt A/B** — optional, degrade-safe. Holds the **model** fixed and varies
   the **system prompt** (the inverse of model A/B), to measure what a prompt
   edit does: generic quality (`eval:prompts`) and binary tuned-behaviors
   (`eval:behavior`).

The optional tools (2 & 3) run **only** when model keys are present; they never
throw and never block.

## Files

| File | Role |
| --- | --- |
| `src/lib/ai/eval/golden-transcripts.ts` | The labeled corpus (30 transcripts) + expected properties. |
| `src/lib/ai/eval/run-eval.ts` | Deterministic runner — replays turns, computes checks, returns a scored report. |
| `src/lib/ai/eval/eval.test.ts` | CI gate — asserts **zero critical failures** offline. |
| `src/lib/ai/eval/judge.ts` | Optional LLM judge (naturalness / helpfulness / completion) + `JUDGE_KNOWLEDGE_PROMPTS` corpus. Degrade-safe. |
| `src/lib/ai/eval/ab-compare.ts` | Model A/B across the registry (judge scores + tokens + latency). Degrade-safe. |
| `src/lib/ai/eval/eval-llm.ts` | Shared single-turn generation helper for the prompt-A/B tools. Degrade-safe. |
| `src/lib/ai/eval/compare-prompts.ts` | Prompt A/B — generic 1–5 quality across prompt variants (model fixed). Degrade-safe. |
| `src/lib/ai/eval/behavior-probe.ts` | Prompt A/B — binary tuned-behaviors (no-pitch-on-education, offer-on-symptom, defer-specifics). Degrade-safe. |
| `src/lib/ai/eval/prompt-variants/` | Drop a full-prompt `*.txt` here to A/B it vs the live baseline (git-ignored; see its README). |
| `src/lib/ai/eval/cli.ts` | CLI entrypoint for `eval` / `eval:ab` / `eval:prompts` / `eval:behavior`. |

## Running

```bash
npm run eval          # deterministic only — OFFLINE, no keys. Exits non-zero on
                      # any CRITICAL failure (same gate as the unit suite).

npm run eval:ab       # Model A/B across the registry. Needs AI_API_KEY and/or
                      # GLM_API_KEY; any model without its key is reported
                      # "skipped". Always prints the deterministic baseline and
                      # exits 0 (it's a report, not a gate).

npm run eval:prompts  # Prompt A/B — generic 1–5 quality. Baseline = live
                      # SYSTEM_PROMPT vs any *.txt in prompt-variants/. Holds the
                      # model fixed. Degrade-safe; exits 0.

npm run eval:behavior # Prompt A/B — binary tuned-behaviors (far less noisy than
                      # the 1–5 scores). Same variant set. Degrade-safe; exits 0.
```

The deterministic gate also runs inside the normal unit suite:

```bash
npm run test:unit     # includes src/lib/ai/eval/eval.test.ts
```

## What the deterministic eval gates

Per transcript, the runner computes checks. **Critical** checks fail CI hard;
the rest guard against silent quality erosion (aggregate score must stay ≥ 95%).

| Check | Critical | Asserts |
| --- | --- | --- |
| `pricing-leak` | ✅ | No served reply contains a committed `$N` price. |
| `false-booking` | ✅ | No served reply claims booked / scheduled / confirmed. |
| `emergency-escalation` | ✅ | An emergency transcript short-circuits to escalation. |
| `injection-block` | ✅ | A hard-injection turn hard-blocks (never reaches a served reply). |
| `expected-action` / `expected-intent` | — | Final-turn router verdict matches the label. |
| `reach-submit` | — | A normal intake reaches a SUBMIT-ready state. |
| `account-recognition` | — | Identity-gated reads are recognized as `ACCOUNT_LOOKUP`. |
| `re-ask-loop` | — | No slot is asked more than its `maxReAsk` limit. |

Corpus categories: emergency, intake, pricing-pressure, account-identified,
account-unidentified, injection, faq, compound, reschedule, scheduling,
ambiguity, off-scope, safety-guardrail.

## How the judge / A/B degrade without keys

The judge and every A/B runner (model and prompt) check
`process.env[entry.apiKeyEnv]` before calling a model:

- **No key for a model** → that model is reported `skipped: API key not
  configured`; it contributes no judge scores.
- **No keys at all** → `npm run eval:ab` prints the deterministic baseline plus a
  "skipped" row per model and exits 0.
- **A model call errors** → the judge returns `null` scores with the error in its
  `note`; the run continues.

The deterministic scores are model-independent (`routeMessage` is pure), so they
are the shared baseline; the A/B axis is purely the judge's view of the same
served replies per model, plus token cost and latency.

## Prompt A/B (`eval:prompts`, `eval:behavior`)

Model A/B (`eval:ab`) holds the replies fixed and varies the **model**. Prompt
A/B is the **inverse**: it holds the model fixed (one model for **both**
generation and judging) and varies the **system prompt**, so it measures what a
prompt edit actually does to the LLM-path answers — the thing the deterministic
eval can't see (it never calls the model).

**Variants.** The baseline is the live `SYSTEM_PROMPT`. Drop a full system prompt
into `src/lib/ai/eval/prompt-variants/<label>.txt` (git-ignored) and it's A/B'd
against the baseline. To compare against a historical prompt, dump it from a git
worktree, e.g. `git worktree add /tmp/old <ref>` then `tsx` a one-liner that
imports and prints `SYSTEM_PROMPT`.

**Two scorers:**

- `eval:prompts` — generic judge scores (naturalness / helpfulness / completion)
  on the `JUDGE_KNOWLEDGE_PROMPTS` corpus, with a signed Δ-vs-baseline row.
- `eval:behavior` — **binary** behaviors the prompt tuning targets, scored as
  match-rates: `edu¬pitch` (a pure-education question must NOT end in a booking
  offer), `sympOffer` (a real symptom SHOULD get one), `specDefer` / `spec¬guess`
  (defer a unit-specific spec, never state a number as fact).

**Why two.** Binary behavior rates replicate across runs; the 1–5 quality scores
are too noisy (≈ ±0.3–0.5 over this small corpus) to detect a behavioral change.
Prefer `eval:behavior` for tuning decisions and `eval:prompts` for a coarse
"not-worse" sanity check.

**Caveats (printed in the footer too):**

- **Self-judging** — generation and judging share one model, so absolute scores
  skew high. Trust the **inter-variant delta**, not the raw numbers. An
  independent judge (a second funded model) removes this.
- **Small corpus** — a few prompts; treat sub-0.5 score deltas as noise.
- **Safety is NOT measured here** — it stays gated by the deterministic `eval`.
  Per the *frozen-safety-text* rule, tune only style/voice/shape text; never
  weaken the SCOPE / ACCURACY / DANGEROUS-DIY / HAZARD blocks in a candidate.

**Worked example (2026-06-18).** `eval:behavior` caught that the shipped T3
"never pitch on a pure-education question" was unhonored — the live prompt ended
education answers with a booking offer 100% of the time (`edu¬pitch` = 0% every
run), a regression the generic scores rated "no measurable change." Sharpening
T3 into a binary decision rule moved `edu¬pitch` 0% → ~83% and overall behavioral
match ~27% → ~80% (verified across 3 replications + a manual read).

## Adding a golden transcript

1. Open `src/lib/ai/eval/golden-transcripts.ts`.
2. Append a `GoldenTranscript` with a **unique `id`**, a `category`, realistic
   `userTurns`, and an `expect` block pinning only the load-bearing properties
   (don't over-pin — keep it a meaningful gate, not a brittle snapshot).
3. Add it to the `GOLDEN_TRANSCRIPTS` array at the bottom.
4. Run `npm run eval` and `npm run test:unit` — both must stay green.

For an **intake** transcript that should reach SUBMIT, the final turn must
re-state the issue alongside the address (the router is a per-message pure
function: SUBMIT promotion fires when a message matches an intent *and* all
required slots — issueType, urgency, address — are present).
