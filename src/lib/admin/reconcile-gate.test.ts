import { describe, expect, it } from "vitest";
import { reconcileShouldRun } from "./reconcile-gate";

describe("reconcileShouldRun", () => {
  it("waits while the invoice list is still loading its first rows", () => {
    expect(reconcileShouldRun({ firstPaintDone: false, alreadyRan: false })).toBe(false);
  });

  it("runs once the list has settled", () => {
    expect(reconcileShouldRun({ firstPaintDone: true, alreadyRan: false })).toBe(true);
  });

  it("never runs a second time (filter refetches don't re-poll)", () => {
    expect(reconcileShouldRun({ firstPaintDone: true, alreadyRan: true })).toBe(false);
    expect(reconcileShouldRun({ firstPaintDone: false, alreadyRan: true })).toBe(false);
  });
});
