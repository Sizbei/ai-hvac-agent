# Invoices — `/admin/invoices` + `/admin/invoices/[id]`

## Purpose

Give an operator one collections workspace: see who owes money (oldest/most
overdue first), chase it with one tap (reminder, pay link), record/refund
native payments, and treat FieldPulse/Housecall-Pro-mirrored invoices as
strictly read-only so this app never fights the system of record for money
that lives elsewhere.

## Brainstorm

This page already went through a full collections redesign
(`docs/page-program/README.md:7` baseline post-dates it), so the bar for new
work is high:

- **Age-sorted overdue-first queue with one-tap reminder/pay link** — done,
  keep. `age-oldest` is the default sort (`page.tsx:156`).
- **Multi-source money guard enforced server-side** — done for
  payment/refund/void; **NOT** done for the manual reminder action. See
  Gaps — this is the one real hole found.
- **Bulk "remind all overdue" action** — rejected: the 6h per-invoice
  cooldown and consent/quiet-hours gate (`money-triggers.ts:249`) make a
  bulk button either a wall of no-op errors or a spam risk; the existing
  weekly automated dunning sweep (`sendOverdueInvoiceReminders`,
  `money-triggers.ts:380-431`) already owns that job on a safe cadence.
- **CSV export of the collections list** — rejected: no requirement
  evidence, and money-of-record for synced invoices is FieldPulse/HCP, not
  this table — an export here would be incomplete for any multi-source org.
- **Aging-bucket (0-30/31-60/61-90+) stat tiles** — rejected:
  `oldestOverdueDays` + age-oldest sort + balance-range filter already let
  an operator work the queue oldest-first; a bucket chart is polish. YAGNI.
- **Disclose "Collected this month"'s native-only scope in its label** —
  real, small gap; see Gaps (P2).
- **Trigram/full-text index to remove the 5,000-row search cap** — rejected
  for this pass, same call as the sibling `customers` spec: it's a new
  indexing architecture, not a page-level change.
- **Client-side pre-check to hide "Void invoice" when payments exist** —
  rejected: the server already returns a clean human `VOID_FAIL` message
  (`page.tsx:52,294`) on the rare attempt; not broken, one avoidable round
  trip. Not worth a requirement.

## Current state

**List page** `page.tsx` — filter tabs (Overdue/All/Unpaid/Paid,
`page.tsx:59-66`, default `overdue`), source segmented control (hidden when
`sourceCounts` has only one non-zero source, `page.tsx:363`, `verified`),
sort select, "Never reminded" toggle, min/max balance-in-dollars inputs,
300 ms debounced search (`page.tsx:232-235`). All filters URL-synced except
page number (`page.tsx:169-194`, `verified` — explicit comment on why).
`ReconcileBanner` (`page.tsx:99-147`) polls `GET
/api/admin/payments/reconcile` on mount, offers "Reconcile now" for stuck
`pending` payments; best-effort, swallows fetch errors (`page.tsx:112-114`).

**Data fetch** `useInvoices` (`use-invoices.ts:120-236`) hits `GET
/api/admin/invoices` with a params-keyed 60s SWR cache (`:80`), `verified`.
Stats/sourceCounts/`collectedThisMonthCents` all come from the server so
`SummaryBand` never re-derives over a partial client page (`:174-186`).

