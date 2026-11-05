import { describe, it, expect } from "vitest";
import { cardState, pickTodayFirst, cardNote, glyphFor } from "./guide-view";
import type { DerivedStep, GuidePayload } from "./guide-steps";

const base: GuidePayload = { steps: [], progress: { requiredDone: 0, requiredTotal: 2, optionalDone: 0, optionalTotal: 7 }, upNext: "start_job", finished: false, hasOpenJob: false, hiddenAt: null, cardHidden: false };
const opts = { loading: false, failed: false, slowElapsed: true, guideHidden: false, todaySettled: true };
const step = { id: "start_job", note: "no job" } as unknown as DerivedStep;
const noNote = { id: "start_job" } as unknown as DerivedStep;

describe("cardState", () => {
  it("hidden server-side never fetches", () => expect(cardState(null, { ...opts, guideHidden: true, loading: true })).toBe("hidden"));
  it("hidden on the payload flag", () => expect(cardState({ ...base, cardHidden: true }, opts)).toBe("hidden"));
  it("nothing before 300 ms, skeleton after, while loading", () => {
    expect(cardState(null, { ...opts, loading: true, slowElapsed: false })).toBe("nothing");
    expect(cardState(null, { ...opts, loading: true })).toBe("skeleton");
  });
  it("waits for the Today fetch to settle", () => {
    expect(cardState(base, { ...opts, todaySettled: false })).toBe("skeleton");
    expect(cardState(base, opts)).toBe("card");
  });
  it("nothing on a failed first load; a kept payload still shows", () => {
    expect(cardState(null, { ...opts, failed: true })).toBe("nothing");
    expect(cardState(base, { ...opts, failed: true })).toBe("card");
  });
  it("finished block", () => expect(cardState({ ...base, finished: true }, opts)).toBe("finished"));
});

describe("pickTodayFirst", () => {
  const j = (id: string, assignmentStatus: string) => ({ id, appointmentId: `a-${id}`, assignmentStatus });
  it("prefers an in-progress, arrived or en-route row, else the first row, null when empty", () => {
    expect(pickTodayFirst([j("1", "assigned"), j("2", "en_route")])).toEqual({ href: "/tech/jobs/2?visit=a-2" });
    expect(pickTodayFirst([j("1", "assigned"), j("2", "scheduled")])).toEqual({ href: "/tech/jobs/1?visit=a-1" });
    expect(pickTodayFirst([])).toBeNull();
  });
});

describe("cardNote", () => {
  it("server note first, then the Upcoming hint only when Today loaded empty", () => {
    expect(cardNote(step, false, null)).toBe("no job");
    expect(cardNote(noNote, true, null)).toBe("Your next job is under Upcoming.");
    expect(cardNote(noNote, true, { href: "/x" })).toBeUndefined();
    expect(cardNote(noNote, true, "unknown")).toBeUndefined();
    expect(cardNote(noNote, false, null)).toBeUndefined();
  });
});

describe("glyphFor", () => {
  it("done / next / todo", () => {
    expect(glyphFor({ id: "start_job", done: true }, "finish_job")).toBe("done");
    expect(glyphFor({ id: "finish_job", done: false }, "finish_job")).toBe("next");
    expect(glyphFor({ id: "clock_in", done: false }, "finish_job")).toBe("todo");
  });
});
