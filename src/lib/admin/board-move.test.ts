import { describe, it, expect } from "vitest";
import {
  applyMoveResult, boardInteractive, cardWidthPx, chipLayout, crewChipModel, findLeadCard, initials, laneCards, laneKey,
  moveDialogBody, moveDialogDefaults, moveLanded, moveNeeds, optimisticCrew, pillSize, resetsToScheduled, showCrewChips,
  type NeedsRow,
} from "./board-move";
import type { CrewMember } from "./board-types";
import type { DashboardRequest, SchedulingCalendar } from "./types";

const ALEX = "a1111111-1111-4111-8111-111111111111";
const SAM = "b2222222-2222-4222-8222-222222222222";
const KIM = "c3333333-3333-4333-8333-333333333333";
const row = (technicianId: string, isLead: boolean, status: string, hasTimestamp = false): NeedsRow => ({ technicianId, isLead, status, hasTimestamp });
const crew = (...m: Array<[string, string | null, boolean, CrewMember["state"]]>): CrewMember[] =>
  m.map(([technicianId, name, isLead, state]) => ({ technicianId, name, isLead, state }));

function card(over: Partial<DashboardRequest> = {}): DashboardRequest {
  return {
    id: "r1", referenceNumber: "HVAC-1", customerName: "Pat Doe", issueType: "no_heat", urgency: "medium", status: "scheduled",
    isAfterHours: false, assignedToName: "Alex Rivera", arrivalWindowStart: "2026-11-10T14:00:00.000Z", arrivalWindowEnd: "2026-11-10T16:00:00.000Z",
    followUpDate: null, holdReason: null, autoAssigned: false, createdAt: "2026-11-01T00:00:00.000Z", syncedSource: null,
    visitId: "v1", visitVersion: 3, crew: crew([ALEX, "Alex Rivera", true, "open"]), started: false, movable: "yes", laneRole: "lead",
    ...over,
  };
}
function board(over: Partial<SchedulingCalendar> = {}): SchedulingCalendar {
  return {
    days: ["2026-11-10"],
    lanes: [
      { technicianId: ALEX, technicianName: "Alex Rivera", jobs: [card()] },
      { technicianId: SAM, technicianName: "Sam Lee", jobs: [] },
    ],
    unassigned: [], unscheduled: [], availability: [], ...over,
  };
}

describe("moveNeeds (spec §5.3: checked technicians, started)", () => {
  const rows = [row(ALEX, true, "in_progress", true), row(SAM, false, "assigned"), row(KIM, false, "cancelled")];
  it("lead change only: checks the new lead; started when the current lead's row is", () => {
    const n = moveNeeds({ leadChanges: true, windowChanges: false, currentLeadId: ALEX, newLeadId: SAM, rows });
    expect(n.checked).toEqual([SAM]);
    expect(n.started).toBe(true);
    expect(n.startedRows.map((r) => r.technicianId)).toEqual([ALEX]);
  });
  it("window change only: checks every live crew member; a cancelled row isn't crew", () => {
    const n = moveNeeds({ leadChanges: false, windowChanges: true, currentLeadId: ALEX, newLeadId: ALEX, rows });
    expect([...n.checked].sort()).toEqual([ALEX, SAM].sort());
    expect(n.started).toBe(true);
  });
  it("lead and window change: the old lead is excluded from the checked list", () => {
    const n = moveNeeds({ leadChanges: true, windowChanges: true, currentLeadId: ALEX, newLeadId: KIM, rows });
    expect([...n.checked].sort()).toEqual([KIM, SAM].sort());
  });
  it("a lead swap with only a helper working and the window unchanged needs nothing", () => {
    const n = moveNeeds({ leadChanges: true, windowChanges: false, currentLeadId: ALEX, newLeadId: KIM,
      rows: [row(ALEX, true, "scheduled"), row(SAM, false, "in_progress", true)] });
    expect(n.started).toBe(false);
  });
  it("a helper working + a time move → started", () => {
    const n = moveNeeds({ leadChanges: false, windowChanges: true, currentLeadId: ALEX, newLeadId: ALEX,
      rows: [row(ALEX, true, "scheduled"), row(SAM, false, "en_route", true)] });
    expect(n.started).toBe(true);
  });
  it("nothing changes → nothing checked", () => {
    expect(moveNeeds({ leadChanges: false, windowChanges: false, currentLeadId: ALEX, newLeadId: ALEX, rows }).checked).toEqual([]);
  });
});

