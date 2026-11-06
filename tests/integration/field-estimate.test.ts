import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

/**
 * Field estimate integration suite (M3c spec §8) against the DEV database
 * (`VITEST_INTEGRATION=1`). Drives the writers through `withIdempotency`
 * exactly as the routes do (the `*Via` helpers mirror the route run bodies),
 * never HTTP. Two throwaway orgs via createOrgCore (the second for tenancy),
 * both deleted in afterAll even on failure. Every fixture UPDATE is by id AND
 * organization_id. No customer phone is ever set; nothing queues a message.
 * Case (q) is the `draftOutcome` unit test in invoice-field-writes.test.ts.
 */

type EW = typeof import("@/lib/tech/estimate-writes");
type FW = typeof import("@/lib/admin/invoice-field-writes");
type QW = typeof import("@/lib/tech/equipment-writes");
type IQ = typeof import("@/lib/admin/invoice-queries");
type EQ = typeof import("@/lib/admin/estimate-queries");
type TQ = typeof import("@/lib/tech/estimate-queries");
type TI = typeof import("@/lib/tech/invoice-queries");
type TE = typeof import("@/lib/tech/equipment-queries");
type ID = typeof import("@/lib/http/idempotency");
type Db = typeof import("@/lib/db");
type Row = Record<string, unknown>;
type RunOut = Awaited<ReturnType<ID["withIdempotency"]>>;
type CreateBody = Parameters<EW["createFieldEstimate"]>[2];

let ew: EW; let fw: FW; let qw: QW; let iq: IQ; let eq: EQ; let tq: TQ; let ti: TI; let te: TE; let idem: ID;
let db: Db["db"];
let sql: typeof import("drizzle-orm").sql;
let okResult: typeof import("@/lib/tech/invoice-write-route").okResult;
let estimateReasonResult: typeof import("@/lib/tech/estimate-errors").estimateReasonResult;
let equipmentReasonResult: typeof import("@/lib/tech/equipment-errors").equipmentReasonResult;
let parseEquipmentInput: typeof import("@/lib/tech/equipment-input").parseEquipmentInput;
let todayInZone: typeof import("@/lib/tech/equipment-input").todayInZone;

let org = "";
let org2 = "";
let tech = "";
let cust = "";
let itemA = "";
let itemB = "";
let taxBps = 0;

async function run(statement: ReturnType<typeof sql>): Promise<Row[]> {
  return (await db.execute(statement)).rows as Row[];
}

/** A request assigned to the technician (the trigger makes visit #1 + the lead row). */
async function newJob(o: { customer?: boolean; locationId?: string | null; status?: string } = {}): Promise<string> {
  const sess = (await run(sql`INSERT INTO customer_sessions (organization_id,token) VALUES (${org},gen_random_uuid()::text) RETURNING id`))[0]!.id as string;
  const customerId = o.customer === false ? null : cust;
  return (await run(sql`INSERT INTO service_requests (organization_id,session_id,assigned_to,customer_id,location_id,issue_type,urgency,description,reference_number,scheduled_date,status)
    VALUES (${org},${sess},${tech},${customerId},${o.locationId ?? null},'no_heat','medium','Probe request','PRB-'||substr(md5(random()::text),1,8),now(),${o.status ?? "arrived"}::request_status)
    RETURNING id`))[0]!.id as string;
}

async function addMaterial(rid: string, qty: number, priceCents: number): Promise<string> {
  return (await run(sql`INSERT INTO job_materials (organization_id,service_request_id,description,quantity,unit_cost_cents,unit_price_cents,created_by)
    VALUES (${org},${rid},'Probe part',${qty},100,${priceCents},${tech}) RETURNING id`))[0]!.id as string;
}

async function unit(o: { locationId: string | null; make?: string; fieldpulseAssetId?: string; customerId?: string; orgId?: string }): Promise<string> {
  return (await run(sql`INSERT INTO customer_equipment (organization_id,customer_id,equipment_type,location_id,make,fieldpulse_asset_id)
    VALUES (${o.orgId ?? org},${o.customerId ?? cust},'ac'::equipment_type,${o.locationId},${o.make ?? null},${o.fieldpulseAssetId ?? null}) RETURNING id`))[0]!.id as string;
}

const actor = (rid: string) => ({ organizationId: org, requestId: rid, techUserId: tech });
const scope = (route: string, key: string) => ({ organizationId: org, userId: tech, route, key });
const base = (rid: string) => `/api/tech/jobs/${rid}/estimates`;

/** The estimates POST route's run body. */
function createVia(rid: string, key: string, body: CreateBody): Promise<RunOut> {
  return idem.withIdempotency(scope(base(rid), key), idem.canonicalHash(body), async (ids) => {
    const r = await ew.createFieldEstimate(actor(rid), { estimateId: ids.id("estimate") }, body);
    if (!r.ok) return estimateReasonResult(r.reason);
    return okResult(r.created ? 201 : 200, { estimateId: r.estimateId, created: r.created });
  });
}

