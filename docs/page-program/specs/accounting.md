# accounting — target-state spec

`/admin/accounting` — the super_admin-only QuickBooks-compatible CSV journal
export.

## 1. Purpose

Let a super_admin download a period-scoped, double-entry-friendly journal
(invoices, payments, refunds, labor) so they — or their bookkeeper — can
import it into QuickBooks (or any ledger) by hand. It's a periodic EXPORT
tool, not a live dashboard: it owns no headline numbers and must not become
a second, driftable source of truth for figures that already live on
`/admin/invoices` and `/admin/operations`.

## 2. Brainstorm

Ideas considered, and what shipped or got cut:

- **Partition native vs. externally-synced (FieldPulse/HCP) money into two
  CSV sections with separate subtotals, no blended grand total** — shipped,
  the right call: synced invoices are already booked in the source
  system's own books, so a merged total would double-count revenue on
  import. verified (`accounting-export.ts:56-68, 333-363`).
- **A pluggable `AccountingProvider` seam** (mock CSV today, real QuickBooks
  OAuth push later) **instead of hardcoding CSV** — shipped, reasonable:
  keeps the route ignorant of the serialization format so a real QBO
  adapter drops in later untouched. verified (`accounting-provider.ts:19-67`).
- **Build the real QuickBooks OAuth push now** — rejected for this pass. No
  `QBO_CLIENT_ID`/`QBO_CLIENT_SECRET` configured (the seam falls back to
  `MockAccountingProvider` and logs a loud warning if those envs appear
  without an adapter, `accounting-provider.ts:52-66`); a live OAuth
  integration is a multi-week vendor project, not a page-spec-sized change.
- **Support the reserved `format=iif` (or another non-CSV) export** —
  rejected. Already parsed and rejected with `UNSUPPORTED_FORMAT` for
  anything but `csv` (`route.ts:71-78`); no evidence anyone's asked for IIF.
- **Show an AR / outstanding-balance headline on this page** — rejected.
  This page's job is a recognized-revenue + cash + labor JOURNAL, not a
  balance-sheet snapshot; AR aging already lives on `/admin/invoices` and
  `/admin/operations` with one shared definition (`outstandingCents =
  totalCents - amountPaidCents`, `invoice-queries.ts:869`). Duplicating any
  total here is exactly the failure mode behind this codebase's earlier "AR
  shows $0 on one surface, $152k on another" bug — don't reopen that door.
- **Canned date-range presets** / **in-app CSV preview before download** —
  both rejected: no friction evidence with the current pickers, and the
  tool's job is "download, open in your ledger app," not render a table
  in-browser. YAGNI.
- **Fix the FieldPulse/HCP synced-invoice date fields to match the
  `issuedAt`-aware definition every other money page already uses** —
  accepted, becomes Raccounting-1. The one real correctness bug found (see
  Gaps), and it directly implements the "do the numbers reconcile" lens.
- **Attribute the synced section's label to its real source (FieldPulse vs.
  HCP vs. both) instead of a hardcoded "FieldPulse" string** — accepted,
  becomes Raccounting-2. A false "already booked in FieldPulse" claim on an
  HCP-only org's export actively misdirects reconciliation.
- **Build a native `payments`-table mirror for HCP** (so the synced section
  always has a matching cash line) — considered, rejected for THIS spec:
  the HCP integration never writes to `payments` at all (verified below); a
  cross-cutting HCP-integration change this page's export logic can't close
  alone. P2 backlog.
- **Switch the export's 6 reads from `Promise.all` to `db.batch()`** — a
  real latency win (1 round-trip vs. 6, the pattern `reporting-queries.ts`
  already uses), held to P2: a manual, infrequent, super-admin-only button
  doesn't need the urgency of a wrong-numbers bug.

## 3. Current state

**Files** (verified — read in full): page
`src/app/admin/(dashboard)/accounting/page.tsx` · export panel
`src/components/admin/accounting/accounting-export-panel.tsx` · export route
`src/app/api/admin/accounting/export/route.ts` · journal builder
`src/lib/admin/accounting-export.ts` · provider seam
`src/lib/accounting/accounting-provider.ts` · schema `src/lib/db/schema.ts`
(`invoices`, `payments`, `refunds`, `technicianTimeEntries`).

