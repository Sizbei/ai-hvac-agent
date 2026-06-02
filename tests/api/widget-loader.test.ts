import { describe, it, expect, vi, afterEach } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "@/app/widget.js/route";

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const ORIG_APP_URL = process.env.NEXT_PUBLIC_APP_URL;
const ORIG_NODE_ENV = process.env.NODE_ENV;
afterEach(() => {
  if (ORIG_APP_URL === undefined) delete process.env.NEXT_PUBLIC_APP_URL;
  else process.env.NEXT_PUBLIC_APP_URL = ORIG_APP_URL;
  vi.unstubAllEnvs();
});

function req(): NextRequest {
  return new NextRequest(
    new URL("https://app.example.com/widget.js"),
    { method: "GET" },
  );
}

describe("GET /widget.js (embed loader)", () => {
  it("serves JavaScript", async () => {
    const res = GET(req());
    expect(res.headers.get("Content-Type")).toContain("application/javascript");
  });

  it("reads the publishable key from data-hvac-key and points the iframe at /embed", async () => {
    const res = GET(req());
    const body = await res.text();
    expect(body).toContain('getAttribute("data-hvac-key")');
    expect(body).toContain("/embed?key=");
    expect(body).toContain("/api/widget/config?key=");
  });

  it("bakes in NEXT_PUBLIC_APP_URL (not the request Host) when configured", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://configured.example.com");
    const res = GET(req());
    const body = await res.text();
    // The trusted env origin is baked in; the request Host is ignored.
    expect(body).toContain('"https://configured.example.com"');
    expect(body).not.toContain('"https://app.example.com"');
  });

  it("falls back to the request origin in development when the env var is unset", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "");
    vi.stubEnv("NODE_ENV", "development");
    const res = GET(req());
    const body = await res.text();
    expect(body).toContain('"https://app.example.com"');
  });

  it("fails closed (503) in production when NEXT_PUBLIC_APP_URL is unset", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "");
    vi.stubEnv("NODE_ENV", "production");
    const res = GET(req());
    expect(res.status).toBe(503);
  });

  it("guards against double-loading", async () => {
    vi.stubEnv("NEXT_PUBLIC_APP_URL", "https://app.example.com");
    const res = GET(req());
    const body = await res.text();
    expect(body).toContain("__hvacWidgetLoaded");
  });
});
