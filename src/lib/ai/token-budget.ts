// Per-session LLM token budget. Most turns are handled by the deterministic
// router at 0 tokens; only novel/ambiguous turns hit the LLM (~1.5-2k tokens
// each given the windowed payload — system prompt + rolling summary + last
// MAX_HISTORY turns). 10k bought only ~5 LLM turns, so a long intake hit the cap
// and errored out. 40k (~20 LLM turns) keeps cost bounded while making
// exhaustion rare — and the chat route now degrades a hit to a human handoff
// rather than a hard error.
export const DEFAULT_TOKEN_BUDGET = 40_000;

export interface TokenBudgetState {
  tokensUsed: number;
  tokenBudget: number;
  remaining: number;
  exhausted: boolean;
  percentUsed: number;
}

export function checkTokenBudget(tokensUsed: number, tokenBudget: number = DEFAULT_TOKEN_BUDGET): TokenBudgetState {
  const remaining = Math.max(0, tokenBudget - tokensUsed);
  return {
    tokensUsed,
    tokenBudget,
    remaining,
    exhausted: remaining === 0,
    percentUsed: Math.round((tokensUsed / tokenBudget) * 100),
  };
}

export function canAffordTokens(
  tokensUsed: number,
  estimatedCost: number,
  tokenBudget: number = DEFAULT_TOKEN_BUDGET,
): boolean {
  return tokensUsed + estimatedCost <= tokenBudget;
}

export function addTokenUsage(
  currentUsage: number,
  newTokens: number,
  tokenBudget: number = DEFAULT_TOKEN_BUDGET,
): { newTotal: number; budgetState: TokenBudgetState } {
  const newTotal = currentUsage + newTokens;
  return {
    newTotal,
    budgetState: checkTokenBudget(newTotal, tokenBudget),
  };
}
