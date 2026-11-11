import { describe, it, expect, vi } from "vitest";
import { createFieldpulseDetailLoader, fieldpulseDataFromDetail, fieldpulseDetailUrl } from "./fieldpulse-detail-fetch";

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

describe("createFieldpulseDetailLoader (dedupe cache)", () => {
  const body = (data: unknown) => ({ data: { invoice: { fieldpulseData: data } } });
  const ok = (json: unknown) => Promise.resolve(new Response(JSON.stringify(json), { status: 200 }));

  it("fetches a record's detail once and shares the result", async () => {
    const fetcher = vi.fn(() => ok(body({ jobType: "repair" })));
    const load = createFieldpulseDetailLoader(fetcher);
    const [a, b] = await Promise.all([load("invoice", "i-1"), load("invoice", "i-1")]);
    expect(a).toEqual({ jobType: "repair" });
    expect(b).toBe(a);
    expect(await load("invoice", "i-1")).toBe(a);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledWith("/api/admin/invoices/i-1");
  });

  it("keys by record and id", async () => {
    const fetcher = vi.fn(() => ok(body(null)));
    const load = createFieldpulseDetailLoader(fetcher);
    await load("invoice", "i-1");
    await load("invoice", "i-2");
    await load("estimate", "i-1");
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("a failed load rejects and is retried on the next call", async () => {
    const fetcher = vi
      .fn<(url: string) => Promise<Response>>()
      .mockResolvedValueOnce(new Response("{}", { status: 500 }))
      .mockRejectedValueOnce(new TypeError("offline"))
      .mockImplementation(() => ok(body({ a: 1 })));
    const load = createFieldpulseDetailLoader(fetcher);
    await expect(load("invoice", "i-1")).rejects.toThrow();
    await expect(load("invoice", "i-1")).rejects.toThrow("offline");
    expect(await load("invoice", "i-1")).toEqual({ a: 1 });
    expect(fetcher).toHaveBeenCalledTimes(3);
  });

  it("holds at most `max` records, dropping the oldest", async () => {
    const fetcher = vi.fn(() => ok(body(null)));
    const load = createFieldpulseDetailLoader(fetcher, 2);
    await load("invoice", "a");
    await load("invoice", "b");
    await load("invoice", "c");
    await load("invoice", "c");
    await load("invoice", "b");
    expect(fetcher).toHaveBeenCalledTimes(3);
    await load("invoice", "a");
    expect(fetcher).toHaveBeenCalledTimes(4);
  });
});
