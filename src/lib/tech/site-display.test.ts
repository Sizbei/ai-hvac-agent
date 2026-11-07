import { describe, it, expect } from "vitest";
import { estimateHref, estimateTotal, membershipLines, pastJobLine, siteCardLine, SITE_COPY, unaddressedLine } from "./site-display";
import type { SiteView } from "./site-view";

const TZ = "America/New_York";
const view = (over: Partial<SiteView> = {}): SiteView => ({
  scope: "location", title: "Service address", pastJobs: [], unaddressedCount: 0, openEstimates: [], membership: { state: "none" }, hasCustomer: true, isLead: true, ...over,
});
const job = { id: "r", referenceNumber: "R-1", date: "2026-11-03T15:00:00.000Z", status: "completed", kind: "Maintenance", leadTechnicianName: "Alex", submittedFormNames: ["Maintenance checklist"] };
const est = (over = {}) => ({ id: "e", label: "Estimate · Nov 6 · 2 options", createdAt: "2026-11-06T15:00:00.000Z", totalCents: 481200, optionCount: 2, thisJob: false, fromFieldPulse: false, ...over });

describe("site rows (spec §8)", () => {
  it("past job line", () => {
    expect(pastJobLine(job, TZ)).toBe("Nov 3, 2026 · Maintenance · Completed · Alex · Forms: Maintenance checklist");
    expect(pastJobLine({ ...job, leadTechnicianName: null, submittedFormNames: [] }, TZ)).toBe("Nov 3, 2026 · Maintenance · Completed");
  });
  it("only this job's native open estimates link, and only for the lead (spec §7.6)", () => {
    expect(estimateHref("j", est({ thisJob: true }), true)).toBe("/tech/jobs/j/estimates/e");
    expect(estimateHref("j", est({ thisJob: true }), false)).toBeNull();
    expect(estimateHref("j", est({ thisJob: false }), true)).toBeNull();
    expect(estimateHref("j", est({ thisJob: true, fromFieldPulse: true }), true)).toBeNull();
  });
  it("estimate total", () => {
    expect(estimateTotal(est())).toBe("Up to $4,812.00");
    expect(estimateTotal(est({ optionCount: 1 }))).toBe("$4,812.00");
  });
  it("unaddressed line", () => {
    expect(unaddressedLine(0)).toBeNull();
    expect(unaddressedLine(1)).toBe("1 earlier job has no saved address.");
    expect(unaddressedLine(3)).toBe("3 earlier jobs have no saved address.");
  });
  it("membership: member, none, withheld", () => {
    const m = membershipLines({
      state: "member", planName: "Comfort Club", startedAt: "2026-03-10T15:00:00.000Z", currentPeriodEnd: "2027-04-01T16:00:00.000Z", visitsPerYear: 2,
      upcoming: [{ dueDate: "2027-05-01T16:00:00.000Z", status: "scheduled", thisJob: false }, { dueDate: "2027-11-01T16:00:00.000Z", status: "generated", thisJob: true }],
    }, TZ);
    expect(m).toEqual({
      head: "Comfort Club · Member since Mar 2026 · Paid through Apr 1, 2027",
      visits: "2 visits a year",
      upcoming: [{ text: "May 1, 2027 · Scheduled", thisJob: false }, { text: "Nov 1, 2027 · Booked", thisJob: true }],
    });
    expect(membershipLines({ state: "member", planName: "P", startedAt: "2026-03-10T15:00:00.000Z", currentPeriodEnd: null, visitsPerYear: 0, upcoming: [] }, TZ).head).toBe("P · Member since Mar 2026");
    expect(membershipLines({ state: "none" }).head).toBe(SITE_COPY.notMember);
    expect(membershipLines({ state: "withheld" }).head).toBe(SITE_COPY.withheld);
  });
});

describe("siteCardLine (spec §7.6)", () => {
  it("counts, zero parts omitted", () => {
    expect(siteCardLine(view({ pastJobs: [job, job, job, job], openEstimates: [est()], membership: { state: "member", planName: "P", startedAt: "x", currentPeriodEnd: null, visitsPerYear: 1, upcoming: [] } }))).toEqual({
      text: "4 past jobs · 1 open estimate · Member", tappable: true,
    });
    expect(siteCardLine(view())).toEqual({ text: "No history at this address yet.", tappable: false });
  });
  it("no saved address, with this job's estimate; no customer", () => {
    expect(siteCardLine(view({ scope: "none", openEstimates: [est({ thisJob: true })] }))).toEqual({ text: "No saved address · 1 open estimate", tappable: true });
    expect(siteCardLine(view({ scope: "none" }))).toEqual({ text: "No saved address", tappable: false });
    expect(siteCardLine(view({ hasCustomer: false }))).toEqual({ text: "No customer on this job yet.", tappable: false });
  });
});
