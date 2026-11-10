import { describe, it, expect } from "vitest";
import { DEFAULT_FEATURES } from "@/lib/tenancy/feature-flags";
import { initialSwitchRow, saveFailed, saveSucceeded, startSave } from "./platform-switch-state";

const base = initialSwitchRow(DEFAULT_FEATURES);

describe("platform switch row state", () => {
  it("starts unlocked", () => {
    expect(base.pending).toBe(false);
  });

  it("startSave flips the key optimistically and locks the whole row", () => {
    const s = startSave(base, "map", true);
    expect(s.features.map).toBe(true);
    expect(s.pending).toBe(true);
    expect(base.features.map).toBe(false); // input not mutated
  });

  it("a second change while pending is ignored", () => {
    const first = startSave(base, "map", true);
    expect(startSave(first, "payLinks", false)).toBe(first);
  });

  it("a failure reverts only the failed key and unlocks", () => {
    const s = saveFailed({ features: { ...DEFAULT_FEATURES, map: true, showHistory: true }, pending: true }, "map", false);
    expect(s.features).toEqual({ ...DEFAULT_FEATURES, map: false, showHistory: true });
    expect(s.pending).toBe(false);
  });

  it("a success applies the server features and unlocks", () => {
    const server = { ...DEFAULT_FEATURES, map: true, payLinks: false };
    expect(saveSucceeded(server)).toEqual({ features: server, pending: false });
  });
});
