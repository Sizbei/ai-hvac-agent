import { describe, expect, it } from "vitest";
import type { PreviewState } from "@/lib/auth/viewer";
import {
  billingPageView,
  canExportAccounting,
  chipIdentity,
  READ_ONLY_PREVIEW,
  seesPlatformUi,
  selfUserId,
} from "./preview-view";

const ACTIVE: PreviewState = {
  status: "active",
  targetUserId: "t1",
  targetName: "Chick Spears",
  targetEmail: "chick@example.com",
  targetRole: "super_admin",
  exp: 1,
};
const STALE: PreviewState = { status: "stale", exp: 1 };
const SESSION = { userId: "u1", name: "Raymond Chen", email: "owner@example.com" };

describe("seesPlatformUi", () => {
  it("is true for the platform admin who is not previewing", () => {
    expect(seesPlatformUi({ isPlatformAdmin: true, preview: null })).toBe(true);
  });

  it("is false while previewing, active or stale (spec P7: the target's gates)", () => {
    expect(seesPlatformUi({ isPlatformAdmin: true, preview: ACTIVE })).toBe(false);
    expect(seesPlatformUi({ isPlatformAdmin: true, preview: STALE })).toBe(false);
  });

  it("is false for an org user", () => {
    expect(seesPlatformUi({ isPlatformAdmin: false, preview: null })).toBe(false);
  });
});

describe("chipIdentity", () => {
  it("shows the session user when not previewing", () => {
    expect(chipIdentity(SESSION, null)).toEqual({ name: "Raymond Chen", email: "owner@example.com" });
  });

  it("shows the target's name and email while previewing", () => {
    expect(chipIdentity(SESSION, ACTIVE)).toEqual({ name: "Chick Spears", email: "chick@example.com" });
  });

  it("keeps the session user for a stale preview (no target to show)", () => {
    expect(chipIdentity(SESSION, STALE)).toEqual({ name: "Raymond Chen", email: "owner@example.com" });
  });
});

describe("selfUserId", () => {
  it("is the session user when not previewing", () => {
    expect(selfUserId(SESSION, null)).toBe("u1");
  });

  it("is the target while previewing", () => {
    expect(selfUserId(SESSION, ACTIVE)).toBe("t1");
  });

  it("is the session user for a stale preview", () => {
    expect(selfUserId(SESSION, STALE)).toBe("u1");
  });
});

describe("canExportAccounting", () => {
  it("only a super_admin view gets the export panel", () => {
    expect(canExportAccounting("super_admin")).toBe(true);
    expect(canExportAccounting("admin")).toBe(false);
    expect(canExportAccounting("technician")).toBe(false);
  });
});

describe("billingPageView", () => {
  it("the platform admin (not previewing) sees the panel, in any org and role", () => {
    expect(billingPageView({ uiRole: "super_admin", platformUi: true, platformManagedOrg: true })).toBe("panel");
    expect(billingPageView({ uiRole: "admin", platformUi: true, platformManagedOrg: false })).toBe("panel");
  });

  it("a super_admin of a platform-managed org is told who handles billing", () => {
    expect(billingPageView({ uiRole: "super_admin", platformUi: false, platformManagedOrg: true })).toBe("handled");
  });

  it("a super_admin of any other org sees the panel", () => {
    expect(billingPageView({ uiRole: "super_admin", platformUi: false, platformManagedOrg: false })).toBe("panel");
  });

  it("anyone else is sent away", () => {
    expect(billingPageView({ uiRole: "admin", platformUi: false, platformManagedOrg: true })).toBe("redirect");
    expect(billingPageView({ uiRole: "technician", platformUi: false, platformManagedOrg: false })).toBe("redirect");
  });
});

describe("READ_ONLY_PREVIEW", () => {
  it("is the exact tooltip copy", () => {
    expect(READ_ONLY_PREVIEW).toBe("Read-only preview");
  });
});
