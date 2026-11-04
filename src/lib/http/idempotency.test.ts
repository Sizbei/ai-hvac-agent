import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

const { execute } = vi.hoisted(() => ({ execute: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: { execute } }));

import {
  M3B_NAMESPACE,
  parseIdempotencyKey,
  canonicalHash,
  multipartHash,
  derivedIdInput,
  derivedId,
  materialLineId,
  officeId,
  decideReplay,
  isStorable,
  withIdempotency,
  toResponse,
  claimSql,
  doneSql,
  deleteSql,
  selectSql,
  takeoverSql,
  type Envelope,
  type KeyRow,
  type KeyScope,
  type RunResult,
} from "./idempotency";
import { STORED_CODES, CLIENT_SPENT_CODES, mintKey } from "./idempotency-codes";

const ORG = "00000000-0000-0000-0000-000000000001";
const USER = "00000000-0000-0000-0000-000000000002";
const ROUTE = "/api/tech/jobs/00000000-0000-0000-0000-000000000003/invoice";
const SCOPE: KeyScope = { organizationId: ORG, userId: USER, route: ROUTE, key: "k1" };
const ATTEMPT = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const HASH = canonicalHash({ a: 1 });
const OTHER_HASH = canonicalHash({ a: 2 });
const NOW = new Date("2026-11-04T12:00:00.000Z");

const render = (q: SQL) => new PgDialect().sqlToQuery(q);
const flat = (q: SQL) => render(q).sql.replace(/\s+/g, " ");
const verb = (q: SQL) => flat(q).trim().split(" ")[0];

const ok201: Envelope = { success: true, data: { invoiceId: "inv-1", created: true } };
const stale409: Envelope = { success: false, error: { message: "Stale", code: "STALE" } };
const locked409: Envelope = { success: false, error: { message: "Locked", code: "INVOICE_LOCKED" } };
const sendFailed500: Envelope = { success: false, error: { message: "The link may not have gone out. Try again in 2 minutes.", code: "SEND_FAILED" } };

function row(over: Partial<KeyRow> = {}): KeyRow {
  return {
    state: "done",
    requestHash: HASH,
    responseStatus: 201,
    responseBody: ok201,
    createdAt: new Date(NOW.getTime() - 10_000),
    attemptId: ATTEMPT,
    ...over,
  };
}

/** A db row as neon-http returns it (snake_case, timestamp as string). */
function dbRow(r: KeyRow) {
  return {
    state: r.state,
    request_hash: r.requestHash,
    response_status: r.responseStatus,
    response_body: r.responseBody,
    created_at: r.createdAt.toISOString(),
    attempt_id: r.attemptId,
  };
}

const verbs = () => execute.mock.calls.map((c) => verb(c[0] as SQL));

beforeEach(() => {
  execute.mockReset();
});

describe("parseIdempotencyKey", () => {
  it("accepts 1-64 chars of [A-Za-z0-9_-]", () => {
    expect(parseIdempotencyKey("a")).toBe("a");
    expect(parseIdempotencyKey("Ab_9-z")).toBe("Ab_9-z");
    expect(parseIdempotencyKey("x".repeat(64))).toBe("x".repeat(64));
    expect(parseIdempotencyKey("6f1c6b3e-2a7d-4f0e-9c1d-3b8e5a2f7d41")).toBe("6f1c6b3e-2a7d-4f0e-9c1d-3b8e5a2f7d41");
  });
  it("rejects null, empty, too long, and other characters", () => {
    expect(parseIdempotencyKey(null)).toBeNull();
    expect(parseIdempotencyKey("")).toBeNull();
    expect(parseIdempotencyKey("x".repeat(65))).toBeNull();
    expect(parseIdempotencyKey("a b")).toBeNull();
    expect(parseIdempotencyKey("a.b")).toBeNull();
    expect(parseIdempotencyKey("a\n")).toBeNull();
    expect(parseIdempotencyKey("ключ")).toBeNull();
  });
});

