import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const h = vi.hoisted(() => ({
  getTechSession: vi.fn(),
  slidingWindow: vi.fn(),
  front: vi.fn(),
  gate: vi.fn(),
  gateFail: vi.fn(),
  submitReplay: vi.fn(),
  replay: vi.fn(),
  getJobForms: vi.fn(),
  getJobForm: vi.fn(),
  save: vi.fn(),
  submit: vi.fn(),
  withIdempotency: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/auth/tech-session", () => ({ getTechSession: h.getTechSession }));
vi.mock("@/lib/rate-limit", async (orig) => ({ ...(await orig<typeof import("@/lib/rate-limit")>()), slidingWindow: h.slidingWindow }));
vi.mock("@/lib/tech/form-route-guards", () => ({ techFormFront: h.front, techFormGate: h.gate, formGateFail: h.gateFail, findSubmitReplay: h.submitReplay }));
vi.mock("@/lib/tech/form-reads", () => ({ getJobForms: h.getJobForms, getJobForm: h.getJobForm }));
vi.mock("@/lib/tech/form-writes", () => ({ saveFormDraft: h.save, submitForm: h.submit, findDraftReplay: h.replay }));
vi.mock("@/lib/crypto", () => ({ macHex: (label: string, v: string) => `mac(${label}:${v.length})` }));
vi.mock("@/lib/http/idempotency", async (orig) => ({ ...(await orig<typeof import("@/lib/http/idempotency")>()), withIdempotency: h.withIdempotency }));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() }, errorCode: () => "x" }));

import { GET as LIST } from "./route";
import { GET as ONE } from "./[formId]/route";
import { PUT as DRAFT } from "./[formId]/draft/route";
import { POST as SUBMIT } from "./[formId]/submit/route";
import { submitHashInput } from "@/lib/tech/form-submit-hash";

const ORG = "00000000-0000-4000-8000-0000000000aa";
const U = "00000000-0000-4000-8000-0000000000bb";
const RID = "11111111-1111-4111-8111-111111111111";
const FORM = "22222222-2222-4222-8222-222222222222";
const AID = "33333333-3333-4333-8333-333333333333";
const SAVE = "44444444-4444-4444-8444-444444444444";
const SECRET = "Basement door code 4471";
const base = `http://localhost/api/tech/jobs/${RID}/forms`;
const json = async (res: Response) => (await res.json()) as { success: boolean; data?: Record<string, unknown>; error?: { code: string; message: string; details?: unknown } };
const body = (over: Record<string, unknown> = {}) => ({ appointmentId: AID, formVersion: 1, baseRevision: 0, changes: { f_0000000001: SECRET }, ...over });
const put = (b: unknown) => DRAFT(new NextRequest(`${base}/${FORM}/draft`, { method: "PUT", body: JSON.stringify(b) }), { params: Promise.resolve({ id: RID, formId: FORM }) });
const post = (b: unknown, key: string | null = "k-1") => {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (key !== null) headers["idempotency-key"] = key;
  return SUBMIT(new NextRequest(`${base}/${FORM}/submit`, { method: "POST", headers, body: JSON.stringify(b) }), { params: Promise.resolve({ id: RID, formId: FORM }) });
};

beforeEach(() => {
  vi.clearAllMocks();
  h.getTechSession.mockResolvedValue({ userId: U, organizationId: ORG });
  h.slidingWindow.mockReturnValue({ allowed: true, remaining: 1, resetMs: 1 });
  h.front.mockResolvedValue({ ok: true, session: { userId: U, organizationId: ORG } });
  h.gate.mockResolvedValue({ ok: true });
  h.gateFail.mockResolvedValue(null);
  h.submitReplay.mockResolvedValue(null);
  h.replay.mockResolvedValue(null);
  h.withIdempotency.mockImplementation(async (_s: unknown, _h: string, run: (ids: { id: (n: string) => string }) => Promise<unknown>) =>
    ({ ...(await run({ id: (n) => `derived-${n}` }) as object), replayed: false }));
});

describe("GET …/forms and …/forms/[formId]", () => {
  it("401 / 400 (bad visit) / 429 / 404 / 200", async () => {
    const list = (visit: string) => LIST(new NextRequest(`${base}?visit=${visit}`), { params: Promise.resolve({ id: RID }) });
    h.getTechSession.mockResolvedValueOnce(null);
    expect((await list(AID)).status).toBe(401);
    expect((await list("nope")).status).toBe(400);
    h.slidingWindow.mockReturnValueOnce({ allowed: false, remaining: 0, resetMs: 1 });
    expect((await list(AID)).status).toBe(429);
    expect(h.slidingWindow).toHaveBeenLastCalledWith(`tech:form:read:${U}`, 60, 60_000);
    h.getJobForms.mockResolvedValueOnce({ kind: "not_found" });
    expect((await list(AID)).status).toBe(404);
    h.getJobForms.mockResolvedValueOnce({ kind: "ok", view: { visitId: AID, forms: [] } });
    expect(await json(await list(AID))).toEqual({ success: true, data: { visitId: AID, forms: [] } });
  });

  it("one form: a foreign form id is 404; archived with no row is 409 FORM_ARCHIVED", async () => {
    const one = () => ONE(new NextRequest(`${base}/${FORM}?visit=${AID}`), { params: Promise.resolve({ id: RID, formId: FORM }) });
    h.getJobForm.mockResolvedValueOnce({ kind: "not_found" });
    expect(await json(await one())).toMatchObject({ error: { code: "NOT_FOUND", message: "This form is no longer on this job." } });
    h.getJobForm.mockResolvedValueOnce({ kind: "archived" });
    const a = await one();
    expect(a.status).toBe(409);
    expect((await json(a)).error?.code).toBe("FORM_ARCHIVED");
  });
});

