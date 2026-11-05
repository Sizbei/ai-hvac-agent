import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

vi.mock("@/lib/auth/tech-session", () => ({ getTechSession: vi.fn() }));
vi.mock("@/lib/tech/field-queries", () => ({ getJobTimelineForTech: vi.fn() }));

import { GET } from "./route";
import { getTechSession } from "@/lib/auth/tech-session";
import { getJobTimelineForTech } from "@/lib/tech/field-queries";

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const req = () => new Request("http://t/api") as never;
const VALID_ID = "11111111-1111-1111-1111-111111111111";

beforeEach(() => {
  vi.clearAllMocks();
  (getTechSession as unknown as Mock).mockResolvedValue({ userId: "u", organizationId: "o" });
});

describe("GET /api/tech/jobs/[id]/timeline", () => {
  it("400 INVALID_ID for a non-UUID id, before any query", async () => {
    const res = await GET(req(), ctx("not-a-uuid") as never);
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("INVALID_ID");
    expect(getJobTimelineForTech).not.toHaveBeenCalled();
  });

  it("404 when the job isn't the tech's", async () => {
    (getJobTimelineForTech as unknown as Mock).mockResolvedValue({ ok: false });
    expect((await GET(req(), ctx(VALID_ID) as never)).status).toBe(404);
  });

  it("200 with the timeline", async () => {
    (getJobTimelineForTech as unknown as Mock).mockResolvedValue({ ok: true, timeline: [] });
    const res = await GET(req(), ctx(VALID_ID) as never);
    expect(res.status).toBe(200);
    expect((await res.json()).data.timeline).toEqual([]);
  });
});
