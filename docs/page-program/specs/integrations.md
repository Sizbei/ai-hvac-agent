# integrations — target-state spec

`/admin/integrations` — the read-only connection-status board for every
external service an org may use (FieldPulse, Housecall Pro, Google Calendar,
Stripe, Wisetack, Resend, Twilio, AI model).

## 1. Purpose

Give an operator one place to see, at a glance, whether each external
service the business depends on is actually working — and, if not, a link
to go fix it. One job: render an honest status badge per integration and a
Manage link where a fix flow exists. It does not configure anything itself
(Settings › Integrations panels own credential entry).

## 2. Brainstorm

Considered, and what shipped or got cut:

- **Server-derived status, computed at request time, no status table** —
  shipped (`src/lib/admin/integrations-status.ts:1-14`). Rejected: a
  persisted `integration_status` table updated by a background job. The
  underlying signals (connection rows, env vars, provider seam `.name`) are
  already source-of-truth and cheap to read per-request; a mirrored table
  is just another place to go stale. verified.
- **Secrecy contract baked into the aggregator's return type** — shipped.
  Module doc: payload carries "ONLY booleans, enums, labels, and short
  non-secret detail strings" (`integrations-status.ts:9-13`); every
  `connection-queries.ts` enforces this at the query layer — the highest-
  value place to get credential hygiene right by construction. verified.
- **Unmapped services never break the UI** — shipped
  (`integration-meta.ts:44-51`, default `{ icon: Plug, intent: 'neutral' }`).
  Rejected: a hard-coded switch that throws on an unknown key — a new key
  should degrade to a generic chip, not 500 the page. verified.
- **"Manage" always deep-links to Settings, never a per-page action
  button** — shipped (`SETTINGS_INTEGRATIONS_HREF`,
  `integrations-status.ts:76`). Rejected: connect/disconnect controls on
  this page — credential entry belongs in one place with its own audit/
  rate-limit/validation wiring; duplicating it here doubles the safety
  surface. YAGNI. verified.
- **Polling / auto-refresh** — rejected. Operator-initiated glance page, not
  a live dashboard; `useIntegrations` fetches once, explicitly "no polling,
  no SWR cache" (`use-integrations.ts:37`). A stale badge for a few minutes
  is smaller than the badge being *wrong* while looked at (Gaps below) —
  polling a wrong signal faster doesn't fix honesty.
- **A "Test connection" button per card** — rejected. Would need a new
  authenticated write path per provider on a deliberately read-only page,
  and the connect flow already live-probes on save
  (`fieldpulse/connect/route.ts:68-87`, `housecall/connect/route.ts:65-82`).
  The real gap isn't "no way to re-test" — it's "the badge doesn't reflect
  the test/sync results the system already runs" (Gint-1, Gint-2).
- **Per-integration sync-history timeline on this page** — rejected.
  `/admin/fieldpulse-import` already owns full sync-run history
  (`fp_import_runs`, `docs/INTEGRATIONS.md:139-141`); duplicating it here
  fragments "where do I look." This page's job is the one-line summary.
- **Google Calendar / Twilio / Resend "last successful call" tracking** —
  rejected for this run. No column exists for these three, and none has a
  recurring background sync the way FieldPulse availability does —
  Twilio/Resend fail visibly at the synchronous call site. Adding tracking
  with no evidence of a live problem is scope creep; FieldPulse
  availability sync (Gint-2) is the one place a write already exists and is
  already ignored.

## 3. Current state

**Page / hook / meta** (verified):
- `src/app/admin/(dashboard)/integrations/page.tsx:55-102` — fetches once
  via `useIntegrations()`, groups items into `CATEGORY_SECTIONS` (FSM →
  payments → financing → comms → ai, `:24-33`), skips empty sections, shows
  a skeleton while loading, `EmptyState` on a failed/empty response. Badge
  classes come only from `STATUS_BADGE` (`:36-53`) — no raw palette classes.
- `src/hooks/use-integrations.ts:39-77` — single fetch on mount, no
  polling, guards overlapping fetches with `isFetchingRef`.
- `src/lib/admin/integration-meta.ts:25-51` — icon/intent registry, prefix
  fallback then generic default so an unmapped key never breaks rendering.

**Server aggregator** (verified, `src/lib/admin/integrations-status.ts`):
- `GET /api/admin/integrations` is admin-session-gated (`:19-22`) and
  read-rate-limited (`:24-30`); calls
  `getIntegrationsStatus(session.organizationId)`.
