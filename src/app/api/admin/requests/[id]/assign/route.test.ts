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

describe("assign route — status refusals read as human copy", () => {
  it("PATCH names the status in words, never the raw enum", async () => {
    (reassignTechnician as unknown as Mock).mockResolvedValue({
      ok: false,
      reason: "request_not_reassignable",
      currentStatus: "pending",
    });
    const res = await call(PATCH, "PATCH");
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe("REQUEST_NOT_REASSIGNABLE");
    expect(body.error.message).toBe("This request can’t be reassigned while it is pending.");
  });

  it("POST lowers an underscored status to plain words", async () => {
    (assignTechnician as unknown as Mock).mockResolvedValue({
      ok: false,
      reason: "request_not_assignable",
      currentStatus: "in_progress",
    });
    const body = await (await call(POST, "POST")).json();
    expect(body.error.message).toBe("This request can’t be assigned while it is in progress.");
    expect(body.error.message).not.toMatch(/_|'/);
  });
});

describe("assign route — M2 refusals", () => {
  it.each([
    ["POST", POST, assignTechnician],
    ["PATCH", PATCH, reassignTechnician],
  ] as const)("%s maps managed_externally and technician_done; HAS_PROGRESS points to Move…", async (method, fn, writer) => {
    (writer as unknown as Mock).mockResolvedValue({ ok: false, reason: "managed_externally" });
    let body = await (await call(fn, method)).json();
    expect(body.error).toEqual({ code: "MANAGED_EXTERNALLY", message: "Change the technician for this request in FieldPulse." });
    (writer as unknown as Mock).mockResolvedValue({ ok: false, reason: "technician_done" });
    const res = await call(fn, method);
    expect(res.status).toBe(409);
    body = await res.json();
    expect(body.error).toEqual({ code: "TECHNICIAN_DONE", message: "That technician has finished on this visit.", details: { technicianId: TECH } });
    (writer as unknown as Mock).mockResolvedValue({ ok: false, reason: "has_progress" });
    body = await (await call(fn, method)).json();
    expect(body.error.message).toBe("A technician has started this visit. To move it anyway, use Move… on the calendar.");
    expect(logAudit).not.toHaveBeenCalled();
  });
});
