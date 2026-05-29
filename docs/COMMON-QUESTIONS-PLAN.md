# Plan: Deterministic "Answers & Actions" Layer

**Goal:** Resolve common HVAC customer messages **without an LLM call** by routing them through a
deterministic knowledge base + intent router. Fall back to Qwen only for genuinely novel/complex
input. This cuts token cost and latency dramatically while keeping the conversational LLM as a
safety net.

**Inputs:** [KNOWLEDGE-BASE-CATALOG.md](./KNOWLEDGE-BASE-CATALOG.md) (53 intents, 10 categories) ·
[TOKEN-SAVINGS.md](./TOKEN-SAVINGS.md) (8 prioritized strategies).

---

## 1. Architecture

```
POST /api/chat
  ├─ auth/session, rate-limit, budget, sanitize        (unchanged)
  ├─ load history, save user message                   (unchanged)
  ├─ ROUTER.route(message, knownSlots)   ◄── NEW deterministic layer
  │     ├─ ANSWER     → stream canned text, NO LLM, NO extraction
  │     ├─ COLLECT_INFO → merge deterministic slots, stream canned ask, NO LLM
  │     ├─ ESCALATE   → stream safety/handoff text, mark session escalated, NO LLM
  │     ├─ REDIRECT   → stream non-HVAC redirect, NO LLM
  │     └─ SUBMIT     → stream confirmation prompt, NO LLM
  └─ FALLBACK_LLM → existing streamText path (+ extraction)   (unchanged path)
```

The router is a **pure function** (no I/O). The route handler decides what to do with its verdict.
Every deterministic branch returns the same `text/plain` stream shape the frontend
(`TextStreamChatTransport`) already consumes, so **no frontend changes are required** for the
short-circuit to work.

## 2. Files

