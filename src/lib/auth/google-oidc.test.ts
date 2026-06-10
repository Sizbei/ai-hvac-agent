import { describe, it, expect, beforeAll } from "vitest";
import { SignJWT, generateKeyPair, exportJWK, type JWK } from "jose";
import {
  getGoogleOidcConfig,
  buildOidcConsentUrl,
  exchangeCodeForIdToken,
  verifyGoogleIdToken,
  type GoogleOidcConfig,
} from "./google-oidc";

const CONFIG: GoogleOidcConfig = {
  clientId: "test-client.apps.googleusercontent.com",
  clientSecret: "test-secret",
  redirectUri: "https://app.example.com/api/auth/google/callback",
};

// A local RSA key pair stands in for Google's signing key so verification runs
// fully offline. We hand verifyGoogleIdToken a local key set built from the JWK.
let privateKey: CryptoKey;
let localJwks: (
  protectedHeader: { alg?: string },
) => Promise<CryptoKey>;

beforeAll(async () => {
  const { privateKey: priv, publicKey } = await generateKeyPair("RS256");
  privateKey = priv;
  const jwk: JWK = await exportJWK(publicKey);
  jwk.alg = "RS256";
  // jwtVerify accepts a function (protectedHeader, token) => key. We ignore the
  // header and always return our single test public key.
  const { importJWK } = await import("jose");
  const key = await importJWK(jwk, "RS256");
  localJwks = async () => key as CryptoKey;
});

async function makeIdToken(
  claims: Record<string, unknown>,
  opts: { iss?: string; aud?: string; exp?: string } = {},
): Promise<string> {
  return new SignJWT(claims)
    .setProtectedHeader({ alg: "RS256" })
    .setIssuer(opts.iss ?? "https://accounts.google.com")
    .setAudience(opts.aud ?? CONFIG.clientId)
    .setIssuedAt()
    .setExpirationTime(opts.exp ?? "5m")
    .setSubject((claims.sub as string) ?? "sub-123")
    .sign(privateKey);
}

describe("getGoogleOidcConfig", () => {
  it("returns null when any env var is missing", () => {
    const saved = {
      id: process.env.GOOGLE_CLIENT_ID,
      secret: process.env.GOOGLE_CLIENT_SECRET,
      uri: process.env.GOOGLE_OIDC_REDIRECT_URI,
    };
    delete process.env.GOOGLE_CLIENT_ID;
    delete process.env.GOOGLE_CLIENT_SECRET;
    delete process.env.GOOGLE_OIDC_REDIRECT_URI;
    expect(getGoogleOidcConfig()).toBeNull();

    process.env.GOOGLE_CLIENT_ID = "x";
    process.env.GOOGLE_CLIENT_SECRET = "y";
    // redirect uri still missing → still null
    expect(getGoogleOidcConfig()).toBeNull();

    process.env.GOOGLE_OIDC_REDIRECT_URI = "z";
    expect(getGoogleOidcConfig()).toEqual({
      clientId: "x",
      clientSecret: "y",
      redirectUri: "z",
    });

    // restore
    if (saved.id) process.env.GOOGLE_CLIENT_ID = saved.id;
    else delete process.env.GOOGLE_CLIENT_ID;
    if (saved.secret) process.env.GOOGLE_CLIENT_SECRET = saved.secret;
    else delete process.env.GOOGLE_CLIENT_SECRET;
    if (saved.uri) process.env.GOOGLE_OIDC_REDIRECT_URI = saved.uri;
    else delete process.env.GOOGLE_OIDC_REDIRECT_URI;
  });
});

describe("buildOidcConsentUrl", () => {
  it("includes scope, state, nonce, response_type=code, and the redirect", () => {
    const url = new URL(buildOidcConsentUrl(CONFIG, "state-abc", "nonce-xyz"));
    expect(url.origin + url.pathname).toBe(
      "https://accounts.google.com/o/oauth2/v2/auth",
    );
    expect(url.searchParams.get("scope")).toBe("openid email profile");
    expect(url.searchParams.get("state")).toBe("state-abc");
    expect(url.searchParams.get("nonce")).toBe("nonce-xyz");
    expect(url.searchParams.get("response_type")).toBe("code");
    expect(url.searchParams.get("client_id")).toBe(CONFIG.clientId);
    expect(url.searchParams.get("redirect_uri")).toBe(CONFIG.redirectUri);
  });
});

