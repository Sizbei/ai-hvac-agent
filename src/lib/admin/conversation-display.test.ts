import { describe, it, expect } from "vitest";
import {
  needsAction,
  customerNameFromMetadata,
  conversationTitle,
  conversationTimeLabel,
  previewSnippet,
  shortConversationId,
  phoneDigitsQuery,
  extractedFields,
  messageAuthors,
  authorLabel,
} from "./conversation-display";

describe("needsAction", () => {
  const base = { status: "escalated", handledAt: null, lastCustomerMessageAt: null };
  it("is only for escalated conversations", () => {
    expect(needsAction({ ...base, status: "submitted" })).toBe(false);
    expect(needsAction(base)).toBe(true);
  });
  it("clears once handled, and reopens on a newer customer message", () => {
    const handledAt = "2026-11-01T10:00:00.000Z";
    expect(needsAction({ ...base, handledAt, lastCustomerMessageAt: null })).toBe(false);
    expect(needsAction({ ...base, handledAt, lastCustomerMessageAt: "2026-11-01T09:00:00.000Z" })).toBe(false);
    expect(needsAction({ ...base, handledAt, lastCustomerMessageAt: "2026-11-01T10:05:00.000Z" })).toBe(true);
  });
});

describe("titles", () => {
  const id = "abfeb0ea-0000-0000-0000-000000000000";
  it("prefers the customer name, then the reference, then a short id", () => {
    expect(customerNameFromMetadata({ customerName: "  Ada Hill " })).toBe("Ada Hill");
    expect(customerNameFromMetadata({ customerName: "" })).toBeNull();
    expect(customerNameFromMetadata(null)).toBeNull();
    expect(conversationTitle({ customerName: "Ada", referenceNumber: "HVAC-1", id })).toBe("Ada");
    expect(conversationTitle({ customerName: null, referenceNumber: "HVAC-1", id })).toBe("HVAC-1");
    expect(conversationTitle({ customerName: null, referenceNumber: null, id })).toBe("abfeb0ea");
  });

  it("falls back to the linked request's customer before anything generic", () => {
    expect(
      conversationTitle({ customerName: null, requestCustomerName: "Watauga Storage", referenceNumber: "HVAC-1", id, channel: "web" }),
    ).toBe("Watauga Storage");
  });

  it("titles an anonymous chat by channel, first words and start time", () => {
    const now = new Date("2026-11-06T20:00:00Z");
    expect(
      conversationTitle(
        {
          customerName: null,
          referenceNumber: "HVAC-1",
          id,
          channel: "web",
          preview: "my AC is not cooling at all since last night",
          startedAt: "2026-11-06T19:14:00Z",
        },
        { now, timeZone: "America/New_York" },
      ),
    ).toBe("Web chat \u00b7 \u201cmy AC is not cooling at\u2026\u201d \u00b7 2:14 PM");
    expect(conversationTitle({ customerName: null, referenceNumber: null, id, channel: "phone", preview: null })).toBe(
      "Phone call",
    );
    expect(shortConversationId(id)).toBe("abfeb0ea");
  });
});

describe("previewSnippet", () => {
  it("keeps short text and cuts long text at a word", () => {
    expect(previewSnippet("  no heat  ")).toBe("no heat");
    expect(previewSnippet("I smell gas in the basement right now")).toBe("I smell gas in the\u2026");
    expect(previewSnippet("")).toBeNull();
    expect(previewSnippet(null)).toBeNull();
  });
});

describe("conversationTimeLabel", () => {
  const tz = "America/New_York";
  const now = new Date("2026-11-06T20:00:00Z");
  it("shows the time today, the date this year, and the year otherwise", () => {
    expect(conversationTimeLabel("2026-11-06T13:05:00Z", now, tz)).toBe("8:05 AM");
    expect(conversationTimeLabel("2026-11-02T13:05:00Z", now, tz)).toBe("Nov 2, 8:05 AM");
    expect(conversationTimeLabel("2025-12-31T18:00:00Z", now, tz)).toBe("Dec 31, 2025, 1:00 PM");
    expect(conversationTimeLabel("not a date", now, tz)).toBeNull();
  });
});

describe("phoneDigitsQuery", () => {
  it("extracts digits from phone-shaped searches only", () => {
    expect(phoneDigitsQuery("5125550177")).toBe("5125550177");
    expect(phoneDigitsQuery("(512) 555-0177")).toBe("5125550177");
    expect(phoneDigitsQuery("+1 512.555.0177")).toBe("5125550177");
    expect(phoneDigitsQuery("+1 512 555 0177")).toBe("5125550177");
    expect(phoneDigitsQuery("44 20 7946 0958")).toBe("442079460958");
    expect(phoneDigitsQuery("HVAC-DEMO0002")).toBeNull();
    expect(phoneDigitsQuery("555-01")).toBeNull();
  });
});

describe("extractedFields", () => {
  it("labels, orders and humanizes office fields and hides bot state", () => {
    const rows = extractedFields({
      reAskCount: 2,
      isHvacRelated: true,
      urgency: "high",
      issueType: "heating_not_working",
      customerName: "Ada Hill",
      customerPhone: "(512) 555-0177",
      customerEmail: "ada@example.com",
      systemDownStatus: "fully_down",
      problemDuration: "a_few_days",
      description: "No heat since last night",
      address: "__skipped__",
    });
    expect(rows.map((r) => [r.label, r.value])).toEqual([
      ["Name", "Ada Hill"],
      ["Phone", "(512) 555-0177"],
      ["Email", "ada@example.com"],
      ["Issue", "Heating not working"],
      ["Urgency", "High"],
      ["System", "Fully down"],
      ["How long", "A few days"],
      ["Description", "No heat since last night"],
    ]);
    expect(rows[1].href).toBe("tel:5125550177");
    expect(rows[2].href).toBe("mailto:ada@example.com");
  });
  it("keeps free text as typed", () => {
    const rows = extractedFields({ problemDuration: "it started yesterday" });
    expect(rows[0].value).toBe("it started yesterday");
  });
  it("returns nothing for missing metadata", () => {
    expect(extractedFields(null)).toEqual([]);
  });
});

describe("messageAuthors", () => {
  const msgs = [
    { role: "user" as const, createdAt: "2026-11-01T10:00:00.000Z" },
    { role: "assistant" as const, createdAt: "2026-11-01T10:00:02.000Z" },
    { role: "assistant" as const, createdAt: "2026-11-01T10:05:00.000Z" },
    { role: "system" as const, createdAt: "2026-11-01T10:06:00.000Z" },
  ];
  it("marks an assistant message as staff when a reply audit row follows it", () => {
    expect(messageAuthors(msgs, ["2026-11-01T10:05:00.200Z"])).toEqual([
      "customer",
      "ai",
      "staff",
      "system",
    ]);
  });
  it("leaves AI messages alone without a nearby audit row", () => {
    expect(messageAuthors(msgs, ["2026-11-01T12:00:00.000Z"])).toEqual([
      "customer",
      "ai",
      "ai",
      "system",
    ]);
  });
  it("labels authors", () => {
    expect(authorLabel("staff")).toBe("Office");
    expect(authorLabel("ai")).toBe("AI assistant");
  });
});