- FieldPulse/HCP: `status: "connected"` iff the per-org row has
  `connected=true` (`:96-113`, `:117-135`); else `"live"` if the env
  fallback key is present, else `"not_configured"`. Google Calendar:
  `"connected"` iff `google.connected`, else `"not_configured"` (`:138-150`).
- Payments/Financing: status is the seam's `.name` — `"mock"` unless a real
  adapter is wired, with a nuance detail when a live key exists but the
  adapter is still mock (`:152-185`).
- Comms (email/Twilio): pure `envPresent()` checks (`:188-211`) — no
  connection row, no live probe.
- AI: always `"live"` (`:216-226`) — a default model is always in effect,
  so `not_configured` isn't reachable; label names the org's selection.
- **Secrecy**: every `getXConnectionStatus` selects `connected` +
  `accountInfo`/`calendarId` only, never the encrypted key/token column
  into the returned shape
  (`fieldpulse/connection-queries.ts:44-60`,
  `housecall-pro/connection-queries.ts:45-61`,
  `google-calendar/connection-queries.ts:31-48`).
  `apiKeyEncrypted`/`refreshTokenEncrypted` are selected only to test
  truthiness, then dropped. The standalone `/status` routes
  (`fieldpulse/status/route.ts:32-40`, `housecall/status/route.ts:32-40`)
  return the same key-free shape plus `configured`. verified — no route
  under `src/app/api/admin/integrations/**` returns a key/token/secret.
- **Encryption at rest**: `encrypt()`/`decrypt()` (`src/lib/crypto.ts:30-74`)
  AES-256-GCM, 32-byte key from `ENCRYPTION_KEY`; connect routes encrypt
  before the upsert (`connection-queries.ts:78,83`). Decryption happens
  only inside server-only config resolution for an outbound call
  (`getOrgHousecallApiKey`, `:141-156`) or OAuth token assembly
  (`getOrgGoogleTokens`, `google-calendar/connection-queries.ts:116-144`).
- **Connect-time live probe**: FieldPulse/HCP connect routes build a client
  from the *submitted* key and call `getAccountInfo()` before any DB
  write; a failed probe returns 400, nothing persisted
  (`fieldpulse/connect/route.ts:68-93`, `housecall/connect/route.ts:65-88`).
  Errors are never logged with the raw body ("could echo the key," both
  files).
- **Webhook auth** (verified): FieldPulse job-status webhook — HMAC-SHA256
  (per-org decrypted or env secret), timing-safe compare
  (`fieldpulse/webhook-signature.ts:79-168`), fails closed in production
  with no secret (`fieldpulse/webhook/route.ts:231-241`), replay-guarded by
  timestamp (`:162-165`), idempotent via `fieldpulseWebhookEvents` unique
  `(org,event_id)` insert-or-skip (`:261-279`). FieldPulse invoice
  webhook — same pattern, separate route
  (`fieldpulse/invoice-webhook/route.ts:94-98,127-131`). Housecall Pro
  webhook — HMAC-SHA256 verified against the raw body before parsing,
  fails closed with no secret (`webhooks/housecall/route.ts:60-76`),
  idempotent via a claim-then-compensating-delete ledger
  (`webhook-sync.ts` doc, `:7-16,64-94`). Twilio delivery-status webhook —
  signature verified before processing, fails closed 403
  (`webhooks/twilio/route.ts:25-31`); status set keyed by `MessageSid`,
  naturally idempotent on redelivery (`:60-68`).
- **Tenancy**: every connection read/write uses `withTenant(table,
  organizationId, ...)` (`fieldpulse/connection-queries.ts:54,127`;
  `housecall-pro/connection-queries.ts:55,131,150`;
  `google-calendar/connection-queries.ts:42,107,130`); webhooks derive
  `organizationId` from a server-side job/invoice lookup, never the
  payload (explicit comments in both FieldPulse routes and the HCP webhook
  module doc).

**Unread-but-written sync-health data** (verified,
`src/lib/db/schema.ts:1391-1404`): `fieldpulseConnections` has
`availabilitySyncStatus` (`pending|in_progress|completed|failed`),
`lastAvailabilitySyncAt`, and `lastSyncError`, each commented "Used for
admin UI display" / "troubleshooting in the admin UI." Written by
`availability-sync.ts` (claim → `markCompleted`/failure-with-message) on
every run of the daily `sync-fieldpulse-availability` cron. A repo-wide
grep for these field names outside `schema.ts` and their writer file finds
only the cron route that triggers the sync — **no UI route, component, or
the `/admin/integrations` aggregator ever selects or renders them.**

