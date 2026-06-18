import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  generateTextMock,
  insertMock,
  updateSetMock,
  selectLimitMock,
  escalateMock,
  routeMock,
  extractAllContactMock,
  extractAddressAtAddressStepMock,
  extractSpokenPhoneMock,
  detectCorrectionMock,
  getRouterConfigMock,
  submitSessionMock,
} = vi.hoisted(() => ({
  generateTextMock: vi.fn(),
  insertMock: vi.fn(),
  updateSetMock: vi.fn(),
  // Backs db.select().from(...).where(...).limit(n) in all paths.
  // Default: returns [] (no flagged customer row). Override per-test to inject a
  // doNotService row for the WS2 gate test.
  selectLimitMock: vi.fn().mockResolvedValue([]),
  escalateMock: vi.fn(),
  routeMock: vi.fn(),
  extractAllContactMock: vi.fn(),
  extractAddressAtAddressStepMock: vi.fn(),
  extractSpokenPhoneMock: vi.fn(),
  detectCorrectionMock: vi.fn(),
  getRouterConfigMock: vi.fn(),
  submitSessionMock: vi.fn(),
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
    select: () => ({
      from: () => ({
        where: () => ({ limit: selectLimitMock }),
        orderBy: () => selectLimitMock(),
      }),
    }),
  },
}));
vi.mock("@/lib/db/schema", () => ({ customerSessions: {}, messages: {}, customers: {} }));
vi.mock("@/lib/db/tenant", () => ({ withTenant: (..._a: unknown[]) => ({}) }));

vi.mock("./escalate-service", () => ({ escalateSession: escalateMock }));
vi.mock("./intent-router", () => ({ routeMessage: routeMock }));
vi.mock("./slot-extract", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./slot-extract")>();
  return {
    ...actual,
    extractAddressAtAddressStep: extractAddressAtAddressStepMock,
  };
});
vi.mock("./extract-all-contact", () => ({
  extractAllContactFields: extractAllContactMock,
}));
vi.mock("./extract-spoken-phone", () => ({
  extractSpokenPhone: extractSpokenPhoneMock,
}));
vi.mock("./detect-correction", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./detect-correction")>();
  return {
    ...actual,
    detectCorrection: detectCorrectionMock,
  };
});
// The shared submission module pulls in the full admin/db dependency chain —
// mock it at the boundary (auto-submit success by default; per-test overrides).
vi.mock("@/lib/requests/submit-session-request", () => ({
  submitSessionServiceRequest: submitSessionMock,
}));
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
  return { name: null, address: null, phone: null, email: null };
}

