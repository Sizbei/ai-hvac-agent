import { describe, it, expect } from "vitest";
import { BANNER_DONE, bannerText, cardFinished, cardHidden, cardLoadingView } from "./setup-card-view";
import { STEP_DEFS, type DerivedStep, type OnboardingPayload } from "./onboarding-steps";

function step(id: string, extra: Partial<DerivedStep> = {}): DerivedStep {
  const def = STEP_DEFS.find((d) => d.id === id);
  if (!def) throw new Error(id);
  const { live: _live, ...rest } = def;
  return { ...rest, done: false, needsAttention: false, ...extra };
}

function payload(extra: Partial<OnboardingPayload> = {}, requiredDone = 0): OnboardingPayload {
  return {
    steps: STEP_DEFS.map((d) => step(d.id)),
    progress: { requiredDone, requiredTotal: 4, optionalDone: 0, optionalTotal: 4 },
    upNext: "phone_hours",
    dismissedAt: null,
    completedSeenAt: null,
    demo: false,
    ...extra,
  };
}

describe("cardHidden", () => {
  it("is hidden without data", () => {
    expect(cardHidden(null, {})).toBe(true);
  });

  it("shows a fresh org", () => {
    expect(cardHidden(payload(), {})).toBe(false);
  });

  it("hides once dismissed or the finished state was acknowledged", () => {
    expect(cardHidden(payload({ dismissedAt: "2026-11-04T00:00:00Z" }), {})).toBe(true);
    expect(cardHidden(payload({ completedSeenAt: "2026-11-04T00:00:00Z" }), {})).toBe(true);
  });

  it("honours the demo session flags only for the demo org", () => {
    expect(cardHidden(payload({ demo: true }), { dismissed: true })).toBe(true);
    expect(cardHidden(payload({ demo: true }), { completedSeen: true })).toBe(true);
    expect(cardHidden(payload({ demo: true }), {})).toBe(false);
    expect(cardHidden(payload(), { dismissed: true, completedSeen: true })).toBe(false);
  });
});

describe("cardFinished", () => {
  it("is finished when every required step is done and not yet acknowledged", () => {
    expect(cardFinished(payload({}, 4))).toBe(true);
    expect(cardFinished(payload({}, 3))).toBe(false);
    expect(cardFinished(payload({ completedSeenAt: "2026-11-04T00:00:00Z" }, 4))).toBe(false);
  });
});

describe("bannerText", () => {
  it("names the step by default", () => {
    expect(bannerText(step("add_technician"), null)).toBe("Setup guide: Add a technician");
  });

  it("falls back to the guide name before the step is known", () => {
    expect(bannerText(undefined, null)).toBe("Setup guide");
    expect(bannerText(undefined, "saved")).toBe("Setup guide");
  });

  it("puts an invite first, even over done", () => {
    const text = "Invite created. This step completes when they accept it";
    expect(bannerText(step("add_technician"), "invite")).toBe(text);
    expect(bannerText(step("add_technician", { done: true }), "invite")).toBe(text);
    expect(bannerText(undefined, "invite")).toBe(text);
  });

  it("says done once the step is done", () => {
    expect(BANNER_DONE).toBe("Done");
    expect(bannerText(step("pricebook", { done: true }), "saved")).toBe("Done");
    expect(bannerText(step("pricebook", { done: true }), null)).toBe("Done");
  });

  it("shows the request note after a save that left the step open", () => {
    expect(
      bannerText(step("book_first_request", { note: "Pick a time and a technician in the request." }), "saved"),
    ).toBe("Saved. Pick a time and a technician on that request to finish this step");
  });

  it("prefixes any other note with Saved.", () => {
    expect(
      bannerText(step("phone_hours", { note: "Add both a phone number and hours." }), "saved"),
    ).toBe("Saved. Add both a phone number and hours.");
  });

  it("keeps the step title after a save without a note, and ignores the note without a save", () => {
    expect(bannerText(step("brand"), "saved")).toBe("Setup guide: Add your logo");
    expect(bannerText(step("phone_hours", { note: "Add both a phone number and hours." }), null)).toBe(
      "Setup guide: Add your business phone and hours",
    );
  });
});

describe("cardLoadingView", () => {
  it("renders nothing after an error without data, even when slow", () => {
    expect(cardLoadingView(null, true, false)).toBe("nothing");
    expect(cardLoadingView(null, true, true)).toBe("nothing");
  });

  it("renders nothing before 300 ms, then a skeleton", () => {
    expect(cardLoadingView(null, false, false)).toBe("nothing");
    expect(cardLoadingView(null, false, true)).toBe("skeleton");
  });

  it("renders the card whenever data is present, errors included", () => {
    expect(cardLoadingView(payload(), false, false)).toBe("card");
    expect(cardLoadingView(payload(), true, true)).toBe("card");
  });
});
