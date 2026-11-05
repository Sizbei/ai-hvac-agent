---
name: admin-pages
description: Use when working on ANY admin page — shared recipes (session mint, screenshots, gates, deploy), design-system rules, terminology canon, and repo-wide invariants the per-page skills reference.
---

# Admin pages — shared conventions and recipes

## Verify locally (visual)

1. Dev server: `npm run dev` — run it detached/background; never leave it
   running after you finish. `.env.local` is the DEV Neon branch — NEVER
   point it at prod (ep-withered-hill).
2. Session: `npx tsx scripts/agent/mint-admin-session.mjs` prints a JWT.
   The payload **must include `name`** — `verifyToken` rejects tokens
   without it (scripts handle this; hand-rolled mints often forget). For
   `/tech/*` pages, `npx tsx scripts/agent/mint-tech-session.mjs` mints the
   `hvac_tech_session` cookie instead (needs an active technician row in the
   dev DB; payload requires `name`/`email`/`userId`/`organizationId`/
   `role: "technician"` plus the `aud: "hvac-tech"` claim).
3. Screenshot: `node scripts/agent/screenshot-page.mjs /admin/<page> [width]`
   (1440 desktop, 390 mobile). LOOK at the image yourself before claiming
   visual success. For a technician page, add `--tech`:
   `node scripts/agent/screenshot-page.mjs /tech/jobs 390 --tech` — it mints
   via `mint-tech-session.mjs` and sets the `hvac_tech_session` cookie
   instead of the admin one.