describe("canonicalHash", () => {
  it("is sha256 hex", () => {
    expect(canonicalHash({})).toMatch(/^[0-9a-f]{64}$/);
  });
  it("ignores key order, recursively", () => {
    expect(canonicalHash({ a: 1, b: { c: 2, d: 3 } })).toBe(canonicalHash({ b: { d: 3, c: 2 }, a: 1 }));
  });
  it("drops undefined values", () => {
    expect(canonicalHash({ a: 1, b: undefined })).toBe(canonicalHash({ a: 1 }));
  });
  it("distinguishes nested values and array order", () => {
    expect(canonicalHash({ a: { b: 1 } })).not.toBe(canonicalHash({ a: { b: 2 } }));
    expect(canonicalHash({ a: [1, 2] })).not.toBe(canonicalHash({ a: [2, 1] }));
  });
  it("hashes null, {} and absent bodies as {}", () => {
    const empty = canonicalHash({});
    expect(canonicalHash(undefined)).toBe(empty);
    expect(canonicalHash(null)).toBe(empty);
    expect(empty).toBe("44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a");
  });
});

describe("multipartHash", () => {
  const p = { route: ROUTE, requestId: "r1", fileSha256: "f".repeat(64), name: "Pat" };
  it("is stable and sensitive to every field", () => {
    expect(multipartHash(p)).toBe(multipartHash({ ...p }));
    for (const k of ["route", "requestId", "fileSha256", "name"] as const) {
      expect(multipartHash({ ...p, [k]: "other" })).not.toBe(multipartHash(p));
    }
  });
});

describe("derived ids", () => {
  it("pins the pre-hash input format", () => {
    expect(derivedIdInput(SCOPE, "invoice")).toBe(
      "00000000-0000-0000-0000-000000000001|00000000-0000-0000-0000-000000000002|/api/tech/jobs/00000000-0000-0000-0000-000000000003/invoice|k1|invoice",
    );
  });
  it("matches golden vectors", () => {
    expect(M3B_NAMESPACE).toBe("6f1c6b3e-2a7d-4f0e-9c1d-3b8e5a2f7d41");
    expect(derivedId(SCOPE, "invoice")).toBe("54b9f8d0-19d7-5eb6-87e6-bac94cf9af63");
    expect(derivedId(SCOPE, "payment")).toBe("890791d3-84ca-5a5f-8b8a-a51c5790af49");
  });
  it("differs per n, route, user and key", () => {
    const base = derivedId(SCOPE, "invoice");
    expect(derivedId(SCOPE, "line")).not.toBe(base);
    expect(derivedId({ ...SCOPE, route: ROUTE + "/lines" }, "invoice")).not.toBe(base);
    expect(derivedId({ ...SCOPE, userId: "00000000-0000-0000-0000-000000000009" }, "invoice")).not.toBe(base);
    expect(derivedId({ ...SCOPE, key: "k2" }, "invoice")).not.toBe(base);
  });
  it("materialLineId and officeId match golden vectors", () => {
    expect(materialLineId("00000000-0000-0000-0000-000000000004", "00000000-0000-0000-0000-000000000005")).toBe(
      "8dfaee1b-6537-537f-864c-a64eab44b8a4",
    );
    expect(officeId("payment", ORG, "tok-1")).toBe("351555b1-4060-5cd0-bb18-86f5d1150f22");
    expect(officeId("refund", ORG, "tok-1")).toBe("0c546dae-44b7-59e6-8cd1-fea5de9f6c36");
  });
});

