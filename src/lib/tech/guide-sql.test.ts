import { describe, it, expect } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { guideSelectSql, guideStampSql, guideHideSql } from "./guide-sql";

const ORG = "11111111-1111-1111-1111-111111111111";
const USER = "22222222-2222-2222-2222-222222222222";
const render = (q: SQL) => new PgDialect().sqlToQuery(q);

describe("guideSelectSql", () => {
  const { sql: text, params } = render(guideSelectSql(ORG, USER));
  const flat = text.replace(/\s+/g, " ");

  it("is a FROM-less SELECT with one column per signal", () => {
    let depth = 0, top = "";
    for (const ch of flat) { if (ch === "(") depth++; else if (ch === ")") depth--; else if (depth === 0) top += ch; }
    expect(top).not.toMatch(/\bFROM\b/);
    for (const col of ["start_job", "finish_job", "clock_in", "share_location", "add_material", "note_or_photo", "capture_signature", "build_invoice", "collect_payment", "has_open_job", "field_guide_state"]) {
      expect(flat).toContain(` AS ${col}`);
    }
  });

  it("binds 26 org predicates and 13 user predicates, nothing else", () => {
    expect(params.filter((p) => p === ORG)).toHaveLength(26);
    expect(params.filter((p) => p === USER)).toHaveLength(13);
    expect(params).toHaveLength(39);
  });

  it("names every user predicate by column", () => {
    for (const col of ["technician_id", "created_by", "author_id", "recorded_by", "id"]) {
      expect(flat).toMatch(new RegExp(`\\b${col} = \\$\\d+`));
    }
  });

  it("excludes office uploads and cancelled visits", () => {
    expect(flat).toContain("position('_admin_' in t.storage_key) = 0");
    expect((flat.match(/p\.cancelled_at IS NULL/g) ?? []).length).toBeGreaterThanOrEqual(5);
    expect(flat).toContain("r.status NOT IN ('completed', 'cancelled')");
  });
});

describe("guideStampSql", () => {
  it("guards with ?& on defined keys only, both jsonb_typeof CASEs, technician role", () => {
    const { sql: text, params } = render(guideStampSql({ organizationId: ORG, userId: USER, newStamps: { start_job: "2026-11-05T00:00:00.000Z", clock_in: undefined } }));
    const flat = text.replace(/\s+/g, " ");
    expect(flat).toContain("role = 'technician'");
    expect(flat).toContain("?&");
    expect((flat.match(/jsonb_typeof/g) ?? []).length).toBeGreaterThanOrEqual(2);
    expect(params).toContainEqual(["start_job"]);
    expect(params).toContainEqual(JSON.stringify({ start_job: "2026-11-05T00:00:00.000Z" }));
    expect(flat).not.toContain("RETURNING");
  });
});

describe("guideHideSql", () => {
  it("prepends the new key so old values win, and returns the state", () => {
    const { sql: text, params } = render(guideHideSql({ organizationId: ORG, userId: USER, hiddenAt: "2026-11-05T00:00:00.000Z" }));
    const flat = text.replace(/\s+/g, " ");
    expect(flat).toMatch(/jsonb_build_object\('hiddenAt', \$\d+::text\) \|\| CASE WHEN jsonb_typeof/);
    expect(flat).toContain("RETURNING field_guide_state");
    expect(params).toEqual(["2026-11-05T00:00:00.000Z", USER, ORG]);
  });
});
