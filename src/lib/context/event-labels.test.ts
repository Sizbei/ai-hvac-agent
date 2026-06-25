import { describe, it, expect } from "vitest";
import { renderEventLabel, type CustomerEventView } from "./event-labels";

describe("renderEventLabel", () => {
  it("renders a booked event with jobType + window", () => {
    const e: CustomerEventView = {
      kind: "booking",
      labelKey: "booked",
      jobType: "no_cool",
      window: "afternoon",
      refId: null,
    };
    expect(renderEventLabel(e)).toBe("Booked no_cool (afternoon)");
  });

  it("renders a reassigned event without window", () => {
    const e: CustomerEventView = {
      kind: "status_change",
      labelKey: "reassigned",
      jobType: "no_cool",
      window: null,
      refId: null,
    };
    expect(renderEventLabel(e)).toBe("Job reassigned (no_cool)");
  });

  it("renders an outbound_sent event", () => {
    const e: CustomerEventView = {
      kind: "outbound",
      labelKey: "outbound_sent",
      jobType: null,
      window: null,
      refId: null,
    };
    expect(renderEventLabel(e)).toBe("Outbound message sent");
  });

  it("renders a generic label when labelKey is null", () => {
    const e: CustomerEventView = {
      kind: "note",
      labelKey: null,
      jobType: null,
      window: null,
      refId: null,
    };
    expect(renderEventLabel(e)).toBe("Activity recorded");
  });

  it("renders a generic label for an out-of-union labelKey", () => {
    const e: CustomerEventView = {
      kind: "note",
      // @ts-expect-error out-of-union label exercises the exhaustive default branch
      labelKey: "totally_unknown",
      jobType: null,
      window: null,
      refId: null,
    };
    expect(renderEventLabel(e)).toBe("Activity recorded");
  });
});
