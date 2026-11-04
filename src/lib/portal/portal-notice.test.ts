import { describe, it, expect } from "vitest";
import { portalPaymentNotice, telHref } from "./portal-notice";

describe("portalPaymentNotice", () => {
  it("shows the pay button and no notice when card payments are enabled", () => {
    expect(portalPaymentNotice({ cardEnabled: true, phone: "(423) 555-0100" })).toEqual({
      showPayButton: true,
      notice: null,
      tel: null,
    });
  });

  it("hides the pay button and asks for in-person payment without a phone", () => {
    expect(portalPaymentNotice({ cardEnabled: false, phone: null })).toEqual({
      showPayButton: false,
      notice: "Pay your technician in person.",
      tel: null,
    });
  });

  it("adds the org phone and a tel: link when one is configured", () => {
    expect(portalPaymentNotice({ cardEnabled: false, phone: "(423) 555-0100" })).toEqual({
      showPayButton: false,
      notice: "Pay your technician in person, or call (423) 555-0100.",
      tel: "tel:4235550100",
    });
  });

  it("treats a blank or digit-less phone as no phone", () => {
    for (const phone of ["", "   ", "call us"]) {
      expect(portalPaymentNotice({ cardEnabled: false, phone })).toEqual({
        showPayButton: false,
        notice: "Pay your technician in person.",
        tel: null,
      });
    }
  });

  it("trims the displayed phone", () => {
    expect(portalPaymentNotice({ cardEnabled: false, phone: "  423-555-0100 " }).notice).toBe(
      "Pay your technician in person, or call 423-555-0100.",
    );
  });
});

describe("telHref", () => {
  it("strips everything but digits", () => {
    expect(telHref("(423) 555-0100")).toBe("tel:4235550100");
    expect(telHref("423.555.0100 ext")).toBe("tel:4235550100");
  });

  it("keeps a leading + only", () => {
    expect(telHref("+1 (423) 555-0100")).toBe("tel:+14235550100");
    expect(telHref("  +1-423-555-0100")).toBe("tel:+14235550100");
    expect(telHref("1+423")).toBe("tel:1423");
  });

  it("returns null when there are no digits", () => {
    expect(telHref("")).toBeNull();
    expect(telHref("+")).toBeNull();
  });
});
