import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * Route-guard + wiring tests for the tech job-photo upload. Exercises the auth
 * gate, file validation, the upload→record flow, and the not_owned cleanup (the
 * orphaned upload is deleted, then 404). Storage + the query are mocked.
 */
const {
  mockGetAdminSession,
  mockAddJobPhoto,
  mockValidateFile,
  mockUploadFile,
  mockDeleteFile,
} = vi.hoisted(() => ({
  mockGetAdminSession: vi.fn(),
  mockAddJobPhoto: vi.fn(),
  mockValidateFile: vi.fn(),
  mockUploadFile: vi.fn(),
  mockDeleteFile: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({
  getAdminSession: () => mockGetAdminSession(),
}));
vi.mock("@/lib/tech/field-queries", () => ({
  addJobPhoto: (...a: unknown[]) => mockAddJobPhoto(...a),
}));
vi.mock("@/lib/storage/r2-client", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/storage/r2-client")>();
  return {
    ...actual,
    getStorageClient: () => ({
      validateFile: (...a: unknown[]) => mockValidateFile(...a),
      uploadFile: (...a: unknown[]) => mockUploadFile(...a),
      deleteFile: (...a: unknown[]) => mockDeleteFile(...a),
    }),
  };
});
vi.mock("@/lib/rate-limit", () => ({
  slidingWindow: vi.fn(() => ({ allowed: true })),
  RATE_LIMITS: { adminMutation: { maxRequests: 100, windowMs: 60000 } },
}));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { POST } from "@/app/api/tech/jobs/[id]/photo/route";
import { NextRequest } from "next/server";

const ORG = "00000000-0000-0000-0000-000000000001";
const TECH = "00000000-0000-0000-0000-0000000000aa";
const JOB = "job-1";
const params = Promise.resolve({ id: JOB });

function reqWithFile(file?: File): NextRequest {
  const fd = new FormData();
  if (file) fd.append("file", file);
  return new NextRequest("http://test/api/tech/jobs/job-1/photo", {
    method: "POST",
    body: fd,
  });
}

const jpeg = () => new File([new Uint8Array([1, 2, 3])], "before.jpg", { type: "image/jpeg" });

beforeEach(() => {
  vi.clearAllMocks();
  mockGetAdminSession.mockResolvedValue({
    userId: TECH,
    organizationId: ORG,
    email: "t@b.co",
    name: "T",
    role: "technician",
  });
  mockValidateFile.mockReturnValue("image/jpeg");
  mockUploadFile.mockResolvedValue({ url: "https://r2/x.jpg", key: "k" });
  mockAddJobPhoto.mockResolvedValue({ ok: true, id: "att-1" });
  mockDeleteFile.mockResolvedValue(undefined);
});

describe("POST /api/tech/jobs/[id]/photo", () => {
  it("401s without a session", async () => {
    mockGetAdminSession.mockResolvedValue(null);
    const res = await POST(reqWithFile(jpeg()), { params });
    expect(res.status).toBe(401);
    expect(mockUploadFile).not.toHaveBeenCalled();
  });

  it("400s when no file is provided", async () => {
    const res = await POST(reqWithFile(), { params });
    expect(res.status).toBe(400);
    expect(mockUploadFile).not.toHaveBeenCalled();
  });

  it("400s on an invalid file (validateFile rejects)", async () => {
    mockValidateFile.mockReturnValue(null);
    const res = await POST(reqWithFile(jpeg()), { params });
    expect(res.status).toBe(400);
    expect(mockUploadFile).not.toHaveBeenCalled();
  });

  it("uploads then records the photo for an owned job (201)", async () => {
    const res = await POST(reqWithFile(jpeg()), { params });
    expect(res.status).toBe(201);
    expect(mockUploadFile).toHaveBeenCalledTimes(1);
    // Recorded with the session org+tech and the job id, never the body.
    const call = mockAddJobPhoto.mock.calls[0];
    expect(call[0]).toBe(ORG);
    expect(call[1]).toBe(TECH);
    expect(call[2]).toBe(JOB);
    expect(call[3]).toMatchObject({ filename: "before.jpg", mimeType: "image/jpeg" });
  });

  it("deletes the orphaned upload and 404s when the job isn't the tech's (not_owned)", async () => {
    mockAddJobPhoto.mockResolvedValue({ ok: false, reason: "not_owned" });
    const res = await POST(reqWithFile(jpeg()), { params });
    expect(res.status).toBe(404);
    // The just-uploaded file is cleaned up.
    expect(mockDeleteFile).toHaveBeenCalledTimes(1);
  });
});
