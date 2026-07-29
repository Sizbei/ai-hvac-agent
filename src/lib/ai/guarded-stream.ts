/**
 * Guarded flush streaming for the chat LLM reply path.
 *
 * Streams a model reply progressively while preserving the exact safety
 * guarantee of the buffer-then-screen path: no character of any
 * guardrail-matching span is ever shown, and every shown character belongs to a
 * complete, jointly-screened, punctuation-terminated sentence.
 *
 * NOT a TransformStream: `pipeThrough` cannot drain the upstream model stream
 * after the downstream closes. We run a manual `for await` pull loop inside
 * `ReadableStream.start()`, so on a violation we keep consuming (drain) and
 * persist-before-close on every path.
 */

const TEXT = new TextEncoder();

/** Return sorted END positions (index AFTER the boundary char / break). */
export function findBoundaries(text: string): number[] {
  const out: number[] = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === "." || ch === "!" || ch === "?") {
      const prev = text[i - 1];
      const next = text[i + 1];
      const atEob = i === text.length - 1;
      const followedByWs = next !== undefined && /\s/.test(next);
      const precededByDigit = prev !== undefined && /\d/.test(prev);
      if ((atEob || followedByWs) && !precededByDigit) out.push(i + 1);
    } else if (ch === "\n" && text[i + 1] === "\n") {
      out.push(i + 2);
      i++; // skip the second \n
    }
  }
  return out;
}

/** True when the whitespace-trimmed prefix ends in terminal punctuation. */
function endsTerminal(prefix: string): boolean {
  const trimmed = prefix.replace(/\s+$/, "");
  const last = trimmed[trimmed.length - 1];
  return last === "." || last === "!" || last === "?";
}

/**
 * Length of the flushable candidate: Rule 1 (one-sentence lag) + Rule 2
 * (terminal-punctuation gate). Returns 0 when nothing may flush yet.
 */
export function flushableLength(text: string, boundaries: number[]): number {
  if (boundaries.length < 2) return 0;
  // Rule 1: lag one sentence — candidate ends at the second-newest boundary.
  // Rule 2: candidate's trimmed tail must end in terminal punctuation; if not,
  // walk back to the largest earlier boundary that does.
  for (let idx = boundaries.length - 2; idx >= 0; idx--) {
    const end = boundaries[idx];
    if (endsTerminal(text.slice(0, end))) return end;
  }
  return 0;
}

export interface GuardedFlushOpts {
  readonly textStream: AsyncIterable<string>;
  readonly screen: (text: string) => {
    readonly safe: boolean;
    readonly violations: readonly string[];
  };
  readonly fallbackFor: (violations: readonly string[]) => string;
  readonly persist: (
    finalText: string,
    opts: { violated: boolean; aborted: boolean },
  ) => Promise<void>;
}

export interface GuardedFlushResult {
  readonly readable: ReadableStream<Uint8Array>;
  readonly done: Promise<void>;
}

export function guardedFlushStream(opts: GuardedFlushOpts): GuardedFlushResult {
  const { textStream, screen, fallbackFor, persist } = opts;

  let resolveDone!: () => void;
  const done = new Promise<void>((resolve) => {
    resolveDone = resolve;
  });

  const readable = new ReadableStream<Uint8Array>({
    async start(controller) {
      let full = "";
      let emittedLen = 0;
      let suppressed = false;
      let lastViolations: readonly string[] = [];
      let aborted = false;

      // enqueue-after-cancel (client disconnect) throws — swallow so the loop
      // still drains the model stream and persists.
      const safeEnqueue = (s: string) => {
        if (s.length === 0) return;
        try {
          controller.enqueue(TEXT.encode(s));
        } catch {
          /* client gone; keep draining + persist */
        }
      };

      // close-after-cancel throws the same way as enqueue-after-cancel; an
      // unguarded throw here would skip resolveDone() and leave after(done)
      // holding the invocation open until the platform timeout.
      const safeClose = () => {
        try {
          controller.close();
        } catch {
          /* client gone; done still resolves */
        }
      };

      try {
        for await (const chunk of textStream) {
          full += chunk;
          if (suppressed) continue; // draining; do not emit
          const boundaries = findBoundaries(full);
          const candidateLen = flushableLength(full, boundaries);
          if (candidateLen <= emittedLen) continue;
          let result;
          try {
            result = screen(full.slice(0, candidateLen));
          } catch {
            // Screening threw -> fail closed.
            suppressed = true;
            lastViolations = [];
            continue;
          }
          if (result.safe) {
            safeEnqueue(full.slice(emittedLen, candidateLen));
            emittedLen = candidateLen;
          } else {
            suppressed = true;
            lastViolations = result.violations;
          }
        }
      } catch {
        // Stream error / abort: close at last clean flush, NO fallback.
        aborted = true;
      }

      if (aborted) {
        await persist(full.slice(0, emittedLen), { violated: false, aborted: true });
        safeClose();
        resolveDone();
        return;
      }

      if (!suppressed) {
        // Clean completion: final full-text screen releases the held tail.
        let finalScreen;
        try {
          finalScreen = screen(full);
        } catch {
          finalScreen = { safe: false, violations: [] as readonly string[] };
        }
        if (finalScreen.safe) {
          safeEnqueue(full.slice(emittedLen));
          await persist(full, { violated: false, aborted: false });
          safeClose();
          resolveDone();
          return;
        }
        // Late violation revealed only by the full-text screen.
        suppressed = true;
        lastViolations = finalScreen.violations;
      }

      // Violation path: flushed clean prefix + fallback (fallback alone when none).
      const fallback = fallbackFor(lastViolations);
      const emitted = full.slice(0, emittedLen);
      const shownFallback = emittedLen > 0 ? `\n\n${fallback}` : fallback;
      safeEnqueue(shownFallback);
      await persist(emitted + shownFallback, { violated: true, aborted: false });
      safeClose();
      resolveDone();
    },
    cancel() {
      // Client disconnected. The loop is driven by the model stream, not the
      // reader, so it continues to completion and persists. Nothing to do here.
    },
  });

  return { readable, done };
}
