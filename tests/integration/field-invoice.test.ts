import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/**
 * Field invoice integration suite (M3b spec §10) against the DEV database
 * (`VITEST_INTEGRATION=1`). Drives the writers and `withIdempotency` directly
 * (the routes' run bodies are mirrored by `createVia` / `payVia`), never HTTP.
 * One throwaway org via createOrgCore, deleted (cascade) in afterAll even on
 * failure. Fixtures never set a customer phone and never drain the job queue.
 */

type FW = typeof import("@/lib/admin/invoice-field-writes");
type PW = typeof import("@/lib/admin/invoice-payment-writes");
type IQ = typeof import("@/lib/admin/invoice-queries");
type ID = typeof import("@/lib/http/idempotency");
type Db = typeof import("@/lib/db");
type Row = Record<string, unknown>;
type RunOut = Awaited<ReturnType<ID["withIdempotency"]>>;

let fw: FW;
let pw: PW;
let iq: IQ;
let idem: ID;
let db: Db["db"];
let sql: typeof import("drizzle-orm").sql;
let recordSignature: typeof import("@/lib/tech/field-queries").recordSignature;
let reasonResult: typeof import("@/lib/tech/invoice-errors").reasonResult;
let okResult: typeof import("@/lib/tech/invoice-write-route").okResult;
let cardPaymentsEnabled: typeof import("@/lib/payments/card-enabled").cardPaymentsEnabled;
let isUniqueViolation: typeof import("@/lib/db/unique-violation").isUniqueViolation;

let org = "";
let owner = "";
let tech = "";
let item = "";
const ITEM_PRICE = 12_500;

async function run(statement: ReturnType<typeof sql>): Promise<Row[]> {
  const res = await db.execute(statement);
  return res.rows as Row[];
}

/** A request assigned to the technician, status arrived (the trigger makes visit #1 + the lead row). */
async function newJob(): Promise<string> {
  const sess = (await run(
    sql`INSERT INTO customer_sessions (organization_id,token) VALUES (${org},gen_random_uuid()::text) RETURNING id`,
  ))[0].id as string;
  return (await run(
    sql`INSERT INTO service_requests (organization_id,session_id,assigned_to,issue_type,urgency,description,reference_number,scheduled_date,status)
      VALUES (${org},${sess},${tech},'no_heat','medium','Probe request','PRB-'||substr(md5(random()::text),1,8),now(),'arrived'::request_status) RETURNING id`,
  ))[0].id as string;
}

async function addMaterial(rid: string, qty: number, priceCents: number): Promise<string> {
  return (await run(
    sql`INSERT INTO job_materials (organization_id,service_request_id,description,quantity,unit_cost_cents,unit_price_cents,created_by)
      VALUES (${org},${rid},'Probe part',${qty},100,${priceCents},${tech}) RETURNING id`,
  ))[0].id as string;
}

const actor = (rid: string) => ({ organizationId: org, requestId: rid, techUserId: tech });
const admin = () => ({ organizationId: org, requestId: null, techUserId: null });
const scope = (route: string, key: string) => ({ organizationId: org, userId: tech, route, key });

/** The tech create route's run body. */
function createVia(rid: string, key: string): Promise<RunOut> {
  return idem.withIdempotency(scope(`/api/tech/jobs/${rid}/invoice`, key), idem.canonicalHash({}), async (ids) => {
    const r = await fw.createInvoiceFromJob(actor(rid), { invoiceId: ids.id("invoice") });
    if (!r.ok) return reasonResult(r.reason);
    return okResult(r.created ? 201 : 200, { invoiceId: r.invoiceId, state: r.state, created: r.created });
  });
}

type PayBody = { invoiceId: string; method: "cash" | "check" | "other"; amountCents: number; checkNumber?: string };

/** The tech payments route's run body. */
function payVia(rid: string, key: string, body: PayBody): Promise<RunOut> {
  return idem.withIdempotency(scope(`/api/tech/jobs/${rid}/invoice/payments`, key), idem.canonicalHash(body), async (ids) => {
    const r = await pw.recordManualPayment(actor(rid), body.invoiceId, { paymentId: ids.id("payment") }, {
      method: body.method, amountCents: body.amountCents, checkNumber: body.checkNumber, isDeposit: false, recordedBy: tech,
    });
    if (!r.ok) return reasonResult(r.reason);
    return okResult(r.created ? 201 : 200, {
      paymentId: r.paymentId, invoiceId: body.invoiceId, invoiceState: r.invoiceState, created: r.created,
    });
  });
}

