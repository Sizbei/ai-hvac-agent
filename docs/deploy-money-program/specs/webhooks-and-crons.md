# Spec: webhook subscriptions and cron strategy

## 1. Purpose

Answer, with evidence, what "subscribe if possible and set up a cron job"
means for this codebase today: inventory every inbound webhook and every
cron, verify each one is authenticated and idempotent, determine whether
FieldPulse's API actually supports registering a webhook subscription, and
decide what (if anything) new is warranted under Vercel Hobby's daily-cron
floor. One job: a single evidence-grounded answer an operator can act on
without re-deriving the platform constraints.

## 2. Brainstorm

Ideas considered, kept or rejected:

- **Call FieldPulse's API to create a webhook subscription.** REJECTED —
  out of scope (GET-only probing), and the live probe found no
  discoverable webhooks/subscriptions resource (§3b). Nothing to POST to.
- **Stand up a second external scheduler** (Upstash QStash, cron-job.org).
  REJECTED — the repo already has a working, precedented answer to
  "Hobby can't do sub-daily": `.github/workflows/sub-daily-crons.yml`, a
  GitHub Actions ping every 5 minutes against the same `CRON_SECRET`-
  protected endpoints Vercel would call. A second scheduler fragments the
  ops surface for zero capability gain — extend the existing one instead
  (Rsync-2, Rsync-3).
- **A brand-new FieldPulse incremental-sync cron.** REJECTED — duplicates
  `.github/workflows/fp-nightly-sync.yml` (full daily sweep: technicians,
  customers, jobs, invoices, estimates, payments, assets, comments,
  locations, items, job-metrics) and the existing
  `sync-fieldpulse-availability`/`sync-fieldpulse-invoices` Vercel crons.
  Would be exactly the "duplicate one of the 11" the task warned against.
- **Upgrade to Vercel Pro for native sub-daily crons.** CONSIDERED, not
  decided here — a cost tradeoff for the account owner, flagged as an
  option (§6), not assumed.
- **Bump every sync cron to 5-minute GH Actions cadence "to be safe."**
  REJECTED — only two jobs demonstrate a sub-daily need (§4); the rest
  (cleanup, membership visits, dunning enqueue, availability, invoice
  backstops) are daily-appropriate by design and self-heal on schedule.
- **Build an HCP webhook subscription flow now.** REJECTED — no API key,
  0 connection rows (`FACTS.md`). No live account to subscribe against;
  the receiver already exists and needs nothing further until credentials
  do.

## 3. Current state

### 3a. Inbound webhook inventory (`verified`, all 7 read in full)

| Endpoint | Handles | Auth | Fail-closed? | Idempotent? |
|---|---|---|---|---|
| `POST /api/admin/integrations/fieldpulse/webhook` | FP job status + invoice status | HMAC-SHA256 `x-fieldpulse-signature`, per-org secret → env fallback | Prod only (dev optional) | Yes — `fieldpulseWebhookEvents` unique `(organizationId, eventId)` + `onConflictDoNothing` |
| `POST /api/admin/integrations/fieldpulse/invoice-webhook` | FP invoice status (separate legacy path) | Same as above | Prod only | Yes — same ledger |
| `POST /api/webhooks/housecall` | HCP job status | HMAC-SHA256 `x-housecallpro-signature`, per-org secret → env fallback | **Always** (no dev bypass) | Yes — `hcpWebhookEvents` unique `(organizationId, eventId)` + `onConflictDoNothing` |
| `POST /api/webhooks/saas-billing` | Org plan/status lifecycle (mock provider) | HMAC-SHA256 `x-saas-billing-signature`, `SAAS_BILLING_WEBHOOK_SECRET` | Always | Yes — `saasBillingEvents` unique `eventId` + `onConflictDoNothing` |
| `POST /api/webhooks/twilio` | SMS delivery status | Twilio's own signature algorithm (`x-twilio-signature`, URL+params HMAC) | Always | Effectively — status is an idempotent field write keyed by `externalId` |
| `POST /api/webhooks/resend` | Email delivery status | HMAC-SHA256 `resend-signature`, `RESEND_WEBHOOK_SECRET`, 5-min replay window | Always | Effectively — same pattern |
| `POST /api/financing/webhook` | Lender application status (mock provider) | Shared secret `x-financing-secret`, timing-safe compare | Always | Status write keyed by `providerAppId`, re-applying the same status is a no-op |