describe("resetsToScheduled", () => {
  const started = [{ technicianId: ALEX, status: "arrived", hasTimestamp: true, openTimeEntry: true }];
  it("a native request on site whose old lead is the only started row resets", () => {
    expect(resetsToScheduled({ status: "arrived", native: true, oldLeadId: ALEX, started })).toBe(true);
  });
  it("not when someone else is working, not on HCP/FieldPulse, not from scheduled", () => {
    expect(resetsToScheduled({ status: "arrived", native: true, oldLeadId: ALEX, started: [...started, { technicianId: SAM, status: "in_progress", hasTimestamp: true, openTimeEntry: false }] })).toBe(false);
    expect(resetsToScheduled({ status: "arrived", native: false, oldLeadId: ALEX, started })).toBe(false);
    expect(resetsToScheduled({ status: "scheduled", native: true, oldLeadId: ALEX, started })).toBe(false);
  });
  it("not when the 409 says another row is started (a lead-only change lists only the lead)", () => {
    expect(resetsToScheduled({ status: "arrived", native: true, oldLeadId: ALEX, started, othersStarted: true })).toBe(false);
  });
});

describe("optimisticCrew", () => {
  it("the new lead comes out of the helpers; the old lead is off", () => {
    expect(optimisticCrew(crew([ALEX, "Alex", true, "working"], [SAM, "Sam", false, "open"]), SAM, "Sam")).toEqual(
      crew([SAM, "Sam", true, "open"]),
    );
  });
  it("a technician not on the crew joins as an open lead", () => {
    expect(optimisticCrew(crew([ALEX, "Alex", true, "open"], [KIM, "Kim", false, "working"]), SAM, "Sam")).toEqual(
      crew([SAM, "Sam", true, "open"], [KIM, "Kim", false, "working"]),
    );
  });
  it("the same lead changes nothing", () => {
    const c = crew([ALEX, "Alex", true, "open"]);
    expect(optimisticCrew(c, ALEX, "Alex")).toEqual(c);
  });
});

describe("laneCards (helper copies)", () => {
  const two = card({ crew: crew([ALEX, "Alex Rivera", true, "open"], [SAM, "Sam Lee", false, "working"]) });
  it("adds a non-draggable copy to each helper's lane, keyed request:technician", () => {
    const out = laneCards(board({ lanes: [{ technicianId: ALEX, technicianName: "Alex Rivera", jobs: [two] }, { technicianId: SAM, technicianName: "Sam Lee", jobs: [] }] }));
    const samJobs = out.lanes[1]!.jobs;
    expect(samJobs).toHaveLength(1);
    expect(samJobs[0]).toMatchObject({ id: "r1", laneRole: "helper", laneTechnicianId: SAM });
    expect(laneKey(samJobs[0]!)).toBe(`r1:${SAM}`);
    expect(laneKey(out.lanes[0]!.jobs[0]!)).toBe("r1");
  });
  it("is idempotent and skips ended visits and helpers without a lane", () => {
    const b = board({ lanes: [{ technicianId: ALEX, technicianName: "Alex Rivera", jobs: [two, card({ id: "r2", visitEnded: true, crew: two.crew })] }] });
    const once = laneCards(b);
    expect(laneCards(once)).toEqual(once);
    expect(once.lanes[0]!.jobs.map((j) => j.id)).toEqual(["r1", "r2"]);
  });
});

