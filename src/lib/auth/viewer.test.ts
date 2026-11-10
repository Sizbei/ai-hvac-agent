import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/session", () => ({ getAdminSession: vi.fn() }));
vi.mock("@/lib/auth/authz", () => ({ isPlatformAdmin: vi.fn() }));
vi.mock("@/lib/tenancy/features", () => ({ getFeatures: vi.fn() }));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn() }, errorCode: () => undefined }));

import { getAdminSession } from "@/lib/auth/session";
import { isPlatformAdmin } from "@/lib/auth/authz";
import { getFeatures } from "@/lib/tenancy/features";
import { DEFAULT_FEATURES } from "@/lib/tenancy/feature-flags";
import type { AdminSessionPayload } from "@/lib/auth/types";
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
const features = vi.mocked(getFeatures);

beforeEach(() => {
  vi.resetAllMocks();
  session.mockResolvedValue(SESSION);
  platform.mockReturnValue(false);
  features.mockResolvedValue(DEFAULT_FEATURES);
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