/** The sell route's run body. */
function sellVia(rid: string, eid: string, key: string, body: { optionId: string; signatureName: string }): Promise<RunOut> {
  return idem.withIdempotency(scope(`${base(rid)}/${eid}/sell`, key), idem.canonicalHash(body), async () => {
    const r = await ew.sellFieldEstimate(actor(rid), { estimateId: eid, ...body });
    if (!r.ok) return estimateReasonResult(r.reason);
    return okResult(200, { estimateId: r.estimateId, status: "sold", created: r.created });
  });
}

/** The bill route's run body. */
function billVia(rid: string, eid: string, key: string): Promise<RunOut> {
  return idem.withIdempotency(scope(`${base(rid)}/${eid}/bill`, key), idem.canonicalHash({}), async (ids) => {
    const r = await fw.billSoldEstimate(actor(rid), eid, { invoiceId: ids.id("invoice") });
    if (!r.ok) return estimateReasonResult(r.reason, r.reason === "already_billed" && r.invoiceId ? { invoiceId: r.invoiceId } : undefined);
    return okResult(200, { invoiceId: r.invoiceId, added: r.added, hasMaterials: r.hasMaterials });
  });
}

/** The decline route's run body. */
function declineVia(rid: string, eid: string, key: string): Promise<RunOut> {
  return idem.withIdempotency(scope(`${base(rid)}/${eid}/decline`, key), idem.canonicalHash({}), async () => {
    const r = await ew.declineFieldEstimate(actor(rid), eid);
    if (!r.ok) return estimateReasonResult(r.reason);
    return okResult(200, { estimateId: r.estimateId, status: "dismissed", created: r.created });
  });
}

/** The equipment POST route's run body. */
function equipVia(rid: string, key: string, raw: Record<string, string>): Promise<RunOut> {
  const parsed = parseEquipmentInput(raw, todayInZone(new Date()));
  if (!parsed.ok) throw new Error(`bad fixture: ${parsed.error}`);
  return idem.withIdempotency(scope(`/api/tech/jobs/${rid}/equipment`, key), idem.canonicalHash(raw), async (ids) => {
    const r = await qw.addFieldEquipment(actor(rid), { equipmentId: ids.id("equipment") }, parsed.value);
    if (!r.ok) return equipmentReasonResult(r.reason);
    return okResult(r.created ? 201 : 200, { equipmentId: r.equipmentId, created: r.created });
  });
}

const data = (r: RunOut): Row => {
  if (!r.envelope.success) throw new Error(`expected success, got ${JSON.stringify(r.envelope)}`);
  return r.envelope.data;
};
const code = (r: RunOut): string | undefined => (r.envelope.success ? undefined : r.envelope.error.code);
const details = (r: RunOut): unknown => (r.envelope.success ? undefined : r.envelope.error.details);

const TWO = (good = 1, better = 1): CreateBody => ({ options: [
  { name: "Good", lines: [{ pricebookItemId: itemA, quantity: good }] },
  { name: "Better", lines: [{ pricebookItemId: itemA, quantity: better }, { pricebookItemId: itemB, quantity: 1 }] },
] });

async function optionIds(eid: string): Promise<string[]> {
  return (await run(sql`SELECT id FROM estimate_options WHERE estimate_id = ${eid} AND organization_id = ${org} ORDER BY sort_order`)).map((r) => String(r.id));
}

/** Build TWO() and sell Better. */
async function soldEstimate(rid: string): Promise<{ eid: string; good: string; better: string }> {
  const eid = data(await createVia(rid, randomUUID(), TWO())).estimateId as string;
  const [good, better] = await optionIds(eid);
  expect(data(await sellVia(rid, eid, randomUUID(), { optionId: better!, signatureName: "Pat Probe" })).created).toBe(true);
  return { eid, good: good!, better: better! };
}

async function estimateRow(eid: string): Promise<Row> {
  return (await run(sql`SELECT * FROM estimates WHERE id = ${eid} AND organization_id = ${org}`))[0]!;
}
async function invoiceRow(inv: string): Promise<Row> {
  return (await run(sql`SELECT * FROM invoices WHERE id = ${inv} AND organization_id = ${org}`))[0]!;
}
async function invoicesOf(rid: string): Promise<Row[]> {
  return run(sql`SELECT id, state, estimate_id FROM invoices WHERE service_request_id = ${rid} AND organization_id = ${org} ORDER BY created_at, id`);
}
async function linesOf(inv: string): Promise<Row[]> {
  return run(sql`SELECT id, estimate_line_item_id, job_material_id, line_total_cents FROM invoice_line_items WHERE invoice_id = ${inv} AND organization_id = ${org} ORDER BY created_at, id`);
}
async function view(rid: string) {
  const r = await tq.getTechEstimatesView(org, tech, rid);
  if (r.kind !== "ok") throw new Error(`view ${r.kind}`);
  return r.view;
}
async function estimateOf(rid: string, eid: string) {
  return (await view(rid)).estimates.find((e) => e.id === eid) ?? null;
}
async function notInvoicedIds(): Promise<string[]> {
  return (await eq.listEstimates(org, { bucket: "not_invoiced", limit: 500 })).estimates.map((e) => e.id);
}
/** create → one catalog line → finalize: the job's open invoice. */
async function openJobInvoice(rid: string): Promise<string> {
  const c = await fw.createInvoiceFromJob(actor(rid), { invoiceId: randomUUID() });
  if (!c.ok) throw new Error(c.reason);
  expect((await fw.addInvoiceLine(actor(rid), c.invoiceId, { lineId: randomUUID() }, { pricebookItemId: itemA, quantity: 1 })).ok).toBe(true);
  expect((await fw.finalizeInvoice(actor(rid), c.invoiceId)).ok).toBe(true);
  return c.invoiceId;
}

