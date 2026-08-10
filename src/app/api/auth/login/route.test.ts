import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { NextRequest } from "next/server";

const dbRows = { current: [] as unknown[] };
vi.mock("@/lib/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({ limit: () => Promise.resolve(dbRows.current) }),
      }),
    }),
  },
}));
vi.mock("bcryptjs", () => ({ default: { compare: vi.fn() } }));
vi.mock("@/lib/auth/session", () => ({ createAdminSession: vi.fn() }));
vi.mock("@/lib/admin/staff-queries", () => ({
  normalizeEmail: (e: string) => e.trim().toLowerCase(),
}));
vi.mock("@/lib/rate-limit", () => ({
  slidingWindow: () => ({ allowed: true }),
  RATE_LIMITS: { sessionCreate: { maxRequests: 5, windowMs: 60000 } },
}));

import { POST } from "./route";
import bcrypt from "bcryptjs";
import { createAdminSession } from "@/lib/auth/session";

const SELF_ORIGIN = "http://t";

const req = (body: unknown, headers: Record<string, string> = {}) =>
  new NextRequest(new URL("http://t/api/auth/login"), {
    method: "POST",
    headers: {
      origin: SELF_ORIGIN,
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });

const adminRow = {
  id: "11111111-1111-1111-1111-111111111111",
  organizationId: "22222222-2222-2222-2222-222222222222",
  email: "admin@example.com",
  name: "Ada Min",
  role: "admin",
  isActive: true,
  passwordHash: "$2a$12$realhash",
};

beforeEach(() => {
  vi.clearAllMocks();
  dbRows.current = [];
});

describe("POST /api/auth/login", () => {
  it("logs in an active admin and issues an admin session", async () => {
    dbRows.current = [adminRow];
    (bcrypt.compare as unknown as Mock).mockResolvedValue(true);
    const res = await POST(req({ email: "admin@example.com", password: "pw" }));
    expect(res.status).toBe(200);
    expect(createAdminSession).toHaveBeenCalledOnce();
  });

  it("rejects a TECHNICIAN-tier user (admin-tier only) with a generic 401", async () => {
    dbRows.current = [{ ...adminRow, role: "technician" }];
    (bcrypt.compare as unknown as Mock).mockResolvedValue(true);
    const res = await POST(req({ email: "admin@example.com", password: "pw" }));
    expect(res.status).toBe(401);
    expect(createAdminSession).not.toHaveBeenCalled();
  });

  it("rejects a cross-origin request with a 403 before touching the DB", async () => {
    dbRows.current = [adminRow];
    const res = await POST(
      req(
        { email: "admin@example.com", password: "pw" },
        { origin: "https://evil.example" },
      ),
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe("FORBIDDEN_ORIGIN");
    expect(bcrypt.compare).not.toHaveBeenCalled();
    expect(createAdminSession).not.toHaveBeenCalled();
  });

  it("rejects a request with no Origin header (never a legitimate browser POST)", async () => {
    dbRows.current = [adminRow];
    const res = await POST(
      req({ email: "admin@example.com", password: "pw" }, { origin: "" }),
    );
    expect(res.status).toBe(403);
    expect(createAdminSession).not.toHaveBeenCalled();
  });

  it("rejects a non-JSON content type (no-preflight form-POST vector)", async () => {
    dbRows.current = [adminRow];
    const res = await POST(
      req(
        { email: "admin@example.com", password: "pw" },
        { "content-type": "text/plain" },
      ),
    );
    expect(res.status).toBe(415);
    expect(createAdminSession).not.toHaveBeenCalled();
  });
});
