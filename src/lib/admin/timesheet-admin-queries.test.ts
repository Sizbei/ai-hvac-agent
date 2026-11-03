import { describe, it, expect, vi, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

const state: { where?: unknown; limit?: number; joins: number; rows: unknown[] } = {
  joins: 0,
  rows: [],
};

vi.mock("@/lib/db", () => {
  const chain: Record<string, unknown> = {};
  chain.from = () => chain;
  chain.leftJoin = () => {
    state.joins += 1;
    return chain;
  };
  chain.where = (w: unknown) => {
    state.where = w;
    return chain;
  };
  chain.orderBy = () => chain;
  chain.limit = (n: number) => {
    state.limit = n;
    return Promise.resolve(state.rows);
  };
  return { db: { select: () => chain } };
});

import { listTimesheetEntries, TIMESHEET_ROW_LIMIT } from "./timesheet-admin-queries";

const dialect = new PgDialect();

beforeEach(() => {
  state.joins = 0;
  state.where = undefined;
  state.limit = undefined;
  state.rows = [];
});

describe("listTimesheetEntries", () => {
  it("scopes by org + technician + business-day range, left-joins request and visit, caps rows", async () => {
    await listTimesheetEntries("org-1", "tech-1", "2026-11-02", "2026-11-03");
    const { sql, params } = dialect.sqlToQuery(state.where as never);
    expect(sql).toContain('"organization_id"');
    expect(sql).toContain('"technician_id"');
    expect(sql).toContain('"clock_in_at" >=');
    expect(sql).toContain('"clock_in_at" <');
    expect(params).toContain("org-1");
    expect(params).toContain("tech-1");
    expect(state.joins).toBe(2);
    expect(state.limit).toBe(TIMESHEET_ROW_LIMIT);
    expect(TIMESHEET_ROW_LIMIT).toBe(500);
  });

  it("maps rows to ISO strings and null labels", async () => {
    state.rows = [
      {
        id: "e1",
        kind: "general",
        clockInAt: new Date("2026-11-03T13:00:00Z"),
        clockOutAt: null,
        minutes: null,
        laborCostCents: null,
        referenceNumber: null,
        appointmentNumber: null,
        clockInMethod: "manual",
      },
    ];
    const out = await listTimesheetEntries("org-1", "tech-1", "2026-11-03", "2026-11-03");
    expect(out).toEqual([
      {
        id: "e1",
        kind: "general",
        clockInAt: "2026-11-03T13:00:00.000Z",
        clockOutAt: null,
        minutes: null,
        laborCostCents: null,
        referenceNumber: null,
        appointmentNumber: null,
        clockInMethod: "manual",
      },
    ]);
  });
});
