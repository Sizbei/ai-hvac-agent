import { describe, expect, it } from "vitest";
import { customerNameLabel, displayCustomerName, isDeletedFieldpulsePlaceholder } from "./customer-name-display";
import { customerNameLabel as requestCustomerNameLabel } from "./request-labels";
import { customerDisplayName } from "./dashboard-display";

describe("displayCustomerName", () => {
  it("reads the deleted-FieldPulse placeholder as a customer with no name", () => {
    expect(displayCustomerName("FieldPulse customer (deleted #17148)")).toBe("No name on file");
    expect(displayCustomerName("Fieldpulse Customer (deleted #16977)")).toBe("No name on file");
  });
  it("detects the placeholder and nothing else", () => {
    expect(isDeletedFieldpulsePlaceholder(" Fieldpulse Customer (deleted #16977) ")).toBe(true);
    expect(isDeletedFieldpulsePlaceholder("Jane Doe")).toBe(false);
    expect(isDeletedFieldpulsePlaceholder(null)).toBe(false);
  });
  it("leaves real names and null alone", () => {
    expect(displayCustomerName("Jane Doe")).toBe("Jane Doe");
    expect(displayCustomerName("Deleted Dan")).toBe("Deleted Dan");
    expect(displayCustomerName(null)).toBeNull();
  });
});

describe("displayCustomerName — erased customers", () => {
  it("never shows the erasure sentinel", () => {
    expect(displayCustomerName("[deleted]")).toBe("Erased customer");
    expect(displayCustomerName(" [deleted] ")).toBe("Erased customer");
  });
  it("leaves names that merely mention it", () => {
    expect(displayCustomerName("[deleted] Smith")).toBe("[deleted] Smith");
  });
});

describe("customerNameLabel", () => {
  it("is the one label for a missing, erased or deleted-in-FieldPulse name", () => {
    for (const fn of [customerNameLabel, requestCustomerNameLabel, customerDisplayName]) {
      expect(fn(null)).toBe("No name on file");
      expect(fn(undefined)).toBe("No name on file");
      expect(fn("   ")).toBe("No name on file");
      expect(fn("[deleted]")).toBe("Erased customer");
      expect(fn("FieldPulse customer (deleted #17148)")).toBe("No name on file");
      expect(fn("  Hollis Barrett ")).toBe("Hollis Barrett");
    }
  });
});
