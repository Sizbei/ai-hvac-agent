import { describe, it, expect } from "vitest";
import {
  esc,
  arRadius,
  formatCents,
  formatWindow,
  jobColor,
  arColor,
  notPlottedChipMessage,
} from "./map-pins";

describe("esc", () => {
  it("escapes all 5 XSS-relevant chars", () => {
    expect(esc("&")).toBe("&amp;");
    expect(esc("<")).toBe("&lt;");
    expect(esc(">")).toBe("&gt;");
    expect(esc('"')).toBe("&quot;");
    expect(esc("'")).toBe("&#39;");
  });

  it("leaves safe text unchanged", () => {
    expect(esc("Jane Doe")).toBe("Jane Doe");
    expect(esc("123 Main St, Apt 4")).toBe("123 Main St, Apt 4");
    expect(esc("")).toBe("");
  });

  it("neutralizes a tag-injection payload", () => {
    const input = '<img src=x onerror="alert(1)">';
    const out = esc(input);
    expect(out).not.toContain("<img");
    expect(out).toBe("&lt;img src=x onerror=&quot;alert(1)&quot;&gt;");
  });

  it("neutralizes an attribute-breaking payload (quote escape out of a value)", () => {
    // A customer name like `" onmouseover="alert(1)` must not be able to
    // close the surrounding HTML attribute it's interpolated into.
    const input = '" onmouseover="alert(1)';
    const out = esc(input);
    expect(out).not.toContain('"');
    expect(out).toBe("&quot; onmouseover=&quot;alert(1)");
  });

  it("neutralizes a script-tag close/reopen payload", () => {
    const input = "</script><script>alert(1)</script>";
    const out = esc(input);
    expect(out).not.toContain("<script");
    expect(out).not.toContain("</script>");
  });

  it("handles mixed single/double quotes used to break out of either attribute style", () => {
    const input = `'-alert(1)-'"`;
    const out = esc(input);
    expect(out).toBe("&#39;-alert(1)-&#39;&quot;");
  });
});

describe("arRadius", () => {
  it("clamps small balances to the 10px floor", () => {
    expect(arRadius(0)).toBe(10);
    expect(arRadius(100)).toBe(10);
  });

  it("clamps large balances to the 34px ceiling", () => {
    expect(arRadius(100_000_00)).toBe(34);
    expect(arRadius(1_000_000_00)).toBe(34);
  });

  it("scales sqrt in between", () => {
    // $10k → sqrt(100) = 10 → *3.4 = 34, clamped to 34 (matches the
    // module's own worked example in a comment).
    expect(arRadius(10_000_00)).toBe(34);
    // A mid-size balance should land strictly between the floor and ceiling.
    const r = arRadius(1_000_00);
    expect(r).toBeGreaterThan(10);
    expect(r).toBeLessThan(34);
  });
});

describe("formatCents", () => {
  it("renders whole-dollar USD with no cents", () => {
    expect(formatCents(123456)).toBe("$1,235");
    expect(formatCents(100)).toBe("$1");
    expect(formatCents(0)).toBe("$0");
  });
});

describe("formatWindow", () => {
  it("returns 'Unscheduled' for null", () => {
    expect(formatWindow(null)).toBe("Unscheduled");
  });

  it("returns 'Unscheduled' for an invalid ISO string", () => {
    expect(formatWindow("not-a-date")).toBe("Unscheduled");
  });

  it("formats a valid ISO string as a day + 2-hour window", () => {
    const out = formatWindow("2026-08-14T12:00:00.000Z");
    expect(out).not.toBe("Unscheduled");
    expect(out).toContain("Aug");
    expect(out).toMatch(/\d{1,2}(am|pm)–\d{1,2}(am|pm)/);
  });
});

describe("jobColor", () => {
  it("maps each urgency band to its color", () => {
    expect(jobColor("emergency")).toBe("#dc2626");
    expect(jobColor("high")).toBe("#ea580c");
    expect(jobColor("low")).toBe("#0891b2");
    expect(jobColor("standard")).toBe("#2563eb");
    expect(jobColor("anything-else")).toBe("#2563eb");
  });
});

describe("arColor", () => {
  it("maps each age band to its fill/ring color", () => {
    expect(arColor(91)).toEqual({ fill: "rgba(220,38,38,0.22)", ring: "#dc2626" });
    expect(arColor(31)).toEqual({ fill: "rgba(234,88,12,0.22)", ring: "#ea580c" });
    expect(arColor(30)).toEqual({ fill: "rgba(217,119,6,0.22)", ring: "#d97706" });
    expect(arColor(0)).toEqual({ fill: "rgba(217,119,6,0.22)", ring: "#d97706" });
  });
});

describe("notPlottedChipMessage", () => {
  it("returns null when nothing was dropped (no chip)", () => {
    expect(notPlottedChipMessage(0, false)).toBeNull();
    expect(notPlottedChipMessage(0, true)).toBeNull();
  });

  it("returns a singular-noun message for exactly one dropped job, under the cap", () => {
    expect(notPlottedChipMessage(1, false)).toBe(
      "1 job couldn't be placed on the map",
    );
  });

  it("returns a plural-noun message for multiple dropped jobs, under the cap", () => {
    expect(notPlottedChipMessage(3, false)).toBe(
      "3 jobs couldn't be placed on the map",
    );
  });

  it("returns a distinct message when the live-geocode cap was exceeded", () => {
    const msg = notPlottedChipMessage(30, true);
    expect(msg).toBe(
      "30 jobs couldn't be placed on the map (25-job geocoding limit reached)",
    );
    expect(msg).not.toBe(notPlottedChipMessage(30, false));
  });
});
