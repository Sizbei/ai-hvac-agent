# Pagination Everywhere + AR "Owing" Fix + FieldPulse Click-to-Expand Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Server-paginate every large admin list, make the AR/"owing" numbers truthful on all three money surfaces, and redesign how FieldPulse data displays (consistent provenance pills, a formatted/grouped details panel, click-to-expand rows).

**Architecture:** Three independently-shippable phases. Phase 1 fixes the AR numbers (smallest, highest urgency). Phase 2 converts the remaining fetch-all list queries to the proven `getCustomers` page-then-join pattern (`src/lib/admin/crm-queries.ts:67`) — page/limit/search server-side, `{rows, total}` payloads, parallel count. Phase 3 ships a shared `SyncPill`, a v2 `FieldpulseDetails` (grouped + formatted + collapsed preview), merges the customer profile's duplicate FP cards, and adds inline click-to-expand rows on the invoices/estimates/pricebook lists.

**Tech Stack:** Next.js 16 App Router, Drizzle ORM over neon-http (NO transactions), Vitest (node env, NO RTL/jsdom — pure-helper + mock-query-shape tests only), Tailwind + existing admin primitives.

## Global Constraints

- Money is ALWAYS integer cents; format with the existing `formatCentsExact` (`src/lib/admin/money-format.ts`). Never float math on money.
- Every query MUST be tenant-scoped via `withTenant(table, organizationId, ...conditions)`.
- Synced-money guard: native metrics exclude synced rows via `fieldpulse_invoice_id IS NULL AND hcp_invoice_id IS NULL` (and `fieldpulse_payment_id IS NULL` for payments). Display surfaces MAY show synced AR but must label it.
- Pagination pattern (copy `getCustomers`, `src/lib/admin/crm-queries.ts:67`): page size 50, `Math.max(1, page)`, select page ids/rows FIRST with LIMIT/OFFSET in a subquery BELOW any join, run page + COUNT + facet queries in `Promise.all`, return `{ rows..., total }`.
- Encrypted columns (customer names on invoices) are NOT SQL-searchable — a search request decrypts + filters server-side, then paginates matches (the `getCustomers` search path).
- API responses use `successResponse(...)` / `errorResponse(...)` from `@/lib/api-response`; routes are session-gated (`getAdminSession`) + rate-limited (`slidingWindow`, `RATE_LIMITS.adminRead`).
- FP provenance color is violet: `bg-violet-50 text-violet-700 border-violet-*` (dark: `violet-950/40`, `violet-300`).
- Prod ground truth (2026-07-11) for verification: open invoices n=119; naive `sum(total)` = **$196,980**; TRUE owing `sum(total−paid)` = **$152,061**; native AR = **$0**; synced AR = **$152,061**. Row counts: invoices 2,851 / pricebook 17,538 / customers 2,246 / estimates 41 / requests 58.
- Verification against prod DB: `npx vercel env pull /tmp/vp.env --environment production`, export `PROD_URL` from its `DATABASE_URL`, run scripts with `PROD_URL=... NODE_OPTIONS='--conditions=react-server' npx tsx <script>` (queries import `server-only`). NEVER commit `/tmp/vp.env` or scripts containing secrets; delete scratch scripts after use.
- No new deps. No RTL/jsdom tests. Lint: warnings of class `set-state-in-effect` in hooks are the accepted codebase pattern; introduce no NEW lint *errors*.
- Each task ends with typecheck (`npx tsc --noEmit`), relevant vitest run, and a commit.

---

## Phase 1 — AR / "owing" correctness

### Task 1: Operations headline shows combined AR; Reports AR gets the balance guard

**Problem (verified on prod):** `/admin/operations` headline "Total outstanding" prints **$0** because `totalOutstandingCents` sums only NATIVE aging buckets (`operations-metrics-queries.ts:370-374`) and 100% of this org's AR is FieldPulse-synced ($152,061 relegated to a muted footnote). `/admin/reports` outstanding-AR query (`reporting-queries.ts:138-151`) lacks the `amount_paid_cents < total_cents` guard the operations query has (`operations-metrics-queries.ts:249`), so open-but-fully/over-paid rows can subtract from the total.

