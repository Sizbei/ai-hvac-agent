import { describe, it, expect } from "vitest";
import { adminPageTitle } from "./admin-title";

describe("adminPageTitle", () => {
  it("joins the page and the org name", () => {
    expect(adminPageTitle("Requests", "Ridgeline Mechanical")).toBe("Requests · Ridgeline Mechanical");
  });
  it("falls back to the product name without an org", () => {
    expect(adminPageTitle("Requests", undefined)).toBe("Requests · Service console");
    expect(adminPageTitle("Requests", "  ")).toBe("Requests · Service console");
  });
  it("uses the brand alone without a page label", () => {
    expect(adminPageTitle("", "Blue Valley Heating")).toBe("Blue Valley Heating");
  });
});
