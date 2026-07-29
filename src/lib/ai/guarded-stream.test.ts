import { describe, it, expect } from "vitest";
import {
  findBoundaries,
  flushableLength,
  guardedFlushStream,
} from "./guarded-stream";
import { screenAssistantReply } from "./output-guardrail";

// ---- helpers ---------------------------------------------------------------

/** Turn a string into a per-character async stream (worst-case chunking). */
async function* charStream(s: string): AsyncIterable<string> {
  for (const ch of s) yield ch;
}

/** Turn an explicit chunk list into an async stream. */
async function* chunks(list: string[]): AsyncIterable<string> {
  for (const c of list) yield c;
}

/** A stream that yields some chunks then throws (mid-stream error / abort). */
async function* throwingStream(list: string[]): AsyncIterable<string> {
  for (const c of list) yield c;
  throw new Error("aborted");
}

const screen = (t: string) => screenAssistantReply(t);
const fallbackFor = (v: readonly string[]) =>
  screenAssistantReply(
    // reconstruct the canned reply the same way the route does:
    // pass a text that trips exactly these violations is overkill; instead
    // build the fallback via a representative trigger per violation set.
    v.includes("dangerous-diy") || v.includes("credentials")
      ? "here's how to recharge your refrigerant"
      : v.includes("false-booking") && v.includes("pricing")
        ? "you're booked and it costs $200"
        : v.includes("false-booking")
          ? "you're booked"
          : "it costs $200",
  ).reply;

/** Drive a guardedFlushStream to completion and collect the emitted text. */
async function collect(
  input: AsyncIterable<string>,
): Promise<{ shown: string; persisted: string; persistOpts: { violated: boolean; aborted: boolean } }> {
  let persisted = "";
  let persistOpts = { violated: false, aborted: false };
  const { readable, done } = guardedFlushStream({
    textStream: input,
    screen,
    fallbackFor,
    persist: async (finalText, opts) => {
      persisted = finalText;
      persistOpts = opts;
    },
  });
  const reader = readable.getReader();
  const dec = new TextDecoder();
  let shown = "";
  for (;;) {
    const { done: d, value } = await reader.read();
    if (d) break;
    shown += dec.decode(value, { stream: true });
  }
  await done;
  return { shown, persisted, persistOpts };
}

// ---- findBoundaries --------------------------------------------------------

describe("findBoundaries", () => {
  it("marks '. ' but not a digit-adjacent period", () => {
    // "It is 4.5 tons. Next." -> boundaries after "tons." and after "Next."
    const t = "It is 4.5 tons. Next.";
    const b = findBoundaries(t);
    // period in 4.5 excluded; two real boundaries
    expect(b).toEqual([t.indexOf("tons.") + "tons.".length, t.length]);
  });

  it("treats \\n\\n as a boundary but a bare \\n as not", () => {
    const t = "line one\nstill one\n\nsecond";
    const b = findBoundaries(t);
    expect(b).toEqual([t.indexOf("\n\n") + 2]);
  });

  it("does not split '$1.50' or '4.5'", () => {
    const t = "That is $1.50 and 4.5 tons total.";
    const b = findBoundaries(t);
    expect(b).toEqual([t.length]); // only the final period
  });
});

// ---- flushableLength (lag + punctuation gate) ------------------------------

describe("flushableLength", () => {
  it("lags one sentence: with two boundaries, candidate is through the first", () => {
    const t = "One sentence. Two sentence. ";
    const b = findBoundaries(t);
    const len = flushableLength(t, b);
    expect(t.slice(0, len)).toBe("One sentence.");
  });

  it("holds everything when fewer than two boundaries exist", () => {
    const t = "Only one sentence here. ";
    const b = findBoundaries(t);
    expect(flushableLength(t, b)).toBe(0);
  });

  it("holds an unpunctuated \\n\\n unit until a later punctuated boundary", () => {
    // second-newest boundary ends "Your appointment" (no terminal punct) -> walk back -> 0
    const t = "Great!\n\nYour appointment\n\nhas been confirmed.";
    const b = findBoundaries(t);
    // second-newest boundary is after "Your appointment\n\n"; its trimmed tail
    // ("Your appointment") is not terminal-punctuated -> walk back to "Great!" boundary,
    // BUT that leaves only the newest sentence unlagged, so nothing flushable yet
    // when only these 2 boundaries exist. Assert nothing before "Great!" streams here:
    const shown = t.slice(0, flushableLength(t, b));
    // flushableLength walks back to the "Great!" boundary (position 8 = after "!\n\n");
    // the slice retains the boundary's trailing \n\n so trimEnd() strips it for comparison.
    expect(shown === "" || shown.trimEnd() === "Great!").toBe(true);
  });
});

