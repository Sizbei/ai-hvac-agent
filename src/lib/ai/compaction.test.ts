import { describe, it, expect, vi, beforeEach } from "vitest";

const { generateTextMock } = vi.hoisted(() => ({
  generateTextMock: vi.fn(),
}));

vi.mock("ai", () => ({
  generateText: generateTextMock,
}));

vi.mock("./provider", () => ({
  getExtractionModel: () => "mock-model",
}));

import {
  buildModelMessages,
  summarizeOlderTurns,
  COMPACTION_THRESHOLD,
  COMPACTION_INTERVAL,
  MAX_HISTORY,
  shouldCompact,
  selectTurnsToCompact,
  type ChatTurn,
} from "./compaction";

function turn(role: ChatTurn["role"], content: string): ChatTurn {
  return { role, content };
}

describe("buildModelMessages", () => {
  it("prepends a system summary turn when a running summary exists", () => {
    const messages = buildModelMessages({
      runningSummary: "Customer Jane reported no heat at 5 Oak St.",
      recent: [turn("assistant", "How urgent is this?"), turn("user", "Very")],
      current: "It's freezing",
    });

    expect(messages[0]).toEqual({
      role: "system",
      content:
        "Summary of earlier conversation: Customer Jane reported no heat at 5 Oak St.",
    });
    // recent window + current message follow, in order
    expect(messages.slice(1)).toEqual([
      { role: "assistant", content: "How urgent is this?" },
      { role: "user", content: "Very" },
      { role: "user", content: "It's freezing" },
    ]);
  });

  it("omits the summary turn when there is no running summary", () => {
    const messages = buildModelMessages({
      runningSummary: null,
      recent: [turn("user", "hi")],
      current: "still hi",
    });
    expect(messages.every((m) => m.role !== "system")).toBe(true);
    expect(messages).toEqual([
      { role: "user", content: "hi" },
      { role: "user", content: "still hi" },
    ]);
  });

  it("treats a blank/whitespace summary as absent", () => {
    const messages = buildModelMessages({
      runningSummary: "   ",
      recent: [],
      current: "hello",
    });
    expect(messages).toEqual([{ role: "user", content: "hello" }]);
  });
});

describe("shouldCompact", () => {
  it("is false at or below the threshold", () => {
    expect(shouldCompact(COMPACTION_THRESHOLD)).toBe(false);
    expect(shouldCompact(COMPACTION_THRESHOLD - 1)).toBe(false);
  });
  it("fires on the first message past the threshold", () => {
    expect(shouldCompact(COMPACTION_THRESHOLD + 1)).toBe(true);
  });

  it("throttles to every COMPACTION_INTERVAL messages past the threshold", () => {
    // First firing is at +1, then every Nth message after that. The in-between
    // turns are skipped (folded in on the next firing).
    expect(shouldCompact(COMPACTION_THRESHOLD + 1)).toBe(true);
    for (let i = 2; i <= COMPACTION_INTERVAL; i++) {
      expect(shouldCompact(COMPACTION_THRESHOLD + i)).toBe(false);
    }
    // +1 + INTERVAL is the next firing.
    expect(shouldCompact(COMPACTION_THRESHOLD + 1 + COMPACTION_INTERVAL)).toBe(
      true,
    );
    for (let i = 1; i < COMPACTION_INTERVAL; i++) {
      expect(
        shouldCompact(COMPACTION_THRESHOLD + 1 + COMPACTION_INTERVAL + i),
      ).toBe(false);
    }
    expect(
      shouldCompact(COMPACTION_THRESHOLD + 1 + 2 * COMPACTION_INTERVAL),
    ).toBe(true);
  });

  it("keeps the firing cadence within the recent window so no turn is lost", () => {
    // Between two firings the conversation grows by at most COMPACTION_INTERVAL,
    // which must not exceed MAX_HISTORY or an aged-out turn could scroll off the
    // verbatim window before being summarized.
    expect(COMPACTION_INTERVAL).toBeLessThanOrEqual(MAX_HISTORY);
  });
});

describe("selectTurnsToCompact", () => {
  it("returns the turns older than the last MAX_HISTORY", () => {
    const history: ChatTurn[] = Array.from({ length: MAX_HISTORY + 3 }, (_, i) =>
      turn(i % 2 === 0 ? "user" : "assistant", `m${i}`),
    );
    const older = selectTurnsToCompact(history);
    expect(older).toHaveLength(3);
    expect(older.map((t) => t.content)).toEqual(["m0", "m1", "m2"]);
  });

  it("returns empty when history fits in the window", () => {
    const history: ChatTurn[] = [turn("user", "a"), turn("assistant", "b")];
    expect(selectTurnsToCompact(history)).toEqual([]);
  });
});

describe("summarizeOlderTurns", () => {
  beforeEach(() => {
    generateTextMock.mockReset();
  });

  it("folds the prior summary and the older turns into a new summary", async () => {
    generateTextMock.mockResolvedValue({ text: "  Updated summary.  " });

    const result = await summarizeOlderTurns({
      priorSummary: "Earlier: caller has a broken AC.",
      olderTurns: [
        turn("user", "It's at 12 Elm St"),
        turn("assistant", "Got it, 12 Elm St."),
      ],
    });

    expect(result).toBe("Updated summary.");
    expect(generateTextMock).toHaveBeenCalledTimes(1);
    const arg = generateTextMock.mock.calls[0][0];
    // The prior summary and the turns must both be present in the prompt.
    const prompt = JSON.stringify(arg);
    expect(prompt).toContain("broken AC");
    expect(prompt).toContain("12 Elm St");
  });

  it("falls back to the prior summary when the model returns nothing usable", async () => {
    generateTextMock.mockResolvedValue({ text: "   " });
    const result = await summarizeOlderTurns({
      priorSummary: "Prior summary stays.",
      olderTurns: [turn("user", "x")],
    });
    expect(result).toBe("Prior summary stays.");
  });

  it("returns the prior summary unchanged when there are no older turns", async () => {
    const result = await summarizeOlderTurns({
      priorSummary: "Nothing to add.",
      olderTurns: [],
    });
    expect(result).toBe("Nothing to add.");
    expect(generateTextMock).not.toHaveBeenCalled();
  });
});
