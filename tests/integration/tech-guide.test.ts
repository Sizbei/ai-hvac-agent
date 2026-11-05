import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/**
 * Integration suite for the technician getting-started guide (dev DB only,
 * VITEST_INTEGRATION=1). Two throwaway orgs via createOrgCore, deleted in
 * afterAll. Every UPDATE carries the row id AND the org id.
 */

type Q = typeof import("@/lib/tech/guide-queries");
type S = typeof import("@/lib/tech/guide-sql");
type Db = typeof import("@/lib/db");
type Row = Record<string, unknown>;

let q: Q;
let s: S;
let db: Db["db"];
let sql: typeof import("drizzle-orm").sql;
let org1 = "";
let org2 = "";
let lead = "";
let helper = "";
let helperRow = "";
let leadB = "";
let techB = "";

async function run(statement: ReturnType<typeof sql>): Promise<Row[]> {
  return (await db.execute(statement)).rows as Row[];
}

async function stateOf(user: string, org: string): Promise<Row | null> {
  const rows = await run(sql`SELECT field_guide_state AS st FROM users WHERE id = ${user} AND organization_id = ${org}`);
  return (rows[0]?.st as Row | null) ?? null;
}

async function tech(org: string, active = true): Promise<string> {
  return (await run(sql`INSERT INTO users (organization_id,email,name,role,password_hash,is_active) VALUES (${org},'tech-'||gen_random_uuid()||'@throwaway.example','Guide Probe Technician','technician','x',${active}) RETURNING id`))[0].id as string;
}

/** Request assigned to the lead (the 0050 trigger makes visit #1 + the lead row), then the helper's row. */
async function seedJob(org: string, leadId: string, helperId: string): Promise<{ rid: string; appt: string; row: string }> {
  const sess = (await run(sql`INSERT INTO customer_sessions (organization_id,token) VALUES (${org},gen_random_uuid()::text) RETURNING id`))[0].id as string;
  const rid = (await run(sql`INSERT INTO service_requests (organization_id,session_id,assigned_to,issue_type,urgency,description,reference_number,scheduled_date,status) VALUES (${org},${sess},${leadId},'no_heat','medium','Guide probe','GPR-'||substr(md5(random()::text),1,8),now(),'assigned'::request_status) RETURNING id`))[0].id as string;
  const appt = (await run(sql`SELECT id FROM appointments WHERE service_request_id = ${rid} AND organization_id = ${org} ORDER BY appointment_number LIMIT 1`))[0].id as string;
  const row = (await run(sql`INSERT INTO appointment_assignments (organization_id,appointment_id,technician_id,is_lead,status) VALUES (${org},${appt},${helperId},false,'assigned'::request_status) RETURNING id`))[0].id as string;
  return { rid, appt, row };
}

