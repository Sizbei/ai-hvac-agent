/**
 * M2 walk fixture (dev only). Creates a THROWAWAY org with createOrgCore and
 * seeds the spec §9 data by SQL; prints one JSON line with ids and a minted
 * admin session (its org asserted). Never touches the default org; refuses
 * prod; refuses to seed while the comms queue holds a due message; never sets
 * a FieldPulse connection (the FieldPulse card is a bare fieldpulse_job_id).
 * `delete <orgId>` asserts the org queued nothing, then deletes it.
 *
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/agent/m2-walk.mts seed            # spec §9 walk data
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/agent/m2-walk.mts seed --spike    # task 0: five technicians
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/agent/m2-walk.mts state <orgId> <requestId>
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/agent/m2-walk.mts delete <orgId>
 */
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^([A-Z_0-9]+)=(.*)$/);
  if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.replace(/^"|"$/g, "");
}
if ((process.env.DATABASE_URL ?? "").includes("ep-withered-hill")) throw new Error("Refusing to run against the production database");

const DEFAULT_ORG = "00000000-0000-0000-0000-000000000001";
const ORG_PREFIX = "Probe Org M2 Walk ";
const { db } = await import("../../src/lib/db");
const { sql } = await import("drizzle-orm");
const { encrypt } = await import("../../src/lib/crypto");
const { signToken } = await import("../../src/lib/auth/config");
const { createOrgCore } = await import("../../src/lib/admin/provisioning");
const { businessWallClockToUtc, businessIsoDate, arrivalWindowUtcForBusinessDate } = await import("../../src/lib/admin/calendar-time");

type Row = Record<string, unknown>;
const run = async (q: ReturnType<typeof sql>): Promise<Row[]> => (await db.execute(q)).rows as Row[];
const one = async (q: ReturnType<typeof sql>): Promise<string> => String((await run(q))[0]!.id);

async function queueGuard(): Promise<void> {
  const [r] = await run(sql`SELECT count(*)::int AS n FROM communication_jobs WHERE status = 'pending' AND scheduled_for <= now() + interval '15 minutes'`);
  if (Number(r!.n) !== 0) throw new Error(`comms queue holds ${String(r!.n)} due message(s); not walking`);
}

/**
 * Tomorrow's business day: every window on it is still ahead, whatever the hour of the walk. Never a
 * Saturday: the walks step to the next day in a Sunday-first Week view, which must be the same week.
 */
