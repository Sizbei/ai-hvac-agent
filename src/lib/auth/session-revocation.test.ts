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
  users: { id: "u.id", organizationId: "u.org", isActive: "u.active", role: "u.role" },
}));
vi.mock("drizzle-orm", () => ({
  and: (...a: unknown[]) => a,
  eq: (...a: unknown[]) => a,
}));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn() } }));

import { isSessionUserCurrent } from "./session-revocation";

beforeEach(() => {
  dbState.rows = [];
  dbState.throwOnSelect = false;
});

describe("isSessionUserCurrent", () => {
  it("true when the user is active and the role matches the token", async () => {
    dbState.rows = [{ isActive: true, role: "admin" }];
    expect(await isSessionUserCurrent("u1", "o1", "admin")).toBe(true);
  });

  it("false when the user has been deactivated", async () => {
    dbState.rows = [{ isActive: false, role: "admin" }];
    expect(await isSessionUserCurrent("u1", "o1", "admin")).toBe(false);
  });

  it("false when the role changed since the token was issued (demotion)", async () => {
    dbState.rows = [{ isActive: true, role: "technician" }];
    expect(await isSessionUserCurrent("u1", "o1", "admin")).toBe(false);
  });

  it("false when the user row is gone (deleted)", async () => {
    dbState.rows = [];
    expect(await isSessionUserCurrent("u1", "o1", "admin")).toBe(false);
  });

  it("fails OPEN on a DB error (honors the crypto-valid session)", async () => {
    dbState.throwOnSelect = true;
    expect(await isSessionUserCurrent("u1", "o1", "admin")).toBe(true);
  });
});
