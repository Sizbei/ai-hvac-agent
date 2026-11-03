import { describe, it, expect } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import {
  onboardingSelectSql,
  stampStatementSql,
  flagsStatementSql,
} from "./onboarding-sql";

const ORG = "11111111-1111-1111-1111-111111111111";
const render = (q: SQL) => new PgDialect().sqlToQuery(q);

describe("onboardingSelectSql", () => {
  const { sql: text, params } = render(onboardingSelectSql(ORG));
  const flat = text.replace(/\s+/g, " ");

  it("is a FROM-less SELECT at top level", () => {
    expect(flat.trim().startsWith("SELECT")).toBe(true);
    // strip every parenthesised subquery; nothing at depth 0 may FROM
    let depth = 0;
    let top = "";
    for (const ch of flat) {
      if (ch === "(") depth++;
      else if (ch === ")") depth--;
      else if (depth === 0) top += ch;
    }
    expect(top).not.toMatch(/\bFROM\b/);
  });

  it("selects one column per signal", () => {
    for (const col of [
      "company_name", "phone", "business_hours", "logo_url", "technician_ready",
      "fp_passwordless", "pending_invite", "pricebook", "any_request",
      "booked_assigned", "tech_signed_in_evidence", "widget_key", "allowed_origins",
      "integration_connected", "completed_request", "org_created_at", "onboarding_state",
    ]) {
      expect(flat).toContain(` AS ${col}`);
    }
  });

  it("scopes every subquery by org and binds only the org id", () => {
    const frags = flat.split(/\(SELECT |EXISTS \(/).slice(1);
    expect(frags.length).toBeGreaterThan(15);
    for (const f of frags) {
      // a fragment that only holds a nested subquery boundary still names a table
      if (!/\bFROM\b/.test(f)) continue;
      expect(f).toMatch(/(organization_id|\bid) = \$\d+/);
    }
    // exactly 25 org predicates in the builder, each bound to the org id
    expect(params).toHaveLength(25);
    expect(params.every((p) => p === ORG)).toBe(true);
    expect((flat.match(/\$\d+/g) ?? []).length).toBe(25);
  });

  it("booked_assigned carries all five org predicates", () => {
    const start = flat.indexOf("EXISTS (SELECT 1 FROM appointments a");
    const end = flat.indexOf(" AS booked_assigned");
    const booked = flat.slice(start, end);
    expect(booked.match(/organization_id = \$\d+/g)).toHaveLength(5);
    for (const alias of ["a", "aa", "u", "r"]) {
      expect(booked).toContain(`${alias}.organization_id = $`);
    }
    expect(booked.match(/u\.organization_id = \$\d+/g)).toHaveLength(2);
  });

  it("scopes the organizations fragment by id and uses explicit casts", () => {
    expect(flat).toMatch(/FROM organizations WHERE id = \$\d+/);
    expect(flat).toContain(
      "CASE WHEN jsonb_typeof(allowed_origins) = 'array' THEN jsonb_array_length(allowed_origins) > 0 ELSE false END",
    );
    expect(flat).toContain("::request_status");
    expect(flat).toContain("assigned_to");
  });

  it("role-only technician check in booked_assigned (no is_active)", () => {
    const booked = flat.slice(flat.indexOf("appointment_assignments"), flat.indexOf(" AS booked_assigned"));
    expect(booked).toContain("role = 'technician'");
    expect(booked).not.toContain("is_active");
  });
});

describe("stampStatementSql", () => {
  const q = render(
    stampStatementSql({
      organizationId: ORG,
      newStamps: { phone_hours: "2026-11-01T00:00:00.000Z", brand: "2026-11-01T00:00:00.000Z" },
      top: { completedSeenAt: "2026-11-01T00:00:00.000Z" },
    }),
  );
  const flat = q.sql.replace(/\s+/g, " ");

  it("renders the upsert with OLD-wins semantics", () => {
    expect(flat).toContain("INSERT INTO organization_settings");
    expect(flat).toContain("ON CONFLICT (organization_id) DO UPDATE SET onboarding_state = jsonb_set(");
    expect(flat).toMatch(/\$\d+::jsonb \|\| CASE WHEN jsonb_typeof\(/);
    expect(flat).toMatch(/WHERE NOT \(.*\?& \$\d+::text\[\]\) OR NOT \(.*\?& \$\d+::text\[\]\)/);
    expect(flat.trim().endsWith("RETURNING onboarding_state")).toBe(true);
  });

  it("binds json strings and two text arrays", () => {
    expect(q.params).toContain(ORG);
    expect(q.params).toContain(JSON.stringify({ completedSeenAt: "2026-11-01T00:00:00.000Z" }));
    expect(q.params).toContain(JSON.stringify({ phone_hours: "2026-11-01T00:00:00.000Z", brand: "2026-11-01T00:00:00.000Z" }));
    const arrays = q.params.filter((p) => Array.isArray(p));
    expect(arrays).toEqual([["phone_hours", "brand"], ["completedSeenAt"]]);
  });

  it("puts $top and $new on the LEFT so old values win", () => {
    expect(flat).toMatch(
      /\$\d+::jsonb \|\| CASE WHEN jsonb_typeof\(organization_settings\.onboarding_state\) = 'object' THEN organization_settings\.onboarding_state ELSE '\{\}'::jsonb END, '\{firstCompleted\}'/,
    );
    expect(flat).toMatch(
      /\$\d+::jsonb \|\| CASE WHEN jsonb_typeof\(\(CASE .*?END\)->'firstCompleted'\) = 'object'/,
    );
  });

  it("drops undefined values from the JSON and the key arrays", () => {
    const u = render(
      stampStatementSql({
        organizationId: ORG,
        newStamps: { brand: undefined },
        top: { dismissedAt: undefined },
      }),
    );
    expect(u.params.filter((p) => p === "{}")).toHaveLength(4);
    expect(u.params.filter((p) => Array.isArray(p))).toEqual([[], []]);
  });

  it("renders for grandfather-only (empty newStamps)", () => {
    const g = render(
      stampStatementSql({ organizationId: ORG, newStamps: {}, top: { dismissedAt: "2026-11-01T00:00:00.000Z" } }),
    );
    expect(g.sql).toContain("ON CONFLICT (organization_id)");
    expect(g.params).toContain("{}");
  });
});

describe("flagsStatementSql", () => {
  const base = { organizationId: ORG, flags: { embedCopied: true as const }, top: {} };

  it("without the guard has no WHERE", () => {
    const { sql: t } = render(flagsStatementSql(base));
    const flat = t.replace(/\s+/g, " ");
    expect(flat).toContain("jsonb_set(");
    expect(flat).toContain("'{flags}'");
    expect(flat).not.toMatch(/\bWHERE\b/);
    expect(flat).toMatch(
      /\$\d+::jsonb \|\| CASE WHEN jsonb_typeof\(organization_settings\.onboarding_state\) = 'object' THEN organization_settings\.onboarding_state ELSE '\{\}'::jsonb END, '\{flags\}'/,
    );
    expect(flat).toMatch(
      /\$\d+::jsonb \|\| CASE WHEN jsonb_typeof\(\(CASE .*?END\)->'flags'\) = 'object'/,
    );
    expect(flat.trim().endsWith("RETURNING onboarding_state")).toBe(true);
  });

  it("with guardTechSignedIn appends the write-once WHERE", () => {
    const { sql: t, params } = render(
      flagsStatementSql({ ...base, flags: { techSignedInAt: "2026-11-01T00:00:00.000Z" }, guardTechSignedIn: true }),
    );
    const flat = t.replace(/\s+/g, " ");
    expect(flat).toContain("WHERE");
    expect(flat).toContain("#> '{flags,techSignedInAt}' IS NULL");
    expect(flat.trim().endsWith("RETURNING onboarding_state")).toBe(true);
    expect(params).toContain(JSON.stringify({ techSignedInAt: "2026-11-01T00:00:00.000Z" }));
  });
});
