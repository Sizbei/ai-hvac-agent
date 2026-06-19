/**
 * A/B PROMPT comparison — the inverse of ab-compare.ts.
 *
 * ab-compare holds the (deterministic, model-independent) served replies FIXED
 * and varies the JUDGE model. This holds the generation+judge model FIXED and
 * varies the SYSTEM PROMPT, so it actually measures a prompt edit's effect on
 * answer quality — the gap the 2026-06-18 prompt-tuning review flagged (there
 * was no prompt-A/B tool; prompt A/B meant a manual edit→rerun→eyeball).
 *
 * For each prompt VARIANT it: generates the bot's answer to each
 * knowledge-quality prompt (JUDGE_KNOWLEDGE_PROMPTS — the LLM-path corpus, NOT
 * the deterministic router scenarios, which are prompt-independent), judges each
 * answer on the shared rubric, and averages. It prints a per-variant table plus
 * a delta row (candidate − baseline).
 *
 * VARIANTS: the baseline is the live `SYSTEM_PROMPT`; additional candidates are
 * any `*.txt` files dropped into `prompt-variants/` (filename = label, contents
 * = a full system prompt). With no candidate files it runs the baseline alone as
 * a quality snapshot.
 *
 * DEGRADE-SAFE: identical contract to ab-compare — when NO registry model has a
 * key, every variant is reported "skipped", it prints a hint and exits 0, and it
 * never throws and never blocks. Nothing here runs in the offline CI gate.
 *
 * JUDGE NOISE: the LLM judge is ~±0.3–0.5 on the 1–5 scale over this small
 * corpus. Treat sub-0.5 deltas as noise, not signal (the footer warns the same).
 *
 * JUDGE INDEPENDENCE: generation and judging use the SAME held-constant model,
 * so a model grades its own answers and the absolute scores are biased upward.
 * The inter-variant DELTA is the usable signal (the bias is shared across
 * variants); the footer discloses this so absolute scores aren't over-trusted.
 */
