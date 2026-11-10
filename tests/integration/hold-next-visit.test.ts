import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { VISIBLE_ONLY } from "@/lib/admin/visibility";

vi.mock("server-only", () => ({}));

/**
 * Round-2 P0 (dev DB only, VITEST_INTEGRATION=1): put a request on hold, then
 * schedule the next visit. A hold ENDS the visit (M3a); the office must show it
 * as ended, and the next visit must resume the request with the office and the
 * technician's phone agreeing on who goes and when. One throwaway org via
 * createOrgCore, deleted in afterAll. The 0050 trigger and status-writes are
 * exercised as they are, unchanged.
 */

type Db = typeof import("@/lib/db");
type Row = Record<string, unknown>;

let db: Db["db"];
let sql: typeof import("drizzle-orm").sql;
let q: typeof import("@/lib/admin/queries");
let cv: typeof import("@/lib/admin/current-visit");
let writes: typeof import("@/lib/tech/status-writes");
let own: typeof import("@/lib/tech/ownership");
let appts: typeof import("@/lib/admin/appointment-queries");
let time: typeof import("@/lib/admin/calendar-time");
let org = "";
let techA = "";
let techB = "";

async function run(statement: ReturnType<typeof sql>): Promise<Row[]> {
  return (await db.execute(statement)).rows as Row[];
}

async function tech(name: string): Promise<string> {
  return (await run(sql`INSERT INTO users (organization_id,email,name,role,password_hash,is_active) VALUES (${org},'tech-'||gen_random_uuid()||'@throwaway.example',${name},'technician','x',true) RETURNING id`))[0].id as string;
}

/** A native request booked for `techId` in `day`'s evening band (trigger makes visit #1 + lead row). */
async function seedRequest(techId: string, day: string): Promise<string> {
  const { start, end } = time.arrivalWindowUtcForBusinessDate(day, "evening");
  const sess = (await run(sql`INSERT INTO customer_sessions (organization_id,token) VALUES (${org},gen_random_uuid()::text) RETURNING id`))[0].id as string;
  return (await run(sql`INSERT INTO service_requests (organization_id,session_id,assigned_to,issue_type,urgency,description,reference_number,scheduled_date,arrival_window_start,arrival_window_end,status)
    VALUES (${org},${sess},${techId},'no_heat','medium','Hold probe','HNV-'||substr(md5(random()::text),1,8),${start.toISOString()}::timestamptz,${start.toISOString()}::timestamptz,${end.toISOString()}::timestamptz,'scheduled'::request_status) RETURNING id`))[0].id as string;
}

async function hold(rid: string): Promise<void> {
  const state = await writes.readRequestState(org, rid);
  const active = await own.findActiveVisit(org, rid);
  const held = await writes.holdVisit({
    organizationId: org, actorUserId: techA, requestId: rid, appointmentId: active?.appointmentId ?? null,
    holdReason: "awaiting_parts", followUpDate: null, requestStatus: state!.status,
  });
  expect(held).toEqual({ ok: true });
}

const dayPlus = (n: number) => time.businessIsoDate(new Date(Date.now() + n * 86_400_000));
const dayRange = (day: string) => {
  const b = time.businessDayBounds(day)!;
  return { start: b.start.toISOString(), end: b.end.toISOString() };
};

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
  cv = await import("@/lib/admin/current-visit");
  writes = await import("@/lib/tech/status-writes");
  own = await import("@/lib/tech/ownership");
  appts = await import("@/lib/admin/appointment-queries");
  time = await import("@/lib/admin/calendar-time");
  const { createOrgCore } = await import("@/lib/admin/provisioning");
  const out = await createOrgCore({
    name: `Hold Probe Org ${randomUUID().slice(0, 8)}`,
    createdBy: null,
    ownerEmail: null,
    ownerUser: { email: `owner-${randomUUID()}@throwaway.example`, name: "Probe Owner", googleId: `probe-${randomUUID()}` },
    skipOrgCountCheck: true,
  });
  if (!out.ok) throw new Error(`createOrgCore failed: ${JSON.stringify(out.error)}`);
  org = out.result.organizationId as string;
  techA = await tech("Probe Junie");
  techB = await tech("Probe Odessa");
}, 60_000);

afterAll(async () => {
  if (!org) return;
  try {
    await db.execute(sql`DELETE FROM organizations WHERE id = ${org}`);
  } catch (error) {
    console.error(`afterAll: could not delete probe org ${org}`, error);
  }
}, 60_000);

