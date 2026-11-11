import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/session", () => ({ getAdminSession: vi.fn() }));
vi.mock("@/lib/auth/authz", () => ({ isPlatformAdmin: vi.fn() }));
vi.mock("@/lib/tenancy/features", () => ({ getCachedFeatures: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn() }, errorCode: () => undefined }));
vi.mock("@/lib/admin/preview-targets", () => ({ findPreviewTarget: vi.fn() }));
const cookieJar = new Map<string, string>();
const cookiesFn = vi.fn(async () => ({
  get: (name: string) => (cookieJar.has(name) ? { name, value: cookieJar.get(name)! } : undefined),
}));
vi.mock("next/headers", () => ({ cookies: () => cookiesFn() }));

import { getAdminSession } from "@/lib/auth/session";
import { isPlatformAdmin } from "@/lib/auth/authz";
import { getCachedFeatures } from "@/lib/tenancy/features";
import { DEFAULT_FEATURES } from "@/lib/tenancy/feature-flags";
import type { AdminSessionPayload } from "@/lib/auth/types";
import { findPreviewTarget } from "@/lib/admin/preview-targets";
import { logger } from "@/lib/logger";
import { PREVIEW_COOKIE, signPreviewCookie } from "./preview-cookie";
import { getViewerContext } from "./viewer";

const SESSION: AdminSessionPayload = {
  userId: "u1",
  organizationId: "o1",
  email: "chick@example.com",
  name: "Chick",
  role: "super_admin",
};

const session = vi.mocked(getAdminSession);
const platform = vi.mocked(isPlatformAdmin);
const features = vi.mocked(getCachedFeatures);
const target = vi.mocked(findPreviewTarget);

const SECRET = "test-auth-secret-for-viewer";
const TARGET = { userId: "t1", name: "Chick Spears", email: "chick.spears@example.com", role: "admin" as const };

async function setPreviewCookie(adminUserId = SESSION.userId, targetUserId = TARGET.userId) {
  const exp = Math.floor(Date.now() / 1000) + 600;
  cookieJar.set(PREVIEW_COOKIE, await signPreviewCookie({ adminUserId, targetUserId, exp }, SECRET));
}

beforeEach(() => {
  vi.resetAllMocks();
  cookieJar.clear();
  process.env.AUTH_SECRET = SECRET;
  session.mockResolvedValue(SESSION);
  platform.mockReturnValue(false);
  features.mockResolvedValue(DEFAULT_FEATURES);
  cookiesFn.mockImplementation(async () => ({
    get: (name: string) =>
      cookieJar.has(name) ? { name, value: cookieJar.get(name)! } : undefined,
  }));
});

describe("getViewerContext", () => {
  it("returns null without a session", async () => {
    session.mockResolvedValue(null);
    expect(await getViewerContext()).toBeNull();
    expect(features).not.toHaveBeenCalled();
  });

  it("an org user sees visible rows only by default", async () => {
    const v = await getViewerContext();
    expect(v).toEqual({
      session: SESSION,
      isPlatformAdmin: false,
      features: DEFAULT_FEATURES,
      preview: null,
      uiRole: "super_admin",
      showHidden: false,
    });
    expect(features).toHaveBeenCalledWith("o1");
  });

  it("showHistory reveals history to the org", async () => {
    features.mockResolvedValue({ ...DEFAULT_FEATURES, showHistory: true });
    expect((await getViewerContext())?.showHidden).toBe(true);
  });

  it("the platform admin sees everything", async () => {
    platform.mockReturnValue(true);
    const v = await getViewerContext();
    expect(v?.isPlatformAdmin).toBe(true);
    expect(v?.showHidden).toBe(true);
  });

  it("uiRole is the session role", async () => {
    session.mockResolvedValue({ ...SESSION, role: "admin" });
    expect((await getViewerContext())?.uiRole).toBe("admin");
  });

  it("a features error falls back to DEFAULT_FEATURES and never reveals history", async () => {
    features.mockRejectedValue(new Error("db down"));
    const v = await getViewerContext();
    expect(v?.features).toEqual(DEFAULT_FEATURES);
    expect(v?.showHidden).toBe(false);
  });

  it("a platform-detection error counts as not a platform admin", async () => {
    platform.mockImplementation(() => {
      throw new Error("env");
    });
    const v = await getViewerContext();
    expect(v?.isPlatformAdmin).toBe(false);
    expect(v?.showHidden).toBe(false);
  });
});

