import { describe, it, expect } from "vitest";
import { isArrivalLate } from "./delay-detection";

const windowEnd = new Date("2026-07-01T16:00:00Z"); // 4:00 PM
const GRACE = 15;

describe("isArrivalLate", () => {
  it("is late when the window passed by more than the grace and not started", () => {
    const now = windowEnd.getTime() + 20 * 60_000; // 20 min after
    expect(isArrivalLate({ status: "assigned", arrivalWindowEnd: windowEnd }, now, GRACE)).toBe(true);
    expect(isArrivalLate({ status: "scheduled", arrivalWindowEnd: windowEnd }, now, GRACE)).toBe(true);
  });

  it("is NOT late inside the grace buffer", () => {
    const now = windowEnd.getTime() + 10 * 60_000; // within 15-min grace
    expect(isArrivalLate({ status: "assigned", arrivalWindowEnd: windowEnd }, now, GRACE)).toBe(false);
  });

  it("is NOT late once the tech has started or finished", () => {
    const now = windowEnd.getTime() + 60 * 60_000;
    expect(isArrivalLate({ status: "in_progress", arrivalWindowEnd: windowEnd }, now, GRACE)).toBe(false);
    expect(isArrivalLate({ status: "completed", arrivalWindowEnd: windowEnd }, now, GRACE)).toBe(false);
  });

  it("is NOT late with no arrival window set", () => {
    const now = Date.now();
    expect(isArrivalLate({ status: "assigned", arrivalWindowEnd: null }, now, GRACE)).toBe(false);
  });
});

// ── findLateJobsForOrg dedup (H14) ──────────────────────────────────────────
import { vi } from "vitest";
import { findLateJobsForOrg } from "./delay-detection";
import { db } from "@/lib/db";

vi.mock("@/lib/db", () => ({ db: { select: vi.fn() } }));
vi.mock("@/lib/db/schema", () => ({ serviceRequests: {}, users: {} }));
vi.mock("@/lib/db/tenant", () => ({ withTenant: (_t: unknown, _o: unknown, c: unknown) => c }));

function mockRows(rows: unknown[]) {
  vi.mocked(db.select).mockReturnValue({
    from: () => ({ leftJoin: () => ({ where: () => Promise.resolve(rows) }) }),
  } as never);
}

describe("findLateJobsForOrg dedup", () => {
  const windowEnd = new Date("2026-07-03T12:00:00.000Z");
  const now = new Date(windowEnd.getTime() + 60 * 60_000); // an hour past → late
  const base = { id: "r1", referenceNumber: "HVAC-1", status: "assigned", arrivalWindowEnd: windowEnd, technicianName: "Sam" };

  it("includes a late job never alerted for this window", async () => {
    mockRows([{ ...base, delayAlertedWindowEnd: null }]);
    expect((await findLateJobsForOrg("org-1", now, 15)).map((j) => j.id)).toEqual(["r1"]);
  });
  it("skips a late job already alerted for THIS window", async () => {
    mockRows([{ ...base, delayAlertedWindowEnd: windowEnd }]);
    expect(await findLateJobsForOrg("org-1", now, 15)).toEqual([]);
  });
  it("re-includes when the window was rescheduled (marker no longer matches)", async () => {
    mockRows([{ ...base, delayAlertedWindowEnd: new Date("2026-07-02T12:00:00.000Z") }]);
    expect((await findLateJobsForOrg("org-1", now, 15)).map((j) => j.id)).toEqual(["r1"]);
  });
});
