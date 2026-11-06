import { describe, it, expect } from "vitest";
import {
  chatErrorCopy,
  sessionStartErrorCopy,
  isEmptyReply,
  emptyReplyFallback,
  isQuestionMessage,
} from "./chat-turn-feedback";

const envelope = (code: string, message = "raw server text") =>
  JSON.stringify({ success: false, error: { message, code } });

describe("chatErrorCopy", () => {
  it("returns null when there is no error", () => {
    expect(chatErrorCopy(null)).toBeNull();
    expect(chatErrorCopy(undefined)).toBeNull();
  });

  it("maps an expired session to a restart, never the raw JSON", () => {
    const c = chatErrorCopy(envelope("NO_SESSION", "No session found. Create a session first."));
    expect(c?.recovery).toBe("restart");
    expect(c?.message).not.toMatch(/[{}"]/);
    expect(c?.message).not.toContain("Create a session first");
  });

  it("maps the chat rate limit to a wait-and-retry", () => {
    const c = chatErrorCopy(envelope("RATE_LIMITED"));
    expect(c?.recovery).toBe("retry");
    expect(c?.message).toMatch(/wait a minute/);
  });

  it("falls back to generic copy for unknown codes and non-JSON text", () => {
    expect(chatErrorCopy(envelope("WEIRD"))?.message).toMatch(/something went wrong/);
    expect(chatErrorCopy("Failed to fetch")?.message).toMatch(/something went wrong/);
    expect(chatErrorCopy("<html>502</html>")?.recovery).toBe("retry");
  });
});

describe("sessionStartErrorCopy", () => {
  it("explains a rate limit in plain words", () => {
    expect(sessionStartErrorCopy(429)).toMatch(/wait a minute/);
    expect(sessionStartErrorCopy(500)).toMatch(/couldn't start the chat/);
    expect(sessionStartErrorCopy(null)).toMatch(/couldn't start the chat/);
  });
});

describe("isEmptyReply", () => {
  const user = { role: "user", content: "how often should I change my filter?" };
  it("is true when the customer's message got no reply bubble", () => {
    expect(isEmptyReply([{ role: "assistant", content: "Hi" }, user])).toBe(true);
  });
  it("is true for a blank assistant bubble after a customer message", () => {
    expect(isEmptyReply([user, { role: "assistant", content: "  " }])).toBe(true);
  });
  it("is false for a real reply or a lone greeting", () => {
    expect(isEmptyReply([user, { role: "assistant", content: "Every 1-3 months." }])).toBe(false);
    expect(isEmptyReply([{ role: "assistant", content: "" }])).toBe(false);
    expect(isEmptyReply([])).toBe(false);
  });
});

describe("emptyReplyFallback", () => {
  it("a question with no known issue: sorry + booking offer + call", () => {
    expect(emptyReplyFallback("423-555-0100")).toBe(
      "Sorry, I couldn't answer that. I can still book a visit for you. Tap the closest option below, or call us at 423-555-0100.",
    );
    expect(
      emptyReplyFallback(null, { lastUserMessage: "Do you service Kingsport?" }),
    ).toBe(
      "Sorry, I couldn't answer that. I can still book a visit for you. Tap the closest option below.",
    );
    expect(emptyReplyFallback("   ")).not.toMatch(/call us/);
  });

  it("a problem report never says it couldn't answer (N-P1-4)", () => {
    const copy = emptyReplyFallback("(423) 555-0142", {
      lastUserMessage: "My heat pump is making a loud grinding noise",
    });
    expect(copy).toBe(
      "I can still get a technician out. Tap the closest option below, or call us at (423) 555-0142.",
    );
    expect(copy).not.toMatch(/couldn't answer/);
  });

  it("issue known: continues the intake with the pending question", () => {
    expect(
      emptyReplyFallback("423-555-0100", {
        lastUserMessage: "how much will this cost?",
        nextQuestion: "What's the service address where you'd like the technician to come?",
      }),
    ).toBe(
      "Sorry, I couldn't answer that. I can still book a visit for you. What's the service address where you'd like the technician to come?",
    );
  });
});

describe("isQuestionMessage", () => {
  it("spots questions by mark or lead word", () => {
    expect(isQuestionMessage("are you open sunday")).toBe(true);
    expect(isQuestionMessage("How do I reset it")).toBe(true);
    expect(isQuestionMessage("it's leaking?")).toBe(true);
    expect(isQuestionMessage("My AC is leaking water")).toBe(false);
    expect(isQuestionMessage("Isaac here, furnace is out")).toBe(false);
  });
});
