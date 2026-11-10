import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/**
 * Integration suite for migration 0059's un-hide triggers. Runs against the DEV
 * database (`VITEST_INTEGRATION=1`) in one throwaway org deleted in afterAll.
 * Rows are marked hidden by direct UPDATE, as the go-live marking script does.
 */

type Db = typeof import("@/lib/db");
type Row = Record<string, unknown>;
type Table = "customers" | "customer_sessions" | "service_requests" | "invoices" | "estimates";

const SPEARS = "00000000-0000-0000-0000-000000000001";

let db: Db["db"];
let sql: typeof import("drizzle-orm").sql;
let upsertInvoiceRecord: typeof import("@/lib/integrations/fieldpulse/invoice-sync").upsertInvoiceRecord;
let org = "";

async function run(statement: ReturnType<typeof sql>): Promise<Row[]> {
  const res = await db.execute(statement);
  return res.rows as Row[];
}

async function one(statement: ReturnType<typeof sql>): Promise<string> {
  return (await run(statement))[0]!.id as string;
}

async function hide(table: Table, ...ids: string[]) {
  for (const id of ids) {
    await db.execute(sql`UPDATE ${sql.identifier(table)} SET hidden_from_org = true WHERE id = ${id}`);
  }
}

async function hidden(table: Table, id: string): Promise<boolean> {
  const rows = await run(sql`SELECT hidden_from_org AS h FROM ${sql.identifier(table)} WHERE id = ${id}`);
  return rows[0]!.h as boolean;
}

function newCustomer(fpId: string | null = null) {
  return one(
    sql`INSERT INTO customers (organization_id,name_encrypted,fieldpulse_customer_id) VALUES (${org},'probe',${fpId}) RETURNING id`,
  );
}

function newSession(customerId: string | null) {
  return one(
    sql`INSERT INTO customer_sessions (organization_id,token,customer_id) VALUES (${org},gen_random_uuid()::text,${customerId}) RETURNING id`,
  );
}

/** No schedule and no technician, so the visit-sync trigger creates no appointment. */
function newRequest(sessionId: string, customerId: string | null, opts: { hidden?: boolean; fpJobId?: string } = {}) {
  return one(
    sql`INSERT INTO service_requests (organization_id,session_id,customer_id,issue_type,urgency,description,reference_number,hidden_from_org,fieldpulse_job_id)
        VALUES (${org},${sessionId},${customerId},'no_heat','medium','Probe request','PRB-'||substr(md5(random()::text),1,8),${opts.hidden ?? false},${opts.fpJobId ?? null}) RETURNING id`,
  );
}

