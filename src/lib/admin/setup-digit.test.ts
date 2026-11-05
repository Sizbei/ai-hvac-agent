import { describe, it, expect } from "vitest";
import { setupDigit } from "./setup-digit";
import { STEP_DEFS, type DerivedStep, type OnboardingPayload } from "./onboarding-steps";

function payload(
  opts: { done?: string[]; attention?: string[]; dismissedAt?: string | null; completedSeenAt?: string | null } = {},
): OnboardingPayload {
  const steps: DerivedStep[] = STEP_DEFS.map(({ live: _live, ...d }) => ({
    ...d,
    done: (opts.done ?? []).includes(d.id),
    needsAttention: (opts.attention ?? []).includes(d.id),
  }));
  const requiredDone = steps.filter((s) => s.required && s.done).length;
  return {
    steps,
    progress: { requiredDone, requiredTotal: 4, optionalDone: 0, optionalTotal: 4 },
    upNext: null,
    dismissedAt: opts.dismissedAt ?? null,
    completedSeenAt: opts.completedSeenAt ?? null,
    demo: false,
  };
}

const HIDDEN = { visible: false, label: "", srLabel: "" };
const ISO = "2026-11-04T00:00:00.000Z";

describe("setupDigit", () => {
  it("is hidden until the payload has loaded", () => {
    expect(setupDigit({ data: null })).toEqual(HIDDEN);
  });

  it("shows the required steps left, plural", () => {
    expect(setupDigit({ data: payload() })).toEqual({
      visible: true,
      label: "4",
      srLabel: "4 setup steps left",
    });
  });

  it("uses the singular for one step left", () => {
    const data = payload({ done: ["phone_hours", "add_technician", "book_first_request"] });
    expect(setupDigit({ data })).toEqual({ visible: true, label: "1", srLabel: "1 setup step left" });
  });

  it("ignores optional steps", () => {
    const data = payload({ done: ["brand", "pricebook", "chat_widget", "integrations"] });
    expect(setupDigit({ data }).label).toBe("4");
  });

  it("is hidden when every required step is done", () => {
    const data = payload({ done: ["phone_hours", "add_technician", "book_first_request", "tech_sign_in"] });
    expect(setupDigit({ data })).toEqual(HIDDEN);
  });

  it("keeps counting required steps after dismissedAt (hiding the home card is not hiding the work)", () => {
    expect(setupDigit({ data: payload({ dismissedAt: ISO }) })).toEqual({
      visible: true,
      label: "4",
      srLabel: "4 setup steps left",
    });
    expect(
      setupDigit({ data: payload({ dismissedAt: ISO, done: ["phone_hours", "add_technician", "book_first_request", "tech_sign_in"] }) }),
    ).toEqual(HIDDEN);
  });

  it("after completedSeenAt shows only needs-attention steps", () => {
    const data = payload({
      done: ["phone_hours", "book_first_request", "tech_sign_in"],
      attention: ["add_technician"],
      completedSeenAt: ISO,
    });
    expect(setupDigit({ data })).toEqual({
      visible: true,
      label: "1",
      srLabel: "1 setup step needs attention",
    });
  });

  it("after completedSeenAt pluralises needs attention", () => {
    const data = payload({
      done: ["phone_hours", "tech_sign_in"],
      attention: ["add_technician", "book_first_request"],
      completedSeenAt: ISO,
    });
    expect(setupDigit({ data })).toEqual({
      visible: true,
      label: "2",
      srLabel: "2 setup steps need attention",
    });
  });

  it("after completedSeenAt is hidden when nothing needs attention", () => {
    const data = payload({ done: ["phone_hours"], completedSeenAt: ISO });
    expect(setupDigit({ data })).toEqual(HIDDEN);
  });

  it("before completedSeenAt counts attention steps inside N left", () => {
    const data = payload({
      done: ["phone_hours", "tech_sign_in"],
      attention: ["add_technician"],
    });
    expect(setupDigit({ data })).toEqual({ visible: true, label: "2", srLabel: "2 setup steps left" });
  });
});
