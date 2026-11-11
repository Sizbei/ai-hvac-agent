import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Migration 0061 (go-live final fix): activity un-hides work. Shape only;
 * behaviour is proven against the dev branch in
 * tests/integration/golive-unhide-activity.test.ts.
 */
const root = join(__dirname, "..", "..", "..");
const read = (file: string) =>
  readFileSync(join(root, "drizzle", file), "utf8")
    .split("--> statement-breakpoint")
    .map((s) => s.trim())
    .filter(Boolean)
    // Comments stripped, whitespace collapsed: lets assertions match on SQL text.
    .map((s) => s.replace(/--[^\n]*/g, "").replace(/\s+/g, " ").trim());
const FLAT = read("0061_unhide_on_activity.sql");
const FN = FLAT.find((s) => s.startsWith("CREATE OR REPLACE FUNCTION unhide_parents()"))!;
const FN_0059 = read("0059_golive.sql").find((s) => s.startsWith("CREATE OR REPLACE FUNCTION unhide_parents()"))!;

const meta = (file: string) => JSON.parse(readFileSync(join(root, "drizzle", "meta", file), "utf8"));
const journal = meta("_journal.json");
const snap60 = meta("0060_snapshot.json");
const snap61 = meta("0061_snapshot.json");

function createTrigger(table: string, name: string): string {
  const found = FLAT.filter((s) => s.startsWith(`CREATE TRIGGER ${name} `) && s.includes(` ON ${table} `));
  expect(found, `${name} on ${table}`).toHaveLength(1);
  return found[0];
}

