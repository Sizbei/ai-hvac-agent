/**
 * Idempotency intents for the estimate and equipment writes (M3c spec §7):
 * their own sessionStorage key (never the M3b invoice key), stored bodies that
 * carry their own path so a reload can re-send them, and the write copy.
 */
import { parseIntents, serializeIntents } from "./invoice-intent-persist";
import type { WriteOutcome } from "./invoice-key-state";

export const ESTIMATE_INTENTS_KEY = (requestId: string) => `tech:estimate:${requestId}:intents`;

export const ESTIMATE_INTENT = {
  create: "estimate:create",
  sell: (estimateId: string) => `estimate:sell:${estimateId}`,
  bill: (estimateId: string) => `estimate:bill:${estimateId}`,
  decline: (estimateId: string) => `estimate:decline:${estimateId}`,
  equipmentAdd: "equipment:add",
  equipmentReplace: (unitId: string) => `equipment:replace:${unitId}`,
} as const;

export interface StoredWrite {
  readonly path: string;
  readonly payload: unknown;
}

export function isStoredWrite(v: unknown): v is StoredWrite {
  if (typeof v !== "object" || v === null || !("payload" in v)) return false;
  const path = (v as { path?: unknown }).path; // read once: a second cast after `in` narrowing is TS2352
  return typeof path === "string" && path.startsWith("/api/tech/jobs/");
}

export interface RecoverableIntent {
  readonly intentId: string;
  readonly key: string;
  readonly write: StoredWrite;
}

export function storedToRecover(raw: string | null, match: (intentId: string) => boolean): RecoverableIntent[] {
  const out: RecoverableIntent[] = [];
  for (const [intentId, s] of Object.entries(parseIntents(raw))) {
    if (!match(intentId) || s.phase === "idle" || !isStoredWrite(s.body)) continue;
    out.push({ intentId, key: s.key, write: s.body });
  }
  return out;
}

/** An answer that still leaves the write's fate unknown keeps it stored. */
export function recoveryKeeps(outcome: WriteOutcome): boolean {
  return outcome === "retry_same_key_after_refetch" || outcome === "wait_then_refetch";
}

/** The stored map without `intentId`, or null when nothing is left. */
export function withoutIntent(raw: string | null, intentId: string): string | null {
  const rest = Object.fromEntries(Object.entries(parseIntents(raw)).filter(([id]) => id !== intentId));
  return Object.keys(rest).length === 0 ? null : serializeIntents(rest);
}

export interface EnvelopeLike {
  readonly error?: { readonly code?: string; readonly message?: string };
}

const FALLBACK = "Couldn't save that. Try again.";

export function estimateWriteCopy(outcome: WriteOutcome, envelope: EnvelopeLike | null): string {
  switch (outcome) {
    case "retry_same_key_after_refetch":
      return "Your last tap may not have saved. Try again.";
    case "wait_then_refetch":
      return "Still saving your last tap…";
    case "spent_new_key":
      return envelope?.error?.code === "IDEMPOTENCY_KEY_REUSED" ? "That tap didn't go through. Try again." : envelope?.error?.message ?? FALLBACK;
    default:
      return envelope?.error?.message ?? FALLBACK;
  }
}
