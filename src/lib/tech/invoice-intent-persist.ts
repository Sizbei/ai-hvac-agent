/**
 * Pure helpers that persist in-flight idempotency intents to `sessionStorage`
 * (spec §7.5): a reload must not mint a fresh key while a request may still be
 * in flight. Only `sent`/`unknown` intents are stored; after a reload a `sent`
 * one is `unknown` (its outcome was never seen).
 */
import type { KeyState } from "./invoice-key-state";

export const INTENTS_STORAGE_KEY = (requestId: string) => `tech:invoice:${requestId}:intents`;

type InFlight = Exclude<KeyState, { phase: "idle" }> & { readonly phase: "sent" | "unknown" };

function isInFlight(s: KeyState): s is InFlight {
  return s.phase === "sent" || s.phase === "unknown";
}

export function serializeIntents(states: Record<string, KeyState>): string {
  const kept: Record<string, InFlight> = {};
  for (const [id, s] of Object.entries(states)) {
    if (isInFlight(s)) kept[id] = { phase: s.phase, key: s.key, bodyHash: s.bodyHash, body: s.body };
  }
  return JSON.stringify(kept);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function parseIntents(raw: string | null): Record<string, KeyState> {
  if (!raw) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return {};
  }
  if (!isRecord(parsed)) return {};
  const out: Record<string, KeyState> = {};
  for (const [id, v] of Object.entries(parsed)) {
    if (!isRecord(v) || (v.phase !== "sent" && v.phase !== "unknown")) continue;
    if (typeof v.key !== "string" || typeof v.bodyHash !== "string" || !("body" in v)) continue;
    out[id] = { phase: "unknown", key: v.key, bodyHash: v.bodyHash, body: v.body };
  }
  return out;
}

/** What the hook does to storage for a transition; applied BEFORE the fetch. */
export function persistOps(prev: KeyState, next: KeyState): "write" | "clear" | "none" {
  if (isInFlight(next)) return "write";
  return isInFlight(prev) ? "clear" : "none";
}
