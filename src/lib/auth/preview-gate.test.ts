import { describe, it, expect, beforeAll } from "vitest";
import {
  PREVIEW_GET_DENY,
  normalizePreviewPath,
  previewGate,
  previewProxyDecision,
} from "./preview-gate";
import { signPreviewCookie } from "./preview-cookie";
import { signToken } from "./config";

const SECRET = "p".repeat(48);
const ORG_UUID = "00000000-0000-0000-0000-000000000001";

describe("normalizePreviewPath", () => {
  it("decodes, collapses slashes, strips the trailing slash and lowercases", () => {
    expect(normalizePreviewPath("//API//Admin/%65xport/")).toBe("/api/admin/export");
  });

  it("keeps the root as /", () => {
    expect(normalizePreviewPath("/")).toBe("/");
    expect(normalizePreviewPath("//")).toBe("/");
  });

  it("decodes encoded slashes", () => {
    expect(normalizePreviewPath("/api%2Fadmin%2fexport")).toBe("/api/admin/export");
  });

  it("decodes double encoding", () => {
    expect(normalizePreviewPath("/api/admin/%2565xport")).toBe("/api/admin/export");
  });

  it("resolves dot segments, encoded or not", () => {
    expect(normalizePreviewPath("/api/admin/x/../export")).toBe("/api/admin/export");
    expect(normalizePreviewPath("/api/admin/%2e%2e/admin/./export")).toBe("/api/admin/export");
    expect(normalizePreviewPath("/api/admin/%2E/export")).toBe("/api/admin/export");
  });

  it("treats a backslash as a slash", () => {
    expect(normalizePreviewPath("/api\\admin\\export")).toBe("/api/admin/export");
  });

  it("returns null when decoding fails", () => {
    expect(normalizePreviewPath("/api/admin/%E0%A4%A")).toBeNull();
    expect(normalizePreviewPath("/api/%")).toBeNull();
  });
});

describe("previewGate", () => {
  it("allows reads", () => {
    expect(previewGate("GET", "/admin/customers")).toBe("allow");
    expect(previewGate("HEAD", "/admin/customers")).toBe("allow");
    expect(previewGate("get", "/api/admin/customers")).toBe("allow");
    expect(previewGate("GET", "/admin")).toBe("allow");
  });

  it("refuses every other method", () => {
    expect(previewGate("POST", "/api/admin/requests")).toBe("refuse");
    expect(previewGate("PATCH", "/api/platform/organizations/x")).toBe("refuse");
    expect(previewGate("POST", "/api/communications/send")).toBe("refuse");
    expect(previewGate("PUT", "/api/admin/settings")).toBe("refuse");
    expect(previewGate("DELETE", "/api/admin/customers/abc")).toBe("refuse");
    expect(previewGate("OPTIONS", "/api/admin/customers")).toBe("refuse");
    expect(previewGate("POST", "/admin/customers")).toBe("refuse");
    expect(previewGate("POST", "/api/admin/preview")).toBe("refuse");
    expect(previewGate("PATCH", "/api/admin/guide")).toBe("refuse");
  });

  it("previewGate refuses POST /api/tech/time", () => {
    expect(previewGate("POST", "/api/tech/time")).toBe("refuse");
  });

  it("refuses every non-GET under /api/tech/ and allows its reads", () => {
    for (const m of ["POST", "PATCH", "PUT", "DELETE", "OPTIONS"]) {
      expect(previewGate(m, "/api/tech/guide")).toBe("refuse");
      expect(previewGate(m, "/api/tech/location")).toBe("refuse");
      expect(previewGate(m, "/api/tech/jobs/abc/status")).toBe("refuse");
      expect(previewGate(m, "/api/tech/jobs/abc/invoice/payments")).toBe("refuse");
      expect(previewGate(m, "/api/auth/tech/logout")).toBe("refuse");
    }
    expect(previewGate("GET", "/api/tech/guide")).toBe("allow");
    expect(previewGate("GET", "/api/tech/jobs")).toBe("allow");
    expect(previewGate("GET", "/tech/jobs")).toBe("allow");
    expect(previewGate("GET", "/tech/guide")).toBe("allow");
  });

  it("lets the exit and logout POSTs through, and only those", () => {
    expect(previewGate("POST", "/api/admin/preview/exit")).toBe("allow");
    expect(previewGate("POST", "/api/auth/logout")).toBe("allow");
    expect(previewGate("post", "/api/admin/preview/exit/")).toBe("allow");
    expect(previewGate("DELETE", "/api/admin/preview/exit")).toBe("refuse");
    expect(previewGate("PUT", "/api/auth/logout")).toBe("refuse");
    expect(previewGate("POST", "/api/admin/preview/exit/x")).toBe("refuse");
    expect(previewGate("POST", "/api/auth/logout%00")).toBe("refuse");
  });

  it("refuses the GETs that write, in every path spelling", () => {
    expect(previewGate("GET", "/api/admin/export")).toBe("refuse");
    expect(previewGate("GET", "/api/admin/export/")).toBe("refuse");
    expect(previewGate("GET", "/api/admin/%65xport")).toBe("refuse");
    expect(previewGate("GET", "//api//admin/export")).toBe("refuse");
    expect(previewGate("GET", "/API/ADMIN/EXPORT")).toBe("refuse");
    expect(previewGate("GET", "/api/admin/%E0%A4%A")).toBe("refuse");
    expect(previewGate("GET", "/api%2fadmin%2fexport")).toBe("refuse");
    expect(previewGate("GET", "/api/admin/x/%2e%2e/export")).toBe("refuse");
    expect(previewGate("HEAD", "/api/admin/export")).toBe("refuse");
    expect(
      previewGate("GET", `/api/platform/organizations/${ORG_UUID}/export`),
    ).toBe("refuse");
    expect(previewGate("GET", "/api/platform/organizations/not-a-uuid/export/")).toBe(
      "refuse",
    );
    expect(previewGate("GET", "/api/admin/integrations/google/connect")).toBe("refuse");
  });

  it("refuses every listed GET", () => {
    const listed = [
      "/api/auth/google/start",
      "/api/auth/google/callback",
      "/api/auth/signup/callback",
      "/api/admin/integrations/google/connect",
      "/api/admin/integrations/google/callback",
      "/api/admin/export",
      "/api/admin/accounting/export",
      `/api/platform/organizations/${ORG_UUID}/export`,
    ];
    for (const p of listed) {
      expect(previewGate("GET", p)).toBe("refuse");
      expect(previewGate("GET", `${p}/`)).toBe("refuse");
      expect(previewGate("GET", p.toUpperCase())).toBe("refuse");
    }
    // The list is exactly the brief's eight entries.
    expect(PREVIEW_GET_DENY).toHaveLength(8);
  });

  it("does not over-match neighbours of a denied path", () => {
    expect(previewGate("GET", "/api/admin/exports")).toBe("allow");
    expect(previewGate("GET", "/api/admin/integrations/google")).toBe("allow");
    expect(previewGate("GET", "/api/platform/organizations")).toBe("allow");
    expect(previewGate("GET", `/api/platform/organizations/${ORG_UUID}`)).toBe("allow");
  });
});

