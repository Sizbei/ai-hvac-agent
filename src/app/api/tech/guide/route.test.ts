import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

vi.mock("@/lib/auth/tech-session", () => ({ getTechSession: vi.fn() }));
vi.mock("@/lib/tech/guide-queries", () => ({ getGuide: vi.fn(), hideGuide: vi.fn() }));
vi.mock("@/lib/rate-limit", async (orig) => ({ ...(await orig<typeof import("@/lib/rate-limit")>()), slidingWindow: () => ({ allowed: true }) }));

import { GET, PATCH } from "./route";
import { getTechSession } from "@/lib/auth/tech-session";
import { getGuide, hideGuide } from "@/lib/tech/guide-queries";
import { NextRequest } from "next/server";

const session = { userId: "u", organizationId: "o", email: "t@x", name: "T", role: "technician" as const };
const patch = (body: unknown, headers: Record<string, string> = { origin: "http://localhost:3000" }) =>
  new NextRequest("http://localhost:3000/api/tech/guide", { method: "PATCH", headers: { "content-type": "application/json", ...headers }, body: JSON.stringify(body) });

beforeEach(() => {
  vi.clearAllMocks();
  (getTechSession as unknown as Mock).mockResolvedValue(session);
  (getGuide as unknown as Mock).mockResolvedValue({ steps: [], progress: { requiredDone: 0, requiredTotal: 2, optionalDone: 0, optionalTotal: 7 }, upNext: "start_job", finished: false, hasOpenJob: false, hiddenAt: null, cardHidden: false });
  (hideGuide as unknown as Mock).mockResolvedValue({ hiddenAt: "2026-11-05T00:00:00.000Z" });
});

describe("GET /api/tech/guide", () => {
  it("401 without a session", async () => {
    (getTechSession as unknown as Mock).mockResolvedValue(null);
    expect((await GET()).status).toBe(401);
    expect(getGuide).not.toHaveBeenCalled();
  });
  it("returns the payload for the session's org and user", async () => {
    const res = await GET();
    expect(res.status).toBe(200);
    expect(getGuide).toHaveBeenCalledWith("o", "u");
    expect((await res.json()).data.upNext).toBe("start_job");
  });
  it("500 with human copy when the query throws", async () => {
    (getGuide as unknown as Mock).mockRejectedValue(new Error("x"));
    const res = await GET();
    expect(res.status).toBe(500);
    expect((await res.json()).error.message).toBe("Couldn't load the guide.");
  });
});

describe("PATCH /api/tech/guide", () => {
  it("401 without a session (Origin present)", async () => {
    (getTechSession as unknown as Mock).mockResolvedValue(null);
    expect((await PATCH(patch({ hidden: true }))).status).toBe(401);
  });
  it("403 on a missing or foreign Origin", async () => {
    expect((await PATCH(patch({ hidden: true }, {}))).status).toBe(403);
    expect((await PATCH(patch({ hidden: true }, { origin: "https://evil.example" }))).status).toBe(403);
    expect(hideGuide).not.toHaveBeenCalled();
  });
  it("400 on {} and on { hidden: false }", async () => {
    expect((await PATCH(patch({}))).status).toBe(400);
    expect((await PATCH(patch({ hidden: false }))).status).toBe(400);
  });
  it("hides and returns hiddenAt", async () => {
    const res = await PATCH(patch({ hidden: true }));
    expect(res.status).toBe(200);
    expect(hideGuide).toHaveBeenCalledWith("o", "u");
    expect((await res.json()).data).toEqual({ hiddenAt: "2026-11-05T00:00:00.000Z" });
  });
  it("404 when no technician row matched", async () => {
    (hideGuide as unknown as Mock).mockResolvedValue(null);
    expect((await PATCH(patch({ hidden: true }))).status).toBe(404);
  });
});
