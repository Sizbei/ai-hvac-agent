import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { seedVisibilityOrg, type VisibilityOrg } from "./visibility-fixture";

vi.mock("server-only", () => ({}));

/**
 * Sweep C (Task 12): invoices, estimates, payments, financing and the sales
 * report read only visible rows for an org user (VISIBLE_ONLY), and every row
 * for the platform owner (SHOW_ALL). Every money tile must equal the sum over
 * the rows the list shows. DEV database, one throwaway org
 * (visibility-fixture.ts), deleted in afterAll.
 *
 * Per set (fixture): invoice open 10000 / paid 2500 (balance 7500), a 2500
 * succeeded payment, an open 25000 estimate. Added here: a 500 refund on each
 * payment, each invoice billed from its set's estimate, one financing
 * application per estimate, both invoices overdue, plus a hidden dismissed
 * (lost) estimate and a visible sold estimate whose only invoice is hidden.
 */

type V = typeof import("@/lib/admin/visibility");

let fx: VisibilityOrg;
let v: V;
let inv: typeof import("@/lib/admin/invoice-queries");
let est: typeof import("@/lib/admin/estimate-queries");
let fin: typeof import("@/lib/admin/financing-queries");
let rep: typeof import("@/lib/admin/reporting-queries");
let lostHidden: string;
let soldVisible: string;
let soldVisibleInvoice: string;

beforeAll(async () => {
  fx = await seedVisibilityOrg();
  v = await import("@/lib/admin/visibility");
  inv = await import("@/lib/admin/invoice-queries");
  est = await import("@/lib/admin/estimate-queries");
  fin = await import("@/lib/admin/financing-queries");
  rep = await import("@/lib/admin/reporting-queries");
  const { db } = await import("@/lib/db");
  const { sql } = await import("drizzle-orm");
  const org = fx.org;

  const id = async (statement: ReturnType<typeof sql>): Promise<string> =>
    ((await db.execute(statement)).rows[0] as { id: string }).id;

  for (const set of [fx.visible, fx.hidden]) {
    await db.batch([
      db.execute(sql`INSERT INTO refunds (organization_id,payment_id,amount_cents,reason)
        VALUES (${org},${set.payment},500,'probe')`),
      db.execute(sql`UPDATE invoices SET estimate_id = ${set.estimate}, due_date = now() - interval '10 days'
        WHERE id = ${set.invoice} AND organization_id = ${org}`),
      db.execute(sql`INSERT INTO financing_applications (organization_id,customer_id,estimate_id,provider,requested_amount_cents)
        VALUES (${org},${set.customer},${set.estimate},'mock',7500)`),
    ]);
  }

  lostHidden = await id(sql`INSERT INTO estimates (organization_id,service_request_id,customer_id,status,total_cents)
    VALUES (${org},${fx.hidden.request},${fx.hidden.customer},'dismissed'::estimate_status,40000) RETURNING id`);
  soldVisible = await id(sql`INSERT INTO estimates (organization_id,service_request_id,customer_id,status,total_cents)
    VALUES (${org},${fx.visible.request},${fx.visible.customer},'sold'::estimate_status,0) RETURNING id`);
  soldVisibleInvoice = await id(sql`INSERT INTO invoices (organization_id,service_request_id,customer_id,estimate_id,state,subtotal_cents,total_cents,amount_paid_cents)
    VALUES (${org},${fx.visible.request},${fx.visible.customer},${soldVisible},'paid'::invoice_state,0,0,0) RETURNING id`);
  // Marking-style: UPDATE after insert, so no un-hide trigger fires on these.
  // The lost estimate's INSERT un-hid its request and customer; hide them again.
  await db.batch([
    db.execute(sql`UPDATE service_requests SET hidden_from_org = true WHERE id = ${fx.hidden.request} AND organization_id = ${org}`),
    db.execute(sql`UPDATE customers SET hidden_from_org = true WHERE id = ${fx.hidden.customer} AND organization_id = ${org}`),
    db.execute(sql`UPDATE estimates SET hidden_from_org = true WHERE id = ${lostHidden} AND organization_id = ${org}`),
    db.execute(sql`UPDATE invoices SET hidden_from_org = true WHERE id = ${soldVisibleInvoice} AND organization_id = ${org}`),
  ]);

  const flags = await db.execute(sql`SELECT
      (SELECT hidden_from_org FROM invoices WHERE id = ${fx.hidden.invoice}) AS i,
      (SELECT hidden_from_org FROM estimates WHERE id = ${fx.hidden.estimate}) AS e,
      (SELECT hidden_from_org FROM customers WHERE id = ${fx.hidden.customer}) AS c,
      (SELECT hidden_from_org FROM invoices WHERE id = ${fx.visible.invoice}) AS vi`);
  const row = flags.rows[0] as { i: boolean; e: boolean; c: boolean; vi: boolean };
  if (!(row.i && row.e && row.c) || row.vi) throw new Error("fixture: hidden flags changed during setup");
}, 60_000);

