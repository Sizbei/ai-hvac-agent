import { describe, it, expect } from "vitest";
import { guardedFlushStream } from "./guarded-stream";
import { screenAssistantReply } from "./output-guardrail";

async function* charStream(s: string): AsyncIterable<string> {
  for (const ch of s) yield ch;
}
async function* throwAfter(list: string[]): AsyncIterable<string> {
  for (const c of list) yield c;
  throw new Error("aborted");
}

const screen = (t: string) => {
  const s = screenAssistantReply(t);
  return { safe: s.safe, violations: s.violations };
};
const fallbackFor = (violations: readonly string[]) => {
  const trigger =
    violations.includes("dangerous-diy") || violations.includes("credentials")
      ? "here's how to recharge your refrigerant"
      : violations.includes("false-booking") && violations.includes("pricing")
        ? "you're booked and it costs $200"
        : violations.includes("false-booking")
          ? "you're booked"
          : "it costs $200";
  return screenAssistantReply(trigger).reply;
};

/**
 * Mirror of the route's persist closure: records the inserted row + the order
 * of persist-vs-close, using a resolvable usage promise like result.usage.
 */
function makeWiring(input: AsyncIterable<string>, usage: { inputTokens: number; outputTokens: number }) {
  const events: string[] = [];
  let insertedContent = "";
  let insertedTokens = -1;
  const usagePromise = Promise.resolve(usage);
  const { readable, done } = guardedFlushStream({
    textStream: input,
    screen,
    fallbackFor,
    persist: async (finalText, { aborted }) => {
      let tokensThisCall = 0;
      if (!aborted) {
        const u = await usagePromise;
        tokensThisCall = (u.inputTokens ?? 0) + (u.outputTokens ?? 0);
      }
      insertedContent = finalText;
      insertedTokens = tokensThisCall;
      events.push("persist");
    },
  });
  return { readable, done, events, get insertedContent() { return insertedContent; }, get insertedTokens() { return insertedTokens; } };
}

async function drain(readable: ReadableStream<Uint8Array>, events: string[]) {
  const reader = readable.getReader();
  const dec = new TextDecoder();
  let shown = "";
  for (;;) {
    const { done: d, value } = await reader.read();
    if (d) break;
    shown += dec.decode(value, { stream: true });
  }
  events.push("close");
  return shown;
}

describe("route wiring — persist content per path", () => {
  it("clean path: row == full text, tokens from usage", async () => {
    const t = "Got it, that is a common issue. Our team can take a look. What is the address?";
    const w = makeWiring(charStream(t), { inputTokens: 40, outputTokens: 20 });
    const shown = await drain(w.readable, w.events);
    await w.done;
    expect(shown).toBe(t);
    expect(w.insertedContent).toBe(t);
    expect(w.insertedTokens).toBe(60);
  });

  it("violated path: row == cleanPrefix + \\n\\n + fallback == streamed concatenation", async () => {
    // Fixture hand-trace (lag rule):
    //   Boundaries: after "background." (40), after "check." (74), after "flat." (B3), after "else?" (B4).
    //   Second-newest = B3; screen slice(0,B3) hits "$250" → suppressed.
    //   Walk back to boundary 74; screen "...to check." → clean → emit prefix (74 chars).
    //   After loop: suppressed → append "\n\n" + SAFE_PRICING_REPLY.
    //   Expected shown = "Great question, here is some background. There are common causes to check." + "\n\n" + fallback.
    const t = "Great question, here is some background. There are common causes to check. That repair runs about $250 flat. Anything else?";
    const w = makeWiring(charStream(t), { inputTokens: 40, outputTokens: 20 });
    const shown = await drain(w.readable, w.events);
    await w.done;
    expect(w.insertedContent).toBe(shown); // persisted == streamed
    expect(screenAssistantReply(shown).safe).toBe(true);
    expect(shown).not.toMatch(/\$/);
    // Structural assertion: shown = cleanPrefix + "\n\n" + fallback.
    const expectedCleanPrefix = "Great question, here is some background. There are common causes to check.";
    const expectedFallback = fallbackFor(["pricing"]); // pricing violation → SAFE_PRICING_REPLY
    expect(shown.startsWith(expectedCleanPrefix)).toBe(true);
    expect(shown.endsWith("\n\n" + expectedFallback)).toBe(true);
  });

  it("aborted path: row == flushed prefix only, no fallback, tokens 0", async () => {
    const w = makeWiring(
      throwAfter(["One clean sentence. ", "Two clean sentence. ", "Three cl"]),
      { inputTokens: 40, outputTokens: 20 },
    );
    const shown = await drain(w.readable, w.events);
    await w.done;
    // Boundary is at position after "." (before the trailing space), so no trailing space.
    expect(shown).toBe("One clean sentence.");
    expect(w.insertedContent).toBe("One clean sentence.");
    expect(w.insertedTokens).toBe(0); // aborted -> usage skipped
  });

  it("persists BEFORE close on the clean path", async () => {
    const w = makeWiring(charStream("First sentence. Second sentence. Third sentence."), {
      inputTokens: 1,
      outputTokens: 1,
    });
    await drain(w.readable, w.events);
    await w.done;
    // persist is awaited inside start() before controller.close(), so the
    // reader sees end-of-stream only after persist resolved.
    expect(w.events).toEqual(["persist", "close"]);
  });
});
