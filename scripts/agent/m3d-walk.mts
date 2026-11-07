/**
 * M3d browser-walk fixture (dev only). Creates a THROWAWAY org with
 * createOrgCore and seeds the spec §9 walk data by SQL; prints JSON with the
 * ids and minted session tokens (each token's org asserted). Never touches the
 * default org; refuses prod; refuses to seed while the comms queue holds a
 * due message. `delete <orgId>` asserts the org queued nothing, then deletes it.
 *
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/agent/m3d-walk.mts seed
 *   NODE_OPTIONS=--conditions=react-server npx tsx scripts/agent/m3d-walk.mts delete <orgId>
 */
import { readFileSync } from "node:fs";
import { randomUUID } from "node:crypto";

for (const line of readFileSync(".env.local", "utf8").split("\n")) {
  const m = line.match(/^([A-Z_0-9]+)=(.*)$/);
  if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.replace(/^"|"$/g, "");
}
if ((process.env.DATABASE_URL ?? "").includes("ep-withered-hill")) throw new Error("Refusing to run against the production database");

const DEFAULT_ORG = "00000000-0000-0000-0000-000000000001";
const { db } = await import("../../src/lib/db");
const { sql } = await import("drizzle-orm");
const { encrypt } = await import("../../src/lib/crypto");
const { signToken } = await import("../../src/lib/auth/config");
const { signTechToken } = await import("../../src/lib/auth/tech-config");
const { createOrgCore } = await import("../../src/lib/admin/provisioning");

type Row = Record<string, unknown>;
const run = async (q: ReturnType<typeof sql>): Promise<Row[]> => (await db.execute(q)).rows as Row[];
const one = async (q: ReturnType<typeof sql>): Promise<string> => String((await run(q))[0]!.id);

async function queueGuard(): Promise<void> {
  const [r] = await run(sql`SELECT count(*)::int AS n FROM communication_jobs WHERE status = 'pending' AND scheduled_for <= now() + interval '15 minutes'`);
  if (Number(r!.n) !== 0) throw new Error(`comms queue holds ${String(r!.n)} due message(s); not walking`);
}

