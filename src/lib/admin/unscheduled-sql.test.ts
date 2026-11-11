import { describe, it, expect } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { needsPlacementWhere } from "./unscheduled-sql";
import { serviceRequests } from "@/lib/db/schema";
import { SHOW_ALL, VISIBLE_ONLY, visibleRows, type Visibility } from "./visibility";
import { NEEDS_PLACEMENT_STATUSES } from "./request-status";

const ORG = "11111111-1111-1111-1111-111111111111";
const render = (q: SQL) => new PgDialect().sqlToQuery(q);
const flat = (q: SQL) => render(q).sql.replace(/\s+/g, " ");
const where = (vis: Visibility) => needsPlacementWhere(ORG, visibleRows(serviceRequests, vis));

describe("needsPlacementWhere (the one unscheduled set)", () => {
  it("is tenant-scoped and takes every open status the rail lists", () => {
    const q = render(where(VISIBLE_ONLY));
    expect(q.params[0]).toBe(ORG);
    expect(q.params).toEqual(expect.arrayContaining([...NEEDS_PLACEMENT_STATUSES]));
    // Assigned, en route, arrived and in progress without a window count too.
    for (const s of ["assigned", "en_route", "arrived", "in_progress"]) {
      expect(q.params).toContain(s);
    }
    expect(q.params).not.toContain("completed");
    expect(q.params).not.toContain("cancelled");
  });

  it("means no technician OR no arrival window", () => {
    expect(flat(where(VISIBLE_ONLY))).toMatch(
      /\("service_requests"\."assigned_to" is null or "service_requests"\."arrival_window_start" is null\)/,
    );
  });

  it("carries the caller's visibility filter", () => {
    expect(flat(where(VISIBLE_ONLY))).toContain('"service_requests"."hidden_from_org" = $');
    expect(flat(where(SHOW_ALL))).not.toContain("hidden_from_org");
  });
});
