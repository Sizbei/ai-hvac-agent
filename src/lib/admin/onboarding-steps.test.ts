import { describe, it, expect } from "vitest";
import type { OnboardingState, Signals, StepId } from "./onboarding-state";
import {
  STEP_DEFS,
  deriveSteps,
  grandfatherDecision,
  upNext,
  type DerivedStep,
} from "./onboarding-steps";

const NOW = new Date("2026-11-04T12:00:00.000Z");
const OPTS = { now: NOW, demo: false, googleEnabled: false, appUrl: "https://app.example.com" };

function state(p: Partial<OnboardingState> = {}): OnboardingState {
  return { firstCompleted: {}, flags: {}, ...p };
}

function signals(p: Partial<Signals> = {}): Signals {
  return {
    companyName: "Acme",
    phone: false,
    businessHours: false,
    logoUrl: false,
    technicianReady: false,
    fpPasswordless: 0,
    pendingInvite: false,
    pricebook: false,
    anyRequest: false,
    bookedAssigned: false,
    techSignedIn: false,
    widgetKey: false,
    allowedOrigins: false,
    integrationConnected: false,
    completedRequest: false,
    orgCreatedAt: "2026-11-01T00:00:00.000Z",
    state: state(),
    ...p,
  };
}

const ALL_DONE: Partial<Signals> = {
  phone: true,
  businessHours: true,
  logoUrl: true,
  technicianReady: true,
  pricebook: true,
  anyRequest: true,
  bookedAssigned: true,
  techSignedIn: true,
  widgetKey: true,
  allowedOrigins: true,
  integrationConnected: true,
};

const step = (steps: readonly DerivedStep[], id: StepId) => {
  const s = steps.find((x) => x.id === id);
  if (!s) throw new Error(`missing ${id}`);
  return s;
};

describe("STEP_DEFS", () => {
  it("lists the eight steps in spec order with verbatim strings", () => {
    expect(STEP_DEFS.map((d) => d.id)).toEqual([
      "phone_hours", "brand", "add_technician", "pricebook",
      "book_first_request", "tech_sign_in", "chat_widget", "integrations",
    ]);
    expect(STEP_DEFS).toEqual([
      { id: "phone_hours", phase: 1, title: "Add your business phone and hours", why: "The assistant tells callers when you're open and how to reach you.", estimateMinutes: 3, estimateLabel: "~3 min", required: true, live: false, href: "/admin/settings?tab=business&from=setup", hrefLabel: "Open business info" },
      { id: "brand", phase: 1, title: "Add your logo", why: "Your portal, chat widget and emails carry your brand.", estimateMinutes: 2, estimateLabel: "~2 min", required: false, live: false, href: "/admin/settings?tab=branding&from=setup", hrefLabel: "Open branding" },
      { id: "add_technician", phase: 2, title: "Add a technician", why: "Requests need someone who can sign in on a phone and run them. Running them yourself? Add yourself with a second email.", estimateMinutes: 3, estimateLabel: "~3 min", required: true, live: true, href: "/admin/staff?new=technician&from=setup", hrefLabel: "Add technician", secondaryHref: "/admin/staff?new=invite&from=setup", secondaryLabel: "Invite by link" },
      { id: "pricebook", phase: 2, title: "Add your first price", why: "Estimates and invoices pull from the pricebook.", estimateMinutes: 5, estimateLabel: "~5 min", required: false, live: false, href: "/admin/pricebook?new=1&from=setup", hrefLabel: "Add price", secondaryHref: "/admin/fieldpulse-import", secondaryLabel: "Import from FieldPulse" },
      { id: "book_first_request", phase: 3, title: "Book your first request", why: "Add the customer, the problem, a time and a technician in one dialog.", estimateMinutes: 4, estimateLabel: "~4 min", required: true, live: true, href: "/admin/requests?new=1&from=setup", hrefLabel: "New request" },
      { id: "tech_sign_in", phase: 3, title: "Have a technician sign in on their phone", why: "They see the requests assigned to them and run them from there.", estimateMinutes: null, estimateLabel: "When they're ready", required: true, live: false, href: null, hrefLabel: "Copy sign-in link" },
      { id: "chat_widget", phase: 3, title: "Add the chat widget to your website", why: "Customers book while you sleep.", estimateMinutes: 5, estimateLabel: "~5 min", required: false, live: false, href: "/admin/settings?tab=embed&from=setup", hrefLabel: "Open embed settings" },
      { id: "integrations", phase: 3, title: "Bring in data from your other tools", why: "FieldPulse, Housecall Pro or Google Calendar, so nothing is typed twice.", estimateMinutes: null, estimateLabel: "Depends on the tool", required: false, live: false, href: "/admin/integrations", hrefLabel: "Open integrations" },
    ]);
  });

  it("has 4 required and 4 optional steps", () => {
    expect(STEP_DEFS.filter((d) => d.required).length).toBe(4);
    expect(STEP_DEFS.filter((d) => !d.required).length).toBe(4);
  });
});

