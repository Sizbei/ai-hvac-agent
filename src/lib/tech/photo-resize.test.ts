import { describe, it, expect } from "vitest";
import { pickPrepared, qualityFromStorage, resizePlan } from "./photo-resize";

const MB = 1024 * 1024;

describe("resizePlan (spec §7.7)", () => {
  it("standard: 1600/q0.8 → 1600/q0.7 → 1200/q0.7 → 900/q0.7 on the long edge", () => {
    expect(resizePlan("standard", 4032, 3024)).toEqual([
      { width: 1600, height: 1200, jpegQuality: 0.8 },
      { width: 1600, height: 1200, jpegQuality: 0.7 },
      { width: 1200, height: 900, jpegQuality: 0.7 },
      { width: 900, height: 675, jpegQuality: 0.7 },
    ]);
  });
  it("high: 3200/q0.9 → 3200/q0.8 → 2400/q0.7 → 1600/q0.7, portrait too", () => {
    expect(resizePlan("high", 3024, 4032).map((s) => [s.height, s.jpegQuality])).toEqual([[3200, 0.9], [3200, 0.8], [2400, 0.7], [1600, 0.7]]);
  });
  it("never upscales a small image", () => {
    expect(resizePlan("high", 800, 600)[0]).toEqual({ width: 800, height: 600, jpegQuality: 0.9 });
  });
});

describe("pickPrepared", () => {
  it("first step under 4 MB; none → too large; decode failure keeps a small original only", () => {
    expect(pickPrepared([5 * MB, 3 * MB, 1 * MB], 9 * MB)).toEqual({ kind: "step", index: 1 });
    expect(pickPrepared([5 * MB, 5 * MB], 9 * MB)).toEqual({ kind: "too_large" });
    expect(pickPrepared("decode_failed", 3 * MB)).toEqual({ kind: "original" });
    expect(pickPrepared("decode_failed", 5 * MB)).toEqual({ kind: "too_large" });
  });
});

describe("qualityFromStorage", () => {
  it("defaults to standard", () => {
    expect(qualityFromStorage(null)).toBe("standard");
    expect(qualityFromStorage("junk")).toBe("standard");
    expect(qualityFromStorage("high")).toBe("high");
  });
});
