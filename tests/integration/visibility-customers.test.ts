import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { seedVisibilityOrg, type VisibilityOrg } from "./visibility-fixture";

vi.mock("server-only", () => ({}));

/**
 * Sweep B (Task 11): customers, conversations, search, reviews and warranties
 * read only visible rows for an org user (VISIBLE_ONLY), and every row for the
 * platform owner (SHOW_ALL). DEV database, one throwaway org
 * (visibility-fixture.ts), deleted in afterAll.
 */

type V = typeof import("@/lib/admin/visibility");

let v: V;
let fx: VisibilityOrg;
let crm: typeof import("@/lib/admin/crm-queries");
let conv: typeof import("@/lib/admin/conversation-queries");
let search: typeof import("@/lib/admin/search-queries");
let reviews: typeof import("@/lib/reviews/review-queries");
let warranty: typeof import("@/lib/admin/warranty-queries");

/** Shared by both FieldPulse ids so one search term finds both rows. */
let fpPrefix: string;
const CLASH_EMAIL = "hidden-clash@throwaway.example";

beforeAll(async () => {
  fx = await seedVisibilityOrg();
  v = await import("@/lib/admin/visibility");
  crm = await import("@/lib/admin/crm-queries");
  conv = await import("@/lib/admin/conversation-queries");
  search = await import("@/lib/admin/search-queries");
  reviews = await import("@/lib/reviews/review-queries");
  warranty = await import("@/lib/admin/warranty-queries");
  const { db } = await import("@/lib/db");
  const { sql } = await import("drizzle-orm");

  fpPrefix = `prbvis${fx.org.slice(0, 8)}`;
  const { emailHash } = crm.computeContactHashes({ email: CLASH_EMAIL, phone: null });
  const both = (col: "session" | "reviewRequest" | "equipment") => [fx.visible[col], fx.hidden[col]];
  const inList = (list: string[]) => sql.join(list.map((id) => sql`${id}`), sql`, `);

  // UPDATEs only: the un-hide triggers fire on INSERT (and on a customer or
  // request link change), so the hidden set stays hidden.
  await db.batch([
    // Both escalated and unhandled: both need action.
    db.execute(sql`UPDATE customer_sessions SET status = 'escalated'::session_status, handled_at = NULL
      WHERE organization_id = ${fx.org} AND id IN (${inList(both("session"))})`),
    // One search term ("<prefix>") finds both invoices and both estimates.
    db.execute(sql`UPDATE invoices SET fieldpulse_invoice_id = ${fpPrefix} || '-' || id::text
      WHERE organization_id = ${fx.org} AND id IN (${fx.visible.invoice}, ${fx.hidden.invoice})`),
    db.execute(sql`UPDATE estimates SET fieldpulse_estimate_id = ${fpPrefix} || '-' || id::text
      WHERE organization_id = ${fx.org} AND id IN (${fx.visible.estimate}, ${fx.hidden.estimate})`),
    // Responded: visible rated 5, hidden rated 1 (average 5 vs 3).
    db.execute(sql`UPDATE review_requests SET status = 'responded',
        rating = CASE WHEN id = ${fx.visible.reviewRequest} THEN 5 ELSE 1 END, responded_at = now()
      WHERE organization_id = ${fx.org} AND id IN (${inList(both("reviewRequest"))})`),
    // Both warranties expire inside the default 30-day window.
    db.execute(sql`UPDATE customer_equipment SET warranty_expiration = now() + interval '10 days'
      WHERE organization_id = ${fx.org} AND id IN (${inList(both("equipment"))})`),
    // The hidden (native) customer owns an email a new customer might reuse.
    db.execute(sql`UPDATE customers SET email_hash = ${emailHash}
      WHERE organization_id = ${fx.org} AND id = ${fx.hidden.customer}`),
  ]);
  const flags = await db.execute(sql`SELECT
      (SELECT hidden_from_org FROM customers WHERE id = ${fx.hidden.customer}) AS c,
      (SELECT hidden_from_org FROM customer_sessions WHERE id = ${fx.hidden.session}) AS s,
      (SELECT hidden_from_org FROM service_requests WHERE id = ${fx.hidden.request}) AS r,
      (SELECT hidden_from_org FROM invoices WHERE id = ${fx.hidden.invoice}) AS i,
      (SELECT hidden_from_org FROM estimates WHERE id = ${fx.hidden.estimate}) AS e`);
  const row = flags.rows[0] as Record<"c" | "s" | "r" | "i" | "e", boolean>;
  if (!(row.c && row.s && row.r && row.i && row.e)) {
    throw new Error("fixture: hidden set was un-hidden by the setup UPDATEs");
  }
}, 60_000);

