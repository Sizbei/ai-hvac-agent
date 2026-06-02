import { describe, it, expect } from "vitest";
import { routeMessage } from "./intent-router";
import type { RouterOrgConfig } from "./router-config";
import { EMPTY_ORG_CONFIG } from "./router-config";

function cfg(overrides: Partial<RouterOrgConfig>): RouterOrgConfig {
  return { ...EMPTY_ORG_CONFIG, ...overrides };
}

describe("router org-config overlay", () => {
  describe("disabled services", () => {
    it("declines a service the org turned off (disabledServiceTags)", () => {
      const v = routeMessage(
        "do you work on boilers?",
        {},
        cfg({ disabledServiceTags: ["boiler"] }),
      );
      expect(v.action).toBe("REDIRECT");
      expect(v.reply).toMatch(/not a service we currently offer/i);
    });

    it("still answers a service the org DID NOT disable", () => {
      const v = routeMessage(
        "do you install ductless mini-splits?",
        {},
        cfg({ disabledServiceTags: ["boiler"] }),
      );
      expect(v.action).toBe("ANSWER");
      expect(v.intentId).toBe("equipment-minisplit");
    });

    it("declines an intent governed by a disabled issueType", () => {
      const v = routeMessage(
        "do you do installations?",
        {},
        cfg({ disabledIssueTypes: ["installation"] }),
      );
      expect(v.action).toBe("REDIRECT");
      expect(v.reply).toMatch(/not a service we currently offer/i);
    });
  });

  describe("custom FAQs", () => {
    it("answers with a matching admin-authored FAQ, over the built-in catalog", () => {
      const v = routeMessage(
        "what is your dog policy on site",
        {},
        cfg({
          customFaqs: [
            {
              id: "faq-1",
              answer: "We love dogs but please crate them during the visit.",
              triggers: ["dog policy"],
            },
          ],
        }),
      );
      expect(v.action).toBe("ANSWER");
      expect(v.intentId).toBe("custom-faq:faq-1");
      expect(v.reply).toContain("crate them");
    });

    it("ignores a custom FAQ whose trigger does not match", () => {
      const v = routeMessage(
        "what are your hours",
        {},
        cfg({
          customFaqs: [
            { id: "faq-1", answer: "irrelevant", triggers: ["dog policy"] },
          ],
        }),
      );
      // Falls through to the built-in business-hours FAQ.
      expect(v.intentId).toBe("faq-business-hours");
    });
  });

  describe("business-info personalization", () => {
    it("uses the org's real business hours in the answer", () => {
      const v = routeMessage(
        "what are your hours",
        {},
        cfg({ businessInfo: { businessHours: "Mon–Fri 8am–6pm" } }),
      );
      expect(v.action).toBe("ANSWER");
      expect(v.reply).toContain("Mon–Fri 8am–6pm");
    });

    it("uses the org's phone number when asked", () => {
      const v = routeMessage(
        "what is your phone number",
        {},
        cfg({ businessInfo: { phone: "555-123-4567" } }),
      );
      expect(v.reply).toContain("555-123-4567");
    });

    it("falls back to the generic answer when no business info is set", () => {
      const v = routeMessage("what are your hours", {}, EMPTY_ORG_CONFIG);
      expect(v.action).toBe("ANSWER");
      expect(v.intentId).toBe("faq-business-hours");
      expect(v.reply).toBeTruthy();
    });
  });

  describe("SAFETY — config never suppresses an emergency", () => {
    it("escalates a gas smell even if every service is disabled and a custom FAQ could match", () => {
      const v = routeMessage(
        "i smell gas in my house",
        {},
        cfg({
          disabledServiceTags: [
            "boiler",
            "water_heater",
            "commercial",
            "ductless_minisplit",
            "iaq_products",
            "new_installation",
            "duct_cleaning",
          ],
          disabledIssueTypes: ["installation", "maintenance", "air_quality"],
          customFaqs: [
            { id: "x", answer: "should never win", triggers: ["gas"] },
          ],
        }),
      );
      expect(v.action).toBe("ESCALATE");
      expect(v.escalate).toBe(true);
    });
  });
});