| File | Type | Purpose |
|---|---|---|
| `src/lib/ai/knowledge-base.ts` | new | Typed catalog: `KnowledgeBaseEntry[]` (53 intents) + literal-typed `action`, `issueTypeMapping`, `urgencyHint`. Encodes the catalog verbatim. |
| `src/lib/ai/intent-router.ts` | new | Pure matcher: normalize → score → threshold → verdict. Plus deterministic slot extractors (phone/email/address). |
| `src/lib/ai/intent-router.test.ts` | new | Unit tests: every category's happy path, the negation/overlap guards, confidence fallbacks, emergency override. |
| `src/lib/ai/slot-extract.ts` | new | Regex slot extraction (phone, email, address heuristics) — used by COLLECT_INFO to fill slots without the LLM. |
| `src/app/api/chat/route.ts` | edit | Wire the router in before `streamText`; add a `streamCannedText()` helper; persist assistant message + turn count on deterministic branches; only run extraction on the FALLBACK_LLM path. |
| `src/lib/ai/system-prompt.ts` | edit | Trim to ~250 tokens (Token-Savings #3). Keep `/no_think`. |

Out of scope for this plan (tracked, not built here): cheaper extraction model (#5), context
caching (#7 — needs doc verification), confirmation-time-only extraction re-architecture (#2 full
version). This plan does the **headline** strategy (#1) plus the cheap wins (#3, partial #2 via
"no extraction on deterministic turns").

## 3. Data model

```ts
export type RouterAction =
  | 'ANSWER' | 'COLLECT_INFO' | 'ESCALATE' | 'SUBMIT' | 'REDIRECT' | 'FALLBACK_LLM';

export interface KnowledgeBaseEntry {
  readonly id: string;
  readonly category: string;
  readonly title: string;
  readonly triggerKeywords: readonly string[];   // lowercased; multi-word phrases weighted higher
  readonly action: RouterAction;
  readonly cannedResponse: string;
  readonly infoNeeded: readonly SlotName[];       // subset of required/optional slots
  readonly issueTypeMapping: IssueType | null;    // ONLY real enum values
  readonly urgencyHint: Urgency | null;
  readonly negationGuards?: readonly string[];    // phrases that SUPPRESS this match
}
```

`SlotName`, `IssueType`, `Urgency` reuse the enums from `extraction-schema.ts` — no new vocabulary.

## 4. Matching strategy (from the catalog)

1. **Normalize:** lowercase, collapse whitespace, strip punctuation except `# + digits`, apply an
   alias map (`ac`/`a/c`→`air conditioner`, `tstat`→`thermostat`, `co/co2`→`carbon monoxide`, …).
2. **Score:** sum matched keyword weights; phrases ~3× single tokens. Apply **negation guards**
   (`no gas smell`, `alarm is not going off` suppress the emergency match).
3. **Priority order (short-circuit on safety):** EMERGENCY → ACCOUNT → issue intents → maintenance/
   scheduling/FAQ → meta (lowest, so a greeting never shadows a real issue in the same message).
4. **Confidence thresholds:** `≥0.70` act; `0.45–0.70` act only for low-harm ANSWER/FAQ else
   fallback; `<0.45` fallback. **Emergency override:** threshold ~0.25 and bypass the
   beat-the-runner-up rule — safety false-positives are acceptable, false-negatives are not.
5. **Known-slot awareness:** router receives current slots; drop already-filled slots from
   `infoNeeded`; when all required (`issueType, urgency, address`) are present → `SUBMIT`. Never
   block on optional name/phone/email.
6. **When in doubt → `FALLBACK_LLM`.** The router is a cost optimizer, not the brain.

## 5. Known-ambiguity → always FALLBACK_LLM
Burning-smell severity (safety), bare "no heat" without conditions, short-cycling without AC/furnace
context, customer self-diagnoses, live account/status lookups, warranty/coverage specifics, compound
multi-intent messages, frustration-vs-venting gray zone, non-HVAC homophones (`refrigerant` ≠
`refrigerator`, `water heater` in scope, `electrical burning smell` = HVAC emergency). These are
encoded as `FALLBACK_LLM` entries or guarded keywords so we never give a confident wrong answer.

## 6. Chat route integration (detail)

- After sanitize + save-user-message, call `router.route(sanitized, knownSlots)` where `knownSlots`
  is parsed from `session.metadata`.
- **Deterministic verdict (not FALLBACK_LLM):**
  - Build the reply text (canned response, with the next-missing-slot ask interpolated for
    COLLECT_INFO).
  - Persist the assistant message (`tokensUsed: 0`) and bump `turnCount` — mirror the existing
    `onFinish` bookkeeping minus the LLM token accounting.
  - For ESCALATE: also set session `status = 'escalated'` (terminal).
  - For COLLECT_INFO/SUBMIT: merge deterministic slots into `metadata`; set `status` via the state
    machine (e.g. → `extracting` when required slots complete).
  - Return `streamCannedText(reply)` — a `Response` with `Content-Type: text/plain; charset=utf-8`
    emitting the text as a single chunk (frontend renders identically to a streamed LLM reply).
- **FALLBACK_LLM verdict:** unchanged existing path (`streamText` + background extraction).
- **No extraction LLM call on deterministic branches** — that's a direct Token-Savings #2 partial win.

## 7. Testing
- `intent-router.test.ts`: for each category, assert the top example phrasing routes to the right
  `action`/`id`; assert negation guards (`"no gas smell"` ≠ emergency); assert
  `refrigerant`≠`refrigerator`; assert greeting+issue in one message picks the issue; assert low
  confidence → FALLBACK_LLM; assert emergency override fires on a single strong token.
- `slot-extract.test.ts`: phone/email/address regex happy + edge cases.
- Manual live smoke against the running dev server: send FAQ ("what areas do you serve"), emergency
  ("I smell gas"), and a novel description; confirm the first two return instantly with `tokensUsed:
  0` (check logs) and the third falls back to the LLM.

## 8. Safety & rollout
- The LLM fallback is **always** reachable; the router only short-circuits on high confidence.
- Emergency handling is conservative (low threshold, fail toward escalation).
- Add a metrics log line per turn: `{ routed: 'deterministic'|'llm', intentId, confidence }` so we
  can measure deterministic hit-rate and catch misroutes.
- Feature can be globally disabled with one guard (`ROUTER_ENABLED`) if a misroute is reported.

## 9. Success criteria
- ≥50% of typical-conversation turns resolved with **0 LLM tokens** (FAQ + slot-collection),
  measured via the per-turn metrics line (not assumed).
- Zero emergency false-negatives in the test suite.
- A 100%-deterministic conversation can reach a **created service request** (end-to-end).
- Existing chat UX unchanged (incl. the 15-turn escalation hint).
- `tsc --noEmit` clean; new unit tests green; live smoke confirms deterministic + fallback paths.

---

## 10. Review incorporated (architect gate — must-fix before/at implementation)

The plan-review subagent returned **"needs rework"**. The following fixes are now part of the plan
and are prerequisites, not optional:

**CRITICAL — close the deterministic-conversation dead-end (C1/C2/L2):**
- **`GET /api/session` must return `metadata`.** Today it omits it, so the frontend's
  extraction-card/confirm flow never sees deterministically-filled slots (and the LLM path's card is
  latently broken too). Add `metadata` (parsed) to the session GET response. *Prerequisite bug fix.*
- **Synthesize `description`.** `/api/session/confirm` validates against `serviceRequestSchema`
  which requires a non-empty `description`; the catalog never produces one. The router must
  synthesize a short description (e.g. intent title + sanitized snippet) when it writes slots.
- **Default `urgency`.** A booking-first deterministic path can reach SUBMIT with `urgencyHint:
  null`. Require an issue intent before SUBMIT, or default `urgency='medium'`.

**CRITICAL — bookkeeping parity via a shared helper (C3):**
- Introduce `finalizeTurn()` used by BOTH the deterministic branches and the LLM `onFinish`:
  persist assistant message (`tokensUsed: 0` for canned), bump `turnCount`, set `updatedAt`,
  advance status via `determineNextState`, and **merge** (not overwrite) `metadata`.
- Preserve the **15-turn escalation hint** on deterministic turns too (append a one-line "talk to a
  human" note to the canned reply when `turnCount >= MAX_TURNS`).

**HIGH:**
- **H1 — shared `escalateSession()`.** Inline `status='escalated'` would bypass the `auditLog`
  insert + `transition()` guard that `/api/session/escalate` enforces. Extract a shared service used
  by both the escalate route and the chat handler; always write the audit log (critical for
  gas/CO/fire cases).
- **H2 — metadata merge semantics.** Deterministic slot writes and LLM extraction must merge into
  one object; **never overwrite a filled slot with `null`**. LLM extraction reads existing
  `knownSlots` as its base.
- **H3 — reference/account intents → `FALLBACK_LLM`.** `account-check-status`,
  `account-provide-reference`, `scheduling-reschedule`, `scheduling-cancel`,
  `account-change-appointment` depend on live backend data and a slot that doesn't exist. Ship them
  as `FALLBACK_LLM` (or escalate), never `COLLECT_INFO` (would dead-end). Matches the catalog's own
  ambiguity guidance.
- **H4 — harden emergency/compound matching.** (a) Emergency intents require a **qualifier token**
  (smell/leak/alarm/detector/smoke), never a bare noun; (b) whitelist **"em heat"/"emergency heat"**
  before emergency scoring; (c) add a **compound-message detector** (multiple distinct category hits,
  or long/multi-clause) that forces `FALLBACK_LLM`. Each gets an explicit test.

**MEDIUM/LOW:**
- **M1** — soften claim to "0 LLM tokens *on matched deterministic turns*"; validate hit-rate via
  metrics. Note fallback turns still cost 2 calls (full extraction-gating is a separate strategy).
- **M2** — router input is `guardrailResult.sanitized`; fallback payload stays sanitized.
- **M3** — `ROUTER_ENABLED` is an env flag read per request; document default. Route metrics through
  the existing `metrics.ts`/Pino pattern, logging on FALLBACK too (deferral rate).
- **M4** — English-only normalization; non-Latin/low-alpha input must route to `FALLBACK_LLM`, never
  the gibberish canned answer.
- **L1** — reuse the SDK's `createTextStreamResponse` (exported) with a one-element stream for
  byte-compatibility with the LLM path; match `content-type: text/plain; charset=utf-8` exactly.
- **L3** — add an integration test asserting `GET /api/session` returns `metadata`, and a
  deterministic-happy-path E2E to the success page.
