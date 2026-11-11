import { describe, it, expect } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { customers, serviceRequests } from "@/lib/db/schema";
import { afterHoursIfMovedEarlier, keepEarliest } from "./keep-earliest";

describe("keepEarliest", () => {
  it("renders LEAST(column, FieldPulse date) with the date as a timestamptz param", () => {
    const q = new PgDialect().sqlToQuery(keepEarliest(customers.createdAt, new Date("2026-07-06T16:27:03Z")));
    expect(q.sql).toBe('LEAST("customers"."created_at", $1::timestamptz)');
    expect(q.params).toEqual(["2026-07-06T16:27:03.000Z"]);
  });
});

describe("afterHoursIfMovedEarlier", () => {
  it("recomputes the flag only when FieldPulse's date is earlier than the stored one", () => {
    const q = new PgDialect().sqlToQuery(
      afterHoursIfMovedEarlier(serviceRequests.createdAt, serviceRequests.isAfterHours, new Date("2026-07-06T23:10:00Z"), true),
    );
    expect(q.sql).toBe(
      'CASE WHEN $1::timestamptz < "service_requests"."created_at" THEN $2 ELSE "service_requests"."is_after_hours" END',
    );
    expect(q.params).toEqual(["2026-07-06T23:10:00.000Z", true]);
  });
});
