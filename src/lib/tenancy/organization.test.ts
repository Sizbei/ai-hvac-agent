import { describe, it, expect, vi, beforeEach } from "vitest";

// `server-only` throws at import in a non-server env (before mocks apply); stub
// it so the module under test (which imports it as a build guard) can load.
vi.mock("server-only", () => ({}));

const { mockSelectRows, mockValidateKey } = vi.hoisted(() => ({
  mockSelectRows: { value: [] as unknown[] },
  mockValidateKey: vi.fn(),
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
  db: { select: () => chain(mockSelectRows.value) },
}));
vi.mock("@/lib/db/schema", () => ({
  organizations: { id: "o.id" },
  organizationSettings: { organizationId: "os.org", allowedOrigins: "os.ao" },
}));
vi.mock("drizzle-orm", () => ({ eq: (...a: unknown[]) => a }));
vi.mock("@/lib/widget/key-queries", () => ({
  validateKey: (k: string) => mockValidateKey(k),
}));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  resolveOrganizationForSession,
  organizationExists,
  DEMO_ORG_ID,
} from "@/lib/tenancy/organization";

const ORG_B = "11111111-1111-1111-1111-111111111111";

beforeEach(() => {
  vi.clearAllMocks();
  mockSelectRows.value = [];
});

describe("resolveOrganizationForSession", () => {
  it("falls back to the demo org when there is no publishable key", async () => {
    const r = await resolveOrganizationForSession();
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.organizationId).toBe(DEMO_ORG_ID);
      expect(r.source).toBe("demo_fallback");
    }
  });

  it("resolves the owning org for a valid publishable key (no allowlist)", async () => {
    mockValidateKey.mockResolvedValue({
      id: "k1",
      organizationId: ORG_B,
      keyType: "publishable",
      scopes: ["sessions:create"],
    });
    mockSelectRows.value = [{ allowedOrigins: [] }]; // no allowlist configured

    const r = await resolveOrganizationForSession({
      publishableKey: "pk_live_abc",
      origin: "https://anything.com",
    });
    expect(r).toEqual({ ok: true, organizationId: ORG_B, source: "widget_key" });
  });

  it("rejects an unknown/revoked key", async () => {
    mockValidateKey.mockResolvedValue(null);
    const r = await resolveOrganizationForSession({
      publishableKey: "pk_live_bad",
    });
    expect(r).toEqual({ ok: false, reason: "invalid_key" });
  });

  it("rejects a SECRET key (secret keys can't open sessions)", async () => {
    mockValidateKey.mockResolvedValue({
      id: "k2",
      organizationId: ORG_B,
      keyType: "secret",
      scopes: ["admin"],
    });
    const r = await resolveOrganizationForSession({
      publishableKey: "sk_live_abc",
    });
    expect(r).toEqual({ ok: false, reason: "invalid_key" });
  });

  it("rejects when the origin is not on the org's allowlist", async () => {
    mockValidateKey.mockResolvedValue({
      id: "k1",
      organizationId: ORG_B,
      keyType: "publishable",
      scopes: ["sessions:create"],
    });
    mockSelectRows.value = [{ allowedOrigins: ["https://acme.com"] }];

    const r = await resolveOrganizationForSession({
      publishableKey: "pk_live_abc",
      origin: "https://evil.example.com",
    });
    expect(r).toEqual({ ok: false, reason: "origin_not_allowed" });
  });

  it("accepts when the origin matches the allowlist", async () => {
    mockValidateKey.mockResolvedValue({
      id: "k1",
      organizationId: ORG_B,
      keyType: "publishable",
      scopes: ["sessions:create"],
    });
    mockSelectRows.value = [{ allowedOrigins: ["https://acme.com"] }];

    const r = await resolveOrganizationForSession({
      publishableKey: "pk_live_abc",
      origin: "https://acme.com",
    });
    expect(r.ok).toBe(true);
  });
});

describe("organizationExists", () => {
  it("returns true when the org row is found", async () => {
    mockSelectRows.value = [{ id: DEMO_ORG_ID }];
    await expect(organizationExists(DEMO_ORG_ID)).resolves.toBe(true);
  });

  it("returns false when the org row is missing", async () => {
    mockSelectRows.value = [];
    await expect(organizationExists("ghost-org")).resolves.toBe(false);
  });
});