**Auth / visibility** (verified): the panel probes
`GET /api/admin/accounting/export` with no params on mount; 401/403 renders
nothing, anything else (400 `VALIDATION_ERROR`) shows the form
(`accounting-export-panel.tsx:41-59`). The route gates on
`getAdminSession()` → 401 and `isSuperAdmin(session)` → 403 before any date
parsing (`route.ts:35-41`) — the client probe is UI hygiene only, the
server is the real authority. Rate-limited per admin user (`route.ts:43-50`).

**Date range handling** (verified): the client sends full-day UTC bounds
(`${from}T00:00:00.000Z` / `${to}T23:59:59.999Z`,
`accounting-export-panel.tsx:74-75`) — the same
`<date>T00:00:00.000Z`-anchored-UTC-day convention used repo-wide (calendar,
dispatch, forecasting rollups; e.g. `calendar-time.ts:44`,
`forecasting/rollups.ts:113`). Deliberate, consistent repo convention
(business is Eastern, but "day" boundaries are UTC-anchored everywhere),
not a page-specific divergence — not re-litigated here.

**Journal build — money and tenancy** (verified): 6 tenant-scoped,
period-scoped reads run in one `Promise.all` — native/synced invoices,
native/synced payments, refunds, labor (`accounting-export.ts:99-225`),
each through `withTenant(...)`. Cents convert to dollars only at the export
boundary (`centsToDollars`, `:70-73`); nothing mutates stored cents (the
file is read-only — its own header says so, and grep finds no
`.insert`/`.update`/`.delete` in it).

**Native vs. synced partition — no double-counting** (verified, and it's
solid): native rows are `fieldpulseInvoiceId IS NULL AND hcpInvoiceId IS
NULL` (invoices) / `fieldpulsePaymentId IS NULL` (payments); synced rows are
the `OR isNotNull(...)` complement (`accounting-export.ts:116-144`),
serialized into two labeled CSV sections with independent subtotals and
**no blended grand total** — `buildCsv` never sums `nativeTotal +
syncedTotal` (`accounting-export.ts:333-363`,
`accounting-export.test.ts:228-259, 306-322` asserts this explicitly). This
correctly avoids the money-double-counting failure mode the lens asks about.

**Date-field divergence from `/admin/invoices` and `/admin/operations`**
(verified, this is a real bug): the synced-invoice query filters and dates
every journal line by `invoices.createdAt` (`accounting-export.ts:133,
141-142` for the filter, `:246` for the CSV `date` field) — same as the
native query (`:113, 122-123, 234`, harmless there, see below). The schema
explicitly documents why `createdAt` is wrong for FieldPulse/HCP-mirrored
invoices: *"For pull-mirrored invoices (FieldPulse/HCP) issuedAt is when the
invoice was created THERE — createdAt is only when WE imported the row,
which made every mirrored invoice look 0 days old"*
(`src/lib/db/schema.ts:2769-2774`). The FieldPulse importer bears this out:
on upsert it sets `issuedAt: parseFpDate(invoice.invoicedDate ??
invoice.createdAt)` but never touches `createdAt`, citing a live-verified
case (FP invoice invoiced 2025-10-30, row `created_at` 2026-07-07 —
`src/lib/integrations/fieldpulse/invoice-sync.ts:423-429`); insert is the
same (`:468-484`, no `createdAt` key — defaults to `defaultNow()` at import
time). HCP's importer sets `issuedAt: parseFpDate(invoice.createdAt)` the
same way, also never touching the native `createdAt` column
(`housecall-pro/invoice-sync.ts:145, 173-187`). Both `/admin/invoices`
(`invoice-queries.ts:877-878, 944, 1015`) and `/admin/operations`
(`operations-metrics-queries.ts:243-245, 268-272`) already learned this
lesson and filter/sort/bucket by `coalesce(issuedAt, createdAt)` — the
accounting export is the one money surface still on raw `createdAt` for
synced rows. Native invoices' `issuedAt` is always null (schema comment
above), so `createdAt`-only filtering happens to be correct there — the bug
is synced-only, but that's exactly the revenue this export exists to
reconcile.

