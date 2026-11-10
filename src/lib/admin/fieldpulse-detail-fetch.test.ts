import { describe, it, expect } from "vitest";
import { fieldpulseDataFromDetail, fieldpulseDetailUrl } from "./fieldpulse-detail-fetch";

describe("fieldpulseDetailUrl", () => {
  it("points at the unchanged detail endpoint of each record type", () => {
    expect(fieldpulseDetailUrl("invoice", "abc")).toBe("/api/admin/invoices/abc");
    expect(fieldpulseDetailUrl("estimate", "abc")).toBe("/api/admin/estimates/abc");
  });

  it("encodes the id so it can't change the path", () => {
    expect(fieldpulseDetailUrl("invoice", "a/b?c")).toBe("/api/admin/invoices/a%2Fb%3Fc");
  });
});

describe("fieldpulseDataFromDetail", () => {
  const data = { discount: 5, job_title: "Furnace — tune-up ✓" };

  it("reads the invoice detail envelope", () => {
    const body = { success: true, data: { invoice: { id: "i", fieldpulseData: data } } };
    expect(fieldpulseDataFromDetail(body, "invoice")).toEqual(data);
  });

  it("reads the estimate detail envelope", () => {
    const body = { success: true, data: { estimate: { id: "e", fieldpulseData: data } } };
    expect(fieldpulseDataFromDetail(body, "estimate")).toEqual(data);
  });

  it("does not read the other record type's key", () => {
    const body = { success: true, data: { invoice: { fieldpulseData: data } } };
    expect(fieldpulseDataFromDetail(body, "estimate")).toBeNull();
  });

  it.each([
    ["null body", null],
    ["undefined body", undefined],
    ["string body", "oops"],
    ["failed envelope", { success: false, error: { code: "NOT_FOUND" } }],
    ["no data", { success: true }],
    ["data is null", { success: true, data: null }],
    ["record missing", { success: true, data: {} }],
    ["record is a string", { success: true, data: { invoice: "x" } }],
    ["fieldpulseData null", { success: true, data: { invoice: { fieldpulseData: null } } }],
    ["fieldpulseData array", { success: true, data: { invoice: { fieldpulseData: [1, 2] } } }],
    ["fieldpulseData string", { success: true, data: { invoice: { fieldpulseData: "{}" } } }],
  ])("returns null for %s", (_label, body) => {
    expect(fieldpulseDataFromDetail(body, "invoice")).toBeNull();
  });
});
