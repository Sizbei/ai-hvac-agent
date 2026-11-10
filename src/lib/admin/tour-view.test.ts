import { describe, expect, it } from "vitest";
import {
  readTourMount,
  seedTour,
  showTourInvite,
  stopAnnouncement,
  stopLabel,
  TOUR_DONE_LINE,
  tourSearch,
  type TourMount,
} from "./tour-view";
import type { AdminGuidePayload } from "./admin-guide-state";

const GUIDE: AdminGuidePayload = {
  welcomeDue: true,
  lastLesson: null,
  tourStartedAt: null,
  tourCompletedAt: null,
  readOnly: false,
  payLinks: false,
  hasFieldPulse: false,
  historyHidden: false,
  historyContact: "your account administrator",
};
const STARTED: AdminGuidePayload = { ...GUIDE, tourStartedAt: "2026-11-10T12:00:00.000Z", lastLesson: "customers" };
const COMPLETED: AdminGuidePayload = { ...STARTED, tourCompletedAt: "2026-11-10T13:00:00.000Z" };

const mount = (search: string, hash = ""): TourMount => readTourMount(search, hash);

describe("readTourMount (decided once, from the URL)", () => {
  it("a valid ?lesson puts the tour above the hero and asks for focus", () => {
    expect(mount("?lesson=schedule")).toEqual({ lesson: "schedule", replay: false, placement: "above", focus: true });
  });

  it("no ?lesson → below the hero, no focus", () => {
    expect(mount("")).toEqual({ lesson: null, replay: false, placement: "below", focus: false });
  });

  it("an invalid ?lesson is ignored: below, no lesson", () => {
    expect(mount("?lesson=map")).toEqual({ lesson: null, replay: false, placement: "below", focus: false });
    expect(mount("?lesson=__proto__")).toMatchObject({ lesson: null, placement: "below" });
    expect(mount("?lesson=")).toMatchObject({ lesson: null, placement: "below" });
  });

  it("#learn without a lesson asks for focus but stays below", () => {
    expect(mount("", "#learn")).toEqual({ lesson: null, replay: false, placement: "below", focus: true });
  });

  it("reads replay=1 only", () => {
    expect(mount("?lesson=requests&replay=1").replay).toBe(true);
    expect(mount("?lesson=requests&replay=true").replay).toBe(false);
  });
});

describe("seedTour (local stop/completed, seeded once from guide)", () => {
  it("?lesson names the stop", () => {
    expect(seedTour(mount("?lesson=technicians"), STARTED)).toEqual({ index: 2, completed: false });
  });

  it("no ?lesson and started → lastLesson", () => {
    expect(seedTour(mount(""), STARTED)).toEqual({ index: 3, completed: false });
  });

  it("not started → stop 1", () => {
    expect(seedTour(mount(""), GUIDE)).toEqual({ index: 0, completed: false });
  });

  it("invalid ?lesson falls back to requests for a new user", () => {
    expect(seedTour(mount("?lesson=bogus"), GUIDE)).toEqual({ index: 0, completed: false });
  });

  it("completed collapses, and beats ?lesson", () => {
    expect(seedTour(mount(""), COMPLETED).completed).toBe(true);
    expect(seedTour(mount("?lesson=paid"), COMPLETED).completed).toBe(true);
  });

  it("replay=1 reopens a completed tour at the named stop", () => {
    expect(seedTour(mount("?lesson=requests&replay=1"), COMPLETED)).toEqual({ index: 0, completed: false });
  });

  it("guide null (failed guide read or failed GET) → the URL's stop, never collapsed", () => {
    expect(seedTour(mount("?lesson=paid"), null)).toEqual({ index: 4, completed: false });
    expect(seedTour(mount(""), null)).toEqual({ index: 0, completed: false });
  });
});

describe("tourSearch (replaceState target)", () => {
  it("sets ?lesson and keeps other params", () => {
    expect(tourSearch("?foo=1", { lesson: "schedule", replay: false })).toBe("?foo=1&lesson=schedule");
    expect(tourSearch("?lesson=requests", { lesson: "paid", replay: false })).toBe("?lesson=paid");
  });

  it("keeps replay=1 during a replay", () => {
    expect(tourSearch("?lesson=requests&replay=1", { lesson: "schedule", replay: true })).toBe(
      "?lesson=schedule&replay=1",
    );
  });

  it("Finish removes ?lesson and replay", () => {
    expect(tourSearch("?lesson=paid&replay=1", { lesson: null, replay: false })).toBe("");
    expect(tourSearch("?foo=1&lesson=paid", { lesson: null, replay: false })).toBe("?foo=1");
  });
});

describe("copy", () => {
  it("stop label and live-region announcement", () => {
    expect(stopLabel(0)).toBe("Stop 1 of 5");
    expect(stopLabel(4)).toBe("Stop 5 of 5");
    expect(stopAnnouncement(1, "Book and assign")).toBe("Stop 2 of 5: Book and assign");
  });

  it("completed collapses to \"You've seen the basics · Replay tour\"", () => {
    expect(TOUR_DONE_LINE).toEqual({ text: "You’ve seen the basics", action: "Replay tour" });
  });
});

describe("showTourInvite (header line)", () => {
  it("shown once seeded, not completed and no ?lesson at mount", () => {
    expect(showTourInvite(mount(""), { index: 0, completed: false })).toBe(true);
  });

  it("hidden before the tour is seeded", () => {
    expect(showTourInvite(mount(""), null)).toBe(false);
  });

  it("hidden once completed", () => {
    expect(showTourInvite(mount(""), { index: 0, completed: true })).toBe(false);
  });

  it("hidden while ?lesson is present", () => {
    expect(showTourInvite(mount("?lesson=requests"), { index: 0, completed: false })).toBe(false);
  });
});
