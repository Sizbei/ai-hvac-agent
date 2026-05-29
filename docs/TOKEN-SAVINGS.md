# Token-Cost Savings Analysis — AI HVAC Intake Assistant

> Research output (cost-optimization subagent). Drives the optimization work in
> [COMMON-QUESTIONS-PLAN.md](./COMMON-QUESTIONS-PLAN.md). All token figures are
> estimates (1 token ≈ 4 chars) with assumptions stated inline.

## Executive Summary

The chat endpoint makes **2 LLM calls per user turn** (one `streamText` for the reply, one
`generateObject` for extraction in `onFinish`), and **both prepend the full ~504-token system
prompt and re-send the entire growing conversation history**. The extraction call is the single
biggest waste: it fires on *every* turn (even turn 1 when there is nothing to extract), re-sends an
even larger ~571-token system, and is **currently failing with JSON parse errors against
DashScope**, so it burns input tokens for zero value.

**Top 3 wins by impact:**

1. **Deterministic intent / slot-filling router to skip the LLM entirely** for FAQ and
   slot-collection turns. Trivial Q&A and "give me your address" turns can drop to **~0 LLM
   tokens**. Headline win — this is what the knowledge-base router delivers.
2. **Stop running extraction every turn** (`route.ts:208`). Gate it to run **once at confirmation
   time** (or behind cheap heuristics). Eliminates ~1 of the 2 calls per turn — roughly a
   **40–50% cut in total tokens per conversation** — and stops paying for a call that currently
   fails anyway.
3. **Trim + cache the system prompt and cap history.** The ~504-token system prompt is re-sent on
   every call (≈1,000 tokens/turn across both calls), and full-history re-send makes token cost
   grow **quadratically** with conversation length. Trimming ~50% plus a sliding history window
   bounds growth.

## Per-Turn Cost Model (assumptions stated)

Assumptions: 1 token ≈ 4 chars. System prompt = **2,015 chars ≈ 504 tokens**
(`system-prompt.ts`). Extraction system (`SYSTEM_PROMPT` + `EXTRACTION_INSTRUCTION`) =
**2,283 chars ≈ 571 tokens**. Avg user+assistant message ≈ 40 tokens; extraction schema overhead
≈ 150 tokens output.

Per user turn at turn *N* (history ≈ 2N prior messages ≈ 80N tokens):

| Call | Site | Input re-sent | Approx input tokens at turn N |
|---|---|---|---|
| `streamText` (chat) | `route.ts:158–167` | system 504 + full history + new msg | 504 + 80N + 40 |
| `generateObject` (extraction) | `extract.ts:40–45` (from `route.ts:208`) | system 571 + full history + new msg + schema | 571 + 80N + 40 + ~80 |

**Both calls re-send the full history independently.** Over a 10-turn conversation, history
re-sending alone is ≈ `2 × 80 × (1+…+10)` ≈ **8,800 redundant history tokens**, plus
`2 × ~537 × 10 ≈ 10,740 tokens` of repeated system prompt. A 10-turn chat can consume
**20k–30k input tokens** — but the per-session budget is only 10k (`token-budget.ts`), so long
chats hit the wall fast, mostly on waste.

## Priority-Ordered Strategy Table

| # | Strategy | Problem (file:line) | Est. savings | Effort | Risk |
|---|---|---|---|---|---|
| 1 | Deterministic intent/FAQ/slot router | All turns hit LLM; `route.ts:158`, `route.ts:208` | 50–90% of turns → ~0 tokens | L | Misclassification; need LLM fallback |
| 2 | Gate / defer extraction | `route.ts:208`, `extract.ts:40` runs every turn, currently failing | ~40–50% of total tokens | S–M | Slightly later state transition |
| 3 | Trim SYSTEM_PROMPT | `system-prompt.ts` (504 tok) re-sent both calls | ~250 tok/call → ~500 tok/turn | S | Behavior drift; re-test prompt |
| 4 | Cap conversation history (sliding window) | `route.ts:161–167`, `extract.ts:28–34` re-send all history | Caps quadratic growth | S–M | Loses early context |
| 5 | Cheaper model + max_tokens for extraction | `provider.ts:10`, `extract.ts:40` (one model for both) | ~50–70% cost on extraction call | S | qwen-turbo lower quality |
| 6 | Enforce response length via maxTokens | `route.ts:158` no output cap | Caps runaway output | S | Truncation if too low |
| 7 | Prompt/context caching (verify support) | system re-sent every call | Up to ~50% on cached input (if supported) | M | DashScope support uncertain |
| 8 | Right-size token budget + early exit | `token-budget.ts`, `route.ts:84` | Prevents overspend | S | UX if cut off early |

