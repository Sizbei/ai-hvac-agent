import { describe, expect, it } from "vitest";
import {
  referencedVariables,
  unknownVariables,
  variablesForTrigger,
} from "./template-variables";

describe("variablesForTrigger", () => {
  it("lists the trigger's variables", () => {
    expect(variablesForTrigger("technician_arrived")).toEqual([
      "customerName",
      "technicianName",
      "companyName",
      "phoneNumber",
    ]);
  });

  it("returns [] for an unknown trigger", () => {
    expect(variablesForTrigger("nope")).toEqual([]);
  });
});

describe("referencedVariables", () => {
  it("skips helpers, block keywords, literals and comments", () => {
    const body =
      'Hi {{customerName}}, {{date appointmentDate "short"}} {{#if totalAmount}}{{totalAmount}}{{else}}free{{/if}} {{!-- note --}} {{{ payLink }}}';
    expect(referencedVariables(body)).toEqual([
      "customerName",
      "appointmentDate",
      "totalAmount",
      "payLink",
    ]);
  });
});

describe("unknownVariables", () => {
  it("flags names the trigger doesn't provide", () => {
    expect(
      unknownVariables("Hi {{customerName}} {{bogusVariable}}", "technician_arrived"),
    ).toEqual(["bogusVariable"]);
  });

  it("is empty when every name is provided", () => {
    expect(
      unknownVariables("{{technicianName}} from {{companyName}} is here", "technician_arrived"),
    ).toEqual([]);
  });
});
