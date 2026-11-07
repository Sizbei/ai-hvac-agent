import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

/**
 * Route-guard + wiring tests for the tech job-photo upload, against the current
 * route (getTechSession, addJobPhoto in photo-writes, ownership checked before
 * the upload). Covers what the co-located route.test.ts doesn't: the 401s, the
 * missing / invalid file 400s, the pre-upload ownership 404, the session-scoped
 * write arguments, and GET's key signing. Storage, session and queries are
 * mocked; nothing touches a database.
 */
const storage = vi.hoisted(() => ({
  validateFile: vi.fn(),
  uploadFile: vi.fn(),
  deleteFile: vi.fn(),
  getSignedReadUrl: vi.fn(),
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
  verifyMagicBytes: vi.fn(() => true),
}));
vi.mock("@/lib/rate-limit", () => ({
  slidingWindow: vi.fn(() => ({ allowed: true })),
  RATE_LIMITS: { adminMutation: { maxRequests: 100, windowMs: 60000 } },
}));
vi.mock("@/lib/logger", () => ({ logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { NextRequest } from "next/server";
import { POST, GET } from "@/app/api/tech/jobs/[id]/photo/route";
import { getTechSession } from "@/lib/auth/tech-session";
import { isJobOwnedByTech, listJobPhotos } from "@/lib/tech/field-queries";
import { addJobPhoto } from "@/lib/tech/photo-writes";

const ORG = "00000000-0000-0000-0000-000000000001";
const TECH = "00000000-0000-0000-0000-0000000000aa";
const JOB = "11111111-1111-1111-1111-111111111111";
const params = () => Promise.resolve({ id: JOB });

function reqWithFile(file?: File): NextRequest {
  const fd = new FormData();
  if (file) fd.append("file", file);
  return new NextRequest(`http://test/api/tech/jobs/${JOB}/photo`, { method: "POST", body: fd });
}
const jpeg = () => new File([new Uint8Array([1, 2, 3])], "before.jpg", { type: "image/jpeg" });
const getReq = () => new NextRequest(`http://test/api/tech/jobs/${JOB}/photo`);

beforeEach(() => {
  vi.clearAllMocks();
  (getTechSession as unknown as Mock).mockResolvedValue({ userId: TECH, organizationId: ORG });
  (isJobOwnedByTech as unknown as Mock).mockResolvedValue(true);
  storage.validateFile.mockReturnValue("image/jpeg");
  storage.uploadFile.mockResolvedValue(undefined);
  storage.deleteFile.mockResolvedValue(undefined);
  (addJobPhoto as unknown as Mock).mockResolvedValue({ ok: true, id: "att-1" });
});

describe("POST /api/tech/jobs/[id]/photo", () => {
  it("401s without a session", async () => {
    (getTechSession as unknown as Mock).mockResolvedValue(null);
    const res = await POST(reqWithFile(jpeg()), { params: params() });
    expect(res.status).toBe(401);
    expect(storage.uploadFile).not.toHaveBeenCalled();
  });

  it("400s when no file is provided", async () => {
    const res = await POST(reqWithFile(), { params: params() });
    expect(res.status).toBe(400);
    expect(storage.uploadFile).not.toHaveBeenCalled();
  });

  it("400s on an invalid file (validateFile rejects)", async () => {
    storage.validateFile.mockReturnValue(null);
    const res = await POST(reqWithFile(jpeg()), { params: params() });
    expect(res.status).toBe(400);
    expect(storage.uploadFile).not.toHaveBeenCalled();
  });

  it("404s before uploading when the job isn't the tech's", async () => {
    (isJobOwnedByTech as unknown as Mock).mockResolvedValue(false);
    const res = await POST(reqWithFile(jpeg()), { params: params() });
    expect(res.status).toBe(404);
    expect(isJobOwnedByTech).toHaveBeenCalledWith(ORG, TECH, JOB);
    expect(storage.uploadFile).not.toHaveBeenCalled();
    expect(addJobPhoto).not.toHaveBeenCalled();
  });

  it("uploads then records the photo with the session org + tech and the job id (201)", async () => {
    const res = await POST(reqWithFile(jpeg()), { params: params() });
    expect(res.status).toBe(201);
    expect((await res.json()).data).toEqual({ id: "att-1" });
    expect(storage.uploadFile).toHaveBeenCalledTimes(1);
    expect(addJobPhoto).toHaveBeenCalledWith(ORG, TECH, JOB, {
      filename: "before.jpg",
      mimeType: "image/jpeg",
      size: 3,
      storageKey: "org/job/before.jpg",
    });
    expect(storage.deleteFile).not.toHaveBeenCalled();
  });
});

describe("GET /api/tech/jobs/[id]/photo", () => {
  it("401s without a session", async () => {
    (getTechSession as unknown as Mock).mockResolvedValue(null);
    expect((await GET(getReq(), { params: params() })).status).toBe(401);
    expect(listJobPhotos).not.toHaveBeenCalled();
  });

  it("returns an empty list without touching storage", async () => {
    (listJobPhotos as unknown as Mock).mockResolvedValue([]);
    const res = await GET(getReq(), { params: params() });
    expect(res.status).toBe(200);
    expect((await res.json()).data.photos).toEqual([]);
    expect(storage.getSignedReadUrl).not.toHaveBeenCalled();
  });

  it("signs each photo's key into a display URL; a failed sign gives null, not a 500", async () => {
    (listJobPhotos as unknown as Mock).mockResolvedValue([
      { id: "a1", filename: "1.jpg", mimeType: "image/jpeg", size: 10, storageKey: "k1", createdAt: new Date("2026-06-24T10:00:00Z") },
      { id: "a2", filename: "2.pdf", mimeType: "application/pdf", size: 20, storageKey: "k2", createdAt: new Date("2026-06-24T11:00:00Z") },
    ]);
    storage.getSignedReadUrl.mockImplementation(async (key: string) => {
      if (key === "k2") throw new Error("r2 down");
      return `https://r2/signed/${key}`;
    });
    const res = await GET(getReq(), { params: params() });
    expect(res.status).toBe(200);
    expect(listJobPhotos).toHaveBeenCalledWith(ORG, JOB);
    const photos = (await res.json()).data.photos;
    expect(photos[0]).toMatchObject({ id: "a1", url: "https://r2/signed/k1" });
    expect(photos[1]).toMatchObject({ id: "a2", url: null });
    expect(photos[0]).not.toHaveProperty("storageKey");
  });
});
