import { describe, it, expect } from "vitest";
import {
  sessionSeed,
  buildStyleHint,
  updateReAskState,
  reAskBreakPrompt,
  REASK_BREAK_THRESHOLD,
  frustrationScore,
  updateFrustration,
  FRUSTRATION_OFFER_THRESHOLD,
  FRUSTRATION_HUMAN_OFFER,
} from "./conversation-style";

describe("sessionSeed", () => {
  it("is deterministic for the same id", () => {
    expect(sessionSeed("abc-123")).toBe(sessionSeed("abc-123"));
  });

  it("returns a non-negative integer", () => {
    for (const id of ["", "x", "session-1", "ZZZ", "a".repeat(40)]) {
      const s = sessionSeed(id);
      expect(Number.isInteger(s)).toBe(true);
      expect(s).toBeGreaterThanOrEqual(0);
    }
  });

  it("varies across different ids (so lead-ins rotate per chat)", () => {
    const seeds = new Set(
      ["sess-a", "sess-b", "sess-c", "sess-d", "sess-e"].map(sessionSeed),
    );
    // Not all five must differ, but they must not collapse to one value.
    expect(seeds.size).toBeGreaterThan(1);
  });
});

describe("buildStyleHint (Step 2 — empathy-once across the seam)", () => {
  it("instructs the model NOT to re-acknowledge when empathy was already given", () => {
    const hint = buildStyleHint({ empathyAlreadyGiven: true, turnCount: 2 });
    expect(hint.length).toBeGreaterThan(0);
    expect(hint.toLowerCase()).toContain("already been acknowledged");
    expect(hint).toContain("Got it");
  });

  it("is empty on a fresh first turn with no prior empathy", () => {
    expect(buildStyleHint({ empathyAlreadyGiven: false, turnCount: 1 })).toBe(
      "",
    );
  });

  it("adds a tightness nudge several turns deep", () => {
    const hint = buildStyleHint({ empathyAlreadyGiven: false, turnCount: 4 });
    expect(hint.length).toBeGreaterThan(0);
    expect(hint.toLowerCase()).toContain("tight");
  });
});

describe("updateReAskState (Step 3 — re-ask circuit breaker)", () => {
  it("starts a fresh slot at count 1, no break", () => {
    const r = updateReAskState({
      prevStepId: null,
      prevCount: 0,
      nextStepId: "address",
    });
    expect(r).toEqual({ stepId: "address", count: 1, shouldBreak: false });
  });

  it("climbs the count when the SAME slot is asked again", () => {
    const r = updateReAskState({
      prevStepId: "address",
      prevCount: 1,
      nextStepId: "address",
    });
    expect(r.count).toBe(2);
  });

  it("trips the breaker once the same slot hits the threshold", () => {
    let count = 0;
    let prevStepId: string | null = null;
    let r = { stepId: null as string | null, count: 0, shouldBreak: false };
    for (let i = 0; i < REASK_BREAK_THRESHOLD; i++) {
      r = updateReAskState({
        prevStepId,
        prevCount: count,
        nextStepId: "phone",
      });
      count = r.count;
      prevStepId = r.stepId;
    }
    expect(r.shouldBreak).toBe(true);
    expect(r.count).toBe(REASK_BREAK_THRESHOLD);
  });

  it("resets the count when a DIFFERENT slot is asked (progress)", () => {
    const r = updateReAskState({
      prevStepId: "address",
      prevCount: 3,
      nextStepId: "phone",
    });
    expect(r.count).toBe(1);
    expect(r.shouldBreak).toBe(false);
  });

  it("clears the loop when no slot question is asked this turn (confirm)", () => {
    const r = updateReAskState({
      prevStepId: "address",
      prevCount: 5,
      nextStepId: null,
    });
    expect(r).toEqual({ stepId: null, count: 0, shouldBreak: false });
  });
});

describe("reAskBreakPrompt", () => {
  it("rephrases and surfaces skip + human escapes for a known slot", () => {
    const copy = reAskBreakPrompt("address");
    expect(copy).toBeTruthy();
    expect(copy!.toLowerCase()).toContain("service address");
    expect(copy!.toLowerCase()).toContain("skip");
    expect(copy!.toLowerCase()).toContain("talk to a human");
  });

  it("returns null for an unlabeled step (caller keeps the normal question)", () => {
    expect(reAskBreakPrompt("some_unmapped_step")).toBeNull();
  });
});

describe("frustrationScore (Step 5)", () => {
  it("is 0 for normal intake speech", () => {
    expect(frustrationScore("my ac is not working")).toBe(0);
    expect(frustrationScore("123 Main St, Johnson City TN 37601")).toBe(0);
  });

  it("counts unambiguous frustration signals", () => {
    expect(frustrationScore("this is ridiculous")).toBeGreaterThanOrEqual(1);
    expect(
      frustrationScore("this is ridiculous and unacceptable, useless"),
    ).toBeGreaterThanOrEqual(2);
  });

  it("catches loop-specific frustration ('I already told you')", () => {
    expect(frustrationScore("I already told you my address")).toBeGreaterThanOrEqual(
      1,
    );
  });
});

describe("updateFrustration", () => {
  it("offers a human once the cumulative score crosses the threshold", () => {
    const r = updateFrustration({
      message: "this is ridiculous and unacceptable",
      priorScore: 0,
      alreadyOffered: false,
    });
    expect(r.total).toBeGreaterThanOrEqual(FRUSTRATION_OFFER_THRESHOLD);
    expect(r.offer).toBe(true);
  });

  it("accumulates across turns (rising frustration is caught early)", () => {
    const t1 = updateFrustration({
      message: "this is annoying",
      priorScore: 0,
      alreadyOffered: false,
    });
    expect(t1.offer).toBe(false); // one mild signal, below threshold
    const t2 = updateFrustration({
      message: "still frustrated",
      priorScore: t1.total,
      alreadyOffered: false,
    });
    expect(t2.total).toBeGreaterThanOrEqual(FRUSTRATION_OFFER_THRESHOLD);
    expect(t2.offer).toBe(true);
  });

  it("never re-offers once already offered", () => {
    const r = updateFrustration({
      message: "ridiculous unacceptable terrible",
      priorScore: 5,
      alreadyOffered: true,
    });
    expect(r.offer).toBe(false);
  });

  it("does not offer for non-frustrated turns", () => {
    const r = updateFrustration({
      message: "555-123-4567",
      priorScore: 0,
      alreadyOffered: false,
    });
    expect(r.offer).toBe(false);
  });
});

describe("FRUSTRATION_HUMAN_OFFER copy", () => {
  it("offers a human handoff without being defensive", () => {
    expect(FRUSTRATION_HUMAN_OFFER.toLowerCase()).toContain("talk to a human");
    expect(FRUSTRATION_HUMAN_OFFER.toLowerCase()).toContain("team");
  });
});
