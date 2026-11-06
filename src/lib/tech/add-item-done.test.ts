import { describe, it, expect } from "vitest";
import { doneAction } from "./add-item-done";

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
