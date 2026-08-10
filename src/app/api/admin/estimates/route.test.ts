import { describe, it, expect, vi, beforeEach } from "vitest";

const getAdminSession = vi.fn();
vi.mock("@/lib/auth/session", () => ({
  getAdminSession: () => getAdminSession(),
}));

const listEstimates = vi.fn();
const createEstimate = vi.fn();
const getEstimatePipelineStats = vi.fn();
const expireOverdueEstimates = vi.fn().mockResolvedValue({ expiredIds: [] });
vi.mock("@/lib/admin/estimate-queries", () => ({
  listEstimates: (...a: unknown[]) => listEstimates(...a),
  createEstimate: (...a: unknown[]) => createEstimate(...a),
  getEstimatePipelineStats: (...a: unknown[]) => getEstimatePipelineStats(...a),
  expireOverdueEstimates: (...a: unknown[]) => expireOverdueEstimates(...a),
}));

const getDefaultTaxBps = vi.fn().mockResolvedValue(0);
const getPricebookItemById = vi.fn();
vi.mock("@/lib/admin/pricebook-queries", () => ({
  getDefaultTaxBps: (...a: unknown[]) => getDefaultTaxBps(...a),
  getPricebookItemById: (...a: unknown[]) => getPricebookItemById(...a),
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

vi.mock("@/lib/communication/money-triggers", () => ({
  triggerEstimateSent: vi.fn().mockResolvedValue(undefined),
}));

import { NextRequest } from "next/server";
import { POST } from "./route";

const SESSION = {
  userId: "u-1",
  organizationId: "org-1",
  email: "admin@x.com",
  name: "Admin",
  role: "admin" as const,
};

function postReq(body: unknown) {
  return new NextRequest("https://app.example.com/api/admin/estimates", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

const PRICEBOOK_ITEM_ID = "11111111-1111-1111-1111-111111111111";

beforeEach(() => {
  vi.clearAllMocks();
  getAdminSession.mockResolvedValue(SESSION);
  getDefaultTaxBps.mockResolvedValue(0);
});

describe("POST /api/admin/estimates — Restimates-3 money-column caps", () => {
  it("rejects an over-cap manual-line unitPriceCents with 400 VALIDATION_ERROR before touching the DB", async () => {
    const res = await POST(
      postReq({
        options: [
          {
            name: "Good",
            lineItems: [{ name: "Custom line", quantity: 1, unitPriceCents: 100_000_000 }],
          },
        ],
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(createEstimate).not.toHaveBeenCalled();
  });

  it("rejects an over-cap quantity with 400 VALIDATION_ERROR before touching the DB", async () => {
    const res = await POST(
      postReq({
        options: [
          {
            name: "Good",
            lineItems: [
              { pricebookItemId: PRICEBOOK_ITEM_ID, quantity: 2_000_000 },
            ],
          },
        ],
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(createEstimate).not.toHaveBeenCalled();
    expect(getPricebookItemById).not.toHaveBeenCalled();
  });

  it("still accepts an at-cap payload (boundary is inclusive, not off-by-one)", async () => {
    getPricebookItemById.mockResolvedValue({
      id: PRICEBOOK_ITEM_ID,
      active: true,
      name: "Item",
      priceCents: 100,
      memberPriceCents: null,
      costCents: 0,
    });
    createEstimate.mockResolvedValue({ estimateId: "est-1", approvalToken: "tok" });

    const res = await POST(
      postReq({
        options: [
          {
            name: "Good",
            lineItems: [{ name: "Custom line", quantity: 1, unitPriceCents: 99_999_999 }],
          },
        ],
      }),
    );
    expect(res.status).toBe(201);
    expect(createEstimate).toHaveBeenCalledOnce();
  });

  // Bounding the factors is not the same as bounding what gets stored. Both
  // values below are individually legal under the per-field caps, but their
  // product is what lands in the int4 `line_total_cents` / `total_cents`
  // columns — so without a derived-value check this 500s on insert.
  it("rejects a line whose quantity x unitPriceCents overflows int4, even though both factors are in range", async () => {
    const res = await POST(
      postReq({
        options: [
          {
            name: "Good",
            lineItems: [{ name: "Custom line", quantity: 22, unitPriceCents: 99_999_999 }],
          },
        ],
      }),
    );
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("VALIDATION_ERROR");
    expect(createEstimate).not.toHaveBeenCalled();
  });

  it("rejects when no single line overflows but the option total does", async () => {
    const line = { name: "Custom line", quantity: 1, unitPriceCents: 99_999_999 };
    const res = await POST(
      postReq({
        options: [
          {
            name: "Good",
            // 25 x $999,999.99 = 2,499,999,975 > INT32_MAX, but each line
            // total is only 99,999,999 — the rollup is what breaks.
            lineItems: Array.from({ length: 25 }, () => ({ ...line })),
          },
        ],
      }),
    );
    expect(res.status).toBe(400);
    expect(createEstimate).not.toHaveBeenCalled();
  });
});
