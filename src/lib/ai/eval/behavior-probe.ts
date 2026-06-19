/**
 * Behavioral prompt probe — a DISCRIMINATING A/B for the prompt-tuning changes.
 *
 * compare-prompts scores generic 1–5 quality (naturalness/helpfulness), which is
 * too noisy (±0.3–0.5) to detect what the T1/T3/T4 tuning actually changed. This
 * probe instead judges BINARY BEHAVIORS that the tuning targets — far less noisy
 * than aesthetic scores — and A/Bs them across prompt variants:
 *
 *   - T3 "no pitch on pure-education": a how-does-it-work / how-often question
 *     must NOT end in a booking offer (pitched=false).
 *   - T3 "soft offer on a real symptom": a fault/symptom SHOULD get an offer
 *     (pitched=true).
 *   - T4 "defer specifics, never guess": a unit-specific spec question must defer
 *     to a technician (deferred=true) and must NOT state a specific number/model
 *     as fact (guessedSpec=false).
 *
 * Per variant it reports the match-rate against these expectations. Variants are
 * the same set as compare-prompts (live SYSTEM_PROMPT baseline + any prompt-
 * variants/*.txt). Held-constant model for BOTH generation and judging.
 *
 * DEGRADE-SAFE: no key → every variant "skipped", exits 0, never throws. Not in
 * the offline CI gate. Self-judging bias applies (disclosed in the footer), but
 * binary behavior detection is far more objective than 1–5 aesthetic scoring.
 */
import {
  loadPromptVariants,
  firstAvailableModelId,
  avg,
  type PromptVariant,
} from "./compare-prompts";
import { generateReply } from "./eval-llm";
import { getRegistryEntry, type ModelRegistryEntry } from "../model-registry";
import { generateText } from "ai";
import { createOpenAI } from "@ai-sdk/openai";

export type BehaviorKind = "pure-education" | "symptom" | "spec-question";

/** Booleans the behavior judge reports for one answer. */
export interface BehaviorFlags {
  /** Did the answer include a booking/service offer? */
  readonly pitched: boolean;
  /** Did it defer a unit-specific detail to a technician / decline to guess? */
  readonly deferred: boolean;
  /** Did it state a specific spec/model/number as fact for THIS unit? */
  readonly guessedSpec: boolean;
}

export interface BehaviorCase {
  readonly id: string;
  readonly kind: BehaviorKind;
  readonly prompt: string;
  /** The flags a correctly-tuned answer should produce. */
  readonly expect: Partial<BehaviorFlags>;
}

/** Small, targeted corpus — each case isolates one tuned behavior. */
export const BEHAVIOR_CASES: readonly BehaviorCase[] = [
  {
    id: "edu-heat-pump",
    kind: "pure-education",
    prompt: "Out of curiosity, can you explain how a heat pump works?",
    expect: { pitched: false },
  },
  {
    id: "edu-filter-cadence",
    kind: "pure-education",
    prompt: "Just wondering — how often should a typical air filter be changed?",
    expect: { pitched: false },
  },
  {
    id: "symptom-ac-warm",
    kind: "symptom",
    prompt: "My AC is running but the house just won't cool down today.",
    expect: { pitched: true },
  },
  {
    id: "symptom-furnace-bang",
    kind: "symptom",
    prompt: "My furnace makes a loud banging noise every time it kicks on.",
    expect: { pitched: true },
  },
  {
    id: "spec-refrigerant-charge",
    kind: "spec-question",
    prompt:
      "What refrigerant does my 2018 Carrier Infinity use, and exactly how many pounds should it be charged with?",
    expect: { deferred: true, guessedSpec: false },
  },
] as const;

export interface BehaviorVariantResult {
  readonly label: string;
  readonly available: boolean;
  /** Fraction of cases whose flags matched ALL their expectations (0..1). */
  readonly matchRate: number | null;
  /** Per-behavior rates over the cases that test them. */
  readonly eduNoPitchRate: number | null;
  readonly symptomOffersRate: number | null;
  readonly specDefersRate: number | null;
  readonly specNoGuessRate: number | null;
  readonly scoredCount: number;
  readonly totalTokens: number;
  readonly latencyMs: number;
  readonly note: string;
}

