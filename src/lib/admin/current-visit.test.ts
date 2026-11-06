import { describe, it, expect } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import {
  activeVisitIdSql,
  officePlacement,
  officeVisitSql,
  parseOfficeVisit,
  placeOfficeJob,
  placedByVisitSql,
  visitEndedSql,
} from "./current-visit";
import { OPEN_ASSIGNMENT_STATUSES } from "@/lib/tech/ownership";

const render = (q: SQL) => new PgDialect().sqlToQuery(q);
const json = (o: Record<string, unknown>) =>
  JSON.stringify({ id: "v", number: 1, start: null, end: null, ended: false, leadId: null, leadStatus: null, leadName: null, ...o });

describe("parseOfficeVisit", () => {
  it("reads the JSON text and normalises timestamps to ISO", () => {
    expect(parseOfficeVisit(json({ id: "v2", number: 2, start: "2026-11-10T17:00:00+00:00", leadId: "t", leadName: "Odessa" }))).toEqual({
      id: "v2", number: 2, start: "2026-11-10T17:00:00.000Z", end: null, ended: false,
      leadId: "t", leadStatus: null, leadName: "Odessa",
    });
  });
  it("is null for NULL, junk or a shape it doesn't know", () => {
    expect(parseOfficeVisit(null)).toBeNull();
    expect(parseOfficeVisit(undefined)).toBeNull();
    expect(parseOfficeVisit("{not json")).toBeNull();
    expect(parseOfficeVisit(JSON.stringify({ number: 2 }))).toBeNull();
  });
});

describe("officePlacement", () => {
  it("keeps the request columns for visit #1 or no visit", () => {
    expect(officePlacement(null)).toEqual({ kind: "request" });
    expect(officePlacement(parseOfficeVisit(json({ number: 1 })))).toEqual({ kind: "request" });
  });

  it("a later live visit is placed by its own window and lead", () => {
    const p = officePlacement(parseOfficeVisit(json({
      id: "v2", number: 2, start: "2026-11-10T17:00:00Z", end: "2026-11-10T21:00:00Z",
      leadId: "odessa", leadStatus: "assigned", leadName: "Odessa Dagley",
    })));
    expect(p).toEqual({
      kind: "visit", appointmentId: "v2", appointmentNumber: 2,
      arrivalWindowStart: "2026-11-10T17:00:00.000Z", arrivalWindowEnd: "2026-11-10T21:00:00.000Z",
      technicianId: "odessa", technicianName: "Odessa Dagley",
    });
  });

  it("a live visit whose lead row is cancelled has no technician", () => {
    const p = officePlacement(parseOfficeVisit(json({ number: 2, leadId: "x", leadStatus: "cancelled", leadName: "X" })));
    expect(p).toMatchObject({ kind: "visit", technicianId: null, technicianName: null });
  });

  it("a visit a hold ended (even #1) is 'ended' and keeps who it was booked with", () => {
    const p = officePlacement(parseOfficeVisit(json({ number: 1, ended: true, leadId: "junie", leadStatus: "cancelled", leadName: "Junie Ortiz" })));
    expect(p).toMatchObject({ kind: "ended", appointmentNumber: 1, technicianId: "junie", technicianName: "Junie Ortiz" });
  });
});

describe("placeOfficeJob", () => {
  const job = { id: "r", arrivalWindowStart: "A", arrivalWindowEnd: "B", assignedToName: "Junie Ortiz" };

  it("request placement: unchanged card, lane = the request's technician", () => {
    expect(placeOfficeJob(job, "junie", { kind: "request" })).toEqual({ job, technicianId: "junie" });
  });

  it("visit placement: the visit's window, lead and number; never the request column's technician", () => {
    const placed = placeOfficeJob(job, "junie", {
      kind: "visit", appointmentId: "v2", appointmentNumber: 2,
      arrivalWindowStart: "S", arrivalWindowEnd: "E", technicianId: null, technicianName: null,
    });
    expect(placed.technicianId).toBeNull();
    expect(placed.job).toEqual({ ...job, arrivalWindowStart: "S", arrivalWindowEnd: "E", assignedToName: null, visitNumber: 2 });
  });

  it("ended placement: flagged, falls back to the request's technician for the lane", () => {
    const placed = placeOfficeJob(job, "junie", {
      kind: "ended", appointmentId: "v1", appointmentNumber: 1,
      arrivalWindowStart: "S", arrivalWindowEnd: "E", technicianId: null, technicianName: null,
    });
    expect(placed.technicianId).toBe("junie");
    expect(placed.job).toMatchObject({ visitEnded: true, assignedToName: "Junie Ortiz", arrivalWindowStart: "S" });
  });
});

describe("SQL fragments", () => {
  it("activeVisitIdSql mirrors pickActiveVisit: live visits, open rows first by number, else latest", () => {
    const { sql, params } = render(activeVisitIdSql());
    expect(sql).toContain('av.service_request_id = "service_requests"."id" AND av.cancelled_at IS NULL');
    expect(sql).toMatch(/ORDER BY EXISTS [\s\S]* DESC, CASE WHEN EXISTS [\s\S]* THEN av\.appointment_number ELSE -av\.appointment_number END/);
    expect(sql).toMatch(/LIMIT 1\)$/);
    // The open list is the ownership.ts one, cast to the enum.
    expect(params).toEqual(expect.arrayContaining([...OPEN_ASSIGNMENT_STATUSES]));
    expect(sql).toContain("::request_status");
  });

  it("visitEndedSql is native-only, on_hold-only, and parenthesised (it contains OR)", () => {
    const { sql } = render(visitEndedSql());
    expect(sql.startsWith("(") && sql.endsWith(")")).toBe(true);
    expect(sql).toContain(`"service_requests"."status" = 'on_hold'::request_status`);
    expect(sql).toContain(`"service_requests"."fieldpulse_job_id" IS NULL AND "service_requests"."hcp_job_id" IS NULL`);
    expect(sql).toMatch(/OR NOT EXISTS \(SELECT 1 FROM appointment_assignments lb/);
  });

  it("officeVisitSql is gated (on hold or a visit #2+) and returns JSON text", () => {
    const { sql } = render(officeVisitSql());
    expect(sql).toMatch(/^\(CASE WHEN "service_requests"\."status" = 'on_hold'::request_status\s+OR EXISTS \(SELECT 1 FROM appointments g/);
    expect(sql).toContain("::text");
    expect(sql).toMatch(/END\)$/);
  });

  it("placedByVisitSql is parenthesised", () => {
    const { sql } = render(placedByVisitSql());
    expect(sql.startsWith("((") && sql.endsWith(")")).toBe(true);
  });
});
