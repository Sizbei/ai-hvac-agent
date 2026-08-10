# PLAN.md round-1 review — feasibility lens

Scope: Waves 0, A, B, C (the committed scope). Question asked per item: will an
engineer following this line, as written, actually succeed? Not a priority
review — severity below is about mechanical correctness, not importance.

Repo state note: at review time several Wave A files were mid-edit in the
working tree (uncommitted) — `customers/[id]/route.ts`, `erase/route.ts`,
`auth/login`, `auth/tech/login`, `auth/invite/accept`, `platform/organizations/[id]`,
`conversations/[id]/route.ts`, `dispatch-column.tsx` — evidently a concurrent
implementation pass. Where I could confirm a fix already landed (e.g. A4, C7)
that is treated as positive feasibility evidence, not ignored.

---

## F-1 — A1 — blocker — verified

Quote: `Scope analytics away from the three token routes (or mask the path before it is sent) | \`src/app/layout.tsx\` (+ portal/estimates/review route group)`

**Verified against the installed Next.js (16.2.6, confirmed via
`node_modules/next/package.json`) and its own docs
(`node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/route-groups.md`).**

`src/app/layout.tsx` renders `<html><body>{children}<Analytics/></body></html>`
— it is *the* root layout for the whole app (there is no other top-level
`layout.tsx`). A nested `layout.tsx` under `app/portal/`, `app/estimates/`, or
`app/review/` — with or without a `(group)` folder — does not replace or
override JSX rendered by an ancestor layout; it renders *inside* the parent's
`{children}` slot. `<Analytics/>` sits in `<body>` above `{children}` in the
root layout, so it fires for every route regardless of what a child layout
does. A child layout has no mechanism to remove it.

The docs confirm the only real way to get route-specific root-layout content:
"Defining multiple root layouts" — but that requires deleting the top-level
`app/layout.tsx` entirely and moving *every* top-level route (not just the
three token routes) into its own route group, each with its own `<html><body>`.
Partial adoption (top-level `layout.tsx` kept for everything else, a
separate self-contained root layout carved out for just `/portal`,
`/estimates`, `/review`) is not supported — a request under `/portal` would
still resolve `app/layout.tsx` as its nearest root layout as long as that
file exists, because route groups are purely a URL/organizational
convention layered on top of the existing tree, not a routing override.

`src/app/portal/`, `src/app/estimates/`, `src/app/review/` currently have **no
layout.tsx of their own at all** (confirmed via `find`), so today they are
plain children of the single root layout — there is no existing group
boundary to extend.

So the "Scope analytics away… route group" half of this line, and the Files
column that names it (`src/app/layout.tsx (+ portal/estimates/review route
group)`), describes something that cannot work at the stated scope. Making it
work the way the docs describe would mean converting the *entire* `src/app`
tree into multiple explicit root-layout groups — a much larger, higher-risk
restructuring (every top-level segment moves, `<html>`/`<body>`/fonts get
duplicated per group, "full page reload" applies when navigating between
groups) than "layout.tsx + one route group" suggests.

**What will actually work** (and is already named, correctly, as the
parenthetical fallback in the same line): `beforeSend` on `<Analytics/>`.
Confirmed present in the installed package
(`node_modules/@vercel/analytics/dist/index.d.ts`):
`type BeforeSend = (event: BeforeSendEvent) => BeforeSendEvent | null` where
`event.url` is available to inspect/rewrite/cancel per request — no route
restructuring, one prop on the existing single `<Analytics/>` call in
`src/app/layout.tsx`, matches every URL shape (token routes, `/embed`, admin)
from one place.

**Recommendation:** drop the "scope away via route group" language and the
"+ portal/estimates/review route group" file entry entirely. Rewrite A1 as:
add a `beforeSend` handler to the existing `<Analytics/>` in
`src/app/layout.tsx` that strips or redacts the bearer segment from
`event.url` for `/portal/[token]`, `/estimates/[token]`, `/review/[token]`
(or returns `null` to drop the event outright on those paths). One file,
already correctly identified.

---

## F-2 — A10 — major — verified

Quote: `Google Calendar / Housecall Pro / FieldPulse credential connect+disconnect require only \`getAdminSession()\`, not \`isSuperAdmin\` … | \`src/app/api/admin/settings/**/connect\` routes`

`src/app/api/admin/settings/**/connect` matches zero files. `find
src/app/api/admin/settings -type f` returns only `faqs/[id]/route.ts`,
`faqs/route.ts`, and `route.ts` — no connect/disconnect anything lives under
`settings`. The real routes are:

