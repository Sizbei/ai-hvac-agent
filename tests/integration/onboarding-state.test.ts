import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/**
 * Integration suite for the setup guide's stamps and flags. Runs against the
 * DEV database (`VITEST_INTEGRATION=1`); the two concurrency pairs are smoke
 * tests driven with the SQL builders directly. Creates five throwaway orgs and
 * deletes each one (cascade) in afterAll, independently.
 */

type Q = typeof import("@/lib/admin/onboarding-queries");
type S = typeof import("@/lib/admin/onboarding-sql");
type Db = typeof import("@/lib/db");
type Row = Record<string, unknown>;
type StateJson = {
  firstSeenAt?: string;
  dismissedAt?: string;
  completedSeenAt?: string;
  firstCompleted: Record<string, string>;
  flags: { embedCopied?: boolean; techSignedInAt?: string };
};

const OPTS = { demo: false, write: true, googleEnabled: false, appUrl: "http://x" };
const REQUIRED = ["phone_hours", "add_technician", "book_first_request", "tech_sign_in"];

let q: Q;
let s: S;
let db: Db["db"];
let sql: typeof import("drizzle-orm").sql;
let orgA = "";
let orgG = "";
let orgA2 = "";
let orgB = "";
let orgH = "";

async function run(statement: ReturnType<typeof sql>): Promise<Row[]> {
  const res = await db.execute(statement);
  return res.rows as Row[];
}

async function stateText(org: string): Promise<string | null> {
  const rows = await run(
    sql`SELECT onboarding_state::text AS t FROM organization_settings WHERE organization_id = ${org}`,
  );
  return (rows[0]?.t as string | undefined) ?? null;
}

async function stateObj(org: string): Promise<StateJson> {
  const t = await stateText(org);
  return t ? JSON.parse(t) : { firstCompleted: {}, flags: {} };
}

async function setPhoneHours(org: string) {
  await db.execute(
    sql`UPDATE organization_settings SET business_info = COALESCE(business_info,'{}'::jsonb) || '{"phone":"(423) 555-0100","businessHours":"Mon–Fri 8–5"}'::jsonb WHERE organization_id = ${org}`,
  );
}

async function seedRest(org: string, status = "pending") {
  const tech = (await run(
    sql`INSERT INTO users (organization_id,email,name,role,password_hash,is_active) VALUES (${org},'tech-'||gen_random_uuid()||'@throwaway.example','Probe Technician','technician','x',true) RETURNING id`,
  ))[0].id;
  const sess = (await run(
    sql`INSERT INTO customer_sessions (organization_id,token) VALUES (${org},gen_random_uuid()::text) RETURNING id`,
  ))[0].id;
  const req = (await run(
    sql`INSERT INTO service_requests (organization_id,session_id,assigned_to,issue_type,urgency,description,reference_number,scheduled_date,status) VALUES (${org},${sess},${tech},'no_heat','medium','Probe request','PRB-'||substr(md5(random()::text),1,8),now()+interval '1 day',${status}::request_status) RETURNING id`,
  ))[0].id;
  return { tech, sess, req };
}

/** Every source table the SELECT reads, "done", plus stamps and flags. */
async function seedEverything(org: string) {
  await setPhoneHours(org);
  await db.execute(
    sql`UPDATE organization_settings SET logo_url = 'https://example.com/logo.png' WHERE organization_id = ${org}`,
  );
  await q.getOnboarding(org, OPTS);
  const { tech, req } = await seedRest(org);
  await db.execute(
    sql`INSERT INTO technician_time_entries (organization_id,technician_id,service_request_id) VALUES (${org},${tech},${req})`,
  );
  await db.execute(
    sql`INSERT INTO pricebook_items (organization_id,type,name,price_cents,active) VALUES (${org},'service','Probe tune-up',9900,true)`,
  );
  await db.execute(
    sql`INSERT INTO widget_keys (organization_id,key_hash,key_prefix,key_type,is_active) VALUES (${org},md5(random()::text)||md5(random()::text),'pk_probe','publishable',true)`,
  );
  await db.execute(
    sql`INSERT INTO google_calendar_connections (organization_id,connected) VALUES (${org},true)`,
  );
  await q.getOnboarding(org, OPTS);
  await db.execute(
    s.flagsStatementSql({ organizationId: org, flags: { embedCopied: true, techSignedInAt: new Date().toISOString() }, top: {} }),
  );
}

async function seedDone(org: string) {
  await setPhoneHours(org);
  await q.getOnboarding(org, OPTS);
  const { tech, req } = await seedRest(org);
  await db.execute(
    sql`INSERT INTO technician_time_entries (organization_id,technician_id,service_request_id) VALUES (${org},${tech},${req})`,
  );
}

