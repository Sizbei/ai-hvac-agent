import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Route-guard + wiring tests for the HCP bulk-operation endpoint. Exercises the
 * auth gate, the body shape guard, the (REAL) validateBulkOperations 400, the
 * NOT_CONFIGURED gate, and that the executor is called with the org-scoped
 * clientId derived from the SESSION (never the body). The executor itself
 * (bulkJobOperations) is mocked — its behavior is covered by its own unit tests.
 */
const { mockGetAdminSession, mockGetHousecallClient, mockBulkJobOperations } =
  vi.hoisted(() => ({
    mockGetAdminSession: vi.fn(),
    mockGetHousecallClient: vi.fn(),
    mockBulkJobOperations: vi.fn(),
  }));

vi.mock("@/lib/auth/session", () => ({
  getAdminSession: () => mockGetAdminSession(),
}));
vi.mock("@/lib/integrations/housecall-pro/client", () => ({
  getHousecallClient: (...a: unknown[]) => mockGetHousecallClient(...a),
}));
// Keep validateBulkOperations + aggregateBulkErrors REAL; mock only the executor.
vi.mock("@/lib/integrations/housecall-pro/bulk-operations", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/integrations/housecall-pro/bulk-operations")>();
  return {
    ...actual,
    bulkJobOperations: (...a: unknown[]) => mockBulkJobOperations(...a),
  };
});
vi.mock("@/lib/rate-limit", () => ({
  slidingWindow: vi.fn(() => ({ allowed: true })),
  RATE_LIMITS: {
    adminMutation: { maxRequests: 100, windowMs: 60000 },
    adminRead: { maxRequests: 100, windowMs: 60000 },
  },
}));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { POST } from "@/app/api/admin/integrations/housecall/bulk-update/route";

const ORG = "00000000-0000-0000-0000-000000000001";
const USER = "00000000-0000-0000-0000-0000000000aa";

function req(body: unknown): Request {
  return new Request("http://test/api/admin/integrations/housecall/bulk-update", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function summary(over: Record<string, unknown> = {}) {
  return {
    total: 1,
    succeeded: 1,
    failed: 0,
    results: [{ hcpJobId: "j1", serviceRequestId: "r1", success: true }],
    startedAt: "t0",
    completedAt: "t1",
    durationMs: 5,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockGetAdminSession.mockResolvedValue({
    userId: USER,
    organizationId: ORG,
    email: "a@b.co",
    name: "A",
    role: "admin",
  });
  mockGetHousecallClient.mockResolvedValue({});
  mockBulkJobOperations.mockResolvedValue(summary());
});

describe("POST /api/admin/integrations/housecall/bulk-update", () => {
  it("401s without a session", async () => {
    mockGetAdminSession.mockResolvedValue(null);
    const res = await POST(req({ operations: [{ hcpJobId: "j", serviceRequestId: "r", action: "cancel" }] }));
    expect(res.status).toBe(401);
    expect(mockBulkJobOperations).not.toHaveBeenCalled();
  });

  it("400s on a non-array body (shape guard, no destructure 500)", async () => {
    const res = await POST(req({ nope: true }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("INVALID_INPUT");
  });

  it("400s on a validation error (real validateBulkOperations: empty batch)", async () => {
    const res = await POST(req({ operations: [] }));
    expect(res.status).toBe(400);
    expect(mockBulkJobOperations).not.toHaveBeenCalled();
  });

  it("400 NOT_CONFIGURED when HCP isn't connected", async () => {
    mockGetHousecallClient.mockResolvedValue(null);
    const res = await POST(req({ operations: [{ hcpJobId: "j", serviceRequestId: "r", action: "cancel" }] }));
    expect(res.status).toBe(400);
    const body = await res.json();
    expect(body.error.code).toBe("NOT_CONFIGURED");
  });

  it("runs the batch with the org-scoped clientId from the SESSION (not the body) and returns the summary", async () => {
    const res = await POST(
      req({
        operations: [{ hcpJobId: "j1", serviceRequestId: "r1", action: "cancel" }],
        // A spoofed clientId/org in the body must be ignored.
        clientId: "org:ATTACKER",
      }),
    );
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
    expect(body.data.completeSuccess).toBe(true);
    // clientId is the 4th arg and is derived from the session org.
    const call = mockBulkJobOperations.mock.calls[0];
    expect(call[3]).toBe(`org:${ORG}`);
  });
});
