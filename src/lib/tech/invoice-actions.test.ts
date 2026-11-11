import { describe, it, expect } from "vitest";
import { invoiceAllowedActions } from "./invoice-actions";

type Input = Parameters<typeof invoiceAllowedActions>[0];
const base: Input = {
  state: "none", isLead: true, onSite: true, native: true, externalInvoice: false, balanceCents: 0,
  lines: 0, fromEstimate: false, customerHasPhone: true, signatureFresh: false, payLinks: true,
};
const allowed = (over: Partial<Input>) => invoiceAllowedActions({ ...base, ...over });

describe("invoiceAllowedActions", () => {
  it("none: create for an on-site native lead", () => {
    expect(allowed({})).toEqual(["create"]);
  });

  it("none: no create with an external invoice, off site, non-native or as a helper", () => {
    expect(allowed({ externalInvoice: true })).toEqual([]);
    expect(allowed({ onSite: false })).toEqual([]);
    expect(allowed({ native: false })).toEqual([]);
    expect(allowed({ isLead: false })).toEqual([]);
  });

  it("draft with no lines: edit lines and sign, no finalize", () => {
    expect(allowed({ state: "draft" })).toEqual(["add_line", "remove_line", "sign"]);
  });

  it("draft with lines and a fresh signature: finalize, no sign", () => {
    expect(allowed({ state: "draft", lines: 2, signatureFresh: true })).toEqual(["add_line", "remove_line", "finalize"]);
    expect(allowed({ state: "draft", lines: 2 })).toEqual(["add_line", "remove_line", "finalize", "sign"]);
  });

  it("draft from an estimate: no line edits", () => {
    expect(allowed({ state: "draft", lines: 1, fromEstimate: true })).toEqual(["finalize", "sign"]);
  });

  it("open with a balance: record payment, pay link only with a phone", () => {
    expect(allowed({ state: "open", lines: 1, balanceCents: 8900 })).toEqual(["record_payment", "pay_link"]);
    expect(allowed({ state: "open", lines: 1, balanceCents: 8900, customerHasPhone: false })).toEqual(["record_payment"]);
    expect(allowed({ state: "open", lines: 1, balanceCents: 8900, fromEstimate: true })).toEqual(["record_payment", "pay_link"]);
  });

  it("open with a balance: no pay link when the org's pay links are off", () => {
    expect(allowed({ state: "open", lines: 1, balanceCents: 8900, payLinks: false })).toEqual(["record_payment"]);
  });

  it("open with nothing due: nothing", () => {
    expect(allowed({ state: "open", lines: 1, balanceCents: 0 })).toEqual([]);
  });

  it("paid and refunded: create a new draft (paid-view ruling), nothing else", () => {
    expect(allowed({ state: "paid", lines: 1 })).toEqual(["create"]);
    expect(allowed({ state: "refunded", lines: 1, balanceCents: 500 })).toEqual(["create"]);
  });

  it("paid and refunded: no create with an external invoice, off site, non-native or as a helper", () => {
    for (const state of ["paid", "refunded"] as const) {
      expect(allowed({ state, externalInvoice: true })).toEqual([]);
      expect(allowed({ state, onSite: false })).toEqual([]);
      expect(allowed({ state, native: false })).toEqual([]);
      expect(allowed({ state, isLead: false })).toEqual([]);
    }
  });

  it("nothing for helpers, off site or non-native whatever the state", () => {
    for (const state of ["draft", "open"] as const) {
      expect(allowed({ state, lines: 1, balanceCents: 100, isLead: false })).toEqual([]);
      expect(allowed({ state, lines: 1, balanceCents: 100, onSite: false })).toEqual([]);
      expect(allowed({ state, lines: 1, balanceCents: 100, native: false })).toEqual([]);
    }
  });
});
