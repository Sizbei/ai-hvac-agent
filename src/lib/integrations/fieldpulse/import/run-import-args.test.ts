/**
 * Tests for parseArgs — the CLI flag parser in run-import.ts.
 *
 * Covers:
 *  - --yes flag: sets yes=true (CI mode)
 *  - --phase with a comma-separated list
 *  - --phase with a single name (backward-compat)
 *  - defaults (all phases, yes=false)
 *  - --org required (can't easily test process.exit; just verify present path)
 */
import { describe, it, expect } from "vitest";
import { parseArgs } from "./run-import";

function argv(...args: string[]): string[] {
  // Simulate process.argv: [node, script, ...args]
  return ["node", "run-import.ts", ...args];
}

describe("parseArgs", () => {
  it("defaults: no phase filter, yes=false", () => {
    const result = parseArgs(argv("--org", "org-123"));
    expect(result.orgId).toBe("org-123");
    expect(result.phaseNames).toBeNull();
    expect(result.yes).toBe(false);
    expect(result.dryRun).toBe(false);
  });

  it("--yes sets yes=true", () => {
    const result = parseArgs(argv("--org", "org-abc", "--yes"));
    expect(result.yes).toBe(true);
  });

  it("--yes can appear anywhere in argv", () => {
    const result = parseArgs(argv("--yes", "--org", "org-abc"));
    expect(result.yes).toBe(true);
  });

  it("--phase with single name returns single-item array", () => {
    const result = parseArgs(argv("--org", "org-abc", "--phase", "customers"));
    expect(result.phaseNames).toEqual(["customers"]);
  });

  it("--phase with comma list returns all names", () => {
    const result = parseArgs(
      argv("--org", "org-abc", "--phase", "technicians,customers,jobs,invoices"),
    );
    expect(result.phaseNames).toEqual([
      "technicians",
      "customers",
      "jobs",
      "invoices",
    ]);
  });

  it("--phase comma list with spaces around commas is trimmed", () => {
    const result = parseArgs(
      argv("--org", "org-abc", "--phase", "technicians, customers , jobs"),
    );
    expect(result.phaseNames).toEqual(["technicians", "customers", "jobs"]);
  });

  it("--dry-run sets dryRun=true", () => {
    const result = parseArgs(argv("--org", "org-abc", "--dry-run"));
    expect(result.dryRun).toBe(true);
  });

  it("combines --yes, --phase list, and --dry-run", () => {
    const result = parseArgs(
      argv(
        "--org",
        "org-abc",
        "--phase",
        "technicians,invoices",
        "--yes",
        "--dry-run",
      ),
    );
    expect(result.yes).toBe(true);
    expect(result.phaseNames).toEqual(["technicians", "invoices"]);
    expect(result.dryRun).toBe(true);
  });
});
