# Voice ↔ Web Chatbot Parity — Design Spec

**Date:** 2026-06-17 · **Status:** approved (brainstorm) → ready for implementation plan
**Plan refs:** CHATBOT-PLAN Step 18 (voice account-lookups via ANI identity gate — "biggest web/voice parity gap"); related Step 19 (barge-in/streaming TTS) is OUT OF SCOPE here.

## Goal & context
The web chat and the voice/phone agent already share the deterministic intent router, input guardrails (`sanitizeInput`), slot/contact extraction, escalation, the auto-submit path, and conversation compaction. But the voice turn handler (`src/lib/voice/voice-turn.ts`) does **not** call a set of chat-only helpers, so a caller gets a measurably weaker — and in three places, less safe — experience than a web visitor. This spec brings the voice channel to parity on **safety** and **intake quality**.

**Decisions locked in brainstorm:**
- **Scope:** safety-critical + intake-quality gaps. Pure polish (frustration-aware human offer, conversation-style parity, voice telemetry) and barge-in/streaming TTS are deferred to their own follow-ups.
- **Approach C:** wire `voice-turn.ts` to the existing tested chat helpers for each gap, AND extract a channel-agnostic shared **core** for the two pieces that are currently chat-coupled and safety-relevant — the **account-identity gate** and the **after-hours decision** — so those can never drift between channels. Do NOT unify the two route orchestrations (rejected as a large, risky refactor of two mature routes for little immediate gain).
- **Voice identity bar:** caller ANI auto-match (Twilio `From` → HMAC blind-index → `customerId`) drives greeting / repeat-customer / do-not-service with no extra step; but reading **sensitive financials** (balance, membership) aloud requires **one** lightweight confirmation of an on-file detail (service ZIP, with name as fallback). Mismatch/unresolved → safe deferral. This is marginally above web's bar, justified by ANI spoofing + the overhearable nature of spoken account data.

## Non-goals (v1)
- Barge-in / streaming TTS (CHATBOT-PLAN Step 19 — a separate UX/latency effort).
- Frustration-aware proactive human offer; conversation-style state parity (empathy-once); voice bot telemetry (`recordBotEvent`). Deferred polish.
- Full channel-pipeline unification (Approach B).
- Any new financial mutation over voice (reschedule that moves money, payments). Voice stays read-only for account data; `account-data-reschedule` keeps its current deferral on voice.
- SMS as a third channel.

## Architecture principle
`voice-turn.ts` remains the voice-specific orchestrator (TwiML, `<Play>`/`<Say>`, spoken-phone/digit quirks). For each gap it **calls the same helper** the chat route calls. Two helpers whose logic is today embedded in the chat route are extracted to channel-agnostic cores and called by both:

| New shared core | Extracted from | Consumed by |
|---|---|---|
| `src/lib/ai/account-identity.ts` — `resolveIdentity({ contact \| ani })` + `requiresVerify(intent)` + `checkVerify(customerId, answer)` | chat route's `lookupCustomerContext` usage + the identity gate around `ACCOUNT_LOOKUP` | chat route + voice-turn |
| `src/lib/ai/after-hours-core.ts` — pure `decideAfterHours(config, now, signals)` returning `{ disclose, askUrgency, instruction }` | `after-hours-chat.ts` (`decideAfterHoursDisclosure`) | chat route + voice-turn |

Everything else is direct reuse (no new module): `screenAssistantReply`, availability query + `buildWindowPrompt`, `checkTokenBudget`, `extractServiceRequest`.

## Workstreams (each an isolated, independently shippable unit)

