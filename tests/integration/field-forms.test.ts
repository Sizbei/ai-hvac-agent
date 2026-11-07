import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
// The erase's R2 cleanup runs in after(): capture it instead of needing a request scope.
const afterCallbacks: Array<() => unknown> = [];
vi.mock("next/server", async (orig) => ({
  ...(await orig<typeof import("next/server")>()),
  after: (cb: () => unknown) => {
    afterCallbacks.push(cb);
  },
}));
const deletedKeys: string[] = [];
vi.mock("@/lib/storage/r2-client", async (orig) => ({
  ...(await orig<typeof import("@/lib/storage/r2-client")>()),
  getStorageClient: () => ({
    deleteFile: async (key: string) => {
      deletedKeys.push(key);
    },
  }),
}));

/**
 * Field forms integration suite (M3d spec §9 (a)–(n), v4.1) against the DEV
 * database (`VITEST_INTEGRATION=1`). Drives the writers exactly as the routes
 * do (`submitVia` mirrors the submit route's run body), never HTTP. Two
 * throwaway orgs via createOrgCore (the second for tenancy), deleted in
 * afterAll even on failure. Fixture UPDATEs are by id AND organization_id. No
 * customer phone is ever set; nothing queues a message.
 */

type FW = typeof import("@/lib/tech/form-writes");
type FQ = typeof import("@/lib/admin/form-queries");
type FR = typeof import("@/lib/tech/form-reads");
type SQ = typeof import("@/lib/tech/site-queries");
type ID = typeof import("@/lib/http/idempotency");
type Db = typeof import("@/lib/db");
type Row = Record<string, unknown>;
type RunOut = Awaited<ReturnType<ID["withIdempotency"]>>;
type FormDef = import("@/lib/forms/form-schema").FormDefinition;
type Changes = import("@/lib/forms/form-values").Changes;

let fw: FW; let fq: FQ; let fr: FR; let sq: SQ; let idem: ID;
let db: Db["db"];
let sql: typeof import("drizzle-orm").sql;
let encrypt: typeof import("@/lib/crypto").encrypt;
let okResult: typeof import("@/lib/tech/invoice-write-route").okResult;
let formReasonResult: typeof import("@/lib/tech/form-errors").formReasonResult;
let submitHashInput: typeof import("@/lib/tech/form-submit-hash").submitHashInput;
let anonymizeCustomer: typeof import("@/lib/admin/erasure-queries").anonymizeCustomer;
let deleteCustomer: typeof import("@/lib/admin/crm-queries").deleteCustomer;
let addJobPhoto: typeof import("@/lib/tech/photo-writes").addJobPhoto;
let runBatch: typeof import("@/lib/admin/invoice-field-writes").runBatch;
let lockRequestSql: typeof import("@/lib/admin/invoice-field-writes").lockRequestSql;
let carryForNewVersion: typeof import("@/lib/tech/form-fill-state").carryForNewVersion;
let mergeDraft: typeof import("@/lib/forms/form-values").mergeDraft;

let org = "";
let org2 = "";
let admin = "";
let lead = "";
let helper = "";
let jobType = "";

const SECRET = "Gate code 4471 behind the shed";
const F = {
  a: "f_aaaaaaaaa1", b: "f_aaaaaaaaa2", c: "f_aaaaaaaaa3", d: "f_aaaaaaaaa4", psi: "f_aaaaaaaaa5", note: "f_aaaaaaaaa6",
} as const;

async function run(statement: ReturnType<typeof sql>): Promise<Row[]> {
  return (await db.execute(statement)).rows as Row[];
}

/** 4 checkboxes (2 required) + a psi number with a usual range + a long answer. */
function checklist(name = `Maintenance checklist ${randomUUID().slice(0, 6)}`, over: Partial<FormDef> = {}): FormDef {
  return {
    name, description: null, jobTypeIds: [], required: true,
    fields: [
      { id: F.a, type: "checkbox", label: "Filter changed", required: true },
      { id: F.b, type: "checkbox", label: "Coil cleaned", required: true },
      { id: F.c, type: "checkbox", label: "Drain flushed", required: false },
      { id: F.d, type: "checkbox", label: "Thermostat checked", required: false },
      { id: F.psi, type: "number", label: "Suction pressure", required: false, unit: "psi", usualMin: 100, usualMax: 140 },
      { id: F.note, type: "long_text", label: "Findings", required: false },
    ],
    ...over,
  };
}

async function newForm(def: FormDef = checklist()): Promise<string> {
  const r = await fq.createForm(org, admin, randomUUID(), def);
  if (!r.ok) throw new Error(r.reason);
  return r.id;
}

async function newTech(name: string): Promise<string> {
  return (await run(sql`INSERT INTO users (organization_id,email,name,role,password_hash,is_active)
    VALUES (${org},'tech-'||gen_random_uuid()||'@throwaway.example',${name},'technician','x',true) RETURNING id`))[0]!.id as string;
}

async function newCustomer(): Promise<string> {
  return (await run(sql`INSERT INTO customers (organization_id,name_encrypted) VALUES (${org},${encrypt("Pat Probe")}) RETURNING id`))[0]!.id as string;
}

/** A request assigned to `lead` (the trigger makes visit #1 + the lead row). */
async function newJob(o: {
  status?: string; customerId?: string | null; fieldpulse?: boolean; address?: string | null; locationId?: string | null;
  jobTypeId?: string | null; scheduled?: boolean;
} = {}): Promise<string> {
  const sess = (await run(sql`INSERT INTO customer_sessions (organization_id,token) VALUES (${org},gen_random_uuid()::text) RETURNING id`))[0]!.id as string;
  return (await run(sql`INSERT INTO service_requests (organization_id,session_id,assigned_to,customer_id,location_id,job_type_id,issue_type,urgency,description,reference_number,scheduled_date,status,fieldpulse_job_id,address_encrypted)
    VALUES (${org},${sess},${lead},${o.customerId ?? null},${o.locationId ?? null},${o.jobTypeId ?? null},'no_heat','medium','Form probe','FRM-'||substr(md5(random()::text),1,8),
      ${o.scheduled === false ? null : new Date().toISOString()}::timestamptz,${o.status ?? "arrived"}::request_status,
      ${o.fieldpulse ? `fp-${randomUUID().slice(0, 8)}` : null},${o.address ? encrypt(o.address) : null})
    RETURNING id`))[0]!.id as string;
}

async function visitOf(rid: string, n = 1): Promise<string> {
  return (await run(sql`SELECT id FROM appointments WHERE service_request_id = ${rid} AND organization_id = ${org} AND appointment_number = ${n}`))[0]!.id as string;
}

async function addVisit(rid: string, n: number): Promise<string> {
  return (await run(sql`INSERT INTO appointments (organization_id,service_request_id,appointment_number,scheduled_date) VALUES (${org},${rid},${n},now()) RETURNING id`))[0]!.id as string;
}