describe("deriveSteps — fresh org", () => {
  const d = deriveSteps(signals(), OPTS);

  it("is 0 of 4 with phone_hours up next and nothing to stamp", () => {
    expect(d.progress).toEqual({ requiredDone: 0, requiredTotal: 4, optionalDone: 0, optionalTotal: 4 });
    expect(d.upNext).toBe("phone_hours");
    expect(d.newStamps).toEqual({});
    expect(d.stamped).toEqual({});
    expect(d.steps.every((s) => !s.done && !s.needsAttention)).toBe(true);
  });

  it("strips live and stamped from the payload steps and carries no notes", () => {
    for (const s of d.steps) {
      expect(s).not.toHaveProperty("live");
      expect(s).not.toHaveProperty("stamped");
      if (s.id !== "tech_sign_in") expect(s).not.toHaveProperty("note");
    }
    expect(step(d.steps, "tech_sign_in")).not.toHaveProperty("note");
  });

  it("counts every rule once all signals are true (digit inputs)", () => {
    const all = deriveSteps(signals(ALL_DONE), OPTS);
    expect(all.progress).toEqual({ requiredDone: 4, requiredTotal: 4, optionalDone: 4, optionalTotal: 4 });
    expect(all.upNext).toBeNull();
    const partial = deriveSteps(signals({ phone: true, businessHours: true, logoUrl: true }), OPTS);
    expect(partial.progress).toEqual({ requiredDone: 1, requiredTotal: 4, optionalDone: 1, optionalTotal: 4 });
  });
});

describe("deriveSteps — rules", () => {
  it("phone_hours needs both phone and hours", () => {
    expect(step(deriveSteps(signals({ phone: true }), OPTS).steps, "phone_hours").done).toBe(false);
    expect(step(deriveSteps(signals({ phone: true, businessHours: true }), OPTS).steps, "phone_hours").done).toBe(true);
  });

  it("chat_widget needs a key and (embedCopied or allowed origins)", () => {
    const at = (p: Partial<Signals>) => step(deriveSteps(signals(p), OPTS).steps, "chat_widget").done;
    expect(at({ widgetKey: true })).toBe(false);
    expect(at({ allowedOrigins: true })).toBe(false);
    expect(at({ widgetKey: true, allowedOrigins: true })).toBe(true);
    expect(at({ widgetKey: true, state: state({ flags: { embedCopied: true } }) })).toBe(true);
    expect(at({ widgetKey: true, state: state({ flags: { embedCopied: false } }) })).toBe(false);
  });

  it("tech_sign_in: flag, evidence or demo", () => {
    const at = (p: Partial<Signals>, demo = false) =>
      step(deriveSteps(signals(p), { ...OPTS, demo }).steps, "tech_sign_in").done;
    expect(at({})).toBe(false);
    expect(at({ techSignedIn: true })).toBe(true);
    expect(at({ state: state({ flags: { techSignedInAt: "2026-11-01T00:00:00.000Z" } }) })).toBe(true);
    expect(at({}, true)).toBe(true);
  });

  it("brand, pricebook, integrations follow their single signal", () => {
    const d = deriveSteps(signals({ logoUrl: true, pricebook: true, integrationConnected: true }), OPTS);
    expect(step(d.steps, "brand").done).toBe(true);
    expect(step(d.steps, "pricebook").done).toBe(true);
    expect(step(d.steps, "integrations").done).toBe(true);
  });
});