describe("voiceReply", () => {
  beforeEach(() => {
    generateTextMock.mockReset();
    insertMock.mockReset();
    updateSetMock.mockReset();
    selectLimitMock.mockReset();
    selectLimitMock.mockResolvedValue([]);
    escalateMock.mockReset();
    routeMock.mockReset();
    extractAllContactMock.mockReset();
    extractAddressAtAddressStepMock.mockReset();
    extractSpokenPhoneMock.mockReset();
    detectCorrectionMock.mockReset();
    getRouterConfigMock.mockReset();
    getRouterConfigMock.mockResolvedValue({});
    submitSessionMock.mockReset();
    submitSessionMock.mockResolvedValue({
      ok: true,
      referenceNumber: "HVAC-TEST",
      serviceRequestId: "sr-test",
    });
    extractAllContactMock.mockReturnValue(noSlots());
    extractAddressAtAddressStepMock.mockReturnValue(null);
    extractSpokenPhoneMock.mockReturnValue(null);
    detectCorrectionMock.mockReturnValue(null);
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
    extractAllContactMock.mockReturnValue({
      name: null,
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

  it("fills the address slot from a spoken-form address at the address step and does NOT re-ask the address", async () => {
    // REGRESSION (the looping bug): voice captured slots via extractSlots, whose
    // address matcher is the STRICT suffix/ZIP-anchored extractor. A spoken
    // address Twilio transcribes ("123 Main Street Johnson City Tennessee" — no
    // comma, no ZIP) never matched, the address slot never filled, and
    // voiceNextSlotPrompt re-asked the address forever. Voice now uses the
    // permissive at-step matcher when triage is at the address step.
    const spoken = "123 Main Street Johnson City Tennessee";
    // Strict multi-field extractor still misses the spoken form…
    extractAllContactMock.mockReturnValue({
      name: null,
      address: null,
      phone: null,
      email: null,
    });
    // …but the permissive at-step matcher captures it.
    extractAddressAtAddressStepMock.mockReturnValue(spoken);

    // A canned ANSWER verdict — the kind that used to get re-spoken and stall the
    // call. With a slot just provided, voice should advance instead.
    routeMock.mockReturnValue({
      action: "ANSWER",
      intentId: "smalltalk",
      confidence: 0.5,
      reply: "Thanks for that.",
      issueType: null,
      urgency: null,
      escalate: false,
    });

    const session = {
      ...baseSession,
      // Safety implicitly passed; issue + urgency known; qualifying questions
      // answered; address still null → triage's pending step is `address`, so
      // this turn's spoken reply is captured via extractAddressAtAddressStep.
      // After capture the merged address is filled, so voiceNextSlotPrompt
      // advances past address — proving the loop is broken (no re-ask).
      metadata: JSON.stringify({
        issueType: "cooling_not_working",
        urgency: "high",
        address: null,
        customerName: null,
        customerPhone: null,
        customerEmail: null,
        description: "ac out",
        isHvacRelated: true,
        systemDownStatus: "fully_down",
        problemDuration: "today",
        addressVerified: "yes",
      }),
    };

    const result = await voiceReply({
      session,
      history: [{ role: "user", content: "my ac is out" }],
      userMessage: spoken,
      ipAddress: "1.2.3.4",
    });

    expect(generateTextMock).not.toHaveBeenCalled();
    // The address slot was captured and persisted (loop broken).
    const persisted = updateSetMock.mock.calls
      .map((c) => c[0] as { metadata?: string })
      .find((s) => typeof s.metadata === "string");
    expect(persisted?.metadata).toContain("123 Main Street");
    // And the reply is NOT the bare service-address question again — the call
    // advances to the next missing slot (the phone number).
    expect(result.reply).not.toContain(
      "What's the service address where you'd like the technician",
    );
    expect(result.reply.toLowerCase()).toContain("phone");
    expect(result.endCall).toBe(false);
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

  it("captures a residual name spoken alongside a phone in one utterance", async () => {
    routeMock.mockReturnValue({
      action: "FALLBACK_LLM",
      intentId: null,
      confidence: 0,
      reply: null,
      issueType: "cooling_not_working",
      urgency: "high",
      escalate: false,
    });
    // "Ray Chen, 865-555-1212" → name + phone in one turn (web-chat parity).
    extractAllContactMock.mockReturnValue({
      name: "Ray Chen",
      address: null,
      phone: "865-555-1212",
      email: null,
    });

    const session = {
      ...baseSession,
      metadata: JSON.stringify({
        issueType: "cooling_not_working",
        urgency: "high",
        address: "3501 W Market St, Johnson City, TN 37604 12345",
        customerName: null,
        customerPhone: null,
        customerEmail: null,
        description: "ac out",
        isHvacRelated: true,
      }),
    };

    await voiceReply({
      session,
      history: [{ role: "user", content: "my ac is out" }],
      userMessage: "Ray Chen, 865-555-1212",
      ipAddress: "1.2.3.4",
    });

    const persisted = updateSetMock.mock.calls
      .map((c) => c[0] as { metadata?: string })
      .find((s) => typeof s.metadata === "string");
    // Both the name and the phone landed in the persisted extraction (phone is
    // stored normalized, so assert on digits).
    expect(persisted?.metadata).toContain("Ray Chen");
    expect((persisted?.metadata ?? "").replace(/\D/g, "")).toContain(
      "8655551212",
    );
  });

  it("captures a digit-by-digit spoken phone at the phone step", async () => {
    routeMock.mockReturnValue({
      action: "FALLBACK_LLM",
      intentId: null,
      confidence: 0,
      reply: null,
      issueType: "cooling_not_working",
      urgency: "high",
      escalate: false,
    });
    // The grouped regex misses the spelled-out form…
    extractAllContactMock.mockReturnValue({
      name: null,
      address: null,
      phone: null,
      email: null,
    });
    // …but the spoken-phone fallback (gated to the phone step) captures it.
    extractSpokenPhoneMock.mockReturnValue("865-555-1212");

    const session = {
      ...baseSession,
      // issue + urgency + a complete address known → triage's pending step is phone.
      metadata: JSON.stringify({
        issueType: "cooling_not_working",
        urgency: "high",
        address: "3501 W Market St, Johnson City, TN 37604 12345",
        customerName: null,
        customerPhone: null,
        customerEmail: null,
        description: "ac out",
        isHvacRelated: true,
        systemDownStatus: "fully_down",
        problemDuration: "today",
      }),
    };

    await voiceReply({
      session,
      history: [{ role: "user", content: "my ac is out" }],
      userMessage: "eight six five, five five five, one two one two",
      ipAddress: "1.2.3.4",
    });

    expect(extractSpokenPhoneMock).toHaveBeenCalled();
    const persisted = updateSetMock.mock.calls
      .map((c) => c[0] as { metadata?: string })
      .find((s) => typeof s.metadata === "string");
    // Stored normalized — assert on digits.
    expect((persisted?.metadata ?? "").replace(/\D/g, "")).toContain(
      "8655551212",
    );
  });

  it("applies and acknowledges a mid-call correction", async () => {
    routeMock.mockReturnValue({
      action: "FALLBACK_LLM",
      intentId: null,
      confidence: 0,
      reply: null,
      issueType: "cooling_not_working",
      urgency: "high",
      escalate: false,
    });
    extractAllContactMock.mockReturnValue({
      name: null,
      address: null,
      phone: null,
      email: null,
    });
    // The caller corrects their already-stored address. Phone is still missing,
    // so intake isn't complete and the ack (not the confirm) should be spoken.
    detectCorrectionMock.mockReturnValue({
      field: "address",
      value: "999 New Street, Johnson City, TN 37601 99999",
    });

    const session = {
      ...baseSession,
      metadata: JSON.stringify({
        issueType: "cooling_not_working",
        urgency: "high",
        address: "3501 W Market St, Johnson City, TN 37604 12345",
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
      userMessage: "actually the address is 999 New Street, Johnson City TN 37601",
      ipAddress: "1.2.3.4",
    });

    const persisted = updateSetMock.mock.calls
      .map((c) => c[0] as { metadata?: string })
      .find((s) => typeof s.metadata === "string");
    // The corrected address replaced the old one.
    expect(persisted?.metadata).toContain("999 New Street");
    expect(persisted?.metadata).not.toContain("3501 W Market St");
    // And the caller heard an acknowledgement of the change.
    expect(result.reply.toLowerCase()).toContain("updated your address");
  });

  it("does not store an enrichment answer as the caller's name (pendingStep=name misalignment)", async () => {
    // REGRESSION: raw nextTriageStep reports `name` as pending whenever the name
    // slot is empty, but voice SKIPS the name step. detectCorrection treats a
    // pending `name` step as a direct name answer, so a caller answering the
    // system-type question with "boiler" would have "boiler" stored as their
    // name. Voice must never pass name/email as the pending step to
    // detectCorrection — guard asserted directly on the call argument.
    routeMock.mockReturnValue({
      action: "FALLBACK_LLM",
      intentId: null,
      confidence: 0,
      reply: null,
      issueType: "cooling_not_working",
      urgency: "high",
      escalate: false,
    });
    extractAllContactMock.mockReturnValue({
      name: null,
      address: null,
      phone: null,
      email: null,
    });
    detectCorrectionMock.mockReturnValue(null);
    // With name pending (voice skips it) and nothing captured, the turn defers
    // to the LLM — mock it so the call completes and we can inspect the args.
    generateTextMock.mockResolvedValue({
      text: "Got it. Anything else?",
      usage: { inputTokens: 5, outputTokens: 3 },
    });

    const session = {
      ...baseSession,
      // address + phone filled, name empty → raw nextTriageStep returns `name`.
      metadata: JSON.stringify({
        issueType: "cooling_not_working",
        urgency: "high",
        address: "3501 W Market St, Johnson City, TN 37604 12345",
        customerName: null,
        customerPhone: "865-555-1212",
        customerEmail: null,
        description: "ac out",
        isHvacRelated: true,
        systemDownStatus: "fully_down",
        problemDuration: "today",
      }),
    };

    await voiceReply({
      session,
      history: [{ role: "user", content: "my ac is out" }],
      userMessage: "boiler",
      ipAddress: "1.2.3.4",
    });

    // detectCorrection must NOT have been invoked with the `name` (or `email`)
    // step id — that is what triggers its name-direct-answer branch.
    for (const call of detectCorrectionMock.mock.calls) {
      expect(call[1]).not.toBe("name");
      expect(call[1]).not.toBe("email");
    }
  });

  it("latches an unrecognized optional-enrichment answer as skipped (no re-ask)", async () => {
    routeMock.mockReturnValue({
      action: "FALLBACK_LLM",
      intentId: null,
      confidence: 0,
      reply: null,
      issueType: "cooling_not_working",
      urgency: "high",
      escalate: false,
    });
    extractAllContactMock.mockReturnValue({
      name: null,
      address: null,
      phone: null,
      email: null,
    });

    const session = {
      ...baseSession,
      // Every required core/contact slot filled so triage's pending step is an
      // optional enrichment step voice asks (Step 15: cooling_not_working now
      // leads with vulnerable_occupants).
      metadata: JSON.stringify({
        issueType: "cooling_not_working",
        urgency: "high",
        address: "3501 W Market St, Johnson City, TN 37604 12345",
        customerName: "Ray Chen",
        customerPhone: "865-555-1212",
        customerEmail: "ray@example.com",
        description: "ac out",
        isHvacRelated: true,
        systemDownStatus: "fully_down",
        problemDuration: "today",
      }),
    };

    await voiceReply({
      session,
      history: [{ role: "user", content: "my ac is out" }],
      // An answer captureEnrichmentAnswer won't recognize as a system type.
      userMessage: "I really have no clue what it is honestly",
      ipAddress: "1.2.3.4",
    });

    const persisted = updateSetMock.mock.calls
      .map((c) => c[0] as { metadata?: string })
      .find((s) => typeof s.metadata === "string");
    // The optional enrichment step latched to the skip sentinel so it won't be
    // re-asked (vulnerableOccupants for cooling, per the Step 15 plan).
    expect(persisted?.metadata).toContain("__skipped__");
  });
});

describe("VOICE_CONFIRM_REPLY", () => {
  it("does not reference tapping a button", () => {
    expect(VOICE_CONFIRM_REPLY.toLowerCase()).not.toContain("tap");
  });
});

describe("voiceReply output guardrail (WS1)", () => {
  beforeEach(() => {
    generateTextMock.mockReset();
    insertMock.mockReset();
    updateSetMock.mockReset();
    selectLimitMock.mockReset();
    selectLimitMock.mockResolvedValue([]);
    escalateMock.mockReset();
    routeMock.mockReset();
    extractAllContactMock.mockReset();
    extractAddressAtAddressStepMock.mockReset();
    extractSpokenPhoneMock.mockReset();
    detectCorrectionMock.mockReset();
    getRouterConfigMock.mockReset();
    getRouterConfigMock.mockResolvedValue({});
    submitSessionMock.mockReset();
    extractAllContactMock.mockReturnValue(noSlots());
    extractAddressAtAddressStepMock.mockReturnValue(null);
    extractSpokenPhoneMock.mockReturnValue(null);
    detectCorrectionMock.mockReturnValue(null);
  });

  it("screens an unsafe LLM reply before speaking/persisting it", async () => {
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
      text: "Great, you're all booked for Tuesday and it'll be $200.",
      usage: { inputTokens: 5, outputTokens: 5 },
    });
    const result = await voiceReply({
      session: baseSession,
      history: [{ role: "user", content: "random question the router won't route" }],
      userMessage: "tell me a joke about my account please",
      ipAddress: "127.0.0.1",
    });
    expect(result.reply).not.toMatch(/\$\s?\d/);
    expect(result.reply.toLowerCase()).not.toContain("booked");
    // The persisted assistant message should also be screened.
    const assistantInsert = insertMock.mock.calls
      .map((c: unknown[]) => c[0] as Record<string, unknown>)
      .find((m) => m.role === "assistant");
    expect(String(assistantInsert?.content)).not.toMatch(/\$\s?\d/);
    expect(String(assistantInsert?.content).toLowerCase()).not.toContain("booked");
  });
});

describe("voiceReply do-not-service (WS2)", () => {
  beforeEach(() => {
    generateTextMock.mockReset();
    insertMock.mockReset();
    updateSetMock.mockReset();
    selectLimitMock.mockReset();
    selectLimitMock.mockResolvedValue([]);
    escalateMock.mockReset();
    routeMock.mockReset();
    extractAllContactMock.mockReset();
    extractAddressAtAddressStepMock.mockReset();
    extractSpokenPhoneMock.mockReset();
    detectCorrectionMock.mockReset();
    getRouterConfigMock.mockReset();
    getRouterConfigMock.mockResolvedValue({});
    submitSessionMock.mockReset();
    extractAllContactMock.mockReturnValue(noSlots());
    extractAddressAtAddressStepMock.mockReturnValue(null);
    extractSpokenPhoneMock.mockReturnValue(null);
    detectCorrectionMock.mockReturnValue(null);
  });

  it("refuses + ends the call when the resolved caller is flagged", async () => {
    // Arrange: a customerId on the session + a customers row with doNotService=true.
    selectLimitMock.mockResolvedValue([{ doNotService: true }]);
    routeMock.mockReturnValue({
      action: "FALLBACK_LLM",
      intentId: null,
      confidence: 0,
      reply: null,
      issueType: null,
      urgency: null,
      escalate: false,
    });
    const result = await voiceReply({
      session: { id: "s1", organizationId: "o1", status: "chatting", turnCount: 1, maxTurns: 40, metadata: null, customerId: "c-flagged" },
      history: [],
      userMessage: "my ac is broken",
      ipAddress: "127.0.0.1",
    });
    expect(result.endCall).toBe(true);
    expect(result.reply.toLowerCase()).toContain("office");
  });
});
