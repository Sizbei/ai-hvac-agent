import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

vi.mock("@/lib/auth/tech-session", () => ({ getTechSession: vi.fn() }));
vi.mock("@/lib/rate-limit", () => ({
  slidingWindow: () => ({ allowed: true }),
  RATE_LIMITS: { adminMutation: { maxRequests: 1, windowMs: 1 } },
}));
vi.mock("@/lib/tech/field-queries", () => ({
  addJobMaterial: vi.fn(),
  listJobMaterials: vi.fn(),
  removeJobMaterial: vi.fn(),
  isJobOwnedByTech: vi.fn(),
}));

vi.mock("@/lib/tech/invoice-queries", () => ({ billedMaterialIds: vi.fn() }));

import { GET, POST } from "./route";
import { billedMaterialIds } from "@/lib/tech/invoice-queries";
import { getTechSession } from "@/lib/auth/tech-session";
import { addJobMaterial, isJobOwnedByTech, listJobMaterials } from "@/lib/tech/field-queries";

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
    (billedMaterialIds as unknown as Mock).mockResolvedValue(new Set());
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

describe("GET materials — onInvoice", () => {
  it("flags each material by whether it is on a non-void invoice, never exposing cost", async () => {
    (isJobOwnedByTech as unknown as Mock).mockResolvedValue(true);
    (listJobMaterials as unknown as Mock).mockResolvedValue([
      { id: "a", pricebookItemId: null, description: "Cap", quantity: 1, unitCostCents: 100, unitPriceCents: 900 },
      { id: "b", pricebookItemId: null, description: "Tab", quantity: 1, unitCostCents: 50, unitPriceCents: 1200 },
    ]);
    (billedMaterialIds as unknown as Mock).mockResolvedValue(new Set(["a"]));
    const body = await (await GET(req(), ctx(VALID_ID) as never)).json();
    expect(body.data.materials.map((m: { id: string; onInvoice: boolean }) => [m.id, m.onInvoice])).toEqual([["a", true], ["b", false]]);
    expect(JSON.stringify(body)).not.toMatch(/cost/i);
    expect(billedMaterialIds).toHaveBeenCalledWith("o", VALID_ID);
  });
});

const post = (body: unknown) =>
  new Request("http://t/api", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }) as never;
const PB = "22222222-2222-2222-2222-222222222222";

describe("POST /api/tech/jobs/[id]/materials — manual price", () => {
  it("passes a manual line's unitPriceCents through", async () => {
    (addJobMaterial as unknown as Mock).mockResolvedValue({ ok: true, id: "m1" });
    const res = await POST(post({ description: "Capacitor", quantity: 2, unitPriceCents: 4250 }), ctx(VALID_ID) as never);
    expect(res.status).toBe(201);
    expect(addJobMaterial).toHaveBeenCalledWith("o", "u", VALID_ID, {
      pricebookItemId: null, description: "Capacitor", quantity: 2, unitPriceCents: 4250,
    });
  });

  it("a manual line without a price sends null (stored as 0)", async () => {
    (addJobMaterial as unknown as Mock).mockResolvedValue({ ok: true, id: "m1" });
    await POST(post({ description: "Fittings", quantity: 1 }), ctx(VALID_ID) as never);
    expect(addJobMaterial).toHaveBeenCalledWith("o", "u", VALID_ID, expect.objectContaining({ unitPriceCents: null }));
  });

  it("400 for a price on a catalog line", async () => {
    const res = await POST(post({ pricebookItemId: PB, quantity: 1, unitPriceCents: 100 }), ctx(VALID_ID) as never);
    expect(res.status).toBe(400);
    expect(addJobMaterial).not.toHaveBeenCalled();
  });

  it("400 for a negative, fractional or over-cap price", async () => {
    for (const unitPriceCents of [-1, 1.5, 100_000_000]) {
      const res = await POST(post({ description: "x", quantity: 1, unitPriceCents }), ctx(VALID_ID) as never);
      expect(res.status).toBe(400);
    }
    expect(addJobMaterial).not.toHaveBeenCalled();
  });

  it("409 JOB_CLOSED on a completed or cancelled request", async () => {
    (addJobMaterial as unknown as Mock).mockResolvedValue({ ok: false, reason: "job_closed" });
    const res = await POST(post({ description: "x", quantity: 1 }), ctx(VALID_ID) as never);
    expect(res.status).toBe(409);
    const body = await res.json();
    expect(body.error.code).toBe("JOB_CLOSED");
    expect(body.error.message).toBe("This job is closed. Ask the office to add parts.");
  });

  it("400 when the query layer refuses the line total", async () => {
    (addJobMaterial as unknown as Mock).mockResolvedValue({ ok: false, reason: "invalid_input" });
    const res = await POST(post({ description: "x", quantity: 2, unitPriceCents: 60_000_000 }), ctx(VALID_ID) as never);
    expect(res.status).toBe(400);
  });
});
