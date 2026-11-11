import { describe, expect, it } from "vitest";
import {
  REVIEW_TEXTS_OFF,
  reviewTextsOnFrom,
  reviewsEmptyDescription,
  reviewsSubtitle,
  historyContactFrom,
  templateStatus,
} from "./review-switch-copy";

describe("reviewTextsOnFrom", () => {
  it("is false only for an explicit false in the success envelope", () => {
    expect(reviewTextsOnFrom({ success: true, data: { reviewTextsOn: false } })).toBe(false);
    expect(reviewTextsOnFrom({ success: true, data: { reviewTextsOn: true } })).toBe(true);
  });

  it("keeps the old copy (true) for a missing key, an error envelope or junk", () => {
    expect(reviewTextsOnFrom({ success: true, data: {} })).toBe(true);
    expect(reviewTextsOnFrom({ success: true, data: { reviewTextsOn: "false" } })).toBe(true);
    expect(reviewTextsOnFrom({ success: false, error: { code: "X" } })).toBe(true);
    expect(reviewTextsOnFrom(null)).toBe(true);
    expect(reviewTextsOnFrom("x")).toBe(true);
  });
});

describe("reviewsEmptyDescription", () => {
  it("explains automatic sends when review texts are on", () => {
    expect(reviewsEmptyDescription(true)).toBe(
      "Review texts are sent automatically when a request is completed.",
    );
  });

  it("says review texts are off when the switch is off", () => {
    expect(REVIEW_TEXTS_OFF).toBe("Review texts are off for this account.");
    expect(reviewsEmptyDescription(false)).toBe(REVIEW_TEXTS_OFF);
  });
});

describe("reviewsSubtitle", () => {
  it("describes the page in review-texts words when the switch is on", () => {
    expect(reviewsSubtitle(true, "Raymond Chen")).toBe(
      "Review texts sent after completed requests, average rating and response rate.",
    );
  });

  it("says they are off and who can turn them on when the switch is off", () => {
    expect(reviewsSubtitle(false, "Raymond Chen")).toBe(
      "Review texts are off for this account. Ask Raymond Chen to turn them on.",
    );
    expect(reviewsSubtitle(false, null)).toBe(
      "Review texts are off for this account. Ask your account administrator to turn them on.",
    );
  });
});

describe("historyContactFrom", () => {
  it("reads data.historyContact from a success envelope, else null", () => {
    expect(historyContactFrom({ success: true, data: { historyContact: "Raymond Chen" } })).toBe("Raymond Chen");
    expect(historyContactFrom({ success: true, data: { historyContact: null } })).toBeNull();
    expect(historyContactFrom({ success: true, data: {} })).toBeNull();
    expect(historyContactFrom({ success: false })).toBeNull();
    expect(historyContactFrom(null)).toBeNull();
  });
});

describe("templateStatus", () => {
  const review = { triggerType: "review_request", isActive: true };
  const confirm = { triggerType: "appointment_scheduled", isActive: true };

  it("is Active / Inactive from isActive while review texts are on", () => {
    expect(templateStatus(review, true)).toEqual({ label: "Active", active: true });
    expect(templateStatus({ ...review, isActive: false }, true)).toEqual({ label: "Inactive", active: false });
  });

  it("never says Active on a review-request template when the switch is off", () => {
    expect(templateStatus(review, false)).toEqual({ label: "Off for this account", active: false });
    expect(templateStatus({ ...review, isActive: false }, false)).toEqual({
      label: "Off for this account",
      active: false,
    });
  });

  it("leaves other triggers alone when the switch is off", () => {
    expect(templateStatus(confirm, false)).toEqual({ label: "Active", active: true });
    expect(templateStatus({ ...confirm, isActive: false }, false)).toEqual({ label: "Inactive", active: false });
  });
});
