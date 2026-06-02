import { describe, it, expect, vi, beforeEach } from "vitest";

const { mockSelectRows } = vi.hoisted(() => ({
  mockSelectRows: { value: [] as unknown[] },
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
vi.mock("@/lib/db/schema", () => ({ organizations: { id: "o.id" } }));
vi.mock("drizzle-orm", () => ({ eq: (...a: unknown[]) => a }));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

import {
  resolveOrganizationForSession,
  organizationExists,
  DEMO_ORG_ID,
} from "@/lib/tenancy/organization";

beforeEach(() => {
  vi.clearAllMocks();
  mockSelectRows.value = [];
});

describe("resolveOrganizationForSession", () => {
  it("falls back to the demo org when there is no tenant signal", async () => {
    const r = await resolveOrganizationForSession();
    expect(r.organizationId).toBe(DEMO_ORG_ID);
    expect(r.source).toBe("demo_fallback");
  });

  it("falls back to the demo org even when an origin is provided (widget path not wired yet)", async () => {
    const r = await resolveOrganizationForSession({
      origin: "https://contractor.example.com",
    });
    // Until the widget_keys/allowlist tables land, origin resolution is a
    // no-op and we deliberately stay on the demo org. This test documents that
    // contract so the widget phase intentionally changes it.
    expect(r.organizationId).toBe(DEMO_ORG_ID);
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