```
src/app/api/admin/integrations/google/connect/route.ts
src/app/api/admin/integrations/google/callback/route.ts
src/app/api/admin/integrations/housecall/connect/route.ts
src/app/api/admin/integrations/housecall/disconnect/route.ts
src/app/api/admin/integrations/fieldpulse/connect/route.ts
src/app/api/admin/integrations/fieldpulse/disconnect/route.ts
```

The underlying defect claim checks out — all three `connect` routes import
only `getAdminSession` (no `isSuperAdmin`), verified by grep on
`google/connect/route.ts`, `housecall/connect/route.ts`,
`housecall/disconnect/route.ts`. The `super_admin`-gated precedent is real
too (`src/app/api/admin/ai/model/route.ts` imports `isSuperAdmin`), though
the plan's second cited precedent ("billing") is not at an `admin/*` path —
billing lives at `src/app/api/platform/billing/route.ts`, gated by
platform-admin, a different role concept from org-level `super_admin`. Minor
inaccuracy, doesn't change the fix.

**Recommendation:** fix the Files glob to
`src/app/api/admin/integrations/{google,housecall,fieldpulse}/{connect,disconnect}/route.ts`.
The fix itself (add an `isSuperAdmin(session)` check, same shape as
`ai/model/route.ts`) is straightforward once an engineer is looking at the
right directory.

---

## F-3 — C1 — major — verified

Quote: `\`map-pins.ts\` pure functions (incl. \`esc()\`) get unit tests | \`src/app/api/admin/map/route.ts\`, map components, \`src/lib/admin/map-pins.ts\``

Both specific paths in this row are wrong:

- `src/app/api/admin/map/route.ts` does not exist. The real dispatch-map API
  route is `src/app/api/admin/dispatch/map/route.ts`.
- `src/lib/admin/map-pins.ts` does not exist. The real file is
  `src/components/admin/dispatch/map-pins.ts`, and `esc()` is indeed exported
  from it (confirmed: `export function esc(s: string): string` at line 110),
  so the underlying testability claim is accurate — it's just filed under
  `src/lib/admin/` when it actually lives under `src/components/admin/dispatch/`.

**Recommendation:** correct the Files column to
`src/app/api/admin/dispatch/map/route.ts` and
`src/components/admin/dispatch/map-pins.ts`.

---

## F-4 — C4 — major — verified

Quote: `All 11 pipeline phases shown, not 4; a run stuck in \`running\` is detectable and recoverable | \`src/lib/admin/import-status-model.ts\`, page`

`src/lib/admin/import-status-model.ts` does not exist. The real file is
`src/components/admin/fp-import/import-status-model.ts` (confirmed present,
alongside its own `import-status-model.test.ts` — good news for the
"pure function, vitest-testable" premise, just at the wrong path).

**Recommendation:** correct to
`src/components/admin/fp-import/import-status-model.ts`.

---

## F-5 — C5 — minor — verified

Quote: `surface the \`lastSyncError\`/\`availabilitySyncStatus\` columns that are already written and read by nothing | \`src/lib/admin/integration-queries.ts\`, integrations page`

`src/lib/admin/integration-queries.ts` does not exist. The file that computes
the "Connected" status shown on the integrations page is
`src/lib/admin/integrations-status.ts` (confirmed: its `status` field is
derived purely from a `connected` boolean per provider — `lastSyncError` and
`availabilitySyncStatus` are never referenced in it — so the underlying
"write-once lie" diagnosis holds). Close enough a name that a directory
listing would surface it quickly; rated minor rather than major unlike F-2/F-3/F-4.

**Recommendation:** correct to `src/lib/admin/integrations-status.ts`.

---

## F-6 — C3 — major — verified

Quote: `\`db.batch()\` replaces \`Promise.all\` in \`getDashboardOverview\` and \`getBotAnalytics\` (repo invariant)`

Checked against the installed drizzle-orm's actual type signature
(`node_modules/drizzle-orm/neon-http/driver.d.ts`):

```
batch<U extends BatchItem<'pg'>, T extends Readonly<[U, ...U[]]>>(batch: T): Promise<BatchResponse<T>>
```

Every element passed to `db.batch([...])` must itself be an unexecuted
drizzle query-builder object (`BatchItem<'pg'>`), not a `Promise` and not the
return value of an arbitrary async function.

`getBotAnalytics`'s `Promise.all` (bot-analytics-queries.ts, lines ~93+) is a
clean array of three `db.select()...` builder chains — this one is a
mechanical swap, exactly as the plan implies.