Evidence: `admin/integrations/fieldpulse/webhook/route.ts:82-270`,
`admin/integrations/fieldpulse/invoice-webhook/route.ts:127-168`,
`webhooks/housecall/route.ts:60-90`, `webhooks/saas-billing/route.ts:47-77`,
`webhooks/twilio/route.ts:27-31` + `lib/voice/twilio-signature.ts:39-50`,
`webhooks/resend/route.ts:28-37` +
`lib/communication/resend-adapter.ts:218-259`,
`financing/webhook/route.ts:33-41`, `lib/db/schema.ts:1448-1454` (FP ledger
unique index), `lib/integrations/housecall-pro/webhook-sync.ts:77-82` (HCP
ledger), `lib/billing/webhook-sync.ts:112-122` (billing ledger). All 7 fail
closed with no secret configured — zero unauthenticated webhook routes
found (`P0 count: 0` on this axis).

`src/proxy.ts:110-117` explicitly excludes the two FieldPulse webhook paths
from the admin-session gate, documenting they're server-to-server (HMAC,
not cookie) — `verified`.

### 3b. Does FieldPulse support programmatic webhook subscription?

**No discoverable endpoint** (`verified` by live GET probe,
inconclusive-to-negative). Base URL
`https://ywe3crmpll.execute-api.us-east-2.amazonaws.com/stage` (AWS API
Gateway, per `config.ts:17`). Probed 8 candidate paths with the real
`x-api-key` (read-only GET): `webhooks`, `webhook`, `webhook_subscriptions`,
`subscriptions`, `account/webhooks`, `notifications`, `events`, `hooks`.
Every one returned `HTTP 403 {"message":"Missing Authentication Token"}` —
**identical** to a garbage nonexistent path (`/this-path-does-not-exist`,
same 403/body), and distinct from a real endpoint: `GET /customers?limit=1`
with the same key returned `HTTP 200` and real data (`total_count: 2631`).
That message is AWS API Gateway's routing-layer response for a resource
that doesn't exist in its tree, not an auth failure on a real one —
reasonably strong evidence no webhook-management resource exists at these
paths.

**Not exhaustive** (an unguessed path or a private/partner API tier is
possible), so the honest verdict is **NO / not discoverable** — matching a
note already in the codebase before this probe: `connect/route.ts:28-30` —
*"Fieldpulse's public API may not expose webhook management; webhooks may
be configured manually in the Fieldpulse dashboard."* `connect` already
accepts an optional `webhookSecret` for exactly that manual scenario
(`connect/route.ts:32-43`).

**Consequence, verified via a read-only DEV-branch query**: the org's
`fieldpulse_connections` row has `connected=true`, `has_api_key=true`,
**`has_webhook_secret=false`**, and `FIELDPULSE_WEBHOOK_SECRET` is absent
from `.env.local`. So regardless of whether FieldPulse's dashboard can be
pointed at our endpoint, the two FP webhook routes **fail closed in
production right now** (`webhook/route.ts:235-241`,
`invoice-webhook/route.ts:137-143`) — correct by design, but the webhook
path is inert either way today.

Housecall Pro: moot. `FACTS.md` — no API key, 0 connection rows. No live
account to subscribe against.

### 3c. Cron inventory — the 11 in `vercel.json` (`verified`, all read in full)

