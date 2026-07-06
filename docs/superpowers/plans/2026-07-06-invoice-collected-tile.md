# Invoice Collections — "Collected this month" tile (Phase 4)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Complete the collections summary band with the spec'd third tile — "Collected this month" (money-in) — backed by a lean payments aggregate.

**Architecture:** A small server query sums this month's succeeded payments for the org; the invoices GET route returns it alongside the list; the hook exposes it; `SummaryBand` renders a third tile and goes to a 3-up grid. The summary's existing two tiles stay client-computed from the list payload; only the new number needs the server (it's not derivable from the invoice list).

**Tech Stack:** Next.js 16 App Router, Drizzle ORM over Neon Postgres HTTP, React client components, Vitest (node env).

## Global Constraints

- **Money is cents;** `formatCentsExact` for display.
- **Neon HTTP:** no transactions; every query `withTenant`-scoped.
- **"Collected this month" = SUM of `payments.amountCents` WHERE `status = 'succeeded'` AND `createdAt` in [start-of-current-month, now]**, org-scoped. neon-http returns `sum()` as a STRING → coerce with `Number(...)`. Month boundary computed in UTC (acceptable approximation for a glance tile; document it).
- No new dependencies. node-env tests (pure/query helpers tested; components not render-tested).
- Pure helpers a client imports must live in a db/server-only-free module (see `invoice-collectible.ts`); a CLIENT must never import a module that pulls `server-only`. **Run `npx next build` in the final gate** (tsc does not catch server-only leaks).
- Commit style: conventional commits, NO Co-Authored-By trailer.

---

## File Structure

- `src/lib/admin/invoice-queries.ts` — NEW `collectedThisMonthCents(orgId, now?)` query.
- `src/app/api/admin/invoices/route.ts` — GET also returns `collectedThisMonthCents`.
- `src/hooks/use-invoices.ts` — expose `collectedThisMonthCents`.
- `src/components/admin/invoices/summary-band.tsx` — third tile + 3-up grid.
- `src/app/admin/(dashboard)/invoices/page.tsx` — pass the value to `SummaryBand`.

---

### Task 1: `collectedThisMonthCents` query + route + hook

**Files:**
- Modify: `src/lib/admin/invoice-queries.ts` (add the query)
- Modify: `src/app/api/admin/invoices/route.ts` (GET response ~L45)
- Modify: `src/hooks/use-invoices.ts`
- Test: `src/lib/admin/collected-this-month.test.ts` (create)

**Interfaces:**
- Produces: `collectedThisMonthCents(organizationId: string, now?: Date): Promise<number>` — sum of succeeded payments this month. The invoices GET returns `{ invoices, collectedThisMonthCents }`. `use-invoices` returns `collectedThisMonthCents: number`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/admin/collected-this-month.test.ts` copying the chainable-proxy DB mock scaffolding from `src/lib/admin/invoice-queries-list.test.ts` (`vi.hoisted`/`chain`/`vi.mock('@/lib/db')`/`vi.mock('@/lib/db/tenant')`). Mock `drizzle-orm` with `eq`, `and`, `gte`, `lt`, `sum` (return tagged objects — for `sum` return `{ kind: 'sum', col }`). Mock `@/lib/db/schema` `payments` with `amountCents`, `status`, `createdAt`, `organizationId`.
```ts
import { collectedThisMonthCents } from './invoice-queries';

it('sums succeeded payments for the current month (coerces neon string)', async () => {
  selectQueue.push([{ value: '124500' }]); // neon returns sum() as a string
  const total = await collectedThisMonthCents('org-1', new Date('2026-07-06T12:00:00Z'));
  expect(total).toBe(124500);
});
it('returns 0 when there are no payments', async () => {
  selectQueue.push([{ value: null }]);
  expect(await collectedThisMonthCents('org-1', new Date('2026-07-06T12:00:00Z'))).toBe(0);
});
it('scopes to the org, succeeded status, and the month window', async () => {
  selectQueue.push([{ value: '0' }]);
  await collectedThisMonthCents('org-1', new Date('2026-07-06T12:00:00Z'));
  const where = JSON.stringify(captured[0].where);
  expect(where).toContain('succeeded');
  expect(where).toContain('org-1');
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/admin/collected-this-month.test.ts` → FAIL (function missing).

- [ ] **Step 3: Implement the query**

In `src/lib/admin/invoice-queries.ts` add (ensure `sum`, `gte`, `lt` are imported from `drizzle-orm`; `payments`, `withTenant` are already imported):
```ts
/**
 * Total succeeded payments received this calendar month (UTC month boundary — an
 * acceptable approximation for a glance tile). neon-http returns sum() as a
 * string, hence the Number() coercion.
 */
export async function collectedThisMonthCents(
  organizationId: string,
  now: Date = new Date(),
): Promise<number> {
  const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
  const [row] = await db
    .select({ value: sum(payments.amountCents) })
    .from(payments)
    .where(
      withTenant(
        payments,
        organizationId,
        eq(payments.status, "succeeded"),
        gte(payments.createdAt, monthStart),
        lt(payments.createdAt, now),
      ),
    );
  const parsed = Number(row?.value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/lib/admin/collected-this-month.test.ts` → PASS.

- [ ] **Step 5: Wire the route + hook**

- `src/app/api/admin/invoices/route.ts` GET (~L45): after `const invoices = await listInvoices(session.organizationId);`, add `const collectedThisMonthCents = await collectedThisMonthCents(session.organizationId);` — WAIT, that shadows the import; name the local differently:
  ```ts
  const invoices = await listInvoices(session.organizationId);
  const collected = await collectedThisMonthCents(session.organizationId);
  return successResponse({ invoices, collectedThisMonthCents: collected });
  ```
  Add `collectedThisMonthCents` to the import from `@/lib/admin/invoice-queries`.
- `src/hooks/use-invoices.ts`: add `collectedThisMonthCents: number` to `UseInvoicesResult`; in the fetch, read `body.data.collectedThisMonthCents` into state (default `0`); the body type becomes `data: { invoices: InvoiceListItem[]; collectedThisMonthCents: number }`. Return it.

- [ ] **Step 6: Run tests, tsc, lint, commit**

Run `npx vitest run src/lib/admin/collected-this-month.test.ts` (PASS), `npx tsc --noEmit` (0), `npx eslint src/lib/admin/invoice-queries.ts "src/app/api/admin/invoices/route.ts" src/hooks/use-invoices.ts` (0 errors). Then:
```bash
git add src/lib/admin/invoice-queries.ts src/lib/admin/collected-this-month.test.ts "src/app/api/admin/invoices/route.ts" src/hooks/use-invoices.ts
git commit -m "feat(invoices): collected-this-month aggregate on the invoices API"
```

---

### Task 2: Third summary tile + 3-up band

**Files:**
- Modify: `src/components/admin/invoices/summary-band.tsx`
- Modify: `src/app/admin/(dashboard)/invoices/page.tsx` (the `<SummaryBand>` usage)

**Interfaces:**
- Consumes: `collectedThisMonthCents: number` from `useInvoices` (Task 1).
- Produces: `<SummaryBand invoices collectedThisMonthCents />` renders three tiles.

- [ ] **Step 1: Add the prop + third tile**

In `summary-band.tsx`, change the signature to `{ invoices, collectedThisMonthCents }: { invoices: readonly InvoiceListItem[]; collectedThisMonthCents: number }`. Change the grid wrapper from `sm:grid-cols-2` to `sm:grid-cols-2 lg:grid-cols-3`. After the Overdue tile, add a third tile:
```tsx
<div className="rounded-xl border bg-card p-5">
  <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Collected this month</p>
  <p className="mt-2 font-heading text-2xl font-bold tabular-nums text-emerald-700">{formatCentsExact(collectedThisMonthCents)}</p>
  <p className="mt-1 text-xs text-muted-foreground">Payments received since the 1st</p>
</div>
```

- [ ] **Step 2: Pass the prop from the page**

In `src/app/admin/(dashboard)/invoices/page.tsx`, destructure `collectedThisMonthCents` from `useInvoices()` and pass it: `<SummaryBand invoices={invoices} collectedThisMonthCents={collectedThisMonthCents} />`.

- [ ] **Step 3: tsc, lint, commit**

Run `npx tsc --noEmit` (0), `npx eslint src/components/admin/invoices/summary-band.tsx "src/app/admin/(dashboard)/invoices/page.tsx"` (0 errors). Then:
```bash
git add src/components/admin/invoices/summary-band.tsx "src/app/admin/(dashboard)/invoices/page.tsx"
git commit -m "feat(invoices): collections summary shows collected-this-month tile"
```

---

## Self-Review notes (addressed)

- **Coverage:** the spec'd 3-tile summary band (Outstanding / Overdue / Collected-this-month) is completed; the new number is a lean server aggregate (Task 1) surfaced through route → hook → tile (Task 2).
- **Type consistency:** `collectedThisMonthCents` is a `number` from the query through the hook to the component prop.
- **Shadowing pitfall flagged:** the route must alias the local (`collected`) so it doesn't shadow the imported `collectedThisMonthCents`.
- **Final gate:** run `npx next build` after both tasks (client/server boundary touched via the hook + route) to confirm no server-only leak.

## Out of scope (still deferred)
- `⋯` row overflow menu (Copy pay link / Record payment / Void) — uses the unused `dropdown-menu` primitive; own increment.
- Reminder-history LOG table (migration); email-channel reminders; bulk chase; per-org tagline.
