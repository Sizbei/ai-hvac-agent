import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest, NextResponse } from "next/server";

const h = vi.hoisted(() => ({
  preamble: vi.fn(),
  getTechSession: vi.fn(),
  slidingWindow: vi.fn(),
  getView: vi.fn(),
  withIdempotency: vi.fn(),
  replay: { current: null as null | { status: number; envelope: unknown } },
  add: vi.fn(),
  logAudit: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/auth/tech-session", () => ({ getTechSession: h.getTechSession }));
vi.mock("@/lib/rate-limit", async (orig) => ({ ...(await orig<typeof import("@/lib/rate-limit")>()), slidingWindow: h.slidingWindow }));
vi.mock("@/lib/tech/invoice-route-guards", async (orig) => ({
  ...(await orig<typeof import("@/lib/tech/invoice-route-guards")>()),
  techEquipmentPreamble: h.preamble,
}));
vi.mock("@/lib/http/idempotency", async (orig) => ({
  ...(await orig<typeof import("@/lib/http/idempotency")>()),
  withIdempotency: h.withIdempotency,
}));
vi.mock("@/lib/tech/equipment-queries", () => ({ getTechEquipmentView: h.getView }));
vi.mock("@/lib/tech/equipment-writes", () => ({ addFieldEquipment: h.add }));
vi.mock("@/lib/admin/audit", () => ({ logAudit: h.logAudit }));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() }, errorCode: () => "x" }));

import { GET, POST } from "./route";

const ORG = "00000000-0000-4000-8000-0000000000aa";
const U = "00000000-0000-4000-8000-0000000000bb";
const RID = "11111111-1111-4111-8111-111111111111";
const OLD = "66666666-6666-4666-8666-666666666666";
const PATH = `/api/tech/jobs/${RID}/equipment`;
const ctx = { params: Promise.resolve({ id: RID }) };
const json = async (res: Response) => (await res.json()) as { success: boolean; data?: Record<string, unknown>; error?: { code: string; message: string } };
const post = (body: unknown, key: string | null = "k-1") => {
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (key !== null) headers["idempotency-key"] = key;
  return POST(new NextRequest(`http://localhost${PATH}`, { method: "POST", headers, body: JSON.stringify(body) }), ctx);
};
const get = () => GET(new NextRequest(`http://localhost${PATH}`), ctx);
const parsed = (over: Record<string, unknown> = {}) => ({
  equipmentType: "ac", make: null, model: null, serialNumber: null, locationInHome: null, notes: null, installDate: null, replacesId: null, ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  h.replay.current = null;
  h.getTechSession.mockResolvedValue({ userId: U, organizationId: ORG });
  h.slidingWindow.mockReturnValue({ allowed: true, remaining: 1, resetMs: 1 });
  h.preamble.mockResolvedValue({ ok: true, session: { userId: U, organizationId: ORG }, job: {}, requestId: RID });
  h.withIdempotency.mockImplementation(async (_s: unknown, _h: string, run: (ids: { id: (n: string) => string }) => Promise<unknown>) =>
    h.replay.current ? { ...h.replay.current, replayed: true } : { ...(await run({ id: (n) => `derived-${n}` }) as object), replayed: false });
});

describe("GET /api/tech/jobs/[id]/equipment", () => {
  it("401 / 400 / 429 / 404 / 409 / 200", async () => {
    h.getTechSession.mockResolvedValueOnce(null);
    expect((await get()).status).toBe(401);
    expect((await GET(new NextRequest("http://localhost/x"), { params: Promise.resolve({ id: "nope" }) })).status).toBe(400);
    h.slidingWindow.mockReturnValueOnce({ allowed: false, remaining: 0, resetMs: 1 });
    expect((await get()).status).toBe(429);
    h.getView.mockResolvedValueOnce({ kind: "not_found" });
    expect((await get()).status).toBe(404);
    h.getView.mockResolvedValueOnce({ kind: "external" });
    expect((await get()).status).toBe(409);
    h.getView.mockResolvedValueOnce({ kind: "ok", view: { units: [], canWrite: true } });
    expect((await json(await get())).data).toEqual({ units: [], canWrite: true });
    expect(h.getView).toHaveBeenLastCalledWith(ORG, U, RID);
  });
});

