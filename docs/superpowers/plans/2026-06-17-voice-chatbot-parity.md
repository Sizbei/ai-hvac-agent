# Voice ↔ Web Chatbot Parity Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Bring the voice/phone agent to parity with the web chat on safety (output guardrail, ANI identity gating, do-not-service) and intake quality (after-hours disclosure, token-budget enforcement, async extraction, voice-appropriate availability), by wiring `src/lib/ai/voice-turn.ts` to the helpers the chat route already uses — no web-route changes.

**Architecture:** `voiceReply()` (src/lib/ai/voice-turn.ts) is the voice orchestrator. Each gap calls an EXISTING shared helper. The only NEW code is voice-local: an ANI-resolution wrapper, a financial-verify gate, and one small shared dispatch extraction (`buildAccountLookupReply` moved out of the chat route so both channels call it). Spec: `docs/superpowers/specs/2026-06-17-voice-chatbot-parity-design.md`.

**Tech Stack:** Next.js 16 (route params are Promises; `after()` for background work), Drizzle ORM on Neon serverless (no interactive txns — `db.batch`), Vercel AI SDK (`generateText` for voice — non-streaming), Twilio TwiML (`<Gather input="dtmf speech">`), Vitest. AES-256-GCM PII encryption + HMAC blind index (`@/lib/crypto`).

---

## File Structure

**New files**
- `src/lib/voice/resolve-voice-identity.ts` — `resolveVoiceIdentity(orgId, ani)`: normalize ANI → blind-index lookup → return `CustomerContext | null`. (WS2)
- `src/lib/voice/resolve-voice-identity.test.ts`
- `src/lib/ai/account-verify.ts` — `requiresVerify(intentId)`, `extractZipsFromAddress`, `checkZipVerify(...)`, verify-state helpers. (WS3)
- `src/lib/ai/account-verify.test.ts`
- `src/lib/ai/account-dispatch.ts` — `buildAccountLookupReply(...)` + capability maps, MOVED from the chat route (shared by chat + voice). (WS3)
- `src/lib/ai/account-dispatch.test.ts` (move/extend existing coverage if any)

**Modified files**
- `src/lib/ai/voice-turn.ts` — wire WS1–WS6 into `voiceReply()`; extend `VoiceSession` with `customerId`, `tokensUsed`, `tokenBudget`.
- `src/app/api/voice/incoming/route.ts` — resolve ANI at session create (WS2); persist `customerId`.
- `src/app/api/voice/gather/route.ts` — pass `Digits` (DTMF) + the extra session fields into `voiceReply`; register `extractServiceRequest` in `after()` (WS6).
- `src/lib/voice/twiml.ts` — extend `gatherTwiML` to accept `input`/`numDigits`/`finishOnKey` for DTMF (WS3).
- `src/lib/ai/extract-spoken-phone.ts` — export a reusable `spokenToDigits(message)` (WS3, used by ZIP verify).
- `src/app/api/chat/route.ts` — import `buildAccountLookupReply` from the new `account-dispatch.ts` (behavior-preserving; WS3).
- `src/lib/ai/eval/golden-transcripts.ts` + `run-eval.ts` — add voice safety transcripts (final task).

---

## Task 1: Voice output guardrail (WS1, safety-critical)

**Files:**
- Modify: `src/lib/ai/voice-turn.ts` (import + the LLM-fallback block, lines ~14–53 imports and ~572–588)
- Test: `src/lib/ai/voice-turn.test.ts` (create if absent)

- [ ] **Step 1: Write the failing test**

Create/append `src/lib/ai/voice-turn.test.ts`. Mock the model so `generateText` returns an unsafe reply, and assert the persisted/returned reply is screened. (If a `voice-turn.test.ts` already exists, add this `describe` block and reuse its mocks.)

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

const generateTextMock = vi.fn();
vi.mock("ai", () => ({ generateText: (...a: unknown[]) => generateTextMock(...a) }));
vi.mock("@/lib/ai/provider", () => ({ getModel: vi.fn().mockResolvedValue("model") }));
vi.mock("@/lib/admin/org-config-queries", () => ({
  getRouterConfig: vi.fn().mockResolvedValue({
    disabledIssueTypes: [], disabledServiceTags: [], businessInfo: {}, customFaqs: [],
  }),
}));

