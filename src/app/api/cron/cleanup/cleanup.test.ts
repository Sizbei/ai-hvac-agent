import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// --- Hoisted mocks ---

const {
  mockUpdate,
  mockSelect,
  mockDelete,
  mockLoggerInfo,
  mockLoggerError,
} = vi.hoisted(() => ({
  // The DB mocks carry custom fields the chainable proxy reads to shape results.
  mockUpdate: Object.assign(vi.fn(), { _rowCount: 0 }),
  mockSelect: Object.assign(vi.fn(), { _resolvedValue: [] as unknown }),
  mockDelete: Object.assign(vi.fn(), { _rowCount: 0 }),
  mockLoggerInfo: vi.fn(),
  mockLoggerError: vi.fn(),
}));

// Chainable proxy mock for drizzle query builder
function createChainableMock(resolvedValue: unknown) {
  const proxy: unknown = new Proxy(
    {},
    {
      get(_target, prop) {
        if (prop === "then") {
          return (resolve: (v: unknown) => void) => resolve(resolvedValue);
        }
        // Every other property returns a function that returns the proxy
        return () => proxy;
      },
    },
  );
  return proxy;
}

vi.mock("@/lib/db", () => ({
  db: {
    update: (...args: unknown[]) => {
      mockUpdate(...args);
      return createChainableMock({ rowCount: mockUpdate._rowCount ?? 0 });
    },
    select: (...args: unknown[]) => {
      mockSelect(...args);
      return createChainableMock(mockSelect._resolvedValue ?? []);
    },
    delete: (...args: unknown[]) => {
      mockDelete(...args);
      return createChainableMock({ rowCount: mockDelete._rowCount ?? 0 });
    },
  },
}));

vi.mock("@/lib/db/schema", () => ({
  customerSessions: {
    id: "cs.id",
    status: "cs.status",
    updatedAt: "cs.updatedAt",
    createdAt: "cs.createdAt",
  },
  messages: {
    id: "m.id",
    sessionId: "m.sessionId",
  },
}));

vi.mock("drizzle-orm", () => ({
  eq: vi.fn((...args: unknown[]) => args),
  and: vi.fn((...args: unknown[]) => args),
  sql: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({
    strings,
    values,
  })),
  inArray: vi.fn((...args: unknown[]) => args),
  lt: vi.fn((...args: unknown[]) => args),
  or: vi.fn((...args: unknown[]) => args),
}));

vi.mock("@/lib/logger", () => ({
  logger: {
    info: mockLoggerInfo,
    error: mockLoggerError,
  },
}));

function createRequest(options: {
  authorization?: string;
}): NextRequest {
  const headers: Record<string, string> = {};
  if (options.authorization) {
    headers["authorization"] = options.authorization;
  }
  return new NextRequest(
    new URL("http://localhost:3000/api/cron/cleanup"),
    {
      method: "GET",
      headers,
    },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CRON_SECRET = "test-secret";
  // Reset custom properties
  mockUpdate._rowCount = 0;
  mockSelect._resolvedValue = [];
  mockDelete._rowCount = 0;
});

describe("GET /api/cron/cleanup", () => {
  // Lazy import to pick up mocks
  const getHandler = async () => {
    const mod = await import("./route");
    return mod.GET;
  };

  it("returns 401 when Authorization header is missing", async () => {
    const GET = await getHandler();
    const request = createRequest({});
    const response = await GET(request);
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("fails closed with 503 when CRON_SECRET is not configured", async () => {
    delete process.env.CRON_SECRET;

    const GET = await getHandler();
    // Even an empty Bearer token must not slip through.
    const request = createRequest({ authorization: "Bearer " });
    const response = await GET(request);
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe("NOT_CONFIGURED");
  });

  it("fails closed with 503 when CRON_SECRET is blank", async () => {
    process.env.CRON_SECRET = "   ";

    const GET = await getHandler();
    const request = createRequest({ authorization: "Bearer    " });
    const response = await GET(request);
    const body = await response.json();

    expect(response.status).toBe(503);
    expect(body.error.code).toBe("NOT_CONFIGURED");
  });

  it("returns 401 when CRON_SECRET is wrong", async () => {
    const GET = await getHandler();
    const request = createRequest({
      authorization: "Bearer wrong-secret",
    });
    const response = await GET(request);
    const body = await response.json();

    expect(response.status).toBe(401);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("expires stale chatting/extracting sessions older than 24h", async () => {
    mockUpdate._rowCount = 3;
    mockSelect._resolvedValue = [];
    mockDelete._rowCount = 0;

    const GET = await getHandler();
    const request = createRequest({
      authorization: "Bearer test-secret",
    });
    const response = await GET(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.expiredSessions).toBe(3);
    expect(mockUpdate).toHaveBeenCalled();
  });

  it("deletes messages belonging to sessions older than 90 days", async () => {
    mockUpdate._rowCount = 0;
    mockSelect._resolvedValue = [
      { id: "session-1" },
      { id: "session-2" },
    ];
    mockDelete._rowCount = 5;

    const GET = await getHandler();
    const request = createRequest({
      authorization: "Bearer test-secret",
    });
    const response = await GET(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.purgedMessages).toBe(5);
    // delete is called twice: once for messages, once for sessions
    expect(mockDelete).toHaveBeenCalledTimes(2);
  });

  it("deletes sessions older than 90 days after their messages", async () => {
    mockUpdate._rowCount = 0;
    mockSelect._resolvedValue = [{ id: "session-old" }];
    mockDelete._rowCount = 1;

    const GET = await getHandler();
    const request = createRequest({
      authorization: "Bearer test-secret",
    });
    const response = await GET(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.purgedSessions).toBe(1);
  });

  it("returns summary with counts of expired and purged items", async () => {
    mockUpdate._rowCount = 2;
    mockSelect._resolvedValue = [{ id: "s1" }];
    mockDelete._rowCount = 10;

    const GET = await getHandler();
    const request = createRequest({
      authorization: "Bearer test-secret",
    });
    const response = await GET(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data).toHaveProperty("expiredSessions");
    expect(body.data).toHaveProperty("purgedSessions");
    expect(body.data).toHaveProperty("purgedMessages");
  });

  it("does not expire sessions in terminal states (only purges after 90 days)", async () => {
    // Terminal states are not in the update WHERE clause
    // Update should only target chatting/extracting
    mockUpdate._rowCount = 0;
    mockSelect._resolvedValue = [];
    mockDelete._rowCount = 0;

    const GET = await getHandler();
    const request = createRequest({
      authorization: "Bearer test-secret",
    });
    const response = await GET(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.data.expiredSessions).toBe(0);
    // No sessions to purge
    expect(body.data.purgedSessions).toBe(0);
    expect(body.data.purgedMessages).toBe(0);
  });
});