describe("deriveSteps — notes", () => {
  it("phone_hours: exactly one of phone/hours set", () => {
    const n = (p: Partial<Signals>) => step(deriveSteps(signals(p), OPTS).steps, "phone_hours").note;
    expect(n({ phone: true })).toBe("Add both a phone number and hours.");
    expect(n({ businessHours: true })).toBe("Add both a phone number and hours.");
    expect(n({})).toBeUndefined();
    expect(n({ phone: true, businessHours: true })).toBeUndefined();
  });

  it("add_technician: pending invite", () => {
    const s = step(deriveSteps(signals({ pendingInvite: true }), OPTS).steps, "add_technician");
    expect(s.note).toBe("Waiting for an invite to be accepted.");
  });

  it("add_technician: FieldPulse count, plural and singular, with and without Google", () => {
    const n = (count: number, googleEnabled: boolean) =>
      step(deriveSteps(signals({ fpPasswordless: count }), { ...OPTS, googleEnabled }).steps, "add_technician").note;
    expect(n(3, false)).toBe("3 technicians from FieldPulse can't sign in yet. Use Reset password in Staff.");
    expect(n(1, false)).toBe("1 technician from FieldPulse can't sign in yet. Use Reset password in Staff.");
    expect(n(2, true)).toBe("2 technicians from FieldPulse can't sign in yet. Have them sign in with Google, or use Reset password in Staff.");
    expect(n(1, true)).toBe("1 technician from FieldPulse can't sign in yet. Have them sign in with Google, or use Reset password in Staff.");
  });

  it("add_technician: the FieldPulse note wins over the pending-invite note", () => {
    const s = step(deriveSteps(signals({ fpPasswordless: 2, pendingInvite: true }), OPTS).steps, "add_technician");
    expect(s.note).toBe("2 technicians from FieldPulse can't sign in yet. Use Reset password in Staff.");
  });

  it("book_first_request: a request exists but none booked with a technician", () => {
    const n = (p: Partial<Signals>) => step(deriveSteps(signals(p), OPTS).steps, "book_first_request").note;
    expect(n({ anyRequest: true })).toBe("Pick a time and a technician in the request.");
    expect(n({ anyRequest: true, bookedAssigned: true })).toBeUndefined();
    expect(n({})).toBeUndefined();
  });
});

describe("deriveSteps — FieldPulse primary switch", () => {
  it("switches href/label and hides the secondary while not done", () => {
    const s = step(deriveSteps(signals({ fpPasswordless: 1 }), OPTS).steps, "add_technician");
    expect(s.href).toBe("/admin/staff?from=setup");
    expect(s.hrefLabel).toBe("Set a password in Staff");
    expect(s).not.toHaveProperty("secondaryHref");
    expect(s).not.toHaveProperty("secondaryLabel");
  });

  it("keeps the default link and secondary once done", () => {
    const s = step(deriveSteps(signals({ fpPasswordless: 1, technicianReady: true }), OPTS).steps, "add_technician");
    expect(s.done).toBe(true);
    expect(s.href).toBe("/admin/staff?new=technician&from=setup");
    expect(s.hrefLabel).toBe("Add technician");
    expect(s.secondaryHref).toBe("/admin/staff?new=invite&from=setup");
    expect(s.secondaryLabel).toBe("Invite by link");
  });

  it("keeps the default link with no FieldPulse technicians", () => {
    const s = step(deriveSteps(signals(), OPTS).steps, "add_technician");
    expect(s.href).toBe("/admin/staff?new=technician&from=setup");
    expect(s.secondaryLabel).toBe("Invite by link");
  });
});

