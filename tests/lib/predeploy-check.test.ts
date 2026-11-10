import { spawnSync } from "node:child_process";
import { chmodSync, copyFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// Runs the real script with a fake `vercel` first on PATH (no network, no
// credentials). Preview mode skips the git checks, so the result does not
// depend on which branch this checkout is on.
const SCRIPT = join(process.cwd(), "scripts/agent/predeploy-check.mjs");
const FIXTURE = join(process.cwd(), "src/lib/deploy/vercel-env-ls.fixture.txt");

let bin: string;

beforeAll(() => {
  bin = mkdtempSync(join(tmpdir(), "predeploy-check-"));
  copyFileSync(FIXTURE, join(bin, "env-ls.txt"));
  writeFileSync(
    join(bin, "vercel"),
    [
      "#!/bin/sh",
      'if [ "$FAKE_VERCEL" = "signed-out" ]; then echo "Error: No existing credentials found." >&2; exit 1; fi',
      'if [ "$1" = "whoami" ]; then echo tester; exit 0; fi',
      'if [ "$1" = "env" ] && [ "$2" = "ls" ]; then',
      '  cat "$(dirname "$0")/env-ls.txt"',
      '  if [ "$FAKE_VERCEL" = "demo" ]; then echo " DEMO_MODE_ORG_IDS  Encrypted  Preview  1d ago"; fi',
      "  exit 0",
      "fi",
      "exit 2",
    ].join("\n"),
  );
  chmodSync(join(bin, "vercel"), 0o755);
});

afterAll(() => rmSync(bin, { recursive: true, force: true }));

function runScript(args: string[], fake = "") {
  const res = spawnSync("npx", ["tsx", SCRIPT, ...args], {
    encoding: "utf8",
    timeout: 60_000,
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, FAKE_VERCEL: fake },
  });
  return { status: res.status, out: `${res.stdout}${res.stderr}` };
}

describe("predeploy-check script", () => {
  it("passes a complete preview env and prints no '='", () => {
    const { status, out } = runScript(["--env", "preview"]);
    expect(out).toContain("warn env var RESEND_API_KEY is not set (preview)");
    expect(out).toContain("ok   predeploy checks passed (preview)");
    expect(out).not.toContain("=");
    expect(status).toBe(0);
  }, 60_000);

  it("reports a signed-out CLI as one failure line instead of crashing", () => {
    const { status, out } = runScript(["--env", "preview"], "signed-out");
    expect(out).toContain("FAIL vercel whoami failed (not signed in; run vercel login)");
    expect(out).not.toContain("Error:");
    expect(status).toBe(1);
  }, 60_000);

  it("does not forbid DEMO_MODE_ORG_IDS on preview", () => {
    const { status } = runScript(["--env", "preview"], "demo");
    expect(status).toBe(0);
  }, 60_000);

  it("rejects an unknown env with usage", () => {
    const { status, out } = runScript(["--env", "staging"]);
    expect(out).toContain("Usage:");
    expect(status).toBe(1);
  }, 60_000);
});
