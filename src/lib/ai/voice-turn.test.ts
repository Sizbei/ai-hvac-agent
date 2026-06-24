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
  buildAccountLookupReplyMock,
  decryptMock,
  decideAfterHoursDisclosureMock,
  loadCustomerContextByIdMock,
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
  buildAccountLookupReplyMock: vi.fn(),
  decryptMock: vi.fn(),
  // After-hours disclosure helper mock (WS4). Default: no after-hours.
  decideAfterHoursDisclosureMock: vi.fn().mockReturnValue({ kind: "none", afterHours: false, copy: "" }),
  // Returning-customer context loader (parity Stage 3). Default: no match.
  loadCustomerContextByIdMock: vi.fn().mockResolvedValue(null),
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
vi.mock("@/lib/db/schema", () => ({ customerSessions: {}, messages: {}, customers: {}, customerLocations: {}, organizationSettings: {} }));
vi.mock("@/lib/db/tenant", () => ({ withTenant: (..._a: unknown[]) => ({}) }));
vi.mock("./account-dispatch", () => ({
  buildAccountLookupReply: buildAccountLookupReplyMock,
}));
vi.mock("@/lib/crypto", () => ({
  decrypt: decryptMock,
}));
// After-hours mocks (WS4): resolveAfterHoursConfig is a pass-through (returns the
// stored value unchanged for tests), and decideAfterHoursDisclosure is controlled
// per-test via decideAfterHoursDisclosureMock. Default is no after-hours ("none").
vi.mock("@/lib/admin/after-hours", () => ({
  resolveAfterHoursConfig: (v: unknown) => v ?? { enabled: false, startHour: 8, endHour: 18, weekendsAreAfterHours: false, timezone: "UTC" },
}));
vi.mock("./after-hours-chat", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./after-hours-chat")>();
  return {
    // Keep the real pure helpers (e.g. inferBookingTarget); only the
    // decision is controlled per-test.
    ...actual,
    decideAfterHoursDisclosure: (...args: unknown[]) => decideAfterHoursDisclosureMock(...args),
  };
});

