import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { isSameOriginRequest, hasJsonContentType } from "./session-csrf";

function makeRequest(
  url: string,
  headers: Record<string, string> = {},
): NextRequest {
  return new NextRequest(new URL(url), { method: "POST", headers });
}

describe("isSameOriginRequest", () => {
  const ORIGINAL_APP_URL = process.env.NEXT_PUBLIC_APP_URL;

  beforeEach(() => {
    delete process.env.NEXT_PUBLIC_APP_URL;
  });
  afterEach(() => {
    if (ORIGINAL_APP_URL === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
    else process.env.NEXT_PUBLIC_APP_URL = ORIGINAL_APP_URL;
  });

  it("allows a request whose Origin matches its own host (same-origin)", () => {
    const req = makeRequest("https://app.example.com/api/session/confirm", {
      origin: "https://app.example.com",
    });
    expect(isSameOriginRequest(req)).toBe(true);
  });

  it("allows across deployment hosts — anchored on the request host, not an env var", () => {
    // A Vercel preview host the env var doesn't know about must still pass.
    const req = makeRequest("https://preview-xyz.vercel.app/api/session/escalate", {
      origin: "https://preview-xyz.vercel.app",
    });
    expect(isSameOriginRequest(req)).toBe(true);
  });

  it("rejects a cross-origin request (the CSRF case)", () => {
    const req = makeRequest("https://app.example.com/api/session/confirm", {
      origin: "https://evil.com",
    });
    expect(isSameOriginRequest(req)).toBe(false);
  });

  it("rejects when the Origin header is absent (never a legitimate browser POST here)", () => {
    const req = makeRequest("https://app.example.com/api/session/confirm");
    expect(isSameOriginRequest(req)).toBe(false);
  });

  it('rejects a literal "null" Origin (sandboxed iframe / opaque origin)', () => {
    const req = makeRequest("https://app.example.com/api/session/confirm", {
      origin: "null",
    });
    expect(isSameOriginRequest(req)).toBe(false);
  });

  it("rejects an http→ downgrade of the same host", () => {
    const req = makeRequest("https://app.example.com/api/session/confirm", {
      origin: "http://app.example.com",
    });
    expect(isSameOriginRequest(req)).toBe(false);
  });

  it("normalizes a trailing slash on the Origin", () => {
    const req = makeRequest("https://app.example.com/api/session/feedback", {
      origin: "https://app.example.com/",
    });
    expect(isSameOriginRequest(req)).toBe(true);
  });

  it("is case-insensitive on the host", () => {
    const req = makeRequest("https://app.example.com/api/session/confirm", {
      origin: "https://APP.example.com",
    });
    expect(isSameOriginRequest(req)).toBe(true);
  });

  it("rejects a lookalike host (suffix attack)", () => {
    const req = makeRequest("https://app.example.com/api/session/confirm", {
      origin: "https://app.example.com.evil.com",
    });
    expect(isSameOriginRequest(req)).toBe(false);
  });

  it("accepts the configured NEXT_PUBLIC_APP_URL even when it differs from the host", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://canonical.example.com/";
    const req = makeRequest("https://behind-proxy.internal/api/session/confirm", {
      origin: "https://canonical.example.com",
    });
    expect(isSameOriginRequest(req)).toBe(true);
  });

  it("still rejects a foreign origin even with NEXT_PUBLIC_APP_URL set", () => {
    process.env.NEXT_PUBLIC_APP_URL = "https://canonical.example.com";
    const req = makeRequest("https://app.example.com/api/session/confirm", {
      origin: "https://evil.com",
    });
    expect(isSameOriginRequest(req)).toBe(false);
  });
});

describe("hasJsonContentType", () => {
  it("accepts application/json", () => {
    const req = makeRequest("https://app.example.com/api/session/feedback", {
      "content-type": "application/json",
    });
    expect(hasJsonContentType(req)).toBe(true);
  });

  it("accepts application/json with a charset parameter", () => {
    const req = makeRequest("https://app.example.com/api/session/feedback", {
      "content-type": "application/json; charset=utf-8",
    });
    expect(hasJsonContentType(req)).toBe(true);
  });

  it("rejects text/plain (the no-preflight form-POST vector)", () => {
    const req = makeRequest("https://app.example.com/api/session/feedback", {
      "content-type": "text/plain",
    });
    expect(hasJsonContentType(req)).toBe(false);
  });

  it("rejects application/x-www-form-urlencoded", () => {
    const req = makeRequest("https://app.example.com/api/session/feedback", {
      "content-type": "application/x-www-form-urlencoded",
    });
    expect(hasJsonContentType(req)).toBe(false);
  });

  it("rejects an absent Content-Type", () => {
    const req = makeRequest("https://app.example.com/api/session/feedback");
    expect(hasJsonContentType(req)).toBe(false);
  });
});
