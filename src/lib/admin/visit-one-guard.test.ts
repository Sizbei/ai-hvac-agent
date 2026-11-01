import { describe, it, expect, vi, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";

const { selectQueue } = vi.hoisted(() => ({ selectQueue: [] as unknown[][] }));
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
  return { db: { select: () => chain() } };
});

import { classifyVisitOne, visitOneGuardSql } from "./visit-one-guard";

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
    expect(text).toContain("(\"service_requests\".\"status\" = 'cancelled' OR NOT EXISTS (SELECT 1 FROM appointments p WHERE p.service_request_id = \"service_requests\".\"id\" AND p.appointment_number = 1 AND p.cancelled_at IS NOT NULL))");
  });
});

describe("classifyVisitOne", () => {
  it("progress wins; an ended visit counts only while the request is not cancelled", async () => {
    selectQueue.push(
      [{ status: "on_hold", progressed: true, ended: true }],
      [{ status: "on_hold", progressed: false, ended: true }],
      [{ status: "cancelled", progressed: false, ended: true }],
      [],
    );
    expect(await classifyVisitOne("o", "r")).toEqual({ status: "on_hold", refusal: "has_progress" });
    expect(await classifyVisitOne("o", "r")).toEqual({ status: "on_hold", refusal: "visit_ended" });
    expect(await classifyVisitOne("o", "r")).toEqual({ status: "cancelled", refusal: null });
    expect(await classifyVisitOne("o", "r")).toBeNull();
  });
});
