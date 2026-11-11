import { describe, it, expect } from "vitest";
import {
  billingHandledCopy,
  NO_BILLING_ENTRY,
  seatLimitError,
  seatLimitNotice,
  showsBillingLink,
  type BillingEntry,
} from "./billing-entry";

const PANEL: BillingEntry = { view: "panel", contact: null };
const HANDLED: BillingEntry = { view: "handled", contact: "Raymond Chen" };
const REDIRECT: BillingEntry = { view: "redirect", contact: null };

describe("billing entry points", () => {
  it("links to plans only when the billing page shows the panel", () => {
    expect(showsBillingLink(PANEL)).toBe(true);
    expect(showsBillingLink(HANDLED)).toBe(false);
    expect(showsBillingLink(REDIRECT)).toBe(false);
    expect(showsBillingLink(NO_BILLING_ENTRY)).toBe(false);
  });

  it("names who handles billing", () => {
    expect(billingHandledCopy(HANDLED)).toBe("Billing is handled by Raymond Chen.");
    expect(billingHandledCopy({ view: "handled", contact: null })).toBe(
      "Billing is handled by your account administrator.",
    );
  });

  it("offers an upgrade only to someone who can open the plans", () => {
    expect(seatLimitNotice(PANEL)).toBe(
      "Your plan has no free seats, so you can’t add or invite anyone right now. Deactivate someone or upgrade the plan to add more.",
    );
    expect(seatLimitError(PANEL)).toBe(
      "Your plan has no free seats. Deactivate someone or upgrade the plan to add more.",
    );
  });

  it("never says upgrade the plan in a platform-managed org", () => {
    expect(seatLimitNotice(HANDLED)).toBe(
      "Your plan has no free seats, so you can’t add or invite anyone right now. Deactivate someone to add more. Billing is handled by Raymond Chen.",
    );
    expect(seatLimitError(HANDLED)).toBe(
      "Your plan has no free seats. Deactivate someone to add more. Billing is handled by Raymond Chen.",
    );
    expect(seatLimitNotice(HANDLED)).not.toMatch(/upgrade/i);
    expect(seatLimitError(HANDLED)).not.toMatch(/upgrade/i);
  });

  it("stays neutral for someone without billing access", () => {
    expect(seatLimitNotice(REDIRECT)).toBe(
      "Your plan has no free seats, so you can’t add or invite anyone right now. Deactivate someone to add more.",
    );
    expect(seatLimitError(NO_BILLING_ENTRY)).toBe(
      "Your plan has no free seats. Deactivate someone to add more.",
    );
  });
});
