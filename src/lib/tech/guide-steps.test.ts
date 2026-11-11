import { describe, it, expect } from "vitest";
import type { GuideState } from "./guide-state";
import { STEP_DEFS, NO_JOB_NOTE, deriveGuide, upNext, type Signals } from "./guide-steps";

const NOW = new Date("2026-11-05T12:00:00.000Z");
const ON = { payLinks: true };
const OFF = { payLinks: false };
const ALL_FALSE = {
  startJob: false, finishJob: false, clockIn: false, shareLocation: false, addMaterial: false,
  noteOrPhoto: false, captureSignature: false, buildInvoice: false, collectPayment: false,
};
function signals(p: Partial<Signals> = {}, state: Partial<GuideState> = {}): Signals {
  return { ...ALL_FALSE, hasOpenJob: false, state: { firstCompleted: {}, ...state }, ...p };
}

describe("STEP_DEFS", () => {
  it("has nine steps, two required, three lead-only, in spec order", () => {
    expect(STEP_DEFS.map((s) => s.id)).toEqual(["start_job", "finish_job", "clock_in", "share_location", "add_material", "note_or_photo", "capture_signature", "build_invoice", "collect_payment"]);
    expect(STEP_DEFS.filter((s) => s.required).map((s) => s.id)).toEqual(["start_job", "finish_job"]);
    expect(STEP_DEFS.filter((s) => s.leadOnly).map((s) => s.id)).toEqual(["capture_signature", "build_invoice", "collect_payment"]);
    expect(STEP_DEFS.filter((s) => s.group === "run")).toHaveLength(2);
  });
  it("pins the how lines to the real buttons", () => {
    const how = Object.fromEntries(STEP_DEFS.map((s) => [s.id, s.how]));
    expect(how.start_job).toBe("Open your job in the list. Tap On my way when you leave. Tap I've arrived at the door, then Working.");
    expect(how.finish_job).toBe("Tap Done when your part is finished. If Close out shows instead, tap that.");
    expect(how.clock_in).toBe("Tap Clock in for the day at the top of your jobs. Tap Clock out when you're done.");
    expect(how.share_location).toBe("Turn on Share my location at the top of the screen.");
    expect(how.add_material).toBe("On the job, under Materials used, pick an item from the pricebook or type one in, then tap Add.");
    expect(how.note_or_photo).toBe("On the job, write an on-site note and tap Save note, or add a photo under Photos.");
    expect(how.capture_signature).toBe("On the job, under Customer signature, hand the phone to the customer, then tap Save signature. Only the lead technician can do this.");
    expect(how.build_invoice).toBe("On the job, tap Open invoice, then Create invoice if there isn't one. Check the lines, tap Customer approval, and have the customer sign and tap Approve and finalize. Only the lead technician builds the invoice.");
    expect(how.collect_payment).toBe("After the customer approves, record cash or a check in the sheet that opens, or tap Send pay link.");
  });
  it("pins titles and why lines", () => {
    const t = Object.fromEntries(STEP_DEFS.map((s) => [s.id, [s.title, s.why]]));
    expect(t.start_job).toEqual(["Start your first job", "Each tap tells the office you're on the way, on site and working, so nobody has to call you."]);
    expect(t.finish_job).toEqual(["Finish a job", "Done tells the office your part is finished. Close out finishes the whole request."]);
    expect(t.clock_in).toEqual(["Clock in for the day", "Your hours land on the office timesheet without a paper form."]);
    expect(t.share_location).toEqual(["Share your location while working", "Dispatch sends the nearest technician to the next job."]);
    expect(t.add_material).toEqual(["Add a part you used", "Parts you add here land on the invoice, so nothing is billed from memory."]);
    expect(t.note_or_photo).toEqual(["Add a note or a photo", "The office and the next technician see what you saw."]);
    expect(t.capture_signature).toEqual(["Get the customer's signature", "Proof the work was approved, kept on the job."]);
    expect(t.build_invoice).toEqual(["Build the invoice and get it approved", "The invoice goes out while you're still on site."]);
    expect(t.collect_payment).toEqual(["Collect payment on site", "Cash and checks are recorded on the spot. A pay link lets the customer pay by phone."]);
  });
});

describe("deriveGuide pay-link copy", () => {
  const pay = (f: { payLinks: boolean }) => deriveGuide(signals(), NOW, f).steps.find((x) => x.id === "collect_payment")!;
  it("off: why and how drop the pay-link clauses", () => {
    expect(pay(OFF).why).toBe("Cash and checks are recorded on the spot.");
    expect(pay(OFF).how).toBe("After the customer approves, record cash or a check in the sheet that opens.");
  });
  it("on: strings unchanged", () => {
    expect(pay(ON).why).toBe("Cash and checks are recorded on the spot. A pay link lets the customer pay by phone.");
    expect(pay(ON).how).toBe("After the customer approves, record cash or a check in the sheet that opens, or tap Send pay link.");
  });
  it("off changes no other step", () => {
    const strip = (f: { payLinks: boolean }) => deriveGuide(signals(), NOW, f).steps.filter((x) => x.id !== "collect_payment");
    expect(strip(OFF)).toEqual(strip(ON));
  });
});

describe("deriveGuide", () => {
  it("fresh technician: 0 of 2, up next start_job with the no-job note, nothing to stamp", () => {
    const d = deriveGuide(signals(), NOW, ON);
    expect(d.progress).toEqual({ requiredDone: 0, requiredTotal: 2, optionalDone: 0, optionalTotal: 7 });
    expect(d.upNext).toBe("start_job");
    expect(d.finished).toBe(false);
    expect(d.newStamps).toEqual({});
    expect(d.steps[0].note).toBe(NO_JOB_NOTE);
    expect(NO_JOB_NOTE).toBe("The office hasn't assigned you a job yet. It shows in your jobs when they do.");
  });
  it("no note once a job is open", () => {
    expect(deriveGuide(signals({ hasOpenJob: true }), NOW, ON).steps[0].note).toBeUndefined();
  });
  it("a true signal is done and stamped now", () => {
    const d = deriveGuide(signals({ startJob: true }), NOW, ON);
    expect(d.steps[0].done).toBe(true);
    expect(d.newStamps).toEqual({ start_job: NOW.toISOString() });
    expect(d.upNext).toBe("finish_job");
  });
  it("a stamped step stays done when the signal is false, and is not re-stamped", () => {
    const d = deriveGuide(signals({}, { firstCompleted: { start_job: "2026-11-01T00:00:00.000Z" } }), NOW, ON);
    expect(d.steps[0].done).toBe(true);
    expect(d.newStamps).toEqual({});
  });
  it("finished when both required are done; up next moves to the first optional", () => {
    const d = deriveGuide(signals({ startJob: true, finishJob: true }), NOW, ON);
    expect(d.finished).toBe(true);
    expect(d.progress.requiredDone).toBe(2);
    expect(d.upNext).toBe("clock_in");
  });
  it("upNext is null when everything is done", () => {
    const all = Object.fromEntries(Object.keys(ALL_FALSE).map((k) => [k, true])) as Partial<Signals>;
    expect(deriveGuide(signals(all), NOW, ON).upNext).toBeNull();
  });
  it("upNext helper prefers required", () => {
    const d = deriveGuide(signals({ clockIn: true }), NOW, ON);
    expect(upNext(d.steps)).toBe("start_job");
  });
});