`getDashboardOverview`'s `Promise.all` (queries.ts, lines ~1200-1210) is
**not** uniform: its first element is `getDashboardStats(organizationId)`, a
wrapper `async function` that internally does
`const [result] = await buildDashboardStatsQuery(organizationId); return
toDashboardStats(result);` — i.e. it's already an awaited, post-processed
`Promise<DashboardStats>`, not a batchable query object. You cannot drop that
call into `db.batch([...])` next to the other three raw `db.select()...`
chains; it will not type-check (`Promise<DashboardStats>` is not
`BatchItem<'pg'>`), and even if coerced, `db.batch` needs the *unexecuted*
builder to include it in the single wire round-trip — an already-awaited
promise defeats the point entirely.

This doesn't make the item impossible — `buildDashboardStatsQuery`'s builder
can be inlined into the batch array and `toDashboardStats()` applied to the
corresponding slot of the batch's result tuple afterward — but "`db.batch()`
replaces `Promise.all`" undersells this as a mechanical find/replace. It's a
small refactor of `getDashboardStats`'s call shape, not a one-line swap, and
an engineer attempting the naive swap will hit a type error at exactly the
line AGENTS.md flags as a repo invariant.

**Recommendation:** note explicitly that `getDashboardOverview` requires
unwrapping `getDashboardStats` into its constituent `buildDashboardStatsQuery`
builder before batching, with `toDashboardStats()` applied post-batch; only
`getBotAnalytics` is a straight swap.

---

## Hidden migration check (claim: only W0-2 and A6 need migrations)

Checked every other Wave 0/A/B/C item against schema.ts and the referenced
query/route files for a column, enum value, or table the plan doesn't
mention needing:

- **A3** (demo-account chokepoint) — no new column needed. `DEMO_ORG_ID`
  (`"00000000-0000-0000-0000-000000000001"`) already exists as an exported
  constant in `src/lib/tenancy/organization.ts` and is already used for
  exactly this kind of org-identity check in `sms/incoming`,
  `voice/incoming`, and `webhooks/housecall`. The true shared chokepoint is
  `queueCommunicationJob` (job-queue.ts) or `checkSendAllowed` (consent.ts) —
  both take `organizationId`, not a session, so `isDemoAccount(session)`
  (session-email-keyed, in `authz.ts`) is the wrong primitive to reuse at
  that layer; an `organizationId === DEMO_ORG_ID` check is what actually
  fits there. Worth calling out in the plan since it currently implies
  reusing `isDemoAccount`, but not a blocker and not a migration.
- **A6** — already correctly flagged as needing a migration. Verified the
  approach is sound: `getAdminSession()` already does a per-request DB
  revocation check (`isSessionUserCurrent`, in `session-revocation.ts`), so
  adding a `passwordChangedAt`/token-version column and comparing it there
  follows an existing pattern rather than introducing a new one. `verifyToken`
  will need to start returning the JWT's `iat` claim (jose provides it,
  `config.ts` currently discards it) to make the comparison.
- **B4** (native estimates reaching a terminal state) — no migration needed.
  `estimateStatusEnum` already has `'dismissed'` and `'expired'`, and
  `BUCKET_CASE_SQL` in `estimate-queries.ts` already maps both to the `'lost'`
  bucket (line 243: `... OR ${estimates.status} IN ('dismissed','expired')
  THEN 'lost'`). The defect is that no native (non-FieldPulse) mutation route
  can currently *write* `dismissed`/`expired` onto an estimate — an
  application-layer gap, not a schema gap.
- **C6** (portal token-revoke) — no migration needed.
  `revokePortalToken()` already exists in `src/lib/portal/portal-queries.ts`
  and works by nulling the existing `portalTokenHash` column. Whatever is
  "not working" about revoke is a wiring/UI gap, not a missing DB capability.
- **B1, B2, B3, B5, B6, B7, C2** — checked each referenced file exists and
  each fix (guard clauses, `coalesce()`, bucket/label logic, CAS re-read) is
  pure application logic against existing columns. No new columns needed.
- **A2, A4, A5, A7, A8, A9** — pure logic/authorization changes against
  existing session/schema shapes. No new columns needed.

No item outside W0-2 and A6 needs a migration, env var, package, or
credential the repo doesn't already have.

---

## Invariant-breakage check (A7, A3, and the rest)

