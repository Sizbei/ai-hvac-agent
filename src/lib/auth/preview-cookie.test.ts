import { describe, it, expect } from "vitest";
import {
  PREVIEW_COOKIE,
  PREVIEW_MAX_AGE_S,
  previewCookieOptions,
  signPreviewCookie,
  verifyPreviewCookie,
  type PreviewClaims,
} from "./preview-cookie";

const SECRET = "s".repeat(48);
const NOW = 1_800_000_000;
const CLAIMS: PreviewClaims = {
  adminUserId: "11111111-1111-4111-8111-111111111111",
  targetUserId: "22222222-2222-4222-8222-222222222222",
  exp: NOW + 600,
};

function b64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

describe("preview cookie constants", () => {
  it("names the cookie and caps it at two hours", () => {
    expect(PREVIEW_COOKIE).toBe("hvac_preview");
    expect(PREVIEW_MAX_AGE_S).toBe(7200);
  });

  it("sets HttpOnly, Secure, SameSite=Strict, path / and a 2 h max age", () => {
    expect(previewCookieOptions()).toEqual({
      httpOnly: true,
      secure: true,
      sameSite: "strict",
      path: "/",
      maxAge: 7200,
    });
  });
});

describe("signPreviewCookie / verifyPreviewCookie", () => {
  it("round-trips claims", async () => {
    const value = await signPreviewCookie(CLAIMS, SECRET);
    expect(await verifyPreviewCookie(value, SECRET, NOW)).toEqual(CLAIMS);
  });

  it("rejects a tampered payload", async () => {
    const value = await signPreviewCookie(CLAIMS, SECRET);
    const [, sig] = value.split(".");
    const forged = b64url(
      new TextEncoder().encode(
        JSON.stringify({ ...CLAIMS, targetUserId: "33333333-3333-4333-8333-333333333333" }),
      ),
    );
    expect(await verifyPreviewCookie(`${forged}.${sig}`, SECRET, NOW)).toBeNull();
  });

  it("rejects a tampered signature", async () => {
    const value = await signPreviewCookie(CLAIMS, SECRET);
    const [payload, sig] = value.split(".");
    const flipped = sig.startsWith("A") ? `B${sig.slice(1)}` : `A${sig.slice(1)}`;
    expect(await verifyPreviewCookie(`${payload}.${flipped}`, SECRET, NOW)).toBeNull();
  });

  it("rejects a value signed with another secret", async () => {
    const value = await signPreviewCookie(CLAIMS, "o".repeat(48));
    expect(await verifyPreviewCookie(value, SECRET, NOW)).toBeNull();
  });

  it("rejects a signature made with AUTH_SECRET directly", async () => {
    // Same payload, but HMAC keyed with the raw AUTH_SECRET instead of the
    // derived "hvac_preview/v1" key (ruling 3): must not verify.
    const value = await signPreviewCookie(CLAIMS, SECRET);
    const [payload] = value.split(".");
    const rawKey = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(SECRET),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign"],
    );
    const sig = new Uint8Array(
      await crypto.subtle.sign("HMAC", rawKey, new TextEncoder().encode(payload)),
    );
    expect(await verifyPreviewCookie(`${payload}.${b64url(sig)}`, SECRET, NOW)).toBeNull();
  });

  it("rejects exp in the past", async () => {
    const value = await signPreviewCookie({ ...CLAIMS, exp: NOW - 1 }, SECRET);
    expect(await verifyPreviewCookie(value, SECRET, NOW)).toBeNull();
  });

  it("rejects exp exactly now", async () => {
    const value = await signPreviewCookie({ ...CLAIMS, exp: NOW }, SECRET);
    expect(await verifyPreviewCookie(value, SECRET, NOW)).toBeNull();
  });

  it("rejects an exp more than two hours out", async () => {
    const value = await signPreviewCookie(
      { ...CLAIMS, exp: NOW + PREVIEW_MAX_AGE_S + 1 },
      SECRET,
    );
    expect(await verifyPreviewCookie(value, SECRET, NOW)).toBeNull();
  });

  it("accepts an exp exactly two hours out", async () => {
    const claims = { ...CLAIMS, exp: NOW + PREVIEW_MAX_AGE_S };
    const value = await signPreviewCookie(claims, SECRET);
    expect(await verifyPreviewCookie(value, SECRET, NOW)).toEqual(claims);
  });

  it("rejects a malformed value without throwing", async () => {
    const valid = await signPreviewCookie(CLAIMS, SECRET);
    const [payload, sig] = valid.split(".");
    const cases = [
      "",
      ".",
      "abc",
      "a.b.c",
      `${payload}.`,
      `.${sig}`,
      `${payload}.${sig}.x`,
      "%%%.###",
      "eyJ.eyJ",
      `${b64url(new TextEncoder().encode("not json"))}.${sig}`,
    ];
    for (const c of cases) {
      await expect(verifyPreviewCookie(c, SECRET, NOW)).resolves.toBeNull();
    }
  });

  it("rejects a correctly signed payload with the wrong claim shapes", async () => {
    // A valid signature does not excuse a bad claim: the shape is checked too.
    const bad = [
      { ...CLAIMS, adminUserId: "" },
      { ...CLAIMS, targetUserId: "" },
      { ...CLAIMS, exp: Number.NaN },
      { ...CLAIMS, exp: 1.5 + NOW },
    ] as PreviewClaims[];
    for (const c of bad) {
      const value = await signPreviewCookie(c, SECRET);
      expect(await verifyPreviewCookie(value, SECRET, NOW)).toBeNull();
    }
  });

  it("returns null for an empty secret", async () => {
    const value = await signPreviewCookie(CLAIMS, SECRET);
    expect(await verifyPreviewCookie(value, "", NOW)).toBeNull();
  });

  it("refuses to sign with an empty secret", async () => {
    await expect(signPreviewCookie(CLAIMS, "")).rejects.toThrow();
  });

  it("defaults nowS to the current clock", async () => {
    const live = { ...CLAIMS, exp: Math.floor(Date.now() / 1000) + 60 };
    const value = await signPreviewCookie(live, SECRET);
    expect(await verifyPreviewCookie(value, SECRET)).toEqual(live);
    const dead = { ...CLAIMS, exp: Math.floor(Date.now() / 1000) - 60 };
    expect(await verifyPreviewCookie(await signPreviewCookie(dead, SECRET), SECRET)).toBeNull();
  });
});