/** A visible customer, its session and its request. */
async function seedChain() {
  const c = await newCustomer();
  const s = await newSession(c);
  const r = await newRequest(s, c);
  return { c, s, r };
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
  ({ upsertInvoiceRecord } = await import("@/lib/integrations/fieldpulse/invoice-sync"));
  const { createOrgCore } = await import("@/lib/admin/provisioning");
  const out = await createOrgCore({
    name: `Probe Org Unhide ${randomUUID().slice(0, 8)}`,
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
}, 60_000);

afterAll(async () => {
  if (!org) return;
  try {
    await db.execute(sql`DELETE FROM organizations WHERE id = ${org}`);
  } catch (error) {
    console.error(`afterAll: could not delete probe org ${org}`, error);
  }
}, 60_000);

// Each case is a chain of serial HTTP round trips to Neon; 5 s is too tight.
describe("migration 0059 un-hide triggers (dev DB)", { timeout: 30_000 }, () => {
  it("visible request insert un-hides its customer and session", async () => {
    const c = await newCustomer();
    const s = await newSession(c);
    await hide("customers", c);
    await hide("customer_sessions", s);
    await newRequest(s, c);
    expect(await hidden("customers", c)).toBe(false);
    expect(await hidden("customer_sessions", s)).toBe(false);
  });

  it("invoice insert un-hides customer, request, request session", async () => {
    const { c, s, r } = await seedChain();
    await hide("customers", c);
    await hide("customer_sessions", s);
    await hide("service_requests", r);
    await db.execute(
      sql`INSERT INTO invoices (organization_id,service_request_id,customer_id,state) VALUES (${org},${r},${c},'open'::invoice_state)`,
    );
    expect(await hidden("customers", c)).toBe(false);
    expect(await hidden("service_requests", r)).toBe(false);
    expect(await hidden("customer_sessions", s)).toBe(false);
  });

  it("estimate insert un-hides its request and customer", async () => {
    const { c, s, r } = await seedChain();
    const billTo = await newCustomer();
    await hide("customers", c, billTo);
    await hide("customer_sessions", s);
    await hide("service_requests", r);
    await db.execute(
      sql`INSERT INTO estimates (organization_id,service_request_id,customer_id,status,total_cents) VALUES (${org},${r},${billTo},'open'::estimate_status,100)`,
    );
    // its own customer, its request, and that request's customer and session
    expect(await hidden("customers", billTo)).toBe(false);
    expect(await hidden("service_requests", r)).toBe(false);
    expect(await hidden("customers", c)).toBe(false);
    expect(await hidden("customer_sessions", s)).toBe(false);
  });

  it("session customer_id update un-hides the customer", async () => {
    const c = await newCustomer();
    const s = await newSession(null);
    await hide("customers", c);
    await db.execute(sql`UPDATE customer_sessions SET customer_id = ${c} WHERE id = ${s}`);
    expect(await hidden("customers", c)).toBe(false);
  });

  it("a message into a hidden session un-hides the session and its customer", async () => {
    const c = await newCustomer();
    const s = await newSession(c);
    await hide("customers", c);
    await hide("customer_sessions", s);
    await db.execute(
      sql`INSERT INTO messages (organization_id,session_id,role,content) VALUES (${org},${s},'user'::message_role,'hello')`,
    );
    expect(await hidden("customer_sessions", s)).toBe(false);
    expect(await hidden("customers", c)).toBe(false);
  });

  it("an appointment on a hidden request un-hides the request, its customer and session; a cancelled one does not", async () => {
    const live = await seedChain();
    await hide("customers", live.c);
    await hide("customer_sessions", live.s);
    await hide("service_requests", live.r);
    await db.execute(
      sql`INSERT INTO appointments (organization_id,service_request_id,appointment_number) VALUES (${org},${live.r},2)`,
    );
    expect(await hidden("service_requests", live.r)).toBe(false);
    expect(await hidden("customers", live.c)).toBe(false);
    expect(await hidden("customer_sessions", live.s)).toBe(false);

    const gone = await seedChain();
    await hide("customers", gone.c);
    await hide("customer_sessions", gone.s);
    await hide("service_requests", gone.r);
    await db.execute(
      sql`INSERT INTO appointments (organization_id,service_request_id,appointment_number,cancelled_at) VALUES (${org},${gone.r},2,now())`,
    );
    expect(await hidden("service_requests", gone.r)).toBe(true);
    expect(await hidden("customers", gone.c)).toBe(true);
    expect(await hidden("customer_sessions", gone.s)).toBe(true);
  });

  it("inserting a row with hidden_from_org=true un-hides nothing", async () => {
    const { c, s, r } = await seedChain();
    await hide("customers", c);
    await hide("customer_sessions", s);
    await hide("service_requests", r);
    await newRequest(s, c, { hidden: true });
    await db.execute(
      sql`INSERT INTO invoices (organization_id,service_request_id,customer_id,state,hidden_from_org) VALUES (${org},${r},${c},'open'::invoice_state,true)`,
    );
    await db.execute(
      sql`INSERT INTO estimates (organization_id,service_request_id,customer_id,status,total_cents,hidden_from_org) VALUES (${org},${r},${c},'open'::estimate_status,100,true)`,
    );
    await db.execute(
      sql`INSERT INTO customer_sessions (organization_id,token,customer_id,hidden_from_org) VALUES (${org},gen_random_uuid()::text,${c},true)`,
    );
    expect(await hidden("customers", c)).toBe(true);
    expect(await hidden("customer_sessions", s)).toBe(true);
    expect(await hidden("service_requests", r)).toBe(true);
  });

  it("an upsert that updates only other columns leaves the flag", async () => {
    const { c, s, r } = await seedChain();
    await hide("customers", c);
    await hide("customer_sessions", s);
    await hide("service_requests", r);
    await db.execute(
      sql`INSERT INTO service_requests (id,organization_id,session_id,customer_id,issue_type,urgency,description,reference_number)
          VALUES (${r},${org},${s},${c},'no_heat','medium','Probe request','PRB-'||substr(md5(random()::text),1,8))
          ON CONFLICT (id) DO UPDATE SET description = 'Re-synced description'`,
    );
    const [row] = await run(sql`SELECT description FROM service_requests WHERE id = ${r}`);
    expect(row!.description).toBe("Re-synced description");
    expect(await hidden("service_requests", r)).toBe(true);
    expect(await hidden("customers", c)).toBe(true);
    expect(await hidden("customer_sessions", s)).toBe(true);
  });

  it("an UPDATE that re-sets customer_id/service_request_id to the same values un-hides nothing", async () => {
    const { c, s, r } = await seedChain();
    // Visible children, so only the "really changed" half of each WHEN clause can stop them.
    const inv = await one(
      sql`INSERT INTO invoices (organization_id,service_request_id,customer_id,state) VALUES (${org},${r},${c},'open'::invoice_state) RETURNING id`,
    );
    const est = await one(
      sql`INSERT INTO estimates (organization_id,service_request_id,customer_id,status,total_cents) VALUES (${org},${r},${c},'open'::estimate_status,100) RETURNING id`,
    );
    await hide("customers", c);
    await hide("customer_sessions", s);
    await hide("service_requests", r);

    await db.execute(sql`UPDATE invoices SET customer_id = customer_id, service_request_id = service_request_id WHERE id = ${inv}`);
    await db.execute(sql`UPDATE estimates SET customer_id = customer_id, service_request_id = service_request_id WHERE id = ${est}`);
    await db.execute(sql`UPDATE customer_sessions SET customer_id = customer_id WHERE id = ${s}`);
    await db.execute(sql`UPDATE service_requests SET customer_id = customer_id WHERE id = ${r}`);
    expect(await hidden("customers", c)).toBe(true);
    expect(await hidden("customer_sessions", s)).toBe(true);
    expect(await hidden("service_requests", r)).toBe(true);

    // Control: a real change of the parent column does un-hide.
    const other = await newCustomer();
    await hide("customers", other);
    await db.execute(sql`UPDATE invoices SET customer_id = ${other} WHERE id = ${inv}`);
    expect(await hidden("customers", other)).toBe(false);
  });

  it("re-running upsertInvoiceRecord on a hidden FieldPulse invoice leaves the invoice, its customer and its request hidden", async () => {
    const fpCustomerId = `fpc-${randomUUID()}`;
    const fpJobId = `fpj-${randomUUID()}`;
    const c = await newCustomer(fpCustomerId);
    const s = await newSession(c);
    const r = await newRequest(s, c, { fpJobId });
    const record = {
      id: `fpi-${randomUUID()}`,
      jobId: fpJobId,
      customerId: fpCustomerId,
      totalCents: 12_500,
      taxCents: 0,
      amountPaidCents: 0,
      invoicedDate: "2025-10-30",
    };
    expect(await upsertInvoiceRecord(org, record)).toBe("created");
    const [inv] = await run(
      sql`SELECT id, customer_id, service_request_id FROM invoices WHERE organization_id = ${org} AND fieldpulse_invoice_id = ${record.id}`,
    );
    expect(inv!.customer_id).toBe(c);
    expect(inv!.service_request_id).toBe(r);
    const invoiceId = inv!.id as string;
    await hide("invoices", invoiceId);
    await hide("customers", c);
    await hide("customer_sessions", s);
    await hide("service_requests", r);

    expect(await upsertInvoiceRecord(org, record)).toBe("updated");
    expect(await hidden("invoices", invoiceId)).toBe(true);
    expect(await hidden("customers", c)).toBe(true);
    expect(await hidden("service_requests", r)).toBe(true);
    expect(await hidden("customer_sessions", s)).toBe(true);
  });

  it("updating hidden_from_org itself does not cascade", async () => {
    const { c, s, r } = await seedChain();
    const inv = await one(
      sql`INSERT INTO invoices (organization_id,service_request_id,customer_id,state) VALUES (${org},${r},${c},'open'::invoice_state) RETURNING id`,
    );
    await hide("invoices", inv);
    await hide("customers", c);
    await hide("customer_sessions", s);
    await hide("service_requests", r);
    await db.execute(sql`UPDATE invoices SET hidden_from_org = false WHERE id = ${inv}`);
    await db.execute(sql`UPDATE service_requests SET hidden_from_org = false WHERE id = ${r}`);
    expect(await hidden("customers", c)).toBe(true);
    expect(await hidden("customer_sessions", s)).toBe(true);
  });

  it("re-executing every 0059 statement is a no-op", async () => {
    const columns = sql`SELECT table_name, column_name, column_default, is_nullable FROM information_schema.columns
      WHERE table_schema = 'public' AND column_name IN ('hidden_from_org','feature_flags') ORDER BY table_name, column_name`;
    const probeFlags = async () =>
      (await run(sql`SELECT feature_flags FROM organizations WHERE id = ${org}`))[0]!.feature_flags;
    const beforeColumns = await run(columns);

    const statements = readFileSync("drizzle/0059_golive.sql", "utf8")
      .split("--> statement-breakpoint")
      .map((s) => s.trim())
      .filter(Boolean);
    // The seed targets the live org, which no suite may touch: it is replayed
    // below against the throwaway org instead.
    const isSeed = (s: string) => s.includes("UPDATE organizations SET feature_flags");
    const seeds = statements.filter(isSeed);
    expect(seeds).toHaveLength(1);
    expect(seeds[0]).toContain(`WHERE id = '${SPEARS}'`);
    const probeSeed = seeds[0].replace(`'${SPEARS}'`, `'${org}'`);
    expect(probeSeed).not.toContain(SPEARS);

    for (let pass = 0; pass < 2; pass++) {
      for (const stmt of statements.filter((s) => !isSeed(s))) await db.execute(sql.raw(stmt));
    }
    expect(await run(columns)).toEqual(beforeColumns);
    expect(beforeColumns).toHaveLength(6);
    for (const col of beforeColumns) expect(col.is_nullable).toBe("NO");
    expect(await probeFlags()).toEqual({});

    // The seed sets both defaults once; a second run changes nothing.
    await db.execute(sql.raw(probeSeed));
    expect(await probeFlags()).toEqual({ reviewRequests: false, payLinks: false });
    await db.execute(sql.raw(probeSeed));
    expect(await probeFlags()).toEqual({ reviewRequests: false, payLinks: false });

    // A retry after the owner toggled a flag keeps the toggle and other keys.
    await db.execute(
      sql`UPDATE organizations SET feature_flags = '{"payLinks":true,"other":1}'::jsonb WHERE id = ${org}`,
    );
    await db.execute(sql.raw(probeSeed));
    expect(await probeFlags()).toEqual({ payLinks: true, other: 1, reviewRequests: false });
  }, 60_000);
});
