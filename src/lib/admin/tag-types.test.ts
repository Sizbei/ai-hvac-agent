import { describe, it, expect } from "vitest";
import { tagTypeInputSchema, tagTypePatchSchema, tagBadgeClass, TAG_COLOR_TOKENS } from "./tag-types";

describe("tagTypeInputSchema", () => {
  it("trims the name and accepts a token colour", () => {
    const r = tagTypeInputSchema.safeParse({ entity: "job", name: " VIP ", color: "danger" });
    expect(r.success).toBe(true);
    if (r.success) expect(r.data.name).toBe("VIP");
  });
  it("rejects a hex colour, an unknown entity, and a patch that changes entity", () => {
    expect(tagTypeInputSchema.safeParse({ entity: "job", name: "VIP", color: "#ff0000" }).success).toBe(false);
    expect(tagTypeInputSchema.safeParse({ entity: "invoice", name: "VIP", color: "marker" }).success).toBe(false);
    expect("entity" in tagTypePatchSchema.shape).toBe(false);
  });
});
describe("tagBadgeClass", () => {
  it("returns a class string for every token", () => {
    for (const c of TAG_COLOR_TOKENS) expect(tagBadgeClass(c)).toMatch(/^bg-/);
  });
});