// Returning-customer recognition (parity Stage 3): the loader is controlled
// per-test; buildCustomerContextHint is a simple marker so we can assert the
// hint reaches the LLM system prompt (the real hint is unit-tested separately).
vi.mock("./customer-context", () => ({
  loadCustomerContextById: loadCustomerContextByIdMock,
  buildCustomerContextHint: (ctx: unknown) => (ctx ? " [RETURNING_CUSTOMER]" : ""),
}));

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
vi.mock("./extract-spoken-phone", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./extract-spoken-phone")>();
  return {
    ...actual,
    extractSpokenPhone: extractSpokenPhoneMock,
  };
});
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
    buildAccountLookupReplyMock.mockReset();
    buildAccountLookupReplyMock.mockResolvedValue(null);
    decryptMock.mockReset();
    decryptMock.mockImplementation((s: string) => s);
    decideAfterHoursDisclosureMock.mockReset();
    decideAfterHoursDisclosureMock.mockReturnValue({ kind: "none", afterHours: false, copy: "" });
    loadCustomerContextByIdMock.mockReset();
    loadCustomerContextByIdMock.mockResolvedValue(null);
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

  it("injects the returning-customer hint into the LLM prompt when the call resolved to a known customer", async () => {
    routeMock.mockReturnValue({
      action: "FALLBACK_LLM",
      intentId: null,
      confidence: 0,
      reply: null,
      issueType: null,
      urgency: null,
      escalate: false,
    });
    loadCustomerContextByIdMock.mockResolvedValue({
      customerId: "cust-1",
      isReturning: true,
      priorRequestCount: 2,
      firstName: "Jane",
    });
    generateTextMock.mockResolvedValue({
      text: "Welcome back! Tell me more.",
      usage: { inputTokens: 10, outputTokens: 5 },
    });

    const result = await voiceReply({
      session: { ...baseSession, customerId: "cust-1" },
      history: [{ role: "user", content: "my furnace is loud" }],
      userMessage: "it rattles",
      ipAddress: "1.2.3.4",
    });

    expect(loadCustomerContextByIdMock).toHaveBeenCalledWith("org-1", "cust-1");
    const call = generateTextMock.mock.calls[0][0];
    expect(call.system).toContain("[RETURNING_CUSTOMER]");
    expect(result.endCall).toBe(false);
  });

  it("adds no customer hint when the call did not resolve to a customer", async () => {
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
      text: "Tell me more.",
      usage: { inputTokens: 10, outputTokens: 5 },
    });

    await voiceReply({
      session: baseSession, // no customerId
      history: [{ role: "user", content: "my furnace is loud" }],
      userMessage: "it rattles",
      ipAddress: "1.2.3.4",
    });

    expect(loadCustomerContextByIdMock).not.toHaveBeenCalled();
    const call = generateTextMock.mock.calls[0][0];
    expect(call.system).not.toContain("[RETURNING_CUSTOMER]");
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
    buildAccountLookupReplyMock.mockReset();
    buildAccountLookupReplyMock.mockResolvedValue(null);
    decryptMock.mockReset();
    decryptMock.mockImplementation((s: string) => s);
    decideAfterHoursDisclosureMock.mockReset();
    decideAfterHoursDisclosureMock.mockReturnValue({ kind: "none", afterHours: false, copy: "" });
    loadCustomerContextByIdMock.mockReset();
    loadCustomerContextByIdMock.mockResolvedValue(null);
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
    buildAccountLookupReplyMock.mockReset();
    buildAccountLookupReplyMock.mockResolvedValue(null);
    decryptMock.mockReset();
    decryptMock.mockImplementation((s: string) => s);
    decideAfterHoursDisclosureMock.mockReset();
    decideAfterHoursDisclosureMock.mockReturnValue({ kind: "none", afterHours: false, copy: "" });
    loadCustomerContextByIdMock.mockReset();
    loadCustomerContextByIdMock.mockResolvedValue(null);
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
    // The gate must fire EARLY — before any router/LLM work runs.
    expect(routeMock).not.toHaveBeenCalled();
    expect(generateTextMock).not.toHaveBeenCalled();
  });
});

