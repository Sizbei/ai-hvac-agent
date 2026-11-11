import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

/**
 * postdeploy-watch.sh exit codes (final wave L2), in fixture mode: no smoke
 * run, no network. Precedence: smoke failed 1 > 5xx seen 5 > logs unavailable
 * 4 > fixture run 3 > clean 0.
 */
const dir = mkdtempSync(join(tmpdir(), "watch-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function watch(logLines: string[]) {
  const logs = join(dir, `logs-${Math.random().toString(36).slice(2)}.txt`);
  const env = join(dir, "env.txt");
  writeFileSync(logs, logLines.join("\n") + "\n");
  writeFileSync(env, "");
  return spawnSync("bash", ["scripts/agent/postdeploy-watch.sh", "https://example.vercel.app"], {
    encoding: "utf8",
    env: { ...process.env, WATCH_FIXTURE: "1", WATCH_FIXTURE_LOGS: logs, WATCH_FIXTURE_ENV: env },
    timeout: 60_000,
  });
}

describe("postdeploy-watch.sh exit codes", { timeout: 60_000 }, () => {
  it("exits 5 when the logs show a 5xx, even in fixture mode", () => {
    const res = watch([JSON.stringify({ path: "/api/chat", statusCode: 500 })]);
    expect(res.stdout).toContain("logs: total=1 5xx=1");
    expect(res.status, res.stderr).toBe(5);
  });

  it("a fixture run with clean logs still exits 3 (not a real watch)", () => {
    const res = watch([JSON.stringify({ path: "/api/chat", statusCode: 200 }), "GET /admin 200 took 512 ms"]);
    expect(res.stdout).toContain("logs: total=2 5xx=0");
    expect(res.status, res.stderr).toBe(3);
  });
});
