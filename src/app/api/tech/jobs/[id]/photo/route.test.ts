import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

vi.mock("@/lib/auth/tech-session", () => ({ getTechSession: vi.fn() }));
vi.mock("@/lib/tech/field-queries", () => ({
  addJobPhoto: vi.fn(),
  listJobPhotos: vi.fn(),
  isJobOwnedByTech: vi.fn(),
}));
vi.mock("@/lib/storage/r2-client", () => ({
  getStorageClient: vi.fn(),
  generateStorageKey: vi.fn(),
  MAX_DOCUMENT_FILE_SIZE: 10,
  ADMIN_DOCUMENT_MIME_TYPES: [],
}));

import { GET } from "./route";
import { getTechSession } from "@/lib/auth/tech-session";
import { isJobOwnedByTech, listJobPhotos } from "@/lib/tech/field-queries";

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const req = () => new Request("http://t/api") as never;
const VALID_ID = "11111111-1111-1111-1111-111111111111";

beforeEach(() => {
  vi.clearAllMocks();
  (getTechSession as unknown as Mock).mockResolvedValue({ userId: "u", organizationId: "o" });
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
