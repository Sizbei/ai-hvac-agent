import { describe, it, expect, vi, beforeEach } from "vitest";

const getAdminSession = vi.fn();
vi.mock("@/lib/auth/session", () => ({
  getAdminSession: () => getAdminSession(),
}));

const createInventoryItem = vi.fn();
const updateInventoryItem = vi.fn();
const listInventory = vi.fn();
const listTrackedPricebookItemIds = vi.fn();
vi.mock("@/lib/admin/inventory-queries", () => ({
  createInventoryItem: (...a: unknown[]) => createInventoryItem(...a),
  updateInventoryItem: (...a: unknown[]) => updateInventoryItem(...a),
  listInventory: (...a: unknown[]) => listInventory(...a),
  listTrackedPricebookItemIds: (...a: unknown[]) => listTrackedPricebookItemIds(...a),
}));

const getPricebookItemById = vi.fn();
vi.mock("@/lib/admin/pricebook-queries", () => ({
  getPricebookItemById: (...a: unknown[]) => getPricebookItemById(...a),
}));

const logAudit = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/admin/audit", () => ({
  logAudit: (...a: unknown[]) => logAudit(...a),
}));

vi.mock("@/lib/rate-limit", () => ({
  slidingWindow: () => ({ allowed: true }),
  RATE_LIMITS: {
    adminRead: { maxRequests: 60, windowMs: 60_000 },
    adminMutation: { maxRequests: 30, windowMs: 60_000 },
  },
}));

vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn(), info: vi.fn() } }));

import { NextRequest } from "next/server";
import { GET, POST } from "./route";

const SESSION = {
  userId: "u-1",
  organizationId: "org-1",
  email: "admin@x.com",
  name: "Admin",
  role: "admin" as const,
};
const ITEM = "7f1a9a4e-0f43-4b8e-9d0a-2c3a5b6c7d8e";

function postReq(body: unknown) {
  return new NextRequest("https://app.example.com/api/admin/inventory", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  getAdminSession.mockResolvedValue(SESSION);
  getPricebookItemById.mockResolvedValue({ id: ITEM });
});

describe("POST /api/admin/inventory", () => {
  it("Track material is insert-only: an already-tracked material is refused, not overwritten", async () => {
    createInventoryItem.mockResolvedValue(false);

    const res = await POST(postReq({ pricebookItemId: ITEM }));
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("ALREADY_TRACKED");
    expect(updateInventoryItem).not.toHaveBeenCalled();
    expect(logAudit).not.toHaveBeenCalled();
  });

  it("Track material passes only the fields that were sent", async () => {
    createInventoryItem.mockResolvedValue(true);

    const res = await POST(postReq({ pricebookItemId: ITEM, unitCostCents: 2000 }));
    expect(res.status).toBe(201);
    expect(createInventoryItem).toHaveBeenCalledWith("org-1", ITEM, { unitCostCents: 2000 });
    expect(logAudit.mock.calls[0]![0]).toMatchObject({ action: "create_inventory_item" });
  });

  it("Edit stock updates the existing row, scoped to the session org", async () => {
    updateInventoryItem.mockResolvedValue(true);

    const res = await POST(
      postReq({ pricebookItemId: ITEM, update: true, quantityOnHand: 3, reorderPoint: null }),
    );
    expect(res.status).toBe(200);
    expect(updateInventoryItem).toHaveBeenCalledWith("org-1", ITEM, {
      quantityOnHand: 3,
      reorderPoint: null,
    });
    expect(createInventoryItem).not.toHaveBeenCalled();
  });

  it("Edit stock on an untracked material is a 404, never an insert", async () => {
    updateInventoryItem.mockResolvedValue(false);
    const res = await POST(postReq({ pricebookItemId: ITEM, update: true, quantityOnHand: 3 }));
    expect(res.status).toBe(404);
    expect(createInventoryItem).not.toHaveBeenCalled();
  });

  it("another org's pricebook item is a 404", async () => {
    getPricebookItemById.mockResolvedValue(null);
    const res = await POST(postReq({ pricebookItemId: ITEM }));
    expect(res.status).toBe(404);
    expect(createInventoryItem).not.toHaveBeenCalled();
  });
});

describe("GET /api/admin/inventory", () => {
  it("returns every tracked pricebook id so the picker can leave them out", async () => {
    listInventory.mockResolvedValue({ items: [], total: 0 });
    listTrackedPricebookItemIds.mockResolvedValue([ITEM]);

    const res = await GET(new NextRequest("https://app.example.com/api/admin/inventory"));
    expect(res.status).toBe(200);
    const body = (await res.json()) as { data: { trackedPricebookItemIds: string[] } };
    expect(body.data.trackedPricebookItemIds).toEqual([ITEM]);
    expect(listTrackedPricebookItemIds).toHaveBeenCalledWith("org-1");
  });
});
