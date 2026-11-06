import { describe, it, expect } from "vitest";
import {
  customerDisplayName,
  recentConversations,
  conversationTitle,
  dashboardSectionState,
  needsActionLabel,
  businessDateLabel,
} from "./dashboard-display";
import type { ConversationSummary } from "./conversation-types";

const conv = (over: Partial<ConversationSummary>): ConversationSummary => ({
  id: "3dd87f0b-0000", status: "chatting", channel: "web", turnCount: 0, messageCount: 0,
  tokensUsed: 0, preview: null, hasServiceRequest: false, referenceNumber: null,
  createdAt: "2026-11-01T00:00:00Z", updatedAt: "2026-11-01T00:00:00Z", lastMessageAt: null,
  customerName: null, needsAction: false, ...over,
});

describe("customerDisplayName", () => {
  it("never shows the erasure placeholder or Unknown", () => {
    expect(customerDisplayName("[deleted]")).toBe("Erased customer");
    expect(customerDisplayName(null)).toBe("No name on file");
    expect(customerDisplayName("  ")).toBe("No name on file");
    expect(customerDisplayName("Ana Ruiz")).toBe("Ana Ruiz");
  });
});

describe("recentConversations", () => {
  it("drops empty widget sessions and caps the list", () => {
    const rows = [
      conv({ id: "empty" }),
      conv({ id: "a", messageCount: 3 }),
      conv({ id: "req", hasServiceRequest: true }),
      conv({ id: "b", messageCount: 1 }),
    ];
    expect(recentConversations(rows, 2).map((c) => c.id)).toEqual(["a", "req"]);
  });
});

describe("conversationTitle", () => {
  it("prefers the customer name, then the reference, then the channel", () => {
    expect(conversationTitle(conv({ customerName: "Ana Ruiz", referenceNumber: "HVAC-1" }))).toBe("Ana Ruiz");
    expect(conversationTitle(conv({ referenceNumber: "HVAC-1" }))).toBe("HVAC-1");
    expect(conversationTitle(conv({ channel: "phone" }))).toBe("Phone call");
    expect(conversationTitle(conv({ customerName: "[deleted]" }))).toBe("Web chat");
  });
});

describe("dashboardSectionState", () => {
  it("shows an error, not the empty state, when the first load failed", () => {
    expect(dashboardSectionState({ isLoading: false, hasData: false, failed: true })).toBe("error");
  });
  it("keeps showing loaded data when a later poll fails", () => {
    expect(dashboardSectionState({ isLoading: false, hasData: true, failed: true })).toBe("ready");
  });
  it("is loading before the first answer, ready (maybe empty) after a good one", () => {
    expect(dashboardSectionState({ isLoading: true, hasData: false, failed: false })).toBe("loading");
    expect(dashboardSectionState({ isLoading: false, hasData: false, failed: false })).toBe("ready");
  });
});

describe("needsActionLabel", () => {
  it("agrees in number", () => {
    expect(needsActionLabel(1)).toBe("1 conversation needs action");
    expect(needsActionLabel(7)).toBe("7 conversations need action");
  });
});

describe("businessDateLabel", () => {
  it("uses the business day, not the viewer's", () => {
    // 01:00 UTC on Nov 6 is still Nov 5 in New York (and already Nov 6 in Tokyo).
    const at = new Date("2026-11-06T01:00:00Z");
    expect(businessDateLabel(at, "America/New_York")).toBe("Thursday, November 5");
    expect(businessDateLabel(at, "Asia/Tokyo")).toBe("Friday, November 6");
  });
});
