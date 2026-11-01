import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/session", () => ({ getAdminSession: vi.fn() }));
vi.mock("@/lib/admin/queries", () => ({ assignTechnician: vi.fn(), reassignTechnician: vi.fn() }));
vi.mock("@/lib/admin/audit", () => ({ logAudit: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({
  slidingWindow: () => ({ allowed: true }),
  RATE_LIMITS: { adminMutation: { maxRequests: 30, windowMs: 60000 } },
}));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), error: vi.fn() } }));

import { POST, PATCH } from "./route";
import { getAdminSession } from "@/lib/auth/session";
import { assignTechnician, reassignTechnician } from "@/lib/admin/queries";
import { logAudit } from "@/lib/admin/audit";

const RID = "11111111-1111-4111-8111-111111111111";
const TECH = "33333333-3333-4333-8333-333333333333";
const call = (fn: typeof POST, method: string) =>
  fn(new Request("http://t/api", { method, body: JSON.stringify({ technicianId: TECH }) }) as never, { params: Promise.resolve({ id: RID }) } as never);

beforeEach(() => {
  vi.clearAllMocks();
  (getAdminSession as unknown as Mock).mockResolvedValue({ userId: "u", organizationId: "o" });
});

describe("assign route — visit #1 refusals", () => {
  it.each([
    ["POST", POST, assignTechnician],
    ["PATCH", PATCH, reassignTechnician],
  ] as const)("%s maps has_progress / visit_ended to 409", async (method, fn, writer) => {
    for (const [reason, code] of [["has_progress", "HAS_PROGRESS"], ["visit_ended", "VISIT_ENDED"]]) {
      (writer as unknown as Mock).mockResolvedValue({ ok: false, reason });
      const res = await call(fn, method);
      expect(res.status).toBe(409);
      expect((await res.json()).error.code).toBe(code);
    }
    expect(logAudit).not.toHaveBeenCalled();
  });
});
