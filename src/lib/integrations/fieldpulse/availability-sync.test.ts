/**
 * Tests for Fieldpulse availability sync orchestration.
 *
 * Failure modes covered (the "drawbacks"):
 * - org not connected -> safe no-op
 * - concurrent sync (CAS claim returns 0 rows) -> "Sync already in progress"
 * - Fieldpulse listAvailability throws -> status marked failed, never throws
 * - the failed-status write ITSELF throwing -> still swallowed (no escape)
 * - happy path -> real slots resolved, cleared via inArray, inserted, completed
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { syncAvailabilityFromFieldpulse } from "./availability-sync";
import { db } from "@/lib/db";
import { getFieldpulseClient } from "./client";

vi.mock("@/lib/db", () => ({
  db: {
    select: vi.fn(),
    update: vi.fn(),
    insert: vi.fn(),
    delete: vi.fn(),
  },
}));

vi.mock("./client", () => ({
  getFieldpulseClient: vi.fn(),
}));

vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const ORG = "org-1";

/** Build a fake Fieldpulse client exposing only listAvailability. */
function fakeClient(listAvailability: ReturnType<typeof vi.fn>) {
  return { listAvailability } as never;
}

/** Wire db.update: first call (claimSync) returns rows via .returning(); later
 *  calls (markCompleted/safeMarkFailed) are awaited directly off .where(). */
function wireUpdate(claimRows: Array<{ id: string }>, statusWhere = vi.fn().mockResolvedValue(undefined)) {
  const claimReturning = vi.fn().mockResolvedValue(claimRows);
  const claimWhere = vi.fn().mockReturnValue({ returning: claimReturning });
  const claimSet = vi.fn().mockReturnValue({ where: claimWhere });
  const statusSet = vi.fn().mockReturnValue({ where: statusWhere });
  vi.mocked(db.update)
    .mockReturnValueOnce({ set: claimSet } as never)
    .mockReturnValue({ set: statusSet } as never);
  return { claimWhere, statusWhere };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("syncAvailabilityFromFieldpulse", () => {
  it("no-ops when the org is not Fieldpulse-connected", async () => {
    vi.mocked(getFieldpulseClient).mockResolvedValue(null);

    const result = await syncAvailabilityFromFieldpulse(ORG);

    expect(result).toEqual({
      success: false,
      synced: 0,
      error: "Fieldpulse not connected",
    });
    expect(db.update).not.toHaveBeenCalled(); // never even tried to claim
  });

  it("returns 'already in progress' when the CAS claim wins zero rows", async () => {
    vi.mocked(getFieldpulseClient).mockResolvedValue(
      fakeClient(vi.fn()),
    );
    wireUpdate([]); // claim affected no rows -> another sync holds it

    const result = await syncAvailabilityFromFieldpulse(ORG);

    expect(result).toEqual({
      success: false,
      synced: 0,
      error: "Sync already in progress",
    });
  });

  it("maps real slots, clears affected techs, inserts, and completes", async () => {
    const listAvailability = vi.fn().mockResolvedValue([
      { startIso: "2026-01-07T13:00:00.000Z", endIso: "2026-01-07T17:00:00.000Z", userId: "u1" },
      { startIso: "2026-01-08T13:00:00.000Z", endIso: "2026-01-08T17:00:00.000Z", userId: "u2" },
      // unknown technician -> should be dropped (no DB row resolves)
      { startIso: "2026-01-09T13:00:00.000Z", endIso: "2026-01-09T17:00:00.000Z", userId: "ghost" },
    ]);
    vi.mocked(getFieldpulseClient).mockResolvedValue(fakeClient(listAvailability));
    wireUpdate([{ id: "conn-1" }]);

    // resolveTechnicianIds: only u1 + u2 map to real technicians
    const selectWhere = vi.fn().mockResolvedValue([
      { id: "tech-1", fieldpulseUserId: "u1" },
      { id: "tech-2", fieldpulseUserId: "u2" },
    ]);
    vi.mocked(db.select).mockReturnValue({
      from: vi.fn().mockReturnValue({ where: selectWhere }),
    } as never);

    const deleteWhere = vi.fn().mockResolvedValue(undefined);
    vi.mocked(db.delete).mockReturnValue({ where: deleteWhere } as never);

    const insertValues = vi.fn().mockResolvedValue(undefined);
    vi.mocked(db.insert).mockReturnValue({ values: insertValues } as never);

    const result = await syncAvailabilityFromFieldpulse(ORG);

    expect(result.success).toBe(true);
    expect(result.synced).toBe(2); // ghost dropped
    // Inserted exactly the two resolved technicians' slots.
    expect(insertValues).toHaveBeenCalledTimes(1);
    const insertedRows = insertValues.mock.calls[0]![0] as Array<{ technicianId: string }>;
    expect(insertedRows.map((r) => r.technicianId).sort()).toEqual(["tech-1", "tech-2"]);
    // Cleared availability for the affected technicians (delete was issued).
    expect(deleteWhere).toHaveBeenCalledTimes(1);
  });

  it("marks the sync failed and returns the error when Fieldpulse throws (no throw escapes)", async () => {
    const listAvailability = vi.fn().mockRejectedValue(new Error("FP 503"));
    vi.mocked(getFieldpulseClient).mockResolvedValue(fakeClient(listAvailability));
    const { statusWhere } = wireUpdate([{ id: "conn-1" }]);

    const result = await syncAvailabilityFromFieldpulse(ORG);

    expect(result).toEqual({ success: false, synced: 0, error: "FP 503" });
    // safeMarkFailed issued the status UPDATE.
    expect(statusWhere).toHaveBeenCalled();
  });

  it("swallows a DB error thrown while recording the failure status", async () => {
    const listAvailability = vi.fn().mockRejectedValue(new Error("FP down"));
    vi.mocked(getFieldpulseClient).mockResolvedValue(fakeClient(listAvailability));
    // status write itself throws — must NOT escape.
    wireUpdate([{ id: "conn-1" }], vi.fn().mockRejectedValue(new Error("DB down")));

    const result = await syncAvailabilityFromFieldpulse(ORG);

    expect(result).toEqual({ success: false, synced: 0, error: "FP down" });
  });
});
