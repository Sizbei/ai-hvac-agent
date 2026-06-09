import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  getGoogleOAuthConfig,
  buildConsentUrl,
  exchangeCodeForTokens,
  refreshAccessToken,
  type GoogleOAuthConfig,
} from "./oauth";

const CONFIG: GoogleOAuthConfig = {
  clientId: "client-123.apps.googleusercontent.com",
  clientSecret: "secret-xyz",
  redirectUri: "http://localhost:3000/api/admin/integrations/google/callback",
};

/** A Response-shaped stub for fetch mocks. */
function jsonResponse(body: unknown, ok = true, status = 200): Response {
  return {
    ok,
    status,
    json: async () => body,
  } as unknown as Response;
}

describe("getGoogleOAuthConfig", () => {
  const saved = { ...process.env };
  afterEach(() => {
    process.env = { ...saved };
  });

  it("returns null when credentials are unset (degrade safely)", () => {
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
    delete process.env.GOOGLE_REDIRECT_URI;
    expect(getGoogleOAuthConfig()).toBeNull();
  });

  it("returns null when only some credentials are set", () => {
    process.env.GOOGLE_CLIENT_ID = "id";
    delete process.env.GOOGLE_CLIENT_SECRET;
    process.env.GOOGLE_REDIRECT_URI = "uri";
    expect(getGoogleOAuthConfig()).toBeNull();
  });

  it("returns the config when all three vars are present", () => {
    process.env.GOOGLE_CLIENT_ID = "id";
    process.env.GOOGLE_CLIENT_SECRET = "secret";
    process.env.GOOGLE_REDIRECT_URI = "uri";
    expect(getGoogleOAuthConfig()).toEqual({
      clientId: "id",
      clientSecret: "secret",
      redirectUri: "uri",
    });
  });
});

describe("buildConsentUrl", () => {
  it("requests offline access + consent so Google returns a refresh token", () => {
    const url = new URL(buildConsentUrl(CONFIG, "state-abc"));
    expect(url.searchParams.get("access_type")).toBe("offline");
    expect(url.searchParams.get("prompt")).toBe("consent");
    expect(url.searchParams.get("client_id")).toBe(CONFIG.clientId);
    expect(url.searchParams.get("redirect_uri")).toBe(CONFIG.redirectUri);
    expect(url.searchParams.get("state")).toBe("state-abc");
    expect(url.searchParams.get("scope")).toContain("calendar.events");
  });
});

describe("exchangeCodeForTokens", () => {
  it("posts the code and returns refresh + access tokens", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({
        access_token: "access-1",
        refresh_token: "refresh-1",
        expires_in: 3600,
      }),
    );
    const result = await exchangeCodeForTokens(
      CONFIG,
      "auth-code",
      fetchMock as unknown as typeof fetch,
    );
    expect(result.refreshToken).toBe("refresh-1");
    expect(result.accessToken).toBe("access-1");
    expect(result.accessTokenExpiresAt).toBeGreaterThan(Date.now());

    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = call[1].body as string;
    expect(body).toContain("grant_type=authorization_code");
    expect(body).toContain("code=auth-code");
  });

  it("throws when Google omits the refresh token", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ access_token: "a", expires_in: 3600 }),
    );
    await expect(
      exchangeCodeForTokens(
        CONFIG,
        "code",
        fetchMock as unknown as typeof fetch,
      ),
    ).rejects.toThrow(/refresh token/i);
  });

  it("throws on a non-OK HTTP response", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({}, false, 400));
    await expect(
      exchangeCodeForTokens(
        CONFIG,
        "code",
        fetchMock as unknown as typeof fetch,
      ),
    ).rejects.toThrow(/HTTP 400/);
  });
});

describe("refreshAccessToken", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-06-09T00:00:00Z"));
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("mints a fresh access token from a refresh token", async () => {
    const fetchMock = vi.fn(async () =>
      jsonResponse({ access_token: "fresh-access", expires_in: 3600 }),
    );
    const result = await refreshAccessToken(
      CONFIG,
      "refresh-1",
      fetchMock as unknown as typeof fetch,
    );
    expect(result.accessToken).toBe("fresh-access");
    expect(result.accessTokenExpiresAt).toBe(Date.now() + 3600 * 1000);

    const call = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const body = call[1].body as string;
    expect(body).toContain("grant_type=refresh_token");
    expect(body).toContain("refresh_token=refresh-1");
  });

  it("throws on a non-OK refresh response", async () => {
    const fetchMock = vi.fn(async () => jsonResponse({}, false, 401));
    await expect(
      refreshAccessToken(
        CONFIG,
        "refresh-1",
        fetchMock as unknown as typeof fetch,
      ),
    ).rejects.toThrow(/HTTP 401/);
  });
});
