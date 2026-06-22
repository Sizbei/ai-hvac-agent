# Autonomous Improvement Program — 20 Stages (hardened)

**Mode:** max-autonomous engineering. **Confirmed scope:** full program, 20 stages.
**Pillars:** (A) improve the AI, (B) improve the invoice experience, (C) eliminate bugs via adversarial review, (D) improve UX overall.
**Hardened 2026-06-22 after a 4-critic adversarial review** (prioritization, feasibility, regression-risk, scope/done-criteria).

## Definition of "done / perfect and tested" (the bar every stage clears)
Green gates — `tsc` · `lint` (**0 errors**; warnings triaged, see below) · `npm run test:unit` · **`npm run eval` 30/30 (0 critical)** · `npm run build` — **plus** an adversarial-review round that converges with zero open blockers/majors on the touched surface, **plus** live-validation where a key exists. Each stage commits → merges → deploys.

- **Lint bar:** 0 *errors*. Warnings are *triaged*, not zeroed: genuine bugs fixed; the idiomatic fetch-in-`useEffect` pattern is suppressed-with-reason or left as documented residual. ("0 problems" is NOT the bar — ~40 fetch hooks fire the benign `set-state-in-effect` warn rule.)
- **UX bar (autonomous-checkable):** an agent has no eyes, so "visual review" is NOT a gate. UX stages gate on: axe-core 0 serious/critical · design-system components used (Button/Card/Input/etc.) · loading+empty+error states present · responsive at mobile width · keyboard nav on the named flow. Subjective polish (spacing feel, "warmth", motion taste) is **deferred to human review**, not blocking.
- **Honest "perfect":** the program reaches done on every *finishable* stage; parts genuinely blocked on an external key are **wired + documented + deferred with the reason** — never faked.

## Finishability (external-input reality)
- **DashScope (`AI_API_KEY`)** — WORKS/funded (verified: `eval:behavior` produced real scores). The AI eval/red-team/measured-tuning stages CAN produce signal.
- **GLM** — out-of-balance (no second judge model → self-judge bias stands; documented).
- **FieldPulse key** — was shared in chat → assume rotated/dead; the live-probe items (pagination param, `listAvailability` real endpoint, integer `status` codes) are **blocked** without a fresh key + vendor docs.
- **HCP key** — none. HCP live verification is **blocked**.

**Baseline (2026-06-22):** tsc/tests(2793)/eval(30/30)/build green; lint = 198 → **196** problems (75 errors, 121 warnings) after the first Stage-(lint) batch already shipped (`369a34f`).

---

## Pillar C first — Eliminate bugs (Stages 1–2), then stabilize (3–5)
*(Reordered per review: bug-finding on the highest-risk surfaces precedes cosmetic lint; the floor is already green so no bug hides under lint noise.)*

1. **Adversarial review — money loop.** Blind multi-critic review of `invoice-queries.ts` (takePayment / refundPayment / reconcilePayment / createInvoiceFromSoldEstimate) + payment provider seam + reporting. Fix verified blockers/majors; regression test the take→refund→reconcile sequence. *(finishable now)*
2. **Adversarial review — integrations (FieldPulse-scoped).** FieldPulse webhooks (signature, idempotency, org-derivation), money guards, the live-verified client. Fix; tests. **HCP review deferred** to a needs-key follow-up (HCP is unverified/mock-first; reviewing inferred shapes is low-value until a live probe). *(FieldPulse finishable now; HCP deferred)*
3. **Lint errors → 0 (src-first, per-file gates).** Eliminate error-level violations (`no-explicit-any`, `no-require-imports`, etc.). **Production `src/` first**, then tests. **One file at a time → run that file's tests after each → never batch** (a wrong cast can hide a real type bug in a money/webhook mock). Test-file `any` in pure mock setup may use a scoped `eslint-disable` + reason where real typing is ceremony. Gate: `lint` 0 errors; full suite green. *(finishable now)*
4. **Cascading-render triage.** Fix GENUINE bugs only (synchronous `setState` in an effect body; derived-state-in-effect; unguarded loops). The canonical `fetch().then(setState)` in try/finally is idiomatic → suppress-with-reason + one-line note, not refactor. Gate: real bugs fixed; warnings reduced with every residual suppressed-with-reason; suite green. *(finishable now)*
5. **Dead-code + unused cleanup.** Remove unused vars/imports. Gate: lint 0 errors; warnings only the documented fetch-hook residual. *(finishable now)*

