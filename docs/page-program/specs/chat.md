# chat — target-state spec

`/chat` · `/chat/success` · `/embed` — the customer-facing AI intake chatbot.

## 1. Purpose

Let an HVAC customer (or a contractor's website visitor, via the embedded
widget) describe their problem in plain language and end up with a submitted
service request — captured name/phone/address/issue/urgency — routed to a
human when the bot can't safely finish the job (emergency, jailbreak attempt,
do-not-service flag, budget/turn exhaustion). One job: turn a free-text
conversation into a request a dispatcher can act on, without ever fabricating
a price, a booking, or a credential.

## 2. Brainstorm

Considered, and what shipped or got cut:

- **Streaming replies with a safety net** — shipped (`guarded-flush` +
  `output-guardrail`). Necessary: an LLM-fallback turn is free text, and the
  bot's two hard promises (no price, no false booking) can't rely on the
  system prompt alone. verified.
- **Deterministic router before the LLM** — shipped (`intent-router` +
  `triage`). Rejected alternative: LLM-only turns. Reason: cheaper, faster,
  and testable — most turns (issue/urgency/address/name/phone capture,
  emergencies, account lookups) never need a model call. verified
  (`src/app/api/chat/route.ts:783-1112` routes FALLBACK_LLM only for novel
  input).
- **Session resume via httpOnly cookie** — shipped. Rejected: client-side
  localStorage transcript. Reason: cookie survives a refresh without
  exposing the session token to JS, and the server is the source of truth
  for status/extraction. verified (`src/hooks/use-chat-session.ts:226-276`).
- **Widget embedding with per-org frame-ancestors** — shipped
  (`src/proxy.ts:25-49`). Rejected: a single global CSP. Reason: `/embed`
  must be framable by contractor sites but scoped to each org's allowlisted
  domains, or any site could iframe a competitor's widget. verified.
- **Past-conversation history sidebar** — partially shipped, currently dead
  (see Gaps Gchat-1). Considered finishing it now vs. cutting it. Decision:
  fix it (P1) rather than rip it out — the API and UI both exist and mostly
  work; the wiring bug is small and the feature has real value for repeat
  customers.
- **Client-side "typing…" indicator with token-by-token reveal** — rejected
  for this spec. The guarded-flush layer intentionally holds back partial
  sentences for safety; animating individual tokens would either lie about
  what's been screened or require weakening the flush granularity. Not
  worth it — sentence-level reveal already feels responsive.
- **Multi-language support** — rejected. No evidence of demand (brand facts
  are Johnson City, TN Eastern-timezone only per repo memory), and every
  guardrail regex is English-anchored; translating would multiply the
  safety-proof surface for a feature nobody asked for. YAGNI.
- **Voice-note / audio input in chat** — rejected. Text intake already
  captures structured slots deterministically; audio would need
  transcription (new failure mode, new cost, new safety-regex risk on
  transcribed text) for a channel that already has a dedicated voice agent
  (`src/lib/ai/voice-turn.ts`). Redundant.
- **Editable extraction card mid-conversation (not just at confirm)** —
  rejected. `ExtractionCard`/`ConfirmationDialog` already let the customer
  edit every field before submit (`chat-experience.tsx:219-226,311-318`).
  Adding inline editing earlier in the flow duplicates that surface for
  marginal benefit.
- **Retry/regenerate button on a suppressed (guardrail-replaced) reply** —
  rejected. The replacement copy already keeps the conversation moving and
  offers a next step; a regenerate control invites re-rolling until the
  guardrail is bypassed, which is exactly the risk the guardrail exists to
  close. Never add a way to fish for an unfiltered reply.

## 3. Current state

**Pages / components** (verified — read in full):
- `src/app/chat/page.tsx` — thin wrapper; on submit, `router.push`es to
  `/chat/success?ref=…&window=…` (window param only when a concrete arrival
  window was reserved). `src/app/chat/page.tsx:11-17`.
