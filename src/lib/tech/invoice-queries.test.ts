import { describe, it, expect, vi, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

// Pure test: @/lib/db is mocked. Each db.execute is answered by the first
// scripted handler whose marker appears in the rendered SQL; every statement
// is recorded so the tests can assert the rendered predicates.
const h = vi.hoisted(() => ({
  executed: [] as unknown[],
  answers: new Map<string, unknown[]>(),
  findReadableJob: vi.fn(),
  findActiveVisit: vi.fn(),
  getDefaultTaxBps: vi.fn(),
  getSignedReadUrl: vi.fn(),
  getStorageClient: vi.fn(),
}));

vi.mock("@/lib/db", () => ({
  db: {
    execute: async (q: unknown) => {
      h.executed.push(q);
      const text = new (await import("drizzle-orm/pg-core")).PgDialect().sqlToQuery(q as SQL).sql;
      for (const [marker, rows] of h.answers) if (text.includes(marker)) return { rows };
      return { rows: [] };
    },
  },
}));
vi.mock("@/lib/tech/ownership", async (orig) => ({
  ...(await orig<typeof import("@/lib/tech/ownership")>()),
  findReadableJob: h.findReadableJob,
  findActiveVisit: h.findActiveVisit,
}));
vi.mock("@/lib/admin/pricebook-queries", () => ({ getDefaultTaxBps: h.getDefaultTaxBps, getPricebookItemById: vi.fn() }));
vi.mock("@/lib/storage/r2-client", () => ({ getStorageClient: h.getStorageClient }));

import { getTechInvoiceView } from "./invoice-queries";
import type { TechInvoice } from "./invoice-view";

const ORG = "11111111-1111-4111-8111-111111111111";
const REQ = "22222222-2222-4222-8222-222222222222";
const ME = "33333333-3333-4333-8333-333333333333";
const INV = "44444444-4444-4444-8444-444444444444";
const OTHER = "55555555-5555-4555-8555-555555555555";
const EST = "66666666-6666-4666-8666-666666666666";
const CUST = "77777777-7777-4777-8777-777777777777";
const MAT = "88888888-8888-4888-8888-888888888888";
const PUBLIC = "https://files.example.com";

const dialect = new PgDialect();
const renderQ = (q: unknown) => dialect.sqlToQuery(q as SQL);
const render = (q: unknown) => renderQ(q).sql.replace(/\s+/g, " ").trim();
const stmt = (marker: string): { sql: string; params: unknown[] } | undefined => {
  const q = h.executed.find((x) => render(x).includes(marker));
  return q ? { sql: render(q), params: renderQ(q).params } : undefined;
};

// Markers: one distinctive fragment per statement the module issues.
const M = {
  meta: "FROM service_requests r",
  adopted: "LIMIT 1", // adopted + history both LIMIT 1; disambiguated below
  lines: "FROM invoice_line_items WHERE",
  payments: "FROM payments",
  materials: "FROM job_materials m",
  estimate: "FROM estimates",
  customer: "FROM customers",
  otherOpen: "id <> ",
  settled: "state IN ('paid'::invoice_state, 'refunded'::invoice_state) AND",
  history: "'refunded'::invoice_state, 'void'::invoice_state)",
};

const invoiceRow = (over: Record<string, unknown> = {}) => ({
  id: INV, state: "draft", subtotal_cents: 10000, tax_cents: 700, total_cents: 10700,
  amount_paid_cents: 0, balance_cents: 10700, issued_at: null,
  updated_at: "2026-11-04T10:00:00.000Z", created_at: "2026-11-04T09:00:00.000Z",
  estimate_id: null, customer_id: CUST, signature_url: null, signature_name: null, signed_at: null,
  cost_cents: 4000, ...over,
});

function script(opts: {
  invoice?: Record<string, unknown> | null;
  meta?: Record<string, unknown>;
  settled?: Record<string, unknown> | null;
  history?: Record<string, unknown> | null;
  otherOpen?: Record<string, unknown>[];
}) {
  h.answers.clear();
  // Order matters: the first matching marker wins.
  h.answers.set(M.settled, opts.settled ? [opts.settled] : []);
  h.answers.set(M.history, opts.history ? [opts.history] : []);
  h.answers.set(M.otherOpen, opts.otherOpen ?? []);
  h.answers.set(M.meta, [{
    signature_url: null, signature_name: null, signed_at: null,
    external_invoice: false, pending_write: false, ...opts.meta,
  }]);
  h.answers.set(M.lines, [{ id: "l1", name: "Capacitor", quantity: 2, unit_price_cents: 5000, line_total_cents: 10000, cost_cents: 1200 }]);
  h.answers.set(M.payments, [{ id: "p1", method: "cash", check_number: null, amount_cents: 500, status: "succeeded", created_at: "2026-11-04T11:00:00.000Z", provider: "manual" }]);
  h.answers.set(M.materials, [{ id: MAT, name: "Filter", quantity: 1, unit_price_cents: 2500, unit_cost_cents: 900 }]);
  h.answers.set(M.estimate, [{ signed_at: "2026-11-01T08:00:00.000Z", signature_name: "Pat Doe" }]);
  h.answers.set(M.customer, [{ has_phone: true }]);
  h.answers.set("FROM invoices WHERE", opts.invoice ? [opts.invoice] : []);
}

function asLead(lead = true) {
  h.findActiveVisit.mockResolvedValue({ appointmentId: "a", leadTechnicianId: lead ? ME : "someone-else" });
}

async function viewOf() {
  const r = await getTechInvoiceView(ORG, ME, REQ);
  if (r.kind !== "ok") throw new Error(`expected a view, got ${r.kind}`);
  return r.view;
}

function hasCostKey(v: unknown): boolean {
  if (Array.isArray(v)) return v.some(hasCostKey);
  if (v && typeof v === "object") {
    return Object.entries(v).some(([k, x]) => k.toLowerCase().includes("cost") || hasCostKey(x));
  }
  return false;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.executed.length = 0;
  process.env.R2_PUBLIC_URL = PUBLIC;
  h.findReadableJob.mockResolvedValue({ id: REQ, customerId: CUST, native: true, status: "in_progress" });
  h.getDefaultTaxBps.mockResolvedValue(700);
  h.getSignedReadUrl.mockResolvedValue("https://signed.example/sig.png?x=1");
  h.getStorageClient.mockImplementation(() => ({ getSignedReadUrl: h.getSignedReadUrl }));
  asLead();
});

