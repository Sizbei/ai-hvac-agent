import { describe, it, expect } from "vitest";
import { auditFindings, MIN_TAP_PX } from "./mobile-audit";

const base = { scrollWidth: 390, viewport: 390, targets: [] };

describe("auditFindings", () => {
  it("returns nothing for a page that fits with big targets", () => {
    expect(
      auditFindings({ ...base, targets: [{ selector: "a.x", w: 120, h: 44 }] }),
    ).toEqual([]);
  });

  it("flags horizontal overflow by the number of pixels", () => {
    const f = auditFindings({ ...base, scrollWidth: 415 });
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ kind: "overflow", detail: "25px wider than the 390px viewport" });
  });

  it("flags a target under 44 in either dimension", () => {
    const f = auditFindings({
      ...base,
      targets: [
        { selector: "button.a", w: 32, h: 44 },
        { selector: "button.b", w: 44, h: 43.4 },
        { selector: "button.c", w: 44, h: 44 },
      ],
    });
    expect(f.map((x) => x.selector)).toEqual(["button.a", "button.b"]);
    expect(f[0].kind).toBe("tap-target");
    expect(f[0].detail).toBe(`32×44 is under ${MIN_TAP_PX}×${MIN_TAP_PX}`);
  });

  it("tolerates sub-pixel rounding at 44", () => {
    expect(auditFindings({ ...base, targets: [{ selector: "a", w: 43.6, h: 43.6 }] })).toEqual([]);
  });

  it("reports overflow before tap targets", () => {
    const f = auditFindings({
      scrollWidth: 400,
      viewport: 390,
      targets: [{ selector: "a", w: 10, h: 10 }],
    });
    expect(f.map((x) => x.kind)).toEqual(["overflow", "tap-target"]);
  });
});
