import { describe, it, expect } from "vitest";
import {
  buildDemandRows,
  buildRevenueRows,
  ALL_JOB_TYPES,
  NATIVE_PAYMENT,
  SYNCED_CREATION,
} from "./rollups";

const EMPTY = {
  nativeCollected: [],
  nativeRefunded: [],
  nativeInvoiced: [],
  syncedInvoiced: [],
  syncedCollected: [],
};

describe("buildDemandRows", () => {
  it("emits one '__all__' row per day with the total bookings + session funnel", () => {
    const rows = buildDemandRows(
      [
        { day: "2026-06-01", jobType: "no_cool", n: 3 },
        { day: "2026-06-01", jobType: "maintenance", n: 2 },
      ],
      [{ day: "2026-06-01", sessions: 10, booked: 5 }],
    );
    const all = rows.find((r) => r.jobType === ALL_JOB_TYPES && r.day === "2026-06-01")!;
    expect(all.bookings).toBe(5); // 3 + 2
    expect(all.sessions).toBe(10);
    expect(all.booked).toBe(5);
  });

  it("emits a per-jobType row (sessions/booked only on the __all__ row)", () => {
    const rows = buildDemandRows([{ day: "2026-06-01", jobType: "no_cool", n: 3 }], []);
    const perType = rows.find((r) => r.jobType === "no_cool")!;
    expect(perType.bookings).toBe(3);
    expect(perType.sessions).toBe(0);
    expect(perType.booked).toBe(0);
  });

  it("counts a null jobType into the day total but emits no per-type row for it", () => {
    const rows = buildDemandRows([{ day: "2026-06-01", jobType: null, n: 4 }], []);
    const all = rows.find((r) => r.jobType === ALL_JOB_TYPES)!;
    expect(all.bookings).toBe(4);
    expect(rows.filter((r) => r.jobType !== ALL_JOB_TYPES)).toHaveLength(0);
  });

  it("creates a day row from sessions even when there were no bookings", () => {
    const rows = buildDemandRows([], [{ day: "2026-06-02", sessions: 7, booked: 0 }]);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      day: "2026-06-02",
      jobType: ALL_JOB_TYPES,
      bookings: 0,
      sessions: 7,
      booked: 0,
    });
  });

  it("coerces neon-http string aggregates to numbers", () => {
    const rows = buildDemandRows(
      [{ day: "2026-06-01", jobType: "no_cool", n: "3" }],
      [{ day: "2026-06-01", sessions: "10", booked: "5" }],
    );
    const all = rows.find((r) => r.jobType === ALL_JOB_TYPES)!;
    expect(all.bookings).toBe(3);
    expect(all.sessions).toBe(10);
    expect(all.booked).toBe(5);
  });
});

describe("buildRevenueRows", () => {
  it("builds a native_payment row from collected/invoiced/refunded", () => {
    const rows = buildRevenueRows({
      ...EMPTY,
      nativeCollected: [{ day: "2026-06-01", cents: 30_000 }],
      nativeRefunded: [{ day: "2026-06-01", cents: 1_000 }],
      nativeInvoiced: [{ day: "2026-06-01", cents: 40_000 }],
    });
    const row = rows.find((r) => r.basis === NATIVE_PAYMENT)!;
    expect(row).toEqual({
      day: "2026-06-01",
      basis: NATIVE_PAYMENT,
      collectedCents: 30_000,
      invoicedCents: 40_000,
      refundedCents: 1_000,
    });
  });

  it("builds a synced_creation row with collected/invoiced and zero refunds", () => {
    const rows = buildRevenueRows({
      ...EMPTY,
      syncedInvoiced: [{ day: "2026-06-01", cents: 50_000 }],
      syncedCollected: [{ day: "2026-06-01", cents: 20_000 }],
    });
    const row = rows.find((r) => r.basis === SYNCED_CREATION)!;
    expect(row).toEqual({
      day: "2026-06-01",
      basis: SYNCED_CREATION,
      collectedCents: 20_000,
      invoicedCents: 50_000,
      refundedCents: 0,
    });
  });

  it("NEVER blends: a day with both bases yields two separate rows", () => {
    const rows = buildRevenueRows({
      ...EMPTY,
      nativeCollected: [{ day: "2026-06-01", cents: 100 }],
      syncedInvoiced: [{ day: "2026-06-01", cents: 200 }],
    });
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.basis).sort()).toEqual([NATIVE_PAYMENT, SYNCED_CREATION]);
    // no row carries the other basis's total
    expect(rows.find((r) => r.basis === NATIVE_PAYMENT)!.invoicedCents).toBe(0);
    expect(rows.find((r) => r.basis === SYNCED_CREATION)!.collectedCents).toBe(0);
  });

  it("coerces neon-http string/null sums", () => {
    const rows = buildRevenueRows({
      ...EMPTY,
      nativeCollected: [{ day: "2026-06-01", cents: "500" }],
      nativeInvoiced: [{ day: "2026-06-01", cents: null }],
    });
    const row = rows.find((r) => r.basis === NATIVE_PAYMENT)!;
    expect(row.collectedCents).toBe(500);
    expect(row.invoicedCents).toBe(0);
  });
});
