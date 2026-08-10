# Code review — final increment (`766c5c1`)

Scope: `git show 766c5c1` only (equivalently `git diff fb27657..766c5c1`). Earlier
commits (`7787352..fb27657`) are covered by sibling reviewers and are not
re-litigated here except where 766c5c1's own claims depend on them.

Files touched (confirmed via `git show 766c5c1 --stat`): `docs/page-program/LEDGER.md`,
`fieldpulse-import/page.tsx`, `insights/page.tsx`, `integrations/page.tsx`,
`admin/(dashboard)/page.tsx`, `conversation-detail-content.tsx`,
`dashboard-stat-cards.tsx`, `import-status-model.{ts,test.ts}`,
`use-fp-import-status.{ts,test.ts}`, `use-integrations.ts`,
`bot-analytics-queries.{ts,test.ts}`, `integrations-status.{ts,test.ts}`,
`invoice-queries.{ts,test.ts}`, `queries.{ts,test.ts}`,
`fieldpulse/connection-queries.{ts,test.ts}`, `portal-queries.test.ts`.

---

## F-1 — DC-4 is claimed by this commit's message but is not in this diff

- **severity**: major
- **tag**: verified
- **file**: commit message of `766c5c1`, first bullet ("DC-4: technician field
  app tap targets raised to 44x44 … terminal status transitions
  (cancelled/completed) now require confirmation. Verified by measuring the
  live DOM at 390px, not by eye alone.")

`git show 766c5c1 --stat` lists 23 changed files; none is under `src/app/tech*`,
`src/app/tech-login*`, `src/app/api/tech*`, or `src/components/tech/*`. A repo-wide
`git log` confirms the technician tap-target/confirm-dialog work
(`src/components/tech/tech-status-confirm.ts`, `tech-status-confirm.test.ts`,
and the `min-h-11 min-w-11` class on the destructive control in
`tech-job-detail-client.tsx:587`) was actually committed in **`fb27657`** — the
commit this review is explicitly told NOT to re-review, because sibling
reviewers already cover it:

```
$ git log --oneline -- src/components/tech/tech-status-confirm.ts
fb27657 fix(pages): wave C + promoted P0s — ...
```

The underlying DC-4 feature is real and (on inspection) looks correctly scoped
to the two terminal statuses (`TERMINAL_STATUSES = new Set(['cancelled',
'completed'])` in `tech-status-confirm.ts:8`) — so this is not "DC-4 was never
built." It is that **this specific artifact under review (`766c5c1`) does zero
technician-app work** while its own commit message claims credit for DC-4,
including a specific verification method ("measuring the live DOM at 390px")
that did not happen in this commit. Anyone auditing `766c5c1` in isolation (as
this review was instructed to do) would reasonably conclude DC-4 shipped here
and was gated by this commit's `tsc 0 / vitest` run — it wasn't; it shipped a
commit earlier with its own gate.

**Fix**: correct the commit message (or, if this is a squash/rebase artifact,
note in `LEDGER.md` that DC-4 landed in `fb27657`, not here) so the changelog
and the diff agree.

---

## F-2 — B7 narrows the invoiceState race but does not eliminate it; the commit's "can no longer strand" claim overstates the fix

- **severity**: major
- **tag**: verified
- **file**: `src/lib/admin/invoice-queries.ts:258-259` and `:274` and `:336-339`

```ts
258  const invoiceState =
259    claimedInvoice.amountPaidCents >= claimedInvoice.totalCents ? "paid" : "open";
...
274      result = await provider.createCharge({   // <-- network round-trip, real provider
...
338      .set({ state: invoiceState, updatedAt: new Date() })
```

`invoiceState` is captured immediately after the atomic claim (correct, and a
real improvement over the pre-claim `inv` read it replaces — the isolated-call
unit tests in `invoice-queries.test.ts` correctly prove this half of the fix:
`mockInvoice({ amountPaidCents: 0 })` + `mockClaimReturning(10000, 10000)` +
`amountCents: 5000` → expects `"paid"`, which the pre-fix code (`inv.amountPaidCents
+ params.amountCents` = 0 + 5000 = 5000 < 10000) would have failed). That part
is genuinely fixed.

But `invoiceState` is a **snapshot frozen at claim time**, and the write of
that snapshot (line 338) happens only *after* inserting the payment row and
awaiting `provider.createCharge` (line 274) — an async network call to
whatever `PaymentProvider` is configured. Between the snapshot and the write,
a second concurrent partial payment on the same invoice can claim, compute its
own (correct, more current) `invoiceState`, and write it — and if *that*
write lands before this call's `createCharge` resolves, this call's stale
`"open"` snapshot overwrites it on line 338, permanently reverting a fully-paid
invoice's display state back to `"open"`. Concretely, for two 5,000¢ partials
against a 10,000¢ invoice:

1. A claims first → sees `amountPaidCents=5,000` → computes `invoiceState="open"`.
2. B claims second → sees `amountPaidCents=10,000` → computes `invoiceState="paid"`.
3. B's `createCharge` resolves faster → B writes `state="paid"` (correct).
4. A's slower `createCharge` finally resolves → A writes `state="open"`,
   clobbering B's write — exactly the "strand a paid invoice as open" failure
   the commit message says is now impossible.

Confirmed there is no periodic/independent reconciliation of `invoices.state`
from `amountPaidCents`/`totalCents` outside a payment's own
`takePayment`/`reconcilePayment` flow (`grep` for `invoiceState` in
`invoice-queries.ts` shows only these two call sites), so once mis-written this
way, nothing self-heals it. The money (`amountPaidCents`) is never wrong — only
the display `state`, which is what the collections workspace / dashboard tile
filters on (`state = 'open'`), so a stranded invoice would keep showing up in
the overdue/collections queue after being fully paid.

This is **not exploitable today**: `MockPaymentProvider.createCharge`
(`src/lib/payments/provider.ts:56-63`) is synchronous with no artificial
latency, so in the current deployment the window is essentially zero. But the
file's own header (`invoice-queries.ts:4`) says money "moves through the
PaymentProvider seam (mock until Stripe keys exist)" — i.e. a real,
network-latency-bound provider is the intended end state, and that is exactly
when this window opens up. None of the new tests exercise two overlapping
`takePayment` calls with out-of-order async resolution, so this residual race
is untested in both directions.

**Fix**: re-derive `invoiceState` from a fresh read (or a second conditional
write keyed off the current `amountPaidCents`) immediately before the final
`state` write, not from the value captured before the provider call — the same
pattern `reconcilePayment` uses (re-read right before its CAS, not across an
external network call).

---

## F-3 — C3c's db.batch test is theatre: nothing asserts `db.batch` was called

- **severity**: minor
- **tag**: verified
- **file**: `src/lib/admin/bot-analytics-queries.test.ts:18-27`

```ts
vi.mock('@/lib/db', () => ({
  db: {
    select: () => chain(selectQueue.shift() ?? []),
    // getBotAnalytics batches its three independent selects (db.batch, not
    // Promise.all) — ...
    batch: (queries: unknown[]) => Promise.all(queries),
  },
}));
```

The comment states the intent (prove `db.batch`, not `Promise.all`, is used),
but the mock's `batch` is just `Promise.all` under a different name, and no
test in the file spies on or counts calls to `db.batch` (`grep -n
"toHaveBeenCalled|vi.spyOn" bot-analytics-queries.test.ts` → no hits). If the
source in `bot-analytics-queries.ts:93` were reverted from `db.batch([...])`
back to `Promise.all([...])`, every test in this file would still pass
unchanged, because `Promise.all` is a real global available regardless of
whether the mock defines a `batch` method. The C3c source change itself is
real and correct (`bot-analytics-queries.ts:93`: `await db.batch([...] as
const)`) — only the regression test for it doesn't hold.

Contrast with the sibling test for the same pattern in the same commit,
`queries.test.ts:1038-1061` ("batches all five queries via db.batch, not
Promise.all"), which *does* capture calls into `batchCallArgs` (`queries.test.ts:66-67`)
and asserts `expect(batchCallArgs).toHaveLength(1)` / `toHaveLength(5)` — that
one is real proof and would fail on a revert to `Promise.all`.

**Fix**: add a `vi.fn()` wrapper around the mocked `batch` (mirroring
`queries.test.ts`'s pattern) and assert it was called once with all three
statements.

---

## F-4 — C5's fix covers only one of two "Connected" badges for FieldPulse

- **severity**: minor
- **tag**: verified
- **file**: `src/components/admin/settings/fieldpulse-panel.tsx:131-140` (unchanged by this commit)

```tsx
) : status.connected ? (
  ...
    Connected
```

The commit's C5 fix (`integrations-status.ts`) correctly makes the
`/admin/integrations` page's "Connected" badge fold in
`availabilitySyncStatus`/`lastSyncError`. But `Settings → Integrations`'s own
FieldPulse panel — the page a user would actually visit to reconnect a dead
credential — reads only `status.connected` from `GET
/api/admin/integrations/fieldpulse/status` and still renders a plain green
"Connected" regardless of sync health; that route/component were not touched
by this commit. Per `PLAN.md`'s own C5 scope line ("`src/lib/admin/integration-queries.ts`,
integrations page" — singular), this isn't a broken promise against the plan,
but the commit message's framing ("a dead credential stops showing green")
reads as a blanket claim it isn't: a dead FieldPulse credential still shows
green in Settings.

**Fix**: either scope the commit message more precisely to "the integrations
page" or extend the same sync-health fold to `fieldpulse-panel.tsx` in a
follow-up.

---

## F-5 — dashboard type cast is safe today but has no compile-time backstop

- **severity**: minor
- **tag**: inferred
- **file**: `src/app/admin/(dashboard)/page.tsx:19-23`

```tsx
const overdueInvoices =
  (overview as DashboardOverviewWithOverdue | null)?.overdueInvoices ?? null;
```

Verified this doesn't currently lie: `GET /api/admin/overview`
(`src/app/api/admin/overview/route.ts:28`) always calls
`getDashboardOverview` (the extended function that always populates
`overdueInvoices` — even the zero-row case resolves to `{count: 0, cents: 0}`
via `toDashboardOverdueInvoices`, `queries.ts`), and the hook
(`use-dashboard-overview.ts`) passes the parsed JSON through untouched, so the
field really is present on every response at runtime today. But the hook's own
type, `DashboardOverview` (`@/lib/admin/types`), does **not** declare
`overdueInvoices` — the cast is bridging a type the hook doesn't know about.
Nothing stops a future edit to the hook (e.g. normalizing/reconstructing the
object instead of passing the raw JSON through) from silently dropping the
field with no compiler error; the cast would then start returning `undefined`
at runtime and the UI would quietly show "—" forever instead of failing loudly.
Low current risk, called out because it's the exact "cast lies at runtime"
shape the review was asked to check.

**Fix**: either add `overdueInvoices` to the shared `DashboardOverview` type
(simplest) or have the hook's fetch return type reference
`DashboardOverviewWithOverdue` directly instead of casting at the call site.

---

## Verified sound (no finding)

- **C3b definitional consistency (highest-stakes item)**: `queries.ts:1207`
  imports `overdueWhere` from `./invoice-queries` (not a copy) and
  `queries.test.ts:918-936`'s new spy test (`vi.spyOn(invoiceQueries,
  'overdueWhere')`) genuinely proves the live function is invoked with the
  real `invoices` table object (`expect(spy).toHaveBeenCalledWith(expect.objectContaining({
  state: 'inv.state' }))`) — this is real proof, not a re-implementation. The
  surrounding `WHERE` clause (`state='open' AND totalCents > amountPaidCents`)
  is duplicated by hand between `buildDashboardOverdueInvoicesQuery` and
  `getInvoiceSummaryStats` (pre-existing pattern, not introduced here), but the
  part that defines "overdue" — the date logic — is single-sourced.
  Loading/zero states: `dashboard-stat-cards.tsx:75` — `value={overdueInvoices
  ? String(overdueInvoices.count) : '—'}` with `loading={isLoading}` on the
  `StatCard`, and `StatCard` renders a skeleton (not the value) while
  `loading` (`stat-card.tsx:91-94`) — a real `0` renders "0", "—" is
  unreachable in practice today only because `isLoading` is false exactly when
  `overview` (and thus `overdueInvoices`) is populated, so it degrades safely
  rather than lying.
- **DC-1 error mapping**: enumerated every code the route
  (`src/app/api/admin/conversations/[id]/message/route.ts`) can emit —
  `UNAUTHORIZED`, `DEMO_RESTRICTED`, `RATE_LIMITED`, `INVALID_INPUT`,
  `NOT_FOUND`, `UNSUPPORTED_CHANNEL`, `CONSENT_BLOCKED`, `INTERNAL_ERROR`
  (catch-all) — against `replyErrorToCopy` (`conversation-reply-logic.ts`,
  itself shipped in `fb27657` but wired up here): all seven named codes have a
  dedicated human sentence, and the `default` branch (hit by `INTERNAL_ERROR`,
  an unparsed error body, or any future code) is also a human sentence, never
  the raw code or `err.message`. Network failure in `handleSendReply`'s own
  `catch` also falls back to human copy (`conversation-detail-content.tsx:253`).
  No leak path found.
- **DC-4 conditional scope** (the underlying `fb27657` implementation,
  inspected only to calibrate F-1's severity): confirmed
  `isTerminalStatus`/`TERMINAL_STATUSES` in `tech-status-confirm.ts:8` is
  `{'cancelled', 'completed'}` only — not applied to every status change.
- **C4**: `PIPELINE_PHASES` in `import-status-model.ts:32-43` (11 entries) is
  byte-for-byte the same order as `PHASES` in
  `src/lib/integrations/fieldpulse/import/run-import.ts:75-169`. Staleness
  (`isStaleRun`, 3h threshold) and the `isPolling`/`asOfMs` wiring in
  `use-fp-import-status.ts` are internally consistent — `nextPollDelay` and the
  UI's `isStaleRun` calls both key off the same `nowMs`/`asOfMs` captured at
  fetch time, and the Refresh button's visibility (`fieldpulse-import/page.tsx:205`)
  correctly follows `!isPolling`. Tests are real (assert against the pure
  functions directly, with explicit timestamps).
- **B7 CAS / synced-invoice guards**: the atomic-claim `WHERE` predicate
  (`state IN (open,draft) AND amountPaidCents + amount <= totalCents`) is
  byte-identical to before this diff — only the `.returning()` projection and
  the post-claim derivation changed — so the over-collection guard itself is
  untouched and still race-free. The `fieldpulseInvoiceId`/`hcpInvoiceId`
  read-only check (lines 196-198) precedes the claim, unchanged. Only the
  display-state derivation has the residual race in F-2.
- **`sync_failed` typing**: `IntegrationStatus`/`STATUS_BADGE` in
  `integrations/page.tsx` is a `Record<IntegrationStatus, …>`, so TS forces
  exhaustive coverage of the new `sync_failed` member — verified via `tsc
  --noEmit` (clean on every file this commit touches; one pre-existing error
  in `src/app/api/admin/estimates/route.ts` unrelated to and untouched by this
  commit, inherited from `fb27657`, out of scope per the review brief).

## Tests run

```
npx vitest run src/lib/admin/queries.test.ts src/lib/admin/invoice-queries.test.ts
→ 2 files, 111 tests, all passed
```

`npx tsc --noEmit` run repo-wide: one pre-existing failure in
`src/app/api/admin/estimates/route.ts` (unchanged by `766c5c1`, inherited from
`fb27657`); every file this commit touches is clean.

## Counts

- blocker: 0
- major: 2 (F-1, F-2)
- minor: 3 (F-3, F-4, F-5)

## Verdict: **ship-with-fixes**

Nothing here corrupts money or breaks a currently-reachable user flow. F-1 is a
paperwork/audit-trail problem (fix the commit message or `LEDGER.md`, not the
code). F-2 is a real but currently-dormant race (only opens up once a
network-latency-bound `PaymentProvider` replaces the mock) that should be
closed before Stripe keys land, not necessarily before this ships. F-3
through F-5 are test-rigor and consistency nits. None blocks deploying this
increment as-is, but F-2 should be fixed before this codebase's Stripe adapter
goes live, and F-1 should be corrected in the ledger so the audit trail is
accurate.