| Cron | Schedule | Purpose | Daily genuinely sufficient? |
|---|---|---|---|
| `cleanup` | `0 3 * * *` | Expire/purge stale chat sessions, messages, GPS history | Yes — pure housekeeping |
| `webhook-cleanup` | `0 4 * * *` | Purge webhook-event ledgers >90 days | Yes — pure housekeeping |
| `booking-recovery` | `0 6 * * *` | SMS/web abandoned-booking recovery nudges + geocode backfill | Yes — TCPA-consent-gated nudges; faster cadence risks feeling spammy |
| `reconcile-payments` | `0 7 * * *` | Heal stranded `pending` payments (charge succeeded, local commit failed) | **No** — money-integrity healer; see G3 |
| `dunning` | `0 8 * * *` | Enqueue overdue-invoice + warranty reminders (send happens via `process-communications`) | Yes — daily dunning cadence is normal |
| `generate-membership-visits` | `0 9 * * *` | Materialize due maintenance visits (30-day window) | Yes — wide window, self-heals |
| `sync-fieldpulse-availability` | `0 10 * * *` | Pull FP technician roster + availability slots | Yes in practice — see note below |
| `sync-fieldpulse-invoices` | `0 11 * * *` | Backstop pull of FP invoices (webhook is primary path) | Yes — webhook-driven `after()` pull is the real-time path; this is only the retry backstop |
| `sync-housecall-invoices` | `0 12 * * *` | Same, for HCP (currently a no-op — 0 connections) | N/A today |
| `delay-sweep` | `0 13 * * *` | SMS dispatcher when a tech is running behind | See note — already sub-daily via GH Actions |
| `dispatch-digest` | `0 12 * * 1` (weekly) | Weekly auto-commit-rate collapse canary | Yes — trend detection, weekly is the right grain |

Note (`sync-fieldpulse-availability`): docstring says "e.g., every hour"
(`route.ts:7`) but it only runs daily. `inferred`: low real-world impact —
technician rosters don't churn multiple times a day, and the nightly FP
sweep (§3d) plus this cron keep it reasonably fresh. Stale comment, not a
functional gap (P2, no requirement).

