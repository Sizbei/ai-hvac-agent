import { describe, it, expect } from "vitest";
import { STEP_IDS, cardHiddenFor, parseGuideState, FINISHED_CARD_MS } from "./guide-state";

const NOW = new Date("2026-11-05T12:00:00.000Z");

describe("parseGuideState", () => {
  it("never throws and drops bad values", () => {
    expect(parseGuideState(null)).toEqual({ firstCompleted: {} });
    expect(parseGuideState([])).toEqual({ firstCompleted: {} });
    expect(parseGuideState({ firstCompleted: "x" })).toEqual({ firstCompleted: {} });
    expect(parseGuideState({ hiddenAt: "nope", firstCompleted: { start_job: 5, finish_job: "2026-11-01T00:00:00.000Z", unknown: "2026-11-01T00:00:00.000Z" } }))
      .toEqual({ firstCompleted: { finish_job: "2026-11-01T00:00:00.000Z" } });
  });
  it("keeps a valid hiddenAt", () => {
    expect(parseGuideState({ hiddenAt: "2026-11-01T00:00:00.000Z" }).hiddenAt).toBe("2026-11-01T00:00:00.000Z");
  });
  it("lists the nine step ids in order", () => {
    expect(STEP_IDS).toEqual(["start_job", "finish_job", "clock_in", "share_location", "add_material", "note_or_photo", "capture_signature", "build_invoice", "collect_payment"]);
  });
});

describe("cardHiddenFor", () => {
  const at = (hoursAgo: number) => new Date(NOW.getTime() - hoursAgo * 3_600_000).toISOString();
  it("hidden when hiddenAt is set", () => {
    expect(cardHiddenFor({ hiddenAt: at(1), firstCompleted: {} }, NOW)).toBe(true);
  });
  it("hidden once the finish stamp is older than 24 hours", () => {
    expect(FINISHED_CARD_MS).toBe(24 * 60 * 60 * 1000);
    expect(cardHiddenFor({ firstCompleted: { finish_job: at(23) } }, NOW)).toBe(false);
    expect(cardHiddenFor({ firstCompleted: { finish_job: at(25) } }, NOW)).toBe(true);
  });
  it("not hidden without a stamp", () => {
    expect(cardHiddenFor({ firstCompleted: { start_job: at(48) } }, NOW)).toBe(false);
  });
});