describe("decideReplay", () => {
  it("null row -> reclaim", () => {
    expect(decideReplay(null, HASH, NOW)).toEqual({ kind: "reclaim" });
  });
  it("done + same hash -> replay with the stored envelope passed through", () => {
    const r = row();
    const d = decideReplay(r, HASH, NOW);
    expect(d).toEqual({ kind: "replay", status: 201, envelope: ok201 });
    if (d.kind === "replay") expect(d.envelope).toBe(r.responseBody);
  });
  it("done + different hash -> reused with storedStatus", () => {
    expect(decideReplay(row({ responseStatus: 409, responseBody: locked409 }), OTHER_HASH, NOW)).toEqual({
      kind: "reused",
      storedStatus: 409,
    });
  });
  it("in_progress + different hash -> reused regardless of age", () => {
    const old = new Date(NOW.getTime() - 10 * 60_000);
    expect(decideReplay(row({ state: "in_progress", responseStatus: null, responseBody: null }), OTHER_HASH, NOW)).toEqual({
      kind: "reused",
      storedStatus: null,
    });
    expect(
      decideReplay(row({ state: "in_progress", responseStatus: null, responseBody: null, createdAt: old }), OTHER_HASH, NOW),
    ).toEqual({ kind: "reused", storedStatus: null });
  });
  it("in_progress + same hash, younger than 2 min -> in_progress", () => {
    const young = new Date(NOW.getTime() - (2 * 60_000 - 1));
    expect(decideReplay(row({ state: "in_progress", createdAt: young }), HASH, NOW)).toEqual({ kind: "in_progress" });
  });
  it("in_progress + same hash, 2 min or older -> takeover", () => {
    const edge = new Date(NOW.getTime() - 2 * 60_000);
    expect(decideReplay(row({ state: "in_progress", createdAt: edge }), HASH, NOW)).toEqual({ kind: "takeover" });
  });
});

describe("isStorable", () => {
  it("stores 2xx and deterministic codes only", () => {
    expect(isStorable(200, { success: true, data: {} })).toBe(true);
    expect(isStorable(201, ok201)).toBe(true);
    expect(isStorable(409, locked409)).toBe(true);
    expect(isStorable(409, stale409)).toBe(false);
    expect(isStorable(422, { success: false, error: { message: "x", code: "EXCEEDS_BALANCE" } })).toBe(false);
    expect(isStorable(500, { success: false, error: { message: "x", code: "INTERNAL_ERROR" } })).toBe(false);
    expect(isStorable(500, sendFailed500)).toBe(true);
  });
});

describe("SQL builders", () => {
  it("claim: ON CONFLICT DO NOTHING RETURNING, 7 params", () => {
    const q = claimSql(SCOPE, HASH, ATTEMPT);
    expect(flat(q)).toContain("INSERT INTO idempotency_keys");
    expect(flat(q)).toContain("ON CONFLICT DO NOTHING RETURNING");
    expect(render(q).params).toHaveLength(7);
    expect(render(q).params).toEqual(expect.arrayContaining([ORG, USER, ROUTE, "k1", HASH, ATTEMPT, "in_progress"]));
  });
  it("select: by pk, 4 params", () => {
    const q = selectSql(SCOPE);
    expect(flat(q)).toMatch(/^SELECT /);
    for (const col of ["state", "request_hash", "response_status", "response_body", "created_at", "attempt_id"]) {
      expect(flat(q)).toContain(col);
    }
    expect(flat(q)).toContain("organization_id =");
    expect(render(q).params).toEqual([ORG, USER, ROUTE, "k1"]);
  });
  it("done: attempt-gated and in_progress-gated, stores status and jsonb, 7 params", () => {
    const q = doneSql(SCOPE, ATTEMPT, 201, ok201);
    const f = flat(q);
    expect(f).toMatch(/^UPDATE idempotency_keys SET state = 'done'/);
    expect(f).toContain("attempt_id = $");
    expect(f).toContain("state = 'in_progress'");
    expect(f).toContain("::jsonb");
    const { params } = render(q);
    expect(params).toHaveLength(7);
    expect(params).toContain(JSON.stringify(ok201));
    expect(params).toContain(201);
  });
  it("delete: attempt-gated, 5 params", () => {
    const q = deleteSql(SCOPE, ATTEMPT);
    expect(flat(q)).toMatch(/^DELETE FROM idempotency_keys/);
    expect(flat(q)).toContain("attempt_id = $");
    expect(render(q).params).toEqual([ORG, USER, ROUTE, "k1", ATTEMPT]);
  });
  it("takeover: 2-minute gate, sets attempt_id, RETURNING, 5 params", () => {
    const q = takeoverSql(SCOPE, ATTEMPT);
    const f = flat(q);
    expect(f).toMatch(/^UPDATE idempotency_keys SET created_at = now\(\), attempt_id = \$1::uuid/);
    expect(f).toContain("state = 'in_progress'");
    expect(f).toContain("created_at < now() - interval '2 minutes'");
    expect(f).toContain("RETURNING");
    expect(render(q).params).toHaveLength(5);
  });
});

