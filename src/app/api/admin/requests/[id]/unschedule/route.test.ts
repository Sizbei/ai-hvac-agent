import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

// after() throws outside a Next request scope; stub it, keep the rest real.
vi.mock("next/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("next/server")>();
  return { ...actual, after: (fn: () => void) => void fn };
});
vi.mock("@/lib/auth/session", () => ({ getAdminSession: vi.fn() }));
vi.mock("@/lib/admin/scheduling-queries", () => ({ unscheduleRequest: vi.fn() }));
vi.mock("@/lib/admin/audit", () => ({ logAudit: vi.fn() }));
vi.mock("@/lib/integrations/google-calendar/sync", () => ({
  syncRequestToCalendar: vi.fn(),
}));
vi.mock("@/lib/integrations/housecall-pro/job-sync", () => ({
  pushJobToHcp: vi.fn(),
}));
vi.mock("@/lib/rate-limit", () => ({
  slidingWindow: () => ({ allowed: true }),
  RATE_LIMITS: { adminMutation: { maxRequests: 30, windowMs: 60000 } },
}));

import { POST } from "./route";
import { getAdminSession } from "@/lib/auth/session";
import { unscheduleRequest } from "@/lib/admin/scheduling-queries";

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const req = () =>
  new Request("http://t/api", { method: "POST" }) as never;
const VALID_ID = "11111111-1111-1111-1111-111111111111";

beforeEach(() => vi.clearAllMocks());

describe("POST unschedule", () => {
  it("401 without a session", async () => {
    (getAdminSession as unknown as Mock).mockResolvedValue(null);
    const res = await POST(req(), ctx(VALID_ID) as never);
    expect(res.status).toBe(401);
  });

  it("400 on a malformed id", async () => {
    (getAdminSession as unknown as Mock).mockResolvedValue({
      userId: "u",
      organizationId: "o",
    });
    const res = await POST(req(), ctx("not-a-uuid") as never);
    expect(res.status).toBe(400);
  });

  it("200 when the mutation succeeds", async () => {
    (getAdminSession as unknown as Mock).mockResolvedValue({
      userId: "u",
      organizationId: "o",
    });
    (unscheduleRequest as unknown as Mock).mockResolvedValue({ ok: true });
    const res = await POST(req(), ctx(VALID_ID) as never);
    expect(res.status).toBe(200);
  });

  it("409 when the job is terminal", async () => {
    (getAdminSession as unknown as Mock).mockResolvedValue({
      userId: "u",
      organizationId: "o",
    });
    (unscheduleRequest as unknown as Mock).mockResolvedValue({
      ok: false,
      reason: "request_terminal",
      currentStatus: "completed",
    });
    const res = await POST(req(), ctx(VALID_ID) as never);
    expect(res.status).toBe(409);
  });
});
