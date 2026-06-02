import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

/**
 * Multi-tenancy isolation guard.
 *
 * The core property after removing the hardcoded DEMO_ORG_ID: every downstream
 * customer route derives the organization from the SESSION ROW it loaded by
 * token — never a constant. So a session belonging to org B must write its
 * audit/message/request rows under org B. These tests feed the routes a session
 * whose organizationId is a NON-demo org and assert the writes follow it.
 */

const ORG_B = "11111111-1111-1111-1111-111111111111";

const { state, mockInsert, mockSelectResult } = vi.hoisted(() => ({
  state: { lastInsertValues: null as unknown },
  mockInsert: vi.fn(),
  mockSelectResult: { rows: [] as unknown[] },
}));

function chain(resolved: unknown): unknown {
  const p: unknown = new Proxy(() => {}, {
    get(_t, prop) {
      if (prop === "then") {
        return (resolve: (v: unknown) => void) => resolve(resolved);
      }
      return () => p;
    },
    apply: () => p,
  });
  return p;
}

vi.mock("@/lib/db", () => ({
  db: {
    select: () => chain(mockSelectResult.rows),
    insert: () => ({
      values: (v: unknown) => {
        state.lastInsertValues = v;
        mockInsert(v);
        return chain([]);
      },
    }),
    update: () => chain([]),
    batch: (qs: readonly unknown[]) => Promise.all(qs),
  },
}));

vi.mock("@/lib/db/schema", () => ({
  customerSessions: { id: "cs.id", token: "cs.token", organizationId: "cs.org" },
  auditLog: {},
  messages: { sessionId: "m.sessionId", organizationId: "m.org" },
}));

vi.mock("drizzle-orm", () => ({
  eq: (...a: unknown[]) => a,
  and: (...a: unknown[]) => a,
}));

vi.mock("@/lib/db/tenant", () => ({
  withTenant: (_t: unknown, orgId: string, ...c: unknown[]) => ({ orgId, c }),
}));

vi.mock("@/lib/session", () => ({
  getSessionToken: vi.fn().mockResolvedValue("session-token-xyz"),
}));

vi.mock("@/lib/rate-limit", () => ({
  slidingWindow: vi.fn(() => ({ allowed: true })),
  RATE_LIMITS: { sessionAction: { maxRequests: 10, windowMs: 60000 } },
}));

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { POST as feedbackHandler } from "@/app/api/session/feedback/route";

function req(body: unknown): NextRequest {
  return new NextRequest(new URL("http://localhost:3000/api/session/feedback"), {
    method: "POST",
    body: JSON.stringify(body),
    headers: { "Content-Type": "application/json" },
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  state.lastInsertValues = null;
  mockSelectResult.rows = [];
});

describe("tenancy isolation — feedback route", () => {
  it("writes the audit row under the SESSION's org, not the demo org", async () => {
    // The loaded session belongs to org B.
    mockSelectResult.rows = [
      { id: "sess-1", token: "session-token-xyz", organizationId: ORG_B },
    ];

    const res = await feedbackHandler(req({ vote: "up", messageIndex: 0 }));
    expect(res.status).toBe(200);

    expect(mockInsert).toHaveBeenCalledTimes(1);
    const inserted = state.lastInsertValues as { organizationId: string };
    expect(inserted.organizationId).toBe(ORG_B);
    // Guard against regressing back to the hardcoded demo org.
    expect(inserted.organizationId).not.toBe(
      "00000000-0000-0000-0000-000000000001",
    );
  });

  it("404s when no session matches the token (no write attributed to any org)", async () => {
    mockSelectResult.rows = []; // token resolves to nothing

    const res = await feedbackHandler(req({ vote: "down", messageIndex: 1 }));
    expect(res.status).toBe(404);
    expect(mockInsert).not.toHaveBeenCalled();
  });
});
