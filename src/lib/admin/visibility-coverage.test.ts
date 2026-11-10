import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { scanSource, type ReadSite } from "./visibility-scan";

/**
 * Hidden-history coverage gate. Every read of a flagged table (or a child of
 * one) in src/lib and the admin API must either apply the visibility filter or
 * be listed in exactly one allowlist under ./visibility-coverage/ with a reason.
 * The pending-*.json lists shrink to [] as the read-site sweeps land.
 */

interface AllowEntry {
  readonly id: string;
  readonly reason: string;
}

const ROOT = process.cwd();
const LIST_DIR = path.join(ROOT, "src/lib/admin/visibility-coverage");
const SCAN_ROOTS = ["src/lib", "src/app/api/admin"];

function walk(dir: string): string[] {
  return readdirSync(path.join(ROOT, dir), { withFileTypes: true }).flatMap((e) => {
    const rel = `${dir}/${e.name}`;
    if (e.isDirectory()) return walk(rel);
    return e.name.endsWith(".ts") && !e.name.endsWith(".test.ts") ? [rel] : [];
  });
}

function scanAll(): ReadSite[] {
  return SCAN_ROOTS.flatMap(walk).flatMap((file) =>
    scanSource(file, readFileSync(path.join(ROOT, file), "utf8")),
  );
}

function loadLists(): Map<string, AllowEntry[]> {
  const lists = new Map<string, AllowEntry[]>();
  for (const name of readdirSync(LIST_DIR).filter((n) => n.endsWith(".json")).sort()) {
    lists.set(name, JSON.parse(readFileSync(path.join(LIST_DIR, name), "utf8")) as AllowEntry[]);
  }
  return lists;
}

/** `<path>#<fn>` exact, `<path>#*` whole file, `<dir>/` prefix. */
function matches(entryId: string, siteId: string): boolean {
  if (entryId.endsWith("/")) return siteId.startsWith(entryId);
  if (entryId.endsWith("#*")) return siteId.startsWith(entryId.slice(0, -1));
  return entryId === siteId;
}

const uncoveredSites = scanAll().filter((s) => s.uncovered.length > 0);
const lists = loadLists();
const entries = [...lists.values()].flat();

describe("hidden-history visibility coverage", () => {
  it("has the five allowlist files, each entry with an id and a reason", () => {
    expect([...lists.keys()]).toEqual([
      "pending-customers.json",
      "pending-insights.json",
      "pending-money.json",
      "pending-requests.json",
      "permanent.json",
    ]);
    for (const e of entries) {
      expect(typeof e.id).toBe("string");
      expect(e.reason.trim().length, `reason for ${e.id}`).toBeGreaterThan(0);
    }
  });

  it("every read site with an uncovered table is allowlisted", () => {
    const missing = uncoveredSites
      .filter((s) => !entries.some((e) => matches(e.id, s.id)))
      .map((s) => `${s.id} → ${s.uncovered.join(", ")}`);
    expect(missing).toEqual([]);
  });

  it("no allowlist entry is stale (each id matches a site that still has an uncovered table)", () => {
    const stale = entries
      .filter((e) => !uncoveredSites.some((s) => matches(e.id, s.id)))
      .map((e) => e.id);
    expect(stale).toEqual([]);
  });

  it("an id appears in at most one allowlist file", () => {
    const seen = new Map<string, string>();
    const dupes: string[] = [];
    for (const [file, list] of lists) {
      for (const e of list) {
        const prior = seen.get(e.id);
        if (prior !== undefined) dupes.push(`${e.id} (${prior}, ${file})`);
        seen.set(e.id, file);
      }
    }
    expect(dupes).toEqual([]);
  });
});
