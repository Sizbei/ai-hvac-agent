import { describe, it, expect } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { sql, type SQL } from "drizzle-orm";
import {
  activeTechnicianSql, cancelDoneOldLeadSql, closeOldLeadEntriesSql, fieldpulseFreeSql, leadDoneSql, noOverlapSql, noWorkLoggedSql,
  otherStartedOnVisitOneSql, requestXminGateSql, reviveLeadSql, startedOnVisitOneSql, versionGateSql, visitOneIdSql,
  visitOneLiveSql, visitOneXminGateSql,
} from "./visit-move-sql";

const ORG = "00000000-0000-4000-8000-0000000000aa";
const RID = "11111111-1111-4111-8111-111111111111";
const VID = "22222222-2222-4222-8222-222222222222";
const ALEX = "33333333-3333-4333-8333-333333333333";
const SAM = "44444444-4444-4444-8444-444444444444";
const q = (s: SQL) => {
  const out = new PgDialect().sqlToQuery(s);
  return { text: out.sql.replace(/\s+/g, " ").trim(), params: out.params };
};
const GATE = sql`GATE_MARK`;

describe("visit #1 and gates", () => {
  it("visitOneIdSql binds the request and the org", () => {
    expect(q(visitOneIdSql(ORG, RID))).toEqual({
      text: "(SELECT v1.id FROM appointments v1 WHERE v1.service_request_id = $1::uuid AND v1.organization_id = $2::uuid AND v1.appointment_number = 1)",
      params: [RID, ORG],
    });
  });
  it("requestXminGateSql: this transaction wrote the org's request row", () => {
    expect(q(requestXminGateSql(ORG, RID))).toEqual({
      text: "EXISTS (SELECT 1 FROM service_requests xr WHERE xr.id = $1::uuid AND xr.organization_id = $2::uuid AND xr.xmin = pg_current_xact_id()::xid)",
      params: [RID, ORG],
    });
  });
  it("visitOneXminGateSql: this transaction wrote visit #1 (the trigger's version bump)", () => {
    expect(q(visitOneXminGateSql(ORG, RID))).toEqual({
      text: "EXISTS (SELECT 1 FROM appointments xp WHERE xp.service_request_id = $1::uuid AND xp.organization_id = $2::uuid AND xp.appointment_number = 1 AND xp.xmin = pg_current_xact_id()::xid)",
      params: [RID, ORG],
    });
  });
  it("versionGateSql compares the visit id AND its version, on #1 of this request in this org", () => {
    expect(q(versionGateSql(ORG, RID, VID, 7))).toEqual({
      text: "EXISTS (SELECT 1 FROM appointments g WHERE g.id = $1::uuid AND g.organization_id = $2::uuid AND g.service_request_id = $3::uuid AND g.appointment_number = 1 AND g.version = $4::int)",
      params: [VID, ORG, RID, 7],
    });
  });
  it("versionGateSql with a null visit: no visit #1 may exist", () => {
    expect(q(versionGateSql(ORG, RID, null, null))).toEqual({
      text: "NOT EXISTS (SELECT 1 FROM appointments g WHERE g.service_request_id = $1::uuid AND g.organization_id = $2::uuid AND g.appointment_number = 1)",
      params: [RID, ORG],
    });
  });
  it("visitOneLiveSql: #1 is the displayed visit, not ended, not cancelled", () => {
    const { text, params } = q(visitOneLiveSql(ORG));
    expect(text).toMatch(/^\(NOT \(/);
    expect(text).toContain("NOT EXISTS (SELECT 1 FROM appointments c1 WHERE c1.service_request_id = \"service_requests\".\"id\" AND c1.organization_id = $");
    expect(text).toContain("c1.appointment_number = 1 AND c1.cancelled_at IS NOT NULL)");
    expect(params).toContain(ORG);
  });
});

describe("started, done, active", () => {
  it("startedOnVisitOneSql(any) is correlated, org-bound, uses the started twin", () => {
    const { text, params } = q(startedOnVisitOneSql(ORG, "any"));
    expect(text).toBe(
      "EXISTS (SELECT 1 FROM appointment_assignments sa JOIN appointments sp ON sp.id = sa.appointment_id WHERE sp.service_request_id = \"service_requests\".\"id\" AND sp.organization_id = $1::uuid AND sa.organization_id = $2::uuid AND sp.appointment_number = 1 AND (sa.status <> 'cancelled'::request_status AND (sa.status IN ('en_route'::request_status, 'arrived'::request_status, 'in_progress'::request_status) OR (sa.status = 'on_hold'::request_status AND (sa.en_route_at IS NOT NULL OR sa.arrived_at IS NOT NULL OR sa.started_at IS NOT NULL OR sa.completed_at IS NOT NULL)) OR (sa.is_lead AND sa.status = 'completed'::request_status))))",
    );
    expect(params).toEqual([ORG, ORG]);
  });
  it("startedOnVisitOneSql(lead) looks at the lead row only", () => {
    expect(q(startedOnVisitOneSql(ORG, "lead")).text).toContain("AND sp.appointment_number = 1 AND sa.is_lead AND (sa.status <> 'cancelled'");
  });
  it("otherStartedOnVisitOneSql excludes one technician", () => {
    const { text, params } = q(otherStartedOnVisitOneSql(ORG, ALEX));
    expect(text).toContain("AND sp.appointment_number = 1 AND sa.technician_id <> $3::uuid AND (sa.status <> 'cancelled'");
    expect(params).toEqual([ORG, ORG, ALEX]);
  });
  it("leadDoneSql: the technician has a completed row on #1", () => {
    expect(q(leadDoneSql(ORG, SAM))).toEqual({
      text: "EXISTS (SELECT 1 FROM appointment_assignments d JOIN appointments dp ON dp.id = d.appointment_id WHERE dp.service_request_id = \"service_requests\".\"id\" AND dp.organization_id = $1::uuid AND d.organization_id = $2::uuid AND dp.appointment_number = 1 AND d.technician_id = $3::uuid AND d.status = 'completed'::request_status)",
      params: [ORG, ORG, SAM],
    });
  });
  it("step 1 requires the new lead to be an active technician of the org", () => {
    expect(q(activeTechnicianSql(ORG, SAM))).toEqual({
      text: "EXISTS (SELECT 1 FROM users u WHERE u.id = $1::uuid AND u.organization_id = $2::uuid AND u.role = 'technician' AND u.is_active)",
      params: [SAM, ORG],
    });
  });
});

describe("noOverlapSql (lead ruling 5)", () => {
  it("open rows of the checked technicians on live visits of other open requests, half-open, org-bound three times", () => {
    const { text, params } = q(noOverlapSql(ORG, RID, [ALEX, SAM], "2026-11-10T17:00:00.000Z", "2026-11-10T21:00:00.000Z"));
    expect(text).toMatch(/^NOT EXISTS \(SELECT 1 FROM appointment_assignments ca JOIN appointments cp ON cp\.id = ca\.appointment_id JOIN service_requests cr ON cr\.id = cp\.service_request_id/);
    expect(text).toContain("WHERE ca.organization_id = $1::uuid AND cp.organization_id = $2::uuid AND cr.organization_id = $3::uuid");
    expect(text).toContain("AND ca.technician_id = ANY($4::uuid[])");
    expect(text).toContain("AND ca.status IN ('assigned'::request_status, 'scheduled'::request_status, 'en_route'::request_status, 'arrived'::request_status, 'in_progress'::request_status, 'on_hold'::request_status)");
    expect(text).toContain("AND cp.cancelled_at IS NULL AND cr.id <> $5::uuid AND cr.status IN ('pending'::request_status,");
    expect(text).toContain("AND cp.arrival_window_start < $6::timestamptz AND cp.arrival_window_end > $7::timestamptz)");
    expect(params).toEqual([ORG, ORG, ORG, [ALEX, SAM], RID, "2026-11-10T21:00:00.000Z", "2026-11-10T17:00:00.000Z"]);
    expect(text).not.toContain("<> ALL(");
  });
  it("mass: the other requests of the run are excluded too", () => {
    const { text, params } = q(noOverlapSql(ORG, RID, [ALEX], "a", "b", [RID, VID]));
    expect(text).toMatch(/AND cr\.id <> ALL\(\$\d+::uuid\[\]\)\)$/);
    expect(params.at(-1)).toEqual([RID, VID]);
  });
});

describe("follow-on statements (spec §5.3 steps 2–4)", () => {
  it("reviveLeadSql: the request's lead row on #1, cancelled or a started status with no stamp, nulls the stamps", () => {
    const { text, params } = q(reviveLeadSql(ORG, RID, GATE));
    expect(text).toBe(
      "UPDATE appointment_assignments a SET status = CASE WHEN r.status IN ('en_route'::request_status, 'arrived'::request_status, 'in_progress'::request_status, 'on_hold'::request_status) THEN 'assigned'::request_status ELSE r.status END, en_route_at = NULL, arrived_at = NULL, started_at = NULL, completed_at = NULL FROM service_requests r, appointments p WHERE r.id = $1::uuid AND r.organization_id = $2::uuid AND p.id = a.appointment_id AND p.service_request_id = r.id AND p.organization_id = $3::uuid AND p.appointment_number = 1 AND a.organization_id = $4::uuid AND a.technician_id = r.assigned_to AND a.is_lead AND (a.status = 'cancelled'::request_status OR (a.status IN ('en_route'::request_status, 'arrived'::request_status, 'in_progress'::request_status, 'on_hold'::request_status) AND NOT (a.en_route_at IS NOT NULL OR a.arrived_at IS NOT NULL OR a.started_at IS NOT NULL OR a.completed_at IS NOT NULL))) AND (GATE_MARK) RETURNING a.id",
    );
    expect(params).toEqual([RID, ORG, ORG, ORG]);
  });
  it("cancelDoneOldLeadSql: only the old lead's kept completed helper row, gated", () => {
    expect(q(cancelDoneOldLeadSql(ORG, RID, ALEX, GATE))).toEqual({
      text: "UPDATE appointment_assignments a SET status = 'cancelled'::request_status FROM appointments p WHERE p.id = a.appointment_id AND p.service_request_id = $1::uuid AND p.organization_id = $2::uuid AND p.appointment_number = 1 AND a.organization_id = $3::uuid AND a.technician_id = $4::uuid AND NOT a.is_lead AND a.status = 'completed'::request_status AND (GATE_MARK) RETURNING a.id",
      params: [RID, ORG, ORG, ALEX],
    });
  });
  it("closeOldLeadEntriesSql: the old lead's open job time on #1 or with no visit link, gated", () => {
    const { text, params } = q(closeOldLeadEntriesSql(ORG, RID, ALEX, GATE));
    expect(text).toContain("WHERE u.id = t.technician_id AND t.organization_id = $");
    expect(text).toContain("AND t.technician_id = ANY($");
    expect(text).toContain("AND t.kind = 'job' AND t.clock_out_at IS NULL AND ((GATE_MARK) AND (t.appointment_id = (SELECT v1.id FROM appointments v1 WHERE v1.service_request_id = $");
    expect(text).toContain("v1.appointment_number = 1) OR t.appointment_id IS NULL))");
    expect(params).toEqual([ORG, RID, [ALEX], RID, ORG]);
  });
  it("noWorkLoggedSql: no job time on #1 of the correlated request, nor unlinked (WORK_LOGGED)", () => {
    expect(q(noWorkLoggedSql(ORG))).toEqual({
      text: "NOT EXISTS (SELECT 1 FROM technician_time_entries t WHERE t.organization_id = $1::uuid AND t.service_request_id = \"service_requests\".\"id\" AND t.kind = 'job' AND (t.appointment_id = (SELECT w1.id FROM appointments w1 WHERE w1.service_request_id = \"service_requests\".\"id\" AND w1.organization_id = $2::uuid AND w1.appointment_number = 1) OR t.appointment_id IS NULL))",
      params: [ORG, ORG],
    });
  });
  it("fieldpulseFreeSql is the correlated request's predicate", () => {
    expect(q(fieldpulseFreeSql()).text).toBe("\"service_requests\".\"fieldpulse_job_id\" IS NULL");
  });
});
