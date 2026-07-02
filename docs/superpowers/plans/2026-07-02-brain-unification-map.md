# Conversational Brain Unification — Convergence Map

> Produced 2026-07-02 by a full read of both brains (chat route.ts 2218 lines; voice-turn.ts 1056 lines — SMS delegates to voiceReply, so there are TWO brains).
> This is the strangler-pattern unification plan: extract the ranked candidates one at a time, each with tests, never a big-bang rewrite.

# Unification Convergence Map — web chat brain vs voice brain

Files: `/Users/sizbei/Documents/GitHub/ai-hvac-agent/src/app/api/chat/route.ts` (2218 lines, "chat") and `/Users/sizbei/Documents/GitHub/ai-hvac-agent/src/lib/ai/voice-turn.ts` (1056 lines, "voice"). Both files were read in full; drift claims below are quoted from the actual code.

---

## 1. Duplicated inline surface (behavior-by-behavior)

| # | Behavior | Chat lines | Voice lines | Drifted? |
|---|----------|-----------|-------------|----------|
| 1 | Metadata rebuild → `buildExtraction` → persist | 1288–1297, 1511–1513, 1740–1760, 2044–2051 | 656–658, 682–684, 823–827 | **YES — security-grade** (see D1) |
| 2 | On-file ZIP loading for financial verify | 152–193 (`loadChatOnFileZips`) | 379–409 (inline) | No — verbatim copy-paste today; pure drift risk |
| 3 | Verify-state parse from session metadata | 133–144 + 925–926, 992–994 | 303–310 | **YES** (see D3) |
| 4 | Bare-ZIP verify-answer turn sequencing | 924–979 | 312–316, 415–424 | Partial — engine shared, orchestration duplicated; DTMF is legit channel delta |
| 5 | ACCOUNT_LOOKUP + verify-gate sequencing (needZips → `advanceVerify` → kind→copy → `buildAccountLookupReply` → "passed-but-null → defer" edge) | 987–1102 | 323–456 | **YES** for the unidentified branch (see D6) |
| 6 | Urgency-answer capture at the urgency step | 241–254 (`parseUrgencyAnswer`), 1349–1352 | **absent** | **YES — live loop bug on voice** (see D2) |
| 7 | KnownSlots → TriageSlots pending-step mapping | 347–360, 383–393, 733–742 | 475–484 | No — mechanical, but duplicated 4x |
| 8 | At-address-step lenient capture + `address_parts` tail combine | 1128–1144, 1419–1445 | 492–525 | Minor (see D8) |
| 9 | Deterministic-path gate (`isSlotProvision` / `pendingAnswerCaptured`) | 1171–1219 | 589–599, 629 | **YES** — chat has `pendingCoreFreeText` force-deterministic clause (1186–1190) and urgency/after-hours signal capture; voice has neither |
| 10 | Emergency escalation branch | 1220–1331 | 630–666 | **YES** (see D7) |
| 11 | After-hours disclosure | 855–871, 881–892, 1591–1622, 1885–1892 | 799–835 | **YES — largest behavioral gap** (see D4) |
| 12 | Do-not-service early gate | 510–543 (+ mid-turn 801–822) | 257–288 | No behavioral drift; ~30 lines duplicated each; chat's mid-turn path is a deliberate channel delta (voice identity = ANI at call start) |
| 13 | Token-budget graceful handoff | 546–564, 286–327 (`gracefulHandoff`) | 931–966 | Placement differs deliberately (voice gates only LLM turns — documented); orchestration (persist + escalate + turn bump) duplicated |
| 14 | Known-slots "already captured" LLM hint | 1898–1913 | 914–924 | Minor — chat includes email + SKIP_SENTINEL wording, voice omits email (deliberate) but header copy also drifted |
| 15 | LLM call + output guardrail + token accounting + telemetry | 1930–1961, 2144–2205 | 996–1053 | **YES — operational** (see D5) |
| 16 | Customer-context + cross-channel hint | 1842–1864 | 975–994 | Template identical except channel literal; voice skips `enrichWithServiceHistory` (deliberate, documented at 972–974) |
| 17 | Real-availability window prompt fetch | 404–421 (`fetchWindowPrompt`) | 205–225 (`fetchVoiceWindowQuestion`) | No — same skip-today logic; differ only in render (chips vs spoken) and voice's lazy import |

