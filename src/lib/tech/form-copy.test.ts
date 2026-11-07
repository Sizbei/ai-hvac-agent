import { describe, it, expect } from "vitest";
import {
  ASSIGN_AGAIN, backHref, cardVisit, dayShort, firstName, SUBMITTED_ON, formChips, numberNote, readOnlyCopy, READ_ONLY_COPY, reminderVisible, statusLine,
  type StatusInput,
} from "./form-copy";
import type { CardForm } from "./form-view";

const TZ = "America/New_York";
const NOW = new Date("2026-11-07T19:45:00.000Z"); // 2:45 PM Eastern
const base: StatusInput = { phase: "saved", savedAt: "2026-11-07T19:41:00.000Z", savedByOther: null, unparsedCount: 0, submittedAt: null, submittedByName: null, now: NOW };

describe("statusLine (spec §7.3 table)", () => {
  it("saved today, earlier, and by someone else", () => {
    expect(statusLine(base, TZ)).toBe("Saved · 2:41 PM");
    expect(statusLine({ ...base, savedAt: "2026-11-06T19:41:00.000Z" }, TZ)).toBe("Saved · Nov 6, 2:41 PM");
    expect(statusLine({ ...base, savedByOther: "Sam" }, TZ)).toBe("Saved · 2:41 PM · Sam");
  });
  it("the day is the business timezone's: 11:30 PM Eastern is still today though UTC is tomorrow", () => {
    const late = new Date("2026-11-08T04:45:00.000Z"); // 11:45 PM Eastern, Nov 7
    expect(statusLine({ ...base, savedAt: "2026-11-08T04:30:00.000Z", now: late }, TZ)).toBe("Saved · 11:30 PM");
    expect(statusLine({ ...base, savedAt: "2026-11-07T04:30:00.000Z", now: late }, TZ)).toBe("Saved · Nov 6, 11:30 PM");
  });
  it("never Saved while a number is unparsed", () => {
    expect(statusLine({ ...base, unparsedCount: 1 }, TZ)).toBe("Not saved yet: 1 answer isn't a number.");
    expect(statusLine({ ...base, phase: "saving", unparsedCount: 2 }, TZ)).toBe("Not saved yet: 2 answers aren't numbers.");
  });
  it("the other phases", () => {
    expect(statusLine({ ...base, phase: "blank", savedAt: null }, TZ)).toBe("");
    expect(statusLine({ ...base, phase: "saving" }, TZ)).toBe("Saving…");
    expect(statusLine({ ...base, phase: "retrying" }, TZ)).toBe("Not saved yet. Retrying…");
    expect(statusLine({ ...base, phase: "signed_out" }, TZ)).toBe("You've been signed out. Sign in again, then open this job again.");
    expect(statusLine({ ...base, phase: "too_large" }, TZ)).toBe("This form is too long to save. Shorten the longest answers.");
    expect(statusLine({ ...base, phase: "bad_request" }, TZ)).toBe("Couldn't save your answers.");
    expect(statusLine({ ...base, phase: "submit_sent" }, TZ)).toBe("Submitting…");
    expect(statusLine({ ...base, phase: "submit_unknown" }, TZ)).toBe("Your last change may not have saved. Try again.");
    expect(statusLine({ ...base, phase: "submitted", submittedAt: "2026-11-07T19:41:00.000Z", submittedByName: "Alex Rivera" }, TZ)).toBe("Submitted · Nov 7, 2:41 PM · Alex Rivera");
  });
});

describe("readOnlyCopy", () => {
  it("every reason has its line; submitted is the status line only", () => {
    for (const [reason, copy] of Object.entries(READ_ONLY_COPY)) {
      expect(readOnlyCopy(reason as keyof typeof READ_ONLY_COPY, { myRowCancelled: false })).toEqual([copy]);
    }
    expect(readOnlyCopy("submitted", { myRowCancelled: false })).toEqual([]);
    expect(readOnlyCopy(null, { myRowCancelled: false })).toEqual([]);
  });
  it("not_assigned with my own row cancelled adds the reassign line", () => {
    expect(readOnlyCopy("not_assigned", { myRowCancelled: true })).toEqual([READ_ONLY_COPY.not_assigned, ASSIGN_AGAIN]);
  });
});

describe("formChips precedence (spec §7.2)", () => {
  const card = (over: Partial<CardForm> = {}): CardForm => ({ formId: "f", name: "M", description: null, required: true, submission: null, submittedOn: null, ...over });
  const sub = (over: Partial<NonNullable<CardForm["submission"]>> = {}) => ({
    id: "s", status: "draft" as const, revision: 1, hasAnswers: true, erased: false, updatedAt: "x", submittedAt: null, submittedByName: null, ...over,
  });
  it("erased, submitted here, submitted on another visit, draft, not started", () => {
    expect(formChips(card({ submission: sub({ erased: true, status: "submitted" }) })).status).toBe("Answers removed");
    expect(formChips(card({ submission: sub({ status: "submitted" }) })).status).toBe("Submitted");
    expect(formChips(card({ submission: sub(), submittedOn: { appointmentId: "a", appointmentNumber: 1, submittedAt: "x" } })).status).toBe("Submitted on visit #1");
    expect(formChips(card({ submission: sub() }))).toEqual({ status: "Draft", required: true });
    expect(formChips(card({ submission: sub({ hasAnswers: false }) })).status).toBe("Not started");
    expect(formChips(card()).status).toBe("Not started");
  });
});

describe("navigation and reminders", () => {
  it("cardVisit: ?visit=, then my assignment, then the active visit", () => {
    expect(cardVisit("p", "a", "b")).toBe("p");
    expect(cardVisit(undefined, null, "b")).toBe("b");
    expect(cardVisit(undefined, null, null)).toBeNull();
    expect(cardVisit("", "a", "b")).toBe("a");
  });
  it("backHref: ?visit only when it is my visit; from= returns to that visit's page", () => {
    expect(backHref({ jobId: "j", formId: "f", visitId: "v", myVisit: true, from: null })).toEqual({ label: "Back to job", href: "/tech/jobs/j?visit=v" });
    expect(backHref({ jobId: "j", formId: "f", visitId: "v", myVisit: false, from: null })).toEqual({ label: "Back to job", href: "/tech/jobs/j" });
    expect(backHref({ jobId: "j", formId: "f", visitId: "v1", myVisit: false, from: "v2" })).toEqual({ label: "Back", href: "/tech/jobs/j/forms/f?visit=v2" });
  });
  it("reminderVisible: close out on a native job with reminders, blocked or ready", () => {
    expect(reminderVisible("close_out", true, [1])).toBe(true);
    expect(reminderVisible("completed", true, [1])).toBe(false);
    expect(reminderVisible("close_out", false, [1])).toBe(false);
    expect(reminderVisible("close_out", true, [])).toBe(false);
  });
  it("the submitted-on line names the day even for a submission earlier today", () => {
    expect(SUBMITTED_ON(1, dayShort("2026-11-07T14:00:00.000Z", TZ))).toBe("Submitted on visit #1 · Nov 7. Fill it in again only if this visit needs it.");
  });
  it("number notes and first names", () => {
    expect(numberNote("partial")).toBe("Not saved yet. Finish the number.");
    expect(numberNote("invalid")).toBe("Enter a number like 12.5 (up to 3 decimal places).");
    expect(numberNote("out_of_bounds")).toBe("Enter a number under 1,000,000.");
    expect(numberNote("value")).toBeNull();
    expect(firstName("Sam  Lee")).toBe("Sam");
  });
});
