import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({ getTechSession: vi.fn(), slidingWindow: vi.fn(), getSiteView: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/auth/tech-session", () => ({ getTechSession: h.getTechSession }));
vi.mock("@/lib/rate-limit", async (orig) => ({ ...(await orig<typeof import("@/lib/rate-limit")>()), slidingWindow: h.slidingWindow }));
vi.mock("@/lib/tech/site-queries", () => ({ getSiteView: h.getSiteView }));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn() }, errorCode: () => "x" }));

import { GET } from "./route";

const RID = "11111111-1111-4111-8111-111111111111";
const get = (id = RID) => GET(new NextRequest(`http://localhost/api/tech/jobs/${id}/site`), { params: Promise.resolve({ id }) });
const VIEW = {
  scope: "location", title: "Main house", unaddressedCount: 1, hasCustomer: true, isLead: true,
  pastJobs: [{ id: "r1", referenceNumber: "R-1", date: "2026-11-03T15:00:00.000Z", status: "completed", kind: "Maintenance", leadTechnicianName: "Alex", submittedFormNames: ["Maintenance checklist"] }],
  openEstimates: [{ id: "e1", label: "Estimate · Nov 6 · 2 options", createdAt: "2026-11-06T15:00:00.000Z", totalCents: 481200, optionCount: 2, thisJob: true, fromFieldPulse: false }],
  membership: { state: "member", planName: "Comfort Club", startedAt: "2026-03-01T00:00:00.000Z", currentPeriodEnd: null, visitsPerYear: 2, upcoming: [] },
};

function keysDeep(v: unknown, out: string[] = []): string[] {
  if (Array.isArray(v)) v.forEach((x) => keysDeep(x, out));
  else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) { out.push(k.toLowerCase()); keysDeep(x, out); }
  return out;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.getTechSession.mockResolvedValue({ userId: "u", organizationId: "o" });
  h.slidingWindow.mockReturnValue({ allowed: true, remaining: 1, resetMs: 1 });
});

describe("GET /api/tech/jobs/[id]/site (spec §7.6)", () => {
  it("401 / 400 / 429 / 404", async () => {
    h.getTechSession.mockResolvedValueOnce(null);
    expect((await get()).status).toBe(401);
    expect((await get("nope")).status).toBe(400);
    h.slidingWindow.mockReturnValueOnce({ allowed: false, remaining: 0, resetMs: 1 });
    expect((await get()).status).toBe(429);
    expect(h.slidingWindow).toHaveBeenLastCalledWith("tech:site:read:u", 60, 60_000);
    h.getSiteView.mockResolvedValueOnce({ kind: "not_found" });
    expect((await get()).status).toBe(404);
  });

  it("the payload has no key like phone, email, description, address or signature", async () => {
    h.getSiteView.mockResolvedValueOnce({ kind: "ok", view: VIEW });
    const res = await get();
    const keys = keysDeep(await res.json());
    // Substring rule (spec §9); the spec's own `unaddressedCount` is the one allowed key (lead ruling 12).
    expect(keys.filter((k) => k !== "unaddressedcount" && /phone|email|description|address|signature/.test(k))).toEqual([]);
    expect(keys).toContain("unaddressedcount");
  });
});