const data = (r: RunOut): Row => {
  if (!r.envelope.success) throw new Error(`expected success, got ${JSON.stringify(r.envelope)}`);
  return r.envelope.data;
};
const code = (r: RunOut): string | undefined => (r.envelope.success ? undefined : r.envelope.error.code);

async function invoiceRow(inv: string): Promise<Row> {
  return (await run(sql`SELECT * FROM invoices WHERE id = ${inv} AND organization_id = ${org}`))[0]!;
}

async function addItem(rid: string | null, inv: string, quantity = 1) {
  const a = rid === null ? admin() : actor(rid);
  return fw.addInvoiceLine(a, inv, { lineId: randomUUID() }, { pricebookItemId: item, quantity });
}

/** create → one catalog line → finalize: an open invoice. */
async function openInvoice(rid: string, quantity = 1): Promise<{ inv: string; total: number }> {
  const inv = data(await createVia(rid, randomUUID())).invoiceId as string;
  expect((await addItem(rid, inv, quantity)).ok).toBe(true);
  expect(await fw.finalizeInvoice(actor(rid), inv)).toMatchObject({ ok: true, state: "open" });
  return { inv, total: Number((await invoiceRow(inv)).total_cents) };
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
  fw = await import("@/lib/admin/invoice-field-writes");
  pw = await import("@/lib/admin/invoice-payment-writes");
  iq = await import("@/lib/admin/invoice-queries");
  idem = await import("@/lib/http/idempotency");
  ({ recordSignature } = await import("@/lib/tech/field-queries"));
  ({ reasonResult } = await import("@/lib/tech/invoice-errors"));
  ({ okResult } = await import("@/lib/tech/invoice-write-route"));
  ({ cardPaymentsEnabled } = await import("@/lib/payments/card-enabled"));
  ({ isUniqueViolation } = await import("@/lib/db/unique-violation"));
  const { createOrgCore } = await import("@/lib/admin/provisioning");

  const out = await createOrgCore({
    name: `Probe Org Field Invoice ${randomUUID().slice(0, 8)}`,
    createdBy: null,
    ownerEmail: null,
    ownerUser: { email: `owner-${randomUUID()}@throwaway.example`, name: "Probe Owner", googleId: `probe-${randomUUID()}` },
    skipOrgCountCheck: true,
  });
  if (!out.ok) throw new Error(`createOrgCore failed: ${JSON.stringify(out.error)}`);
  org = out.result.organizationId;
  owner = out.result.ownerUserId!;
  tech = (await run(
    sql`INSERT INTO users (organization_id,email,name,role,password_hash,is_active)
      VALUES (${org},'tech-'||gen_random_uuid()||'@throwaway.example','Probe Technician','technician','x',true) RETURNING id`,
  ))[0].id as string;
  item = (await run(
    sql`INSERT INTO pricebook_items (organization_id,type,name,cost_cents,price_cents,active)
      VALUES (${org},'service'::pricebook_item_type,'Probe tune-up',4000,${ITEM_PRICE},true) RETURNING id`,
  ))[0].id as string;
}, 60_000);

afterAll(async () => {
  if (!org) return;
  try {
    await db.execute(sql`DELETE FROM organizations WHERE id = ${org}`);
  } catch (error) {
    console.error(`afterAll: could not delete probe org ${org}`, error);
  }
}, 60_000);

