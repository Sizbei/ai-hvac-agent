import { describe, expect, it } from "vitest";
import {
  buildLessons,
  CONSERVATIVE_LESSON_CONTEXT,
  lessonContext,
  type LessonContext,
} from "./tour-lessons";
import { HISTORY_CONTACT_FALLBACK, LESSON_IDS, type AdminGuidePayload } from "./admin-guide-state";

const OFF: LessonContext = {
  payLinks: false,
  hasFieldPulse: false,
  historyHidden: false,
  historyContact: "Raymond Chen",
};

function copyOf(ctx: Partial<LessonContext>, id: string): string {
  const lesson = buildLessons({ ...OFF, ...ctx }).find((l) => l.id === id);
  if (!lesson) throw new Error(`no lesson ${id}`);
  return lesson.copy;
}

const ALL_CONTEXTS: LessonContext[] = [false, true].flatMap((payLinks) =>
  [false, true].flatMap((hasFieldPulse) =>
    [false, true].map((historyHidden) => ({ payLinks, hasFieldPulse, historyHidden, historyContact: "Raymond Chen" })),
  ),
);

describe("buildLessons", () => {
  it("returns the five stops in order with exact titles", () => {
    const lessons = buildLessons(OFF);
    expect(lessons.map((l) => l.id)).toEqual([...LESSON_IDS]);
    expect(lessons.map((l) => l.title)).toEqual([
      "Requests come to you",
      "Book and assign",
      "Your team works from their phones",
      "Every customer in one place",
      "Getting paid",
    ]);
  });

  it("uses the base copy when every switch is off", () => {
    expect(buildLessons(OFF).map((l) => l.copy)).toEqual([
      "Calls, texts and website chat arrive as requests with the problem and contact already filled in.",
      "Give a request a time and a technician in one dialog. The calendar shows everyone’s day.",
      "Technicians see their requests, notes and photos on their phone, and their own guide walks them through it.",
      "Each customer’s requests, equipment, estimates and invoices live on their page.",
      "See what’s owed at a glance, and turn an accepted estimate into an invoice.",
    ]);
  });

  it("Show me opens the lesson's page from the tour", () => {
    expect(buildLessons(OFF).map((l) => l.href)).toEqual([
      "/admin/requests?from=tour&lesson=requests",
      "/admin/calendar?from=tour&lesson=schedule",
      "/admin/staff?from=tour&lesson=technicians",
      "/admin/customers?from=tour&lesson=customers",
      "/admin/invoices?from=tour&lesson=paid",
    ]);
  });

  describe("requests variants", () => {
    it("FieldPulse + history hidden prepends the carried-over sentence", () => {
      expect(copyOf({ hasFieldPulse: true, historyHidden: true }, "requests")).toBe(
        "Your upcoming FieldPulse work carried over as requests. Calls, texts and website chat arrive as requests with the problem and contact already filled in.",
      );
    });

    it("FieldPulse with history shown prepends the jobs sentence", () => {
      expect(copyOf({ hasFieldPulse: true, historyHidden: false }, "requests")).toBe(
        "Your FieldPulse jobs are requests here. Calls, texts and website chat arrive as requests with the problem and contact already filled in.",
      );
    });

    it("history hidden without FieldPulse makes no FieldPulse claim", () => {
      expect(copyOf({ historyHidden: true }, "requests")).not.toContain("FieldPulse");
    });
  });

  describe("customers variants", () => {
    it("customers + historyHidden appends the history note naming the contact", () => {
      expect(copyOf({ historyHidden: true }, "customers")).toBe(
        "Each customer’s requests, equipment, estimates and invoices live on their page. Older records are hidden for a clean start. Ask Raymond Chen if you need them back.",
      );
    });

    it("says Older FieldPulse records only with FieldPulse", () => {
      expect(copyOf({ historyHidden: true, hasFieldPulse: true }, "customers")).toBe(
        "Each customer’s requests, equipment, estimates and invoices live on their page. Older FieldPulse records are hidden for a clean start. Ask Raymond Chen if you need them back.",
      );
    });

    it("no history note when history is shown, even with FieldPulse", () => {
      expect(copyOf({ hasFieldPulse: true }, "customers")).toBe(
        "Each customer’s requests, equipment, estimates and invoices live on their page.",
      );
    });
  });

  describe("paid variants", () => {
    it("payLinks on appends the pay-link sentence", () => {
      expect(copyOf({ payLinks: true }, "paid")).toBe(
        "See what’s owed at a glance, and turn an accepted estimate into an invoice. Text a pay link so customers can pay by phone.",
      );
    });

    it("payLinks off → no pay-link sentence in any lesson, in any context", () => {
      for (const ctx of ALL_CONTEXTS.filter((c) => !c.payLinks)) {
        for (const lesson of buildLessons(ctx)) expect(lesson.copy).not.toMatch(/pay link/i);
      }
    });
  });

  it("no lesson mentions the map or review texts, in any context", () => {
    for (const ctx of ALL_CONTEXTS) {
      for (const lesson of buildLessons(ctx)) {
        expect(`${lesson.title} ${lesson.copy}`).not.toMatch(/\bmap\b|review/i);
      }
    }
  });

  it("FieldPulse is never mentioned without a FieldPulse connection", () => {
    for (const ctx of ALL_CONTEXTS.filter((c) => !c.hasFieldPulse)) {
      for (const lesson of buildLessons(ctx)) expect(lesson.copy).not.toContain("FieldPulse");
    }
  });

  it("never says demo", () => {
    for (const ctx of ALL_CONTEXTS) {
      for (const lesson of buildLessons(ctx)) expect(`${lesson.title} ${lesson.copy}`).not.toMatch(/demo/i);
    }
  });
});

describe("lessonContext", () => {
  const guide: AdminGuidePayload = {
    welcomeDue: true,
    lastLesson: null,
    tourStartedAt: null,
    tourCompletedAt: null,
    readOnly: false,
    payLinks: true,
    hasFieldPulse: true,
    historyHidden: false,
    historyContact: "Raymond Chen",
  };

  it("takes the switches and contact from the guide", () => {
    expect(lessonContext(guide)).toEqual({
      payLinks: true,
      hasFieldPulse: true,
      historyHidden: false,
      historyContact: "Raymond Chen",
    });
  });

  it("no guide → conservative: no FieldPulse or pay-link claims, history note on", () => {
    expect(lessonContext(null)).toBe(CONSERVATIVE_LESSON_CONTEXT);
    expect(CONSERVATIVE_LESSON_CONTEXT).toEqual({
      payLinks: false,
      hasFieldPulse: false,
      historyHidden: true,
      historyContact: HISTORY_CONTACT_FALLBACK,
    });
    expect(copyOf(CONSERVATIVE_LESSON_CONTEXT, "customers")).toContain(
      "Older records are hidden for a clean start. Ask your account administrator if you need them back.",
    );
  });
});
