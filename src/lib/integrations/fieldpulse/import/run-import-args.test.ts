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
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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

/**
 * --allow-prod: the target guard's opt-in.
 *
 * Before it existed, "dev branch only" was enforced by nothing but a printed
 * hostname and an interactive prompt that --yes skips. Since dotenv does not
 * override an already-exported DATABASE_URL, a shell with production exported
 * silently beat .env.local — and this importer deletes and re-inserts invoice
 * line items, so a mis-targeted run rewrites real money.
 */
describe("parseArgs — --allow-prod", () => {
  it("defaults to false so a non-dev target fails closed", () => {
    const r = parseArgs(["node", "run-import.ts", "--org", "org-1"]);
    expect(r.allowProd).toBe(false);
  });

  it("is true only when explicitly passed", () => {
    const r = parseArgs(["node", "run-import.ts", "--org", "org-1", "--allow-prod"]);
    expect(r.allowProd).toBe(true);
  });

  it("is independent of --yes — skipping the prompt does not imply prod consent", () => {
    const r = parseArgs(["node", "run-import.ts", "--org", "org-1", "--yes"]);
    expect(r.yes).toBe(true);
    expect(r.allowProd).toBe(false);
  });
});

/**
 * --split-shared-contacts: the customers-phase split's opt-in.
 *
 * The customers phase is not a command someone types — it runs unattended,
 * nightly, against production. Anything that creates duplicate-hash rows must
 * therefore be OFF unless a deliberate backfill asks for it, or the behaviour
 * ships to production the morning after this branch merges.
 */
describe("parseArgs — --split-shared-contacts", () => {
  it("defaults to false, so the nightly sweep keeps today's behaviour", () => {
    const r = parseArgs(argv("--org", "org-1"));
    expect(r.splitSharedContacts).toBe(false);
  });

  it("is true only when explicitly passed", () => {
    const r = parseArgs(argv("--org", "org-1", "--split-shared-contacts"));
    expect(r.splitSharedContacts).toBe(true);
  });

  it("is independent of --yes and --allow-prod — neither implies the split", () => {
    const r = parseArgs(argv("--org", "org-1", "--yes", "--allow-prod"));
    expect(r.yes).toBe(true);
    expect(r.allowProd).toBe(true);
    expect(r.splitSharedContacts).toBe(false);
  });

  it("combines with a phase filter", () => {
    const r = parseArgs(
      argv("--org", "org-1", "--phase", "customers", "--split-shared-contacts", "--yes"),
    );
    expect(r.phaseNames).toEqual(["customers"]);
    expect(r.splitSharedContacts).toBe(true);
  });
});

// ── Database target guard ────────────────────────────────────────────────────

import { parseDbHost, assertWritableTarget } from "./run-import";

describe("parseDbHost", () => {
  it("reads the hostname", () => {
    expect(parseDbHost("postgres://u:p@ep-patient-surf-x.neon.tech/db")).toBe(
      "ep-patient-surf-x.neon.tech",
    );
  });

  it("prefers Neon's options=endpoint over the hostname", () => {
    // Neon's SNI-less form routes to a different compute than the hostname
    // suggests, so a URL that READS as dev can write to prod. The option wins.
    const url =
      "postgres://u:p@ep-patient-surf-x.neon.tech/db?options=endpoint%3Dep-withered-hill-y";
    expect(parseDbHost(url)).toBe("ep-withered-hill-y");
  });

  it("fails closed on an unparseable url", () => {
    expect(parseDbHost("not a url")).toBe("(unparseable)");
  });
});

describe("assertWritableTarget", () => {
  let exitSpy: ReturnType<typeof vi.spyOn>;
  let errSpy: ReturnType<typeof vi.spyOn>;
  let logSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    exitSpy = vi
      .spyOn(process, "exit")
      .mockImplementation((() => undefined) as never);
    errSpy = vi.spyOn(console, "error").mockImplementation(() => undefined);
    logSpy = vi.spyOn(console, "log").mockImplementation(() => undefined);
  });
  afterEach(() => {
    exitSpy.mockRestore();
    errSpy.mockRestore();
    logSpy.mockRestore();
  });

  it("allows the dev branch by default", () => {
    assertWritableTarget("ep-patient-surf-x.neon.tech", false);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("refuses an unknown host by default", () => {
    assertWritableTarget("ep-somewhere-else.neon.tech", false);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("allows production when --allow-prod asserts it", () => {
    assertWritableTarget("ep-withered-hill-y.neon.tech", true);
    expect(exitSpy).not.toHaveBeenCalled();
  });

  it("refuses an unknown host even with --allow-prod", () => {
    // The flag names a target; it does not permit a category.
    assertWritableTarget("ep-somewhere-else.neon.tech", true);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("refuses dev when --allow-prod is given — a prod sweep pointed at dev is a silent no-op", () => {
    assertWritableTarget("ep-patient-surf-x.neon.tech", true);
    expect(exitSpy).toHaveBeenCalledWith(1);
  });

  it("never prints the full host — output lands in a public repo's CI logs", () => {
    assertWritableTarget("ep-withered-hill-y.neon.tech", true);
    const printed = logSpy.mock.calls.flat().join(" ");
    expect(printed).not.toContain("ep-withered-hill-y");
  });
});
