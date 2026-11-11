import { describe, it, expect, vi, beforeAll, beforeEach } from "vitest";

vi.mock("@/lib/widget/key-queries", () => ({
  allowedOriginsForKey: vi.fn().mockResolvedValue([]),
}));

// Spy on the preview decision while keeping its real behaviour.
const decisionSpy = vi.fn();
vi.mock("@/lib/auth/preview-gate", async (importOriginal) => {
  const real = await importOriginal<typeof import("@/lib/auth/preview-gate")>();
  return {
    ...real,
    previewProxyDecision: (...a: Parameters<typeof real.previewProxyDecision>) => {
      decisionSpy(...a);
      return real.previewProxyDecision(...a);
    },
  };
});

import { NextRequest } from "next/server";
import { proxy, config } from "./proxy";
import { signToken } from "@/lib/auth/config";
import { PREVIEW_COOKIE, signPreviewCookie } from "@/lib/auth/preview-cookie";

const SECRET = "x".repeat(48);
const ADMIN = {
  userId: "11111111-1111-4111-8111-111111111111",
  organizationId: "00000000-0000-0000-0000-000000000001",
  email: "owner@platform.test",
  name: "Platform Owner",
  role: "super_admin" as const,
};
const TARGET = "22222222-2222-4222-8222-222222222222";
let session: string;
let otherSession: string;
let preview: string;

beforeAll(async () => {
  process.env.AUTH_SECRET = SECRET;
  session = await signToken(ADMIN);
  otherSession = await signToken({ ...ADMIN, userId: "33333333-3333-4333-8333-333333333333" });
  preview = await signPreviewCookie(
    { adminUserId: ADMIN.userId, targetUserId: TARGET, exp: Math.floor(Date.now() / 1000) + 600 },
    SECRET,
  );
});

beforeEach(() => {
  decisionSpy.mockClear();
});

function req(
  path: string,
  { method = "GET", cookies = {} as Record<string, string> } = {},
) {
  const cookie = Object.entries(cookies)
    .map(([k, v]) => `${k}=${v}`)
    .join("; ");
  return new NextRequest(`https://app.example.com${path}`, {
    method,
    headers: cookie ? { cookie } : {},
  });
}

const passedThrough = (res: Response) => res.headers.get("x-middleware-next") === "1";

function expectPreviewCleared(res: Response) {
  const setCookie = res.headers.get("set-cookie") ?? "";
  expect(setCookie).toMatch(/hvac_preview=;/);
  expect(setCookie).toMatch(/Max-Age=0/);
  expect(setCookie).toMatch(/Expires=Thu, 01 Jan 1970 00:00:00 GMT/);
}

describe("proxy without a preview cookie (the old path, unchanged)", () => {
  it("never consults the preview gate and sets no cookie", async () => {
    const cases = [
      req("/api/admin/customers", { method: "POST", cookies: { hvac_admin_session: session } }),
      req("/api/admin/customers", { method: "POST" }),
      req("/admin/customers"),
      req("/admin/customers", { cookies: { hvac_admin_session: session } }),
      req("/api/auth/logout", { method: "POST" }),
      req("/embed"),
    ];
    for (const r of cases) {
      const res = await proxy(r);
      expect(res.headers.get("set-cookie")).toBeNull();
    }
    expect(decisionSpy).not.toHaveBeenCalled();
  });

  it("a signed-in POST passes through with the security headers", async () => {
    const res = await proxy(
      req("/api/admin/customers", { method: "POST", cookies: { hvac_admin_session: session } }),
    );
    expect(passedThrough(res)).toBe(true);
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
    expect(res.headers.get("X-Request-Id")).toBeTruthy();
  });

  it("an anonymous admin API call still gets 401 UNAUTHORIZED", async () => {
    const res = await proxy(req("/api/admin/customers", { method: "POST" }));
    expect(res.status).toBe(401);
    expect((await res.json()).error.code).toBe("UNAUTHORIZED");
  });

  it("an anonymous admin page still redirects to sign in", async () => {
    const res = await proxy(req("/admin/customers"));
    expect(res.status).toBe(307);
    expect(res.headers.get("location")).toBe("https://app.example.com/admin/login");
  });
});