- `src/app/embed/page.tsx` — same `ChatExperience`, `variant="embed"`; on
  submit shows an inline confirmation instead of navigating (the iframe
  can't drive the host page). Wrapped in `<Suspense>` to avoid a prerender
  crash from `useChat`'s `Math.random()` calls. `src/app/embed/page.tsx:19-57`.
- `src/app/chat/success/page.tsx` — reads `?ref=` and `?window=` from the
  URL; copy is conditional on `windowLabel` presence (never promises a time
  that wasn't held). `src/app/chat/success/page.tsx:13-32`.
- `src/components/chat/chat-experience.tsx` — the shared UI: header,
  message list, extraction card, quick replies / suggested-reply chips,
  address autocomplete (shown only while the address step is pending, per
  `nextStepIdForExtraction`), escalation dialog, confirmation dialog, offline
  banner (`ConnectionStatus`), history sidebar. `src/components/chat/chat-experience.tsx:1-323`.
- `src/hooks/use-chat-session.ts` — owns session lifecycle: create-or-resume
  on mount (`:174-276`), streams via `useChat` + `TextStreamChatTransport`
  posting to `/api/chat` (`:82-114`), polls `/api/session` after each stream
  completes with a 5-step exponential backoff (300ms then 800/1500/2500/
  4000/5000ms, ~14s budget) to pick up the async-extracted slots
  (`:278-357`), and exposes `confirm`/`escalate`/`startNewConversation`.

**Server** (verified):
- `POST /api/session` (`src/app/api/session/route.ts:32-164`) resolves the
  org (publishable widget key header, or demo org for the hosted page),
  stamps org-configured token budget / turn limit onto the session row, and
  persists the org-branded greeting as the session's first assistant
  message (so the welcome is a real, resumable transcript entry, not a
  client phantom).
- `GET /api/session` (`:166-261`) resumes by cookie token; on a widget-key
  mismatch (cross-org resume) it fails closed to `NO_SESSION` so the client
  falls through to `createSession` for the correct org (`:187-201`).
- `POST /api/chat` (`src/app/api/chat/route.ts`, 2169 lines) — CSRF
  (same-origin + JSON content-type, `:346-355`), rate limiting, terminal/
  submitted-state gates, a do-not-service early gate keyed off a
  previously-linked customer (`:415-448`), token-budget graceful handoff
  (`:450-469`), guardrail input screening with HARD (400 block) vs SOFT
  (canned in-scope reply, never fed to the model) severities (`:505-561`),
  then the deterministic router (`:783-1500ish`) for known-slot capture,
  emergencies, account lookups (ZIP-verify gated), and only falls back to
  `streamText` (`:1818-1848`) for novel input.
- LLM-fallback replies are streamed through `guardedFlushStream`
  (`src/lib/ai/guarded-stream.ts`), which enforces a one-sentence lag +
  terminal-punctuation gate (`flushableLength`, `:48-58`) before any text
  reaches the client, screens each candidate with `screenAssistantReply`
  (`src/lib/ai/output-guardrail.ts:128-155`), keeps draining the model
  stream after a violation (no early abort), and always calls `persist()`
  before closing (`guarded-stream.ts:145-179`). `screenAssistantReply` is
  pure/deterministic and checks 4 regex families: price (`:20,33`),
  false-booking (`:47-48`), dangerous-DIY (`:78-79`), fabricated credentials
  (`:89-90`) — the exact regexes the offline eval imports (module doc
  comment, `:11-16`).
- `POST /api/session/confirm` (`src/app/api/session/confirm/route.ts`)
  validates the payload against `serviceRequestSchema`, merges in
  server-side session metadata (enrichment fields the client can't drop,
  `:88-96`), applies a vulnerable-occupant urgency bump (`:98-110`),
  promotes `chatting → extracting → confirmed → submitted` (self-healing if
  the client-visible status lagged, `:118-149`), and calls the shared
  `submitSessionServiceRequest` (money/CRM canonical path, shared with the
  voice channel's auto-submit). Returns `arrivalWindow` only when a real
  window was held (`:190-202`).
- `/embed` framing: `src/proxy.ts:25-49` scopes `frame-ancestors` to the
  org's configured allowlist (`'self'` default, `*` only if the org hasn't
  configured domains, else the org's specific origins) — the global
  `X-Frame-Options: DENY` in `next.config.ts:22` and `proxy.ts:11` does NOT
  apply to `/embed`. verified.

**Gotchas already documented** (`.claude/skills/page-chat/SKILL.md:49-55`,
verified against source): `/embed`'s `<Suspense>` wrapper is load-bearing
for build; `safeEnqueue`/`safeClose` swallow post-disconnect stream errors
so the loop still drains and persists; the widget key is not an admin
session.

## 4. Gaps

| Gap | Severity | Evidence |
|---|---|---|
| Gchat-1: History sidebar is permanently dead for every user, including linked/returning customers | P1 | `chat-experience.tsx:200` passes `customerId={null}` unconditionally to `HistorySidebar`, with a stale comment claiming it "is populated after extraction confirmation" — no state ever sets it. `HistorySidebar` gates its fetch on that prop: `if (!customerId) { setSessions([]); return; }` (`history-sidebar.tsx:57-61`) and renders "Sign in to see your conversation history" (`:121-124`). The server route `GET /api/chat/history` doesn't need a customerId param at all — it derives the linked customer from the session cookie server-side (`src/app/api/chat/history/route.ts:38-56`). Net effect: the History button in `ChatHeader` (always rendered, `chat-experience.tsx:208`) is permanently non-functional dead UI, even for a session the server has linked to a real customer mid-conversation (`api/chat/route.ts:703-727`). |
| Gchat-2: File-picker validation errors use `window.alert` | P2 | `chat-input.tsx:69,74` calls bare `alert('Only images are allowed')` / `alert('File size must be less than 5MB')` — a blocking native dialog, inconsistent with the inline `Alert` component used elsewhere in the same experience (`chat-experience.tsx:229-237`). |
| Gchat-3: No `aria-live` region for streamed assistant replies | P2 | `message-list.tsx` renders the transcript with no `aria-live`/`role="log"` announced region (inferred from grep of the component — no `aria-live` in `src/components/chat`), so a screen-reader user gets no announcement when a new bot reply streams in; they'd have to re-navigate the list. |

That's the full list. The rest of the page — streaming safety, deterministic
routing, session resume, tenancy scoping, submit flow, embed framing — is
solid and evidenced above; this spec does not invent additional work to pad
it out.

## 5. Requirements

Only Gchat-1 clears the P0/P1 bar.

- **Rchat-1**: When the current session is linked to a customer (either at
  load — `GET /api/session` response already includes enough to know a
  session is resumable/linked — or mid-conversation, once the server links
  `session.customerId`), the History sidebar must fetch and display that
  customer's past conversations instead of the permanent "sign in" empty
  state.
  **Acceptance criterion**: with a session whose `customerId` is set
  server-side (e.g. after a contact-field match), opening the History
  sidebar calls `GET /api/chat/history` and renders the returned sessions
  (or "No past conversations yet" if none) — never the "Sign in to see your
  conversation history" copy. A fresh/unlinked session still shows that
  copy (it is the correct state for a genuinely-anonymous chat, not a bug).
  Verify by making `GET /api/session`'s response carry whatever signal the
  client needs to know linkage (e.g. a boolean or the metadata it already
  parses) and wiring that into the `customerId`/linked prop passed to
  `HistorySidebar`, then a `vitest` unit test on the pure derivation
  function (no jsdom) confirming: linked session → truthy prop, unlinked →
  null.

## 6. Non-goals

- Not touching the guarded-flush lag/punctuation-gate algorithm, the
  guardrail regex shapes, or `screenAssistantReply`'s replacement copy —
  see Invariants.
- Not adding retry/regenerate on a suppressed reply (Brainstorm, rejected —
  safety risk).
- Not building multi-language or voice-note input (Brainstorm, YAGNI).
- Not redesigning the visual chat UI — no evidence it's broken; this spec
  found a wiring bug, not a design problem.
- Gchat-2 and Gchat-3 (P2) are recorded in Gaps and left in the backlog per
  METHOD.md's severity gate; they are not implementation work in this run.

## 7. Invariants

- **FROZEN safety text & guardrail regexes** — `src/lib/ai` prompt strings
  and `PRICE_REGEX` / `PRICE_WORD_REGEX` / `FALSE_BOOKING_REGEX` /
  `DANGEROUS_DIY_REGEX` / `CREDENTIAL_REGEX` in
  `src/lib/ai/output-guardrail.ts` must not change shape. The offline eval
  imports these exact regexes as its CI safety gate (module doc,
  `output-guardrail.ts:11-16`); any requirement that would alter them is
  forbidden. Rchat-1 touches only `use-chat-session.ts` / `history-sidebar.tsx`
  / `chat-experience.tsx` wiring — nowhere near these files.
- **Guarded-flush lag/punctuation-gate theorem** — `flushableLength` (one
  sentence lag, ≥2 boundaries, terminal-punctuation-anchored) and the
  drain-always/persist-on-every-path structure in
  `src/lib/ai/guarded-stream.ts` is a proven safety property, not
  incidental code. Do not touch it for this page's fix.
- `screenAssistantReply` stays pure/deterministic (no I/O) —
  `output-guardrail.ts` module doc.
- Voice parity: `src/lib/ai/voice-turn.ts` is "a voice persona over the
  proven core, not a second brain" (`voice-turn.ts:11-12`). Rchat-1 is
  chat-UI-only (History sidebar has no voice-channel equivalent), so no
  parity check is needed for this specific fix — noted here so a future
  editor doesn't assume otherwise.
- Tenancy: every session/message/customer read in the chat route is scoped
  by `organizationId` from the session row, never a hardcoded org
  (`api/chat/route.ts:378-386`) — Rchat-1's history fetch must keep using
  the existing session-scoped `GET /api/chat/history`, not a new
  unscoped query.
- Success-page / embed-confirmation copy stays conditional on
  `arrivalWindowLabel` — never promise a window that wasn't actually
  reserved (`chat/success/page.tsx:14-17`, `embed/page.tsx:42-45`).

## 8. Verification

- `npx tsc --noEmit` → 0.
- `npx eslint src/components/chat/chat-experience.tsx src/components/chat/history-sidebar.tsx src/hooks/use-chat-session.ts` → 0 errors.
- `npx vitest run` → must not drop below the live baseline (297 files ·
  4022 passed · 1 skipped, per `docs/page-program/README.md`).
- Guardrail/streaming regression pack (must stay green — proves Rchat-1
  didn't touch the safety surface):
  `npx vitest run src/lib/ai/guarded-stream.test.ts src/lib/ai/guarded-stream.route-wiring.test.ts src/lib/ai/output-guardrail.test.ts src/lib/ai/guardrails.test.ts src/lib/ai/state-machine.test.ts src/lib/ai/intent-router.test.ts`
- New pure-function unit test (no jsdom/RTL, per repo convention) covering
  the linked→prop derivation added for Rchat-1.
- Manual/visual: `npm run dev` (background) → mint a session, POST/GET
  `/api/session` directly (or drive a real conversation with a known
  email/phone that matches a seeded customer) to link `customerId`, then
  screenshot the chat page with History open via
  `node scripts/agent/screenshot-page.mjs /chat` and confirm the sidebar
  shows sessions, not the "sign in" empty state.
