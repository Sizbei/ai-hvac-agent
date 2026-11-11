import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/**
 * Integration suite for the go-live marking builders and script against the
 * DEV database (`VITEST_INTEGRATION=1`). One throwaway org (timezone
 * America/Chicago) holds every fixture; each case starts from an unhide so the
 * cases are order-independent. The org is deleted in afterAll.
 */

type Db = typeof import("@/lib/db");
type M = typeof import("@/lib/admin/golive-marking-sql");
type Row = Record<string, unknown>;
type Table = "customers" | "customer_sessions" | "service_requests" | "invoices" | "estimates";

const SCRIPT = "scripts/agent/golive-hide-history.mjs";
const TZ = "America/Chicago";

let db: Db["db"];
let sql: typeof import("drizzle-orm").sql;
let m: M;
let org = "";

/** Fixture ids, filled in beforeAll. */
const f: Record<string, string> = {};

async function run(statement: ReturnType<typeof sql>): Promise<Row[]> {
  return (await db.execute(statement)).rows as Row[];
}

async function one(statement: ReturnType<typeof sql>): Promise<string> {
  return (await run(statement))[0]!.id as string;
}

async function batch(statements: ReturnType<typeof sql>[]): Promise<number[]> {
  const results = (await db.batch(statements.map((s) => db.execute(s)) as never)) as unknown as { rowCount: number | null }[];
  return results.map((r) => r.rowCount ?? 0);
}

async function apply(mode: "history" | "empty"): Promise<number[]> {
  await batch(m.unhideStatements(org));
  return batch(m.markStatements(org, mode));
}

async function hidden(table: Table, id: string): Promise<boolean> {
  const rows = await run(sql`SELECT hidden_from_org AS h FROM ${sql.identifier(table)} WHERE id = ${id}`);
  return rows[0]!.h as boolean;
}

async function expectHidden(expected: boolean, pairs: [Table, string][]) {
  for (const [table, key] of pairs) {
    expect(await hidden(table, f[key]!), `${table} ${key}`).toBe(expected);
  }
}

async function hiddenTotal(): Promise<number> {
  const rows = await run(
    sql`SELECT (SELECT count(*) FROM customers WHERE organization_id = ${org} AND hidden_from_org)
             + (SELECT count(*) FROM customer_sessions WHERE organization_id = ${org} AND hidden_from_org)
             + (SELECT count(*) FROM service_requests WHERE organization_id = ${org} AND hidden_from_org)
             + (SELECT count(*) FROM invoices WHERE organization_id = ${org} AND hidden_from_org)
             + (SELECT count(*) FROM estimates WHERE organization_id = ${org} AND hidden_from_org) AS n`,
  );
  return Number(rows[0]!.n);
}

function customer() {
  return one(sql`INSERT INTO customers (organization_id,name_encrypted) VALUES (${org},'probe') RETURNING id`);
}

function session(customerId: string | null, status = "submitted") {
  return one(
    sql`INSERT INTO customer_sessions (organization_id,token,customer_id,status) VALUES (${org},gen_random_uuid()::text,${customerId},${status}::session_status) RETURNING id`,
  );
}

/** scheduledDate is SQL so the visit-sync trigger mirrors it into visit #1. refPrefix "HVAC-DEMO"/"HVAC-CAP" makes a seeded row. */
function request(sessionId: string, customerId: string | null, status: string, scheduledDate = sql`NULL`, refPrefix = "PRB-") {
  return one(
    sql`INSERT INTO service_requests (organization_id,session_id,customer_id,issue_type,urgency,description,reference_number,status,scheduled_date)
        VALUES (${org},${sessionId},${customerId},'no_heat','medium','Probe request',${refPrefix}||substr(md5(random()::text),1,8),${status}::request_status,${scheduledDate}) RETURNING id`,
  );
}

