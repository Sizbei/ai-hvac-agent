import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";

const h = vi.hoisted(() => ({
  getAdminSession: vi.fn(), slidingWindow: vi.fn(), logAudit: vi.fn(),
  listForms: vi.fn(), createForm: vi.fn(), getForm: vi.fn(), updateForm: vi.fn(),
}));
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/auth/session", () => ({ getAdminSession: h.getAdminSession }));
vi.mock("@/lib/rate-limit", async (orig) => ({ ...(await orig<typeof import("@/lib/rate-limit")>()), slidingWindow: h.slidingWindow }));
vi.mock("@/lib/admin/audit", () => ({ logAudit: h.logAudit }));
vi.mock("@/lib/admin/form-queries", () => ({ listForms: h.listForms, createForm: h.createForm, getForm: h.getForm, updateForm: h.updateForm }));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn() }, errorCode: () => "x" }));

import { GET as LIST, POST as CREATE } from "./route";
import { GET as ONE, PATCH } from "./[id]/route";

const ORG = "00000000-0000-4000-8000-0000000000aa";
const U = "00000000-0000-4000-8000-0000000000bb";
const FID = "11111111-1111-4111-8111-111111111111";
const TOKEN = "22222222-2222-4222-8222-222222222222";
const DEF = {
  name: "Maintenance checklist", description: null, jobTypeIds: [], required: true,
  fields: [{ id: "f_0000000001", type: "checkbox", label: "Filter changed", required: true }],
};
const json = async (res: Response) => (await res.json()) as { success: boolean; data?: Record<string, unknown>; error?: { code: string; message: string; details?: unknown } };
const create = (b: unknown) => CREATE(new NextRequest("http://localhost/api/admin/settings/forms", { method: "POST", body: JSON.stringify(b) }));
const patch = (b: unknown, id = FID) => PATCH(new NextRequest(`http://localhost/api/admin/settings/forms/${id}`, { method: "PATCH", body: JSON.stringify(b) }), { params: Promise.resolve({ id }) });

beforeEach(() => {
  vi.clearAllMocks();
  h.getAdminSession.mockResolvedValue({ userId: U, organizationId: ORG, role: "admin" });
  h.slidingWindow.mockReturnValue({ allowed: true, remaining: 1, resetMs: 1 });
  h.logAudit.mockResolvedValue(undefined);
});

describe("GET/POST /api/admin/settings/forms (spec §4.1, §6)", () => {
  it("lists forms for the admin's org", async () => {
    h.listForms.mockResolvedValueOnce([]);
    expect(await json(await LIST())).toEqual({ success: true, data: { forms: [] } });
    expect(h.listForms).toHaveBeenCalledWith(ORG);
  });

  it("201 on create with a form_created audit (ids only); 200 replay with no audit", async () => {
    h.createForm.mockResolvedValueOnce({ ok: true, id: FID, created: true });
    const r = await create({ ...DEF, clientToken: TOKEN });
    expect([r.status, (await json(r)).data]).toEqual([201, { id: FID }]);
    expect(h.createForm).toHaveBeenCalledWith(ORG, U, TOKEN, DEF);
    expect(h.logAudit).toHaveBeenCalledWith(expect.objectContaining({ action: "form_created", entityId: FID, details: JSON.stringify({ formId: FID }) }));
    h.createForm.mockResolvedValueOnce({ ok: true, id: FID, created: false });
    expect((await create({ ...DEF, clientToken: TOKEN })).status).toBe(200);
    expect(h.logAudit).toHaveBeenCalledTimes(1);
  });

  it("an empty definition is 400 VALIDATION_ERROR with a path, and nothing is created", async () => {
    const r = await create({ ...DEF, fields: [{ id: "f_0000000001", type: "heading", label: "H", required: false }], clientToken: TOKEN });
    expect(await json(r)).toEqual({ success: false, error: { code: "VALIDATION_ERROR", message: "Invalid form", details: { path: ["fields"] } } });
    expect(h.createForm).not.toHaveBeenCalled();
  });

  it("NAME_TAKEN / LIMIT_REACHED / UNKNOWN_JOB_TYPE", async () => {
    for (const [reason, status, code] of [["name_taken", 409, "NAME_TAKEN"], ["limit_reached", 409, "LIMIT_REACHED"], ["unknown_job_type", 400, "UNKNOWN_JOB_TYPE"]] as const) {
      h.createForm.mockResolvedValueOnce({ ok: false, reason });
      const r = await create({ ...DEF, clientToken: TOKEN });
      expect([r.status, (await json(r)).error?.code]).toEqual([status, code]);
    }
  });
});

describe("GET/PATCH /api/admin/settings/forms/[id]", () => {
  it("a foreign or missing id is 404; a non-uuid is 400", async () => {
    h.getForm.mockResolvedValueOnce(null);
    expect((await ONE(new NextRequest("http://x"), { params: Promise.resolve({ id: FID }) })).status).toBe(404);
    expect(h.getForm).toHaveBeenCalledWith(ORG, FID);
    expect((await ONE(new NextRequest("http://x"), { params: Promise.resolve({ id: "nope" }) })).status).toBe(400);
  });

  it("definition PATCH audits form_updated with version and fieldCount; archive audits form_archived", async () => {
    h.updateForm.mockResolvedValueOnce({ ok: true, version: 3 });
    expect(await json(await patch({ version: 2, definition: DEF }))).toEqual({ success: true, data: { version: 3 } });
    expect(h.logAudit).toHaveBeenLastCalledWith(expect.objectContaining({ action: "form_updated", details: JSON.stringify({ formId: FID, version: 3, fieldCount: 1 }) }));
    h.updateForm.mockResolvedValueOnce({ ok: true, version: 4 });
    await patch({ version: 3, active: false });
    expect(h.logAudit).toHaveBeenLastCalledWith(expect.objectContaining({ action: "form_archived", details: JSON.stringify({ formId: FID, version: 4 }) }));
  });

  it("STALE / NAME_TAKEN / NOT_FOUND; a body with neither definition nor active is 400", async () => {
    h.updateForm.mockResolvedValueOnce({ ok: false, reason: "stale" });
    expect(await json(await patch({ version: 1, active: true }))).toMatchObject({ error: { code: "STALE", message: "Someone else changed this form. Reload to see their changes." } });
    h.updateForm.mockResolvedValueOnce({ ok: false, reason: "name_taken" });
    expect((await json(await patch({ version: 1, active: true }))).error?.code).toBe("NAME_TAKEN");
    h.updateForm.mockResolvedValueOnce({ ok: false, reason: "not_found" });
    expect((await patch({ version: 1, active: true })).status).toBe(404);
    expect((await patch({ version: 1 })).status).toBe(400);
    expect(h.logAudit).not.toHaveBeenCalled();
  });
});