describe("deriveSteps — tech_sign_in action", () => {
  const ts = (appUrl: string, googleEnabled = false) =>
    step(deriveSteps(signals(), { ...OPTS, appUrl, googleEnabled }).steps, "tech_sign_in");

  it("builds the copy value with trailing slashes stripped", () => {
    expect(ts("https://app.example.com").copyValue).toBe("https://app.example.com/tech-login");
    expect(ts("https://app.example.com/").copyValue).toBe("https://app.example.com/tech-login");
    expect(ts("https://app.example.com///").copyValue).toBe("https://app.example.com/tech-login");
    expect(ts("https://app.example.com").action).toBe("copy_sign_in_link");
  });

  it("without an app URL: no action or copy value, the instruction only", () => {
    const s = ts("");
    expect(s).not.toHaveProperty("action");
    expect(s).not.toHaveProperty("copyValue");
    expect(s.instruction).toBe(
      "Open it on the technician's phone and sign in with their email and password.",
    );
  });

  it("adds the Google clause only when Google is enabled", () => {
    expect(ts("https://a.example", false).instruction).toBe(
      "Open it on the technician's phone and sign in with their email and password.",
    );
    expect(ts("https://a.example", true).instruction).toBe(
      "Open it on the technician's phone and sign in with their email and password. Use the password, not Google, if this email also signs in to the office.",
    );
  });

  it("no other step carries the action", () => {
    const d = deriveSteps(signals(), OPTS);
    expect(d.steps.filter((s) => s.action).map((s) => s.id)).toEqual(["tech_sign_in"]);
    expect(d.steps.filter((s) => s.copyValue || s.instruction).map((s) => s.id)).toEqual(["tech_sign_in"]);
  });
});

describe("deriveSteps — demo", () => {
  it("derives tech_sign_in as done", () => {
    const d = deriveSteps(signals(), { ...OPTS, demo: true });
    expect(step(d.steps, "tech_sign_in").done).toBe(true);
    expect(d.progress.requiredDone).toBe(1);
  });
});

describe("deriveSteps — stamps, sticky and live", () => {
  const T = "2026-10-01T00:00:00.000Z";

  it("a done step without a stamp is in newStamps at now (live steps included)", () => {
    const d = deriveSteps(
      signals({ phone: true, businessHours: true, technicianReady: true, state: state({ firstCompleted: { phone_hours: T } }) }),
      OPTS,
    );
    expect(d.newStamps).toEqual({ add_technician: NOW.toISOString() });
    expect(d.stamped).toEqual({ phone_hours: true });
  });

  it("sticky: pricebook stamped and rule false stays done", () => {
    const s = step(deriveSteps(signals({ state: state({ firstCompleted: { pricebook: T } }) }), OPTS).steps, "pricebook");
    expect(s.done).toBe(true);
    expect(s.needsAttention).toBe(false);
  });

  it("live: add_technician stamped and rule false needs attention, not done", () => {
    const s = step(deriveSteps(signals({ state: state({ firstCompleted: { add_technician: T } }) }), OPTS).steps, "add_technician");
    expect(s.done).toBe(false);
    expect(s.needsAttention).toBe(true);
  });

  it("live: stamped and rule true is done without attention", () => {
    const s = step(
      deriveSteps(signals({ technicianReady: true, state: state({ firstCompleted: { add_technician: T } }) }), OPTS).steps,
      "add_technician",
    );
    expect(s.done).toBe(true);
    expect(s.needsAttention).toBe(false);
  });

  it("both live steps stamped, technicianReady=false, bookedAssigned=true: only add_technician re-opens", () => {
    const d = deriveSteps(
      signals({
        technicianReady: false,
        bookedAssigned: true,
        anyRequest: true,
        state: state({ firstCompleted: { add_technician: T, book_first_request: T } }),
      }),
      OPTS,
    );
    expect(step(d.steps, "add_technician")).toMatchObject({ done: false, needsAttention: true });
    expect(step(d.steps, "book_first_request")).toMatchObject({ done: true, needsAttention: false });
    expect(d.newStamps).toEqual({});
    expect(d.upNext).toBe("phone_hours");
  });

  it("non-live steps never need attention", () => {
    const fc = Object.fromEntries(STEP_DEFS.map((x) => [x.id, T]));
    const d = deriveSteps(signals({ state: state({ firstCompleted: fc }) }), OPTS);
    expect(d.steps.filter((s) => s.needsAttention).map((s) => s.id)).toEqual(["add_technician", "book_first_request"]);
    expect(d.progress.requiredDone).toBe(2);
    expect(d.progress.optionalDone).toBe(4);
  });
});

