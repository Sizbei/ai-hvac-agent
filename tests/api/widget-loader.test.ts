import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { GET } from "@/app/widget.js/route";

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

  it("bakes in the request origin so iframe/config calls are same-origin", async () => {
    const res = GET(req());
    const body = await res.text();
    expect(body).toContain('"https://app.example.com"');
  });

  it("guards against double-loading", async () => {
    const res = GET(req());
    const body = await res.text();
    expect(body).toContain("__hvacWidgetLoaded");
  });
});
