import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const getViewerContext = vi.fn();
vi.mock("@/lib/auth/viewer", () => ({ getViewerContext: () => getViewerContext() }));

vi.mock("@/lib/reviews/review-queries", () => ({
  listReviews: async () => ({ reviews: [], total: 0 }),
  getReviewStats: async () => ({ count: 0, avgRating: null, responded: 0 }),
}));

vi.mock("@/lib/rate-limit", () => ({
  slidingWindow: () => ({ allowed: true }),
  RATE_LIMITS: { adminRead: { maxRequests: 100, windowMs: 60_000 } },
}));

vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn() } }));

import { GET } from "./route";

const SESSION = { userId: "u-1", organizationId: "11111111-1111-4111-8111-111111111111" };
const viewer = (reviewRequests: boolean) => ({
  session: SESSION,
  showHidden: false,
  features: { map: false, reviewRequests, payLinks: true, showHistory: false },
});
const req = () => new NextRequest("http://localhost/api/admin/reviews");

beforeEach(() => vi.clearAllMocks());

describe("GET /api/admin/reviews", () => {
  it("401 without a session", async () => {
    getViewerContext.mockResolvedValue(null);
    expect((await GET(req())).status).toBe(401);
  });

  it("carries the reviewRequests switch as reviewTextsOn", async () => {
    getViewerContext.mockResolvedValue(viewer(false));
    expect((await (await GET(req())).json()).data.reviewTextsOn).toBe(false);
    getViewerContext.mockResolvedValue(viewer(true));
    expect((await (await GET(req())).json()).data.reviewTextsOn).toBe(true);
  });
});