beforeAll(async () => {
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const m = line.match(/^([A-Z_0-9]+)=(.*)$/);
    if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.replace(/^"|"$/g, "");
  }
  const url = process.env.DATABASE_URL ?? "";
  if (!url) throw new Error("DATABASE_URL missing from .env.local");
  if (url.includes("ep-withered-hill")) throw new Error("Refusing to run against the production database");

  ({ sql } = await import("drizzle-orm"));
  ({ db } = await import("@/lib/db"));
  ew = await import("@/lib/tech/estimate-writes");
  fw = await import("@/lib/admin/invoice-field-writes");
  qw = await import("@/lib/tech/equipment-writes");
  iq = await import("@/lib/admin/invoice-queries");
  eq = await import("@/lib/admin/estimate-queries");
  tq = await import("@/lib/tech/estimate-queries");
  ti = await import("@/lib/tech/invoice-queries");
  te = await import("@/lib/tech/equipment-queries");
  idem = await import("@/lib/http/idempotency");
  ({ okResult } = await import("@/lib/tech/invoice-write-route"));
  ({ estimateReasonResult } = await import("@/lib/tech/estimate-errors"));
  ({ equipmentReasonResult } = await import("@/lib/tech/equipment-errors"));
  ({ parseEquipmentInput, todayInZone } = await import("@/lib/tech/equipment-input"));
  const { createOrgCore } = await import("@/lib/admin/provisioning");
  const { encrypt } = await import("@/lib/crypto");
  const { getDefaultTaxBps } = await import("@/lib/admin/pricebook-queries");

  const mkOrg = async (label: string) => {
    const out = await createOrgCore({
      name: `Probe Org Field Estimate ${label} ${randomUUID().slice(0, 8)}`,
      createdBy: null,
      ownerEmail: null,
      ownerUser: { email: `owner-${randomUUID()}@throwaway.example`, name: "Probe Owner", googleId: `probe-${randomUUID()}` },
      skipOrgCountCheck: true,
    });
    if (!out.ok) throw new Error(`createOrgCore failed: ${JSON.stringify(out.error)}`);
    return out.result.organizationId;
  };
  org = await mkOrg("A");
  org2 = await mkOrg("B");
  tech = (await run(sql`INSERT INTO users (organization_id,email,name,role,password_hash,is_active)
    VALUES (${org},'tech-'||gen_random_uuid()||'@throwaway.example','Probe Technician','technician','x',true) RETURNING id`))[0]!.id as string;
  cust = (await run(sql`INSERT INTO customers (organization_id,name_encrypted) VALUES (${org},${encrypt("Pat Probe")}) RETURNING id`))[0]!.id as string;
  itemA = (await run(sql`INSERT INTO pricebook_items (organization_id,type,name,cost_cents,price_cents,active)
    VALUES (${org},'service'::pricebook_item_type,'Probe capacitor',4000,12500,true) RETURNING id`))[0]!.id as string;
  itemB = (await run(sql`INSERT INTO pricebook_items (organization_id,type,name,cost_cents,price_cents,active)
    VALUES (${org},'service'::pricebook_item_type,'Probe fan motor',21000,48000,true) RETURNING id`))[0]!.id as string;
  await db.execute(sql`INSERT INTO tax_rates (organization_id,name,rate_bps,is_default,active) VALUES (${org},'Probe tax',825,true,true) ON CONFLICT DO NOTHING`);
  taxBps = await getDefaultTaxBps(org);
}, 90_000);

afterAll(async () => {
  for (const id of [org, org2].filter(Boolean)) {
    try {
      await db.execute(sql`DELETE FROM organizations WHERE id = ${id}`);
    } catch (error) {
      console.error(`afterAll: could not delete probe org ${id}`, error);
    }
  }
}, 60_000);