describe("exchangeCodeForIdToken", () => {
  it("posts the code and returns the id_token", async () => {
    let capturedBody = "";
    const fakeFetch = (async (_url: string, init?: RequestInit) => {
      capturedBody = String(init?.body ?? "");
      return new Response(JSON.stringify({ id_token: "the.id.token" }), {
        status: 200,
      });
    }) as unknown as typeof fetch;

    const token = await exchangeCodeForIdToken(CONFIG, "auth-code", fakeFetch);
    expect(token).toBe("the.id.token");
    expect(capturedBody).toContain("code=auth-code");
    expect(capturedBody).toContain("grant_type=authorization_code");
  });

  it("throws on a non-OK token response", async () => {
    const fakeFetch = (async () =>
      new Response("nope", { status: 400 })) as unknown as typeof fetch;
    await expect(
      exchangeCodeForIdToken(CONFIG, "bad", fakeFetch),
    ).rejects.toThrow(/HTTP 400/);
  });

  it("throws when id_token is missing", async () => {
    const fakeFetch = (async () =>
      new Response(JSON.stringify({ access_token: "a" }), {
        status: 200,
      })) as unknown as typeof fetch;
    await expect(
      exchangeCodeForIdToken(CONFIG, "x", fakeFetch),
    ).rejects.toThrow(/missing id_token/);
  });
});

describe("verifyGoogleIdToken", () => {
  const NONCE = "nonce-xyz";

  it("accepts a valid token and returns the identity", async () => {
    const token = await makeIdToken({
      sub: "google-sub-1",
      email: "Admin@Example.com",
      email_verified: true,
      name: "Admin User",
      nonce: NONCE,
    });
    const identity = await verifyGoogleIdToken(token, CONFIG, NONCE, localJwks);
    expect(identity).toEqual({
      sub: "google-sub-1",
      email: "Admin@Example.com",
      emailVerified: true,
      name: "Admin User",
    });
  });

  it("treats email_verified false as unverified", async () => {
    const token = await makeIdToken({
      sub: "s",
      email: "a@b.com",
      email_verified: false,
      nonce: NONCE,
    });
    const identity = await verifyGoogleIdToken(token, CONFIG, NONCE, localJwks);
    expect(identity.emailVerified).toBe(false);
  });

  it("rejects a nonce mismatch (replay protection)", async () => {
    const token = await makeIdToken({
      sub: "s",
      email: "a@b.com",
      email_verified: true,
      nonce: "different-nonce",
    });
    await expect(
      verifyGoogleIdToken(token, CONFIG, NONCE, localJwks),
    ).rejects.toThrow(/nonce mismatch/);
  });

  it("rejects a wrong audience (token minted for another client)", async () => {
    const token = await makeIdToken(
      { sub: "s", email: "a@b.com", email_verified: true, nonce: NONCE },
      { aud: "someone-else.apps.googleusercontent.com" },
    );
    await expect(
      verifyGoogleIdToken(token, CONFIG, NONCE, localJwks),
    ).rejects.toThrow();
  });

  it("rejects a wrong issuer", async () => {
    const token = await makeIdToken(
      { sub: "s", email: "a@b.com", email_verified: true, nonce: NONCE },
      { iss: "https://evil.example.com" },
    );
    await expect(
      verifyGoogleIdToken(token, CONFIG, NONCE, localJwks),
    ).rejects.toThrow();
  });

  it("rejects an expired token", async () => {
    const token = await makeIdToken(
      { sub: "s", email: "a@b.com", email_verified: true, nonce: NONCE },
      { exp: "-1m" },
    );
    await expect(
      verifyGoogleIdToken(token, CONFIG, NONCE, localJwks),
    ).rejects.toThrow();
  });

  it("rejects a token missing email", async () => {
    const token = await makeIdToken({
      sub: "s",
      email_verified: true,
      nonce: NONCE,
    });
    await expect(
      verifyGoogleIdToken(token, CONFIG, NONCE, localJwks),
    ).rejects.toThrow(/missing sub or email/);
  });
});
