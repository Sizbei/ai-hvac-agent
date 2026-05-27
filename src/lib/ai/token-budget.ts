export const DEFAULT_TOKEN_BUDGET = 10_000;

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
