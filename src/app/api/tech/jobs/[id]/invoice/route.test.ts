import { describe, it, expect, vi, beforeEach } from "vitest";

const h = vi.hoisted(() => ({
  getTechSession: vi.fn(),
  slidingWindow: vi.fn(),
  getTechInvoiceView: vi.fn(),
}));
vi.mock("@/lib/auth/tech-session", () => ({ getTechSession: h.getTechSession }));
vi.mock("@/lib/rate-limit", async (orig) => ({
  ...(await orig<typeof import("@/lib/rate-limit")>()),
  slidingWindow: h.slidingWindow,
}));
vi.mock("@/lib/tech/invoice-queries", () => ({ getTechInvoiceView: h.getTechInvoiceView }));

import { GET } from "./route";
import { RATE_LIMITS } from "@/lib/rate-limit";

const ID = "22222222-2222-4222-8222-222222222222";
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const req = () => new Request("http://localhost/api/tech/jobs/x/invoice") as never;

beforeEach(() => {
  vi.clearAllMocks();
  h.getTechSession.mockResolvedValue({ userId: "u1", organizationId: "o1" });
  h.slidingWindow.mockReturnValue({ allowed: true, remaining: 1, resetMs: 1 });
});

describe("GET /api/tech/jobs/[id]/invoice", () => {
  it("401 without a tech session", async () => {
    h.getTechSession.mockResolvedValue(null);
    const res = await GET(req(), ctx(ID));
    expect(res.status).toBe(401);
    expect(h.getTechInvoiceView).not.toHaveBeenCalled();
  });

  it("400 INVALID_ID on a malformed id, before the rate limit", async () => {
    const res = await GET(req(), ctx("nope"));
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("INVALID_ID");
    expect(h.slidingWindow).not.toHaveBeenCalled();
  });

  it("429 on the read key", async () => {
    h.slidingWindow.mockReturnValue({ allowed: false, remaining: 0, resetMs: 1 });
    const res = await GET(req(), ctx(ID));
    expect(res.status).toBe(429);
    expect(h.slidingWindow).toHaveBeenCalledWith("tech:invoice:read:u1", RATE_LIMITS.adminRead.maxRequests, RATE_LIMITS.adminRead.windowMs);
    expect(h.getTechInvoiceView).not.toHaveBeenCalled();
  });

  it("404 when the job isn't readable", async () => {
    h.getTechInvoiceView.mockResolvedValue(null);
    const res = await GET(req(), ctx(ID));
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({ success: false, error: { code: "NOT_FOUND", message: "This job isn't yours." } });
  });

  it("200 wraps the view in the success envelope, scoped by the session", async () => {
    const view = { invoice: null, otherOpen: [], history: null, materialsNotOnInvoice: [], pendingWrite: false,
      customerHasPhone: false, isLead: true, onSite: true, externalInvoice: false, allowed: ["create"] };
    h.getTechInvoiceView.mockResolvedValue(view);
    const res = await GET(req(), ctx(ID));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ success: true, data: view });
    expect(h.getTechInvoiceView).toHaveBeenCalledWith("o1", "u1", ID);
  });

  it("500 with human copy when the read throws", async () => {
    h.getTechInvoiceView.mockRejectedValue(new Error("db down secret"));
    const res = await GET(req(), ctx(ID));
    expect(res.status).toBe(500);
    expect(JSON.stringify(await res.json())).not.toContain("secret");
  });
});
