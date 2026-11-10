import { describe, expect, it } from "vitest";
import { parseTourParams } from "./tour-strip";

const p = (q: string) => new URLSearchParams(q);

describe("parseTourParams", () => {
  it("returns null without from=tour", () => {
    expect(parseTourParams(p(""))).toBeNull();
    expect(parseTourParams(p("lesson=requests"))).toBeNull();
  });
  it("returns null for from=setup", () => {
    expect(parseTourParams(p("from=setup&lesson=requests"))).toBeNull();
  });
  it("returns null for an unknown or missing lesson", () => {
    expect(parseTourParams(p("from=tour&lesson=map"))).toBeNull();
    expect(parseTourParams(p("from=tour"))).toBeNull();
    expect(parseTourParams(p("from=tour&lesson="))).toBeNull();
  });
  it("links back to the stop", () => {
    expect(parseTourParams(p("from=tour&lesson=customers"))?.href).toBe(
      "/admin/setup?lesson=customers#learn",
    );
  });
  it("keeps replay=1 on the back link", () => {
    expect(parseTourParams(p("from=tour&lesson=paid&replay=1"))?.href).toBe(
      "/admin/setup?lesson=paid&replay=1#learn",
    );
    expect(parseTourParams(p("from=tour&lesson=paid&replay=0"))?.href).toBe(
      "/admin/setup?lesson=paid#learn",
    );
  });
  it("n matches the lesson order", () => {
    const ns = ["requests", "schedule", "technicians", "customers", "paid"].map(
      (l) => parseTourParams(p(`from=tour&lesson=${l}`))?.n,
    );
    expect(ns).toEqual([1, 2, 3, 4, 5]);
  });
});
