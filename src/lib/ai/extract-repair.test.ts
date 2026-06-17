import { describe, it, expect, vi, beforeEach } from "vitest";
import { generateText } from "ai";
import { extractServiceRequest } from "./extract";

// Mock the AI SDK + provider so no network/SDK client is constructed; mock the
// logger so trackAICall's structured logs don't pollute test output.
vi.mock("ai", () => ({ generateText: vi.fn() }));
vi.mock("./provider", () => ({ getExtractionModel: () => ({}) }));
vi.mock("@/lib/logger", () => ({
  logger: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

const VALID_JSON =
  '{"issueType":"cooling_not_working","urgency":"high","address":null,"customerName":null,"customerPhone":null,"customerEmail":null,"description":"AC out","isHvacRelated":true}';

function reply(text: string, inTok = 10, outTok = 5) {
  return { text, usage: { inputTokens: inTok, outputTokens: outTok } } as never;
}

beforeEach(() => {
  vi.mocked(generateText).mockReset();
});

describe("extractServiceRequest — repair pass", () => {
  it("does NOT invoke the repair pass when the first reply parses", async () => {
    vi.mocked(generateText).mockResolvedValueOnce(reply(VALID_JSON));

    const r = await extractServiceRequest([], "my ac is out");

    expect(generateText).toHaveBeenCalledTimes(1);
    expect(r.extraction.issueType).toBe("cooling_not_working");
  });

  it("invokes ONE repair pass when the first reply has no parseable JSON, and adopts the repaired result", async () => {
    vi.mocked(generateText)
      .mockResolvedValueOnce(reply("Sure, I can help with that!")) // unparseable
      .mockResolvedValueOnce(reply(VALID_JSON)); // repair succeeds

    const r = await extractServiceRequest([], "my ac is out");

    expect(generateText).toHaveBeenCalledTimes(2);
    expect(r.extraction.issueType).toBe("cooling_not_working");
    // Tokens from BOTH calls are summed.
    expect(r.tokensUsed).toBe(30);
  });

  it("repairs a first reply that parses but FAILS validation (non-object)", async () => {
    vi.mocked(generateText)
      .mockResolvedValueOnce(reply('["not", "an", "object"]')) // array → ok:false
      .mockResolvedValueOnce(reply(VALID_JSON));

    const r = await extractServiceRequest([], "my ac is out");

    expect(generateText).toHaveBeenCalledTimes(2);
    expect(r.extraction.issueType).toBe("cooling_not_working");
  });

  it("gives up gracefully when the repair ALSO fails — returns the empty fallback, never throws", async () => {
    vi.mocked(generateText)
      .mockResolvedValueOnce(reply("nope")) // unparseable
      .mockResolvedValueOnce(reply("still nope")); // repair also unparseable

    const r = await extractServiceRequest([], "my ac is out");

    expect(generateText).toHaveBeenCalledTimes(2);
    expect(r.extraction.issueType).toBeNull();
    expect(r.extraction.isHvacRelated).toBe(false);
    expect(r.extraction.description).toBe("");
  });

  it("does not throw when the repair call itself errors (timeout/network)", async () => {
    vi.mocked(generateText)
      .mockResolvedValueOnce(reply("nope")) // unparseable
      .mockRejectedValueOnce(new Error("AbortError: timeout")); // repair throws

    const r = await extractServiceRequest([], "my ac is out");

    expect(generateText).toHaveBeenCalledTimes(2);
    // Falls back to the original empty extraction.
    expect(r.extraction.issueType).toBeNull();
  });

  it("caps the repair call's output tokens (latency guard)", async () => {
    vi.mocked(generateText)
      .mockResolvedValueOnce(reply("nope"))
      .mockResolvedValueOnce(reply(VALID_JSON));

    await extractServiceRequest([], "my ac is out");

    const repairCall = vi.mocked(generateText).mock.calls[1][0];
    expect(repairCall.maxOutputTokens).toBeDefined();
    expect(repairCall.maxOutputTokens).toBeLessThanOrEqual(300);
  });
});