4. Dev-DB note: active dev requests carry seeded cached locations near the
   Johnson City base (label "dev seed", 2026-08-01) so map-adjacent pages
   show realistic pins. NEW unseeded test requests without a cached location
   are live-geocoded and fake addresses land in Manhattan — seed a
   customer_locations row (reuse the request's own address ciphertext) if
   that happens. Prod visuals: demo login (admin@demo-hvac.com / admin123).

## Gates (run before any commit)

- `npx tsc --noEmit` → 0 errors
- `npx eslint <changed files>` → 0 errors
- `npx vitest run` → capture the LIVE baseline first; it must not drop.
  No jsdom/RTL in this repo — pure-helper vitest only; component logic is
  tested by extracting pure functions.

## Deploy

`git push` does NOT reliably trigger builds — always
`vercel deploy --prod --yes`, then `bash scripts/agent/prod-smoke.sh`.
Migrations run in the Vercel build.

## Design system (compose, don't hand-roll)

SectionCard: put sentence-length explanations in `description` (a line under
the header band), not in `action` or `meta`; the header wraps on phones and
the title never yields to `meta`.
Primitives in `src/components/admin/ui/` (PageShell, PageHeader, StatCard,
SectionCard, DataTableShell, Pager, TabGroup, SegmentedControl, InfoBanner,
ErrorState, SkeletonTable…). Status colors ONLY via
`src/lib/admin/status-colors.ts`. Bricolage Grotesque display font via
tokens; one cyan accent; oklch tokens in globals.

Shared UI and shell behaviour:

- `Select` (`src/components/ui/select.tsx`) passes Base UI an `items` list
  collected from its `SelectItem` children (`collectSelectItems` in
  `select-items.ts`), so the trigger shows the option LABEL, not the raw value.
  Items rendered inside a custom wrapper component aren't seen; pass `items`
  yourself there.
- `SheetContent` side widths are plain classes (`w-3/4 sm:max-w-sm` for
  left/right), so a caller's `w-full sm:w-[480px] sm:max-w-[480px]` wins.
- Tab titles: client pages call `useAdminPageTitle('<Page>')`
  (`src/components/admin/org-name-context.tsx`) → "<Page> · <org name>";
  server pages set `metadata.title = '<Page>'` and the dashboard layout's
  template adds the org. Never hardcode a brand.
- Phone shell: the top bar shows the org name (`AdminHeader orgName`); the
  drawer is a left `Sheet` (Esc, focus trap); its Search button closes the
  drawer first. Active nav + top-bar title use `navItemMatches` / `navLabelFor`
  in `nav-items.ts`.
- ⌘K search (`search-queries.ts`): request results link to
  `/admin/requests?request=<id>` (there is no `/admin/requests/[id]` page);
  conversations are searched by captured metadata + request number.

**Pickers:** base-ui `<SelectValue />` renders the RAW value (a UUID,
`__manual__`, `name`). Always pass a formatter:
`<SelectValue>{(v: unknown) => selectLabel(options, v, 'Placeholder')}</SelectValue>`
(`src/lib/admin/select-label.ts`) — it never returns the raw value.

**PageHeader actions** wrap on phones (`flex-wrap max-w-full`, single
non-shrinking row from `sm` up) so a primary action is never pushed off a
390 px screen. Don't re-add `shrink-0`/nowrap below `sm`.

## Copy canon (enforced by review waves)

request (not job/booking — "Bookings" allowed only as the customer-profile
section title) · technician (not tech) · sign in (not login) · cancelled ·
Unicode … · sentence case (capitals only for brands/acronyms/24-7) · human
error copy ("Couldn't save X. Please try again."), never err.message or
"Unknown error" in UI.

## Repo-wide invariants

- Tenancy: every admin query scopes by the session's organizationId.
- Logs carry codes and ids, never PII. `logger.error({ error })` is fine: the
  `error` serializer in `src/lib/logger.ts` drops Drizzle's `query`/`params`
  (a failed statement's params can hold names, check numbers and portal
  links). Prefer `logger.error({ code: errorCode(error), invoiceId }, "…")`
  with `errorCode` from the same module.
- Demo account (admin@demo-hvac.com): blocked from GDPR erase
  (super_admin gate) and outbound SMS (`isDemoAccount` in
  `src/lib/auth/authz.ts`) — deliberate, do not "fix".
- Request status lists (open / in-flight / on-site / terminal …) are
  constants in `src/lib/admin/request-status.ts`; import them, don't inline
  arrays. `en_route`/`arrived` colors live in `status-colors.ts`.
- Dev org is FieldPulse-connected: `POST /api/admin/requests` (and other
  native-create paths) push REAL jobs to FieldPulse. Create throwaway
  requests for testing with SQL only (`seed-org.mjs` or direct inserts), never
  through the API.
- Time off (`technician_shifts`, kind `time_off`) is never overridable: the
  schedule-conflict `override` flag does not bypass it (409 `TIME_OFF`).
- Money: synced invoices (fieldpulse_invoice_id / HCP source set) are
  read-only in money flows; money mutations are atomic/CAS-guarded.
- neon-http: `db.transaction()` throws — use `db.batch()` (also 1 HTTP
  round-trip vs Promise.all's N).
- Serverless background work: `after()` from next/server, never detached
  promises.
- FROZEN safety text in `src/lib/ai` prompts and the guardrail regexes in
  `src/lib/ai/output-guardrail.ts` must not be touched (chat streaming's
  safety proof depends on the regex shape — see page-chat skill).

## Money writes (M3b recipes)

- **Idempotency (tech money POSTs):** `withIdempotency(scope, hash, run)` in
  `src/lib/http/idempotency.ts`. Scope = `(organization_id, user_id, route =
  the literal request path, key)` from the `Idempotency-Key` header (1–64
  `[A-Za-z0-9_-]`). The hash is `canonicalHash(body)` (an empty body is `{}`;
  multipart uses `multipartHash`). Entity ids come from `ids.id(n)` =
  `derivedId` (uuidv5 of `org|user|route|key|n`), so a re-run writes the same
  rows (`ON CONFLICT (id) DO NOTHING`). The winner stores the FULL response
  envelope when it is 2xx or a 4xx whose code is in `STORED_CODES`
  (`idempotency-codes.ts`, shared with the client); otherwise it releases the
  key. Same key + same hash → replay of the stored status (a replayed 201 is a
  201). A different hash → 422 `IDEMPOTENCY_KEY_REUSED`. An `in_progress` key
  younger than 2 minutes → 409 `IN_PROGRESS` with Retry-After; an older one is
  taken over. Deviation from spec §4: `STORED_CODES` includes `SEND_FAILED`
  (a pay-link SMS may already have gone out).
- **Office client token:** office money forms (Record payment, Refund) mint a
  `clientToken` when the form opens and send it. The server derives
  `officeId("payment"|"refund", org, token)`, which is org-scoped and never
  invoice-scoped. Writers read the by-id row FIRST: a full match →
  `created: false`; any difference → 409 `ID_CONFLICT`.
- **Mock gate:** while `cardPaymentsEnabled()` is false (provider = mock),
  card paths refuse with 409 `CARD_PAYMENTS_UNAVAILABLE`: the portal pay route
  (before token resolution), the admin payments route `method: 'card'`, and
  membership `chargeFirstPeriod`. Never offer a Card option in UI on the mock.
- **Queue-drain probe guard:** `processPendingJobs()` drains EVERY org's due
  jobs through real Twilio. Before any probe or screenshot run that could
  queue a message (a payment on an invoice with a customer, a pay link), run
  `SELECT count(*) FROM communication_jobs WHERE status='pending' AND
  scheduled_for <= now() + interval '15 minutes'` and ABORT unless it is 0.
  Never drain on dev while real customers' jobs are pending. Cancel any job
  the probe queued (`status='cancelled'`). Screenshot fixtures pay invoices
  with a null `customer_id`.
- **Tech sessions for probes:** `MINT_ORG_ID=<org> npx tsx
  scripts/agent/mint-tech-session.mjs` pins the technician to that org
  (without it you get whichever technician comes first, usually the
  FieldPulse-connected default org). Assert the token's `organizationId`
  before any fetch.

## Setup guide recipes

- Deep link that opens a dialog: `useOpenFromParam(key, allowedValues, open)` from
  `src/hooks/use-open-from-param.ts`. Declare it BEFORE `useUrlFilterSync` so it
  reads the URL before that hook rewrites it. It returns `{ fromSetup }` for the
  `BackToGuideBanner`. Only whitelisted values open anything.
- Throwaway orgs for probes/screenshots are SQL-only: `createOrgCore` via a
  temporary `probe.mts` under `NODE_OPTIONS=--conditions=react-server`, rows by
  SQL, one `DELETE FROM organizations`. Full recipe in page-setup.