async function seed(): Promise<void> {
  await queueGuard();
  const out = await createOrgCore({
    name: `Probe Org M3d Walk ${randomUUID().slice(0, 8)}`,
    createdBy: null,
    ownerEmail: null,
    ownerUser: { email: `owner-${randomUUID()}@throwaway.example`, name: "Probe Owner", googleId: `probe-${randomUUID()}` },
    skipOrgCountCheck: true,
  });
  if (!out.ok) throw new Error(`createOrgCore failed: ${JSON.stringify(out.error)}`);
  const org = out.result.organizationId;
  if (org === DEFAULT_ORG) throw new Error("refusing the default org");
  const admin = out.result.ownerUserId!;
  const tech = (name: string) => one(sql`INSERT INTO users (organization_id,email,name,role,password_hash,is_active)
    VALUES (${org},'tech-'||gen_random_uuid()||'@throwaway.example',${name},'technician','x',true) RETURNING id`);
  const lead = await tech("Alex Rivera");
  const helper = await tech("Sam Lee");
  const jobType = String((await run(sql`SELECT id FROM job_types WHERE organization_id = ${org} ORDER BY position LIMIT 1`))[0]!.id);

  const ADDR_A = "12 Elm St, Johnson City, TN 37601";
  const custA = await one(sql`INSERT INTO customers (organization_id,name_encrypted) VALUES (${org},${encrypt("Pat Probe")}) RETURNING id`);
  const custB = await one(sql`INSERT INTO customers (organization_id,name_encrypted) VALUES (${org},${encrypt("Robin Other")}) RETURNING id`);
  const loc = await one(sql`INSERT INTO customer_locations (organization_id,customer_id,address_encrypted,label,is_primary)
    VALUES (${org},${custA},${encrypt(ADDR_A)},'Main house',true) RETURNING id`);
  const request = async (o: { cust: string; status: string; address: string | null; locationId: string | null; jobTypeId?: string | null; fieldpulse?: boolean; daysAgo?: number }) => {
    const sess = await one(sql`INSERT INTO customer_sessions (organization_id,token) VALUES (${org},gen_random_uuid()::text) RETURNING id`);
    const when = new Date(Date.now() - (o.daysAgo ?? 0) * 86_400_000).toISOString();
    return one(sql`INSERT INTO service_requests (organization_id,session_id,assigned_to,customer_id,location_id,job_type_id,issue_type,urgency,description,reference_number,scheduled_date,status,completed_at,address_encrypted,fieldpulse_job_id)
      VALUES (${org},${sess},${lead},${o.cust},${o.locationId},${o.jobTypeId ?? null},'no_heat','medium','Walk probe','WLK-'||substr(md5(random()::text),1,8),${when}::timestamptz,
        ${o.status}::request_status,${o.status === "completed" ? when : null}::timestamptz,${o.address ? encrypt(o.address) : null},${o.fieldpulse ? `fp-walk-${randomUUID().slice(0, 8)}` : null})
      RETURNING id`);
  };
  const past1 = await request({ cust: custA, status: "completed", address: ADDR_A, locationId: loc, daysAgo: 40 });
  const past2 = await request({ cust: custA, status: "completed", address: ADDR_A, locationId: loc, daysAgo: 10 });
  const est = await one(sql`INSERT INTO estimates (organization_id,service_request_id,customer_id,status,total_cents,expires_at)
    VALUES (${org},${past2},${custA},'open',481200,now() + interval '20 days') RETURNING id`);
  await run(sql`INSERT INTO estimate_options (organization_id,estimate_id,name,sort_order,subtotal_cents,tax_cents,total_cents)
    VALUES (${org},${est},'Good',0,295000,0,295000),(${org},${est},'Better',1,481200,0,481200)`);
  const plan = await one(sql`INSERT INTO membership_plans (organization_id,name,price_cents,visits_per_year) VALUES (${org},'Comfort Club',1500,2) RETURNING id`);
  const mem = await one(sql`INSERT INTO customer_memberships (organization_id,customer_id,plan_id,status,current_period_end)
    VALUES (${org},${custA},${plan},'active',now() + interval '150 days') RETURNING id`);
  await run(sql`INSERT INTO membership_visits (organization_id,customer_membership_id,due_date,period_key,status)
    VALUES (${org},${mem},now() + interval '60 days','walk-1','scheduled')`);
  const job = await request({ cust: custA, status: "in_progress", address: ADDR_A, locationId: loc, jobTypeId: jobType });
  const visit = String((await run(sql`SELECT id FROM appointments WHERE service_request_id = ${job} AND appointment_number = 1`))[0]!.id);
  await run(sql`UPDATE appointment_assignments SET status = 'in_progress'::request_status, en_route_at = now(), arrived_at = now(), started_at = now()
    WHERE appointment_id = ${visit} AND technician_id = ${lead} AND organization_id = ${org}`);
  await run(sql`INSERT INTO appointment_assignments (organization_id,appointment_id,technician_id,is_lead,status,arrived_at,started_at)
    VALUES (${org},${visit},${helper},false,'in_progress'::request_status,now(),now())`);
  const otherJob = await request({ cust: custB, status: "completed", address: "40 Oak Ave, Bristol, TN 37620", locationId: null, daysAgo: 5 });
  // Customer B's: an address-less sibling of A's would make A's membership `withheld` (spec §7.6).
  const synced = await request({ cust: custB, status: "scheduled", address: null, locationId: null, fieldpulse: true });

  const users = await run(sql`SELECT id, email, name, role, organization_id FROM users WHERE id IN (${admin}, ${lead}, ${helper})`);
  const user = (id: string) => users.find((u) => u.id === id)!;
  const tokens = {
    admin: await signToken({ userId: admin, email: String(user(admin).email), name: String(user(admin).name), role: user(admin).role as "super_admin", organizationId: org }),
    lead: await signTechToken({ userId: lead, email: String(user(lead).email), name: "Alex Rivera", role: "technician", organizationId: org }),
    helper: await signTechToken({ userId: helper, email: String(user(helper).email), name: "Sam Lee", role: "technician", organizationId: org }),
  };
  for (const u of users) if (u.organization_id !== org) throw new Error("token org mismatch");
  console.log(JSON.stringify({ org, admin, lead, helper, jobType, custA, custB, loc, past1, past2, job, visit, otherJob, synced, tokens }));
}

async function remove(org: string): Promise<void> {
  if (org === DEFAULT_ORG) throw new Error("refusing the default org");
  const [q] = await run(sql`SELECT count(*)::int AS n FROM communication_jobs WHERE organization_id = ${org}`);
  if (Number(q!.n) !== 0) throw new Error(`the walk queued ${String(q!.n)} communication job(s)`);
  await run(sql`DELETE FROM organizations WHERE id = ${org} AND name LIKE 'Probe Org M3d Walk %'`);
  console.log(JSON.stringify({ deleted: org }));
}

const [cmd, arg] = process.argv.slice(2);
if (cmd === "seed") await seed();
else if (cmd === "delete" && arg) await remove(arg);
else throw new Error("usage: m3d-walk.mts seed | delete <orgId>");
process.exit(0);
