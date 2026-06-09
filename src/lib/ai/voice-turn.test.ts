import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  generateTextMock,
  insertMock,
  updateSetMock,
  escalateMock,
  routeMock,
  extractSlotsMock,
  getRouterConfigMock,
} = vi.hoisted(() => ({
  generateTextMock: vi.fn(),
  insertMock: vi.fn(),
  updateSetMock: vi.fn(),
  escalateMock: vi.fn(),
  routeMock: vi.fn(),
  extractSlotsMock: vi.fn(),
  getRouterConfigMock: vi.fn(),
}));

vi.mock("ai", () => ({ generateText: generateTextMock }));
vi.mock("./provider", () => ({
  getModel: () => "chat-model",
  getExtractionModel: () => "ext-model",
}));

vi.mock("@/lib/db", () => ({
  db: {
    insert: () => ({
      values: (v: unknown) => {
        insertMock(v);
        return Promise.resolve();
      },
    }),
    update: () => ({
      set: (v: unknown) => {
        updateSetMock(v);
        return { where: () => Promise.resolve() };
      },
    }),
  },
}));
vi.mock("@/lib/db/schema", () => ({ customerSessions: {}, messages: {} }));

vi.mock("./escalate-service", () => ({ escalateSession: escalateMock }));
vi.mock("./intent-router", () => ({ routeMessage: routeMock }));
vi.mock("./slot-extract", () => ({ extractSlots: extractSlotsMock }));
vi.mock("@/lib/admin/org-config-queries", () => ({
  getRouterConfig: getRouterConfigMock,
}));

import { voiceReply, VOICE_CONFIRM_REPLY } from "./voice-turn";

const baseSession = {
  id: "sess-1",
  organizationId: "org-1",
  status: "chatting" as const,
  turnCount: 1,
  maxTurns: 40,
  metadata: null as string | null,
};

function noSlots() {
  return { address: null, phone: null, email: null };
}

describe("voiceReply", () => {
  beforeEach(() => {
    generateTextMock.mockReset();
    insertMock.mockReset();
    updateSetMock.mockReset();
    escalateMock.mockReset();
    routeMock.mockReset();
    extractSlotsMock.mockReset();
    getRouterConfigMock.mockReset();
    getRouterConfigMock.mockResolvedValue({});
    extractSlotsMock.mockReturnValue(noSlots());
  });

  it("returns a spoken canned reply on a deterministic ANSWER (no LLM, no markdown)", async () => {
    routeMock.mockReturnValue({
      action: "ANSWER",
      intentId: "hours",
      confidence: 0.9,
      reply: "**We're open** 8 to 5.\n\nIf you'd prefer to speak with a human, tap “Talk to a Human”.",
      issueType: null,
      urgency: null,
      escalate: false,
    });

    const result = await voiceReply({
      session: baseSession,
      history: [],
      userMessage: "what are your hours",
      ipAddress: "1.2.3.4",
    });

    expect(generateTextMock).not.toHaveBeenCalled();
    expect(result.reply).not.toContain("**");
    expect(result.reply.toLowerCase()).not.toContain("tap");
    expect(result.reply).toContain("8 to 5");
    expect(result.endCall).toBe(false);
    // persisted an assistant message
    expect(insertMock).toHaveBeenCalled();
  });

  it("escalates and ends the call on an emergency verdict", async () => {
    routeMock.mockReturnValue({
      action: "ESCALATE",
      intentId: "gas_smell",
      confidence: 1,
      reply: "Please leave the building now.",
      issueType: "other",
      urgency: "emergency",
      escalate: true,
    });
    escalateMock.mockResolvedValue({ ok: true });

    const result = await voiceReply({
      session: baseSession,
      history: [],
      userMessage: "i smell gas",
      ipAddress: "1.2.3.4",
    });

    expect(escalateMock).toHaveBeenCalled();
    expect(result.reply.toLowerCase()).toContain("leave the building");
    expect(result.endCall).toBe(true);
  });

  it("completes a voice intake without email/name (voice gate excludes them)", async () => {
    // REGRESSION: making email REQUIRED for web broke voice — isExtractionComplete
    // required an email voice never collects, so a call could never wrap up. Voice
    // uses isVoiceExtractionComplete (issue+urgency+address+phone), so a phone
    // intake with those four reaches VOICE_CONFIRM_REPLY even with no email/name.
    routeMock.mockReturnValue({
      action: "FALLBACK_LLM", // not an ANSWER — drive completion off slots, not a canned reply
      intentId: null,
      confidence: 0,
      reply: null,
      issueType: "cooling_not_working",
      urgency: "high",
      escalate: false,
    });
    // The caller's final turn supplies the phone; address already known.
    extractSlotsMock.mockReturnValue({
      address: "3501 W Market St, Johnson City, TN 37604",
      phone: "(423) 854-9505",
      email: null,
    });

    const session = {
      ...baseSession,
      // issue + urgency already captured; address present; phone arrives this turn.
      metadata: JSON.stringify({
        issueType: "cooling_not_working",
        urgency: "high",
        address: "3501 W Market St, Johnson City, TN 37604",
        customerName: null,
        customerPhone: null,
        customerEmail: null,
        description: "ac out",
        isHvacRelated: true,
      }),
    };

    const result = await voiceReply({
      session,
      history: [{ role: "user", content: "my ac is out" }],
      userMessage: "my number is 423-854-9505",
      ipAddress: "1.2.3.4",
    });

    expect(generateTextMock).not.toHaveBeenCalled();
    expect(result.reply).toContain("everything I need");
    expect(result.reply.toLowerCase()).not.toContain("tap");
  });

  it("falls back to a non-streaming LLM call when the router defers", async () => {
    routeMock.mockReturnValue({
      action: "FALLBACK_LLM",
      intentId: null,
      confidence: 0,
      reply: null,
      issueType: null,
      urgency: null,
      escalate: false,
    });
    generateTextMock.mockResolvedValue({
      text: "Tell me more about the noise.",
      usage: { inputTokens: 10, outputTokens: 5 },
    });

    const result = await voiceReply({
      session: baseSession,
      history: [{ role: "user", content: "my furnace is loud" }],
      userMessage: "it rattles",
      ipAddress: "1.2.3.4",
    });

    expect(generateTextMock).toHaveBeenCalledTimes(1);
    // phone persona is used
    const call = generateTextMock.mock.calls[0][0];
    expect(call.system.toLowerCase()).toContain("phone");
    expect(result.reply).toContain("noise");
    expect(result.endCall).toBe(false);
  });
});

describe("VOICE_CONFIRM_REPLY", () => {
  it("does not reference tapping a button", () => {
    expect(VOICE_CONFIRM_REPLY.toLowerCase()).not.toContain("tap");
  });
});