describe("proxy on /tech (Task 19)", () => {
  it("the matcher covers the technician pages", () => {
    expect(config.matcher).toContain("/tech/:path*");
  });

  it("other /api routes are matched only while a View-as cookie is present", () => {
    // The customer chat, webhooks and crons must not pay for the proxy; the
    // read-only preview gate must still see every /api write.
    expect(config.matcher).not.toContain("/api/:path*");
    expect(config.matcher).toContain("/api/admin/:path*");
    expect(config.matcher).toContainEqual({
      source: "/api/:path*",
      has: [{ type: "cookie", key: PREVIEW_COOKIE }],
    });
  });

  it("a real technician (no preview cookie) never consults the preview gate", async () => {
    const cases = [
      req("/tech/jobs", { cookies: { hvac_tech_session: "tech-token" } }),
      req("/tech/guide", { cookies: { hvac_tech_session: "tech-token" } }),
      req("/tech/jobs/abc", { cookies: { hvac_tech_session: "tech-token" } }),
      req("/tech/jobs"),
      req("/api/tech/time", { method: "POST", cookies: { hvac_tech_session: "tech-token" } }),
    ];
    for (const r of cases) {
      const res = await proxy(r);
      expect(passedThrough(res)).toBe(true);
      expect(res.status).toBe(200);
      expect(res.headers.get("set-cookie")).toBeNull();
      expect(res.headers.get("location")).toBeNull();
      // The proxy adds no page policy on /tech (the camera/geolocation pages keep theirs).
      expect(res.headers.get("Content-Security-Policy")).toBeNull();
      expect(res.headers.get("Permissions-Policy")).toBeNull();
    }
    expect(decisionSpy).not.toHaveBeenCalled();
  });

  it("valid bound cookie lets a technician page read through", async () => {
    const res = await proxy(
      req("/tech/guide", { cookies: { hvac_admin_session: session, [PREVIEW_COOKIE]: preview } }),
    );
    expect(passedThrough(res)).toBe(true);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("valid bound cookie refuses a technician write", async () => {
    for (const [method, path] of [
      ["POST", "/api/tech/time"],
      ["PATCH", "/api/tech/guide"],
      ["POST", "/api/tech/location"],
      ["POST", "/api/tech/jobs/abc/status"],
    ] as const) {
      const res = await proxy(
        req(path, { method, cookies: { hvac_admin_session: session, [PREVIEW_COOKIE]: preview } }),
      );
      expect(res.status).toBe(403);
      expect((await res.json()).error.code).toBe("PREVIEW_READ_ONLY");
    }
  });

  it("a forged cookie is cleared on a technician page", async () => {
    const res = await proxy(
      req("/tech/jobs", { cookies: { hvac_admin_session: session, [PREVIEW_COOKIE]: "garbage" } }),
    );
    expect(passedThrough(res)).toBe(true);
    expectPreviewCleared(res);
  });
});

describe("proxy with a preview cookie", () => {
  it("valid bound cookie refuses a write with 403 PREVIEW_READ_ONLY", async () => {
    const res = await proxy(
      req("/api/admin/customers", {
        method: "POST",
        cookies: { hvac_admin_session: session, [PREVIEW_COOKIE]: preview },
      }),
    );
    expect(res.status).toBe(403);
    expect(await res.json()).toEqual({
      success: false,
      error: { message: "Read-only while viewing as another user", code: "PREVIEW_READ_ONLY" },
    });
    expect(res.headers.get("X-Frame-Options")).toBe("DENY");
  });

  it("valid bound cookie refuses a write to an unauthenticated API path too", async () => {
    const res = await proxy(
      req("/api/communications/send", {
        method: "POST",
        cookies: { hvac_admin_session: session, [PREVIEW_COOKIE]: preview },
      }),
    );
    expect(res.status).toBe(403);
  });

  it("valid bound cookie refuses a denied GET", async () => {
    const res = await proxy(
      req("/api/admin/export", {
        cookies: { hvac_admin_session: session, [PREVIEW_COOKIE]: preview },
      }),
    );
    expect(res.status).toBe(403);
  });

  it("valid bound cookie lets a read through and keeps the cookie", async () => {
    const res = await proxy(
      req("/admin/customers", {
        cookies: { hvac_admin_session: session, [PREVIEW_COOKIE]: preview },
      }),
    );
    expect(passedThrough(res)).toBe(true);
    expect(res.headers.get("set-cookie")).toBeNull();
  });

  it("valid bound cookie lets exit and logout through", async () => {
    for (const path of ["/api/admin/preview/exit", "/api/auth/logout"]) {
      const res = await proxy(
        req(path, {
          method: "POST",
          cookies: { hvac_admin_session: session, [PREVIEW_COOKIE]: preview },
        }),
      );
      expect(passedThrough(res)).toBe(true);
    }
  });

  it("cookie bound to another admin is cleared and the write proceeds", async () => {
    const res = await proxy(
      req("/api/admin/customers", {
        method: "POST",
        cookies: { hvac_admin_session: otherSession, [PREVIEW_COOKIE]: preview },
      }),
    );
    expect(passedThrough(res)).toBe(true);
    expectPreviewCleared(res);
  });

  it("cookie without a session is cleared on the 401 and on the sign-in redirect", async () => {
    const api = await proxy(
      req("/api/admin/customers", { method: "POST", cookies: { [PREVIEW_COOKIE]: preview } }),
    );
    expect(api.status).toBe(401);
    expectPreviewCleared(api);

    const page = await proxy(req("/admin/customers", { cookies: { [PREVIEW_COOKIE]: preview } }));
    expect(page.status).toBe(307);
    expectPreviewCleared(page);
  });

  it("garbage cookie is cleared on the embed path too", async () => {
    const res = await proxy(req("/embed", { cookies: { [PREVIEW_COOKIE]: "garbage" } }));
    expectPreviewCleared(res);
  });
});
