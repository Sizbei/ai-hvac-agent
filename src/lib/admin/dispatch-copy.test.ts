import { describe, it, expect } from "vitest";
import {
  CALL_THEM, confirmLines, conflictRows, coveredLine, dayLabel, firstName, massDialogTitle, massMoveButton, massReasonLabel,
  massResultHeadline, moveBanner, moveErrorBanner, startedLine, timeOffLine, MOVED, STALE_LINE,
} from "./dispatch-copy";
import { WINDOW_ENDED_MESSAGE } from "./window-ended";

const ALEX = "alex-id";
const SAM = "sam-id";
const names = new Map([[ALEX, "Alex Rivera"], [SAM, "Sam Lee"]]);

describe("names and dates", () => {
  it("firstName", () => {
    expect(firstName("Alex Rivera")).toBe("Alex");
    expect(firstName("  ")).toBe("A technician");
    expect(firstName(null)).toBe("A technician");
  });
  it("dayLabel is the business day, 'Tue, Nov 10'", () => {
    expect(dayLabel("2026-11-10")).toBe("Tue, Nov 10");
  });
  it("coveredLine", () => {
    expect(coveredLine("8 AM–8 PM")).toBe("Still 8 AM–8 PM. Use Move… to change the window.");
  });
});

describe("confirm copy (spec §8)", () => {
  it("started line per status; a mirrored status with no timestamp is 'marked'", () => {
    expect(startedLine("Alex Rivera", "en_route", true)).toBe("Alex Rivera is en route to this visit.");
    expect(startedLine("Alex Rivera", "arrived", true)).toBe("Alex Rivera has arrived.");
    expect(startedLine("Alex Rivera", "in_progress", true)).toBe("Alex Rivera is in progress on this visit.");
    expect(startedLine("Alex Rivera", "on_hold", true)).toBe("Alex Rivera is paused on this visit.");
    expect(startedLine("Alex Rivera", "completed", true)).toBe("Alex Rivera is done with this visit.");
    expect(startedLine("Alex Rivera", "in_progress", false)).toBe("This visit is marked in progress.");
  });
  it("lead change: lines 1–3 with reset and time stop", () => {
    expect(confirmLines(
      { needs: ["started"], started: [{ technicianId: ALEX, status: "arrived", hasTimestamp: true, openTimeEntry: true }] },
      { names, oldLeadId: ALEX, newLeadId: SAM, leadChanges: true, windowChanges: false, range: "9 AM–11 AM", dayLabel: null, resetsToScheduled: true },
    )).toEqual([
      "Alex Rivera has arrived.",
      "Alex comes off the visit. Sam becomes the lead and takes over close-out, the invoice and estimates. The request goes back to scheduled. Alex’s time on it stops.",
      CALL_THEM,
    ]);
  });
  it("time change: started lines, then one 'It moves to' line with the day when it changes", () => {
    expect(confirmLines(
      { needs: ["started"], started: [{ technicianId: ALEX, status: "in_progress", hasTimestamp: true, openTimeEntry: false }] },
      { names, oldLeadId: ALEX, newLeadId: ALEX, leadChanges: false, windowChanges: true, range: "12 PM–4 PM", dayLabel: "Wed, Nov 11", resetsToScheduled: false },
    )).toEqual(["Alex Rivera is in progress on this visit.", "It moves to 12 PM–4 PM on Wed, Nov 11.", CALL_THEM]);
  });
  it("lead and window both change: lead lines, then the move line", () => {
    expect(confirmLines(
      { needs: ["started"], started: [{ technicianId: ALEX, status: "en_route", hasTimestamp: true, openTimeEntry: false }] },
      { names, oldLeadId: ALEX, newLeadId: SAM, leadChanges: true, windowChanges: true, range: "12 PM–4 PM", dayLabel: null, resetsToScheduled: true },
    )).toEqual([
      "Alex Rivera is en route to this visit.",
      "Alex comes off the visit. Sam becomes the lead and takes over close-out, the invoice and estimates. The request goes back to scheduled.",
      "It moves to 12 PM–4 PM.",
      CALL_THEM,
    ]);
  });
  it("conflict rows name technicians only when more than one is involved", () => {
    const c = (technicianId: string) => ({ id: "x", referenceNumber: "HVAC-9", technicianId, arrivalWindowStart: "2026-11-10T17:00:00.000Z", arrivalWindowEnd: "2026-11-10T21:00:00.000Z" });
    expect(conflictRows([c(SAM)], names)).toEqual(["HVAC-9 · 12 PM–4 PM"]);
    expect(conflictRows([c(SAM), c(ALEX)], names)).toEqual(["HVAC-9 · 12 PM–4 PM · Sam", "HVAC-9 · 12 PM–4 PM · Alex"]);
  });
});