**Files:**
- Modify: `src/lib/admin/operations-metrics-queries.ts` (aging section ~lines 236–271 and the return ~370–374)
- Modify: `src/app/admin/(dashboard)/operations/page.tsx` (headline ~lines 277–312)
- Modify: `src/lib/admin/reporting-queries.ts:138-151`
- Modify: whatever type declares `OperationsMetrics.totalOutstandingCents` (same file or `src/lib/admin/types.ts` — follow the import)
- Test: extend the existing operations/reporting query tests if present (`grep -rl "operations-metrics\|getSalesReport" src --include="*.test.ts"`); otherwise add a mock-shape test following `src/lib/admin/crm-list-helpers.test.ts`'s harness style.

**Interfaces (UPDATED for main@6da379b — synced-AR aging buckets already landed):**
- The synced totals now live at `metrics.syncedArAging.totalOutstandingCents` (`src/lib/admin/operations-metrics-types.ts:39`, `operations-metrics-queries.ts:392`). Produces: `OperationsMetrics` gains `readonly totalOutstandingAllCents: number` = native `aging.totalOutstandingCents` + `syncedArAging.totalOutstandingCents`. The headline is at `operations/page.tsx:298` fed by `agingTotal` at `:152` (native-only — the bug).

- [ ] **Step 1: Reports guard.** In `reporting-queries.ts:138-151`, add the same balance guard the operations query uses. The WHERE currently ends at `eq(invoices.state, "open")` (however expressed); add `sql\`${invoices.amountPaidCents} < ${invoices.totalCents}\`` (or `lt(invoices.amountPaidCents, invoices.totalCents)`) as an additional condition inside the same `withTenant(...)`/`and(...)`. Both CASE branches (native/synced) are covered by the shared WHERE.

- [ ] **Step 2: Combined outstanding.** In `operations-metrics-queries.ts`, at the return-assembly (~370-374) where `totalOutstandingCents = b0+b30+b60`, add:

```ts
const totalOutstandingAllCents =
  (b0 + b30 + b60) + syncedArTotalCents; // native buckets + synced total (queries.ts:382,392)
```

Add `totalOutstandingAllCents` to the returned object and to the `OperationsMetrics` type with the doc comment: `/** Native + synced AR combined — the headline number. Native-only lives in totalOutstandingCents. */`

- [ ] **Step 3: Headline swap.** In `operations/page.tsx` (~277-312): the "Total outstanding" stat renders `totalOutstandingAllCents`. Directly under it, a one-line split hint: `Native {formatCentsExact(m.totalOutstandingCents)} · Synced (FieldPulse/HCP) {formatCentsExact(m.syncedAr.totalCents)} — collected in the external system`. Keep the aging buckets native-only and keep the existing synced-AR line as is.

- [ ] **Step 4: Test.** If a mock-shape test harness exists for these queries, assert (a) the reports AR where-clause now contains the balance-guard predicate, and (b) `totalOutstandingAllCents === totalOutstandingCents + syncedAr.totalCents`. If no harness exists, write the (b) assertion as a pure function test by extracting the addition into an exported helper `combineOutstanding(nativeCents: number, syncedCents: number): number` and testing it — do NOT build a new DB-mock harness just for this.

- [ ] **Step 5: Prod verification.** Scratch script (see Global Constraints for env setup) calling the real `getOperationsMetrics(org)` and `getSalesReport(org, ...)`:
Expected: `totalOutstandingAllCents === 15_206_100 ± payments since` (~$152,061), `totalOutstandingCents === 0`, reports `outstandingArCents` equals the same combined figure.

- [ ] **Step 6: Typecheck + commit.**
```bash
npx tsc --noEmit && npx vitest run <touched test files>
git add -A && git commit -m "fix(money): operations headline = combined AR (native+synced split); reports AR balance guard"
```

---

## Phase 2 — Server pagination everywhere

Every task in this phase copies the `getCustomers` pattern (`src/lib/admin/crm-queries.ts:67`): options `{ page?, limit?, search?, ...filters }`, LIMIT/OFFSET in SQL, page + `count()` + facets in `Promise.all`, return `{ <rows>, total, ... }`. Routes parse `page` with `Number.isFinite(x) && x > 0 ? Math.floor(x) : 1`. Hooks take a params object, key their SWR cache on the full param tuple, debounce search 300ms at the PAGE level (see `customers/page.tsx`), reset page to 1 on filter change, and drive the existing pager bar with the server `total` via `pageLabel(safePage, total, PER_PAGE)`.

### Task 2: Pricebook pagination (17,538 rows — critical)

