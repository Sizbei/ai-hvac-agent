import { describe, it, expect, vi, beforeEach } from "vitest";
import { PgDialect } from "drizzle-orm/pg-core";
import type { SQL } from "drizzle-orm";

const { readQueue, batch, executed } = vi.hoisted(() => ({ readQueue: [] as unknown[][], batch: vi.fn(), executed: [] as unknown[] }));
vi.mock("@/lib/db", () => ({
  db: {
    execute: (q: unknown) => (executed.push(q), {
      __sql: q,
      then: (ok: (v: unknown) => unknown, err: (e: unknown) => unknown) =>
        Promise.resolve({ rows: readQueue.shift() ?? [] }).then(ok, err),
    }),
    batch,
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

import { decryptValues, findDraftReplay, saveFormDraft, submitForm, zeroRowOutcome, type DraftInput, type SubmissionRow } from "./form-writes";
import type { FormGates } from "@/lib/forms/form-gates";

const ORG = "11111111-1111-4111-8111-111111111111";
const RID = "22222222-2222-4222-8222-222222222222";
const AID = "33333333-3333-4333-8333-333333333333";
const ME = "44444444-4444-4444-8444-444444444444";
const FORM = "55555555-5555-4555-8555-555555555555";
const SID = "66666666-6666-4666-8666-666666666666";
const SAVE = "abcdef12-3456-4789-8abc-def012345678";
const KEY = "fedcba98-7654-4321-8fed-cba987654321";
const actor = { organizationId: ORG, requestId: RID, techUserId: ME };
const TICK = { id: "f_0000000001", type: "checkbox", label: "Filter", required: true };
const NUM = { id: "f_0000000002", type: "number", label: "Suction", required: false, unit: "psi" };
const FIELDS = [TICK, NUM];
const T0 = "2026-11-07T14:41:00.000Z";

const draft = (over: Partial<DraftInput> = {}): DraftInput => ({
  formId: FORM, appointmentId: AID, formVersion: 1, baseRevision: 0, saveId: SAVE, changes: { [TICK.id]: true }, ...over,
});
const row = (over: Record<string, unknown> = {}) => ({
  id: SID, status: "draft", revision: 1, form_version: 1, erased: false, last_save_id: null, submit_key: null,
  updated_at: T0, submitted_at: null, fields: FIELDS, values_encrypted: null, ...over,
});

const dialect = new PgDialect();
const renderQ = (q: unknown) => dialect.sqlToQuery(((q as { __sql?: unknown }).__sql ?? q) as SQL);
const render = (q: unknown) => renderQ(q).sql.replace(/\s+/g, " ").trim();
const stmts = () => (batch.mock.calls[0]![0] as unknown[]).map(render);
const params = (i: number) => renderQ((batch.mock.calls[0]![0] as unknown[])[i]).params;
const rowsOf = (...r: unknown[][]) => r.map((rows) => ({ rows }));

const VISIT_GATE = "EXISTS (SELECT 1 FROM appointments p JOIN appointment_assignments a ON a.appointment_id = p.id";
const LOCK = "SELECT 1 FROM service_requests WHERE id = $1::uuid AND organization_id = $2::uuid FOR NO KEY UPDATE";
const orgCount = (i: number) => params(i).filter((p) => p === ORG).length;

beforeEach(() => { readQueue.length = 0; executed.length = 0; batch.mockReset(); });

describe("saveFormDraft (spec §5.2)", () => {
  it("replay is checked first: revision = base + 1 and the same saveId → 200, nothing else read", async () => {
    readQueue.push([row({ revision: 4, last_save_id: SAVE, values_encrypted: "BAD" })]);
    expect(await saveFormDraft(actor, draft({ baseRevision: 3, saveId: SAVE.toUpperCase() }))).toEqual({
      ok: true, submissionId: SID, revision: 4, savedAt: T0, created: false,
    });
    expect(batch).not.toHaveBeenCalled();
    expect(readQueue).toHaveLength(0);
  });

  it("first write: reads the live form, then one batch L_req → INSERT … SELECT → gated UPDATE → tail", async () => {
    readQueue.push([], [{ active: true, version: 1, fields: FIELDS }]);
    batch.mockResolvedValueOnce(rowsOf([], [{ id: SID }], [{ id: SID, revision: 1, updated_at: T0 }], [row()]));
    expect(await saveFormDraft(actor, draft())).toEqual({ ok: true, submissionId: SID, revision: 1, savedAt: T0, created: true });
    const s = stmts();
    expect(s).toHaveLength(4);
    expect(s[0]).toBe(LOCK);
    // The live form is read inside this org only.
    expect(render(executed[1])).toBe("SELECT active, version, fields FROM forms WHERE id = $1::uuid AND organization_id = $2::uuid");
    expect(s[1]).toMatch(/^INSERT INTO form_submissions \(organization_id, form_id, service_request_id, appointment_id, form_name, form_version, fields, started_by\) SELECT /);
    expect(s[1]).toContain("FROM forms f WHERE f.id = $");
    expect(s[1]).toContain("AND f.active AND f.version = $");
    expect(s[1]).toContain("EXISTS (SELECT 1 FROM service_requests rg");
    expect(s[1]).toContain("EXISTS (SELECT 1 FROM appointments p JOIN appointment_assignments a ON a.appointment_id = p.id");
    expect(s[1]).toContain("ON CONFLICT (appointment_id, form_id, service_request_id) DO NOTHING RETURNING id");
    expect(s[2]).toContain("SET values_encrypted = $1::text, revision = revision + 1, updated_by = $2::uuid, updated_at = now(), last_save_id = $3::uuid");
    expect(s[2]).toContain("AND status = 'draft' AND erased_at IS NULL AND revision = $");
    expect(s[2]).toContain("AND form_version = $");
    expect(s[2]).toContain("EXISTS (SELECT 1 FROM service_requests rg");
    // The UPDATE re-checks the visit (a technician removed after the route's gate read).
    expect(s[2]).toContain(VISIT_GATE);
    expect(params(2)[0]).toBe(`ENC:${JSON.stringify({ [TICK.id]: true })}`);
    // C M-3: the revision gate binds the client's base revision and form version, by value and position.
    expect(s[2]).toContain("AND revision = $8::int AND form_version = $9::int");
    expect(params(2).slice(0, 9)).toEqual([`ENC:${JSON.stringify({ [TICK.id]: true })}`, ME, SAVE, ORG, AID, FORM, RID, 0, 1]);
    // INSERT: forms, the row value, rg, gc, ga, p, a. UPDATE: the row, rg, gc, ga, p, a.
    expect(orgCount(1)).toBe(7);
    expect(orgCount(2)).toBe(6);
    // organization_id is bound on every statement.
    for (let i = 0; i < 4; i++) expect(params(i)).toContain(ORG);
  });

  it("an uppercase visit or form id from the client binds lowercase (Postgres returns lowercase uuids)", async () => {
    const UP = "ABCDEF12-3456-4789-8ABC-DEF012345678";
    expect(UP.toUpperCase()).toBe(UP);
    readQueue.push([], [{ active: true, version: 1, fields: FIELDS }]);
    batch.mockResolvedValueOnce(rowsOf([], [{ id: SID }], [{ id: SID, revision: 1, updated_at: T0 }], [row()]));
    await saveFormDraft(actor, draft({ appointmentId: UP, formId: FORM.toUpperCase() }));
    for (let i = 1; i < 4; i++) {
      expect(params(i)).toContain(UP.toLowerCase());
      expect(params(i)).not.toContain(UP);
    }
  });

  it("a later base binds that base, not base + 1 (C M-3)", async () => {
    readQueue.push([row({ revision: 3, form_version: 2 })]);
    batch.mockResolvedValueOnce(rowsOf([], [], [{ id: SID, revision: 4, updated_at: T0 }], [row({ revision: 4 })]));
    await saveFormDraft(actor, draft({ baseRevision: 3, formVersion: 2 }));
    expect(params(2).slice(7, 9)).toEqual([3, 2]);
  });

  it("clearing every answer stores NULL", async () => {
    readQueue.push([row({ values_encrypted: `ENC:${JSON.stringify({ [TICK.id]: true })}` })]);
    batch.mockResolvedValueOnce(rowsOf([], [], [{ id: SID, revision: 2, updated_at: T0 }], [row({ revision: 2 })]));
    const r = await saveFormDraft(actor, draft({ baseRevision: 1, changes: { [TICK.id]: null } }));
    expect(r).toMatchObject({ ok: true, revision: 2, created: false });
    expect(params(2)[0]).toBeNull();
  });

  it("pre-read refusals: erased, submitted, other version, unreadable; no batch", async () => {
    for (const [r, reason] of [
      [row({ erased: true }), "answers_removed"],
      [row({ status: "submitted", submitted_at: T0 }), "form_submitted"],
      [row({ form_version: 2 }), "form_changed"],
      [row({ values_encrypted: "BAD" }), "answers_unreadable"],
      [row({ fields: "nope" }), "answers_unreadable"],
    ] as const) {
      readQueue.push([r]);
      expect(await saveFormDraft(actor, draft({ baseRevision: 1 }))).toEqual({ ok: false, reason });
    }
    expect(batch).not.toHaveBeenCalled();
  });

  it("a base other than the pre-read revision is STALE before any decrypt or batch (spec §4.2)", async () => {
    readQueue.push([row({ revision: 3, values_encrypted: "BAD" })]);
    expect(await saveFormDraft(actor, draft({ baseRevision: 1 }))).toEqual({ ok: false, reason: "stale", revision: 3 });
    readQueue.push([]);
    expect(await saveFormDraft(actor, draft({ baseRevision: 2 }))).toEqual({ ok: false, reason: "stale", revision: 0 });
    expect(batch).not.toHaveBeenCalled();
  });

  it("findDraftReplay: a landed write's retry answers without the gates; anything else is null", async () => {
    readQueue.push([row({ revision: 2, last_save_id: SAVE })]);
    expect(await findDraftReplay(actor, draft({ baseRevision: 1 }))).toEqual({ ok: true, submissionId: SID, revision: 2, savedAt: T0, created: false });
    readQueue.push([row({ revision: 2, last_save_id: SAVE })]);
    expect(await findDraftReplay(actor, draft({ baseRevision: 1, saveId: KEY }))).toBeNull();
    readQueue.push([]);
    expect(await findDraftReplay(actor, draft())).toBeNull();
  });

  it("no row: missing form 404, archived, version changed", async () => {
    readQueue.push([], []);
    expect(await saveFormDraft(actor, draft())).toEqual({ ok: false, reason: "not_found" });
    readQueue.push([], [{ active: false, version: 1, fields: FIELDS }]);
    expect(await saveFormDraft(actor, draft())).toEqual({ ok: false, reason: "form_archived" });
    readQueue.push([], [{ active: true, version: 2, fields: FIELDS }]);
    expect(await saveFormDraft(actor, draft())).toEqual({ ok: false, reason: "form_changed" });
  });

  it("content: a bad value names its field; an injected over-128 KB document is values_too_large (lead ruling 5: no valid definition reaches the cap)", async () => {
    readQueue.push([], [{ active: true, version: 1, fields: FIELDS }]);
    expect(await saveFormDraft(actor, draft({ changes: { [NUM.id]: "12" } }))).toEqual({ ok: false, reason: "invalid_values", fieldIds: [NUM.id] });
    const LONG = { id: "f_0000000003", type: "long_text", label: "L", required: false };
    // An INJECTED snapshot with 22 long answers (a valid definition allows 10; stored fields skip that check):
    // 22 × 2,000 "€" = 132,000 UTF-8 bytes, each under its own limit, together over 128 KB.
    const big = Object.fromEntries(Array.from({ length: 22 }, (_, i) => [`f_00000001${String(i).padStart(2, "0")}`, "€".repeat(2000)]));
    const fields = [...FIELDS, LONG, ...Object.keys(big).map((id) => ({ ...LONG, id }))];
    readQueue.push([], [{ active: true, version: 1, fields }]);
    expect(await saveFormDraft(actor, draft({ changes: big }))).toEqual({ ok: false, reason: "values_too_large" });
  });

  it("zero rows: my own landed write → replay; a colleague's → STALE with their revision; a gate → its code", async () => {
    readQueue.push([row({ revision: 1 })], [row({ revision: 2, last_save_id: SAVE })]);
    batch.mockResolvedValueOnce(rowsOf([], [], [], [row({ revision: 2, last_save_id: SAVE })]));
    expect(await saveFormDraft(actor, draft({ baseRevision: 1 }))).toMatchObject({ ok: true, revision: 2, created: false });

    batch.mockReset();
    readQueue.length = 0;
    readQueue.push([row({ revision: 1 })], [{ status: "arrived", native: true, visit_found: true, visit_live: true, my_row: true, my_live_row: true, form_found: true, form_active: true, form_version: 1 }]);
    batch.mockResolvedValueOnce(rowsOf([], [], [], [row({ revision: 3 })]));
    expect(await saveFormDraft(actor, draft({ baseRevision: 1 }))).toEqual({ ok: false, reason: "stale", revision: 3 });

    batch.mockReset();
    readQueue.length = 0;
    readQueue.push([row({ revision: 1 })], [{ status: "cancelled", native: true, visit_found: true, visit_live: false }]);
    batch.mockResolvedValueOnce(rowsOf([], [], [], [row({ revision: 1 })]));
    expect(await saveFormDraft(actor, draft({ baseRevision: 1 }))).toEqual({ ok: false, reason: "job_closed" });
  });

  it("a deadlock is STALE, never a 500", async () => {
    readQueue.push([row()]);
    batch.mockRejectedValueOnce(Object.assign(new Error("deadlock"), { code: "40P01" }));
    expect(await saveFormDraft(actor, draft({ baseRevision: 1 }))).toEqual({ ok: false, reason: "stale", revision: 1 });
  });
});

describe("submitForm (spec §5.3)", () => {
  it("missing required → form_incomplete with the ids, no batch", async () => {
    readQueue.push([row()]);
    expect(await submitForm(actor, draft({ baseRevision: 1, changes: { [NUM.id]: 5 } }), { submitKey: KEY })).toEqual({
      ok: false, reason: "form_incomplete", fieldIds: [TICK.id],
    });
    expect(batch).not.toHaveBeenCalled();
  });

  it("submits with the derived key and an in-batch audit gated on status, key and xmin", async () => {
    readQueue.push([row()]);
    batch.mockResolvedValueOnce(rowsOf([], [], [{ id: SID, revision: 2, updated_at: T0, submitted_at: T0 }], [{ id: "a" }], [row()]));
    expect(await submitForm(actor, draft({ baseRevision: 1 }), { submitKey: KEY.toUpperCase() })).toEqual({
      ok: true, submissionId: SID, revision: 2, submittedAt: T0,
    });
    const s = stmts();
    expect(s).toHaveLength(5);
    expect(s[0]).toBe(LOCK);
    expect(s[2]).toContain(VISIT_GATE);
    expect(s[2]).toContain("EXISTS (SELECT 1 FROM service_requests rg");
    expect(s[2]).toContain("status = 'submitted', submitted_by = $");
    expect(s[2]).toContain("submitted_at = now(), submit_key = $");
    expect(s[2]).not.toContain("last_save_id");
    expect(s[3]).toMatch(/^INSERT INTO audit_log \(organization_id, user_id, action, entity, entity_id, details\) SELECT s.organization_id, \$1::uuid, 'form_submitted', 'form_submissions', s.id, json_build_object\('formId', s.form_id, 'appointmentId', s.appointment_id, 'formVersion', s.form_version\)::text/);
    expect(s[3]).toContain("AND s.status = 'submitted' AND s.submit_key = $");
    expect(s[3]).toContain("AND s.xmin = pg_current_xact_id()::xid");
    expect(params(2)).toContain(KEY);
    expect(params(3)).toContain(KEY);
  });

  it("a takeover re-run of a committed submit answers 200 from the pre-read", async () => {
    readQueue.push([row({ status: "submitted", submit_key: KEY, submitted_at: T0, revision: 2 })]);
    expect(await submitForm(actor, draft({ baseRevision: 1 }), { submitKey: KEY })).toEqual({ ok: true, submissionId: SID, revision: 2, submittedAt: T0 });
    expect(batch).not.toHaveBeenCalled();
  });

  it("zero rows: a concurrent run of this submit key that committed → 200 from the tail", async () => {
    readQueue.push([row()], [{ status: "arrived", native: true, visit_found: true, visit_live: true, my_row: true, my_live_row: true, form_found: true, form_active: true, form_version: 1 }]);
    batch.mockResolvedValueOnce(rowsOf([], [], [], [], [row({ status: "submitted", submit_key: KEY, submitted_at: T0, revision: 2 })]));
    expect(await submitForm(actor, draft({ baseRevision: 1 }), { submitKey: KEY })).toEqual({ ok: true, submissionId: SID, revision: 2, submittedAt: T0 });
  });

  it("submitted by someone else → form_submitted", async () => {
    readQueue.push([row({ status: "submitted", submit_key: SAVE, submitted_at: T0 })]);
    expect(await submitForm(actor, draft({ baseRevision: 1 }), { submitKey: KEY })).toEqual({ ok: false, reason: "form_submitted" });
  });
});

describe("zeroRowOutcome", () => {
  const g: FormGates = {
    status: "arrived", native: true, customerErased: false, visitFound: true, visitLive: true, myRow: true,
    myLiveRow: true, myProgress: false, formFound: true, formActive: true, formVersion: 1,
  };
  const tail = (over: Partial<SubmissionRow> = {}): SubmissionRow => ({
    id: SID, status: "draft", revision: 2, formVersion: 1, erased: false, lastSaveId: null, submitKey: null,
    updatedAt: T0, submittedAt: null, fields: FIELDS, valuesEncrypted: null, ...over,
  });
  const inp = { formVersion: 1, baseRevision: 1 };
  it("no row: gates, then form found / active / version, then stale 0", () => {
    expect(zeroRowOutcome(null, { ...g, myLiveRow: false }, inp)).toEqual({ kind: "fail", fail: { ok: false, reason: "not_assigned" } });
    expect(zeroRowOutcome(null, { ...g, formFound: false }, inp)).toEqual({ kind: "fail", fail: { ok: false, reason: "not_found" } });
    expect(zeroRowOutcome(null, { ...g, formActive: false }, inp)).toEqual({ kind: "fail", fail: { ok: false, reason: "form_archived" } });
    expect(zeroRowOutcome(null, { ...g, formVersion: 2 }, inp)).toEqual({ kind: "fail", fail: { ok: false, reason: "form_changed" } });
    expect(zeroRowOutcome(null, g, inp)).toEqual({ kind: "fail", fail: { ok: false, reason: "stale", revision: 0 } });
  });
  it("row: erased, submitted, version, gates, stale", () => {
    expect(zeroRowOutcome(tail({ erased: true }), g, inp)).toMatchObject({ fail: { reason: "answers_removed" } });
    expect(zeroRowOutcome(tail({ status: "submitted" }), g, inp)).toMatchObject({ fail: { reason: "form_submitted" } });
    expect(zeroRowOutcome(tail({ status: "submitted", submitKey: KEY }), g, { ...inp, submitKey: KEY })).toEqual({ kind: "replay" });
    expect(zeroRowOutcome(tail({ formVersion: 2 }), g, inp)).toMatchObject({ fail: { reason: "form_changed" } });
    expect(zeroRowOutcome(tail(), { ...g, customerErased: true }, inp)).toMatchObject({ fail: { reason: "customer_removed" } });
    expect(zeroRowOutcome(tail({ revision: 5 }), g, inp)).toMatchObject({ fail: { reason: "stale", revision: 5 } });
  });
});

describe("decryptValues", () => {
  it("null → {}; a non-object or bad blob → unreadable", () => {
    expect(decryptValues(null)).toEqual({});
    expect(decryptValues("BAD")).toBe("unreadable");
    expect(decryptValues("ENC:[1]")).toBe("unreadable");
    expect(decryptValues('ENC:{"a":1}')).toEqual({ a: 1 });
  });
});

describe("leave-time field-wise merge (lead ruling R1(b))", () => {
  const enc = (v: Record<string, unknown>) => `ENC:${JSON.stringify(v)}`;
  const GATES = { status: "arrived", native: true, visit_found: true, visit_live: true, my_row: true, my_live_row: true, form_found: true, form_active: true, form_version: 1 };
  // A colleague set NUM (absent → 120) at revision 2; this phone, based on revision 1, changed NUM and TICK.
  const theirs = () => row({ revision: 2, values_encrypted: enc({ [NUM.id]: 120 }) });
  const leaveDraft = (over: Partial<DraftInput> = {}) =>
    draft({ baseRevision: 1, leave: true, changes: { [NUM.id]: 118, [TICK.id]: true }, bases: { [NUM.id]: null }, ...over });

  it("applies only the fields whose stored value is still the base, gated on the merged revision, same saveId", async () => {
    readQueue.push([theirs()], [theirs()]);
    batch.mockResolvedValueOnce(rowsOf([], [], [{ id: SID, revision: 3, updated_at: T0 }], [row({ revision: 3 })]));
    expect(await saveFormDraft(actor, leaveDraft())).toEqual({ ok: true, submissionId: SID, revision: 3, savedAt: T0, created: false, skipped: [NUM.id] });
    const s = stmts();
    expect(s[0]).toBe(LOCK);
    expect(s[2]).toContain("last_save_id = $3::uuid");
    expect(s[2]).toContain(VISIT_GATE);
    expect(params(2)[0]).toBe(enc({ [NUM.id]: 120, [TICK.id]: true }));
    expect(params(2)[2]).toBe(SAVE);
    expect(params(2).slice(7, 9)).toEqual([2, 1]);
  });

  it("without leave a moved revision stays STALE (spec §4.2), no batch", async () => {
    readQueue.push([theirs()]);
    expect(await saveFormDraft(actor, leaveDraft({ leave: undefined }))).toEqual({ ok: false, reason: "stale", revision: 2 });
    expect(batch).not.toHaveBeenCalled();
  });

  it("every field skipped, or a retry whose fields already hold my values: 200 with nothing written", async () => {
    readQueue.push([theirs()], [theirs()]);
    expect(await saveFormDraft(actor, leaveDraft({ changes: { [NUM.id]: 118 } }))).toEqual({
      ok: true, submissionId: SID, revision: 2, savedAt: T0, created: false, skipped: [NUM.id],
    });
    const mergedRow = row({ revision: 3, last_save_id: SAVE, values_encrypted: enc({ [NUM.id]: 120, [TICK.id]: true }) });
    readQueue.push([mergedRow], [mergedRow]);
    expect(await saveFormDraft(actor, leaveDraft())).toMatchObject({ ok: true, revision: 3, skipped: [NUM.id] });
    expect(batch).not.toHaveBeenCalled();
  });

  it("unreadable stored answers stay refused; erased, submitted and other version keep their codes", async () => {
    for (const [r, reason] of [
      [row({ revision: 2, values_encrypted: "BAD" }), "answers_unreadable"],
      [row({ revision: 2, fields: "nope" }), "answers_unreadable"],
    ] as const) {
      readQueue.push([r], [r]);
      expect(await saveFormDraft(actor, leaveDraft())).toEqual({ ok: false, reason });
    }
    readQueue.push([row({ revision: 2, erased: true })]);
    expect(await saveFormDraft(actor, leaveDraft())).toEqual({ ok: false, reason: "answers_removed" });
    expect(batch).not.toHaveBeenCalled();
  });

  it("a write that lands between the read and the lock: re-read, merge again against the newer row", async () => {
    const newer = row({ revision: 3, values_encrypted: enc({ [NUM.id]: 120, [TICK.id]: true }) });
    readQueue.push([theirs()], [theirs()], [GATES], [newer]);
    batch
      .mockResolvedValueOnce(rowsOf([], [], [], [newer]))
      .mockResolvedValueOnce(rowsOf([], [], [{ id: SID, revision: 4, updated_at: T0 }], [row({ revision: 4 })]));
    // On the newer row TICK already holds my value and NUM is a colleague's → nothing to apply.
    expect(await saveFormDraft(actor, leaveDraft())).toMatchObject({ ok: true, revision: 3, skipped: [NUM.id] });
    expect(batch).toHaveBeenCalledTimes(1);
  });

  it("gives up as STALE after repeated races; a gate refusal is returned as is", async () => {
    readQueue.push([theirs()]);
    for (let i = 0; i < 3; i++) {
      readQueue.push([theirs()], [GATES]);
      batch.mockResolvedValueOnce(rowsOf([], [], [], [row({ revision: 9 })]));
    }
    expect(await saveFormDraft(actor, leaveDraft())).toEqual({ ok: false, reason: "stale", revision: 9 });
    expect(batch).toHaveBeenCalledTimes(3);
    batch.mockReset();
    readQueue.length = 0;
    readQueue.push([theirs()], [theirs()], [{ ...GATES, status: "cancelled", visit_live: false }]);
    batch.mockResolvedValueOnce(rowsOf([], [], [], [theirs()]));
    expect(await saveFormDraft(actor, leaveDraft())).toEqual({ ok: false, reason: "job_closed" });
  });
});
