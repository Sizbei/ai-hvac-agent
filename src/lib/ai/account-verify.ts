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
