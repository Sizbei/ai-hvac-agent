---
name: page-chat
description: Use when working on /chat, /chat/success, or /embed — the customer chatbot surface (streaming, guarded-flush safety layer, session polling, embed variant).
---

# Chat (/chat · /chat/success · /embed)

**Purpose:** the customer-facing AI intake chatbot. Captures service details, routes
emergencies, and on submission creates a service request and navigates to the success
confirmation (or shows an inline confirmation in the embed).

**Files:** pages `src/app/chat/page.tsx` · `src/app/chat/success/page.tsx` ·
`src/app/embed/page.tsx` · experience
`src/components/chat/chat-experience.tsx` · session hook
`src/hooks/use-chat-session.ts` · chat API `src/app/api/chat/route.ts` ·
session API `src/app/api/session/route.ts` ·
guarded-flush layer `src/lib/ai/guarded-stream.ts` ·
output guardrail `src/lib/ai/output-guardrail.ts` ·
voice parity `src/lib/ai/voice-turn.ts` ·
account-verify gate `src/lib/ai/account-verify.ts` ·
history API `src/app/api/chat/history/route.ts` ·
end-state mapping `src/lib/chat/chat-end-state.ts` (pure) + panel
`src/components/chat/chat-end-panel.tsx` · failure copy
`src/lib/chat/chat-turn-feedback.ts` (pure) · widget loader
`src/app/widget.js/route.ts` + close contract `src/lib/widget/widget-messages.ts`

**Data flow:** `useChatSession` wraps `useChat` (Vercel AI SDK) via
`TextStreamChatTransport`. On first render it POSTs `/api/session` to create or resume
a session, then polls session state to track `extraction` (filled slots) and `status`
(state machine). Messages stream from `/api/chat`. On submit, `/api/session/confirm`
creates the service request and returns `referenceNumber` + optional `arrivalWindowLabel`.
The embed variant (`/embed`) receives a publishable widget key via `?key=pk_live_…` and
shows an inline confirmation instead of navigating.

**Invariants (CRITICAL — violate = safety regression):**
- **Guarded-flush layer** (`src/lib/ai/guarded-stream.ts`): implements a one-sentence
  lag + terminal-punctuation gate before any streamed content reaches the client. The
  rule: `flushableLength` requires ≥2 boundaries and the candidate must end in `.!?`.
  On a guardrail violation the full flagged text is suppressed and a safe replacement
  is emitted. The stream is always drained even after a violation (no early abort) and
  `persist()` is called on EVERY path.
- **Guardrail regexes** (`src/lib/ai/output-guardrail.ts`) are the FROZEN single
  source of truth: `PRICE_REGEX`, `PRICE_WORD_REGEX`, `FALSE_BOOKING_REGEX`,
  `DANGEROUS_DIY_REGEX`, `CREDENTIAL_REGEX`. The offline eval imports these exact
  regexes; changing their shape breaks the CI safety gate. Do NOT alter regex shapes.
- `screenAssistantReply` is pure + deterministic — keep it that way (no I/O).
- **Voice parity rule:** `src/lib/ai/voice-turn.ts` is "a voice persona over the
  proven core, not a second brain." Any change to chat logic (intent routing,
  extraction, state machine, after-hours, safety) usually also needs a parity check
  in voice-turn.ts and the shared modules it delegates to.
- The success page copy must be conditional on `arrivalWindowLabel`: only show a
  confirmed window when one was actually reserved — never promise a time for a soft
  booking (the `?window=` param is absent on soft bookings).
- **Account-data verify gate** (`src/lib/ai/account-verify.ts`): `requiresVerify`
  treats EVERY `account-data-*` intent (balance, membership-status, next-visit,
  appointment-status, reschedule) plus the legacy aliases (`account-check-status`,
  `account-change-appointment`, `scheduling-reschedule`) as needing the ZIP-verify
  challenge — a self-reported phone/email that linked the session is not possession
  proof. `GET /api/chat/history` gates on the same verify state (only `status ===
  'passed'` returns real sessions; anything else gets an empty list) — the
  contact-field match that sets `customerId` is not enough on its own. Voice
  inherits both via the shared module. `requiresVerify` returns false for any
  id NOT in `INTENT_SENSITIVITY` — an UNSAFE default — so every id in
  `account-dispatch.ts`'s `LEGACY_ACCOUNT_INTENT_TOOL` must also appear there.
  `src/lib/ai/account-verify.contract.test.ts` fails if the two ever drift, which
  is what makes the unsafe default tolerable. Add a capability, add a gate.

**Closed-chat and failure UX (customer must never hit a dead end):**
- `chatEndActions({status, urgency, phone})` decides what a non-active chat
  offers. Escalated → persistent panel (emergency when the polled extraction's
  urgency is `emergency`, else hand-off) with the org phone as `tel:`; with no
  phone, the emergency panel shows `EMERGENCY_GENERIC_GUIDANCE`. "Talk to a
  human" becomes "Call us" (tel) or focuses the panel — never disabled while
  escalated. The input is hidden in terminal states and the reason
  (`inputNote`) shows above "Start a new conversation" — the chat route still
  refuses messages for escalated sessions (`isTerminalState`), so the
  deterministic escalation's "what's the address/phone?" ask is answered by
  calling, not typing.
- GET and POST `/api/session` return `companyName` + `companyPhone` (from
  `getRouterConfig`, memoized). The header falls back to "Chat with us",
  never another org's name; the escalation dialog shows only the org's phone.
- Empty reply (HTTP 200, no text — e.g. the provider errored and `streamText`
  ended empty): `isEmptyReply` → `emptyReplyFallback` bubble with Try again
  (`regenerate()`) / Call. Blank assistant bubbles are not rendered. Fixed in
  the UI on purpose: `guarded-stream.ts` stays untouched.
- Failed sends: the AI SDK's `error.message` is the raw JSON envelope — always
  map through `chatErrorCopy` (restart for NO_SESSION/terminal, retry
  otherwise). Session start errors use `sessionStartErrorCopy(status)`.
- Chat session creation has its own limit `RATE_LIMITS.chatSessionCreate`
  (15/min/IP); `sessionCreate` (5/min) still guards the login routes.
- Widget: the loader opens `/embed?widget=1&key=…`; with `widget=1` the
  embed header shows an X and Esc (unless a dialog is open) posts
  `WIDGET_CLOSE_MESSAGE` to the parent; the loader accepts it only from
  `APP` origin + its own iframe. On phones the panel is `100dvh` and the
  launcher hides while open. `tests/api/widget-loader.test.ts` pins this.

**Gotchas:**
- `/embed` is wrapped in `<Suspense>` to prevent prerender errors from `useChat`'s
  `Math.random()` calls during Next.js build — do not remove it.
- `safeEnqueue` / `safeClose` swallow `ReadableStream` errors after client
  disconnect; the loop keeps draining so the model response is always persisted.
- The widget key (`?key=`) is forwarded by the chat-session hook to `/api/session`;
  it is NOT an admin session.

**Verify changes:**
- `npx vitest run src/lib/ai/guarded-stream.test.ts src/lib/ai/guarded-stream.route-wiring.test.ts`
- `npx vitest run src/lib/ai/output-guardrail.test.ts src/lib/ai/guardrails.test.ts`
- `npx vitest run src/lib/ai/state-machine.test.ts src/lib/ai/intent-router.test.ts`
- `npx vitest run src/lib/chat tests/api/widget-loader.test.ts`
- Gate: `npx tsc --noEmit`