describe("field estimates (dev DB)", () => {
  it("(a) create: two options, v7 ids in build order, total = max, re-run creates nothing; no customer → NO_CUSTOMER", async () => {
    const rid = await newJob();
    const key = randomUUID();
    const r = await createVia(rid, key, TWO(2, 1));
    expect(r.status).toBe(201);
    const eid = data(r).estimateId as string;
    const opts = await run(sql`SELECT id, name, total_cents FROM estimate_options WHERE estimate_id = ${eid} AND organization_id = ${org} ORDER BY sort_order`);
    expect(opts.map((o) => o.name)).toEqual(["Good", "Better"]);
    expect(String(opts[0]!.id) < String(opts[1]!.id)).toBe(true);
    const lines = await run(sql`SELECT option_id FROM estimate_line_items WHERE option_id IN (${opts[0]!.id}, ${opts[1]!.id}) AND organization_id = ${org} ORDER BY id`);
    expect(lines.map((l) => l.option_id)).toEqual([opts[0]!.id, opts[1]!.id, opts[1]!.id]);
    expect(Number(opts[1]!.total_cents)).toBe(60_500 + Math.round((60_500 * taxBps) / 10000));
    const est = await estimateRow(eid);
    expect(Number(est.total_cents)).toBe(Math.max(...opts.map((o) => Number(o.total_cents))));
    expect(est).toMatchObject({ status: "open", title: "Field estimate", approval_token_hash: null, customer_id: cust, sold_via: null });

    const again = await createVia(rid, key, TWO(2, 1));
    expect([again.status, again.replayed]).toEqual([201, true]);
    expect(await ew.createFieldEstimate(actor(rid), { estimateId: eid }, TWO(2, 1))).toEqual({ ok: true, estimateId: eid, created: false });
    const [{ n }] = await run(sql`SELECT count(*)::int AS n FROM estimate_options WHERE estimate_id = ${eid} AND organization_id = ${org}`) as [{ n: number }];
    expect(n).toBe(2);

    const bare = await newJob({ customer: false });
    const nc = await createVia(bare, randomUUID(), TWO());
    expect([nc.status, code(nc)]).toEqual([409, "NO_CUSTOMER"]);
  }, 60_000);

  it("(b) sell: field sale; same option + same technician + any name → success; other option / portal-sold → ALREADY_DECIDED", async () => {
    const rid = await newJob();
    const eid = data(await createVia(rid, randomUUID(), TWO())).estimateId as string;
    const [good, better] = await optionIds(eid);
    const s = await sellVia(rid, eid, randomUUID(), { optionId: better!, signatureName: "Pat Probe" });
    expect([s.status, data(s)]).toEqual([200, { estimateId: eid, status: "sold", created: true }]);
    expect(await estimateRow(eid)).toMatchObject({ status: "sold", sold_option_id: better, sold_via: "field", sold_by: tech, signature_name: "Pat Probe", signature_ip: null });

    const again = await sellVia(rid, eid, randomUUID(), { optionId: better!, signatureName: "Someone Else" });
    expect([again.status, data(again).created]).toEqual([200, false]);
    expect((await estimateRow(eid)).signature_name).toBe("Pat Probe");
    expect(code(await sellVia(rid, eid, randomUUID(), { optionId: good!, signatureName: "Pat" }))).toBe("ALREADY_DECIDED");

    const eid2 = data(await createVia(rid, randomUUID(), TWO())).estimateId as string;
    const [, b2] = await optionIds(eid2);
    await db.execute(sql`UPDATE estimates SET status = 'sold'::estimate_status, sold_option_id = ${b2!}, sold_via = 'portal', signed_at = now(), signature_name = 'Pat'
      WHERE id = ${eid2} AND organization_id = ${org}`);
    expect(code(await sellVia(rid, eid2, randomUUID(), { optionId: b2!, signatureName: "Pat" }))).toBe("ALREADY_DECIDED");
  }, 60_000);

  it("(c) bill: lines once with links; totals = Σ lines + tax; same key replays; a new key → ALREADY_BILLED, no new invoice", async () => {
    const rid = await newJob();
    const { eid, better } = await soldEstimate(rid);
    expect(await notInvoicedIds()).toContain(eid);
    const key = randomUUID();
    const b = await billVia(rid, eid, key);
    expect(b.status).toBe(200);
    expect(data(b)).toMatchObject({ added: 2, hasMaterials: false });
    const inv = data(b).invoiceId as string;
    const sold = await run(sql`SELECT id FROM estimate_line_items WHERE option_id = ${better} AND organization_id = ${org} ORDER BY id`);
    const lines = await linesOf(inv);
    expect(lines.map((l) => l.estimate_line_item_id)).toEqual(sold.map((s) => s.id));
    const sum = lines.reduce((s, l) => s + Number(l.line_total_cents), 0);
    expect(await invoiceRow(inv)).toMatchObject({ state: "draft", subtotal_cents: sum, total_cents: sum + Math.round((sum * taxBps) / 10000) });
    expect(await notInvoicedIds()).not.toContain(eid);
    expect((await estimateOf(rid, eid))?.billing).toBe("job");

    const replay = await billVia(rid, eid, key);
    expect([replay.status, replay.replayed]).toEqual([200, true]);
    const fresh = await billVia(rid, eid, randomUUID());
    expect([fresh.status, code(fresh), details(fresh)]).toEqual([409, "ALREADY_BILLED", { invoiceId: inv }]);
    expect(await invoicesOf(rid)).toHaveLength(1);
    expect(await linesOf(inv)).toHaveLength(2);
  }, 60_000);

  it("(d) two concurrent bills with different keys and no draft → one draft, lines once", async () => {
    const rid = await newJob();
    const { eid } = await soldEstimate(rid);
    // One retry each on an unstored STALE (a transient 40P01 deadlock under load), with a new key.
    const billOnce = async (): Promise<RunOut> => {
      const r = await billVia(rid, eid, randomUUID());
      return code(r) === "STALE" ? billVia(rid, eid, randomUUID()) : r;
    };
    const [a, b] = await Promise.all([billOnce(), billOnce()]);
    expect([a.status, b.status].sort()).toEqual([200, 409]);
    expect([code(a), code(b)].filter(Boolean)).toEqual(["ALREADY_BILLED"]);
    const invs = await invoicesOf(rid);
    expect(invs).toHaveLength(1);
    expect(invs[0]!.state).toBe("draft");
    expect((await linesOf(String(invs[0]!.id))).filter((l) => l.estimate_line_item_id !== null)).toHaveLength(2);
  }, 60_000);

  it("(d2) the in-batch guard alone: billLinesSql run twice with the pre-check skipped → the second inserts nothing", async () => {
    const rid = await newJob();
    const { eid, better } = await soldEstimate(rid);
    const c = await fw.createInvoiceFromJob(actor(rid), { invoiceId: randomUUID() });
    if (!c.ok) throw new Error(c.reason);
    const sold = await run(sql`SELECT id FROM estimate_line_items WHERE option_id = ${better} AND organization_id = ${org} ORDER BY id`);
    // Fresh ids every run, exactly like a re-run of step 3: only NOT billed(eid) can stop the second.
    const stmt = () => fw.billLinesSql({ org, rid, me: tech, inv: c.invoiceId, estimateId: eid, lines: sold.map((l) => ({ id: randomUUID(), eli: String(l.id) })) });
    expect((await db.execute(stmt())).rows).toHaveLength(2);
    expect((await db.execute(stmt())).rows).toHaveLength(0);
    expect((await linesOf(c.invoiceId)).filter((l) => l.estimate_line_item_id !== null)).toHaveLength(2);
  }, 60_000);

  it("(d3) this key's derived invoice was voided → stored INVOICE_CHANGED; the same key replays it; a new key bills (ruling 11)", async () => {
    const rid = await newJob();
    const { eid } = await soldEstimate(rid);
    const key = randomUUID();
    const derived = idem.derivedId(scope(`${base(rid)}/${eid}/bill`, key), "invoice");
    expect(await fw.createInvoiceFromJob(actor(rid), { invoiceId: derived })).toMatchObject({ ok: true, invoiceId: derived, created: true });
    await db.execute(sql`UPDATE invoices SET state = 'void'::invoice_state WHERE id = ${derived} AND organization_id = ${org}`);
    const r = await billVia(rid, eid, key);
    expect([r.status, code(r)]).toEqual([409, "INVOICE_CHANGED"]);
    const again = await billVia(rid, eid, key);
    expect([again.replayed, code(again)]).toEqual([true, "INVOICE_CHANGED"]);
    const fresh = await billVia(rid, eid, randomUUID());
    expect(fresh.status).toBe(200);
    expect(data(fresh).invoiceId).not.toBe(derived);
  }, 60_000);

  it("(e) office Generate after a field bill returns the field invoice (draft and after finalize)", async () => {
    const rid = await newJob();
    const { eid } = await soldEstimate(rid);
    const inv = data(await billVia(rid, eid, randomUUID())).invoiceId as string;
    expect(await iq.createInvoiceFromSoldEstimate(org, eid)).toEqual({ ok: true, invoiceId: inv, created: false });
    expect((await fw.finalizeInvoice(actor(rid), inv)).ok).toBe(true);
    expect(await iq.createInvoiceFromSoldEstimate(org, eid)).toEqual({ ok: true, invoiceId: inv, created: false });
    expect(await invoicesOf(rid)).toHaveLength(1);
  }, 60_000);

  it("(f)(r) office invoice first → field bill ALREADY_BILLED, billing office; voided → filter drops it, Generate returns the void invoice, billing none, a field bill works", async () => {
    const rid = await newJob();
    const { eid } = await soldEstimate(rid);
    const office = await iq.createInvoiceFromSoldEstimate(org, eid);
    if (!office.ok) throw new Error(office.reason);
    expect((await linesOf(office.invoiceId)).every((l) => l.estimate_line_item_id !== null)).toBe(true);
    const refused = await billVia(rid, eid, randomUUID());
    expect([code(refused), details(refused)]).toEqual(["ALREADY_BILLED", { invoiceId: office.invoiceId }]);
    expect((await estimateOf(rid, eid))?.billing).toBe("office");
    expect(await notInvoicedIds()).not.toContain(eid);

    await db.execute(sql`UPDATE invoices SET state = 'void'::invoice_state WHERE id = ${office.invoiceId} AND organization_id = ${org}`);
    expect(await notInvoicedIds()).not.toContain(eid);
    expect(await iq.createInvoiceFromSoldEstimate(org, eid)).toEqual({ ok: true, invoiceId: office.invoiceId, created: false });
    expect((await estimateOf(rid, eid))?.billing).toBe("none");
    const field = await billVia(rid, eid, randomUUID());
    expect(field.status).toBe(200);
    expect(data(field).invoiceId).not.toBe(office.invoiceId);
    expect((await estimateOf(rid, eid))?.billing).toBe("job");
  }, 60_000);

  it("(f) billing precedence: office beats job when both halves hold (synthetic office row)", async () => {
    const rid = await newJob();
    const { eid } = await soldEstimate(rid);
    expect(data(await billVia(rid, eid, randomUUID())).added).toBe(2);
    await db.execute(sql`INSERT INTO invoices (organization_id,service_request_id,customer_id,estimate_id,state) VALUES (${org},${rid},${cust},${eid},'open'::invoice_state)`);
    expect((await estimateOf(rid, eid))?.billing).toBe("office");
  }, 60_000);

  it("(g) the job's invoice is open and the estimate unbilled → INVOICE_LOCKED (stored), no draft created", async () => {
    const rid = await newJob();
    await openJobInvoice(rid);
    const { eid } = await soldEstimate(rid);
    const key = randomUUID();
    const r = await billVia(rid, eid, key);
    expect([r.status, code(r)]).toEqual([409, "INVOICE_LOCKED"]);
    expect((await invoicesOf(rid)).map((i) => i.state)).toEqual(["open"]);
    const [k] = await run(sql`SELECT state FROM idempotency_keys WHERE organization_id = ${org} AND user_id = ${tech} AND route = ${`${base(rid)}/${eid}/bill`} AND key = ${key}`);
    expect(k!.state).toBe("done");
    expect((await view(rid)).jobInvoice).toMatchObject({ state: "open", hasPayment: false });
  }, 60_000);

  it("(h) two sold estimates on one request bill independently onto the same draft", async () => {
    const rid = await newJob();
    const one = await soldEstimate(rid);
    const two = await soldEstimate(rid);
    expect((await view(rid)).hasOtherSold).toBe(true);
    const a = await billVia(rid, one.eid, randomUUID());
    const b = await billVia(rid, two.eid, randomUUID());
    expect(data(a).invoiceId).toBe(data(b).invoiceId);
    expect((await linesOf(data(a).invoiceId as string)).filter((l) => l.estimate_line_item_id !== null)).toHaveLength(4);
    expect(code(await billVia(rid, one.eid, randomUUID()))).toBe("ALREADY_BILLED");
    expect(code(await billVia(rid, two.eid, randomUUID()))).toBe("ALREADY_BILLED");
  }, 60_000);

  it("(i) equipment: replace retires and links; replays; a second key → EQUIPMENT_RETIRED; location rule both ways; FieldPulse unit refused", async () => {
    const L1 = randomUUID();
    const L2 = randomUUID();
    const rid = await newJob({ locationId: L1 });
    const located = await unit({ locationId: L1, make: "Carrier" });
    const unlocated = await unit({ locationId: null });
    const elsewhere = await unit({ locationId: L2 });
    const fp = await unit({ locationId: L1, fieldpulseAssetId: `fp-${randomUUID()}` });
    const v = await te.getTechEquipmentView(org, tech, rid);
    if (v.kind !== "ok") throw new Error(v.kind);
    const listed = v.view.units.map((u) => u.id);
    expect(listed).toEqual(expect.arrayContaining([located, unlocated, fp]));
    expect(listed).not.toContain(elsewhere);
    expect(v.view.canWrite).toBe(true);
    expect(v.view.units.find((u) => u.id === fp)?.managedExternally).toBe(true);

    const key = randomUUID();
    const body = { equipmentType: "ac", make: "Trane", replacesId: unlocated };
    const r = await equipVia(rid, key, body);
    expect(r.status).toBe(201);
    const neu = data(r).equipmentId as string;
    const [old] = await run(sql`SELECT retired_at, replaced_by_equipment_id FROM customer_equipment WHERE id = ${unlocated} AND organization_id = ${org}`);
    expect(old!.retired_at).not.toBeNull();
    expect(old!.replaced_by_equipment_id).toBe(neu);
    const [n] = await run(sql`SELECT location_id, retired_at, customer_id FROM customer_equipment WHERE id = ${neu} AND organization_id = ${org}`);
    expect(n).toMatchObject({ location_id: L1, retired_at: null, customer_id: cust });

    expect((await equipVia(rid, key, body)).replayed).toBe(true);
    const parsed = parseEquipmentInput(body, todayInZone(new Date()));
    if (!parsed.ok) throw new Error("fixture");
    expect(await qw.addFieldEquipment(actor(rid), { equipmentId: neu }, parsed.value)).toEqual({ ok: true, equipmentId: neu, created: false, replaced: true });
    expect(code(await equipVia(rid, randomUUID(), body))).toBe("EQUIPMENT_RETIRED");
    expect(code(await equipVia(rid, randomUUID(), { equipmentType: "ac", replacesId: fp }))).toBe("MANAGED_EXTERNALLY");
    expect(code(await equipVia(rid, randomUUID(), { equipmentType: "ac", replacesId: elsewhere }))).toBe("NOT_FOUND");

    const after = await te.getTechEquipmentView(org, tech, rid);
    if (after.kind !== "ok") throw new Error(after.kind);
    expect(after.view.units.map((u) => u.id)).not.toContain(unlocated);

    const rid2 = await newJob({ locationId: null });
    expect((await equipVia(rid2, randomUUID(), { equipmentType: "furnace", replacesId: elsewhere })).status).toBe(201);
  }, 60_000);

  it("(j) tenancy: another org's estimate or equipment id → NOT_FOUND", async () => {
    const rid = await newJob();
    const foreignEst = (await run(sql`INSERT INTO estimates (organization_id,status,total_cents) VALUES (${org2},'open'::estimate_status,100) RETURNING id`))[0]!.id as string;
    const foreignOpt = (await run(sql`INSERT INTO estimate_options (organization_id,estimate_id,name,subtotal_cents,tax_cents,total_cents)
      VALUES (${org2},${foreignEst},'Good',100,0,100) RETURNING id`))[0]!.id as string;
    expect(code(await sellVia(rid, foreignEst, randomUUID(), { optionId: foreignOpt, signatureName: "Pat" }))).toBe("NOT_FOUND");
    expect(code(await billVia(rid, foreignEst, randomUUID()))).toBe("NOT_FOUND");
    expect(code(await declineVia(rid, foreignEst, randomUUID()))).toBe("NOT_FOUND");
    const { encrypt } = await import("@/lib/crypto");
    const foreignCust = (await run(sql`INSERT INTO customers (organization_id,name_encrypted) VALUES (${org2},${encrypt("Other Org")}) RETURNING id`))[0]!.id as string;
    const foreignUnit = await unit({ locationId: null, customerId: foreignCust, orgId: org2 });
    expect(code(await equipVia(rid, randomUUID(), { equipmentType: "ac", replacesId: foreignUnit }))).toBe("NOT_FOUND");
    const [fu] = await run(sql`SELECT retired_at FROM customer_equipment WHERE id = ${foreignUnit} AND organization_id = ${org2}`);
    expect(fu!.retired_at).toBeNull();
  }, 60_000);

  it("(j2) same org: another request's estimate or another customer's unit → NOT_FOUND", async () => {
    const ridA = await newJob();
    const ridB = await newJob();
    const sold = await soldEstimate(ridB);
    const openEid = data(await createVia(ridB, randomUUID(), TWO())).estimateId as string;
    const [openOpt] = await optionIds(openEid);
    expect(code(await sellVia(ridA, openEid, randomUUID(), { optionId: openOpt!, signatureName: "Pat" }))).toBe("NOT_FOUND");
    expect(code(await billVia(ridA, sold.eid, randomUUID()))).toBe("NOT_FOUND");
    expect(code(await declineVia(ridA, openEid, randomUUID()))).toBe("NOT_FOUND");
    expect((await estimateRow(openEid)).status).toBe("open");
    expect(await invoicesOf(ridA)).toHaveLength(0);
    const { encrypt } = await import("@/lib/crypto");
    const otherCust = (await run(sql`INSERT INTO customers (organization_id,name_encrypted) VALUES (${org},${encrypt("Other Customer")}) RETURNING id`))[0]!.id as string;
    const theirs = await unit({ locationId: null, customerId: otherCust });
    expect(code(await equipVia(ridA, randomUUID(), { equipmentType: "ac", replacesId: theirs }))).toBe("NOT_FOUND");
  }, 60_000);

  it("(k) expired → ESTIMATE_EXPIRED; decline → dismissed, replay → success, then sell → ALREADY_DECIDED", async () => {
    const rid = await newJob();
    const eid = data(await createVia(rid, randomUUID(), TWO())).estimateId as string;
    const [good] = await optionIds(eid);
    await db.execute(sql`UPDATE estimates SET expires_at = now() - interval '1 minute' WHERE id = ${eid} AND organization_id = ${org}`);
    expect(code(await sellVia(rid, eid, randomUUID(), { optionId: good!, signatureName: "Pat" }))).toBe("ESTIMATE_EXPIRED");
    expect((await estimateOf(rid, eid))?.status).toBe("expired");

    const eid2 = data(await createVia(rid, randomUUID(), TWO())).estimateId as string;
    const [g2] = await optionIds(eid2);
    expect(data(await declineVia(rid, eid2, randomUUID()))).toEqual({ estimateId: eid2, status: "dismissed", created: true });
    expect((await estimateRow(eid2)).status).toBe("dismissed");
    expect(data(await declineVia(rid, eid2, randomUUID()))).toEqual({ estimateId: eid2, status: "dismissed", created: false });
    expect(code(await sellVia(rid, eid2, randomUUID(), { optionId: g2!, signatureName: "Pat" }))).toBe("ALREADY_DECIDED");
    expect((await estimateOf(rid, eid2))?.status).toBe("declined");
  }, 60_000);

  it("(l) materials logged before the sale, no draft → the bill's draft holds the materials and the estimate lines", async () => {
    const rid = await newJob();
    const m = await addMaterial(rid, 1, 3_000);
    const { eid } = await soldEstimate(rid);
    const b = await billVia(rid, eid, randomUUID());
    expect(data(b)).toMatchObject({ added: 2, hasMaterials: true });
    const lines = await linesOf(data(b).invoiceId as string);
    expect(lines.filter((l) => l.job_material_id === m)).toHaveLength(1);
    expect(lines.filter((l) => l.estimate_line_item_id !== null)).toHaveLength(2);
  }, 60_000);

  it("(m) an estimate-linked line can't be removed in the field (FROM_ESTIMATE) nor its estimate line deleted (FK)", async () => {
    const rid = await newJob();
    const { eid } = await soldEstimate(rid);
    const inv = data(await billVia(rid, eid, randomUUID())).invoiceId as string;
    const [l] = (await linesOf(inv)).filter((x) => x.estimate_line_item_id !== null);
    expect(await fw.removeInvoiceLine(actor(rid), inv, String(l!.id))).toEqual({ ok: false, reason: "from_estimate" });
    expect(await linesOf(inv)).toHaveLength(2);
    let caught: unknown = null;
    try {
      await db.execute(sql`DELETE FROM estimate_line_items WHERE id = ${String(l!.estimate_line_item_id)} AND organization_id = ${org}`);
    } catch (error) {
      caught = error;
    }
    expect(caught).not.toBeNull();
  }, 60_000);

  it("(n) a zero-line sold estimate → NO_LINES, no invoice", async () => {
    const rid = await newJob();
    const est = (await run(sql`INSERT INTO estimates (organization_id,service_request_id,customer_id,status,total_cents)
      VALUES (${org},${rid},${cust},'sold'::estimate_status,0) RETURNING id`))[0]!.id as string;
    const opt = (await run(sql`INSERT INTO estimate_options (organization_id,estimate_id,name,subtotal_cents,tax_cents,total_cents)
      VALUES (${org},${est},'Good',0,0,0) RETURNING id`))[0]!.id as string;
    await db.execute(sql`UPDATE estimates SET sold_option_id = ${opt} WHERE id = ${est} AND organization_id = ${org}`);
    expect(code(await billVia(rid, est, randomUUID()))).toBe("NO_LINES");
    expect(await invoicesOf(rid)).toHaveLength(0);
  }, 60_000);

  it("(o) a draft with a recorded payment → INVOICE_LOCKED, nothing added", async () => {
    const rid = await newJob();
    const c = await fw.createInvoiceFromJob(actor(rid), { invoiceId: randomUUID() });
    if (!c.ok) throw new Error(c.reason);
    await db.execute(sql`UPDATE invoices SET amount_paid_cents = 100 WHERE id = ${c.invoiceId} AND organization_id = ${org}`);
    const { eid } = await soldEstimate(rid);
    expect((await view(rid)).jobInvoice).toMatchObject({ id: c.invoiceId, state: "draft", hasPayment: true });
    expect(code(await billVia(rid, eid, randomUUID()))).toBe("INVOICE_LOCKED");
    expect((await linesOf(c.invoiceId)).filter((l) => l.estimate_line_item_id !== null)).toHaveLength(0);
  }, 60_000);

  it("(p) the job's earlier invoice paid, no live invoice → the bill creates a new draft with the sale", async () => {
    const rid = await newJob();
    const first = await openJobInvoice(rid);
    await db.execute(sql`UPDATE invoices SET state = 'paid'::invoice_state, amount_paid_cents = total_cents WHERE id = ${first} AND organization_id = ${org}`);
    const { eid } = await soldEstimate(rid);
    const v = await view(rid);
    expect([v.jobInvoice, v.priorInvoicePaid]).toEqual([null, true]);
    const b = await billVia(rid, eid, randomUUID());
    expect(b.status).toBe(200);
    expect(data(b).invoiceId).not.toBe(first);
    expect((await invoiceRow(data(b).invoiceId as string)).state).toBe("draft");
  }, 60_000);

  it("(s) estimate-linked lines read fromEstimate in the tech invoice view", async () => {
    const rid = await newJob();
    const m = await addMaterial(rid, 1, 3_000);
    const { eid } = await soldEstimate(rid);
    expect(data(await billVia(rid, eid, randomUUID())).added).toBe(2);
    const r = await ti.getTechInvoiceView(org, tech, rid);
    if (r.kind !== "ok" || !r.view.invoice || !("lines" in r.view.invoice)) throw new Error("expected the lead's full invoice");
    expect(r.view.invoice.lines.map((l) => l.fromEstimate).sort()).toEqual([false, true, true]);
    expect(m).toBeTruthy();
  }, 60_000);

  it("(t) an in-flight estimate or equipment key does not set the invoice view's pendingWrite; an invoice key does", async () => {
    const rid = await newJob();
    for (const route of [base(rid), `/api/tech/jobs/${rid}/equipment`]) {
      await db.execute(sql`INSERT INTO idempotency_keys (organization_id,user_id,route,key,request_hash,state,attempt_id)
        VALUES (${org},${tech},${route},${randomUUID()},'h','in_progress',${randomUUID()})`);
    }
    const before = await ti.getTechInvoiceView(org, tech, rid);
    if (before.kind !== "ok") throw new Error(before.kind);
    expect(before.view.pendingWrite).toBe(false);
    await db.execute(sql`INSERT INTO idempotency_keys (organization_id,user_id,route,key,request_hash,state,attempt_id)
      VALUES (${org},${tech},${`/api/tech/jobs/${rid}/invoice/finalize`},${randomUUID()},'h','in_progress',${randomUUID()})`);
    const after = await ti.getTechInvoiceView(org, tech, rid);
    if (after.kind !== "ok") throw new Error(after.kind);
    expect(after.view.pendingWrite).toBe(true);
  }, 60_000);

  it("migration 0057 applies twice, statement by statement", async () => {
    const statements = readFileSync("drizzle/0057_m3c_sell_on_site.sql", "utf8").split("--> statement-breakpoint").map((s) => s.trim()).filter(Boolean);
    expect(statements.length).toBe(7);
    for (let pass = 0; pass < 2; pass++) {
      for (const stmt of statements) await db.execute(sql.raw(stmt));
    }
  }, 60_000);
});
