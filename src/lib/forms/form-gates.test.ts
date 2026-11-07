import { describe, it, expect } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import {
  formApplies, formAppliesSql, gateReason, readFormGatesSql, requestGateSql, toFormGates, visitCounts, visitCountsSql,
  visitGateSql, writeBlockedReason, type FormGates,
} from "./form-gates";

const ORG = "11111111-1111-4111-8111-111111111111";
const RID = "22222222-2222-4222-8222-222222222222";
const AID = "33333333-3333-4333-8333-333333333333";
const ME = "44444444-4444-4444-8444-444444444444";
const FORM = "55555555-5555-4555-8555-555555555555";
const dialect = new PgDialect();
const q = (s: SQL) => dialect.sqlToQuery(s);
const text = (s: SQL) => q(s).sql.replace(/\s+/g, " ").trim();
const orgCount = (s: SQL) => q(s).params.filter((p) => p === ORG).length;

describe("gate SQL (spec §5.1)", () => {
  it("visitGateSql joins on a.appointment_id = p.id and binds the org on both tables", () => {
    const s = visitGateSql(ORG, RID, AID, ME);
    expect(text(s)).toBe(
      "EXISTS (SELECT 1 FROM appointments p JOIN appointment_assignments a ON a.appointment_id = p.id WHERE p.id = $1::uuid AND p.service_request_id = $2::uuid AND p.organization_id = $3::uuid AND a.organization_id = $4::uuid AND p.cancelled_at IS NULL AND a.technician_id = $5::uuid AND a.status <> 'cancelled'::request_status)",
    );
    expect(orgCount(s)).toBe(2);
  });

  it("requestGateSql: not cancelled; synced OR on site OR own arrival (parenthesised); customer not erased", () => {
    const s = requestGateSql(ORG, RID, AID, ME);
    const t = text(s);
    expect(t).toContain("rg.status <> 'cancelled'::request_status");
    expect(t).toContain("AND ((rg.fieldpulse_job_id IS NOT NULL OR rg.hcp_job_id IS NOT NULL) OR rg.status IN ('arrived'::request_status, 'in_progress'::request_status, 'on_hold'::request_status, 'completed'::request_status) OR EXISTS (SELECT 1 FROM appointment_assignments ga");
    expect(t).toContain("(ga.arrived_at IS NOT NULL OR ga.started_at IS NOT NULL OR ga.completed_at IS NOT NULL))");
    expect(t).toContain("NOT EXISTS (SELECT 1 FROM customers gc WHERE gc.id = rg.customer_id AND gc.organization_id = $");
    expect(t).toContain("gc.anonymized_at IS NOT NULL");
    expect(orgCount(s)).toBe(3);
  });

  it("formAppliesSql and its pure twin", () => {
    expect(text(formAppliesSql("f", "r"))).toBe("(cardinality(f.job_type_ids) = 0 OR r.job_type_id = ANY(f.job_type_ids))");
    expect(formApplies([], null)).toBe(true);
    expect(formApplies(["jt-1"], null)).toBe(false);
    expect(formApplies(["jt-1"], "jt-1")).toBe(true);
  });

  it("visitCountsSql: live OR progressed/completed row OR a submission, org-bound twice", () => {
    const s = visitCountsSql(ORG, "p");
    const t = text(s);
    expect(t.startsWith("(p.cancelled_at IS NULL OR EXISTS (SELECT 1 FROM appointment_assignments vca WHERE vca.appointment_id = p.id")).toBe(true);
    expect(t).toContain("vca.status = 'completed'::request_status))");
    expect(t).toContain("OR EXISTS (SELECT 1 FROM form_submissions vcs WHERE vcs.appointment_id = p.id AND vcs.organization_id = $2::uuid))");
    expect(orgCount(s)).toBe(2);
  });

  it("readFormGatesSql reads the visit and the form org-scoped", () => {
    const s = readFormGatesSql(ORG, RID, AID, ME, FORM);
    const t = text(s);
    expect(t).toContain("LEFT JOIN appointments p ON p.id = $");
    expect(t).toContain("p.service_request_id = r.id AND p.organization_id = $");
    expect(t).toContain("LEFT JOIN forms f ON f.id = $");
    expect(t).toContain("WHERE r.id = $");
    expect(orgCount(s)).toBe(7);
    expect(q(readFormGatesSql(ORG, RID, AID, ME, null)).params).toContain(null);
  });
});

