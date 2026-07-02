import { describe, it, expect } from "vitest";
import { summarizeCallQa } from "./call-qa";
import type { TranscriptQaFlags } from "./transcript-flags";
import type { JudgeScores } from "@/lib/ai/eval/judge";

const cleanFlags: TranscriptQaFlags = {
  greetingGiven: true,
  bookingAttempted: true,
  priceQuoted: false,
  falseBooking: false,
  dangerousDiy: false,
  credentialClaim: false,
};

const goodJudge: JudgeScores = {
  naturalness: 5,
  helpfulness: 5,
  completion: 4,
  pricingLeak: false,
  falseBooking: false,
  rationale: "solid",
};

describe("summarizeCallQa", () => {
  it("a clean call with good judge → no hard fail, no violations/gaps, judge passed through", () => {
    const s = summarizeCallQa(cleanFlags, goodJudge);
    expect(s.hardFail).toBe(false);
    expect(s.violations).toEqual([]);
    expect(s.coachingGaps).toEqual([]);
    expect(s.judge).toBe(goodJudge);
  });

  it("a deterministic price flag → hard fail with a pricing violation", () => {
    const s = summarizeCallQa({ ...cleanFlags, priceQuoted: true });
    expect(s.hardFail).toBe(true);
    expect(s.violations).toContain("pricing");
  });

  it("unions judge detections with deterministic flags (judge-only pricing leak)", () => {
    const s = summarizeCallQa(cleanFlags, { ...goodJudge, pricingLeak: true });
    expect(s.violations).toContain("pricing");
    expect(s.hardFail).toBe(true);
  });

  it("does not double-count when both flag and judge detect the same violation", () => {
    const s = summarizeCallQa(
      { ...cleanFlags, falseBooking: true },
      { ...goodJudge, falseBooking: true },
    );
    expect(s.violations.filter((v) => v === "false-booking")).toHaveLength(1);
  });

  it("missed positives are coaching gaps, NOT hard fails", () => {
    const s = summarizeCallQa({ ...cleanFlags, greetingGiven: false, bookingAttempted: false });
    expect(s.hardFail).toBe(false);
    expect(s.coachingGaps).toEqual(["no-greeting", "no-booking-attempt"]);
  });

  it("works with no judge (flags only) and reports judge: null", () => {
    const s = summarizeCallQa({ ...cleanFlags, dangerousDiy: true, credentialClaim: true });
    expect(s.judge).toBeNull();
    expect(s.violations).toEqual(["dangerous-diy", "credentials"]);
    expect(s.hardFail).toBe(true);
  });

  it("imposes no rubric weighting — low judge scores alone are not a hard fail", () => {
    const s = summarizeCallQa(cleanFlags, { ...goodJudge, naturalness: 1, helpfulness: 1, completion: 1 });
    expect(s.hardFail).toBe(false); // weighting/thresholds are Stage 7 (per-org), not here
    expect(s.judge?.naturalness).toBe(1);
  });
});