export interface BehaviorReport {
  readonly modelId: string | null;
  readonly results: readonly BehaviorVariantResult[];
}

const BEHAVIOR_JUDGE_SYSTEM = `You audit ONE HVAC chatbot answer for specific BEHAVIORS (not overall quality).
Given the customer's question and the bot's answer, report three booleans:
- "pitched": true if the answer includes ANY booking/service offer (e.g. "want me to get a technician out?", "I can schedule a visit", "should I send someone?"). A pure informational answer with no offer is pitched=false.
- "deferred": true if it hands a unit-specific detail to a technician or declines to state an exact value (e.g. "the exact spec depends on your unit — a tech can confirm").
- "guessedSpec": true if it states a SPECIFIC number, model, refrigerant amount, or code AS FACT for the customer's particular unit (a general range like "every 1-3 months" is NOT a guessed spec).
Reply with ONLY a JSON object:
{"pitched":true|false,"deferred":true|false,"guessedSpec":true|false,"rationale":"<one sentence>"}`;

function parseFlags(text: string): BehaviorFlags | null {
  const match = text.match(/\{[\s\S]*\}/);
  if (!match) return null;
  try {
    const raw = JSON.parse(match[0]) as Record<string, unknown>;
    return {
      pitched: raw.pitched === true,
      deferred: raw.deferred === true,
      guessedSpec: raw.guessedSpec === true,
    };
  } catch {
    return null;
  }
}

/** True when the observed flags satisfy every expectation in the case. */
export function caseMatches(
  expect: Partial<BehaviorFlags>,
  flags: BehaviorFlags,
): boolean {
  return (Object.keys(expect) as (keyof BehaviorFlags)[]).every(
    (key) => expect[key] === flags[key],
  );
}

