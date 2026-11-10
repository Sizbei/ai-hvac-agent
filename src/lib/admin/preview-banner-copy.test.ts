import { describe, expect, it } from "vitest";
import { previewBannerLine } from "./preview-banner-copy";

describe("previewBannerLine", () => {
  it("names the target for an active preview", () => {
    expect(
      previewBannerLine({
        status: "active",
        targetUserId: "u",
        targetName: "Chick Spears",
        targetRole: "super_admin",
      }),
    ).toBe("Viewing as Chick Spears · read-only");
  });

  it("uses the ruling 9 line when the target is no longer available", () => {
    expect(previewBannerLine({ status: "stale" })).toBe(
      "Viewing as a user who is no longer available · read-only",
    );
  });

  it("falls back to the stale wording for a blank name", () => {
    expect(
      previewBannerLine({ status: "active", targetUserId: "u", targetName: "  ", targetRole: "admin" }),
    ).toBe("Viewing as a user who is no longer available · read-only");
  });
});
