import { describe, it, expect } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { customerSessions } from "@/lib/db/schema";
import {
  ADMIN_SESSION_TOKEN_PREFIX,
  STAND_IN_SESSION_TOKEN_PREFIXES,
  isStandInSessionToken,
  notStandInSession,
} from "./stand-in-session";

describe("isStandInSessionToken", () => {
  it("matches every writer's synthetic token prefix", () => {
    expect(isStandInSessionToken(`${ADMIN_SESSION_TOKEN_PREFIX}6f1c`)).toBe(true);
    expect(isStandInSessionToken("mvisit-6f1c")).toBe(true);
    expect(isStandInSessionToken("fp-import-12345")).toBe(true);
  });
  it("leaves real chat / phone / sms session tokens alone", () => {
    expect(isStandInSessionToken("b3c1e0f2a9d84c7e")).toBe(false);
    expect(isStandInSessionToken("CA123:9f8e")).toBe(false);
    expect(isStandInSessionToken("administrator")).toBe(false);
    expect(isStandInSessionToken("")).toBe(false);
  });
  it("lists exactly the three known prefixes", () => {
    expect(STAND_IN_SESSION_TOKEN_PREFIXES).toEqual(["admin-", "mvisit-", "fp-import-"]);
  });
});

describe("notStandInSession", () => {
  it("renders NOT (token LIKE … OR …) over every prefix", () => {
    const { sql, params } = new PgDialect().sqlToQuery(notStandInSession(customerSessions.token));
    expect(sql).toMatch(/^not \(/i);
    expect(sql.match(/"token" like/gi)?.length).toBe(3);
    expect(params).toEqual(["admin-%", "mvisit-%", "fp-import-%"]);
  });
});
