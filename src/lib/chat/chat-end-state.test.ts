import { describe, it, expect } from "vitest";
import { chatEndActions, EMERGENCY_GENERIC_GUIDANCE } from "./chat-end-state";

describe("chatEndActions", () => {
  it("keeps an active chat open with the normal escalate dialog", () => {
    for (const status of ["chatting", "extracting", "confirmed"] as const) {
      const a = chatEndActions({ status, urgency: "emergency", phone: "423-555-0100" });
      expect(a.panel).toBeNull();
      expect(a.inputDisabled).toBe(false);
      expect(a.inputNote).toBeNull();
      expect(a.talkToHuman).toBe("dialog");
    }
  });

  it("emergency + org phone: emergency panel with tap-to-call, Talk to a human calls", () => {
    const a = chatEndActions({
      status: "escalated",
      urgency: "emergency",
      phone: "(423) 555-0100",
    });
    expect(a.panel?.kind).toBe("emergency");
    expect(a.panel?.body).toContain("(423) 555-0100");
    // Both lines: the 911 / gas company line AND our call button (N-P1-5).
    expect(a.panel?.guidance).toBe(EMERGENCY_GENERIC_GUIDANCE);
    expect(EMERGENCY_GENERIC_GUIDANCE).toBe(
      "If you smell gas, leave now and call 911 or your gas company from outside.",
    );
    // The panel no longer repeats the "This chat is closed" input note.
    expect(a.panel?.body).not.toMatch(/chat is closed/);
    expect(a.callHref).toBe("tel:4235550100");
    expect(a.talkToHuman).toBe("call");
    expect(a.inputDisabled).toBe(true);
    expect(a.inputNote).toMatch(/closed so our team can take over/);
  });

  it("emergency without an org phone: generic safety line, Talk to a human still enabled", () => {
    const a = chatEndActions({ status: "escalated", urgency: "emergency", phone: null });
    expect(a.panel?.kind).toBe("emergency");
    expect(a.panel?.guidance).toBe(EMERGENCY_GENERIC_GUIDANCE);
    expect(a.callHref).toBeNull();
    expect(a.talkToHuman).toBe("show-panel");
    expect(a.talkToHuman).not.toBe("disabled");
  });

  it("treats a phone with no digits as no phone", () => {
    const a = chatEndActions({ status: "escalated", urgency: "emergency", phone: "  call us " });
    expect(a.callHref).toBeNull();
    expect(a.phone).toBeNull();
    expect(a.panel?.guidance).toBe(EMERGENCY_GENERIC_GUIDANCE);
  });

  it("non-emergency escalation: handoff panel, never the emergency copy", () => {
    const a = chatEndActions({ status: "escalated", urgency: "medium", phone: "423-555-0100" });
    expect(a.panel?.kind).toBe("handoff");
    expect(a.panel?.guidance).toBeNull();
    expect(a.talkToHuman).toBe("call");
    const none = chatEndActions({ status: "escalated", urgency: null, phone: null });
    expect(none.panel?.kind).toBe("handoff");
    expect(none.talkToHuman).toBe("show-panel");
  });

  it("submitted / abandoned: no panel, locked input with a reason", () => {
    const s = chatEndActions({ status: "submitted", urgency: "high", phone: null });
    expect(s.panel).toBeNull();
    expect(s.inputDisabled).toBe(true);
    expect(s.inputNote).toMatch(/request is in/);
    expect(s.talkToHuman).toBe("disabled");
    const ab = chatEndActions({ status: "abandoned", urgency: null, phone: "423-555-0100" });
    expect(ab.inputNote).toMatch(/ended/);
    expect(ab.talkToHuman).toBe("call");
  });
});