**List query** `listInvoices` (`invoice-queries.ts:949-1175`): server-side
WHERE/ORDER BY/LIMIT/OFFSET for browse; `sourceCounts` facet uses a WHERE
that omits the active source filter so every tab shows a correct count
(`:1008-1052`). Search path (encrypted names aren't SQL-filterable): loads
the newest 5,000 matching rows, decrypts, filters in app code, paginates
the JS array (`:1099-1154`, comment confirms this mirrors
`SCAN_LIMIT_INVOICES` in `search-queries.ts`) — no indicator when an org
exceeds 5,000 rows. `overdueWhere`/`makeOverduePredicate` (`:44-49,
941-946`) is the single overdue predicate reused by both
`getInvoiceSummaryStats` and the `overdue=1` list filter — identical SQL in
both call sites (1-day grace past `dueDate`, else 30 days since
`coalesce(issuedAt, createdAt)`), and native/FP/HCP rows share the same
column shape, so overdue means the same thing across sources, `verified`.

**Row/detail actions** — `InvoiceRow` and `InvoiceDetailClient` both gate
Send reminder / Copy pay link / Void / Take payment on
`invoice.syncedSource === null` client-side (`invoice-row.tsx:135,167,172`;
`invoice-detail-client.tsx:355,367,379`), `verified`.

**Money mutations** (`invoice-queries.ts`): `takePayment` (158-331),
`refundPayment` (333-491), `voidInvoice` (1445-1487) each read
`fieldpulseInvoiceId`/`hcpInvoiceId` and return `synced_read_only` before
touching money, then re-check the same guard inside one atomic
conditional-write claim — `verified`, covered by
`invoice-synced-guards.test.ts` (4 tests, green). Over-collection/refund
guard is the same pattern: `takePayment`'s claim predicate is
`amountPaidCents + amount <= totalCents` (`:232`); `refundPayment`'s is
`amountRefundedCents + amount <= amountCents` (`:420`) — single conditional
writes, not read-then-write, `verified`.

**Manual reminder** `sendInvoiceReminder` (`money-triggers.ts:252-358`)
checks `isCollectible` and the 6h cooldown (atomic claim, `:308-323`) —
but never reads `fieldpulseInvoiceId`/`hcpInvoiceId`. Contrast the
automated weekly sweep `sendOverdueInvoiceReminders` in the **same file**
(`:380-431`), which explicitly filters `isNull(fieldpulseInvoiceId),
isNull(hcpInvoiceId)` with the comment: *"the UI already refuses reminders
on synced rows, and dunning them here would double-text real customers"*
(`:398-402`). The manual path lacks the guard its own sibling documents as
necessary; `invoice-synced-guards.test.ts` has no case for it, `verified`.

**Refund gate** — renders only when the server component computes
`canRefund = isSuperAdmin(session)` (`[id]/page.tsx:16-20`), and `POST
/api/admin/payments/[id]/refund` independently re-checks `isSuperAdmin`
(`refund/route.ts:31-33`), `verified` — UI hiding and server enforcement
both present here, unlike the reminder case above.

**INT32 clamp** — `GET /api/admin/invoices` rejects (400, not silently
clamps) `minCents`/`maxCents` outside `[0, 2_147_483_647]`
(`route.ts:72-92`), `verified`.

**"Collected this month"** `collectedThisMonthCents` (`:755-777`) sums
`payments.amountCents` where `status='succeeded' AND fieldpulsePaymentId IS
NULL` this UTC month. This exclusion is deliberate and previously
reviewed — git log shows it was added to "prevent FP record-only payments
from inflating revenue." HCP payments are **never** written to `payments`
at all — the HCP sync path (`housecall-pro/invoice-sync.ts`) writes
`invoices.amountPaidCents`/`state` directly (confirmed by a repo-wide grep
for `insert(payments)`: only `invoice-queries.ts:252` (native charge) and
`fieldpulse/import/payments.ts:133` (FP import) exist) — so the same
native-only scope applies to HCP by construction, not by an explicit
filter. Net effect: deliberately scoped to money collected *through this
app*, `verified` as intentional, not drift — but the `StatCard` sublabel
"Payments received since the 1st" (`summary-band.tsx:45`) doesn't disclose
that scope.

## Gaps

| Gap | Severity | Evidence |
|---|---|---|
| `sendInvoiceReminder` (manual "Send reminder"/"Remind again") does not check `fieldpulseInvoiceId`/`hcpInvoiceId`. UI hides the button for synced invoices, but a direct `POST /api/admin/invoices/[id]/send-reminder` on a FieldPulse/HCP-mirrored invoice succeeds — double-texting a customer whose invoice is managed (possibly already paid) elsewhere, using a balance the UI itself calls "informational" (`invoice-detail-client.tsx:391-394`). The sibling automated dunning function in the same file has the exact guard with a comment documenting why it's required. | P0 | `money-triggers.ts:252-358` (no synced check) vs. `:398-402` (guard + comment on sibling); `invoice-row.tsx:135`, `invoice-detail-client.tsx:355` (UI-only gate); `invoice-synced-guards.test.ts` (no reminder coverage) |
| "Collected this month" is deliberately native-only (FieldPulse payments excluded; HCP payments never enter `payments`), but the sublabel doesn't say so — reads as comprehensive collections for a multi-source org. | P2 | `invoice-queries.ts:755-777`; `summary-band.tsx:45` |
| Encrypted-name search scans only the newest 5,000 invoices; older rows beyond that are silently unsearchable, no indicator. Latent, not active (no evidence any org is near 5,000). | P2 | `invoice-queries.ts:1099-1154` |

No other documented invariant in `.claude/skills/page-invoices/SKILL.md`
(multi-source guard, reminder cooldown, overdue semantics, `issuedAt`
coalesce, INT32 clamp, over-collection CAS, refund gate, SummaryBand
load-guard, source-tab hide-when-single-source, void irreversibility) was
found drifted — all re-verified against current source, and the 5 targeted
vitest suites (`invoice-collectible`, `invoice-list-pagination`,
`invoice-queries`, `invoice-synced-guards`, `invoice-queries-list`) pass
78/78 green.

## Requirements

- **Rinvoices-1**: `sendInvoiceReminder` (`money-triggers.ts:252-358`) must
  refuse when `fieldpulseInvoiceId` or `hcpInvoiceId` is non-null, returning
  a new `synced_read_only` reason (mirroring the reason already used by
  `takePayment`/`refundPayment`/`voidInvoice`/the pay-link route).
  *Acceptance:* a unit test calling `sendInvoiceReminder` against a mocked
  row with `fieldpulseInvoiceId: "fp-1"` (and separately `hcpInvoiceId:
  "hcp-1"`) asserts `{ ok: false, reason: "synced_read_only" }` and that
  `queueCommunicationJob` is never called; `send-reminder/route.ts` maps the
  new reason to a 4xx with a human message (reusing the existing
  `REASON_STATUS`/`REASON_MAP` pattern, `page.tsx:42-48`). A native,
  collectible invoice's reminder flow is unaffected (existing
  cooldown/no-contact/no-template tests still pass).

