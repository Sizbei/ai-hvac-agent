import { describe, it, expect, vi, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

const { readQueue, batch, getDefaultTaxBps } = vi.hoisted(() => ({
  readQueue: [] as unknown[][],
  batch: vi.fn(),
  getDefaultTaxBps: vi.fn(),
}));
vi.mock("@/lib/db", () => ({
  db: {
    execute: (q: unknown) => ({
      __sql: q,
      then: (ok: (v: unknown) => unknown, err: (e: unknown) => unknown) =>
        Promise.resolve({ rows: readQueue.shift() ?? [] }).then(ok, err),
    }),
    batch,
  },
}));
vi.mock("@/lib/admin/pricebook-queries", () => ({ getDefaultTaxBps, getPricebookItemById: vi.fn() }));

import {
  createFieldEstimate, createOutcome, declineFieldEstimate, declineOutcome, sellFieldEstimate, sellOutcome,
} from "./estimate-writes";

const ORG = "11111111-1111-4111-8111-111111111111";
const REQ = "22222222-2222-4222-8222-222222222222";
const ME = "33333333-3333-4333-8333-333333333333";
const EST = "44444444-4444-4444-8444-444444444444";
const OPT = "55555555-5555-4555-8555-555555555555";
const ITEM = "66666666-6666-4666-8666-666666666666";
const CUST = "77777777-7777-4777-8777-777777777777";
const actor = { organizationId: ORG, requestId: REQ, techUserId: ME };

const dialect = new PgDialect();
const renderQ = (q: unknown) => dialect.sqlToQuery(((q as { __sql?: unknown }).__sql ?? q) as SQL);
const render = (q: unknown) => renderQ(q).sql.replace(/\s+/g, " ").trim();
const stmts = (call = 0) => (batch.mock.calls[call]![0] as unknown[]).map(render);
const rowsOf = (...r: unknown[][]) => r.map((rows) => ({ rows }));

beforeEach(() => { readQueue.length = 0; batch.mockReset(); getDefaultTaxBps.mockResolvedValue(825); });

const body = { options: [{ name: "Good", lines: [{ pricebookItemId: ITEM, quantity: 2 }] }] };

describe("createFieldEstimate (spec §5.1)", () => {
  it("no customer → no_customer, nothing written", async () => {
    readQueue.push([{ customer_id: null }]);
    expect(await createFieldEstimate(actor, { estimateId: EST }, body)).toEqual({ ok: false, reason: "no_customer" });
    expect(batch).not.toHaveBeenCalled();
  });

  it("an inactive or missing item → item_inactive, nothing written", async () => {
    readQueue.push([{ customer_id: CUST }], []);
    expect(await createFieldEstimate(actor, { estimateId: EST }, body)).toEqual({ ok: false, reason: "item_inactive" });
    expect(batch).not.toHaveBeenCalled();
  });

  it("one batch: L_req → estimate gated on lead/status/customer → options and lines gated on its xmin → tail", async () => {
    readQueue.push([{ customer_id: CUST }], [{ id: ITEM, name: "Capacitor", price_cents: 12_500, cost_cents: 4_000 }]);
    batch.mockResolvedValueOnce(rowsOf([], [{ id: EST }], [], [], [{ still_lead: true, status: "arrived", customer_id: CUST, exists: true }]));
    expect(await createFieldEstimate(actor, { estimateId: EST }, body)).toEqual({ ok: true, estimateId: EST, created: true });
    const s = stmts();
    expect(s).toHaveLength(5);
    expect(s[0]).toContain("FROM service_requests WHERE id = $1::uuid AND organization_id = $2::uuid FOR NO KEY UPDATE");
    expect(s[1]).toMatch(/^INSERT INTO estimates \(id, organization_id, service_request_id, customer_id, status, total_cents, expires_at, title, approval_token_hash\)/);
    expect(s[1]).toContain("'open'::estimate_status");
    expect(s[1]).toContain("now() + interval '30 days', 'Field estimate', NULL");
    expect(s[1]).toContain("r.status IN ('arrived'::request_status, 'in_progress'::request_status, 'on_hold'::request_status) AND r.customer_id = $");
    expect(s[1]).toContain("a.is_lead");
    expect(s[1]).toContain("ON CONFLICT (id) DO NOTHING RETURNING id");
    for (const i of [2, 3]) expect(s[i]).toContain("WHERE EXISTS (SELECT 1 FROM estimates WHERE id = $");
    for (const i of [2, 3]) expect(s[i]).toContain("xmin = pg_current_xact_id()::xid)");
    expect(s[2]).toContain("FROM (VALUES ($");
    // headline total = the only option's total: 25,000 + 2,063 tax
    expect(renderQ((batch.mock.calls[0]![0] as unknown[])[1]).params).toContain(27_063);
  });

  it("zero rows map through createOutcome", async () => {
    readQueue.push([{ customer_id: CUST }], [{ id: ITEM, name: "Capacitor", price_cents: 12_500, cost_cents: 4_000 }]);
    batch.mockResolvedValueOnce(rowsOf([], [], [], [], [{ still_lead: true, status: "en_route", customer_id: CUST, exists: false }]));
    expect(await createFieldEstimate(actor, { estimateId: EST }, body)).toEqual({ ok: false, reason: "not_on_site" });
  });
});

describe("createOutcome", () => {
  const t = (over: Record<string, unknown>) => ({ still_lead: true, status: "arrived", customer_id: CUST, exists: false, ...over });
  it("an existing row with this id is a re-run, before every other answer", () =>
    expect(createOutcome(t({ exists: true, still_lead: false, status: "completed" }), EST)).toEqual({ ok: true, estimateId: EST, created: false }));
  it("then lead, status, customer", () => {
    expect(createOutcome(t({ still_lead: false }), EST)).toEqual({ ok: false, reason: "not_lead" });
    expect(createOutcome(t({ status: "scheduled" }), EST)).toEqual({ ok: false, reason: "not_on_site" });
    expect(createOutcome(t({ status: "completed" }), EST)).toEqual({ ok: false, reason: "job_closed" });
    expect(createOutcome(t({ customer_id: null }), EST)).toEqual({ ok: false, reason: "no_customer" });
    // the request now points at another customer: the job changed, not "no customer"
    expect(createOutcome(t({ customer_id: ITEM }), EST)).toEqual({ ok: false, reason: "stale" });
    expect(createOutcome(t({}), EST)).toEqual({ ok: false, reason: "stale" });
    expect(createOutcome(undefined, EST)).toEqual({ ok: false, reason: "stale" });
  });
});

describe("sellFieldEstimate (spec §5.2)", () => {
  it("one guarded UPDATE under L_req and the estimate row lock", async () => {
    batch.mockResolvedValueOnce(rowsOf([], [], [{ id: EST }], [], []));
    expect(await sellFieldEstimate(actor, { estimateId: EST, optionId: OPT, signatureName: "  Pat Probe " }))
      .toEqual({ ok: true, estimateId: EST, created: true });
    const s = stmts();
    expect(s[1]).toBe("SELECT 1 FROM estimates WHERE id = $1::uuid AND organization_id = $2::uuid FOR NO KEY UPDATE");
    expect(s[2]).toContain("SET status = 'sold'::estimate_status, sold_option_id = $1::uuid, signed_at = now(), signature_name = $2, signature_ip = NULL, sold_via = 'field', sold_by = $3::uuid, updated_at = now()");
    expect(s[2]).toContain("status = 'open'::estimate_status AND fieldpulse_estimate_id IS NULL AND (expires_at IS NULL OR expires_at > now())");
    expect(s[2]).toContain("EXISTS (SELECT 1 FROM estimate_options o WHERE o.id = $");
    expect(s[2]).toContain("r.status IN ('arrived'::request_status, 'in_progress'::request_status, 'on_hold'::request_status)");
    expect(renderQ((batch.mock.calls[0]![0] as unknown[])[2]).params).toContain("Pat Probe");
  });

  it("the sell UPDATE itself re-checks the lead and the request (the race after the preamble)", async () => {
    batch.mockResolvedValueOnce(rowsOf([], [], [{ id: EST }], [], []));
    await sellFieldEstimate(actor, { estimateId: EST, optionId: OPT, signatureName: "Pat Probe" });
    const s = stmts();
    expect(s[2]).toMatch(/^UPDATE estimates SET /);
    // The lead predicate, inside this UPDATE (not only the tail SELECT).
    expect(s[2]).toMatch(/AND \(EXISTS \(SELECT 1 FROM appointment_assignments a .* a\.technician_id = \$\d+::uuid AND a\.is_lead AND a\.status IN /);
    // Scoped to the route's request.
    expect(s[2]).toMatch(/WHERE id = \$\d+::uuid AND organization_id = \$\d+::uuid AND service_request_id = \$\d+::uuid AND status = 'open'::estimate_status/);
  });
});

describe("sellOutcome", () => {
  const ctx = { rid: REQ, me: ME, opt: OPT, eid: EST };
  const est = (over: Record<string, unknown>) => ({
    status: "open", service_request_id: REQ, sold_option_id: null, sold_via: null, sold_by: null,
    synced: false, past_expiry: false, option_ok: true, ...over,
  });
  const tail = { still_lead: true, request_status: "arrived" };
  it("missing or another request → estimate_not_found", () => {
    expect(sellOutcome(undefined, tail, ctx)).toEqual({ ok: false, reason: "estimate_not_found" });
    expect(sellOutcome(est({ service_request_id: CUST }), tail, ctx)).toEqual({ ok: false, reason: "estimate_not_found" });
  });
  it("our own field sale of this option is a replay, whatever name was typed", () =>
    expect(sellOutcome(est({ status: "sold", sold_option_id: OPT, sold_via: "field", sold_by: ME }), tail, ctx))
      .toEqual({ ok: true, estimateId: EST, created: false }));
  it("sellOutcome treats an uppercase optionId and technician id as the same sale", () => {
    // hex letters, so upper-casing really changes the strings; Postgres returns lower case
    const OPT_HEX = "abcdef01-2345-4abc-8def-abcdefabcdef";
    const ME_HEX = "fedcba98-7654-4fed-8cba-fedcbafedcba";
    const REQ_HEX = "abc12345-def6-4abc-8def-123456abcdef";
    for (const id of [OPT_HEX, ME_HEX, REQ_HEX]) expect(id.toUpperCase()).not.toBe(id);
    const row = est({ status: "sold", sold_option_id: OPT_HEX, sold_via: "field", sold_by: ME_HEX, service_request_id: REQ_HEX });
    // Without the toLowerCase() calls this is estimate_not_found / already_decided.
    expect(sellOutcome(row, tail, { eid: EST, opt: OPT_HEX.toUpperCase(), me: ME_HEX.toUpperCase(), rid: REQ_HEX.toUpperCase() }))
      .toEqual({ ok: true, estimateId: EST, created: false });
  });
  it("expired (stored or past expires_at) → estimate_expired", () => {
    expect(sellOutcome(est({ status: "expired" }), tail, ctx)).toEqual({ ok: false, reason: "estimate_expired" });
    expect(sellOutcome(est({ past_expiry: true }), tail, ctx)).toEqual({ ok: false, reason: "estimate_expired" });
  });
  it("any other decided state → already_decided (another option, portal, office, another technician, declined)", () => {
    for (const over of [
      { status: "sold", sold_option_id: CUST, sold_via: "field", sold_by: ME },
      { status: "sold", sold_option_id: OPT, sold_via: "portal", sold_by: null },
      // an admin who is also the lead marked this same option sold in the office
      { status: "sold", sold_option_id: OPT, sold_via: "office", sold_by: ME },
      { status: "sold", sold_option_id: OPT, sold_via: "field", sold_by: CUST },
      { status: "dismissed" },
    ]) expect(sellOutcome(est(over), tail, ctx)).toEqual({ ok: false, reason: "already_decided" });
  });
  it("then option, lead, request status", () => {
    expect(sellOutcome(est({ option_ok: false }), tail, ctx)).toEqual({ ok: false, reason: "invalid_option" });
    expect(sellOutcome(est({}), { still_lead: false, request_status: "arrived" }, ctx)).toEqual({ ok: false, reason: "not_lead" });
    expect(sellOutcome(est({}), { still_lead: true, request_status: "en_route" }, ctx)).toEqual({ ok: false, reason: "not_on_site" });
    expect(sellOutcome(est({}), { still_lead: true, request_status: "completed" }, ctx)).toEqual({ ok: false, reason: "job_closed" });
    expect(sellOutcome(est({}), tail, ctx)).toEqual({ ok: false, reason: "stale" });
  });
  it("a FieldPulse estimate → managed_externally", () =>
    expect(sellOutcome(est({ synced: true }), tail, ctx)).toEqual({ ok: false, reason: "managed_externally" }));
});

describe("declineFieldEstimate (spec §5.5)", () => {
  it("UPDATE to dismissed while open, native, of this request and lead", async () => {
    batch.mockResolvedValueOnce(rowsOf([], [{ id: EST }], [], []));
    expect(await declineFieldEstimate(actor, EST)).toEqual({ ok: true, estimateId: EST, created: true });
    const s = stmts();
    expect(s[1]).toContain("SET status = 'dismissed'::estimate_status, updated_at = now()");
    expect(s[1]).toContain("status = 'open'::estimate_status AND fieldpulse_estimate_id IS NULL AND (EXISTS (SELECT 1 FROM appointment_assignments");
    expect(s[1]).toMatch(/WHERE id = \$\d+::uuid AND organization_id = \$\d+::uuid AND service_request_id = \$\d+::uuid AND status = 'open'::estimate_status/);
  });
  it("declineOutcome: dismissed → replay; decided → already_decided; missing → 404; not lead", () => {
    const e = (over: Record<string, unknown>) => ({ status: "open", service_request_id: REQ, synced: false, ...over });
    const ctx = { rid: REQ, eid: EST };
    expect(declineOutcome(e({ status: "dismissed" }), { still_lead: true }, ctx)).toEqual({ ok: true, estimateId: EST, created: false });
    expect(declineOutcome(e({ status: "sold" }), { still_lead: true }, ctx)).toEqual({ ok: false, reason: "already_decided" });
    expect(declineOutcome(undefined, { still_lead: true }, ctx)).toEqual({ ok: false, reason: "estimate_not_found" });
    expect(declineOutcome(e({}), { still_lead: false }, ctx)).toEqual({ ok: false, reason: "not_lead" });
    expect(declineOutcome(e({}), { still_lead: true }, ctx)).toEqual({ ok: false, reason: "stale" });
  });
});
