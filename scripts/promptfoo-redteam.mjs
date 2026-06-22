/**
 * promptfoo red-team runner with a clean offline skip (Stage 8).
 *
 * Runs the CURATED adversarial probe set (promptfoo/redteam-probes.yaml) against
 * the real chat path. (promptfoo's HOSTED red-team GENERATOR requires interactive
 * email verification, which can't run autonomously — so we hand-author the
 * probes and run them as a normal eval, which needs no gated service.)
 *
 * Needs a live model key (AI_API_KEY → DashScope), so this clean-skips (exit 0)
 * when the key is absent. NOT part of the offline CI gate.
 *
 * Usage: npm run eval:redteam  (extra promptfoo args after `--`).
 */
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";

if (existsSync(".env.local")) {
  try {
    const { config } = await import("dotenv");
    config({ path: ".env.local" });
  } catch {
    // dotenv optional.
  }
}

if (!process.env.AI_API_KEY?.trim()) {
  console.log(
    "[eval:redteam] AI_API_KEY not set — skipping the red-team sweep (offline-safe, exit 0).",
  );
  process.exit(0);
}

const extra = process.argv.slice(2);
const res = spawnSync(
  "npx",
  ["promptfoo", "eval", "-c", "promptfoo/redteam-probes.yaml", ...extra],
  { stdio: "inherit" },
);
process.exit(res.status ?? 1);
