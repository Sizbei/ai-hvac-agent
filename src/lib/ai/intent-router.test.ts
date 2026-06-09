import { describe, it, expect } from "vitest";
import { routeMessage, normalize } from "./intent-router";

describe("normalize", () => {
  it("lowercases, strips punctuation, collapses whitespace", () => {
    expect(normalize("  My  A/C is BROKEN!! ")).toContain("air conditioner");
    expect(normalize("Hello???")).toBe("hello");
  });

  it("applies the ac alias", () => {
    expect(normalize("my ac broke")).toBe("my air conditioner broke");
  });
});

describe("emergency short-circuit", () => {
  it("escalates a gas smell with a qualifier", () => {
    const v = routeMessage("I smell gas near my furnace");
    expect(v.action).toBe("ESCALATE");
    expect(v.escalate).toBe(true);
    expect(v.intentId).toBe("emergency-gas-smell");
    expect(v.urgency).toBe("emergency");
    expect(v.reply).toBeTruthy();
  });

  it("does NOT escalate 'gas furnace' (negation guard)", () => {
    const v = routeMessage("my gas furnace won't start");
    expect(v.escalate).toBe(false);
    expect(v.intentId).not.toBe("emergency-gas-smell");
  });

  it("does NOT escalate a CO mention without a qualifier", () => {
    // "carbon monoxide" alias fires from "co" but no alarm/detector qualifier.
    const v = routeMessage("does a gas furnace produce co");
    expect(v.escalate).toBe(false);
  });

  it("escalates a CO alarm going off", () => {
    const v = routeMessage("my carbon monoxide alarm is going off");
    expect(v.action).toBe("ESCALATE");
    expect(v.escalate).toBe(true);
  });

  it("ignores the 'emergency heat' heat-pump mode (whitelist)", () => {
    const v = routeMessage("how do I turn on emergency heat on my heat pump");
    expect(v.escalate).toBe(false);
  });
});

describe("FAQ / informational answers (no LLM)", () => {
  it("answers a service-area question", () => {
    const v = routeMessage("do you serve my area?");
    expect(v.action).toBe("ANSWER");
    expect(v.intentId).toBe("faq-service-area");
    expect(v.reply).toBeTruthy();
  });

  it("answers a business-hours question", () => {
    const v = routeMessage("what are your hours");
    expect(v.action).toBe("ANSWER");
    expect(v.reply).toBeTruthy();
  });
});

describe("conversational / meta", () => {
  it("answers a bare greeting without the LLM", () => {
    const v = routeMessage("hi");
    expect(v.action).toBe("ANSWER");
    expect(v.intentId).toBe("meta-greeting");
  });

  it("answers a thanks", () => {
    const v = routeMessage("thank you so much");
    expect(v.action).toBe("ANSWER");
    expect(v.intentId).toBe("meta-thanks");
  });

  it("redirects a non-HVAC request", () => {
    const v = routeMessage("can you fix my leaky toilet");
    expect(v.action).toBe("REDIRECT");
    expect(v.intentId).toBe("meta-non-hvac-redirect");
  });

  it("treats keyboard-mash as gibberish, not the LLM", () => {
    const v = routeMessage("asdfghjkl");
    expect(v.action).toBe("ANSWER");
    expect(v.intentId).toBe("meta-gibberish-empty");
  });
});

describe("issue intents → COLLECT_INFO", () => {
  it("recognizes AC not cooling", () => {
    const v = routeMessage("my ac is blowing warm air");
    expect(v.action).toBe("COLLECT_INFO");
    expect(v.issueType).toBe("cooling_not_working");
    expect(v.reply).toBeTruthy();
  });

  it("recognizes furnace not heating", () => {
    const v = routeMessage("my furnace is not heating the house");
    expect(v.action).toBe("COLLECT_INFO");
    expect(v.issueType).toBe("heating_not_working");
  });

  // "down" is a common way customers describe a non-working system. The router
  // must classify it (not punt to the LLM, which left issueType null in live
  // testing). Heating/refrigeration "down" must NOT mis-route to cooling.
  it('classifies "AC is completely down" as cooling', () => {
    const v = routeMessage("my office AC is completely down");
    expect(v.action).toBe("COLLECT_INFO");
    expect(v.issueType).toBe("cooling_not_working");
  });

  it('classifies "ac is down" / "cooling is down" as cooling', () => {
    expect(routeMessage("ac is down").issueType).toBe("cooling_not_working");
    expect(routeMessage("the cooling is down").issueType).toBe(
      "cooling_not_working",
    );
  });

  it('classifies "the heat is down" / "furnace is down" as heating', () => {
    expect(routeMessage("the heat is down").issueType).toBe(
      "heating_not_working",
    );
    expect(routeMessage("my furnace is down").issueType).toBe(
      "heating_not_working",
    );
  });

  it('classifies a bare "no heat" as heating (not emergency without a qualifier)', () => {
    const v = routeMessage("no heat in the building");
    expect(v.issueType).toBe("heating_not_working");
    expect(v.escalate).toBe(false);
  });

  it('does NOT mis-route a heating "down" complaint to cooling', () => {
    // "furnace ... down" → the cooling intent guards off "furnace"; it must not
    // claim this via its generic "completely down" trigger.
    const v = routeMessage("the furnace is down");
    expect(v.issueType).not.toBe("cooling_not_working");
  });
});

describe("COLLECT_INFO → SUBMIT promotion when required slots known", () => {
  it("promotes to SUBMIT once issueType, urgency, and address are present", () => {
    const v = routeMessage("my ac is still not cooling", {
      issueType: "cooling_not_working",
      urgency: "high",
      address: "742 Evergreen Terrace, Springfield, IL 62704",
    });
    expect(v.action).toBe("SUBMIT");
    expect(v.reply).toContain("Confirm");
  });
});

describe("fallback to LLM", () => {
  it("falls back on empty input", () => {
    expect(routeMessage("").action).toBe("FALLBACK_LLM");
  });

  it("falls back on a novel, unmatched description", () => {
    const v = routeMessage(
      "the zone damper actuator seems to be hunting between positions",
    );
    expect(v.action).toBe("FALLBACK_LLM");
  });

  it("falls back on non-Latin input", () => {
    const v = routeMessage("私のエアコンが壊れています");
    expect(v.action).toBe("FALLBACK_LLM");
  });

  it("falls back on compound multi-category messages", () => {
    const v = routeMessage(
      "my furnace is not heating and my thermostat screen is blank and there is weak airflow",
    );
    expect(v.action).toBe("FALLBACK_LLM");
  });
});

describe("escalation request", () => {
  it("escalates an explicit human request", () => {
    const v = routeMessage("I want to speak to a human");
    expect(v.action).toBe("ESCALATE");
    expect(v.escalate).toBe(true);
  });
});
