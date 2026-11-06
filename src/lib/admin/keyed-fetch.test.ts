import { describe, it, expect } from "vitest";
import { fetchGate, responseApplies } from "./keyed-fetch";

describe("list fetch keyed by its params (Task 7 parked: ?bucket= deep links)", () => {
  it("a deep link's bucket fetches even while the default bucket's first fetch is in flight", () => {
    expect(fetchGate({ inFlightKey: "estimates:1:50:::::", key: "estimates:1:50:won::::", bust: false })).toBe("fetch");
  });
  it("the same key in flight is not fetched twice (StrictMode double mount); a bust always fetches", () => {
    expect(fetchGate({ inFlightKey: "k", key: "k", bust: false })).toBe("skip");
    expect(fetchGate({ inFlightKey: "k", key: "k", bust: true })).toBe("fetch");
    expect(fetchGate({ inFlightKey: null, key: "k", bust: false })).toBe("fetch");
  });
  it("a late answer for the default bucket never replaces the chosen bucket's rows", () => {
    expect(responseApplies("open-key", "won-key")).toBe(false);
    expect(responseApplies("won-key", "won-key")).toBe(true);
  });
});