describe("voiceReply financial verify (WS3)", () => {
  // Common setup for the financial verify tests: customerId present, balance intent.
  const balanceSession = {
    id: "s-verify",
    organizationId: "o1",
    status: "chatting" as const,
    turnCount: 1,
    maxTurns: 40,
    metadata: null as string | null,
    customerId: "c-verify",
  };

  function resetWS3Mocks() {
    generateTextMock.mockReset();
    insertMock.mockReset();
    updateSetMock.mockReset();
    selectLimitMock.mockReset();
    // By default: not flagged (doNotService=false), then customer row w/ZIP, then no locations.
    selectLimitMock
      .mockResolvedValueOnce([{ doNotService: false }]) // do-not-service gate
      .mockResolvedValueOnce([{ addressEncrypted: "212 E Unaka Ave, Johnson City, TN 37601" }]) // customer address
      .mockResolvedValue([]); // customerLocations
    escalateMock.mockReset();
    routeMock.mockReset();
    routeMock.mockReturnValue({
      action: "ACCOUNT_LOOKUP",
      intentId: "account-data-balance",
      confidence: 0.95,
      reply: null,
      issueType: null,
      urgency: null,
      escalate: false,
    });
    extractAllContactMock.mockReset();
    extractAllContactMock.mockReturnValue(noSlots());
    extractAddressAtAddressStepMock.mockReset();
    extractAddressAtAddressStepMock.mockReturnValue(null);
    extractSpokenPhoneMock.mockReset();
    extractSpokenPhoneMock.mockReturnValue(null);
    detectCorrectionMock.mockReset();
    detectCorrectionMock.mockReturnValue(null);
    getRouterConfigMock.mockReset();
    getRouterConfigMock.mockResolvedValue({});
    submitSessionMock.mockReset();
    buildAccountLookupReplyMock.mockReset();
    // By default: returns the balance string.
    buildAccountLookupReplyMock.mockResolvedValue("Your current balance is $125.00.");
    decryptMock.mockReset();
    // decrypt just returns the input (the test address is already plaintext).
    decryptMock.mockImplementation((s: string) => s);
    decideAfterHoursDisclosureMock.mockReset();
    decideAfterHoursDisclosureMock.mockReturnValue({ kind: "none", afterHours: false, copy: "" });
  }

  beforeEach(() => {
    resetWS3Mocks();
  });

  it("asks for ZIP and does NOT read the balance on first financial ask (no verify state yet)", async () => {
    const result = await voiceReply({
      session: balanceSession,
      history: [],
      userMessage: "what is my balance",
      ipAddress: "127.0.0.1",
    });

    // Must mention ZIP and NOT speak the balance.
    expect(result.reply.toLowerCase()).toMatch(/zip/);
    expect(result.reply).not.toContain("$");
    expect(result.endCall).toBe(false);
    expect(generateTextMock).not.toHaveBeenCalled();

    // Metadata must have verify.status = "pending".
    const setCall = updateSetMock.mock.calls.find(
      (c: unknown[]) => typeof (c[0] as Record<string, unknown>).metadata === "string",
    );
    expect(setCall).toBeDefined();
    const meta = JSON.parse((setCall![0] as Record<string, unknown>).metadata as string) as Record<string, unknown>;
    const verify = meta.verify as Record<string, unknown>;
    expect(verify?.status).toBe("pending");
    expect(verify?.attempts).toBe(0);
  });

  it("serves the balance after a matching DTMF ZIP (verify passes)", async () => {
    // Session already has verify pending (asked last turn).
    const sessionWithPending = {
      ...balanceSession,
      metadata: JSON.stringify({ verify: { status: "pending", attempts: 0 } }),
    };
    // Reset the selectLimitMock chain for this test — doNotService must come first.
    selectLimitMock.mockReset();
    selectLimitMock
      .mockResolvedValueOnce([{ doNotService: false }])
      .mockResolvedValueOnce([{ addressEncrypted: "212 E Unaka Ave, Johnson City, TN 37601" }])
      .mockResolvedValue([]);

    const result = await voiceReply({
      session: sessionWithPending,
      history: [],
      userMessage: "37601", // spoken as a word (simulate DTMF as speech fallback)
      ipAddress: "127.0.0.1",
      dtmfDigits: "37601",
    });

    // The balance must be spoken.
    expect(result.reply).toContain("$125.00");
    expect(result.endCall).toBe(false);

    // Metadata must have verify.status = "passed".
    const setCall = updateSetMock.mock.calls.find(
      (c: unknown[]) => typeof (c[0] as Record<string, unknown>).metadata === "string",
    );
    expect(setCall).toBeDefined();
    const meta = JSON.parse((setCall![0] as Record<string, unknown>).metadata as string) as Record<string, unknown>;
    const verify = meta.verify as Record<string, unknown>;
    expect(verify?.status).toBe("passed");
  });

  it("defers after 2 mismatches (MAX_VERIFY_ATTEMPTS) and does not speak balance", async () => {
    // Already had 1 failed attempt — this is the second (final) one.
    const sessionWith1Attempt = {
      ...balanceSession,
      metadata: JSON.stringify({ verify: { status: "pending", attempts: 1 } }),
    };
    selectLimitMock.mockReset();
    selectLimitMock
      .mockResolvedValueOnce([{ doNotService: false }])
      .mockResolvedValueOnce([{ addressEncrypted: "212 E Unaka Ave, Johnson City, TN 37601" }])
      .mockResolvedValue([]);

    const result = await voiceReply({
      session: sessionWith1Attempt,
      history: [],
      userMessage: "99999", // wrong ZIP
      ipAddress: "127.0.0.1",
      dtmfDigits: "99999",
    });

    // Must NOT speak the balance; must give the deferral copy.
    expect(result.reply).not.toContain("$");
    expect(result.reply.toLowerCase()).toMatch(/follow up|office|online/);
    expect(result.endCall).toBe(false);

    // Metadata must have verify.status = "failed".
    const setCall = updateSetMock.mock.calls.find(
      (c: unknown[]) => typeof (c[0] as Record<string, unknown>).metadata === "string",
    );
    expect(setCall).toBeDefined();
    const meta = JSON.parse((setCall![0] as Record<string, unknown>).metadata as string) as Record<string, unknown>;
    const verify = meta.verify as Record<string, unknown>;
    expect(verify?.status).toBe("failed");
  });

  it("falls through to FALLBACK_LLM when customerId is absent (no account lookup)", async () => {
    const sessionNoCustomer = { ...balanceSession, customerId: null as string | null };
    selectLimitMock.mockReset();
    selectLimitMock.mockResolvedValue([]);
    generateTextMock.mockResolvedValue({
      text: "I can help you with that.",
      usage: { inputTokens: 5, outputTokens: 5 },
    });

    const result = await voiceReply({
      session: sessionNoCustomer,
      history: [],
      userMessage: "what is my balance",
      ipAddress: "127.0.0.1",
    });

    // With no customerId the account lookup falls through to the LLM.
    expect(generateTextMock).toHaveBeenCalledTimes(1);
    expect(result.reply).not.toContain("$125.00");
  });

  // ── FINDING 1 REGRESSION: verify-bypass via non-financial intent ──
  // A non-financial ACCOUNT_LOOKUP must NEVER fabricate a "passed" verify state.
  // If a caller first asks "when is my next visit?" (non-financial → served with
  // no verify) and then asks "what's my balance?" (financial), the second turn
  // must gate with a ZIP ask, not serve the balance.
  it("REGRESSION F1: non-financial intent must not fabricate verify:passed that unlocks a subsequent financial intent", async () => {
    const nextVisitSession = {
      ...balanceSession,
      // session starts with NO verify state (null metadata)
      metadata: null as string | null,
    };

    // Turn 1: non-financial intent (next-visit). Route returns non-financial.
    routeMock.mockReturnValue({
      action: "ACCOUNT_LOOKUP",
      intentId: "account-data-next-visit",
      confidence: 0.9,
      reply: null,
      issueType: null,
      urgency: null,
      escalate: false,
    });
    buildAccountLookupReplyMock.mockResolvedValue("Your next visit is on Monday.");

    const turn1 = await voiceReply({
      session: nextVisitSession,
      history: [],
      userMessage: "when is my next visit",
      ipAddress: "127.0.0.1",
    });
    // Non-financial intent should be served immediately.
    expect(turn1.reply).toContain("Monday");

    // Capture the metadata written by turn 1 (should NOT be verify:passed).
    const turn1SetCall = updateSetMock.mock.calls.find(
      (c: unknown[]) => typeof (c[0] as Record<string, unknown>).metadata === "string",
    );
    const turn1MetaStr = turn1SetCall
      ? ((turn1SetCall[0] as Record<string, unknown>).metadata as string)
      : null;
    if (turn1MetaStr) {
      const turn1Meta = JSON.parse(turn1MetaStr) as Record<string, unknown>;
      const verifyAfterTurn1 = turn1Meta.verify as Record<string, unknown> | undefined;
      // If verify was written, it must NOT be "passed" — that would be the fabrication.
      expect(verifyAfterTurn1?.status).not.toBe("passed");
    }

    // Turn 2: financial intent (balance). The session now carries whatever turn 1 wrote.
    // Reset mocks but preserve the turn1 metadata as the session state.
    resetWS3Mocks();
    routeMock.mockReturnValue({
      action: "ACCOUNT_LOOKUP",
      intentId: "account-data-balance",
      confidence: 0.95,
      reply: null,
      issueType: null,
      urgency: null,
      escalate: false,
    });
    buildAccountLookupReplyMock.mockResolvedValue("Your current balance is $125.00.");

    const sessionAfterTurn1 = {
      ...nextVisitSession,
      metadata: turn1MetaStr, // whatever turn 1 persisted
    };

    const turn2 = await voiceReply({
      session: sessionAfterTurn1,
      history: [],
      userMessage: "what is my balance",
      ipAddress: "127.0.0.1",
    });

    // Turn 2 must NOT serve the balance — it must ask for ZIP (financial gate).
    expect(turn2.reply).not.toContain("$125.00");
    expect(turn2.reply.toLowerCase()).toMatch(/zip/);
    // buildAccountLookupReply should NOT have been called with data served.
    // (It may have been called and returned the sentinel — what matters is the
    // spoken reply does NOT contain the balance string.)
  });

  // ── FINDING 2 REGRESSION: verify-ask turn must produce dtmf+speech gather ──
  // Tested at the VoiceReplyResult level: nextGatherMode must be "dtmf_zip" on
  // the verify-ask path, and absent on normal (non-verify) turns.
  it("REGRESSION F2: voiceReply returns nextGatherMode='dtmf_zip' on the verify-ask turn", async () => {
    // First financial ask — no verify state yet. Must return nextGatherMode:"dtmf_zip".
    const result = await voiceReply({
      session: balanceSession,
      history: [],
      userMessage: "what is my balance",
      ipAddress: "127.0.0.1",
    });
    expect(result.nextGatherMode).toBe("dtmf_zip");
  });

  it("REGRESSION F2b: nextGatherMode is absent/undefined on a normal (non-verify) turn", async () => {
    // Non-financial intent — must NOT set nextGatherMode.
    routeMock.mockReturnValue({
      action: "ACCOUNT_LOOKUP",
      intentId: "account-data-next-visit",
      confidence: 0.9,
      reply: null,
      issueType: null,
      urgency: null,
      escalate: false,
    });
    buildAccountLookupReplyMock.mockResolvedValue("Your next visit is on Monday.");

    const result = await voiceReply({
      session: balanceSession,
      history: [],
      userMessage: "when is my next visit",
      ipAddress: "127.0.0.1",
    });
    expect(result.nextGatherMode).toBeUndefined();
  });
});