describe("POST /api/tech/jobs/[id]/equipment", () => {
  it("returns the equipment preamble's refusal untouched", async () => {
    h.preamble.mockResolvedValueOnce({ ok: false, response: NextResponse.json({ success: false, error: { code: "NOT_ASSIGNED", message: "x" } }, { status: 403 }) });
    expect((await post({ equipmentType: "ac" })).status).toBe(403);
    expect(h.withIdempotency).not.toHaveBeenCalled();
  });
  it("semantic validation copy (Other needs a description, future date, unknown type, bad replaces id)", async () => {
    expect((await json(await post({ equipmentType: "other" }))).error).toEqual({ code: "INVALID_INPUT", message: "Describe the equipment." });
    expect((await json(await post({ equipmentType: "ac", installDate: "2999-01-01" }))).error).toEqual({ code: "INVALID_INPUT", message: "The install date can't be in the future." });
    expect((await json(await post({ equipmentType: "jacuzzi" }))).error).toEqual({ code: "INVALID_INPUT", message: "Choose the type of equipment." });
    expect((await json(await post({ equipmentType: "ac", replacesId: "nope" }))).error?.code).toBe("INVALID_INPUT");
    expect(h.withIdempotency).not.toHaveBeenCalled();
  });
  it("201 add with equipment_added; 201 replace with equipment_replaced; 200 replay without an audit", async () => {
    h.add.mockResolvedValueOnce({ ok: true, equipmentId: "eq-1", created: true, replaced: false });
    const a = await post({ equipmentType: "ac", make: "Carrier" });
    expect(a.status).toBe(201);
    expect((await json(a)).data).toEqual({ equipmentId: "eq-1", created: true });
    expect(h.add).toHaveBeenCalledWith({ organizationId: ORG, requestId: RID, techUserId: U }, { equipmentId: "derived-equipment" }, parsed({ make: "Carrier" }));
    expect(h.logAudit).toHaveBeenLastCalledWith(expect.objectContaining({ action: "equipment_added", entity: "equipment", details: "equipmentId:eq-1" }));
    h.add.mockResolvedValueOnce({ ok: true, equipmentId: "eq-2", created: true, replaced: true });
    expect((await post({ equipmentType: "ac", replacesId: OLD })).status).toBe(201);
    expect(h.logAudit).toHaveBeenLastCalledWith(expect.objectContaining({ action: "equipment_replaced", details: `equipmentId:eq-2 replacesId:${OLD}` }));
    h.logAudit.mockClear();
    h.add.mockResolvedValueOnce({ ok: true, equipmentId: "eq-2", created: false, replaced: true });
    expect((await post({ equipmentType: "ac", replacesId: OLD })).status).toBe(200);
    h.replay.current = { status: 201, envelope: { success: true, data: { equipmentId: "eq-2", created: true } } };
    expect((await post({ equipmentType: "ac", replacesId: OLD })).status).toBe(201);
    expect(h.logAudit).not.toHaveBeenCalled();
  });
  it("EQUIPMENT_RETIRED / MANAGED_EXTERNALLY / NOT_FOUND / NO_CUSTOMER / STALE", async () => {
    for (const [reason, status, code] of [["equipment_retired", 409, "EQUIPMENT_RETIRED"], ["managed_externally", 409, "MANAGED_EXTERNALLY"], ["not_found", 404, "NOT_FOUND"], ["no_customer", 409, "NO_CUSTOMER"], ["stale", 409, "STALE"]] as const) {
      h.add.mockResolvedValueOnce({ ok: false, reason });
      const res = await post({ equipmentType: "ac", replacesId: OLD });
      expect([res.status, (await json(res)).error?.code]).toEqual([status, code]);
    }
  });
});
