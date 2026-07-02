import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

vi.mock("@/lib/auth/tech-session", () => ({ getTechSession: vi.fn() }));
vi.mock("@/lib/tech/field-queries", () => ({ getTechJobSummary: vi.fn() }));

import { GET } from "./route";
import { getTechSession } from "@/lib/auth/tech-session";
import { getTechJobSummary } from "@/lib/tech/field-queries";

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const req = () => new Request("http://t/api") as never;
const VALID_ID = "11111111-1111-1111-1111-111111111111";

beforeEach(() => vi.clearAllMocks());

describe("GET /api/tech/jobs/[id]", () => {
  it("401 without a tech session", async () => {
    (getTechSession as unknown as Mock).mockResolvedValue(null);
    const res = await GET(req(), ctx(VALID_ID) as never);
    expect(res.status).toBe(401);
    expect(getTechJobSummary).not.toHaveBeenCalled();
  });

  it("400 on a malformed id", async () => {
    (getTechSession as unknown as Mock).mockResolvedValue({
      userId: "u",
      organizationId: "o",
    });
    const res = await GET(req(), ctx("not-a-uuid") as never);
    expect(res.status).toBe(400);
  });

  it("404 when the job isn't owned by this tech (null summary)", async () => {
    (getTechSession as unknown as Mock).mockResolvedValue({
      userId: "u",
      organizationId: "o",
    });
    (getTechJobSummary as unknown as Mock).mockResolvedValue(null);
    const res = await GET(req(), ctx(VALID_ID) as never);
    expect(res.status).toBe(404);
  });

  it("200 with the summary when owned", async () => {
    (getTechSession as unknown as Mock).mockResolvedValue({
      userId: "u",
      organizationId: "o",
    });
    (getTechJobSummary as unknown as Mock).mockResolvedValue({
      id: VALID_ID,
      referenceNumber: "HVAC-1",
      status: "scheduled",
      allowedNextStatuses: ["in_progress"],
    });
    const res = await GET(req(), ctx(VALID_ID) as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.referenceNumber).toBe("HVAC-1");
    expect(getTechJobSummary).toHaveBeenCalledWith("o", "u", VALID_ID);
  });
});