**HCP-synced invoices never produce a payment line** (verified): HCP writes
rows to `invoices` (`housecall-pro/invoice-sync.ts:173-189`) but a
repo-wide grep for `insert(payments)` under
`src/lib/integrations/housecall-pro/` returns nothing — HCP never writes to
`payments`. FieldPulse does mirror payments
(`fieldpulse/import/payments.ts:132-155`), with `createdAt` correctly set
to the real `payment.paymentDate`, not import time (`:130, 144` — no
`createdAt`-vs-`issuedAt` bug there). So for an HCP-only org, the synced
section will always show `invoice` lines (Sales Revenue) with **no matching
`payment` lines**, ever — a structural HCP-mirror gap this page's query
logic can't fix alone.

**Synced-section label hardcodes "FieldPulse"** (verified): the CSV section
marker correctly says "already booked in FieldPulse/HCP"
(`accounting-export.ts:350-352`), but three lines later the subtotal row is
unconditionally labeled `"FieldPulse synced subtotal"`
(`:358`) regardless of whether the synced rows came from FieldPulse, HCP, or
both.

**Read cost** (verified): the 6 queries run via `Promise.all`
(`:99-106`), each a separate neon-http round-trip. Sibling money-query
files already use `db.batch([...])` to collapse multi-select reads to one
round-trip (`reporting-queries.ts:97, 316, 484, 638`) — this export is the
one money-read path in the family still on `Promise.all`.

## 4. Gaps

