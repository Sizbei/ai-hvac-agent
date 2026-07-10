import { describe, it, expect } from "vitest";
import {
  humanizeKey,
  formatValue,
  buildFieldpulseEntries,
} from "./fieldpulse-details-format";

describe("humanizeKey", () => {
  it("converts snake_case to Title Case", () => {
    expect(humanizeKey("due_date")).toBe("Due Date");
    expect(humanizeKey("is_tax_exempt")).toBe("Is Tax Exempt");
    expect(humanizeKey("account_type")).toBe("Account Type");
  });

  it("handles single words", () => {
    expect(humanizeKey("status")).toBe("Status");
  });

  it("handles already-capitalised words untouched (only first char forced)", () => {
    expect(humanizeKey("qbo_id")).toBe("Qbo Id");
  });
});

describe("formatValue", () => {
  it("formats booleans as Yes/No", () => {
    expect(formatValue(true)).toBe("Yes");
    expect(formatValue(false)).toBe("No");
  });

  it("formats ISO date strings as readable dates", () => {
    // We only test the pattern recognition, not locale output (locale varies)
    const result = formatValue("2025-03-15T10:00:00Z");
    expect(result).toMatch(/2025/);
    expect(result).toMatch(/Mar|3/);
  });

  it("returns non-date strings as-is", () => {
    expect(formatValue("residential")).toBe("residential");
    expect(formatValue("active")).toBe("active");
  });

  it("formats numbers as strings", () => {
    expect(formatValue(42)).toBe("42");
    expect(formatValue(0)).toBe("0");
  });

  it("formats arrays as CSV", () => {
    expect(formatValue(["a", "b", "c"])).toBe("a, b, c");
    expect(formatValue([])).toBe("");
  });

  it("coerces unknown types via String()", () => {
    expect(formatValue(null)).toBe("null");
  });

  it("does not parse malformed date-like strings as dates", () => {
    // Not a real date
    expect(formatValue("2025-99-99")).toBe("2025-99-99");
  });
});

describe("buildFieldpulseEntries", () => {
  it("returns null for null input", () => {
    expect(buildFieldpulseEntries(null)).toBeNull();
  });

  it("returns null for undefined input", () => {
    expect(buildFieldpulseEntries(undefined)).toBeNull();
  });

  it("returns null for empty object", () => {
    expect(buildFieldpulseEntries({})).toBeNull();
  });

  it("returns null when all values are empty/null", () => {
    expect(buildFieldpulseEntries({ a: null, b: "", c: [] })).toBeNull();
  });

  it("skips null/undefined/empty-string/empty-array values", () => {
    const result = buildFieldpulseEntries({
      good: "kept",
      bad_null: null,
      bad_empty: "",
      bad_arr: [],
      bad_undef: undefined,
    });
    expect(result).toHaveLength(1);
    expect(result![0].label).toBe("Good");
    expect(result![0].value).toBe("kept");
  });

  it("skips plain object values", () => {
    const result = buildFieldpulseEntries({
      nested: { foo: "bar" },
      flat: "kept",
    });
    expect(result).toHaveLength(1);
    expect(result![0].label).toBe("Flat");
  });

  it("sorts entries alphabetically by label", () => {
    const result = buildFieldpulseEntries({
      zebra: "z",
      apple: "a",
      mango: "m",
    });
    expect(result!.map((e) => e.label)).toEqual(["Apple", "Mango", "Zebra"]);
  });

  it("formats boolean values as Yes/No", () => {
    const result = buildFieldpulseEntries({ is_active: true });
    expect(result![0].value).toBe("Yes");
  });

  it("formats array values as CSV", () => {
    const result = buildFieldpulseEntries({ tags: ["urgent", "callback"] });
    expect(result![0].value).toBe("urgent, callback");
  });

  it("humanizes snake_case keys", () => {
    const result = buildFieldpulseEntries({ booking_portal_consent: "yes" });
    expect(result![0].label).toBe("Booking Portal Consent");
  });
});
