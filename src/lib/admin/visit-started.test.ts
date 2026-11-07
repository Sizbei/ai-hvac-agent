import { describe, it, expect } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { rowStarted, startedRowSql, anyTimestampSql } from "./visit-started";
import { STARTED_ASSIGNMENT_STATUSES } from "./request-status";

const render = (q: Parameters<PgDialect["sqlToQuery"]>[0]) => new PgDialect().sqlToQuery(q).sql.replace(/\s+/g, " ");

describe("rowStarted (spec §3.2)", () => {
  const cases: Array<[string, boolean, boolean, boolean]> = [
    // status, isLead, hasTimestamp, started
    ["en_route", true, true, true],
    ["arrived", true, false, true],          // status counts: the trigger mirrors it onto an untouched lead
    ["in_progress", true, false, true],      // office status mirror (dev: 16 rows)
    ["completed", true, true, true],
    ["on_hold", true, true, true],           // a pause
    ["on_hold", true, false, false],         // untouched on_hold: timestamps only tell a pause apart
    ["scheduled", true, true, false],        // timestamps alone don't count
    ["assigned", true, false, false],
    ["cancelled", true, true, false],        // only live rows count
    ["en_route", false, false, true],        // a working helper
    ["in_progress", false, true, true],
    ["on_hold", false, true, true],
    ["completed", false, true, false],       // a done helper isn't working
    ["assigned", false, false, false],
  ];
  for (const [status, isLead, hasTimestamp, started] of cases) {
    it(`${isLead ? "lead" : "helper"} ${status}${hasTimestamp ? " with a timestamp" : ""} → ${started}`, () => {
      expect(rowStarted({ status, isLead, hasTimestamp })).toBe(started);
    });
  }
  it("the shared list is the lead's started statuses", () => {
    expect(STARTED_ASSIGNMENT_STATUSES).toEqual(["en_route", "arrived", "in_progress", "completed"]);
  });
});

describe("startedRowSql — the SQL twin", () => {
  it("renders the same rule with enum casts, every OR parenthesised", () => {
    expect(render(startedRowSql("a"))).toBe(
      "(a.status <> 'cancelled'::request_status AND (a.status IN ('en_route'::request_status, 'arrived'::request_status, 'in_progress'::request_status) OR (a.status = 'on_hold'::request_status AND (a.en_route_at IS NOT NULL OR a.arrived_at IS NOT NULL OR a.started_at IS NOT NULL OR a.completed_at IS NOT NULL)) OR (a.is_lead AND a.status = 'completed'::request_status)))",
    );
  });
  it("anyTimestampSql lists the four progress stamps", () => {
    expect(render(anyTimestampSql("sa"))).toBe(
      "(sa.en_route_at IS NOT NULL OR sa.arrived_at IS NOT NULL OR sa.started_at IS NOT NULL OR sa.completed_at IS NOT NULL)",
    );
  });
  it("refuses an alias that isn't a plain identifier", () => {
    expect(() => startedRowSql("a; DROP")).toThrow("bad SQL alias");
  });
});
