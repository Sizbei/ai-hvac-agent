import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Migration 0060 (onboarding D1): per-user admin guide state. It auto-runs in
 * the prod build, so it must be additive, nullable, default-free and safe to
 * re-run (the migrator records history only at the end of a deploy).
 */
const root = join(__dirname, "..", "..", "..");
const SQL = readFileSync(join(root, "drizzle", "0060_admin_guide.sql"), "utf8");
const statements = SQL.split("--> statement-breakpoint")
  .map((s) => s.replace(/--[^\n]*/g, "").replace(/\s+/g, " ").trim())
  .filter(Boolean);
const journal = JSON.parse(readFileSync(join(root, "drizzle", "meta", "_journal.json"), "utf8"));
const snap59 = JSON.parse(readFileSync(join(root, "drizzle", "meta", "0059_snapshot.json"), "utf8"));
const snap60 = JSON.parse(readFileSync(join(root, "drizzle", "meta", "0060_snapshot.json"), "utf8"));

describe("migration 0060", () => {
  it("is exactly ADD COLUMN IF NOT EXISTS admin_guide_state jsonb (nullable, no default, no lock_timeout)", () => {
    expect(statements).toEqual([
      `ALTER TABLE "users" ADD COLUMN IF NOT EXISTS "admin_guide_state" jsonb;`,
    ]);
    const code = statements.join(" ").toUpperCase();
    expect(code).not.toContain("LOCK_TIMEOUT");
    expect(code).not.toContain("DEFAULT");
    expect(code).not.toContain("NOT NULL");
  });

  it("is the journal entry right after 0059_golive", () => {
    const entries = journal.entries as { idx: number; tag: string; when: number }[];
    const at = entries.findIndex((e) => e.tag === "0060_admin_guide");
    const entry = entries[at];
    const prev = entries[at - 1];
    expect(prev.tag).toBe("0059_golive");
    expect(entry).toMatchObject({ idx: 60, tag: "0060_admin_guide", version: "7", breakpoints: true });
    expect(entry.when).toBeGreaterThan(prev.when);
  });

  it("snapshot = the 0059 snapshot plus the one nullable users column, chained by prevId", () => {
    expect(snap60.prevId).toBe(snap59.id);
    expect(snap60.id).not.toBe(snap59.id);
    const users60 = snap60.tables["public.users"].columns;
    expect(users60.admin_guide_state).toEqual({
      name: "admin_guide_state",
      type: "jsonb",
      primaryKey: false,
      notNull: false,
    });
    const { admin_guide_state: _added, ...rest } = users60;
    const strip = (s: Record<string, unknown>) => ({ ...s, id: "", prevId: "" });
    expect(strip({ ...snap60, tables: { ...snap60.tables, "public.users": { ...snap60.tables["public.users"], columns: rest } } }))
      .toEqual(strip(snap59));
  });
});
