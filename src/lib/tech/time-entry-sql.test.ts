import { describe, it, expect } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { sql, type SQL } from "drizzle-orm";
import { openJobEntrySql, closeJobEntriesSql } from "./time-entry-sql";

const render = (q: SQL) => new PgDialect().sqlToQuery(q);
const flat = (s: string) => s.replace(/\s+/g, " ");

describe("openJobEntrySql", () => {
  const q = render(
    openJobEntrySql({ organizationId: "o", requestId: "r", techUserId: "t", appointmentId: "a", gateAssignmentId: "g" }),
  );

  it("inserts an auto job entry and skips when one is already open", () => {
    const text = flat(q.sql);
    expect(text).toContain("INSERT INTO technician_time_entries");
    expect(text).toContain("'job', 'auto', now()");
    expect(text).toContain("ON CONFLICT (service_request_id, technician_id) WHERE clock_out_at IS NULL DO NOTHING");
  });

  it("gates on the assignment row written in this transaction", () => {
    expect(flat(q.sql)).toContain("a.xmin = pg_current_xact_id()::xid");
    expect(q.params).toEqual(["o", "r", "t", "a", "g"]);
  });
});

describe("closeJobEntriesSql", () => {
  it("uses the shared minutes/labor formula and only closes open job entries", () => {
    const text = flat(render(closeJobEntriesSql({ organizationId: "o", requestId: "r" })).sql);
    expect(text).toContain("GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (now() - t.clock_in_at)) / 60))::int");
    expect(text).toContain("/ 60.0 * COALESCE(u.labor_rate_cents, 0))::int");
    expect(text).toContain("t.kind = 'job' AND t.clock_out_at IS NULL");
  });

  it("omits the technician filter and gate when not supplied", () => {
    const q = render(closeJobEntriesSql({ organizationId: "o", requestId: "r" }));
    expect(q.sql).not.toContain("technician_id = ANY");
    expect(q.params).toEqual(["o", "r"]);
  });

  it("binds technician ids as exactly one array param", () => {
    const q = render(closeJobEntriesSql({ organizationId: "o", requestId: "r", technicianIds: ["t1", "t2"] }));
    expect(flat(q.sql)).toContain("t.technician_id = ANY($3::uuid[])");
    expect(q.params).toEqual(["o", "r", ["t1", "t2"]]);
  });

  it("includes the caller's gate fragment", () => {
    const q = render(closeJobEntriesSql({ organizationId: "o", requestId: "r", gate: sql`EXISTS (SELECT 1 FROM x)` }));
    expect(flat(q.sql)).toContain("AND (EXISTS (SELECT 1 FROM x))");
  });
});
