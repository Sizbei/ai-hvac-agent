import { describe, it, expect } from "vitest";
import {
  forecastRevenue,
  assertDisjoint,
  type BookedJob,
  type OpenEstimate,
  type MrrPeriod,
} from "./revenue";

const half = () => 0.5; // closeProb stub

describe("forecastRevenue — partition", () => {
  it("sums the three disjoint streams", () => {
    const booked: BookedJob[] = [{ serviceRequestId: "r1", estimateId: null, cents: 10_000 }];
    const openEstimates: OpenEstimate[] = [
      { estimateId: "e2", serviceRequestId: null, totalCents: 20_000, ageDays: 3 },
    ];
    const mrr: MrrPeriod[] = [{ key: "2026-V1", materializedServiceRequestId: null, cents: 5_000 }];
    const f = forecastRevenue({ booked, openEstimates, mrr, closeProbWithinHorizon: half });
    expect(f.bookedCents).toBe(10_000);
    expect(f.pipelineCents).toBe(10_000); // 20000 * 0.5
    expect(f.mrrCents).toBe(5_000);
    expect(f.totalCents).toBe(25_000);
  });

  it("excludes a pipeline estimate already consumed by a booked job (by estimateId)", () => {
    const booked: BookedJob[] = [{ serviceRequestId: "r1", estimateId: "e1", cents: 10_000 }];
    const openEstimates: OpenEstimate[] = [
      { estimateId: "e1", serviceRequestId: "r1", totalCents: 20_000, ageDays: 1 },
    ];
    const f = forecastRevenue({ booked, openEstimates, mrr: [], closeProbWithinHorizon: half });
    expect(f.pipelineCents).toBe(0); // e1 is already booked → not double-counted
    expect(f.totalCents).toBe(10_000);
  });

  it("excludes a pipeline estimate overlapping a booked job by serviceRequestId", () => {
    const booked: BookedJob[] = [{ serviceRequestId: "r1", estimateId: null, cents: 10_000 }];
    const openEstimates: OpenEstimate[] = [
      { estimateId: "e9", serviceRequestId: "r1", totalCents: 20_000, ageDays: 1 },
    ];
    const f = forecastRevenue({ booked, openEstimates, mrr: [], closeProbWithinHorizon: half });
    expect(f.pipelineCents).toBe(0);
  });

  it("excludes an MRR period already materialized into a booked job", () => {
    const booked: BookedJob[] = [{ serviceRequestId: "r1", estimateId: null, cents: 10_000 }];
    const mrr: MrrPeriod[] = [{ key: "2026-V1", materializedServiceRequestId: "r1", cents: 5_000 }];
    const f = forecastRevenue({ booked, openEstimates: [], mrr, closeProbWithinHorizon: half });
    expect(f.mrrCents).toBe(0);
  });

  it("applies the close probability once (no double-discount)", () => {
    const openEstimates: OpenEstimate[] = [
      { estimateId: "e1", serviceRequestId: null, totalCents: 1_000, ageDays: 10 },
    ];
    const f = forecastRevenue({
      booked: [],
      openEstimates,
      mrr: [],
      closeProbWithinHorizon: (age) => (age === 10 ? 0.25 : 0),
    });
    expect(f.pipelineCents).toBe(250); // 1000 * 0.25, once
  });
});

describe("assertDisjoint", () => {
  it("passes when streams share no entities", () => {
    expect(() =>
      assertDisjoint({
        booked: [{ serviceRequestId: "r1", estimateId: "e1", cents: 1 }],
        openEstimates: [{ estimateId: "e2", serviceRequestId: "r2", totalCents: 1, ageDays: 1 }],
        mrr: [{ key: "k", materializedServiceRequestId: "r3", cents: 1 }],
      }),
    ).not.toThrow();
  });

  it("throws on an estimateId in both booked and pipeline", () => {
    expect(() =>
      assertDisjoint({
        booked: [{ serviceRequestId: "r1", estimateId: "e1", cents: 1 }],
        openEstimates: [{ estimateId: "e1", serviceRequestId: null, totalCents: 1, ageDays: 1 }],
        mrr: [],
      }),
    ).toThrow(/both booked and pipeline/);
  });

  it("throws on a serviceRequestId overlap (estimate vs booked)", () => {
    expect(() =>
      assertDisjoint({
        booked: [{ serviceRequestId: "r1", estimateId: null, cents: 1 }],
        openEstimates: [{ estimateId: "e9", serviceRequestId: "r1", totalCents: 1, ageDays: 1 }],
        mrr: [],
      }),
    ).toThrow(/overlaps a booked job/);
  });

  it("throws on an MRR period overlapping a booked materialized visit", () => {
    expect(() =>
      assertDisjoint({
        booked: [{ serviceRequestId: "r1", estimateId: null, cents: 1 }],
        openEstimates: [],
        mrr: [{ key: "2026-V1", materializedServiceRequestId: "r1", cents: 1 }],
      }),
    ).toThrow(/overlaps a booked materialized visit/);
  });
});
