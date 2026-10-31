import { describe, it, expect } from "vitest";
import {
  parseCreateRequestBody,
  planSchedule,
  resolveJobType,
  scheduleConflictMessage,
  windowAvailability,
  buildCreateRequestPayload,
  formatIsoDayShort,
  firstOpenDay,
  isScheduleDayInRange,
  requestContactSnapshot,
  SCHEDULE_MAX_DAYS_AHEAD,
  BOOKABLE_WINDOWS,
  ISSUE_TYPE_LABELS,
  type CreateRequestDraft,
} from "./create-request";
import { issueTypeValues, jobTypeValues } from "@/lib/ai/extraction-schema";

const TODAY = "2026-11-01";
const parse = (raw: unknown) => parseCreateRequestBody(raw, TODAY);

const CUSTOMER_ID = "11111111-1111-4111-8111-111111111111";
const TECH_ID = "22222222-2222-4222-8222-222222222222";

function baseBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    customerId: CUSTOMER_ID,
    address: "  12 Main St, Johnson City, TN 37601 ",
    issueType: "cooling_not_working",
    urgency: "high",
    description: "  AC blowing warm air  ",
    ...overrides,
  };
}

describe("parseCreateRequestBody", () => {
  it("accepts an existing-customer body and trims text", () => {
    const r = parse(baseBody());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.customer).toEqual({ kind: "existing", customerId: CUSTOMER_ID });
    expect(r.data.address).toBe("12 Main St, Johnson City, TN 37601");
    expect(r.data.description).toBe("AC blowing warm air");
    expect(r.data.schedule).toBeNull();
    expect(r.data.override).toBe(false);
    expect(r.data.accessNotes).toBeNull();
  });

  it("accepts an inline customer and blanks empty contact fields to null", () => {
    const r = parse(
      baseBody({
        customerId: undefined,
        customer: { name: " Dana Fox ", phone: "", email: "  " },
      }),
    );
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.data.customer).toEqual({
      kind: "inline",
      name: "Dana Fox",
      phone: null,
      email: null,
    });
  });

  it("rejects when both or neither customer forms are given", () => {
    expect(
      parse(
        baseBody({ customer: { name: "Dana Fox" } }),
      ).ok,
    ).toBe(false);
    expect(parse(baseBody({ customerId: undefined })).ok).toBe(false);
  });

  it("rejects a malformed customer id, phone or email", () => {
    expect(parse(baseBody({ customerId: "nope" })).ok).toBe(false);
    expect(
      parse(
        baseBody({ customerId: undefined, customer: { name: "A B", phone: "123" } }),
      ).ok,
    ).toBe(false);
    expect(
      parse(
        baseBody({ customerId: undefined, customer: { name: "A B", email: "x@" } }),
      ).ok,
    ).toBe(false);
  });

  it("requires address and description, caps description at 2000", () => {
    expect(parse(baseBody({ address: "   " })).ok).toBe(false);
    expect(parse(baseBody({ description: "" })).ok).toBe(false);
    expect(parse(baseBody({ description: "x".repeat(2001) })).ok).toBe(false);
    expect(parse(baseBody({ description: "x".repeat(2000) })).ok).toBe(true);
  });

  it("rejects unknown enums", () => {
    expect(parse(baseBody({ issueType: "fire" })).ok).toBe(false);
    expect(parse(baseBody({ urgency: "now" })).ok).toBe(false);
    expect(parse(baseBody({ jobType: "party" })).ok).toBe(false);
  });

  it("accepts a schedule with a bookable band and rejects impossible dates", () => {
    const ok = parse(
      baseBody({ schedule: { isoDay: "2026-11-02", window: "morning", technicianId: TECH_ID } }),
    );
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.data.schedule).toEqual({
        isoDay: "2026-11-02",
        window: "morning",
        technicianId: TECH_ID,
      });
    }
    expect(
      parse(baseBody({ schedule: { isoDay: "2026-02-31", window: "morning" } })).ok,
    ).toBe(false);
    expect(
      parse(baseBody({ schedule: { isoDay: "2026-11-02", window: "anytime" } })).ok,
    ).toBe(false);
    expect(
      parse(
        baseBody({ schedule: { isoDay: "2026-11-02", window: "morning", technicianId: "x" } }),
      ).ok,
    ).toBe(false);
  });

  it("returns a human message on failure, never a zod dump", () => {
    const r = parse("not an object");
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/^[A-Z]/);
  });
});

