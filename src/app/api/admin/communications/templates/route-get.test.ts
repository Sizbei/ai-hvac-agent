/** GET carries the reviewRequests switch so the Review request card can read "Off for this account" (P8 M9). */
import { describe, it, expect, vi, beforeEach } from "vitest";

const getViewerContext = vi.fn();
vi.mock("@/lib/auth/viewer", () => ({ getViewerContext: () => getViewerContext() }));
vi.mock("@/lib/auth/session", () => ({ getAdminSession: vi.fn() }));

const findMany = vi.fn();
vi.mock("@/lib/db", () => ({
  db: { query: { communicationTemplates: { findMany: (...a: unknown[]) => findMany(...a) } } },
}));

vi.mock("@/lib/admin/audit", () => ({ logAudit: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({
  slidingWindow: () => ({ allowed: true }),
  RATE_LIMITS: {
    adminRead: { maxRequests: 100, windowMs: 60_000 },
    adminMutation: { maxRequests: 100, windowMs: 60_000 },
  },
}));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn() } }));

import { GET } from "./route";

const SESSION = { userId: "u-1", organizationId: "11111111-1111-4111-8111-111111111111" };
const viewer = (reviewRequests: boolean) => ({
  session: SESSION,
  showHidden: false,
  features: { map: false, reviewRequests, payLinks: true, showHistory: false },
});

beforeEach(() => {
  vi.clearAllMocks();
  findMany.mockResolvedValue([{ id: "t-1", triggerType: "review_request", isActive: true }]);
});

describe("GET /api/admin/communications/templates", () => {
  it("401 without a session", async () => {
    getViewerContext.mockResolvedValue(null);
    expect((await GET()).status).toBe(401);
    expect(findMany).not.toHaveBeenCalled();
  });

  it("returns the templates with the reviewRequests switch as reviewTextsOn", async () => {
    getViewerContext.mockResolvedValue(viewer(false));
    const json = await (await GET()).json();
    expect(json.data.templates).toHaveLength(1);
    expect(json.data.reviewTextsOn).toBe(false);
    getViewerContext.mockResolvedValue(viewer(true));
    expect((await (await GET()).json()).data.reviewTextsOn).toBe(true);
  });
});
