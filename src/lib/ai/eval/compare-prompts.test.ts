/**
 * Unit tests for the PROMPT A/B harness. These exercise the PURE surface only —
 * variant loading from disk, averaging, the degrade-safe no-key path, and the
 * report formatter (incl. the delta row). The actual generation/judge round-trip
 * needs a live model key and is NOT exercised here (mirrors ab-compare, whose
 * model layer is also key-gated and offline-skipped).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadPromptVariants,
  firstAvailableModelId,
  comparePrompts,
  avg,
  formatPromptABReport,
  type PromptABReport,
} from "./compare-prompts";
import { SYSTEM_PROMPT } from "../system-prompt";
import { MODEL_REGISTRY } from "../model-registry";

describe("avg", () => {
  it("returns null for an empty list", () => {
    expect(avg([])).toBeNull();
  });
  it("averages a non-empty list", () => {
    expect(avg([2, 4, 6])).toBe(4);
  });
});

describe("loadPromptVariants", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "prompt-variants-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("always includes the live baseline first", () => {
    const variants = loadPromptVariants(dir);
    expect(variants[0].label).toMatch(/baseline/i);
    expect(variants[0].systemPrompt).toBe(SYSTEM_PROMPT);
  });

  it("returns baseline-only for a missing directory (never throws)", () => {
    const variants = loadPromptVariants(join(dir, "does-not-exist"));
    expect(variants).toHaveLength(1);
    expect(variants[0].systemPrompt).toBe(SYSTEM_PROMPT);
  });

  it("loads *.txt candidates sorted, using the filename as the label", () => {
    writeFileSync(join(dir, "b-softer.txt"), "/no_think\nSofter prompt body.");
    writeFileSync(join(dir, "a-tighter.txt"), "/no_think\nTighter prompt body.");
    const variants = loadPromptVariants(dir);
    expect(variants.map((v) => v.label)).toEqual([
      "baseline (live SYSTEM_PROMPT)",
      "a-tighter",
      "b-softer",
    ]);
    expect(variants[1].systemPrompt).toContain("Tighter prompt body.");
  });

  it("ignores non-.txt files and empty/whitespace-only candidates", () => {
    writeFileSync(join(dir, "notes.md"), "not a prompt");
    writeFileSync(join(dir, "blank.txt"), "   \n  ");
    writeFileSync(join(dir, "real.txt"), "actual prompt");
    const variants = loadPromptVariants(dir);
    expect(variants.map((v) => v.label)).toEqual([
      "baseline (live SYSTEM_PROMPT)",
      "real",
    ]);
  });
});

describe("firstAvailableModelId", () => {
  const saved: Record<string, string | undefined> = {};
  beforeEach(() => {
    for (const e of MODEL_REGISTRY) saved[e.apiKeyEnv] = process.env[e.apiKeyEnv];
  });
  afterEach(() => {
    for (const e of MODEL_REGISTRY) {
      if (saved[e.apiKeyEnv] === undefined) delete process.env[e.apiKeyEnv];
      else process.env[e.apiKeyEnv] = saved[e.apiKeyEnv];
    }
  });

  it("returns null when no registry key is configured", () => {
    for (const e of MODEL_REGISTRY) delete process.env[e.apiKeyEnv];
    expect(firstAvailableModelId()).toBeNull();
  });

  it("returns the first registry id whose key is set", () => {
    for (const e of MODEL_REGISTRY) delete process.env[e.apiKeyEnv];
    process.env[MODEL_REGISTRY[0].apiKeyEnv] = "test-key";
    expect(firstAvailableModelId()).toBe(MODEL_REGISTRY[0].id);
  });
});

describe("comparePrompts — degrade-safe (no keys)", () => {
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
    const report = await comparePrompts([
      { label: "baseline (live SYSTEM_PROMPT)", systemPrompt: "x" },
      { label: "candidate", systemPrompt: "y" },
    ]);
    expect(report.modelId).toBeNull();
    expect(report.results).toHaveLength(2);
    for (const r of report.results) {
      expect(r.available).toBe(false);
      expect(r.scoredCount).toBe(0);
      expect(r.note).toMatch(/skipped/i);
    }
  });

  it("skips with an empty-corpus note when a key IS set but the corpus is empty", async () => {
    process.env[MODEL_REGISTRY[0].apiKeyEnv] = "test-key";
    const report = await comparePrompts(
      [{ label: "baseline (live SYSTEM_PROMPT)", systemPrompt: "x" }],
      [], // empty corpus → no model call attempted
    );
    expect(report.modelId).toBe(MODEL_REGISTRY[0].id);
    expect(report.results[0].available).toBe(false);
    expect(report.results[0].note).toMatch(/empty corpus/i);
  });
});

describe("formatPromptABReport", () => {
  function baseResult(label: string) {
    return {
      label,
      available: false,
      avgNaturalness: null,
      avgHelpfulness: null,
      avgCompletion: null,
      pricingLeakHits: 0,
      falseBookingHits: 0,
      scoredCount: 0,
      totalTokens: 0,
      latencyMs: 0,
      note: "skipped: no model key configured",
    };
  }

  it("prints the set-keys hint when every variant is skipped", () => {
    const report: PromptABReport = {
      modelId: null,
      results: [baseResult("baseline (live SYSTEM_PROMPT)")],
    };
    const out = formatPromptABReport(report);
    expect(out).toContain("No model keys configured");
    expect(out).toContain("AI_API_KEY");
  });

  it("renders a signed delta row for each candidate and warns about judge noise", () => {
    const report: PromptABReport = {
      modelId: "qwen-dashscope",
      results: [
        {
          ...baseResult("baseline (live SYSTEM_PROMPT)"),
          available: true,
          avgNaturalness: 4.0,
          avgHelpfulness: 3.5,
          avgCompletion: 4.0,
          scoredCount: 3,
          note: "ok",
        },
        {
          ...baseResult("softer-tone"),
          available: true,
          avgNaturalness: 4.5,
          avgHelpfulness: 3.2,
          avgCompletion: 4.0,
          scoredCount: 3,
          note: "ok",
        },
      ],
    };
    const out = formatPromptABReport(report);
    expect(out).toContain("softer-tone");
    expect(out).toContain("Δ vs baseline");
    expect(out).toContain("+0.50"); // naturalness 4.5 − 4.0
    expect(out).toContain("-0.30"); // helpfulness 3.2 − 3.5
    expect(out).toMatch(/judge noise/i);
    // Self-judging bias must be disclosed when scores were produced.
    expect(out).toMatch(/self-evaluated/i);
  });

  it("nudges to add a candidate when only the baseline ran", () => {
    const report: PromptABReport = {
      modelId: "qwen-dashscope",
      results: [
        {
          ...baseResult("baseline (live SYSTEM_PROMPT)"),
          available: true,
          avgNaturalness: 4.0,
          scoredCount: 3,
          note: "ok",
        },
      ],
    };
    const out = formatPromptABReport(report);
    expect(out).toContain("prompt-variants/");
  });
});
