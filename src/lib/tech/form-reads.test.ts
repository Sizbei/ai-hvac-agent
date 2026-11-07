import { describe, it, expect, vi, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

const { readQueue, executed } = vi.hoisted(() => ({ readQueue: [] as unknown[][], executed: [] as unknown[] }));
vi.mock("@/lib/db", () => ({
  db: {
    execute: (q: unknown) => {
      executed.push(q);
      return Promise.resolve({ rows: readQueue.shift() ?? [] });
    },
    batch: vi.fn(),
  },
}));
vi.mock("@/lib/admin/pricebook-queries", () => ({ getDefaultTaxBps: vi.fn(), getPricebookItemById: vi.fn() }));
vi.mock("@/lib/tech/ownership", async (orig) => ({ ...(await orig<typeof import("@/lib/tech/ownership")>()), findReadableJob: vi.fn() }));
vi.mock("@/lib/crypto", () => ({
  encrypt: (s: string) => `ENC:${s}`,
  decrypt: (s: string) => {
    if (s === "BAD") throw new Error("auth tag");
    return s.slice(4);
  },
}));

import { cardFormsSql, cardSubmissionsSql, countingVisitSql, getJobForm, getJobForms, oneSubmissionSql, submittedElsewhereSql } from "./form-reads";
import { findReadableJob } from "@/lib/tech/ownership";

const ORG = "11111111-1111-4111-8111-111111111111";
const ME = "22222222-2222-4222-8222-222222222222";
const RID = "33333333-3333-4333-8333-333333333333";
const AID = "44444444-4444-4444-8444-444444444444";
const FORM = "55555555-5555-4555-8555-555555555555";
const FIELDS = [{ id: "f_0000000001", type: "checkbox", label: "Filter", required: true }];
const T = "2026-11-07T14:41:00.000Z";
const gates = (over: Record<string, unknown> = {}) => ({
  status: "arrived", native: true, customer_erased: false, visit_found: true, visit_live: true, my_row: true, my_live_row: true,
  my_progress: false, form_found: true, form_active: true, form_version: 1, ...over,
});
const dialect = new PgDialect();
const render = (q: unknown) => dialect.sqlToQuery(q as SQL).sql.replace(/\s+/g, " ").trim();

beforeEach(() => {
  readQueue.length = 0;
  executed.length = 0;
  vi.mocked(findReadableJob).mockResolvedValue({ id: RID, customerId: null, native: true, status: "arrived" });
});

describe("getJobForms (spec §6)", () => {
  it("404 when the job isn't readable, the visit isn't the request's, or the visit doesn't count", async () => {
    vi.mocked(findReadableJob).mockResolvedValueOnce(null);
    expect(await getJobForms(ORG, ME, RID, AID)).toEqual({ kind: "not_found" });
    readQueue.push([]);
    expect(await getJobForms(ORG, ME, RID, AID)).toEqual({ kind: "not_found" });
    readQueue.push([{ id: AID, appointment_number: 1, counts: false }]);
    expect(await getJobForms(ORG, ME, RID, AID)).toEqual({ kind: "not_found" });
  });

  it("assembles the card; a reader with no row on the visit reads not_assigned", async () => {
    readQueue.push(
      [{ id: AID, appointment_number: 2, counts: true }],
      [gates({ my_row: false, my_live_row: false })],
      [{ id: FORM, name: "Maintenance checklist", description: null, required: true, active: true, applies: true }],
      [],
    );
    const r = await getJobForms(ORG, ME, RID, AID.toUpperCase());
    expect(r).toMatchObject({
      kind: "ok",
      view: { visitId: AID, visitNumber: 2, myVisit: false, canWrite: false, writeBlockedReason: "not_assigned", myRowCancelled: false },
    });
    if (r.kind === "ok") expect(r.view.forms.map((f) => f.name)).toEqual(["Maintenance checklist"]);
  });

  it("tenancy and request scope on every read (deleting a predicate fails here)", () => {
    const orgs = (s: SQL) => dialect.sqlToQuery(s).params.filter((p) => p === ORG).length;
    expect(orgs(cardFormsSql(ORG, RID))).toBe(2);
    expect(render(cardFormsSql(ORG, RID))).toContain("WHERE f.organization_id = $");
    expect(orgs(countingVisitSql(ORG, RID, AID))).toBe(3);
    expect(render(countingVisitSql(ORG, RID, AID))).toContain("WHERE p.id = $3::uuid AND p.service_request_id = $4::uuid AND p.organization_id = $5::uuid");
    expect(orgs(oneSubmissionSql(ORG, RID, AID, FORM))).toBe(3);
    expect(render(oneSubmissionSql(ORG, RID, AID, FORM))).toContain("AND s.service_request_id = $");
    expect(orgs(submittedElsewhereSql(ORG, RID, AID, FORM))).toBe(4);
    expect(render(submittedElsewhereSql(ORG, RID, AID, FORM))).toContain("AND s.service_request_id = $");
  });

  it("form submission scope predicates are pinned", () => {
    expect(render(cardSubmissionsSql(ORG, RID))).toContain("AND s.service_request_id = $");
    const o = render(oneSubmissionSql(ORG, RID, AID, FORM));
    expect(o).toContain("s.appointment_id = $");
    expect(o).toContain("s.form_id = $");
    const e = render(submittedElsewhereSql(ORG, RID, AID, FORM));
    expect(e).toContain("s.status = 'submitted' AND s.appointment_id <> $");
    expect(e).toContain("ORDER BY s.submitted_at DESC, s.id LIMIT 1");
  });

  it("hasAnswers is values_encrypted IS NOT NULL (no decrypt); every table org-bound", () => {
    const t = render(cardSubmissionsSql(ORG, RID));
    expect(t).toContain("s.values_encrypted IS NOT NULL AS has_answers");
    expect(dialect.sqlToQuery(cardSubmissionsSql(ORG, RID)).params.filter((p) => p === ORG)).toHaveLength(5);
    expect(render(countingVisitSql(ORG, RID, AID))).toContain("WHERE p.id = $");
  });
});

describe("getJobForm (spec §6)", () => {
  it("an unreadable job → job_not_found (\"This job isn't yours.\"); a visit that doesn't count → not_found", async () => {
    vi.mocked(findReadableJob).mockResolvedValueOnce(null);
    expect(await getJobForm(ORG, ME, RID, FORM, AID)).toEqual({ kind: "job_not_found" });
    expect(executed).toHaveLength(0);
    readQueue.push([{ id: AID, appointment_number: 1, counts: false }]);
    expect(await getJobForm(ORG, ME, RID, FORM, AID)).toEqual({ kind: "not_found" });
  });

  it("a foreign or missing form id → 404; an archived form with no row → archived", async () => {
    readQueue.push([{ id: AID, appointment_number: 1, counts: true }], [gates()], [], []);
    expect(await getJobForm(ORG, ME, RID, FORM, AID)).toEqual({ kind: "not_found" });
    // The form is read inside the caller's org only: a foreign form id is a miss, never another org's form.
    const formRead = executed.map((q) => render(q)).find((t) => t.startsWith("SELECT name, description, version, fields, active FROM forms"));
    expect(formRead).toBe("SELECT name, description, version, fields, active FROM forms WHERE id = $1::uuid AND organization_id = $2::uuid");
    readQueue.push([{ id: AID, appointment_number: 1, counts: true }], [gates({ form_active: false })], [{ name: "M", description: null, version: 1, fields: FIELDS, active: false }], []);
    expect(await getJobForm(ORG, ME, RID, FORM, AID)).toEqual({ kind: "archived" });
  });

  it("renders the snapshot; decrypts; updatedByMe compares the caller", async () => {
    readQueue.push(
      [{ id: AID, appointment_number: 1, counts: true }],
      [gates()],
      [{ name: "Live name", description: "Desc", version: 3, fields: [], active: true }],
      [{ id: "s1", status: "draft", revision: 2, erased: false, form_name: "Snapshot name", form_version: 1, fields: FIELDS,
        values_encrypted: `ENC:${JSON.stringify({ f_0000000001: true })}`, updated_at: T, updated_by: ME, updated_by_name: "Sam Lee", submitted_at: null, submitted_by_name: null }],
      [],
    );
    const r = await getJobForm(ORG, ME, RID, FORM, AID);
    expect(r).toMatchObject({
      kind: "ok",
      view: {
        form: { name: "Snapshot name", description: "Desc", version: 1 },
        submission: { values: { f_0000000001: true }, updatedByMe: true, revision: 2 },
        canWrite: true, writeBlockedReason: null, submittedOn: null,
      },
    });
  });

  it("an undecryptable blob → values null, unreadable, never throws", async () => {
    readQueue.push(
      [{ id: AID, appointment_number: 1, counts: true }],
      [gates()],
      [{ name: "M", description: null, version: 1, fields: FIELDS, active: true }],
      [{ id: "s1", status: "draft", revision: 2, erased: false, form_name: "M", form_version: 1, fields: FIELDS, values_encrypted: "BAD", updated_at: T, updated_by: null }],
      [],
    );
    const r = await getJobForm(ORG, ME, RID, FORM, AID);
    expect(r).toMatchObject({ kind: "ok", view: { submission: { values: null }, canWrite: false, writeBlockedReason: "unreadable" } });
  });
});
