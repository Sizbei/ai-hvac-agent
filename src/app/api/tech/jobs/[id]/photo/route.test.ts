import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";
import { NextRequest } from "next/server";

const storage = vi.hoisted(() => ({
  validateFile: vi.fn(),
  uploadFile: vi.fn(),
  deleteFile: vi.fn(),
  getSignedReadUrl: vi.fn(),
  verifyMagicBytes: vi.fn(),
}));
vi.mock("@/lib/auth/tech-session", () => ({ getTechSession: vi.fn() }));
vi.mock("@/lib/tech/field-queries", () => ({
  listJobPhotos: vi.fn(),
  isJobOwnedByTech: vi.fn(),
}));
vi.mock("@/lib/tech/photo-writes", () => ({ addJobPhoto: vi.fn() }));
vi.mock("@/lib/storage/r2-client", () => ({
  getStorageClient: vi.fn(() => storage),
  generateStorageKey: vi.fn(() => "org/job/before.jpg"),
  ADMIN_DOCUMENT_MIME_TYPES: [],
  verifyMagicBytes: storage.verifyMagicBytes,
}));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), error: vi.fn(), warn: vi.fn() } }));

import { GET, POST } from "./route";
import { getTechSession } from "@/lib/auth/tech-session";
import { isJobOwnedByTech, listJobPhotos } from "@/lib/tech/field-queries";
import { addJobPhoto } from "@/lib/tech/photo-writes";
import { logger } from "@/lib/logger";

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const req = () => new Request("http://t/api") as never;
const VALID_ID = "11111111-1111-1111-1111-111111111111";
const upload = (file: File | null) => {
  const fd = new FormData();
  if (file) fd.append("file", file);
  return new NextRequest(`http://localhost/api/tech/jobs/${VALID_ID}/photo`, { method: "POST", body: fd });
};
const jpeg = (bytes = 3) => new File([new Uint8Array(bytes)], "before.jpg", { type: "image/jpeg" });

beforeEach(() => {
  vi.clearAllMocks();
  (getTechSession as unknown as Mock).mockResolvedValue({ userId: "u", organizationId: "o" });
  storage.validateFile.mockReturnValue("image/jpeg");
  storage.uploadFile.mockResolvedValue(undefined);
  storage.deleteFile.mockResolvedValue(undefined);
  storage.verifyMagicBytes.mockReturnValue(true);
});

describe("GET /api/tech/jobs/[id]/photo", () => {
  it("400 INVALID_ID for a non-UUID id, before any query", async () => {
    const res = await GET(req(), ctx("not-a-uuid") as never);
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("INVALID_ID");
    expect(isJobOwnedByTech).not.toHaveBeenCalled();
  });

  it("404 when the job isn't the tech's", async () => {
    (isJobOwnedByTech as unknown as Mock).mockResolvedValue(false);
    expect((await GET(req(), ctx(VALID_ID) as never)).status).toBe(404);
  });

  it("200 with no photos", async () => {
    (isJobOwnedByTech as unknown as Mock).mockResolvedValue(true);
    (listJobPhotos as unknown as Mock).mockResolvedValue([]);
    const res = await GET(req(), ctx(VALID_ID) as never);
    expect(res.status).toBe(200);
    expect((await res.json()).data.photos).toEqual([]);
  });
});

