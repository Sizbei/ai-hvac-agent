import { describe, it, expect } from "vitest";
import {
  BILLING_LINE, billingOf, canSell, createBlockedReason, derivedStatus, estimateLabel, estimatesCardVisible,
  priceSummary, SOLD_COPY, soldBillingView, STATUS_CHIP, totalsLine, totalsParts,
} from "./estimate-display";
import type { TechEstimate, TechEstimatesView } from "./estimate-view";

const NOW = new Date("2026-11-06T15:00:00Z");
const opt = (id: string, totalCents: number) => ({ id, name: id, sortOrder: 0, subtotalCents: totalCents, taxCents: 0, totalCents, lines: [] });

describe("estimate display (spec §2, §7.3)", () => {
  it("label: creation day in the business timezone, option count", () => {
    expect(estimateLabel("2026-11-06T15:00:00Z", 2)).toBe("Estimate · Nov 6 · 2 options");
    expect(estimateLabel("2026-11-07T03:30:00Z", 1)).toBe("Estimate · Nov 6 · 1 option"); // 22:30 Eastern
  });
  it("derived status: open past expires_at reads Expired; dismissed reads Declined", () => {
    expect(derivedStatus("open", "2026-11-06T14:59:59Z", NOW)).toBe("expired");
    expect(derivedStatus("open", "2026-12-06T00:00:00Z", NOW)).toBe("open");
    expect(derivedStatus("open", null, NOW)).toBe("open");
    expect(derivedStatus("dismissed", null, NOW)).toBe("declined");
    expect(derivedStatus("expired", null, NOW)).toBe("expired");
    expect(derivedStatus("sold", "2026-01-01T00:00:00Z", NOW)).toBe("sold");
    expect(STATUS_CHIP).toEqual({ open: "Open", sold: "Sold", expired: "Expired", declined: "Declined" });
  });
  it("price: the sold option's total, else the option range", () => {
    expect(priceSummary({ status: "open", soldOptionId: null, options: [opt("a", 120_000), opt("b", 481_200)] })).toBe("$1,200.00 – $4,812.00");
    expect(priceSummary({ status: "open", soldOptionId: null, options: [opt("a", 120_000)] })).toBe("$1,200.00");
    expect(priceSummary({ status: "sold", soldOptionId: "b", options: [opt("a", 120_000), opt("b", 481_200)] })).toBe("$4,812.00");
  });
  it("billing: office beats job beats none; copy per state", () => {
    expect(billingOf(true, true)).toBe("office");
    expect(billingOf(false, true)).toBe("job");
    expect(billingOf(false, false)).toBe("none");
    expect(BILLING_LINE).toEqual({ job: "On the job's invoice", office: "Billed by the office", none: "Not invoiced yet" });
  });
  it("create blocked reasons", () => {
    expect(createBlockedReason({ isLead: true, status: "arrived", hasCustomer: true })).toBeNull();
    expect(createBlockedReason({ isLead: false, status: "arrived", hasCustomer: true })).toBe("Only the lead technician can do that.");
    expect(createBlockedReason({ isLead: true, status: "en_route", hasCustomer: true })).toBe("Arrive at the job first.");
    expect(createBlockedReason({ isLead: true, status: "completed", hasCustomer: true })).toBe("This job is closed.");
    expect(createBlockedReason({ isLead: true, status: "on_hold", hasCustomer: false })).toBe("Ask the office to add the customer before quoting.");
  });
  it("canSell: the lead, an open estimate, an on-site request", () => {
    const v = { isLead: true, requestStatus: "in_progress" };
    expect(canSell(v, { status: "open" })).toBe(true);
    expect(canSell(v, { status: "sold" })).toBe(false);
    expect(canSell({ ...v, isLead: false }, { status: "open" })).toBe(false);
    expect(canSell({ ...v, requestStatus: "completed" }, { status: "open" })).toBe(false);
    expect(canSell(v, null)).toBe(false);
  });
  it("sold billing view (spec §7.3)", () => {
    const view = (over: Partial<TechEstimatesView>) => ({ jobInvoice: null, priorInvoicePaid: false, requestStatus: "in_progress", ...over }) as TechEstimatesView;
    const est = (over: Partial<TechEstimate>) => ({ billing: "none", billingInvoiceId: null, ...over }) as TechEstimate;
    expect(soldBillingView(est({ billing: "job", billingInvoiceId: "i1" }), view({}))).toEqual({ kind: "job", invoiceId: "i1" });
    expect(soldBillingView(est({ billing: "office" }), view({}))).toEqual({ kind: "office" });
    expect(soldBillingView(est({}), view({}))).toEqual({ kind: "add", newInvoice: false, leave: true });
    expect(soldBillingView(est({}), view({ priorInvoicePaid: true }))).toEqual({ kind: "add", newInvoice: true, leave: true });
    // A live draft IS the job's invoice: only Add, never Leave for the office (lead ruling, final review B P1-2;
    // the office would answer request_has_draft).
    expect(soldBillingView(est({}), view({ jobInvoice: { id: "d", state: "draft", hasPayment: false } }))).toEqual({ kind: "add", newInvoice: false, leave: false });
    expect(soldBillingView(est({}), view({ jobInvoice: { id: "d", state: "draft", hasPayment: true } }))).toEqual({ kind: "locked" });
    expect(soldBillingView(est({}), view({ jobInvoice: { id: "o", state: "open", hasPayment: false } }))).toEqual({ kind: "locked" });
    expect(soldBillingView(est({}), view({ requestStatus: "cancelled" }))).toEqual({ kind: "closed" });
    expect(SOLD_COPY.locked).toBe("The job's invoice is already finalized. Ask the office to bill this estimate."); // ruling 12
  });
  it("the card shows from arrival on, or whenever estimates exist", () => {
    expect(estimatesCardVisible({ requestStatus: "en_route", estimates: [] })).toBe(false);
    expect(estimatesCardVisible({ requestStatus: "arrived", estimates: [] })).toBe(true);
    expect(estimatesCardVisible({ requestStatus: "cancelled", estimates: [{} as TechEstimate] })).toBe(true);
  });
});

describe("one Subtotal · Tax · Total formatter (final review C m6)", () => {
  const t = { subtotalCents: 25_000, taxCents: 2_063, totalCents: 27_063 };
  it("the line for the builder and the estimate page", () => {
    expect(totalsLine(t)).toBe("Subtotal $250.00 · Tax $20.63 · Total $270.63");
  });
  it("the rows for the customer view, with its tax label", () => {
    expect(totalsParts(t, "Tax (8.25%)")).toEqual([
      { label: "Subtotal", value: "$250.00" }, { label: "Tax (8.25%)", value: "$20.63" }, { label: "Total", value: "$270.63" },
    ]);
  });
});
