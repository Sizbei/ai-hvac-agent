import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  getTechSession: vi.fn(),
  slidingWindow: vi.fn(),
  listPricebookItemsForAdmin: vi.fn(),
  listTechMaterialItems: vi.fn(),
}));
vi.mock("@/lib/auth/tech-session", () => ({ getTechSession: h.getTechSession }));
vi.mock("@/lib/rate-limit", async (orig) => ({
  ...(await orig<typeof import("@/lib/rate-limit")>()),
  slidingWindow: h.slidingWindow,
}));
vi.mock("@/lib/admin/pricebook-queries", () => ({
  listPricebookItemsForAdmin: h.listPricebookItemsForAdmin,
  listTechMaterialItems: h.listTechMaterialItems,
}));

import { GET } from "./route";
import { RATE_LIMITS } from "@/lib/rate-limit";

const req = (qs = "") => new Request(`http://localhost/api/tech/pricebook${qs}`) as never;
const item = (type: string, n: number) => ({
  id: `id-${type}-${n}`, name: `${type} ${n}`, type, priceCents: 1000 * n, sku: `SKU-${n}`,
  costCents: 400, markupPct: 150, description: "internal", active: true,
});

beforeEach(() => {
  vi.clearAllMocks();
  h.getTechSession.mockResolvedValue({ userId: "u1", organizationId: "o1" });
  h.slidingWindow.mockReturnValue({ allowed: true, remaining: 1, resetMs: 1 });
  h.listTechMaterialItems.mockResolvedValue([
    { id: "id-material-1", name: "material 1", type: "material", priceCents: 1000 },
    { id: "id-equipment-1", name: "equipment 1", type: "equipment", priceCents: 1000 },
  ]);
  h.listPricebookItemsForAdmin.mockImplementation(async (_org: string, o: { type?: string }) => ({
    items: o.type ? [item(o.type, 1)] : [item("service", 1), item("material", 2), item("equipment", 3)],
  }));
});

describe("GET /api/tech/pricebook?scope=invoice", () => {
  it("401 without a session", async () => {
    h.getTechSession.mockResolvedValue(null);
    expect((await GET(req("?scope=invoice&q=cap"))).status).toBe(401);
  });

  it("a 1-character query returns [] without searching", async () => {
    const res = await GET(req("?scope=invoice&q=c"));
    expect(await res.json()).toEqual({ success: true, data: { items: [] } });
    expect(h.listPricebookItemsForAdmin).not.toHaveBeenCalled();
  });

  it("a query over 100 characters returns [] without searching; exactly 100 searches", async () => {
    const res = await GET(req(`?scope=invoice&q=${"a".repeat(101)}`));
    expect(await res.json()).toEqual({ success: true, data: { items: [] } });
    expect(h.listPricebookItemsForAdmin).not.toHaveBeenCalled();
    await GET(req(`?scope=invoice&q=${"a".repeat(100)}`));
    expect(h.listPricebookItemsForAdmin).toHaveBeenCalledTimes(1);
  });

  it("whitespace-padded short queries count trimmed", async () => {
    const res = await GET(req("?scope=invoice&q=%20c%20"));
    expect((await res.json()).data.items).toEqual([]);
  });

  it("searches active items of every type, limit 50, projected without cost fields", async () => {
    const res = await GET(req("?scope=invoice&q=cap"));
    expect(res.status).toBe(200);
    expect(h.listPricebookItemsForAdmin).toHaveBeenCalledWith("o1", { search: "cap", includeInactive: false, limit: 50 });
    const { items } = (await res.json()).data;
    expect(items).toEqual([
      { id: "id-service-1", name: "service 1", type: "service", priceCents: 1000, sku: "SKU-1" },
      { id: "id-material-2", name: "material 2", type: "material", priceCents: 2000, sku: "SKU-2" },
      { id: "id-equipment-3", name: "equipment 3", type: "equipment", priceCents: 3000, sku: "SKU-3" },
    ]);
    expect(JSON.stringify(items)).not.toMatch(/cost|markup/i);
  });

  it("rate-limited on the tech pricebook key (adminRead)", async () => {
    h.slidingWindow.mockReturnValue({ allowed: false, remaining: 0, resetMs: 1 });
    const res = await GET(req("?scope=invoice&q=cap"));
    expect(res.status).toBe(429);
    expect(h.slidingWindow).toHaveBeenCalledWith("tech:pricebook:u1", RATE_LIMITS.adminRead.maxRequests, RATE_LIMITS.adminRead.windowMs);
    expect(h.listPricebookItemsForAdmin).not.toHaveBeenCalled();
  });
});

describe("GET /api/tech/pricebook (materials picker, unchanged)", () => {
  it("returns material and equipment items only, id/name/type/priceCents", async () => {
    const res = await GET(req());
    expect(res.status).toBe(200);
    // One narrow query, never the admin list (which carries cost and the FieldPulse blob).
    expect(h.listTechMaterialItems).toHaveBeenCalledWith("o1", 20000);
    expect(h.listPricebookItemsForAdmin).not.toHaveBeenCalled();
    expect((await res.json()).data.items).toEqual([
      { id: "id-material-1", name: "material 1", type: "material", priceCents: 1000 },
      { id: "id-equipment-1", name: "equipment 1", type: "equipment", priceCents: 1000 },
    ]);
  });

  it("is not rate limited (old behaviour)", async () => {
    await GET(req("?q=cap"));
    expect(h.slidingWindow).not.toHaveBeenCalled();
  });
});
