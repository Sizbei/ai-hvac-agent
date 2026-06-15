import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

// --- Hoisted mocks ---

const {
  mockDeleteHcp,
  mockDeleteFieldpulse,
  mockLoggerInfo,
  mockLoggerError,
} = vi.hoisted(() => ({
  mockDeleteHcp: Object.assign(vi.fn(), { _rowCount: 0 }),
  mockDeleteFieldpulse: Object.assign(vi.fn(), { _rowCount: 0 }),
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
        return () => proxy;
      },
    },
  );
  return proxy;
}

vi.mock("@/lib/db", () => ({
  db: {
    delete: (...args: unknown[]) => {
      // Determine which table is being deleted
      const tableArg = args[0] as { _?: string };
      if (tableArg?._ === "hcp") {
        mockDeleteHcp(...args);
        return createChainableMock({ rowCount: mockDeleteHcp._rowCount ?? 0 });
      }
      mockDeleteFieldpulse(...args);
      return createChainableMock({ rowCount: mockDeleteFieldpulse._rowCount ?? 0 });
    },
  },
}));

vi.mock("@/lib/db/schema", () => ({
  hcpWebhookEvents: {
    _: "hcp",
    createdAt: "hwe.created_at",
  },
  fieldpulseWebhookEvents: {
    _: "fp",
    createdAt: "fwe.created_at",
  },
}));

vi.mock("drizzle-orm", () => ({
  sql: vi.fn((strings: TemplateStringsArray, ...values: unknown[]) => ({
    strings,
    values,
  })),
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
    new URL("http://localhost:3000/api/cron/webhook-cleanup"),
    {
      method: "GET",
      headers,
    },
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  process.env.CRON_SECRET = "test-secret";
  mockDeleteHcp._rowCount = 0;
  mockDeleteFieldpulse._rowCount = 0;
});

describe("GET /api/cron/webhook-cleanup", () => {
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

  it("deletes HCP webhook events older than 90 days", async () => {
    mockDeleteHcp._rowCount = 42;
    mockDeleteFieldpulse._rowCount = 0;

    const GET = await getHandler();
    const request = createRequest({
      authorization: "Bearer test-secret",
    });
    const response = await GET(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.purgedHcpEvents).toBe(42);
    expect(mockDeleteHcp).toHaveBeenCalled();
  });

  it("deletes Fieldpulse webhook events older than 90 days", async () => {
    mockDeleteHcp._rowCount = 0;
    mockDeleteFieldpulse._rowCount = 17;

    const GET = await getHandler();
    const request = createRequest({
      authorization: "Bearer test-secret",
    });
    const response = await GET(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.purgedFieldpulseEvents).toBe(17);
    expect(mockDeleteFieldpulse).toHaveBeenCalled();
  });

  it("returns summary with counts of purged events from both tables", async () => {
    mockDeleteHcp._rowCount = 25;
    mockDeleteFieldpulse._rowCount = 15;

    const GET = await getHandler();
    const request = createRequest({
      authorization: "Bearer test-secret",
    });
    const response = await GET(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data).toHaveProperty("purgedHcpEvents");
    expect(body.data).toHaveProperty("purgedFieldpulseEvents");
    expect(body.data).toHaveProperty("totalPurged");
    expect(body.data.totalPurged).toBe(40); // 25 + 15
  });

  it("returns zero counts when no events to purge", async () => {
    mockDeleteHcp._rowCount = 0;
    mockDeleteFieldpulse._rowCount = 0;

    const GET = await getHandler();
    const request = createRequest({
      authorization: "Bearer test-secret",
    });
    const response = await GET(request);
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.success).toBe(true);
    expect(body.data.purgedHcpEvents).toBe(0);
    expect(body.data.purgedFieldpulseEvents).toBe(0);
    expect(body.data.totalPurged).toBe(0);
  });

  it("logs cleanup summary on success", async () => {
    mockDeleteHcp._rowCount = 10;
    mockDeleteFieldpulse._rowCount = 5;

    const GET = await getHandler();
    const request = createRequest({
      authorization: "Bearer test-secret",
    });
    await GET(request);

    expect(mockLoggerInfo).toHaveBeenCalledWith(
      expect.objectContaining({
        webhookCleanup: {
          purgedHcpEvents: 10,
          purgedFieldpulseEvents: 5,
          totalPurged: 15,
        },
      }),
      "Webhook cleanup completed",
    );
  });

  it("logs error and returns 500 on database error", async () => {
    mockDeleteHcp._rowCount = 0;
    // Make delete throw an error
    vi.mocked(mockDeleteHcp).mockImplementationOnce(() => {
      throw new Error("Database connection failed");
    });

    const GET = await getHandler();
    const request = createRequest({
      authorization: "Bearer test-secret",
    });
    const response = await GET(request);
    const body = await response.json();

    expect(response.status).toBe(500);
    expect(body.success).toBe(false);
    expect(body.error.code).toBe("INTERNAL_ERROR");
    expect(mockLoggerError).toHaveBeenCalledWith(
      expect.objectContaining({
        error: "Database connection failed",
      }),
      "Webhook cleanup failed",
    );
  });
});
