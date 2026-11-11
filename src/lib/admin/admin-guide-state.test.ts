import { describe, it, expect } from "vitest";
import {
  LESSON_IDS,
  HISTORY_CONTACT_FALLBACK,
  buildGuidePayload,
  contactOrFallback,
  guidePatchSchema,
  guidePatchWrites,
  parseAdminGuideState,
  welcomeDue,
} from "./admin-guide-state";

const T1 = "2026-11-10T12:00:00.000Z";
const T2 = "2026-11-11T09:30:00.000Z";

describe("LESSON_IDS", () => {
  it("is the five tour stops in order", () => {
    expect(LESSON_IDS).toEqual(["requests", "schedule", "technicians", "customers", "paid"]);
  });
});

describe("parseAdminGuideState", () => {
  it.each([
    ["null", null],
    ["undefined", undefined],
    ["a string", "welcome"],
    ["a number", 7],
    ["an array", [T1]],
    ["true", true],
  ])("treats %s as {}", (_n, raw) => {
    expect(parseAdminGuideState(raw)).toEqual({});
  });

  it("keeps the four known keys", () => {
    const raw = { welcomeDismissedAt: T1, tourStartedAt: T1, tourCompletedAt: T2, lastLesson: "customers" };
    expect(parseAdminGuideState(raw)).toEqual(raw);
  });

  it("drops unknown keys", () => {
    expect(parseAdminGuideState({ lastLesson: "paid", hiddenAt: T1, x: { y: 1 } })).toEqual({ lastLesson: "paid" });
  });

  it("drops a bad value without losing the good ones", () => {
    expect(
      parseAdminGuideState({ welcomeDismissedAt: "not a date", tourStartedAt: 5, tourCompletedAt: T2, lastLesson: "map" }),
    ).toEqual({ tourCompletedAt: T2 });
  });

  it("never throws on hostile input", () => {
    const hostile = Object.create(null) as Record<string, unknown>;
    hostile.lastLesson = { toString: () => "requests" };
    expect(() => parseAdminGuideState(hostile)).not.toThrow();
    expect(parseAdminGuideState(hostile)).toEqual({});
  });
});

describe("welcomeDue", () => {
  it.each(["admin", "super_admin"] as const)("is true for a fresh %s", (role) => {
    expect(welcomeDue(role, {})).toBe(true);
  });

  it("is false for a technician", () => {
    expect(welcomeDue("technician", {})).toBe(false);
  });

  it("is false once the welcome was dismissed", () => {
    expect(welcomeDue("admin", { welcomeDismissedAt: T1 })).toBe(false);
  });

  it("is false once the tour was completed", () => {
    expect(welcomeDue("admin", { tourCompletedAt: T1 })).toBe(false);
  });

  it("stays true while the tour is only started", () => {
    expect(welcomeDue("admin", { tourStartedAt: T1, lastLesson: "schedule" })).toBe(true);
  });
});

describe("guidePatchSchema", () => {
  it.each([
    [{ dismissWelcome: true }],
    [{ lesson: "requests" }],
    [{ tourCompleted: true }],
    [{ dismissWelcome: true, lesson: "paid", tourCompleted: true }],
  ])("accepts %j", (body) => {
    expect(guidePatchSchema.safeParse(body).success).toBe(true);
  });

  it.each([
    ["an empty object", {}],
    ["dismissWelcome false", { dismissWelcome: false }],
    ["tourCompleted false", { tourCompleted: false }],
    ["an unknown lesson", { lesson: "map" }],
    ["an extra key", { lesson: "requests", tourStartedAt: T1 }],
    ["a stored key", { welcomeDismissedAt: T1 }],
    ["null", null],
    ["an array", [{ lesson: "requests" }]],
  ])("rejects %s", (_n, body) => {
    expect(guidePatchSchema.safeParse(body).success).toBe(false);
  });
});

describe("guidePatchWrites", () => {
  it("dismissWelcome writes welcomeDismissedAt once", () => {
    expect(guidePatchWrites({ dismissWelcome: true }, T1)).toEqual({
      writeOnce: { welcomeDismissedAt: T1 },
    });
  });

  it("lesson sets lastLesson and offers tourStartedAt as write-once", () => {
    expect(guidePatchWrites({ lesson: "customers" }, T1)).toEqual({
      writeOnce: { tourStartedAt: T1 },
      lastLesson: "customers",
    });
  });

  it("tourCompleted writes tourCompletedAt once", () => {
    expect(guidePatchWrites({ tourCompleted: true }, T1)).toEqual({
      writeOnce: { tourCompletedAt: T1 },
    });
  });

  it("combines every key", () => {
    expect(guidePatchWrites({ dismissWelcome: true, lesson: "paid", tourCompleted: true }, T2)).toEqual({
      writeOnce: { welcomeDismissedAt: T2, tourStartedAt: T2, tourCompletedAt: T2 },
      lastLesson: "paid",
    });
  });
});

describe("buildGuidePayload", () => {
  const base = {
    role: "admin" as const,
    readOnly: false,
    payLinks: true,
    hasFieldPulse: true,
  };

  it("maps a fresh admin's state", () => {
    expect(buildGuidePayload({ ...base, state: {} })).toEqual({
      welcomeDue: true,
      lastLesson: null,
      tourStartedAt: null,
      tourCompletedAt: null,
      readOnly: false,
      payLinks: true,
      hasFieldPulse: true,
    });
  });

  it("carries the stored progress", () => {
    const p = buildGuidePayload({ ...base, state: { tourStartedAt: T1, lastLesson: "technicians" } });
    expect(p).toMatchObject({ welcomeDue: true, tourStartedAt: T1, lastLesson: "technicians", tourCompletedAt: null });
  });

  it("a stale preview (no subject) is read-only and never due", () => {
    expect(buildGuidePayload({ ...base, state: null, readOnly: true })).toMatchObject({
      welcomeDue: false,
      readOnly: true,
      lastLesson: null,
      tourStartedAt: null,
      tourCompletedAt: null,
    });
  });

  it("an active preview of a fresh admin is due but read-only", () => {
    expect(buildGuidePayload({ ...base, state: {}, readOnly: true })).toMatchObject({
      welcomeDue: true,
      readOnly: true,
    });
  });

});

describe("contactOrFallback", () => {
  it.each([
    ["no platform admin in the org", null],
    ["a blank name", "   "],
  ])("falls back to the generic contact with %s", (_n, contactName) => {
    expect(contactOrFallback(contactName)).toBe(HISTORY_CONTACT_FALLBACK);
    expect(HISTORY_CONTACT_FALLBACK).toBe("your account administrator");
  });

  it.each([
    ["a name equal to an email", "owner@spears.example"],
    ["a name containing @", "Ray @ Spears"],
  ])("never returns an email: %s falls back", (_n, contactName) => {
    expect(contactOrFallback(contactName)).toBe(HISTORY_CONTACT_FALLBACK);
  });

  it("trims the contact name", () => {
    expect(contactOrFallback("  Ray  ")).toBe("Ray");
  });
});
