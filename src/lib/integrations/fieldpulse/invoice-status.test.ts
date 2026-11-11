import { describe, it, expect } from "vitest";
import {
  buildFpInvoiceStatusLookup,
  fpInvoiceStateFromStatus,
  requestInvoiceStatusWord,
} from "./invoice-status";

// Shape of GET /invoices/status-workflows `response` (live 2026-11-11; ids are
// per company and must never be hardcoded in the mapping — only `type` matters).
const WORKFLOWS = [
  {
    id: 344745,
    statuses: [
      { id: 1878561, name: "Invoice Draft", type: "invoice_draft" },
      { id: 1878562, name: "Invoiced", type: "invoice_invoiced" },
      { id: 1878563, name: "Sent", type: "invoice_sent" },
      { id: 1878564, name: "Partially Paid", type: "invoice_partially_paid" },
      { id: 1878565, name: "Paid", type: "invoice_paid" },
      { id: 1878566, name: "Void", type: "invoice_void" },
      { id: 9, name: "Mystery", type: "invoice_something_new" },
    ],
  },
];
const LOOKUP = buildFpInvoiceStatusLookup(WORKFLOWS);

describe("fpInvoiceStateFromStatus", () => {
  it.each([
    [1878561, "draft"],
    [1878562, "open"],
    [1878563, "open"],
    [1878564, "open"],
    [1878565, "paid"],
    [1878566, "void"],
  ] as const)("status_id %s → %s", (id, state) => {
    expect(fpInvoiceStateFromStatus(id, LOOKUP)).toBe(state);
  });

  it("accepts the id as a string", () => {
    expect(fpInvoiceStateFromStatus("1878566", LOOKUP)).toBe("void");
  });

  it("decides by type, not by the company's name or id", () => {
    const other = buildFpInvoiceStatusLookup([
      { statuses: [{ id: 42, name: "Cancelled (renamed)", type: "invoice_void" }] },
    ]);
    expect(fpInvoiceStateFromStatus(42, other)).toBe("void");
    expect(fpInvoiceStateFromStatus(1878566, other)).toBeNull();
  });

  it("keeps the stored state (null) when the lookup failed or came back empty", () => {
    expect(fpInvoiceStateFromStatus(1878566, null)).toBeNull();
    expect(fpInvoiceStateFromStatus(1878566, undefined)).toBeNull();
    expect(fpInvoiceStateFromStatus(1878566, new Map())).toBeNull();
    expect(fpInvoiceStateFromStatus(1878566, buildFpInvoiceStatusLookup([]))).toBeNull();
  });

  it("keeps the stored state for an unknown id, a missing id or an unknown type", () => {
    expect(fpInvoiceStateFromStatus(123, LOOKUP)).toBeNull();
    expect(fpInvoiceStateFromStatus(null, LOOKUP)).toBeNull();
    expect(fpInvoiceStateFromStatus("", LOOKUP)).toBeNull();
    expect(fpInvoiceStateFromStatus(9, LOOKUP)).toBeNull();
  });
});

describe("requestInvoiceStatusWord", () => {
  it("maps to the words syncInvoiceStatus understands", () => {
    expect(requestInvoiceStatusWord("draft")).toBe("draft");
    expect(requestInvoiceStatusWord("open")).toBe("sent");
    expect(requestInvoiceStatusWord("paid")).toBe("paid");
    expect(requestInvoiceStatusWord("void")).toBe("void");
  });
});