describe("POST /api/tech/jobs/[id]/photo (M3d spec §7.7)", () => {
  it("400 INVALID_ID for a non-UUID id, before reading the body", async () => {
    const res = await POST(upload(jpeg()), ctx("nope") as never);
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("INVALID_ID");
    expect(storage.uploadFile).not.toHaveBeenCalled();
  });

  it("refuses a file over 4 MB with the same copy as the phone", async () => {
    const res = await POST(upload(jpeg(4 * 1024 * 1024 + 1)), ctx(VALID_ID) as never);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ success: false, error: { code: "INVALID_INPUT", message: "This file is too large. The limit is 4 MB." } });
    expect(storage.uploadFile).not.toHaveBeenCalled();
  });

  it("an erased customer: the upload is deleted and the answer is 409 CUSTOMER_REMOVED", async () => {
    (isJobOwnedByTech as unknown as Mock).mockResolvedValue(true);
    (addJobPhoto as unknown as Mock).mockResolvedValue({ ok: false, reason: "customer_removed" });
    const res = await POST(upload(jpeg()), ctx(VALID_ID) as never);
    expect(res.status).toBe(409);
    expect((await res.json()).error.code).toBe("CUSTOMER_REMOVED");
    expect(storage.deleteFile).toHaveBeenCalledWith("org/job/before.jpg");
  });

  it("201 on success; 404 (and the upload deleted) when the job is no longer the tech's", async () => {
    (isJobOwnedByTech as unknown as Mock).mockResolvedValue(true);
    (addJobPhoto as unknown as Mock).mockResolvedValueOnce({ ok: true, id: "att-1" });
    expect((await POST(upload(jpeg()), ctx(VALID_ID) as never)).status).toBe(201);
    (addJobPhoto as unknown as Mock).mockResolvedValueOnce({ ok: false, reason: "not_owned" });
    expect((await POST(upload(jpeg()), ctx(VALID_ID) as never)).status).toBe(404);
    expect(storage.deleteFile).toHaveBeenCalledTimes(1);
  });

  it("a failed write batch: the upload is deleted and the answer is 409 STALE (retryable)", async () => {
    (isJobOwnedByTech as unknown as Mock).mockResolvedValue(true);
    (addJobPhoto as unknown as Mock).mockResolvedValue({ ok: false, reason: "stale" });
    const res = await POST(upload(jpeg()), ctx(VALID_ID) as never);
    expect(res.status).toBe(409);
    expect(await res.json()).toEqual({ success: false, error: { code: "STALE", message: "This job changed. Try again." } });
    expect(storage.deleteFile).toHaveBeenCalledWith("org/job/before.jpg");
  });

  it("a thrown write (Neon error, lock timeout): the upload is deleted and the answer is 500", async () => {
    (isJobOwnedByTech as unknown as Mock).mockResolvedValue(true);
    (addJobPhoto as unknown as Mock).mockRejectedValue(new Error("fetch failed"));
    const res = await POST(upload(jpeg()), ctx(VALID_ID) as never);
    expect(res.status).toBe(500);
    expect((await res.json()).error.code).toBe("INTERNAL_ERROR");
    expect(storage.deleteFile).toHaveBeenCalledWith("org/job/before.jpg");
  });

  it("a thrown write whose orphan delete also fails: logged (ids only), still 500", async () => {
    (isJobOwnedByTech as unknown as Mock).mockResolvedValue(true);
    (addJobPhoto as unknown as Mock).mockRejectedValue(new Error("fetch failed"));
    storage.deleteFile.mockRejectedValueOnce(new Error("r2 down"));
    expect((await POST(upload(jpeg()), ctx(VALID_ID) as never)).status).toBe(500);
    expect(logger.warn).toHaveBeenCalledWith({ storageKey: "org/job/before.jpg", serviceRequestId: VALID_ID }, "orphan upload delete failed");
  });

  it("bytes that don't match the declared type: 400 with the invalid-file copy, nothing uploaded", async () => {
    (isJobOwnedByTech as unknown as Mock).mockResolvedValue(true);
    storage.verifyMagicBytes.mockReturnValue(false);
    const res = await POST(upload(jpeg()), ctx(VALID_ID) as never);
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({
      success: false,
      error: { code: "INVALID_INPUT", message: "Invalid file. Allowed: JPEG, PNG, WEBP, HEIC, or PDF (max 4 MB)." },
    });
    expect(storage.verifyMagicBytes).toHaveBeenCalledWith(expect.any(ArrayBuffer), "image/jpeg");
    expect(storage.uploadFile).not.toHaveBeenCalled();
    expect(addJobPhoto).not.toHaveBeenCalled();
  });

  it("logs a failed orphan delete (ids only) and still answers", async () => {
    (isJobOwnedByTech as unknown as Mock).mockResolvedValue(true);
    (addJobPhoto as unknown as Mock).mockResolvedValue({ ok: false, reason: "not_owned" });
    storage.deleteFile.mockRejectedValueOnce(new Error("r2 down"));
    expect((await POST(upload(jpeg()), ctx(VALID_ID) as never)).status).toBe(404);
    expect(logger.warn).toHaveBeenCalledWith({ storageKey: "org/job/before.jpg", serviceRequestId: VALID_ID }, "orphan upload delete failed");
  });
});
