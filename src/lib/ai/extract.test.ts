import { describe, it, expect } from "vitest";
import { parseExtractionResponse } from "./extract";

describe("parseExtractionResponse", () => {
  it("parses a clean JSON object", () => {
    const r = parseExtractionResponse(
      '{"issueType":"cooling_not_working","urgency":"high","address":"742 Evergreen Terrace","customerName":"Jane","customerPhone":"555-123-9876","customerEmail":null,"description":"AC blowing warm air","isHvacRelated":true}',
    );
    expect(r.issueType).toBe("cooling_not_working");
    expect(r.urgency).toBe("high");
    expect(r.address).toBe("742 Evergreen Terrace");
    expect(r.isHvacRelated).toBe(true);
  });

  it("strips markdown code fences (Qwen often wraps JSON)", () => {
    const r = parseExtractionResponse(
      '```json\n{"issueType":"heating_not_working","urgency":"medium","address":null,"customerName":null,"customerPhone":null,"customerEmail":null,"description":"furnace issue","isHvacRelated":true}\n```',
    );
    expect(r.issueType).toBe("heating_not_working");
    expect(r.urgency).toBe("medium");
  });

  it("ignores leading/trailing prose around the JSON", () => {
    const r = parseExtractionResponse(
      'Sure! Here is the data:\n{"issueType":null,"urgency":null,"address":null,"customerName":null,"customerPhone":null,"customerEmail":null,"description":"chatting","isHvacRelated":true}\nLet me know if that helps.',
    );
    expect(r.description).toBe("chatting");
  });

  it("coerces nullish strings to null", () => {
    const r = parseExtractionResponse(
      '{"issueType":"N/A","urgency":"unknown","address":"","customerName":"none","customerPhone":null,"customerEmail":"","description":"x","isHvacRelated":true}',
    );
    expect(r.issueType).toBeNull();
    expect(r.urgency).toBeNull();
    expect(r.address).toBeNull();
    expect(r.customerName).toBeNull();
    expect(r.customerEmail).toBeNull();
  });

  it("drops out-of-enum issueType/urgency instead of throwing", () => {
    const r = parseExtractionResponse(
      '{"issueType":"spaceship_broken","urgency":"super_urgent","address":"1 Main St","customerName":null,"customerPhone":null,"customerEmail":null,"description":"x","isHvacRelated":true}',
    );
    expect(r.issueType).toBeNull();
    expect(r.urgency).toBeNull();
    expect(r.address).toBe("1 Main St");
  });

  it("drops an invalid email rather than failing the whole parse", () => {
    const r = parseExtractionResponse(
      '{"issueType":null,"urgency":null,"address":null,"customerName":null,"customerPhone":null,"customerEmail":"not-an-email","description":"x","isHvacRelated":false}',
    );
    expect(r.customerEmail).toBeNull();
    expect(r.description).toBe("x");
  });

  it("returns an all-null extraction when there is no JSON", () => {
    const r = parseExtractionResponse("I'm sorry, I cannot help with that.");
    expect(r.issueType).toBeNull();
    expect(r.description).toBe("");
    expect(r.isHvacRelated).toBe(false);
  });

  it("coerces stringified boolean isHvacRelated", () => {
    const r = parseExtractionResponse(
      '{"issueType":null,"urgency":null,"address":null,"customerName":null,"customerPhone":null,"customerEmail":null,"description":"x","isHvacRelated":"true"}',
    );
    expect(r.isHvacRelated).toBe(true);
  });
});
