import { describe, it, expect } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { customerSessions } from "@/lib/db/schema";
import {
  SESSION_CONTACT_KEYS,
  sessionContactMatches,
  sessionPhoneDigitsMatch,
} from "./session-contact-search";

const render = (fragment: Parameters<PgDialect["sqlToQuery"]>[0]) =>
  new PgDialect().sqlToQuery(fragment);

describe("sessionContactMatches", () => {
  it("matches only the contact keys, never the raw metadata text", () => {
    const { sql, params } = render(sessionContactMatches(customerSessions.metadata, "%rob%"));
    // One guarded ->> per contact key, each ILIKE the pattern.
    expect(sql.match(/is json object/gi)?.length).toBe(SESSION_CONTACT_KEYS.length);
    expect(sql.match(/::jsonb ->> \$\d+::text/g)?.length).toBe(SESSION_CONTACT_KEYS.length);
    expect(sql.match(/ilike/gi)?.length).toBe(SESSION_CONTACT_KEYS.length);
    expect(params).toEqual(SESSION_CONTACT_KEYS.flatMap((key) => [key, "%rob%"]));
    // No whole-blob match (the old coalesce(metadata, '') ILIKE …).
    expect(sql).not.toMatch(/coalesce\("customer_sessions"\."metadata"/i);
  });

  it("covers name, phone, email and address and nothing internal", () => {
    expect(SESSION_CONTACT_KEYS).toEqual([
      "customerName",
      "customerPhone",
      "customerEmail",
      "address",
    ]);
  });
});

describe("sessionPhoneDigitsMatch", () => {
  const { sql, params } = render(
    sessionPhoneDigitsMatch(customerSessions.metadata, customerSessions.token, "5125550177"),
  );

  it("reads digits from the customerPhone key only", () => {
    expect(params).toContain("customerPhone");
    expect(params).not.toContain("address");
    expect(sql).toMatch(/regexp_replace\(coalesce\(\(CASE WHEN "customer_sessions"\."metadata" IS JSON OBJECT/);
  });

  it("matches the token only for SMS threads, and only its phone part", () => {
    expect(sql).toMatch(/"customer_sessions"\."token" LIKE 'sms:%' AND regexp_replace\(split_part\("customer_sessions"\."token", ':', 2\)/);
    // The token never feeds a digits match on its own (web tokens, CallSids).
    expect(sql.match(/"customer_sessions"\."token"/g)?.length).toBe(2);
  });

  it("wraps the digits in a substring pattern", () => {
    expect(params.filter((p) => p === "%5125550177%")).toHaveLength(2);
  });
});
