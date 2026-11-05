import { describe, it, expect } from "vitest";
import { customerDisplayName, recentConversations, conversationTitle } from "./dashboard-display";
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
