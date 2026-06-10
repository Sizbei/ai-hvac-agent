import { describe, it, expect, beforeEach, vi } from "vitest";
import type { VerifiedGoogleIdentity } from "./google-oidc";

// `server-only` throws at import in a non-server env; stub it (matches the
// convention in organization.test.ts).
vi.mock("server-only", () => ({}));

// --- Chainable db mock (mirrors staff-queries.test.ts) ---
const selectQueue: unknown[] = [];
const updateCalls: unknown[] = [];

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
  db: {
    select: () => chain(selectQueue.shift() ?? []),
    update: () => {
      updateCalls.push(true);
      return chain([]);
    },
  },
}));

vi.mock("@/lib/db/schema", () => ({
  users: { id: "u.id", email: "u.email" },
}));

vi.mock("drizzle-orm", () => ({
  eq: (...a: unknown[]) => ["eq", ...a],
}));

// normalizeEmail comes from staff-queries; stub it to a simple lowercase/trim so
// we don't pull in bcrypt/tenant/etc.
vi.mock("@/lib/admin/staff-queries", () => ({
  normalizeEmail: (e: string) => e.trim().toLowerCase(),
}));

import { resolveGoogleLogin } from "./google-login";

function identity(
  over: Partial<VerifiedGoogleIdentity> = {},
): VerifiedGoogleIdentity {
  return {
    sub: "google-sub-1",
    email: "Admin@Example.com",
    emailVerified: true,
    name: "Admin User",
    ...over,
  };
}

function userRow(over: Record<string, unknown> = {}) {
  return {
    id: "user-1",
    organizationId: "org-1",
    email: "admin@example.com",
    name: "Admin User",
    role: "admin",
    isActive: true,
    googleId: null,
    ...over,
  };
}

beforeEach(() => {
  selectQueue.length = 0;
  updateCalls.length = 0;
});

describe("resolveGoogleLogin — pre-provisioned only", () => {
  it("denies when no user row exists for the email (no auto-create)", async () => {
    selectQueue.push([]); // no match
    const result = await resolveGoogleLogin(identity());
    expect(result).toEqual({ ok: false, reason: "no_account" });
    expect(updateCalls).toHaveLength(0); // never links/creates anything
  });

  it("denies a technician (non-admin-tier role)", async () => {
    selectQueue.push([userRow({ role: "technician" })]);
    const result = await resolveGoogleLogin(identity());
    expect(result).toEqual({ ok: false, reason: "no_account" });
  });

  it("denies an inactive admin", async () => {
    selectQueue.push([userRow({ isActive: false })]);
    const result = await resolveGoogleLogin(identity());
    expect(result).toEqual({ ok: false, reason: "no_account" });
  });

  it("logs in an active admin and links google_id on first login", async () => {
    selectQueue.push([userRow({ googleId: null })]);
    const result = await resolveGoogleLogin(identity({ sub: "sub-new" }));
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.session).toMatchObject({
        userId: "user-1",
        organizationId: "org-1",
        role: "admin",
      });
    }
    expect(updateCalls).toHaveLength(1); // linked the sub
  });

  it("logs in a super_admin with role super_admin in the session", async () => {
    selectQueue.push([userRow({ role: "super_admin", googleId: "sub-x" })]);
    const result = await resolveGoogleLogin(identity({ sub: "sub-x" }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.session.role).toBe("super_admin");
    expect(updateCalls).toHaveLength(0); // already linked, matching sub
  });

  it("rejects a sub mismatch (same email, different Google account)", async () => {
    selectQueue.push([userRow({ googleId: "original-sub" })]);
    const result = await resolveGoogleLogin(identity({ sub: "attacker-sub" }));
    expect(result).toEqual({ ok: false, reason: "sub_mismatch" });
    expect(updateCalls).toHaveLength(0); // never re-links
  });

  it("does not re-link when the stored sub already matches", async () => {
    selectQueue.push([userRow({ googleId: "google-sub-1" })]);
    const result = await resolveGoogleLogin(identity({ sub: "google-sub-1" }));
    expect(result.ok).toBe(true);
    expect(updateCalls).toHaveLength(0);
  });
});
