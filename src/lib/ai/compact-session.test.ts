import { describe, it, expect, vi, beforeEach } from "vitest";

const { summarizeMock, updateSet, updateWhere, selectResult } = vi.hoisted(
  () => ({
    summarizeMock: vi.fn(),
    updateSet: vi.fn(),
    updateWhere: vi.fn(),
    selectResult: { value: [] as unknown[] },
  }),
);

vi.mock("./compaction", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./compaction")>();
  return { ...actual, summarizeOlderTurns: summarizeMock };
});

vi.mock("@/lib/db", () => ({
  db: {
    select: () => ({
      from: () => ({
        where: () => ({ limit: () => Promise.resolve(selectResult.value) }),
      }),
    }),
    update: () => ({
      set: (v: unknown) => {
        updateSet(v);
        return { where: (w: unknown) => {
          updateWhere(w);
          return Promise.resolve();
        } };
      },
    }),
  },
}));

vi.mock("@/lib/db/schema", () => ({ customerSessions: {} }));

import { compactSessionIfNeeded } from "./compact-session";
import { MAX_HISTORY, COMPACTION_THRESHOLD, type ChatTurn } from "./compaction";

function makeHistory(n: number): ChatTurn[] {
  return Array.from({ length: n }, (_, i) => ({
    role: i % 2 === 0 ? "user" : "assistant",
    content: `m${i}`,
  }));
}

describe("compactSessionIfNeeded", () => {
  beforeEach(() => {
    summarizeMock.mockReset();
    updateSet.mockReset();
    updateWhere.mockReset();
    selectResult.value = [{ runningSummary: null }];
  });

  it("does nothing when the conversation fits in the window", async () => {
    const did = await compactSessionIfNeeded({
      sessionId: "s1",
      organizationId: "o1",
      history: makeHistory(MAX_HISTORY),
    });
    expect(did).toBe(false);
    expect(summarizeMock).not.toHaveBeenCalled();
    expect(updateSet).not.toHaveBeenCalled();
  });

  it("summarizes overflow turns and writes running_summary when over threshold", async () => {
    selectResult.value = [{ runningSummary: "prior" }];
    summarizeMock.mockResolvedValue("new summary");

    // +1 is the first message past the threshold, which fires under the throttle.
    const history = makeHistory(COMPACTION_THRESHOLD + 1);
    const did = await compactSessionIfNeeded({
      sessionId: "s1",
      organizationId: "o1",
      history,
    });

    expect(did).toBe(true);
    expect(summarizeMock).toHaveBeenCalledTimes(1);
    const args = summarizeMock.mock.calls[0][0];
    expect(args.priorSummary).toBe("prior");
    // overflow = everything before the last MAX_HISTORY
    expect(args.olderTurns).toHaveLength(history.length - MAX_HISTORY);
    expect(updateSet).toHaveBeenCalledWith(
      expect.objectContaining({ runningSummary: "new summary" }),
    );
  });

  it("skips the write when the summary is unchanged", async () => {
    selectResult.value = [{ runningSummary: "same" }];
    summarizeMock.mockResolvedValue("same");

    const did = await compactSessionIfNeeded({
      sessionId: "s1",
      organizationId: "o1",
      history: makeHistory(COMPACTION_THRESHOLD + 1),
    });

    expect(did).toBe(false);
    expect(updateSet).not.toHaveBeenCalled();
  });

  it("skips compaction on the throttled in-between turns past the threshold", async () => {
    selectResult.value = [{ runningSummary: "prior" }];
    summarizeMock.mockResolvedValue("new summary");

    // +2 is past the threshold but lands between firings under the throttle.
    const did = await compactSessionIfNeeded({
      sessionId: "s1",
      organizationId: "o1",
      history: makeHistory(COMPACTION_THRESHOLD + 2),
    });

    expect(did).toBe(false);
    expect(summarizeMock).not.toHaveBeenCalled();
    expect(updateSet).not.toHaveBeenCalled();
  });
});
