import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseJunkList, planJunk, type JunkList, type JunkSnapshot, type MoneyRow } from "./golive-junk";

const entry = (key: string) => ({ key, reason: "test row" });
const list = (over: Partial<JunkList> = {}): JunkList => ({
  requests: [],
  customers: [],
  invoices: [],
  estimates: [],
  pricebookItems: [],
  ...over,
});
const empty: JunkSnapshot = {
  requests: [],
  invoices: [],
  estimates: [],
  customers: [],
  customerRequests: [],
  sessions: [],
  pricebookItems: [],
};
const money = (over: Partial<MoneyRow> & { id: string }): MoneyRow => ({
  fieldpulseId: null,
  requestId: null,
  customerId: null,
  totalCents: 0,
  paidCents: 0,
  synced: true,
  ...over,
});
const UUID_A = "e568d491-579f-4cb5-864a-dc2f4d6f1baa";

describe("parseJunkList", () => {
  it("accepts the repo's default list", () => {
    const raw = JSON.parse(readFileSync("scripts/agent/golive-junk-list.json", "utf8"));
    const parsed = parseJunkList(raw);
    expect(parsed.requests.length).toBeGreaterThan(0);
    expect(parsed.customers.length).toBeGreaterThan(0);
  });

  it("fills missing sections with empty arrays and trims", () => {
    const parsed = parseJunkList({ requests: [{ key: " 123 ", reason: " title 'Test' " }] });
    expect(parsed.requests).toEqual([{ key: "123", reason: "title 'Test'" }]);
    expect(parsed.pricebookItems).toEqual([]);
  });

  it("allows a reference number for requests and a row id for customers only", () => {
    expect(() => parseJunkList({ requests: [entry("HVAC-A7452C89")] })).not.toThrow();
    expect(() => parseJunkList({ customers: [entry(UUID_A)] })).not.toThrow();
    expect(() => parseJunkList({ customers: [entry("HVAC-A7452C89")] })).toThrow(/bad key/);
    expect(() => parseJunkList({ requests: [entry(UUID_A)] })).toThrow(/bad key/);
    expect(() => parseJunkList({ invoices: [entry(UUID_A)] })).toThrow(/bad key/);
  });

  it.each([
    [{ requests: [{ key: "1" }] }, /reason is required/],
    [{ requests: [{ key: "1; DROP", reason: "x" }] }, /bad key/],
    [{ requests: [entry("1"), entry("1")] }, /duplicate key/],
    [{ users: [] }, /unknown section/],
    [{ requests: {} }, /must be an array/],
    [[], /JSON object/],
  ])("rejects %j", (raw, message) => {
    expect(() => parseJunkList(raw)).toThrow(message);
  });
});

describe("planJunk", () => {
  it("hides listed requests and reports keys missing from this database", () => {
    const plan = planJunk(list({ requests: [entry("1"), entry("2")] }), { ...empty, requests: [{ id: "r1", key: "1" }] });
    expect(plan.requestIds).toEqual(["r1"]);
    expect(plan.notFound).toEqual(["requests 2"]);
  });

  it("takes a test request's $0 or unsynced money with it, keeps synced priced rows for review", () => {
    const plan = planJunk(list({ requests: [entry("1")] }), {
      ...empty,
      requests: [{ id: "r1", key: "1" }],
      invoices: [
        money({ id: "i0", requestId: "r1" }),
        money({ id: "i-native", requestId: "r1", totalCents: 51020, synced: false }),
        money({ id: "i1", requestId: "r1", fieldpulseId: "77", totalCents: 500 }),
      ],
      estimates: [money({ id: "e0", requestId: "r1" }), money({ id: "e1", requestId: "r1", fieldpulseId: "88", totalCents: 79110 })],
    });
    expect(plan.invoiceIds).toEqual(["i0", "i-native"]);
    expect(plan.estimateIds).toEqual(["e0"]);
    expect(plan.kept).toEqual([
      "invoices 77: synced and priced, kept (list it to hide)",
      "estimates 88: synced and priced, kept (list it to hide)",
    ]);
  });

  it("hides a listed priced estimate, never a listed invoice with real money paid", () => {
    const plan = planJunk(list({ invoices: [entry("5")], estimates: [entry("6")] }), {
      ...empty,
      invoices: [money({ id: "i5", fieldpulseId: "5", totalCents: 100, paidCents: 1 })],
      estimates: [money({ id: "e6", fieldpulseId: "6", totalCents: 2184824 })],
    });
    expect(plan.invoiceIds).toEqual([]);
    expect(plan.estimateIds).toEqual(["e6"]);
    expect(plan.kept).toEqual(["invoices 5: money paid on it, kept"]);
  });

  it("never hides a paid invoice on a test request", () => {
    const plan = planJunk(list({ requests: [entry("1")] }), {
      ...empty,
      requests: [{ id: "r1", key: "1" }],
      invoices: [money({ id: "i1", requestId: "r1", synced: false, totalCents: 900, paidCents: 900 })],
    });
    expect(plan.invoiceIds).toEqual([]);
    expect(plan.kept).toEqual(["invoices i1: money paid on it, kept"]);
  });

  it("ignores money rows with no test parent", () => {
    const plan = planJunk(list(), { ...empty, invoices: [money({ id: "x", requestId: "other", synced: false })] });
    expect(plan.invoiceIds).toEqual([]);
    expect(plan.kept).toEqual([]);
  });

  it("hides a listed customer and its unsynced money only when all its work goes", () => {
    const l = list({ requests: [entry("1")], customers: [entry("10"), entry("20"), entry(UUID_A)] });
    const plan = planJunk(l, {
      ...empty,
      requests: [{ id: "r1", key: "1" }],
      customers: [
        { id: "c10", key: "10" },
        { id: "c20", key: "20" },
        { id: "cA", key: UUID_A },
      ],
      customerRequests: [
        { customerId: "c10", requestIds: ["r1"] },
        { customerId: "c20", requestIds: ["r1", "real"] },
        { customerId: "cA", requestIds: [] },
      ],
      invoices: [
        money({ id: "i10", customerId: "c10", synced: false, totalCents: 70903 }),
        money({ id: "i20", customerId: "c20", synced: false }),
        money({ id: "iA", customerId: "cA", fieldpulseId: "9", totalCents: 100 }),
      ],
    });
    expect(plan.customerIds).toEqual(["c10"]);
    expect(plan.invoiceIds).toEqual(["i10"]);
    expect(plan.kept).toEqual([
      "customers 20: 1 other requests and 0 priced or paid invoices/estimates, kept",
      `customers ${UUID_A}: 0 other requests and 1 priced or paid invoices/estimates, kept`,
    ]);
  });

  it("hides a conversation only when every request on it is junk", () => {
    const plan = planJunk(list({ requests: [entry("1")] }), {
      ...empty,
      requests: [{ id: "r1", key: "1" }],
      sessions: [
        { id: "s1", requestIds: ["r1"] },
        { id: "s2", requestIds: ["r1", "real"] },
        { id: "s3", requestIds: [] },
      ],
    });
    expect(plan.sessionIds).toEqual(["s1"]);
  });

  it("matches pricebook items by FieldPulse id", () => {
    const plan = planJunk(list({ pricebookItems: [entry("9959284"), entry("1")] }), {
      ...empty,
      pricebookItems: [{ id: "p1", key: "9959284" }],
    });
    expect(plan.pricebookIds).toEqual(["p1"]);
    expect(plan.notFound).toEqual(["pricebookItems 1"]);
  });
});
