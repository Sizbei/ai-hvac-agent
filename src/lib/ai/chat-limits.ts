/**
 * Per-org conversation limits — the token budget and max turns an admin can
 * tune. Defaults match the values previously hardcoded at session creation
 * (DEFAULT_TOKEN_BUDGET) and in the chat route (MAX_TURNS = 15). Bounds keep an
 * admin from setting a nonsensical value (e.g. 0 turns, or a budget so large it
 * defeats cost control).
 */
import { DEFAULT_TOKEN_BUDGET } from "./token-budget";

export { DEFAULT_TOKEN_BUDGET };

// Raised from 15 once summary-based compaction (see compaction.ts) decoupled
// conversation length from per-turn token cost — a long intake can run to ~40
// turns while the model still only sees a running summary + the recent window.
export const DEFAULT_MAX_TURNS = 40;

// Inclusive bounds enforced at the admin API boundary.
export const TOKEN_BUDGET_MIN = 1_000;
// Raised from 200k alongside compaction so an org can opt into very long
// conversations without the budget guard tripping mid-call.
export const TOKEN_BUDGET_MAX = 500_000;
export const MAX_TURNS_MIN = 3;
export const MAX_TURNS_MAX = 100;

/** Resolve an org's effective token budget, falling back to the default when
 * unset (null) or out of bounds. */
export function resolveTokenBudget(orgValue: number | null | undefined): number {
  if (
    typeof orgValue === "number" &&
    Number.isFinite(orgValue) &&
    orgValue >= TOKEN_BUDGET_MIN &&
    orgValue <= TOKEN_BUDGET_MAX
  ) {
    return Math.floor(orgValue);
  }
  return DEFAULT_TOKEN_BUDGET;
}

/** Resolve an org's effective max turns, falling back to the default when unset
 * (null) or out of bounds. */
export function resolveMaxTurns(orgValue: number | null | undefined): number {
  if (
    typeof orgValue === "number" &&
    Number.isFinite(orgValue) &&
    orgValue >= MAX_TURNS_MIN &&
    orgValue <= MAX_TURNS_MAX
  ) {
    return Math.floor(orgValue);
  }
  return DEFAULT_MAX_TURNS;
}