(The two P2 gaps are recorded above and in `README.md`'s backlog table; not
built this pass per the severity gate — no requirement created for them.)

## Non-goals

- Bulk "remind all overdue" — cooldown + consent gate make it a wall of
  no-ops or a spam risk; the weekly automated sweep already owns that job.
- CSV export of the collections list — no requirement evidence; incomplete
  for multi-source orgs (money-of-record is FieldPulse/HCP for synced rows).
- Aging-bucket stat tiles — existing sort/filter set already supports
  working the queue oldest-first; a chart is polish, not a hole.
- A new searchable-index architecture to remove the 5,000-row search cap —
  real fix for the P2 gap, but a multi-page indexing change. Backlog (same
  call as the `customers` spec).
- Relabeling/redesigning "Collected this month" beyond its sublabel — the
  native-only scope is intentional, previously-reviewed design; only the
  disclosure is P2.
- Client-side pre-check hiding "Void invoice" when payments exist — server
  already returns a clean human failure message; not broken.

## Invariants

- **Multi-source money guard**: `fieldpulseInvoiceId`/`hcpInvoiceId` set →
  read-only for void, payment capture, refund — enforced server-side inside
  the same atomic write as the mutation, regardless of UI state. (After
  Rinvoices-1, extends to the manual reminder action too.)