describe("withIdempotency", () => {
  const claimWon = { rows: [{ key: "k1" }] };
  const claimLost = { rows: [] };
  const affected = { rows: [{ key: "k1" }] };

  it("winner stores a 201 envelope and returns its own result", async () => {
    execute.mockResolvedValueOnce(claimWon).mockResolvedValueOnce(affected);
    const run = vi.fn(async () => ({ status: 201, envelope: ok201 }));
    const r = await withIdempotency(SCOPE, HASH, run);
    expect(r).toEqual({ status: 201, envelope: ok201, replayed: false });
    expect(verbs()).toEqual(["INSERT", "UPDATE"]);
    const done = render(execute.mock.calls[1][0] as SQL);
    expect(done.sql).toContain("state = 'done'");
    expect(done.params).toContain(JSON.stringify(ok201));
    // the attempt that claimed is the attempt that completes
    const claimParams = render(execute.mock.calls[0][0] as SQL).params;
    const attempt = claimParams.find((p) => typeof p === "string" && p !== ORG && p !== USER && /^[0-9a-f-]{36}$/.test(p));
    expect(done.params).toContain(attempt);
  });

  it("winner returns its own result even when done matched 0 rows", async () => {
    execute.mockResolvedValueOnce(claimWon).mockResolvedValueOnce({ rows: [] });
    const r = await withIdempotency(SCOPE, HASH, async () => ({ status: 201, envelope: ok201 }));
    expect(r).toEqual({ status: 201, envelope: ok201, replayed: false });
  });

  it("winner deletes its claim on 409 STALE", async () => {
    execute.mockResolvedValueOnce(claimWon).mockResolvedValueOnce(affected);
    const r = await withIdempotency(SCOPE, HASH, async () => ({ status: 409, envelope: stale409 }));
    expect(r).toEqual({ status: 409, envelope: stale409, replayed: false });
    expect(verbs()).toEqual(["INSERT", "DELETE"]);
  });

  it("winner deletes its claim on throw and rethrows", async () => {
    execute.mockResolvedValueOnce(claimWon).mockResolvedValueOnce(affected);
    const boom = new Error("boom");
    await expect(
      withIdempotency(SCOPE, HASH, async () => {
        throw boom;
      }),
    ).rejects.toBe(boom);
    expect(verbs()).toEqual(["INSERT", "DELETE"]);
  });

  it("stores a 500 SEND_FAILED envelope", async () => {
    execute.mockResolvedValueOnce(claimWon).mockResolvedValueOnce(affected);
    const r = await withIdempotency(SCOPE, HASH, async () => ({ status: 500, envelope: sendFailed500 }));
    expect(r.status).toBe(500);
    expect(verbs()).toEqual(["INSERT", "UPDATE"]);
    expect(render(execute.mock.calls[1][0] as SQL).params).toContain(500);
  });

  it("passes derived ids to run", async () => {
    execute.mockResolvedValueOnce(claimWon).mockResolvedValueOnce(affected);
    let seen = "";
    await withIdempotency(SCOPE, HASH, async ({ id }) => {
      seen = id("invoice");
      return { status: 201, envelope: ok201 };
    });
    expect(seen).toBe("54b9f8d0-19d7-5eb6-87e6-bac94cf9af63");
  });

  it("loser replays the stored result with replayed: true and does not run", async () => {
    execute.mockResolvedValueOnce(claimLost).mockResolvedValueOnce({ rows: [dbRow(row())] });
    const run = vi.fn();
    const r = await withIdempotency(SCOPE, HASH, run);
    expect(run).not.toHaveBeenCalled();
    expect(r).toEqual({ status: 201, envelope: ok201, replayed: true });
    expect(verbs()).toEqual(["INSERT", "SELECT"]);
  });

  it("loser with a different hash gets 422 IDEMPOTENCY_KEY_REUSED with storedStatus", async () => {
    execute.mockResolvedValueOnce(claimLost).mockResolvedValueOnce({ rows: [dbRow(row())] });
    const r = await withIdempotency(SCOPE, OTHER_HASH, vi.fn());
    expect(r).toEqual({
      status: 422,
      replayed: false,
      envelope: {
        success: false,
        error: {
          message: "That key was already used for a different request.",
          code: "IDEMPOTENCY_KEY_REUSED",
          details: { storedStatus: 201 },
        },
      },
    });
  });

  it("loser while the winner is fresh gets 409 IN_PROGRESS with Retry-After 2", async () => {
    const fresh = row({ state: "in_progress", responseStatus: null, responseBody: null, createdAt: new Date() });
    execute.mockResolvedValueOnce(claimLost).mockResolvedValueOnce({ rows: [dbRow(fresh)] });
    const r = await withIdempotency(SCOPE, HASH, vi.fn());
    expect(r).toEqual({
      status: 409,
      retryAfter: 2,
      replayed: false,
      envelope: {
        success: false,
        error: { message: "Still saving your last tap. Try again in a moment.", code: "IN_PROGRESS" },
      },
    });
  });

  it("takeover re-runs with identical ids and stores under the new attempt", async () => {
    const stale = row({ state: "in_progress", responseStatus: null, responseBody: null, createdAt: new Date(Date.now() - 5 * 60_000) });
    execute
      .mockResolvedValueOnce(claimLost)
      .mockResolvedValueOnce({ rows: [dbRow(stale)] })
      .mockResolvedValueOnce({ rows: [{ key: "k1" }] })
      .mockResolvedValueOnce(affected);
    let seen = "";
    const r = await withIdempotency(SCOPE, HASH, async ({ id }) => {
      seen = id("payment");
      return { status: 201, envelope: ok201 };
    });
    expect(seen).toBe(derivedId(SCOPE, "payment"));
    expect(seen).toBe("890791d3-84ca-5a5f-8b8a-a51c5790af49");
    expect(r).toEqual({ status: 201, envelope: ok201, replayed: false });
    expect(verbs()).toEqual(["INSERT", "SELECT", "UPDATE", "UPDATE"]);
    const takeoverAttempt = render(execute.mock.calls[2][0] as SQL).params[0];
    expect(render(execute.mock.calls[3][0] as SQL).params).toContain(takeoverAttempt);
  });

  it("takeover that loses re-selects once and replays a now-done row", async () => {
    const stale = row({ state: "in_progress", responseStatus: null, responseBody: null, createdAt: new Date(Date.now() - 5 * 60_000) });
    execute
      .mockResolvedValueOnce(claimLost)
      .mockResolvedValueOnce({ rows: [dbRow(stale)] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [dbRow(row())] });
    const run = vi.fn();
    const r = await withIdempotency(SCOPE, HASH, run);
    expect(run).not.toHaveBeenCalled();
    expect(r).toEqual({ status: 201, envelope: ok201, replayed: true });
    expect(verbs()).toEqual(["INSERT", "SELECT", "UPDATE", "SELECT"]);
  });

  it("takeover that loses and still sees in_progress returns 409", async () => {
    const stale = row({ state: "in_progress", responseStatus: null, responseBody: null, createdAt: new Date(Date.now() - 5 * 60_000) });
    const fresh = row({ state: "in_progress", responseStatus: null, responseBody: null, createdAt: new Date() });
    execute
      .mockResolvedValueOnce(claimLost)
      .mockResolvedValueOnce({ rows: [dbRow(stale)] })
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce({ rows: [dbRow(fresh)] });
    const r = await withIdempotency(SCOPE, HASH, vi.fn());
    expect(r.status).toBe(409);
    expect(r.retryAfter).toBe(2);
    expect(verbs()).toHaveLength(4);
  });

  it("reclaims when the row vanished and runs as winner", async () => {
    execute
      .mockResolvedValueOnce(claimLost)
      .mockResolvedValueOnce({ rows: [] })
      .mockResolvedValueOnce(claimWon)
      .mockResolvedValueOnce(affected);
    const run = vi.fn(async () => ({ status: 201, envelope: ok201 }));
    const r = await withIdempotency(SCOPE, HASH, run);
    expect(run).toHaveBeenCalledTimes(1);
    expect(r).toEqual({ status: 201, envelope: ok201, replayed: false });
    expect(verbs()).toEqual(["INSERT", "SELECT", "INSERT", "UPDATE"]);
  });

  it("a failed reclaim returns 409 IN_PROGRESS", async () => {
    execute.mockResolvedValueOnce(claimLost).mockResolvedValueOnce({ rows: [] }).mockResolvedValueOnce(claimLost);
    const run = vi.fn();
    const r = await withIdempotency(SCOPE, HASH, run);
    expect(run).not.toHaveBeenCalled();
    expect(r.status).toBe(409);
    expect(r.envelope).toMatchObject({ success: false, error: { code: "IN_PROGRESS" } });
  });
});

