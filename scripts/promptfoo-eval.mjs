/**
 * promptfoo runner with a clean offline skip.
 *
 * The LLM-judged guardrail eval needs a live model key (AI_API_KEY → DashScope).
 * In offline CI that key is absent, so this wrapper exits 0 with a clear note
 * instead of failing — promptfoo itself errors hard on a missing key. With the
 * key present it regenerates the system-prompt snapshot from the shipped source
 * and runs the real eval, propagating promptfoo's exit code.
 *
 * Usage: npm run eval:promptfoo  (pass extra promptfoo args after `--`).
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

// Load .env.local if present (mirrors the other eval scripts) so a local run
// picks up AI_API_KEY without exporting it manually.
if (existsSync(".env.local")) {
  try {
    const { config } = await import("dotenv");
    config({ path: ".env.local" });
  } catch {
    // dotenv optional — env may already be set in the shell / CI.
  }
}

if (!process.env.AI_API_KEY?.trim()) {
  console.log(
    "[eval:promptfoo] AI_API_KEY not set — skipping the live promptfoo eval (offline-safe, exit 0).",
  );
  process.exit(0);
}

// Refresh the system-prompt snapshot the config feeds the model, so the eval
// always reflects the shipped prompt (never a stale copy).
const gen = spawnSync(
  "npx",
  [
    "tsx",
    "-e",
    'import {buildSystemPrompt} from "./src/lib/ai/system-prompt"; import {writeFileSync} from "node:fs"; writeFileSync("promptfoo/system-prompt.txt", buildSystemPrompt());',
  ],
  { stdio: "inherit" },
);
if (gen.status !== 0) {
  console.error("[eval:promptfoo] Failed to regenerate the system-prompt snapshot.");
  process.exit(gen.status ?? 1);
}

const extra = process.argv.slice(2);
const res = spawnSync(
  "npx",
  ["promptfoo", "eval", "-c", "promptfooconfig.yaml", ...extra],
  { stdio: "inherit" },
);
process.exit(res.status ?? 1);
