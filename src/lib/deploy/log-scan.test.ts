import { describe, expect, it } from "vitest";
import { summarizeLogLines } from "./log-scan";

const UUID = "3f2b8c1e-9a4d-4e7b-8c55-1a2b3c4d5e6f";
const TOKEN = "Zk3p9QwErTyUiOpAsDfGhJkLzXcVbNm12345";
const json = (o: object) => JSON.stringify(o);

describe("summarizeLogLines", () => {
  it("counts 5xx by route", () => {
    const s = summarizeLogLines([
      json({ path: "/api/chat", statusCode: 500 }),
      json({ path: "/api/chat", statusCode: 502 }),
      "GET /admin/requests 503",
      json({ path: "/api/chat", statusCode: 200 }),
    ]);
    expect(s.total).toBe(4);
    expect(s.status5xx).toBe(3);
    expect(s.byRoute).toEqual({ "/api/chat": 2, "/admin/requests": 1 });
  });

  it("ignores 4xx and 2xx for the 5xx tally", () => {
    const s = summarizeLogLines([json({ path: "/x", statusCode: 404 }), json({ path: "/x", statusCode: 401 }), "GET /y 200"]);
    expect(s).toEqual({ total: 3, status5xx: 0, byRoute: {} });
  });

  it("prints no line content", () => {
    const secret = "customer-email-jane@example.com";
    const s = summarizeLogLines([json({ path: "/api/chat", statusCode: 500, message: secret }), `${secret} 500`]);
    expect(JSON.stringify(s)).not.toContain(secret);
    expect(JSON.stringify(s)).not.toContain("jane");
  });

  it("keys are route patterns: no uuid or token-like segment", () => {
    const s = summarizeLogLines([
      json({ path: `/admin/invite/${TOKEN}`, statusCode: 500 }),
      json({ path: `/portal/${TOKEN}?x=1`, statusCode: 500 }),
      json({ path: `/api/admin/customers/${UUID}/erase`, statusCode: 500 }),
      json({ path: `/api/admin/requests/12345`, statusCode: 500 }),
      json({ path: `/some/${TOKEN}/thing`, statusCode: 500 }),
    ]);
    expect(Object.keys(s.byRoute)).toEqual(
      expect.arrayContaining(["/admin/invite/[token]", "/portal/[token]", "/api/admin/customers/[id]/erase", "/api/admin/requests/[id]", "/some/[token]/thing"]),
    );
    for (const key of Object.keys(s.byRoute)) {
      expect(key).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i);
      expect(key.split("/").every((seg) => seg.startsWith("[") || !/^[A-Za-z0-9_-]{17,}$/.test(seg))).toBe(true);
    }
  });

  it("handles empty input, blank lines and garbage", () => {
    expect(summarizeLogLines([])).toEqual({ total: 0, status5xx: 0, byRoute: {} });
    expect(summarizeLogLines(["", "   ", "not a log"]).status5xx).toBe(0);
  });

  it("buckets an unparseable 5xx path as (unknown)", () => {
    const s = summarizeLogLines([json({ statusCode: 500 })]);
    expect(s.byRoute).toEqual({ "(unknown)": 1 });
  });
});
