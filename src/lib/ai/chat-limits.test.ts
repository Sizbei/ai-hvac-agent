import { describe, it, expect } from "vitest";
import {
  resolveTokenBudget,
  resolveMaxTurns,
  DEFAULT_TOKEN_BUDGET,
  DEFAULT_MAX_TURNS,
  TOKEN_BUDGET_MIN,
  TOKEN_BUDGET_MAX,
  MAX_TURNS_MIN,
  MAX_TURNS_MAX,
} from "./chat-limits";

describe("resolveTokenBudget", () => {
  it("returns the default for null/undefined (unconfigured org)", () => {
    expect(resolveTokenBudget(null)).toBe(DEFAULT_TOKEN_BUDGET);
    expect(resolveTokenBudget(undefined)).toBe(DEFAULT_TOKEN_BUDGET);
  });

  it("returns an in-range configured value", () => {
    expect(resolveTokenBudget(25_000)).toBe(25_000);
    expect(resolveTokenBudget(TOKEN_BUDGET_MIN)).toBe(TOKEN_BUDGET_MIN);
    expect(resolveTokenBudget(TOKEN_BUDGET_MAX)).toBe(TOKEN_BUDGET_MAX);
  });

  it("falls back to the default for out-of-range or non-finite values", () => {
    expect(resolveTokenBudget(TOKEN_BUDGET_MIN - 1)).toBe(DEFAULT_TOKEN_BUDGET);
    expect(resolveTokenBudget(TOKEN_BUDGET_MAX + 1)).toBe(DEFAULT_TOKEN_BUDGET);
    expect(resolveTokenBudget(0)).toBe(DEFAULT_TOKEN_BUDGET);
    expect(resolveTokenBudget(Number.NaN)).toBe(DEFAULT_TOKEN_BUDGET);
    expect(resolveTokenBudget(Number.POSITIVE_INFINITY)).toBe(
      DEFAULT_TOKEN_BUDGET,
    );
  });

  it("floors a fractional in-range value", () => {
    expect(resolveTokenBudget(12_345.9)).toBe(12_345);
  });
});

describe("resolveMaxTurns", () => {
  it("returns the default for null/undefined", () => {
    expect(resolveMaxTurns(null)).toBe(DEFAULT_MAX_TURNS);
    expect(resolveMaxTurns(undefined)).toBe(DEFAULT_MAX_TURNS);
  });

  it("returns an in-range configured value", () => {
    expect(resolveMaxTurns(25)).toBe(25);
    expect(resolveMaxTurns(MAX_TURNS_MIN)).toBe(MAX_TURNS_MIN);
    expect(resolveMaxTurns(MAX_TURNS_MAX)).toBe(MAX_TURNS_MAX);
  });

  it("falls back to the default for out-of-range or non-finite values", () => {
    expect(resolveMaxTurns(MAX_TURNS_MIN - 1)).toBe(DEFAULT_MAX_TURNS);
    expect(resolveMaxTurns(MAX_TURNS_MAX + 1)).toBe(DEFAULT_MAX_TURNS);
    expect(resolveMaxTurns(0)).toBe(DEFAULT_MAX_TURNS);
    expect(resolveMaxTurns(Number.NaN)).toBe(DEFAULT_MAX_TURNS);
    expect(resolveMaxTurns(Number.POSITIVE_INFINITY)).toBe(DEFAULT_MAX_TURNS);
  });

  it("floors a fractional in-range value", () => {
    expect(resolveMaxTurns(20.7)).toBe(20);
  });
});