**Files:**
- Modify: `src/lib/admin/pricebook-queries.ts:136` (`listPricebookItemsForAdmin`)
- Modify: `src/app/api/admin/pricebook/route.ts` (GET)
- Modify: `src/hooks/use-pricebook.ts`
- Modify: `src/app/admin/(dashboard)/pricebook/page.tsx` + `src/components/admin/pricebook/pricebook-table.tsx` (pager bar; keep column layout)
- Test: add/extend a mock-shape test asserting the page query carries LIMIT (copy the harness in `src/lib/admin/crm-list-helpers.test.ts`).

**Interfaces:**
- Produces: `listPricebookItemsForAdmin(organizationId, { page?, limit?, search?, type? }): Promise<{ items: PricebookItem[], total: number }>`. Route `GET /api/admin/pricebook?page&search&type` returns `{ items, total }`.

Key details:
- Pricebook columns are PLAINTEXT → search is server-side SQL: `ilike(pricebookItems.name, %term%) OR ilike(pricebookItems.sku, %term%) OR ilike(pricebookItems.description, %term%)` (escape `\%_` in user input — copy the escaping in `getRequests`, `src/lib/admin/queries.ts:130`).
- `type` filter = equality on the item-type column when provided.
- ORDER BY name asc (match current UI order). Page + count in `Promise.all`. No join → plain `.limit/.offset` is fine (no subquery needed).
- Do NOT touch `listPricebookItems` (:59) — that is the AI-quoting path.
- Page component: replace the client-side filter/slice with server params; search box debounced 300ms; pager bar identical to customers'.

- [ ] Steps: failing mock-shape test (hasLimit true) → implement query → route params → hook `{ items, total }` + cache key on params → page wiring → `npx tsc --noEmit` → vitest → commit `perf(pricebook): server-side pagination + search (17.5k rows)`.
- [ ] **Prod verify:** scratch script: page 1 returns 50 + `total === 17538`; `search: 'compressor'` returns matching page with plausible total; timing < 300ms from laptop.

### Task 3: Invoices pagination + server-computed summary stats

**The trap:** `SummaryBand` (`src/components/admin/invoices/summary-band.tsx:13-16`) computes Outstanding/Overdue by reducing over the FULL client list. Paginating without moving these stats server-side silently breaks the money numbers. This task moves them into SQL first, then paginates.

**Files:**
- Modify: `src/lib/admin/invoice-queries.ts` (`listInvoices` :827; add `getInvoiceSummaryStats`)
- Modify: `src/app/api/admin/invoices/route.ts` (GET returns `{ invoices, total, stats, collectedThisMonthCents }`)
- Modify: `src/hooks/use-invoices.ts`
- Modify: `src/app/admin/(dashboard)/invoices/page.tsx`, `src/components/admin/invoices/summary-band.tsx`
- Test: mock-shape test for the stats SQL + pagination LIMIT.

**Interfaces:**
- Produces: `getInvoiceSummaryStats(organizationId): Promise<{ outstandingCents: number; outstandingCount: number; overdueCents: number; overdueCount: number }>`; `listInvoices(organizationId, { page?, limit?, search?, state?, source?, customerId?, serviceRequestId? }): Promise<{ invoices: InvoiceListRow[], total: number, sourceCounts: Record<string, number> }>`.

Key details:
- **Stats SQL** replicates the client semantics exactly (`isCollectible` = `state='open' AND total>paid`; `overdueByDates` in `src/components/admin/invoices/age-chip.tsx:31-36` = duePast ≥ 1 day, else age ≥ 30 days on `coalesce(issued_at, created_at)`):

