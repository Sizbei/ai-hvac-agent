import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Migration 0058 (M3d spec §3, §3.4): idempotent shape, and the re-created
 * visit trigger is 0050's body byte for byte except the one predicate line.
 */
const root = join(__dirname, "..", "..", "..");
const read = (f: string) => readFileSync(join(root, "drizzle", f), "utf8");
const SQL_0058 = read("0058_m3d_forms.sql");
const SQL_0050 = read("0050_m3a_run_the_day.sql");

const START = "CREATE OR REPLACE FUNCTION sync_request_appointment()";
const END = "$$ LANGUAGE plpgsql;";
function functionBody(src: string): string {
  const start = src.indexOf(START);
  const end = src.indexOf(END, start);
  if (start < 0 || end < 0) throw new Error("function not found");
  return src.slice(start, end + END.length);
}

const OLD_LINE = "      ) INTO v_has_progress;";
const NEW_LINE = "      ) OR EXISTS (SELECT 1 FROM form_submissions s WHERE s.appointment_id = v_appt_id) INTO v_has_progress;";

describe("migration 0058", () => {
  const statements = SQL_0058.split("--> statement-breakpoint").map((s) => s.trim()).filter(Boolean);

  it("has 23 statements, the trigger function last", () => {
    expect(statements).toHaveLength(23);
    expect(statements.at(-1)).toContain(START);
  });

  it("creates forms before form_submissions, both IF NOT EXISTS", () => {
    expect(statements[0]).toMatch(/^-- M3d[\s\S]*CREATE TABLE IF NOT EXISTS "forms"/);
    expect(statements[1]).toMatch(/^CREATE TABLE IF NOT EXISTS "form_submissions"/);
  });

  it("wraps every constraint in its own duplicate_object block", () => {
    const adds = statements.filter((s) => s.includes("ADD CONSTRAINT"));
    expect(adds).toHaveLength(15);
    for (const s of adds) {
      expect(s.startsWith("DO $$ BEGIN")).toBe(true);
      expect(s.endsWith("EXCEPTION WHEN duplicate_object THEN NULL; END $$;")).toBe(true);
      expect(s.match(/ADD CONSTRAINT/g)).toHaveLength(1);
    }
  });

  it("indexes are IF NOT EXISTS; the name index is lower(name) WHERE active", () => {
    const idx = statements.filter((s) => s.includes("INDEX"));
    expect(idx).toHaveLength(5);
    for (const s of idx) expect(s).toMatch(/^CREATE (UNIQUE )?INDEX IF NOT EXISTS/);
    expect(SQL_0058).toContain(`ON "forms" USING btree ("organization_id",lower("name")) WHERE "forms"."active"`);
    expect(SQL_0058).toContain(`"form_submissions_visit_form_unique" ON "form_submissions" USING btree ("appointment_id","form_id","service_request_id")`);
  });

  it("the visit and form foreign keys are NO ACTION; the request and org ones cascade", () => {
    expect(SQL_0058).toContain(`FOREIGN KEY ("appointment_id") REFERENCES "public"."appointments"("id") ON DELETE no action`);
    expect(SQL_0058).toContain(`FOREIGN KEY ("form_id") REFERENCES "public"."forms"("id") ON DELETE no action`);
    expect(SQL_0058).toContain(`FOREIGN KEY ("service_request_id") REFERENCES "public"."service_requests"("id") ON DELETE cascade`);
  });

  it("the trigger body is 0050's with only the v_has_progress predicate changed", () => {
    const before = functionBody(SQL_0050);
    const after = functionBody(SQL_0058);
    expect(before.split(OLD_LINE)).toHaveLength(2);
    expect(after).toBe(before.replace(OLD_LINE, NEW_LINE));
    const a = before.split("\n");
    const b = after.split("\n");
    expect(b).toHaveLength(a.length);
    expect(a.filter((line, i) => line !== b[i])).toEqual([OLD_LINE]);
  });
});