## Pillar B — Improve the AI (Stages 6–10)
6. **Adopt promptfoo (MIT).** `npm i -D promptfoo`; `promptfooconfig.yaml` with a DashScope provider (key from env). Gate: `npx promptfoo eval` exits 0 with no key (clean skip) AND runs real evals with `AI_API_KEY`. *(finishable now — DashScope works)*
7. **Guardrail assertions.** Port the 6 critical eval properties (pricing-leak, false-booking, emergency-escalation, injection-block, off-scope-deflection, dangerous-DIY-refusal) to promptfoo `assert`s against the real chat path. *(finishable now)*
8. **Red-team sweep.** Jailbreak / prompt-injection / PII-leak plugins as `npm run eval:redteam` (key-gated; not the offline CI gate). **Run against DashScope**, triage + fix real findings. Gate: red-team run produced + findings triaged. *(finishable now via DashScope)*
9. **Measured prompt tuning.** Use `eval:behavior` + promptfoo (DashScope) to MEASURE T1/T3/T4 + no-pitch-on-education and iterate. **Bounded:** ≤3 edit rounds; ship when behavior rates stop improving past judge-noise. **Invariant:** the frozen blocks — SAFETY GATE, SCOPE BOUNDARY, ACCURACY DISCIPLINE, DANGEROUS-DIY REFUSAL, HAZARDS, KEEP-EXISTING-GUARDRAILS (in `hvac-knowledge.ts`) — are off-limits; run `npm run eval` 30/30 **after each prompt edit** before committing. *(finishable now via DashScope)*
10. **Adversarial review — chatbot.** Router/guardrails/output-screening + voice↔web parity. **Must include a test that `metadata.verify` survives the voice gather-route async extraction** (documented lockout-wipe bug class). Fix; eval stays 30/30. *(finishable now)*

## Pillar C′ — Improve the invoice experience (Stages 11–15)
11. **Source-aware reporting.** Revenue/AR/aging reads group by source so a request with BOTH a native and a synced invoice is never double-counted. Tests. *(finishable now)*
12. **Invoice detail UX (functional).** Loading/empty/error states, synced read-only affordances, line-item + margin display. Gate: build · states present · design-system components · tests for the states. (Subjective polish → human-deferred.) *(finishable now)*
13. **Native money-flow UX.** Take-payment / refund / reconcile: validation, error messaging, disabled states; **the 409 `synced_read_only` surfaced gracefully — with a test for that response path.** Gate: build + the 409-flow test. *(finishable now)*
14. **FieldPulse P2 — finishable subset.** Wire pagination support + status-code mapping **defensively** (code that works whether or not the param/codes are confirmed; amount-derivation stays the source of truth). **Live confirmation of the pagination param, `listAvailability` endpoint, and integer status codes is DEFERRED — blocked on a fresh FieldPulse key + vendor docs** (documented, not faked). Gate: code + unit tests; `smoke:fieldpulse` only when a key is provided. *(partially blocked — offline subset finishable)*
15. **Adversarial review — invoice experience.** End-to-end (data model → queries → routes → UI). Gate: all blockers fixed + tested; majors fixed or tracked-with-reason. *(finishable now)*

## Pillar D — Improve UX overall (Stages 16–19) — narrowed + auto-checkable
16. **Admin UX pass — core surfaces** (login, customer list, invoice detail, dispatch board). Gate: design-system components used · loading/empty/error states · responsive · build. *(finishable now)*
17. **Chatbot widget UX (functional).** Loading/empty/error/offline states, streaming renders incrementally, responsive/mobile. Gate: states + responsive + a streaming-renders test. (Felt latency/"warmth" → human-deferred.) *(finishable now)*
18. **Accessibility pass — named flows.** axe-core 0 serious/critical on login → customers → invoice → payment + the chat widget; all inputs labeled; alt/aria on images; heading hierarchy. Manual keyboard nav documented. *(finishable now)*
19. **Adversarial review — UX & accessibility.** Review the Stage 16–18 changes for regressions + missed a11y/states. Fix. *(finishable now)*

## Pillar E — Finish (Stage 20)
20. **Final integration pass + sign-off** (distinct from 19's UX-focused review): all gates green together, whole-system smoke, deploy, update docs (INTEGRATIONS/EVAL/ARCHITECTURE/NOTES) + memory, and an **honest residuals report** — remaining warnings (with reasons), key-blocked items (FieldPulse live-probe, HCP), and any rejected/deferred findings. No "absolute perfection" claim. *(finishable now)*

---

## Risks (post-hardening)
- "Remove ALL bugs / til perfect" is unbounded → bounded by the done-bar + honest residuals.
- AI signal depends on DashScope (works); GLM-as-second-judge unavailable → self-judge bias documented, not hidden.
- FieldPulse live-probe items (Stage 14) + HCP (Stage 2/14) blocked on keys → wired + deferred, not faked.
- Bulk lint edits can introduce bugs → mitigated by per-file gates + suite-per-file.

## Execution
Stages in order. Each independently shippable (commit → merge → deploy) and clears its gate. Adversarial review at Stages 1, 2, 10, 15, 19, 20. Already shipped: a first lint batch (`369a34f`, require→import + entity).