- **A7** (extend ZIP-verify to all `account-data-*` intents): verified
  exactly against `src/lib/ai/account-verify.ts` — the `INTENT_SENSITIVITY`
  record does show `account-data-next-visit`, `account-data-appointment-status`,
  and `account-data-reschedule` all mapped to `"none"` while only
  `account-data-balance`/`account-data-membership-status` are `"financial"`,
  matching the plan's claim precisely. The fix is a data change to a plain
  `Record`, not a prompt or guardrail-regex change — it doesn't touch FROZEN
  safety text, `output-guardrail.ts`, or the streaming theorem. `requiresVerify`
  is a pure function already (`vitest`-testable as-is).
- **A3**: does not touch `db.transaction()`/`db.batch()`, `after()`, tenancy
  scoping, or FROZEN text — see the hidden-migration section above for the
  one correction it needs (right check primitive, not a new one).
- **C3**: stays inside the stated invariant (`db.batch()` over
  `Promise.all`/`db.transaction()`) — see F-6 for the mechanical caveat, not
  an invariant violation.
- No item in W0/A/B/C touches FROZEN `src/lib/ai` prompt text,
  `output-guardrail.ts` regex shapes, the guarded-flush streaming code, or
  swaps `after()` for a detached promise anywhere I found.

---

## Testability check

- **C1**: `esc()` and the rest of `map-pins.ts`'s exports are already plain
  functions with no React/DOM dependency — directly `vitest`-testable once
  the Files column points at the real path (F-3).
- **C4**: `src/components/admin/fp-import/import-status-model.ts` already has
  a sibling `.test.ts` file, confirming the pure-function-test pattern the
  plan wants is already established there, not a new pattern being
  introduced.
- **B7, A7**: both fixes land in already-pure or already-isolated functions
  (`requiresVerify`, the CAS/state-derivation block in `takePayment`) —
  testable without jsdom/RTL, consistent with the repo's no-RTL rule.
- No item in scope requires component-level (jsdom/RTL) testing to prove.

---

## Verdicts

- **Wave 0**: feasible as written. W0-1 mirrors an existing, working script
  pattern (`mint-admin-session.mjs` → `signTechToken`/tech `users` role) with
  no gaps. W0-2's corrections were independently verified against git history
  (`git show a117843:drizzle/0027_...` and `392cbc4:drizzle/0008_...` both
  resolve and match the claimed semantic diff) and against the live dev DB
  (`trg_enforce_last_active_admin` already exists there, confirming the
  idempotency requirement is real, not speculative).
- **Wave A**: not feasible as written. A1 is a blocker — the primary
  described mechanism cannot work in this Next.js version, though its own
  parenthetical names the fix that would. A10 is major on a wrong file glob
  that matches nothing. A2–A9 are feasible as written (A3 has a one-primitive
  correction worth making, not blocking).
- **Wave B**: feasible as written. Every referenced file exists; B4 and C6's
  apparent schema needs turned out to already be satisfied by existing
  columns/enum values; B7's race condition was independently traced through
  the CAS `UPDATE...WHERE` logic and confirmed reproducible as described.
- **Wave C**: not feasible as written on three items — C1, C4 point at files
  that don't exist (major, easy fix: correct the path), C5 similarly at
  minor severity, and C3 understates `getDashboardOverview` as a mechanical
  `db.batch()` swap when one of its four parallel branches is a wrapped
  helper function that the batch API's type signature rejects outright.

## Counts

- Blocker: 1 (F-1 / A1)
- Major: 4 (F-2 / A10, F-3 / C1, F-4 / C4, F-6 / C3)
- Minor: 1 (F-5 / C5)
- Tag: all 6 findings `verified` (read the code and/or the installed
  package's docs/types directly; none inferred).

**A1 answer, directly:** No — a nested route group cannot opt a route out of
a component rendered by the root layout in Next.js 16.2.6 (confirmed via
`node_modules/next/dist/docs/01-app/03-api-reference/03-file-conventions/route-groups.md`
and the actual `src/app/layout.tsx`/`src/app/portal|estimates|review`
structure). The only way to remove `<Analytics/>` from specific routes via
layouts would be converting the entire app to multiple independent root
layouts, which is a far larger change than the plan's Files column implies.
The working fix is `beforeSend` (confirmed present in the installed
`@vercel/analytics` types) to mask/cancel the event for the three token
routes from the single existing `<Analytics/>` call — already named as the
plan's own parenthetical fallback.

**Items that secretly need a migration beyond W0-2/A6:** none found. A3, B4,
and C6 looked like migration candidates on first read but each resolved
against an already-existing constant/enum-value/column
(`DEMO_ORG_ID`, `estimateStatusEnum`'s `dismissed`/`expired`, and
`portalTokenHash`, respectively).