describe("planSchedule", () => {
  it("is none without a schedule", () => {
    expect(planSchedule(null)).toEqual({ kind: "none" });
  });
  it("places the window only when no technician is picked", () => {
    expect(planSchedule({ isoDay: "2026-11-02", window: "afternoon", technicianId: null })).toEqual({
      kind: "window_only",
      isoDay: "2026-11-02",
      window: "afternoon",
    });
  });
  it("assigns when a technician is picked", () => {
    expect(planSchedule({ isoDay: "2026-11-02", window: "evening", technicianId: TECH_ID })).toEqual({
      kind: "assign",
      isoDay: "2026-11-02",
      window: "evening",
      technicianId: TECH_ID,
    });
  });
});

describe("resolveJobType", () => {
  it("keeps an explicit job type", () => {
    expect(resolveJobType("cooling_not_working", "estimate")).toBe("estimate");
  });
  it("derives from the issue when omitted", () => {
    expect(resolveJobType("heating_not_working", null)).toBe("no_heat");
    expect(resolveJobType("water_leak", null)).toBe("service_call");
  });
});

describe("scheduleConflictMessage", () => {
  it("mirrors the reschedule copy for each case", () => {
    expect(scheduleConflictMessage({ conflictCount: 1, outsideAvailability: true })).toBe(
      "This time overlaps another job and is outside the technician's hours.",
    );
    expect(scheduleConflictMessage({ conflictCount: 0, outsideAvailability: true })).toBe(
      "This time is outside the technician's working hours.",
    );
    expect(scheduleConflictMessage({ conflictCount: 2, outsideAvailability: false })).toBe(
      "This time overlaps another job for the technician.",
    );
  });
});

describe("windowAvailability", () => {
  const windows = [
    { day: "2026-11-02", window: "morning", capacity: 3, available: 2 },
    { day: "2026-11-02", window: "afternoon", capacity: 3, available: 0 },
  ];
  it("reads the band's open count", () => {
    expect(windowAvailability(windows, "2026-11-02", "morning")).toEqual({ capacity: 3, available: 2 });
    expect(windowAvailability(windows, "2026-11-02", "afternoon")).toEqual({ capacity: 3, available: 0 });
  });
  it("treats a missing band as no capacity", () => {
    expect(windowAvailability(windows, "2026-11-02", "evening")).toEqual({ capacity: 0, available: 0 });
  });
});

describe("buildCreateRequestPayload", () => {
  const draft: CreateRequestDraft = {
    customerId: null,
    newCustomer: { name: " Dana Fox ", phone: " (423) 555-0100 ", email: "" },
    address: " 12 Main St ",
    issueType: "cooling_not_working",
    jobType: "",
    urgency: "medium",
    description: " Warm air ",
    accessNotes: "  ",
    scheduleOpen: false,
    isoDay: "2026-11-02",
    window: "morning",
    technicianId: "",
  };

  it("builds an inline-customer payload and omits blanks", () => {
    const p = buildCreateRequestPayload(draft, false);
    expect(p).toEqual({
      customer: { name: "Dana Fox", phone: "(423) 555-0100" },
      address: "12 Main St",
      issueType: "cooling_not_working",
      urgency: "medium",
      description: "Warm air",
    });
  });

  it("uses the picked customer id and includes the schedule when open", () => {
    const p = buildCreateRequestPayload(
      { ...draft, customerId: CUSTOMER_ID, scheduleOpen: true, technicianId: TECH_ID, jobType: "estimate" },
      true,
    );
    expect(p.customerId).toBe(CUSTOMER_ID);
    expect(p.customer).toBeUndefined();
    expect(p.jobType).toBe("estimate");
    expect(p.schedule).toEqual({ isoDay: "2026-11-02", window: "morning", technicianId: TECH_ID });
    expect(p.override).toBe(true);
  });

  it("round-trips through the server parser", () => {
    const p = buildCreateRequestPayload({ ...draft, scheduleOpen: true }, false);
    const r = parse(p);
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.data.schedule).toEqual({ isoDay: "2026-11-02", window: "morning", technicianId: null });
  });
});

