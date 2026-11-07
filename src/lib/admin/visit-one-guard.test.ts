import { describe, it, expect, vi, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

const { selectQueue, batch } = vi.hoisted(() => ({ selectQueue: [] as unknown[][], batch: vi.fn() }));
vi.mock("@/lib/db", () => {
  const chain = () => {
    const rows = Promise.resolve(selectQueue.shift() ?? []);
    const node: Record<string, unknown> = {
      from: () => node,
      where: () => node,
      then: (ok: (v: unknown) => unknown, err: (e: unknown) => unknown) => rows.then(ok, err),
    };
    return node;
  };
  return { db: { select: () => chain(), execute: (q: unknown) => q, batch } };
});

import type { SQL } from "drizzle-orm";
import { classifyVisitOne, lockedUpdate, visitOneGuardSql, visitOneRefusalResponse, visitOneStartedGuardSql } from "./visit-one-guard";

beforeEach(() => {
  selectQueue.length = 0;
});

describe("visitOneGuardSql", () => {
  it("is one parenthesised predicate on the outer request row (it contains OR)", () => {
    const text = new PgDialect().sqlToQuery(visitOneGuardSql()).sql;
    expect(text.startsWith("(NOT EXISTS (")).toBe(true);
    expect(text.endsWith(")")).toBe(true);
    // Never a bare column: inside the subqueries it would be ambiguous or bind to the inner table.
    expect(text).not.toMatch(/= "id"/);
    expect(text).toContain("p.service_request_id = \"service_requests\".\"id\" AND p.appointment_number = 1 AND (a.en_route_at IS NOT NULL OR a.arrived_at IS NOT NULL OR a.started_at IS NOT NULL OR a.completed_at IS NOT NULL)");
    expect(text).toContain("(\"service_requests\".\"status\" = 'cancelled'::request_status OR NOT EXISTS (SELECT 1 FROM appointments p WHERE p.service_request_id = \"service_requests\".\"id\" AND p.appointment_number = 1 AND p.cancelled_at IS NOT NULL))");
  });
});

describe("visitOneStartedGuardSql", () => {
  it("refuses a started visit #1 (the M2 rule) or an ended one; org-bound", () => {
    const { sql: text, params } = new PgDialect().sqlToQuery(visitOneStartedGuardSql("org-1"));
    expect(text.startsWith("(NOT EXISTS (SELECT 1 FROM appointment_assignments sa JOIN appointments sp")).toBe(true);
    expect(text).toContain("sp.organization_id = $1::uuid AND sa.organization_id = $2::uuid AND sp.appointment_number = 1 AND (sa.status <> 'cancelled'::request_status");
    expect(text).toContain("AND (\"service_requests\".\"status\" = 'cancelled'::request_status OR NOT EXISTS (SELECT 1 FROM appointments p WHERE p.service_request_id = \"service_requests\".\"id\" AND p.appointment_number = 1 AND p.cancelled_at IS NOT NULL)))");
    expect(params).toEqual(["org-1", "org-1"]);
  });
});

describe("classifyVisitOne", () => {
  it("progress wins; an ended visit counts only while the request is not cancelled", async () => {
    selectQueue.push(
      [{ status: "on_hold", progressed: true, ended: true, fieldpulse: false, technicianDone: false }],
      [{ status: "on_hold", progressed: false, ended: true, fieldpulse: false, technicianDone: false }],
      [{ status: "cancelled", progressed: false, ended: true, fieldpulse: false, technicianDone: false }],
      [],
    );
    expect(await classifyVisitOne("o", "r")).toEqual({ status: "on_hold", refusal: "has_progress", fieldpulse: false, technicianDone: false });
    expect(await classifyVisitOne("o", "r")).toEqual({ status: "on_hold", refusal: "visit_ended", fieldpulse: false, technicianDone: false });
    expect(await classifyVisitOne("o", "r")).toEqual({ status: "cancelled", refusal: null, fieldpulse: false, technicianDone: false });
    expect(await classifyVisitOne("o", "r")).toBeNull();
  });
  it("reports FieldPulse and a done technician (started rule)", async () => {
    selectQueue.push([{ status: "in_progress", progressed: true, ended: false, fieldpulse: true, technicianDone: true }]);
    expect(await classifyVisitOne("o", "r", "started", "t")).toEqual({ status: "in_progress", refusal: "has_progress", fieldpulse: true, technicianDone: true });
  });
});

describe("lockedUpdate", () => {
  it("batches the request lock in front of the update and returns the update's rows", async () => {
    batch.mockResolvedValue([{ rows: [] }, [{ id: "r" }]]);
    const update = { marker: "update" };
    expect(await lockedUpdate("o", "r", update)).toEqual([{ id: "r" }]);
    const [lock, second] = batch.mock.calls[0]![0] as [SQL, unknown];
    expect(new PgDialect().sqlToQuery(lock).sql).toBe(
      "SELECT 1 FROM service_requests WHERE id = $1::uuid AND organization_id = $2::uuid FOR NO KEY UPDATE",
    );
    expect(second).toBe(update);
  });
  it("appends follow-on statements after the update, in order", async () => {
    batch.mockReset();
    batch.mockResolvedValue([{ rows: [] }, [{ id: "r" }], { rows: [] }]);
    const { sql } = await import("drizzle-orm");
    const after = sql`SELECT 'after'`;
    await lockedUpdate("o", "r", { marker: "update" }, [after]);
    const statements = batch.mock.calls[0]![0] as unknown[];
    expect(statements).toHaveLength(3);
    expect(statements[2]).toBe(after); // db.execute is the identity in this mock
  });
});

describe("visitOneRefusalResponse (spec §5.5, §8)", () => {
  it("native sheet: points to Move… on the calendar", async () => {
    const body = await visitOneRefusalResponse("has_progress").json();
    expect(body.error).toEqual({ code: "HAS_PROGRESS", message: "A technician has started this visit. To move it anyway, use Move… on the calendar." });
  });
  it("a FieldPulse request names FieldPulse", async () => {
    const body = await visitOneRefusalResponse("has_progress", { fieldpulse: true }).json();
    expect(body.error.message).toBe("A technician has started this visit. Change it in FieldPulse.");
  });
  it("drag to Unscheduled has its own line", async () => {
    const body = await visitOneRefusalResponse("has_progress", { surface: "unschedule" }).json();
    expect(body.error.message).toBe("A technician has started this visit, so it can’t go back to Unscheduled.");
  });
  it("visit_ended is unchanged", async () => {
    const res = visitOneRefusalResponse("visit_ended");
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("VISIT_ENDED");
  });
});
