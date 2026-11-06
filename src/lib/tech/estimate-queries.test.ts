import { describe, it, expect, vi } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/crypto", () => ({ decrypt: (s: string) => s }));
vi.mock("@/lib/admin/org-config-queries", () => ({ getOrgConfig: vi.fn() }));
vi.mock("@/lib/admin/pricebook-queries", () => ({ getDefaultTaxBps: vi.fn(), getPricebookItemById: vi.fn() }));
import { assembleEstimates, estimatesSql, jobInvoiceSql, linesSql, optionsSql, shownCustomerName } from "./estimate-queries";

const ORG = "11111111-1111-4111-8111-111111111111";
const RID = "22222222-2222-4222-8222-222222222222";
const ME = "33333333-3333-4333-8333-333333333333";
const q = (s: SQL) => new PgDialect().sqlToQuery(s);
const render = (s: SQL) => q(s).sql.replace(/\s+/g, " ");

describe("tech estimates GET SQL (spec §6)", () => {
  it("native estimates of the request, newest first, with both billing halves", () => {
    const t = render(estimatesSql(ORG, RID, ME));
    expect(t).toContain("e.fieldpulse_estimate_id IS NULL");
    expect(t).toContain("ORDER BY e.created_at DESC, e.id DESC");
    expect(t).toContain("AS office_billed");
    expect(t).toContain("AS job_billed");
    expect(t).toContain("AS billing_invoice_id");
    expect(t).not.toContain("signature_name");
    expect(q(estimatesSql(ORG, RID, ME)).params.filter((p) => p === ORG).length).toBeGreaterThanOrEqual(1 + 1 + 4 + 1 + 4);
  });
  it("options and lines never select a cost; every table is org-bound", () => {
    for (const s of [optionsSql(ORG, RID), linesSql(ORG, RID)]) {
      expect(render(s)).not.toContain("cost");
    }
    expect(q(linesSql(ORG, RID)).params.filter((p) => p === ORG)).toHaveLength(3);
    expect(render(linesSql(ORG, RID))).toContain("ORDER BY l.id");
  });
  it("the job's invoice is the newest live native one", () => {
    const t = render(jobInvoiceSql(ORG, RID));
    expect(t).toContain("(state = 'draft'::invoice_state OR state = 'open'::invoice_state)");
    expect(t).toContain("amount_paid_cents > 0 AS has_payment");
  });
});

describe("assembleEstimates", () => {
  const NOW = new Date("2026-11-06T15:00:00Z");
  it("nests options and lines in order, derives status, billing and the label; no cost keys", () => {
    const out = assembleEstimates(
      [{ id: "e1", status: "sold", created_at: "2026-11-06T14:00:00Z", expires_at: "2026-12-06T14:00:00Z", signed_at: "2026-11-06T14:30:00Z",
        sold_option_id: "o2", sold_via: "field", sold_by_me: true, has_approval_link: false, office_billed: true, job_billed: true, billing_invoice_id: "inv-1" }],
      [{ id: "o1", estimate_id: "e1", name: "Good", sort_order: 0, subtotal_cents: 100, tax_cents: 8, total_cents: 108 },
       { id: "o2", estimate_id: "e1", name: "Better", sort_order: 1, subtotal_cents: 200, tax_cents: 17, total_cents: 217 }],
      [{ id: "l1", option_id: "o2", pricebook_item_id: "p1", name: "Coil", quantity: 2, unit_price_cents: 100, line_total_cents: 200 }],
      NOW,
    );
    expect(out[0]).toMatchObject({
      id: "e1", label: "Estimate · Nov 6 · 2 options", status: "sold", soldOptionId: "o2", soldVia: "field", soldByMe: true,
      billing: "office", billingInvoiceId: "inv-1", signedAt: "2026-11-06T14:30:00.000Z",
    });
    expect(out[0]!.options.map((o) => o.lines.length)).toEqual([0, 1]);
    expect(out[0]!.options[1]!.lines[0]).toEqual({ id: "l1", pricebookItemId: "p1", name: "Coil", quantity: 2, unitPriceCents: 100, lineTotalCents: 200 });
    expect(JSON.stringify(out)).not.toMatch(/cost/i);
  });
});

describe("shownCustomerName", () => {
  it("an erased customer has no name, so the view reads \"Your estimate\"", () => {
    expect(shownCustomerName("[deleted]")).toBeNull();
    expect(shownCustomerName("  ")).toBeNull();
    expect(shownCustomerName(" Pat Probe ")).toBe("Pat Probe");
  });
});