```ts
const [stats] = await db
  .select({
    outstandingCents: sql<number>`coalesce(sum(${invoices.totalCents} - ${invoices.amountPaidCents}), 0)::bigint`,
    outstandingCount: sql<number>`count(*)::int`,
    overdueCents: sql<number>`coalesce(sum(${invoices.totalCents} - ${invoices.amountPaidCents}) filter (where
      (${invoices.dueDate} is not null and ${invoices.dueDate} < now())
      or (${invoices.dueDate} is null and coalesce(${invoices.issuedAt}, ${invoices.createdAt}) < now() - interval '30 days')
    ), 0)::bigint`,
    overdueCount: sql<number>`count(*) filter (where
      (${invoices.dueDate} is not null and ${invoices.dueDate} < now())
      or (${invoices.dueDate} is null and coalesce(${invoices.issuedAt}, ${invoices.createdAt}) < now() - interval '30 days')
    )::int`,
  })
  .from(invoices)
  .where(withTenant(invoices, organizationId,
    eq(invoices.state, "open"),
    sql`${invoices.totalCents} > ${invoices.amountPaidCents}`,
  ));
```
(bigint comes back as string from neon — wrap with `Number(...)` in the mapper.)
- **Pagination:** filters `state` (enum value), `source` (`native` → both synced ids NULL; `fieldpulse`/`hcp` → respective id NOT NULL), `customerId`, `serviceRequestId` (for the scoped section, Task 4). Search: reference/number prefix server-side; customer-name search uses the decrypt-then-filter path over the FILTERED set (like `getCustomers` search). ORDER BY `coalesce(issued_at, created_at) DESC`. `sourceCounts` facet for the source tabs (`count(*) group by` the source classification) runs in the same `Promise.all`.
- SummaryBand becomes a dumb renderer of the server `stats` (+ existing `collectedThisMonthCents`).
- **Verify before wiring:** confirm the existing filter/sort/search controls on `invoices/page.tsx` and map EACH to a server param — do not drop a control. `paginate()` usage for invoices dies; keep `pageLabel`.

- [ ] Steps: failing stats-shape test → implement `getInvoiceSummaryStats` → mock-shape pagination test → convert `listInvoices` → route → hook (params-keyed cache) → page + SummaryBand wiring → typecheck → vitest → commit `perf(invoices): server pagination + SQL summary stats (2.8k rows)`.
- [ ] **Prod verify:** `getInvoiceSummaryStats` returns `outstandingCents = 15_206_100 ±` (~$152,061 — MUST match the Phase-1 combined AR) and `outstandingCount = 119`; page 1 of `listInvoices` = 50 rows, `total = 2851`; `source: 'native'` total = 0.

### Task 4: ScopedInvoicesSection uses server-side scoping

