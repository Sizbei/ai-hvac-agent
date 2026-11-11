import { describe, it, expect } from "vitest";
import { defaultInvoiceSort, effectiveInvoiceSort } from "./invoice-list-sort";

describe("defaultInvoiceSort", () => {
  it("collections tabs lead with the most overdue", () => {
    expect(defaultInvoiceSort("overdue")).toBe("age-oldest");
    expect(defaultInvoiceSort("unpaid")).toBe("age-oldest");
  });

  it("history tabs lead with the newest invoice", () => {
    expect(defaultInvoiceSort("all")).toBe("newest");
    expect(defaultInvoiceSort("paid")).toBe("newest");
  });
});

describe("effectiveInvoiceSort", () => {
  it("a picked sort wins on every tab", () => {
    expect(effectiveInvoiceSort("all", "balance-high")).toBe("balance-high");
    expect(effectiveInvoiceSort("overdue", "newest")).toBe("newest");
  });

  it("no pick falls back to the tab default", () => {
    expect(effectiveInvoiceSort("paid", null)).toBe("newest");
    expect(effectiveInvoiceSort("overdue", null)).toBe("age-oldest");
  });
});
