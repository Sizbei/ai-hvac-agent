import { describe, it, expect } from "vitest";
import {
  afterCheck, approveConfirmCopy, approvedLine, CUSTOMER_COPY, customerHeading, footerSummary, initialChoice, previewLines,
  saleResult, showAllLabel,
} from "./estimate-page-copy";

describe("customer view copy and rules (spec §7.2)", () => {
  it("heading", () => {
    expect(customerHeading("Pat Probe")).toBe("Estimate for Pat Probe");
    expect(customerHeading(null)).toBe("Your estimate");
  });
  it("radio pre-select: only a single option is pre-selected", () => {
    expect(initialChoice([{ id: "a" }])).toBe("a");
    expect(initialChoice([{ id: "a" }, { id: "b" }])).toBeNull();
  });
  it("cards show the first 3 lines; Show all N items beyond that", () => {
    expect(previewLines([1, 2, 3, 4], false)).toEqual([1, 2, 3]);
    expect(previewLines([1, 2, 3, 4], true)).toEqual([1, 2, 3, 4]);
    expect(showAllLabel(3)).toBeNull();
    expect(showAllLabel(5)).toBe("Show all 5 items");
  });
  it("footer and confirm copy", () => {
    expect(footerSummary(null)).toBe("Choose an option");
    expect(footerSummary({ name: "Better", totalCents: 481_200 })).toBe("Better · $4,812.00");
    expect(approveConfirmCopy("Better", 481_200)).toBe("Approve Better for $4,812.00?");
  });
  it("sale result: success, check by refetch, or the customer-safe failure", () => {
    expect(saleResult("success_refetch")).toBe("success");
    expect(saleResult("already_saved_refetch")).toBe("success");
    expect(saleResult("retry_same_key_after_refetch")).toBe("check");
    expect(saleResult("wait_then_refetch")).toBe("check");
    expect(saleResult("show_message_refetch")).toBe("failed");
    expect(saleResult("spent_new_key")).toBe("failed");
  });
  it("after an unknown result: success only when THIS technician sold THIS option", () => {
    expect(afterCheck({ status: "sold", soldByMe: true, soldOptionId: "b" }, "b")).toBe(true);
    expect(afterCheck({ status: "sold", soldByMe: true, soldOptionId: "a" }, "b")).toBe(false);
    expect(afterCheck({ status: "sold", soldByMe: false, soldOptionId: "b" }, "b")).toBe(false);
    expect(afterCheck({ status: "open", soldByMe: false, soldOptionId: null }, "b")).toBe(false);
    expect(afterCheck(null, "b")).toBe(false);
  });
  it("exact customer-facing strings", () => {
    expect(CUSTOMER_COPY.failed).toBe("Something went wrong. Please hand the phone back to your technician.");
    expect(CUSTOMER_COPY.approved).toBe("Approved. Thank you.");
    expect(CUSTOMER_COPY.consent).toBe("By typing your name and approving, you authorize the selected work.");
    expect(CUSTOMER_COPY.nameLabel).toBe("Type your full name to sign");
    expect(CUSTOMER_COPY.handBackPrompt).toBe("Please hand the phone back to your technician.");
  });
  it("technician's approved line in the business timezone", () => {
    expect(approvedLine("2026-11-06T19:05:00Z", "Better")).toBe("Approved · Nov 6, 2:05 PM · Better");
  });
});
