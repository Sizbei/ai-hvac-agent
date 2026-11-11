#!/usr/bin/env node
/**
 * Stdin filters for postdeploy-watch.sh. Prints counts and names only.
 *   summarize        vercel logs --json lines on stdin -> "total=N 5xx=N" + route counts;
 *                    exits 5 when it counted any 5xx
 *   has-env <NAME>   `vercel env ls` output on stdin -> exit 0 if NAME is listed
 */
import { readFileSync } from "node:fs";
import { summarizeLogLines } from "../../src/lib/deploy/log-scan.ts";
import { parseVercelEnvLs } from "../../src/lib/deploy/env-check.ts";

const [mode, arg] = process.argv.slice(2);
const input = readFileSync(0, "utf8");
if (mode === "summarize") {
  const s = summarizeLogLines(input.split("\n"));
  console.log(`logs: total=${s.total} 5xx=${s.status5xx}`);
  for (const [route, n] of Object.entries(s.byRoute).sort((a, b) => b[1] - a[1])) console.log(`  5xx ${n}  ${route}`);
  if (s.status5xx > 0) process.exitCode = 5;
} else if (mode === "has-env" && arg) {
  process.exit(parseVercelEnvLs(input).includes(arg) ? 0 : 1);
} else {
  console.error("usage: postdeploy-summarize.mjs summarize | has-env <NAME>");
  process.exit(2);
}
