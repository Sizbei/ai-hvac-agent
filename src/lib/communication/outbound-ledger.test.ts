/**
 * Tests for the outbound-send dedupe ledger.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { claimOutboundOnce } from "./outbound-ledger";
import { db } from "@/lib/db";

vi.mock("@/lib/db", () => ({ db: { insert: vi.fn() } }));

/** Wire db.insert(...).values(...).onConflictDoNothing().returning() -> rows. */
function mockClaim(returnedRows: Array<{ id: string }>) {
  vi.mocked(db.insert).mockReturnValue({
    values: vi.fn().mockReturnValue({
      onConflictDoNothing: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue(returnedRows),
      }),
    }),
  } as never);
}

const params = {
  organizationId: "org-1",
  customerId: "cust-1",
  triggerType: "follow_up" as const,
  periodKey: "2026-06-15",
};

beforeEach(() => vi.clearAllMocks());

describe("claimOutboundOnce", () => {
  it("returns true when the slot is claimed for the first time (row inserted)", async () => {
    mockClaim([{ id: "ledger-1" }]);
    await expect(claimOutboundOnce(params)).resolves.toBe(true);
  });

  it("returns false on a duplicate claim (conflict -> no row inserted)", async () => {
    mockClaim([]);
    await expect(claimOutboundOnce(params)).resolves.toBe(false);
  });
});
