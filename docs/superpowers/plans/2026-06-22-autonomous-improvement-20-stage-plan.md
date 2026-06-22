# Autonomous Improvement Program — 20 Stages

**Mode:** max-autonomous engineering. **Confirmed scope (2026-06-22):** full program, in order.
**Pillars:** (A) improve the AI, (B) improve the invoice experience, (C) eliminate bugs via adversarial review, (D) improve UX overall.

**Definition of "perfect and tested" (the bar every stage clears):**
green gates — `tsc` · `lint` · `npm run test:unit` · `npm run eval` (30/30) · `npm run build` —
**plus** an adversarial-review round that converges with zero open blockers/majors on the touched
surface, **plus** live-validation where applicable. Each stage commits → merges → deploys.

**Baseline (2026-06-22):** tsc/tests(2793)/eval(30/30)/build green; **lint = 198 problems (77 errors,
121 warnings)** — mostly `no-explicit-any` errors + "setState synchronously in an effect"
(cascading-render) warnings across hooks/dialogs.

---

## Pillar A — Stabilize the floor + de-bug core (Stages 1–5)

1. **Lint errors → 0.** Eliminate all 77 `no-explicit-any` (and other error-level) violations across `src/` + `tests/` with real types. Gate: `lint` 0 errors; suite green.
2. **Cascading-render bugs.** Fix genuine `setState`-in-effect cases (derived-state-in-effect, unguarded loops). For the standard fetch-in-`useEffect` hook pattern, apply the idiomatic fix or suppress-with-reason — triaged, not blanket. Gate: warnings materially reduced; no behavior regressions.
3. **Dead-code + unused cleanup.** Remove unused vars/imports flagged by lint; clean baseline. Gate: `lint` fully clean (0 problems) or documented residual.
4. **Adversarial review — money loop.** Blind multi-critic review of `invoice-queries.ts` (takePayment / refundPayment / reconcilePayment / createInvoiceFromSoldEstimate) + the payment provider seam. Fix verified blockers/majors; add regression tests.
5. **Adversarial review — integrations.** Review FieldPulse/HCP webhooks (signature, idempotency, org-derivation), money guards, the live FieldPulse client. Fix verified issues; tests.

## Pillar B — Improve the AI (Stages 6–10)

6. **Adopt promptfoo (MIT).** `npm i -D promptfoo`; `promptfooconfig.yaml` with providers pointed at our DashScope/GLM base URLs (key-gated). Gate: `npx promptfoo eval` runs (skips cleanly without keys).
7. **Guardrail assertions.** Port the critical eval properties (pricing-leak, false-booking, emergency-escalation, injection-block, off-scope-deflection, dangerous-DIY-refusal) into promptfoo `assert`s against the real chat path.
8. **Red-team sweep.** Add jailbreak / prompt-injection / PII-leak plugins as `npm run eval:redteam` (key-gated; not the offline CI gate). Triage + fix any real findings.
9. **Measured prompt tuning.** Run the now-real signal (promptfoo + `eval:behavior`) to actually measure T1/T3/T4 + the no-pitch-on-education behavior and iterate prompts against scores, not eyeballing. Keep the frozen-safety-text invariant.
10. **Adversarial review — chatbot.** Review router/guardrails/output-screening + voice↔web parity for correctness gaps. Fix; tests; eval stays 30/30.

## Pillar C — Improve the invoice experience (Stages 11–15)

11. **Source-aware reporting.** Ensure revenue/AR/aging reads group by source so a request with BOTH a native and a synced (FieldPulse/HCP) invoice is never double-counted. Tests.
12. **Invoice detail UX.** Loading/empty/error states, clearer synced read-only affordances, line-item + margin display polish (now that FieldPulse line items mirror). Gate: build + visual review.
13. **Native money-flow UX.** Take-payment / refund / reconcile flows: clearer validation, error messaging, optimistic/disabled states; the 409 `synced_read_only` surfaced gracefully.
14. **FieldPulse P2 (live-validated).** Pagination for >1-page accounts; confirm + encode the integer invoice `status` codes (probe live); fix `listAvailability` if feasible. Gate: `smoke:fieldpulse` passes.
15. **Adversarial review — invoice experience.** End-to-end review (data model → queries → routes → UI) for money-integrity + UX gaps. Fix; tests.

## Pillar D — Improve UX overall (Stages 16–19)

16. **Admin dashboard UX pass.** Apply `~/.claude/design-principles.md`: spacing/ratio, hierarchy, motion timings, component states across the admin surfaces.
17. **Chatbot UX pass.** Web widget: streaming/latency/warmth, empty/error/loading states, mobile.
18. **Accessibility pass.** Focus management, contrast, labels/ARIA, keyboard nav across admin + chat.
19. **Adversarial review — UX & cross-cutting.** Review the UX changes + accessibility + any cross-cutting regressions. Fix.

## Pillar E — Finish (Stage 20)

20. **Final hardening + sign-off.** Whole-system adversarial review; all gates green; deploy; update docs (INTEGRATIONS/EVAL/ARCHITECTURE/NOTES) + memory. Report residual *known* limitations honestly (no false "absolute perfection" claim).

---

## Risks
- "Remove ALL bugs / til it's perfect" is unbounded → bounded here by the explicit done-bar + honest residual reporting.
- promptfoo eval/red-team needs API keys to produce signal (DashScope works; GLM out-of-balance).
- HCP invoice work blocked on a live HCP key (stays best-effort/mock-first).
- Blanket lint-warning elimination (40+ fetch hooks) is high-risk/low-value → triaged, not forced.

## Execution
Stages run in order; each is independently shippable (commit → merge → deploy) and ends with its gate. Adversarial review is woven in at Stages 4, 5, 10, 15, 19, 20.
