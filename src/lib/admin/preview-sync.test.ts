import { describe, expect, it } from "vitest";
import {
  parsePreviewStatus,
  previewExpiryDelayMs,
  previewStatusDiffers,
  shownPreview,
} from "./preview-sync";

const NOW_MS = 1_800_000_000_000;
const NOW_S = NOW_MS / 1000;

describe("previewExpiryDelayMs", () => {
  it("null when not previewing", () => {
    expect(previewExpiryDelayMs(null, NOW_MS)).toBeNull();
  });

  it("fires one second after exp, so the server already sees it expired", () => {
    expect(previewExpiryDelayMs(NOW_S + 60, NOW_MS)).toBe(61_000);
  });

  it("an exp already in the past reloads almost at once", () => {
    expect(previewExpiryDelayMs(NOW_S - 30, NOW_MS)).toBe(1_000);
  });
});

describe("shownPreview", () => {
  it("not previewing", () => {
    expect(shownPreview(null)).toEqual({ previewing: false, targetUserId: null });
  });
  it("active → its target", () => {
    expect(
      shownPreview({ status: "active", targetUserId: "t1", targetName: "A", targetRole: "admin", exp: 1 }),
    ).toEqual({ previewing: true, targetUserId: "t1" });
  });
  it("stale → previewing with no target", () => {
    expect(shownPreview({ status: "stale", exp: 1 })).toEqual({ previewing: true, targetUserId: null });
  });
});

describe("previewStatusDiffers", () => {
  const off = { previewing: false, targetUserId: null };
  const onT1 = { previewing: true, targetUserId: "t1" };

  it("same state → no reload", () => {
    expect(previewStatusDiffers(off, off)).toBe(false);
    expect(previewStatusDiffers(onT1, { ...onT1 })).toBe(false);
  });
  it("another tab exited (or the cookie expired) → reload", () => {
    expect(previewStatusDiffers(onT1, off)).toBe(true);
  });
  it("another tab started a preview → reload", () => {
    expect(previewStatusDiffers(off, onT1)).toBe(true);
  });
  it("another tab switched target → reload", () => {
    expect(previewStatusDiffers(onT1, { previewing: true, targetUserId: "t2" })).toBe(true);
  });
  it("the target went stale → reload (banner copy changes)", () => {
    expect(previewStatusDiffers(onT1, { previewing: true, targetUserId: null })).toBe(true);
  });
  it("an unreadable status never reloads", () => {
    expect(previewStatusDiffers(onT1, null)).toBe(false);
  });
});

describe("parsePreviewStatus", () => {
  it("reads the success envelope", () => {
    expect(
      parsePreviewStatus({ success: true, data: { previewing: true, targetUserId: "t1" } }),
    ).toEqual({ previewing: true, targetUserId: "t1" });
    expect(
      parsePreviewStatus({ success: true, data: { previewing: false, targetUserId: null } }),
    ).toEqual({ previewing: false, targetUserId: null });
  });
  it.each([
    ["null", null],
    ["error envelope", { success: false, error: { code: "RATE_LIMITED" } }],
    ["missing data", { success: true }],
    ["non-boolean previewing", { success: true, data: { previewing: "yes", targetUserId: null } }],
    ["numeric target", { success: true, data: { previewing: true, targetUserId: 5 } }],
  ])("null for %s", (_n, json) => {
    expect(parsePreviewStatus(json)).toBeNull();
  });
});