describe("PUT …/draft (spec §4.2)", () => {
  it("the front refusal comes first, before the body is read", async () => {
    h.front.mockResolvedValueOnce({ ok: false, response: NextResponse.json({ success: false, error: { code: "RATE_LIMITED" } }, { status: 429 }) });
    expect((await put(body({ saveId: SAVE }))).status).toBe(429);
    expect(h.save).not.toHaveBeenCalled();
  });

  it("a body without saveId is 400 INVALID_INPUT; the gate runs with the body's visit", async () => {
    expect((await put(body())).status).toBe(400);
    h.save.mockResolvedValueOnce({ ok: true, submissionId: "s", revision: 1, savedAt: "t", created: true });
    expect((await put(body({ saveId: SAVE }))).status).toBe(201);
    expect(h.gate).toHaveBeenCalledWith({ userId: U, organizationId: ORG }, RID, FORM, AID);
    h.save.mockResolvedValueOnce({ ok: true, submissionId: "s", revision: 2, savedAt: "t", created: false });
    const r = await put(body({ saveId: SAVE, baseRevision: 1 }));
    expect([r.status, (await json(r)).data]).toEqual([200, { submissionId: "s", revision: 2, savedAt: "t" }]);
  });

  it("a retry of a landed write replays BEFORE the gates (spec §4.2 replay first)", async () => {
    h.replay.mockResolvedValueOnce({ ok: true, submissionId: "s", revision: 4, savedAt: "t", created: false });
    const r = await put(body({ saveId: SAVE, baseRevision: 3 }));
    expect([r.status, (await json(r)).data]).toEqual([200, { submissionId: "s", revision: 4, savedAt: "t" }]);
    expect(h.gate).not.toHaveBeenCalled();
    expect(h.save).not.toHaveBeenCalled();
  });

  it("refusals map to codes with id / revision / path details only", async () => {
    h.save.mockResolvedValueOnce({ ok: false, reason: "stale", revision: 7 });
    expect(await json(await put(body({ saveId: SAVE })))).toEqual({
      success: false, error: { code: "STALE", message: "Someone else changed this form.", details: { revision: 7 } },
    });
    h.save.mockResolvedValueOnce({ ok: false, reason: "values_too_large" });
    expect((await json(await put(body({ saveId: SAVE })))).error?.details).toEqual({ path: ["values"] });
  });
});

describe("POST …/submit (spec §4.3)", () => {
  it("needs an idempotency key", async () => {
    expect((await json(await post(body(), null))).error?.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
  });

  it("passes the derived submit key; neither the hash input nor a stored envelope holds a submitted string", async () => {
    h.submit.mockResolvedValueOnce({ ok: false, reason: "form_incomplete", fieldIds: ["f_0000000002"] });
    const r = await post(body());
    expect(r.status).toBe(400);
    const envelope = await json(r);
    expect(envelope.error?.code).toBe("FORM_INCOMPLETE");
    expect(JSON.stringify(envelope)).not.toContain(SECRET);
    expect(h.submit.mock.calls[0]![2]).toEqual({ submitKey: "derived-form-submit" });
    const hashInput = submitHashInput(body() as never);
    expect(JSON.stringify(hashInput)).not.toContain(SECRET);
    expect(hashInput).toEqual({ appointmentId: AID, formVersion: 1, baseRevision: 0, changesMac: expect.stringMatching(/^mac\(hvac-form-changes-v1:/) });
  });

  it("the gates run inside the keyed run: a closed job refuses (unstored) without calling the writer", async () => {
    h.gateFail.mockResolvedValueOnce({ ok: false, reason: "job_closed" });
    const r = await post(body());
    expect([r.status, (await json(r)).error?.code]).toEqual([409, "JOB_CLOSED"]);
    expect(h.submit).not.toHaveBeenCalled();
    expect(h.gateFail).toHaveBeenCalledWith({ userId: U, organizationId: ORG }, RID, FORM, AID);
  });

  it("a takeover re-run of a submit that committed answers 200 even after the job closed (lead ruling, spec §5.3)", async () => {
    h.submitReplay.mockResolvedValueOnce({ ok: true, submissionId: "s", revision: 3, submittedAt: "t" });
    h.gateFail.mockResolvedValue({ ok: false, reason: "job_closed" }); // persistent: never consumed here; beforeEach restores null
    const r = await post(body());
    expect([r.status, (await json(r)).data]).toEqual([200, { submissionId: "s", revision: 3, submittedAt: "t" }]);
    expect(h.submitReplay).toHaveBeenCalledWith({ userId: U, organizationId: ORG }, RID, FORM, AID, "derived-form-submit");
    expect(h.gateFail).not.toHaveBeenCalled();
    expect(h.submit).not.toHaveBeenCalled();
  });

  it("no committed row with this key: the gates still run first", async () => {
    h.gateFail.mockResolvedValueOnce({ ok: false, reason: "visit_ended" });
    const r = await post(body());
    expect([r.status, (await json(r)).error?.code]).toEqual([409, "VISIT_ENDED"]);
    expect(h.submitReplay).toHaveBeenCalledTimes(1);
    expect(h.submit).not.toHaveBeenCalled();
  });

  it("success is 200 { submissionId, revision, submittedAt }", async () => {
    h.submit.mockResolvedValueOnce({ ok: true, submissionId: "s", revision: 3, submittedAt: "t" });
    const r = await post(body());
    expect([r.status, (await json(r)).data]).toEqual([200, { submissionId: "s", revision: 3, submittedAt: "t" }]);
  });
});
