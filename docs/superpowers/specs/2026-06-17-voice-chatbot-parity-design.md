# Voice ↔ Web Chatbot Parity — Design Spec

**Date:** 2026-06-17 · **Status:** approved (brainstorm) → ready for implementation plan
**Plan refs:** CHATBOT-PLAN Step 18 (voice account-lookups via ANI identity gate — "biggest web/voice parity gap"); related Step 19 (barge-in/streaming TTS) is OUT OF SCOPE here.

## Goal & context
The web chat and the voice/phone agent already share the deterministic intent router, input guardrails (`sanitizeInput`), slot/contact extraction, escalation, the auto-submit path, and conversation compaction. But the voice turn handler (`src/lib/voice/voice-turn.ts`) does **not** call a set of chat-only helpers, so a caller gets a measurably weaker — and in three places, less safe — experience than a web visitor. This spec brings the voice channel to parity on **safety** and **intake quality**.

**Decisions locked in brainstorm:**
- **Scope:** safety-critical + intake-quality gaps. Pure polish (frustration-aware human offer, conversation-style parity, voice telemetry) and barge-in/streaming TTS are deferred to their own follow-ups.
- **Approach A-refined (revised after adversarial review):** wire `voice-turn.ts` to the helpers the chat route ALREADY uses, without extracting new shared "cores" and without modifying the web path. Two pieces the original draft proposed extracting are already reusable as-is: `decideAfterHoursDisclosure` (`after-hours-chat.ts`) is already a pure, channel-agnostic function, and the contact→customer blind-index lookup is already a shared query (`findCustomerIdByContact`). Refactoring the eval-gated web route to call new abstractions was rejected as gold-plating with real regression risk and little gain. The only genuinely NEW logic is voice-local: an ANI-resolution wrapper and the financial-verify gate (the web path has no verify step to share — web serves account data on contact-match).
- **Voice identity bar:** caller ANI auto-match (Twilio `From` → `normalizePhone` → HMAC `phoneHash` → `customerId`) drives **repeat-customer context and do-not-service enforcement** with no extra step. It does NOT trigger a name greeting on the opening turn (see WS2 — privacy). Reading **sensitive financials** (balance, membership) aloud requires a lightweight confirmation of an on-file detail, entered by **DTMF keypad (primary) or speech (digit-normalized fallback)**, with up to **2 attempts**, then safe deferral. Once verified, all financial intents are unlocked for that call (per-session, not per-intent). Justified by ANI spoofing + the overhearable nature of spoken account data.

## Non-goals (v1)
- Barge-in / streaming TTS (CHATBOT-PLAN Step 19 — a separate UX/latency effort).
- Frustration-aware proactive human offer; conversation-style state parity (empathy-once); voice bot telemetry (`recordBotEvent`). Deferred polish.
- Full channel-pipeline unification (Approach B).
- Any new financial mutation over voice (reschedule that moves money, payments). Voice stays read-only for account data; `account-data-reschedule` keeps its current deferral on voice.
- SMS as a third channel.

## Architecture principle
`voice-turn.ts` remains the voice-specific orchestrator (TwiML, `<Gather>`, `<Play>`/`<Say>`, spoken-phone/digit quirks). For each gap it **calls the existing helper** the chat route already uses — no new shared modules, no changes to the web route:

| Gap | Existing helper reused (no change) |
|---|---|
| Output guardrail | `screenAssistantReply` (`src/lib/ai/output-guardrail.ts`) |
| Customer resolution | `findCustomerIdByContact` (blind-index lookup) |
| Account reads | account tools + `account-reply.ts` formatting |
| After-hours decision | `decideAfterHoursDisclosure` (`after-hours-chat.ts`, already pure) |
| Real windows | availability query + `buildWindowPrompt` |
| Token budget | `checkTokenBudget` |
| Async enrichment | `extractServiceRequest` |
| Spoken-digit parsing | `extractSpokenPhone`'s digit-word normalizer (reused for ZIP) |