beforeAll(async () => {
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const m = line.match(/^([A-Z_0-9]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
  }
  const url = process.env.DATABASE_URL ?? "";
  if (!url) throw new Error("DATABASE_URL missing from .env.local");
  if (url.includes("ep-withered-hill")) throw new Error("Refusing to run against the production database");
  ({ sql } = await import("drizzle-orm"));
  ({ db } = await import("@/lib/db"));
  q = await import("@/lib/tech/guide-queries");
  s = await import("@/lib/tech/guide-sql");
  const { createOrgCore } = await import("@/lib/admin/provisioning");
  const make = async (label: string) => {
    const out = await createOrgCore({
      name: `Guide Probe Org ${label} ${randomUUID().slice(0, 8)}`,
      createdBy: null,
      ownerEmail: null,
      ownerUser: { email: `owner-${randomUUID()}@throwaway.example`, name: "Probe Owner", googleId: `probe-${randomUUID()}` },
      skipOrgCountCheck: true,
    });
    if (!out.ok) throw new Error(`createOrgCore failed: ${JSON.stringify(out.error)}`);
    return out.result.organizationId as string;
  };
  org1 = await make("1");
  org2 = await make("2");
  lead = await tech(org1, false);
  helper = await tech(org1);
  leadB = await tech(org2, false);
  techB = await tech(org2);
}, 60_000);

afterAll(async () => {
  for (const id of [org1, org2]) {
    if (!id) continue;
    try {
      await db.execute(sql`DELETE FROM organizations WHERE id = ${id}`);
    } catch (error) {
      console.error(`afterAll: could not delete probe org ${id}`, error);
    }
  }
}, 60_000);

describe("technician guide (dev DB)", () => {
  it("(a) a new technician is 0 of 2 with the no-job note and nothing stamped", async () => {
    const p = await q.getGuide(org1, helper);
    expect(p.progress.requiredDone).toBe(0);
    expect(p.upNext).toBe("start_job");
    expect(p.steps[0].note).toBe("The office hasn't assigned you a job yet. It shows in your jobs when they do.");
    expect(p.cardHidden).toBe(false);
    expect(await stateOf(helper, org1)).toBeNull();
  });

  it("(b) a started row completes start_job, stamps it, and the stamp is sticky", async () => {
    ({ row: helperRow } = await seedJob(org1, lead, helper));
    expect((await q.getGuide(org1, helper)).steps[0].note).toBeUndefined();
    await db.execute(sql`UPDATE appointment_assignments SET en_route_at = now() WHERE id = ${helperRow} AND organization_id = ${org1}`);
    const p = await q.getGuide(org1, helper);
    expect(p.steps[0].done).toBe(true);
    expect(p.upNext).toBe("finish_job");
    const st = await stateOf(helper, org1);
    expect((st?.firstCompleted as Row)?.start_job).toBeDefined();
    await db.execute(sql`UPDATE appointment_assignments SET en_route_at = NULL WHERE id = ${helperRow} AND organization_id = ${org1}`);
    expect((await q.getGuide(org1, helper)).steps[0].done).toBe(true);
  });

  it("(c) a completed started row finishes the guide; the next read writes nothing", async () => {
    await db.execute(sql`UPDATE appointment_assignments SET started_at = now(), completed_at = now() WHERE id = ${helperRow} AND organization_id = ${org1}`);
    const p = await q.getGuide(org1, helper);
    expect(p.finished).toBe(true);
    expect(p.cardHidden).toBe(false);
    const before = JSON.stringify(await stateOf(helper, org1));
    expect((JSON.parse(before).firstCompleted as Row).finish_job).toBeDefined();
    await q.getGuide(org1, helper);
    expect(JSON.stringify(await stateOf(helper, org1))).toBe(before);
  });

  it("(d) hide is write-once", async () => {
    const first = await q.hideGuide(org1, helper);
    expect(first?.hiddenAt).toBeDefined();
    await new Promise((r) => setTimeout(r, 20));
    const second = await q.hideGuide(org1, helper);
    expect(second?.hiddenAt).toBe(first?.hiddenAt);
    expect((await q.getGuide(org1, helper)).cardHidden).toBe(true);
    expect(await q.readGuideHidden(org1, helper)).toBe(true);
  });

  it("(e) tenancy: technician B's rows in org 2 never count for the helper, and the org parameter gates", async () => {
    const { rid, row } = await seedJob(org2, leadB, techB);
    await db.execute(sql`UPDATE appointment_assignments SET en_route_at = now(), started_at = now() WHERE id = ${row} AND organization_id = ${org2}`);
    await db.execute(sql`INSERT INTO job_materials (organization_id,service_request_id,description,created_by) VALUES (${org2},${rid},'Probe part',${techB})`);
    await db.execute(sql`INSERT INTO request_notes (organization_id,request_id,author_id,content) VALUES (${org2},${rid},${techB},'Probe note')`);
    const pb = await q.getGuide(org2, techB);
    expect(pb.steps.find((x) => x.id === "add_material")?.done).toBe(true);
    expect(pb.steps.find((x) => x.id === "note_or_photo")?.done).toBe(true);
    const fresh = await tech(org1);
    const pa = await q.getGuide(org1, fresh);
    expect(pa.steps.every((x) => !x.done)).toBe(true);
    const cross = (await run(s.guideSelectSql(org2, helper)))[0];
    for (const [k, v] of Object.entries(cross)) {
      if (k !== "field_guide_state") expect(v, k).toBe(false);
    }
  });

  it("(f) two stamp statements with disjoint keys both land", async () => {
    const fresh = await tech(org1);
    const iso = new Date().toISOString();
    await Promise.all([
      db.execute(s.guideStampSql({ organizationId: org1, userId: fresh, newStamps: { clock_in: iso } })),
      db.execute(s.guideStampSql({ organizationId: org1, userId: fresh, newStamps: { add_material: iso } })),
    ]);
    const st = await stateOf(fresh, org1);
    expect(Object.keys((st?.firstCompleted as Row) ?? {}).sort()).toEqual(["add_material", "clock_in"]);
  });

  it("(g) a day-old finish stamp hides the card server-side and in the payload", async () => {
    const fresh = await tech(org1);
    const old = new Date(Date.now() - 25 * 3_600_000).toISOString();
    await db.execute(s.guideStampSql({ organizationId: org1, userId: fresh, newStamps: { start_job: old, finish_job: old } }));
    expect(await q.readGuideHidden(org1, fresh)).toBe(true);
    expect((await q.getGuide(org1, fresh)).cardHidden).toBe(true);
  });
});