describe("getTechInvoiceView", () => {
  it("not_found when the job is not readable, without querying further", async () => {
    h.findReadableJob.mockResolvedValue(null);
    expect(await getTechInvoiceView(ORG, ME, REQ)).toEqual({ kind: "not_found" });
    expect(h.executed).toHaveLength(0);
    expect(h.findActiveVisit).not.toHaveBeenCalled();
  });

  it("external for a FieldPulse/HCP job: no statement after findReadableJob", async () => {
    h.findReadableJob.mockResolvedValue({ id: REQ, customerId: CUST, native: false, status: "in_progress" });
    script({ invoice: invoiceRow() });
    expect(await getTechInvoiceView(ORG, ME, REQ)).toEqual({ kind: "external" });
    expect(h.executed).toHaveLength(0);
    expect(h.findActiveVisit).not.toHaveBeenCalled();
    expect(h.getDefaultTaxBps).not.toHaveBeenCalled();
  });

  it("customerHasPhone reads the INVOICE's customer once a live invoice exists", async () => {
    const INV_CUST = "99999999-9999-4999-8999-999999999999";
    script({ invoice: invoiceRow({ customer_id: INV_CUST }) });
    await viewOf();
    const phone = stmt(M.customer)!;
    expect(phone.params).toEqual([INV_CUST, ORG]);
  });

  it("customerHasPhone is false for a live invoice with no customer, even if the request has one", async () => {
    script({ invoice: invoiceRow({ customer_id: null }) });
    const v = await viewOf();
    expect(v.customerHasPhone).toBe(false);
    expect(stmt(M.customer)).toBeUndefined();
  });

  it("customerHasPhone falls back to the request's customer when there is no live invoice", async () => {
    script({ invoice: null });
    await viewOf();
    expect(stmt(M.customer)!.params).toEqual([CUST, ORG]);
  });

  it("non-lead: exactly { id, state, totalCents, balanceCents }, no materials, no actions", async () => {
    asLead(false);
    script({ invoice: invoiceRow({ signature_url: `${PUBLIC}/sig.png`, signed_at: "2026-11-04T10:00:00Z" }) });
    const v = (await viewOf());
    expect(v.invoice).toEqual({ id: INV, state: "draft", totalCents: 10700, balanceCents: 10700 });
    expect(v.materialsNotOnInvoice).toEqual([]);
    expect(v.allowed).toEqual([]);
    expect(v.isLead).toBe(false);
    expect(stmt(M.lines)).toBeUndefined();
    expect(stmt(M.materials)).toBeUndefined();
    expect(h.getSignedReadUrl).not.toHaveBeenCalled();
  });

  it("lead view never carries a key containing 'cost' although the rows do", async () => {
    script({ invoice: invoiceRow() });
    const v = await viewOf();
    expect(hasCostKey(v)).toBe(false);
    expect((v!.invoice as TechInvoice).lines).toEqual([
      { id: "l1", name: "Capacitor", quantity: 2, unitPriceCents: 5000, lineTotalCents: 10000 },
    ]);
    expect(v!.materialsNotOnInvoice).toEqual([{ id: MAT, name: "Filter", quantity: 1, unitPriceCents: 2500 }]);
    for (const q of h.executed) expect(render(q)).not.toMatch(/cost|markup/i);
  });

  it("adopts the newest live native invoice and every statement carries the org param", async () => {
    script({ invoice: invoiceRow() });
    await viewOf();
    const adopted = stmt("FROM invoices WHERE")!;
    expect(adopted.sql).toContain("(state = 'draft'::invoice_state OR state = 'open'::invoice_state)");
    expect(adopted.sql).toContain("fieldpulse_invoice_id IS NULL AND hcp_invoice_id IS NULL");
    expect(adopted.sql).toContain("ORDER BY created_at DESC, id DESC LIMIT 1");
    expect(stmt(M.lines)!.sql).toContain("ORDER BY created_at, id");
    expect(stmt(M.payments)!.sql).toContain("ORDER BY created_at DESC");
    expect(h.executed.length).toBeGreaterThan(5);
    for (const q of h.executed) expect(renderQ(q).params).toContain(ORG);
  });

  it("materialsNotOnInvoice: created after the invoice and not linked on a non-void native invoice", async () => {
    script({ invoice: invoiceRow() });
    await viewOf();
    const m = stmt(M.materials)!.sql;
    expect(m).toMatch(/m\.created_at > \(SELECT i0\.created_at FROM invoices i0 WHERE i0\.id = \$\d+::uuid AND i0\.organization_id = \$\d+::uuid\)/);
    expect(m).toContain("AND NOT EXISTS (SELECT 1 FROM invoice_line_items l JOIN invoices i ON i.id = l.invoice_id WHERE l.job_material_id = m.id");
    expect(m).toContain("i.state <> 'void'::invoice_state");
    expect(m).toContain("COALESCE(pi.name, m.description, 'Material')");
  });

  it("materialsNotOnInvoice is empty and not queried for an open invoice; taxBps null on open", async () => {
    script({ invoice: invoiceRow({ state: "open", issued_at: "2026-11-04T10:30:00Z" }) });
    const v = (await viewOf());
    expect(v.materialsNotOnInvoice).toEqual([]);
    expect(stmt(M.materials)).toBeUndefined();
    expect((v.invoice as TechInvoice).taxBps).toBeNull();
    expect(h.getDefaultTaxBps).not.toHaveBeenCalled();
  });

  it("taxBps is the org default while draft", async () => {
    script({ invoice: invoiceRow() });
    const v = (await viewOf());
    expect((v.invoice as TechInvoice).taxBps).toBe(700);
  });

  describe("draft signature = the request's current one", () => {
    const run = async (signedAt: string) => {
      script({
        invoice: invoiceRow({ updated_at: "2026-11-04T10:00:00.000Z" }),
        meta: { signature_url: `${PUBLIC}/sigs/a.png`, signature_name: "Pat", signed_at: signedAt },
      });
      return ((await viewOf()).invoice as TechInvoice).signature;
    };
    it("fresh when signedAt equals updatedAt", async () => {
      const s = await run("2026-11-04T10:00:00.000Z");
      expect(s).toMatchObject({ state: "present", fresh: true, signatureName: "Pat", url: "https://signed.example/sig.png?x=1" });
      expect(h.getSignedReadUrl).toHaveBeenCalledWith("sigs/a.png", expect.any(Number));
    });
    it("fresh when signedAt is after updatedAt", async () => {
      expect((await run("2026-11-04T10:00:01.000Z")).fresh).toBe(true);
    });
    it("not fresh when signedAt is before updatedAt; the sign action is offered", async () => {
      expect((await run("2026-11-04T09:59:59.000Z")).fresh).toBe(false);
      expect((await viewOf()).allowed).toContain("sign");
    });
    it("none when the request is unsigned", async () => {
      script({ invoice: invoiceRow() });
      const s = ((await viewOf()).invoice as TechInvoice).signature;
      expect(s).toEqual({ state: "none", signedAt: null, signatureName: null, url: null, fresh: false });
    });
  });

  describe("open invoice signature = the invoice's own snapshot", () => {
    it("ignores the request's signature and signs the invoice's url", async () => {
      script({
        invoice: invoiceRow({ state: "open", signature_url: `${PUBLIC}/sigs/inv.png`, signature_name: "Lee", signed_at: "2026-11-04T09:30:00Z" }),
        meta: { signature_url: `${PUBLIC}/sigs/req.png`, signature_name: "Other", signed_at: "2026-11-04T12:00:00Z" },
      });
      const s = ((await viewOf()).invoice as TechInvoice).signature;
      expect(s.state).toBe("present");
      expect(s.signatureName).toBe("Lee");
      expect(h.getSignedReadUrl).toHaveBeenCalledWith("sigs/inv.png", expect.any(Number));
    });
    it("erased when signed_at is set and the url is gone", async () => {
      script({ invoice: invoiceRow({ state: "open", signed_at: "2026-11-04T09:30:00Z", signature_name: null }) });
      const s = ((await viewOf()).invoice as TechInvoice).signature;
      expect(s).toMatchObject({ state: "erased", url: null });
    });
    it("unavailable when the storage client throws (no R2 env)", async () => {
      h.getStorageClient.mockImplementation(() => { throw new Error("R2 env missing"); });
      script({ invoice: invoiceRow({ state: "open", signature_url: `${PUBLIC}/sigs/inv.png`, signed_at: "2026-11-04T09:30:00Z" }) });
      const s = ((await viewOf()).invoice as TechInvoice).signature;
      expect(s).toMatchObject({ state: "unavailable", url: null });
    });
    it("unavailable when signing rejects", async () => {
      h.getSignedReadUrl.mockRejectedValue(new Error("Failed to sign read URL"));
      script({ invoice: invoiceRow({ state: "open", signature_url: `${PUBLIC}/sigs/inv.png`, signed_at: "2026-11-04T09:30:00Z" }) });
      const s = ((await viewOf()).invoice as TechInvoice).signature;
      expect(s.state).toBe("unavailable");
    });
    it("estimate-born: the estimate's acceptance", async () => {
      script({ invoice: invoiceRow({ state: "open", estimate_id: EST }) });
      const v = (await viewOf());
      const inv = v.invoice as TechInvoice;
      expect(inv.fromEstimate).toBe(true);
      expect(inv.signature).toMatchObject({ state: "estimate", signatureName: "Pat Doe", url: null });
      expect(stmt(M.estimate)!.params).toEqual([EST, ORG]);
    });
  });

  it("pendingWrite: in-progress key for (org, user) on this job's routes younger than 2 minutes", async () => {
    script({ invoice: null, meta: { pending_write: true } });
    const v = (await viewOf());
    expect(v.pendingWrite).toBe(true);
    const meta = stmt(M.meta)!;
    expect(meta.sql).toMatch(/EXISTS \(SELECT 1 FROM idempotency_keys k WHERE k\.organization_id = \$\d+::uuid AND k\.user_id = \$\d+::uuid AND k\.route LIKE '\/api\/tech\/jobs\/' \|\| \$\d+::text \|\| '\/%' AND k\.state = 'in_progress' AND k\.created_at > now\(\) - interval '2 minutes'\)/);
    expect(meta.params).toEqual(expect.arrayContaining([ORG, ME, REQ]));
  });

  it("otherOpen excludes the adopted invoice", async () => {
    script({ invoice: invoiceRow({ state: "open" }), otherOpen: [{ id: OTHER, total_cents: 8900, balance_cents: 8900 }] });
    const v = (await viewOf());
    expect(v.otherOpen).toEqual([{ id: OTHER, totalCents: 8900, balanceCents: 8900 }]);
    const q = stmt(M.otherOpen)!;
    expect(q.sql).toContain("state = 'open'::invoice_state");
    expect(q.sql).toMatch(/id <> \$\d+::uuid/);
    expect(q.params).toContain(INV);
  });

  it("no live invoice, a paid one: THE invoice in full (lines, payments, its own signature), history null, create offered", async () => {
    script({
      invoice: null,
      settled: invoiceRow({
        id: OTHER, state: "paid", amount_paid_cents: 10700, balance_cents: 0, issued_at: "2026-11-04T10:30:00.000Z",
        signature_url: `${PUBLIC}/inv-sig.png`, signature_name: "Pat Doe", signed_at: "2026-11-04T10:15:00.000Z",
      }),
      meta: { signature_url: `${PUBLIC}/req-sig.png`, signature_name: "Someone Else", signed_at: "2026-11-04T12:00:00.000Z" },
    });
    const v = (await viewOf());
    const inv = v.invoice as TechInvoice;
    expect(inv).toMatchObject({ id: OTHER, state: "paid", balanceCents: 0, amountPaidCents: 10700, taxBps: null });
    expect(inv.lines).toHaveLength(1);
    expect(inv.payments).toEqual([
      { id: "p1", method: "cash", checkNumber: null, amountCents: 500, status: "succeeded", createdAt: "2026-11-04T11:00:00.000Z" },
    ]);
    expect(inv.signature).toMatchObject({ state: "present", signatureName: "Pat Doe", signedAt: "2026-11-04T10:15:00.000Z", fresh: false });
    expect(h.getSignedReadUrl).toHaveBeenCalledWith(expect.stringContaining("inv-sig.png"), expect.any(Number));
    expect(v.materialsNotOnInvoice).toEqual([]);
    expect(stmt(M.materials)).toBeUndefined();
    expect(h.getDefaultTaxBps).not.toHaveBeenCalled();
    expect(v.history).toBeNull();
    expect(stmt(M.history)).toBeUndefined();
    expect(v.otherOpen).toEqual([]);
    expect(v.allowed).toEqual(["create"]);
    const q = stmt(M.settled)!;
    expect(q.sql).toContain("ORDER BY created_at DESC, id DESC LIMIT 1");
    expect(q.sql).toContain("fieldpulse_invoice_id IS NULL AND hcp_invoice_id IS NULL");
    expect(q.params).toEqual([ORG, REQ]);
    expect(stmt(M.payments)!.params).toEqual([OTHER, ORG]);
  });

  it("no live invoice, a refunded one: shown in full, create offered", async () => {
    script({ invoice: null, settled: invoiceRow({ id: OTHER, state: "refunded", amount_paid_cents: 0, balance_cents: 10700 }) });
    const v = (await viewOf());
    expect(v.invoice).toMatchObject({ id: OTHER, state: "refunded" });
    expect(v.history).toBeNull();
    expect(v.allowed).toEqual(["create"]);
  });

  it("a live invoice is never replaced by a settled one; the settled query is not issued", async () => {
    script({ invoice: invoiceRow(), settled: invoiceRow({ id: OTHER, state: "paid" }) });
    const v = (await viewOf());
    expect(v.invoice).toMatchObject({ id: INV, state: "draft" });
    expect(stmt(M.settled)).toBeUndefined();
    expect(v.history).toBeNull();
  });

  it("non-lead on a paid invoice: the reduced view still applies", async () => {
    asLead(false);
    script({ invoice: null, settled: invoiceRow({ id: OTHER, state: "paid", amount_paid_cents: 10700, balance_cents: 0 }) });
    const v = (await viewOf());
    expect(v.invoice).toEqual({ id: OTHER, state: "paid", totalCents: 10700, balanceCents: 0 });
    expect(v.allowed).toEqual([]);
    expect(v.history).toBeNull();
    expect(stmt(M.lines)).toBeUndefined();
    expect(stmt(M.payments)).toBeUndefined();
  });

  it("no live and no settled invoice: history = the newest voided one; create offered on site", async () => {
    script({ invoice: null, history: { id: OTHER, state: "void", total_cents: 5000 } });
    const v = (await viewOf());
    expect(v.invoice).toBeNull();
    expect(v.history).toEqual({ id: OTHER, state: "void", totalCents: 5000 });
    expect(stmt(M.history)!.sql).toContain("ORDER BY created_at DESC, id DESC LIMIT 1");
    expect(v.allowed).toEqual(["create"]);
    expect(v.customerHasPhone).toBe(true);
  });

  it("externalInvoice and onSite flags; off-site lead gets no actions", async () => {
    h.findReadableJob.mockResolvedValue({ id: REQ, customerId: null, native: true, status: "scheduled" });
    script({ invoice: null, meta: { external_invoice: true } });
    const v = (await viewOf());
    expect(v).toMatchObject({ externalInvoice: true, onSite: false, isLead: true, allowed: [], customerHasPhone: false });
    expect(stmt(M.customer)).toBeUndefined();
    expect(stmt(M.meta)!.sql).toContain("(i.fieldpulse_invoice_id IS NOT NULL OR i.hcp_invoice_id IS NOT NULL)");
  });

  it("open invoice with a balance and a customer phone: record_payment and pay_link", async () => {
    script({ invoice: invoiceRow({ state: "open", amount_paid_cents: 500, balance_cents: 10200 }) });
    const v = (await viewOf());
    expect(v.allowed).toEqual(["record_payment", "pay_link"]);
    expect((v.invoice as TechInvoice).payments).toEqual([
      { id: "p1", method: "cash", checkNumber: null, amountCents: 500, status: "succeeded", createdAt: "2026-11-04T11:00:00.000Z" },
    ]);
    expect(stmt(M.customer)!.sql).toContain("phone_encrypted IS NOT NULL");
  });
});
