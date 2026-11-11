import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

vi.mock("server-only", () => ({}));
const historyContact = vi.fn();
vi.mock("@/lib/admin/admin-guide-queries", () => ({
  historyContactOrFallback: (...a: unknown[]) => historyContact(...a),
}));

import { resolveBillingEntry } from "./billing-entry-server";

const ORG = "00000000-0000-0000-0000-0000000000aa";
const ORIGINAL = process.env.PLATFORM_ORG_ID;

function viewer(over: { uiRole?: string; isPlatformAdmin?: boolean; previewing?: boolean } = {}) {
  return {
    session: { userId: "u1", email: "c@x.com", name: "Chick", role: "super_admin" as const, organizationId: ORG },
    uiRole: (over.uiRole ?? "super_admin") as "super_admin" | "admin",
    isPlatformAdmin: over.isPlatformAdmin ?? false,
    preview: over.previewing ? ({ status: "stale", exp: 1 } as const) : null,
  };
}

beforeEach(() => {
  historyContact.mockReset();
  historyContact.mockResolvedValue("Raymond Chen");
});
afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.PLATFORM_ORG_ID;
  else process.env.PLATFORM_ORG_ID = ORIGINAL;
});

describe("resolveBillingEntry", () => {
  it("names the contact in a platform-managed org", async () => {
    process.env.PLATFORM_ORG_ID = ORG;
    expect(await resolveBillingEntry(viewer())).toEqual({ view: "handled", contact: "Raymond Chen" });
    expect(historyContact).toHaveBeenCalledWith(ORG);
  });

  it("shows the panel to an org super_admin elsewhere, without a contact read", async () => {
    process.env.PLATFORM_ORG_ID = "00000000-0000-0000-0000-0000000000ff";
    expect(await resolveBillingEntry(viewer())).toEqual({ view: "panel", contact: null });
    expect(historyContact).not.toHaveBeenCalled();
  });

  it("gives a plain admin no billing entry", async () => {
    process.env.PLATFORM_ORG_ID = ORG;
    expect(await resolveBillingEntry(viewer({ uiRole: "admin" }))).toEqual({ view: "redirect", contact: null });
  });

  it("gives the platform owner (not previewing) the panel, but not while previewing", async () => {
    process.env.PLATFORM_ORG_ID = ORG;
    expect((await resolveBillingEntry(viewer({ isPlatformAdmin: true }))).view).toBe("panel");
    expect((await resolveBillingEntry(viewer({ isPlatformAdmin: true, previewing: true }))).view).toBe("handled");
  });
});
