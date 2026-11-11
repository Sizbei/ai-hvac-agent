import { describe, expect, it } from "vitest";
import { displayCustomerName } from "./customer-name-display";

describe("displayCustomerName", () => {
  it("renders the deleted-FieldPulse placeholder in plain words", () => {
    expect(displayCustomerName("FieldPulse customer (deleted #17148)")).toBe("Deleted FieldPulse customer");
    expect(displayCustomerName("Fieldpulse Customer (deleted #16977)")).toBe("Deleted FieldPulse customer");
  });
  it("leaves real names and null alone", () => {
    expect(displayCustomerName("Jane Doe")).toBe("Jane Doe");
    expect(displayCustomerName("Deleted Dan")).toBe("Deleted Dan");
    expect(displayCustomerName(null)).toBeNull();
  });
});
