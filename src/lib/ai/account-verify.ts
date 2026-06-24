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
  if (digits.length !== 5) return false;
  return onFileZips.includes(digits);
}

/** Per-session verify state persisted under metadata.verify (as JSON). */
export interface VerifyState {
  readonly status: "pending" | "passed" | "failed";
  readonly attempts: number;
}

/** What the caller (voice or chat) should do with an account-lookup turn. */
export type VerifyDecision =
  /** Serve the account data. `verify` is the state to persist (existing state,
   *  carried unchanged for non-financial / already-passed, or the upgraded
   *  `passed` on a correct ZIP). Never a fabricated pass on a non-financial turn. */
  | { readonly kind: "serve"; readonly verify: VerifyState | null }
  /** Issue (or re-issue) the ZIP challenge; persist `verify` (pending). */
  | { readonly kind: "ask"; readonly verify: VerifyState }
  /** Refuse without re-asking (lockout / already failed); persist `verify`. */
  | { readonly kind: "defer"; readonly verify: VerifyState };

/**
 * The pure, channel-agnostic financial-verify state machine — the single source
 * of truth for "may we read this account intent aloud, and what's the next verify
 * state?". Voice and chat share it so the two channels cannot drift (a chat-only
 * reimplementation is exactly how a security gate gets a subtly different — and
 * bypassable — branch). All IO (loading on-file ZIPs, persisting state, building
 * the reply) stays in the caller; this function only decides.
 *
 * Semantics (mirrors the voice gate):
 *  - non-financial intent → serve, carrying the EXISTING state unchanged (never
 *    fabricate `passed`, which would let a later financial ask skip the check).
 *  - financial + passed → serve (unchanged).
 *  - financial + failed → defer (no re-ask).
 *  - financial + pending → check the answer's ZIP: match → serve as `passed`;
 *    mismatch → attempts++ → at/over MAX_VERIFY_ATTEMPTS defer as `failed`, else
 *    re-ask as `pending`.
 *  - financial + no state → first challenge: ask as `pending` (attempts 0).
 *
 * An empty `onFileZips` can never match (a customer with no address on file is
 * never auto-passed) — that property is inherited from {@link checkZipMatch}.
 */
export function advanceVerify(input: {
  readonly intentId: string | null;
  readonly state: VerifyState | null;
  /** The user's answer THIS turn (spoken text or DTMF digits) — only read when pending. */
  readonly zipAnswer: string;
  readonly onFileZips: readonly string[];
}): VerifyDecision {
  const { intentId, state, zipAnswer, onFileZips } = input;

  if (!requiresVerify(intentId)) {
    return { kind: "serve", verify: state };
  }
  if (state?.status === "passed") {
    return { kind: "serve", verify: state };
  }
  if (state?.status === "failed") {
    return { kind: "defer", verify: state };
  }
  if (state?.status === "pending") {
    if (checkZipMatch(zipAnswer, onFileZips)) {
      return { kind: "serve", verify: { status: "passed", attempts: state.attempts + 1 } };
    }
    const attempts = state.attempts + 1;
    return attempts >= MAX_VERIFY_ATTEMPTS
      ? { kind: "defer", verify: { status: "failed", attempts } }
      : { kind: "ask", verify: { status: "pending", attempts } };
  }
  // No verify state yet — first financial ask.
  return { kind: "ask", verify: { status: "pending", attempts: 0 } };
}

/**
 * Splice the financial-verify state back onto a freshly-built extraction object.
 *
 * The voice gather route rebuilds session metadata from buildExtraction() on a
 * background turn, but buildExtraction does NOT round-trip the top-level `verify`
 * key that voiceReply owns. Without re-attaching it, every non-financial turn
 * would WIPE the verify lockout and reset {@link MAX_VERIFY_ATTEMPTS} — letting a
 * caller retry the ZIP check indefinitely. This pure helper reads `verify` off
 * the fresh metadata JSON and re-attaches it, so the documented lockout-wipe bug
 * cannot regress. Returns the extraction unchanged when there is no verify key
 * (or the metadata is absent / unparseable).
 */
export function preserveVerifyKey<T extends object>(
  extraction: T,
  freshMetadataJson: string | null | undefined,
): T {
  let verifyKey: unknown;
  try {
    verifyKey = freshMetadataJson
      ? (JSON.parse(freshMetadataJson) as Record<string, unknown>).verify
      : undefined;
  } catch {
    verifyKey = undefined;
  }
  return verifyKey !== undefined ? { ...extraction, verify: verifyKey } : extraction;
}
