import { describe, it, expect } from "vitest";
import { rateKeyFor, techPreviewBanner } from "./tech-preview";

const TECH = "77777777-7777-4777-8777-777777777777";
const ADMIN = "66666666-6666-4666-8666-666666666666";
const real = { userId: TECH, organizationId: "o", email: "t@x", name: "Tess Tech", role: "technician" as const };
const preview = { ...real, preview: { adminUserId: ADMIN, exp: 1_900_000_000 } };

describe("rateKeyFor", () => {
  it("a real technician is limited by their own id", () => {
    expect(rateKeyFor(real)).toBe(TECH);
  });
  it("a preview is limited by the platform admin's id, never the technician's", () => {
    expect(rateKeyFor(preview)).toBe(ADMIN);
  });
});

describe("techPreviewBanner", () => {
  it("null for a real technician", () => {
    expect(techPreviewBanner(real)).toBeNull();
  });
  it("the banner line, target and expiry while previewing", () => {
    expect(techPreviewBanner(preview)).toEqual({
      line: "Viewing as Tess Tech · read-only",
      targetUserId: TECH,
      exp: 1_900_000_000,
    });
  });
  it("a blank name reads as the unavailable-user line", () => {
    expect(techPreviewBanner({ ...preview, name: "  " })?.line).toBe(
      "Viewing as a user who is no longer available · read-only",
    );
  });
});
