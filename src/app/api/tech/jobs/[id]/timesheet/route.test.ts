import { describe, it, expect, vi, beforeEach, type Mock } from "vitest";

vi.mock("@/lib/auth/tech-session", () => ({ getTechSession: vi.fn() }));
vi.mock("@/lib/tech/field-queries", () => ({ isJobOwnedByTech: vi.fn() }));
vi.mock("@/lib/tech/timesheet-queries", () => ({
  clockIn: vi.fn(),
  clockOut: vi.fn(),
  listTimeEntries: vi.fn(),
}));

import { GET } from "./route";
import { getTechSession } from "@/lib/auth/tech-session";
import { isJobOwnedByTech } from "@/lib/tech/field-queries";
import { listTimeEntries } from "@/lib/tech/timesheet-queries";

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });
const req = () => new Request("http://t/api") as never;
const VALID_ID = "11111111-1111-1111-1111-111111111111";

const entry = (over: Record<string, unknown>) => ({
  id: "e",
  technicianId: "u",
  clockInAt: new Date("2026-11-05T14:00:00Z"),
  clockOutAt: new Date("2026-11-05T14:30:00Z"),
  minutes: 30,
  laborRateCents: 5000,
  laborCostCents: 2500,
  note: null,
  ...over,
});

beforeEach(() => {
  vi.clearAllMocks();
  (getTechSession as unknown as Mock).mockResolvedValue({ userId: "u", organizationId: "o" });
  (isJobOwnedByTech as unknown as Mock).mockResolvedValue(true);
});

describe("GET /api/tech/jobs/[id]/timesheet", () => {
  it("401 without a tech session", async () => {
    (getTechSession as unknown as Mock).mockResolvedValue(null);
    const res = await GET(req(), ctx(VALID_ID) as never);
    expect(res.status).toBe(401);
  });

  it("400 INVALID_ID for a non-UUID id, before any query", async () => {
    const res = await GET(req(), ctx("not-a-uuid") as never);
    expect(res.status).toBe(400);
    expect((await res.json()).error.code).toBe("INVALID_ID");
    expect(isJobOwnedByTech).not.toHaveBeenCalled();
  });

  it("404 when the job isn't the tech's", async () => {
    (isJobOwnedByTech as unknown as Mock).mockResolvedValue(false);
    const res = await GET(req(), ctx(VALID_ID) as never);
    expect(res.status).toBe(404);
  });

  it("totals only this tech's closed minutes and strips payroll fields", async () => {
    (listTimeEntries as unknown as Mock).mockResolvedValue([
      entry({ id: "a", minutes: 30 }),
      entry({ id: "b", technicianId: "other", minutes: 90 }),
      entry({ id: "c", minutes: 12 }),
      entry({ id: "d", clockOutAt: null, minutes: null, clockInAt: new Date("2026-11-05T15:00:00Z") }),
    ]);
    const res = await GET(req(), ctx(VALID_ID) as never);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body.data.totalMinutes).toBe(42);
    expect(body.data.open).toEqual({ id: "d", clockInAt: "2026-11-05T15:00:00.000Z" });
    expect(JSON.stringify(body.data)).not.toMatch(/laborRate|laborCost/);
  });
});
