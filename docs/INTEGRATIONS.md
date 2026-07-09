# Integrations

Third-party integrations live under `src/lib/integrations/<provider>/` with a
consistent anatomy, admin routes under `src/app/api/admin/integrations/<provider>/`,
inbound webhooks under `src/app/api/webhooks/` (or the admin path for FieldPulse),
and a unified status surface at `/admin/integrations`.

Three integrations exist today:

| Provider | Purpose | Live status |
|---|---|---|
| **FieldPulse** (FSM) | mirror jobs/customers/invoices; availability; invoice money-mirror | **read path live-verified** (2026-06-22) against a real account |
| **Housecall Pro** (FSM) | same surface, at parity with FieldPulse | **key-blocked / mock-first — UNVERIFIED against the live API** |
| **Google Calendar** | OAuth + two-way event sync for scheduling | wired (OAuth-gated) |

> **Honesty note.** The FieldPulse READ path (connect, customers, jobs, invoices
> incl. the money-grade invoice mirror) is verified against the live API. WRITE
> paths (create/update job, customer find-or-create), availability, and the exact
> integer `status` codes are **not** live-verified. Housecall Pro was built to the
> same pattern but on *inferred* shapes — it almost certainly shares the bugs
> FieldPulse had before the 2026-06-19 remediation; re-probe with a live HCP key
> and apply the same fixes before trusting it.

## Anatomy of an integration (the shared pattern)

Each `src/lib/integrations/<provider>/` module is built from the same parts so a
new provider is a fill-in-the-blanks job:

- **`config.ts`** — base URL + credential resolution. `get<Provider>Config(org)`
  reads the org's encrypted key from the DB, decrypts it (`@/lib/crypto`), and
  falls back to an env var for single-tenant setups. Returns `null` when neither
  exists — the one signal callers branch on to **degrade safely**.
- **`types.ts`** — the narrowed shapes our code consumes (NOT the raw vendor
  payloads). All fields optional/nullable to tolerate API drift.
- **`client.ts`** — a `<Provider>Client` interface + a `Rest<Provider>Client`
  impl + a `get<Provider>Client(org, fetchImpl?, baseUrl?)` factory that returns
  `null` when unconfigured. The impl authenticates every request, retries
  transient 429/5xx with backoff, times out, and **narrows** untrusted responses
  through `to<Entity>()` functions. `fetchImpl` is injectable so unit tests never
  hit the network.
- **`connection-queries.ts`** — per-org credential storage (encrypted), the
  `connected` flag, and `get<Provider>ConnectionStatus(org)` (client-safe — never
  returns the key).
- **`rate-limiter.ts`** (FieldPulse) — per-org token bucket.
- **`webhook-signature.ts`** — HMAC-SHA256 verification + replay guard.
- **`*-sync.ts`** — per-entity sync logic (customer, job, invoice, …).

**Invariants every integration upholds:** org always comes from the verified
session or a server-side lookup (never trusted from a webhook payload); secrets
are AES-256-GCM encrypted at rest and never logged; every external touch is
degrade-safe (no client / API error → log + return, never throw into a customer
turn); no PII in logs or audit (ids/enums/cents only).

## Connection model + admin UI

Per-org credentials live in three tables (`schema.ts`):
`googleCalendarConnections`, `housecallProConnections`, `fieldpulseConnections` —
each holds the encrypted API key (+ encrypted webhook secret where applicable),
cached non-secret `accountInfo`, and a `connected` flag.

Admin routes (all gated by `getAdminSession()`):

| Route | Purpose |
|---|---|
| `POST /api/admin/integrations/<p>/connect` | validate the key (live probe) then store it encrypted |
| `GET  /api/admin/integrations/<p>/status` | `{ configured, connected, accountInfo }` — never the key |
| `POST /api/admin/integrations/<p>/disconnect` | clear creds, keep the row for audit |

The `/admin/integrations` page renders all three via
`src/lib/admin/integrations-status.ts` (`getIntegrationsStatus`), which reports
each as `connected` / `env-configured` / `not configured`.

## FieldPulse

**Base:** `https://ywe3crmpll.execute-api.us-east-2.amazonaws.com/stage` (an AWS
API Gateway in front of FieldPulse). **Auth:** `x-api-key` header.

### Verified real-API contract (2026-06-19/22)

- **Envelope:** EVERY response (list AND single) is wrapped:
  `{ "error": boolean, "response": <array|object>, "total_count"?: number }`.
  The payload is under **`.response`** — never `.customers`/`.jobs`/`.invoices`.
- **IDs are NUMBERS** (e.g. `20269705`). The client coerces them to strings
  (`idStr`).
- **Money is decimal-DOLLAR STRINGS** (`total: "200.00"`, `unit_price:
  "200.0000"`). The client parses to integer **cents** (`dollarsToCents`).