async function judgeBehavior(
  entry: ModelRegistryEntry,
  question: string,
  answer: string,
): Promise<{ flags: BehaviorFlags | null; tokens: number; note: string }> {
  try {
    const provider = createOpenAI({
      baseURL: entry.baseUrl,
      apiKey: process.env[entry.apiKeyEnv] ?? "",
    });
    const { text, usage } = await generateText({
      model: provider(entry.modelId),
      system: BEHAVIOR_JUDGE_SYSTEM,
      messages: [{ role: "user", content: `Customer: ${question}\nBot: ${answer}` }],
      abortSignal: AbortSignal.timeout(30_000),
    });
    const flags = parseFlags(typeof text === "string" ? text : "");
    const tokens = (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0);
    return { flags, tokens, note: flags ? "ok" : "failed: unparseable judge output" };
  } catch (err) {
    return {
      flags: null,
      tokens: 0,
      note: `error: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

interface Scored {
  readonly kind: BehaviorKind;
  readonly matched: boolean;
  readonly flags: BehaviorFlags;
}

/** Pure aggregation of per-case results into the variant's rate fields. */
export function aggregate(
  label: string,
  scored: readonly Scored[],
  totalTokens: number,
  latencyMs: number,
  fallbackNote: string,
): BehaviorVariantResult {
  const rateFor = (
    kinds: BehaviorKind[],
    pass: (s: Scored) => boolean,
  ): number | null => {
    const subset = scored.filter((s) => kinds.includes(s.kind));
    return avg(subset.map((s) => (pass(s) ? 1 : 0)));
  };

  return {
    label,
    available: true,
    matchRate: avg(scored.map((s) => (s.matched ? 1 : 0))),
    eduNoPitchRate: rateFor(["pure-education"], (s) => !s.flags.pitched),
    symptomOffersRate: rateFor(["symptom"], (s) => s.flags.pitched),
    specDefersRate: rateFor(["spec-question"], (s) => s.flags.deferred),
    specNoGuessRate: rateFor(["spec-question"], (s) => !s.flags.guessedSpec),
    scoredCount: scored.length,
    totalTokens,
    latencyMs,
    note: scored.length > 0 ? "ok" : fallbackNote,
  };
}

async function runVariant(
  variant: PromptVariant,
  corpus: readonly BehaviorCase[],
  modelId: string | null,
): Promise<BehaviorVariantResult> {
  const skipped = (note: string): BehaviorVariantResult => ({
    label: variant.label,
    available: false,
    matchRate: null,
    eduNoPitchRate: null,
    symptomOffersRate: null,
    specDefersRate: null,
    specNoGuessRate: null,
    scoredCount: 0,
    totalTokens: 0,
    latencyMs: 0,
    note,
  });

  if (!modelId) return skipped("skipped: no model key configured");
  const entry = getRegistryEntry(modelId);
  if (!entry) return skipped(`skipped: unknown model ${modelId}`);
  if (corpus.length === 0) return skipped("skipped: empty corpus");

  const start = Date.now();
  const scored: Scored[] = [];
  let totalTokens = 0;
  let lastNote = "ok";

  for (const c of corpus) {
    const gen = await generateReply(entry, variant.systemPrompt, c.prompt);
    totalTokens += gen.tokens;
    if (gen.text === null) {
      lastNote = gen.note;
      continue;
    }
    const judged = await judgeBehavior(entry, c.prompt, gen.text);
    totalTokens += judged.tokens;
    if (!judged.flags) {
      lastNote = judged.note;
      continue;
    }
    scored.push({
      kind: c.kind,
      flags: judged.flags,
      matched: caseMatches(c.expect, judged.flags),
    });
  }

  return aggregate(variant.label, scored, totalTokens, Date.now() - start, lastNote);
}

export async function comparePromptBehaviors(
  variants: readonly PromptVariant[] = loadPromptVariants(),
  corpus: readonly BehaviorCase[] = BEHAVIOR_CASES,
): Promise<BehaviorReport> {
  const modelId = firstAvailableModelId();
  const results: BehaviorVariantResult[] = [];
  for (const variant of variants) {
    results.push(await runVariant(variant, corpus, modelId));
  }
  return { modelId, results };
}

function pct(value: number | null): string {
  return value === null ? "  —  " : `${Math.round(value * 100)}%`;
}

export function formatBehaviorReport(report: BehaviorReport): string {
  const lines: string[] = [];
  lines.push("Behavioral prompt probe — tuned-behavior match rates");
  lines.push("═".repeat(86));
  lines.push(
    `Held-constant model (generation + judge): ${report.modelId ?? "none"} · ` +
      `${BEHAVIOR_CASES.length} behavior cases`,
  );
  lines.push("");
  lines.push(
    "variant".padEnd(28) +
      "match".padStart(7) +
      "edu¬pitch".padStart(11) +
      "sympOffer".padStart(11) +
      "specDefer".padStart(11) +
      "spec¬guess".padStart(12) +
      "  note",
  );
  lines.push("─".repeat(86));
  for (const m of report.results) {
    const label = m.label.length > 27 ? m.label.slice(0, 26) + "…" : m.label;
    lines.push(
      label.padEnd(28) +
        pct(m.matchRate).padStart(7) +
        pct(m.eduNoPitchRate).padStart(11) +
        pct(m.symptomOffersRate).padStart(11) +
        pct(m.specDefersRate).padStart(11) +
        pct(m.specNoGuessRate).padStart(12) +
        `  ${m.note}`,
    );
  }
  lines.push("═".repeat(86));
  const ran = report.results.filter((m) => m.available).length;
  if (ran === 0) {
    lines.push(
      "No model keys configured — generation/judge skipped. Set AI_API_KEY and/or GLM_API_KEY to run the probe.",
    );
  } else {
    lines.push(
      "Higher is better for every column. Generation and judge share ONE model (self-evaluated) — trust inter-variant deltas, not absolute rates.",
    );
  }
  return lines.join("\n");
}
