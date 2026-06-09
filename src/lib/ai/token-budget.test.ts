import { describe, it, expect } from 'vitest';
import {
  DEFAULT_TOKEN_BUDGET,
  checkTokenBudget,
  canAffordTokens,
  addTokenUsage,
} from '@/lib/ai/token-budget';

describe('DEFAULT_TOKEN_BUDGET', () => {
  it('should be 40,000 (raised from 10k so a long intake degrades gracefully rather than erroring at the cap)', () => {
    expect(DEFAULT_TOKEN_BUDGET).toBe(40_000);
  });
});

describe('checkTokenBudget', () => {
  it('should return full budget when 0 tokens used', () => {
    const state = checkTokenBudget(0);
    expect(state.tokensUsed).toBe(0);
    expect(state.tokenBudget).toBe(DEFAULT_TOKEN_BUDGET);
    expect(state.remaining).toBe(DEFAULT_TOKEN_BUDGET);
    expect(state.exhausted).toBe(false);
    expect(state.percentUsed).toBe(0);
  });

  it('should show exhausted when budget fully used', () => {
    const state = checkTokenBudget(DEFAULT_TOKEN_BUDGET);
    expect(state.remaining).toBe(0);
    expect(state.exhausted).toBe(true);
    expect(state.percentUsed).toBe(100);
  });

  it('should show 50% used at half the budget', () => {
    const state = checkTokenBudget(DEFAULT_TOKEN_BUDGET / 2);
    expect(state.remaining).toBe(DEFAULT_TOKEN_BUDGET / 2);
    expect(state.exhausted).toBe(false);
    expect(state.percentUsed).toBe(50);
  });

  it('should clamp remaining to 0 when over budget', () => {
    const state = checkTokenBudget(DEFAULT_TOKEN_BUDGET + 2_000);
    expect(state.remaining).toBe(0);
    expect(state.exhausted).toBe(true);
    expect(state.percentUsed).toBeGreaterThan(100);
  });

  it('should accept custom budget', () => {
    const state = checkTokenBudget(500, 1000);
    expect(state.tokenBudget).toBe(1000);
    expect(state.remaining).toBe(500);
    expect(state.percentUsed).toBe(50);
  });

  it('should handle edge case of 1 token remaining', () => {
    const state = checkTokenBudget(DEFAULT_TOKEN_BUDGET - 1);
    expect(state.remaining).toBe(1);
    expect(state.exhausted).toBe(false);
  });
});

describe('canAffordTokens', () => {
  it('should return true when cost fits within budget', () => {
    expect(canAffordTokens(DEFAULT_TOKEN_BUDGET - 1_000, 500)).toBe(true);
  });

  it('should return false when cost exceeds remaining budget', () => {
    expect(canAffordTokens(DEFAULT_TOKEN_BUDGET - 500, 600)).toBe(false);
  });

  it('should return false when already at budget limit', () => {
    expect(canAffordTokens(DEFAULT_TOKEN_BUDGET, 1)).toBe(false);
  });

  it('should return true when cost exactly reaches budget', () => {
    expect(canAffordTokens(DEFAULT_TOKEN_BUDGET - 500, 500)).toBe(true);
  });

  it('should return true for zero-cost operation', () => {
    expect(canAffordTokens(DEFAULT_TOKEN_BUDGET, 0)).toBe(true);
  });

  it('should work with custom budget', () => {
    expect(canAffordTokens(400, 100, 500)).toBe(true);
    expect(canAffordTokens(400, 200, 500)).toBe(false);
  });
});

describe('addTokenUsage', () => {
  it('should add tokens and return new total when within budget', () => {
    const result = addTokenUsage(5_000, 200);
    expect(result.newTotal).toBe(5_200);
    expect(result.budgetState.exhausted).toBe(false);
    expect(result.budgetState.remaining).toBe(DEFAULT_TOKEN_BUDGET - 5_200);
  });

  it('should show exhausted when addition exceeds budget', () => {
    const result = addTokenUsage(DEFAULT_TOKEN_BUDGET - 200, 300);
    expect(result.newTotal).toBe(DEFAULT_TOKEN_BUDGET + 100);
    expect(result.budgetState.exhausted).toBe(true);
    expect(result.budgetState.remaining).toBe(0);
  });

  it('should show exhausted at exactly budget', () => {
    const result = addTokenUsage(DEFAULT_TOKEN_BUDGET - 500, 500);
    expect(result.newTotal).toBe(DEFAULT_TOKEN_BUDGET);
    expect(result.budgetState.exhausted).toBe(true);
    expect(result.budgetState.remaining).toBe(0);
  });

  it('should work with zero new tokens', () => {
    const result = addTokenUsage(5_000, 0);
    expect(result.newTotal).toBe(5_000);
    expect(result.budgetState.exhausted).toBe(false);
  });

  it('should work with custom budget', () => {
    const result = addTokenUsage(400, 100, 500);
    expect(result.newTotal).toBe(500);
    expect(result.budgetState.exhausted).toBe(true);
  });
});
