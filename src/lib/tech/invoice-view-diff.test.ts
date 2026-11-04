import { describe, it, expect } from "vitest";
import { intentFromBody, intentLanded, sendPlan, writeStatus, type Intent } from "./invoice-view-diff";
import type { TechInvoice, TechInvoiceView } from "./invoice-view";
import type { KeyState } from "./invoice-key-state";

const SIG = { state: "none" as const, signedAt: null, signatureName: null, url: null, fresh: false };

function inv(over: Partial<TechInvoice> = {}): TechInvoice {
  return {
    id: "i1", state: "draft", subtotalCents: 0, taxCents: 0, taxBps: 825, totalCents: 0,
    amountPaidCents: 0, balanceCents: 0, issuedAt: null, updatedAt: null, fromEstimate: false,
    lines: [], payments: [], signature: SIG, ...over,
  };
}

function view(invoice: TechInvoiceView["invoice"], over: Partial<TechInvoiceView> = {}): TechInvoiceView {
  return {
    invoice, otherOpen: [], history: null, materialsNotOnInvoice: [], pendingWrite: false,
    customerHasPhone: false, isLead: true, onSite: true, externalInvoice: false, allowed: [], ...over,
  };
}

const LINE = { id: "l1", name: "Filter", quantity: 1, unitPriceCents: 1000, lineTotalCents: 1000 };
const LINE2 = { id: "l2", name: "Capacitor", quantity: 2, unitPriceCents: 500, lineTotalCents: 1000 };
const MAT = { id: "m1", name: "Filter", quantity: 1, unitPriceCents: 1000 };
const PAY = (id: string, amountCents: number, method = "cash") => ({
  id, method, checkNumber: null, amountCents, status: "succeeded", createdAt: null,
});

describe("intentLanded", () => {
  it("create: landed when an invoice appears, not when it stays null", () => {
    const i: Intent = { kind: "create" };
    expect(intentLanded(i, view(null), view(inv()))).toBe(true);
    expect(intentLanded(i, view(null), view(null))).toBe(false);
  });

  it("add_line (pricebook): landed when a new line appears", () => {
    const i: Intent = { kind: "add_line", pricebookItemId: "p1" };
    expect(intentLanded(i, view(inv({ lines: [LINE] })), view(inv({ lines: [LINE, LINE2] })))).toBe(true);
    expect(intentLanded(i, view(inv({ lines: [LINE] })), view(inv({ lines: [LINE] })))).toBe(false);
  });

  it("add_line (material): landed when the material leaves the unbilled list", () => {
    const i: Intent = { kind: "add_line", jobMaterialId: "m1" };
    expect(
      intentLanded(i, view(inv(), { materialsNotOnInvoice: [MAT] }), view(inv({ lines: [LINE] }))),
    ).toBe(true);
    expect(
      intentLanded(i, view(inv(), { materialsNotOnInvoice: [MAT] }), view(inv(), { materialsNotOnInvoice: [MAT] })),
    ).toBe(false);
  });

  it("remove_line: landed when the line is gone", () => {
    const i: Intent = { kind: "remove_line", lineId: "l1" };
    expect(intentLanded(i, view(inv({ lines: [LINE] })), view(inv()))).toBe(true);
    expect(intentLanded(i, view(inv({ lines: [LINE] })), view(inv({ lines: [LINE] })))).toBe(false);
  });

  it("finalize: landed when the invoice left draft", () => {
    const i: Intent = { kind: "finalize" };
    expect(intentLanded(i, view(inv()), view(inv({ state: "open" })))).toBe(true);
    expect(intentLanded(i, view(inv()), view(inv()))).toBe(false);
  });

  it("payment: landed on a NEW payment with the same amount and method", () => {
    const i: Intent = { kind: "payment", amountCents: 10000, method: "cash" };
    const before = view(inv({ state: "open", payments: [] }));
    expect(intentLanded(i, before, view(inv({ state: "paid", payments: [PAY("p1", 10000)] })))).toBe(true);
    // An existing payment of the same amount is not new.
    const had = view(inv({ state: "open", payments: [PAY("p1", 10000)] }));
    expect(intentLanded(i, had, had)).toBe(false);
    // Same amount, other method.
    expect(intentLanded(i, before, view(inv({ state: "open", payments: [PAY("p1", 10000, "check")] })))).toBe(false);
  });

  it("payment: the office's $50 does not satisfy the tech's $100", () => {
    const i: Intent = { kind: "payment", amountCents: 10000, method: "cash" };
    const before = view(inv({ state: "open" }));
    expect(intentLanded(i, before, view(inv({ state: "open", payments: [PAY("p9", 5000)] })))).toBe(false);
  });

  it("pay_link: never observable", () => {
    expect(intentLanded({ kind: "pay_link" }, view(inv({ state: "open" })), view(inv({ state: "open" })))).toBe(false);
  });

  it("signature: landed when signedAt changed", () => {
    const i: Intent = { kind: "signature" };
    const signed = inv({ signature: { ...SIG, state: "present", signedAt: "2026-11-04T10:00:00Z" } });
    expect(intentLanded(i, view(inv()), view(signed))).toBe(true);
    expect(intentLanded(i, view(signed), view(signed))).toBe(false);
  });

  it("is never true while a write is still pending", () => {
    expect(intentLanded({ kind: "create" }, view(null), view(inv(), { pendingWrite: true }))).toBe(false);
    expect(
      intentLanded({ kind: "remove_line", lineId: "l1" }, view(inv({ lines: [LINE] })), view(inv(), { pendingWrite: true })),
    ).toBe(false);
  });

  it("is false when the helper view hides lines and payments", () => {
    const reduced = { id: "i1", state: "open" as const, totalCents: 100, balanceCents: 100 };
    expect(intentLanded({ kind: "payment", amountCents: 100, method: "cash" }, view(reduced), view(reduced))).toBe(false);
  });
});