function backdate(table: Table, id: string, days: number) {
  const ago = sql`now() - make_interval(days => ${days}::int)`;
  return db.execute(sql`UPDATE ${sql.identifier(table)} SET created_at = ${ago}, updated_at = ${ago} WHERE id = ${id}`);
}

/** Visible rows whose parent (session, customer, request) is hidden. Must be 0 after any apply. */
async function danglingLinks(orgId: string): Promise<Row> {
  return (await run(sql`SELECT
    (SELECT count(*) FROM service_requests x JOIN customer_sessions p ON p.id = x.session_id WHERE x.organization_id = ${orgId} AND NOT x.hidden_from_org AND p.hidden_from_org)::int AS request_session,
    (SELECT count(*) FROM service_requests x JOIN customers p ON p.id = x.customer_id WHERE x.organization_id = ${orgId} AND NOT x.hidden_from_org AND p.hidden_from_org)::int AS request_customer,
    (SELECT count(*) FROM customer_sessions x JOIN customers p ON p.id = x.customer_id WHERE x.organization_id = ${orgId} AND NOT x.hidden_from_org AND p.hidden_from_org)::int AS session_customer,
    (SELECT count(*) FROM invoices x JOIN service_requests p ON p.id = x.service_request_id WHERE x.organization_id = ${orgId} AND NOT x.hidden_from_org AND p.hidden_from_org)::int AS invoice_request,
    (SELECT count(*) FROM invoices x JOIN customers p ON p.id = x.customer_id WHERE x.organization_id = ${orgId} AND NOT x.hidden_from_org AND p.hidden_from_org)::int AS invoice_customer,
    (SELECT count(*) FROM estimates x JOIN service_requests p ON p.id = x.service_request_id WHERE x.organization_id = ${orgId} AND NOT x.hidden_from_org AND p.hidden_from_org)::int AS estimate_request,
    (SELECT count(*) FROM estimates x JOIN customers p ON p.id = x.customer_id WHERE x.organization_id = ${orgId} AND NOT x.hidden_from_org AND p.hidden_from_org)::int AS estimate_customer`))[0]!;
}

const NO_DANGLING = {
  request_session: 0, request_customer: 0, session_customer: 0,
  invoice_request: 0, invoice_customer: 0, estimate_request: 0, estimate_customer: 0,
};

function appointment(requestId: string, startsAt: ReturnType<typeof sql>, cancelled: boolean) {
  return one(
    sql`INSERT INTO appointments (organization_id,service_request_id,appointment_number,starts_at,cancelled_at)
        VALUES (${org},${requestId},1,${startsAt},${cancelled ? sql`now()` : sql`NULL`}) RETURNING id`,
  );
}

function invoice(requestId: string | null, customerId: string | null, state: string, fieldpulseId: string | null = null) {
  return one(
    sql`INSERT INTO invoices (organization_id,service_request_id,customer_id,state,total_cents,fieldpulse_invoice_id)
        VALUES (${org},${requestId},${customerId},${state}::invoice_state,12500,${fieldpulseId}) RETURNING id`,
  );
}

function estimate(requestId: string | null, customerId: string | null, status: string) {
  return one(
    sql`INSERT INTO estimates (organization_id,service_request_id,customer_id,status,total_cents)
        VALUES (${org},${requestId},${customerId},${status}::estimate_status,9900) RETURNING id`,
  );
}

/** A customer, its submitted session and a request in `status`. */
async function chain(key: string, status: string, scheduledDate = sql`NULL`) {
  f[`${key}C`] = await customer();
  f[`${key}S`] = await session(f[`${key}C`]!);
  f[`${key}R`] = await request(f[`${key}S`]!, f[`${key}C`]!, status, scheduledDate);
}