### 1. Voice output guardrail (safety-critical)
**What:** After the voice LLM produces a reply (`generateText` → spoken reply in `voice-turn.ts`), run `screenAssistantReply(rawReply)` BEFORE rendering TTS. Persist + speak the **screened** text (so it can't re-enter history or be read back). On a violation, log `{ sessionId, violations }` (never the raw text), same as the chat route.
**Why first:** trivial reuse of the just-shipped guardrail; closes the most dangerous divergence (voice could speak "$300" / "you're booked").
**Done when:** a voice LLM reply containing a price or a false-booking claim is replaced with the safe reply before TTS; unit + eval coverage (see Testing).

### 2. ANI identity resolution + gate (safety-critical, shared core)
**What:** On session-create (incoming call) and as a turn-1 backfill, resolve the caller: `Twilio From` → `normalizePhone` → HMAC blind-index → org-scoped `customers` row → persist `customerSessions.customerId`. Then:
- **Do-not-service:** the existing early gate (`session.customerId` → `customers.doNotService` → `DO_NOT_SERVICE_REPLY`) now fires on voice too (it was dead code on voice because `customerId` was always NULL). The submit-time backstop is unchanged.
- **Greeting/personalization:** greet by name on the first spoken turn when resolved (mirrors web's repeat-customer greeting).
**Shared core:** `account-identity.resolveIdentity` takes `{ ani }` (voice) or `{ email, phone }` (web) and returns the resolved org-scoped `customerId | null` using the SAME blind-index lookup. Web is refactored to call it (no behavior change) so the resolution logic is single-sourced.
**Fail-safe:** any lookup error → treat as unresolved (anonymous intake continues). ANI absent/withheld → unresolved.

### 3. Voice account lookups + 1-step verify (safety-critical)
**What:** Remove the `voice-turn.ts` coercion that forces `ACCOUNT_LOOKUP` → `FALLBACK_LLM`. For a resolved caller, dispatch account intents to the **same** account tools the chat route uses (`getMembershipSummary`, `getNextVisit`, `getOpenBalance`, appointment status) via `account-reply.ts` formatting.
**Verify gate:** `account-identity.requiresVerify(intent)` returns true for **sensitive financials** (`balance`, `membership-status`). For those, before reading aloud, voice asks one confirmation ("Can you confirm the ZIP code on your account?"); `checkVerify(customerId, spokenAnswer)` compares against the decrypted on-file service ZIP (name as fallback when no address on file). The pending-verify state + which intent is gated live in `customerSessions.metadata` (e.g. `extras.pendingVerify`). On match → serve; on mismatch or no on-file detail → safe deferral ("I'll have our team follow up / you can check your account portal"), never the data. Non-financial account intents (`next_visit`, `appointment-status`) follow web parity (served on ANI match, no extra step — they reveal scheduling, not money).
**Why ZIP:** it's overhear-resistant (caller states it, not the system) and present for any customer with a service address; name fallback covers the rare no-address record.

### 4. After-hours disclosure (intake-quality, shared core)
**What:** Extract the chat route's after-hours/urgency decision into pure `after-hours-core.decideAfterHours(config, now, signals)`. Voice loads the org's `afterHoursConfig` (same query the chat route uses) and, when after hours, speaks the disclosure ("since it's after our normal hours, an additional after-hours charge applies and our team will confirm the details — NEVER a dollar amount") and asks the urgency-gating question, exactly per the existing chat logic. Hazard short-circuit always wins (escalate immediately, never delay for charge talk). Disclosure-once is latched in metadata (no repeat).
**Fail-safe:** config read error → no disclosure, intake continues (never blocks the call).

### 5. Real availability window offers (intake-quality)
**What:** At the window step, reuse the same availability query + `buildWindowPrompt` the chat route uses to offer **real** open bands ("Thursday morning or Friday afternoon") in spoken form, instead of the generic morning/afternoon/evening enum.
**Fail-safe:** no availability / query error → fall back to the current generic-window prompt (unchanged behavior).

### 6. Async extraction + token-budget enforcement (intake-quality)
**What:** (a) Run `extractServiceRequest()` in `after()` from the voice turn (same pattern as chat) to enrich slots the synchronous regex missed (address completion, prose-embedded contact), merging on the next turn without blocking the spoken reply. (b) Call `checkTokenBudget()` each voice turn before the LLM call; on exhaustion, escalate via the existing `escalateSession` path with a graceful spoken handoff (parity with chat's budget escalation). Turn-limit handling already works and is unchanged.

## Data flow (voice turn, after parity)
1. Incoming call → session create; **resolveIdentity({ ani })** → persist `customerId` (WS2).
2. Each turn: load session+history → **do-not-service early gate** (WS2) → `sanitizeInput` (shared) → **checkTokenBudget** (WS6) → `routeMessage` (shared).
3. If `ACCOUNT_LOOKUP` (WS3): resolved + (verify passed | non-financial) → account tool → `account-reply`; else verify-ask or safe deferral.
4. Else deterministic intake: **after-hours decision** (WS4) → **real window offer** at window step (WS5) → slot capture (shared) → auto-submit when complete (shared).
5. LLM fallback only when the router defers: `generateText` → **screenAssistantReply** (WS1) → persist screened → TTS.
6. `after()`: **extractServiceRequest** (WS6) + compaction (shared).

## Error handling (fail-safe table)
| Failure | Behavior |
|---|---|
| ANI lookup / blind-index error | Treat as unresolved → anonymous intake continues |
| Verify detail missing on file | Skip financial read → safe deferral |
| Verify mismatch | Safe deferral, no data; do NOT loop the verify endlessly (one retry then defer) |
| After-hours config read error | No disclosure → intake continues |
| Availability query error / empty | Generic-window fallback (current behavior) |
| Token budget exhausted | Escalate + graceful spoken handoff |
| LLM error/timeout | Existing graceful spoken handoff (unchanged) |
| Output guardrail | Always applied; safe reply on violation |

## Security
- **ANI spoofing:** mitigated by the verify step for financials; non-financial personalization (name/scheduling) accepts ANI match as web accepts a typed contact.
- **Overhear:** financials only read after explicit caller confirmation; reschedule/payment mutations stay out of scope.
- **No PII in logs:** identity resolution, verify, and guardrail logs carry ids/enums/violation labels only — never name/phone/ZIP/balance or the raw reply.
- **Verify comparison:** against the **decrypted** on-file value, normalized (trim/case/spacing); ZIP compared as digits.
- **Do-not-service:** early voice gate (now live via WS2) + the unchanged submit-time hard backstop.
- **Org scoping:** every customer/account read is `withTenant`-scoped to the call's org (resolved from the dialed number's org mapping, never caller-supplied).

## Testing
- **Unit:** `account-identity` (resolve by ani/contact; requiresVerify; checkVerify match/mismatch/missing-detail; org scoping), `after-hours-core` (disclose/askUrgency/instruction across business-hours/after-hours/hazard). `screenAssistantReply` already covered.
- **Voice integration:** `voice-turn` tests (mock Twilio request) for: output guardrail replaces an unsafe spoken reply; do-not-service caller refused; account financial requires verify then serves; verify mismatch → deferral; after-hours disclosure spoken; real window offered; budget-exhausted escalation.
- **Eval harness:** add **voice safety transcripts** exercising the deterministic-checkable properties over the phone channel — pricing-leak, false-booking, account-data-without-verify (must not leak), do-not-service caller (must refuse). These join the existing critical gates so voice can't regress.
- **Gates:** `tsc`, `npm run test:unit`, `npm run eval` (0 critical failures), `npm run build` — all green before merge.

## Rollout / required external setup
- No DB migration (reuses `customerSessions`; identity sets `customerId`; verify state in `metadata`).
- No new env beyond the already-required Twilio + voice TTS config. Voice remains env-gated (routes already 404/no-op without Twilio config).
- Build order (each independently shippable, safety first): **WS1 → WS2 → WS3 → WS4 → WS5 → WS6.** WS1 is a near-trivial first ship; WS2 unblocks WS3; WS4–6 are independent.
- Confirm with the operator that **service ZIP** is the desired verify field (name fallback) before shipping WS3.
