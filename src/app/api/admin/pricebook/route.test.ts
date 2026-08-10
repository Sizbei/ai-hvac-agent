import { describe, it, expect, vi, beforeEach } from "vitest";

const getAdminSession = vi.fn();
vi.mock("@/lib/auth/session", () => ({
  getAdminSession: () => getAdminSession(),
}));

const createPricebookItem = vi.fn();
const listPricebookItemsForAdmin = vi.fn();
vi.mock("@/lib/admin/pricebook-queries", () => ({
  createPricebookItem: (...a: unknown[]) => createPricebookItem(...a),
  listPricebookItemsForAdmin: (...a: unknown[]) => listPricebookItemsForAdmin(...a),
}));

const logAudit = vi.fn().mockResolvedValue(undefined);
vi.mock("@/lib/admin/audit", () => ({
  logAudit: (...a: unknown[]) => logAudit(...a),
}));

vi.mock("@/lib/db/unique-violation", () => ({
  isUniqueViolation: () => false,
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
import { POST } from "./route";

const SESSION = {
  userId: "u-1",
  organizationId: "org-1",
  email: "admin@x.com",
  name: "Admin",
  role: "admin" as const,
};

const ITEM_NAME = "24k Gold Furnace Filter — Customer John Smith special order";

function postReq(body: unknown) {
  return new NextRequest("https://app.example.com/api/admin/pricebook", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("POST /api/admin/pricebook", () => {
  it("Gaudit-1: audit details never contain the free-text item name", async () => {
    getAdminSession.mockResolvedValue(SESSION);
    createPricebookItem.mockResolvedValue("item-1");

    const res = await POST(
      postReq({
        type: "material",
        name: ITEM_NAME,
        priceCents: 1000,
      }),
    );
    expect(res.status).toBe(201);

    expect(logAudit).toHaveBeenCalledOnce();
    const call = logAudit.mock.calls[0]![0] as { details: string; entityId: string };
    expect(call.entityId).toBe("item-1");

    const parsed: unknown = JSON.parse(call.details);
    expect(JSON.stringify(parsed)).not.toContain(ITEM_NAME);
    expect(Object.values(parsed as Record<string, unknown>)).not.toContain(ITEM_NAME);
    expect(parsed).toMatchObject({ type: "material" });
    expect((parsed as { fields: string[] }).fields).toContain("name");
  });
});
