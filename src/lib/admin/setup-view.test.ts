import { describe, it, expect } from "vitest";
import {
  dismissedNote,
  heroActionVariant,
  heroFor,
  justDone,
  nextRows,
  optionalGroup,
  optionalMeta,
  phasesOf,
  requiredMeta,
  rowActionsFor,
  showFinished,
  setupStepForTab,
  subtitleFor,
} from "./setup-view";
import { STEP_DEFS, type DerivedStep, type OnboardingPayload } from "./onboarding-steps";

function payload(
  done: string[] = [],
  extra: Partial<OnboardingPayload> & { attention?: string[] } = {},
): OnboardingPayload {
  const { attention = [], ...rest } = extra;
  const steps: DerivedStep[] = STEP_DEFS.map(({ live: _live, ...d }) => ({
    ...d,
    done: done.includes(d.id),
    needsAttention: attention.includes(d.id),
  }));
  const count = (req: boolean) => steps.filter((s) => s.required === req && s.done).length;
  return {
    steps,
    progress: { requiredDone: count(true), requiredTotal: 4, optionalDone: count(false), optionalTotal: 4 },
    upNext: null,
    dismissedAt: null,
    completedSeenAt: null,
    demo: false,
    guide: null,
    ...rest,
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

const REQUIRED = ["phone_hours", "add_technician", "book_first_request", "tech_sign_in"];
const NOW = "2026-11-04T12:00:00.000Z";

describe("phasesOf", () => {
  it("groups required steps by phase with required-only meta", () => {
    const phases = phasesOf(payload(["phone_hours", "brand"]));
    expect(phases.map((p) => p.phase)).toEqual([1, 2, 3]);
    expect(phases.map((p) => p.title)).toEqual([
      "Set up your company",
      "Get your team in",
      "Run your first request",
    ]);
    expect(phases.map((p) => p.rows.map((r) => r.step.id))).toEqual([
      ["phone_hours"],
      ["add_technician"],
      ["book_first_request", "tech_sign_in"],
    ]);
    expect(phases.map((p) => p.meta)).toEqual(["1 of 1", "0 of 1", "0 of 2"]);
  });

  it("retitles phase 3 once the first request is booked", () => {
    expect(phasesOf(payload(["book_first_request"]))[2].title).toBe("Run requests");
    expect(phasesOf(payload(["phone_hours"]))[2].title).toBe("Run your first request");
  });

  it("numbers required rows 1-4 in order", () => {
    const numbers = phasesOf(payload()).flatMap((p) => p.rows.map((r) => r.number));
    expect(numbers).toEqual([1, 2, 3, 4]);
  });

  it("collapses a phase only when every required step in it is done", () => {
    const phases = phasesOf(payload(["phone_hours", "add_technician", "book_first_request"]));
    expect(phases.map((p) => p.collapsed)).toEqual([true, true, false]);
    expect(phasesOf(payload(REQUIRED)).every((p) => p.collapsed)).toBe(true);
  });

  it("re-opens a phase whose live step needs attention", () => {
    const p = payload(["phone_hours", "book_first_request", "tech_sign_in"], { attention: ["add_technician"] });
    expect(phasesOf(p)[1]).toMatchObject({ collapsed: false, meta: "0 of 1" });
  });

  it("omits meta for a phase with no required steps", () => {
    const p = payload();
    const onlyOptional = { ...p, steps: p.steps.map((s) => (s.phase === 1 ? { ...s, required: false } : s)) };
    expect(phasesOf(onlyOptional)[0]).toMatchObject({ meta: undefined, collapsed: false, rows: [] });
  });
});

describe("optionalGroup / optionalMeta", () => {
  it("lists optional steps in step order, numbered after the required ones", () => {
    const g = optionalGroup(payload(["brand"]));
    expect(g.rows.map((r) => r.step.id)).toEqual(["brand", "pricebook", "chat_widget", "integrations"]);
    expect(g.rows.map((r) => r.number)).toEqual([5, 6, 7, 8]);
    expect(g.meta).toBe("Go further · 1 of 4");
  });

  it("formats the optional meta from progress", () => {
    expect(optionalMeta(payload())).toBe("Go further · 0 of 4");
    expect(optionalMeta(payload(["brand", "pricebook"]))).toBe("Go further · 2 of 4");
  });
});

describe("heroFor", () => {
  it("returns the up-next step when nothing needs attention", () => {
    const hero = heroFor(payload([], { upNext: "phone_hours" }));
    expect(hero.attention).toBeUndefined();
    expect(hero.upNext?.id).toBe("phone_hours");
  });

  it("the first needs-attention step wins and suppresses up next", () => {
    const p = payload(["phone_hours"], { upNext: "book_first_request", attention: ["add_technician", "book_first_request"] });
    const hero = heroFor(p);
    expect(hero.attention?.id).toBe("add_technician");
    expect(hero.upNext).toBeUndefined();
  });

  it("returns neither when nothing is next", () => {
    expect(heroFor(payload(STEP_DEFS.map((d) => d.id)))).toEqual({});
  });

  it("completedSeenAt + attention: attention hero AND the finished block", () => {
    const p = payload(["phone_hours", "book_first_request", "tech_sign_in"], {
      completedSeenAt: NOW,
      attention: ["add_technician"],
      upNext: "add_technician",
    });
    expect(heroFor(p).attention?.id).toBe("add_technician");
    expect(showFinished(p)).toBe(true);
  });

  it("dismissedAt + attention: the hero still shows the attention step", () => {
    const p = payload(["phone_hours", "book_first_request", "tech_sign_in"], {
      dismissedAt: NOW,
      attention: ["add_technician"],
    });
    expect(heroFor(p).attention?.id).toBe("add_technician");
    expect(showFinished(p)).toBe(false);
  });
});

describe("showFinished", () => {
  it("is true when every required step is done, even unacknowledged", () => {
    expect(showFinished(payload(REQUIRED))).toBe(true);
  });

  it("is true once completedSeenAt is set, and false otherwise", () => {
    expect(showFinished(payload([], { completedSeenAt: NOW }))).toBe(true);
    expect(showFinished(payload(["phone_hours"]))).toBe(false);
  });
});

describe("subtitleFor / dismissedNote", () => {
  it("uses the full subtitle for an active guide", () => {
    expect(subtitleFor(payload())).toBe(
      "Finish these to run your first request. Steps complete on their own · about 10 min, plus your technician's sign-in",
    );
    expect(dismissedNote(payload())).toBeNull();
  });

  it("drops the first-request wording once a request is booked", () => {
    expect(subtitleFor(payload(["phone_hours", "book_first_request"]))).toBe(
      "A few steps left to finish setting up. Steps complete on their own · about 10 min, plus your technician's sign-in",
    );
  });

  it("shortens the subtitle and adds the note when dismissed", () => {
    const p = payload([], { dismissedAt: NOW });
    expect(subtitleFor(p)).toBe("Steps complete on their own.");
    // The subtitle already says steps complete on their own; the note does not repeat it.
    expect(dismissedNote(p)).toBe("Hidden from the home page.");
  });

  it("shortens the subtitle without the note when finished", () => {
    const p = payload(REQUIRED, { completedSeenAt: NOW });
    expect(subtitleFor(p)).toBe("Steps complete on their own.");
    expect(dismissedNote(p)).toBeNull();
  });
});

describe("justDone", () => {
  it("returns the ids that flipped from not done to done", () => {
    expect(justDone(payload(["phone_hours"]), payload(["phone_hours", "add_technician", "brand"]))).toEqual([
      "brand",
      "add_technician",
    ]);
  });

  it("ignores the first load, re-opened steps and unchanged steps", () => {
    expect(justDone(null, payload(["phone_hours"]))).toEqual([]);
    expect(justDone(payload(["add_technician"]), payload([]))).toEqual([]);
    expect(justDone(payload(["phone_hours"]), payload(["phone_hours"]))).toEqual([]);
  });
});

describe("rowActionsFor", () => {
  const step = (id: string, done: string[] = []) => payload(done).steps.find((s) => s.id === id)!;

  it("shows primary and secondary on a to-do row that is not the hero", () => {
    expect(rowActionsFor(step("add_technician"), "phone_hours")).toEqual({ primary: true, secondary: true });
  });

  it("keeps the secondary link on the hero step's row, hiding only the primary", () => {
    expect(rowActionsFor(step("add_technician"), "add_technician")).toEqual({ primary: false, secondary: true });
  });

  it("pricebook has no secondary link (the FieldPulse import console is platform-only)", () => {
    expect(rowActionsFor(step("pricebook"), "pricebook")).toEqual({ primary: false, secondary: false });
  });

  it("has no secondary for a step without one, and nothing on done rows", () => {
    expect(rowActionsFor(step("phone_hours"), undefined)).toEqual({ primary: true, secondary: false });
    expect(rowActionsFor(step("add_technician", ["add_technician"]), undefined)).toEqual({
      primary: false,
      secondary: false,
    });
  });
});

describe("setupStepForTab", () => {
  it("maps the three setup tabs", () => {
    expect(setupStepForTab("business")).toBe("phone_hours");
    expect(setupStepForTab("branding")).toBe("brand");
    expect(setupStepForTab("embed")).toBe("chat_widget");
  });

  it("yields undefined for other tabs and prototype keys", () => {
    for (const tab of ["team", "", "constructor", "__proto__", "toString", "hasOwnProperty"]) {
      expect(setupStepForTab(tab)).toBeUndefined();
    }
  });
});

describe("requiredMeta", () => {
  it("names the noun next to the count", () => {
    expect(requiredMeta(payload(["phone_hours", "add_technician", "book_first_request"]))).toBe(
      "3 of 4 required steps",
    );
    expect(requiredMeta(payload())).toBe("0 of 4 required steps");
  });
});

describe("heroActionVariant", () => {
  it("steps back to outline while the quick tour is open", () => {
    expect(heroActionVariant({ tourExpanded: true, attention: false })).toBe("outline");
    expect(heroActionVariant({ tourExpanded: false, attention: false })).toBe("default");
  });

  it("stays primary when a step needs attention, tour or not", () => {
    expect(heroActionVariant({ tourExpanded: true, attention: true })).toBe("default");
    expect(heroActionVariant({ tourExpanded: false, attention: true })).toBe("default");
  });
});