async function seed() {
  // kept by history
  await chain("open", "pending");
  await chain("upcoming", "completed", sql`now() + interval '2 days'`);
  await chain("ar", "completed", sql`now() - interval '90 days'`);
  f.arI = await invoice(f.arR!, f.arC!, "open");
  f.draftC = await customer();
  f.draftI = await invoice(null, f.draftC, "draft");
  await chain("est", "completed");
  f.estE = await estimate(f.estR!, f.estC!, "open");
  f.chatC = await customer();
  f.chatS = await session(f.chatC, "chatting");
  // hidden by history
  await chain("done", "completed", sql`now() - interval '30 days'`);
  f.paidC = await customer();
  f.paidI = await invoice(null, f.paidC, "paid");
  f.fpDraftC = await customer();
  f.fpDraftI = await invoice(null, f.fpDraftC, "draft", `fp-${randomUUID()}`);
  f.soldC = await customer();
  f.soldE = await estimate(null, f.soldC, "sold");
  f.orphanS = await session(null, "abandoned");
  // a cancelled future appointment
  await chain("cancelledVisit", "completed");
  await appointment(f.cancelledVisitR!, sql`now() + interval '3 days'`, true);
  // an old open request that was never scheduled
  await chain("stale", "pending");
  await db.execute(sql`UPDATE service_requests SET created_at = now() - interval '90 days' WHERE id = ${f.staleR}`);
  // a cancelled request still carrying a future scheduled_date
  await chain("cancelledReq", "cancelled", sql`now() + interval '3 days'`);
  // P8 B3: a resumable chat idle for 20 days
  f.oldChatC = await customer();
  f.oldChatS = await session(f.oldChatC, "chatting");
  await backdate("customer_sessions", f.oldChatS, 20);
  // P8 M5: an open estimate untouched for 120 days, on a completed request
  await chain("oldEst", "completed");
  f.oldEstE = await estimate(f.oldEstR!, f.oldEstC!, "open");
  await backdate("estimates", f.oldEstE, 120);
  // P8 M6: old open requests kept by an open invoice / a recent open estimate
  await chain("staleInv", "pending");
  await backdate("service_requests", f.staleInvR!, 90);
  f.staleInvI = await invoice(f.staleInvR!, f.staleInvC!, "open");
  await chain("staleEst", "pending");
  await backdate("service_requests", f.staleEstR!, 90);
  f.staleEstE = await estimate(f.staleEstR!, f.staleEstC!, "open");
  // P8 B1: seeded rows. A DEMO request with a visit and a fresh chatting session,
  // a CAP request with an open invoice, and a customer who also has real work.
  f.seedDemoC = await customer();
  f.seedDemoS = await session(f.seedDemoC, "chatting");
  f.seedDemoR = await request(f.seedDemoS, f.seedDemoC, "pending", sql`now() + interval '2 days'`, "HVAC-DEMO");
  f.seedCapC = await customer();
  f.seedCapS = await session(f.seedCapC);
  f.seedCapR = await request(f.seedCapS, f.seedCapC, "pending", sql`NULL`, "HVAC-CAP");
  f.seedCapI = await invoice(f.seedCapR, f.seedCapC, "open");
  f.seedCapE = await estimate(f.seedCapR, f.seedCapC, "open");
  f.sharedC = await customer();
  f.sharedSeedS = await session(f.sharedC);
  f.sharedSeedR = await request(f.sharedSeedS, f.sharedC, "pending", sql`NULL`, "HVAC-DEMO");
  f.sharedRealS = await session(f.sharedC);
  f.sharedRealR = await request(f.sharedRealS, f.sharedC, "pending");
  // the local-midnight boundary in America/Chicago
  const midnight = sql`(date_trunc('day', now() AT TIME ZONE ${TZ}) AT TIME ZONE ${TZ})`;
  await chain("todayEarly", "completed");
  await appointment(f.todayEarlyR!, sql`${midnight} + interval '30 minutes'`, false);
  await chain("yesterdayLate", "completed");
  await appointment(f.yesterdayLateR!, sql`${midnight} - interval '30 minutes'`, false);
}

