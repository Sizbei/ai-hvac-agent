import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const {
  mockVerifyCronAuth,
  mockGetRollup,
  mockSendSms,
  mockSelect,
  selectQueue,
  loggerError,
} = vi.hoisted(() => {
  const selectQueue: unknown[][] = [];
  const chain = (resolved: unknown): unknown => {
    const p: unknown = new Proxy(() => {}, {
      get(_t, prop) {
        if (prop === "then")
          return (resolve: (v: unknown) => void) => resolve(resolved);
        return () => p;
      },
      apply: () => p,
    });
    return p;
  };
  return {
    mockVerifyCronAuth: vi.fn(() => true),
    mockGetRollup: vi.fn(),
    mockSendSms: vi.fn(async () => ({ sid: "SM1" })),
    mockSelect: () => chain(selectQueue.shift() ?? []),
    selectQueue,
    loggerError: vi.fn(),
  };
});

vi.mock("@/lib/cron-auth", () => ({ verifyCronAuth: mockVerifyCronAuth }));
vi.mock("@/lib/admin/dispatch-rollup", () => ({
  getDispatchOutcomeRollup: (...a: unknown[]) => mockGetRollup(...a),
}));
vi.mock("@/lib/communication/twilio-adapter", () => ({ sendSms: mockSendSms }));
vi.mock("@/lib/db", () => ({ db: { select: () => mockSelect() } }));
vi.mock("@/lib/db/schema", () => ({
  organizationSettings: {
    organizationId: "os.org",
    dispatchAlertPhone: "os.phone",
  },
}));
vi.mock("drizzle-orm", () => ({
  isNotNull: (c: unknown) => ["isNotNull", c],
}));
vi.mock("@/lib/logger", () => ({
  logger: { error: loggerError, info: vi.fn(), warn: vi.fn() },
}));

import { GET } from "@/app/api/cron/dispatch-digest/route";

function req(): NextRequest {
  return new NextRequest("http://localhost/api/cron/dispatch-digest", {
    headers: { authorization: "Bearer test-secret" },
  });
}

const ORG = "00000000-0000-0000-0000-000000000001";

beforeEach(() => {
  vi.clearAllMocks();
  selectQueue.length = 0;
  process.env.CRON_SECRET = "test-secret";
  mockVerifyCronAuth.mockReturnValue(true);
});

