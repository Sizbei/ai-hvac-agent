import { describe, it, expect } from "vitest";
import pino from "pino";
import { Writable } from "node:stream";
import { DrizzleQueryError as RealDrizzleQueryError } from "drizzle-orm/errors";
import { errorCode, serializeError } from "./logger";

/** Same shape as drizzle-orm 0.45's DrizzleQueryError: enumerable query/params, SQL in the message. */
class DrizzleQueryError extends Error {
  constructor(public query: string, public params: unknown[], public cause?: unknown) {
    super(`Failed query: ${query}\nparams: ${params.join(",")}`);
  }
}

describe("serializeError", () => {
  it("drops params, query and the SQL-bearing message, keeps type and the cause code", () => {
    const e = new DrizzleQueryError("UPDATE service_requests SET signature_name = $1", ["Jane"], { code: "40P01" });
    const out = serializeError(e);
    expect(out).toEqual({ type: "DrizzleQueryError", code: "40P01" });
    expect(JSON.stringify(out)).not.toContain("Jane");
  });

  it("the real drizzle-orm DrizzleQueryError serialises without its params", () => {
    const e = new RealDrizzleQueryError("UPDATE x SET name = $1", ["Jane"], Object.assign(new Error("deadlock"), { code: "40P01" }));
    const out = serializeError(e);
    expect(out).toEqual({ type: "DrizzleQueryError", code: "40P01" });
    expect(JSON.stringify(out)).not.toContain("Jane");
  });

  it("drops the message of any error-shaped object carrying params or query", () => {
    const out = serializeError({ query: "select $1", params: ["Jane"], cause: { code: "40P01" }, message: "params: Jane" });
    expect(out).toEqual({ type: "Object", code: "40P01" });
    expect(JSON.stringify(out)).not.toContain("Jane");
  });

  it("keeps the message of a plain error, and its own code", () => {
    expect(serializeError(Object.assign(new Error("portal_token_unavailable"), { code: "E1" })))
      .toEqual({ type: "Error", code: "E1", message: "portal_token_unavailable" });
    expect(serializeError(new TypeError("boom"))).toEqual({ type: "TypeError", message: "boom" });
  });

  it("non-objects serialise to their type only", () => {
    expect(serializeError("Jane")).toEqual({ type: "string" });
    expect(serializeError(null)).toEqual({ type: "object" });
  });

  it("pino applies it to both the error and err keys", () => {
    const lines: string[] = [];
    const sink = new Writable({ write(chunk, _enc, cb) { lines.push(String(chunk)); cb(); } });
    const log = pino({ serializers: { error: serializeError, err: serializeError } }, sink);
    const e = new DrizzleQueryError("insert", ["Jane", { payLink: "https://x/portal/SECRET" }], { code: "23505" });
    log.error({ error: e, invoiceId: "inv-1" }, "a");
    log.error({ err: e }, "b");
    expect(lines.join("")).not.toContain("Jane");
    expect(lines.join("")).not.toContain("SECRET");
    expect(JSON.parse(lines[0]!).error).toEqual({ type: "DrizzleQueryError", code: "23505" });
    expect(JSON.parse(lines[1]!).err).toEqual({ type: "DrizzleQueryError", code: "23505" });
  });
});

describe("errorCode", () => {
  it("reads the error's code, else its cause's, else undefined", () => {
    expect(errorCode({ code: "40P01" })).toBe("40P01");
    expect(errorCode({ cause: { code: "23505" } })).toBe("23505");
    expect(errorCode(new Error("x"))).toBeUndefined();
    expect(errorCode("x")).toBeUndefined();
  });
});
