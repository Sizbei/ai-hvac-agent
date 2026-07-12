import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

vi.mock("@/lib/auth/tech-session", () => ({ deleteTechSession: vi.fn() }));

import { POST } from "./route";
import { deleteTechSession } from "@/lib/auth/tech-session";

describe("POST /api/auth/tech/logout", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("deletes the tech session and returns success", async () => {
    const res = await POST();
    expect(deleteTechSession).toHaveBeenCalledOnce();
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.success).toBe(true);
  });

  it("returns 500 when session deletion throws", async () => {
    (deleteTechSession as Mock).mockRejectedValueOnce(new Error("boom"));
    const res = await POST();
    expect(res.status).toBe(500);
    const body = await res.json();
    expect(body.success).toBe(false);
  });
});
