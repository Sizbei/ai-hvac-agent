# Prompt variants (A/B candidates for `npm run eval:prompts`)

Drop a `*.txt` file here to A/B a candidate system prompt against the live
baseline (`SYSTEM_PROMPT` from `src/lib/ai/system-prompt.ts`).

- **Filename** (without `.txt`) becomes the variant's label in the report.
- **Contents** must be a *complete* system prompt — the harness sends it verbatim
  as the `system` message (start it with `/no_think` to match the baseline).
- Empty/whitespace-only files are ignored.

```bash
# baseline only (a quality snapshot of the live prompt)
npm run eval:prompts

# baseline vs your candidate(s)
cp ../../system-prompt-snapshot.txt softer-tone.txt   # or hand-write one
npm run eval:prompts
```

The harness holds the **model fixed** (first registry model whose API key is set,
used for BOTH generation and judging) so the only axis is the prompt. With no key
configured it prints "skipped" and exits 0 — it never runs in CI.

**Read the deltas with care:** the LLM judge is noisy (≈ ±0.3–0.5 on the 1–5
scale over this small corpus). Generation and judging use the **same** model, so
it grades its own answers — absolute scores skew high; trust the inter-variant
**delta**, not the raw numbers. Treat sub-0.5 deltas as noise. Safety is **not**
measured here — it is gated by the deterministic `npm run eval`. Per the
frozen-safety-text rule, do not weaken the SCOPE / ACCURACY / DANGEROUS-DIY /
HAZARD blocks in a candidate prompt; tune only style/voice/shape text.

Candidate `.txt` files are git-ignored (this README and the rule are tracked).
