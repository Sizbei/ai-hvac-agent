import { describe, it, expect, beforeEach, vi } from "vitest";

vi.mock("server-only", () => ({}));

vi.mock("@/lib/db", () => ({
  db: { select: vi.fn() },
}));

import { db } from "@/lib/db";
import { getOrgEntitlements, isOrgActive } from "./entitlements";

/** Make db.select().from().where().limit() resolve to `rows`. */
function mockSelect(rows: unknown[]) {
  vi.mocked(db.select).mockImplementation(
    () =>
      ({
        from: () => ({
          where: () => ({ limit: () => Promise.resolve(rows) }),
        }),
      }) as never,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("isOrgActive", () => {
  it("is true for active and trial", () => {
    expect(isOrgActive({ status: "active" })).toBe(true);
    expect(isOrgActive({ status: "trial" })).toBe(true);
  });

  it("is false for past_due and suspended", () => {
    expect(isOrgActive({ status: "past_due" })).toBe(false);
    expect(isOrgActive({ status: "suspended" })).toBe(false);
  });
});

describe("getOrgEntitlements", () => {
  it("maps a real plan id to that tier's entitlements", async () => {
    mockSelect([{ plan: "pro" }]);
    const { plan, entitlements } = await getOrgEntitlements("org-1");
    expect(plan.id).toBe("pro");
    expect(entitlements.maxStaff).toBe(20);
  });

  it("returns the default/free tier when plan is null", async () => {
    mockSelect([{ plan: null }]);
    const { plan, entitlements } = await getOrgEntitlements("org-1");
    expect(plan.id).toBe("free");
    expect(entitlements.maxStaff).toBe(2);
  });

  it("throws when the org does not exist", async () => {
    mockSelect([]);
    await expect(getOrgEntitlements("missing")).rejects.toThrow(
      /Organization not found/,
    );
  });
});
