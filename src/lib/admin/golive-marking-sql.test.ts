import { describe, it, expect } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { BUSINESS_TIME_ZONE } from "./calendar-time";
import {
  MARKED_TABLES,
  dryRunSql,
  keptCustomerIdsSql,
  keptEstimateIdsSql,
  keptInvoiceIdsSql,
  keptRequestIdsSql,
  keptSessionIdsSql,
  markStatements,
  todayStartSql,
  unhideStatements,
  visitFromTodaySql,
  type MarkingMode,
} from "./golive-marking-sql";

const ORG = "11111111-1111-1111-1111-111111111111";
const MODES: MarkingMode[] = ["history", "empty"];
const TABLES = /\b(?:FROM|JOIN|UPDATE)\s+(customers|customer_sessions|service_requests|invoices|estimates|appointments|organization_settings)\b/g;

const render = (q: SQL) => {
  const { sql: text, params } = new PgDialect().sqlToQuery(q);
  return { flat: text.replace(/\s+/g, " "), params };
};

function allStatements(): SQL[] {
  return [
    ...markStatements(ORG, "history"),
    ...markStatements(ORG, "empty"),
    ...unhideStatements(ORG),
    dryRunSql(ORG),
  ];
}

describe("golive marking SQL", () => {
  it("every statement binds organization_id = $org on every table reference", () => {
    for (const statement of allStatements()) {
      const { flat, params } = render(statement);
      const tableRefs = flat.match(TABLES) ?? [];
      const orgPreds = [...flat.matchAll(/organization_id = \$(\d+)/g)];
      expect(tableRefs.length).toBeGreaterThan(0);
      expect(orgPreds.length).toBe(tableRefs.length);
      for (const m of orgPreds) expect(params[Number(m[1]) - 1]).toBe(ORG);
      // the only other bound value is the fallback timezone
      for (const p of params) expect([ORG, BUSINESS_TIME_ZONE]).toContain(p);
    }
  });

  it("history keeps non-terminal requests; empty does not", () => {
    const history = render(keptRequestIdsSql(ORG, "history")).flat;
    const empty = render(keptRequestIdsSql(ORG, "empty")).flat;
    expect(history).toContain("sr.status NOT IN ('completed'::request_status, 'cancelled'::request_status)");
    expect(empty).not.toContain("sr.status NOT IN");
    // both keep a visit from today
    const visit = render(visitFromTodaySql(ORG)).flat;
    expect(history).toContain(visit.slice(0, 40));
    expect(empty).toContain(visit.slice(0, 40));
    // history also keeps requests referenced by a kept invoice or estimate
    expect(history).toMatch(/FROM invoices/);
    expect(history).toMatch(/FROM estimates/);
    expect(empty).not.toMatch(/invoices|estimates/);
  });

  it("both modes keep chatting/extracting/confirmed sessions", () => {
    for (const mode of MODES) {
      const { flat } = render(keptSessionIdsSql(ORG, mode));
      expect(flat).toContain(
        "cs.status IN ('chatting'::session_status, 'extracting'::session_status, 'confirmed'::session_status)",
      );
      // and the sessions of kept requests
      expect(flat).toMatch(/SELECT kr\.session_id FROM service_requests kr/);
    }
  });

  it("a visit means cancelled_at IS NULL", () => {
    const { flat } = render(visitFromTodaySql(ORG));
    expect(flat).toContain("a.cancelled_at IS NULL");
    expect(flat).toContain("COALESCE(a.starts_at, a.scheduled_date) >=");
    expect(flat).toContain("sr.scheduled_date >=");
    const today = render(todayStartSql(ORG)).flat;
    expect(flat).toContain(today.slice(0, 30));
  });

  it("a cancelled request with a future scheduled_date is not a visit", () => {
    const { flat } = render(visitFromTodaySql(ORG));
    expect(flat).toMatch(/^COALESCE\(\(\(sr\.status <> 'cancelled'::request_status AND sr\.scheduled_date >= /);
  });

  it("the visit predicate is two-valued, so a NULL scheduled_date is simply not a visit", () => {
    const { flat } = render(visitFromTodaySql(ORG));
    expect(flat).toMatch(/^COALESCE\(.*, false\)$/);
    expect(render(dryRunSql(ORG)).flat).toContain("AND NOT COALESCE(((sr.status <> 'cancelled'");
  });

  it("today starts at local midnight in the org timezone with the business fallback", () => {
    const { flat, params } = render(todayStartSql(ORG));
    expect(flat).toMatch(/date_trunc\('day', now\(\) AT TIME ZONE .+\) AT TIME ZONE /);
    expect(flat).toContain("after_hours_config->>'timezone'");
    expect(params).toEqual([ORG, BUSINESS_TIME_ZONE, ORG, BUSINESS_TIME_ZONE]);
  });

  it("kept invoices exclude FieldPulse and HCP drafts", () => {
    const { flat } = render(keptInvoiceIdsSql(ORG, "history"));
    expect(flat).toContain(
      "(i.state = 'open'::invoice_state OR (i.state = 'draft'::invoice_state AND i.fieldpulse_invoice_id IS NULL AND i.hcp_invoice_id IS NULL))",
    );
    expect(render(keptEstimateIdsSql(ORG, "history")).flat).toContain("e.status = 'open'::estimate_status");
  });

  it("empty keeps no invoices and no estimates", () => {
    expect(render(keptInvoiceIdsSql(ORG, "empty")).flat).toBe("SELECT NULL::uuid WHERE false");
    expect(render(keptEstimateIdsSql(ORG, "empty")).flat).toBe("SELECT NULL::uuid WHERE false");
  });

  it("kept customers are customer primary keys, never a nullable customer_id list", () => {
    // NOT IN over a list holding NULL matches nothing, so the outer list must be ids
    for (const mode of MODES) {
      const { flat } = render(keptCustomerIdsSql(ORG, mode));
      expect(flat.startsWith("SELECT c.id FROM customers c WHERE c.organization_id = $1::uuid")).toBe(true);
      for (const t of ["service_requests", "invoices", "estimates", "customer_sessions"]) {
        expect(flat).toContain(`FROM ${t} `);
      }
    }
  });

  it("markStatements hides only visible rows outside the kept set, one per table", () => {
    for (const mode of MODES) {
      const statements = markStatements(ORG, mode).map((s) => render(s).flat);
      expect(statements).toHaveLength(5);
      const tables = statements.map((s) => s.match(/^UPDATE (\w+) SET hidden_from_org = true WHERE organization_id = \$1::uuid AND NOT hidden_from_org AND id NOT IN \(/)?.[1]);
      expect([...tables].sort()).toEqual([...MARKED_TABLES].sort());
    }
  });

  it("statements never DELETE", () => {
    for (const statement of allStatements()) {
      expect(render(statement).flat).not.toMatch(/\b(DELETE|TRUNCATE|DROP)\b/i);
    }
  });

  it("unhide covers exactly the five tables", () => {
    const statements = unhideStatements(ORG).map((s) => render(s).flat);
    expect(statements).toHaveLength(5);
    const tables = statements.map((s) => s.match(/^UPDATE (\w+) SET hidden_from_org = false WHERE organization_id = \$1::uuid AND hidden_from_org$/)?.[1]);
    expect([...tables].sort()).toEqual([...MARKED_TABLES].sort());
  });

  it("enum literals are cast", () => {
    for (const statement of allStatements()) {
      const { flat } = render(statement);
      const literals = [...flat.matchAll(/'(\w+)'(::\w+)?/g)];
      for (const [, value, cast] of literals) {
        if (value === "day" || value === "timezone" || value === "60 days") continue;
        expect(cast, `'${value}' needs a cast`).toBeDefined();
      }
    }
  });

  it("dry run reports total, hidden and both hide counts per table plus the two warnings", () => {
    const { flat } = render(dryRunSql(ORG));
    for (const t of MARKED_TABLES) {
      for (const col of ["total", "hidden", "hide_history", "hide_empty"]) {
        expect(flat).toContain(` AS ${t}_${col}`);
      }
    }
    expect(flat).toContain(" AS old_open_requests_kept");
    expect(flat).toContain(" AS open_ar_cents_hidden_in_empty");
    expect(flat).toContain("interval '60 days'");
  });
});