- **Invoice `status` is an INTEGER**; the mirror derives paid/open state from the
  **amounts** (`amount_paid`/`amount_unpaid`), which are authoritative, not the
  opaque status int.
- **Users `role` is an INTEGER**: observed vocabulary `1` = admin/office (incl. founder), `4` = field technician. The technician-sync imports role `4`.
- **Dates** are `"YYYY-MM-DD HH:MM:SS"`. Paid timestamp is `last_payment_date`.
- **Working endpoints:** `/customers`, `/jobs`, `/jobs/{id}`, `/invoices`,
  `/invoices/{id}`, `/users`, `/estimates`, `/payments`, `/teams`.
- **404 (route does not exist):** `/company`, `/me`, `/account`. (So
  `getAccountInfo` validates the key via `/users` and surfaces `company_id`.)
- **`/invoices?job_id=` does NOT filter server-side** — `listJobInvoices`
  fetches and filters client-side by `job_id`.

### Invoice money-mirror

`invoice-sync.ts` pulls FieldPulse invoices (read-only) into the native
`invoices` table, keyed/idempotent on `invoices.fieldpulse_invoice_id`
(per-org partial unique index). It maps dollar→cents, derives state from amounts,
sets accurate `amountPaidCents`, and mirrors **line items** (flattened from
`line_items[].line_components[]`, with `unit_cost` → margin) into
`invoice_line_items` (replace-on-resync). Entry points:

- the invoice webhook (`after()`-scheduled pull, post-idempotency),
- the main webhook (also schedules the pull),
- the daily reconcile cron `/api/cron/sync-fieldpulse-invoices` (durability
  backstop for failed webhook pulls).