describe("findLeadCard / applyMoveResult / moveLanded", () => {
  const names = new Map([[ALEX, "Alex Rivera"], [SAM, "Sam Lee"]]);
  it("finds the lead card in lanes, the unassigned lane or Unscheduled, never a helper copy", () => {
    const b = laneCards(board({ lanes: [{ technicianId: ALEX, technicianName: "A", jobs: [] }, { technicianId: SAM, technicianName: "S", jobs: [card({ crew: crew([SAM, "Sam", true, "open"], [ALEX, "Alex", false, "open"]) })] }] }));
    expect(findLeadCard(b, "r1")).toMatchObject({ scope: SAM });
    expect(findLeadCard(board({ lanes: [], unscheduled: [card()] }), "r1")).toMatchObject({ scope: "unscheduled" });
    expect(findLeadCard(board(), "nope")).toBeNull();
  });
  it("writes the new version, window, status and lead before the refetch", () => {
    const out = applyMoveResult(board(), "r1", {
      visitId: "v1", visitVersion: 4, requestStatus: "scheduled", arrivalWindowStart: "2026-11-10T17:00:00.000Z",
      arrivalWindowEnd: "2026-11-10T21:00:00.000Z", leadId: SAM, confirmed: [],
    }, names);
    expect(out.lanes[0]!.jobs).toEqual([]);
    expect(out.lanes[1]!.jobs[0]).toMatchObject({ visitVersion: 4, arrivalWindowStart: "2026-11-10T17:00:00.000Z", assignedToName: "Sam Lee" });
    expect(out.lanes[1]!.jobs[0]!.crew?.[0]).toMatchObject({ technicianId: SAM, isLead: true });
  });
  it("moveLanded: the refetched card has the intended lead and window", () => {
    const b = board();
    expect(moveLanded(b, { requestId: "r1", leadId: ALEX, start: "2026-11-10T14:00:00.000Z", end: "2026-11-10T16:00:00.000Z" })).toBe(true);
    expect(moveLanded(b, { requestId: "r1", leadId: SAM, start: "2026-11-10T14:00:00.000Z", end: "2026-11-10T16:00:00.000Z" })).toBe(false);
    expect(moveLanded(b, { requestId: "r1", leadId: ALEX, start: "2026-11-10T17:00:00.000Z", end: "2026-11-10T21:00:00.000Z" })).toBe(false);
  });
  it("moveLanded for an Unscheduled drop: landed means back in Unscheduled", () => {
    expect(moveLanded(board({ lanes: [], unscheduled: [card()] }), { requestId: "r1", unscheduled: true })).toBe(true);
    expect(moveLanded(board(), { requestId: "r1", unscheduled: true })).toBe(false);
  });
  it("two tray cards: moving one leaves the other in Unscheduled", () => {
    const b = board({ lanes: [{ technicianId: ALEX, technicianName: "A", jobs: [] }], unscheduled: [card({ id: "u1", arrivalWindowStart: null, arrivalWindowEnd: null }), card({ id: "u2", arrivalWindowStart: null, arrivalWindowEnd: null })] });
    const out = applyMoveResult(b, "u1", { visitId: "v9", visitVersion: 1, requestStatus: "assigned", arrivalWindowStart: "2026-11-10T13:00:00.000Z", arrivalWindowEnd: "2026-11-10T17:00:00.000Z", leadId: ALEX, confirmed: [] }, names);
    expect(out.unscheduled.map((j) => j.id)).toEqual(["u2"]);
    expect(out.lanes[0]!.jobs.map((j) => j.id)).toEqual(["u1"]);
  });
});

describe("layout helpers", () => {
  it("boardInteractive: ≥ 1024 px with a fine pointer", () => {
    expect(boardInteractive(1440, true)).toBe(true);
    expect(boardInteractive(1023, true)).toBe(false);
    expect(boardInteractive(1440, false)).toBe(false);
  });
  it("chips only with 2+ crew; a count below 120 px wide, below 72 px high, or in Week view", () => {
    expect(showCrewChips(crew([ALEX, "A", true, "open"]))).toBe(false);
    expect(showCrewChips(crew([ALEX, "A", true, "open"], [SAM, "S", false, "open"]))).toBe(true);
    expect(chipLayout(220, 112, "day")).toBe("chips");
    expect(chipLayout(119, 112, "day")).toBe("count");
    expect(chipLayout(220, 71, "day")).toBe("count");
    expect(chipLayout(220, 112, "week")).toBe("count");
  });
  it("crewChipModel: lead first, three chips, +N past three", () => {
    const m = crewChipModel(crew([SAM, "Sam", false, "open"], [ALEX, "Alex", true, "working"], [KIM, "Kim", false, "done"], ["d", "Dee", false, "open"], ["e", "Eve", false, "open"]));
    expect(m.chips.map((c) => c.technicianId)).toEqual([ALEX, SAM, KIM]);
    expect(m.more).toBe(2);
  });
  it("initials", () => {
    expect(initials("Alex Rivera")).toBe("AR");
    expect(initials("Sam")).toBe("S");
    expect(initials(null)).toBe("?");
  });
  it("card width = 224 / columns − 4; pill md at ≥ 160 px in Day view only", () => {
    expect(cardWidthPx(1)).toBe(220);
    expect(cardWidthPx(2)).toBe(108);
    expect(pillSize("day", 220)).toBe("md");
    expect(pillSize("day", 108)).toBe("sm");
    expect(pillSize("week", 220)).toBe("sm");
  });
});

