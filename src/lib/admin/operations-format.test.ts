import { describe, it, expect } from "vitest";
import {
  bookedSublabel,
  formatDuration,
  countOf,
  responseSublabel,
  timeToPaidSublabel,
  dispatcherSublabel,
  dispatchHealthSublabel,
} from "./operations-format";

const samples = { response: 1, timeToPaid: 0, paidAtVisit: 3, firstResponseHuman: 2 };
const counts = (total: number) => ({
  committed: 0, queuedAmbiguous: 0, queuedNoFit: 0, queuedNeedsReview: 0, total,
});

describe("operations-format", () => {
  it("formats seconds adaptively and null as a dash", () => {
    expect(formatDuration(null)).toBe("—");
    expect(formatDuration(7)).toBe("7 s");
    expect(formatDuration(600)).toBe("10 min");
    expect(formatDuration(3 * 3600)).toBe("3.0 hrs");
    expect(formatDuration(59 * 86400)).toBe("59.0 days");
  });

  it("pluralises counts", () => {
    expect(countOf(1, "request")).toBe("1 request");
    expect(countOf(0, "invoice")).toBe("0 invoices");
  });

  it("response time states the definition and the sample", () => {
    expect(responseSublabel({ onSiteSeconds: null, samples })).toBe(
      "Median from booking to a technician on site · 1 request",
    );
    expect(responseSublabel({ onSiteSeconds: 5400, samples })).toContain("1.5 hrs avg on site");
  });

  it("time to paid names the invoices paid at the visit", () => {
    expect(timeToPaidSublabel({ samples })).toBe(
      "Median from invoice to final payment · 0 invoices · 3 paid at the visit, not counted · your invoices only, not FieldPulse/HCP",
    );
    expect(timeToPaidSublabel({ samples: { ...samples, paidAtVisit: 0 } })).not.toContain("visit");
  });

  it("dispatcher leaves auto-dispatch out when it never ran", () => {
    expect(dispatcherSublabel({ samples, firstResponseSystemSeconds: null })).toBe(
      "Median wait for a dispatcher to assign a new request · 2 requests",
    );
    expect(dispatcherSublabel({ samples, firstResponseSystemSeconds: 20 })).toContain(
      "auto-dispatch assigns in 20 s on average",
    );
  });

  it("dispatch health uses owner words", () => {
    const text = dispatchHealthSublabel({ real: counts(4), shadow: counts(0), overrides: 1 });
    expect(text).toBe(
      "Share of autopilot decisions that assigned a technician, last 7 days · 4 decisions · 1 changed by a dispatcher",
    );
    expect(text).not.toMatch(/commit|preview|override/i);
    expect(dispatchHealthSublabel({ real: counts(1), shadow: counts(2), overrides: 0 })).toContain(
      "3 decisions · 2 suggested only",
    );
  });
});

describe("bookedSublabel", () => {
  it("a slow rate reads per week instead of 0.0 a day", () => {
    expect(bookedSublabel(18, 365, 207)).toBe("Booked here · 0.3 / week avg · +207 imported");
  });
  it("a busy rate stays per day", () => {
    expect(bookedSublabel(45, 30, 0)).toBe("Booked here · 1.5 / day avg");
  });
  it("none booked reads 0.0 a day", () => {
    expect(bookedSublabel(0, 30, 0)).toBe("Booked here · 0.0 / day avg");
  });
});
