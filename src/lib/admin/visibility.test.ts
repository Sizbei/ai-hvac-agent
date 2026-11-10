import { describe, expect, it } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { customers, serviceRequests } from "@/lib/db/schema";
import {
  SHOW_ALL,
  VISIBLE_ONLY,
  computeShowHidden,
  visibleRows,
  visibleRowsSql,
} from "./visibility";

const dialect = new PgDialect();
const query = (s: SQL) => dialect.sqlToQuery(s);
const render = (s: SQL) => query(s).sql;

describe("visibleRows", () => {
  it("filters hidden rows for an org viewer", () => {
    const s = visibleRows(customers, VISIBLE_ONLY);
    expect(render(s)).toBe('"customers"."hidden_from_org" = $1');
    expect(query(s).params).toEqual([false]);
  });

  it("is a no-op predicate when hidden rows are shown", () => {
    const s = visibleRows(customers, SHOW_ALL);
    expect(render(s)).toBe("true");
    expect(query(s).params).toEqual([]);
  });

  it("uses the table's own column", () => {
    expect(render(visibleRows(serviceRequests, VISIBLE_ONLY))).toBe(
      '"service_requests"."hidden_from_org" = $1',
    );
  });
});

describe("visibleRowsSql", () => {
  it("filters by alias for an org viewer", () => {
    expect(render(visibleRowsSql("sr", VISIBLE_ONLY))).toBe("sr.hidden_from_org = false");
  });

  it("renders TRUE when hidden rows are shown", () => {
    expect(render(visibleRowsSql("sr", SHOW_ALL))).toBe("TRUE");
  });

  it("accepts a snake table name as the alias", () => {
    expect(render(visibleRowsSql("service_requests", VISIBLE_ONLY))).toBe(
      "service_requests.hidden_from_org = false",
    );
  });

  it.each(["sr; drop", "", "Sr", "1sr", "sr.x", '"sr"', "sr ", "s-r"])(
    "throws on an unsafe alias %j",
    (alias) => {
      expect(() => visibleRowsSql(alias, VISIBLE_ONLY)).toThrow();
      expect(() => visibleRowsSql(alias, SHOW_ALL)).toThrow();
    },
  );
});

describe("computeShowHidden", () => {
  it("platform admin not previewing sees everything", () => {
    expect(computeShowHidden({ isPlatformAdmin: true, previewing: false, showHistory: false })).toBe(true);
  });

  it("platform admin previewing sees what the org sees", () => {
    expect(computeShowHidden({ isPlatformAdmin: true, previewing: true, showHistory: false })).toBe(false);
  });

  it("showHistory reveals history to the org", () => {
    expect(computeShowHidden({ isPlatformAdmin: false, previewing: false, showHistory: true })).toBe(true);
    expect(computeShowHidden({ isPlatformAdmin: true, previewing: true, showHistory: true })).toBe(true);
  });

  it("an org user without showHistory sees visible rows only", () => {
    expect(computeShowHidden({ isPlatformAdmin: false, previewing: false, showHistory: false })).toBe(false);
    expect(computeShowHidden({ isPlatformAdmin: false, previewing: true, showHistory: false })).toBe(false);
  });
});

describe("constants", () => {
  it("SHOW_ALL and VISIBLE_ONLY are frozen", () => {
    expect(SHOW_ALL).toEqual({ showHidden: true });
    expect(VISIBLE_ONLY).toEqual({ showHidden: false });
    expect(Object.isFrozen(SHOW_ALL)).toBe(true);
    expect(Object.isFrozen(VISIBLE_ONLY)).toBe(true);
  });
});
