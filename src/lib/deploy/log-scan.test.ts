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
      expect.arrayContaining(["/admin/invite/[token]", "/portal/[token]", "/api/admin/customers/[id]/erase", "/api/admin/requests/[id]", "/some/[x]/thing"]),
    );
    for (const key of Object.keys(s.byRoute)) {
      expect(key).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/i);
      expect(key.split("/").every((seg) => seg.startsWith("[") || !/^[A-Za-z0-9_-]{17,}$/.test(seg))).toBe(true);
    }
  });

  it("hides non-allowlisted segments", () => {
    const s = summarizeLogLines([json({ path: "/u/jane.smith@example.com", statusCode: 500 })]);
    expect(s.byRoute).toEqual({ "/u/[x]": 1 });
  });

  it("text fallback with arbitrary path-like text only yields allowlisted keys", () => {
    const s = summarizeLogLines([
      "500 /Jane_Smith/555-123-4567/a%40b.com/ok-route",
      "boom 502 /secret-1234567/x",
      "see /Users/jane/file.txt 503",
    ]);
    for (const key of Object.keys(s.byRoute)) {
      expect(key.split("/").every((seg) => seg === "" || /^\[(x|id|token)\]$/.test(seg) || (/^[a-z][a-z0-9-]{0,30}$/.test(seg) && !/\d{4,}/.test(seg)))).toBe(true);
      expect(key).not.toMatch(/1234|secret|@|Jane/);
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

  it("text fallback: a 5xx counts only right after a path or as status=", () => {
    const s = summarizeLogLines([
      "GET /admin/requests 503",
      "/api/chat 500 12ms",
      "status=502 /api/cron/sweep",
      "statusCode: 504",
    ]);
    expect(s.status5xx).toBe(4);
    expect(s.byRoute).toEqual({ "/admin/requests": 1, "/api/chat": 1, "/api/cron/sweep": 1, "(unknown)": 1 });
  });

  it("text fallback: durations, sizes and counts in the 500s are not 5xx", () => {
    const s = summarizeLogLines([
      "GET /admin/requests 200 took 512 ms",
      "Compiled /admin in 503 ms",
      "fetched 550 rows",
      "500 /Jane_Smith/ok-route",
      "boom 502 /secret-1234567/x",
    ]);
    expect(s.status5xx).toBe(0);
    expect(s.byRoute).toEqual({});
  });
});
