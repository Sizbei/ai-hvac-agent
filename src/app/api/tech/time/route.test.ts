import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

vi.mock("@/lib/auth/tech-session", () => ({ getTechSession: vi.fn() }));
vi.mock("@/lib/tech/timesheet-queries", () => ({
  closeGeneralEntry: vi.fn(),
  getOpenGeneralEntry: vi.fn(),
  openGeneralEntry: vi.fn(),
}));

import { GET } from "./route";
import { getTechSession } from "@/lib/auth/tech-session";
import { getOpenGeneralEntry } from "@/lib/tech/timesheet-queries";

beforeEach(() => {
  vi.clearAllMocks();
  (getTechSession as unknown as Mock).mockResolvedValue({ userId: "u", organizationId: "o" });
});

describe("GET /api/tech/time", () => {
  it("401 without a tech session", async () => {
    (getTechSession as unknown as Mock).mockResolvedValue(null);
    expect((await GET()).status).toBe(401);
  });

  it("200 with a null clockInAt when clocked out (no 404 console noise)", async () => {
    (getOpenGeneralEntry as unknown as Mock).mockResolvedValue(null);
    const res = await GET();
    expect(res.status).toBe(200);
    expect((await res.json()).data).toEqual({ id: null, clockInAt: null });
  });

  it("200 with the open entry", async () => {
    (getOpenGeneralEntry as unknown as Mock).mockResolvedValue({ id: "e1", clockInAt: new Date("2026-11-05T14:00:00Z") });
    const res = await GET();
    expect((await res.json()).data).toEqual({ id: "e1", clockInAt: "2026-11-05T14:00:00.000Z" });
  });
});
