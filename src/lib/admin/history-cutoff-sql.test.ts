import { describe, it, expect } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import { historyCutoffPatchSql } from "./history-cutoff-sql";

const ORG = "11111111-1111-1111-1111-111111111111";

const render = (iso: string) => {
  const { sql: text, params } = new PgDialect().sqlToQuery(historyCutoffPatchSql(ORG, iso));
  return { flat: text.replace(/\s+/g, " "), params };
};

describe("historyCutoffPatchSql", () => {
  it("merges historyCutoff into feature_flags for one org, binding both values", () => {
    const { flat, params } = render("2026-11-10T17:30:00.000Z");
    expect(flat).toMatch(/^UPDATE organizations SET feature_flags = feature_flags \|\| jsonb_build_object\('historyCutoff', \$\d+::text\) WHERE id = \$\d+::uuid/);
    expect(params).toEqual(["2026-11-10T17:30:00.000Z", ORG]);
  });

  it("normalises the timestamp to UTC ISO", () => {
    expect(render("2026-11-10T12:30:00-05:00").params[0]).toBe("2026-11-10T17:30:00.000Z");
  });

  it("returns the stored cutoff", () => {
    expect(render("2026-11-10T17:30:00.000Z").flat).toMatch(/RETURNING feature_flags->>'historyCutoff' AS history_cutoff$/);
  });

  it("refuses a non-uuid org and an unparseable timestamp", () => {
    expect(() => historyCutoffPatchSql("org-1", "2026-11-10T17:30:00.000Z")).toThrow(/uuid/);
    expect(() => historyCutoffPatchSql(ORG, "yesterday")).toThrow(/timestamp/);
    expect(() => historyCutoffPatchSql(ORG, "")).toThrow(/timestamp/);
  });
});
