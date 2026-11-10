import { describe, it, expect } from "vitest";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";

const DASHBOARD = path.join(process.cwd(), "src/app/admin/(dashboard)");

function pageDirs(dir: string): string[] {
  const out: string[] = [];
  if (existsSync(path.join(dir, "page.tsx"))) out.push(dir);
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name);
    if (statSync(full).isDirectory()) out.push(...pageDirs(full));
  }
  return out;
}

function resolvesLoading(dir: string): boolean {
  for (let d = dir; d.startsWith(DASHBOARD); d = path.dirname(d)) {
    if (existsSync(path.join(d, "loading.tsx"))) return true;
  }
  return false;
}

describe("admin loading coverage", () => {
  const dirs = pageDirs(DASHBOARD);

  it("finds the admin pages", () => {
    expect(dirs.length).toBeGreaterThan(20);
  });

  it("every admin page directory resolves a loading.tsx at its own level or an ancestor up to (dashboard)", () => {
    const missing = dirs.filter((d) => !resolvesLoading(d)).map((d) => path.relative(DASHBOARD, d) || "(root)");
    expect(missing).toEqual([]);
  });

  it("a detail [id] route never inherits a list-level loading.tsx", () => {
    const inherited = dirs
      .filter((d) => /\[[^\]]+\]$/.test(d))
      .filter((d) => {
        for (let p = d; p.startsWith(DASHBOARD); p = path.dirname(p)) {
          if (existsSync(path.join(p, "loading.tsx"))) return p !== d && p !== DASHBOARD;
        }
        return false;
      })
      .map((d) => path.relative(DASHBOARD, d));
    expect(inherited).toEqual([]);
  });

  it("has an in-shell not-found.tsx at the (dashboard) level", () => {
    expect(existsSync(path.join(DASHBOARD, "not-found.tsx"))).toBe(true);
  });
});
