import { describe, it, expect, vi, beforeEach } from "vitest";

const deleteAdminSession = vi.fn();
vi.mock("@/lib/auth/session", () => ({
  deleteAdminSession: () => deleteAdminSession(),
}));

vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn(), info: vi.fn() } }));

import { POST } from "./route";

beforeEach(() => {
  vi.clearAllMocks();
  deleteAdminSession.mockResolvedValue(undefined);
});

describe("POST /api/auth/logout", () => {
  it("ends the session and clears the preview cookie", async () => {
    const res = await POST();
    expect(res.status).toBe(200);
    expect(deleteAdminSession).toHaveBeenCalledTimes(1);
    const setCookie = res.headers.get("set-cookie") ?? "";
    expect(setCookie).toMatch(/hvac_preview=;/);
    expect(setCookie).toMatch(/Max-Age=0/);
    expect(setCookie).toMatch(/Expires=Thu, 01 Jan 1970 00:00:00 GMT/);
    expect(setCookie).toMatch(/Path=\//);
  });

  it("500 LOGOUT_FAILED when the session delete fails", async () => {
    deleteAdminSession.mockRejectedValue(new Error("boom"));
    const res = await POST();
    expect(res.status).toBe(500);
    expect((await res.json()).error.code).toBe("LOGOUT_FAILED");
  });
});