describe("voiceReply after-hours disclosure (WS4)", () => {
  // The after-hours disclosure copy from after-hours-chat.ts (number-free).
  const DISCLOSE_CHARGE_COPY =
    "Since it's after our normal hours, there's an additional after-hours service charge, and our team will confirm the details. Let's get the rest of your information so we can get someone out to you.";

  // Session with no customerId (avoids the do-not-service gate consuming
  // the first selectLimitMock call). Issue + urgency (high) known; address
  // missing → intake is in progress and the deterministic path is active.
  const intakeSession = {
    id: "s-ah",
    organizationId: "o1",
    status: "chatting" as const,
    turnCount: 1,
    maxTurns: 40,
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
    }),
  };

  function resetWS4Mocks() {
    generateTextMock.mockReset();
    insertMock.mockReset();
    updateSetMock.mockReset();
    selectLimitMock.mockReset();
    // No customerId → no do-not-service gate → selectLimitMock returns the
    // org settings row (any value works; resolveAfterHoursConfig is mocked).
    selectLimitMock.mockResolvedValue([{ afterHoursConfig: { enabled: true } }]);
    escalateMock.mockReset();
    routeMock.mockReset();
    routeMock.mockReturnValue({
      action: "FALLBACK_LLM",
      intentId: null,
      confidence: 0,
      reply: null,
      issueType: "cooling_not_working",
      urgency: "high",
      escalate: false,
    });
    extractAllContactMock.mockReset();
    extractAllContactMock.mockReturnValue(noSlots());
    extractAddressAtAddressStepMock.mockReset();
    extractAddressAtAddressStepMock.mockReturnValue(null);
    extractSpokenPhoneMock.mockReset();
    extractSpokenPhoneMock.mockReturnValue(null);
    detectCorrectionMock.mockReset();
    detectCorrectionMock.mockReturnValue(null);
    getRouterConfigMock.mockReset();
    getRouterConfigMock.mockResolvedValue({});
    submitSessionMock.mockReset();
    submitSessionMock.mockResolvedValue({ ok: true, referenceNumber: "AH-1", serviceRequestId: "sr-1" });
    buildAccountLookupReplyMock.mockReset();
    buildAccountLookupReplyMock.mockResolvedValue(null);
    decryptMock.mockReset();
    decryptMock.mockImplementation((s: string) => s);
    // By default: after-hours + urgent → disclose_charge.
    decideAfterHoursDisclosureMock.mockReset();
    decideAfterHoursDisclosureMock.mockReturnValue({
      kind: "disclose_charge",
      afterHours: true,
      copy: DISCLOSE_CHARGE_COPY,
    });
  }

  beforeEach(() => resetWS4Mocks());

  it("prepends the after-hours disclosure when after-hours + urgent (no dollar amount)", async () => {
    // Provide an address slot so the turn stays on the deterministic path.
    extractAddressAtAddressStepMock.mockReturnValue("123 Main St, Johnson City, TN 37601");
    extractAllContactMock.mockReturnValue({
      name: null,
      address: "123 Main St, Johnson City, TN 37601",
      phone: null,
      email: null,
    });

    const result = await voiceReply({
      session: intakeSession,
      history: [{ role: "user", content: "my ac stopped working" }],
      userMessage: "my address is 123 Main St",
      ipAddress: "127.0.0.1",
    });

    // Must include the disclosure phrase ("after our normal hours").
    expect(result.reply.toLowerCase()).toContain("after our normal hours");
    // Must NEVER contain a dollar amount.
    expect(result.reply).not.toMatch(/\$\s?\d/);
    expect(result.endCall).toBe(false);
    // LLM must not have been called (deterministic path).
    expect(generateTextMock).not.toHaveBeenCalled();
  });

  it("does NOT disclose after-hours a second time when already latched (afterHoursShown set)", async () => {
    const sessionAlreadyShown = {
      ...intakeSession,
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
        afterHoursShown: "1",
      }),
    };
    // Provide a slot so the deterministic path fires.
    extractAllContactMock.mockReturnValue({
      name: null,
      address: "456 Oak Ave, Johnson City, TN 37601",
      phone: null,
      email: null,
    });

    const result = await voiceReply({
      session: sessionAlreadyShown,
      history: [{ role: "user", content: "ac is out" }],
      userMessage: "456 Oak Ave, Johnson City, TN 37601",
      ipAddress: "127.0.0.1",
    });

    // The disclosure phrase should NOT appear when already latched.
    expect(result.reply.toLowerCase()).not.toContain("after our normal hours");
  });

  it("emergency escalation wins and does NOT include after-hours disclosure", async () => {
    routeMock.mockReturnValue({
      action: "ESCALATE",
      intentId: "gas_smell",
      confidence: 1,
      reply: "Please leave the building now and call 911.",
      issueType: "other",
      urgency: "emergency",
      escalate: true,
    });
    escalateMock.mockResolvedValue({ ok: true });

    const result = await voiceReply({
      session: intakeSession,
      history: [],
      userMessage: "i smell gas and its dangerous",
      ipAddress: "127.0.0.1",
    });

    // Emergency escalates and ends the call.
    expect(escalateMock).toHaveBeenCalled();
    expect(result.endCall).toBe(true);
    // The emergency reply must NOT contain after-hours disclosure.
    expect(result.reply.toLowerCase()).not.toContain("after our normal hours");
    // Must NOT contain a dollar amount.
    expect(result.reply).not.toMatch(/\$\s?\d/);
  });
});

