import { describe, it, expect } from "vitest";
import { toJudgeTranscript, type ConversationMessage } from "./transcript-adapter";

describe("toJudgeTranscript", () => {
  it("pairs alternating turns and keeps the arrays aligned", () => {
    const msgs: ConversationMessage[] = [
      { role: "user", content: "my AC is out" },
      { role: "assistant", content: "Sorry to hear that — when did it start?" },
      { role: "user", content: "this morning" },
      { role: "assistant", content: "Got it, let's get someone out." },
    ];
    const t = toJudgeTranscript(msgs);
    expect(t.userTurns).toEqual(["my AC is out", "this morning"]);
    expect(t.botReplies).toEqual([
      "Sorry to hear that — when did it start?",
      "Got it, let's get someone out.",
    ]);
    expect(t.userTurns.length).toBe(t.botReplies.length);
  });

  it("concatenates consecutive assistant messages into the preceding turn's reply", () => {
    const msgs: ConversationMessage[] = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "Hello!" },
      { role: "assistant", content: "How can I help?" },
    ];
    const t = toJudgeTranscript(msgs);
    expect(t.userTurns).toEqual(["hi"]);
    expect(t.botReplies).toEqual(["Hello! How can I help?"]);
  });

  it("gives consecutive user turns their own (null-reply) slots", () => {
    const msgs: ConversationMessage[] = [
      { role: "user", content: "are you open?" },
      { role: "user", content: "hello?" },
      { role: "assistant", content: "Yes, we're open." },
    ];
    const t = toJudgeTranscript(msgs);
    expect(t.userTurns).toEqual(["are you open?", "hello?"]);
    expect(t.botReplies).toEqual([null, "Yes, we're open."]);
    expect(t.userTurns.length).toBe(t.botReplies.length);
  });

  it("drops a leading assistant greeting (customer-first model)", () => {
    const msgs: ConversationMessage[] = [
      { role: "assistant", content: "Thanks for calling Spears!" },
      { role: "user", content: "I need service" },
      { role: "assistant", content: "Happy to help." },
    ];
    const t = toJudgeTranscript(msgs);
    expect(t.userTurns).toEqual(["I need service"]);
    expect(t.botReplies).toEqual(["Happy to help."]);
  });

  it("drops system messages", () => {
    const msgs: ConversationMessage[] = [
      { role: "system", content: "session start" },
      { role: "user", content: "hi" },
      { role: "assistant", content: "Hi there." },
    ];
    const t = toJudgeTranscript(msgs);
    expect(t.userTurns).toEqual(["hi"]);
    expect(t.botReplies).toEqual(["Hi there."]);
  });

  it("returns empty aligned arrays for an empty/greeting-only transcript", () => {
    expect(toJudgeTranscript([])).toEqual({
      description: "Real call transcript",
      userTurns: [],
      botReplies: [],
    });
    const greetingOnly = toJudgeTranscript([{ role: "assistant", content: "Hello!" }]);
    expect(greetingOnly.userTurns).toEqual([]);
    expect(greetingOnly.botReplies).toEqual([]);
  });

  it("uses a provided description", () => {
    const t = toJudgeTranscript([{ role: "user", content: "x" }], "Call 123");
    expect(t.description).toBe("Call 123");
  });
});
