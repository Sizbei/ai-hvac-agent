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
voice parity `src/lib/ai/voice-turn.ts`

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
- Gate: `npx tsc --noEmit`