## Detailed Strategies

### 1. Deterministic intent / FAQ / slot-filling router (HEADLINE)
Before calling the LLM, run a deterministic router: FAQ match → canned answer (**0 LLM tokens**);
slot-collection state → templated prompt for the next missing required field (**0 LLM tokens**);
deterministic slot extraction via regex (phone `\d{3}[-.\s]?\d{3}[-.\s]?\d{4}`, email, street
heuristics); **fall back to the LLM** only for open-ended HVAC problem descriptions. If 50–90% of
turns are FAQ/slot turns, total LLM tokens per conversation drop **50–90%**. Mitigate misrouting
with conservative thresholds and an always-available LLM fallback.

### 2. Gate or defer extraction — stop running it every turn
`route.ts:208` calls `extractServiceRequest` on **every** turn; on turn 1 there's nothing to
extract. Per the current bug, `generateObject` fails against DashScope, so it burns input every
turn for zero output (silently caught at `route.ts:236`). Fix: replace per-turn LLM extraction with
deterministic slot-filling from strategy 1, and call the LLM extractor **only once at confirmation
time**; or gate behind cheap heuristics (≥3 turns, or regex detects address + a contact field).
Eliminates ~1 of 2 calls on most turns → **~40–50%** of total tokens.

### 3. Trim the SYSTEM_PROMPT
504 tokens prepended to **both** calls every turn (~1,000 system tokens/turn). Condense the
greeting block, urgency examples, and style bullets to terse directives; target ~250 tokens. Keep
`/no_think` — it disables Qwen chain-of-thought, a real **output-token** saver. Savings
~500 tokens/turn (~5,000 over a 10-turn chat).

### 4. Cap conversation history (sliding window)
Both calls re-send the entire history (`route.ts:161–167`, `extract.ts:28–34`) → quadratic growth.
Send only the last K messages (e.g. K=6) plus system; optionally keep a short running summary (the
extracted slots are a natural summary). Always inject current known slots so key facts survive
truncation.

### 5. Cheaper model for extraction + right-size output
`getModel()` (`provider.ts:10`) returns one model for both chat and extraction. Extraction is a
mechanical JSON task — point it at **qwen-turbo/flash** via a separate env var, with tight
`maxTokens` (~150–200). ~50–70% cost reduction on that call.

### 6. Enforce response length via maxTokens on the chat call
`streamText` (`route.ts:158`) has no output cap though the prompt requests "2–3 sentences." Add
`maxTokens: ~150`. Output tokens are usually the costlier side.

### 7. Prompt / context caching (VERIFY before relying on it)
Anthropic-style `cache_control` is **not** in the OpenAI-compatible surface this app uses
(`@ai-sdk/openai` via DashScope). DashScope advertises an automatic context cache for Qwen, but its
availability via `/compatible-mode/v1` + `qwen-plus` + the current provider version is **not
confirmable from code** — verify against primary docs. If supported, keep the system prompt +
stable prefix byte-identical and first; don't mutate the system string with `escalationHint`
(`route.ts:152–160`) — append it as a trailing message instead.

### 8. Right-size token budget + early exit
Flat 10k budget checked only at entry (`route.ts:84`). After strategies 1–5, the same budget goes
much further. Add a soft early-exit: at ~80% used (`percentUsed` already computed) steer toward
confirmation/escalation instead of hard-failing at 100%. Track chat vs extraction tokens separately
to catch regressions.

## Additional Findings
- **No `maxTokens` on either call** — output unbounded on both (strategies 5–6).
- **`escalationHint` mutates the system string** (`route.ts:152–160`) — defeats prefix caching;
  append as a trailing message.
- **`provider.ts` defaults to Ollama/`qwen3:8b`** but `.env.local` overrides to DashScope/`qwen-plus`;
  the single shared `getModel()` blocks per-purpose model selection (strategy 5).
- **Security (out of cost scope):** `.env` contains a live `DASHSCOPE_API_KEY=sk-...` in the working
  tree. Confirm it's gitignored and not pushed; rotate if exposed.