afterAll(async () => {
  await fx?.cleanup();
});

const ids = <T extends { id: string }>(rows: readonly T[]) => rows.map((r) => r.id).sort();
const balance = (rows: readonly { totalCents: number; amountPaidCents: number }[]) =>
  rows.reduce((s, r) => s + r.totalCents - r.amountPaidCents, 0);
/** A minute ahead of node's clock, so DB-stamped rows from just now are "before now". */
const soon = () => new Date(Date.now() + 60_000);

describe("visibility — invoices, estimates, payments, financing (sweep C)", () => {
  it("listInvoices rows and getInvoiceSummaryStats AR tiles exclude the hidden invoice", async () => {
    const run = async (vis: typeof v.SHOW_ALL) => {
      const open = await inv.listInvoices(fx.org, { state: "open" }, vis);
      const overdue = await inv.listInvoices(fx.org, { state: "open", overdue: true }, vis);
      const stats = await inv.getInvoiceSummaryStats(fx.org, vis);
      // Tiles are the sums over the rows the list shows.
      expect(stats.outstandingCents).toBe(balance(open.invoices));
      expect(stats.outstandingCount).toBe(open.total);
      expect(stats.overdueCents).toBe(balance(overdue.invoices));
      expect(stats.overdueCount).toBe(overdue.total);
      return { open: ids(open.invoices), total: open.total, stats };
    };

    const only = await run(v.VISIBLE_ONLY);
    expect(only.open).toEqual([fx.visible.invoice]);
    expect(only.total).toBe(1);
    expect(only.stats).toMatchObject({ outstandingCents: 7500, outstandingCount: 1, overdueCents: 7500, overdueCount: 1 });

    const all = await run(v.SHOW_ALL);
    expect(all.open).toEqual([fx.visible.invoice, fx.hidden.invoice].sort());
    expect(all.total).toBe(2);
    expect(all.stats).toMatchObject({ outstandingCents: 15000, outstandingCount: 2, overdueCents: 15000, overdueCount: 2 });
  });

  it("listInvoices search path skips the hidden invoice", async () => {
    const only = await inv.listInvoices(fx.org, { search: "pat " }, v.VISIBLE_ONLY);
    expect(ids(only.invoices)).toEqual([fx.visible.invoice]);
    expect(only.sourceCounts).toEqual({ native: 1 });

    const all = await inv.listInvoices(fx.org, { search: "pat " }, v.SHOW_ALL);
    expect(ids(all.invoices)).toEqual([fx.visible.invoice, fx.hidden.invoice, soldVisibleInvoice].sort());
    expect(all.sourceCounts).toEqual({ native: 3 });
  });

  it("listInvoices tab counts (whereClauseNoSource) exclude the hidden invoice", async () => {
    // Another tab active: the facet still counts every source, visible rows only.
    const only = await inv.listInvoices(fx.org, { state: "open", source: "fieldpulse" }, v.VISIBLE_ONLY);
    expect(only.total).toBe(0);
    expect(only.sourceCounts).toEqual({ native: 1 });

    const all = await inv.listInvoices(fx.org, { state: "open", source: "fieldpulse" }, v.SHOW_ALL);
    expect(all.sourceCounts).toEqual({ native: 2 });
  });

  it("collectedThisMonthCents ignores payments (and their refunds) on hidden invoices", async () => {
    // 2500 received − 500 refunded per set.
    expect(await inv.collectedThisMonthCents(fx.org, v.VISIBLE_ONLY, soon())).toBe(2000);
    expect(await inv.collectedThisMonthCents(fx.org, v.SHOW_ALL, soon())).toBe(4000);
  });

  it("getInvoiceDetailById returns null for hidden", async () => {
    expect(await inv.getInvoiceDetailById(fx.org, fx.hidden.invoice, v.VISIBLE_ONLY)).toBeNull();

    const visible = await inv.getInvoiceDetailById(fx.org, fx.visible.invoice, v.VISIBLE_ONLY);
    expect(visible?.id).toBe(fx.visible.invoice);
    expect(visible?.payments.map((p) => p.id)).toEqual([fx.visible.payment]);
    expect(visible?.payments[0]?.refunds.map((r) => r.amountCents)).toEqual([500]);

    const hidden = await inv.getInvoiceDetailById(fx.org, fx.hidden.invoice, v.SHOW_ALL);
    expect(hidden?.id).toBe(fx.hidden.invoice);
    expect(hidden?.payments.map((p) => p.id)).toEqual([fx.hidden.payment]);
  });

  it("listEstimates and getEstimatePipelineStats skip hidden; getEstimateDetailById null", async () => {
    const run = async (vis: typeof v.SHOW_ALL) => {
      const list = await est.listEstimates(fx.org, {}, vis);
      const open = await est.listEstimates(fx.org, { bucket: "open" }, vis);
      const lost = await est.listEstimates(fx.org, { bucket: "lost" }, vis);
      const won = await est.listEstimates(fx.org, { bucket: "won" }, vis);
      const stats = await est.getEstimatePipelineStats(fx.org, vis);
      const sum = (rows: readonly { totalCents: number }[]) => rows.reduce((s, r) => s + Number(r.totalCents), 0);
      // Pipeline tiles are the sums over the rows each bucket lists.
      expect(stats.openCents).toBe(sum(open.estimates));
      expect(stats.openCount).toBe(open.total);
      expect(stats.lostCents).toBe(sum(lost.estimates));
      expect(stats.lostCount).toBe(lost.total);
      expect(stats.wonCount).toBe(won.total);
      return { all: ids(list.estimates), total: list.total, stats };
    };

    const only = await run(v.VISIBLE_ONLY);
    expect(only.all).toEqual([fx.visible.estimate, soldVisible].sort());
    expect(only.total).toBe(2);
    expect(only.stats).toMatchObject({ openCents: 25000, openCount: 1, lostCount: 0, wonCount: 1, winRatePct: 100 });

    const all = await run(v.SHOW_ALL);
    expect(all.all).toEqual([fx.visible.estimate, fx.hidden.estimate, lostHidden, soldVisible].sort());
    expect(all.stats).toMatchObject({ openCents: 50000, openCount: 2, lostCents: 40000, lostCount: 1, wonCount: 1, winRatePct: 50 });

    const search = await est.listEstimates(fx.org, { search: "pat " }, v.VISIBLE_ONLY);
    expect(ids(search.estimates)).toEqual([fx.visible.estimate, soldVisible].sort());

    expect(await est.getEstimateDetailById(fx.org, fx.hidden.estimate, v.VISIBLE_ONLY)).toBeNull();
    expect((await est.getEstimateDetailById(fx.org, fx.visible.estimate, v.VISIBLE_ONLY))?.id).toBe(fx.visible.estimate);
    expect((await est.getEstimateDetailById(fx.org, fx.hidden.estimate, v.SHOW_ALL))?.id).toBe(fx.hidden.estimate);
  });

  it("a sold estimate whose invoice is hidden is still invoiced (no Generate prompt, not in Sold, not invoiced)", async () => {
    const notInvoiced = await est.listEstimates(fx.org, { bucket: "not_invoiced" }, v.VISIBLE_ONLY);
    expect(ids(notInvoiced.estimates)).not.toContain(soldVisible);
    expect((await est.getEstimateDetailById(fx.org, soldVisible, v.VISIBLE_ONLY))?.invoiceId).toBe(soldVisibleInvoice);
  });

  it("listFinancingApplications skips applications on hidden invoices", async () => {
    expect(await fin.listFinancingApplications(fx.org, { invoiceId: fx.hidden.invoice }, v.VISIBLE_ONLY)).toEqual([]);
    expect(await fin.listFinancingApplications(fx.org, { invoiceId: fx.visible.invoice }, v.VISIBLE_ONLY)).toHaveLength(1);
    expect(await fin.listFinancingApplications(fx.org, { invoiceId: fx.hidden.invoice }, v.SHOW_ALL)).toHaveLength(1);
  });

  it("getSalesReport nets payments and refunds, AR, estimates and invoices over visible rows only", async () => {
    const period = { fromDate: new Date(Date.now() - 86_400_000), toDate: soon() };
    const only = await rep.getSalesReport(fx.org, period, v.VISIBLE_ONLY);
    expect(only).toMatchObject({
      grossCollectedCents: 2500,
      refundedCents: 500,
      netCollectedCents: 2000,
      outstandingArCents: 7500,
      nativeArCents: 7500,
      estimatesCreated: 2,
      estimatesSold: 1,
      estimatesOpen: 1,
      estimatesDismissed: 0,
      invoicesCreated: 1,
    });
    // The report's AR equals the invoices page's Outstanding tile.
    expect(only.outstandingArCents).toBe((await inv.getInvoiceSummaryStats(fx.org, v.VISIBLE_ONLY)).outstandingCents);

    const all = await rep.getSalesReport(fx.org, period, v.SHOW_ALL);
    expect(all).toMatchObject({
      grossCollectedCents: 5000,
      refundedCents: 1000,
      netCollectedCents: 4000,
      outstandingArCents: 15000,
      estimatesCreated: 4,
      estimatesDismissed: 1,
      invoicesCreated: 3,
    });
  });
});