describe("visitCounts", () => {
  const a = (progressed: boolean, status = "assigned") => ({ progressed, status });
  it("live; ended by a hold with progress; with a submission; cancelled untouched", () => {
    expect(visitCounts({ cancelledAt: null, assignments: [], hasSubmission: false })).toBe(true);
    expect(visitCounts({ cancelledAt: new Date(), assignments: [a(true, "cancelled")], hasSubmission: false })).toBe(true);
    expect(visitCounts({ cancelledAt: new Date(), assignments: [a(false, "completed")], hasSubmission: false })).toBe(true);
    expect(visitCounts({ cancelledAt: new Date(), assignments: [a(false, "cancelled")], hasSubmission: true })).toBe(true);
    expect(visitCounts({ cancelledAt: new Date(), assignments: [a(false, "cancelled")], hasSubmission: false })).toBe(false);
  });
});

const ok: FormGates = {
  status: "arrived", native: true, customerErased: false, visitFound: true, visitLive: true,
  myRow: true, myLiveRow: true, myProgress: false, formFound: true, formActive: true, formVersion: 1,
};

describe("gateReason (lead ruling 1)", () => {
  it("passes an on-site native job and any synced status but cancelled", () => {
    expect(gateReason(ok)).toBeNull();
    expect(gateReason({ ...ok, native: false, status: "scheduled" })).toBeNull();
    expect(gateReason({ ...ok, status: "completed" })).toBeNull();
  });
  it("a native helper who arrived before the request did is allowed; without progress → not_on_site", () => {
    expect(gateReason({ ...ok, status: "scheduled", myProgress: true })).toBeNull();
    expect(gateReason({ ...ok, status: "scheduled" })).toBe("not_on_site");
  });
  it("orders job_closed, customer_removed, visit_ended / not_assigned, not_on_site", () => {
    expect(gateReason(null)).toBe("not_found");
    expect(gateReason({ ...ok, visitFound: false })).toBe("not_found");
    expect(gateReason({ ...ok, status: "cancelled", visitLive: false, myLiveRow: false })).toBe("job_closed");
    expect(gateReason({ ...ok, native: false, status: "cancelled" })).toBe("job_closed");
    expect(gateReason({ ...ok, visitLive: false })).toBe("visit_ended");
    expect(gateReason({ ...ok, visitLive: false, myRow: false, myLiveRow: false })).toBe("not_assigned");
    expect(gateReason({ ...ok, myLiveRow: false })).toBe("not_assigned");
    expect(gateReason({ ...ok, customerErased: true })).toBe("customer_removed");
    // An erased customer refuses before the on-site and visit checks (the GET shows the same reason).
    expect(gateReason({ ...ok, customerErased: true, status: "scheduled" })).toBe("customer_removed");
    expect(gateReason({ ...ok, customerErased: true, visitLive: false })).toBe("customer_removed");
    expect(gateReason({ ...ok, customerErased: true, status: "cancelled" })).toBe("job_closed");
  });
  it("toFormGates maps the row and treats nulls as false", () => {
    expect(toFormGates(undefined)).toBeNull();
    expect(toFormGates({ status: "arrived", native: true, visit_found: true, visit_live: null, form_version: "3" })).toMatchObject({
      visitLive: false, formVersion: 3, myRow: false,
    });
  });
});

describe("writeBlockedReason (spec §6)", () => {
  const draft = { status: "draft" as const, erased: false, unreadable: false };
  it("null when the caller may write", () => {
    expect(writeBlockedReason(ok, null)).toBeNull();
    expect(writeBlockedReason(ok, draft)).toBeNull();
  });
  it("row states before gates; archived only without a row", () => {
    expect(writeBlockedReason(ok, { ...draft, erased: true })).toBe("answers_removed");
    expect(writeBlockedReason({ ...ok, customerErased: true }, draft)).toBe("customer_removed");
    expect(writeBlockedReason(ok, { ...draft, status: "submitted" })).toBe("submitted");
    expect(writeBlockedReason(ok, { ...draft, unreadable: true })).toBe("unreadable");
    expect(writeBlockedReason({ ...ok, formActive: false }, null)).toBe("archived");
    expect(writeBlockedReason({ ...ok, formActive: false }, draft)).toBeNull();
  });
  it("gates map to their reasons", () => {
    expect(writeBlockedReason({ ...ok, status: "cancelled" }, draft)).toBe("job_closed");
    expect(writeBlockedReason({ ...ok, visitLive: false }, draft)).toBe("visit_ended");
    expect(writeBlockedReason({ ...ok, myRow: false, myLiveRow: false }, null)).toBe("not_assigned");
    expect(writeBlockedReason({ ...ok, status: "scheduled" }, null)).toBe("not_on_site");
  });
});
