import { describe, it, expect, beforeEach, vi } from "vitest";
import { getCommsOutcomeSummary } from "./observability";
import { db } from "@/lib/db";

vi.mock("@/lib/db", () => ({
  db: { select: vi.fn() },
}));

const ORG = "org-1";

/** Make db.select().from().where() resolve to the given rows. */
function mockRows(rows: unknown[]): void {
  vi.mocked(db.select).mockReturnValue({
    from: () => ({ where: () => Promise.resolve(rows) }),
  } as never);
}

beforeEach(() => vi.clearAllMocks());

describe("getCommsOutcomeSummary", () => {
  it("counts terminal/in-flight statuses (sent, failed, pending)", async () => {
    mockRows([
      { status: "sent", channel: "sms", errorMessage: null },
      { status: "sent", channel: "email", errorMessage: null },
      { status: "failed", channel: "sms", errorMessage: "boom" },
      { status: "pending", channel: "sms", errorMessage: null },
      { status: "processing", channel: "sms", errorMessage: null }, // ignored
    ]);
    const r = await getCommsOutcomeSummary(ORG);
    expect(r.sent).toBe(2);
    expect(r.failed).toBe(1);
    expect(r.pending).toBe(1);
    expect(r.suppressedByReason).toEqual({});
    expect(r.emailStalled).toBe(0);
  });

  it("buckets cancelled jobs by their `suppressed:<reason>` tag", async () => {
    mockRows([
      { status: "cancelled", channel: "sms", errorMessage: "suppressed:do_not_contact" },
      { status: "cancelled", channel: "sms", errorMessage: "suppressed:do_not_contact" },
      { status: "cancelled", channel: "sms", errorMessage: "suppressed:quiet_hours" },
      // A cancelled job WITHOUT the suppressed prefix is not bucketed.
      { status: "cancelled", channel: "sms", errorMessage: "manual cancel" },
    ]);
    const r = await getCommsOutcomeSummary(ORG);
    expect(r.suppressedByReason).toEqual({
      do_not_contact: 2,
      quiet_hours: 1,
    });
  });

  it("treats a bare `suppressed:` tag as 'unknown' reason", async () => {
    mockRows([{ status: "cancelled", channel: "sms", errorMessage: "suppressed:" }]);
    const r = await getCommsOutcomeSummary(ORG);
    expect(r.suppressedByReason).toEqual({ unknown: 1 });
  });

  it("counts ONLY pending EMAIL jobs as emailStalled (the RESEND-unset stall)", async () => {
    mockRows([
      { status: "pending", channel: "email", errorMessage: null },
      { status: "pending", channel: "email", errorMessage: null },
      { status: "pending", channel: "sms", errorMessage: null }, // not stalled
      { status: "sent", channel: "email", errorMessage: null }, // already sent
    ]);
    const r = await getCommsOutcomeSummary(ORG);
    expect(r.emailStalled).toBe(2);
    expect(r.pending).toBe(3); // all pending, regardless of channel
  });

  it("returns all-zero on an empty queue", async () => {
    mockRows([]);
    const r = await getCommsOutcomeSummary(ORG);
    expect(r).toEqual({
      sent: 0,
      failed: 0,
      pending: 0,
      suppressedByReason: {},
      emailStalled: 0,
    });
  });

  it("passes a since-window filter through to the query (sinceMs)", async () => {
    mockRows([{ status: "sent", channel: "sms", errorMessage: null }]);
    const r = await getCommsOutcomeSummary(ORG, Date.now() - 86_400_000);
    // The filter is applied in-query; we just assert the call succeeds and shape holds.
    expect(r.sent).toBe(1);
    expect(db.select).toHaveBeenCalledTimes(1);
  });
});