describe("upNext", () => {
  it("first not-done required in order", () => {
    const d = deriveSteps(signals({ phone: true, businessHours: true }), OPTS);
    expect(d.upNext).toBe("add_technician");
    expect(upNext(d.steps)).toBe("add_technician");
  });

  it("skips optional steps while a required one is open", () => {
    const d = deriveSteps(signals({ phone: true, businessHours: true, technicianReady: true, bookedAssigned: true }), OPTS);
    expect(d.upNext).toBe("tech_sign_in");
  });

  it("falls back to the first not-done optional step", () => {
    const d = deriveSteps(
      signals({ phone: true, businessHours: true, technicianReady: true, bookedAssigned: true, techSignedIn: true, logoUrl: true }),
      OPTS,
    );
    expect(d.upNext).toBe("pricebook");
  });

  it("is null when everything is done", () => {
    expect(upNext(deriveSteps(signals(ALL_DONE), OPTS).steps)).toBeNull();
    expect(upNext([])).toBeNull();
  });
});

describe("grandfatherDecision", () => {
  const OLD = "2026-10-01T00:00:00.000Z"; // 34 days before NOW
  const YOUNG = "2026-10-25T00:00:00.000Z"; // 10 days before NOW
  const REQUIRED: Partial<Signals> = { phone: true, businessHours: true, technicianReady: true, bookedAssigned: true, techSignedIn: true };
  const g = (p: Partial<Signals>, demo = false) => {
    const s = signals(p);
    return grandfatherDecision(s, deriveSteps(s, { ...OPTS, demo }), NOW, { demo });
  };

  it("all required done → completedSeenAt", () => {
    expect(g(REQUIRED)).toEqual({ completedSeenAt: NOW.toISOString() });
  });

  it("older than 14 days with a completed request → dismissedAt", () => {
    expect(g({ orgCreatedAt: OLD, completedRequest: true })).toEqual({ dismissedAt: NOW.toISOString() });
  });

  it("otherwise nothing", () => {
    expect(g({ orgCreatedAt: OLD })).toEqual({});
    expect(g({ orgCreatedAt: YOUNG, completedRequest: true })).toEqual({});
    expect(g({ orgCreatedAt: null, completedRequest: true })).toEqual({});
    expect(g({})).toEqual({});
  });

  it("has stamps → nothing", () => {
    expect(g({ ...REQUIRED, state: state({ firstCompleted: { phone_hours: OLD } }) })).toEqual({});
    expect(g({ orgCreatedAt: OLD, completedRequest: true, state: state({ firstCompleted: { brand: OLD } }) })).toEqual({});
  });

  it("not the first GET (firstSeenAt stored) → nothing, even with no stamps", () => {
    expect(g({ ...REQUIRED, state: state({ firstSeenAt: OLD }) })).toEqual({});
    expect(g({ orgCreatedAt: OLD, completedRequest: true, state: state({ firstSeenAt: OLD }) })).toEqual({});
  });

  it("demo → nothing", () => {
    expect(g(REQUIRED, true)).toEqual({});
    expect(g({ orgCreatedAt: OLD, completedRequest: true }, true)).toEqual({});
  });

  it("omits keys already present in the state", () => {
    expect(g({ ...REQUIRED, state: state({ completedSeenAt: OLD }) })).toEqual({});
    expect(g({ orgCreatedAt: OLD, completedRequest: true, state: state({ dismissedAt: OLD }) })).toEqual({});
  });

  it("all-required wins over the age branch", () => {
    expect(g({ ...REQUIRED, orgCreatedAt: OLD, completedRequest: true })).toEqual({ completedSeenAt: NOW.toISOString() });
  });
});
