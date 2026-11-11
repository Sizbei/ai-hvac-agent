import { describe, it, expect } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";
import { adminGuidePatchSql, adminGuideSelectSql } from "./admin-guide-sql";

const ORG = "11111111-1111-1111-1111-111111111111";
const USER = "22222222-2222-2222-2222-222222222222";
const T1 = "2026-11-10T12:00:00.000Z";
const render = (q: SQL) => new PgDialect().sqlToQuery(q);
const flat = (q: SQL) => render(q).sql.replace(/\s+/g, " ");

describe("adminGuideSelectSql", () => {
  it("reads the subject's state, the FieldPulse connection, the flags and the contact name", () => {
    const q = adminGuideSelectSql({ organizationId: ORG, userId: USER, contactEmails: ["owner@x.com"] });
    const text = flat(q);
    for (const col of ["state", "has_field_pulse", "feature_flags", "contact_name"]) {
      expect(text).toContain(` AS ${col}`);
    }
    expect(text).toContain("SELECT admin_guide_state FROM users WHERE id = $1 AND organization_id = $2");
    expect(text).toContain("fieldpulse_connections WHERE organization_id = $3 AND connected = true");
    expect(text).toContain("SELECT feature_flags FROM organizations WHERE id = $4");
    expect(text).toMatch(/SELECT NULLIF\(name, email\) FROM users WHERE organization_id = \$5 AND is_active AND lower\(trim\(email\)\) = ANY\(\$6::text\[\]\) ORDER BY created_at, id LIMIT 1/);
    expect(render(q).params).toEqual([USER, ORG, ORG, ORG, ORG, ["owner@x.com"]]);
    expect(text).not.toContain("hidden_from_org");
  });

  it("a stale preview (no subject) reads no user row", () => {
    const q = adminGuideSelectSql({ organizationId: ORG, userId: null, contactEmails: ["owner@x.com"] });
    expect(flat(q)).toContain("NULL::jsonb AS state");
    expect(flat(q)).not.toContain("admin_guide_state");
    expect(render(q).params).not.toContain(USER);
  });

  it("no platform admin emails: no contact lookup", () => {
    const q = adminGuideSelectSql({ organizationId: ORG, userId: USER, contactEmails: [] });
    expect(flat(q)).toContain("NULL::text AS contact_name");
    expect(flat(q)).not.toContain("ANY(");
  });

  it("never writes", () => {
    const text = flat(adminGuideSelectSql({ organizationId: ORG, userId: USER, contactEmails: ["a@b.c"] }));
    expect(text).not.toMatch(/\b(UPDATE|INSERT|DELETE)\b/i);
  });
});

describe("adminGuidePatchSql", () => {
  const q = adminGuidePatchSql({
    organizationId: ORG,
    userId: USER,
    writeOnce: { tourStartedAt: T1 },
    lastLesson: "schedule",
  });
  const text = flat(q);
  const { params } = render(q);

  it("updates only the session user's own active admin-tier row in the org", () => {
    expect(text).toMatch(/^UPDATE users SET admin_guide_state = /);
    expect(text).toContain(
      "WHERE id = $3 AND organization_id = $4 AND role IN ('admin', 'super_admin') AND is_active",
    );
    expect(params.slice(-2)).toEqual([USER, ORG]);
  });

  it("merges write-once keys under the stored object (stored values win), then lastLesson over it", () => {
    expect(text).toContain(
      "(($1::jsonb || (CASE WHEN jsonb_typeof(users.admin_guide_state) = 'object' THEN users.admin_guide_state ELSE '{}'::jsonb END)) || $2::jsonb)",
    );
    expect(params[0]).toBe(JSON.stringify({ tourStartedAt: T1 }));
    expect(params[1]).toBe(JSON.stringify({ lastLesson: "schedule" }));
  });

  it("without a lesson, the right-hand side is empty so lastLesson is kept", () => {
    const p = render(
      adminGuidePatchSql({ organizationId: ORG, userId: USER, writeOnce: { welcomeDismissedAt: T1 } }),
    ).params;
    expect(p[0]).toBe(JSON.stringify({ welcomeDismissedAt: T1 }));
    expect(p[1]).toBe("{}");
  });

  it("returns nothing (the route always answers 204)", () => {
    expect(text).not.toContain("RETURNING");
  });
});