describe("sendPlan", () => {
  const base = { key: "k1", bodyHash: "h1", body: {} };
  it("sends an armed intent", () => {
    expect(sendPlan({ phase: "armed", ...base }, "h1")).toBe("send");
  });
  it("re-sends the same body of an unknown intent with its key", () => {
    expect(sendPlan({ phase: "unknown", ...base }, "h1")).toBe("send");
  });
  it("re-sends the OLD body first when an unknown intent meets a changed body", () => {
    expect(sendPlan({ phase: "unknown", ...base }, "h2")).toBe("resend_stored");
  });
  it("skips a double tap while the intent is in flight, and an idle intent", () => {
    expect(sendPlan({ phase: "sent", ...base }, "h1")).toBe("skip");
    expect(sendPlan({ phase: "idle" } as KeyState, "h1")).toBe("skip");
  });
});

describe("add_line (pricebook) with the line's identity", () => {
  const i: Intent = { kind: "add_line", pricebookItemId: "p1", name: "Capacitor", unitPriceCents: 500, quantity: 2 };
  it("lands only when a NEW line matches name, unit price and quantity", () => {
    expect(intentLanded(i, view(inv({ lines: [LINE] })), view(inv({ lines: [LINE, LINE2] })))).toBe(true);
  });
  it("does not land on some other new line", () => {
    const other = { ...LINE2, quantity: 3, lineTotalCents: 1500 };
    expect(intentLanded(i, view(inv({ lines: [LINE] })), view(inv({ lines: [LINE, other] })))).toBe(false);
    expect(intentLanded(i, view(inv({ lines: [LINE2] })), view(inv({ lines: [LINE2] })))).toBe(false);
  });
});

describe("writeStatus", () => {
  it("maps outcome + event to the result kind", () => {
    expect(writeStatus("success_refetch", "spent")).toBe("done");
    expect(writeStatus("retry_same_key_after_refetch", "dropped")).toBe("dropped");
    expect(writeStatus("retry_same_key_after_refetch", "unknown")).toBe("retry");
    expect(writeStatus("wait_then_refetch", "unknown")).toBe("pending");
    expect(writeStatus("wait_then_refetch", "dropped")).toBe("dropped");
    expect(writeStatus("show_message_refetch", "definitive_unstored")).toBe("error");
    expect(writeStatus("already_saved_refetch", "spent")).toBe("error");
  });
});

describe("intentFromBody", () => {
  it("rebuilds each persisted intent", () => {
    expect(intentFromBody("create", {})).toEqual({ kind: "create" });
    expect(intentFromBody("add_line", { invoiceId: "i", jobMaterialId: "m1" }))
      .toEqual({ kind: "add_line", pricebookItemId: undefined, jobMaterialId: "m1" });
    expect(intentFromBody("add_line", { invoiceId: "i", pricebookItemId: "p1", quantity: 2 }))
      .toEqual({ kind: "add_line", pricebookItemId: "p1", jobMaterialId: undefined, quantity: 2 });
    expect(intentFromBody("remove_line", { invoiceId: "i", lineId: "l1" })).toEqual({ kind: "remove_line", lineId: "l1" });
    expect(intentFromBody("payment", { amountCents: 500, method: "cash" }))
      .toEqual({ kind: "payment", amountCents: 500, method: "cash" });
    expect(intentFromBody("finalize", { invoiceId: "i" })).toEqual({ kind: "finalize" });
    expect(intentFromBody("pay_link", null)).toEqual({ kind: "pay_link" });
  });
});
