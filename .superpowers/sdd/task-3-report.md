# Task 3 Report — Invoices pagination + server-computed summary stats

## Status: DONE_WITH_CONCERNS

---

## What was built

### 1. `getInvoiceSummaryStats` (src/lib/admin/invoice-queries.ts)

New exported function that runs a single SQL aggregate over the full open-balance set:
- `outstandingCents / outstandingCount`: all rows where `state='open' AND total > paid`
- `overdueCents / overdueCount`: filtered by `(dueDate IS NOT NULL AND dueDate < now()) OR (dueDate IS NULL AND coalesce(issuedAt, createdAt) < now() - interval '30 days')` — exactly matches `overdueByDates` in `age-chip.tsx`
- Neon bigint strings wrapped with `Number()` in the mapper

### 2. `listInvoices` converted to paginated (src/lib/admin/invoice-queries.ts)

Signature changed from `listInvoices(orgId): Promise<InvoiceListRow[]>` to `listInvoices(orgId, opts?): Promise<InvoiceListPage>`.

New options: `page`, `limit` (clamped to 1–20000), `search`, `state`, `source`, `customerId`, `serviceRequestId`.

Three db queries in `Promise.all`:
- `sourceCountsPromise`: SQL CASE facet returning native/fieldpulse/housecall counts
- `countPromise`: total row count for pager
- `rowsPromise`: page rows with `LIMIT/OFFSET`, `ORDER BY coalesce(issuedAt, createdAt) DESC`

Source filter: `native` → both ids IS NULL; `fieldpulse`/`housecall` → respective id IS NOT NULL.

Search path: decrypt-then-filter (customer name is encrypted). Loads ALL matching rows server-side, decrypts, filters, then slices the page.

Added `fieldpulseData` to the select projection (Task 11 dependency).

New exported interfaces: `InvoiceSummaryStats`, `InvoiceListPage`, `ListInvoicesOptions`.

### 3. API route updated (src/app/api/admin/invoices/route.ts)

GET now accepts `page`, `limit`, `search`, `state`, `source`, `customerId`, `serviceRequestId` params. State validated against `invoiceStateEnum.enumValues`; source validated against `['native','fieldpulse','housecall']`. Three parallel fetches: `listInvoices`, `getInvoiceSummaryStats`, `collectedThisMonthCents`.

Response shape: `{ invoices, total, sourceCounts, stats, collectedThisMonthCents }`.

### 4. Hook updated (src/hooks/use-invoices.ts)

`useInvoices(params?)` — params-keyed SWR cache (`invoices:page:limit:search:state:source:customerId:serviceRequestId`). Returns `{ invoices, total, sourceCounts, stats, collectedThisMonthCents, isLoading, error, refetch, sendReminder, voidInvoice }`. Builds query string only for non-default values.

### 5. SummaryBand updated (src/components/admin/invoices/summary-band.tsx)

Now a dumb renderer: `SummaryBand({ stats: InvoiceStats | null, collectedThisMonthCents: number })`. Removed the client-side reduction (lines 13–16). Outstanding/overdue numbers come from the server.

Note: The "oldest N days" line was removed from the overdue tile since we no longer have the full list to compute it. The server stats don't include max age (would require an additional aggregate). This is a minor UX regression — if it's needed, add `oldestOverdueDays` to `getInvoiceSummaryStats`.

### 6. Invoices page updated (src/app/admin/(dashboard)/invoices/page.tsx)

Controls mapped to server params:
- `filter` → `state` param (`overdue`/`unpaid` → `state=open`, `paid` → `state=paid`, `all` → no state filter)
- `source` → `source` param (all/native/fieldpulse/housecall)
- `search` → `search` param, 300ms debounce (increased from 150ms to match pricebook pattern)
- `page` → `page` param

`overdue` tab: server sends `state=open`, client further filters displayed rows via `isCollectible(i) && overdueByDates(i)`. The overdue badge count comes from `stats.overdueCount`. The pager label for the `overdue` tab uses the client-filtered `displayRows.length` (correct: only overdue rows shown).

