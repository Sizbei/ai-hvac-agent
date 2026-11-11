import { describe, it, expect } from "vitest";
import {
  DEFAULT_FEATURES,
  MALFORMED_HISTORY_CUTOFF_ISO,
  featurePatchSchema,
  historyCutoff,
  parseFeatures,
} from "./feature-flags";

describe("parseFeatures", () => {
  it("returns the defaults for null, undefined and non-objects", () => {
    expect(parseFeatures(null)).toEqual(DEFAULT_FEATURES);
    expect(parseFeatures(undefined)).toEqual(DEFAULT_FEATURES);
    expect(parseFeatures("x")).toEqual(DEFAULT_FEATURES);
    expect(parseFeatures([true])).toEqual(DEFAULT_FEATURES);
  });

  it("returns the defaults for an empty object", () => {
    expect(parseFeatures({})).toEqual(DEFAULT_FEATURES);
  });

  it("ignores unknown keys and non-boolean values", () => {
    expect(parseFeatures({ map: true, junk: 1, payLinks: "no" })).toEqual({
      ...DEFAULT_FEATURES,
      map: true,
    });
  });

  it("honours explicit false for default-true keys", () => {
    expect(parseFeatures({ reviewRequests: false, payLinks: false })).toEqual({
      ...DEFAULT_FEATURES,
      reviewRequests: false,
      payLinks: false,
    });
  });

  it("has the documented defaults", () => {
    expect(DEFAULT_FEATURES).toEqual({
      map: false,
      reviewRequests: true,
      payLinks: true,
      showHistory: false,
    });
  });
});

describe("featurePatchSchema", () => {
  it("rejects an empty patch", () => {
    expect(featurePatchSchema.safeParse({}).success).toBe(false);
  });
  it("rejects unknown keys", () => {
    expect(featurePatchSchema.safeParse({ map: true, extra: true }).success).toBe(false);
  });
  it("rejects non-boolean values", () => {
    expect(featurePatchSchema.safeParse({ map: "yes" }).success).toBe(false);
  });
  it("accepts one or more boolean keys", () => {
    expect(featurePatchSchema.safeParse({ showHistory: true }).success).toBe(true);
    expect(featurePatchSchema.safeParse({ map: false, payLinks: true }).success).toBe(true);
  });
});

describe("historyCutoff", () => {
  it("is null when there are no flags (null, undefined) or the key is missing", () => {
    expect(historyCutoff(null)).toBeNull();
    expect(historyCutoff(undefined)).toBeNull();
    expect(historyCutoff({ showHistory: true })).toBeNull();
  });

  it("fails closed when feature_flags itself is not an object", () => {
    for (const bad of ["2026-11-10T12:00:00.000Z", ["2026-11-10T12:00:00.000Z"], 42, true]) {
      expect(historyCutoff(bad)?.toISOString(), JSON.stringify(bad)).toBe(MALFORMED_HISTORY_CUTOFF_ISO);
    }
  });

  it("is null for an explicit null (no cutoff)", () => {
    expect(historyCutoff({ historyCutoff: null })).toBeNull();
  });

  it("fails closed on a present but malformed value: a cutoff after every entry", () => {
    for (const bad of [1_762_776_000_000, true, "", "not a date", {}, ["2026-11-10T12:00:00.000Z"]]) {
      const at = historyCutoff({ historyCutoff: bad });
      expect(at?.toISOString(), JSON.stringify(bad)).toBe(MALFORMED_HISTORY_CUTOFF_ISO);
    }
    expect(MALFORMED_HISTORY_CUTOFF_ISO).toBe("9999-12-31T23:59:59.999Z");
  });

  it("returns a fresh Date each time, so a caller can't move the fail-closed cutoff", () => {
    const first = historyCutoff({ historyCutoff: "nope" })!;
    first.setTime(0);
    expect(historyCutoff({ historyCutoff: "nope" })?.toISOString()).toBe(MALFORMED_HISTORY_CUTOFF_ISO);
  });

  it("reads an ISO timestamp", () => {
    expect(historyCutoff({ historyCutoff: "2026-11-10T12:00:00.000Z", map: true })?.toISOString()).toBe(
      "2026-11-10T12:00:00.000Z",
    );
  });

  it("leaves parseFeatures boolean-only", () => {
    expect(parseFeatures({ historyCutoff: "2026-11-10T12:00:00.000Z" })).toEqual(DEFAULT_FEATURES);
  });
});
