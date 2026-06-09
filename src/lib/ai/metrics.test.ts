import { describe, it, expect, vi, beforeEach } from "vitest";

// --- Hoisted mocks ---
const { mockLoggerInfo, mockLoggerError } = vi.hoisted(() => ({
  mockLoggerInfo: vi.fn(),
  mockLoggerError: vi.fn(),
}));

vi.mock("@/lib/logger", () => ({
  logger: {
    info: mockLoggerInfo,
    error: mockLoggerError,
  },
}));

import { trackAICall } from "./metrics";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("trackAICall", () => {
  it("returns the wrapped function result on success", async () => {
    const expected = { data: "hello", tokens: 42 };
    const fn = vi.fn().mockResolvedValue(expected);

    const { result } = await trackAICall("test-op", fn, () => 42);

    expect(result).toBe(expected);
  });

  it("records latencyMs >= 0 in the returned metrics", async () => {
    const fn = vi.fn().mockResolvedValue({ value: 1 });

    const { metrics } = await trackAICall("test-op", fn, () => 10);

    expect(metrics.latencyMs).toBeGreaterThanOrEqual(0);
    expect(typeof metrics.latencyMs).toBe("number");
  });

  it("records tokensUsed from the extractTokens callback", async () => {
    const fn = vi.fn().mockResolvedValue({ usage: 150 });

    const { metrics } = await trackAICall(
      "test-op",
      fn,
      (r: { usage: number }) => r.usage,
    );

    expect(metrics.tokensUsed).toBe(150);
  });

  it("records error status and error message on failure", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("AI model timeout"));

    await expect(
      trackAICall("test-op", fn, () => 0),
    ).rejects.toThrow("AI model timeout");
  });

  it("calls logger.info with structured metrics on success", async () => {
    const fn = vi.fn().mockResolvedValue({ tokens: 75 });

    await trackAICall("extraction", fn, () => 75);

    expect(mockLoggerInfo).toHaveBeenCalledTimes(1);
    const [logData, logMessage] = mockLoggerInfo.mock.calls[0];
    expect(logMessage).toBe("AI call completed");
    expect(logData).toHaveProperty("aiMetrics");
    expect(logData.aiMetrics).toMatchObject({
      operation: "extraction",
      tokensUsed: 75,
      success: true,
    });
    expect(logData.aiMetrics.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it("calls logger.error with structured metrics on failure", async () => {
    const fn = vi.fn().mockRejectedValue(new Error("Rate limited"));

    await expect(
      trackAICall("extraction", fn, () => 0),
    ).rejects.toThrow("Rate limited");

    expect(mockLoggerError).toHaveBeenCalledTimes(1);
    const [logData, logMessage] = mockLoggerError.mock.calls[0];
    expect(logMessage).toBe("AI call failed");
    expect(logData).toHaveProperty("aiMetrics");
    expect(logData.aiMetrics).toMatchObject({
      operation: "extraction",
      tokensUsed: 0,
      success: false,
      error: "Rate limited",
    });
    expect(logData.aiMetrics.latencyMs).toBeGreaterThanOrEqual(0);
  });
});
