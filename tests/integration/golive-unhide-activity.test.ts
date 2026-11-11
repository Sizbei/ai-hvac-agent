import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { migrationStatements, replayUnits } from "./replay-migration";

vi.mock("server-only", () => ({}));

/**
 * Integration suite for migration 0061 (activity un-hides work) against the DEV
 * database (`VITEST_INTEGRATION=1`), one throwaway org deleted in afterAll.
 * Rows are marked hidden by direct UPDATE, as the go-live marking script does.
 * Every trigger is checked both firing and not firing, including re-syncs that
 * re-set the same values and updates of the hidden flag alone.
 */

type Db = typeof import("@/lib/db");
type Row = Record<string, unknown>;
type Table = "customers" | "customer_sessions" | "service_requests" | "invoices" | "estimates";

let db: Db["db"];
let sql: typeof import("drizzle-orm").sql;
let upsertInvoiceRecord: typeof import("@/lib/integrations/fieldpulse/invoice-sync").upsertInvoiceRecord;
let org = "";

async function run(statement: ReturnType<typeof sql>): Promise<Row[]> {
  return (await db.execute(statement)).rows as Row[];
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

interface Chain {
  readonly c: string;
  readonly s: string;
  readonly r: string;
}

async function expectChain(expected: boolean, ch: Chain) {
  expect(await hidden("service_requests", ch.r), "request").toBe(expected);
  expect(await hidden("customers", ch.c), "customer").toBe(expected);
  expect(await hidden("customer_sessions", ch.s), "session").toBe(expected);
}

/**
 * A customer, its session and a request. With no scheduled date and no
 * technician the visit-sync trigger creates no appointment; with one it mirrors
 * the date into visit #1 (at insert, before anything is hidden).
 */
async function chain(
  opts: { status?: string; scheduled?: ReturnType<typeof sql>; fpJobId?: string; fpCustomerId?: string } = {},
): Promise<Chain> {
  const c = await one(
    sql`INSERT INTO customers (organization_id,name_encrypted,fieldpulse_customer_id) VALUES (${org},'probe',${opts.fpCustomerId ?? null}) RETURNING id`,
  );
  const s = await one(
    sql`INSERT INTO customer_sessions (organization_id,token,customer_id) VALUES (${org},gen_random_uuid()::text,${c}) RETURNING id`,
  );
  const r = await one(
    sql`INSERT INTO service_requests (organization_id,session_id,customer_id,issue_type,urgency,description,reference_number,status,scheduled_date,fieldpulse_job_id)
        VALUES (${org},${s},${c},'no_heat','medium','Probe request','PRB-'||substr(md5(random()::text),1,8),${opts.status ?? "pending"}::request_status,${opts.scheduled ?? sql`NULL`},${opts.fpJobId ?? null}) RETURNING id`,
  );
  return { c, s, r };
}

async function hideChain(ch: Chain) {
  await hide("customers", ch.c);
  await hide("customer_sessions", ch.s);
  await hide("service_requests", ch.r);
}

/** A second visit on the request, inserted while the chain is still visible. */
function visit(requestId: string, startsAt: ReturnType<typeof sql>, cancelled = false) {
  return one(
    sql`INSERT INTO appointments (organization_id,service_request_id,appointment_number,starts_at,cancelled_at)
        VALUES (${org},${requestId},2,${startsAt},${cancelled ? sql`now()` : sql`NULL`}) RETURNING id`,
  );
}

function invoice(ch: Chain, state: string) {
  return one(
    sql`INSERT INTO invoices (organization_id,service_request_id,customer_id,state,total_cents) VALUES (${org},${ch.r},${ch.c},${state}::invoice_state,12500) RETURNING id`,
  );
}

beforeAll(async () => {
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const m = line.match(/^([A-Z_0-9]+)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
  }
  const url = process.env.DATABASE_URL ?? "";
  if (!url) throw new Error("DATABASE_URL missing from .env.local");
  if (url.toLowerCase().includes("ep-withered-hill")) {
    throw new Error("Refusing to run against the production database");
  }
  ({ sql } = await import("drizzle-orm"));
  ({ db } = await import("@/lib/db"));
  ({ upsertInvoiceRecord } = await import("@/lib/integrations/fieldpulse/invoice-sync"));
  const { createOrgCore } = await import("@/lib/admin/provisioning");
  const out = await createOrgCore({
    name: `Probe Org Unhide Activity ${randomUUID().slice(0, 8)}`,
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
describe("migration 0061: activity un-hides work (dev DB)", { timeout: 60_000 }, () => {
  describe("service_requests", () => {
    it("a status change on a hidden request un-hides it, its customer and its session", async () => {
      const ch = await chain();
      await hideChain(ch);
      await db.execute(sql`UPDATE service_requests SET status = 'in_progress'::request_status WHERE id = ${ch.r}`);
      await expectChain(false, ch);
    });

    it("a reschedule to within the last day un-hides, even with no live visit to cascade from", async () => {
      // A cancelled request mirrors its date into a cancelled visit #1, so no
      // appointment trigger can fire: only the request trigger is in play.
      const ch = await chain({ status: "cancelled" });
      await hideChain(ch);
      await db.execute(sql`UPDATE service_requests SET scheduled_date = now() - interval '20 hours' WHERE id = ${ch.r}`);
      await expectChain(false, ch);
    });

    it("FieldPulse moving an already-mirrored visit to next week un-hides the request", async () => {
      const ch = await chain({ scheduled: sql`now() - interval '40 days'` });
      await hideChain(ch);
      await db.execute(sql`UPDATE service_requests SET scheduled_date = now() + interval '7 days' WHERE id = ${ch.r}`);
      await expectChain(false, ch);
    });

    it("a reschedule further into the past un-hides nothing", async () => {
      const ch = await chain({ scheduled: sql`now() - interval '40 days'` });
      await hideChain(ch);
      await db.execute(sql`UPDATE service_requests SET scheduled_date = now() - interval '3 days' WHERE id = ${ch.r}`);
      await db.execute(sql`UPDATE service_requests SET scheduled_date = NULL WHERE id = ${ch.r}`);
      await expectChain(true, ch);
    });

    it("a FieldPulse-style re-sync that re-sets the same status and date un-hides nothing", async () => {
      const ch = await chain({ status: "scheduled", scheduled: sql`now() + interval '2 days'` });
      await hideChain(ch);
      await db.execute(
        sql`UPDATE service_requests SET status = status, scheduled_date = scheduled_date, description = 'Re-synced', updated_at = now() WHERE id = ${ch.r}`,
      );
      // and the same through an upsert, as the job import writes it
      await db.execute(
        sql`INSERT INTO service_requests (id,organization_id,session_id,customer_id,issue_type,urgency,description,reference_number,status,scheduled_date)
            SELECT id,organization_id,session_id,customer_id,issue_type,urgency,description,reference_number,status,scheduled_date FROM service_requests WHERE id = ${ch.r}
            ON CONFLICT (id) DO UPDATE SET status = EXCLUDED.status, scheduled_date = EXCLUDED.scheduled_date, description = 'Re-synced again'`,
      );
      const [row] = await run(sql`SELECT description FROM service_requests WHERE id = ${ch.r}`);
      expect(row!.description).toBe("Re-synced again");
      await expectChain(true, ch);
    });

    it("an update of other columns on a hidden request un-hides nothing", async () => {
      const ch = await chain();
      await hideChain(ch);
      await db.execute(sql`UPDATE service_requests SET description = 'Office note', urgency = 'high' WHERE id = ${ch.r}`);
      await expectChain(true, ch);
    });

    it("updating only the hidden flag never fires it: hide stays hidden, un-hide does not cascade", async () => {
      const ch = await chain();
      await hideChain(ch);
      // marking hides it: nothing brings it straight back
      expect(await hidden("service_requests", ch.r)).toBe(true);
      // a flag-only un-hide of the request leaves its parents alone
      await db.execute(sql`UPDATE service_requests SET hidden_from_org = false WHERE id = ${ch.r}`);
      expect(await hidden("customers", ch.c)).toBe(true);
      expect(await hidden("customer_sessions", ch.s)).toBe(true);
    });

    it("the self un-hide changes only the flag: status and updated_at stay as the update left them", async () => {
      const ch = await chain();
      await hideChain(ch);
      const before = await run(sql`SELECT updated_at FROM service_requests WHERE id = ${ch.r}`);
      await db.execute(sql`UPDATE service_requests SET status = 'on_hold'::request_status WHERE id = ${ch.r}`);
      const [row] = await run(sql`SELECT status, hidden_from_org, updated_at FROM service_requests WHERE id = ${ch.r}`);
      expect(row).toMatchObject({ status: "on_hold", hidden_from_org: false });
      expect(row!.updated_at).toEqual(before[0]!.updated_at);
    });

    it("a visible request's status change touches no hidden row", async () => {
      const ch = await chain();
      await hide("customers", ch.c);
      await db.execute(sql`UPDATE service_requests SET status = 'assigned'::request_status WHERE id = ${ch.r}`);
      expect(await hidden("customers", ch.c)).toBe(true);
    });
  });

  describe("appointments", () => {
    it("moving a live visit to tomorrow un-hides its request, customer and session", async () => {
      const ch = await chain();
      const a = await visit(ch.r, sql`now() - interval '30 days'`);
      await hideChain(ch);
      await db.execute(sql`UPDATE appointments SET starts_at = now() + interval '1 day' WHERE id = ${a}`);
      await expectChain(false, ch);
    });

    it("a date-only visit moved to within the last day un-hides", async () => {
      const ch = await chain();
      const a = await one(
        sql`INSERT INTO appointments (organization_id,service_request_id,appointment_number,scheduled_date) VALUES (${org},${ch.r},2,now() - interval '30 days') RETURNING id`,
      );
      await hideChain(ch);
      await db.execute(sql`UPDATE appointments SET scheduled_date = now() - interval '12 hours' WHERE id = ${a}`);
      await expectChain(false, ch);
    });

    it("a cancelled visit, a move into the past, a same-date re-set and other columns un-hide nothing", async () => {
      const ch = await chain();
      const live = await visit(ch.r, sql`now() - interval '30 days'`);
      const cancelled = await one(
        sql`INSERT INTO appointments (organization_id,service_request_id,appointment_number,starts_at,cancelled_at) VALUES (${org},${ch.r},3,now() - interval '30 days',now()) RETURNING id`,
      );
      await hideChain(ch);
      await db.execute(sql`UPDATE appointments SET starts_at = now() + interval '1 day' WHERE id = ${cancelled}`);
      await db.execute(sql`UPDATE appointments SET starts_at = now() - interval '2 days' WHERE id = ${live}`);
      await db.execute(sql`UPDATE appointments SET starts_at = starts_at, scheduled_date = scheduled_date, version = version + 1 WHERE id = ${live}`);
      await db.execute(sql`UPDATE appointments SET updated_at = now() WHERE id = ${live}`);
      await expectChain(true, ch);
    });
  });

  describe("invoices", () => {
    it("a hidden draft that is sent (open) un-hides the invoice, its customer, its request and the request's session", async () => {
      const ch = await chain({ status: "completed" });
      const inv = await invoice(ch, "draft");
      await hide("invoices", inv);
      await hideChain(ch);
      await db.execute(sql`UPDATE invoices SET state = 'open'::invoice_state WHERE id = ${inv}`);
      expect(await hidden("invoices", inv)).toBe(false);
      await expectChain(false, ch);
    });

    it("a hidden invoice that is paid, voided, re-set to the same state or changes money only stays hidden", async () => {
      const ch = await chain({ status: "completed" });
      const paid = await invoice(ch, "open");
      const same = await invoice(ch, "open");
      const voided = await invoice(ch, "draft");
      await hide("invoices", paid, same, voided);
      await hideChain(ch);
      await db.execute(sql`UPDATE invoices SET state = 'paid'::invoice_state, amount_paid_cents = 12500 WHERE id = ${paid}`);
      await db.execute(sql`UPDATE invoices SET state = state, amount_paid_cents = 100 WHERE id = ${same}`);
      await db.execute(sql`UPDATE invoices SET state = 'void'::invoice_state WHERE id = ${voided}`);
      for (const id of [paid, same, voided]) expect(await hidden("invoices", id)).toBe(true);
      await expectChain(true, ch);
    });

    it("a flag-only update of an invoice does not cascade", async () => {
      const ch = await chain({ status: "completed" });
      const inv = await invoice(ch, "open");
      await hide("invoices", inv);
      await hideChain(ch);
      await db.execute(sql`UPDATE invoices SET hidden_from_org = false WHERE id = ${inv}`);
      await expectChain(true, ch);
    });

    it("FieldPulse: a same-values re-pull leaves a hidden invoice hidden; a re-pull that reopens it un-hides it", async () => {
      const fpCustomerId = `fpc-${randomUUID()}`;
      const fpJobId = `fpj-${randomUUID()}`;
      const ch = await chain({ status: "completed", fpJobId, fpCustomerId });
      const record = {
        id: `fpi-${randomUUID()}`,
        jobId: fpJobId,
        customerId: fpCustomerId,
        totalCents: 12_500,
        taxCents: 0,
        amountPaidCents: 12_500,
        invoicedDate: "2025-10-30",
      };
      expect(await upsertInvoiceRecord(org, record)).toBe("created");
      const [inv] = await run(
        sql`SELECT id, state FROM invoices WHERE organization_id = ${org} AND fieldpulse_invoice_id = ${record.id}`,
      );
      expect(inv!.state).toBe("paid");
      const invoiceId = inv!.id as string;
      await hide("invoices", invoiceId);
      await hideChain(ch);

      expect(await upsertInvoiceRecord(org, record)).toBe("updated");
      expect(await hidden("invoices", invoiceId)).toBe(true);
      await expectChain(true, ch);

      // a refund upstream: nothing paid any more, so the mirror reopens it
      expect(await upsertInvoiceRecord(org, { ...record, amountPaidCents: 0 })).toBe("updated");
      const [reopened] = await run(sql`SELECT state FROM invoices WHERE id = ${invoiceId}`);
      expect(reopened!.state).toBe("open");
      expect(await hidden("invoices", invoiceId)).toBe(false);
      await expectChain(false, ch);
    });
  });

  describe("messages", () => {
    it("a message into a hidden session also un-hides the session's request", async () => {
      const ch = await chain();
      await hideChain(ch);
      await db.execute(
        sql`INSERT INTO messages (organization_id,session_id,role,content) VALUES (${org},${ch.s},'user'::message_role,'still no heat')`,
      );
      await expectChain(false, ch);
    });

    it("the session's request brings its own customer back when that differs from the session's", async () => {
      const ch = await chain();
      const billTo = await one(sql`INSERT INTO customers (organization_id,name_encrypted) VALUES (${org},'probe') RETURNING id`);
      await db.execute(sql`UPDATE service_requests SET customer_id = ${billTo} WHERE id = ${ch.r}`);
      await hideChain(ch);
      await hide("customers", billTo);
      await db.execute(
        sql`INSERT INTO messages (organization_id,session_id,role,content) VALUES (${org},${ch.s},'user'::message_role,'hello again')`,
      );
      expect(await hidden("customers", billTo)).toBe(false);
      await expectChain(false, ch);
    });
  });

  it("0061 is installed and re-executing every statement twice is a no-op", async () => {
    const triggers = sql`SELECT c.relname AS tbl, t.tgname AS name FROM pg_trigger t JOIN pg_class c ON c.oid = t.tgrelid
      WHERE NOT t.tgisinternal AND t.tgname LIKE 'trg_unhide%' ORDER BY 1, 2`;
    const before = await run(triggers);
    expect(before).toEqual(
      expect.arrayContaining([
        { tbl: "service_requests", name: "trg_unhide_on_activity" },
        { tbl: "appointments", name: "trg_unhide_on_reschedule" },
        { tbl: "invoices", name: "trg_unhide_on_reopen" },
      ]),
    );
    // Each DROP/CREATE TRIGGER pair in one transaction, so a suite running
    // beside this one never meets a missing trigger.
    const units = replayUnits(migrationStatements("drizzle/0061_unhide_on_activity.sql"));
    expect(units.map((u) => u.length)).toEqual([1, 2, 2, 2]);
    for (let pass = 0; pass < 2; pass++) {
      for (const unit of units) await db.batch(unit.map((stmt) => db.execute(sql.raw(stmt))) as never);
    }
    expect(await run(triggers)).toEqual(before);

    // still behaves after the replay
    const ch = await chain();
    await hideChain(ch);
    await db.execute(sql`UPDATE service_requests SET status = 'assigned'::request_status WHERE id = ${ch.r}`);
    await expectChain(false, ch);
  });
});
