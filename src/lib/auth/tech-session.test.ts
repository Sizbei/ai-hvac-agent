import { describe, it, expect, vi, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

vi.mock("server-only", () => ({}));

vi.mock("next/server", () => ({
  after: (fn: () => Promise<void> | void) => {
    void fn();
  },
}));

const cookieSet = vi.fn();
const cookieGet = vi.fn();
vi.mock("next/headers", () => ({
  cookies: async () => ({ set: cookieSet, get: cookieGet, delete: vi.fn() }),
}));

const execute = vi.fn();
vi.mock("@/lib/db", () => ({ db: { execute: (q: SQL) => execute(q) } }));

vi.mock("./tech-config", () => ({
  signTechToken: vi.fn(async () => "tok"),
  verifyTechToken: vi.fn(),
}));
vi.mock("./session-revocation", () => ({ isSessionUserCurrent: vi.fn() }));
vi.mock("./session", () => ({ getAdminSession: vi.fn() }));

const warn = vi.fn();
const logError = vi.fn();
vi.mock("@/lib/logger", () => ({
  logger: { warn: (...a: unknown[]) => warn(...a), error: (...a: unknown[]) => logError(...a) },
  errorCode: () => "X",
}));

import { createTechSession, getTechSession } from "./tech-session";
import { verifyTechToken } from "./tech-config";
import { isSessionUserCurrent } from "./session-revocation";
import { getAdminSession } from "./session";
import { PREVIEW_COOKIE, signPreviewCookie } from "./preview-cookie";
const DEMO_ORG_ID = "44444444-4444-4444-4444-444444444444";

const ORG = "33333333-3333-3333-3333-333333333333";
const payload = (organizationId: string) =>
  ({ userId: "u1", organizationId, role: "technician" }) as never;

beforeEach(() => {
  process.env.DEMO_MODE_ORG_IDS = DEMO_ORG_ID;
  execute.mockReset().mockResolvedValue({ rows: [] });
  cookieSet.mockClear();
  warn.mockClear();
});

describe("createTechSession onboarding flag", () => {
  it("never writes for the demo org", async () => {
    await createTechSession(payload(DEMO_ORG_ID));
    expect(cookieSet).toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("writes a guarded techSignedInAt statement for a real org", async () => {
    await createTechSession(payload(ORG));
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));
    const q = new PgDialect().sqlToQuery(execute.mock.calls[0][0] as SQL);
    expect(q.sql).toContain("#> '{flags,techSignedInAt}' IS NULL");
    expect(q.params).toContain(ORG);
  });

  it("does not reject when the write throws", async () => {
    execute.mockRejectedValue(new Error("db down"));
    await expect(createTechSession(payload(ORG))).resolves.toBeUndefined();
    await vi.waitFor(() => expect(warn).toHaveBeenCalled());
  });
});

describe("getTechSession revocation call shape", () => {
  it("passes the token email to isSessionUserCurrent", async () => {
    cookieGet.mockReturnValue({ value: "tok" });
    const tokenPayload = {
      userId: "u1",
      organizationId: ORG,
      email: "tech@example.com",
      name: "Tess",
      role: "technician",
    };
    vi.mocked(verifyTechToken).mockResolvedValue(tokenPayload as never);
    vi.mocked(isSessionUserCurrent).mockResolvedValue(true);
    expect(await getTechSession()).toEqual(tokenPayload);
    expect(isSessionUserCurrent).toHaveBeenCalledWith(
      "u1",
      ORG,
      "technician",
      "tech@example.com",
    );
  });

  it("returns null when the revocation check denies", async () => {
    cookieGet.mockReturnValue({ value: "tok" });
    vi.mocked(verifyTechToken).mockResolvedValue({
      userId: "u1",
      organizationId: ORG,
      email: "mike.johnson@demo-hvac.com",
      name: "Mike",
      role: "technician",
    } as never);
    vi.mocked(isSessionUserCurrent).mockResolvedValue(false);
    expect(await getTechSession()).toBeNull();
  });
});

describe("getTechSession preview fallback (View as a technician)", () => {
  const SECRET = "t".repeat(48);
  const PLATFORM_ORG = "55555555-5555-4555-8555-555555555555";
  const ADMIN = {
    userId: "66666666-6666-4666-8666-666666666666",
    organizationId: PLATFORM_ORG,
    email: "owner@platform.test",
    name: "Owner",
    role: "super_admin" as const,
  };
  const TECH = "77777777-7777-4777-8777-777777777777";
  const techRow = { id: TECH, name: "Tess Tech", email: "tess@example.com", role: "technician" };
  const nowS = () => Math.floor(Date.now() / 1000);

  async function cookie(over: { adminUserId?: string; exp?: number; secret?: string } = {}) {
    return signPreviewCookie(
      { adminUserId: over.adminUserId ?? ADMIN.userId, targetUserId: TECH, exp: over.exp ?? nowS() + 600 },
      over.secret ?? SECRET,
    );
  }
  function jar(values: Record<string, string>) {
    cookieGet.mockImplementation((name: string) =>
      values[name] === undefined ? undefined : { value: values[name] },
    );
  }

  beforeEach(() => {
    process.env.AUTH_SECRET = SECRET;
    process.env.PLATFORM_ORG_ID = PLATFORM_ORG;
    process.env.PLATFORM_ADMIN_EMAILS = ADMIN.email;
    cookieGet.mockReset();
    logError.mockClear();
    vi.mocked(verifyTechToken).mockReset();
    vi.mocked(getAdminSession).mockReset().mockResolvedValue(ADMIN);
    execute.mockReset().mockResolvedValue({ rows: [techRow] });
  });

  it("falls back to the previewed technician", async () => {
    const exp = nowS() + 600;
    jar({ [PREVIEW_COOKIE]: await cookie({ exp }) });
    expect(await getTechSession()).toEqual({
      userId: TECH,
      organizationId: PLATFORM_ORG,
      email: "tess@example.com",
      name: "Tess Tech",
      role: "technician",
      preview: { adminUserId: ADMIN.userId, exp },
    });
    // The target lookup is scoped to the admin's org, the target id and active users.
    const q = new PgDialect().sqlToQuery(execute.mock.calls[0][0] as SQL);
    expect(q.params).toEqual(expect.arrayContaining([TECH, PLATFORM_ORG]));
    expect(q.sql).toMatch(/is_active = true/);
    expect(execute).toHaveBeenCalledTimes(1);
  });

  it("no fallback for an admin-tier target", async () => {
    jar({ [PREVIEW_COOKIE]: await cookie() });
    execute.mockResolvedValue({ rows: [{ ...techRow, role: "admin" }] });
    expect(await getTechSession()).toBeNull();
    execute.mockResolvedValue({ rows: [{ ...techRow, role: "super_admin" }] });
    expect(await getTechSession()).toBeNull();
  });

  it("no fallback when the target is not an active user of the org", async () => {
    jar({ [PREVIEW_COOKIE]: await cookie() });
    execute.mockResolvedValue({ rows: [] });
    expect(await getTechSession()).toBeNull();
  });

  it("no fallback for a forged cookie", async () => {
    jar({ [PREVIEW_COOKIE]: await cookie({ secret: "f".repeat(48) }) });
    expect(await getTechSession()).toBeNull();
    const real = await cookie();
    jar({ [PREVIEW_COOKIE]: `${real.split(".")[0]}.AAAA` });
    expect(await getTechSession()).toBeNull();
    expect(execute).not.toHaveBeenCalled();
  });

  it("no fallback for an expired cookie", async () => {
    jar({ [PREVIEW_COOKIE]: await cookie({ exp: nowS() - 1 }) });
    expect(await getTechSession()).toBeNull();
    expect(execute).not.toHaveBeenCalled();
  });

  it("no fallback for a cookie bound to another admin", async () => {
    jar({ [PREVIEW_COOKIE]: await cookie({ adminUserId: "88888888-8888-4888-8888-888888888888" }) });
    expect(await getTechSession()).toBeNull();
    expect(execute).not.toHaveBeenCalled();
  });

  it("no fallback when the admin is not a platform admin", async () => {
    jar({ [PREVIEW_COOKIE]: await cookie() });
    process.env.PLATFORM_ADMIN_EMAILS = "someone-else@platform.test";
    expect(await getTechSession()).toBeNull();
    process.env.PLATFORM_ADMIN_EMAILS = ADMIN.email;
    vi.mocked(getAdminSession).mockResolvedValue({ ...ADMIN, organizationId: ORG });
    expect(await getTechSession()).toBeNull();
    expect(execute).not.toHaveBeenCalled();
  });

  it("no fallback without an admin session", async () => {
    jar({ [PREVIEW_COOKIE]: await cookie() });
    vi.mocked(getAdminSession).mockResolvedValue(null);
    expect(await getTechSession()).toBeNull();
  });

  it("no fallback while a technician session cookie is present, even an invalid one", async () => {
    jar({ hvac_tech_session: "bad", [PREVIEW_COOKIE]: await cookie() });
    vi.mocked(verifyTechToken).mockResolvedValue(null);
    expect(await getTechSession()).toBeNull();
    expect(getAdminSession).not.toHaveBeenCalled();
  });

  it("a real technician never reaches the preview path", async () => {
    jar({ hvac_tech_session: "tok" });
    const real = { userId: "u1", organizationId: ORG, email: "t@x", name: "T", role: "technician" };
    vi.mocked(verifyTechToken).mockResolvedValue(real as never);
    vi.mocked(isSessionUserCurrent).mockResolvedValue(true);
    expect(await getTechSession()).toEqual(real);
    expect(getAdminSession).not.toHaveBeenCalled();
    expect(execute).not.toHaveBeenCalled();
  });

  it("no cookies at all → null without an admin lookup", async () => {
    jar({});
    expect(await getTechSession()).toBeNull();
    expect(getAdminSession).not.toHaveBeenCalled();
  });

  it("a failed target lookup → null, logged with a code", async () => {
    jar({ [PREVIEW_COOKIE]: await cookie() });
    execute.mockRejectedValue(new Error("db down"));
    expect(await getTechSession()).toBeNull();
    expect(logError).toHaveBeenCalledTimes(1);
  });
});
