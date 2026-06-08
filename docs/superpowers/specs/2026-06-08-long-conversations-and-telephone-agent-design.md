# Long-conversation flow + Telephone agent channel — Design

Date: 2026-06-08
Status: Approved (proceeding to implementation)

## Goal

1. **Longer conversations** — keep conversations coherent past the current
   `MAX_HISTORY = 10` sliding window without unbounded token growth, and raise
   the practical turn/budget ceilings.
2. **Telephone sub-agent** — a runtime in-app agent persona tuned for voice
   (phone) conversations, sharing the existing extraction/router/state-machine
   core rather than forking it.
3. **Admin visibility** — phone conversations and the running summary are
   visible in the existing admin Conversations view.

## 1. Longer conversations (compaction + higher caps)

### Compaction
- New nullable column `running_summary TEXT` on `customer_sessions`.
- A `summarizeOlderTurns()` helper (`src/lib/ai/compaction.ts`) takes the prior
  running summary + the turns about to fall out of the window and produces a new
  running summary via the extraction-tier model (`getExtractionModel()`).
- The chat route, in its `after()` background task, when
  `history.length > COMPACTION_THRESHOLD`, summarizes everything older than the
  last `MAX_HISTORY` turns into `running_summary`. Idempotent: it folds the prior
  summary into the new one, so re-running never loses earlier facts.
- The LLM context becomes: `system + [running summary, if any] + last
  MAX_HISTORY turns + current message`. A pure helper
  `buildModelMessages({ runningSummary, recent, current })` constructs this and
  is unit-tested.
- Runs in `next/server` `after()` (never a detached promise — Vercel freezes the
  function once the response closes).

### Higher caps
- Raise `DEFAULT_MAX_TURNS` (15 → 40) and `TOKEN_BUDGET_MAX` (200k → 500k);
  `MAX_TURNS_MAX` stays 100. Per-org `chatMaxTurns` / `chatTokenBudget` already
  override these. Compaction is what makes the higher caps affordable.

## 2. Telephone sub-agent (runtime persona)

- New column `channel` on `customer_sessions`: enum `('web','phone')`, default
  `'web'`. All existing rows are web.
- `src/lib/ai/phone-agent.ts`:
  - `PHONE_SYSTEM_PROMPT` — a voice-tuned variant: no markdown, no "tap a
    button", spoken-friendly confirmations, spells back address/phone, keeps
    replies to one short spoken sentence.
  - `selectSystemPrompt(channel)` — returns the phone or web prompt.
  - `voiceReply(...)` — runs a phone turn through the SAME routing/extraction/
    slot/state-machine core used by web, returning the spoken reply + next state.
- The phone persona is a thin wrapper over the proven core; it does not
  re-implement intent routing or extraction.

## 3. Twilio voice integration

- `POST /api/voice/incoming` — TwiML webhook for an inbound call.
  - Validates the `X-Twilio-Signature` (HMAC-SHA1 of the full URL + sorted POST
    params using `TWILIO_AUTH_TOKEN`); invalid/missing → 403.
  - Creates a `phone` session (reusing the org-resolution + limit-stamping logic
    of the existing session route, attributed to the demo org).
  - Returns TwiML: `<Say>` greeting + `<Gather input="speech"
    action="/api/voice/gather">`.
- `POST /api/voice/gather` — receives `SpeechResult` + `CallSid`.
  - Same signature validation.
  - Loads the phone session (by a `CallSid`→token mapping stored in session
    metadata), persists the user turn, runs `voiceReply`, persists the assistant
    turn, returns TwiML `<Say>` + next `<Gather>`. On terminal/confirmed state,
    `<Say>` a closing line + `<Hangup>`.
- TwiML generation lives in `src/lib/voice/twiml.ts` (pure string builders, unit
  tested). Signature validation in `src/lib/voice/twilio-signature.ts` (pure,
  unit tested).
- Env-gated config in `src/lib/voice/config.ts`: reads `TWILIO_AUTH_TOKEN`,
  `TWILIO_ACCOUNT_SID`. Missing token → signature validation fails closed.

## 4. Admin view

- `ConversationSummary` + `ConversationDetail` gain `channel: 'web' | 'phone'`
  and `runningSummary: string | null` (detail only).
- `conversation-queries.ts` selects `channel` (+ `runningSummary` in detail).
- Conversations table gets a **Channel** badge column (Web / Phone).
- A channel filter (All / Web / Phone) alongside the status filter; the
  `ConversationFilters` type + query gain an optional `channel`.
- Detail sheet shows the running summary (when present) in a labelled block.

## Data flow

```
Inbound call → /api/voice/incoming (verify sig) → create phone session → TwiML <Gather speech>
   → caller speaks → /api/voice/gather (verify sig) → persist user turn
     → voiceReply (router/extraction/state-machine core) → persist assistant turn
     → TwiML <Say> + <Gather> (or <Hangup> on terminal)
Admin → /admin/conversations → table (channel badge, channel filter)
     → detail sheet (transcript + running summary)
```

## Error handling
- Twilio webhooks: bad signature → 403; processing error → a graceful TwiML
  `<Say>` apology + `<Hangup>` (never a 500 the caller hears as dead air).
- Compaction failure in `after()` is logged and swallowed (matches existing
  background-extraction error handling); the conversation continues uncompacted.

## Testing (TDD, 80%+ target)
- Unit: `buildModelMessages`, `summarizeOlderTurns` (mock model),
  `selectSystemPrompt`, `voiceReply` routing, `twiml` builders,
  `twilio-signature` validation, `chat-limits` new bounds, state-machine
  unaffected.
- Integration: conversation-queries channel select + filter.
- Existing chat + session tests must stay green.

## Out of scope
- External STT providers (using Twilio's built-in speech recognition).
- Outbound calling, call recording storage, multi-org phone-number routing.
