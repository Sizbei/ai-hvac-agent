import { describe, it, expect } from "vitest";
import { listViewState } from "./list-view-state";

describe("listViewState", () => {
  it("shows the error, not the empty state, when the first load failed", () => {
    expect(listViewState({ loading: false, failed: true, count: 0 })).toBe("error");
  });

  it("shows the empty state only for a successful load with no rows", () => {
    expect(listViewState({ loading: false, failed: false, count: 0 })).toBe("empty");
  });

  it("shows loading until the first load settles", () => {
    expect(listViewState({ loading: true, failed: false, count: 0 })).toBe("loading");
    expect(listViewState({ loading: true, failed: true, count: 0 })).toBe("loading");
  });

  it("keeps rows on screen through a refetch or a failed refetch", () => {
    expect(listViewState({ loading: true, failed: false, count: 3 })).toBe("ready");
    expect(listViewState({ loading: false, failed: true, count: 3 })).toBe("ready");
  });
});
