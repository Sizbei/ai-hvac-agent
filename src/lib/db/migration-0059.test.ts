import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Migration 0059 (go-live P5/P6): per-org feature flags, hidden_from_org on the
 * five history tables, and the database-enforced un-hide triggers. Shape only;
 * behaviour is proven against the dev branch in
 * tests/integration/golive-unhide.test.ts.
 */
const root = join(__dirname, "..", "..", "..");
const SQL = readFileSync(join(root, "drizzle", "0059_golive.sql"), "utf8");
const statements = SQL.split("--> statement-breakpoint").map((s) => s.trim()).filter(Boolean);
// Comments stripped, whitespace collapsed: lets assertions match on SQL text.
const flat = (s: string) => s.replace(/--[^\n]*/g, "").replace(/\s+/g, " ").trim();
const FLAT = statements.map(flat);

const HIDDEN_TABLES = ["customers", "service_requests", "invoices", "estimates", "customer_sessions"];
const CHILD_TABLES = ["service_requests", "invoices", "estimates", "customer_sessions"];
const SPEARS = "00000000-0000-0000-0000-000000000001";

function createTrigger(table: string, name: string): string {
  const found = FLAT.filter((s) => s.startsWith(`CREATE TRIGGER ${name} `) && s.includes(` ON ${table} `));
  expect(found, `${name} on ${table}`).toHaveLength(1);
  return found[0];
}

describe("migration 0059", () => {
  it("adds feature_flags NOT NULL DEFAULT '{}' with IF NOT EXISTS", () => {
    expect(FLAT).toContain(
      `ALTER TABLE "organizations" ADD COLUMN IF NOT EXISTS "feature_flags" jsonb DEFAULT '{}'::jsonb NOT NULL;`,
    );
  });

  it("adds hidden_from_org to exactly customers, service_requests, invoices, estimates, customer_sessions", () => {
    const adds = FLAT.filter((s) => s.includes(`"hidden_from_org"`) && s.startsWith("ALTER TABLE"));
    expect(adds).toEqual(
      HIDDEN_TABLES.map(
        (t) => `ALTER TABLE "${t}" ADD COLUMN IF NOT EXISTS "hidden_from_org" boolean DEFAULT false NOT NULL;`,
      ),
    );
  });

  it("seeds reviewRequests:false and payLinks:false for 00000000-0000-0000-0000-000000000001 only, merging with ||", () => {
    const updates = FLAT.filter((s) => s.startsWith("UPDATE"));
    expect(updates).toEqual([
      `UPDATE organizations SET feature_flags = '{"reviewRequests":false,"payLinks":false}'::jsonb || feature_flags WHERE id = '${SPEARS}';`,
    ]);
  });

  it("child triggers fire AFTER INSERT WHEN (NEW.hidden_from_org = false)", () => {
    for (const t of CHILD_TABLES) {
      expect(createTrigger(t, "trg_unhide_parents")).toBe(
        `CREATE TRIGGER trg_unhide_parents AFTER INSERT ON ${t} FOR EACH ROW WHEN (NEW.hidden_from_org = false) EXECUTE FUNCTION unhide_parents();`,
      );
    }
  });

  it("UPDATE triggers fire only when a parent column really changed", () => {
    for (const t of ["service_requests", "customer_sessions"]) {
      expect(createTrigger(t, "trg_unhide_parents_on_update")).toBe(
        `CREATE TRIGGER trg_unhide_parents_on_update AFTER UPDATE OF customer_id ON ${t} FOR EACH ROW ` +
          `WHEN (NEW.hidden_from_org = false AND OLD.customer_id IS DISTINCT FROM NEW.customer_id) ` +
          `EXECUTE FUNCTION unhide_parents();`,
      );
    }
    for (const t of ["invoices", "estimates"]) {
      expect(createTrigger(t, "trg_unhide_parents_on_update")).toBe(
        `CREATE TRIGGER trg_unhide_parents_on_update AFTER UPDATE OF customer_id, service_request_id ON ${t} FOR EACH ROW ` +
          `WHEN (NEW.hidden_from_org = false AND (OLD.customer_id IS DISTINCT FROM NEW.customer_id OR OLD.service_request_id IS DISTINCT FROM NEW.service_request_id)) ` +
          `EXECUTE FUNCTION unhide_parents();`,
      );
    }
  });

  it("messages and appointments get AFTER INSERT triggers (appointments WHEN cancelled_at IS NULL)", () => {
    expect(createTrigger("messages", "trg_unhide_from_message")).toBe(
      "CREATE TRIGGER trg_unhide_from_message AFTER INSERT ON messages FOR EACH ROW EXECUTE FUNCTION unhide_parents();",
    );
    expect(createTrigger("appointments", "trg_unhide_from_appointment")).toBe(
      "CREATE TRIGGER trg_unhide_from_appointment AFTER INSERT ON appointments FOR EACH ROW WHEN (NEW.cancelled_at IS NULL) EXECUTE FUNCTION unhide_parents();",
    );
    // No other triggers anywhere.
    expect(FLAT.filter((s) => s.startsWith("CREATE TRIGGER"))).toHaveLength(CHILD_TABLES.length * 2 + 2);
  });

  it("every statement is separated by --> statement-breakpoint; the function uses CREATE OR REPLACE and each trigger DROP TRIGGER IF EXISTS", () => {
    // One SQL statement per chunk (the function body's inner semicolons sit inside $$ … $$).
    for (const s of FLAT) {
      const outside = s.replace(/\$\$[\s\S]*?\$\$/g, "$$$$");
      expect(outside.match(/;/g), s).toHaveLength(1);
    }
    const fns = FLAT.filter((s) => s.includes("FUNCTION unhide_parents()") && !s.startsWith("CREATE TRIGGER"));
    expect(fns).toHaveLength(1);
    expect(fns[0].startsWith("CREATE OR REPLACE FUNCTION unhide_parents() RETURNS trigger AS $$")).toBe(true);
    const creates = FLAT.filter((s) => s.startsWith("CREATE TRIGGER"));
    for (const c of creates) {
      const [, name, table] = c.match(/^CREATE TRIGGER (\w+) AFTER .*? ON (\w+) /) ?? [];
      const drop = `DROP TRIGGER IF EXISTS ${name} ON ${table};`;
      const i = FLAT.indexOf(drop);
      expect(i, drop).toBeGreaterThanOrEqual(0);
      expect(FLAT[i + 1]).toBe(c);
    }
    // The function exists before any trigger refers to it.
    expect(FLAT.indexOf(fns[0])).toBeLessThan(FLAT.findIndex((s) => s.startsWith("DROP TRIGGER")));
  });

  it("each un-hide only touches a row that is hidden", () => {
    const fn = FLAT.find((s) => s.startsWith("CREATE OR REPLACE FUNCTION unhide_parents()"))!;
    const unhides = fn.match(/UPDATE \w+ SET hidden_from_org = false WHERE [^;]+;/g) ?? [];
    expect(unhides.length).toBeGreaterThan(0);
    for (const u of unhides) expect(u).toMatch(/WHERE id = [\w.]+ AND hidden_from_org;$/);
    for (const t of ["service_requests", "invoices", "estimates", "customer_sessions", "messages", "appointments"]) {
      expect(fn).toContain(`'${t}'`);
    }
  });
});
