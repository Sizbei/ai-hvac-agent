import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/session", () => ({ getAdminSession: vi.fn() }));
vi.mock("@/lib/admin/dispatch-decision-queries", () => ({ getDispatchDecisionForRequest: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({
  slidingWindow: () => ({ allowed: true }),
  RATE_LIMITS: { adminRead: { maxRequests: 100, windowMs: 60000 } },
}));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), error: vi.fn() } }));

import { GET } from "./route";
import { getAdminSession } from "@/lib/auth/session";
import { getDispatchDecisionForRequest } from "@/lib/admin/dispatch-decision-queries";

const RID = "11111111-1111-4111-8111-111111111111";
const call = () => GET(new Request("http://t/api") as never, { params: Promise.resolve({ id: RID }) });

beforeEach(() => {
  vi.clearAllMocks();
  (getAdminSession as unknown as Mock).mockResolvedValue({ userId: "u", organizationId: "org-1" });
});

describe("GET /api/admin/requests/[id]/decision", () => {
  it("returns 200 with null data when no decision was recorded (not a 404)", async () => {
    (getDispatchDecisionForRequest as unknown as Mock).mockResolvedValue(null);
    const res = await call();
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ success: true, data: null });
  });

  it("scopes the lookup to the session org and returns the decision", async () => {
    (getDispatchDecisionForRequest as unknown as Mock).mockResolvedValue({ outcome: "assigned" });
    const res = await call();
    expect(res.status).toBe(200);
    expect(getDispatchDecisionForRequest).toHaveBeenCalledWith("org-1", RID);
    expect((await res.json()).data).toEqual({ outcome: "assigned" });
  });

  it("still refuses without a session", async () => {
    (getAdminSession as unknown as Mock).mockResolvedValue(null);
    expect((await call()).status).toBe(401);
  });
});