**Money safety:** a synced invoice (any `fieldpulse_invoice_id`/`hcp_invoice_id`
set) is READ-ONLY in native money flows — `takePayment` / `refundPayment` /
`reconcilePayment` refuse it (`synced_read_only` → HTTP 409). FieldPulse holds
the real money; charging natively would double-bill. See [the invoice mirror
section](#the-invoice-mirror-cross-integration).

### Live smoke harness

`npm run smoke:fieldpulse` (`src/lib/integrations/fieldpulse/live-smoke.ts`)
validates the client against the REAL API — the check that was missing and let
the integration ship broken (unit mocks used inferred shapes). Key-gated +
degrade-safe: with no `FIELDPULSE_API_KEY` it prints "skipped" and exits 0; it is
NOT part of the CI suite. Optional `FIELDPULSE_SMOKE_INVOICE_ID` /
`FIELDPULSE_SMOKE_JOB_ID` exercise the invoice paths. The real-shape unit test
(`client-real-shapes.test.ts`) locks the contract in CI.

### Steady-state sync (Phase 6)

| Layer | What syncs | When | Notes |
|---|---|---|---|
| Webhooks | Job status changes, invoice events | Real-time (on FP event) | Fail-closed HMAC; idempotency ledger; scheduled via `after()` |
| Vercel daily cron | Technician roster + availability | 10:00 UTC | `/api/cron/sync-fieldpulse-availability` |
| Vercel daily cron | Invoices for tracked jobs | 11:00 UTC | `/api/cron/sync-fieldpulse-invoices` |
| **GitHub Actions nightly** | **technicians, customers, jobs, invoices (full re-page)** | **08:30 UTC** | `.github/workflows/fp-nightly-sync.yml`; runs BEFORE Vercel crons |

The GH Actions sweep runs before the Vercel crons (08:30 vs 10:00 UTC) so fresh
data is in place before the availability and invoice crons process it. All sweep
runs are recorded in `fp_import_runs` (same ledger as the initial backfill) and
visible at `/admin/fieldpulse-import`.

**Delta semantics:** FP ignores server-side `updated_at` filters (verified
2026-07-09), so each nightly sweep is a full re-page + idempotent upsert. At
current volume (2,597 customers, 54 jobs) a complete sweep takes ≈20 minutes —
well within GitHub Actions limits but impossible in a Vercel function.

**Convergence guarantee:** both the live webhook and the nightly sweep write
current FP state. A webhook write is never stomped permanently by a lagging list
— the next sweep self-corrects from a fresh FP read. Sweeps must never write
from a cached list (see comment in each sweep module).

## Housecall Pro

Same module anatomy and the same invoice money-mirror, built to **parity** with
FieldPulse (`hcp_invoice_id`, webhook at `POST /api/webhooks/housecall`, reconcile
cron `/api/cron/sync-housecall-invoices`). The webhook event parser extracts both
the job id and the invoice id; the pull schedules post-idempotency via `after()`.

⚠️ **Key-blocked / mock-first / UNVERIFIED.** HCP was built against *inferred*
shapes (string ids, an `.invoices`/`.jobs` envelope key, money as cents). The
live FieldPulse probe proved those exact assumptions wrong for FieldPulse; HCP
likely has analogous bugs. Before enabling HCP for a real org: obtain a live key,
re-run the FieldPulse-style discovery, and apply the same `idStr` / `unwrap` /
`dollarsToCents` / endpoint fixes. Everything is degrade-safe, so an unconfigured
HCP integration is inert.

## Google Calendar

OAuth-based two-way event sync. `oauth.ts` + `oauth-state.ts` implement the
authorization-code flow (`/api/admin/integrations/google/connect` →
`/api/admin/integrations/google/callback`); `sync.ts` + `event-mapping.ts`
mirror scheduled jobs to calendar events. Credentials use the standard Google
OAuth env vars (`GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, `GOOGLE_REDIRECT_URI`).

## The invoice mirror (cross-integration)

Both FSMs feed ONE native `invoices` table. Provenance is the external-id column:
`fieldpulse_invoice_id` or `hcp_invoice_id` (NULL = native invoice from a sold
estimate). The admin UI derives `syncedSource: "fieldpulse" | "housecall" | null`
(FieldPulse wins the rare dual-source row), shows a source chip, and hides
pay/refund controls + shows an authoritative-balance caveat for synced invoices.

- **Money guards** (`invoice-queries.ts`): the three native money mutations
  refuse any synced invoice.
- **Source-aware reporting:** a request can legitimately have BOTH a native and a
  synced invoice; revenue/aging reads must group by source to avoid double-count.

## Webhooks

Inbound FSM webhooks share a hardening sequence (do not reorder):
**parse → replay-guard → derive org from a server-side lookup (job/invoice id)
→ rate-limit → HMAC signature verify (fail-closed in production) → idempotency
ledger insert (`*_webhook_events`, dedupe on `(org, event_id)`) → apply →
schedule background work**. The money-grade invoice pull is scheduled via
`after()` (Vercel freezes the lambda on response — never a detached promise) and
ONLY after a fresh (non-replay) ledger insert, so a forged or replayed event
never triggers a pull.

## Scheduled jobs (`vercel.json` crons)

| Path | Schedule | Purpose |
|---|---|---|
| `/api/cron/sync-fieldpulse-availability` | `0 10 * * *` | availability sync (connected orgs) |
| `/api/cron/sync-fieldpulse-invoices` | `0 11 * * *` | FieldPulse invoice reconcile (durability backstop) |
| `/api/cron/sync-housecall-invoices` | `0 12 * * *` | HCP invoice reconcile |

All cron routes fail closed via `verifyCronAuth` (Bearer `CRON_SECRET`) and run
per-org work inside `after()`.

## Environment variables

| Var | Used by | Notes |
|---|---|---|
| `FIELDPULSE_API_KEY` | FieldPulse | single-tenant fallback when no per-org key |
| `FIELDPULSE_WEBHOOK_SECRET` | FieldPulse webhooks | env fallback for HMAC; fail-closed in prod |
| `HOUSECALL_API_KEY` | Housecall Pro | single-tenant fallback |
| `HOUSECALL_WEBHOOK_SECRET` | HCP webhooks | env fallback for HMAC |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` / `GOOGLE_REDIRECT_URI` | Google Calendar | OAuth app creds |
| `CRON_SECRET` | all cron routes | Bearer token; routes fail closed without it |
| `FIELDPULSE_SMOKE_INVOICE_ID` / `FIELDPULSE_SMOKE_JOB_ID` | smoke harness only | optional, manual |

Per-org keys (set via the admin Connect flow, encrypted at rest) take precedence
over the env fallbacks.

## Adding a new integration

1. Create `src/lib/integrations/<provider>/` with `config.ts`, `types.ts`,
   `client.ts` (interface + Rest impl + factory + `to<Entity>` narrowers),
   `connection-queries.ts`.
2. Add a `<provider>_connections` table + migration.
3. Add `connect` / `status` / `disconnect` admin routes (session-gated) and wire
   the provider into `integrations-status.ts` + the `/admin/integrations` page.
4. For inbound events: a webhook route following the hardening sequence above +
   a `*_webhook_events` idempotency ledger.
5. **Probe the live API before writing narrowers** — confirm the response
   envelope, id types, and money units. Add a key-gated live smoke harness and a
   real-shape unit test so mocks can't hide a wrong contract.

## Testing

- **Unit:** every client/sync module mocks the network (`fetchImpl`) and the DB;
  narrowers and sync logic are covered offline. **Use REAL response shapes in the
  fixtures** — inferred-shape mocks are exactly what hid the FieldPulse bugs.
- **Live smoke:** `npm run smoke:fieldpulse` (key-gated, manual) is the only
  thing that validates against the real API. Add the equivalent per provider.

> **Data map:** see [FIELDPULSE-DATA.md](FIELDPULSE-DATA.md) for every imported entity, where it displays, read-only rules, and the sync schedule.
