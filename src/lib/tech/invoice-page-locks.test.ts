import { describe, expect, it } from "vitest";
import { unknownBanner } from "./approval-flow";
import {
  APPROVAL_CLOSED,
  approvalCanMount,
  bannerTap,
  inFlightPaymentBody,
  pageLocks,
  staleUnknownKinds,
} from "./invoice-page-locks";
import type { TechInvoice, TechInvoiceView } from "./invoice-view";

const SIG = { state: "none" as const, signedAt: null, signatureName: null, url: null, fresh: false };
const LINE = { id: "l1", name: "Filter", quantity: 1, unitPriceCents: 1000, lineTotalCents: 1000 };

function inv(over: Partial<TechInvoice> = {}): TechInvoice {
  return {
    id: "i1", state: "draft", subtotalCents: 0, taxCents: 0, taxBps: 825, totalCents: 0,
    amountPaidCents: 0, balanceCents: 0, issuedAt: null, updatedAt: null, fromEstimate: false,
    lines: [LINE], payments: [], signature: SIG, ...over,
  };
}

function view(invoice: TechInvoiceView["invoice"], over: Partial<TechInvoiceView> = {}): TechInvoiceView {
  return {
    invoice, otherOpen: [], history: null, materialsNotOnInvoice: [], pendingWrite: false,
    customerHasPhone: false, isLead: true, onSite: true, externalInvoice: false, allowed: ["finalize", "sign"], ...over,
  };
}

describe("staleUnknownKinds", () => {
  it("keeps an unknown signature on a draft without a fresh signature", () => {
    expect(staleUnknownKinds(view(inv()), ["signature"])).toEqual([]);
  });

  it("drops the signature once the request signature is fresh", () => {
    expect(staleUnknownKinds(view(inv({ signature: { ...SIG, fresh: true } })), ["signature"])).toEqual(["signature"]);
  });

  it("drops signature and finalize once the invoice left draft", () => {
    for (const state of ["open", "paid", "refunded"] as const) {
      expect(staleUnknownKinds(view(inv({ state })), ["finalize", "signature"])).toEqual(["finalize", "signature"]);
    }
  });

  it("drops signature and finalize when there is no invoice", () => {
    expect(staleUnknownKinds(view(null), ["finalize", "signature"])).toEqual(["finalize", "signature"]);
  });

  it("keeps finalize while the invoice is still a draft", () => {
    expect(staleUnknownKinds(view(inv({ signature: { ...SIG, fresh: true } })), ["finalize"])).toEqual([]);
  });

  it("never drops payments or lines (intentLanded decides those)", () => {
    expect(staleUnknownKinds(view(inv({ state: "paid" })), ["payment", "add_line", "remove_line", "create"])).toEqual([]);
  });
});

describe("pageLocks", () => {
  const base = { pendingWrite: false, busy: null, recovering: false, unknownKinds: [] } as const;

  it("nothing locked at rest", () => {
    expect(pageLocks(base)).toEqual({ locked: false, addLocked: false, approvalBlocked: false });
  });

  it("a pending server write locks everything", () => {
    expect(pageLocks({ ...base, pendingWrite: true })).toEqual({ locked: true, addLocked: true, approvalBlocked: true });
  });

  it("recovery locks edits but not the approval button", () => {
    expect(pageLocks({ ...base, recovering: true })).toEqual({ locked: true, addLocked: true, approvalBlocked: false });
  });

  it("an add in flight or unknown leaves the add sheet usable", () => {
    expect(pageLocks({ ...base, busy: "add_line" }).addLocked).toBe(false);
    expect(pageLocks({ ...base, busy: "add_line" }).locked).toBe(true);
    expect(pageLocks({ ...base, unknownKinds: ["add_line"] }).addLocked).toBe(false);
  });

  it("another intent locks the add sheet", () => {
    expect(pageLocks({ ...base, busy: "payment" }).addLocked).toBe(true);
    expect(pageLocks({ ...base, unknownKinds: ["remove_line"] }).addLocked).toBe(true);
  });

  it("approval is blocked by a line or payment, not by its own signature or finalize", () => {
    expect(pageLocks({ ...base, unknownKinds: ["signature", "finalize"] }).approvalBlocked).toBe(false);
    expect(pageLocks({ ...base, unknownKinds: ["add_line"] }).approvalBlocked).toBe(true);
  });
});

describe("approvalCanMount", () => {
  it("draft with lines, lead, finalize or sign allowed", () => {
    expect(approvalCanMount(view(inv()))).toBe(true);
    expect(approvalCanMount(view(inv(), { allowed: ["sign"] }))).toBe(true);
  });

  it("not on open, empty, helper or disallowed", () => {
    expect(approvalCanMount(view(inv({ state: "open" })))).toBe(false);
    expect(approvalCanMount(view(inv({ lines: [] })))).toBe(false);
    expect(approvalCanMount(view(inv(), { isLead: false }))).toBe(false);
    expect(approvalCanMount(view(inv(), { allowed: [] }))).toBe(false);
    expect(approvalCanMount(view(null))).toBe(false);
  });
});

describe("bannerTap", () => {
  it("a retry banner re-sends its kind", () => {
    expect(bannerTap(unknownBanner(["payment"])!, view(inv({ state: "open" })))).toEqual({ type: "retry", kind: "payment" });
  });

  it("a signature banner opens approval only when the sheet can mount", () => {
    const b = unknownBanner(["signature"])!;
    expect(bannerTap(b, view(inv()))).toEqual({ type: "open_approval" });
    expect(bannerTap(b, view(inv({ state: "open" })))).toEqual({ type: "status", text: APPROVAL_CLOSED });
  });
});

describe("inFlightPaymentBody", () => {
  const last = { amountCents: 100 };
  const stored = { amountCents: 200 };

  it("null when idle (the form is editable)", () => {
    expect(inFlightPaymentBody({ busy: false, paymentUnknown: false, stored }, last)).toBeNull();
  });

  it("the last body while busy or unknown", () => {
    expect(inFlightPaymentBody({ busy: true, paymentUnknown: false, stored }, last)).toBe(last);
    expect(inFlightPaymentBody({ busy: false, paymentUnknown: true, stored }, last)).toBe(last);
  });

  it("the stored body after a reload (unknown, no last body)", () => {
    expect(inFlightPaymentBody({ busy: false, paymentUnknown: true, stored }, null)).toBe(stored);
    expect(inFlightPaymentBody({ busy: true, paymentUnknown: false, stored }, null)).toBeNull();
  });
});