async function assign(aid: string, tech: string, o: { arrived?: boolean; lead?: boolean } = {}): Promise<void> {
  await run(sql`INSERT INTO appointment_assignments (organization_id,appointment_id,technician_id,is_lead,status,arrived_at)
    VALUES (${org},${aid},${tech},${o.lead ?? false},${o.arrived ? "arrived" : "assigned"}::request_status,${o.arrived ? new Date().toISOString() : null}::timestamptz)
    ON CONFLICT (appointment_id, technician_id) DO UPDATE SET status = EXCLUDED.status, arrived_at = EXCLUDED.arrived_at`);
}

const actor = (rid: string, me = lead) => ({ organizationId: org, requestId: rid, techUserId: me });

function draft(rid: string, aid: string, formId: string, changes: Changes, o: { me?: string; base?: number; version?: number; saveId?: string } = {}) {
  return fw.saveFormDraft(actor(rid, o.me), {
    formId, appointmentId: aid, formVersion: o.version ?? 1, baseRevision: o.base ?? 0, saveId: o.saveId ?? randomUUID(), changes,
  });
}

/** The submit route's run body. */
function submitVia(rid: string, aid: string, formId: string, key: string, changes: Changes, o: { me?: string; base?: number; version?: number } = {}): Promise<RunOut> {
  const me = o.me ?? lead;
  const body = { appointmentId: aid, formVersion: o.version ?? 1, baseRevision: o.base ?? 0, changes };
  const scope = { organizationId: org, userId: me, route: `/api/tech/jobs/${rid}/forms/${formId}/submit`, key };
  return idem.withIdempotency(scope, idem.canonicalHash(submitHashInput(body)), async (ids) => {
    const r = await fw.submitForm(actor(rid, me), { ...body, formId }, { submitKey: ids.id("form-submit") });
    if (!r.ok) return formReasonResult(r);
    return okResult(200, { submissionId: r.submissionId, revision: r.revision, submittedAt: r.submittedAt });
  });
}

const code = (r: { ok: boolean; reason?: string }) => (r.ok ? "ok" : r.reason);
const envCode = (r: RunOut): string | undefined => (r.envelope.success ? undefined : r.envelope.error.code);
const ALL_REQUIRED: Changes = { [F.a]: true, [F.b]: true };

async function row(rid: string, aid: string, formId: string): Promise<Row | undefined> {
  return (await run(sql`SELECT * FROM form_submissions WHERE organization_id = ${org} AND service_request_id = ${rid} AND appointment_id = ${aid} AND form_id = ${formId}`))[0];
}
async function auditCount(action: string, entityId: string): Promise<number> {
  return Number((await run(sql`SELECT count(*)::int AS n FROM audit_log WHERE organization_id = ${org} AND action = ${action} AND entity_id = ${entityId}`))[0]!.n);
}
async function techView(rid: string, formId: string, aid: string, me = lead) {
  const r = await fr.getJobForm(org, me, rid, formId, aid);
  if (r.kind !== "ok") throw new Error(`view ${r.kind}`);
  return r.view;
}

beforeAll(async () => {
  for (const line of readFileSync(".env.local", "utf8").split("\n")) {
    const m = line.match(/^([A-Z_0-9]+)=(.*)$/);
    if (m && !process.env[m[1]!]) process.env[m[1]!] = m[2]!.replace(/^"|"$/g, "");
  }
  const url = process.env.DATABASE_URL ?? "";
  if (!url) throw new Error("DATABASE_URL missing from .env.local");
  if (url.includes("ep-withered-hill")) throw new Error("Refusing to run against the production database");

  ({ sql } = await import("drizzle-orm"));
  ({ db } = await import("@/lib/db"));
  ({ encrypt } = await import("@/lib/crypto"));
  fw = await import("@/lib/tech/form-writes");
  fq = await import("@/lib/admin/form-queries");
  fr = await import("@/lib/tech/form-reads");
  sq = await import("@/lib/tech/site-queries");
  idem = await import("@/lib/http/idempotency");
  ({ okResult } = await import("@/lib/tech/invoice-write-route"));
  ({ formReasonResult } = await import("@/lib/tech/form-errors"));
  ({ submitHashInput } = await import("@/lib/tech/form-submit-hash"));
  ({ anonymizeCustomer } = await import("@/lib/admin/erasure-queries"));
  ({ deleteCustomer } = await import("@/lib/admin/crm-queries"));
  ({ addJobPhoto } = await import("@/lib/tech/photo-writes"));
  ({ carryForNewVersion } = await import("@/lib/tech/form-fill-state"));
  ({ runBatch, lockRequestSql } = await import("@/lib/admin/invoice-field-writes"));
  ({ mergeDraft } = await import("@/lib/forms/form-values"));
  const { createOrgCore } = await import("@/lib/admin/provisioning");

  const mkOrg = async (label: string) => {
    const out = await createOrgCore({
      name: `Probe Org Field Forms ${label} ${randomUUID().slice(0, 8)}`,
      createdBy: null,
      ownerEmail: null,
      ownerUser: { email: `owner-${randomUUID()}@throwaway.example`, name: "Probe Owner", googleId: `probe-${randomUUID()}` },
      skipOrgCountCheck: true,
    });
    if (!out.ok) throw new Error(`createOrgCore failed: ${JSON.stringify(out.error)}`);
    return out.result;
  };
  const a = await mkOrg("A");
  org = a.organizationId;
  admin = a.ownerUserId!;
  org2 = (await mkOrg("B")).organizationId;
  lead = await newTech("Alex Rivera");
  helper = await newTech("Sam Lee");
  jobType = (await run(sql`SELECT id FROM job_types WHERE organization_id = ${org} ORDER BY position LIMIT 1`))[0]!.id as string;
}, 90_000);

afterAll(async () => {
  for (const id of [org, org2].filter(Boolean)) {
    try {
      await db.execute(sql`DELETE FROM organizations WHERE id = ${id}`);
    } catch (error) {
      console.error(`afterAll: could not delete probe org ${id}`, error);
    }
  }
}, 60_000);