Note (`delay-sweep`): docstring ("Daily on Hobby; bump to a few minutes on
Pro," `route.ts:37`) undersells its actual cadence — it's **already**
pinged every 5 minutes by `sub-daily-crons.yml:19-22`, with the
`vercel.json` daily entry as a redundant backstop. `verified`. This is the
pattern Rsync-2/3 extend for two other jobs below.

All 11 `verified` against `vercel.json` — all daily-or-weekly, all legal
on Hobby today. No cron-count or schedule-legality problem exists.

### 3d. The 12th cron route — not in `vercel.json`

`src/app/api/cron/process-communications/route.ts` exists, is the
**single SEND chokepoint** for every automated customer message (dunning
reminders, warranty reminders, review requests, payment receipts, booking
confirmations — `docs/page-program/specs/communications.md:52-65`,
`verified` cross-reference), and checks `verifyCronAuth` correctly
(`route.ts:27`). It is **not** one of the 11 entries in `vercel.json`. Git
history (`0a8d87f`, `d9eb053`, `35d00e3`) shows it was moved to GitHub
Actions because its documented design cadence is per-minute (`route.ts:7`,
`"CRON: * * * * *"`) — a schedule that would fail at deploy time on Hobby.
Its actual production schedule today: `sub-daily-crons.yml:15-18`, a
GitHub Actions ping every 5 minutes against `CRON_SECRET`. `verified`.
`payments/route.ts:99-113` also drains the queue inline via `after()`
right after a manual payment, so receipts don't wait even 5 minutes.

Unlike `delay-sweep`, `process-communications` has **no Vercel-native
daily backstop** — its only schedule is the GitHub Actions ping (G2).

### 3e. `CRON_SECRET` auth audit (`verified`, all 12 cron routes read)

Every cron route (the 11 in `vercel.json` plus `process-communications`)
calls `verifyCronAuth(request.headers.get("authorization"))`
(`cron-auth.ts:28-37`), which fails closed — returns `false` — when
`CRON_SECRET` is unset/blank, so a misconfigured secret never collapses to
an accepted `"Bearer "` (`cron-auth.ts:29-31`). Several routes (`cleanup`,
`webhook-cleanup`, `reconcile-payments`, `generate-membership-visits`,
`delay-sweep`, `dispatch-digest`) add an explicit pre-check that 503s when
`CRON_SECRET` is unset, before even calling `verifyCronAuth` — defense in
depth, not a gap. **Zero cron routes callable unauthenticated. P0: 0.**

### 3f. Idempotency audit (`verified`)

Money-moving/state-changing crons are all safe to double-run:
`reconcile-payments` re-asks the provider for ground truth
(`route.ts:1-15`); `dunning`/warranty use `claimOutboundOnce` per
`(org, customer, trigger, periodKey)` (`money-triggers.ts:450`,
`warranty-queries.ts:217`); `generate-membership-visits` is guarded by a
unique `(customerMembershipId, periodKey)` index (`route.ts:9-13`);
`sync-fieldpulse-invoices`/`sync-housecall-invoices` are idempotent on
`(org, invoiceId)`, read-only against the money authority; and
`process-communications` atomically claims `pending→processing` so
overlapping drains can't double-send (`job-queue.ts:142-159`).

Two SMS-alert crons have **best-effort, not atomic** dedup, both accepted
in their own comments: `delay-sweep` marks `delayAlerted` *after* a
successful send in a separate try/catch — a marker-write failure could
re-alert next sweep (`route.ts:87-102`, "best-effort dedup, never a
dropped alert"); `dispatch-digest` recomputes its collapse check fresh
each run with no persisted per-week claim. Both P2 — low frequency, not
money, and the accepted direction (occasional dup over a dropped alert)
is correct.

## 4. Gaps

| Gap | Severity | Evidence |
|---|---|---|
| FieldPulse webhook secret configured nowhere (no per-org, no env) — both FP webhook routes fail closed 401 to every inbound call in production, regardless of vendor-side configuration | P1 | DB probe (dev branch, read-only): `fieldpulse_connections.has_webhook_secret=false`; `.env.local` has no `FIELDPULSE_WEBHOOK_SECRET`; `webhook/route.ts:235-241`, `invoice-webhook/route.ts:137-143` |
| `process-communications` (sole comms-send chokepoint) has no Vercel-native daily backstop — its only schedule is the GitHub Actions 5-min ping; a GH Actions outage/quota/secret-drift silently stalls ALL automated customer messaging with no self-healing fallback | P1 | `vercel.json` (11 crons, none named `process-communications`); `.github/workflows/sub-daily-crons.yml:14-18`; contrast with `delay-sweep`, which has both |
| `reconcile-payments` (money-integrity healer for stranded post-charge payments) runs only once daily on Hobby — a stranded payment can show the wrong status for up to ~24h | P1 | `reconcile-payments/route.ts:1-15` (module doc names the exact failure mode); FACTS.md/task brief names payment reconciliation as the canonical "needs sub-daily" example |
| FieldPulse's public API has no discoverable webhook/subscription endpoint (8-path GET probe, all AWS-Gateway "route doesn't exist" 403s) | P2 (informational — vendor limit, not a code defect) | Probe output §3b; `connect/route.ts:28-30` pre-existing comment |
| `sync-fieldpulse-availability` docstring says "e.g., every hour"; actual cadence is daily | P2 | `route.ts:7` vs `vercel.json` |
| `delay-sweep`/`dispatch-digest` best-effort (non-atomic) alert dedup | P2 | `delay-sweep/route.ts:87-102`; `dispatch-digest/route.ts` |

**P0 count: 0.** No unauthenticated cron or webhook route was found; every
one of the 7 webhooks and 12 cron routes fails closed.

## 5. Requirements

- **Rsync-1**: Configure a FieldPulse webhook signing secret so the
  existing inbound routes stop failing closed by default. Generate a
  random hex secret and store it via
  `POST /api/admin/integrations/fieldpulse/connect`'s `webhookSecret`
  field (or `FIELDPULSE_WEBHOOK_SECRET` in the Vercel prod env). Then — a
  manual, vendor-side step outside this codebase, since §3b found no API
  for it — configure FieldPulse's dashboard (if it supports outbound
  webhook config at all) to POST to the deployed origin's
  `/api/admin/integrations/fieldpulse/webhook` and `/invoice-webhook` with
  that same secret. *AC*: `fieldpulse_connections.webhook_secret_encrypted`
  (or the env var) is non-null; a signed test POST (via
  `createSignatureHeader`, `webhook-signature.ts:178-181`) returns
  200/204/404 (not 401); an unsigned POST still 401s. **Depends on**: the
  app deployed first — the callback URL must point at the live origin, not
  localhost (`vercel deploy --prod --yes`, `AGENTS.md`).
- **Rsync-2**: Add `/api/cron/process-communications` to `vercel.json`'s
  `crons` array on a legal daily schedule (e.g. `0 5 * * *`), mirroring
  `delay-sweep`'s belt-and-suspenders pattern — a Vercel-native backstop
  alongside the GH Actions 5-minute ping, not a replacement. *AC*:
  `vercel.json` has the new entry; `vercel deploy --prod --yes` succeeds
  (proves Hobby accepts it); the GH Actions ping keeps running unchanged.
- **Rsync-3**: Extend `sub-daily-crons.yml`'s ping list with a third step
  for `/api/cron/reconcile-payments`, the identical established pattern
  (`CRON_SECRET` bearer, non-fatal `|| echo ... failed"`) already used for
  the other two. *AC*: the workflow's `ping` job gains a
  `reconcile-payments` step; a payment stuck `pending` past the 120s
  threshold heals within one ~5-min cycle instead of waiting up to 24h.

No requirement proposes a FieldPulse webhook subscription via their API
(Rsync-1 is manual-config-only — §3b found no such API) or a new sync
cron (§2 — would duplicate `fp-nightly-sync.yml` /
`sync-fieldpulse-invoices` / `sync-fieldpulse-availability`).

## 6. Non-goals

- Writing to FieldPulse's API to create/register a webhook subscription —
  forbidden by the read-only constraint, and §3b found no endpoint anyway.
- A Housecall Pro webhook subscription — no live HCP account exists
  (`FACTS.md`: no key, 0 rows). Nothing to subscribe.
- A new FieldPulse incremental-sync cron — duplicates `fp-nightly-sync.yml`
  and the existing `sync-fieldpulse-*` Vercel crons (§2).
- A second external scheduler — the existing GitHub Actions pattern
  already solves "Hobby can't do sub-daily"; Rsync-2/3 extend it.
- Deciding *for* the user whether to upgrade to Vercel Pro — flagged as an
  option (native sub-daily crons would let Rsync-2/3's pings retire), not
  recommended or assumed.
- Fixing the P2 items (stale docstrings, best-effort SMS dedup) — noted
  for awareness, not requirement-worthy per the P0/P1 gate.
- Deploying, or actually editing `vercel.json` / the workflow file — this
  spec is the design; execution is separate (constraints: no deploy, one
  file written).

## 7. Invariants

- Every webhook and cron auth check stays fail-closed: no change may make
  a missing secret resolve to "allow" (verified universal today, §3a/§3e).
- `vercel.json` cron schedules stay daily-or-weekly (Hobby's floor); any
  sub-daily need routes through the GitHub Actions ping pattern, never a
  bare cron expression that fails at deploy time.
- FieldPulse and HCP stay the money authority for invoices — sync/reconcile
  crons remain read-only pulls, never a local override (unchanged).
- Idempotency ledgers (`fieldpulseWebhookEvents`, `hcpWebhookEvents`,
  `saasBillingEvents`) keep their unique `(organizationId, eventId)` /
  `eventId` constraints — the dedupe primitive every handler relies on.
- Tenancy: every cron/webhook write stays scoped by the row's own
  `organizationId`, never a global unscoped update (verified above).
- `CRON_SECRET` and `FIELDPULSE_WEBHOOK_SECRET` are never logged — Rsync-1's
  new secret must follow the same rule.

## 8. Verification

- `npx tsc --noEmit` → 0. `npx eslint <changed files>` → 0 (once Rsync-2/3
  are implemented as a follow-up, not part of this spec file).
- `npx vitest run` → capture the live baseline first (321 files / 4239
  passed / 1 skipped per `FACTS.md`), must not drop. Relevant suites:
  `webhook-signature.test.ts`, `webhook-security-helpers.test.ts`,
  `cleanup.test.ts`, `webhook-cleanup.test.ts`, HCP/saas-billing
  `route.test.ts`.
- Rsync-1: after setting the secret, a signed test POST (via
  `createSignatureHeader`) must return 200/204/404, not 401; an unsigned
  POST to the same endpoint must still 401.
- Rsync-2: `vercel deploy --prod --yes` must succeed with the new entry in
  `vercel.json` — a non-daily schedule fails at deploy time, so a
  successful deploy IS the legality proof; confirm with
  `bash scripts/agent/prod-smoke.sh` after.
- Rsync-3: `workflow_dispatch` on `sub-daily-crons.yml` (already declared)
  and confirm the new `reconcile-payments` step returns 200/204.
- `node scripts/agent/verify-skills.mjs` → 0 missing (no skill cites these
  paths today, so this is a no-op check, not a new obligation).