// ---- guardedFlushStream: five round-1 fixtures -----------------------------
// Each asserts the LEADING HALF of a cross-junction match is NEVER emitted.

describe("guardedFlushStream — round-1 fixtures (leading half never shown)", () => {
  // Each fixture violates a guardrail via a match that spans a sentence boundary.
  // The spec mandates ZERO match-span chars are ever emitted. We assert:
  //   (a) screen(shown).safe — whatever was emitted is itself clean
  //   (b) explicit not.toContain for BOTH halves of the spanning match
  //
  // Fallback-collision note: for "I am\na licensed technician here." the violation
  // triggers SAFE_DIY_REPLY which itself contains "licensed technician". We therefore
  // skip the not.toContain("licensed technician") assertion for that fixture (it would
  // always fail on the fallback text) and only assert the other half "I am" which is
  // absent from SAFE_DIY_REPLY.
  it(`never shows a match-span char for: "The visit is fifty\\ndollars total."`, async () => {
    const { shown } = await collect(charStream("The visit is fifty\ndollars total."));
    expect(screen(shown).safe).toBe(true);
    expect(shown).not.toContain("fifty");
    expect(shown).not.toContain("dollars");
  });

  it(`never shows a match-span char for: "It will be $\\n89 even."`, async () => {
    const { shown } = await collect(charStream("It will be $\n89 even."));
    expect(screen(shown).safe).toBe(true);
    expect(shown).not.toContain("$");
    expect(shown).not.toContain("89");
  });

  it(`never shows a match-span char for: "Good news you are\\nbooked for Tuesday."`, async () => {
    const { shown } = await collect(charStream("Good news you are\nbooked for Tuesday."));
    expect(screen(shown).safe).toBe(true);
    // SAFE_BOOKING_REPLY does not contain "you are" or "booked" — safe to assert both.
    expect(shown).not.toContain("you are");
    expect(shown).not.toContain("booked");
  });

  it(`never shows a match-span char for: "We can top off the\\nrefrigerant for you."`, async () => {
    const { shown } = await collect(charStream("We can top off the\nrefrigerant for you."));
    expect(screen(shown).safe).toBe(true);
    // SAFE_DIY_REPLY does not contain "top off" or "refrigerant" — safe to assert both.
    expect(shown).not.toContain("top off");
    expect(shown).not.toContain("refrigerant");
  });

  it(`never shows a match-span char for: "I am\\na licensed technician here."`, async () => {
    const { shown } = await collect(charStream("I am\na licensed technician here."));
    expect(screen(shown).safe).toBe(true);
    // "I am" is absent from SAFE_DIY_REPLY — safe to assert.
    expect(shown).not.toContain("I am");
    // NOTE: "licensed technician" IS present in SAFE_DIY_REPLY (the fallback), so
    // asserting not.toContain("licensed technician") on `shown` would always fail
    // when emittedLen=0 and shown==fallback. Skip that half; the screen() assertion
    // above confirms no raw match-span content leaked.
  });
});

// ---- guardedFlushStream: four round-2/3 multi-paragraph fixtures ------------
// Assert ZERO match-span characters emitted (shown prefix is clean).
//
// Fallback-collision notes (per fixture):
//   "I am\n\na\n\nlicensed technician": triggers SAFE_DIY_REPLY which contains
//     "licensed technician" — we skip not.toContain("licensed technician") and only
//     assert "I am" which is absent from SAFE_DIY_REPLY.
//   "Great!\n\nYour appointment\n\nhas\n\nbeen confirmed.": triggers SAFE_BOOKING_REPLY
//     which contains "hasn't" (via "I haven't") — bare "has" would collide; we assert
//     "been confirmed" (absent from fallback) instead of bare "has"/"been".
//   "Great question!\n\nadding\n\nmore\n\nof\n\nthe\n\nrefrigerant": triggers SAFE_DIY_REPLY
//     which contains "of"/"to" — assert "adding" and "refrigerant" (both absent from fallback);
//     skip "more"/"of"/"the" which are too common.

