import { describe, it, expect } from "vitest";
import { DEFAULT_FEATURES, featurePatchSchema, historyCutoff, parseFeatures } from "./feature-flags";

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
  it("is null for null, non-objects, arrays and a missing key", () => {
    expect(historyCutoff(null)).toBeNull();
    expect(historyCutoff(undefined)).toBeNull();
    expect(historyCutoff("2026-11-10T12:00:00.000Z")).toBeNull();
    expect(historyCutoff(["2026-11-10T12:00:00.000Z"])).toBeNull();
    expect(historyCutoff({ showHistory: true })).toBeNull();
  });

  it("is null for a non-string or unparseable value", () => {
    expect(historyCutoff({ historyCutoff: 1_762_776_000_000 })).toBeNull();
    expect(historyCutoff({ historyCutoff: true })).toBeNull();
    expect(historyCutoff({ historyCutoff: "" })).toBeNull();
    expect(historyCutoff({ historyCutoff: "not a date" })).toBeNull();
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