beforeAll(async () => {
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const m = line.match(/^([A-Z_0-9]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
  }
  const url = process.env.DATABASE_URL ?? "";
  if (!url) throw new Error("DATABASE_URL missing from .env.local");
  if (url.includes("ep-withered-hill")) {
    throw new Error("Refusing to run against the production database");
  }
  ({ sql } = await import("drizzle-orm"));
  ({ db } = await import("@/lib/db"));
  q = await import("@/lib/admin/onboarding-queries");
  s = await import("@/lib/admin/onboarding-sql");
  const { createOrgCore } = await import("@/lib/admin/provisioning");

  const make = async (label: string) => {
    const id8 = randomUUID().slice(0, 8);
    const out = await createOrgCore({
      name: `Probe Org ${label} ${id8}`,
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
    return out.result.organizationId as string;
  };
  orgA = await make("A");
  orgG = await make("G");
  orgA2 = await make("A2");
  orgB = await make("B");
  orgH = await make("H");
}, 60_000);

afterAll(async () => {
  // One try/catch per org: a failed delete can never leak the others.
  for (const id of [orgA, orgG, orgA2, orgB, orgH]) {
    if (!id) continue;
    try {
      await db.execute(sql`DELETE FROM organizations WHERE id = ${id}`);
    } catch (error) {
      console.error(`afterAll: could not delete probe org ${id}`, error);
    }
  }
}, 60_000);

describe("onboarding state (dev DB)", () => {
  it("a fresh org is 0 of 4, up next phone_hours, with no stamps written", async () => {
    const p = await q.getOnboarding(orgA, OPTS);
    expect(p.progress.requiredDone).toBe(0);
    expect(p.upNext).toBe("phone_hours");
    const st = await stateObj(orgA);
    expect(st.firstCompleted ?? {}).toEqual({});
    expect(st.dismissedAt).toBeUndefined();
    expect(st.completedSeenAt).toBeUndefined();
    // the first GET writes the write-once firstSeenAt; a second GET keeps it
    expect(st.firstSeenAt).toBeDefined();
    await new Promise((r) => setTimeout(r, 20));
    await q.getOnboarding(orgA, OPTS);
    expect((await stateObj(orgA)).firstSeenAt).toBe(st.firstSeenAt);
  });

  it("(e) row-less: both statements create the settings row", async () => {
    await db.execute(sql`DELETE FROM organization_settings WHERE organization_id = ${orgA}`);
    await db.execute(
      s.stampStatementSql({ organizationId: orgA, newStamps: { brand: "2026-01-01T00:00:00.000Z" }, top: {} }),
    );
    expect((await stateObj(orgA)).firstCompleted.brand).toBeDefined();
    await db.execute(sql`DELETE FROM organization_settings WHERE organization_id = ${orgA}`);
    await db.execute(
      s.flagsStatementSql({ organizationId: orgA, flags: { embedCopied: true }, top: {} }),
    );
    expect((await stateObj(orgA)).flags.embedCopied).toBe(true);
    // restore a default row for the following cases
    await db.execute(sql`DELETE FROM organization_settings WHERE organization_id = ${orgA}`);
    await db.execute(
      sql`INSERT INTO organization_settings (organization_id, company_name) VALUES (${orgA}, 'Probe Org A')`,
    );
  });

  it("(b) finished rows applied in order: 4 of 4 with stamps, completedSeenAt unset", async () => {
    await seedDone(orgA);
    const p = await q.getOnboarding(orgA, OPTS);
    expect(p.progress.requiredDone).toBe(4);
    const st = await stateObj(orgA);
    for (const id of REQUIRED) expect(st.firstCompleted[id]).toBeDefined();
    expect(st.completedSeenAt).toBeUndefined();
  });

  it("(c) smoke: concurrent stamp statements keep both keys", async () => {
    const iso = new Date().toISOString();
    await Promise.all([
      db.execute(s.stampStatementSql({ organizationId: orgA, newStamps: { brand: iso }, top: {} })),
      db.execute(s.stampStatementSql({ organizationId: orgA, newStamps: { pricebook: iso }, top: {} })),
    ]);
    const st = await stateObj(orgA);
    expect(st.firstCompleted.brand).toBeDefined();
    expect(st.firstCompleted.pricebook).toBeDefined();
  });

  it("(d) smoke: concurrent flag statements keep both flags", async () => {
    const iso = new Date().toISOString();
    await Promise.all([
      db.execute(s.flagsStatementSql({ organizationId: orgA, flags: { embedCopied: true }, top: {} })),
      db.execute(
        s.flagsStatementSql({ organizationId: orgA, flags: { techSignedInAt: iso }, top: {}, guardTechSignedIn: true }),
      ),
    ]);
    const st = await stateObj(orgA);
    expect(st.flags.embedCopied).toBe(true);
    expect(st.flags.techSignedInAt).toBeDefined();
  });

  it("(f) repeated dismissed keeps the first timestamp", async () => {
    await q.patchOnboarding(orgA, { dismissed: true }, { demo: false });
    const first = (await stateObj(orgA)).dismissedAt;
    expect(first).toBeDefined();
    await new Promise((r) => setTimeout(r, 20));
    await q.patchOnboarding(orgA, { dismissed: true }, { demo: false });
    expect((await stateObj(orgA)).dismissedAt).toBe(first);
  });

  it("(g) stamp-less old org with only a completed request: top-only grandfather write", async () => {
    await db.execute(
      sql`UPDATE organizations SET created_at = now() - interval '20 days' WHERE id = ${orgG}`,
    );
    const sess = (await run(
      sql`INSERT INTO customer_sessions (organization_id,token) VALUES (${orgG},gen_random_uuid()::text) RETURNING id`,
    ))[0].id;
    await db.execute(
      sql`INSERT INTO service_requests (organization_id,session_id,issue_type,urgency,description,reference_number,status) VALUES (${orgG},${sess},'no_heat','medium','Probe request','PRB-'||substr(md5(random()::text),1,8),'completed'::request_status)`,
    );
    const before = await stateObj(orgG);
    expect(before.dismissedAt).toBeUndefined();
    expect(before.firstSeenAt).toBeUndefined();
    expect(before.firstCompleted ?? {}).toEqual({});

    const p = await q.getOnboarding(orgG, OPTS);
    expect(p.progress.requiredDone).toBe(0);
    expect(p.dismissedAt).not.toBeNull();
    const st = await stateObj(orgG);
    expect(st.dismissedAt).toBe(p.dismissedAt);
    expect(st.firstSeenAt).toBeDefined();
    expect(st.firstCompleted).toEqual({});
    expect(st.completedSeenAt).toBeUndefined();
  });

  it("(h) tenancy: a fresh org A2 reads 0/0 and its GET and PATCH leave org B byte-identical", async () => {
    await seedEverything(orgB);
    const pb = await q.getOnboarding(orgB, OPTS);
    expect(pb.progress).toMatchObject({ requiredDone: 4, optionalDone: 4 });
    const seeded = await stateObj(orgB);
    expect(Object.keys(seeded.firstCompleted).sort()).toEqual(
      ["add_technician", "book_first_request", "brand", "chat_widget", "integrations", "phone_hours", "pricebook", "tech_sign_in"],
    );
    expect(seeded.flags.embedCopied).toBe(true);
    expect(seeded.flags.techSignedInAt).toBeDefined();
    const before = await stateText(orgB);
    expect(before).toBeTruthy();

    const p = await q.getOnboarding(orgA2, OPTS);
    expect(p.progress.requiredDone).toBe(0);
    expect(p.progress.optionalDone).toBe(0);
    await q.patchOnboarding(orgA2, { dismissed: true, completedSeen: true, flags: { embedCopied: true } }, { demo: false });
    expect((await stateObj(orgA2)).dismissedAt).toBeDefined();

    expect(await stateText(orgB)).toBe(before);
  });

  it("(i) hidden history alone: no request signals, book_first_request open, no grandfather dismissal", async () => {
    // An old org whose only request is completed, booked with a technician and
    // hidden (go-live marking). Ruling 2: signals count visible rows only.
    await db.execute(
      sql`UPDATE organizations SET created_at = now() - interval '20 days' WHERE id = ${orgH}`,
    );
    const { req } = await seedRest(orgH, "completed");
    // Marking-style: hide by UPDATE after the insert (the visit trigger has run).
    await db.execute(
      sql`UPDATE service_requests SET hidden_from_org = true WHERE id = ${req} AND organization_id = ${orgH}`,
    );
    const signals = async () => (await run(s.onboardingSelectSql(orgH)))[0];

    const hidden = await signals();
    expect(hidden).toMatchObject({
      any_request: false,
      booked_assigned: false,
      completed_request: false,
      technician_ready: true,
    });

    const p = await q.getOnboarding(orgH, OPTS);
    expect(p.steps.find((st) => st.id === "book_first_request")?.done).toBe(false);
    expect(p.dismissedAt).toBeNull();
    const st = await stateObj(orgH);
    expect(st.dismissedAt).toBeUndefined();
    expect(st.firstCompleted.book_first_request).toBeUndefined();

    // Control: the same row, visible, sets all three signals.
    await db.execute(
      sql`UPDATE service_requests SET hidden_from_org = false WHERE id = ${req} AND organization_id = ${orgH}`,
    );
    expect(await signals()).toMatchObject({
      any_request: true,
      booked_assigned: true,
      completed_request: true,
    });
  });
});
