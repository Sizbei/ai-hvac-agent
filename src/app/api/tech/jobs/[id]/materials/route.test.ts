import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

vi.mock("@/lib/auth/tech-session", () => ({ getTechSession: vi.fn() }));
vi.mock("@/lib/tech/field-queries", () => ({
  addJobMaterial: vi.fn(),
  listJobMaterials: vi.fn(),
  removeJobMaterial: vi.fn(),
  isJobOwnedByTech: vi.fn(),
}));

import { GET } from "./route";
import { getTechSession } from "@/lib/auth/tech-session";
import { isJobOwnedByTech, listJobMaterials } from "@/lib/tech/field-queries";

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const req = () => new Request("http://t/api") as never;
const VALID_ID = "11111111-1111-1111-1111-111111111111";

beforeEach(() => {
  vi.clearAllMocks();
  (getTechSession as unknown as Mock).mockResolvedValue({ userId: "u", organizationId: "o" });
});

describe("GET /api/tech/jobs/[id]/materials", () => {
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

  it("200 without the cost field", async () => {
    (isJobOwnedByTech as unknown as Mock).mockResolvedValue(true);
    (listJobMaterials as unknown as Mock).mockResolvedValue([
      { id: "m", pricebookItemId: null, description: "Cap", quantity: 1, unitCostCents: 100, unitPriceCents: 900 },
    ]);
    const res = await GET(req(), ctx(VALID_ID) as never);
    const body = await res.json();
    expect(res.status).toBe(200);
    expect(body.data.materials[0]).not.toHaveProperty("unitCostCents");
    expect(body.data.materials[0].unitPriceCents).toBe(900);
  });
});