## 4. Gaps

| Gap | Severity | Evidence |
|---|---|---|
| Gint-1: A "Connected" badge never reflects a later failure — only explicit connect/disconnect flips the stored flag | P1 | `connected` is set `true` only inside `saveFieldpulseConnection`/`saveHousecallConnection`/`saveGoogleConnection` (each after a one-time live probe) and `false` only inside the matching `delete*Connection`/`disconnect*Connection`. Repo-wide grep for `connected: false`/`connected = false` across `src/lib/integrations` and `src/app/api/admin/integrations` returns exactly those three save/disconnect pairs — nothing in invoice-sync, webhook, or availability-sync failure paths writes `connected=false`. A FieldPulse or HCP key revoked/expired after connect still renders the green "Connected" badge indefinitely — a green badge for a dead credential. |
| Gint-2: FieldPulse availability-sync failures are captured in the DB but never surfaced to any operator UI | P1 | `fieldpulseConnections.lastSyncError`/`.availabilitySyncStatus`/`.lastAvailabilitySyncAt` (`schema.ts:1392-1404`) are written by `availability-sync.ts` on every cron run. `getIntegrationsStatus` (`integrations-status.ts:96-113`) derives the FieldPulse card from only `fieldpulse.connected` and the env var — it doesn't select these columns, and neither does `getFieldpulseConnectionStatus` (`connection-queries.ts:47-54`, selects only `connected`/`apiKeyEncrypted`/`accountInfo`) or the Settings panel (`fieldpulse-panel.tsx:26-30`, no error/sync field in `FieldpulseStatus`). A daily sync silently failing for weeks renders identically to a healthy one everywhere an operator can look. |
| Gint-3: Housecall Pro has no sync-health columns at all | P2 | `housecallProConnections` (`schema.ts:1329-1361`) has only `apiKeyEncrypted`, `webhookSecretEncrypted`, `accountInfo`, `connected` — no error/status/last-run column. Recorded but not promoted: HCP is key-blocked/unverified (`docs/INTEGRATIONS.md:160-166`) and has no recurring background sync analogous to FieldPulse's availability cron. Adding tracking infra for a provider nobody can currently connect is premature. |
| Gint-4: AI card is hardcoded `status: "live"` regardless of reachability | P2 | `integrations-status.ts:216-220` sets `"live"` unconditionally — no call to the model provider. Low severity: unlike FieldPulse/HCP there's no connect/disconnect lifecycle to lie about, and a broken model key surfaces immediately and loudly in chat/voice (a customer-facing 500), not silently. |

Credential secrecy, webhook signature/replay/idempotency, and tenancy
scoping are all solid and evidenced above; this spec does not invent
additional work to pad out those lenses.

## 5. Requirements

Only Gint-1 and Gint-2 clear the P0/P1 bar (Gint-1's fix folds into
Rintegrations-1, driven by the data Rintegrations-2 exposes).

- **Rintegrations-1**: The FieldPulse card must not render "Connected" from
  a stale flag alone when a more recent signal shows the sync is broken.
  **Acceptance criterion**: `getIntegrationsStatus` folds
  `availabilitySyncStatus === "failed"` (Gint-2's data, via
  Rintegrations-2) into a distinct, visibly-non-green status/detail on the
  FieldPulse card — "Connected" while `failed` is set is unacceptable
  ambiguity; this spec does not mandate the exact enum value. Covered by a
  unit test on the pure status-derivation function: connected=true +
  `availabilitySyncStatus="failed"` → non-`"connected"` status;
  connected=true + `"completed"`/`"pending"`/no row → unchanged
  `"connected"`. Housecall Pro has no equivalent signal (Gint-3, P2, out of
  scope) — its card is unchanged by this requirement.