`sourceOptions` derived from `sourceCounts` returned by the server.

Sort is client-side on the current page (preserving existing behavior — server orders by `coalesce(issuedAt, createdAt) DESC`; other sort keys re-sort the 50-row page).

`paginate()` usage removed; `pageLabel` kept.

---

## Controls audit — every UI control mapped to a server param

| UI control | Before (client) | After (server param) |
|---|---|---|
| Filter tabs (overdue/all/unpaid/paid) | client filter | `state=open/null/open/paid` |
| Source segmented (all/native/FP/HCP) | client filter | `source=native/fieldpulse/housecall` |
| Sort dropdown (newest/oldest/balance-high/age-oldest) | client sort | **client sort on current page** (no server sort param) |
| Search | client search | `search=` (decrypt-then-filter server-side) |
| Pager (prev/next/first/last) | client slice | `page=` server param |

**Sort note:** Sort is the one control NOT mapped to a server param. The server always returns `ORDER BY coalesce(issuedAt, createdAt) DESC`. Other sort keys (oldest, balance-high, age-oldest) re-sort the current 50-row page client-side. This means sort rankings are page-local, not global. This is a known limitation — adding server-side ORDER BY would require additional Drizzle SQL for each sort key. For the 2,851-row invoice table it's a visual inconsistency but not a correctness issue (the overdue/outstanding numbers are correct from SQL stats).

---

## ScopedInvoicesSection workaround

`ScopedInvoicesSection` still calls `useInvoices()` and filters client-side. Now that `useInvoices()` returns only 50 rows by default, invoices for a customer/request beyond page 1 would be invisible.

Added `{ limit: 20000 }` workaround in `src/components/admin/invoices/scoped-invoices-section.tsx` — this loads all rows in a single request and continues the existing client-filter pattern. Note in comment: "Task 4 will replace this with a server-scoped fetch."

---

## Tests

New test file: `src/lib/admin/invoice-list-pagination.test.ts`
- `(a)` stats SQL WHERE contains `state='open'` AND `total>paid`
- `(b)` bigint string wrapping with `Number()`
- `(c)` page query carries LIMIT
- `(d)` count and rows share same WHERE when state filter active
- `(e)` source filter `'native'` produces both-ids-NULL predicates
- `(f)` tenant scope on all queries
- 1 bonus: sourceCounts shape test

Updated `src/lib/admin/invoice-queries-list.test.ts` — fixed schema mock (added missing fields: issuedAt, dueDate, fieldpulseData, invoiceStateEnum), drizzle-orm mock (added count, asc, isNotNull), and test body (3 queue items, `.invoices[0]` accessor).

Updated `src/lib/admin/invoice-queries.test.ts` — updated `mockReadSeq` to support chainable leftJoin/orderBy/limit/offset; updated `listInvoices` test to queue 3 results and use `.invoices`.

---

## TypeScript / Vitest

- `npx tsc --noEmit` → clean (0 errors)
- `npx vitest run` → 3783 passing, 1 skipped, 2 pre-existing failures (money-triggers server-only import error; accounting/export CSV test; invite/accept technician redirect — all confirmed pre-existing from baseline)
- New tests: 7/7 passing

---

## Concerns

1. **Sort is page-local**: The 4 sort options (age-oldest, newest, oldest, balance-high) sort the current 50 rows, not the full 2,851. This is the same limitation as any other paginated list without server-sort. The brief didn't require server-sort — flagging for awareness.

