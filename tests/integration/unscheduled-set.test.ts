import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/**
 * Final wave I1: the nav badge and the dispatch link (countUnscheduledRequests),
 * the calendar page's panel (getSchedulingCalendar) and listUnscheduledRequests
 * read ONE unscheduled set, so the count always equals the rail's length. DEV database, one throwaway org,
 * deleted in afterAll.
 */

let db: typeof import("@/lib/db").db;
let sql: typeof import("drizzle-orm").sql;
let q: typeof import("@/lib/admin/queries");
let sched: typeof import("@/lib/admin/scheduling-queries");
let v: typeof import("@/lib/admin/visibility");
let org = "";
const expected: string[] = [];

async function insertRequest(p: {
  session: string;
  customer: string;
  status: string;
  assignedTo: string | null;
  window: boolean;
}): Promise<string> {
  const start = p.window ? sql`now() + interval '1 day'` : sql`NULL`;
  const end = p.window ? sql`now() + interval '1 day 2 hours'` : sql`NULL`;
  const res = await db.execute(sql`INSERT INTO service_requests
      (organization_id,session_id,customer_id,issue_type,urgency,description,reference_number,
       status,assigned_to,arrival_window_start,arrival_window_end)
    VALUES (${org},${p.session},${p.customer},'no_heat','medium','Probe unscheduled',
      'PRB-'||substr(md5(random()::text),1,8),
      ${p.status}::request_status,${p.assignedTo},${start},${end}) RETURNING id`);
  return (res.rows[0] as { id: string }).id;
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
  q = await import("@/lib/admin/queries");
  sched = await import("@/lib/admin/scheduling-queries");
  v = await import("@/lib/admin/visibility");
  const { encrypt } = await import("@/lib/crypto");
  const { createOrgCore } = await import("@/lib/admin/provisioning");

  const out = await createOrgCore({
    name: `Probe Org Unscheduled ${randomUUID().slice(0, 8)}`,
    createdBy: null,
    ownerEmail: null,
    ownerUser: {
      email: `owner-${randomUUID()}@throwaway.example`,
      name: "Probe Owner",
      googleId: `probe-${randomUUID()}`,
    },
    skipOrgCountCheck: true,
  });
  if (!out.ok) throw new Error(`createOrgCore failed: ${JSON.stringify(out.error)}`);
  org = out.result.organizationId as string;

  const one = async (statement: ReturnType<typeof sql>) =>
    ((await db.execute(statement)).rows[0] as { id: string }).id;
  const tech = await one(sql`SELECT id FROM users WHERE organization_id = ${org} LIMIT 1`);
  const customer = await one(sql`INSERT INTO customers (organization_id,name_encrypted)
    VALUES (${org},${encrypt("Pat Unscheduled")}) RETURNING id`);
  const session = await one(sql`INSERT INTO customer_sessions (organization_id,token,customer_id,status)
    VALUES (${org},gen_random_uuid()::text,${customer},'submitted'::session_status) RETURNING id`);
  const base = { session, customer };

  // In the set: no technician, or no arrival window, while open.
  expected.push(await insertRequest({ ...base, status: "pending", assignedTo: null, window: false }));
  expected.push(await insertRequest({ ...base, status: "assigned", assignedTo: tech, window: false }));
  expected.push(await insertRequest({ ...base, status: "in_progress", assignedTo: tech, window: false }));
  expected.push(await insertRequest({ ...base, status: "scheduled", assignedTo: null, window: true }));
  // Out of the set: fully placed, or closed.
  await insertRequest({ ...base, status: "assigned", assignedTo: tech, window: true });
  await insertRequest({ ...base, status: "completed", assignedTo: null, window: false });
}, 120_000);

afterAll(async () => {
  if (!org) return;
  try {
    await db.execute(sql`DELETE FROM organizations WHERE id = ${org}`);
  } catch (error) {
    console.error(`afterAll: could not delete probe org ${org}`, error);
  }
}, 60_000);

describe("one unscheduled set (dev DB)", { timeout: 60_000 }, () => {
  it("the rail lists every open request without a technician or a window", async () => {
    const rail = await sched.listUnscheduledRequests(org, v.VISIBLE_ONLY);
    expect(rail.map((r) => r.id).sort()).toEqual([...expected].sort());
  });

  it("the badge count equals the rail's length", async () => {
    const rail = await sched.listUnscheduledRequests(org, v.VISIBLE_ONLY);
    expect(await q.countUnscheduledRequests(org, v.VISIBLE_ONLY)).toBe(rail.length);
  });

  it("the dispatch board's link count equals the rail's length", async () => {
    const rail = await sched.listUnscheduledRequests(org, v.VISIBLE_ONLY);
    const board = await q.getDispatchBoard(org, undefined, v.VISIBLE_ONLY);
    expect(board.unscheduledCount).toBe(rail.length);
  });

  it("the calendar page's unscheduled panel lists the same requests", async () => {
    const rail = await sched.listUnscheduledRequests(org, v.VISIBLE_ONLY);
    const now = new Date();
    const cal = await q.getSchedulingCalendar(
      org, now.toISOString(), new Date(now.getTime() + 86_400_000).toISOString(), [], false, v.VISIBLE_ONLY,
    );
    expect(cal.unscheduled.map((r) => r.id).sort()).toEqual(rail.map((r) => r.id).sort());
  });
});
