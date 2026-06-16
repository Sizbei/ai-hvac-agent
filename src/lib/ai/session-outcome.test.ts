/**
 * Tests for Stage 3 session summary + outcome classification.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { summarizeAndClassifySession } from "./session-outcome";
import { db } from "@/lib/db";
import { generateText } from "ai";

vi.mock("@/lib/db", () => ({ db: { select: vi.fn(), update: vi.fn() } }));
vi.mock("ai", () => ({ generateText: vi.fn() }));
vi.mock("./provider", () => ({ getExtractionModel: () => ({}) }));
vi.mock("@/lib/logger", () => ({ logger: { error: vi.fn(), info: vi.fn() } }));

const ORG = "org-1";
const SID = "sess-1";

function mockMessages(rows: Array<{ role: string; content: string }>) {
  vi.mocked(db.select).mockReturnValue({
    from: vi.fn().mockReturnValue({
      where: vi.fn().mockReturnValue({
        orderBy: vi.fn().mockResolvedValue(rows),
      }),
    }),
  } as never);
}

function captureUpdate() {
  const set = vi.fn().mockReturnValue({ where: vi.fn().mockResolvedValue(undefined) });
  vi.mocked(db.update).mockReturnValue({ set } as never);
  return set;
}

beforeEach(() => vi.clearAllMocks());

describe("summarizeAndClassifySession", () => {
  it("writes summary, outcome, and capped nextSteps from valid LLM JSON", async () => {
    mockMessages([
      { role: "user", content: "my furnace is out" },
      { role: "assistant", content: "booked you for tomorrow" },
    ]);
    vi.mocked(generateText).mockResolvedValue({
      text: '{"summary":"Customer furnace down, booked.","outcome":"booked","nextSteps":["a","b","c","d"]}',
    } as never);
    const set = captureUpdate();

    await summarizeAndClassifySession({ organizationId: ORG, sessionId: SID });

    const arg = set.mock.calls[0]![0];
    expect(arg.outcome).toBe("booked");
    expect(arg.summary).toContain("furnace");
    expect(arg.nextSteps).toHaveLength(3); // capped at 3
  });

  it("falls back to definiteOutcome when the LLM returns garbage", async () => {
    mockMessages([{ role: "user", content: "hi" }]);
    vi.mocked(generateText).mockResolvedValue({ text: "not json at all" } as never);
    const set = captureUpdate();

    await summarizeAndClassifySession({
      organizationId: ORG,
      sessionId: SID,
      definiteOutcome: "escalated",
    });

    expect(set.mock.calls[0]![0].outcome).toBe("escalated");
  });

  it("rejects an invalid LLM outcome and uses definiteOutcome", async () => {
    mockMessages([{ role: "user", content: "hi" }]);
    vi.mocked(generateText).mockResolvedValue({
      text: '{"summary":"x","outcome":"totally_made_up","nextSteps":[]}',
    } as never);
    const set = captureUpdate();

    await summarizeAndClassifySession({
      organizationId: ORG,
      sessionId: SID,
      definiteOutcome: "booked",
    });

    expect(set.mock.calls[0]![0].outcome).toBe("booked");
  });

  it("skips the LLM for an empty session but still records the definite outcome", async () => {
    mockMessages([]); // no user turns
    const set = captureUpdate();

    await summarizeAndClassifySession({
      organizationId: ORG,
      sessionId: SID,
      definiteOutcome: "abandoned",
    });

    expect(generateText).not.toHaveBeenCalled();
    expect(set.mock.calls[0]![0].outcome).toBe("abandoned");
  });

  it("is best-effort: a DB error never throws", async () => {
    mockMessages([{ role: "user", content: "hi" }]);
    vi.mocked(generateText).mockResolvedValue({ text: '{"outcome":"info_provided"}' } as never);
    vi.mocked(db.update).mockImplementation(() => {
      throw new Error("db down");
    });
    await expect(
      summarizeAndClassifySession({ organizationId: ORG, sessionId: SID }),
    ).resolves.toBeUndefined();
  });
});