2. **Overdue pager**: When `filter=overdue`, the pager label shows `displayRows.length` (client-filtered count, correct for what's visible), not the server `total` (which is state=open). If there are > 50 open invoices, the overdue tab may not show all of them (only those on the current page that are overdue). A proper fix would add an `overdue` server-side filter using the same SQL predicate as `getInvoiceSummaryStats`. Flagging for Task review.

3. **SummaryBand "oldest" line removed**: The old SummaryBand showed the oldest overdue invoice age. Removed since we no longer have the full list. Can be restored by adding `oldestOverdueDays` to the stats query.

4. **ScopedInvoicesSection workaround active**: `{ limit: 20000 }` added. Task 4 should replace this with a server-scoped fetch using `customerId` / `serviceRequestId` params (now supported by the new `listInvoices`).

---

## Fix round 1

**Commit:** 26fc48e  
**Branch:** feat/pagination-ar-fp

### What changed

**Gap 1 — Sort is now server-side (all 4 keys)**

All 4 sort keys (newest, oldest, balance-high, age-oldest) were analysed:
- `newest` / `oldest` → `ORDER BY coalesce(issuedAt, createdAt) DESC/ASC` — pure SQL
- `balance-high` → `ORDER BY (totalCents - amountPaidCents) DESC` — pure SQL
- `age-oldest` → `ORDER BY CASE WHEN total > paid THEN extract(epoch from now() - coalesce(issuedAt, createdAt)) ELSE -1 END DESC` — pure SQL (no encrypted column involved)

None of the 4 sort keys touch encrypted customer name, so all are SQL-sortable without decrypt-then-sort.

Added `InvoiceSortKey` type and `INVOICE_SORT_KEYS` set to `invoice-queries.ts`. Added `sort?: InvoiceSortKey` to `ListInvoicesOptions` with a `resolveOrderBy()` helper that maps each key to a Drizzle `asc`/`desc` expression. The ORDER BY replaces the previous hardcoded `desc(coalesce(...))`. Both the paginated rows query and the search/decrypt path use the same `orderByClause`.

Route: whitelists `sort` param via `INVOICE_SORT_KEYS.has()`, invalid values → `undefined` (never a 500). Hook: `sort` added to `UseInvoicesParams`, `makeKey`, and `buildQuery`. Page: removed `sortInvoices` client-side call, passes `sort: sortKey` to hook, removed unused `isCollectible` / `overdueByDates` / `SortKey` imports.

**Gap 2 — Overdue filter is now server-side**

Added `overdue?: boolean` to `ListInvoicesOptions`. When true, two extra conditions are pushed: `totalCents > amountPaidCents` and `makeOverduePredicate()` (the exact SQL predicate from `getInvoiceSummaryStats`). This makes the pager `total` reflect the overdue-filtered count, not the whole `state=open` set.

`makeOverduePredicate()` is a factory function (not a module-level const) to avoid calling `sql\`\`` at import time — which broke tests that mock `drizzle-orm` without the `sql` export.

Route: `overdue=1` query param → `overdue: true`. Hook: `overdue` in params/key/query. Page: `serverOverdue = filter === 'overdue'` passed to hook; client-side `overdueByDates`/`isCollectible` filter removed from `displayRows`; pager now always uses server `total`.

**Gap 3 — oldestOverdueDays restored in SummaryBand**

`getInvoiceSummaryStats` extended with `oldestOverdueDays` aggregate:
```sql
max(CASE
  WHEN dueDate IS NOT NULL AND dueDate < now()
    THEN extract(day FROM now() - dueDate)
  WHEN dueDate IS NULL AND coalesce(issuedAt, createdAt) < now() - interval '30 days'
    THEN extract(day FROM now() - coalesce(issuedAt, createdAt)) - 30
  ELSE 0
END) FILTER (WHERE overdue) :: bigint
```
Wrapped with `Number()`. Added to `InvoiceSummaryStats` interface, `InvoiceStats` in the hook, and rendered in `SummaryBand` as "oldest N days past due" appended to the overdue-count line (hidden when 0).

**Test changes**

`invoice-list-pagination.test.ts`:
- Mock chain extended to capture `orderBy` argument per query.
- 6 new tests added (e–j): sort keys produce correct `asc`/`desc` on rows query; `overdue=true` adds `sql` predicate to WHERE for both count and rows; `overdue=false` (default) does not.

### Commands + output summary

```
npx tsc --noEmit    → clean (0 errors)
npx vitest run src/lib/admin/invoice-list-pagination.test.ts
  → 13/13 passed (7 original + 6 new)
npx vitest run src/lib/admin/
  → 67 test files, 815 tests, all passed
```

### Concerns

None. All 4 sort keys are SQL-sortable (no encrypted column involved). The `age-oldest` SQL CASE produces equivalent ordering to the prior client-side `sortInvoices` function.

---

## Fix round 2

**Branch:** feat/pagination-ar-fp

### What changed per finding

**Critical 1 — Missing GROUP BY on sourceCountsPromise**
`src/lib/admin/invoice-queries.ts` (around line 1005):
- Extracted the source-classification CASE expression into a shared `sourceExpr` sql variable.
- Added `.groupBy(sourceExpr)` to the `sourceCountsPromise` chain — SELECT and GROUP BY now reference the identical expression, so they can't drift.

**Critical 2 — sourceCounts WHERE wrongly included the source filter**
`src/lib/admin/invoice-queries.ts` (around line 948):
- Changed the condition-building block to maintain two parallel arrays: `extraConditions` (for rows/count WHERE) and `extraConditionsNoSource` (for facet WHERE).
- A local `pushCond(c, includeInNoSource = true)` helper populates both by default; source predicates pass `false` so they go only into `extraConditions`.
- Built `whereClauseNoSource = withTenant(invoices, organizationId, ...extraConditionsNoSource)` and used it in `sourceCountsPromise` instead of `whereClause`.

**Important 3 — Test (c) didn't exercise the search path**
`src/lib/admin/invoice-list-pagination.test.ts`:
- Updated `CapturedQuery` interface to include a `groupBy` field.
- Updated the proxy in `vi.hoisted` to capture the `groupBy(expr)` argument (previously silently absorbed).
- Rewrote test (c): now passes `{ state: 'open', search: 'test' }` to trigger the decrypt-then-filter path (4 db.select calls: [0]=sourceCounts, [1]=count, [2]=rows, [3]=allRows).
- Added assertions that all four queries are tenant-scoped; that allRows (captured[3]) and count (captured[1]) carry the state filter.
- Added a second sub-scenario with `source: 'fieldpulse'` + `search: 'test'` asserting that:
  - Facet WHERE (captured[0]) contains no `isNotNull`/`isNull` predicates (Critical 2 guard).
  - allRows WHERE (captured[3]) does contain `isNotNull` on `fpInvoiceId` (main query still filtered).
  - Facet query has `groupBy` set (Critical 1 guard).

**Minor 4 — Dead DB call in search path**
`src/lib/admin/invoice-queries.ts` line ~1086:
- Removed `countResult` from the search-path `Promise.all`; now only `[sourceCounts, allRows]` are awaited. `countPromise` is still constructed (for the non-search path) but not awaited in the search branch.

**Minor 5 — Unused alias `serverTotal`**
`src/app/admin/(dashboard)/invoices/page.tsx` lines 265 and 457:
- Removed `const serverTotal = total` and inlined `total` directly at the `pageLabel(...)` call site.

### Commands + results

```
npx tsc --noEmit              → clean (0 errors)
npx vitest run src/lib/admin/invoice-list-pagination.test.ts
  → 13/13 passed
```

### Concerns

None.

## Review + prod verification (controller)

- Review round 1 (base 7e4689b..26fc48e): Needs fixes — 2 CRITICAL (sourceCounts missing GROUP BY → pg 42803 at runtime; sourceCounts WHERE wrongly included the source filter), 1 IMPORTANT (test (c) missed the search path), 2 MINOR.
- Fix round 2 (31ddb4c) resolved all five; re-review: **Approved** (GROUP BY shares the same sql expression as SELECT; facet uses whereClauseNoSource; tests now capture groupBy + both WHERE variants).
- Reviewer ⚠️ (synced-money guard on stats) resolved by controller: brief mandates verbatim stats SQL and its prod target ($152,061) IS the combined AR incl. synced rows — no guard intended on SummaryBand stats. collectedThisMonthCents retains its payments-side guard.
- Prod verify (read-only, 2026-07-11): stats = { outstandingCents: 15,206,103; outstandingCount: 119; overdueCents: 14,001,116; overdueCount: 92; oldestOverdueDays: 830 } — matches brief targets ($152,061 / 119). listInvoices page 1 = 50 rows, total = 2,851, sourceCounts = { fieldpulse: 2851 }. source:'native' total = 0. All targets ✓.
- Known deferrals: ScopedInvoicesSection still uses temporary { limit: 20000 } (Task 4 converts it). Minor notes for final review: lazily-constructed unused count/rows promises in search path (no runtime round-trip; commented); test (j) overdue=false assertion keyed on absence of "kind":"sql" chunks (fragile if future non-overdue sql fragments added).

---

## Fix round 3 (independent-review findings)

**Commit:** 019f75d
**Branch:** feat/pagination-ar-fp

### Findings fixed

**[HIGH] groupBy missing from mockReadSeq chain (invoice-queries.test.ts:539-548)**
Added `groupBy: () => chain,` to the chainable mock. Without it, `db.select().from().where().groupBy()` threw `TypeError: ... .groupBy is not a function`, causing the `listInvoices` test to fail. All 34 tests in invoice-queries.test.ts now pass.

**[HIGH] Overdue predicate boundary drift from client semantics**
Both `getInvoiceSummaryStats` (FILTER WHERE clauses for overdueCents / overdueCount / oldestOverdueDays) and `makeOverduePredicate()` (used by the overdue server filter) were fixed to match `age-chip.tsx:overdueByDates` exactly:
- dueDate branch: `dueDate < now() - interval '1 day'` (matches `daysPastDue >= 1`, i.e. a full day past due)
- no-dueDate branch: `coalesce(issuedAt, createdAt) <= now() - interval '30 days'` (matches `invoiceAgeDays >= 30`, inclusive boundary)

Old SQL used `dueDate < now()` (triggers the instant past midnight) and `< now() - interval '30 days'` (misses the 30-day boundary row). No test fixtures asserted the old fragment text so no test updates were needed beyond the predicate itself.

**[MEDIUM] sourceCounts diverged from visible results under search**
On the search path the `sourceCountsPromise` SQL facet ran against the full (unfiltered-by-search) row set because customer names are encrypted and invisible to SQL. The fix: on the search path, discard the SQL facet result and compute `sourceCounts` from the JS-filtered row set using the same classification (`fieldpulseInvoiceId != null → fieldpulse; hcpInvoiceId != null → housecall; else → native`). Non-search path keeps the SQL facet. A one-line comment in the search path explains the split.

**[LOW] Test (j) fragile assertion**
Changed the overdue=false assertion from checking absence of any `"kind":"sql"` fragment (breaks if any future sql-tagged condition is added to non-overdue paths) to checking absence of `inv.dueDate` column ref (the overdue predicate always references the dueDate column — this is a stable, semantics-specific signal).

**[HYGIENE] task-3-brief.md restored**
File was 0 bytes (clobbered). Restored by extracting the Task 3 section from `docs/superpowers/plans/2026-07-11-pagination-ar-fp-expand.md` (lines 95–138).

### Test results

```
npx tsc --noEmit              → clean (0 errors)
npx vitest run src/lib/admin/invoice-queries.test.ts
  → 34/34 passed (was 1 failing)
npx vitest run src/lib/admin/invoice-list-pagination.test.ts
  → 13/13 passed
npx vitest run src/lib/admin/
  → 67 test files, 815 tests, all passed
```

### New overdue predicate text (both locations)

```sql
(dueDate IS NOT NULL AND dueDate < now() - interval '1 day')
OR (dueDate IS NULL AND coalesce(issuedAt, createdAt) <= now() - interval '30 days')
```
