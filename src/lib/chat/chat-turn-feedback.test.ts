import { describe, it, expect } from "vitest";
import {
  chatErrorCopy,
  sessionStartErrorCopy,
  isEmptyReply,
  emptyReplyFallback,
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
  it("offers the org phone when known, otherwise a retry", () => {
    expect(emptyReplyFallback("423-555-0100")).toBe(
      "Sorry, I couldn't answer that. You can call us at 423-555-0100, or try again.",
    );
    expect(emptyReplyFallback(null)).toBe("Sorry, I couldn't answer that. Please try again.");
    expect(emptyReplyFallback("   ")).toBe("Sorry, I couldn't answer that. Please try again.");
  });
});
