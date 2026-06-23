# 20-Stage Improvement Program — Sign-off & Honest Residuals

Plan: `docs/superpowers/plans/2026-06-22-autonomous-improvement-20-stage-plan.md`.
Pillars: (A) AI, (B/C′) invoice experience, (C) eliminate bugs via adversarial
review, (D) UX/a11y. This is the Stage-20 final pass — **not** an "absolute
perfection" claim; it records what shipped, what's deliberately deferred, and why.

## Final gate (all green together)
- `tsc` 0 · `lint` **0 errors** (63 warnings — see residuals) · `npm run test:unit` **2840 pass** / 1 skipped · `npm run eval` **30/30** (0 critical) · `npm run eval:promptfoo` **6/6** · `npm run eval:redteam` **8/8** · `npm run build` green.

## What shipped (real defects found + fixed)
- **S1 money loop:** atomic SQL increment/decrement (neon-http has no row locks → absolute writes lost-update/over-collect); portal pay false-success blocker → 422/409.
- **S2 FieldPulse:** fail-closed on a non-hex webhook secret (empty-key HMAC forge).
- **S3 lint→0:** 79→0 errors; caught a real bug (`channel` typed as the enum *builder*).
- **S4/S5:** no genuine cascading-render bug; 60 unused-vars → 0.
- **S6–S10 AI:** adopted promptfoo (MIT); 6 critical guardrails on the real chat path; red-team **found + fixed a prompt-injection scope-break**; measured tuning (no safe gain past judge-noise); chatbot review → `metadata.verify` regression test + **2 output-guardrail bypasses fixed** ("you are booked", how-to "replace the capacitor").
- **S11–S15 invoice:** source-aware revenue/AR (no native+synced double-count); detail read-only affordance extracted + tested; 409 `synced_read_only` flow tests; defensive bounded FieldPulse pagination; E2E review (no blockers/majors).
- **S16–S19 UX/a11y:** customer-list + dispatch error states w/ retry; chat offline state; streaming-renders tests; 5 critical a11y label violations → 0; UX/a11y review.

## Honest residuals

### Lint warnings (63, by design — NOT zeroed)
- **55 `react-hooks/set-state-in-effect`** — the idiomatic async-fetch-then-setState hooks (setState runs after the `await`, not a render loop). Documented residual per the plan; suppressed-with-reason only where escalated to error.
- **~8 minor** — `@next/next/no-img-element` (×2), `react-hooks/exhaustive-deps` (×3), React-compiler `purity`/memoization notes (×3, suppressed-with-reason where load-bearing). None are dead code or bugs.

### Key-blocked / deferred (wired, not faked)
- **FieldPulse live-probe** (S14): the `page` pagination param, the `listAvailability` endpoint, and the integer invoice **status codes** are unconfirmed (no fresh key + vendor docs). Code is defensive: pagination works whether or not `page` is honored; `mapFieldpulseInvoiceStatus` falls back to `unknown` and **amount-derivation stays the source of truth**. `smoke:fieldpulse` is key-gated.
- **HCP**: no key — live verification deferred (mirror is at FieldPulse parity, duplicated-not-abstracted).
- **GLM model**: out of balance (429). Reverted primary to qwen-dashscope; GLM is wired in the registry — flip `DEFAULT_MODEL_ID` + the two promptfoo graders once funded (operator chose not to recharge for now).
- **Automated axe gate** (S18): `@axe-core/playwright` over the named flows needs the dep + a running server (not the offline gate). Static fixes resolved the serious/critical rules; wiring the runtime axe sweep into the e2e suite is a CI follow-up.
- **AI judge bias**: single-model self-judge (no funded 2nd judge); inter-variant deltas are trustworthy, absolute rates are not. Documented.

### Rejected-with-reason (adversarial reviews)
- FieldPulse "money blockers" (S2): synced invoices are read-only → no native money moves; display/observability minors only.
- Reporting per-cohort location/tech "double-count" (S11 review): each invoice counted once; the only exposure is the rare native↔synced *mirror* anomaly, which the data has no same-bill linkage to dedupe. `getSalesReport` holds the authoritative split.
- Invoice "Date-vs-string" + "synced-source asymmetry" (S15): idiomatic Next serialization / correct defense-in-depth — not bugs.
- `syncedCollectedCents` is a creation-cohort, paid-to-date figure (no synced per-payment dates) — labeled, not blended with native gross.
- Reconcile POST left admin-gated (S1): it reflects provider truth, not money-out; documented operator action.

### Known limitations (tracked, not addressed this program)
- Double-submit double-charge needs request-level idempotency (a real-Stripe-adapter concern). The client-side rate-limiter is best-effort politeness atop FieldPulse's own 429 backoff. Refund has no reconcile sweep (lower-probability than the lost-updates fixed in S1).

## Deploy status (operator's call — NOT fired autonomously)
Local `main` is ~100+ commits ahead of `origin/main`, with uncommitted in-flight
FieldPulse work in the tree and **two un-run migrations (0034, 0035)**. A push
triggers a Vercel **production** deploy WITHOUT those migrations → 500s on the new
columns. A safe deploy needs a coordinated **push + `npm run db:migrate`**.