describe("moveDialogDefaults / moveDialogBody (spec §7.5)", () => {
  const today = "2026-11-10";
  const morningNow = new Date("2026-11-10T12:00:00.000Z"); // 7 AM ET: nothing has ended
  it("a placed card: its lead, its day, Keep", () => {
    expect(moveDialogDefaults(card(), today, morningNow)).toEqual({ technicianId: ALEX, day: "2026-11-10", window: "keep" });
  });
  it("an unassigned card: Unassigned, Keep", () => {
    expect(moveDialogDefaults(card({ crew: [] }), today, morningNow)).toEqual({ technicianId: "", day: "2026-11-10", window: "keep" });
  });
  it("an Unscheduled card without a window: Unassigned, today, the first band that hasn't ended", () => {
    const u = card({ arrivalWindowStart: null, arrivalWindowEnd: null });
    expect(moveDialogDefaults(u, today, morningNow, true)).toEqual({ technicianId: "", day: today, window: "morning" });
    expect(moveDialogDefaults(u, today, new Date("2026-11-10T18:30:00.000Z"), true).window).toBe("afternoon"); // 1:30 PM: morning ended, afternoon hasn't
    expect(moveDialogDefaults(u, today, new Date("2026-11-10T21:30:00.000Z"), true).window).toBe("evening"); // 4:30 PM
  });
  it("no change → null (Move disabled)", () => {
    expect(moveDialogBody(card(), { technicianId: ALEX, day: "2026-11-10", window: "keep" })).toBeNull();
    expect(moveDialogBody(card(), { technicianId: "", day: "2026-11-10", window: "keep" })).toBeNull();
  });
  it("keep to another day: rule keep, the band the kept start falls in", () => {
    expect(moveDialogBody(card(), { technicianId: ALEX, day: "2026-11-11", window: "keep" })).toEqual({
      visitId: "v1", expectedVersion: 3, day: "2026-11-11", band: "morning", windowRule: "keep", confirm: [],
    });
  });
  it("a picked window and another technician", () => {
    expect(moveDialogBody(card(), { technicianId: SAM, day: "2026-11-10", window: "afternoon" })).toEqual({
      visitId: "v1", expectedVersion: 3, day: "2026-11-10", band: "afternoon", windowRule: "pick", pick: "afternoon", technicianId: SAM, confirm: [],
    });
  });
  it("Anytime rides on the morning band", () => {
    expect(moveDialogBody(card(), { technicianId: ALEX, day: "2026-11-10", window: "anytime" })).toMatchObject({ band: "morning", pick: "anytime" });
  });
  it("picking exactly the current window, same day and technician, is no change", () => {
    const m = card({ arrivalWindowStart: "2026-11-10T13:00:00.000Z", arrivalWindowEnd: "2026-11-10T17:00:00.000Z" });
    expect(moveDialogBody(m, { technicianId: ALEX, day: "2026-11-10", window: "morning" })).toBeNull();
  });
  it("an Unscheduled card with no window can't Keep", () => {
    const u = card({ arrivalWindowStart: null, arrivalWindowEnd: null });
    expect(moveDialogBody(u, { technicianId: "", day: today, window: "keep" }, true)).toBeNull();
    expect(moveDialogBody(u, { technicianId: "", day: today, window: "morning" }, true)).toMatchObject({ windowRule: "pick", pick: "morning" });
  });
});