function spawnScript(args: string[], env: NodeJS.ProcessEnv = process.env) {
  return spawnSync("npx", ["tsx", SCRIPT, ...args], { encoding: "utf8", env, timeout: 60_000 });
}

beforeAll(async () => {
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const match = line.match(/^([A-Z_0-9]+)=(.*)$/);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^"|"$/g, "");
  }
  const url = process.env.DATABASE_URL ?? "";
  if (!url) throw new Error("DATABASE_URL missing from .env.local");
  if (url.includes("ep-withered-hill")) {
    throw new Error("Refusing to run against the production database");
  }
  ({ sql } = await import("drizzle-orm"));
  ({ db } = await import("@/lib/db"));
  m = await import("@/lib/admin/golive-marking-sql");
  const { createOrgCore } = await import("@/lib/admin/provisioning");
  const out = await createOrgCore({
    name: `Probe Org Marking ${randomUUID().slice(0, 8)}`,
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
  await db.execute(
    sql`UPDATE organization_settings SET after_hours_config = COALESCE(after_hours_config, '{}'::jsonb) || jsonb_build_object('timezone', ${TZ}::text) WHERE organization_id = ${org}`,
  );
  await seed();
}, 120_000);

afterAll(async () => {
  if (!org) return;
  try {
    await db.execute(sql`DELETE FROM organizations WHERE id = ${org}`);
  } catch (error) {
    console.error(`afterAll: could not delete probe org ${org}`, error);
  }
}, 60_000);

