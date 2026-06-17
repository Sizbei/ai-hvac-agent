# Productization Plan — 20 Stages to a Real Product

Turning the AI-HVAC platform from an impressive single-tenant demo into a real,
sellable multi-tenant SaaS. Derived from a 3-track audit (UI/UX refinement,
code/production-readiness, chatbot). Each stage is **independently shippable**,
sequenced so foundations land before the things that depend on them.

**Honest starting point:** architecturally multi-tenant, security/correctness-solid
for one org, ~2,290 passing unit tests, disciplined `withTenant`/AES-GCM/consent.
The gap to "real product" is: (1) can't onboard a 2nd customer, (2) money seams are
mocks, (3) ops/infra deficits, (4) UI refinement debt outside the 3 refreshed screens.

Legend: effort **S/M/L** · `[gated: X]` = needs an external account/contract/decision.

---

## Track A — Foundation & Ops (do first; everything else rides on these)

### Stage 1 — CI test gate + fix the real regressions · S
- [ ] Add `test:unit` (`vitest run`) script + run it in CI as a blocking gate (today CI runs only Playwright, which can't pass without a DB).
- [ ] Fix the 2 genuine regressions: `src/lib/admin/queries.test.ts` (3 tests — `toISOString` on undefined ~`queries.ts:1004`) and `tests/e2e/smoke.test.ts` (4 tests — chat/login/session 500 vs 200 under mocks).
- [ ] Enforce the existing 80% coverage threshold from `vitest.config.ts` (currently never invoked).
- [ ] Either give Playwright a CI database or drop it from the blocking job (keep as a manual/nightly suite).
- [ ] Document the known env-gated baseline failures so CI red ≠ noise.

### Stage 2 — Error tracking + alerting · S–M · [gated: Sentry]
- [ ] Wire Sentry (or equiv) server + client with release tracking (today: zero error aggregation — only pino→stdout + Vercel analytics).
- [ ] Alert rules: error-rate spike, failed cron, webhook failures, failed payment reconcile.
- [ ] Scrub PII from captured events (reuse the redaction key-list).

### Stage 3 — Environment separation · M · [gated: Neon branching]
- [ ] Stop sharing one `DATABASE_URL` for dev + prod (current state per MEMORY).
- [ ] Neon branches/projects: prod / staging / ephemeral-preview; preview deploys → ephemeral branch.
- [ ] Move secrets to per-env Vercel envs; document which keys live where.

### Stage 4 — Migrations on deploy · M
- [ ] Add a migrate step to the deploy pipeline (CI job vs prod, or build hook) — today migrations are manual `npm run db:migrate` and silently skipped on deploy (drift → 500s on `.returning()`).
- [ ] Forward-only chain; never re-squash; reconcile the journal (on-disk at `0011`, ledger backfilled). Write the runbook.
- [ ] Guard: migrations run against the right env only; dry-run/plan output in CI.

### Stage 5 — Reliability hardening (audit quick-wins) · S
- [ ] `AbortSignal.timeout()` on all outbound integration calls: Fieldpulse `client.ts:306` (also bypasses retry on network err), Housecall `client.ts:270`, Google Calendar `client.ts:121`, AI hot paths (`chat/route.ts` streamText, `extract.ts` generateText).
- [ ] (Verify, may be done) `reconcilePayment` already guards `status !== "pending"` before `getCharge` (`invoice-queries.ts:382`). For true concurrency-safety make it atomic: `UPDATE ... WHERE status='pending' RETURNING` rather than read-then-guard. Not an open bug today — only harden if concurrent reconciles are possible.
- [ ] Schedule the orphaned cron `/api/cron/sync-fieldpulse-availability` (not in `vercel.json` → never runs) or delete the route.
- [ ] PII logs: rename `from`→`phone` in 4 `sms/incoming` log lines so redaction catches it; log `error.message` only in twilio/resend adapters.
- [ ] Make the financing seam consistent: check `WISETACK_API_KEY` + emit the loud warning like the other seams.
- [ ] Clean env-validation phantoms (`TWILITY_WHISPERNamespace`, `TWILIO_API_KEY` vs `TWILIO_AUTH_TOKEN`; R2 required/optional mismatch).

---

## Track B — Design system & refinement ("redo what's not refined")

### Stage 6 — Shared design-system primitives · M
- [ ] `PageShell` — one wrapper (`mx-auto max-w-[1280px] space-y-7 p-6 sm:p-7`); fixes ~15 pages of max-width/padding/spacing drift in one move.
- [ ] `PageHeader` — title + subtitle + right-aligned actions slot (headers are re-implemented per page today).
- [ ] `EmptyState` — `{icon, title, description, action?}` rendering the icon-in-circle pattern; cover all 4 kinds (first-run / no-results / error / filtered).
- [ ] Semantic color tokens: `success`/`warning`/`danger` (+ light variants) + the chat per-category palette in `design-tokens.ts`/Tailwind, to replace hardcoded `gray/green/amber/blue`.
- [ ] Consolidate on the shared `StatusBadge`; delete local redefinitions (reviews, customers/[id]) + monochrome one-offs (invoices/[id], portal, tech).
- [ ] Skeleton-shape contract: reusable `TableSkeleton`/`CardSkeleton` that mirror real layout.
- [ ] a11y primitives: `aria-label` on icon buttons, `focus-visible:ring` on ad-hoc controls.

### Stage 7 — Redo unrefined admin pages to the bar · M
- [ ] **communications/templates** — full rebuild (worst offender: raw fetch, `border-blue-600`, `text-gray-900`, native `confirm()`, hand-rolled modal div). Move to Card/Button/Dialog/StatusBadge/Skeleton.
- [ ] Apply `PageShell` + `PageHeader` to: requests, customers (+[id], **no padding today**), calendar, dispatch, estimates(+[id]), invoices(+[id]), pricebook, inventory, membership-plans, reviews, reports, insights, integrations, staff, audit-log.
- [ ] Replace bare-text empty states with `EmptyState` across the same pages.
- [ ] Standardize `space-y-7` + card `p-5`; wrap bare tables (pricebook/inventory/membership) in `Card`.
- [ ] Shape skeletons to layout (audit-log grid, customers/[id] cards).

### Stage 8 — Redo customer-facing surfaces · M
- [ ] Token discipline on `estimates/[token]`, `portal/[token]`, `review/[token]` (replace pervasive `gray-*`/`white`/`green-50`/`amber-400` with `border-border`/`bg-background`/`text-foreground`/semantic tokens; fixes dark-mode + brand).
- [ ] `<Button>` for all CTAs — especially the money/approve "ending" actions (portal Pay `bg-gray-900`, review CTA `<a bg-gray-900>`).
- [ ] Brand the chat widget header (`chat-header.tsx` "HVAC Assistant" → BrandMark + Spears); tokenize the status dot + quick-reply/extraction/feedback palettes.
- [ ] Tech pages: urgency/priority color hierarchy on job badges, `Select` instead of native `<select>`, focus rings on remove buttons, skeletons for async.
- [ ] Address-autocomplete dropdown: `max-h`+overflow or mobile Sheet (clip risk at viewport bottom).

---

## Track C — Become real multi-tenant SaaS

### Stage 9 — Tenant onboarding / org provisioning · L
- [ ] Org-creation path beyond `seed.ts` (the only `insert(organizations)` today): signup → org + first super_admin user + default `organizationSettings` + comms-template seeding, all in one `db.batch()`.
- [ ] `organizations` columns: owner, status (active/suspended/trial), createdBy.
- [ ] Super-admin "create/manage tenant" console at minimum; self-serve signup ideally.
- [ ] New-org smoke: every per-org default resolves (config-queries already lazy-default — verify across all surfaces).

### Stage 10 — SaaS billing for the platform itself · L · [gated: Stripe]
- [ ] `organizations`: `plan`, `subscriptionId`, `stripeCustomerId`, `status`, trial/seat fields.
- [ ] Stripe Billing: Checkout + customer portal + subscription webhooks (distinct from customer-payment Stripe in Stage 11).
- [ ] Entitlement gating (feature/seat/usage limits per plan) + suspended-tenant state (read-only or blocked).
- [ ] Dunning for the SaaS subscription (separate from customer-invoice dunning).

---

## Track D — Make the money seams real

### Stage 11 — Real Stripe payments adapter · M · [gated: Stripe + Connect decision]
- [ ] `npm i stripe`; `StripePaymentProvider` behind the existing seam (interface already maps `idempotencyKey` + `getCharge` for reconcile).
- [ ] `/api/webhooks/stripe` (signature-verified) → payment status mirror + reconcile.
- [ ] Per-org encrypted Stripe key storage; flip `getPaymentProvider()` to return live when configured (today returns mock even with key set).
- [ ] Connect decision: who receives funds (platform vs per-org accounts).
- [ ] Tests: real payment path + webhook + cross-tenant + the existing refund-state invariants.

### Stage 12 — Real financing adapter · M · [gated: Wisetack/lender contract]
- [ ] `WisetackFinancingProvider` behind the seam; webhook status mirror (own dedupe key).
- [ ] Never quote APR/Reg-Z — provider owns terms (keep current guardrail).

### Stage 13 — Real accounting export · L · [gated: QBO app]
- [ ] QBO OAuth + token refresh + journal-entry mapping + a `push()` method (interface change); keep CSV/IIF as fallback.
- [ ] super_admin-gated + access-controlled download (already pattern).

### Stage 14 — Vendor / purchasing adapter · M–L · [gated: distributor API]
- [ ] Real `submitOrder` behind the seam (today a no-op); or formally document deferral + keep PO as internal record.

---

## Track E — Scale, observability, security, launch

### Stage 15 — Cron/queue at scale · S–M · [gated: Vercel Pro]
- [ ] Vercel Pro (sub-daily crons) or a real queue; move time-sensitive jobs (reconcile, comms, dunning) off the daily ceiling (7 daily crons already maxed; 24h lag unacceptable for payment retries at scale).

### Stage 16 — Ops & money observability · M
- [ ] Dashboards: error rate, cron health, webhook success, payment success/stuck, comms-outcome (the `getCommsOutcomeSummary` surface), bot intent/abandon/escalation.
- [ ] "Needs attention" surfaces wired to alerts (stuck `pending` payments already have a query — alert on it).

### Stage 17 — Security & compliance for GA · M · [gated: A2P 10DLC]
- [ ] A2P 10DLC registration (hard gate for outbound SMS volume).
- [ ] Move rate-limiting from in-memory (`rate-limit.ts`) to a durable store (Upstash/Redis) — in-memory is per-lambda, useless at scale.
- [ ] PII review + log scrub pass; webhook-secret rotation runbook; pen-test pass.
- [ ] Data-retention + deletion (GDPR/CCPA "delete my data") path for encrypted PII.

### Stage 18 — Critical-path test coverage + real E2E · M
- [ ] Tests for: real payment path + webhook, financing webhook, customer-session token, a live cross-tenant leak test.
- [ ] An E2E suite that actually runs in CI (against a seeded staging DB).

### Stage 19 — Performance & scale · M
- [ ] Query/index review (the big list + reporting aggregates); N+1 sweep.
- [ ] Caching where safe (per-org config, pricebook); load test the chat + money paths.

### Stage 20 — Docs, runbooks, launch · M
- [ ] Operator docs + in-app help/onboarding; admin runbooks (migrate, rotate secrets, incident).
- [ ] Status page + backup strategy (Neon PITR configured + documented).
- [ ] GA launch checklist; pricing page; T&Cs/privacy; support channel.

---

---

## Review revisions (architect sign-off — REVISE→addressed)
Gaps the review surfaced, folded in (keep the 20-stage spine; these slot into existing stages):
- **Data-deletion / GDPR — promote out of Stage 17 into Track C (with Stage 9).** Per-customer "delete my data" + per-tenant purge, cascading `customers`/conversations/invoices/audit **and the HMAC blind-index columns** (see [[customer-dedupe-blind-index]]); retention windows. Multi-tenant correctness, not launch polish. Also expose end-customer deletion via the portal.
- **Tenant offboarding / export — add to Track C.** Data export (CSV/JSON dump) + account suspension/teardown when a tenant leaves (B2B-contractual).
- **White-label / per-org branding — expand Stage 8/9 beyond the chat header.** Org-config-driven brand name, logo, colors, email "from", voice persona. Gates demoing to customer #2 (Spears is hardcoded today). Establish the pattern via the chat-header brand fix (First Move #3).
- **Stage 17 additions:** cross-tenant authz as a **CI-enforced suite** (not one test); legal surface = ToS + privacy + **DPA/subprocessor list** + tenant data-processing consent (Stage 20's single bullet is too thin); SLA/uptime definition + incident-response runbook.
- **Stage 20 addition:** a **tested restore drill** (Neon PITR "configured" ≠ "we restored from one").

## Sequence summary
**Now:** Stages 1–5 (ops foundation) — cheap, de-risk everything. **Then:** 6–8 (design-system + refinement, the "redo unrefined" work). **Then:** 9–10 (multi-tenant + SaaS billing — the actual "product" unlock). **Then:** 11–14 (real money, as contracts/keys land). **Then:** 15–20 (scale + GA). Money seams (11–14), billing (10), A2P (17), Pro/Sentry/Neon are externally gated — start their procurement in parallel with Track A/B.