- **Reminder cooldown**: `REMINDER_COOLDOWN_MS = 6h`
  (`invoice-collectible.ts:17`), atomic claim via guarded `UPDATE`. Never
  surface the raw `COOLDOWN` code — map to "A reminder was already sent
  recently."
- **Overdue semantics (full-day boundary parity)**: with `dueDate`, overdue
  when more than 1 day past due; without one, overdue when
  `coalesce(issuedAt, createdAt) <= now() - 30 days`. Native and FP/HCP
  rows share this exact SQL via `overdueWhere`/`makeOverduePredicate` —
  never fork the predicate per source.
- **`issuedAt` coalesce**: age/sort always use `coalesce(issuedAt,
  createdAt)`, never raw `createdAt` — for mirrored rows `createdAt` is
  import time and understates age.
- **INT32 overflow guard**: `minCents`/`maxCents` outside `[0,
  2_147_483_647]` rejected with 400, never silently clamped/dropped.
- **Over-collection/over-refund CAS**: `takePayment`/`refundPayment` each
  reserve their delta with a single conditional `UPDATE` predicate before
  calling the payment provider — never read-then-write.
- **Refund control**: rendered only when server-computed
  `canRefund=isSuperAdmin(session)`; the API independently enforces
  `isSuperAdmin` regardless of client state.
- **SummaryBand load-guard**: suppressed while `isLoading` — do not remove.
- **Source tab visibility**: hidden when `sourceCounts` has only one
  non-zero source — deliberate, no single-source noise.
- **Void is terminal**: `state='void'` cannot be undone via the UI; server
  blocks voiding synced invoices and any invoice with `amountPaidCents > 0`.
- **Design system**: compose `PageShell`, `PageHeader`, `Pager`,
  `SegmentedControl`; status colors only via `status-colors.ts`.
- **Tenancy**: every query in `invoice-queries.ts` is scoped by
  `organizationId` via `withTenant` (repo-wide, `AGENTS.md`).
- **neon-http has no interactive transactions**: multi-statement money
  writes use `db.batch()` plus the atomic-claim pattern above — never
  introduce `db.transaction()` on this page's write paths.

## Verification

- `npx tsc --noEmit` → 0.
- `npx eslint src/lib/communication/money-triggers.ts
  src/app/api/admin/invoices/[id]/send-reminder/route.ts` (+ other changed
  files) → 0 errors.
- `npx vitest run src/lib/admin/invoice-collectible.test.ts
  src/lib/admin/invoice-list-pagination.test.ts
  src/lib/admin/invoice-queries.test.ts
  src/lib/admin/invoice-synced-guards.test.ts
  src/lib/admin/invoice-queries-list.test.ts` → must not drop below the
  live baseline (297 files · 4022 passed · 1 skipped, `README.md:7`); 78/78
  observed here is this page's pre-change floor.
- New coverage for Rinvoices-1: a test asserting `sendInvoiceReminder`
  returns `{ ok: false, reason: "synced_read_only" }` for both
  `fieldpulseInvoiceId` and `hcpInvoiceId` set, `queueCommunicationJob`
  never invoked; a route-level assertion the reason maps to a 4xx with a
  human message, never the raw code.
- Visual: `node scripts/agent/screenshot-page.mjs /admin/invoices` and
  `/admin/invoices/[id]` (a synced and a native id) per the `admin-pages`
  recipe — confirm reminder affordances still hide for synced rows (no
  visual change expected — Rinvoices-1 only changes server behavior on a
  path the UI already hides).
- Manual/API check: as a dev admin session, `POST
  /api/admin/invoices/[id]/send-reminder` directly against a known
  FieldPulse-synced invoice id, confirm a 4xx with `synced_read_only` (or
  mapped message), not a queued reminder.
