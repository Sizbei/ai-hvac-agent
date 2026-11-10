import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Pull `server-only` guard before route imports it transitively.
vi.mock("server-only", () => ({}));

const getAdminSession = vi.fn();
vi.mock("@/lib/auth/session", () => ({
  getAdminSession: () => getAdminSession(),
}));

vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn() } }));

const getFeatures = vi.fn();
vi.mock("@/lib/tenancy/features", () => ({
  getFeatures: (...a: unknown[]) => getFeatures(...a),
}));

import { NextRequest } from "next/server";
import { generateKeyPair, exportPKCS8 } from "jose";
import { GET } from "./route";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeReq(origin = "https://admin.example.com") {
  return new NextRequest("https://admin.example.com/api/admin/mapkit-token", {
    method: "GET",
    headers: { origin },
  });
}

const SESSION = {
  userId: "u-1",
  organizationId: "org-1",
  email: "owner@example.com",
  name: "Owner",
  role: "admin" as const,
};

// ---------------------------------------------------------------------------
// Env var snapshot helpers
// ---------------------------------------------------------------------------

let savedEnv: Record<string, string | undefined> = {};

function setAppleEnv(teamId: string, keyId: string, privateKey: string) {
  process.env.APPLE_TEAM_ID = teamId;
  process.env.APPLE_MAPKIT_KEY_ID = keyId;
  process.env.APPLE_MAPKIT_PRIVATE_KEY = privateKey;
}

function clearAppleEnv() {
  delete process.env.APPLE_TEAM_ID;
  delete process.env.APPLE_MAPKIT_KEY_ID;
  delete process.env.APPLE_MAPKIT_PRIVATE_KEY;
}

beforeEach(() => {
  vi.clearAllMocks();
  getFeatures.mockResolvedValue({ map: true });
  savedEnv = {
    APPLE_TEAM_ID: process.env.APPLE_TEAM_ID,
    APPLE_MAPKIT_KEY_ID: process.env.APPLE_MAPKIT_KEY_ID,
    APPLE_MAPKIT_PRIVATE_KEY: process.env.APPLE_MAPKIT_PRIVATE_KEY,
  };
});

afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("GET /api/admin/mapkit-token", () => {
  it("404 NOT_FOUND when the map switch is off, even with credentials set", async () => {
    getAdminSession.mockResolvedValue(SESSION);
    getFeatures.mockResolvedValue({ map: false });
    setAppleEnv("TEAM123", "kid-1", "placeholder");
    const res = await GET(makeReq());
    expect(res.status).toBe(404);
    expect((await res.json()).error.code).toBe("NOT_FOUND");
    expect(getFeatures).toHaveBeenCalledWith("org-1");
  });

  it("401 when unauthenticated", async () => {
    getAdminSession.mockResolvedValue(null);
    clearAppleEnv();
    const res = await GET(makeReq());
    expect(res.status).toBe(401);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe("UNAUTHORIZED");
  });

  it("503 NOT_CONFIGURED when all three env vars are absent", async () => {
    getAdminSession.mockResolvedValue(SESSION);
    clearAppleEnv();
    const res = await GET(makeReq());
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.success).toBe(false);
    expect(body.error.code).toBe("NOT_CONFIGURED");
  });

  it("503 NOT_CONFIGURED when APPLE_TEAM_ID is absent", async () => {
    getAdminSession.mockResolvedValue(SESSION);
    clearAppleEnv();
    process.env.APPLE_MAPKIT_KEY_ID = "kid-1";
    process.env.APPLE_MAPKIT_PRIVATE_KEY = "placeholder";
    const res = await GET(makeReq());
    expect(res.status).toBe(503);
    const body = await res.json();
    expect(body.error.code).toBe("NOT_CONFIGURED");
  });

  it("503 NOT_CONFIGURED when APPLE_MAPKIT_KEY_ID is absent", async () => {
    getAdminSession.mockResolvedValue(SESSION);
    clearAppleEnv();
    process.env.APPLE_TEAM_ID = "TEAM123";
    process.env.APPLE_MAPKIT_PRIVATE_KEY = "placeholder";
    const res = await GET(makeReq());
    expect(res.status).toBe(503);
  });

  it("503 NOT_CONFIGURED when APPLE_MAPKIT_PRIVATE_KEY is absent", async () => {
    getAdminSession.mockResolvedValue(SESSION);
    clearAppleEnv();
    process.env.APPLE_TEAM_ID = "TEAM123";
    process.env.APPLE_MAPKIT_KEY_ID = "kid-1";
    const res = await GET(makeReq());
    expect(res.status).toBe(503);
  });

  it("200 { token, expiresAt } with valid throwaway ES256 key — claims iss/exp/kid/origin", async () => {
    getAdminSession.mockResolvedValue(SESSION);

    // Generate a throwaway P-256 keypair — never a real Apple key.
    // extractable: true is required so we can exportPKCS8 in the test.
    const { privateKey, publicKey } = await generateKeyPair("ES256", { extractable: true });
    const pkcs8 = await exportPKCS8(privateKey);
    // Simulate the \n-escaped storage format (each newline → literal \\n).
    const escapedKey = pkcs8.replace(/\n/g, "\\n");

    const TEAM_ID = "TESTTEAM1";
    const KEY_ID = "TESTKEYID1";
    const ORIGIN = "https://admin.example.com";

    setAppleEnv(TEAM_ID, KEY_ID, escapedKey);

    const req = makeReq(ORIGIN);
    const res = await GET(req);

    expect(res.status).toBe(200);

    const body = await res.json();
    expect(body.success).toBe(true);
    expect(typeof body.data.token).toBe("string");
    expect(typeof body.data.expiresAt).toBe("number");

    // Decode and assert claims (using decodeJwt — no signature verification
    // needed; we just want to confirm the payload structure; the public key
    // is available for full verification below).
    const { jwtVerify } = await import("jose");
    const { payload, protectedHeader } = await jwtVerify(body.data.token, publicKey, {
      algorithms: ["ES256"],
      issuer: TEAM_ID,
    });

    // iss = team id
    expect(payload.iss).toBe(TEAM_ID);

    // exp - iat ≈ 1800 seconds (30 min), allow ±5s for test timing
    const iat = payload.iat as number;
    const exp = payload.exp as number;
    expect(exp - iat).toBeGreaterThanOrEqual(1795);
    expect(exp - iat).toBeLessThanOrEqual(1805);

    // header kid = key id
    expect(protectedHeader.kid).toBe(KEY_ID);

    // claim origin = request host WITHOUT scheme (Apple validates the claim
    // as a fully-qualified domain, not a URL).
    expect((payload as Record<string, unknown>).origin).toBe("admin.example.com");

    // expiresAt in response matches token exp
    expect(body.data.expiresAt).toBe(exp);
  });

  it("omits the origin claim entirely for localhost dev origins", async () => {
    getAdminSession.mockResolvedValue(SESSION);
    const { privateKey } = await generateKeyPair("ES256", { extractable: true });
    const pkcs8 = await exportPKCS8(privateKey);
    setAppleEnv("TESTTEAM1", "TESTKEYID1", pkcs8.replace(/\n/g, "\\n"));

    const res = await GET(makeReq("http://localhost:3000"));
    expect(res.status).toBe(200);
    const body = await res.json();
    const { decodeJwt } = await import("jose");
    const payload = decodeJwt(body.data.token);
    expect("origin" in payload).toBe(false);
  });
});