Genuinely NEW code, **voice-local only** (lives in `src/lib/voice/`, not shared, because there is no web counterpart):
- `resolveVoiceIdentity(organizationId, ani)` — thin wrapper: `normalizePhone(ani)` → `findCustomerIdByContact` → persist `customerSessions.customerId`. Returns `null` on absent/withheld ANI or any error.
- `account-verify.ts` — `requiresVerify(intent)` (a data-driven sensitivity map), `checkVerify(customerId, keypadOrSpokenAnswer)` (match against on-file ZIP(s) / name), and the small per-session verify state machine (below).

## Workstreams (each an isolated, independently shippable unit)

### 1. Voice output guardrail (safety-critical)
**What:** After the voice LLM produces a reply (`generateText` → spoken reply in `voice-turn.ts`), run `screenAssistantReply(rawReply)` BEFORE rendering TTS. Persist + speak the **screened** text (so it can't re-enter history or be read back). On a violation, log `{ sessionId, violations }` (never the raw text), same as the chat route.
**Why first:** trivial reuse of the just-shipped guardrail; closes the most dangerous divergence (voice could speak "$300" / "you're booked").
**Done when:** a voice LLM reply containing a price or a false-booking claim is replaced with the safe reply before TTS; unit + eval coverage (see Testing).

### 2. ANI identity resolution + gate (safety-critical, voice-local)
**What:** On session-create (incoming call) and as a turn-1 backfill, resolve the caller via `resolveVoiceIdentity(orgId, Twilio From)`: `normalizePhone` → HMAC `phoneHash` → org-scoped `customers` row → persist `customerSessions.customerId`. Org is the voice session's org (today single-tenant — the incoming route's org; multi-tenant dialed-number→org routing is OUT OF SCOPE and noted in Security). Then:
- **Do-not-service:** the existing early gate (`session.customerId` → `customers.doNotService` → `DO_NOT_SERVICE_REPLY`) now fires on voice too (it was effectively dead on voice because `customerId` was always NULL). The submit-time backstop is unchanged.
- **Repeat-customer CONTEXT, not a name greeting:** resolution seeds repeat-customer context (history-aware replies) but does **NOT** speak the account holder's name on the opening turn. A phone number is often shared (household, business line); announcing "Hi Sarah" to whoever answers leaks the account holder's identity and is a domestic-safety hazard — this is NOT web parity (web has explicit login/contact-entry consent). Name personalization is allowed only AFTER the caller self-identifies in conversation (they state their name) — then later turns may use it naturally.
**Fail-safe:** any lookup error → unresolved (anonymous intake continues). ANI absent/withheld/unparseable → unresolved.