describe("getViewerContext — view as", () => {
  beforeEach(() => {
    platform.mockReturnValue(true);
    target.mockResolvedValue(TARGET);
  });

  it("platform admin, no cookie → showHidden true, preview null, uiRole session.role", async () => {
    const v = await getViewerContext();
    expect(v?.preview).toBeNull();
    expect(v?.showHidden).toBe(true);
    expect(v?.uiRole).toBe("super_admin");
    expect(target).not.toHaveBeenCalled();
  });

  it("valid cookie, active same-org target → preview active, showHidden false, uiRole target role", async () => {
    await setPreviewCookie();
    const v = await getViewerContext();
    expect(v?.preview).toEqual({
      status: "active",
      targetUserId: "t1",
      targetName: "Chick Spears",
      targetEmail: "chick.spears@example.com",
      targetRole: "admin",
      exp: expect.any(Number),
    });
    expect(v?.showHidden).toBe(false);
    expect(v?.uiRole).toBe("admin");
    // The real session stays authoritative.
    expect(v?.session).toEqual(SESSION);
    expect(v?.isPlatformAdmin).toBe(true);
    expect(target).toHaveBeenCalledWith("o1", "t1");
  });

  it("a technician target renders with the technician role", async () => {
    target.mockResolvedValue({ ...TARGET, role: "technician" });
    await setPreviewCookie();
    const v = await getViewerContext();
    expect(v?.uiRole).toBe("technician");
    expect(v?.preview).toMatchObject({ status: "active", targetRole: "technician" });
  });

  it("valid cookie, target inactive → preview stale, showHidden false", async () => {
    target.mockResolvedValue(null);
    await setPreviewCookie();
    const v = await getViewerContext();
    expect(v?.preview).toEqual({ status: "stale", exp: expect.any(Number) });
    expect(v?.showHidden).toBe(false);
    expect(v?.uiRole).toBe("super_admin");
  });

  it("cookie bound to another admin → preview null", async () => {
    await setPreviewCookie("someone-else");
    const v = await getViewerContext();
    expect(v?.preview).toBeNull();
    expect(v?.showHidden).toBe(true);
    expect(target).not.toHaveBeenCalled();
  });

  it("non-platform admin with a valid cookie → preview null", async () => {
    platform.mockReturnValue(false);
    await setPreviewCookie();
    const v = await getViewerContext();
    expect(v?.preview).toBeNull();
    expect(v?.uiRole).toBe("super_admin");
    expect(cookiesFn).not.toHaveBeenCalled();
    expect(target).not.toHaveBeenCalled();
  });

  it("a tampered or expired cookie → preview null", async () => {
    await setPreviewCookie();
    cookieJar.set(PREVIEW_COOKIE, `${cookieJar.get(PREVIEW_COOKIE)}x`);
    expect((await getViewerContext())?.preview).toBeNull();

    const past = Math.floor(Date.now() / 1000) - 1;
    cookieJar.set(
      PREVIEW_COOKIE,
      await signPreviewCookie({ adminUserId: "u1", targetUserId: "t1", exp: past }, SECRET),
    );
    expect((await getViewerContext())?.preview).toBeNull();
    expect(target).not.toHaveBeenCalled();
  });

  it("a cookie signed under another secret → preview null", async () => {
    await setPreviewCookie();
    process.env.AUTH_SECRET = "a-different-secret";
    expect((await getViewerContext())?.preview).toBeNull();
  });

  it("showHistory on → showHidden true even while previewing", async () => {
    features.mockResolvedValue({ ...DEFAULT_FEATURES, showHistory: true });
    await setPreviewCookie();
    const v = await getViewerContext();
    expect(v?.preview?.status).toBe("active");
    expect(v?.showHidden).toBe(true);
  });

  it("a target lookup error behind a valid bound cookie → stale (agrees with the proxy), logged", async () => {
    target.mockRejectedValue(new Error("db down"));
    await setPreviewCookie();
    const v = await getViewerContext();
    expect(v?.preview).toEqual({ status: "stale", exp: expect.any(Number) });
    expect(v?.showHidden).toBe(false);
    expect(v?.uiRole).toBe("super_admin");
    expect(logger.error).toHaveBeenCalledTimes(1);
  });

  it("preview.exp is the cookie's exp", async () => {
    const exp = Math.floor(Date.now() / 1000) + 900;
    cookieJar.set(
      PREVIEW_COOKIE,
      await signPreviewCookie({ adminUserId: "u1", targetUserId: "t1", exp }, SECRET),
    );
    expect((await getViewerContext())?.preview?.exp).toBe(exp);
  });

  it("a cookie read error → not previewing", async () => {
    cookiesFn.mockRejectedValue(new Error("outside a request"));
    const v = await getViewerContext();
    expect(v?.preview).toBeNull();
    expect(v?.showHidden).toBe(true);
  });
});