import { readdirSync, readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { generateText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";
import {
  judgeTranscript,
  judgeAvailable,
  JUDGE_KNOWLEDGE_PROMPTS,
  type JudgeScores,
  type JudgeKnowledgePrompt,
} from "./judge";
import type { GoldenTranscript } from "./golden-transcripts";
import {
  MODEL_REGISTRY,
  getRegistryEntry,
  type ModelRegistryEntry,
} from "../model-registry";
import { SYSTEM_PROMPT } from "../system-prompt";

/** A named full system prompt to score. */
export interface PromptVariant {
  readonly label: string;
  readonly systemPrompt: string;
}

/** Aggregated judge scores for one variant across the knowledge corpus. */
export interface VariantResult {
  readonly label: string;
  readonly available: boolean;
  readonly avgNaturalness: number | null;
  readonly avgHelpfulness: number | null;
  readonly avgCompletion: number | null;
  readonly pricingLeakHits: number;
  readonly falseBookingHits: number;
  readonly scoredCount: number;
  readonly totalTokens: number;
  readonly latencyMs: number;
  readonly note: string;
}

export interface PromptABReport {
  /** The model id used for BOTH generation and judging (held constant), or null. */
  readonly modelId: string | null;
  readonly results: readonly VariantResult[];
}

/**
 * Default directory scanned for candidate prompt `.txt` files. Anchored to this
 * module's own location (not cwd) so it resolves correctly regardless of where
 * the CLI is launched from.
 */
export const DEFAULT_VARIANTS_DIR = join(
  dirname(fileURLToPath(import.meta.url)),
  "prompt-variants",
);

/**
 * Build the variant list: the live SYSTEM_PROMPT as the baseline, plus every
 * non-empty `*.txt` in `dir` (sorted, filename-without-extension as the label).
 * A missing/unreadable directory yields baseline-only — never throws.
 */
export function loadPromptVariants(
  dir: string = DEFAULT_VARIANTS_DIR,
): PromptVariant[] {
  const variants: PromptVariant[] = [
    { label: "baseline (live SYSTEM_PROMPT)", systemPrompt: SYSTEM_PROMPT },
  ];
  let files: string[] = [];
  try {
    files = readdirSync(dir)
      .filter((f) => f.endsWith(".txt"))
      .sort();
  } catch {
    return variants; // no directory → baseline only
  }
  for (const file of files) {
    let body = "";
    try {
      body = readFileSync(join(dir, file), "utf8").trim();
    } catch {
      continue; // unreadable file → skip
    }
    if (body) variants.push({ label: file.replace(/\.txt$/, ""), systemPrompt: body });
  }
  return variants;
}

/** First registry model whose API key is configured, or null if none. */
export function firstAvailableModelId(): string | null {
  for (const entry of MODEL_REGISTRY) {
    if (judgeAvailable(entry.id)) return entry.id;
  }
  return null;
}

export function avg(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

/** A knowledge prompt rendered as the minimal transcript the judge consumes. */
function asTranscript(prompt: JudgeKnowledgePrompt): GoldenTranscript {
  return {
    id: prompt.id,
    category: "faq",
    description: prompt.rubric,
    userTurns: [prompt.prompt],
    expect: {},
  };
}

/**
 * Generate one bot answer for a prompt variant. Degrade-safe: returns
 * `{ text: null }` with a note rather than throwing on error/empty output.
 */
async function generateReply(
  entry: ModelRegistryEntry,
  systemPrompt: string,
  userPrompt: string,
): Promise<{ text: string | null; tokens: number; note: string }> {
  try {
    const provider = createOpenAI({
      baseURL: entry.baseUrl,
      apiKey: process.env[entry.apiKeyEnv] ?? "",
    });
    const { text, usage } = await generateText({
      model: provider(entry.modelId),
      system: systemPrompt,
      messages: [{ role: "user", content: userPrompt }],
      abortSignal: AbortSignal.timeout(30_000),
    });
    const out = typeof text === "string" ? text.trim() : "";
    const tokens = (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0);
    return out.length
      ? { text: out, tokens, note: "ok" }
      : { text: null, tokens, note: "failed: empty generation" };
  } catch (err) {
    return {
      text: null,
      tokens: 0,
      note: `error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

async function runVariant(
  variant: PromptVariant,
  corpus: readonly JudgeKnowledgePrompt[],
  modelId: string | null,
): Promise<VariantResult> {
  const base: Omit<VariantResult, "label"> = {
    available: false,
    avgNaturalness: null,
    avgHelpfulness: null,
    avgCompletion: null,
    pricingLeakHits: 0,
    falseBookingHits: 0,
    scoredCount: 0,
    totalTokens: 0,
    latencyMs: 0,
    note: "",
  };

  if (!modelId) {
    return { label: variant.label, ...base, note: "skipped: no model key configured" };
  }
  const entry = getRegistryEntry(modelId);
  if (!entry) {
    return { label: variant.label, ...base, note: `skipped: unknown model ${modelId}` };
  }
  if (corpus.length === 0) {
    return { label: variant.label, ...base, note: "skipped: empty corpus" };
  }

  const start = Date.now();
  const scores: JudgeScores[] = [];
  let totalTokens = 0;
  let lastNote = "ok";

  for (const prompt of corpus) {
    const gen = await generateReply(entry, variant.systemPrompt, prompt.prompt);
    totalTokens += gen.tokens;
    if (gen.text === null) {
      lastNote = gen.note;
      continue;
    }
    const judged = await judgeTranscript(asTranscript(prompt), [gen.text], modelId);
    totalTokens += judged.tokens;
    if (judged.scores) scores.push(judged.scores);
    else lastNote = judged.note;
  }

  return {
    label: variant.label,
    ...base,
    available: true,
    avgNaturalness: avg(scores.map((s) => s.naturalness)),
    avgHelpfulness: avg(scores.map((s) => s.helpfulness)),
    avgCompletion: avg(scores.map((s) => s.completion)),
    pricingLeakHits: scores.filter((s) => s.pricingLeak).length,
    falseBookingHits: scores.filter((s) => s.falseBooking).length,
    scoredCount: scores.length,
    totalTokens,
    latencyMs: Date.now() - start,
    note: scores.length > 0 ? "ok" : lastNote,
  };
}

/**
 * Score every prompt variant on the knowledge corpus with a single held-constant
 * model (used for BOTH generation and judging, so the only axis is the prompt).
 */
export async function comparePrompts(
  variants: readonly PromptVariant[] = loadPromptVariants(),
  corpus: readonly JudgeKnowledgePrompt[] = JUDGE_KNOWLEDGE_PROMPTS,
): Promise<PromptABReport> {
  const modelId = firstAvailableModelId();
  const results: VariantResult[] = [];
  for (const variant of variants) {
    results.push(await runVariant(variant, corpus, modelId));
  }
  return { modelId, results };
}

function fmt(value: number | null, digits = 2): string {
  return value === null ? "  —  " : value.toFixed(digits);
}

/** Signed delta (candidate − baseline), or "—" when either side is missing. */
function fmtDelta(candidate: number | null, baseline: number | null): string {
  if (candidate === null || baseline === null) return "  —  ";
  const d = candidate - baseline;
  return (d >= 0 ? "+" : "") + d.toFixed(2);
}

export function formatPromptABReport(report: PromptABReport): string {
  const lines: string[] = [];
  lines.push("A/B PROMPT comparison — HVAC knowledge corpus");
  lines.push("═".repeat(78));
  lines.push(
    `Held-constant model (generation + judge): ${report.modelId ?? "none"} · ` +
      `${JUDGE_KNOWLEDGE_PROMPTS.length} knowledge prompts ` +
      `(safety is gated separately by the deterministic eval)`,
  );
  lines.push("");
  lines.push(
    "variant".padEnd(28) +
      "nat".padStart(6) +
      "help".padStart(6) +
      "compl".padStart(7) +
      "leak".padStart(6) +
      "book".padStart(6) +
      "tokens".padStart(9) +
      "ms".padStart(8) +
      "  note",
  );
  lines.push("─".repeat(78));

  const baseline = report.results[0];
  report.results.forEach((m, i) => {
    const label = m.label.length > 27 ? m.label.slice(0, 26) + "…" : m.label;
    lines.push(
      label.padEnd(28) +
        fmt(m.avgNaturalness).padStart(6) +
        fmt(m.avgHelpfulness).padStart(6) +
        fmt(m.avgCompletion).padStart(7) +
        String(m.pricingLeakHits).padStart(6) +
        String(m.falseBookingHits).padStart(6) +
        String(m.totalTokens).padStart(9) +
        String(m.latencyMs).padStart(8) +
        `  ${m.note}`,
    );
    // Delta row for every candidate (vs the baseline = results[0]).
    if (i > 0 && baseline) {
      lines.push(
        "  └─ Δ vs baseline".padEnd(28) +
          fmtDelta(m.avgNaturalness, baseline.avgNaturalness).padStart(6) +
          fmtDelta(m.avgHelpfulness, baseline.avgHelpfulness).padStart(6) +
          fmtDelta(m.avgCompletion, baseline.avgCompletion).padStart(7),
      );
    }
  });
  lines.push("═".repeat(78));

  const ran = report.results.filter((m) => m.available).length;
  if (ran === 0) {
    lines.push(
      "No model keys configured — generation/judge skipped. Set AI_API_KEY and/or GLM_API_KEY to run the live comparison.",
    );
  } else {
    if (report.results.length === 1) {
      lines.push(
        "Baseline only — drop a full-system-prompt *.txt into src/lib/ai/eval/prompt-variants/ to A/B against it.",
      );
    }
    lines.push(
      "Judge noise ≈ ±0.3–0.5 on the 1–5 scale over this small corpus — treat sub-0.5 deltas as noise, not signal.",
    );
    lines.push(
      "Generation and judge share ONE model — answers are self-evaluated (biased upward). Trust inter-variant deltas, not absolute scores.",
    );
  }
  return lines.join("\n");
}
