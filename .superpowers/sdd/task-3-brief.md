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
