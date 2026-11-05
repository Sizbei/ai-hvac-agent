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
vi.mock("@/lib/auth/tech-session", () => ({ createTechSession: vi.fn() }));
vi.mock("@/lib/admin/staff-queries", () => ({
  normalizeEmail: (e: string) => e.trim().toLowerCase(),
}));
vi.mock("@/lib/rate-limit", () => ({
  slidingWindow: () => ({ allowed: true }),
  RATE_LIMITS: { sessionCreate: { maxRequests: 5, windowMs: 60000 } },
}));

import { POST } from "./route";
import bcrypt from "bcryptjs";
import { createTechSession } from "@/lib/auth/tech-session";

const SELF_ORIGIN = "http://t";

const req = (body: unknown, headers: Record<string, string> = {}) =>
  new NextRequest(new URL("http://t/api/auth/tech/login"), {
    method: "POST",
    headers: {
      origin: SELF_ORIGIN,
      "content-type": "application/json",
      ...headers,
    },
    body: JSON.stringify(body),
  });

const techRow = {
  id: "11111111-1111-1111-1111-111111111111",
  organizationId: "22222222-2222-2222-2222-222222222222",
  email: "tech@example.com",
  name: "Tess Tech",
  role: "technician",
  isActive: true,
  passwordHash: "$2a$12$realhash",
};

beforeEach(() => {
  vi.clearAllMocks();
  dbRows.current = [];
});

describe("POST /api/auth/tech/login", () => {
  it("logs in an active technician and issues a tech session", async () => {
    dbRows.current = [techRow];
    (bcrypt.compare as unknown as Mock).mockResolvedValue(true);
    const res = await POST(req({ email: "tech@example.com", password: "pw" }));
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.redirectTo).toBe("/tech/jobs");
    expect(createTechSession).toHaveBeenCalledOnce();
  });

  it("rejects an ADMIN-tier user (technicians only) with a generic 401", async () => {
    dbRows.current = [{ ...techRow, role: "admin" }];
    (bcrypt.compare as unknown as Mock).mockResolvedValue(true);
    const res = await POST(req({ email: "tech@example.com", password: "pw" }));
    expect(res.status).toBe(401);
    expect(createTechSession).not.toHaveBeenCalled();
  });

  it("rejects an unknown email (still compares to avoid enumeration)", async () => {
    dbRows.current = [];
    (bcrypt.compare as unknown as Mock).mockResolvedValue(false);
    const res = await POST(req({ email: "nobody@example.com", password: "pw" }));
    expect(res.status).toBe(401);
    expect((await res.json()).error).toMatchObject({
      code: "INVALID_CREDENTIALS",
      message: "That email and password don't match.",
    });
    expect(bcrypt.compare).toHaveBeenCalledOnce();
    expect(createTechSession).not.toHaveBeenCalled();
  });

  it("rejects a disabled technician", async () => {
    dbRows.current = [{ ...techRow, isActive: false }];
    (bcrypt.compare as unknown as Mock).mockResolvedValue(true);
    const res = await POST(req({ email: "tech@example.com", password: "pw" }));
    expect(res.status).toBe(401);
    expect(createTechSession).not.toHaveBeenCalled();
  });

  it("rejects a cross-origin request with a 403 before touching the DB", async () => {
    dbRows.current = [techRow];
    const res = await POST(
      req(
        { email: "tech@example.com", password: "pw" },
        { origin: "https://evil.example" },
      ),
    );
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe("FORBIDDEN_ORIGIN");
    expect(bcrypt.compare).not.toHaveBeenCalled();
    expect(createTechSession).not.toHaveBeenCalled();
  });

  it("rejects a request with no Origin header (never a legitimate browser POST)", async () => {
    dbRows.current = [techRow];
    const res = await POST(
      req({ email: "tech@example.com", password: "pw" }, { origin: "" }),
    );
    expect(res.status).toBe(403);
    expect(createTechSession).not.toHaveBeenCalled();
  });

  it("rejects a non-JSON content type (no-preflight form-POST vector)", async () => {
    dbRows.current = [techRow];
    const res = await POST(
      req(
        { email: "tech@example.com", password: "pw" },
        { "content-type": "text/plain" },
      ),
    );
    expect(res.status).toBe(415);
    expect(createTechSession).not.toHaveBeenCalled();
  });
});