describe("field invoice (dev DB)", () => {
  it("done-when: create seeds materials → line → sign → finalize snapshots → check payment → paid; replays", async () => {
    const rid = await newJob();
    const m1 = await addMaterial(rid, 2, 1_500);
    const m2 = await addMaterial(rid, 1, 4_000);

    const key = randomUUID();
    const created = await createVia(rid, key);
    expect(created.status).toBe(201);
    expect(created.replayed).toBe(false);
    const inv = data(created).invoiceId as string;
    const seeded = await run(sql`SELECT job_material_id, line_total_cents FROM invoice_line_items WHERE invoice_id = ${inv} AND organization_id = ${org}`);
    expect(seeded.map((r) => r.job_material_id).sort()).toEqual([m1, m2].sort());

    // Create replay: same key, same body → the stored 201, same invoice.
    const again = await createVia(rid, key);
    expect(again.replayed).toBe(true);
    expect(again.status).toBe(201);
    expect(data(again).invoiceId).toBe(inv);

    expect((await addItem(rid, inv)).ok).toBe(true);
    const sig = `https://signatures.invalid/${randomUUID()}.png`;
    expect(await recordSignature(org, tech, rid, { signatureUrl: sig, signatureName: "Pat Probe" })).toMatchObject({ ok: true });
    expect(await fw.finalizeInvoice(actor(rid), inv)).toEqual({ ok: true, state: "open", changed: true });

    const open = await invoiceRow(inv);
    expect(open.state).toBe("open");
    expect(open.signature_url).toBe(sig);
    expect(open.signature_name).toBe("Pat Probe");
    expect(open.signed_at).not.toBeNull();
    expect(Number(open.subtotal_cents)).toBe(2 * 1_500 + 4_000 + ITEM_PRICE);
    const total = Number(open.total_cents);

    const payKey = randomUUID();
    const body: PayBody = { invoiceId: inv, method: "check", amountCents: total, checkNumber: "1001" };
    const paid = await payVia(rid, payKey, body);
    expect(paid.status).toBe(201);
    expect(data(paid)).toMatchObject({ invoiceState: "paid", created: true });
    expect(await invoiceRow(inv)).toMatchObject({ state: "paid", amount_paid_cents: total });

    // Payment replay → the stored 201, no second credit.
    const replay = await payVia(rid, payKey, body);
    expect(replay.replayed).toBe(true);
    expect(replay.status).toBe(201);
    expect(data(replay).paymentId).toBe(data(paid).paymentId);
    // Different body, same key → 422 IDEMPOTENCY_KEY_REUSED.
    const reused = await payVia(rid, payKey, { ...body, amountCents: total - 1 });
    expect(reused.status).toBe(422);
    expect(code(reused)).toBe("IDEMPOTENCY_KEY_REUSED");
    const pays = await run(sql`SELECT count(*)::int AS n FROM payments WHERE invoice_id = ${inv} AND organization_id = ${org}`);
    expect(pays[0].n).toBe(1);
    expect(Number((await invoiceRow(inv)).amount_paid_cents)).toBe(total);

    // Partial manual refund on the paid invoice → open (never refunded).
    const refund = await pw.refundManualPayment(org, data(paid).paymentId as string,
      { refundId: idem.officeId("refund", org, randomUUID()) }, { amountCents: 1_000 });
    expect(refund).toMatchObject({ ok: true, created: true });
    expect(await invoiceRow(inv)).toMatchObject({ state: "open", amount_paid_cents: total - 1_000 });
  }, 120_000);

  it("two concurrent creates with different keys → one draft, both get its id", async () => {
    const rid = await newJob();
    const [a, b] = await Promise.all([createVia(rid, randomUUID()), createVia(rid, randomUUID())]);
    expect(data(a).invoiceId).toBe(data(b).invoiceId);
    expect([data(a).created, data(b).created].sort()).toEqual([false, true]);
    const drafts = await run(sql`SELECT count(*)::int AS n FROM invoices WHERE service_request_id = ${rid} AND organization_id = ${org} AND state = 'draft'::invoice_state`);
    expect(drafts[0].n).toBe(1);
  }, 60_000);

  it("two concurrent payments above the balance → exactly one lands, amount_paid exact", async () => {
    const rid = await newJob();
    const { inv, total } = await openInvoice(rid, 2);
    const amt = Math.floor(total * 0.6);
    const [a, b] = await Promise.all([
      payVia(rid, randomUUID(), { invoiceId: inv, method: "cash", amountCents: amt }),
      payVia(rid, randomUUID(), { invoiceId: inv, method: "cash", amountCents: amt }),
    ]);
    const statuses = [a.status, b.status].sort();
    expect(statuses[0]).toBe(201);
    expect(statuses[1]).not.toBe(201);
    expect([code(a), code(b)].filter(Boolean)).toHaveLength(1);
    expect(await invoiceRow(inv)).toMatchObject({ state: "open", amount_paid_cents: amt });
    const pays = await run(sql`SELECT count(*)::int AS n FROM payments WHERE invoice_id = ${inv} AND organization_id = ${org}`);
    expect(pays[0].n).toBe(1);
  }, 60_000);

  it("takeover of a 3-minute-old in_progress key row re-runs and credits once", async () => {
    const rid = await newJob();
    const { inv } = await openInvoice(rid);
    const key = randomUUID();
    const body: PayBody = { invoiceId: inv, method: "cash", amountCents: 2_000 };
    const s = scope(`/api/tech/jobs/${rid}/invoice/payments`, key);
    await db.execute(sql`INSERT INTO idempotency_keys (organization_id,user_id,route,key,request_hash,state,attempt_id,created_at)
      VALUES (${org},${tech},${s.route},${key},${idem.canonicalHash(body)},'in_progress',${randomUUID()},now() - interval '3 minutes')`);

    const r = await payVia(rid, key, body);
    expect(r.status).toBe(201);
    expect(r.replayed).toBe(false);
    expect(data(r).created).toBe(true);
    expect(Number((await invoiceRow(inv)).amount_paid_cents)).toBe(2_000);
    const [k] = await run(sql`SELECT state FROM idempotency_keys WHERE organization_id = ${org} AND user_id = ${tech} AND route = ${s.route} AND key = ${key}`);
    expect(k.state).toBe("done");
    // A replay now returns the stored outcome, still one credit.
    expect((await payVia(rid, key, body)).replayed).toBe(true);
    expect(Number((await invoiceRow(inv)).amount_paid_cents)).toBe(2_000);
  }, 60_000);

  it("crashed first run (payment row present, key row absent) → created: false, no double credit, incl. a full-balance payment", async () => {
    const rid = await newJob();
    const { inv, total } = await openInvoice(rid);
    const route = `/api/tech/jobs/${rid}/invoice/payments`;

    // Partial: the first run's writer committed, then the process died before doneSql.
    const k1 = randomUUID();
    const b1: PayBody = { invoiceId: inv, method: "cash", amountCents: 3_000 };
    const pid1 = idem.derivedId(scope(route, k1), "payment");
    expect(await pw.recordManualPayment(actor(rid), inv, { paymentId: pid1 },
      { method: "cash", amountCents: 3_000, isDeposit: false, recordedBy: tech })).toMatchObject({ ok: true, created: true });
    const r1 = await payVia(rid, k1, b1);
    expect(r1.status).toBe(200);
    expect(data(r1)).toMatchObject({ paymentId: pid1, created: false, invoiceState: "open" });
    expect(Number((await invoiceRow(inv)).amount_paid_cents)).toBe(3_000);

    // Full balance: the crashed run paid the invoice; the retry replays instead of INVOICE_NOT_CHARGEABLE.
    const rest = total - 3_000;
    const k2 = randomUUID();
    const pid2 = idem.derivedId(scope(route, k2), "payment");
    expect(await pw.recordManualPayment(actor(rid), inv, { paymentId: pid2 },
      { method: "cash", amountCents: rest, isDeposit: false, recordedBy: tech })).toMatchObject({ ok: true, invoiceState: "paid" });
    const r2 = await payVia(rid, k2, { invoiceId: inv, method: "cash", amountCents: rest });
    expect(r2.status).toBe(200);
    expect(data(r2)).toMatchObject({ paymentId: pid2, created: false, invoiceState: "paid" });
    expect(await invoiceRow(inv)).toMatchObject({ state: "paid", amount_paid_cents: total });
  }, 60_000);

  it("sign → add a line → finalize leaves the snapshot NULL; a later re-sign leaves a snapshot intact", async () => {
    // Stale signature: the line moved updated_at past signed_at.
    const rid = await newJob();
    const inv = data(await createVia(rid, randomUUID())).invoiceId as string;
    expect((await recordSignature(org, tech, rid, { signatureUrl: "https://signatures.invalid/old.png", signatureName: "Old" })).ok).toBe(true);
    expect((await addItem(rid, inv)).ok).toBe(true);
    expect((await fw.finalizeInvoice(actor(rid), inv)).ok).toBe(true);
    expect(await invoiceRow(inv)).toMatchObject({ state: "open", signature_url: null, signature_name: null, signed_at: null });

    // Fresh signature snapshotted, then the request is re-signed.
    const rid2 = await newJob();
    const inv2 = data(await createVia(rid2, randomUUID())).invoiceId as string;
    expect((await addItem(rid2, inv2)).ok).toBe(true);
    const first = "https://signatures.invalid/first.png";
    expect((await recordSignature(org, tech, rid2, { signatureUrl: first, signatureName: "First" })).ok).toBe(true);
    expect((await fw.finalizeInvoice(actor(rid2), inv2)).ok).toBe(true);
    const snap = await invoiceRow(inv2);
    expect(snap.signature_url).toBe(first);
    const resign = await recordSignature(org, tech, rid2, { signatureUrl: "https://signatures.invalid/second.png", signatureName: "Second" });
    expect(resign).toEqual({ ok: true, previousUrl: first });
    const after = await invoiceRow(inv2);
    expect(after).toMatchObject({ signature_url: first, signature_name: "First" });
    expect(String(after.signed_at)).toBe(String(snap.signed_at));
  }, 60_000);

  it("full manual refund → open with amount_paid_cents = 0, never refunded", async () => {
    const rid = await newJob();
    const { inv, total } = await openInvoice(rid);
    const pay = data(await payVia(rid, randomUUID(), { invoiceId: inv, method: "cash", amountCents: total }));
    expect(pay.invoiceState).toBe("paid");
    const r = await pw.refundManualPayment(org, pay.paymentId as string,
      { refundId: idem.officeId("refund", org, randomUUID()) }, { amountCents: total });
    expect(r).toMatchObject({ ok: true, created: true });
    expect(await invoiceRow(inv)).toMatchObject({ state: "open", amount_paid_cents: 0 });
    const [p] = await run(sql`SELECT status, amount_refunded_cents FROM payments WHERE id = ${pay.paymentId as string}`);
    expect(p).toMatchObject({ status: "refunded", amount_refunded_cents: total });
  }, 60_000);

  it("estimate creator refuses on a field draft and coexists with a field open invoice", async () => {
    const rid = await newJob();
    const inv = data(await createVia(rid, randomUUID())).invoiceId as string;
    const est = (await run(sql`INSERT INTO estimates (organization_id,service_request_id,status,total_cents)
      VALUES (${org},${rid},'sold'::estimate_status,5000) RETURNING id`))[0].id as string;
    const opt = (await run(sql`INSERT INTO estimate_options (organization_id,estimate_id,name,subtotal_cents,tax_cents,total_cents)
      VALUES (${org},${est},'Good',5000,0,5000) RETURNING id`))[0].id as string;
    await db.execute(sql`UPDATE estimates SET sold_option_id = ${opt} WHERE id = ${est} AND organization_id = ${org}`);

    expect(await iq.createInvoiceFromSoldEstimate(org, est)).toEqual({ ok: false, reason: "request_has_draft" });

    expect((await addItem(rid, inv)).ok).toBe(true);
    expect((await fw.finalizeInvoice(actor(rid), inv)).ok).toBe(true);
    const made = await iq.createInvoiceFromSoldEstimate(org, est);
    expect(made.ok).toBe(true);
    const rows = await run(sql`SELECT id, state, estimate_id FROM invoices WHERE service_request_id = ${rid} AND organization_id = ${org} ORDER BY created_at`);
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.state)).toEqual(["open", "open"]);
    expect(rows[1].estimate_id).toBe(est);
  }, 60_000);

  it("a second invoice after a paid one seeds only unbilled materials", async () => {
    const rid = await newJob();
    const m1 = await addMaterial(rid, 1, 2_000);
    const m2 = await addMaterial(rid, 3, 500);
    const first = data(await createVia(rid, randomUUID())).invoiceId as string;
    expect((await fw.finalizeInvoice(actor(rid), first)).ok).toBe(true);
    const total = Number((await invoiceRow(first)).total_cents);
    expect(data(await payVia(rid, randomUUID(), { invoiceId: first, method: "cash", amountCents: total })).invoiceState).toBe("paid");

    const m3 = await addMaterial(rid, 1, 7_000);
    const second = await createVia(rid, randomUUID());
    expect(data(second)).toMatchObject({ created: true, state: "draft" });
    const lines = await run(sql`SELECT job_material_id FROM invoice_line_items WHERE invoice_id = ${data(second).invoiceId as string} AND organization_id = ${org}`);
    expect(lines.map((l) => l.job_material_id)).toEqual([m3]);
    expect([m1, m2]).not.toContain(lines[0].job_material_id);
  }, 60_000);

  it("an office token reused on another invoice → payment_id_conflict, no credit", async () => {
    const ridA = await newJob();
    const ridB = await newJob();
    const { inv: a } = await openInvoice(ridA);
    const { inv: b } = await openInvoice(ridB);
    const token = randomUUID();
    const pid = idem.officeId("payment", org, token);
    expect(idem.officeId("payment", org, token)).toBe(pid); // org-scoped, invoice-independent
    const input = { method: "cash" as const, amountCents: 1_500, isDeposit: false, recordedBy: owner };
    expect(await pw.recordManualPayment(admin(), a, { paymentId: pid }, input)).toMatchObject({ ok: true, created: true });
    expect(await pw.recordManualPayment(admin(), b, { paymentId: pid }, input)).toEqual({ ok: false, reason: "payment_id_conflict" });
    expect(Number((await invoiceRow(b)).amount_paid_cents)).toBe(0);
    expect(Number((await invoiceRow(a)).amount_paid_cents)).toBe(1_500);
  }, 60_000);

  it("reconcile of a pending mock payment un-claims in one batch; state follows the CASE", async () => {
    expect(cardPaymentsEnabled()).toBe(false);
    const rid = await newJob();
    const { inv, total } = await openInvoice(rid);
    // Pre-credited claim of the full balance (the claim also flipped it to paid).
    const pid = randomUUID();
    await db.batch([
      db.execute(sql`INSERT INTO payments (id,organization_id,invoice_id,provider,amount_cents,status,method)
        VALUES (${pid},${org},${inv},'mock',${total},'pending'::payment_status,'card')`),
      db.execute(sql`UPDATE invoices SET amount_paid_cents = ${total}, state = 'paid'::invoice_state WHERE id = ${inv} AND organization_id = ${org}`),
    ]);
    expect(await iq.reconcilePayment(org, pid)).toEqual({ ok: true, outcome: "failed_marked" });
    expect(await invoiceRow(inv)).toMatchObject({ state: "open", amount_paid_cents: 0 });
    const [p] = await run(sql`SELECT status FROM payments WHERE id = ${pid}`);
    expect(p.status).toBe("failed");
    // A second reconcile is a no-op (the CAS already resolved it).
    expect(await iq.reconcilePayment(org, pid)).toEqual({ ok: false, reason: "not_pending" });
    expect(Number((await invoiceRow(inv)).amount_paid_cents)).toBe(0);
  }, 60_000);

  it("Promise.all([addInvoiceLine, finalizeInvoice(admin)]) × 10 → line in subtotal or invoice_locked; totals consistent", async () => {
    const outcomes: string[] = [];
    for (let i = 0; i < 10; i++) {
      const rid = await newJob();
      const inv = data(await createVia(rid, randomUUID())).invoiceId as string;
      expect((await addItem(rid, inv)).ok).toBe(true);
      const lineId = randomUUID();
      // The add does three reads before its batch, the admin finalize one, so an
      // unstaggered pair always locks; a growing finalize delay samples both sides.
      const [add, fin] = await Promise.all([
        fw.addInvoiceLine(actor(rid), inv, { lineId }, { pricebookItemId: item, quantity: 1 }),
        new Promise((r) => setTimeout(r, i * 60)).then(() => fw.finalizeInvoice(admin(), inv)),
      ]);
      expect(fin).toMatchObject({ ok: true, state: "open" });
      const [sum] = await run(sql`SELECT COALESCE(SUM(line_total_cents),0)::int AS s,
          bool_or(id = ${lineId}::uuid) AS has_line FROM invoice_line_items WHERE invoice_id = ${inv} AND organization_id = ${org}`);
      const row = await invoiceRow(inv);
      expect(Number(row.subtotal_cents)).toBe(sum.s);
      if (add.ok) {
        expect(sum.has_line).toBe(true);
        expect(sum.s).toBe(2 * ITEM_PRICE);
        outcomes.push("added");
      } else {
        expect(add).toEqual({ ok: false, reason: "invoice_locked" });
        expect(sum.has_line).toBe(false);
        expect(sum.s).toBe(ITEM_PRICE);
        outcomes.push("locked");
      }
    }
    console.log(`add-vs-finalize outcomes: ${outcomes.join(",")}`);
  }, 180_000);

  it("the one-draft index refuses a second native draft (direct INSERT)", async () => {
    const rid = await newJob();
    data(await createVia(rid, randomUUID()));
    let caught: unknown = null;
    try {
      await db.execute(sql`INSERT INTO invoices (organization_id,service_request_id,state) VALUES (${org},${rid},'draft'::invoice_state)`);
    } catch (error) {
      caught = error;
    }
    expect(isUniqueViolation(caught, "invoices_one_native_draft_per_request_idx")).toBe(true);
  }, 60_000);

  it("migrations 0052 and 0053 apply twice, statement by statement", async () => {
    for (const file of ["drizzle/0052_m3b_collect.sql", "drizzle/0053_m3b_backfill.sql"]) {
      const statements = readFileSync(file, "utf8").split("--> statement-breakpoint").map((s) => s.trim()).filter(Boolean);
      expect(statements.length).toBeGreaterThan(0);
      for (let pass = 0; pass < 2; pass++) {
        for (const stmt of statements) {
          await db.execute(sql.raw(stmt));
        }
      }
    }
  }, 120_000);
});