| Gap | Severity | Evidence |
|---|---|---|
| Gaccounting-1: synced (FieldPulse/HCP) invoice rows are filtered and dated by `invoices.createdAt` (import time) instead of `coalesce(issuedAt, createdAt)` (real invoice date) — diverges from `/admin/invoices` and `/admin/operations`, which both already use the coalesce. A period export can silently omit revenue that was really issued in that period (it's dated to the bulk-import day instead) or include revenue from a different real-world period | P0 | `accounting-export.ts:133, 141-142, 246` vs. `invoice-queries.ts:877-878, 944, 1015` and `operations-metrics-queries.ts:243-245, 268-272`; root cause documented at `schema.ts:2769-2774` and `fieldpulse/invoice-sync.ts:423-429` |
| Gaccounting-2: the synced-section subtotal row is hardcoded `"FieldPulse synced subtotal"` even when the synced rows are HCP-sourced (or mixed) — misattributes which external system already booked the money | P1 | `accounting-export.ts:358` vs. the correctly-generic section marker at `:350-352` |
| Gaccounting-3: HCP-synced invoices never have a corresponding `payment` journal line — the HCP integration writes no rows to `payments` at all, so the synced section's "for reconciliation" promise can't be kept for HCP-only orgs | P2 | grep for `insert(payments)` under `src/lib/integrations/housecall-pro/` — no matches; contrast `fieldpulse/import/payments.ts:132-155` |
| Gaccounting-4: 6 tenant-scoped reads run as `Promise.all` (6 round-trips) instead of `db.batch()` (1 round-trip), the pattern already used by sibling money-query files | P2 | `accounting-export.ts:99-106` vs. `reporting-queries.ts:97, 316, 484, 638` |
| Gaccounting-5: no cap on requested date-range span or resulting row count — a super_admin can request a multi-year range and the whole CSV is built as one in-memory string before the response is sent | P2 (inferred — no evidence of an org actually hitting this) | `route.ts:80-107` builds `body` fully before constructing the `Response`; no row-count/range guard in `getAccountingExport` or the route |

## 5. Requirements

- **Raccounting-1**: Synced (FieldPulse- or HCP-sourced) invoice rows are
  filtered by, and dated on, `coalesce(invoices.issuedAt,
  invoices.createdAt)` — not raw `createdAt` — matching `/admin/invoices`
  and `/admin/operations`. Native rows are unaffected (`issuedAt` is always
  null there, so the coalesce no-ops). Acceptance:
  `accounting-export.test.ts` gains a case with a synced invoice whose
  `createdAt` falls OUTSIDE the requested period but `issuedAt` falls
  INSIDE it — the invoice appears in `result.synced`, dated by `issuedAt`;
  the inverse case (issuedAt outside, createdAt inside) is excluded.
- **Raccounting-2**: The synced-section subtotal label reflects the actual
  source(s) in that export's synced rows (e.g. "FieldPulse synced
  subtotal", "HCP synced subtotal", or source-neutral when mixed/absent)
  instead of an unconditional "FieldPulse synced subtotal". Acceptance:
  a `buildCsv` test asserts the subtotal label for an all-HCP-sourced
  synced section does not read "FieldPulse".

Gaccounting-3 through -5 (P2) are recorded in `README.md`'s backlog table,
not implementation work in this run, per METHOD.md's severity gate.

## 6. Non-goals

- **Live QuickBooks OAuth push / IIF format** — no credentials configured,
  no adapter built, no demand evidence; the provider seam already exists
  for whenever that's scoped separately.
- **AR / outstanding-balance headline on this page** — deliberately kept
  single-sourced on `/admin/invoices` and `/admin/operations`; this page
  reports recognized revenue + cash + labor for a period, not a balance.
- **Building an HCP `payments`-table mirror** (would close Gaccounting-3)
  and **`Promise.all` → `db.batch()`** (Gaccounting-4) — both real but P2:
  the former is a cross-cutting HCP-integration change outside this page's
  query logic, the latter a low-urgency perf win for an infrequent,
  manual, super-admin-only action.
- **Date-range/row-count caps or true response streaming** (Gaccounting-5)
  and **canned date-range presets / in-app CSV preview** — no evidence
  either has actually bitten an org or a user; YAGNI until it does.

## 7. Invariants

- Server-side super_admin gate (`getAdminSession` → 401, `isSuperAdmin` →
  403); the client's no-params probe is UI hygiene only, never the real
  gate. Reason: this file contains amounts — unauthorized visibility is a
  money-adjacent data leak. (`page-accounting/SKILL.md:26-27`)
- Cents→dollars conversion happens only at the export boundary
  (`centsToDollars`), never by mutating stored cents. Reason: repeated
  conversion elsewhere risks float drift.
- Native and FieldPulse/HCP-synced rows stay in separate CSV sections with
  independent subtotals, never a blended grand total. Reason: synced rows
  are already booked in the source system; a combined total double-counts
  revenue on import.
- Every read is tenant-scoped via `withTenant(...)` (`AGENTS.md`) — a
  cross-org sum here is a tenant breach in a file that processes only money.
- Memos carry ids only, never customer names/emails/addresses; the audit
  log records period + row counts only, never amounts or PII
  (`accounting-export.ts:14-18`, `route.ts:90-105`). Reason: an audited
  financial export's own audit trail must not become a PII surface.
- neon-http: `db.transaction()` throws at runtime — any future write path
  here must use `db.batch()` (`AGENTS.md`); this file is read-only today,
  so this guards a future regression, not a current violation.
- Export file name pattern
  `accounting-export-${from}_to_${to}.${extension}` using `YYYY-MM-DD`
  strings, not full ISO (`page-accounting/SKILL.md:33-34`) — don't break it.

## 8. Verification

- `npx tsc --noEmit` → 0. `npx eslint <changed files>` → 0 errors.
- `npx vitest run src/lib/admin/accounting-export.test.ts` → existing cases
  stay green; new cases for Raccounting-1 (issuedAt-vs-createdAt boundary)
  and Raccounting-2 (source-accurate subtotal label) pass.
- `npx vitest run` → must not drop below the live baseline (297 files /
  4022 passed / 1 skipped, `docs/page-program/README.md`). No jsdom/RTL.
- Visual check via the admin-pages recipe: mint a super_admin session,
  `screenshot-page.mjs /admin/accounting`, confirm the panel renders and
  the CSV still downloads with two sections/subtotals (Raccounting-1/2's
  numbers are covered by the vitest cases above, not screenshot-verifiable).
- `node scripts/agent/verify-skills.mjs` → 0 missing, after updating
  `page-accounting/SKILL.md` if files/flows change (e.g. documenting the
  `coalesce(issuedAt, createdAt)` rule once Raccounting-1 ships).