describe("time off copy", () => {
  const block = { startsAt: "2026-11-10T21:00:00.000Z", endsAt: "2026-11-11T01:00:00.000Z", kind: "time_off" as const };
  it("one day", () => {
    expect(timeOffLine("Sam Lee", block, false)).toBe("Sam is off 4 PM–8 PM on Tue, Nov 10.");
  });
  it("more than one day", () => {
    expect(timeOffLine("Sam Lee", { ...block, startsAt: "2026-11-09T05:00:00.000Z", endsAt: "2026-11-14T05:00:00.000Z" }, false)).toBe("Sam is off Mon, Nov 9 – Fri, Nov 13.");
  });
  it("a non-job event or a capacity-removing on-call shift", () => {
    expect(timeOffLine("Sam Lee", { ...block, kind: "non_job" }, false)).toBe("Sam has a non-job event 4 PM–8 PM on Tue, Nov 10.");
    expect(timeOffLine("Sam Lee", { ...block, kind: "on_call" }, false)).toBe("Sam has a non-job event 4 PM–8 PM on Tue, Nov 10.");
  });
  it("a helper adds the way out", () => {
    expect(timeOffLine("Sam Lee", block, true)).toBe("Sam is off 4 PM–8 PM on Tue, Nov 10. Or remove Sam in the request.");
  });
});

describe("banners", () => {
  it("each code's line", () => {
    expect(moveErrorBanner("STALE")).toBe(STALE_LINE);
    expect(moveErrorBanner("VISIT_ENDED")).toBe("This visit has ended. Add a new visit instead.");
    expect(moveErrorBanner("VISIT_PINNED", { visitNumber: 2 })).toBe("Visit #2. Change its time in the request.");
    expect(moveErrorBanner("REQUEST_TERMINAL", { status: "completed" })).toBe("This request is completed, so it can’t be moved.");
    expect(moveErrorBanner("REQUEST_TERMINAL", { status: "cancelled" })).toBe("This request is cancelled, so it can’t be moved.");
    expect(moveErrorBanner("TECHNICIAN_NOT_FOUND")).toBe("That technician isn’t active any more.");
    expect(moveErrorBanner("TECHNICIAN_DONE", { technicianId: SAM }, names)).toBe("Sam has finished on this visit.");
    expect(moveErrorBanner("WINDOW_ENDED")).toBe(WINDOW_ENDED_MESSAGE);
    expect(moveErrorBanner("MANAGED_EXTERNALLY")).toBe("Change this request in FieldPulse.");
    expect(moveErrorBanner("INTERNAL_ERROR")).toBe("Couldn’t move the request. Please try again.");
  });
  it("moveBanner: a lead change that shrinks the crew names both", () => {
    const before = [{ technicianId: ALEX, name: "Alex Rivera", isLead: true, state: "working" as const }];
    const after = [{ technicianId: SAM, name: "Sam Lee", isLead: true, state: "open" as const }];
    expect(moveBanner(before, after)).toBe("Sam is now the lead. Alex is off this visit.");
    expect(moveBanner(before, before)).toBe(MOVED);
    expect(moveBanner([], after)).toBe(MOVED);
  });
});

describe("mass copy (spec §7.6, §8)", () => {
  it("reasons", () => {
    expect(massReasonLabel("started", {})).toBe("Started");
    expect(massReasonLabel("ended", {})).toBe("Visit ended");
    expect(massReasonLabel("later_visit", { visitNumber: 2 })).toBe("Visit #2. Change it in the request.");
    expect(massReasonLabel("time_off", {})).toBe("Time off then");
    expect(massReasonLabel("window_ended", {})).toBe("That time has passed");
    expect(massReasonLabel("already_on_visit", { toFirstName: "Sam" })).toBe("Sam is already on it");
    expect(massReasonLabel("fieldpulse", {})).toBe("Change it in FieldPulse");
    expect(massReasonLabel("helper", { leadFirstName: "Alex" })).toBe("Helping Alex. Change it in the request.");
    expect(massReasonLabel("stale", {})).toBe("Changed since you opened this");
    expect(massReasonLabel("conflict", {})).toBe("Overlaps another request");
  });
  it("result headline variants", () => {
    expect(massResultHeadline(3, "Alex", "Sam", "Wed, Nov 11")).toBe("Moved 3 of Alex’s requests to Sam on Wed, Nov 11.");
    expect(massResultHeadline(3, "Alex", "Sam", null)).toBe("Moved 3 of Alex’s requests to Sam.");
    expect(massResultHeadline(1, "Alex", null, "Wed, Nov 11")).toBe("Moved 1 of Alex’s requests to Wed, Nov 11.");
    expect(massResultHeadline(0, "Alex", "Sam", null)).toBe("None of Alex’s requests moved.");
  });
  it("button and title", () => {
    expect(massMoveButton(1)).toBe("Move 1 request");
    expect(massMoveButton(4)).toBe("Move 4 requests");
    expect(massDialogTitle("Alex Rivera", "Tue, Nov 10")).toBe("Move Alex’s requests on Tue, Nov 10");
  });
});
