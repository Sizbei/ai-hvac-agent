import { describe, it, expect } from "vitest";
import { nextRows } from "./setup-view";
import { STEP_DEFS, type DerivedStep, type OnboardingPayload } from "./onboarding-steps";

function payload(done: string[] = []): OnboardingPayload {
  const steps: DerivedStep[] = STEP_DEFS.map(({ live: _live, ...d }) => ({
    ...d,
    done: done.includes(d.id),
    needsAttention: false,
  }));
  return {
    steps,
    progress: { requiredDone: 0, requiredTotal: 4, optionalDone: 0, optionalTotal: 4 },
    upNext: null,
    dismissedAt: null,
    completedSeenAt: null,
    demo: false,
  };
}

const ids = (rows: readonly DerivedStep[]) => rows.map((r) => r.id);

describe("nextRows", () => {
  it("returns required steps first, in step order", () => {
    expect(ids(nextRows(payload(), 3))).toEqual(["phone_hours", "add_technician", "book_first_request"]);
  });

  it("skips done steps", () => {
    expect(ids(nextRows(payload(["phone_hours", "add_technician"]), 2))).toEqual([
      "book_first_request",
      "tech_sign_in",
    ]);
  });

  it("falls through to optional steps in step order once required are done", () => {
    const p = payload(["phone_hours", "add_technician", "book_first_request"]);
    expect(ids(nextRows(p, 3))).toEqual(["tech_sign_in", "brand", "pricebook"]);
  });

  it("returns fewer rows when fewer remain, and none for n <= 0", () => {
    const p = payload(STEP_DEFS.map((d) => d.id).filter((id) => id !== "integrations"));
    expect(ids(nextRows(p, 3))).toEqual(["integrations"]);
    expect(nextRows(payload(), 0)).toEqual([]);
  });
});
