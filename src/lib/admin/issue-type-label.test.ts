import { describe, it, expect } from "vitest";
import { issueTypeLabel, humanizeCode, groupIssueTypes } from "./issue-type-label";

describe("issueTypeLabel", () => {
  it("uses the office label for known types", () => {
    expect(issueTypeLabel("cooling_not_working")).toBe("Cooling not working");
    expect(issueTypeLabel("refrigeration")).toBe("Refrigeration");
  });
  it("humanizes unknown codes instead of showing them raw", () => {
    expect(issueTypeLabel("duct_cleaning")).toBe("Duct cleaning");
  });
  it("does not treat prototype keys as known", () => {
    expect(issueTypeLabel("constructor")).toBe("Constructor");
  });
});

describe("humanizeCode", () => {
  it("is sentence case, not Title Case", () => {
    expect(humanizeCode("HEATING_NOT_WORKING")).toBe("Heating not working");
    expect(humanizeCode("")).toBe("");
  });
});

describe("groupIssueTypes", () => {
  it("keeps the top N known types, folds the rest into Other and leaves imported free text out", () => {
    const rows = [
      { key: "heating_not_working", count: 50 },
      { key: "cooling_not_working", count: 40 },
      { key: "maintenance", count: 5 },
      { key: "other", count: 2 },
      { key: "Job for Arby's Elizabethton", count: 1 },
      { key: "ESTIMATE for roof unit", count: 1 },
    ];
    const { bars, importedTitles } = groupIssueTypes(rows, 2);
    expect(bars).toEqual([
      { key: "heating_not_working", label: "Heating not working", count: 50 },
      { key: "cooling_not_working", label: "Cooling not working", count: 40 },
      { key: "other", label: "Other", count: 7 },
    ]);
    expect(importedTitles).toBe(2);
  });
  it("never lets imported titles make an Other bar on their own", () => {
    const { bars, importedTitles } = groupIssueTypes([
      { key: "water_leak", count: 3 },
      { key: "Job for Arby's Elizabethton", count: 209 },
    ]);
    expect(bars).toEqual([{ key: "water_leak", label: "Water leak", count: 3 }]);
    expect(importedTitles).toBe(209);
  });
  it("has no Other bar when nothing is folded", () => {
    expect(groupIssueTypes([{ key: "water_leak", count: 3 }]).bars).toEqual([
      { key: "water_leak", label: "Water leak", count: 3 },
    ]);
  });
});
