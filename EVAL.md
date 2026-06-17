# Conversation-Quality Eval Harness

Makes bot quality **measurable** and **regression-gated** (CHATBOT-PLAN Steps 8
& 9). Two layers:

1. **Deterministic eval** — runs fully offline, gates CI. Replays labeled golden
   transcripts through the pure router (`routeMessage`) + guardrails
   (`sanitizeInput`) and asserts safety/quality properties **without any LLM, DB,
   or network**.
2. **LLM-judge + A/B** — optional, degrade-safe. Scores the same corpus with a
   live model and compares two registry models. Runs **only** when model keys
   are present; never throws, never blocks.

## Files

| File | Role |
| --- | --- |
| `src/lib/ai/eval/golden-transcripts.ts` | The labeled corpus (21 transcripts) + expected properties. |
| `src/lib/ai/eval/run-eval.ts` | Deterministic runner — replays turns, computes checks, returns a scored report. |
| `src/lib/ai/eval/eval.test.ts` | CI gate — asserts **zero critical failures** offline. |
| `src/lib/ai/eval/judge.ts` | Optional LLM judge (naturalness / helpfulness / completion). Degrade-safe. |
| `src/lib/ai/eval/ab-compare.ts` | A/B across registry models (judge scores + tokens + latency). Degrade-safe. |
| `src/lib/ai/eval/cli.ts` | CLI entrypoint for `npm run eval` / `npm run eval:ab`. |

## Running

```bash
npm run eval          # deterministic only — OFFLINE, no keys. Exits non-zero on
                      # any CRITICAL failure (same gate as the unit suite).

npm run eval:ab       # A/B comparison across registry models. Needs AI_API_KEY
                      # and/or GLM_API_KEY; any model without its key is reported
                      # "skipped". Always prints the deterministic baseline and
                      # exits 0 (it's a report, not a gate).
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
account-unidentified, injection, faq, compound, reschedule.

## How the judge / A/B degrade without keys

Both the judge and the A/B runner check `process.env[entry.apiKeyEnv]` before
calling a model:

- **No key for a model** → that model is reported `skipped: API key not
  configured`; it contributes no judge scores.
- **No keys at all** → `npm run eval:ab` prints the deterministic baseline plus a
  "skipped" row per model and exits 0.
- **A model call errors** → the judge returns `null` scores with the error in its
  `note`; the run continues.

The deterministic scores are model-independent (`routeMessage` is pure), so they
are the shared baseline; the A/B axis is purely the judge's view of the same
served replies per model, plus token cost and latency.

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