afterAll(async () => {
  await fx?.cleanup();
});

const ids = <T extends { id: string }>(rows: readonly T[]) => rows.map((r) => r.id);
const sorted = (...list: string[]) => [...list].sort();

describe("visibility — customers, conversations, search, reviews, warranties (sweep B)", () => {
  it("getCustomers list and total exclude the hidden customer", async () => {
    const only = await crm.getCustomers(fx.org, {}, v.VISIBLE_ONLY);
    expect(ids(only.customers)).toEqual([fx.visible.customer]);
    expect(only.total).toBe(1);
    expect(only.customers[0]?.requestCount).toBe(1);

    const all = await crm.getCustomers(fx.org, {}, v.SHOW_ALL);
    expect(ids(all.customers).sort()).toEqual(sorted(fx.visible.customer, fx.hidden.customer));
    expect(all.total).toBe(2);

    // The search path (decrypt + filter) as well: both are named "Pat …".
    const searchOnly = await crm.getCustomers(fx.org, { search: "pat" }, v.VISIBLE_ONLY);
    expect(ids(searchOnly.customers)).toEqual([fx.visible.customer]);
    expect(searchOnly.total).toBe(1);
    const searchAll = await crm.getCustomers(fx.org, { search: "pat" }, v.SHOW_ALL);
    expect(ids(searchAll.customers).sort()).toEqual(sorted(fx.visible.customer, fx.hidden.customer));
    expect(searchAll.total).toBe(2);
  });

  it("getCustomerById returns null for hidden", async () => {
    expect(await crm.getCustomerById(fx.org, fx.hidden.customer, v.VISIBLE_ONLY)).toBeNull();
    const visible = await crm.getCustomerById(fx.org, fx.visible.customer, v.VISIBLE_ONLY);
    expect(visible?.id).toBe(fx.visible.customer);
    expect(visible?.requestCount).toBe(1);
    expect((await crm.getCustomerById(fx.org, fx.hidden.customer, v.SHOW_ALL))?.id).toBe(fx.hidden.customer);
  });

  it("findNativeContactClash never points an org user at a hidden customer", async () => {
    const input = { email: CLASH_EMAIL, phone: null };
    expect(await crm.findNativeContactClash(fx.org, input, v.VISIBLE_ONLY)).toBeNull();
    expect((await crm.findNativeContactClash(fx.org, input, v.SHOW_ALL))?.id).toBe(fx.hidden.customer);
  });

  it("getConversations skips hidden sessions", async () => {
    const only = await conv.getConversations(fx.org, {}, v.VISIBLE_ONLY);
    expect(ids(only.conversations)).toEqual([fx.visible.session]);
    expect(only.total).toBe(1);

    const all = await conv.getConversations(fx.org, {}, v.SHOW_ALL);
    expect(ids(all.conversations).sort()).toEqual(sorted(fx.visible.session, fx.hidden.session));
    expect(all.total).toBe(2);
  });

  it("getConversations' needs-action count excludes a hidden session", async () => {
    const only = await conv.getConversations(fx.org, { needsAction: true }, v.VISIBLE_ONLY);
    expect(only.needsActionCount).toBe(1);
    // The inbox's own "Needs action" list and the badge agree.
    expect(only.total).toBe(only.needsActionCount);
    const [badge] = await conv.buildNeedsActionCountQuery(fx.org, v.VISIBLE_ONLY);
    expect(Number(badge?.value)).toBe(only.needsActionCount);

    const all = await conv.getConversations(fx.org, { needsAction: true }, v.SHOW_ALL);
    expect(all.needsActionCount).toBe(2);
    expect(all.total).toBe(2);
  });

  it("getConversationById returns null for a hidden session", async () => {
    expect(await conv.getConversationById(fx.org, fx.hidden.session, v.VISIBLE_ONLY)).toBeNull();
    const visible = await conv.getConversationById(fx.org, fx.visible.session, v.VISIBLE_ONLY);
    expect(visible?.id).toBe(fx.visible.session);
    expect(visible?.serviceRequestId).toBe(fx.visible.request);
    expect((await conv.getConversationById(fx.org, fx.hidden.session, v.SHOW_ALL))?.id).toBe(fx.hidden.session);
  });

  it("each search* omits hidden rows and returns them with SHOW_ALL", async () => {
    const cases = [
      { name: "searchCustomers", run: search.searchCustomers, q: "pat", key: "customer" },
      { name: "searchInvoices", run: search.searchInvoices, q: fpPrefix, key: "invoice" },
      { name: "searchJobs", run: search.searchJobs, q: "no_heat", key: "request" },
      { name: "searchConversations", run: search.searchConversations, q: "probe", key: "session" },
      { name: "searchEstimates", run: search.searchEstimates, q: fpPrefix, key: "estimate" },
    ] as const;
    for (const c of cases) {
      const only = await c.run(fx.org, c.q, v.VISIBLE_ONLY);
      expect(ids(only), `${c.name} VISIBLE_ONLY`).toEqual([fx.visible[c.key]]);
      const all = await c.run(fx.org, c.q, v.SHOW_ALL);
      expect(ids(all).sort(), `${c.name} SHOW_ALL`).toEqual(sorted(fx.visible[c.key], fx.hidden[c.key]));
    }

    // The ⌘K entry point threads the viewer to every type.
    const hiddenIds = new Set(Object.values(fx.hidden));
    for (const q of ["pat", fpPrefix, "no_heat", "probe"]) {
      const results = await search.searchAllEntities(fx.org, q, v.VISIBLE_ONLY);
      expect(results.length, `searchAllEntities "${q}"`).toBeGreaterThan(0);
      expect(results.filter((r) => hiddenIds.has(r.id)), `searchAllEntities "${q}"`).toEqual([]);
    }
  });

  it("listReviews and getReviewStats skip reviews of hidden requests", async () => {
    const only = await reviews.listReviews(fx.org, {}, v.VISIBLE_ONLY);
    expect(ids(only.reviews)).toEqual([fx.visible.reviewRequest]);
    expect(only.total).toBe(1);
    expect(await reviews.getReviewStats(fx.org, v.VISIBLE_ONLY)).toEqual({ count: 1, responded: 1, avgRating: 5 });

    const all = await reviews.listReviews(fx.org, {}, v.SHOW_ALL);
    expect(ids(all.reviews).sort()).toEqual(sorted(fx.visible.reviewRequest, fx.hidden.reviewRequest));
    expect(all.total).toBe(2);
    expect(await reviews.getReviewStats(fx.org, v.SHOW_ALL)).toEqual({ count: 2, responded: 2, avgRating: 3 });
  });

  it("listExpiringWarranties skips equipment of hidden customers", async () => {
    const only = await warranty.listExpiringWarranties(fx.org, v.VISIBLE_ONLY);
    expect(only.map((w) => w.equipmentId)).toEqual([fx.visible.equipment]);
    const all = await warranty.listExpiringWarranties(fx.org, v.SHOW_ALL);
    expect(all.map((w) => w.equipmentId).sort()).toEqual(sorted(fx.visible.equipment, fx.hidden.equipment));
  });
});