### Drift evidence (top candidates, quoted)

**D1 — voice wipes the financial-verify lockout on every intake metadata rebuild.** Chat's own comment names the bug class (route.ts 1507–1510):
> `// Preserve the financial-verify lockout (Stage 5): buildExtraction does NOT round-trip the top-level 'verify' key, so without this an intervening intake turn would wipe a pending ZIP lockout and reset the attempt counter`

Chat wraps all four rebuild sites in `preserveVerifyKey(...)`. Voice-turn.ts has **zero** references to `preserveVerifyKey` (grep-confirmed); its slot-fill rebuild is bare: `metadataStr = JSON.stringify(extraction);` (line 684). Consequence: a caller mid-ZIP-challenge who utters one intake-ish turn ("my AC is broken" → COLLECT_INFO → deterministic merge) gets `verify: {status:"pending", attempts:N}` erased — the attempt cap on the financial gate is resettable at will on the phone channel. Money/security-relevant, and the exact drift chat already fixed for itself.

**D2 — voice asks the urgency question but cannot capture the answer.** `urgency` is in `VOICE_STEP_PHRASING` ("How urgent is this? …", phone-agent.ts 99–100), so voice asks it. But `captureEnrichmentAnswer` has no urgency mapping (`STEP_TO_EXTRA` in triage.ts lacks `urgency` — it's a top-level slot), and `parseUrgencyAnswer` lives only inline in route.ts (241–254, wired at 1349–1352 with the comment "so 'this week' / 'routine' advance the stepper without an LLM call"). Voice-turn never parses urgency answers, urgency isn't in `VOICE_OPTIONAL_STEP_EXTRA` (no skip latch), so a spoken "it can wait a while" → `captured=null` → falls to the LLM → LLM persists no slots → the stepper re-asks urgency. This is the same re-ask loop chat patched, unreplicated.

**D3 — verify-state parsing validated on voice, blind-cast on chat.** Voice validates the enum and defaults attempts (306–309): `if (v && (v.status === "pending" || v.status === "passed" || v.status === "failed")) { verifyState = { status: v.status, attempts: v.attempts ?? 0 }; }`. Chat blind-casts: `(vMeta?.verify as VerifyState | undefined) ?? null` (926, 993–994). A malformed verify key is discarded by voice but fed into `advanceVerify` by chat.

**D4 — after-hours: chat runs the full move machine, voice only one move.** Chat handles every decision kind (`ask_urgency` / charge disclosure / next-day offer), each shown at most once via a comma-joined kinds latch (`!shownKinds.includes(afterHoursDecision.kind)`, 1608–1615), reads the customer's yes/no urgency answer (`readUrgencySignal`, 881–892), and coaches the LLM path (`AFTER_HOURS_LLM_INSTRUCTION` / suppression note, 1885–1892). Voice hardcodes `customerSignal: "unknown"`, acts **only** on `ahDecision.kind === "disclose_charge"` (818), latches a different format (`afterHoursShown === "1"` vs chat's kinds list), and its LLM fallback has no after-hours instruction at all. A voice caller is never asked "is this urgent?" and never gets the no-charge next-day offer.

**D5 — LLM call hardening exists only on chat.** Chat: `abortSignal: AbortSignal.timeout(30_000)` + `maxOutputTokens: 350` (1935, 1946). Voice `generateText` (996–1001) has neither — a hung upstream stalls the Twilio webhook to platform kill. Also telemetry: chat uses `after(() => recordBotEvent(...))`; voice uses `void recordBotEvent(...)` (1046) — a detached promise, which this repo's own serverless rule (memory: "use after(), not detached promises") forbids; and voice omits the model id chat records.

**D6 — unidentified ACCOUNT_LOOKUP.** Chat deliberately falls through so "the verdict's canned reply is the 'what's the email/phone on your account?' ask, surfaced by the normal deterministic path" (905–910). Voice coerces to `{ ...routed, action: "FALLBACK_LLM", reply: null }` (461–464) — the LLM improvises the identify ask. Partly intentional (ANI identity), but the canned ask was discarded rather than adapted.

