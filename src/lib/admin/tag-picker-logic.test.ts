import { describe, it, expect } from "vitest";
import { nextTagIds, isStaleResponse, isPickerReady } from "./tag-picker-logic";

describe("nextTagIds", () => {
  it("keeps unresolved ids when toggling another one", () => {
    expect(nextTagIds(["unresolved", "b"], "c")).toEqual(["unresolved", "b", "c"]);
    expect(nextTagIds(["unresolved", "b"], "b")).toEqual(["unresolved"]);
  });
  it("adding twice yields one entry", () => {
    const once = nextTagIds([], "a");
    expect(nextTagIds(once, "a")).toEqual([]);
    expect(nextTagIds(["a", "a"].slice(0, 1), "b")).toEqual(["a", "b"]);
  });
  it("de-dupes a pre-duplicated list on add", () => {
    expect(nextTagIds(["a", "a"], "b")).toEqual(["a", "b"]);
  });
  it("does not mutate the input", () => {
    const cur = ["a"] as const;
    nextTagIds(cur, "b");
    expect(cur).toEqual(["a"]);
  });
});

describe("isStaleResponse", () => {
  it("is stale only when a newer sequence exists", () => {
    expect(isStaleResponse(1, 2)).toBe(true);
    expect(isStaleResponse(2, 2)).toBe(false);
  });
});

describe("isPickerReady", () => {
  it("controlled pickers are always ready", () => {
    expect(isPickerReady(false, false, false)).toBe(true);
  });
  it("bound pickers wait for initial tags or a finished load", () => {
    expect(isPickerReady(true, false, false)).toBe(false);
    expect(isPickerReady(true, true, false)).toBe(true);
    expect(isPickerReady(true, false, true)).toBe(true);
  });
});