const inserted: Array<Record<string, unknown>> = [];
vi.mock("@/lib/db", () => ({
  db: {
    insert: () => ({ values: (v: Record<string, unknown>) => { inserted.push(v); return Promise.resolve(); } }),
    update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
    select: () => ({ from: () => ({ where: () => ({ limit: () => Promise.resolve([]), orderBy: () => Promise.resolve([]) }) }) }),
  },
}));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

import { voiceReply } from "./voice-turn";

beforeEach(() => { inserted.length = 0; generateTextMock.mockReset(); });

describe("voiceReply output guardrail (WS1)", () => {
  it("screens an unsafe LLM reply before speaking/persisting it", async () => {
    generateTextMock.mockResolvedValue({
      text: "Great, you're all booked for Tuesday and it'll be $200.",
      usage: { inputTokens: 5, outputTokens: 5 },
    });
    const result = await voiceReply({
      session: { id: "s1", organizationId: "o1", status: "chatting", turnCount: 1, maxTurns: 40, metadata: null },
      history: [{ role: "user", content: "random question the router won't route" }],
      userMessage: "tell me a joke about my account please",
      ipAddress: "127.0.0.1",
    });
    expect(result.reply).not.toMatch(/\$\s?\d/);
    expect(result.reply.toLowerCase()).not.toContain("booked");
    const assistant = inserted.find((m) => m.role === "assistant");
    expect(String(assistant?.content)).not.toMatch(/\$\s?\d/);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/ai/voice-turn.test.ts -t "output guardrail"`
Expected: FAIL — the reply still contains "$200"/"booked" (no screening yet).

- [ ] **Step 3: Add the import**

In `src/lib/ai/voice-turn.ts`, after the existing guardrail-adjacent imports (near line 49), add:

```typescript
import { screenAssistantReply } from "./output-guardrail";
```

- [ ] **Step 4: Screen the LLM reply**

In `voice-turn.ts`, replace the LLM-fallback shaping (currently `const reply = toSpokenReply(text, { nearLimit });` at ~line 578) with:

```typescript
  // Output guardrail: screen the free-form LLM reply for the two hard safety
  // properties (never quote a price, never claim a confirmed booking) BEFORE it
  // is spoken or persisted — same net the web chat applies. Deterministic
  // template replies above are already safe.
  const screened = screenAssistantReply(text);
  if (!screened.safe) {
    logger.warn(
      { sessionId: session.id, violations: screened.violations },
      "Voice output guardrail replaced an unsafe LLM reply",
    );
  }
  const reply = toSpokenReply(screened.reply, { nearLimit });
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npx vitest run src/lib/ai/voice-turn.test.ts -t "output guardrail"`
Expected: PASS.

- [ ] **Step 6: Typecheck + commit**

Run: `npx tsc --noEmit`
```bash
git add src/lib/ai/voice-turn.ts src/lib/ai/voice-turn.test.ts
git commit -m "feat(voice): screen LLM-fallback reply with output guardrail (WS1)"
```

---

## Task 2: ANI identity resolution + do-not-service gate (WS2, safety-critical)

**Files:**
- Create: `src/lib/voice/resolve-voice-identity.ts`, `src/lib/voice/resolve-voice-identity.test.ts`
- Modify: `src/app/api/voice/incoming/route.ts` (persist resolved `customerId`), `src/app/api/voice/gather/route.ts` (pass `customerId` into `voiceReply`), `src/lib/ai/voice-turn.ts` (`VoiceSession.customerId` + early do-not-service gate)

- [ ] **Step 1: Write the failing test for the resolver**

Create `src/lib/voice/resolve-voice-identity.test.ts`:

```typescript
import { describe, it, expect, vi, beforeEach } from "vitest";

const lookupMock = vi.fn();
vi.mock("@/lib/ai/customer-context", () => ({
  lookupCustomerContext: (...a: unknown[]) => lookupMock(...a),
}));

import { resolveVoiceIdentity } from "./resolve-voice-identity";

beforeEach(() => lookupMock.mockReset());

describe("resolveVoiceIdentity", () => {
  it("returns null for absent/withheld ANI without calling the lookup", async () => {
    expect(await resolveVoiceIdentity("org1", null)).toBeNull();
    expect(await resolveVoiceIdentity("org1", "")).toBeNull();
    expect(await resolveVoiceIdentity("org1", "anonymous")).toBeNull();
    expect(lookupMock).not.toHaveBeenCalled();
  });

  it("resolves a caller by phone via lookupCustomerContext", async () => {
    lookupMock.mockResolvedValue({ customerId: "c1", doNotService: false, firstName: "Sam" });
    const ctx = await resolveVoiceIdentity("org1", "+18655551212");
    expect(ctx?.customerId).toBe("c1");
    expect(lookupMock).toHaveBeenCalledWith("org1", { phone: "+18655551212" });
  });

  it("degrades to null when the lookup throws", async () => {
    lookupMock.mockRejectedValue(new Error("db down"));
    expect(await resolveVoiceIdentity("org1", "+18655551212")).toBeNull();
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/voice/resolve-voice-identity.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement the resolver**

Create `src/lib/voice/resolve-voice-identity.ts`:

```typescript
import "server-only";
import {
  lookupCustomerContext,
  type CustomerContext,
} from "@/lib/ai/customer-context";

/** ANI values Twilio sends when the caller ID is unavailable/withheld. */
const ABSENT_ANI = new Set(["", "anonymous", "unavailable", "restricted", "unknown"]);

/**
 * Resolve the calling number (Twilio `From`/ANI) to an existing customer for the
 * org, returning light personalization context (incl. doNotService) or null.
 *
 * Pure read via the shared blind-index lookup. Degrades to null on any error or
 * absent/withheld ANI, so a failed resolution never blocks anonymous intake.
 */
export async function resolveVoiceIdentity(
  organizationId: string,
  ani: string | null | undefined,
): Promise<CustomerContext | null> {
  const trimmed = (ani ?? "").trim();
  if (trimmed.length === 0 || ABSENT_ANI.has(trimmed.toLowerCase())) return null;
  try {
    return await lookupCustomerContext(organizationId, { phone: trimmed });
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/voice/resolve-voice-identity.test.ts`
Expected: PASS.

- [ ] **Step 5: Persist customerId at session create**

In `src/app/api/voice/incoming/route.ts`: add the import and resolve the caller from `params.From`, writing `customerId` onto the inserted session. After the `organizationId = DEMO_ORG_ID;` line (~59), add:

```typescript
    const callerContext = await resolveVoiceIdentity(organizationId, params.From);
```

Add the import at the top:

```typescript
import { resolveVoiceIdentity } from "@/lib/voice/resolve-voice-identity";
```

Then in the `.values({...})` of the session insert, add:

```typescript
        customerId: callerContext?.customerId ?? null,
```

- [ ] **Step 6: Thread customerId into voiceReply**

In `src/app/api/voice/gather/route.ts`, the `voiceReply({ session: {...} })` call (~104): add `customerId: session.customerId` to the session object.

In `src/lib/ai/voice-turn.ts`, extend the `VoiceSession` interface (after `runningSummary`, ~line 134):

```typescript
  readonly customerId?: string | null;
```

- [ ] **Step 7: Write the failing test for the do-not-service gate**

Append to `src/lib/ai/voice-turn.test.ts`. Add to the existing `@/lib/db` mock a `select` that returns a flagged customer row, then:

```typescript
describe("voiceReply do-not-service (WS2)", () => {
  it("refuses + ends the call when the resolved caller is flagged", async () => {
    // Arrange: a customerId on the session + a customers row with doNotService=true.
    // (Adjust the shared db mock so select().from(customers)...limit() returns
    //  [{ doNotService: true }] for this test.)
    const result = await voiceReply({
      session: { id: "s1", organizationId: "o1", status: "chatting", turnCount: 1, maxTurns: 40, metadata: null, customerId: "c-flagged" },
      history: [],
      userMessage: "my ac is broken",
      ipAddress: "127.0.0.1",
    });
    expect(result.endCall).toBe(true);
    expect(result.reply.toLowerCase()).toContain("office");
  });
});
```

- [ ] **Step 8: Run it (fails)**

Run: `npx vitest run src/lib/ai/voice-turn.test.ts -t "do-not-service"`
Expected: FAIL — no gate yet (call proceeds).

- [ ] **Step 9: Implement the early do-not-service gate**

In `src/lib/ai/voice-turn.ts`, add the imports (`customers` to the schema import on line 17; `withTenant`):

```typescript
import { customerSessions, messages, customers } from "@/lib/db/schema";
import { withTenant } from "@/lib/db/tenant";
```

Then immediately after persisting the caller's turn (after the user-message `db.insert(messages)` at ~line 167), insert:

```typescript
  // Do-not-service early gate (parity with the web chat). When ANI resolved this
  // call to a flagged customer, refuse before any router/LLM work. Non-critical:
  // a DB blip degrades to "no early gate" (the submit-time backstop still holds).
  if (session.customerId) {
    try {
      const [flagRow] = await db
        .select({ doNotService: customers.doNotService })
        .from(customers)
        .where(withTenant(customers, organizationId, eq(customers.id, session.customerId)))
        .limit(1);
      if (flagRow?.doNotService) {
        const reply = toSpokenReply(VOICE_OFFICE_REPLY, {});
        await db.insert(messages).values({
          organizationId, sessionId: session.id, role: "assistant", content: reply, tokensUsed: 0,
        });
        await db.update(customerSessions)
          .set({ turnCount: newTurnCount, updatedAt: new Date() })
          .where(sessionScope);
        return { reply, endCall: true, nextState: session.status };
      }
    } catch (e: unknown) {
      logger.error({ error: e, sessionId: session.id }, "voice do-not-service gate read failed");
    }
  }
```

- [ ] **Step 10: Run tests (pass)**

Run: `npx vitest run src/lib/ai/voice-turn.test.ts src/lib/voice/resolve-voice-identity.test.ts`
Expected: PASS.

- [ ] **Step 11: Typecheck + commit**

Run: `npx tsc --noEmit`
```bash
git add src/lib/voice/resolve-voice-identity.ts src/lib/voice/resolve-voice-identity.test.ts src/app/api/voice/incoming/route.ts src/app/api/voice/gather/route.ts src/lib/ai/voice-turn.ts src/lib/ai/voice-turn.test.ts
git commit -m "feat(voice): ANI identity resolution + do-not-service early gate (WS2)"
```

---

## Task 3: Account lookups + financial verify gate (WS3, safety-critical)

This is the largest task. Sub-steps: (3a) extract the dispatcher, (3b) the verify module, (3c) DTMF TwiML, (3d) wire the verify state machine into `voiceReply`.

### 3a — Extract `buildAccountLookupReply` to a shared module

**Files:** Create `src/lib/ai/account-dispatch.ts`; Modify `src/app/api/chat/route.ts`.

- [ ] **Step 1: Move the dispatcher.** Cut `ACCOUNT_INTENT_CAPABILITY`, `LEGACY_ACCOUNT_INTENT_TOOL`, the `AccountCapability` type, and `buildAccountLookupReply(...)` (chat route ~384–470) into a new `src/lib/ai/account-dispatch.ts`, exporting `buildAccountLookupReply` and `ACCOUNT_INTENT_CAPABILITY`. Keep the imports it needs (account-tools, account-reply). Do not change the logic.

- [ ] **Step 2: Import it back into the chat route.** In `src/app/api/chat/route.ts`, delete the moved code and add:

```typescript
import { buildAccountLookupReply } from "@/lib/ai/account-dispatch";
```

- [ ] **Step 3: Verify chat is unchanged.**

Run: `npm run test:unit` and `npm run eval`
Expected: all green, eval 25/25, 0 critical (behavior-preserving move).

- [ ] **Step 4: Commit.**
```bash
git add src/lib/ai/account-dispatch.ts src/app/api/chat/route.ts
git commit -m "refactor(ai): extract buildAccountLookupReply to account-dispatch (shared by chat+voice)"
```

### 3b — Verify module (`account-verify.ts`)

**Files:** Create `src/lib/ai/account-verify.ts`, `src/lib/ai/account-verify.test.ts`; Modify `src/lib/ai/extract-spoken-phone.ts` (export `spokenToDigits`).

- [ ] **Step 1: Export the digit normalizer.** In `src/lib/ai/extract-spoken-phone.ts`, change `function wordsToDigits` to an exported `export function spokenToDigits(message: string): string` (same body) and update `extractSpokenPhone` to call `spokenToDigits`. (Reused so ZIP verify handles "oh"/"zero".)

- [ ] **Step 2: Write the failing test.** Create `src/lib/ai/account-verify.test.ts`:

```typescript
import { describe, it, expect } from "vitest";
import { requiresVerify, extractZipsFromAddress, checkZipMatch } from "./account-verify";

describe("requiresVerify", () => {
  it("gates financial intents only", () => {
    expect(requiresVerify("account-data-balance")).toBe(true);
    expect(requiresVerify("account-data-membership-status")).toBe(true);
    expect(requiresVerify("account-data-next-visit")).toBe(false);
    expect(requiresVerify("account-data-appointment-status")).toBe(false);
    expect(requiresVerify(null)).toBe(false);
  });
});

describe("extractZipsFromAddress", () => {
  it("pulls a 5-digit ZIP from a US address", () => {
    expect(extractZipsFromAddress("212 E Unaka Ave, Johnson City, TN 37601")).toEqual(["37601"]);
  });
  it("returns [] when no 5-digit ZIP is present (non-US / missing)", () => {
    expect(extractZipsFromAddress("12 King St, Toronto, ON K1A 0B1")).toEqual([]);
  });
});

describe("checkZipMatch", () => {
  it("matches DTMF digits against any on-file ZIP", () => {
    expect(checkZipMatch("37601", ["37601", "37615"])).toBe(true);
  });
  it("matches a spoken ZIP with 'oh' for zero", () => {
    expect(checkZipMatch("three seven six oh one", ["37601"])).toBe(true);
  });
  it("rejects a mismatch", () => {
    expect(checkZipMatch("00000", ["37601"])).toBe(false);
  });
});
```

- [ ] **Step 3: Run it (fails).** Run: `npx vitest run src/lib/ai/account-verify.test.ts` → FAIL (module not found).

- [ ] **Step 4: Implement.** Create `src/lib/ai/account-verify.ts`:

```typescript
import { spokenToDigits } from "./extract-spoken-phone";

/** Intent → whether reading its answer aloud needs a verify step. Data-driven. */
const INTENT_SENSITIVITY: Record<string, "financial" | "none"> = {
  "account-data-balance": "financial",
  "account-data-membership-status": "financial",
  "account-data-next-visit": "none",
  "account-data-appointment-status": "none",
  "account-data-reschedule": "none",
};

export function requiresVerify(intentId: string | null): boolean {
  return intentId !== null && INTENT_SENSITIVITY[intentId] === "financial";
}

/** Up to 2 verify attempts per call before deferral. */
export const MAX_VERIFY_ATTEMPTS = 2;

/** Pull all 5-digit ZIPs from a decrypted address string (US-only). */
export function extractZipsFromAddress(address: string | null): string[] {
  if (!address) return [];
  const out: string[] = [];
  for (const m of address.matchAll(/\b(\d{5})(?:-\d{4})?\b/g)) out.push(m[1]);
  return out;
}

/** Reduce an answer (DTMF digits or spoken words) to its bare digits. */
function answerToDigits(answer: string): string {
  return spokenToDigits(answer).replace(/\D/g, "");
}

/** True when the answer's 5 digits match ANY on-file ZIP. */
export function checkZipMatch(answer: string, onFileZips: readonly string[]): boolean {
  const digits = answerToDigits(answer);
  if (digits.length < 5) return false;
  const zip5 = digits.slice(0, 5);
  return onFileZips.includes(zip5);
}

/** Per-session verify state persisted under metadata.extras.verify (as JSON). */
export interface VerifyState {
  readonly status: "pending" | "passed" | "failed";
  readonly attempts: number;
}
```

- [ ] **Step 5: Run it (pass).** Run: `npx vitest run src/lib/ai/account-verify.test.ts` → PASS.

- [ ] **Step 6: Commit.**
```bash
git add src/lib/ai/account-verify.ts src/lib/ai/account-verify.test.ts src/lib/ai/extract-spoken-phone.ts
git commit -m "feat(ai): account financial-verify primitives (requiresVerify, ZIP match) (WS3)"
```

### 3c — DTMF-capable gather TwiML

**Files:** Modify `src/lib/voice/twiml.ts`, `src/app/api/voice/gather/route.ts`.

- [ ] **Step 1: Extend `gatherTwiML`.** In `src/lib/voice/twiml.ts`, add optional `input?: "speech" | "dtmf speech"`, `numDigits?: number`, `finishOnKey?: string` to `gatherTwiML`'s params and render them on the `<Gather>` element (default `input="speech"`, unchanged when omitted). Add a unit test in the existing twiml test file asserting `<Gather input="dtmf speech" numDigits="5">` renders when those are passed.

- [ ] **Step 2: Surface `Digits` in the gather route.** In `src/app/api/voice/gather/route.ts`, read `const digits = (params.Digits ?? "").trim();` and pass `userMessage: digits.length > 0 ? digits : sanitized.sanitized` is WRONG (DTMF must be routed only to verify). Instead, pass a new field into `voiceReply`: `dtmfDigits: digits || null`. Add `readonly dtmfDigits?: string | null;` to the `voiceReply` params type.

- [ ] **Step 3: Commit.**
```bash
git add src/lib/voice/twiml.ts src/app/api/voice/gather/route.ts
git commit -m "feat(voice): DTMF-capable gather TwiML + Digits passthrough (WS3)"
```

### 3d — Verify state machine + account dispatch in `voiceReply`

**Files:** Modify `src/lib/ai/voice-turn.ts`; Test in `src/lib/ai/voice-turn.test.ts`.

- [ ] **Step 1: Write the failing tests** (append to `voice-turn.test.ts`): (a) a `balance` intent from a resolved caller with NO verify state asks for the ZIP and sets `extras.verify.status="pending"`, speaking NO balance; (b) a `pending` verify + matching DTMF serves the balance; (c) two mismatches → `failed` + deferral copy, and a later balance ask is NOT re-verified (returns deferral, never the number).

```typescript
describe("voiceReply financial verify (WS3)", () => {
  it("asks for ZIP and does NOT read the balance on first financial ask", async () => {
    // router → ACCOUNT_LOOKUP intentId "account-data-balance"; session.customerId set.
    // assert reply mentions ZIP, contains no "$", and metadata.extras.verify.status === "pending".
  });
  it("serves the balance after a matching DTMF ZIP", async () => {
    // session.metadata extras.verify = { status: "pending", attempts: 0 }; dtmfDigits = on-file ZIP.
    // assert reply contains the balance figure.
  });
  it("defers after 2 mismatches and never re-asks", async () => {
    // attempts already 1, dtmfDigits wrong → status "failed", deferral copy, no balance.
  });
});
```

- [ ] **Step 2: Run (fails).** Run: `npx vitest run src/lib/ai/voice-turn.test.ts -t "financial verify"` → FAIL.

- [ ] **Step 3: Implement the account+verify branch.** In `voice-turn.ts`, add imports:

```typescript
import { buildAccountLookupReply } from "./account-dispatch";
import { requiresVerify, checkZipMatch, extractZipsFromAddress, MAX_VERIFY_ATTEMPTS, type VerifyState } from "./account-verify";
import { decrypt } from "@/lib/crypto";
import { customerLocations } from "@/lib/db/schema";
```

Replace the `ACCOUNT_LOOKUP → FALLBACK_LLM` coercion (lines ~179–182) with a real branch: if `routed.action === "ACCOUNT_LOOKUP"` AND `session.customerId`, handle it here (verify gate for financial intents; serve via `buildAccountLookupReply(routed.intentId, organizationId, session.customerId, userMessage)` — note the real 4-arg signature `(intentId, organizationId, customerId, message)` returning `Promise<string | null>`; export it from `account-dispatch.ts` in 3a — otherwise). Use a fixed deferral line:

```typescript
const VOICE_VERIFY_ASK = "To pull up your account, can you tell me or key in the 5-digit ZIP code on your account?";
const VOICE_VERIFY_DEFER = "I can't confirm that over the phone right now — I'll have our team follow up, or you can check your account online. Anything else I can help with?";
```

Logic (insert before the existing router/extraction work, returning early like the do-not-service gate): when the intent is non-financial → serve immediately. When financial: read `extras.verify`; if `passed` → serve; if `failed` → defer; else treat `dtmfDigits ?? userMessage` as the ZIP answer when a verify is already pending, compare with `checkZipMatch` against ZIPs from the decrypted `customers.addressEncrypted` + each `customerLocations.addressEncrypted` (tenant-scoped, `safeDecrypt`-style try/catch); on match set `passed` + serve; on miss increment attempts, set `failed` + defer at `MAX_VERIFY_ATTEMPTS`, else re-ask; when no verify pending yet, set `pending`/attempts 0 and speak `VOICE_VERIFY_ASK`. Persist `extras.verify` via the existing `mergeSlots`/metadata write. Each turn that asks/serves/defers persists the assistant message + `turnCount` like the other branches and returns `{ reply, endCall: false, nextState }`.

(Keep the unresolved-caller case — no `session.customerId` — falling through to the LLM as today.)

- [ ] **Step 4: Run (pass).** Run: `npx vitest run src/lib/ai/voice-turn.test.ts -t "financial verify"` → PASS.

- [ ] **Step 5: Typecheck + commit.**

Run: `npx tsc --noEmit`
```bash
git add src/lib/ai/voice-turn.ts src/lib/ai/voice-turn.test.ts
git commit -m "feat(voice): account lookups + financial ZIP-verify gate (WS3)"
```

---

## Task 4: After-hours disclosure on voice (WS4, intake-quality)

**Files:** Modify `src/lib/ai/voice-turn.ts`; Test in `voice-turn.test.ts`. Reuses the EXISTING pure `decideAfterHoursDisclosure` (`src/lib/ai/after-hours-chat.ts`) and the org `afterHoursConfig` query/resolver the chat route uses.

- [ ] **Step 1: Confirm the helper contract.** Read `src/lib/ai/after-hours-chat.ts` for `decideAfterHoursDisclosure(input)` (`AfterHoursDecisionInput` → `AfterHoursDecision { kind, afterHours, ... }`, kind incl. `"disclose_charge"`) and how the chat route loads `organizationSettings.afterHoursConfig` → `resolveAfterHoursConfig`.

- [ ] **Step 2: Write the failing test.** In `voice-turn.test.ts`, mock the config query to an after-hours window and an urgent caller; assert the spoken reply includes the disclosure phrase ("after our normal hours") and NO dollar amount; and that a hazard/emergency turn escalates WITHOUT the disclosure.

- [ ] **Step 3: Run (fails).** `npx vitest run src/lib/ai/voice-turn.test.ts -t "after-hours"` → FAIL.

- [ ] **Step 4: Implement.** In the deterministic intake branch of `voiceReply`, after the emergency check (which already short-circuits), load `afterHoursConfig` (same query the chat route uses), call `decideAfterHoursDisclosure({ clock: new Date(), config, urgency: merged.urgency ?? null, customerSignal: "unknown" })`, and when `kind === "disclose_charge"` (and not already latched in `extras.afterHoursShown`) prepend the canned disclosure line to the next question and latch `extras.afterHoursShown="1"`. Wrap the config load in try/catch → no disclosure on error.

- [ ] **Step 5: Run (pass)** → commit.
```bash
git add src/lib/ai/voice-turn.ts src/lib/ai/voice-turn.test.ts
git commit -m "feat(voice): after-hours charge disclosure via shared decision helper (WS4)"
```

---

## Task 5: Async extraction + token-budget enforcement (WS6, intake-quality)

**Files:** Modify `src/app/api/voice/gather/route.ts` (register `extractServiceRequest` in `after()`, pass budget fields), `src/lib/ai/voice-turn.ts` (`VoiceSession.tokensUsed`/`tokenBudget` + budget check + token accounting on the LLM path).

- [ ] **Step 1: Write the failing test.** In `voice-turn.test.ts`: a session whose `tokensUsed >= tokenBudget` returns a graceful handoff + `nextState` escalated/terminal WITHOUT calling `generateText`.

- [ ] **Step 2: Run (fails).**

- [ ] **Step 3: Implement budget check.** Add `readonly tokensUsed?: number; readonly tokenBudget?: number;` to `VoiceSession`. Import `checkTokenBudget`, `addTokenUsage` from `./token-budget`. Before the LLM `generateText` call (~line 572), add:

```typescript
  const budget = checkTokenBudget(session.tokensUsed ?? 0, session.tokenBudget);
  if (budget.exhausted) {
    const reply = toSpokenReply(VOICE_OFFICE_REPLY, { nearLimit });
    await db.insert(messages).values({ organizationId, sessionId: session.id, role: "assistant", content: reply, tokensUsed: 0 });
    await escalateSession({ organizationId, sessionId: session.id, currentStatus: session.status, ipAddress }).catch(() => {});
    await db.update(customerSessions).set({ turnCount: newTurnCount, updatedAt: new Date() }).where(sessionScope);
    return { reply, endCall: true, nextState: "escalated" };
  }
```

After the LLM call, accumulate usage: change the session update on the LLM path to also write `tokensUsed: addTokenUsage(session.tokensUsed ?? 0, tokensThisCall, session.tokenBudget).newTotal`.

- [ ] **Step 4: Pass session budget fields.** In `gather/route.ts`'s `voiceReply` call, add `tokensUsed: session.tokensUsed, tokenBudget: session.tokenBudget`.

- [ ] **Step 5: Register async extraction.** In `gather/route.ts`, alongside the existing compaction `after()`, register a second best-effort `after()` that calls `extractServiceRequest(chatHistory, sanitized.sanitized, organizationId)` and merges results into the session metadata (mirror the chat route's after-extraction merge; never overwrite a filled slot). Wrap in try/catch → log only.

- [ ] **Step 6: Run + typecheck + commit.**

Run: `npx vitest run src/lib/ai/voice-turn.test.ts` ; `npx tsc --noEmit`
```bash
git add src/lib/ai/voice-turn.ts src/app/api/voice/gather/route.ts src/lib/ai/voice-turn.test.ts
git commit -m "feat(voice): token-budget enforcement + async extraction parity (WS6)"
```

---

## Task 6: Voice-appropriate availability offer (WS5, intake-quality — last; deferrable)

**Files:** Modify `src/lib/ai/voice-turn.ts` (window step) + `src/lib/ai/phone-agent.ts` (`voiceNextSlotPrompt` window phrasing). Reuses the chat route's availability fetch (`getOpenAvailability` + `buildWindowPrompt`).

> **Decision gate (from the spec):** before building, confirm real-window offers earn their keep on voice. If not, SKIP this task — the generic "morning, afternoon, or evening?" prompt already works. If building, cap at 2 bands with DTMF/number selection.

- [ ] **Step 1: Write the failing test.** At the `preferred_window` step with availability mocked to ≥2 bands, assert the spoken prompt offers at most 2 concrete bands and a numbered/DTMF selection, and that a "1"/"2" DTMF reply maps to the right band enum via `captureEnrichmentAnswer`. With zero availability, assert it falls back to the generic prompt.

- [ ] **Step 2: Run (fails).**

- [ ] **Step 3: Implement.** At the window step, fetch availability (same helper the chat route uses), take the first 2 bands, render "For <band A> press 1, for <band B> press 2, or say another time", and map DTMF "1"/"2" to the band enum before `captureEnrichmentAnswer`. On empty/error/miss → existing generic prompt.

- [ ] **Step 4: Run + commit.**
```bash
git add src/lib/ai/voice-turn.ts src/lib/ai/phone-agent.ts src/lib/ai/voice-turn.test.ts
git commit -m "feat(voice): voice-appropriate (≤2 band, DTMF-select) availability offer (WS5)"
```

---

## Task 7: Voice safety eval transcripts (final)

**Files:** Modify `src/lib/ai/eval/golden-transcripts.ts`, `src/lib/ai/eval/run-eval.ts`.

- [ ] **Step 1: Add phone-channel safety transcripts** exercising the deterministic-checkable properties over voice: pricing-leak (must not), false-booking (must not), account-data-without-verify (must not leak a balance), do-not-service caller (must refuse). Mark the safety checks `critical`.

- [ ] **Step 2: Run the eval.** Run: `npm run eval` → 25+ transcripts, **0 critical failures**.

- [ ] **Step 3: Full gate + commit.**

Run: `npx tsc --noEmit && npm run test:unit && npm run eval && npm run build`
```bash
git add src/lib/ai/eval/golden-transcripts.ts src/lib/ai/eval/run-eval.ts
git commit -m "test(eval): voice safety transcripts (pricing/booking/account/do-not-service)"
```

---

## Final verification (before merge/deploy)

- [ ] `npx tsc --noEmit` — clean
- [ ] `npm run test:unit` — all pass
- [ ] `npm run eval` — 0 critical failures
- [ ] `npm run build` — succeeds
- [ ] Manual: confirm with the operator that **service ZIP** (name fallback) and **DTMF entry** are acceptable for the verify step.
- [ ] No DB migration required (reuses `customerSessions.customerId` + `metadata.extras.verify`).

## Notes on coverage vs. spec
- Spec WS1→Task 1; WS2→Task 2; WS3→Task 3 (3a–3d); WS4→Task 4; WS6→Task 5; WS5→Task 6; eval/testing→Task 7. Build order matches the spec (WS1→2→3→4→6→5).
- The spec's "no name greeting from ANI alone" is satisfied by design: `resolveVoiceIdentity` returns context used only for do-not-service + (later) in-conversation personalization; no task speaks the name on the opening turn (the incoming greeting is the existing neutral `GREETING`).
- The spec's latency + hang-up notes are inherent (voice already uses non-streaming `generateText`; `after()` extraction is best-effort) — no task needed.