describe("previewProxyDecision", () => {
  const ADMIN = {
    userId: "11111111-1111-4111-8111-111111111111",
    organizationId: ORG_UUID,
    email: "owner@platform.test",
    name: "Platform Owner",
    role: "super_admin" as const,
  };
  const TARGET = "22222222-2222-4222-8222-222222222222";
  const NOW = Math.floor(Date.now() / 1000);
  let sessionToken: string;
  let otherSessionToken: string;
  let cookie: string;

  beforeAll(async () => {
    process.env.AUTH_SECRET = SECRET;
    sessionToken = await signToken(ADMIN);
    otherSessionToken = await signToken({
      ...ADMIN,
      userId: "33333333-3333-4333-8333-333333333333",
    });
    cookie = await signPreviewCookie(
      { adminUserId: ADMIN.userId, targetUserId: TARGET, exp: NOW + 600 },
      SECRET,
    );
  });

  const base = () => ({ authSecret: SECRET, nowS: NOW, sessionToken, previewCookie: cookie });

  it("no cookie → pass", async () => {
    expect(
      await previewProxyDecision({
        ...base(),
        method: "POST",
        pathname: "/api/admin/customers",
        previewCookie: undefined,
      }),
    ).toEqual({ action: "pass" });
  });

  it("valid bound cookie + POST /api/admin/customers → refuse (403 PREVIEW_READ_ONLY)", async () => {
    expect(
      await previewProxyDecision({ ...base(), method: "POST", pathname: "/api/admin/customers" }),
    ).toEqual({ action: "refuse" });
  });

  it("valid bound cookie + GET /admin → pass", async () => {
    expect(
      await previewProxyDecision({ ...base(), method: "GET", pathname: "/admin" }),
    ).toEqual({ action: "pass" });
  });

  it("valid bound cookie + GET on the deny list → refuse", async () => {
    expect(
      await previewProxyDecision({ ...base(), method: "GET", pathname: "/api/admin/export/" }),
    ).toEqual({ action: "refuse" });
  });

  it("cookie bound to another admin → clear, and the request proceeds", async () => {
    expect(
      await previewProxyDecision({
        ...base(),
        sessionToken: otherSessionToken,
        method: "POST",
        pathname: "/api/admin/customers",
      }),
    ).toEqual({ action: "clear" });
  });

  it("expired cookie → clear", async () => {
    const expired = await signPreviewCookie(
      { adminUserId: ADMIN.userId, targetUserId: TARGET, exp: NOW - 1 },
      SECRET,
    );
    expect(
      await previewProxyDecision({
        ...base(),
        previewCookie: expired,
        method: "GET",
        pathname: "/admin",
      }),
    ).toEqual({ action: "clear" });
  });

  it("tampered or garbage cookie → clear", async () => {
    for (const bad of ["", "garbage", `${cookie}x`]) {
      expect(
        await previewProxyDecision({
          ...base(),
          previewCookie: bad,
          method: "POST",
          pathname: "/api/admin/customers",
        }),
      ).toEqual({ action: "clear" });
    }
  });

  it("cookie present, no session token → clear", async () => {
    expect(
      await previewProxyDecision({
        ...base(),
        sessionToken: undefined,
        method: "GET",
        pathname: "/admin",
      }),
    ).toEqual({ action: "clear" });
  });

  it("cookie present, invalid session token → clear", async () => {
    expect(
      await previewProxyDecision({
        ...base(),
        sessionToken: "not-a-jwt",
        method: "GET",
        pathname: "/admin",
      }),
    ).toEqual({ action: "clear" });
  });

  it("valid bound cookie + POST /api/auth/logout → pass", async () => {
    expect(
      await previewProxyDecision({ ...base(), method: "POST", pathname: "/api/auth/logout" }),
    ).toEqual({ action: "pass" });
  });

  it("valid bound cookie + POST /api/admin/preview/exit → pass", async () => {
    expect(
      await previewProxyDecision({
        ...base(),
        method: "POST",
        pathname: "/api/admin/preview/exit",
      }),
    ).toEqual({ action: "pass" });
  });
});
