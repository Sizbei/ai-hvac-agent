/**
 * Tests for Fieldpulse technician sync.
 *
 * Key safety properties (the "drawbacks" fixed):
 * - an empty Fieldpulse roster must NOT mass-deactivate every technician
 * - non-connected org -> safe no-op
 * - technicians present -> upsert per tech, then a single guarded deactivation
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { syncTechniciansFromFieldpulse } from "./technician-sync";
import { db } from "@/lib/db";
import { getFieldpulseClient } from "./client";

vi.mock("@/lib/db", () => ({
  db: { insert: vi.fn(), update: vi.fn(), select: vi.fn() },
}));
vi.mock("./client", () => ({ getFieldpulseClient: vi.fn() }));
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

describe("syncTechniciansFromFieldpulse", () => {
  it("no-ops when the org is not connected", async () => {
    vi.mocked(getFieldpulseClient).mockResolvedValue(null);
    const result = await syncTechniciansFromFieldpulse(ORG);
    expect(result).toEqual({ synced: 0 });
    expect(db.insert).not.toHaveBeenCalled();
    expect(db.update).not.toHaveBeenCalled();
  });

  it("does NOT mass-deactivate when Fieldpulse returns no technicians", async () => {
    vi.mocked(getFieldpulseClient).mockResolvedValue({
      // roster has only non-technicians -> zero technicians after filter
      listUsers: vi.fn().mockResolvedValue([
        { id: "u1", name: "Owner", email: "o@x.com", role: "admin" },
      ]),
    } as never);
    wireInsert();
    const { set } = wireUpdate();

    const result = await syncTechniciansFromFieldpulse(ORG);

    expect(result.synced).toBe(0);
    expect(db.insert).not.toHaveBeenCalled();
    // The guard must prevent the deactivation UPDATE entirely.
    expect(set).not.toHaveBeenCalled();
  });

  it("upserts each technician then issues one guarded deactivation", async () => {
    vi.mocked(getFieldpulseClient).mockResolvedValue({
      listUsers: vi.fn().mockResolvedValue([
        { id: "t1", name: "Tech One", email: "t1@x.com", role: "technician", isActive: true },
        { id: "t2", name: "Tech Two", email: "t2@x.com", role: "Technician", isActive: true },
        { id: "x", name: "Admin", email: "a@x.com", role: "admin" },
      ]),
    } as never);
    const { values } = wireInsert();
    const { set } = wireUpdate();

    const result = await syncTechniciansFromFieldpulse(ORG);

    expect(result.synced).toBe(2); // admin filtered out
    expect(values).toHaveBeenCalledTimes(2);
    // Deactivation UPDATE runs exactly once (roster non-empty).
    expect(set).toHaveBeenCalledTimes(1);
  });

  it("degrades safely (synced 0) when listUsers throws", async () => {
    vi.mocked(getFieldpulseClient).mockResolvedValue({
      listUsers: vi.fn().mockRejectedValue(new Error("FP 500")),
    } as never);
    const result = await syncTechniciansFromFieldpulse(ORG);
    expect(result).toEqual({ synced: 0 });
  });
});