describe("field forms (dev DB)", () => {
  it("(a) createForm twice with one token → one row; empty definition refused; stale PATCH; duplicate name", async () => {
    const token = randomUUID();
    const def = checklist();
    const one = await fq.createForm(org, admin, token, def);
    const two = await fq.createForm(org, admin, token, def);
    expect(one).toMatchObject({ ok: true, created: true });
    expect(two).toMatchObject({ ok: true, created: false });
    if (!one.ok || !two.ok) return;
    expect(two.id).toBe(one.id);
    expect(Number((await run(sql`SELECT count(*)::int AS n FROM forms WHERE organization_id = ${org} AND name = ${def.name}`))[0]!.n)).toBe(1);

    // An empty definition (headings only) is refused by the route's schema before any write: no row.
    const { formDefinitionSchema } = await import("@/lib/forms/form-schema");
    const countForms = async () => Number((await run(sql`SELECT count(*)::int AS n FROM forms WHERE organization_id = ${org}`))[0]!.n);
    const before = await countForms();
    expect(formDefinitionSchema.safeParse({ ...def, fields: [{ id: F.a, type: "heading", label: "H", required: false }] }).success).toBe(false);
    expect(await countForms()).toBe(before);

    expect(await fq.updateForm(org, one.id, { version: 1, definition: { ...def, required: false } })).toEqual({ ok: true, version: 2 });
    expect(await fq.updateForm(org, one.id, { version: 1, definition: def })).toEqual({ ok: false, reason: "stale" });
    expect(await fq.createForm(org, admin, randomUUID(), { ...def, name: def.name.toUpperCase() })).toEqual({ ok: false, reason: "name_taken" });
  }, 60_000);

  it("(b) done-when: helper saves, reload shows the draft, replays, untick after a lost tick, FORM_INCOMPLETE, submit, replays", async () => {
    const formId = await newForm();
    const rid = await newJob({ status: "scheduled" });
    const v1 = await visitOf(rid);
    await assign(v1, helper, { arrived: true });

    const save1 = randomUUID();
    const s1 = await draft(rid, v1, formId, { [F.a]: true, [F.c]: true, [F.psi]: 180 }, { me: helper, saveId: save1 });
    expect(s1).toMatchObject({ ok: true, revision: 1, created: true });
    const view = await techView(rid, formId, v1, helper);
    expect(view.submission?.values).toEqual({ [F.a]: true, [F.c]: true, [F.psi]: 180 });
    expect(view.canWrite).toBe(true);

    // The same saveId again → replay.
    expect(await draft(rid, v1, formId, { [F.a]: true, [F.c]: true, [F.psi]: 180 }, { me: helper, saveId: save1 })).toMatchObject({ ok: true, revision: 1, created: false });
    // A colleague's long answer, then a replay: the helper's next save lands and its retry is still a replay
    // (checked before any decrypt, apply or measure). No valid form reaches the 128 KB cap (lead ruling 5).
    await assign(v1, lead, { arrived: true });
    expect(await draft(rid, v1, formId, { [F.note]: "€".repeat(2000) }, { base: 1 })).toMatchObject({ ok: true, revision: 2 });
    const save2 = randomUUID();
    expect(await draft(rid, v1, formId, { [F.psi]: 120 }, { me: helper, base: 2, saveId: save2 })).toMatchObject({ ok: true, revision: 3 });
    expect(await draft(rid, v1, formId, { [F.psi]: 120 }, { me: helper, base: 2, saveId: save2 })).toMatchObject({ ok: true, revision: 3, created: false });
    // A stale retry of the first save is STALE, not a replay.
    expect(await draft(rid, v1, formId, { [F.a]: true, [F.c]: true, [F.psi]: 180 }, { me: helper, saveId: save1 })).toMatchObject({ ok: false, reason: "stale", revision: 3 });

    // Tick (response lost), untick, retry the first then the second → unticked.
    const tick = randomUUID();
    const untick = randomUUID();
    expect(await draft(rid, v1, formId, { [F.d]: true }, { me: helper, base: 3, saveId: tick })).toMatchObject({ ok: true, revision: 4 });
    expect(await draft(rid, v1, formId, { [F.d]: true }, { me: helper, base: 3, saveId: tick })).toMatchObject({ ok: true, revision: 4 });
    expect(await draft(rid, v1, formId, { [F.d]: null }, { me: helper, base: 4, saveId: untick })).toMatchObject({ ok: true, revision: 5 });
    expect(await draft(rid, v1, formId, { [F.d]: null }, { me: helper, base: 4, saveId: untick })).toMatchObject({ ok: true, revision: 5 });
    expect((await techView(rid, formId, v1, helper)).submission?.values?.[F.d]).toBeUndefined();

    const key1 = randomUUID();
    const missing = await submitVia(rid, v1, formId, key1, {}, { me: helper, base: 5 });
    expect([missing.status, envCode(missing)]).toEqual([400, "FORM_INCOMPLETE"]);
    const key2 = randomUUID();
    const done = await submitVia(rid, v1, formId, key2, ALL_REQUIRED, { me: helper, base: 5 });
    expect(done.status).toBe(200);
    const r = await row(rid, v1, formId);
    expect(r).toMatchObject({ status: "submitted", submitted_by: helper });
    expect(await auditCount("form_submitted", String(r!.id))).toBe(1);

    const again = await submitVia(rid, v1, formId, key2, ALL_REQUIRED, { me: helper, base: 5 });
    expect([again.status, again.replayed]).toEqual([200, true]);
    expect(envCode(await submitVia(rid, v1, formId, randomUUID(), ALL_REQUIRED, { me: helper, base: 6 }))).toBe("FORM_SUBMITTED");
    expect(await draft(rid, v1, formId, { [F.c]: null }, { me: helper, base: 6 })).toMatchObject({ ok: false, reason: "form_submitted" });
    expect(await auditCount("form_submitted", String(r!.id))).toBe(1);
  }, 90_000);

  it("(c) submit takeover → 200 and one audit row; submit, reopen, resubmit → two; a first insert whose update misses → no audit", async () => {
    const formId = await newForm();
    const rid = await newJob();
    const v1 = await visitOf(rid);
    const key = randomUUID();
    const route = `/api/tech/jobs/${rid}/forms/${formId}/submit`;
    const scope = { organizationId: org, userId: lead, route, key };
    // The batch committed, but the key stayed claimed past the takeover window.
    expect(await fw.submitForm(actor(rid), { formId, appointmentId: v1, formVersion: 1, baseRevision: 0, changes: ALL_REQUIRED }, { submitKey: idem.derivedId(scope, "form-submit") })).toMatchObject({ ok: true });
    const body = { appointmentId: v1, formVersion: 1, baseRevision: 0, changes: ALL_REQUIRED };
    await run(sql`INSERT INTO idempotency_keys (organization_id,user_id,route,key,request_hash,state,attempt_id,created_at)
      VALUES (${org},${lead},${route},${key},${idem.canonicalHash(submitHashInput(body))},'in_progress',${randomUUID()},now() - interval '3 minutes')`);
    const taken = await submitVia(rid, v1, formId, key, ALL_REQUIRED);
    expect(taken.status).toBe(200);
    const sid = String((await row(rid, v1, formId))!.id);
    expect(await auditCount("form_submitted", sid)).toBe(1);

    const rev = Number((await row(rid, v1, formId))!.revision);
    expect(await fq.reopenSubmission(org, rid, sid, rev)).toMatchObject({ ok: true, changed: true });
    expect((await submitVia(rid, v1, formId, randomUUID(), ALL_REQUIRED, { base: rev + 1 })).status).toBe(200);
    expect(await auditCount("form_submitted", sid)).toBe(2);

    // A first-insert batch whose UPDATE misses writes no audit row. The writer refuses a non-zero base with
    // no row before batching (lead ruling 4), so drive the writer's own statements directly.
    const form2 = await newForm();
    const sub = { formId: form2, appointmentId: v1, formVersion: 1, baseRevision: 5, changes: ALL_REQUIRED };
    const k2 = randomUUID();
    const out = await runBatch([
      lockRequestSql(org, rid),
      fw.insertSubmissionSql(actor(rid), sub),
      fw.updateSubmissionSql(actor(rid), sub, null, sql`, status = 'submitted', submitted_by = ${lead}::uuid, submitted_at = now(), submit_key = ${k2}::uuid`),
      fw.submitAuditSql(actor(rid), sub, k2),
    ]);
    if (!Array.isArray(out)) throw new Error("batch");
    expect([out[1]!.length, out[2]!.length, out[3]!.length]).toEqual([1, 0, 0]);
    const created = await row(rid, v1, form2);
    expect(created).toMatchObject({ status: "draft", revision: 0 });
    expect(await auditCount("form_submitted", String(created!.id))).toBe(0);
    // Through the writer, the same request is STALE with nothing created.
    const form3 = await newForm();
    expect(envCode(await submitVia(rid, v1, form3, randomUUID(), ALL_REQUIRED, { base: 5 }))).toBe("STALE");
    expect(await row(rid, v1, form3)).toBeUndefined();
  }, 90_000);

  it("(d) two technicians from revision 0 at once → one lands, one STALE", async () => {
    const formId = await newForm();
    const rid = await newJob();
    const v1 = await visitOf(rid);
    await assign(v1, helper, { arrived: true });
    const [x, y] = await Promise.all([draft(rid, v1, formId, { [F.a]: true }), draft(rid, v1, formId, { [F.b]: true }, { me: helper })]);
    expect([code(x), code(y)].sort()).toEqual(["ok", "stale"]);
  }, 60_000);

  it("(d2) leave-time save (R1(b)): a colleague saved A; a leave save of A (from the old base) and B applies B only", async () => {
    const formId = await newForm();
    const rid = await newJob();
    const v1 = await visitOf(rid);
    await assign(v1, helper, { arrived: true });
    expect(await draft(rid, v1, formId, { [F.psi]: 118 })).toMatchObject({ ok: true, revision: 1 });
    expect(await draft(rid, v1, formId, { [F.psi]: 120 }, { me: helper, base: 1 })).toMatchObject({ ok: true, revision: 2 });
    const leave = { formId, appointmentId: v1, formVersion: 1, baseRevision: 1, changes: { [F.psi]: 125, [F.note]: "Coil iced" }, bases: { [F.psi]: 118 } };
    // Without leave the same save is STALE, as before.
    expect(await fw.saveFormDraft(actor(rid), { ...leave, saveId: randomUUID() })).toEqual({ ok: false, reason: "stale", revision: 2 });
    const saveId = randomUUID();
    expect(await fw.saveFormDraft(actor(rid), { ...leave, saveId, leave: true })).toMatchObject({ ok: true, revision: 3, skipped: [F.psi] });
    expect((await techView(rid, formId, v1)).submission?.values).toEqual({ [F.psi]: 120, [F.note]: "Coil iced" });
    expect(String((await row(rid, v1, formId))!.last_save_id)).toBe(saveId);
    // A retry writes nothing more and still reports the colleague's field.
    expect(await fw.saveFormDraft(actor(rid), { ...leave, saveId, leave: true })).toMatchObject({ ok: true, revision: 3, skipped: [F.psi] });
  }, 60_000);

  it("(e) a version-1 draft submits on version 1 after the office saves v2; FORM_CHANGED carry keeps a colleague's answers", async () => {
    const def = checklist();
    const formId = await newForm(def);
    const rid = await newJob();
    const v1 = await visitOf(rid);
    expect(await draft(rid, v1, formId, ALL_REQUIRED)).toMatchObject({ ok: true });
    const v2def: FormDef = { ...def, fields: [...def.fields, { id: "f_aaaaaaaaa7", type: "short_text", label: "Filter size", required: false }] };
    expect(await fq.updateForm(org, formId, { version: 1, definition: v2def })).toEqual({ ok: true, version: 2 });
    expect((await submitVia(rid, v1, formId, randomUUID(), {}, { base: 1, version: 1 })).status).toBe(200);
    expect((await row(rid, v1, formId))!.form_version).toBe(1);

    const v2 = await addVisit(rid, 2);
    await assign(v2, lead, { arrived: true, lead: true });
    await assign(v2, helper, { arrived: true });
    expect(await draft(rid, v2, formId, { "f_aaaaaaaaa7": "16x25x1" }, { me: helper, version: 2 })).toMatchObject({ ok: true, revision: 1 });
    expect(await draft(rid, v2, formId, { [F.c]: true }, { version: 1 })).toMatchObject({ ok: false, reason: "form_changed" });
    // The page carries base and mine to v2 and merges over the re-read row.
    const reread = await techView(rid, formId, v2);
    const carried = carryForNewVersion(reread.form.fields, {}, { [F.c]: true });
    const merged = mergeDraft(carried.base, carried.mine, reread.submission!.values!);
    expect(merged.values).toEqual({ "f_aaaaaaaaa7": "16x25x1", [F.c]: true });
    expect(await draft(rid, v2, formId, carried.mine, { version: 2, base: reread.submission!.revision })).toMatchObject({ ok: true, revision: 2 });
    expect((await techView(rid, formId, v2)).submission?.values).toEqual({ "f_aaaaaaaaa7": "16x25x1", [F.c]: true });
  }, 90_000);

  it("(f) gates: other visit, helper arrival arm, not on site, ended visit, other org, cancelled, completed", async () => {
    const formId = await newForm();
    const rid = await newJob({ status: "scheduled" });
    const v1 = await visitOf(rid);
    const v2 = await addVisit(rid, 2);
    await assign(v1, helper, { arrived: true });
    expect(await draft(rid, v2, formId, { [F.a]: true }, { me: helper })).toMatchObject({ ok: false, reason: "not_assigned" });
    expect(await draft(rid, v1, formId, { [F.a]: true }, { me: helper })).toMatchObject({ ok: true });
    expect(await draft(rid, v1, formId, { [F.b]: true }, { base: 1 })).toMatchObject({ ok: false, reason: "not_on_site" });
    // Unassigned from a visit that already has a row: the UPDATE's own visit gate refuses.
    await run(sql`UPDATE appointment_assignments SET status = 'cancelled'::request_status
      WHERE appointment_id = ${v1} AND technician_id = ${helper} AND organization_id = ${org}`);
    expect(await draft(rid, v1, formId, { [F.c]: true }, { me: helper, base: 1 })).toMatchObject({ ok: false, reason: "not_assigned" });
    expect((await row(rid, v1, formId))!.revision).toBe(1);

    const ended = await newJob();
    const ev = await visitOf(ended);
    await run(sql`UPDATE appointments SET cancelled_at = now() WHERE id = ${ev} AND organization_id = ${org}`);
    expect(await draft(ended, ev, formId, { [F.a]: true })).toMatchObject({ ok: false, reason: "visit_ended" });

    expect(await fr.getJobForms(org2, lead, rid, v1)).toEqual({ kind: "not_found" });
    expect(await fw.saveFormDraft({ organizationId: org2, requestId: rid, techUserId: lead }, {
      formId, appointmentId: v1, formVersion: 1, baseRevision: 0, saveId: randomUUID(), changes: { [F.a]: true },
    })).toMatchObject({ ok: false, reason: "not_found" });

    // A form of ANOTHER org, by its id, is never visible or writable here (tenancy, spec §9).
    const org2Owner = String((await run(sql`SELECT id FROM users WHERE organization_id = ${org2} LIMIT 1`))[0]!.id);
    const foreign = await fq.createForm(org2, org2Owner, randomUUID(), checklist(undefined, { required: true }));
    if (!foreign.ok) throw new Error(foreign.reason);
    const mine = await newJob();
    const mv = await visitOf(mine);
    expect(await fr.getJobForm(org, lead, mine, foreign.id, mv)).toEqual({ kind: "not_found" });
    expect(await draft(mine, mv, foreign.id, { [F.a]: true })).toMatchObject({ ok: false, reason: "not_found" });
    expect(await fq.getForm(org, foreign.id)).toBeNull();
    expect(await fq.updateForm(org, foreign.id, { version: 1, active: false })).toEqual({ ok: false, reason: "not_found" });
    const card = await fr.getJobForms(org, lead, mine, mv);
    if (card.kind !== "ok") throw new Error(card.kind);
    expect([...card.view.forms, ...card.view.otherForms].map((f) => f.formId)).not.toContain(foreign.id);
    expect((await fq.getRequestForms(org, mine))?.missingRequired.map((m) => m.formId)).not.toContain(foreign.id);

    const gone = await newJob();
    const gv = await visitOf(gone);
    await run(sql`UPDATE service_requests SET status = 'cancelled'::request_status WHERE id = ${gone} AND organization_id = ${org}`);
    expect(await draft(gone, gv, formId, { [F.a]: true })).toMatchObject({ ok: false, reason: "job_closed" });

    const doneJob = await newJob({ status: "completed" });
    expect(await draft(doneJob, await visitOf(doneJob), formId, { [F.a]: true })).toMatchObject({ ok: true });
  }, 90_000);

  it("(g) synced job: write and submit; cancelled → JOB_CLOSED; the trigger keeps a visit with a submission; cascades", async () => {
    const formId = await newForm();
    const rid = await newJob({ fieldpulse: true, status: "scheduled" });
    const v1 = await visitOf(rid);
    expect(await draft(rid, v1, formId, ALL_REQUIRED)).toMatchObject({ ok: true });
    expect((await submitVia(rid, v1, formId, randomUUID(), {}, { base: 1 })).status).toBe(200);

    // A sync-style UPDATE clearing assignment, date and window: the visit stays (times NULL, lead demoted).
    await run(sql`UPDATE service_requests SET assigned_to = NULL, scheduled_date = NULL, arrival_window_start = NULL, arrival_window_end = NULL
      WHERE id = ${rid} AND organization_id = ${org}`);
    const kept = await run(sql`SELECT p.id, p.scheduled_date, a.is_lead FROM appointments p LEFT JOIN appointment_assignments a ON a.appointment_id = p.id
      WHERE p.service_request_id = ${rid} AND p.organization_id = ${org}`);
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject({ id: v1, scheduled_date: null, is_lead: false });
    const office = await fq.getRequestForms(org, rid);
    expect(office?.submissions.map((s) => s.status)).toEqual(["submitted"]);

    const synced2 = await newJob({ fieldpulse: true, status: "scheduled" });
    await run(sql`UPDATE service_requests SET status = 'cancelled'::request_status WHERE id = ${synced2} AND organization_id = ${org}`);
    expect(await draft(synced2, await visitOf(synced2), formId, { [F.a]: true })).toMatchObject({ ok: false, reason: "job_closed" });

    // Native completed job with no progress: same keep.
    const nat = await newJob({ status: "completed" });
    const nv = await visitOf(nat);
    expect(await draft(nat, nv, formId, { [F.a]: true })).toMatchObject({ ok: true });
    await run(sql`UPDATE service_requests SET assigned_to = NULL, scheduled_date = NULL WHERE id = ${nat} AND organization_id = ${org}`);
    expect(await run(sql`SELECT id FROM appointments WHERE id = ${nv} AND organization_id = ${org}`)).toHaveLength(1);

    // A visit with no submission under the same UPDATE is deleted, as in 0050.
    const bare = await newJob({ status: "scheduled" });
    await run(sql`UPDATE service_requests SET assigned_to = NULL, scheduled_date = NULL WHERE id = ${bare} AND organization_id = ${org}`);
    expect(await run(sql`SELECT id FROM appointments WHERE service_request_id = ${bare} AND organization_id = ${org}`)).toHaveLength(0);

    // A direct visit delete that would orphan answers fails with the foreign key error.
    await expect(db.execute(sql`DELETE FROM appointments WHERE id = ${nv} AND organization_id = ${org}`)).rejects.toThrow();
    try {
      await db.execute(sql`DELETE FROM appointments WHERE id = ${nv} AND organization_id = ${org}`);
    } catch (error) {
      const { errorCode } = await import("@/lib/logger");
      expect(errorCode(error)).toBe("23503");
    }

    // Deleting the request (the session delete path) cascades visit and submission in one statement.
    await run(sql`DELETE FROM service_requests WHERE id = ${nat} AND organization_id = ${org}`);
    expect(await run(sql`SELECT id FROM form_submissions WHERE service_request_id = ${nat}`)).toHaveLength(0);
    expect(await run(sql`SELECT id FROM appointments WHERE id = ${nv}`)).toHaveLength(0);
  }, 120_000);

  it("(g2) purging an org with a submission succeeds and cascades it", async () => {
    const { createOrgCore } = await import("@/lib/admin/provisioning");
    const out = await createOrgCore({
      name: `Probe Org Field Forms Purge ${randomUUID().slice(0, 8)}`, createdBy: null, ownerEmail: null,
      ownerUser: { email: `owner-${randomUUID()}@throwaway.example`, name: "Probe Owner", googleId: `probe-${randomUUID()}` },
      skipOrgCountCheck: true,
    });
    if (!out.ok) throw new Error("createOrgCore failed");
    const p = out.result.organizationId;
    try {
      const t = (await run(sql`INSERT INTO users (organization_id,email,name,role,password_hash,is_active)
        VALUES (${p},'tech-'||gen_random_uuid()||'@throwaway.example','Purge Tech','technician','x',true) RETURNING id`))[0]!.id as string;
      const f = await fq.createForm(p, out.result.ownerUserId!, randomUUID(), checklist());
      if (!f.ok) throw new Error(f.reason);
      const sess = (await run(sql`INSERT INTO customer_sessions (organization_id,token) VALUES (${p},gen_random_uuid()::text) RETURNING id`))[0]!.id as string;
      const r = (await run(sql`INSERT INTO service_requests (organization_id,session_id,assigned_to,issue_type,urgency,description,reference_number,scheduled_date,status)
        VALUES (${p},${sess},${t},'no_heat','medium','Purge probe','PRG-'||substr(md5(random()::text),1,8),now(),'arrived'::request_status) RETURNING id`))[0]!.id as string;
      const a = (await run(sql`SELECT id FROM appointments WHERE service_request_id = ${r}`))[0]!.id as string;
      expect(await fw.saveFormDraft({ organizationId: p, requestId: r, techUserId: t }, {
        formId: f.id, appointmentId: a, formVersion: 1, baseRevision: 0, saveId: randomUUID(), changes: { [F.a]: true },
      })).toMatchObject({ ok: true });
      await run(sql`DELETE FROM organizations WHERE id = ${p}`);
      expect(await run(sql`SELECT id FROM form_submissions WHERE organization_id = ${p}`)).toHaveLength(0);
      expect(await run(sql`SELECT id FROM forms WHERE organization_id = ${p}`)).toHaveLength(0);
    } finally {
      await db.execute(sql`DELETE FROM organizations WHERE id = ${p}`).catch(() => undefined);
    }
  }, 90_000);

  it("(h) archived: an existing draft saves and submits; can't start on a new visit; non-applicable active forms start; Clear answers", async () => {
    const formId = await newForm();
    const rid = await newJob();
    const v1 = await visitOf(rid);
    expect(await draft(rid, v1, formId, { [F.a]: true })).toMatchObject({ ok: true });
    expect(await fq.updateForm(org, formId, { version: 1, active: false })).toMatchObject({ ok: true });
    expect(await draft(rid, v1, formId, { [F.b]: true }, { base: 1 })).toMatchObject({ ok: true, revision: 2 });
    expect((await submitVia(rid, v1, formId, randomUUID(), {}, { base: 2 })).status).toBe(200);
    const v2 = await addVisit(rid, 2);
    await assign(v2, lead, { arrived: true, lead: true });
    expect(await draft(rid, v2, formId, { [F.a]: true })).toMatchObject({ ok: false, reason: "form_archived" });
    expect(await fr.getJobForm(org, lead, rid, formId, v2)).toEqual({ kind: "archived" });

    const other = await newForm(checklist(undefined, { jobTypeIds: [jobType] }));
    const typed = await newJob(); // job_type_id NULL: the form doesn't apply
    const tv = await visitOf(typed);
    const card = await fr.getJobForms(org, lead, typed, tv);
    if (card.kind !== "ok") throw new Error(card.kind);
    expect(card.view.otherForms.map((o) => o.formId)).toContain(other);
    expect(await draft(typed, tv, other, { [F.a]: true })).toMatchObject({ ok: true });
    // Clear answers: every answered field as null → NULL blob, Not started, hidden from the office.
    expect(await draft(typed, tv, other, { [F.a]: null }, { base: 1 })).toMatchObject({ ok: true, revision: 2 });
    expect((await row(typed, tv, other))!.values_encrypted).toBeNull();
    const after = await fr.getJobForms(org, lead, typed, tv);
    if (after.kind !== "ok") throw new Error(after.kind);
    expect(after.view.forms.find((f) => f.formId === other)?.submission?.hasAnswers).toBe(false);
    expect((await fq.getRequestForms(org, typed))?.submissions).toEqual([]);
  }, 90_000);

  it("(i) erase: answers and request + equipment attachments go; later writes refused; races leave nothing; delete keeps answers", async () => {
    const cust = await newCustomer();
    const formId = await newForm();
    const rid = await newJob({ customerId: cust });
    const v1 = await visitOf(rid);
    expect(await draft(rid, v1, formId, { [F.note]: SECRET })).toMatchObject({ ok: true });
    const unit = (await run(sql`INSERT INTO customer_equipment (organization_id,customer_id,equipment_type) VALUES (${org},${cust},'ac'::equipment_type) RETURNING id`))[0]!.id as string;
    await run(sql`INSERT INTO attachments (organization_id,service_request_id,filename,mime_type,size,storage_key) VALUES (${org},${rid},'a.jpg','image/jpeg',1,'probe/request.jpg')`);
    await run(sql`INSERT INTO attachments (organization_id,equipment_id,filename,mime_type,size,storage_key) VALUES (${org},${unit},'b.pdf','application/pdf',1,'probe/unit.pdf')`);
    afterCallbacks.length = 0;
    deletedKeys.length = 0;

    expect(await anonymizeCustomer(org, cust)).toBe(true);
    const r = await row(rid, v1, formId);
    expect(r).toMatchObject({ values_encrypted: null, status: "draft" });
    expect(r!.erased_at).not.toBeNull();
    expect(await run(sql`SELECT id FROM attachments WHERE organization_id = ${org} AND (service_request_id = ${rid} OR equipment_id = ${unit})`)).toHaveLength(0);
    for (const cb of afterCallbacks) await cb();
    expect(deletedKeys).toEqual(expect.arrayContaining(["probe/request.jpg", "probe/unit.pdf"]));
    const audit = (await run(sql`SELECT details FROM audit_log WHERE organization_id = ${org} AND action = 'customer_erased' AND entity_id = ${cust}`))[0]!;
    expect(JSON.parse(String(audit.details)).attachmentsDeleted).toBe(2);

    expect(await draft(rid, v1, formId, { [F.a]: true }, { base: 1 })).toMatchObject({ ok: false, reason: "answers_removed" });
    expect(await draft(rid, v1, await newForm(), { [F.a]: true })).toMatchObject({ ok: false, reason: "customer_removed" });
    expect(await addJobPhoto(org, lead, rid, { filename: "c.jpg", mimeType: "image/jpeg", size: 1, storageKey: "probe/c.jpg" })).toEqual({ ok: false, reason: "customer_removed" });

    // Races on two connections: an erase against a first save, and against a photo insert.
    for (let i = 0; i < 3; i++) {
      const c2 = await newCustomer();
      const r2 = await newJob({ customerId: c2 });
      const a2 = await visitOf(r2);
      const f2 = await newForm();
      await Promise.all([
        draft(r2, a2, f2, { [F.note]: SECRET }),
        addJobPhoto(org, lead, r2, { filename: "d.jpg", mimeType: "image/jpeg", size: 1, storageKey: `probe/race-${i}.jpg` }),
        anonymizeCustomer(org, c2),
      ]);
      const leftover = await run(sql`SELECT id FROM form_submissions WHERE organization_id = ${org} AND service_request_id = ${r2} AND values_encrypted IS NOT NULL`);
      expect(leftover).toHaveLength(0);
      expect(await run(sql`SELECT id FROM attachments WHERE organization_id = ${org} AND service_request_id = ${r2}`)).toHaveLength(0);
    }

    // deleteCustomer detaches; the request's submission stays.
    const c3 = await newCustomer();
    const r3 = await newJob({ customerId: c3 });
    const a3 = await visitOf(r3);
    expect(await draft(r3, a3, formId, { [F.a]: true })).toMatchObject({ ok: true });
    expect(await deleteCustomer(org, c3)).toBe(true);
    expect((await row(r3, a3, formId))!.values_encrypted).not.toBeNull();
  }, 120_000);

  it("(j) reopen: changed; stale; already a draft; resubmit", async () => {
    const formId = await newForm();
    const rid = await newJob();
    const v1 = await visitOf(rid);
    expect((await submitVia(rid, v1, formId, randomUUID(), ALL_REQUIRED)).status).toBe(200);
    const r = (await row(rid, v1, formId))!;
    const rev = Number(r.revision);
    expect(await fq.reopenSubmission(org, rid, String(r.id), rev - 1)).toEqual({ ok: false, reason: "stale" });
    // Another request's id never reaches this submission.
    expect(await fq.reopenSubmission(org, await newJob(), String(r.id), rev)).toEqual({ ok: false, reason: "not_found" });
    expect(await fq.reopenSubmission(org, rid, String(r.id), rev)).toMatchObject({ ok: true, changed: true, revision: rev + 1 });
    expect(await fq.reopenSubmission(org, rid, String(r.id), rev)).toMatchObject({ ok: true, changed: false });
    expect((await submitVia(rid, v1, formId, randomUUID(), {}, { base: rev + 1 })).status).toBe(200);
  }, 60_000);

  it("(k) an undecryptable blob: tech GET unreadable, save refused, office unreadable, never a 500", async () => {
    const formId = await newForm();
    const rid = await newJob();
    const v1 = await visitOf(rid);
    expect(await draft(rid, v1, formId, { [F.a]: true })).toMatchObject({ ok: true });
    await run(sql`UPDATE form_submissions SET values_encrypted = 'not-a-ciphertext' WHERE organization_id = ${org} AND service_request_id = ${rid}`);
    const v = await techView(rid, formId, v1);
    expect([v.writeBlockedReason, v.submission?.values]).toEqual(["unreadable", null]);
    expect(await draft(rid, v1, formId, { [F.b]: true }, { base: 1 })).toMatchObject({ ok: false, reason: "answers_unreadable" });
    const office = await fq.getRequestForms(org, rid);
    expect(office?.submissions[0]).toMatchObject({ unreadable: true, values: null });
  }, 60_000);

  it("(l) site: location and address scope, synced none, future and other-customer exclusions, membership states, tenancy", async () => {
    const A = "12 Elm St, Johnson City, TN 37601";
    const cust = await newCustomer();
    const loc = (await run(sql`INSERT INTO customer_locations (organization_id,customer_id,address_encrypted,label,is_primary) VALUES (${org},${cust},${encrypt(A)},'Main house',true) RETURNING id`))[0]!.id as string;
    const pastSame = await newJob({ customerId: cust, locationId: loc, address: A, status: "completed" });
    const pastAddr = await newJob({ customerId: cust, address: "12 elm st,  johnson city, tn 37601", status: "completed" });
    const future = await newJob({ customerId: cust, locationId: loc, address: A, status: "scheduled" });
    await run(sql`UPDATE service_requests SET scheduled_date = now() + interval '10 days' WHERE id = ${future} AND organization_id = ${org}`);
    const cancelledElsewhere = await newJob({ customerId: cust, address: "99 Far Rd, Bristol, TN", status: "cancelled" });
    const custB = await newCustomer();
    const otherCust = await newJob({ customerId: custB, address: A, status: "completed" });
    const plan = (await run(sql`INSERT INTO membership_plans (organization_id,name,price_cents,visits_per_year) VALUES (${org},'Comfort Club',1500,2) RETURNING id`))[0]!.id as string;
    const mem = (await run(sql`INSERT INTO customer_memberships (organization_id,customer_id,plan_id,status) VALUES (${org},${cust},${plan},'active') RETURNING id`))[0]!.id as string;
    await run(sql`INSERT INTO membership_visits (organization_id,customer_membership_id,due_date,period_key,status) VALUES
      (${org},${mem},now() + interval '30 days','2027-H1','scheduled'),(${org},${mem},now() - interval '30 days','2026-H2','scheduled')`);
    const openEstimate = async (rid: string, c: string) =>
      (await run(sql`INSERT INTO estimates (organization_id,service_request_id,customer_id,status,total_cents) VALUES (${org},${rid},${c},'open',481200) RETURNING id`))[0]!.id as string;
    const est = await openEstimate(pastSame, cust);
    // Estimates on unmatched requests never list: another customer's, and a cancelled request's.
    const estOther = await openEstimate(otherCust, custB);
    const estCancelled = await openEstimate(cancelledElsewhere, cust);
    // The customer's other location (another address): never on this site.
    const loc2 = (await run(sql`INSERT INTO customer_locations (organization_id,customer_id,address_encrypted,label) VALUES (${org},${cust},${encrypt("40 Oak Ave, Bristol, TN")},'Rental') RETURNING id`))[0]!.id as string;
    const atLoc2 = await newJob({ customerId: cust, locationId: loc2, address: "40 Oak Ave, Bristol, TN", status: "completed" });

    const job = await newJob({ customerId: cust, locationId: loc, address: A });
    const site = await sq.getSiteView(org, lead, job);
    if (site.kind !== "ok") throw new Error(site.kind);
    expect(site.view.scope).toBe("location");
    expect(site.view.pastJobs.map((j) => j.id).sort()).toEqual([pastSame, pastAddr].sort());
    expect(site.view.pastJobs.map((j) => j.id)).not.toContain(future);
    expect(site.view.pastJobs.map((j) => j.id)).not.toContain(otherCust);
    expect(site.view.pastJobs.map((j) => j.id)).not.toContain(atLoc2);
    expect(site.view.openEstimates.map((e) => e.id)).toEqual([est]);
    expect(site.view.openEstimates.map((e) => e.id)).not.toContain(estOther);
    expect(site.view.openEstimates.map((e) => e.id)).not.toContain(estCancelled);
    // Two locations: membership is withheld (whether or not there is one).
    expect(site.view.membership).toEqual({ state: "withheld" });

    const byAddr = await newJob({ customerId: cust, address: A });
    const s2 = await sq.getSiteView(org, lead, byAddr);
    if (s2.kind !== "ok") throw new Error(s2.kind);
    expect(s2.view.scope).toBe("address");

    // Member: a single-location customer whose every request has the same address.
    const custM = await newCustomer();
    const locM = (await run(sql`INSERT INTO customer_locations (organization_id,customer_id,address_encrypted,is_primary) VALUES (${org},${custM},${encrypt(A)},true) RETURNING id`))[0]!.id as string;
    const memM = (await run(sql`INSERT INTO customer_memberships (organization_id,customer_id,plan_id,status) VALUES (${org},${custM},${plan},'active') RETURNING id`))[0]!.id as string;
    await run(sql`INSERT INTO membership_visits (organization_id,customer_membership_id,due_date,period_key,status) VALUES
      (${org},${memM},now() + interval '30 days','2027-H1','scheduled'),(${org},${memM},now() - interval '30 days','2026-H2','scheduled')`);
    const mJob = await newJob({ customerId: custM, locationId: locM, address: A });
    const sm = await sq.getSiteView(org, lead, mJob);
    if (sm.kind !== "ok") throw new Error(sm.kind);
    expect(sm.view.membership).toMatchObject({ state: "member", planName: "Comfort Club" });
    if (sm.view.membership.state === "member") expect(sm.view.membership.upcoming).toHaveLength(1); // the overdue visit is excluded

    // A two-location customer with NO membership is withheld too (existence isn't leaked).
    const custN = await newCustomer();
    const locN = (await run(sql`INSERT INTO customer_locations (organization_id,customer_id,address_encrypted) VALUES (${org},${custN},${encrypt(A)}) RETURNING id`))[0]!.id as string;
    await run(sql`INSERT INTO customer_locations (organization_id,customer_id,address_encrypted) VALUES (${org},${custN},${encrypt("9 Pine Ct, Kingsport, TN")})`);
    const nJob = await newJob({ customerId: custN, locationId: locN, address: A });
    const s3 = await sq.getSiteView(org, lead, nJob);
    if (s3.kind !== "ok") throw new Error(s3.kind);
    expect(s3.view.membership).toEqual({ state: "withheld" });

    const custC = await newCustomer();
    const cJob = await newJob({ customerId: custC, address: A });
    const synced = await newJob({ customerId: custC, fieldpulse: true, status: "scheduled" });
    const s4 = await sq.getSiteView(org, lead, cJob);
    if (s4.kind !== "ok") throw new Error(s4.kind);
    expect(s4.view.membership).toEqual({ state: "withheld" });
    const syncedEst = await openEstimate(synced, custC);
    const s5 = await sq.getSiteView(org, lead, synced);
    if (s5.kind !== "ok") throw new Error(s5.kind);
    expect([s5.view.scope, s5.view.unaddressedCount, s5.view.pastJobs]).toEqual(["none", 0, []]);
    expect(s5.view.openEstimates.map((e) => e.id)).toEqual([syncedEst]); // under `none` this job's own still list
    const s6 = await sq.getSiteView(org, lead, cJob);
    if (s6.kind !== "ok") throw new Error(s6.kind);
    expect(s6.view.unaddressedCount).toBe(1);

    expect(await sq.getSiteView(org2, lead, job)).toEqual({ kind: "not_found" });
  }, 120_000);

  it("(m) missingRequired: completed yes, cancelled no; hold-ended visit counts; untouched cancelled visit doesn't; created after completion not listed", async () => {
    const formId = await newForm();
    const rid = await newJob({ status: "completed" });
    await run(sql`UPDATE service_requests SET completed_at = now() WHERE id = ${rid} AND organization_id = ${org}`);
    expect((await fq.getRequestForms(org, rid))?.missingRequired.map((m) => m.formId)).toContain(formId);
    const late = await newForm();
    expect((await fq.getRequestForms(org, rid))?.missingRequired.map((m) => m.formId)).not.toContain(late);

    const cancelled = await newJob();
    await run(sql`UPDATE service_requests SET status = 'cancelled'::request_status WHERE id = ${cancelled} AND organization_id = ${org}`);
    expect((await fq.getRequestForms(org, cancelled))?.missingRequired).toEqual([]);

    const held = await newJob();
    const hv = await visitOf(held);
    expect((await submitVia(held, hv, formId, randomUUID(), ALL_REQUIRED)).status).toBe(200);
    await run(sql`UPDATE appointments SET cancelled_at = now() WHERE id = ${hv} AND organization_id = ${org}`);
    const heldForms = await fq.getRequestForms(org, held);
    expect(heldForms?.missingRequired.map((m) => m.formId)).not.toContain(formId);
    expect(heldForms?.submissions[0]?.visitState).toBe("ended");

    // Lead ruling 13: (m)'s "a visit cancelled before any work doesn't count" can only mean a visit with NO
    // submission — §5.1 makes any visit holding a submission count. Pin both sides.
    const preWork = await newJob();
    const pv = await visitOf(preWork);
    expect((await submitVia(preWork, pv, formId, randomUUID(), ALL_REQUIRED)).status).toBe(200);
    await run(sql`UPDATE appointment_assignments SET status = 'cancelled'::request_status WHERE appointment_id = ${pv} AND organization_id = ${org}`);
    await run(sql`UPDATE appointments SET cancelled_at = now() WHERE id = ${pv} AND organization_id = ${org}`);
    expect((await fq.getRequestForms(org, preWork))?.missingRequired.map((m) => m.formId)).not.toContain(formId);
    const fresh = await newJob();
    const fv2 = await addVisit(fresh, 2);
    await run(sql`UPDATE appointments SET cancelled_at = now() WHERE id = ${fv2} AND organization_id = ${org}`);
    expect(await fr.getJobForms(org, lead, fresh, fv2)).toEqual({ kind: "not_found" });
  }, 90_000);

  it("(n) form audit rows carry ids and enums only; stored keys hold no answer", async () => {
    const formId = await newForm();
    const rid = await newJob();
    expect((await submitVia(rid, await visitOf(rid), formId, randomUUID(), { ...ALL_REQUIRED, [F.note]: SECRET })).status).toBe(200);
    const rows = await run(sql`SELECT action, details FROM audit_log WHERE organization_id = ${org} AND action LIKE 'form_%'`);
    expect(rows.length).toBeGreaterThan(0);
    const allowed = new Set(["formId", "appointmentId", "formVersion", "version", "fieldCount"]);
    for (const r of rows) {
      expect(String(r.details)).not.toContain(SECRET);
      expect(Object.keys(JSON.parse(String(r.details))).every((k) => allowed.has(k))).toBe(true);
    }
    const stored = await run(sql`SELECT request_hash, response_body FROM idempotency_keys WHERE organization_id = ${org}`);
    for (const s of stored) expect(JSON.stringify(s)).not.toContain(SECRET);
  }, 60_000);

  it("migration 0058 applies twice, statement by statement", async () => {
    const statements = readFileSync("drizzle/0058_m3d_forms.sql", "utf8").split("--> statement-breakpoint").map((s) => s.trim()).filter(Boolean);
    expect(statements.length).toBe(23);
    for (let pass = 0; pass < 2; pass++) {
      for (const stmt of statements) await db.execute(sql.raw(stmt));
    }
  }, 60_000);
});