describe("migration 0061", () => {
  it("is additive: one CREATE OR REPLACE FUNCTION and three DROP IF EXISTS / CREATE TRIGGER pairs, nothing else", () => {
    expect(FN).toBeDefined();
    const kinds = FLAT.map((s) => s.split(" ").slice(0, 2).join(" "));
    expect(kinds).toEqual([
      "CREATE OR",
      "DROP TRIGGER", "CREATE TRIGGER",
      "DROP TRIGGER", "CREATE TRIGGER",
      "DROP TRIGGER", "CREATE TRIGGER",
    ]);
    for (const c of FLAT.filter((s) => s.startsWith("CREATE TRIGGER"))) {
      const [, name, table] = c.match(/^CREATE TRIGGER (\w+) AFTER .*? ON (\w+) /) ?? [];
      expect(FLAT[FLAT.indexOf(c) - 1]).toBe(`DROP TRIGGER IF EXISTS ${name} ON ${table};`);
    }
    // One SQL statement per chunk (the function body's semicolons sit inside $$ … $$).
    for (const s of FLAT) {
      expect(s.replace(/\$\$[\s\S]*?\$\$/g, "$$$$").match(/;/g), s).toHaveLength(1);
    }
  });

  it("keeps every statement of 0059's function", () => {
    const body = (fn: string) => fn.slice(fn.indexOf("BEGIN"), fn.lastIndexOf("END;"));
    const lines0059 = body(FN_0059).match(/(?:UPDATE|SELECT) [^;]+;/g) ?? [];
    expect(lines0059.length).toBeGreaterThan(10);
    for (const line of lines0059) expect(FN, line).toContain(line);
    for (const branch of ["'service_requests'", "('invoices', 'estimates')", "'customer_sessions'", "'messages'", "'appointments'"]) {
      expect(FN).toContain(branch);
    }
  });

  it("each un-hide only touches a row that is hidden and SETs nothing but the flag", () => {
    const unhides = FN.match(/UPDATE \w+ SET [^;]+;/g) ?? [];
    expect(unhides.length).toBeGreaterThan(0);
    for (const u of unhides) {
      expect(u).toMatch(/^UPDATE \w+ SET hidden_from_org = false WHERE /);
      expect(u).toMatch(/ AND hidden_from_org;$/);
    }
  });

  it("a hidden request or invoice un-hides itself; messages bring back the session's requests", () => {
    expect(FN).toContain("IF NEW.hidden_from_org THEN UPDATE service_requests SET hidden_from_org = false WHERE id = NEW.id AND hidden_from_org;");
    expect(FN).toContain("IF TG_TABLE_NAME = 'invoices' AND NEW.hidden_from_org THEN UPDATE invoices SET hidden_from_org = false WHERE id = NEW.id AND hidden_from_org;");
    expect(FN).toContain("UPDATE service_requests SET hidden_from_org = false WHERE session_id = NEW.session_id AND hidden_from_org;");
  });

  it("service_requests: a hidden row with a real change to a live status, or a reschedule to yesterday or later", () => {
    expect(createTrigger("service_requests", "trg_unhide_on_activity")).toBe(
      "CREATE TRIGGER trg_unhide_on_activity AFTER UPDATE OF status, scheduled_date ON service_requests FOR EACH ROW " +
        "WHEN (NEW.hidden_from_org AND ((OLD.status IS DISTINCT FROM NEW.status AND NEW.status NOT IN ('completed'::request_status, 'cancelled'::request_status)) OR (NEW.scheduled_date IS DISTINCT FROM OLD.scheduled_date AND NEW.scheduled_date >= now() - interval '1 day'))) " +
        "EXECUTE FUNCTION unhide_parents();",
    );
  });

  it("appointments: a live visit whose date really moves to yesterday or later", () => {
    expect(createTrigger("appointments", "trg_unhide_on_reschedule")).toBe(
      "CREATE TRIGGER trg_unhide_on_reschedule AFTER UPDATE OF scheduled_date, starts_at ON appointments FOR EACH ROW " +
        "WHEN (NEW.cancelled_at IS NULL AND (OLD.scheduled_date IS DISTINCT FROM NEW.scheduled_date OR OLD.starts_at IS DISTINCT FROM NEW.starts_at) AND COALESCE(NEW.starts_at, NEW.scheduled_date) >= now() - interval '1 day') " +
        "EXECUTE FUNCTION unhide_parents();",
    );
  });

  it("invoices: a hidden invoice whose state really changes to open", () => {
    expect(createTrigger("invoices", "trg_unhide_on_reopen")).toBe(
      "CREATE TRIGGER trg_unhide_on_reopen AFTER UPDATE OF state ON invoices FOR EACH ROW " +
        "WHEN (NEW.hidden_from_org AND OLD.state IS DISTINCT FROM NEW.state AND NEW.state = 'open'::invoice_state) " +
        "EXECUTE FUNCTION unhide_parents();",
    );
  });

  it("no trigger lists hidden_from_org, so a flag-only UPDATE fires none of them", () => {
    for (const c of FLAT.filter((s) => s.startsWith("CREATE TRIGGER"))) {
      const columns = c.match(/AFTER UPDATE OF ([\w, ]+) ON /)![1];
      expect(columns).not.toContain("hidden_from_org");
    }
  });

  it("is the journal entry right after 0060_admin_guide", () => {
    const entries = journal.entries as { idx: number; tag: string; when: number }[];
    const at = entries.findIndex((e) => e.tag === "0061_unhide_on_activity");
    const entry = entries[at];
    const prev = entries[at - 1];
    expect(prev.tag).toBe("0060_admin_guide");
    expect(entry).toMatchObject({ idx: 61, tag: "0061_unhide_on_activity", version: "7", breakpoints: true });
    expect(entry.when).toBeGreaterThan(prev.when);
  });

  it("snapshot = the 0060 snapshot (no schema change), chained by prevId", () => {
    expect(snap61.prevId).toBe(snap60.id);
    expect(snap61.id).not.toBe(snap60.id);
    const strip = (s: Record<string, unknown>) => ({ ...s, id: "", prevId: "" });
    expect(strip(snap61)).toEqual(strip(snap60));
  });
});
