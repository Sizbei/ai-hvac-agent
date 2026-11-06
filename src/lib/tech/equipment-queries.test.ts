import { describe, it, expect, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/admin/pricebook-queries", () => ({ getDefaultTaxBps: vi.fn(), getPricebookItemById: vi.fn() }));
import { canWriteFrom, canWriteSql, toUnit, unitsSql } from "./equipment-queries";

const ORG = "11111111-1111-4111-8111-111111111111";
const REQ = "22222222-2222-4222-8222-222222222222";
const ME = "33333333-3333-4333-8333-333333333333";
const render = (s: Parameters<PgDialect["sqlToQuery"]>[0]) => new PgDialect().sqlToQuery(s).sql.replace(/\s+/g, " ");

describe("tech equipment GET (spec §6)", () => {
  it("lists live units of the request's customer by the location rule, never retired ones", () => {
    const t = render(unitsSql(ORG, REQ));
    expect(t).toContain("ce.customer_id = r.customer_id AND ce.retired_at IS NULL");
    expect(t).toContain("(r.location_id IS NULL OR ce.location_id IS NULL OR ce.location_id = r.location_id)");
    expect(t).toContain("ce.fieldpulse_asset_id IS NOT NULL AS managed_externally");
    expect(t).not.toContain("cost");
  });
  it("canWrite needs the caller on the job, an on-site or completed status and a customer", () => {
    expect(render(canWriteSql(ORG, REQ, ME))).toContain("a.status <> 'cancelled'::request_status");
    expect(canWriteFrom({ on_job: true, status: "completed", has_customer: true })).toBe(true);
    expect(canWriteFrom({ on_job: true, status: "en_route", has_customer: true })).toBe(false);
    expect(canWriteFrom({ on_job: true, status: "cancelled", has_customer: true })).toBe(false);
    expect(canWriteFrom({ on_job: false, status: "arrived", has_customer: true })).toBe(false);
    expect(canWriteFrom({ on_job: true, status: "arrived", has_customer: false })).toBe(false);
    expect(canWriteFrom(undefined)).toBe(false);
  });
  it("maps a row", () => {
    expect(toUnit({ id: "u1", equipment_type: "ac", make: "Carrier", model: null, serial_number: "S1", location_in_home: null, notes: null,
      install_date: new Date("2026-11-06T17:00:00Z"), managed_externally: false })).toEqual({
      id: "u1", equipmentType: "ac", make: "Carrier", model: null, serialNumber: "S1", locationInHome: null, notes: null,
      installDate: "2026-11-06T17:00:00.000Z", managedExternally: false,
    });
  });
});
