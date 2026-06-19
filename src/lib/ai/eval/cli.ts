/**
 * Eval CLI entrypoint (CHATBOT-PLAN Steps 8 & 9).
 *
 *   npm run eval      → deterministic-only, fully OFFLINE (no keys, no network).
 *                       Prints the per-transcript report and exits non-zero on
 *                       ANY critical failure (mirrors the CI gate in eval.test.ts).
 *
 *   npm run eval:ab   → A/B comparison across the registry models. Degrade-safe:
 *                       runs the judge only for models whose API key is set;
 *                       skips the rest. Always prints the deterministic baseline.
 *
 *   npm run eval:prompts → A/B comparison across PROMPT variants (live
 *                       SYSTEM_PROMPT vs any *.txt in prompt-variants/), holding
 *                       the model fixed. Degrade-safe: skips when no key is set.
 *
 *   npm run eval:behavior → A/B the tuned BEHAVIORS (no-pitch-on-education,
 *                       offer-on-symptom, defer-specifics) across the same prompt
 *                       variants via binary judging. Degrade-safe.
 *
 * The deterministic path imports only pure modules; the A/B path lazy-loads the
 * model-touching layer so `npm run eval` never even constructs an SDK client.
 */
import { runEval, formatReport } from "./run-eval";

async function main(): Promise<void> {
  const mode = process.argv[2] ?? "deterministic";

  if (mode === "ab") {
    // Lazy import so the offline path stays free of any model/SDK construction.
    const { compareModels, formatABReport } = await import("./ab-compare");
    const report = await compareModels();
    console.log(formatABReport(report));
    // A/B is a reporting tool, not a gate — it always exits 0 (even when all
    // models are skipped for missing keys).
    return;
  }

  if (mode === "prompts") {
    // Lazy import (model/SDK + fs) so the offline path stays clean.
    const { comparePrompts, formatPromptABReport } = await import(
      "./compare-prompts"
    );
    const report = await comparePrompts();
    console.log(formatPromptABReport(report));
    // Reporting tool, not a gate — always exits 0 (even when skipped for keys).
    return;
  }

  if (mode === "behavior") {
    // Lazy import (model/SDK + fs) so the offline path stays clean.
    const { comparePromptBehaviors, formatBehaviorReport } = await import(
      "./behavior-probe"
    );
    const report = await comparePromptBehaviors();
    console.log(formatBehaviorReport(report));
    // Reporting tool, not a gate — always exits 0 (even when skipped for keys).
    return;
  }

  const report = runEval();
  console.log(formatReport(report));
  if (report.criticalFailures > 0) {
    console.error(`\nFAILED: ${report.criticalFailures} critical eval failure(s).`);
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error("eval crashed:", err);
  process.exitCode = 1;
});
