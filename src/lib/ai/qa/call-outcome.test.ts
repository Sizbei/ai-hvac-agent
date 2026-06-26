import { describe, it, expect } from "vitest";
import { classifyCallOutcome } from "./call-outcome";
import type { CallQaSummary } from "./call-qa";

const cleanQa: CallQaSummary = {
  hardFail: false,
  violations: [],
  coachingGaps: [],
  judge: null,
};

describe("classifyCallOutcome", () => {
  it("booked → not a recovery candidate, no loss driver", () => {
    const r = classifyCallOutcome({ sessionOutcome: "booked", qa: cleanQa });
    expect(r.outcome).toBe("booked");
    expect(r.recoveryCandidate).toBe(false);
    expect(r.lostToViolation).toBeNull();
  });

  it("abandoned → recovery candidate", () => {
    const r = classifyCallOutcome({ sessionOutcome: "abandoned", qa: cleanQa });
    expect(r.outcome).toBe("abandoned");
    expect(r.recoveryCandidate).toBe(true);
  });

  it("info_provided / unresolved → unbooked recovery candidate", () => {
    expect(classifyCallOutcome({ sessionOutcome: "info_provided", qa: cleanQa }).outcome).toBe("unbooked");
    const r = classifyCallOutcome({ sessionOutcome: "unresolved", qa: cleanQa });
    expect(r.outcome).toBe("unbooked");
    expect(r.recoveryCandidate).toBe(true);
  });

  it("escalated → human-handled, not a recovery candidate", () => {
    const r = classifyCallOutcome({ sessionOutcome: "escalated", qa: cleanQa });
    expect(r.outcome).toBe("escalated");
    expect(r.recoveryCandidate).toBe(false);
  });

  it("null / unknown outcome → unknown, not a recovery candidate", () => {
    expect(classifyCallOutcome({ sessionOutcome: null, qa: cleanQa }).outcome).toBe("unknown");
    expect(classifyCallOutcome({ sessionOutcome: "weird", qa: cleanQa }).recoveryCandidate).toBe(false);
  });

  it("surfaces a loss driver when a NOT-booked call tripped a violation", () => {
    const qa: CallQaSummary = { hardFail: true, violations: ["pricing"], coachingGaps: [], judge: null };
    const r = classifyCallOutcome({ sessionOutcome: "unresolved", qa });
    expect(r.lostToViolation).toBe("pricing");
    expect(r.reasons.some((x) => x.includes("pricing"))).toBe(true);
  });

  it("does NOT attribute a loss driver to a BOOKED call even if a violation tripped", () => {
    const qa: CallQaSummary = { hardFail: true, violations: ["false-booking"], coachingGaps: [], judge: null };
    const r = classifyCallOutcome({ sessionOutcome: "booked", qa });
    expect(r.lostToViolation).toBeNull();
  });
});
