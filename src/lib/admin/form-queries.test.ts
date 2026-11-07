import { describe, it, expect, vi, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

const { readQueue, executed, failNext } = vi.hoisted(() => ({
  readQueue: [] as unknown[][],
  executed: [] as unknown[],
  failNext: { error: null as unknown },
}));
vi.mock("@/lib/db", () => ({
  db: {
    execute: (q: unknown) => {
      executed.push(q);
      if (failNext.error) {
        const e = failNext.error;
        failNext.error = null;
        return Promise.reject(e);
      }
      return Promise.resolve({ rows: readQueue.shift() ?? [] });
    },
    batch: vi.fn(),
  },
}));
vi.mock("@/lib/admin/pricebook-queries", () => ({ getDefaultTaxBps: vi.fn(), getPricebookItemById: vi.fn() }));
vi.mock("@/lib/crypto", () => ({
  encrypt: (s: string) => `ENC:${s}`,
  decrypt: (s: string) => {
    if (s === "BAD") throw new Error("auth tag");
    return s.slice(4);
  },
}));

import { createForm, missingRequiredFormsSql, reopenSubmission, requestSubmissionsSql, toOfficeSubmission, updateForm } from "./form-queries";
import { uuidArraySql } from "@/lib/db/sql-arrays";
import { officeId } from "@/lib/http/idempotency";
import type { FormDefinition } from "@/lib/forms/form-schema";

const ORG = "11111111-1111-4111-8111-111111111111";
const ME = "22222222-2222-4222-8222-222222222222";
const TOKEN = "33333333-3333-4333-8333-333333333333";
const JT = "44444444-4444-4444-8444-444444444444";
const FID = "55555555-5555-4555-8555-555555555555";
const RID = "66666666-6666-4666-8666-666666666666";
const SID = "77777777-7777-4777-8777-777777777777";
const dialect = new PgDialect();
const render = (q: unknown) => dialect.sqlToQuery(q as SQL).sql.replace(/\s+/g, " ").trim();
const params = (q: unknown) => dialect.sqlToQuery(q as SQL).params;
const def = (over: Partial<FormDefinition> = {}): FormDefinition => ({
  name: "Maintenance checklist", description: null, jobTypeIds: [], required: true,
  fields: [{ id: "f_0000000001", type: "checkbox", label: "Filter", required: true }], ...over,
});
const unique = Object.assign(new Error("dup"), { cause: { code: "23505", constraint: "forms_org_name_active_unique" } });

beforeEach(() => { readQueue.length = 0; executed.length = 0; failNext.error = null; });

describe("createForm (spec §4.1)", () => {
  it("id is officeId('form', org, token); INSERT … WHERE count < 100 ON CONFLICT (id) DO NOTHING", async () => {
    readQueue.push([{ id: "x" }]);
    const id = officeId("form", ORG, TOKEN);
    expect(await createForm(ORG, ME, TOKEN, def())).toEqual({ ok: true, id, created: true });
    const s = render(executed[0]);
    expect(s).toMatch(/^INSERT INTO forms \(id, organization_id, name, description, fields, job_type_ids, required, created_by\) SELECT \$1::uuid, \$2::uuid/);
    expect(s).toContain("::jsonb, ARRAY[]::uuid[], $");
    expect(s).toContain("WHERE (SELECT count(*) FROM forms WHERE organization_id = $");
    expect(s).toContain(") < $");
    expect(s).toContain("ON CONFLICT (id) DO NOTHING RETURNING id");
    expect(params(executed[0])).toContain(100);
  });

  it("a replay (same token) returns the existing id with created:false; a full org → limit_reached", async () => {
    readQueue.push([], [{ id: "x" }]);
    expect(await createForm(ORG, ME, TOKEN, def())).toMatchObject({ ok: true, created: false });
    readQueue.push([], []);
    expect(await createForm(ORG, ME, TOKEN, def())).toEqual({ ok: false, reason: "limit_reached" });
  });

  it("name collision → name_taken; unknown job type → unknown_job_type before any insert", async () => {
    failNext.error = unique;
    expect(await createForm(ORG, ME, TOKEN, def())).toEqual({ ok: false, reason: "name_taken" });
    executed.length = 0;
    readQueue.push([{ n: 0 }]);
    expect(await createForm(ORG, ME, TOKEN, def({ jobTypeIds: [JT] }))).toEqual({ ok: false, reason: "unknown_job_type" });
    expect(executed).toHaveLength(1);
    expect(render(executed[0])).toContain("FROM job_types WHERE organization_id = $1::uuid AND id = ANY(ARRAY[$2::uuid]::uuid[])");
  });
});

describe("updateForm", () => {
  it("CAS on version; zero rows → stale when the form exists, else not_found", async () => {
    readQueue.push([{ version: 3 }]);
    expect(await updateForm(ORG, FID, { version: 2, definition: def() })).toEqual({ ok: true, version: 3 });
    expect(render(executed[0])).toContain("SET version = version + 1, updated_at = now(), name = $");
    expect(render(executed[0])).toContain("WHERE id = $");
    expect(render(executed[0])).toContain("AND version = $");
    readQueue.push([], [{ "?column?": 1 }]);
    expect(await updateForm(ORG, FID, { version: 2, active: false })).toEqual({ ok: false, reason: "stale" });
    readQueue.push([], []);
    expect(await updateForm(ORG, FID, { version: 2, active: false })).toEqual({ ok: false, reason: "not_found" });
  });

  it("restoring an archived form whose name is now taken → name_taken", async () => {
    failNext.error = unique;
    expect(await updateForm(ORG, FID, { version: 4, active: true })).toEqual({ ok: false, reason: "name_taken" });
  });
});

describe("reopenSubmission (spec §5.5)", () => {
  it("changed; already a draft → changed:false; erased; stale; missing", async () => {
    readQueue.push([{ revision: 5, form_id: FID, appointment_id: "a" }]);
    expect(await reopenSubmission(ORG, RID, SID, 4)).toEqual({ ok: true, revision: 5, changed: true, formId: FID, appointmentId: "a" });
    expect(render(executed[0])).toContain("AND status = 'submitted' AND erased_at IS NULL AND revision = $");
    expect(render(executed[0])).toContain("WHERE id = $1::uuid AND organization_id = $2::uuid AND service_request_id = $3::uuid");
    readQueue.push([], [{ status: "draft", revision: 5, erased: false, form_id: FID, appointment_id: "a" }]);
    expect(await reopenSubmission(ORG, RID, SID, 4)).toMatchObject({ ok: true, changed: false, revision: 5 });
    readQueue.push([], [{ status: "submitted", revision: 6, erased: true }]);
    expect(await reopenSubmission(ORG, RID, SID, 4)).toEqual({ ok: false, reason: "answers_removed" });
    readQueue.push([], [{ status: "submitted", revision: 6, erased: false }]);
    expect(await reopenSubmission(ORG, RID, SID, 4)).toEqual({ ok: false, reason: "stale" });
    readQueue.push([], []);
    expect(await reopenSubmission(ORG, RID, SID, 4)).toEqual({ ok: false, reason: "not_found" });
  });
});

describe("office reads (spec §6)", () => {
  it("submissions omit unerased answerless drafts; every table org-bound", () => {
    const s = render(requestSubmissionsSql(ORG, RID));
    expect(s).toContain("AND NOT (s.status = 'draft' AND s.erased_at IS NULL AND s.values_encrypted IS NULL)");
    expect(params(requestSubmissionsSql(ORG, RID)).filter((p) => p === ORG)).toHaveLength(5);
  });

  it("missingRequired: not on cancelled, created before completion, counted only on visits that count", () => {
    const s = render(missingRequiredFormsSql(ORG, RID));
    expect(s).toContain("r.status <> 'cancelled'::request_status");
    expect(s).toContain("(r.status <> 'completed'::request_status OR r.completed_at IS NULL OR f.created_at < r.completed_at)");
    expect(s).toContain("(cardinality(f.job_type_ids) = 0 OR r.job_type_id = ANY(f.job_type_ids))");
    expect(s).toContain("(p.cancelled_at IS NULL OR EXISTS (SELECT 1 FROM appointment_assignments vca");
    // r, f, p, s, vca, vcs: every table bound to the org.
    expect(params(missingRequiredFormsSql(ORG, RID)).filter((p) => p === ORG)).toHaveLength(6);
    expect(s).toContain("WHERE f.organization_id = $");
  });

  it("an undecryptable blob reads unreadable with null values, never throws; an ended visit reads 'ended'", () => {
    const o = toOfficeSubmission({
      id: SID, form_id: FID, form_name: "M", form_version: 1, appointment_id: "a", appointment_number: 1, visit_live: false,
      status: "submitted", revision: 2, erased: false, fields: [], values_encrypted: "BAD", updated_at: "2026-11-07T00:00:00Z",
      updated_by_name: null, submitted_at: "2026-11-07T00:00:00Z", submitted_by_name: "Alex Rivera", visit_has_technician: false,
    });
    expect(o).toMatchObject({ unreadable: true, values: null, visitState: "ended", submittedByName: "Alex Rivera" });
  });

  it("uuidArraySql builds an ARRAY of uuid params", () => {
    expect(render(uuidArraySql([JT, FID]))).toBe("ARRAY[$1::uuid, $2::uuid]::uuid[]");
  });
});
