/**
 * Public review-response route handler (POST /api/review/[token]).
 *
 * COMPLIANCE (FTC / Google ToS): the public-review link is returned to EVERYONE
 * who responds, regardless of rating. These tests assert there is NO sentiment
 * branch — a 1-star and a 5-star response both get the same public link back.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { POST } from "@/app/api/review/[token]/route";
import { recordReviewResponse } from "@/lib/reviews/review-queries";
import { getReviewProvider } from "@/lib/reviews/review-provider";

vi.mock("@/lib/reviews/review-queries", () => ({
  recordReviewResponse: vi.fn(),
}));
vi.mock("@/lib/reviews/review-provider", () => ({
  getReviewProvider: vi.fn(),
}));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/rate-limit", () => ({
  slidingWindow: vi.fn(() => ({ allowed: true })),
}));

const PUBLIC_URL = "https://search.google.com/local/writereview?placeid=test";

function makeRequest(body: unknown): Request {
  return new Request("http://localhost/api/review/tok", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(getReviewProvider).mockReturnValue({
    name: "mock",
    getPublicReviewUrl: () => PUBLIC_URL,
  });
  vi.mocked(recordReviewResponse).mockResolvedValue({ ok: true });
});

describe("POST /api/review/[token] — no review-gating", () => {
  it.each([1, 2, 3, 4, 5])(
    "returns the public review link for a rating of %i",
    async (rating) => {
      const res = await POST(makeRequest({ rating }) as never, {
        params: Promise.resolve({ token: "tok" }),
      });
      const body = await res.json();

      expect(res.status).toBe(200);
      expect(body.success).toBe(true);
      // The SAME public link is offered regardless of rating — no sentiment gate.
      expect(body.data.publicReviewUrl).toBe(PUBLIC_URL);
    },
  );

  it("rejects an out-of-range rating", async () => {
    const res = await POST(makeRequest({ rating: 6 }) as never, {
      params: Promise.resolve({ token: "tok" }),
    });
    expect(res.status).toBe(400);
    expect(recordReviewResponse).not.toHaveBeenCalled();
  });

  it("returns 409 when already responded", async () => {
    vi.mocked(recordReviewResponse).mockResolvedValue({
      ok: false,
      reason: "already_responded",
    });
    const res = await POST(makeRequest({ rating: 5 }) as never, {
      params: Promise.resolve({ token: "tok" }),
    });
    expect(res.status).toBe(409);
  });
});
