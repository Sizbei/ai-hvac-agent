import { describe, it, expect } from "vitest";
import { withoutRetiredDemoUsers } from "./retired-demo-users";
import { SHOW_ALL, VISIBLE_ONLY } from "./visibility";

const ROWS = [
  { id: "1", email: "chick.s@spearsservices.com" },
  { id: "2", email: "admin@demo-hvac.com" },
  { id: "3", email: " Mike.Johnson@Demo-HVAC.com " },
  { id: "4", email: null },
  { id: "5", email: "x@demo-hvac.com.evil.io" },
] as const;

describe("withoutRetiredDemoUsers", () => {
  it("drops @demo-hvac.com users for an org viewer", () => {
    expect(withoutRetiredDemoUsers(ROWS, VISIBLE_ONLY).map((r) => r.id)).toEqual(["1", "4", "5"]);
  });

  it("keeps everyone for the platform owner (not previewing)", () => {
    expect(withoutRetiredDemoUsers(ROWS, SHOW_ALL).map((r) => r.id)).toEqual(["1", "2", "3", "4", "5"]);
  });

  it("returns a new array and never mutates the input", () => {
    const input = [...ROWS];
    const out = withoutRetiredDemoUsers(input, SHOW_ALL);
    expect(out).not.toBe(input);
    expect(input).toHaveLength(5);
  });

  it("handles an empty list", () => {
    expect(withoutRetiredDemoUsers([], VISIBLE_ONLY)).toEqual([]);
  });

  it("keeps the row's own type (extra fields survive)", () => {
    const [row] = withoutRetiredDemoUsers([{ email: "a@b.com", name: "Dana" }], VISIBLE_ONLY);
    expect(row?.name).toBe("Dana");
  });
});
