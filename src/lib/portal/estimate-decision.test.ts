import { describe, it, expect } from "vitest";
import { estimateDecisionCopy } from "./estimate-decision";

describe("estimateDecisionCopy", () => {
  it("sold: a receipt with option, price, signer and date", () => {
    const c = estimateDecisionCopy({
      status: "sold",
      soldOptionName: "Repair + tune-up",
      soldTotal: "$463.19",
      signedOn: "Nov 5, 2026",
      signatureName: "Trevor Nunn",
    });
    expect(c.title).toBe("Estimate approved");
    expect(c.body).toBe(
      "You approved Repair + tune-up for $463.19. Signed by Trevor Nunn on Nov 5, 2026. We'll be in touch to schedule the work.",
    );
  });

  it("sold in the office: no fake signer", () => {
    const c = estimateDecisionCopy({
      status: "sold",
      soldOptionName: "Repair",
      soldTotal: "$315.00",
      signedOn: "Nov 5, 2026",
      signatureName: "(admin)",
    });
    expect(c.body).not.toContain("(admin)");
    expect(c.body).toContain("Approved on Nov 5, 2026.");
  });

  it("sold with nothing known still reads as a sentence", () => {
    const c = estimateDecisionCopy({
      status: "sold",
      soldOptionName: null,
      soldTotal: null,
      signedOn: null,
      signatureName: null,
    });
    expect(c.body).toBe("You approved this estimate. We'll be in touch to schedule the work.");
  });

  it("never says 'decided'", () => {
    for (const status of ["dismissed", "expired", "weird"]) {
      const c = estimateDecisionCopy({
        status,
        soldOptionName: null,
        soldTotal: null,
        signedOn: null,
        signatureName: null,
      });
      expect(`${c.title} ${c.body}`).not.toMatch(/decided/i);
    }
  });
});