function tomorrow(): string {
  const d = new Date(`${businessIsoDate(new Date())}T00:00:00.000Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  if (d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
const at = (day: string, h: number, m = 0) => businessWallClockToUtc(day, h, m).toISOString();

async function seed(spike: boolean): Promise<void> {
  await queueGuard();
  const out = await createOrgCore({
    name: `${ORG_PREFIX}${randomUUID().slice(0, 8)}`,
    createdBy: null,
    ownerEmail: null,
    ownerUser: { email: `owner-${randomUUID()}@throwaway.example`, name: "Probe Owner", googleId: `probe-${randomUUID()}` },
    skipOrgCountCheck: true,
  });
  if (!out.ok) throw new Error(`createOrgCore failed: ${JSON.stringify(out.error)}`);
  const org = out.result.organizationId;
  if (org === DEFAULT_ORG) throw new Error("refusing the default org");
  const admin = out.result.ownerUserId!;
  const [conn] = await run(sql`SELECT count(*)::int AS n FROM fieldpulse_connections WHERE organization_id = ${org}`);
  if (Number(conn!.n) !== 0) throw new Error("throwaway org unexpectedly has a FieldPulse connection");

  const tech = async (name: string) => {
    const id = await one(sql`INSERT INTO users (organization_id,email,name,role,password_hash,is_active)
      VALUES (${org},'tech-'||gen_random_uuid()||'@throwaway.example',${name},'technician','x',true) RETURNING id`);
    // Every weekday, all day: no drop in the walk is refused as out of hours.
    await run(sql`INSERT INTO technician_availability (organization_id, technician_id, day_of_week, start_minute, end_minute)
      SELECT ${org}::uuid, ${id}::uuid, d, 0, 1440 FROM generate_series(0, 6) AS d`);
    return id;
  };
  const techs: Record<string, string> = { alex: await tech("Alex Rivera"), sam: await tech("Sam Lee") };
  if (spike) {
    techs.casey = await tech("Casey Park");
    techs.drew = await tech("Drew Moss");
    techs.eli = await tech("Eli Grant");
  }
  const day = tomorrow();

  const request = async (o: { name: string; lead: string | null; start: string | null; end: string | null; status: string; fieldpulse?: boolean }) => {
    const cust = await one(sql`INSERT INTO customers (organization_id,name_encrypted) VALUES (${org},${encrypt(o.name)}) RETURNING id`);
    const sess = await one(sql`INSERT INTO customer_sessions (organization_id,token) VALUES (${org},gen_random_uuid()::text) RETURNING id`);
    return one(sql`INSERT INTO service_requests (organization_id,session_id,assigned_to,customer_id,issue_type,urgency,description,reference_number,
        scheduled_date,arrival_window_start,arrival_window_end,status,fieldpulse_job_id)
      VALUES (${org},${sess},${o.lead},${cust},'no_heat','medium','M2 walk probe','WLK-'||substr(md5(random()::text),1,8),
        ${o.start}::timestamptz,${o.start}::timestamptz,${o.end}::timestamptz,${o.status}::request_status,
        ${o.fieldpulse ? `fp-walk-${randomUUID().slice(0, 8)}` : null})
      RETURNING id`);
  };

  const requests: Record<string, string> = {};
  if (spike) {
    // (a) Alex 9–11 → Sam's afternoon (lane 5, off-screen at 1440).
    requests.a = await request({ name: "Spike Lane Five", lead: techs.alex!, start: at(day, 9), end: at(day, 11), status: "scheduled" });
    // (b) Unscheduled → Eli's morning (lane 4, off-screen).
    requests.b = await request({ name: "Spike Tray Off", lead: null, start: null, end: null, status: "pending" });
    // (c) Casey 1–3 PM: two drops 4 px inside the morning/afternoon edge.
    requests.c = await request({ name: "Spike Band Edge", lead: techs.casey!, start: at(day, 13), end: at(day, 15), status: "scheduled" });
    // (d) Alex 5–7 PM → right half of Casey's lane (the second technician lane), evening band.
    requests.d = await request({ name: "Spike Near Lane", lead: techs.alex!, start: at(day, 17), end: at(day, 19), status: "scheduled" });
    // (e) Unscheduled → the Unassigned lane's morning band.
    requests.e = await request({ name: "Spike Tray Home", lead: null, start: null, end: null, status: "pending" });
  } else {
    // Spec §9 walk: a 9–11 request on Alex; Alex en route on a morning (8 AM–12 PM) request;
    // an afternoon request on Alex; Sam off 4 PM–8 PM; a FieldPulse card set by SQL.
    requests.nineEleven = await request({ name: "Pat Nine", lead: techs.alex!, start: at(day, 9), end: at(day, 11), status: "scheduled" });
    requests.enRoute = await request({ name: "Robin Route", lead: techs.alex!, start: at(day, 8), end: at(day, 12), status: "scheduled" });
    await run(sql`UPDATE appointment_assignments a SET status = 'en_route'::request_status, en_route_at = now()
      FROM appointments p WHERE a.appointment_id = p.id AND p.service_request_id = ${requests.enRoute} AND p.appointment_number = 1
        AND p.organization_id = ${org} AND a.organization_id = ${org} AND a.technician_id = ${techs.alex} AND a.is_lead`);
    await run(sql`UPDATE service_requests SET status = 'en_route'::request_status WHERE id = ${requests.enRoute} AND organization_id = ${org}`);
    requests.afternoon = await request({ name: "Lee Afternoon", lead: techs.alex!, start: at(day, 12), end: at(day, 16), status: "scheduled" });
    requests.fieldpulse = await request({ name: "Fran Pulse", lead: techs.alex!, start: at(day, 13), end: at(day, 15), status: "scheduled", fieldpulse: true });
    requests.unscheduled = await request({ name: "Una Placed", lead: null, start: null, end: null, status: "pending" });
    await run(sql`INSERT INTO technician_shifts (organization_id, technician_id, kind, title, starts_at, ends_at, removes_capacity)
      VALUES (${org}, ${techs.sam}, 'time_off', NULL, ${at(day, 16)}::timestamptz, ${at(day, 20)}::timestamptz, true)`);
  }

  const [u] = await run(sql`SELECT id, email, name, role, organization_id FROM users WHERE id = ${admin}`);
  if (u!.organization_id !== org) throw new Error("token org mismatch");
  const tokens = {
    admin: await signToken({ userId: admin, email: String(u!.email), name: String(u!.name), role: u!.role as "super_admin", organizationId: org }),
  };
  const band = (w: "morning" | "afternoon" | "evening") => {
    const b = arrivalWindowUtcForBusinessDate(day, w);
    return { start: b.start.toISOString(), end: b.end.toISOString() };
  };
  const bands = { morning: band("morning"), afternoon: band("afternoon"), evening: band("evening") };
  console.log(JSON.stringify({ org, admin, techs, day, bands, requests, tokens }));
}

async function state(org: string, rid: string): Promise<void> {
  const [r] = await run(sql`SELECT assigned_to, arrival_window_start, arrival_window_end, status FROM service_requests WHERE id = ${rid} AND organization_id = ${org}`);
  if (!r) throw new Error("no such request in that org");
  const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);
  console.log(JSON.stringify({ assignedTo: r.assigned_to ?? null, start: iso(r.arrival_window_start), end: iso(r.arrival_window_end), status: r.status }));
}

async function remove(org: string): Promise<void> {
  if (org === DEFAULT_ORG) throw new Error("refusing the default org");
  const [q] = await run(sql`SELECT count(*)::int AS n FROM communication_jobs WHERE organization_id = ${org}`);
  if (Number(q!.n) !== 0) throw new Error(`the walk queued ${String(q!.n)} communication job(s)`);
  const deleted = await run(sql`DELETE FROM organizations WHERE id = ${org} AND name LIKE ${`${ORG_PREFIX}%`} RETURNING id`);
  if (deleted.length !== 1) throw new Error(`no walk org ${org} was deleted`);
  console.log(JSON.stringify({ deleted: org }));
}

const [cmd, arg, arg2] = process.argv.slice(2);
if (cmd === "seed") await seed(arg === "--spike");
else if (cmd === "state" && arg && arg2) await state(arg, arg2);
else if (cmd === "delete" && arg) await remove(arg);
else throw new Error("usage: m2-walk.mts seed [--spike] | state <orgId> <requestId> | delete <orgId>");
process.exit(0);
