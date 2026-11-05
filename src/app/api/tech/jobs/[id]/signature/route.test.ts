/**
 * Pure unit tests for the signature route (spec §6.5): guard order, the
 * idempotency claim BEFORE the upload, not_owned cleanup and the previous
 * object's deletion in after(). Everything is mocked — no DB, no R2.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { NextRequest } from "next/server";
import { createHash } from "node:crypto";

const h = vi.hoisted(() => ({
  order: [] as string[],
  getTechSession: vi.fn(),
  isSameOriginRequest: vi.fn(),
  slidingWindow: vi.fn(),
  findReadableJob: vi.fn(),
  findActiveVisit: vi.fn(),
  recordSignature: vi.fn(),
  uploadFile: vi.fn(),
  deleteFile: vi.fn(),
  validateFile: vi.fn(),
  withIdempotency: vi.fn(),
  execute: vi.fn(),
  after: vi.fn(),
  logAudit: vi.fn(),
  logInfo: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
}));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/auth/tech-session", () => ({ getTechSession: h.getTechSession }));
vi.mock("@/lib/session-csrf", () => ({ isSameOriginRequest: h.isSameOriginRequest }));
vi.mock("@/lib/rate-limit", async (orig) => ({
  ...(await orig<typeof import("@/lib/rate-limit")>()),
  slidingWindow: h.slidingWindow,
}));
vi.mock("@/lib/tech/ownership", () => ({ findReadableJob: h.findReadableJob, findActiveVisit: h.findActiveVisit }));
vi.mock("@/lib/tech/field-queries", () => ({ recordSignature: h.recordSignature }));
vi.mock("@/lib/storage/r2-client", () => ({
  MAX_FILE_SIZE: 10_000_000,
  generateStorageKey: (org: string, rid: string, name: string) => `${org}/${rid}/new-${name}`,
  getStorageClient: () => ({ uploadFile: h.uploadFile, deleteFile: h.deleteFile, validateFile: h.validateFile }),
}));
vi.mock("@/lib/http/idempotency", async (orig) => ({
  ...(await orig<typeof import("@/lib/http/idempotency")>()),
  withIdempotency: h.withIdempotency,
}));
vi.mock("@/lib/db", () => ({ db: { execute: h.execute } }));
vi.mock("next/server", async (orig) => ({
  ...(await orig<typeof import("next/server")>()),
  after: h.after,
}));
vi.mock("@/lib/admin/audit", () => ({ logAudit: h.logAudit }));
vi.mock("@/lib/logger", async (orig) => ({ ...(await orig<typeof import("@/lib/logger")>()), logger: { info: h.logInfo, error: h.logError, warn: h.logWarn } }));

import { POST } from "./route";
import { multipartHash } from "@/lib/http/idempotency";

const ID = "22222222-2222-4222-8222-222222222222";
const PUBLIC = "https://cdn.example.com";
const OLD_URL = `${PUBLIC}/o1/${ID}/old.png`;
const NAME = "Pat Customer-Secret";
const BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3]);
const ctx = (id = ID) => ({ params: Promise.resolve({ id }) });

function req(opts: { key?: string | null; name?: string; file?: boolean } = {}) {
  const form = new FormData();
  if (opts.file !== false) form.append("file", new File([BYTES], "signature.png", { type: "image/png" }));
  form.append("signatureName", opts.name ?? NAME);
  const headers: Record<string, string> = { origin: "http://localhost" };
  if (opts.key !== null) headers["idempotency-key"] = opts.key ?? "sig-key-1";
  return new NextRequest(`http://localhost/api/tech/jobs/${ID}/signature`, { method: "POST", headers, body: form });
}

beforeEach(() => {
  vi.clearAllMocks();
  h.order.length = 0;
  process.env.R2_PUBLIC_URL = PUBLIC;
  h.getTechSession.mockResolvedValue({ userId: "u1", organizationId: "o1" });
  h.isSameOriginRequest.mockReturnValue(true);
  h.slidingWindow.mockReturnValue({ allowed: true, remaining: 1, resetMs: 1 });
  h.findReadableJob.mockResolvedValue({ id: ID, native: true, status: "arrived", customerId: null });
  h.findActiveVisit.mockResolvedValue({ leadTechnicianId: "u1" });
  h.validateFile.mockReturnValue("image/png");
  h.uploadFile.mockImplementation(async (_f: File, key: string) => {
    h.order.push("upload");
    return { storageKey: key, url: `${PUBLIC}/${key}` };
  });
  h.deleteFile.mockResolvedValue(undefined);
  h.recordSignature.mockResolvedValue({ ok: true, previousUrl: OLD_URL });
  h.execute.mockResolvedValue({ rows: [{ referenced: false }] });
  h.logAudit.mockResolvedValue(undefined);
  h.withIdempotency.mockImplementation(async (_scope, _hash, run) => {
    h.order.push("claim");
    return { ...(await run({ id: (n: string) => n })), replayed: false };
  });
});

const runAfter = async () => {
  for (const [cb] of h.after.mock.calls) await cb();
};

describe("POST /api/tech/jobs/[id]/signature", () => {
  it("401 without a session", async () => {
    h.getTechSession.mockResolvedValue(null);
    expect((await POST(req(), ctx())).status).toBe(401);
  });

  it("403 FORBIDDEN cross-origin, before anything else", async () => {
    h.isSameOriginRequest.mockReturnValue(false);
    const res = await POST(req(), ctx());
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("FORBIDDEN");
    expect(h.slidingWindow).not.toHaveBeenCalled();
  });

  it("400 INVALID_ID on a malformed id", async () => {
    const res = await POST(req(), ctx("nope"));
    expect(res.status).toBe(400);
    expect(h.findReadableJob).not.toHaveBeenCalled();
  });

  it("404 when the job isn't readable", async () => {
    h.findReadableJob.mockResolvedValue(null);
    const res = await POST(req(), ctx());
    expect(res.status).toBe(404);
    expect((await res.json()).error.message).toBe("This job isn't yours.");
  });

  it("409 MANAGED_EXTERNALLY for a synced job — nothing claimed or uploaded", async () => {
    h.findReadableJob.mockResolvedValue({ id: ID, native: false, status: "arrived", customerId: null });
    const res = await POST(req(), ctx());
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({
      success: false,
      error: { code: "MANAGED_EXTERNALLY", message: "This job is managed in FieldPulse." },
    });
    expect(h.withIdempotency).not.toHaveBeenCalled();
    expect(h.uploadFile).not.toHaveBeenCalled();
  });

  it("403 NOT_LEAD for a helper", async () => {
    h.findActiveVisit.mockResolvedValue({ leadTechnicianId: "someone-else" });
    const res = await POST(req(), ctx());
    expect(res.status).toBe(403);
    expect((await res.json()).error.code).toBe("NOT_LEAD");
    expect(h.uploadFile).not.toHaveBeenCalled();
  });

  it("400 IDEMPOTENCY_KEY_REQUIRED without a key — nothing uploaded", async () => {
    const res = await POST(req({ key: null }), ctx());
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("IDEMPOTENCY_KEY_REQUIRED");
    expect(h.withIdempotency).not.toHaveBeenCalled();
    expect(h.uploadFile).not.toHaveBeenCalled();
  });

  it("claims the key (multipart hash of the bytes + name) BEFORE the upload; 201 signed", async () => {
    const res = await POST(req(), ctx());
    expect(res.status).toBe(201);
    expect(await res.json()).toEqual({ success: true, data: { signed: true } });
    expect(h.order).toEqual(["claim", "upload"]);
    const [scope, hash] = h.withIdempotency.mock.calls[0];
    expect(scope).toEqual({ organizationId: "o1", userId: "u1", route: `/api/tech/jobs/${ID}/signature`, key: "sig-key-1" });
    const fileSha256 = createHash("sha256").update(BYTES).digest("hex");
    expect(hash).toBe(multipartHash({ route: `/api/tech/jobs/${ID}/signature`, requestId: ID, fileSha256, name: NAME }));
    expect(h.recordSignature).toHaveBeenCalledWith("o1", "u1", ID, {
      signatureUrl: `${PUBLIC}/o1/${ID}/new-signature.png`,
      signatureName: NAME,
    });
  });

  it("not_owned deletes the fresh upload and 404s", async () => {
    h.recordSignature.mockResolvedValue({ ok: false, reason: "not_owned" });
    const res = await POST(req(), ctx());
    expect(res.status).toBe(404);
    expect(h.deleteFile).toHaveBeenCalledWith(`o1/${ID}/new-signature.png`);
    expect(h.after).not.toHaveBeenCalled();
  });

  it("deletes the previous object in after() when no invoice snapshot references it", async () => {
    await POST(req(), ctx());
    expect(h.deleteFile).not.toHaveBeenCalled(); // not inline
    await runAfter();
    expect(h.execute).toHaveBeenCalledTimes(1);
    expect(h.deleteFile).toHaveBeenCalledWith(`o1/${ID}/old.png`);
  });

  it("keeps the previous object when an invoice snapshot references it", async () => {
    h.execute.mockResolvedValue({ rows: [{ referenced: true }] });
    await POST(req(), ctx());
    await runAfter();
    expect(h.deleteFile).not.toHaveBeenCalled();
  });

  it("deletes nothing when there was no previous signature or the URL is unchanged", async () => {
    h.recordSignature.mockResolvedValue({ ok: true, previousUrl: null });
    await POST(req(), ctx());
    h.recordSignature.mockResolvedValue({ ok: true, previousUrl: `${PUBLIC}/o1/${ID}/new-signature.png` });
    await POST(req(), ctx());
    await runAfter();
    expect(h.execute).not.toHaveBeenCalled();
    expect(h.deleteFile).not.toHaveBeenCalled();
  });

  it("a replay uploads nothing, deletes nothing, returns the stored 201", async () => {
    h.withIdempotency.mockResolvedValue({ status: 201, envelope: { success: true, data: { signed: true } }, replayed: true });
    const res = await POST(req(), ctx());
    expect(res.status).toBe(201);
    expect(h.uploadFile).not.toHaveBeenCalled();
    expect(h.after).not.toHaveBeenCalled();
    expect(h.logAudit).not.toHaveBeenCalled();
  });

  it("deletes the uploaded object and logs only a code when recordSignature throws (no orphaned image)", async () => {
    const dbError = Object.assign(new Error(`Failed query\nparams: ${NAME}`), { query: "UPDATE", params: [NAME], cause: { code: "40P01" } });
    h.recordSignature.mockRejectedValueOnce(dbError);
    const res = await POST(req(), ctx());
    expect(res.status).toBe(500);
    expect(h.deleteFile).toHaveBeenCalledTimes(1);
    expect(h.deleteFile).toHaveBeenCalledWith(h.uploadFile.mock.calls[0][1]);
    expect(h.logError).toHaveBeenCalledWith({ code: "40P01" }, "Failed to capture signature");
    expect(JSON.stringify(h.logError.mock.calls)).not.toContain(NAME);
  });

  it("never logs the customer's printed name", async () => {
    h.recordSignature.mockResolvedValueOnce({ ok: true, previousUrl: OLD_URL });
    await POST(req(), ctx());
    h.deleteFile.mockRejectedValueOnce(new Error("r2"));
    await runAfter();
    h.uploadFile.mockRejectedValueOnce(new Error("upload"));
    await POST(req(), ctx());
    const logged = JSON.stringify([h.logInfo.mock.calls, h.logError.mock.calls, h.logWarn.mock.calls, h.logAudit.mock.calls]);
    expect(h.logInfo).toHaveBeenCalled();
    expect(logged).not.toContain(NAME);
  });
});