describe("GET /api/cron/dispatch-digest", () => {
  it("returns 401 when cron auth fails", async () => {
    mockVerifyCronAuth.mockReturnValue(false);
    const res = await GET(req());
    expect(res.status).toBe(401);
  });

  it("alerts on a collapse (this-week rate < 50% of trailing, >=20 each)", async () => {
    selectQueue.push([{ organizationId: ORG, phone: "+15551234567" }]);
    // 1st call = this week (low commit rate), 2nd = trailing-28d (high).
    mockGetRollup
      .mockResolvedValueOnce({
        days: 7,
        real: { committed: 4, queuedAmbiguous: 0, queuedNoFit: 0, queuedNeedsReview: 0, total: 20 },
        shadow: { committed: 0, queuedAmbiguous: 0, queuedNoFit: 0, queuedNeedsReview: 0, total: 0 },
        overrides: 0,
        commitRate: 0.2,
      })
      .mockResolvedValueOnce({
        days: 28,
        real: { committed: 80, queuedAmbiguous: 0, queuedNoFit: 0, queuedNeedsReview: 0, total: 100 },
        shadow: { committed: 0, queuedAmbiguous: 0, queuedNoFit: 0, queuedNeedsReview: 0, total: 0 },
        overrides: 0,
        commitRate: 0.8,
      });
    const res = await GET(req());
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(mockSendSms).toHaveBeenCalledWith(
      expect.objectContaining({ to: "+15551234567" }),
    );
    expect(body.data.alertsSent).toBe(1);
  });

  it("does NOT alert when the trailing window has < 20 decisions", async () => {
    selectQueue.push([{ organizationId: ORG, phone: "+15551234567" }]);
    mockGetRollup
      .mockResolvedValueOnce({
        days: 7,
        real: { committed: 1, queuedAmbiguous: 0, queuedNoFit: 0, queuedNeedsReview: 0, total: 20 },
        shadow: { committed: 0, queuedAmbiguous: 0, queuedNoFit: 0, queuedNeedsReview: 0, total: 0 },
        overrides: 0,
        commitRate: 0.05,
      })
      .mockResolvedValueOnce({
        days: 28,
        real: { committed: 10, queuedAmbiguous: 0, queuedNoFit: 0, queuedNeedsReview: 0, total: 15 },
        shadow: { committed: 0, queuedAmbiguous: 0, queuedNoFit: 0, queuedNeedsReview: 0, total: 0 },
        overrides: 0,
        commitRate: 0.67,
      });
    const res = await GET(req());
    const body = await res.json();
    expect(mockSendSms).not.toHaveBeenCalled();
    expect(body.data.alertsSent).toBe(0);
  });

  it("does NOT alert when THIS WEEK's window has < 20 decisions", async () => {
    // Trailing window has plenty (>=20) but this week is too sparse to judge —
    // a slow week must not page the dispatcher.
    selectQueue.push([{ organizationId: ORG, phone: "+15551234567" }]);
    mockGetRollup
      .mockResolvedValueOnce({
        days: 7,
        real: { committed: 1, queuedAmbiguous: 0, queuedNoFit: 0, queuedNeedsReview: 0, total: 12 },
        shadow: { committed: 0, queuedAmbiguous: 0, queuedNoFit: 0, queuedNeedsReview: 0, total: 0 },
        overrides: 0,
        commitRate: 0.08,
      })
      .mockResolvedValueOnce({
        days: 28,
        real: { committed: 80, queuedAmbiguous: 0, queuedNoFit: 0, queuedNeedsReview: 0, total: 100 },
        shadow: { committed: 0, queuedAmbiguous: 0, queuedNoFit: 0, queuedNeedsReview: 0, total: 0 },
        overrides: 0,
        commitRate: 0.8,
      });
    const res = await GET(req());
    const body = await res.json();
    expect(mockSendSms).not.toHaveBeenCalled();
    expect(body.data.alertsSent).toBe(0);
  });

  it("one org's sendSms failure does not abort the run", async () => {
    selectQueue.push([
      { organizationId: ORG, phone: "+15551110000" },
      { organizationId: ORG, phone: "+15552220000" },
    ]);
    // Both orgs collapse; the first send throws (e.g. TWILIO_PHONE_NUMBER unset).
    const collapse = [
      {
        days: 7,
        real: { committed: 2, queuedAmbiguous: 0, queuedNoFit: 0, queuedNeedsReview: 0, total: 20 },
        shadow: { committed: 0, queuedAmbiguous: 0, queuedNoFit: 0, queuedNeedsReview: 0, total: 0 },
        overrides: 0,
        commitRate: 0.1,
      },
      {
        days: 28,
        real: { committed: 90, queuedAmbiguous: 0, queuedNoFit: 0, queuedNeedsReview: 0, total: 100 },
        shadow: { committed: 0, queuedAmbiguous: 0, queuedNoFit: 0, queuedNeedsReview: 0, total: 0 },
        overrides: 0,
        commitRate: 0.9,
      },
    ];
    mockGetRollup.mockResolvedValue(collapse[0]);
    // Alternate week/trailing per org via sequence.
    mockGetRollup
      .mockResolvedValueOnce(collapse[0])
      .mockResolvedValueOnce(collapse[1])
      .mockResolvedValueOnce(collapse[0])
      .mockResolvedValueOnce(collapse[1]);
    mockSendSms.mockRejectedValueOnce(new Error("TWILIO_PHONE_NUMBER not set"));
    const res = await GET(req());
    const body = await res.json();
    expect(res.status).toBe(200); // run completed despite the first failure
    expect(mockSendSms).toHaveBeenCalledTimes(2); // both orgs attempted
    expect(loggerError).toHaveBeenCalled();
    expect(body.data.alertsSent).toBe(1); // only the second succeeded
  });
});