describe("labels", () => {
  it("labels every issue type and bookable window", () => {
    for (const v of issueTypeValues) expect(ISSUE_TYPE_LABELS[v]).toBeTruthy();
    expect(BOOKABLE_WINDOWS).toEqual(["morning", "afternoon", "evening"]);
    expect(jobTypeValues.length).toBeGreaterThan(0);
  });
});

describe("formatIsoDayShort", () => {
  it("formats a business day without timezone drift", () => {
    expect(formatIsoDayShort("2026-11-02")).toBe("Mon, Nov 2");
  });
});

describe("firstOpenDay", () => {
  const days = ["2026-11-01", "2026-11-02", "2026-11-03"];
  it("picks the first day with an open band", () => {
    const windows = [
      { day: "2026-11-01", window: "morning", capacity: 0, available: 0 },
      { day: "2026-11-02", window: "evening", capacity: 2, available: 1 },
    ];
    expect(firstOpenDay(days, windows)).toBe("2026-11-02");
  });
  it("falls back to the first day, or empty with no days", () => {
    expect(firstOpenDay(days, [])).toBe("2026-11-01");
    expect(firstOpenDay([], [])).toBe("");
  });
});

describe("isScheduleDayInRange", () => {
  it("allows yesterday through the max horizon", () => {
    expect(isScheduleDayInRange("2026-10-31", TODAY)).toBe(true);
    expect(isScheduleDayInRange(TODAY, TODAY)).toBe(true);
    expect(isScheduleDayInRange("2027-11-01", TODAY)).toBe(true);
  });
  it("refuses two days back or past the horizon", () => {
    expect(isScheduleDayInRange("2026-10-30", TODAY)).toBe(false);
    expect(isScheduleDayInRange("2027-11-02", TODAY)).toBe(false);
    expect(SCHEDULE_MAX_DAYS_AHEAD).toBe(365);
  });
  it("is enforced by the body parser", () => {
    const r = parse(baseBody({ schedule: { isoDay: "2020-01-01", window: "morning" } }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/date/i);
  });
});

describe("requestContactSnapshot", () => {
  it("sanitises an inline customer the way the customer row is sanitised", () => {
    expect(
      requestContactSnapshot({ kind: "inline", name: "dana  o'brien", phone: "423.555.0100", email: "Dana@Example.COM" }),
    ).toEqual({ name: "Dana O'Brien", phone: "(423) 555-0100", email: "dana@example.com" });
  });
  it("keeps absent contact fields null", () => {
    expect(requestContactSnapshot({ kind: "inline", name: "Dana Fox", phone: null, email: null })).toEqual({
      name: "Dana Fox",
      phone: null,
      email: null,
    });
  });
  it("returns null for an existing customer (blobs are copied, not re-typed)", () => {
    expect(requestContactSnapshot({ kind: "existing", customerId: "x" })).toBeNull();
  });
});

describe("M0b fields", () => {
  const JT = "22222222-2222-4222-8222-222222222222", CT = "33333333-3333-4333-8333-333333333333", LOC = "44444444-4444-4444-8444-444444444444", TAG = "55555555-5555-4555-8555-555555555555";
  it("accepts jobTypeId, contactId, locationId and tags with an existing customer", () => {
    const r = parse({ ...baseBody(), jobTypeId: JT, contactId: CT, locationId: LOC, tagTypeIds: [TAG] });
    expect(r.ok).toBe(true);
    if (r.ok) { expect(r.data.jobTypeId).toBe(JT); expect(r.data.contactId).toBe(CT); expect(r.data.locationId).toBe(LOC); expect(r.data.tagTypeIds).toEqual([TAG]); }
  });
  it("rejects contactId/locationId with an inline customer", () => {
    const body = { ...baseBody(), customerId: undefined, customer: { name: "New Person" }, contactId: CT };
    const r = parse(body);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.message).toMatch(/existing customer/i);
  });
  it("rejects more than 20 tags", () => {
    const r = parse({ ...baseBody(), tagTypeIds: Array.from({ length: 21 }, (_, i) => `66666666-6666-4666-8666-${String(i).padStart(12, "0")}`) });
    expect(r.ok).toBe(false);
  });
});
