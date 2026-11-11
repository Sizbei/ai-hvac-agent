import { describe, expect, it } from "vitest";
import { previewBannerLine } from "./preview-banner-copy";

describe("previewBannerLine", () => {
  it("names the target for an active preview", () => {
    expect(
      previewBannerLine({
        status: "active",
        targetUserId: "u",
        targetName: "Chick Spears",
        targetEmail: "t@example.com",
        targetRole: "super_admin",
        exp: 1,
      }),
    ).toBe("Viewing as Chick Spears · read-only");
  });

  it("uses the ruling 9 line when the target is no longer available", () => {
    expect(previewBannerLine({ status: "stale", exp: 1 })).toBe(
      "Viewing as a user who is no longer available · read-only",
    );
  });

  it("falls back to the stale wording for a blank name", () => {
    expect(
      previewBannerLine({ status: "active", targetUserId: "u", targetName: "  ", targetEmail: "t@example.com", targetRole: "admin", exp: 1 }),
    ).toBe("Viewing as a user who is no longer available · read-only");
  });
});