describe("guardedFlushStream — round-2/3 multi-paragraph fixtures (zero match-span chars)", () => {
  it(`emits zero match-span chars for: "Great news.\\n\\nfive\\n\\nhundred\\n\\nthousand\\n\\ndollars."`, async () => {
    const { shown, persisted } = await collect(charStream("Great news.\n\nfive\n\nhundred\n\nthousand\n\ndollars."));
    expect(screen(shown).safe).toBe(true);
    expect(screen(persisted).safe).toBe(true);
    // SAFE_PRICING_REPLY contains none of these words — safe to assert all four.
    expect(shown).not.toContain("five");
    expect(shown).not.toContain("hundred");
    expect(shown).not.toContain("thousand");
    expect(shown).not.toContain("dollars");
  });

  it(`emits zero match-span chars for: "I am\\n\\na\\n\\nlicensed technician"`, async () => {
    const { shown, persisted } = await collect(charStream("I am\n\na\n\nlicensed technician"));
    expect(screen(shown).safe).toBe(true);
    expect(screen(persisted).safe).toBe(true);
    // "I am" is absent from SAFE_DIY_REPLY — safe to assert.
    expect(shown).not.toContain("I am");
    // NOTE: "licensed technician" IS in SAFE_DIY_REPLY (the fallback), so we cannot
    // assert not.toContain("licensed technician") on shown — the fallback itself contains it.
    // The screen(shown).safe assertion confirms no raw match-span content leaked.
  });

  it(`emits zero match-span chars for: "Great!\\n\\nYour appointment\\n\\nhas\\n\\nbeen confirmed."`, async () => {
    const { shown, persisted } = await collect(charStream("Great!\n\nYour appointment\n\nhas\n\nbeen confirmed."));
    expect(screen(shown).safe).toBe(true);
    expect(screen(persisted).safe).toBe(true);
    // "Your appointment" and "been confirmed" are absent from SAFE_BOOKING_REPLY.
    // Bare "has" is skipped — SAFE_BOOKING_REPLY contains "hasn't" which includes "has".
    expect(shown).not.toContain("Your appointment");
    expect(shown).not.toContain("been confirmed");
  });

  it(`emits zero match-span chars for: "Great question!\\n\\nadding\\n\\nmore\\n\\nof\\n\\nthe\\n\\nrefrigerant"`, async () => {
    const { shown, persisted } = await collect(charStream("Great question!\n\nadding\n\nmore\n\nof\n\nthe\n\nrefrigerant"));
    expect(screen(shown).safe).toBe(true);
    expect(screen(persisted).safe).toBe(true);
    // "adding" and "refrigerant" are absent from SAFE_DIY_REPLY — safe to assert.
    // "more"/"of"/"the" are too common and appear in SAFE_DIY_REPLY — skipped.
    expect(shown).not.toContain("adding");
    expect(shown).not.toContain("refrigerant");
  });
});

// ---- clean reply: emitted == input -----------------------------------------

describe("guardedFlushStream — clean reply", () => {
  it("streams a clean multi-sentence reply verbatim", async () => {
    const t =
      "Got it, your AC is not cooling. That points to a few common causes. Our team can take a look. What is the service address?";
    const { shown, persisted, persistOpts } = await collect(charStream(t));
    expect(shown).toBe(t);
    expect(persisted).toBe(t);
    expect(persistOpts).toEqual({ violated: false, aborted: false });
  });

  it("whitespace merge: a clean reply with trailing spaces streams intact", async () => {
    const t = "First sentence.   Second sentence.   Third sentence. ";
    const { shown } = await collect(chunks(["First sentence.   ", "Second sentence.   ", "Third sentence. "]));
    expect(shown).toBe(t);
  });
});

// ---- violation in first two sentences -> fallback only ---------------------