**D7 — emergency escalation.** Chat appends a missing address/phone ask so the dispatcher never gets a blank-location emergency (1227–1240) and records telemetry; voice speaks `verdict.reply` verbatim, no missing-info ask, no telemetry, and its `escMerged` metadata write (656–658) again lacks `preserveVerifyKey`.

**D8 — address_parts tail.** Chat appends the raw reply as the city/ZIP tail whenever the step is pending and it isn't a phone/email (1437–1445); voice additionally requires `resolvedAddress` to be truthy (517). Guard-set drift, low impact (the lenient extractor matches most tails), but the retyped-full-street handling reached parity via two different code paths.

---

## 2. Top 5 extraction candidates (ranked)

| Rank | Extract | Location | Scope | Risk if done wrong | Payoff |
|------|---------|----------|-------|--------------------|--------|
| **1** | `serializeSessionMetadata(merged, description, priorMetadata)` — buildExtraction + slice(0,280) + `preserveVerifyKey` + stringify | `src/lib/ai/chat-slots.ts` | **Small** (7 call sites, pure function) | Wrong prior-metadata argument re-attaches a stale verify state | Fixes the live D1 security drift on voice the day it lands; makes verify-lockout preservation unforgettable at every future rebuild site; ~40 lines + 4 duplicated comments deduped |
| **2** | `runAccountVerifyTurn()` — verify-state parse (voice's validated version), `loadOnFileZips` (move chat's 152–193 into account-verify.ts), bare-ZIP answer detection, gate sequencing, kind→outcome, "passed-but-null→defer" edge | new `src/lib/ai/account-verify-turn.ts` | **Medium** (~150 lines each side collapse; returns `{outcome, verify, wantsDtmf}` — copy + persistence stay channel-side) | Financial-data gate: a wrong fall-through serves balance data unverified; must keep chat's this-turn-resolved `customerContext.customerId` and voice's `dtmfDigits` as inputs | Money gate can no longer fork (D3 + the verbatim ZIP-loader copy); ~200 lines deduped |
| **3** | `parseUrgencyAnswer` + urgency-step capture — move route.ts 241–254 into `src/lib/ai/triage.ts`, wire into voice's capture block (561–587) | `triage.ts` | **Small** | Over-eager parse misreads an unrelated utterance as urgency (mitigated: only fires when urgency step is pending, same as chat) | Fixes the D2 voice urgency re-ask loop; one urgency vocabulary for both channels |
| **4** | `decideAfterHoursTurn()` — config load + latch read/write (canonical comma-kinds format) + move selection + LLM-hint text | new `src/lib/ai/after-hours-turn.ts` | **Medium** | After-hours charge talk is compliance-sensitive copy; the "each move at most once" and "never on emergency/confirm turns" invariants must survive; voice's `"1"` latch needs a read-compat shim | Voice gains ask_urgency/next-day-offer + the LLM suppression hint (D4); charge-disclosure policy becomes single-sourced |
| **5** | `runLlmFallbackTurn()` — buildModelMessages + slot-facts hint builder + timeout/output-cap defaults + guardrail screen + token accounting + `after()`-based telemetry; channel passes persona prompt and a render callback | new `src/lib/ai/llm-fallback-turn.ts` | **Medium/large** (chat streams, voice buffers — seam must return both a text promise and usage) | Breaking chat's streaming or losing the guardrail-before-persist ordering | Fixes D5 (voice timeout/cap/detached-promise); hints stop wording-drifting; ~120 lines deduped |

Smaller cleanups not worth their own rank: `toTriageSlots(knownSlots)` helper (kills the 4x mapping), `enforceDoNotService()` (row 12), unifying the cross-channel hint template. Do them opportunistically inside the above extractions.

---

## 3. Already shared — no work needed

