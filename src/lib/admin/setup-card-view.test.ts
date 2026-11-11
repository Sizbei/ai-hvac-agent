import { describe, it, expect } from "vitest";
import {
  BANNER_DONE,
  bannerText,
  cardFinished,
  cardHidden,
  cardTitle,
  cardView,
  skeletonTitle,
  upNextAction,
} from "./setup-card-view";
import type { AdminGuidePayload } from "./admin-guide-state";
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
    guide: null,
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

  it("shows the invite line while the step is open; done outranks it", () => {
    const text = "Invite created. This step completes when they accept it";
    expect(bannerText(step("add_technician"), "invite")).toBe(text);
    expect(bannerText(step("add_technician", { note: "Waiting for an invite to be accepted." }), "invite")).toBe(text);
    expect(bannerText(step("add_technician", { done: true }), "invite")).toBe("Done");
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

function guide(welcomeDue: boolean): AdminGuidePayload {
  return {
    welcomeDue,
    lastLesson: null,
    tourStartedAt: null,
    tourCompletedAt: null,
    readOnly: false,
    payLinks: false,
    hasFieldPulse: false,
  };
}

describe("cardView", () => {
  const OPS = "operations" as const;
  const INT = "integrations" as const;
  const base = { error: false, slow: false, placement: OPS, demoFlags: {} };

  it("renders nothing after an error without data, even when slow", () => {
    expect(cardView({ ...base, data: null, error: true })).toEqual({ view: "nothing", welcome: false });
    expect(cardView({ ...base, data: null, error: true, slow: true })).toEqual({ view: "nothing", welcome: false });
  });

  it("renders nothing before 300 ms, then a skeleton", () => {
    expect(cardView({ ...base, data: null }).view).toBe("nothing");
    expect(cardView({ ...base, data: null, slow: true }).view).toBe("skeleton");
  });

  it("no welcome due: full card whenever data is present, errors included", () => {
    expect(cardView({ ...base, data: payload() })).toEqual({ view: "full", welcome: false });
    expect(cardView({ ...base, data: payload(), error: true, slow: true })).toEqual({ view: "full", welcome: false });
    expect(cardView({ ...base, data: payload({ guide: guide(false) }) })).toEqual({ view: "full", welcome: false });
  });

  it("no welcome due: finished moment, and nothing once acknowledged or dismissed", () => {
    expect(cardView({ ...base, data: payload({}, 4) })).toEqual({ view: "finished", welcome: false });
    expect(cardView({ ...base, data: payload({ dismissedAt: "2026-11-04T00:00:00Z" }) }).view).toBe("nothing");
    expect(cardView({ ...base, data: payload({ demo: true }), demoFlags: { dismissed: true } }).view).toBe("nothing");
  });

  it("no welcome due: nothing at all under Integrations placement (no skeleton flash)", () => {
    expect(cardView({ ...base, placement: INT, data: null, slow: true }).view).toBe("nothing");
    expect(cardView({ ...base, placement: INT, data: null }).view).toBe("nothing");
    expect(cardView({ ...base, placement: INT, data: payload(), slow: true }).view).toBe("nothing");
  });

  it("welcome due, operations, active: full card with the welcome row", () => {
    expect(cardView({ ...base, data: payload({ guide: guide(true) }) })).toEqual({ view: "full", welcome: true });
  });

  it("welcome due, operations, finished: finished state with the welcome row", () => {
    expect(cardView({ ...base, data: payload({ guide: guide(true) }, 4) })).toEqual({
      view: "finished",
      welcome: true,
    });
  });

  it("row shows when placement is integrations (welcome-only)", () => {
    const data = payload({ guide: guide(true), dismissedAt: "2026-11-04T00:00:00Z" });
    expect(cardView({ ...base, placement: INT, data })).toEqual({ view: "welcome-only", welcome: true });
    // Org dismissed after this page load decided placement: still welcome-only.
    expect(cardView({ ...base, data })).toEqual({ view: "welcome-only", welcome: true });
  });

  it("welcome due, demo org dismissed via session flag: welcome-only", () => {
    const data = payload({ guide: guide(true), demo: true });
    expect(cardView({ ...base, data, demoFlags: { dismissed: true } })).toEqual({
      view: "welcome-only",
      welcome: true,
    });
  });

  it("welcome due, finished card already acknowledged (completedSeenAt): welcome-only", () => {
    const data = payload({ guide: guide(true), completedSeenAt: "2026-11-04T00:00:00Z" }, 4);
    expect(cardView({ ...base, data })).toEqual({ view: "welcome-only", welcome: true });
  });

  it("guide still loading or failed: as today", () => {
    expect(cardView({ ...base, data: payload({ guide: null }) })).toEqual({ view: "full", welcome: false });
    expect(cardView({ ...base, placement: INT, data: payload({ guide: null }) }).view).toBe("nothing");
  });
});

describe("cardTitle", () => {
  it('is "Getting started" for the welcome-only card, else "Setup guide"', () => {
    expect(cardTitle("welcome-only")).toBe("Getting started");
    expect(cardTitle("full")).toBe("Setup guide");
    expect(cardTitle("finished")).toBe("Setup guide");
    expect(cardTitle("skeleton")).toBe("Setup guide");
  });
});

describe("skeletonTitle", () => {
  it("is the title the loaded card lands on: the checklist's unless this session hid it", () => {
    expect(skeletonTitle({})).toBe("Setup guide");
    // A demo-org session that dismissed or finished the checklist can only land
    // on the welcome row, titled "Getting started".
    expect(skeletonTitle({ dismissed: true })).toBe("Getting started");
    expect(skeletonTitle({ completedSeen: true })).toBe("Getting started");
  });
});

describe("upNextAction", () => {
  it("the copy step gets outline while the welcome is due", () => {
    const copy = step("tech_sign_in", { action: "copy_sign_in_link", copyValue: "https://x.test/tech/login" });
    expect(upNextAction(copy, "outline")).toEqual({
      kind: "copy",
      url: "https://x.test/tech/login",
      variant: "outline",
    });
    expect(upNextAction(copy, "default")).toMatchObject({ kind: "copy", variant: "default" });
  });

  it("a link step carries the variant; instruction-only and bare steps have no button", () => {
    const link = step("phone_hours");
    expect(upNextAction(link, "outline")).toMatchObject({ kind: "link", variant: "outline" });
    expect(upNextAction(step("tech_sign_in", { instruction: "Ask them to sign in." }), "outline")).toEqual({
      kind: "instruction",
    });
    expect(upNextAction(step("phone_hours", { href: null, instruction: undefined }), "default")).toEqual({
      kind: "none",
    });
  });
});