describe("toResponse", () => {
  it("sets Retry-After when present", () => {
    const res = toResponse({
      status: 409,
      retryAfter: 2,
      envelope: { success: false, error: { message: "m", code: "IN_PROGRESS" } },
    });
    expect(res.status).toBe(409);
    expect(res.headers.get("Retry-After")).toBe("2");
  });
  it("omits Retry-After otherwise", () => {
    expect(toResponse({ status: 201, envelope: ok201 }).headers.get("Retry-After")).toBeNull();
  });
  it("adds data.replayed on a NEW object and keeps a stored 201 as 201", async () => {
    const stored: Envelope = { success: true, data: { invoiceId: "inv-1", nested: { a: 1 } } };
    const snapshot = structuredClone(stored);
    const res = toResponse({ status: 201, envelope: stored, replayed: true });
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ success: true, data: { invoiceId: "inv-1", nested: { a: 1 }, replayed: true } });
    expect(stored).toEqual(snapshot);
  });
  it("does not add replayed on a first run", async () => {
    const res = toResponse({ status: 201, envelope: ok201, replayed: false });
    expect(await res.json()).toEqual(ok201);
  });
  it("a replayed stored 4xx reproduces status and error.code", async () => {
    const res = toResponse({ status: 409, envelope: locked409, replayed: true } satisfies RunResult & { replayed: boolean });
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual(locked409);
  });
});

