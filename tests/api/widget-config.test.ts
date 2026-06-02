import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const { mockValidateKey, mockGetOrgConfig } = vi.hoisted(() => ({
  mockValidateKey: vi.fn(),
  mockGetOrgConfig: vi.fn(),
}));

vi.mock("@/lib/widget/key-queries", () => ({
  validateKey: (k: string) => mockValidateKey(k),
}));
vi.mock("@/lib/admin/org-config-queries", () => ({
  getOrgConfig: (o: string) => mockGetOrgConfig(o),
}));
vi.mock("@/lib/rate-limit", () => ({
  slidingWindow: vi.fn(() => ({ allowed: true })),
  RATE_LIMITS: { sessionCreate: { maxRequests: 5, windowMs: 60000 } },
}));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import { GET } from "@/app/api/widget/config/route";

const ORG = "00000000-0000-0000-0000-000000000001";

function req(key: string | null, origin?: string): NextRequest {
  const url = new URL("http://localhost:3000/api/widget/config");
  if (key) url.searchParams.set("key", key);
  const headers: Record<string, string> = {};
  if (origin) headers.origin = origin;
  return new NextRequest(url, { method: "GET", headers });
}

const FULL_CONFIG = {
  companyName: "Acme HVAC",
  logoUrl: "https://acme.com/logo.png",
  primaryColor: "#2563eb",
  welcomeMessage: "Hi!",
  launcherPosition: "bottom-right",
  disabledIssueTypes: ["installation"],
  disabledServiceTags: ["boiler"],
  businessInfo: { phone: "555-1234", licensedInsured: "secret cert #" },
  allowedOrigins: [],
};

beforeEach(() => {
  vi.clearAllMocks();
});

describe("GET /api/widget/config", () => {
  it("403s for a missing or invalid key", async () => {
    mockValidateKey.mockResolvedValue(null);
    const res = await GET(req("pk_live_bad", "https://acme.com"));
    expect(res.status).toBe(403);
  });

  it("403s for a secret key (only publishable keys may theme the widget)", async () => {
    mockValidateKey.mockResolvedValue({
      id: "k",
      organizationId: ORG,
      keyType: "secret",
      scopes: ["admin"],
    });
    const res = await GET(req("sk_live_x", "https://acme.com"));
    expect(res.status).toBe(403);
  });

  it("returns ONLY public branding — never business info / services / FAQs", async () => {
    mockValidateKey.mockResolvedValue({
      id: "k",
      organizationId: ORG,
      keyType: "publishable",
      scopes: ["sessions:create"],
    });
    mockGetOrgConfig.mockResolvedValue(FULL_CONFIG);

    const res = await GET(req("pk_live_good", "https://acme.com"));
    expect(res.status).toBe(200);
    const body = await res.json();
    const cfg = body.data.config;

    expect(cfg).toEqual({
      companyName: "Acme HVAC",
      logoUrl: "https://acme.com/logo.png",
      primaryColor: "#2563eb",
      welcomeMessage: "Hi!",
      launcherPosition: "bottom-right",
    });
    // Critical: no private fields leak to the public endpoint.
    expect(cfg).not.toHaveProperty("businessInfo");
    expect(cfg).not.toHaveProperty("disabledServiceTags");
    expect(JSON.stringify(body)).not.toContain("secret cert");
  });

  it("enforces the org allowlist — 403 from a non-allowlisted origin", async () => {
    mockValidateKey.mockResolvedValue({
      id: "k",
      organizationId: ORG,
      keyType: "publishable",
      scopes: ["sessions:create"],
    });
    mockGetOrgConfig.mockResolvedValue({
      ...FULL_CONFIG,
      allowedOrigins: ["https://acme.com"],
    });

    const res = await GET(req("pk_live_good", "https://evil.com"));
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body.error.code).toBe("ORIGIN_NOT_ALLOWED");
  });

  it("allows an allowlisted origin and sets a reflected CORS header", async () => {
    mockValidateKey.mockResolvedValue({
      id: "k",
      organizationId: ORG,
      keyType: "publishable",
      scopes: ["sessions:create"],
    });
    mockGetOrgConfig.mockResolvedValue({
      ...FULL_CONFIG,
      allowedOrigins: ["https://acme.com"],
    });

    const res = await GET(req("pk_live_good", "https://acme.com"));
    expect(res.status).toBe(200);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(
      "https://acme.com",
    );
  });
});
