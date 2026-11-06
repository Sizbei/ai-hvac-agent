import { describe, it, expect } from "vitest";
import { shouldResumeSession, parseResumedExtraction } from "./session-resume";
import { chatEndActions } from "./chat-end-state";

describe("shouldResumeSession", () => {
  it("resumes active and escalated sessions that have a transcript", () => {
    expect(shouldResumeSession("chatting", 2)).toBe(true);
    expect(shouldResumeSession("extracting", 5)).toBe(true);
    expect(shouldResumeSession("escalated", 3)).toBe(true);
  });
  it("starts fresh for empty or finished sessions", () => {
    expect(shouldResumeSession("escalated", 0)).toBe(false);
    expect(shouldResumeSession("submitted", 4)).toBe(false);
    expect(shouldResumeSession("abandoned", 4)).toBe(false);
    expect(shouldResumeSession("confirmed", 4)).toBe(false);
  });
});

describe("parseResumedExtraction", () => {
  it("reads the slots the escalation path persisted", () => {
    const meta = JSON.stringify({ issueType: "gas_leak", urgency: "emergency", address: null });
    expect(parseResumedExtraction(meta)?.urgency).toBe("emergency");
  });
  it("returns null for missing or non-extraction metadata", () => {
    expect(parseResumedExtraction(null)).toBeNull();
    expect(parseResumedExtraction("not json")).toBeNull();
    expect(parseResumedExtraction(JSON.stringify({ verify: {} }))).toBeNull();
  });
  it("a reloaded gas emergency still shows the emergency panel", () => {
    const meta = JSON.stringify({ issueType: "gas_leak", urgency: "emergency" });
    const extraction = parseResumedExtraction(meta);
    const a = chatEndActions({
      status: "escalated",
      urgency: extraction?.urgency,
      phone: "(423) 555-0142",
    });
    expect(a.panel?.kind).toBe("emergency");
    expect(a.callHref).toBeTruthy();
  });
});
