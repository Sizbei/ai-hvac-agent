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

describe("account-data intents (identified-customer reads, v1)", () => {
  // The router only RECOGNIZES these (surfaces ACCOUNT_LOOKUP + the intentId);
  // identity is enforced in the chat route, not here. These tests pin the
  // recognition + the critical precedence guarantees.

  it("recognizes a membership-status question as ACCOUNT_LOOKUP", () => {
    const v = routeMessage("am i a member");
    expect(v.action).toBe("ACCOUNT_LOOKUP");
    expect(v.intentId).toBe("account-data-membership-status");
  });

  it("recognizes a next-visit question as ACCOUNT_LOOKUP", () => {
    const v = routeMessage("when is my next visit");
    expect(v.action).toBe("ACCOUNT_LOOKUP");
    expect(v.intentId).toBe("account-data-next-visit");
  });

  it("recognizes a balance question as ACCOUNT_LOOKUP", () => {
    const v = routeMessage("what do i owe");
    expect(v.action).toBe("ACCOUNT_LOOKUP");
    expect(v.intentId).toBe("account-data-balance");
  });

  it("recognizes a tech/appointment-status question as ACCOUNT_LOOKUP", () => {
    const v = routeMessage("when is my technician");
    expect(v.action).toBe("ACCOUNT_LOOKUP");
    expect(v.intentId).toBe("account-data-appointment-status");
  });

  it("recognizes a reschedule request as ACCOUNT_LOOKUP", () => {
    const v = routeMessage("push my visit");
    expect(v.action).toBe("ACCOUNT_LOOKUP");
    expect(v.intentId).toBe("account-data-reschedule");
  });

  it("surfaces the legacy reschedule intent as ACCOUNT_LOOKUP for the route to map", () => {
    // "reschedule my visit" is claimed by the higher-priority scheduling intent,
    // but that legacy reference intent is now carved out to ACCOUNT_LOOKUP so the
    // chat route can map it to the reschedule account tool for an identified
    // customer (an unidentified session gets the identify ask, never data).
    const v = routeMessage("reschedule my visit");
    expect(v.action).toBe("ACCOUNT_LOOKUP");
    expect(v.intentId).toBe("scheduling-reschedule");
  });

  it("surfaces the legacy check-status intent as ACCOUNT_LOOKUP", () => {
    const v = routeMessage("any update on my request");
    expect(v.action).toBe("ACCOUNT_LOOKUP");
    expect(v.intentId).toBe("account-check-status");
  });

  it("carries a canned identify-ask reply (used for an UNIDENTIFIED session)", () => {
    // The route surfaces this as the 'what's your email/phone?' ask so an
    // unidentified session never leaks another customer's data.
    const v = routeMessage("what do i owe");
    expect(v.reply).toBeTruthy();
    expect(v.reply!.toLowerCase()).toContain("account");
  });

  it("an account question NEVER outranks the emergency short-circuit", () => {
    // A hazard worded alongside an account question must still escalate — the
    // emergency short-circuit runs FIRST and account_data is the lowest tier.
    const v = routeMessage("my carbon monoxide alarm is going off, what do i owe");
    expect(v.action).toBe("ESCALATE");
    expect(v.escalate).toBe(true);
    expect(v.intentId).toBe("emergency-carbon-monoxide");
  });

  it("a real issue outranks an account question on the same turn", () => {
    // account_data is priority 4 (lowest); a cooling issue (priority 2) wins.
    // (Distinct categories both scoring high would compound→FALLBACK; here the
    // account phrase is the lower-priority loser, never the winner.)
    const v = routeMessage("my air conditioner is not cooling");
    expect(v.intentId).not.toBe("account-data-balance");
  });
});

describe("deterministic ambiguity probes (Step 16)", () => {
  it("probes vague malfunction with a crisp direction question (not an LLM punt)", () => {
    const v = routeMessage("it's not working");
    expect(v.action).toBe("CLARIFY");
    expect(v.intentId).toBe("clarify-malfunction-direction");
    expect(v.reply).toMatch(/not cooling, not heating, or making a noise/i);
    expect(v.escalate).toBe(false);
  });

  it("probes a home-vs-commercial ambiguity (cooler) instead of punting", () => {
    const v = routeMessage("my cooler is down");
    expect(v.action).toBe("CLARIFY");
    expect(v.intentId).toBe("clarify-home-or-commercial");
    expect(v.reply).toMatch(/home or a commercial property/i);
  });

  it("does NOT probe a confident single-intent message", () => {
    const v = routeMessage("my ac is blowing warm air");
    expect(v.action).not.toBe("CLARIFY");
  });

  it("does NOT probe direction once the issue type is already known", () => {
    const v = routeMessage("it's not working", { issueType: "cooling_not_working" });
    expect(v.action).not.toBe("CLARIFY");
  });

  it("does NOT probe home-vs-commercial once propertyType is known", () => {
    const v = routeMessage("my cooler is down", {
      extras: { propertyType: "commercial" },
    });
    expect(v.action).not.toBe("CLARIFY");
  });

  it("NEVER outranks an emergency — a hazard still escalates", () => {
    const v = routeMessage("i smell gas and my system is not working");
    expect(v.action).toBe("ESCALATE");
    expect(v.escalate).toBe(true);
  });

  it("NEVER outranks the compound detector — multi-intent still punts to LLM", () => {
    const v = routeMessage(
      "my furnace is not heating and my thermostat is blank and there is weak airflow",
    );
    expect(v.action).toBe("FALLBACK_LLM");
  });

  it("a probe is a preference/clarify only — never escalates or commits", () => {
    const v = routeMessage("it's not working");
    expect(v.escalate).toBe(false);
    expect(v.issueType).toBeNull();
    expect(v.urgency).toBeNull();
  });
});