- **Rintegrations-2**: `getFieldpulseConnectionStatus` (or a sibling query
  feeding `getIntegrationsStatus`) selects and returns
  `availabilitySyncStatus`, `lastAvailabilitySyncAt`, and `lastSyncError`
  alongside `connected`/`accountInfo`, still never exposing a secret.
  **Acceptance criterion**: the returned shape carries the three columns; a
  unit test asserts no key-shaped field name (`apiKey`, `Encrypted`,
  `token`, `secret`) — mirroring the existing secrecy contract — and that a
  row with `lastSyncError` set surfaces that string in the card's `detail`
  (e.g. "Connected — last availability sync failed: <message>") instead of
  the current generic "Connected — <company>" text.

## 6. Non-goals

- Not adding a "Test connection" button or a sync-history timeline on this
  page (Brainstorm, rejected — fix what the existing probe/sync data
  already shows first; `/admin/fieldpulse-import` owns import-run history).
- Not adding sync-health columns for Housecall Pro, Google Calendar,
  Twilio, or Resend (Gint-3, P2, and Brainstorm — no evidence of a live
  problem, and HCP is key-blocked so nothing to validate against).
- Not changing the AI card's hardcoded `"live"` status (Gint-4, P2 — no
  connect/disconnect lifecycle makes this dishonest like Gint-1).
- Not touching connect/disconnect/status routes' shapes beyond the three
  read-only fields on the FieldPulse status path (Rintegrations-2) — no
  change to Settings panels' connect/disconnect flows.
- Not attempting Housecall Pro live-API work (key-blocked, no MAX-plan key,
  `docs/INTEGRATIONS.md:160-166`) or FieldPulse full-import changes
  (separately API-key-blocked per repo memory) — out of scope here.

## 7. Invariants

- **Never return a secret.** No route under `src/app/api/admin/integrations/**`
  may add a key/token/secret field to any response, including
  Rintegrations-2's new fields — `lastSyncError` is a system-generated
  message, not credential data, but must keep passing the "no key-shaped
  field" check in its own acceptance criterion.
- **Encryption at rest stays AES-256-GCM via `@/lib/crypto`** — no second
  encryption path, no plaintext credential storage, even temporarily.
- **Webhook hardening sequence stays intact**: parse → replay-guard →
  derive org from a server-side lookup → rate-limit → HMAC verify (fail
  closed in production) → idempotency ledger insert → apply → schedule via
  `after()` (`docs/INTEGRATIONS.md:191-198`). This spec's requirements
  touch only status-read paths, no webhook route.
- **Tenancy**: any new query for Rintegrations-2 uses
  `withTenant(fieldpulseConnections, organizationId)` like every existing
  query in that file — never a global/unscoped read.
- **`connected` semantics for HCP/Google unchanged.** Rintegrations-1 scopes
  the non-green treatment to FieldPulse only (the only provider with a
  written failure signal); do not invent a synthetic failure signal for
  HCP/Google — violates evidence-over-eloquence.
- **Degrade-safe reads.** If the new columns are null (never synced) or the
  row doesn't exist, `getIntegrationsStatus` falls back to today's
  behavior exactly — only a new branch for the `failed` case.
- Repo-wide: `src/lib/ai` prompts and `output-guardrail.ts` regexes are
  FROZEN, untouched here. `db.transaction()` must not be used (neon-http).
  Admin queries stay session-`organizationId`-scoped.

## 8. Verification

- `npx tsc --noEmit` → 0.
- `npx eslint src/lib/admin/integrations-status.ts src/lib/integrations/fieldpulse/connection-queries.ts src/app/admin/(dashboard)/integrations/page.tsx` → 0 errors.
- `npx vitest run` → must not drop below the live baseline (297 files ·
  4022 passed · 1 skipped, per `docs/page-program/README.md`).
- Targeted regression pack (must stay green — proves no webhook/secrecy
  invariant broke): `npx vitest run src/lib/integrations/fieldpulse/webhook-signature.test.ts src/lib/integrations/housecall-pro/webhook-signature.test.ts src/lib/admin/integrations-status.test.ts`
- New pure-function unit tests (no jsdom/RTL) covering Rintegrations-1's
  status-derivation branch and Rintegrations-2's shape (no key-shaped
  field; `lastSyncError` surfaced in `detail` when present).
- Manual/visual: `npm run dev` (background) → mint an admin session → set a
  test org's `fieldpulseConnections.availabilitySyncStatus` to `'failed'`
  and `lastSyncError` to a sample message directly in the dev DB →
  `node scripts/agent/screenshot-page.mjs /admin/integrations` → confirm
  the FieldPulse card shows a non-green badge and the error text, then
  revert and confirm it returns to the normal green "Connected" card.
