/**
 * A/B model comparison (CHATBOT-PLAN Step 9 — OPTIONAL, degrade-safe).
 *
 * Runs the golden-transcript corpus through TWO registry models (default:
 * qwen-dashscope vs glm-4.6) and compares, per model:
 *   - the LLM-judge scores (naturalness / helpfulness / completion) averaged
 *     across the corpus,
 *   - judge-flagged safety hits (pricing leak / false booking),
 *   - total tokens and wall-clock latency.
 *
 * The DETERMINISTIC scores are model-independent (routeMessage is pure), so they
 * are computed ONCE and reported as the shared baseline — the A/B axis is purely
 * the judge's view of the same canned/served replies per model.
 *
 * DEGRADE-SAFE: any model whose API key env var is missing is reported as
 * "skipped" and contributes no judge scores. With NO keys at all, this prints
 * the deterministic baseline plus two "skipped" rows and exits 0 — it never
 * throws and never blocks.
 */
import {
  runEval,
  runTranscript,
  type EvalReport,
  type TranscriptResult,
} from "./run-eval";
import { judgeTranscript, judgeAvailable, type JudgeScores } from "./judge";
import { GOLDEN_TRANSCRIPTS } from "./golden-transcripts";
import { MODEL_REGISTRY } from "../model-registry";

export interface ModelAB {
  readonly modelId: string;
  readonly label: string;
  readonly available: boolean;
  /** Averaged judge scores across transcripts that produced scores. */
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

export interface ABReport {
  readonly deterministic: EvalReport;
  readonly models: readonly ModelAB[];
}

/** Per-transcript deterministic served replies, by turn (null where none). */
function repliesFor(result: TranscriptResult): (string | null)[] {
  return result.turns.map((t) => t.verdict?.reply ?? null);
}

function avg(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}

async function runModel(modelId: string, label: string): Promise<ModelAB> {
  const base: Omit<ModelAB, "modelId" | "label"> = {
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

  if (!judgeAvailable(modelId)) {
    return { modelId, label, ...base, note: "skipped: API key not configured" };
  }

  const start = Date.now();
  const scoreList: JudgeScores[] = [];
  let totalTokens = 0;
  let lastNote = "ok";

  for (const transcript of GOLDEN_TRANSCRIPTS) {
    const result = runTranscript(transcript);
    const judged = await judgeTranscript(transcript, repliesFor(result), modelId);
    totalTokens += judged.tokens;
    if (judged.scores) scoreList.push(judged.scores);
    else lastNote = judged.note;
  }

  return {
    modelId,
    label,
    ...base,
    available: true,
    avgNaturalness: avg(scoreList.map((s) => s.naturalness)),
    avgHelpfulness: avg(scoreList.map((s) => s.helpfulness)),
    avgCompletion: avg(scoreList.map((s) => s.completion)),
    pricingLeakHits: scoreList.filter((s) => s.pricingLeak).length,
    falseBookingHits: scoreList.filter((s) => s.falseBooking).length,
    scoredCount: scoreList.length,
    totalTokens,
    latencyMs: Date.now() - start,
    note: scoreList.length > 0 ? "ok" : lastNote,
  };
}

/**
 * Compare the registry models. Defaults to every entry in MODEL_REGISTRY (today:
 * qwen-dashscope, glm-4.6). Pass explicit ids to compare a subset.
 */
export async function compareModels(
  modelIds: readonly string[] = MODEL_REGISTRY.map((e) => e.id),
): Promise<ABReport> {
  const deterministic = runEval();
  const models: ModelAB[] = [];
  for (const id of modelIds) {
    const entry = MODEL_REGISTRY.find((e) => e.id === id);
    models.push(await runModel(id, entry?.label ?? id));
  }
  return { deterministic, models };
}

function fmt(value: number | null, digits = 2): string {
  return value === null ? "  —  " : value.toFixed(digits);
}

export function formatABReport(report: ABReport): string {
  const d = report.deterministic;
  const lines: string[] = [];
  lines.push("A/B model comparison — golden transcripts");
  lines.push("═".repeat(72));
  lines.push(
    `Deterministic baseline (model-independent): ${d.passed}/${d.total} pass · ` +
      `aggregate ${(d.aggregateScore * 100).toFixed(1)}% · critical failures ${d.criticalFailures}`,
  );
  lines.push("");
  lines.push(
    "model".padEnd(22) +
      "nat".padStart(6) +
      "help".padStart(6) +
      "compl".padStart(7) +
      "leak".padStart(6) +
      "book".padStart(6) +
      "tokens".padStart(9) +
      "ms".padStart(8) +
      "  note",
  );
  lines.push("─".repeat(72));
  for (const m of report.models) {
    lines.push(
      m.label.slice(0, 21).padEnd(22) +
        fmt(m.avgNaturalness).padStart(6) +
        fmt(m.avgHelpfulness).padStart(6) +
        fmt(m.avgCompletion).padStart(7) +
        String(m.pricingLeakHits).padStart(6) +
        String(m.falseBookingHits).padStart(6) +
        String(m.totalTokens).padStart(9) +
        String(m.latencyMs).padStart(8) +
        `  ${m.note}`,
    );
  }
  lines.push("═".repeat(72));
  const ran = report.models.filter((m) => m.available).length;
  if (ran === 0) {
    lines.push(
      "No model keys configured — judge/A/B skipped. Set AI_API_KEY and/or GLM_API_KEY to run the live comparison.",
    );
  }
  return lines.join("\n");
}
