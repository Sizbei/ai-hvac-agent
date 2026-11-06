import { describe, it, expect } from "vitest";
import { businessDay, businessWhen, estimateInvoiceCard } from "./estimate-detail-display";

describe("office estimate detail: invoice card (final review B P2-1)", () => {
  it("an office invoice: Invoice created, with its link", () => {
    expect(estimateInvoiceCard({ invoiceId: "i1", jobInvoiceId: null })).toEqual({ kind: "office", invoiceId: "i1" });
    expect(estimateInvoiceCard({ invoiceId: "i1", jobInvoiceId: "j1" })).toEqual({ kind: "office", invoiceId: "i1" });
  });
  it("billed on the job's invoice: no Generate, a link to that invoice", () => {
    expect(estimateInvoiceCard({ invoiceId: null, jobInvoiceId: "j1" })).toEqual({ kind: "job", invoiceId: "j1" });
  });
  it("not billed: Generate", () => {
    expect(estimateInvoiceCard({ invoiceId: null, jobInvoiceId: null })).toEqual({ kind: "generate" });
  });
});

describe("office dates in the business timezone (final review B P2-2)", () => {
  it("a late-evening Eastern sale reads that Eastern day, wherever the viewer is", () => {
    expect(businessWhen("2026-11-07T03:26:00Z")).toBe("Nov 6, 10:26 PM");
    expect(businessDay("2026-11-07T03:26:00Z")).toBe("Nov 6, 2026");
  });
});
