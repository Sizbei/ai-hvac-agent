/**
 * Tests for Housecall Pro technician sync (mirror of the Fieldpulse suite).
 *
 * Key safety properties:
 * - an empty HCP roster must NOT mass-deactivate every technician
 * - a non-connected org -> safe no-op
 * - employees present -> upsert per (email+name) tech, then ONE guarded deactivation
 * - an HCP error -> safe degrade (synced 0)
 *
 * NB (divergence from FP): HCP has no role field, so the "empty roster" case must
 * return an actually-empty listTechnicians() array — there is no non-tech row to
 * filter out.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { syncTechniciansFromHousecall } from "./technician-sync";
import { db } from "@/lib/db";
import { getHousecallClient } from "./client";

vi.mock("@/lib/db", () => ({
  db: { insert: vi.fn(), update: vi.fn(), select: vi.fn() },
}));
vi.mock("./client", () => ({ getHousecallClient: vi.fn() }));
vi.mock("@/lib/logger", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

const ORG = "org-1";

function wireInsert() {
  const returning = vi.fn().mockResolvedValue([{ id: "user-db-1" }]);
  const onConflictDoUpdate = vi.fn().mockReturnValue({ returning });
  const values = vi.fn().mockReturnValue({ onConflictDoUpdate });
  vi.mocked(db.insert).mockReturnValue({ values } as never);
  return { values, onConflictDoUpdate };
}

function wireUpdate() {
  const where = vi.fn().mockResolvedValue(undefined);
  const set = vi.fn().mockReturnValue({ where });
  vi.mocked(db.update).mockReturnValue({ set } as never);
  return { set, where };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("syncTechniciansFromHousecall", () => {
  it("no-ops when the org is not connected", async () => {
    vi.mocked(getHousecallClient).mockResolvedValue(null);
    const result = await syncTechniciansFromHousecall(ORG);
    expect(result).toEqual({ synced: 0 });
    expect(db.insert).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });

  it("does NOT mass-deactivate when HCP returns an empty roster", async () => {
    vi.mocked(getHousecallClient).mockResolvedValue({
      listTechnicians: vi.fn().mockResolvedValue([]),
    } as never);
    wireInsert();
    const { set } = wireUpdate();

    const result = await syncTechniciansFromHousecall(ORG);

    expect(result.synced).toBe(0);
    expect(db.insert).not.toHaveBeenCalled();
    // The guard must prevent the deactivation UPDATE entirely.
    expect(set).not.toHaveBeenCalled();
  });

  it("upserts each valid technician (skipping one without email) then issues one guarded deactivation", async () => {
    vi.mocked(getHousecallClient).mockResolvedValue({
      listTechnicians: vi.fn().mockResolvedValue([
        { id: "t1", name: "Tech One", email: "T1@x.com", isActive: true },
        { id: "t2", name: "Tech Two", email: "t2@x.com", isActive: false },
        { id: "t3", name: "No Email", isActive: true }, // skipped: no email
      ]),
    } as never);
    const { values } = wireInsert();
    const { set } = wireUpdate();

    const result = await syncTechniciansFromHousecall(ORG);

    expect(result.synced).toBe(2); // the email-less tech is skipped
    expect(values).toHaveBeenCalledTimes(2);
    // Email is normalized to lowercase before the upsert.
    expect(values).toHaveBeenCalledWith(
      expect.objectContaining({ email: "t1@x.com", housecallProUserId: "t1" }),
    );
    // Deactivation UPDATE runs exactly once (roster non-empty).
    expect(set).toHaveBeenCalledTimes(1);
  });

  it("degrades safely (synced 0) when listTechnicians throws", async () => {
    vi.mocked(getHousecallClient).mockResolvedValue({
      listTechnicians: vi.fn().mockRejectedValue(new Error("HCP 500")),
    } as never);
    const result = await syncTechniciansFromHousecall(ORG);
    expect(result).toEqual({ synced: 0 });
  });
});
