/**
 * Tests for the technicians phase in the fp:import script.
 *
 * Verifies:
 *  - syncTechniciansFromFieldpulse is called with the correct orgId
 *  - synced count maps to counts.fetched and counts.updated
 *  - created/skipped remain 0 (no split available from the function)
 *  - errors remain 0 on success
 *  - errors thrown by syncTechniciansFromFieldpulse propagate (runner handles ledger)
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { PHASES, type PhaseResult } from "./run-import";

vi.mock("../technician-sync", () => ({
  syncTechniciansFromFieldpulse: vi.fn(),
}));

// These modules are imported transitively by run-import.ts; mock them so the
// test doesn't need real DB/env wiring.
vi.mock("@/lib/db", () => ({ db: {} }));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));
vi.mock("../client", () => ({ getFieldpulseClient: vi.fn() }));

import { syncTechniciansFromFieldpulse } from "../technician-sync";

const ORG = "org-abc";

function makeCounts(): PhaseResult {
  return { fetched: 0, created: 0, updated: 0, skipped: 0, errors: 0 };
}

// Minimal PhaseContext — only orgId is used by the technicians phase.
function makeCtx() {
  return {
    orgId: ORG,
    dryRun: false,
    db: {} as never,
    fpClient: {} as never,
  };
}

describe("technicians phase fn", () => {
  const techniciansPhase = PHASES.find((p) => p.name === "technicians")!;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("maps synced count into fetched + updated; leaves created/skipped/errors at 0", async () => {
    vi.mocked(syncTechniciansFromFieldpulse).mockResolvedValue({ synced: 5 });

    const counts = makeCounts();
    const result = await techniciansPhase.fn(makeCtx(), counts);

    expect(syncTechniciansFromFieldpulse).toHaveBeenCalledWith(ORG);
    expect(result.fetched).toBe(5);
    expect(result.updated).toBe(5);
    expect(result.created).toBe(0);
    expect(result.skipped).toBe(0);
    expect(result.errors).toBe(0);
  });

  it("maps synced=0 (org not connected) correctly", async () => {
    vi.mocked(syncTechniciansFromFieldpulse).mockResolvedValue({ synced: 0 });

    const result = await techniciansPhase.fn(makeCtx(), makeCounts());

    expect(result.fetched).toBe(0);
    expect(result.updated).toBe(0);
  });

  it("propagates errors thrown by syncTechniciansFromFieldpulse", async () => {
    vi.mocked(syncTechniciansFromFieldpulse).mockRejectedValue(
      new Error("FP network error"),
    );

    await expect(
      techniciansPhase.fn(makeCtx(), makeCounts()),
    ).rejects.toThrow("FP network error");
  });
});
