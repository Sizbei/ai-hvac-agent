import { describe, it, expect } from "vitest";
import { welcomeDismissBody, welcomeRowView } from "./welcome-view";
import type { AdminGuidePayload } from "./admin-guide-state";
import type { CardState } from "./setup-card-view";

function guide(extra: Partial<AdminGuidePayload> = {}): AdminGuidePayload {
  return {
    welcomeDue: true,
    lastLesson: null,
    tourStartedAt: null,
    tourCompletedAt: null,
    readOnly: false,
    payLinks: false,
    hasFieldPulse: false,
    ...extra,
  };
}

const FULL: CardState = { view: "full", welcome: true };
const WELCOME_ONLY: CardState = { view: "welcome-only", welcome: true };
const NO_WELCOME: CardState = { view: "full", welcome: false };
const STARTED = "2026-11-10T12:00:00.000Z";

describe("welcomeRowView", () => {
  it("row shows when placement is integrations", () => {
    const row = welcomeRowView({ guide: guide(), orgName: "Spears Services", cardState: WELCOME_ONLY });
    expect(row.show).toBe(true);
    expect(row.title).toBe("Welcome to Spears Services");
  });

  it("shows on top of the full card and hides when the card state has no welcome", () => {
    expect(welcomeRowView({ guide: guide(), orgName: "Spears Services", cardState: FULL }).show).toBe(true);
    expect(welcomeRowView({ guide: guide(), orgName: "Spears Services", cardState: NO_WELCOME }).show).toBe(false);
    expect(welcomeRowView({ guide: null, orgName: "Spears Services", cardState: FULL }).show).toBe(false);
  });

  it("offers the tour from stop 1 before it has started", () => {
    const row = welcomeRowView({ guide: guide(), orgName: "Spears Services", cardState: FULL });
    expect(row.primary).toEqual({ label: "Take the tour", href: "/admin/setup?lesson=requests#learn" });
    expect(row.meta).toBeNull();
  });

  it('"Continue the tour" with "Stop 4 of 5" after lastLesson=customers', () => {
    const row = welcomeRowView({
      guide: guide({ tourStartedAt: STARTED, lastLesson: "customers" }),
      orgName: "Spears Services",
      cardState: FULL,
    });
    expect(row.primary).toEqual({ label: "Continue the tour", href: "/admin/setup?lesson=customers#learn" });
    expect(row.meta).toBe("Stop 4 of 5");
  });

  it('quitting at stop 3 reads "Stop 3 of 5"', () => {
    const row = welcomeRowView({
      guide: guide({ tourStartedAt: STARTED, lastLesson: "technicians" }),
      orgName: "Spears Services",
      cardState: FULL,
    });
    expect(row.meta).toBe("Stop 3 of 5");
  });

  it("a started tour without a stored lesson continues from stop 1", () => {
    const row = welcomeRowView({ guide: guide({ tourStartedAt: STARTED }), orgName: "Spears Services", cardState: FULL });
    expect(row.primary).toEqual({ label: "Continue the tour", href: "/admin/setup?lesson=requests#learn" });
    expect(row.meta).toBe("Stop 1 of 5");
  });

  it("FieldPulse line names FieldPulse and never mentions hidden records", () => {
    const row = welcomeRowView({ guide: guide({ hasFieldPulse: true }), orgName: "Spears Services", cardState: FULL });
    expect(row.line).toBe(
      "Your FieldPulse jobs, customers and team, in one place. Here’s a quick tour of where things live.",
    );
    expect(row.line).not.toMatch(/hidden/i);
  });

  it("no-FieldPulse line drops the FieldPulse sentence", () => {
    const row = welcomeRowView({ guide: guide(), orgName: "Spears Services", cardState: FULL });
    expect(row.line).toBe("Your jobs, customers and team, in one place. Here’s a quick tour of where things live.");
  });

  it("never claims older records are hidden, whatever the guide says", () => {
    for (const hasFieldPulse of [false, true]) {
      const row = welcomeRowView({ guide: guide({ hasFieldPulse }), orgName: "Spears Services", cardState: FULL });
      expect(row.line).not.toMatch(/hidden|clean start|need them back/i);
    }
  });

  it("falls back to a plain title without an org name", () => {
    expect(welcomeRowView({ guide: guide(), orgName: undefined, cardState: FULL }).title).toBe("Welcome");
    expect(welcomeRowView({ guide: guide(), orgName: "  ", cardState: FULL }).title).toBe("Welcome");
  });

  it("while shown: the card X is hidden and Up next is outline; otherwise as today", () => {
    const shown = welcomeRowView({ guide: guide(), orgName: "Spears Services", cardState: FULL });
    expect(shown.hideCardDismiss).toBe(true);
    expect(shown.upNextVariant).toBe("outline");
    const hidden = welcomeRowView({ guide: guide(), orgName: "Spears Services", cardState: NO_WELCOME });
    expect(hidden.hideCardDismiss).toBe(false);
    expect(hidden.upNextVariant).toBe("default");
  });
});

describe("welcomeDismissBody", () => {
  it("sends dismissWelcome for a real admin", () => {
    expect(welcomeDismissBody(guide())).toEqual({ dismissWelcome: true });
  });

  it("readOnly never PATCHes", () => {
    expect(welcomeDismissBody(guide({ readOnly: true }))).toBeNull();
  });

  it("no guide, no PATCH", () => {
    expect(welcomeDismissBody(null)).toBeNull();
  });
});