The heavy machinery is genuinely shared already; do **not** re-unify: `routeMessage` + router config (`intent-router`, `router-config`, `getRouterConfig`), the triage engine (`nextTriageStep`, `captureEnrichmentAnswer`, `isSkip`), slot plumbing (`parseKnownSlots`, `mergeSlots`, `hasSlotData`, `buildExtraction`, `SKIP_SENTINEL`, `stripSkipSentinels`), the verify **decision** engine (`advanceVerify`, `advanceVerifyAnswer`, `looksLikeZipAnswer`, `requiresVerify`, `extractZipsFromAddress` — and `preserveVerifyKey` already exists shared; voice just never calls it), `buildAccountLookupReply`, extractors (`extractAllContactFields`, `extractAddressAtAddressStep`, `extractSpokenPhone`, `detectCorrection`, `isBusinessName`), `withLeadIn`, `escalateSession`, `determineNextState`, `checkTokenBudget`/`addTokenUsage`, `buildModelMessages`/`MAX_HISTORY`, `screenAssistantReply`, `decideAfterHoursDisclosure`/`inferBookingTarget`/`resolveAfterHoursConfig` (the pure decision — only the *turn orchestration* around it is duplicated), availability queries + `buildWindowPrompt`/`buildVoiceWindowPrompt`, customer-context helpers, `getThread`, `recordBotEvent`, `getModel`, `submitSessionServiceRequest`. Also deliberately channel-specific (leave alone): TwiML/DTMF handling, `toSpokenReply`, `voiceNextSlotPrompt` step skipping, voice auto-submit, chat's `addressSelected`, chat's re-ask breaker + frustration offer, chat streaming.

---

## 4. First extraction — do today

**`serializeSessionMetadata` in `src/lib/ai/chat-slots.ts`** (candidate 1). Smallest seam, and it closes a real money/security drift (D1) as a side effect of the refactor rather than as a separate patch.

```ts
// src/lib/ai/chat-slots.ts  (imports preserveVerifyKey from "./account-verify")
/**
 * The ONLY way either brain may turn merged slots back into session.metadata.
 * Re-attaches the financial-verify lockout (buildExtraction does not round-trip
 * the top-level `verify` key) and applies the canonical description truncation.
 */
export function serializeSessionMetadata(
  merged: KnownSlots,
  description: string,
  priorMetadata: string | null,
): string {
  return JSON.stringify(
    preserveVerifyKey(buildExtraction(merged, description.slice(0, 280)), priorMetadata),
  );
}
```

(Direction check: `account-verify.ts` is a pure engine with no chat-slots import, so no cycle.)

**Replaces in chat (`route.ts`)** — pure refactor, byte-identical output:
- 1288–1296 (escalation `escMetadata`)
- 1511–1513 (slot-fill rebuild)
- 1740–1760 (conversation-style consolidated write — the outer `JSON.stringify(preserveVerifyKey(buildExtraction(...)))`)
- 2044–2051 (async-extraction write; pass `fresh?.metadata ?? session.metadata` as `priorMetadata`)

**Replaces in voice (`voice-turn.ts`)** — behavior change = the D1 fix:
- 682–684 (deterministic slot-fill: `metadataStr = serializeSessionMetadata(merged, firstUser, session.metadata)`)
- 656–658 (escalation merge)
- 823–826 (after-hours latch rebuild — `priorMetadata` is still `session.metadata`; the latch lives in `merged.extras`, verify rides through the helper)

**What stays outside the seam (channel-specific):** everything. The helper touches no copy and no transport — chat still returns `cannedTextResponse`/streams JSON-shaped text and composes web copy (`CONFIRM_REPLY`, chips, ESCALATION_NOTE); voice still routes every utterance through `toSpokenReply` and returns `{reply, endCall, nextState}` for the TwiML adapter. Which slots to merge, which turns write, and what is spoken/rendered remain per-brain; only "slots → metadata string" is single-sourced. Voice's `persistAccountTurn` (336–369) keeps its raw verify-merge write for now — it already preserves slots correctly and is absorbed later by candidate 2.

**Verify:** existing suites `chat-slots.test.ts` + `account-verify.test.ts` must stay green; add one voice-turn test — verify `pending` with `attempts: 2` in metadata, run a slot-provision turn, assert the persisted metadata still carries `verify` (fails today, passes after).