describe("idempotency-codes", () => {
  it("STORED_CODES is exactly the deterministic set, shared with the client", () => {
    expect([...STORED_CODES].sort()).toEqual(
      ["ALREADY_BILLED", "INVALID_INPUT", "INVOICE_LOCKED", "INVOICE_VOIDED", "ITEM_NOT_FOUND", "NO_LINES", "SEND_FAILED", "VALIDATION_ERROR"],
    );
    expect(CLIENT_SPENT_CODES).toBe(STORED_CODES);
  });
  it("has no import statements (client-safe)", () => {
    const src = readFileSync(join(__dirname, "idempotency-codes.ts"), "utf8");
    expect(src.split("\n").some((l) => l.startsWith("import "))).toBe(false);
  });

  describe("mintKey", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });
    it("uses crypto.randomUUID when available", () => {
      vi.stubGlobal("crypto", { randomUUID: () => "11111111-2222-4333-8444-555555555555", getRandomValues: vi.fn() });
      expect(mintKey()).toBe("11111111-2222-4333-8444-555555555555");
    });
    it("builds a v4 from getRandomValues when randomUUID is undefined", () => {
      vi.stubGlobal("crypto", {
        getRandomValues: <T extends ArrayBufferView>(a: T): T => {
          (a as unknown as Uint8Array).fill(0xff);
          return a;
        },
      });
      const k = mintKey();
      expect(k).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
      expect(k).toBe("ffffffff-ffff-4fff-bfff-ffffffffffff");
      expect(parseIdempotencyKey(k)).toBe(k);
    });
  });
});