describe("hold → schedule next visit (dev DB)", () => {
  it("a live request is placed by its own columns", async () => {
    const rid = await seedRequest(techA, dayPlus(2));
    const detail = await q.getRequestById(org, rid, VISIBLE_ONLY);
    expect(detail?.currentVisit).toEqual({ kind: "request" });
    expect(await cv.readVisitEnded(org, rid)).toBe(false);
  }, 60_000);

  it("after a hold the visit shows as ended; the next visit resumes it and office = phone", async () => {
    const day = dayPlus(3);
    const rid = await seedRequest(techA, day);
    await hold(rid);

    // The hold ended visit #1 (untouched lead row → cancelled → visit cancelled).
    const v1 = await run(sql`SELECT cancelled_at FROM appointments WHERE service_request_id = ${rid} AND appointment_number = 1`);
    expect(v1[0].cancelled_at).not.toBeNull();
    expect(await cv.readVisitEnded(org, rid)).toBe(true);

    const held = await q.getRequestById(org, rid, VISIBLE_ONLY);
    expect(held?.status).toBe("on_hold");
    expect(held?.currentVisit).toMatchObject({ kind: "ended", appointmentNumber: 1, technicianId: techA });

    // Calendar and dispatch: still in Junie's lane on that day, but as ENDED.
    const range = dayRange(day);
    const cal = await q.getSchedulingCalendar(org, range.start, range.end, [day], false, VISIBLE_ONLY);
    const laneA = cal.lanes.find((l) => l.technicianId === techA)!;
    expect(laneA.jobs.filter((j) => j.id === rid).map((j) => j.visitEnded)).toEqual([true]);
    const board = await q.getDispatchBoard(org, day, VISIBLE_ONLY);
    expect(board.columns.find((c) => c.technicianId === techA)!.jobs.find((j) => j.id === rid)?.visitEnded).toBe(true);

    // The phone: Junie has no live row on this request any more.
    expect(await own.findTechAssignments(org, techA, rid)).toEqual([]);

    // Schedule the next visit with Odessa, the morning after.
    const nextDay = dayPlus(4);
    const w = time.arrivalWindowUtcForBusinessDate(nextDay, "morning");
    const added = await appts.addAppointment(org, rid, {
      arrivalWindowStart: w.start.toISOString(), arrivalWindowEnd: w.end.toISOString(), technicianIds: [techB],
    }, techA);
    expect(added).toMatchObject({ appointmentNumber: 2, resumed: true });

    const back = await run(sql`SELECT status, hold_reason FROM service_requests WHERE id = ${rid}`);
    expect(back[0]).toEqual({ status: "scheduled", hold_reason: null });
    expect(await cv.readVisitEnded(org, rid)).toBe(false);

    // Office: visit #2, Odessa, its own window.
    const after = await q.getRequestById(org, rid, VISIBLE_ONLY);
    expect(after?.currentVisit).toMatchObject({
      kind: "visit", appointmentNumber: 2, technicianId: techB, technicianName: "Probe Odessa",
      arrivalWindowStart: w.start.toISOString(), arrivalWindowEnd: w.end.toISOString(),
    });
    // Phone: the active visit is the same one, led by Odessa.
    const active = await own.findActiveVisit(org, rid);
    expect(active).toEqual({ appointmentId: (after!.currentVisit as { appointmentId: string }).appointmentId, leadTechnicianId: techB });
    expect((await own.findTechAssignments(org, techB, rid)).map((r) => r.appointmentNumber)).toEqual([2]);

    // Calendar: Odessa's lane on the new day; nothing left in Junie's lane on the old day.
    const r2 = dayRange(nextDay);
    const cal2 = await q.getSchedulingCalendar(org, r2.start, r2.end, [nextDay], false, VISIBLE_ONLY);
    expect(cal2.lanes.find((l) => l.technicianId === techB)!.jobs.filter((j) => j.id === rid).map((j) => j.visitNumber)).toEqual([2]);
    const calOld = await q.getSchedulingCalendar(org, range.start, range.end, [day], false, VISIBLE_ONLY);
    expect(calOld.lanes.flatMap((l) => l.jobs).concat(calOld.unassigned).some((j) => j.id === rid)).toBe(false);
    // The list's technician column says who goes now.
    const list = await q.getRequests(org, { page: 1, limit: 50 }, VISIBLE_ONLY);
    expect(list.requests.find((r) => r.id === rid)?.assignedToName).toBe("Probe Odessa");
  }, 60_000);

  it("a hold after the technician started (row kept as done, visit not cancelled) is ended too", async () => {
    const rid = await seedRequest(techA, dayPlus(5));
    await run(sql`UPDATE appointment_assignments a SET en_route_at = now(), status = 'en_route'::request_status
      FROM appointments p WHERE a.appointment_id = p.id AND p.service_request_id = ${rid} AND a.organization_id = ${org} AND a.is_lead`);
    await hold(rid);
    const v1 = await run(sql`SELECT p.cancelled_at, a.status FROM appointments p JOIN appointment_assignments a ON a.appointment_id = p.id WHERE p.service_request_id = ${rid}`);
    expect(v1).toEqual([{ cancelled_at: null, status: "completed" }]);
    expect(await cv.readVisitEnded(org, rid)).toBe(true);
    expect((await q.getRequestById(org, rid, VISIBLE_ONLY))?.currentVisit).toMatchObject({ kind: "ended", technicianId: techA });
  }, 60_000);
});