describe("voiceReply token-budget enforcement (WS6)", () => {
  function resetWS6Mocks() {
    generateTextMock.mockReset();
    insertMock.mockReset();
    updateSetMock.mockReset();
    selectLimitMock.mockReset();
    selectLimitMock.mockResolvedValue([]);
    escalateMock.mockReset();
    escalateMock.mockResolvedValue({ ok: true });
    routeMock.mockReset();
    routeMock.mockReturnValue({
      action: "FALLBACK_LLM",
      intentId: null,
      confidence: 0,
      reply: null,
      issueType: null,
      urgency: null,
      escalate: false,
    });
    extractAllContactMock.mockReset();
    extractAllContactMock.mockReturnValue(noSlots());
    extractAddressAtAddressStepMock.mockReset();
    extractAddressAtAddressStepMock.mockReturnValue(null);
    extractSpokenPhoneMock.mockReset();
    extractSpokenPhoneMock.mockReturnValue(null);
    detectCorrectionMock.mockReset();
    detectCorrectionMock.mockReturnValue(null);
    getRouterConfigMock.mockReset();
    getRouterConfigMock.mockResolvedValue({});
    submitSessionMock.mockReset();
    buildAccountLookupReplyMock.mockReset();
    buildAccountLookupReplyMock.mockResolvedValue(null);
    decryptMock.mockReset();
    decryptMock.mockImplementation((s: string) => s);
    decideAfterHoursDisclosureMock.mockReset();
    decideAfterHoursDisclosureMock.mockReturnValue({ kind: "none", afterHours: false, copy: "" });
  }

  beforeEach(() => resetWS6Mocks());

  it("returns a graceful handoff and escalates WITHOUT calling generateText when token budget is exhausted", async () => {
    // tokensUsed >= tokenBudget → budget exhausted.
    const exhaustedSession = {
      ...baseSession,
      tokensUsed: 40_000,
      tokenBudget: 40_000,
    };

    const result = await voiceReply({
      session: exhaustedSession,
      history: [{ role: "user", content: "my furnace is loud" }],
      userMessage: "it just keeps rattling",
      ipAddress: "127.0.0.1",
    });

    // LLM must NOT be called.
    expect(generateTextMock).not.toHaveBeenCalled();
    // The session must be escalated.
    expect(escalateMock).toHaveBeenCalled();
    // The call should end.
    expect(result.endCall).toBe(true);
    expect(result.nextState).toBe("escalated");
    // Reply should be a graceful spoken handoff (references "office" or "team").
    expect(result.reply.toLowerCase()).toMatch(/office|team|call/);
  });

  it("accumulates token usage in the session update after a successful LLM call", async () => {
    generateTextMock.mockResolvedValue({
      text: "Tell me more about the noise.",
      usage: { inputTokens: 100, outputTokens: 50 },
    });

    const sessionWithPriorTokens = {
      ...baseSession,
      tokensUsed: 1_000,
      tokenBudget: 40_000,
    };

    await voiceReply({
      session: sessionWithPriorTokens,
      history: [{ role: "user", content: "my furnace is loud" }],
      userMessage: "it rattles",
      ipAddress: "1.2.3.4",
    });

    expect(generateTextMock).toHaveBeenCalledTimes(1);
    // The session update must persist the accumulated token total.
    const sessionUpdate = updateSetMock.mock.calls
      .map((c: unknown[]) => c[0] as Record<string, unknown>)
      .find((s) => typeof s.tokensUsed === "number");
    expect(sessionUpdate).toBeDefined();
    // 1000 prior + 100 input + 50 output = 1150.
    expect(sessionUpdate?.tokensUsed).toBe(1150);
  });
});
