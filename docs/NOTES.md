# Engineering Notes

A running log of research, decisions, and things worth remembering that don't
belong in a formal spec. Newest first.

---

## 2026-06-22 — Adopt `promptfoo` (MIT) to improve the chatbot's eval + red-teaming

**Recommendation:** [`promptfoo/promptfoo`](https://github.com/promptfoo/promptfoo)
— **MIT license**, **22.4k★** (verified via `gh api repos/promptfoo/promptfoo`
on 2026-06-22). "Test your prompts, agents, and RAGs. Red teaming / pentesting /
vulnerability scanning."

MIT is the same permissive license VS Code's source is released under, so it
satisfies the licensing requirement and is safe to vendor in / depend on with no
copyleft obligations. (We'd use it as a **devDependency / CLI tool**, not ship it
to customers, so license risk is nil either way.)

### Why it fits our chatbot specifically

Our memory flags the real gap: the deterministic eval (`npm run eval`) gates
safety but **can't judge LLM answer quality**, the LLM-judge is **noisy**, and
quality is currently **eyeballed** (see [EVAL.md](../EVAL.md) and the
chatbot-prompt-tuning work). promptfoo closes exactly that gap:

- **Assertion-based eval** — encode our hard guardrails as declarative checks
  (never leak a `$` price, never claim "booked/scheduled/confirmed", escalate
  emergencies, refuse off-scope, refuse dangerous DIY) and run them across prompt
  *and* model variants. This is the real `compare-prompts` / less-noisy judge we
  wanted (it supports deterministic assertions + LLM-rubric + similarity).
- **Red teaming** — automated jailbreak / prompt-injection / PII-leak / harmful-
  output probes. Directly strengthens our injection-block + scope-boundary +
  output-guardrail layers with adversarial coverage we don't generate by hand.
- **OpenAI-compatible providers** — points at any OpenAI-compatible base URL, so
  it drives our existing DashScope/GLM providers (`AI_BASE_URL` / `GLM_BASE_URL`)
  with no new plumbing.
- **CI-friendly + config-driven** — a YAML config in-repo; runs headless and
  fails the run on a regression. Keep our offline deterministic `eval.test.ts` as
  the always-on CI gate; add promptfoo as the deeper, **key-gated** layer
  (matches how `eval:ab` / `smoke:fieldpulse` are key-gated).

### Alternatives considered (license-verified 2026-06-22)

| Repo | Stars | License | Note |
|---|---|---|---|
| **promptfoo/promptfoo** | 22.4k | **MIT** ✅ | eval + red-team; OpenAI-compatible; CI-first — **chosen** |
| confident-ai/deepeval | 16.4k | Apache-2.0 | great pytest-style eval, but Apache (not MIT) and Python |
| guardrails-ai/guardrails | 7.0k | Apache-2.0 | runtime output validation; Apache, Python |
| NVIDIA-NeMo/Guardrails | 6.5k | NOASSERTION (custom) | not a standard permissive license — fails the MIT requirement |
| Arize-ai/phoenix | 10.2k | NOASSERTION (Elastic v2) | observability; source-available, not MIT |

deepeval and guardrails are permissive (Apache-2.0) and worth knowing about, but
the explicit ask was MIT — promptfoo is the only battle-tested MIT match, and it
also happens to be the best fit (TS/Node like our stack, OpenAI-compatible).

### Adoption plan (when we pick this up)

1. `npm i -D promptfoo`; add `promptfooconfig.yaml` with two providers pointed at
   our DashScope + GLM base URLs (key-gated, like `eval:ab`).
2. Port the golden-transcript **critical** properties (pricing-leak,
   false-booking, emergency-escalation, injection-block, off-scope-deflection,
   dangerous-DIY-refusal) into promptfoo `assert` blocks, reusing the existing
   `PRICE_REGEX` / `FALSE_BOOKING_REGEX` ideas as `javascript`/`regex` asserts.
2b. Drive the assertions against the **real chat path** output, not a re-prompt,
   so we measure what ships (the gap the deterministic eval can't cover).
3. Add the red-team config (jailbreak + PII + injection plugins) and run it as a
   pre-release sweep: `npm run eval:redteam` (key-gated; not in the offline CI
   gate).
4. Keep `npm run eval` (deterministic, offline) as the CI gate; promptfoo is the
   richer, optional layer for prompt tuning + adversarial hardening.

**Status:** researched + recommended; not yet installed. Pick up under the
prompt-tuning thread when we want a real, less-noisy quality signal.