describe("go-live marking (dev DB)", { timeout: 60_000 }, () => {
  it("history keeps open request, upcoming-visit completed request, open invoice + its customer/request/session, native draft, open estimate, chatting session + its customer", async () => {
    await batch(m.unhideStatements(org));
    const dry = (await run(m.dryRunSql(org)))[0]!;
    const changed = await batch(m.markStatements(org, "history"));
    // the dry run predicts exactly what the apply changes
    expect(changed).toEqual(m.MARKED_TABLES.map((t) => dry[`${t}_hide_history`]));
    await expectHidden(false, [
      ["service_requests", "openR"], ["customer_sessions", "openS"], ["customers", "openC"],
      ["service_requests", "upcomingR"], ["customer_sessions", "upcomingS"], ["customers", "upcomingC"],
      ["invoices", "arI"], ["service_requests", "arR"], ["customer_sessions", "arS"], ["customers", "arC"],
      ["invoices", "draftI"], ["customers", "draftC"],
      ["estimates", "estE"], ["service_requests", "estR"], ["customers", "estC"],
      ["customer_sessions", "chatS"], ["customers", "chatC"],
    ]);
  });

  it("the dry run counts each P8 rule", async () => {
    await batch(m.unhideStatements(org));
    const dry = (await run(m.dryRunSql(org)))[0]!;
    // staleR (never scheduled) is the one old open request nothing keeps
    expect(dry.stale_requests_hidden).toBe(1);
    // staleInvR and staleEstR are kept by their open invoice / recent estimate
    expect(dry.old_open_requests_kept).toBe(2);
    // oldEstE only; seedCapE is hidden as seeded, not as stale
    expect(dry.stale_estimates_hidden).toBe(1);
    // oldChatS only; seedDemoS (fresh, but a seeded request's session) counts as seeded
    expect(dry.stale_sessions_hidden).toBe(1);
    expect(dry.seeded_requests_hidden).toBe(3);
    // a longer cut keeps staleR
    const longer = (await run(m.dryRunSql(org, 100)))[0]!;
    expect(longer.stale_requests_hidden).toBe(0);
    expect(longer.old_open_requests_kept).toBe(0);
  });

  it("an old resumable session is hidden with its customer; a recent one is kept (both modes)", async () => {
    for (const mode of ["history", "empty"] as const) {
      await apply(mode);
      await expectHidden(true, [["customer_sessions", "oldChatS"], ["customers", "oldChatC"]]);
      await expectHidden(false, [["customer_sessions", "chatS"], ["customers", "chatC"]]);
    }
  });

  it("history hides an open estimate untouched for 90 days and keeps a recent one", async () => {
    await apply("history");
    await expectHidden(true, [["estimates", "oldEstE"], ["service_requests", "oldEstR"], ["customers", "oldEstC"]]);
    await expectHidden(false, [["estimates", "estE"], ["service_requests", "estR"], ["customers", "estC"]]);
  });

  it("history hides an old open request unless an open invoice or recent estimate keeps it", async () => {
    await apply("history");
    await expectHidden(true, [["service_requests", "staleR"], ["customer_sessions", "staleS"], ["customers", "staleC"]]);
    await expectHidden(false, [
      ["service_requests", "staleInvR"], ["invoices", "staleInvI"], ["customer_sessions", "staleInvS"], ["customers", "staleInvC"],
      ["service_requests", "staleEstR"], ["estimates", "staleEstE"], ["customer_sessions", "staleEstS"], ["customers", "staleEstC"],
      ["service_requests", "openR"],
    ]);
  });

  it("--stale-days moves the cut", async () => {
    await batch(m.unhideStatements(org));
    await batch(m.markStatements(org, "history", 100));
    await expectHidden(false, [["service_requests", "staleR"], ["customers", "staleC"]]);
  });

  it("seeded HVAC-DEMO / HVAC-CAP requests, their sessions, invoices and estimates are hidden in both modes", async () => {
    for (const mode of ["history", "empty"] as const) {
      await apply(mode);
      await expectHidden(true, [
        ["service_requests", "seedDemoR"], ["customer_sessions", "seedDemoS"], ["customers", "seedDemoC"],
        ["service_requests", "seedCapR"], ["customer_sessions", "seedCapS"], ["customers", "seedCapC"],
        ["invoices", "seedCapI"], ["estimates", "seedCapE"],
        ["service_requests", "sharedSeedR"], ["customer_sessions", "sharedSeedS"],
      ]);
    }
    // a seeded customer with other kept work stays
    await apply("history");
    await expectHidden(false, [["customers", "sharedC"], ["service_requests", "sharedRealR"]]);
  });

  it("no visible row points at a hidden parent after either mode", async () => {
    for (const mode of ["history", "empty"] as const) {
      await apply(mode);
      expect(await danglingLinks(org)).toEqual(NO_DANGLING);
    }
  });

  it("history hides completed request without future visit, paid invoice, FieldPulse draft, sold estimate, abandoned orphan session", async () => {
    await apply("history");
    await expectHidden(true, [
      ["service_requests", "doneR"], ["customer_sessions", "doneS"], ["customers", "doneC"],
      ["invoices", "paidI"], ["customers", "paidC"],
      ["invoices", "fpDraftI"], ["customers", "fpDraftC"],
      ["estimates", "soldE"], ["customers", "soldC"],
      ["customer_sessions", "orphanS"],
    ]);
  });

  it("empty keeps only upcoming-visit requests, resumable sessions and their customers", async () => {
    await apply("empty");
    await expectHidden(false, [
      ["service_requests", "upcomingR"], ["customer_sessions", "upcomingS"], ["customers", "upcomingC"],
      ["service_requests", "todayEarlyR"],
      ["customer_sessions", "chatS"], ["customers", "chatC"],
    ]);
    await expectHidden(true, [
      ["service_requests", "openR"], ["customer_sessions", "openS"], ["customers", "openC"],
      ["invoices", "arI"], ["service_requests", "arR"], ["customers", "arC"],
      ["invoices", "draftI"], ["customers", "draftC"],
      ["estimates", "estE"], ["service_requests", "estR"],
      ["invoices", "paidI"], ["estimates", "soldE"], ["customer_sessions", "orphanS"],
    ]);
    const kept = await run(
      sql`SELECT id FROM service_requests WHERE organization_id = ${org} AND NOT hidden_from_org ORDER BY id`,
    );
    expect(kept.map((r) => r.id).sort()).toEqual([f.upcomingR, f.todayEarlyR].sort());
  });

  it("a cancelled future appointment does not keep its request", async () => {
    for (const mode of ["history", "empty"] as const) {
      await apply(mode);
      await expectHidden(true, [["service_requests", "cancelledVisitR"], ["customers", "cancelledVisitC"]]);
    }
  });

  it("a cancelled request with a future scheduled_date is hidden in both modes", async () => {
    for (const mode of ["history", "empty"] as const) {
      await apply(mode);
      await expectHidden(true, [["service_requests", "cancelledReqR"], ["customer_sessions", "cancelledReqS"], ["customers", "cancelledReqC"]]);
    }
  });

  it("visit at 00:30 local today is kept; 23:30 yesterday is hidden", async () => {
    for (const mode of ["history", "empty"] as const) {
      await apply(mode);
      await expectHidden(false, [["service_requests", "todayEarlyR"], ["customers", "todayEarlyC"]]);
      await expectHidden(true, [["service_requests", "yesterdayLateR"], ["customers", "yesterdayLateC"]]);
    }
  });

  it("a second apply without --reapply refuses; markStatements re-run changes 0 rows", async () => {
    const first = await apply("history");
    expect(first.reduce((a, b) => a + b, 0)).toBeGreaterThan(0);
    const before = await hiddenTotal();
    const out = spawnScript(["--org", org, "--apply"]);
    expect(out.status).toBe(1);
    expect(out.stderr).toMatch(/^Refused: .* already has \d+ hidden rows; pass --reapply to mark again\n$/);
    expect(await hiddenTotal()).toBe(before);
    expect(await batch(m.markStatements(org, "history"))).toEqual([0, 0, 0, 0, 0]);
    const again = spawnScript(["--org", org, "--apply", "--reapply"]);
    expect(again.status).toBe(0);
    expect(again.stdout).toContain("Hid rows for");
  });

  it("script refuses a bad --stale-days and reports the cut it was given", () => {
    for (const bad of ["0", "-5", "abc", "1.5"]) {
      const out = spawnScript(["--org", org, "--stale-days", bad]);
      expect(out.status).toBe(1);
      expect(out.stderr).toBe("Refused: --stale-days must be a whole number of days from 1 to 99999\n");
    }
    const out = spawnScript(["--org", org, "--stale-days", "100"]);
    expect(out.status).toBe(0);
    expect(out.stdout).toContain("stale cut 100 days");
    expect(out.stdout).toMatch(/history: hides \d+ open requests older than 100 days/);
    expect(out.stdout).toMatch(/both: hide \d+ seeded HVAC-DEMO \/ HVAC-CAP requests/);
  });

  it("unhide restores every row", async () => {
    await apply("empty");
    expect(await hiddenTotal()).toBeGreaterThan(0);
    const out = spawnScript(["--org", org, "--unhide"]);
    expect(out.status).toBe(0);
    expect(await hiddenTotal()).toBe(0);
  });

  it("script refuses ep-withered-hill without --prod", () => {
    const env = { ...process.env, DATABASE_URL: "postgresql://probe:probe@ep-withered-hill-000000.invalid/neondb" };
    for (const args of [["--org", org], ["--org", org, "--apply"], ["--org", org, "--unhide"]]) {
      const started = Date.now();
      const out = spawnScript(args, env);
      expect(out.status).toBe(1);
      expect(out.stderr).toBe("Refused: this is the production database; pass --prod to run against it\n");
      // nothing past the refusal ran: no dry-run header, no connection error
      expect(out.stdout).toBe("");
      expect(Date.now() - started).toBeLessThan(30_000);
    }
  });
});
