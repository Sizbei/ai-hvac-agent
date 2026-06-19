/**
 * Unit tests for the behavioral probe. Pure surface only — match logic,
 * aggregation into per-behavior rates, the degrade-safe no-key path, and the
 * formatter. The generation/judge round-trip needs a live key and is NOT
 * exercised here (mirrors compare-prompts / ab-compare).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import {
  caseMatches,
  aggregate,
  comparePromptBehaviors,
  formatBehaviorReport,
  BEHAVIOR_CASES,
  type BehaviorFlags,
  type BehaviorReport,
} from "./behavior-probe";
import { MODEL_REGISTRY } from "../model-registry";

const FLAGS = (over: Partial<BehaviorFlags> = {}): BehaviorFlags => ({
  pitched: false,
  deferred: false,
  guessedSpec: false,
  ...over,
});

describe("BEHAVIOR_CASES", () => {
  it("has unique ids and an expectation on every case", () => {
    const ids = BEHAVIOR_CASES.map((c) => c.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const c of BEHAVIOR_CASES) {
      expect(Object.keys(c.expect).length).toBeGreaterThan(0);
    }
  });
});

describe("caseMatches", () => {
  it("matches when every expected flag agrees (ignores unspecified flags)", () => {
    expect(caseMatches({ pitched: false }, FLAGS({ deferred: true }))).toBe(true);
  });
  it("fails when any expected flag disagrees", () => {
    expect(caseMatches({ pitched: false }, FLAGS({ pitched: true }))).toBe(false);
  });
  it("requires ALL expectations for multi-flag cases", () => {
    const expect_ = { deferred: true, guessedSpec: false };
    expect(caseMatches(expect_, FLAGS({ deferred: true }))).toBe(true);
    expect(caseMatches(expect_, FLAGS({ deferred: true, guessedSpec: true }))).toBe(
      false,
    );
  });
});

describe("aggregate", () => {
  it("computes match rate and per-behavior rates from scored cases", () => {
    const scored = [
      { kind: "pure-education" as const, matched: true, flags: FLAGS() },
      { kind: "pure-education" as const, matched: false, flags: FLAGS({ pitched: true }) },
      { kind: "symptom" as const, matched: true, flags: FLAGS({ pitched: true }) },
      {
        kind: "spec-question" as const,
        matched: true,
        flags: FLAGS({ deferred: true }),
      },
    ];
    const r = aggregate("v", scored, 100, 50, "ok");
    expect(r.matchRate).toBe(0.75); // 3 of 4 matched
    expect(r.eduNoPitchRate).toBe(0.5); // 1 of 2 education answers did not pitch
    expect(r.symptomOffersRate).toBe(1); // the one symptom answer offered
    expect(r.specDefersRate).toBe(1);
    expect(r.specNoGuessRate).toBe(1); // guessedSpec was false
    expect(r.available).toBe(true);
  });

  it("yields null per-behavior rates when no case of that kind was scored", () => {
    const r = aggregate("v", [], 0, 0, "error: x");
    expect(r.matchRate).toBeNull();
    expect(r.eduNoPitchRate).toBeNull();
    expect(r.scoredCount).toBe(0);
    expect(r.note).toBe("error: x");
  });
});

describe("comparePromptBehaviors — degrade-safe (no keys)", () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const e of MODEL_REGISTRY) {
      saved[e.apiKeyEnv] = process.env[e.apiKeyEnv];
      delete process.env[e.apiKeyEnv];
    }
  });
  afterEach(() => {
    for (const e of MODEL_REGISTRY) {
      if (saved[e.apiKeyEnv] === undefined) delete process.env[e.apiKeyEnv];
      else process.env[e.apiKeyEnv] = saved[e.apiKeyEnv];
    }
  });

  it("marks every variant skipped, scores nothing, and never throws", async () => {
    const report = await comparePromptBehaviors([
      { label: "baseline", systemPrompt: "x" },
      { label: "candidate", systemPrompt: "y" },
    ]);
    expect(report.modelId).toBeNull();
    for (const r of report.results) {
      expect(r.available).toBe(false);
      expect(r.matchRate).toBeNull();
      expect(r.note).toMatch(/skipped/i);
    }
  });
});

describe("formatBehaviorReport", () => {
  it("prints the set-keys hint when every variant is skipped", () => {
    const report: BehaviorReport = {
      modelId: null,
      results: [
        {
          label: "baseline",
          available: false,
          matchRate: null,
          eduNoPitchRate: null,
          symptomOffersRate: null,
          specDefersRate: null,
          specNoGuessRate: null,
          scoredCount: 0,
          totalTokens: 0,
          latencyMs: 0,
          note: "skipped: no model key configured",
        },
      ],
    };
    const out = formatBehaviorReport(report);
    expect(out).toContain("No model keys configured");
  });

  it("renders rates as percentages and discloses self-judging", () => {
    const report: BehaviorReport = {
      modelId: "qwen-dashscope",
      results: [
        {
          label: "baseline",
          available: true,
          matchRate: 0.8,
          eduNoPitchRate: 1,
          symptomOffersRate: 1,
          specDefersRate: 0.5,
          specNoGuessRate: 1,
          scoredCount: 5,
          totalTokens: 1234,
          latencyMs: 999,
          note: "ok",
        },
      ],
    };
    const out = formatBehaviorReport(report);
    expect(out).toContain("100%");
    expect(out).toContain("80%");
    expect(out).toMatch(/self-evaluated/i);
  });
});
