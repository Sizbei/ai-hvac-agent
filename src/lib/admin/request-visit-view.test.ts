import { describe, it, expect } from "vitest";
import { cancelRequestDescription, sheetVisitView } from "./request-visit-view";

const base = {
  assignedToName: "Junie Ortiz",
  arrivalWindowStart: "2026-11-10T21:00:00.000Z",
  arrivalWindowEnd: "2026-11-11T01:00:00.000Z",
};

describe("sheetVisitView", () => {
  it("request mode keeps the request's technician, window and controls", () => {
    expect(sheetVisitView({ ...base, currentVisit: { kind: "request" } })).toEqual({
      mode: "request",
      technicianName: "Junie Ortiz",
      arrivalWindowStart: base.arrivalWindowStart,
      arrivalWindowEnd: base.arrivalWindowEnd,
      requestControls: true,
      hiddenTransitions: [],
      notice: null,
    });
  });

  it("a hold-ended visit hides the request controls and every bare resume, and says why", () => {
    const view = sheetVisitView({
      ...base,
      currentVisit: {
        kind: "ended", appointmentId: "v1", appointmentNumber: 1,
        arrivalWindowStart: base.arrivalWindowStart, arrivalWindowEnd: base.arrivalWindowEnd,
        technicianId: "junie", technicianName: "Junie Ortiz",
      },
    });
    expect(view.mode).toBe("ended");
    expect(view.requestControls).toBe(false);
    expect(view.hiddenTransitions).toEqual(["scheduled", "en_route", "arrived", "in_progress"]);
    expect(view.notice).toBe("This visit ended when the request was put on hold. Schedule the next visit to send someone.");
  });

  it("a later visit shows ITS technician and window, not the request columns (office = phone)", () => {
    const view = sheetVisitView({
      ...base,
      currentVisit: {
        kind: "visit", appointmentId: "v2", appointmentNumber: 2,
        arrivalWindowStart: "2026-11-10T17:00:00.000Z", arrivalWindowEnd: "2026-11-10T21:00:00.000Z",
        technicianId: "odessa", technicianName: "Odessa Dagley",
      },
    });
    expect(view).toMatchObject({
      mode: "visit",
      technicianName: "Odessa Dagley",
      arrivalWindowStart: "2026-11-10T17:00:00.000Z",
      requestControls: false,
      hiddenTransitions: [],
    });
    expect(view.notice).toMatch(/^Visit #2 is the current visit/);
  });
});

describe("cancelRequestDescription", () => {
  it("mentions the technician only when one is assigned", () => {
    expect(cancelRequestDescription(true)).toBe("The technician will see it as cancelled.");
    expect(cancelRequestDescription(false)).not.toMatch(/technician/i);
  });
});