**Files:**
- Modify: `src/components/admin/invoices/scoped-invoices-section.tsx` (drop `useInvoices()`-full-list + client filter; fetch `/api/admin/invoices?customerId=...` or `?serviceRequestId=...` with its own small state — copy the fetch shape in `src/components/admin/customers/customer-bookings-section.tsx`)
- Test: none beyond typecheck (thin fetch wrapper; the query params are covered by Task 3's tests).

- [ ] Steps: rewrite fetch → typecheck → manual check that customer detail + request sheet still show their invoices → commit `perf(invoices): scoped sections fetch server-filtered pages`.

### Task 5: Inventory pagination (items + purchase orders)

**Files:**
- Modify: `src/lib/admin/inventory-queries.ts:42` (`listInventory`), `:349` (`listPurchaseOrders`)
- Modify: the inventory API route(s) under `src/app/api/admin/inventory/`
- Modify: `src/hooks/use-inventory.ts`, `src/app/admin/(dashboard)/inventory/page.tsx`
- Test: mock-shape LIMIT test.

Same pattern; `listInventory` joins pricebook_items → put LIMIT in a subquery below the join (the `getCustomers` page-then-join shape) if the join can fan out; otherwise plain limit/offset. POs: plain limit/offset, page size 50.

- [ ] Steps: tests → queries → route → hook → page → typecheck → vitest → commit `perf(inventory): server-side pagination`.

### Task 6: Estimates + Reviews pagination (growth insurance)

**Files:**
- Modify: `src/lib/admin/estimate-queries.ts:229` (`listEstimates`), `src/lib/reviews/review-queries.ts:256` (`listReviews`), their routes, `src/hooks/use-estimates.ts`, `src/hooks/use-reviews.ts`, pages.

Small tables today (41 / ~58) — one mechanical task, plain limit/offset + total, page size 50, keep all current ordering/filters. NOTE: `ScopedEstimatesSection` client-filters `useEstimates()` — give `listEstimates` the same optional `customerId`/`serviceRequestId` params and convert the section exactly like Task 4.

- [ ] Steps: tests → queries → routes → hooks → pages + scoped section → typecheck → vitest → commit `perf(estimates,reviews): server-side pagination`.

---

## Phase 3 — FieldPulse display redesign + click-to-expand

### Task 7: Shared `SyncPill` + pricebook provenance

**Problem:** 9 surfaces hand-roll the violet pill in 2 sizes/labels; the pricebook table (17.5k rows) shows NO provenance at all. A `SyncPill` already exists in `src/components/admin/global-search.tsx:36-41` — extract it.

**Files:**
- Create: `src/components/admin/sync-pill.tsx`
- Modify (replace hand-rolled pills): `customers/page.tsx:63`, `customer-people-cards.tsx:52`, `estimates/page.tsx:81-88`, `estimates/[id]/page.tsx:187-195`, `invoice-row.tsx:77-80`, `invoice-detail-client.tsx:342-346`, `scoped-invoices-section.tsx:59-64`, `request-detail-sheet.tsx:594-597`, `calendar-job-card.tsx:57`, `month-grid.tsx:58`, `agenda-view.tsx:159`, `global-search.tsx` (re-export/consume)
- Modify: `src/components/admin/pricebook/pricebook-table.tsx` — add `<SyncPill source="fieldpulse" size="sm" />` on rows with `fieldpulseItemId` (already in `ADMIN_ITEM_PROJECTION`).

```tsx
// src/components/admin/sync-pill.tsx
'use client';

const LABELS = { fieldpulse: { sm: 'FP', md: 'FieldPulse' }, housecall: { sm: 'HCP', md: 'Housecall Pro' } } as const;

/** The one provenance pill. sm = dense grids (calendar chips, cards); md = list rows and headers. */
export function SyncPill({
  source,
  size = 'md',
}: {
  readonly source: 'fieldpulse' | 'housecall' | null | undefined;
  readonly size?: 'sm' | 'md';
}) {
  if (!source) return null;
  return (
    <span
      className={`shrink-0 rounded border bg-violet-50 font-semibold text-violet-700 dark:border-violet-800 dark:bg-violet-950/40 dark:text-violet-300 ${
        size === 'sm' ? 'px-1 py-px text-[9px]' : 'px-1.5 py-px text-[10px]'
      }`}
    >
      {LABELS[source][size]}
    </span>
  );
}
```
(If a call site uses `'hcp'`/`'housecall'` variants, normalize at the call site — check each site's actual value before replacing.)

- [ ] Steps: create component → replace sites one file at a time (typecheck between) → pricebook column → commit `refactor(ui): unified SyncPill + pricebook provenance`.

### Task 8: `FieldpulseDetails` v2 — grouped, formatted, collapsed preview

**Problems (from audit):** alphabetical flat `<dl>`; raw values (money as `"35424.670000"`, dates unformatted); nested objects SILENTLY dropped (`fieldpulse-details-format.ts:82-83`); collapsed header says just "Details (N)" with zero preview.

**Files:**
- Modify: `src/lib/admin/fieldpulse-details-format.ts` + its existing pure tests
- Modify: `src/components/admin/fieldpulse-details.tsx`

**Interfaces:**
- Produces: `buildFieldpulseSections(data: Record<string, unknown>): { sections: readonly { title: 'Money'|'Dates'|'Flags'|'IDs'|'Other'; entries: readonly {label: string; value: string}[] }[]; preview: readonly string[]; hiddenCount: number }` — pure, fully unit-tested. The old `buildFieldpulseEntries` stays exported (other callers may exist — grep first) but the panel switches to sections.

Formatting rules (implement + test each):
- Money keys (`/(price|total|subtotal|tax|cost|discount|commission|surcharge|amount)/` with numeric-string value) → `$1,234.56` via `Number(v)` (FP sends DOLLAR strings — do NOT treat as cents; `"35424.670000"` → `$35,424.67`).
- Percent keys (`/(rate|percent)$/`) → `9.75%`.
- Date keys (`/(_at|_date)$/` with parseable value) → `Jul 7, 2026` (`toLocaleDateString('en-US', {month:'short',day:'numeric',year:'numeric'})`).
- Booleans → `Yes`/`No`. Keys `/(^|_)id(s)?$/`-ish and `*_id` → IDs section, rendered `font-mono`.
- Nested plain objects: flatten ONE level (`address.city` → label "Address · City"); deeper nesting counts into `hiddenCount`; arrays of scalars join `', '`.
- `preview` = first 3 entries from Money+Dates sections (most informative), as `"label: value"` strings.
- Panel component: collapsed header shows `FieldPulse details · N fields` + the preview as muted inline chips; expanded shows the grouped sections with a `min-w-40` label column; if `hiddenCount > 0`, footer line `+N nested fields not shown`.

- [ ] Steps: write failing pure tests for each formatting rule (real FP fixture keys from the audit: `service_price: "35354.67"`, `tax_rate: "9.75"`, `invoiced_date: "2026-05-29 12:00:00"`, `qb_originated: true`, `status_id: 1878564`) → run (fail) → implement `buildFieldpulseSections` → pass → rewrite panel body → typecheck → commit `feat(fp): FieldpulseDetails v2 — grouped sections, formatted values, collapsed preview`.

### Task 9: Merge the customer profile's two FP cards

**Problem:** `customers/[id]/page.tsx:410-432` renders an always-open raw "FieldPulse — Details" custom-fields card AND the collapsed spillover panel — inconsistent duplication.

**Files:**
- Modify: `src/components/admin/fieldpulse-details.tsx` — add optional prop `customFields?: readonly {name: string; value: string}[] | null`, rendered as the FIRST section ("Custom fields") inside the same collapsible panel.
- Modify: `src/app/admin/(dashboard)/customers/[id]/page.tsx` — delete the standalone card (410-429); pass `customFields={customer.fieldpulseCustomFields}` to the single `<FieldpulseDetails>`.

- [ ] Steps: prop + section render → page cleanup → typecheck → commit `refactor(customers): single FieldPulse panel (custom fields merged into details)`.

### Task 10: Collapsible `fieldpulseMetrics` section in the request sheet

**Files:**
- Modify: `src/components/admin/request-detail-sheet.tsx:633-664` — wrap the metrics block in the same chevron-toggle collapse used by `FieldpulseDetails` (default OPEN — metrics are the high-value numbers), suppress the section entirely when all three metrics are empty (today it renders dead "No metrics reported" text).

- [ ] Steps: implement → typecheck → commit `refactor(requests): collapsible FP metrics, hide empty block`.

### Task 11: Click-to-expand rows on invoices, estimates, pricebook lists

**Behavior (same on all three):** each row gets a chevron; clicking the row toggles an inline expansion panel under it (only one open at a time per list; row click no longer navigates — the explicit "Open/View/Edit" action in the expansion does). The expansion shows the row's key facts + `<FieldpulseDetails>` when FP data exists + the primary action button.

- Invoices (`invoice-row.tsx` + `invoices/page.tsx`): expansion = issued/due dates, total/paid/balance (formatCentsExact), state badge, `FieldpulseDetails data={row.fieldpulseData}` — ADD `fieldpulseData` to the list projection in `listInvoices` (Task 3 defines the select — include it there) — and "Open invoice →" button. Keep the existing dropdown menu intact.
- Estimates (`estimates/page.tsx` list rows): expansion = title, FP status name, total, option count, `FieldpulseDetails`, "View estimate →". ADD `fieldpulseData` to `listEstimates` select (Task 6 touches it — include there).
- Pricebook (`pricebook-table.tsx`): expansion = description, cost/price/margin, qty, `FieldpulseDetails data={item.fieldpulseData}` (already in projection), "Edit item" button opening the existing dialog.
- Implementation: local `expandedId: string | null` state in each list; expansion row is a full-width `<tr>`/`<div>` with `bg-muted/30` and a slide-down feel (`animate-in` utilities already used in the codebase — grep `animate-in` for the exact classes; if absent, no animation).
- A11y: the row toggle is a `button` with `aria-expanded`.

- [ ] Steps: invoices expand → typecheck+commit → estimates expand → typecheck+commit → pricebook expand → typecheck+commit (`feat(ui): click-to-expand rows with FP details on <surface>`).

---

## Execution order & verification gates

1. Branch from `origin/main` in an isolated worktree.
2. Phase 1 (Task 1) → review → prod-verify numbers → squash-merge to main by ref → deploy → health check.
3. Phase 2 (Tasks 2–6, sequential) → review per task → after Task 3 re-verify $152,061 consistency across ALL THREE surfaces → squash-merge → deploy.
4. Phase 3 (Tasks 7–11, sequential) → review per task → squash-merge → deploy.
5. Final whole-branch review before each phase's merge (most capable model).
6. After all phases: update `docs/FIELDPULSE-DATA.md` display map + memory notes.

**Global regression gate per phase:** `npx tsc --noEmit` clean; `npx vitest run` — the ~7 DB/env-dependent suites that fail at import are the KNOWN baseline (see memory), everything else green; `npm run build` compiles.
