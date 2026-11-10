import { describe, it, expect, vi, beforeEach } from "vitest";

const dbState = { rows: [] as unknown[], throwOnSelect: false };
vi.mock("@/lib/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: () => {
            if (dbState.throwOnSelect) return Promise.reject(new Error("db down"));
            return Promise.resolve(dbState.rows);
          },
        }),
      }),
    }),
  },
}));
vi.mock("@/lib/db/schema", () => ({
  users: {
    id: "u.id",
    organizationId: "u.org",
    isActive: "u.active",
    role: "u.role",
    email: "u.email",
  },
}));
vi.mock("drizzle-orm", () => ({
  and: (...a: unknown[]) => a,
  eq: (...a: unknown[]) => a,
}));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn() } }));

import {
  isSessionUserCurrent,
  clearRevocationCacheForTests,
} from "./session-revocation";

const EMAIL = "ops@example.com";

beforeEach(() => {
  dbState.rows = [];
  dbState.throwOnSelect = false;
  // Positive results are cached module-wide (perf); clear between cases so a
  // pass in one test can't satisfy a deny test's lookup from cache.
  clearRevocationCacheForTests();
});

describe("isSessionUserCurrent", () => {
  it("true when the user is active and the role matches the token", async () => {
    dbState.rows = [{ isActive: true, role: "admin", email: EMAIL }];
    expect(await isSessionUserCurrent("u1", "o1", "admin", EMAIL)).toBe(true);
  });

  it("false when the user has been deactivated", async () => {
    dbState.rows = [{ isActive: false, role: "admin", email: EMAIL }];
    expect(await isSessionUserCurrent("u1", "o1", "admin", EMAIL)).toBe(false);
  });

  it("false when the role changed since the token was issued (demotion)", async () => {
    dbState.rows = [{ isActive: true, role: "technician", email: EMAIL }];
    expect(await isSessionUserCurrent("u1", "o1", "admin", EMAIL)).toBe(false);
  });

  it("false when the user row is gone (deleted)", async () => {
    dbState.rows = [];
    expect(await isSessionUserCurrent("u1", "o1", "admin", EMAIL)).toBe(false);
  });

  it("fails OPEN on a DB error (honors the crypto-valid session)", async () => {
    dbState.throwOnSelect = true;
    expect(await isSessionUserCurrent("u1", "o1", "admin", EMAIL)).toBe(true);
  });

  it("caches a PASS: the second call within the TTL skips the DB read", async () => {
    dbState.rows = [{ isActive: true, role: "admin", email: EMAIL }];
    expect(await isSessionUserCurrent("u1", "o1", "admin", EMAIL)).toBe(true);
    // If the second call hit the DB it would throw → fail-open logs an error;
    // a cache hit returns true without touching the (now-broken) DB.
    dbState.throwOnSelect = true;
    expect(await isSessionUserCurrent("u1", "o1", "admin", EMAIL)).toBe(true);
  });

  it("never caches a DENY: a deactivated user is re-checked every call", async () => {
    dbState.rows = [{ isActive: false, role: "admin", email: EMAIL }];
    expect(await isSessionUserCurrent("u1", "o1", "admin", EMAIL)).toBe(false);
    // Re-activate: the next call must see the fresh row, not a cached deny.
    dbState.rows = [{ isActive: true, role: "admin", email: EMAIL }];
    expect(await isSessionUserCurrent("u1", "o1", "admin", EMAIL)).toBe(true);
  });

  it("a PASS for one identity does not satisfy a different role claim", async () => {
    dbState.rows = [{ isActive: true, role: "admin", email: EMAIL }];
    expect(await isSessionUserCurrent("u1", "o1", "admin", EMAIL)).toBe(true);
    // Same user, different claimed role → distinct cache key → real check → deny.
    expect(await isSessionUserCurrent("u1", "o1", "super_admin", EMAIL)).toBe(false);
  });

  it("refuses a retired demo email even when active with the right role", async () => {
    const demo = "admin@demo-hvac.com";
    dbState.rows = [{ isActive: true, role: "admin", email: demo }];
    expect(await isSessionUserCurrent("u1", "o1", "admin", demo)).toBe(false);
  });

  it("refuses when the DB email differs from the token email", async () => {
    dbState.rows = [{ isActive: true, role: "admin", email: "someone-else@example.com" }];
    expect(await isSessionUserCurrent("u1", "o1", "admin", EMAIL)).toBe(false);
  });

  it("accepts an email that differs only by case/whitespace", async () => {
    dbState.rows = [{ isActive: true, role: "admin", email: "ops@example.com" }];
    expect(await isSessionUserCurrent("u1", "o1", "admin", " Ops@Example.COM ")).toBe(true);
  });

  it("does not cache a denial", async () => {
    const demo = "admin@demo-hvac.com";
    dbState.rows = [{ isActive: true, role: "admin", email: demo }];
    expect(await isSessionUserCurrent("u1", "o1", "admin", demo)).toBe(false);
    // A cached deny would return false without reading; a broken DB now
    // fails open, proving the second call re-read instead of hitting a cache.
    dbState.throwOnSelect = true;
    expect(await isSessionUserCurrent("u1", "o1", "admin", demo)).toBe(true);
  });

  it("a PASS for one email does not satisfy a different email claim", async () => {
    dbState.rows = [{ isActive: true, role: "admin", email: EMAIL }];
    expect(await isSessionUserCurrent("u1", "o1", "admin", EMAIL)).toBe(true);
    expect(await isSessionUserCurrent("u1", "o1", "admin", "admin@demo-hvac.com")).toBe(false);
  });
});