describe("guardedFlushStream — violation in first two sentences", () => {
  it("shows fallback only (nothing flushed before the violation)", async () => {
    const t = "That repair runs about $250 flat. Anything else?";
    const { shown, persisted, persistOpts } = await collect(charStream(t));
    // Nothing safe was flushable before the violating sentence completed.
    expect(shown).not.toMatch(/\$/);
    expect(screen(shown).safe).toBe(true);
    expect(persistOpts.violated).toBe(true);
    expect(screen(persisted).safe).toBe(true);
    // fallback appears (either alone, or after "\n\n" if a clean prefix existed)
    expect(shown.length).toBeGreaterThan(0);
  });
});

// ---- screening throws -> fail closed ---------------------------------------

describe("guardedFlushStream — screening throws", () => {
  it("fails closed: stops, emits fallback, persists, closes", async () => {
    let calls = 0;
    const throwingScreen = (t: string) => {
      calls++;
      if (calls > 1) throw new Error("screen boom");
      return screenAssistantReply(t);
    };
    let persisted = "";
    const { readable, done } = guardedFlushStream({
      textStream: charStream("First sentence here. Second sentence here. Third here."),
      screen: throwingScreen,
      fallbackFor,
      persist: async (t) => {
        persisted = t;
      },
    });
    const reader = readable.getReader();
    const dec = new TextDecoder();
    let shown = "";
    for (;;) {
      const { done: d, value } = await reader.read();
      if (d) break;
      shown += dec.decode(value, { stream: true });
    }
    await done; // must resolve, never reject
    expect(screen(shown).safe).toBe(true);
    expect(screen(persisted).safe).toBe(true);
  });
});

// ---- abort mid-stream -> close at last flush, no fallback ------------------

describe("guardedFlushStream — abort/error mid-stream", () => {
  it("closes at last clean flush with no fallback", async () => {
    // Two clean sentences flush, then the stream throws.
    const input = throwingStream(["One good sentence. ", "Two good sentence. ", "Three good sen"]);
    let persisted = "";
    let opts = { violated: true, aborted: false };
    const { readable, done } = guardedFlushStream({
      textStream: input,
      screen,
      fallbackFor,
      persist: async (t, o) => {
        persisted = t;
        opts = o;
      },
    });
    const reader = readable.getReader();
    const dec = new TextDecoder();
    let shown = "";
    for (;;) {
      const { done: d, value } = await reader.read();
      if (d) break;
      shown += dec.decode(value, { stream: true });
    }
    await done;
    expect(opts.aborted).toBe(true);
    expect(opts.violated).toBe(false);
    // No fallback text appended; only lag-flushed clean sentences.
    // Boundary position is AFTER the "." (not after the trailing space), so no trailing space.
    expect(shown).toBe("One good sentence.");
    expect(persisted).toBe(shown);
  });

  it("abort during a violation drain still closes at last clean flush, no fallback", async () => {
    // Clean sentence flushes, a violating sentence begins, then stream throws.
    const input = throwingStream(["Clean sentence one. ", "Clean sentence two. ", "That costs $99 ", "and more"]);
    let opts = { violated: false, aborted: false };
    let persisted = "";
    const { readable, done } = guardedFlushStream({
      textStream: input,
      screen,
      fallbackFor,
      persist: async (t, o) => {
        persisted = t;
        opts = o;
      },
    });
    const reader = readable.getReader();
    const dec = new TextDecoder();
    let shown = "";
    for (;;) {
      const { done: d, value } = await reader.read();
      if (d) break;
      shown += dec.decode(value, { stream: true });
    }
    await done;
    expect(opts.aborted).toBe(true);
    expect(shown).not.toMatch(/\$/);
    expect(screen(shown).safe).toBe(true);
    expect(persisted).toBe(shown);
  });
});

// ---- held-then-released bullet list at completion --------------------------

describe("guardedFlushStream — unpunctuated tail held then released", () => {
  it("holds a bullet list mid-stream, releases it intact at clean completion", async () => {
    const t = "Here are common causes:\n- dirty filter\n- low airflow\n- thermostat set wrong";
    const { shown, persisted } = await collect(charStream(t));
    // No terminal punctuation anywhere -> held until completion, then released whole.
    expect(shown).toBe(t);
    expect(persisted).toBe(t);
  });
});
