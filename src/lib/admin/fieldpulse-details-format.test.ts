import { describe, it, expect } from "vitest";
import {
  humanizeKey,
  formatValue,
  buildFieldpulseEntries,
  buildFieldpulseSections,
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

// ─── buildFieldpulseSections ──────────────────────────────────────────────────

describe("buildFieldpulseSections — money formatting", () => {
  it("formats service_price '35354.67' → '$35,354.67'", () => {
    const { sections } = buildFieldpulseSections({ service_price: "35354.67" });
    const money = sections.find((s) => s.title === "Money");
    expect(money).toBeDefined();
    expect(money!.entries[0].value).toBe("$35,354.67");
  });

  it("formats raw float strings with trailing zeros correctly", () => {
    // FP sends strings like "35424.670000" — should be $35,424.67
    const { sections } = buildFieldpulseSections({ total_amount: "35424.670000" });
    const money = sections.find((s) => s.title === "Money");
    expect(money!.entries[0].value).toBe("$35,424.67");
  });

  it("formats numeric money values (number type)", () => {
    const { sections } = buildFieldpulseSections({ subtotal: 100 });
    const money = sections.find((s) => s.title === "Money");
    expect(money!.entries[0].value).toBe("$100.00");
  });

  it("non-numeric money-key strings are NOT formatted as currency", () => {
    const { sections } = buildFieldpulseSections({ cost_code: "ABC-123" });
    const money = sections.find((s) => s.title === "Money");
    // not a numeric value — falls to Other
    expect(money).toBeUndefined();
    const other = sections.find((s) => s.title === "Other");
    expect(other!.entries[0].value).toBe("ABC-123");
  });
});

describe("buildFieldpulseSections — percent formatting", () => {
  it("formats tax_rate '9.75' → '9.75%'", () => {
    // CRITICAL: 'tax_rate' matches both money (tax) AND percent (rate$) — percent wins
    const { sections } = buildFieldpulseSections({ tax_rate: "9.75" });
    // Should be in Other (not Money)
    const money = sections.find((s) => s.title === "Money");
    expect(money).toBeUndefined();
    const other = sections.find((s) => s.title === "Other");
    expect(other!.entries[0].value).toBe("9.75%");
  });

  it("formats discount_percent '10' → '10%'", () => {
    const { sections } = buildFieldpulseSections({ discount_percent: "10" });
    const other = sections.find((s) => s.title === "Other");
    expect(other!.entries[0].value).toBe("10%");
  });
});

describe("buildFieldpulseSections — date formatting", () => {
  it("formats invoiced_date '2026-05-29 12:00:00' → 'May 29, 2026'", () => {
    const { sections } = buildFieldpulseSections({ invoiced_date: "2026-05-29 12:00:00" });
    const dates = sections.find((s) => s.title === "Dates");
    expect(dates).toBeDefined();
    expect(dates!.entries[0].value).toBe("May 29, 2026");
  });

  it("formats _at keys as dates", () => {
    const { sections } = buildFieldpulseSections({ created_at: "2026-01-15T10:00:00Z" });
    const dates = sections.find((s) => s.title === "Dates");
    expect(dates!.entries[0].value).toMatch(/Jan.*2026|2026.*Jan/);
  });
});

describe("buildFieldpulseSections — flags section", () => {
  it("formats qb_originated true → 'Yes' in Flags", () => {
    const { sections } = buildFieldpulseSections({ qb_originated: true });
    const flags = sections.find((s) => s.title === "Flags");
    expect(flags).toBeDefined();
    expect(flags!.entries[0].value).toBe("Yes");
  });

  it("formats boolean false → 'No' in Flags", () => {
    const { sections } = buildFieldpulseSections({ is_active: false });
    const flags = sections.find((s) => s.title === "Flags");
    expect(flags!.entries[0].value).toBe("No");
  });
});

describe("buildFieldpulseSections — IDs section", () => {
  it("puts status_id 1878564 in IDs section", () => {
    const { sections } = buildFieldpulseSections({ status_id: 1878564 });
    const ids = sections.find((s) => s.title === "IDs");
    expect(ids).toBeDefined();
    expect(ids!.entries[0].value).toBe("1878564");
  });

  it("puts *_id keys in IDs section", () => {
    const { sections } = buildFieldpulseSections({ customer_id: "abc123" });
    const ids = sections.find((s) => s.title === "IDs");
    expect(ids!.entries[0].label).toBe("Customer Id");
  });
});

describe("buildFieldpulseSections — nested object flattening", () => {
  it("flattens one level of plain objects with 'Parent · Child' labels", () => {
    const { sections } = buildFieldpulseSections({
      address: { city: "Nashville", state: "TN" },
    });
    const other = sections.find((s) => s.title === "Other");
    expect(other).toBeDefined();
    const labels = other!.entries.map((e) => e.label);
    expect(labels).toContain("Address · City");
    expect(labels).toContain("Address · State");
  });

  it("counts deeper nesting into hiddenCount", () => {
    const { hiddenCount } = buildFieldpulseSections({
      address: { nested: { deep: "value" } },
    });
    expect(hiddenCount).toBeGreaterThan(0);
  });

  it("joins arrays of scalars with ', '", () => {
    const { sections } = buildFieldpulseSections({ tags: ["a", "b", "c"] });
    const other = sections.find((s) => s.title === "Other");
    expect(other!.entries[0].value).toBe("a, b, c");
  });
});

describe("buildFieldpulseSections — section ordering + preview", () => {
  it("returns sections in order: Money, Dates, Flags, IDs, Other (omitting empty)", () => {
    const { sections } = buildFieldpulseSections({
      service_price: "100.00",
      created_at: "2026-01-01",
      is_active: true,
      customer_id: "42",
      notes: "hello",
    });
    const titles = sections.map((s) => s.title);
    // Should appear in this relative order
    const moneyIdx = titles.indexOf("Money");
    const datesIdx = titles.indexOf("Dates");
    const flagsIdx = titles.indexOf("Flags");
    const idsIdx = titles.indexOf("IDs");
    const otherIdx = titles.indexOf("Other");
    expect(moneyIdx).toBeLessThan(datesIdx);
    expect(datesIdx).toBeLessThan(flagsIdx);
    expect(flagsIdx).toBeLessThan(idsIdx);
    expect(idsIdx).toBeLessThan(otherIdx);
  });

  it("preview contains first 3 entries from Money+Dates as 'label: value'", () => {
    const { preview } = buildFieldpulseSections({
      service_price: "100.00",
      tax_amount: "10.00",
      discount_amount: "5.00",
      created_at: "2026-01-01",
    });
    expect(preview).toHaveLength(3);
    preview.forEach((p) => expect(p).toMatch(/^.+: .+$/));
  });

  it("preview has at most 3 entries", () => {
    const { preview } = buildFieldpulseSections({
      service_price: "1.00",
      tax_amount: "2.00",
      cost_total: "3.00",
      discount_amount: "4.00",
      created_at: "2026-01-01",
    });
    expect(preview.length).toBeLessThanOrEqual(3);
  });

  it("returns hiddenCount 0 when no deeply nested fields", () => {
    const { hiddenCount } = buildFieldpulseSections({ notes: "hello" });
    expect(hiddenCount).toBe(0);
  });

  it("entries within a section are sorted alphabetically by label", () => {
    const { sections } = buildFieldpulseSections({
      total_cost: "10.00",
      service_price: "5.00",
    });
    const money = sections.find((s) => s.title === "Money")!;
    const labels = money.entries.map((e) => e.label);
    expect(labels).toEqual([...labels].sort((a, b) => a.localeCompare(b)));
  });

  it("returns empty sections array for null data", () => {
    const result = buildFieldpulseSections(null);
    expect(result.sections).toHaveLength(0);
    expect(result.preview).toHaveLength(0);
    expect(result.hiddenCount).toBe(0);
  });

  it("returns empty sections array for empty object", () => {
    const result = buildFieldpulseSections({});
    expect(result.sections).toHaveLength(0);
  });
});

// Garbage-input robustness: real FP rows carry sentinel strings and
// pre-formatted values. None of these may ever render "$NaN"/"Invalid Date" —
// the safe fallback is the raw string (usually in Other). Review-mandated.
describe("buildFieldpulseSections — garbage-input robustness", () => {
  const sectionOf = (r: ReturnType<typeof buildFieldpulseSections>, title: string) =>
    r.sections.find((s) => s.title === title);
  const entryValue = (r: ReturnType<typeof buildFieldpulseSections>, title: string) =>
    sectionOf(r, title)?.entries[0]?.value;

  it('money key with "N/A" sentinel → raw string in Other, never "$NaN"', () => {
    const r = buildFieldpulseSections({ service_price: "N/A" });
    expect(sectionOf(r, "Money")).toBeUndefined();
    expect(entryValue(r, "Other")).toBe("N/A");
    expect(JSON.stringify(r.sections)).not.toContain("NaN");
  });

  it('money key with comma-formatted "1,234.56" → raw string in Other, never "$NaN"', () => {
    const r = buildFieldpulseSections({ service_price: "1,234.56" });
    expect(sectionOf(r, "Money")).toBeUndefined();
    expect(entryValue(r, "Other")).toBe("1,234.56");
    expect(JSON.stringify(r.sections)).not.toContain("NaN");
  });

  it('date key with unparseable "N/A" → raw string in Dates, never "Invalid Date"', () => {
    const r = buildFieldpulseSections({ invoiced_date: "N/A" });
    expect(entryValue(r, "Dates")).toBe("N/A");
    expect(JSON.stringify(r.sections)).not.toContain("Invalid Date");
  });

  it("percent key with numeric 0 → \"0%\" (zero passes the empty-skip guard)", () => {
    const r = buildFieldpulseSections({ tax_rate: 0 });
    expect(entryValue(r, "Other")).toBe("0%");
  });
});
