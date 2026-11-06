import { describe, it, expect } from "vitest";
import { doneAction, hitsUsable } from "./add-item-done";

describe("Add item sheet Done (spec §7.1)", () => {
  it("adds the pending picked item first", () => expect(doneAction({ picked: true, canRetry: false, adding: false, locked: false })).toBe("add_then_close"));
  it("just closes with nothing picked or an unknown add pending retry", () => {
    expect(doneAction({ picked: false, canRetry: false, adding: false, locked: false })).toBe("close");
    expect(doneAction({ picked: true, canRetry: true, adding: false, locked: false })).toBe("close");
  });
  it("waits while an add is in flight", () => expect(doneAction({ picked: true, canRetry: false, adding: true, locked: false })).toBe("wait"));
  it("waits while the page is locked instead of dropping the pick", () => {
    expect(doneAction({ picked: true, canRetry: false, adding: false, locked: true })).toBe("wait");
    expect(doneAction({ picked: false, canRetry: false, adding: false, locked: true })).toBe("close");
    expect(doneAction({ picked: true, canRetry: true, adding: false, locked: true })).toBe("close");
  });
});

describe("Add item results belong to the query on screen (final review B P2-3)", () => {
  it("results for an earlier query are not tappable once the query changes", () => {
    expect(hitsUsable("capac", "motor")).toBe(false);
    expect(hitsUsable("capac", "capaci")).toBe(false);
    expect(hitsUsable(null, "motor")).toBe(false);
  });
  it("results for this query are tappable (surrounding spaces ignored)", () => {
    expect(hitsUsable("motor", "motor")).toBe(true);
    expect(hitsUsable("motor", " motor ")).toBe(true);
  });
});
