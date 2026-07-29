# Chat streaming with guarded flush — design (round 4)

**Date:** 2026-07-29 · **Status:** revised after adversarial rounds 1–3
**Decides:** the deferred streaming-vs-guardrail tradeoff (user-approved 2026-07-29).

## Problem

The chat LLM path calls `streamText` but buffers the entire reply
(`await result.text`, `route.ts:2057`) so `screenAssistantReply` can screen it
before anything shows. Short intake replies (1–2 sentences per the system
prompt) generate in ~1–2s and are fine today; the pain is the long
knowledgeable-assistant answers (HVAC knowledge questions), where the customer
stares at "typing…" for **5–7s**. The client (`TextStreamChatTransport` +
`useChat`) already consumes the `text/plain` response progressively (verified:
raw UTF-8 chunks, no wire framing needed); only the server must change.

**Honest benefit statement (round-2 corrected):** for 1–2-sentence replies the
first-paint gain is ~0–1s (they're already fast); for the multi-sentence
replies that cause the 5–7s waits, first paint drops to ~2–3s. The win
concentrates exactly on the worst case.

## Guarantee

> **No character of any guardrail-matching span is ever shown — including the
> leading half of a match that completes later — and every shown character
> belongs to a complete sentence within a prefix that passed all four checks.**

Accepted delta vs today, stated honestly: on a mid-reply violation the
customer sees earlier complete, jointly-screened sentences plus the safe
fallback instead of fallback-only. Those sentences contain no part of any
match; at most they reveal a topic was being approached before the fallback
redirects. Fallback-only behavior resumes whenever the violation completes
within the first two sentences. The four canned fallbacks were verified clean
under concatenation with any flushed prefix (no `\s+` bridge can cross their
non-whitespace tokens).

## Design — guarded flush: lag rule + tail holdback

**Implementation shape (round-2 corrected):** `guardedFlushStream` in
`src/lib/ai/guarded-stream.ts` returns a **`ReadableStream`** whose `start()`
runs a manual `for await` pull loop over `result.textStream` (verified
`AsyncIterableStream<string>`, ai v6.0.191). NOT a `TransformStream` —
`pipeThrough` cannot drain upstream after downstream closes. The route returns
`new Response(readable, { "content-type": "text/plain; charset=utf-8" })`
immediately; deterministic paths stay byte-identical single-chunk responses.

**Sentence boundary** := position after `.`, `!`, or `?` that is (a) followed
by whitespace or end-of-buffer, (b) NOT preceded by a digit (kills `4.5`,
`$1.50`), plus `\n\n` (paragraph break). A bare `\n` is NOT a boundary.
Whitespace-only segments merge into the previous unit. Abbreviation false
boundaries ("approx. ", "e.g. ") are ACCEPTED cosmetic defects — they can
cause an early flush point, never a bypass (lag + full-text screening below).

**Rule 1 — one-sentence lag:** flush sentence *i* only when sentence *i+1* is
COMPLETE and `screenAssistantReply(accumulated)` — always the FULL accumulated
text — passes. Equivalently: on each new boundary, candidate = text through
the second-newest boundary; screen everything; if clean, emit the candidate
delta. Covers every match that spans ≤1 sentence junction (the round-1
counter-examples `fifty\ndollars`, `$\n89`, `you are\nbooked`,
`top off the\nrefrigerant`, `I am\na licensed…` — all fixtures).

**Rule 2 — terminal-punctuation flush gate (round-3 final form; replaces the
round-2 vocabulary holdback, which round 3 broke for the non-price regexes):**
only flush a candidate whose whitespace-trimmed tail ends in `.`, `!`, or `?`.
Units ending any other way (bare words, colons, list bullets, em-dashes) are
HELD until a later punctuation-terminated boundary extends the candidate, or
until the completion-path full screen releases them.

*Why this is sufficient — VERIFIED against the real regex sources (node
probes, 2026-07-29):* no guardrail match can contain `.`, `!`, or `?` followed
by whitespace. The regexes' gaps are `\s+`/`[\s-]*` (no punctuation); their
atoms are words; the single in-match period is `PRICE_WORD_REGEX`'s decimal
`\d[\d,]*(?:\.\d+)?`, where the period is digit-adjacent on both sides —
probes confirm `"costs 1. 5 thousand dollars"` matches only from `"5"` (a
period + whitespace breaks every match). Therefore a unit ending in terminal
punctuation cannot have a match spanning past its end, and every intermediate
fragment of a multi-junction span (which necessarily ends mid-match, i.e.
unpunctuated) is held. This uniformly covers all four regexes — including
round 3's `Great!\n\nYour appointment\n\nhas\n\nbeen confirmed.` attack
("Your appointment" is unpunctuated → held) — with no vocabulary to maintain.
The digit-guard in the boundary definition independently prevents a boundary
inside `1.5`. Round-2/3 attack traces are MANDATORY test fixtures asserting
ZERO match-span characters emitted: `Great news.\n\nfive\n\nhundred\n\n
thousand\n\ndollars.`, `I am\n\na\n\nlicensed technician`,
`Great!\n\nYour appointment\n\nhas\n\nbeen confirmed.`,
`Great question!\n\nadding\n\nmore\n\nof\n\nthe\n\nrefrigerant`.
Honest cost: bullet/colon-formatted replies stream less (held to completion —
today's behavior); normal prose paragraphs end with punctuation and stream
fine. The shared guardrail regexes are NOT modified (narrowing them would
weaken voice + full-buffer coverage — rejected round-2 suggestion).

**Screening frequency:** screen only when a new boundary appears. With
`maxOutputTokens: 350` that is ≤ ~25 screens of ≤ ~1,400 chars — no
amortization needed.

**On violation:** stop emitting (set a `suppressed` flag; the loop keeps
consuming — this IS the drain, no cancellation, cost identical to today which
always generates fully). After the loop exits, enqueue `\n\n` + the existing
canned fallback (fallback alone when nothing was flushed), then persist, then
close. `logger.warn` with violations as today.

**On clean completion:** screen full text once more; flush remainder
(including held sentences — final-flush semantics == today's full-buffer
screen); persist; close.

**Errors/abort (round-2 corrected):** ALL stream errors are caught INSIDE the
pull loop; the readable is closed normally after persisting — an error must
NEVER propagate to the route's outer catch (which would append `HANDOFF_REPLY`
as a second body and garble the stream). The existing
`abortSignal: AbortSignal.timeout(30_000)` (route.ts:1820) is the stall
defense: on abort (including abort during a violation drain), close at the
last clean flush, NO fallback, persist what was shown with `tokensUsed: 0`
when `result.usage` is unavailable. Screening throws → fail closed: stop,
emit fallback, persist, close.

## Persistence — at loop end, before close (all paths)

Persistence runs at the END of the pull loop (clean, violated-drained, or
error-caught), BEFORE `controller.close()` — so the row commits before the
client observes stream-end: a refresh after a streamed reply finds the row,
and a rapid follow-up reads fresh counts, both same as today. It replicates
today's three-step sequence from route.ts:2072–2091 exactly: (1) insert the
assistant message row with `tokensUsed: tokensThisCall`, (2) compute the new
total via `addTokenUsage(session.tokensUsed, tokensThisCall,
session.tokenBudget)`, (3) update the session row's `tokensUsed` +
`turnCount`. Persist the loop's emitted text (`flushed` [+ fallback]) — NEVER
`result.text`, which contains suppressed violating content. On the clean/drain
paths `result.usage` is resolved when the loop exits; on error paths record 0.

**Client disconnect:** `cancel()` only sets a flag that stops `enqueue` calls
(enqueue-after-cancel throws) — the pull loop itself is driven by the MODEL
stream, not client consumption, so it continues to completion and persists
normally. To keep the serverless runtime alive past the response, the route
registers the loop's completion promise with `after(completionPromise)` at
stream creation (promises register with waitUntil immediately). No
`after()`-inside-`cancel()` and no ALS-context uncertainty. Documented delta:
the transcript records what the server decided to show; a disconnecting
client may have received less (inherent to streaming); on a violation this
may include a fallback the client never rendered — the transcript is server
truth.

**`after()` keeps exactly today's contents** — extraction, compaction,
telemetry (none consume reply text; verified). Their trigger ("stream
consumed") is the same wall-clock moment as today's post-generation
response-return; the round-1 "+7s extraction delay" claim was rejected on
this basis.

## Client — no code changes

Verified round 1: transport streams progressively; typing indicator clears on
first delta; post-stream `/api/session` polling reads only status/metadata
(in-memory messages carry the reply). **Auto-scroll pins to the START of the
assistant reply and does not follow growth — deliberate shipped behavior**
(reader starts at the top; no per-delta jank).

## Unchanged surfaces (hard constraints)

Deterministic paths byte-identical · voice untouched (`generateText`, own
screening) · zero prompt changes; FROZEN safety text untouched · shared
guardrail regexes untouched · widget shares `use-chat-session` (visual verify
only). **Nothing is appended to LLM replyText after screening** (verified:
`ESCALATION_NOTE` is deterministic-path-only; LLM path gets `escalationHint`
via system prompt; `empathyShown` is metadata) — the auditable basis of
shown == persisted; adding a post-screen append is a spec violation.

## Testing

- Unit (pure, no jsdom) for `guardedFlushStream(textStream, screen,
  fallbackFor, persist)`: lag math; digit boundary guard; whitespace-segment
  merging; the FIVE round-1 fixtures (leading half never emitted); the FOUR
  round-2/3 multi-paragraph fixtures (`Great news.\n\nfive\n\nhundred\n\n
  thousand\n\ndollars.`; `I am\n\na\n\nlicensed technician`;
  `Great!\n\nYour appointment\n\nhas\n\nbeen confirmed.`;
  `Great question!\n\nadding\n\nmore\n\nof\n\nthe\n\nrefrigerant` — assert
  ZERO match-span chars emitted for all four); violation-in-first-two-sentences →
  fallback only; clean reply → emitted == input; screening-throw fail-closed;
  abort mid-stream → close at last flush, no fallback; abort during violation
  drain → same; unpunctuated-tail units held then released clean at
  completion (bullet-list reply streams at end, content intact).
- Route-level (mock model stream), per-path persisted-content expectations:
  clean → row == full text; violated → row == cleanPrefix + "\n\n" + fallback
  (== streamed concatenation); aborted → row == flushed prefix only, no
  fallback. Ordering assertion: row committed before stream close.
- Full gate: tsc, lint, complete vitest (3,985/1skip baseline); prod probe
  post-deploy: first-paint timing on a long knowledge question, a
  forced-violation prompt, refresh-after-reply shows the message.

## Out of scope

Voice streaming; SSE migration; auto-follow scrolling; guardrail-regex
changes; per-check severity tiers; streaming deterministic replies;
placeholder-row schemes.
