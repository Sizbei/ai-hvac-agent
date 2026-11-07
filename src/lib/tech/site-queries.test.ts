import { describe, it, expect, vi, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

const { readQueue, executed } = vi.hoisted(() => ({ readQueue: [] as unknown[][], executed: [] as unknown[] }));
vi.mock("@/lib/db", () => ({
  db: {
    execute: (q: unknown) => {
      executed.push(q);
      return Promise.resolve({ rows: readQueue.shift() ?? [] });
    },
    batch: vi.fn(),
  },
}));
vi.mock("@/lib/admin/pricebook-queries", () => ({ getDefaultTaxBps: vi.fn(), getPricebookItemById: vi.fn() }));
vi.mock("@/lib/tech/ownership", async (orig) => ({
  ...(await orig<typeof import("@/lib/tech/ownership")>()),
  findReadableJob: vi.fn(),
  findActiveVisit: vi.fn(),
}));
vi.mock("@/lib/crypto", () => ({
  encrypt: (s: string) => `ENC:${s}`,
  decrypt: (s: string) => {
    if (s === "BAD") throw new Error("auth tag");
    return s.slice(4);
  },
  blindIndex: vi.fn(),
}));

import {
  allAddressesSql, candidatesSql, locationCountSql, getSiteView, membershipSql, normalizedAddress, openEstimatesSql, pastJobsSql, siteSelfSql,
  unaddressedSql, upcomingVisitsSql,
} from "./site-queries";
import { findActiveVisit, findReadableJob } from "@/lib/tech/ownership";

const ORG = "11111111-1111-4111-8111-111111111111";
const ME = "22222222-2222-4222-8222-222222222222";
const RID = "33333333-3333-4333-8333-333333333333";
const CUST = "44444444-4444-4444-8444-444444444444";
const LOC = "55555555-5555-4555-8555-555555555555";
const OTHER = "66666666-6666-4666-8666-666666666666";
const ADDR = "ENC:12 Elm St, Johnson City, TN";
const dialect = new PgDialect();
const q = (s: SQL) => dialect.sqlToQuery(s);
const text = (s: SQL) => q(s).sql.replace(/\s+/g, " ").trim();
const orgCount = (s: SQL) => q(s).params.filter((p) => p === ORG).length;

beforeEach(() => {
  readQueue.length = 0;
  executed.length = 0;
  vi.mocked(findReadableJob).mockResolvedValue({ id: RID, customerId: CUST, native: true, status: "arrived" });
  vi.mocked(findActiveVisit).mockResolvedValue({ appointmentId: "a", leadTechnicianId: ME });
});

describe("site SQL binds the org on every table (spec §7.6)", () => {
  it("each builder", () => {
    expect(orgCount(siteSelfSql(ORG, RID))).toBe(3);
    expect(orgCount(candidatesSql(ORG, CUST, RID))).toBe(1);
    expect(orgCount(pastJobsSql(ORG, [OTHER]))).toBe(4);
    expect(orgCount(unaddressedSql(ORG, CUST, RID))).toBe(1);
    expect(orgCount(openEstimatesSql(ORG, [RID]))).toBe(2);
    expect(orgCount(allAddressesSql(ORG, CUST))).toBe(1);
    expect(orgCount(membershipSql(ORG, CUST))).toBe(2);
    expect(orgCount(upcomingVisitsSql(ORG, "m"))).toBe(1);
  });

  it("allAddressesSql includes the request's own address (membershipEvaluable relies on it): no id exclusion", () => {
    const t = text(allAddressesSql(ORG, CUST));
    expect(t).not.toMatch(/id <>/);
    expect(t).toContain("customer_id = $");
  });

  it("cancelled requests never feed the site (candidates, unaddressed count, membership addresses)", () => {
    for (const b of [candidatesSql(ORG, CUST, RID), unaddressedSql(ORG, CUST, RID), allAddressesSql(ORG, CUST)]) {
      expect(text(b)).toContain("status <> 'cancelled'::request_status");
    }
    expect(text(unaddressedSql(ORG, CUST, RID))).toContain("AND id <> $");
  });

  it("customer and request scope predicates are pinned", () => {
    const l = text(locationCountSql(ORG, CUST));
    expect(orgCount(locationCountSql(ORG, CUST))).toBe(1);
    expect(l).toContain("AND customer_id = $");
    const c = text(candidatesSql(ORG, CUST, RID));
    expect(c).toContain("AND customer_id = $");
    expect(c).toContain("AND id <> $");
    expect(text(unaddressedSql(ORG, CUST, RID))).toContain("AND customer_id = $");
    const m = text(membershipSql(ORG, CUST));
    expect(m).toContain("AND m.customer_id = $");
    expect(m).toContain("m.status = 'active'::membership_status");
  });

  it("the customer and request binds are pinned by value and position (C M-4)", () => {
    expect(q(candidatesSql(ORG, CUST, RID)).params).toEqual([ORG, CUST, RID, 500]);
    expect(q(unaddressedSql(ORG, CUST, RID)).params).toEqual([ORG, CUST, RID]);
    expect(q(allAddressesSql(ORG, CUST)).params).toEqual([ORG, CUST]);
    expect(q(locationCountSql(ORG, CUST)).params).toEqual([ORG, CUST]);
    expect(q(membershipSql(ORG, CUST)).params).toEqual([ORG, ORG, CUST]);
    expect(text(candidatesSql(ORG, CUST, RID))).toContain("organization_id = $1::uuid AND customer_id = $2::uuid AND id <> $3::uuid");
  });

  it("past jobs exclude unstarted future jobs and never select description, notes or contact columns", () => {
    const t = text(pastJobsSql(ORG, [OTHER]));
    expect(t).toContain("AND NOT (r.status IN ('pending'::request_status, 'assigned'::request_status, 'scheduled'::request_status) AND COALESCE(r.scheduled_date, r.arrival_window_start) > now())");
    expect(t).not.toMatch(/description|access_notes|address|phone|email|signature/);
    expect(t).toContain("LIMIT $");
  });

  it("estimates: open, unexpired, on the given requests only; upcoming visits from the start of today in the business timezone", () => {
    expect(text(openEstimatesSql(ORG, [RID]))).toContain("e.status = 'open'::estimate_status AND (e.expires_at IS NULL OR e.expires_at > now()) AND e.service_request_id = ANY(ARRAY[$");
    expect(text(upcomingVisitsSql(ORG, "m", "America/New_York"))).toContain("due_date >= (date_trunc('day', now() AT TIME ZONE $3) AT TIME ZONE $4)");
  });
});

describe("getSiteView", () => {
  it("no customer: none scope, this job's estimates still listed", async () => {
    vi.mocked(findReadableJob).mockResolvedValueOnce({ id: RID, customerId: null, native: false, status: "scheduled" });
    readQueue.push([{ customer_id: null, location_id: null, address_encrypted: null, customer_erased: false, location_label: null }], []);
    expect(await getSiteView(ORG, ME, RID)).toEqual({
      kind: "ok",
      view: { scope: "none", title: "Service address", unaddressedCount: 0, membership: { state: "none" }, hasCustomer: false, isLead: true, pastJobs: [], openEstimates: [] },
    });
  });

  it("location scope: matches feed past jobs and estimates; a second location withholds membership", async () => {
    readQueue.push(
      [{ customer_id: CUST, location_id: LOC, address_encrypted: ADDR, customer_erased: false, location_label: "Main house" }],
      [{ id: OTHER, location_id: LOC, address_encrypted: null }, { id: "x", location_id: null, address_encrypted: "ENC:40 Oak Ave" }],
      [{ n: 2 }],
      [{ id: OTHER, reference_number: "R-1", job_date: "2026-11-03T15:00:00Z", status: "completed", job_type_name: null, issue_type: "no_heat", lead_first_name: "Alex", form_names: ["Maintenance checklist"] }],
      [{ id: "e1", created_at: "2026-11-06T15:00:00Z", total_cents: 481200, title: null, from_fp: false, service_request_id: OTHER, option_count: 2 }],
      [{ n: 2 }],
      [{ address_encrypted: ADDR }],
    );
    const r = await getSiteView(ORG, ME, RID);
    expect(r).toMatchObject({
      kind: "ok",
      view: {
        scope: "location", title: "Main house", unaddressedCount: 2, membership: { state: "withheld" },
        pastJobs: [{ id: OTHER, kind: "No heat", leadTechnicianName: "Alex", submittedFormNames: ["Maintenance checklist"] }],
        openEstimates: [{ id: "e1", label: "Estimate · Nov 6 · 2 options", thisJob: false, fromFieldPulse: false }],
      },
    });
    expect(q(executed[4] as SQL).params).toEqual(expect.arrayContaining([RID, OTHER]));
  });

  it("an erased customer: none scope and membership withheld, never \"Not a member.\" (R2); no customer reads", async () => {
    readQueue.push([{ customer_id: CUST, location_id: LOC, address_encrypted: ADDR, customer_erased: true, location_label: null }], []);
    const r = await getSiteView(ORG, ME, RID);
    expect(r).toMatchObject({ kind: "ok", view: { scope: "none", membership: { state: "withheld" }, hasCustomer: true, pastJobs: [] } });
    expect(executed.map((e) => text(e as SQL)).some((t) => t.includes("customer_memberships") || t.includes("customer_id = $2"))).toBe(false);
  });

  it("member: one address everywhere and one location", async () => {
    readQueue.push(
      [{ customer_id: CUST, location_id: null, address_encrypted: ADDR, customer_erased: false, location_label: null }],
      [], [{ n: 0 }], [], [{ n: 1 }], [{ address_encrypted: ADDR }, { address_encrypted: "ENC:12  elm st, johnson city, tn" }],
      [{ id: "m1", started_at: "2026-03-01T00:00:00Z", current_period_end: null, plan_name: "Comfort Club", visits_per_year: 2 }],
      [{ due_date: "2027-05-01T12:00:00Z", status: "generated", generated_service_request_id: RID }],
    );
    const r = await getSiteView(ORG, ME, RID);
    expect(r).toMatchObject({ kind: "ok", view: { scope: "address", membership: { state: "member", planName: "Comfort Club", upcoming: [{ status: "generated", thisJob: true }] } } });
  });

  it("isLead comes from the shared lead rule (the active visit's lead), not from assigned_to", async () => {
    vi.mocked(findActiveVisit).mockResolvedValueOnce({ appointmentId: "a", leadTechnicianId: "someone-else" });
    readQueue.push([{ customer_id: null, location_id: null, address_encrypted: null, customer_erased: false, location_label: null }], []);
    expect(await getSiteView(ORG, ME, RID)).toMatchObject({ kind: "ok", view: { isLead: false } });
    vi.mocked(findActiveVisit).mockResolvedValueOnce(null);
    readQueue.push([{ customer_id: null, location_id: null, address_encrypted: null, customer_erased: false, location_label: null }], []);
    expect(await getSiteView(ORG, ME, RID)).toMatchObject({ kind: "ok", view: { isLead: false } });
  });

  it("normalizedAddress tolerates a rotated key", () => {
    expect(normalizedAddress("BAD")).toBeNull();
    expect(normalizedAddress("ENC:  12 Elm  St ")).toBe("12 elm st");
  });
});