### 3. Voice account lookups + verify gate (safety-critical, voice-local)
**What:** Remove the `voice-turn.ts` coercion that forces `ACCOUNT_LOOKUP` → `FALLBACK_LLM`. For a resolved caller, dispatch account intents to the **same** account tools the chat route uses (`getMembershipSummary`, `getNextVisit`, `getOpenBalance`, appointment status) via `account-reply.ts` formatting.
**Sensitivity map (data-driven, testable):** `requiresVerify(intent)` reads a static map, not inline prose:
`account-data-balance → financial`, `account-data-membership-status → financial`, `account-data-next-visit → none`, `account-data-appointment-status → none`, `account-data-reschedule → none` (hand-off note only; no money exposed, stays read-only on voice). Only `financial` intents gate.
**Verify factor + input:** before reading a financial answer aloud, voice asks for the **service ZIP**, accepting **DTMF keypad entry (primary, 100% reliable) OR speech** (`<Gather input="dtmf speech">`). A spoken answer is digit-normalized with `extractSpokenPhone`'s word→digit map ("oh"/"zero" etc.) before compare. `checkVerify` matches the entered 5 digits against the decrypted ZIP of **any** of the customer's on-file service addresses (customer row + `customerLocations`). Name is the fallback factor only when no parseable 5-digit ZIP exists on file (non-US / no address).
**State machine (per-session, in `customerSessions.metadata.extras.verify`):** `{ status: "pending" | "passed" | "failed", attempts: number }`. Up to **2 attempts** (DTMF makes this generous), then `status="failed"` → safe deferral and never re-ask this call. Once `status="passed"`, ALL financial intents are unlocked for the session (don't re-verify per intent).
**Deferral copy (fixed):** "I can't confirm that over the phone right now — I'll have our team follow up, or you can check your account online." Never the data.
**Non-financial account intents** (`next_visit`, `appointment-status`) are served on ANI match with no verify (web parity; they reveal scheduling, not money).

### 4. After-hours disclosure (intake-quality, reuse existing helper)
**What:** Voice loads the org's `afterHoursConfig` (same query the chat route uses) and calls the EXISTING pure `decideAfterHoursDisclosure(...)` (no new core). When it decides after-hours applies, voice speaks a **deterministic canned disclosure line** ("since it's after our normal hours, an additional after-hours charge applies and our team will confirm the details" — NEVER a dollar amount) and asks the urgency-gating question. NOTE the channel difference: on web the disclosure is woven into the LLM system prompt (`AFTER_HOURS_LLM_INSTRUCTION`); on voice (deterministic-first) it is a canned spoken line, and the same instruction block is appended to the voice LLM system prompt only on the fallback path. Disclosure-once is latched in metadata. Hazard short-circuit always wins: emergency/hazard detection is deterministic in the router and escalates BEFORE any after-hours talk or LLM call (never delayed for charge talk).
**Fail-safe:** config read error → no disclosure, intake continues.

### 5. Availability window offers — voice-appropriate (intake-quality)
**What:** At the window step, fetch the same real availability the chat route uses, but render it for VOICE: offer at most **2** concrete bands and let the caller select by **DTMF or short speech** ("For Thursday morning press 1, for Friday afternoon press 2, or say another time"). A spoken day/band is matched back to the band enum (`captureEnrichmentAnswer`). Reading a long list aloud (3+ day+band options) exceeds caller working memory and has no reliable voice-select mechanism, so it is explicitly avoided.
**Fail-safe / default:** no availability, query error, or selection miss → fall back to the current generic "morning, afternoon, or evening?" prompt (unchanged, already works). **Open question flagged for the plan:** real-window offers may prove low-value on voice vs. the generic ask; if so, this WS is the first candidate to defer, keeping the generic prompt.

### 6. Async extraction + token-budget enforcement (intake-quality)
**What:** (a) Run `extractServiceRequest()` in `after()` from the voice turn (same pattern as chat) to enrich slots the synchronous regex missed (address completion, prose-embedded contact), merging on the next turn without blocking the spoken reply. (b) Call `checkTokenBudget()` each voice turn before the LLM call; on exhaustion, escalate via the existing `escalateSession` path with a graceful spoken handoff (parity with chat's budget escalation). Turn-limit handling already works and is unchanged.

## Data flow (voice turn, after parity)
1. Incoming call → session create; **resolveVoiceIdentity(orgId, From)** → persist `customerId` (WS2).
2. Each turn: load session+history → **do-not-service early gate** (WS2) → `sanitizeInput` (shared) → **checkTokenBudget** (WS6) → `routeMessage` (shared). Emergency/hazard → escalate immediately (deterministic, before any LLM).
3. If `ACCOUNT_LOOKUP` (WS3): non-financial → serve on ANI match; financial → verify gate (DTMF/speech ZIP, ≤2 attempts) → serve on pass, safe deferral on fail.
4. Else deterministic intake: **after-hours decision** (WS4) → **voice window offer** at window step (WS5, ≤2 bands + DTMF select, else generic) → slot capture (shared) → auto-submit when complete (shared).
5. LLM fallback only when the router defers: `generateText` → **screenAssistantReply** (WS1) → persist screened → TTS.
6. `after()`: **extractServiceRequest** (WS6) + compaction (shared). Best-effort: if the caller hangs up before the next turn, async enrichment may not land — acceptable because essentials (issue/address/phone) are captured synchronously.

## Error handling (fail-safe table)
| Failure | Behavior |
|---|---|
| ANI lookup / blind-index error / absent ANI | Treat as unresolved → anonymous intake continues |
| Verify detail missing on file (no ZIP) | Fall back to name verify; if neither → safe deferral |
| Verify mismatch | Re-ask up to 2 attempts total; then `failed` → safe deferral, never re-ask this call |
| After-hours config read error | No disclosure → intake continues |
| Availability query error / empty / select miss | Generic-window fallback (current behavior) |
| Token budget exhausted | Escalate + graceful spoken handoff |
| LLM error/timeout | Existing graceful spoken handoff (unchanged) |
| Output guardrail | Always applied; safe reply on violation |

## Security
- **ANI spoofing:** non-financial personalization/scheduling accepts ANI match (≈ web's typed-contact bar). Financials additionally require the ZIP verify. Brute force is bounded: an attacker needs both a spoofed matching ANI AND the ZIP, capped at 2 attempts per call, per-session — not an open guessing oracle.
- **Caller-identity privacy:** no name is spoken from ANI match alone (shared-phone/household/domestic-safety risk); name use only after the caller self-identifies (WS2).
- **Overhear:** financials read only after explicit verify; reschedule/payment mutations stay out of scope (read-only voice).
- **No PII in logs:** identity/verify/guardrail logs carry ids/enums/labels only — e.g. verify logs `{ sessionId, intent, verified, attemptsRemaining }`, NEVER the entered/stored ZIP, name, phone, balance, or raw reply.
- **Verify comparison:** entered digits vs. the **decrypted** on-file ZIP(s) (customer + `customerLocations`), compared as normalized 5-digit strings; spoken answers digit-normalized first. Decrypt error → treat as missing detail → deferral.
- **Do-not-service:** early voice gate (now live via WS2) + the unchanged submit-time hard backstop.
- **Org scoping:** every customer/account read is `withTenant`-scoped to the voice session's org. NOTE: voice is currently single-tenant (the incoming route's org); a dialed-number→org mapping for multi-tenant voice is a SEPARATE effort, explicitly out of scope here — this spec does not claim it.

## Latency note (voice-specific)
Buffering the LLM reply (required for `screenAssistantReply`) + TTS render adds perceptible dead air on a call. Mitigations: emergencies never wait on the LLM (deterministic router short-circuit, step 2); `maxOutputTokens` stays low for short spoken replies; consider a brief "one moment" filler on the rare long LLM turn. Streaming TTS (Step 19) is the real fix and is out of scope.

## Testing
- **Unit:** `resolveVoiceIdentity` (ani normalize/match/absent/error; org scoping); `account-verify` (`requiresVerify` map; `checkVerify` DTMF-match / spoken-digit-normalized match / mismatch / multi-location any-ZIP / no-ZIP→name fallback; attempt cap; per-session unlock). `decideAfterHoursDisclosure` + `screenAssistantReply` already covered.
- **Voice integration:** `voice-turn` tests (mock Twilio request) for: output guardrail replaces an unsafe spoken reply; do-not-service caller refused; financial intent requires verify then serves; 2-attempt mismatch → deferral (no re-ask after); NO name greeting on opening turn from ANI alone; after-hours disclosure spoken; budget-exhausted escalation; emergency short-circuits before any LLM.
- **Eval harness:** add **voice safety transcripts** for the deterministic-checkable properties over the phone channel — pricing-leak, false-booking, account-data-without-verify (must not leak), do-not-service caller (must refuse). These join the existing critical gates so voice can't regress.
- **Gates:** `tsc`, `npm run test:unit`, `npm run eval` (0 critical failures), `npm run build` — all green before merge.

## Rollout / required external setup
- No DB migration (reuses `customerSessions`; identity sets `customerId`; verify state in `metadata.extras.verify`).
- No new env beyond the already-required Twilio + voice TTS config. Voice remains env-gated (routes already 404/no-op without Twilio config). Verify uses `<Gather input="dtmf speech">` — no new dependency.
- Build order (safety first): **WS1 → WS2 → WS3 → WS4 → WS6 → WS5.** WS1 ships alone (near-trivial). WS2 unblocks WS3 (account/do-not-service depend on resolved identity). WS4/WS6 are independent. WS5 is last and the first candidate to defer (see WS5 open question).
- Confirm with the operator: **service ZIP** as the verify factor (name fallback), and that DTMF entry is acceptable, before shipping WS3.
