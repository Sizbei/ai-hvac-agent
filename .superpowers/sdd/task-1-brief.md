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
