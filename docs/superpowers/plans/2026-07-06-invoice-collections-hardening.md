# Invoice Collections — Hardening & Polish Implementation Plan (Phase 3)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the collections correctness bug (void/refunded invoices are dunnable), close the automated-reminder blind spot, and land the high-value trust/polish items surfaced by the follow-up review.

**Architecture:** A single pure `isCollectible` predicate (and a shared 6h cooldown constant) becomes the one definition of "in collections" used by every surface (list, summary, row, detail) and the reminder backend — killing the drift where each place hand-rolled `state !== 'paid'`. The rest are small, isolated fixes (cron stamp, canonical ref, org phone, pay-link guard, list re-chase, a11y heading).

**Tech Stack:** Next.js 16 App Router, Drizzle ORM over Neon Postgres HTTP, React client components, Vitest (node env).

## Global Constraints

- **Collectible = `state === 'open' && (totalCents - amountPaidCents) > 0`.** Only `open` invoices are sent-and-owed; `paid`/`void`/`refunded`/`draft` are NOT collectible (a full refund lands in `refunded` with `total` still > 0 — it must NOT be dunned). Enum: `draft|open|paid|void|refunded` (`schema.ts` `invoiceStateEnum`).
- **Neon HTTP:** no transactions/row locks; every query `withTenant`-scoped.
- **Money is cents;** `formatCentsExact` for display.
- **Synced (FieldPulse/HCP) invoices** (`syncedSource !== null`) stay read-only in money flows; reminder + pay-link are unavailable for them.
- **No new dependencies.** Tests run in the **`node`** environment — NO `@testing-library/react`/jsdom; test PURE functions (`.test.ts`), never render components. `vi.mock('server-only', () => ({}))` when a test's import chain crosses the server-only boundary.
- **Commit style:** conventional commits, NO Co-Authored-By trailer.
- **TDD:** failing test first. DB-query tests use the chainable-proxy mock (see `src/lib/admin/invoice-queries-list.test.ts`).

---

## File Structure

- `src/lib/admin/invoice-collectible.ts` — NEW pure module: `isCollectible()` + `REMINDER_COOLDOWN_MS`. Single source of truth (client + server import it).
- `src/lib/communication/money-triggers.ts` — reminder guard uses `isCollectible`; cron sweep stamps `lastReminderSentAt`; reuse the shared cooldown constant.
- `src/app/api/admin/invoices/[id]/send-reminder/route.ts` — add `not_collectible` reason mapping.
- `src/app/admin/(dashboard)/invoices/page.tsx`, `summary-band.tsx`, `invoice-row.tsx` — consume `isCollectible`; row canonical ref + re-chase.
- `src/components/admin/invoices/invoice-detail-client.tsx` — reminder visibility via `isCollectible`; add `<h1>` landmark.
- `src/lib/admin/invoice-queries.ts` — `getInvoiceOrgIdentity` fills phone from `businessInfo`.
- `src/app/api/admin/invoices/[id]/pay-link/route.ts` — synced guard.

---

### Task 1: `isCollectible` predicate — fix the dunnable-void/refunded bug

**Files:**
- Create: `src/lib/admin/invoice-collectible.ts`
- Test: `src/lib/admin/invoice-collectible.test.ts`
- Modify: `src/app/admin/(dashboard)/invoices/page.tsx` (`isOverdue` ~L21, unpaid filter ~L157), `src/components/admin/invoices/summary-band.tsx:6`, `src/components/admin/invoices/invoice-row.tsx` (reminder branch ~L92), `src/lib/communication/money-triggers.ts` (`sendInvoiceReminder` guard ~L263), `src/app/api/admin/invoices/[id]/send-reminder/route.ts` (`REASON_STATUS`), `src/components/admin/invoices/invoice-detail-client.tsx` (send-reminder visibility)

**Interfaces:**
- Produces: `isCollectible(inv: { state: string; totalCents: number; amountPaidCents: number }): boolean` and `export const REMINDER_COOLDOWN_MS = 6 * 60 * 60 * 1000`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/admin/invoice-collectible.test.ts`:
```ts
import { isCollectible } from './invoice-collectible';

const mk = (state: string, total: number, paid: number) => ({ state, totalCents: total, amountPaidCents: paid });

it('open invoice with a balance is collectible', () => {
  expect(isCollectible(mk('open', 5000, 0))).toBe(true);
  expect(isCollectible(mk('open', 5000, 2000))).toBe(true);
});
it('paid / draft / void / refunded are NOT collectible even with a positive balance', () => {
  expect(isCollectible(mk('paid', 5000, 5000))).toBe(false);
  expect(isCollectible(mk('draft', 5000, 0))).toBe(false);   // not sent yet
  expect(isCollectible(mk('void', 5000, 0))).toBe(false);    // voided
  expect(isCollectible(mk('refunded', 5000, 0))).toBe(false); // full refund leaves total>0
});
it('open with zero/negative balance is NOT collectible', () => {
  expect(isCollectible(mk('open', 5000, 5000))).toBe(false);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/admin/invoice-collectible.test.ts` → FAIL (module missing).

- [ ] **Step 3: Implement the pure module**

```ts
/**
 * A collections predicate: an invoice belongs in the collections workspace and
 * may be dunned ONLY when it is OPEN (sent, awaiting payment) and still carries a
 * balance. `paid`/`void`/`refunded`/`draft` are excluded — notably a FULL REFUND
 * lands in `refunded` with totalCents still set, so `state !== 'paid'` (the old
 * check) wrongly treated it as owed. `draft` is pre-send, so it is not dunnable.
 */
export function isCollectible(inv: {
  readonly state: string;
  readonly totalCents: number;
  readonly amountPaidCents: number;
}): boolean {
  return inv.state === 'open' && inv.totalCents - inv.amountPaidCents > 0;
}

/** Don't re-send a manual reminder within this window (client + server share it). */
export const REMINDER_COOLDOWN_MS = 6 * 60 * 60 * 1000;
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/lib/admin/invoice-collectible.test.ts` → PASS.

- [ ] **Step 5: Apply it to every collections surface**

- `page.tsx` `isOverdue`: replace the body with
  ```ts
  return isCollectible(inv) && daysBetween(new Date(inv.createdAt), new Date()) >= 30;
  ```
  and the `'unpaid'` filter (`rows = rows.filter((i) => i.state !== 'paid' && ...)`) with `rows = rows.filter(isCollectible);`. Import `isCollectible` from `@/lib/admin/invoice-collectible`.
- `summary-band.tsx:6`: `const open = invoices.filter(isCollectible);` (import it).
- `invoice-row.tsx`: the reminder-controls branch currently renders when `state !== 'paid' && syncedSource === null && ...`. Gate the whole reminder area (Send reminder button AND the reminded chip) on `isCollectible(invoice) && invoice.syncedSource === null`. For a non-collectible row (void/refunded/paid), render NO reminder control (the `InvoiceStateBadge`/amount already convey state).
- `money-triggers.ts` `sendInvoiceReminder`: replace `if (inv.state === "paid" || balanceCents <= 0) return { ok: false, reason: "no_balance" };` with
  ```ts
  if (!isCollectible(inv)) return { ok: false, reason: "not_collectible" };
  ```
  Import `isCollectible` from `@/lib/admin/invoice-collectible`. Also change the function's return union to add the `"not_collectible"` reason string. (Keep the `!inv || !inv.customerId` not_found check above it.)
- `send-reminder/route.ts` `REASON_STATUS`: add `not_collectible: 400,`.
- `invoice-detail-client.tsx`: the Send-reminder toolbar button visibility currently uses `invoice.state !== 'paid'` (and `!syncedSource`). Change to `isCollectible(invoice) && !invoice.syncedSource`.

- [ ] **Step 6: Update the reminder test for the new guard**

In `src/lib/communication/send-invoice-reminder.test.ts`, the "fully-paid → no_balance" test now returns `not_collectible` (paid is not collectible). Update that assertion to `{ ok: false, reason: 'not_collectible' }`, and ADD a case: a `refunded` invoice with `totalCents: 5000, amountPaidCents: 0` also returns `{ ok:false, reason:'not_collectible' }` and does NOT enqueue (`expect(queueCommunicationJob).not.toHaveBeenCalled()`).

- [ ] **Step 7: Run tests, tsc, lint, commit**

Run `npx vitest run src/lib/admin/invoice-collectible.test.ts src/lib/communication/send-invoice-reminder.test.ts` (PASS), `npx tsc --noEmit` (0), `npx eslint src/lib/admin/invoice-collectible.ts src/components/admin/invoices "src/app/admin/(dashboard)/invoices/page.tsx" src/lib/communication/money-triggers.ts "src/app/api/admin/invoices/[id]/send-reminder/route.ts"` (0 errors). Then:
```bash
git add -- src/lib/admin/invoice-collectible.ts src/lib/admin/invoice-collectible.test.ts "src/app/admin/(dashboard)/invoices/page.tsx" src/components/admin/invoices/summary-band.tsx src/components/admin/invoices/invoice-row.tsx src/components/admin/invoices/invoice-detail-client.tsx src/lib/communication/money-triggers.ts src/lib/communication/send-invoice-reminder.test.ts "src/app/api/admin/invoices/[id]/send-reminder/route.ts"
git commit -m "fix(invoices): only OPEN invoices are collectible (never dun void/refunded)"
```

---

### Task 2: Cron dunning sweep stamps `lastReminderSentAt`

**Files:**
- Modify: `src/lib/communication/money-triggers.ts` (`sendOverdueInvoiceReminders` ~L356)
- Test: `src/lib/communication/send-invoice-reminder.test.ts` (add a case) or a focused new test

**Interfaces:**
- Consumes: `invoices`, `withTenant`, `eq`. No signature change.

- [ ] **Step 1: Write the failing test**

The weekly sweep enqueues a reminder but never stamps `lastReminderSentAt`, so the UI (list chip + detail Activity) shows "never reminded" after an automated send. Add a test asserting the sweep issues a stamping `UPDATE`. In a test that drives `sendOverdueInvoiceReminders` with one overdue invoice (mock the overdue select to return it, contact + template present, `claimOutboundOnce` → true), assert an `update(invoices).set({ lastReminderSentAt: ... })` was recorded (reuse the `updateSetCalls` capture pattern from `send-invoice-reminder.test.ts`).

- [ ] **Step 2: Run to verify it fails**, then **Step 3: implement**

After the successful `queueCommunicationJob(...)` inside the `for` loop's `try` (the `enqueued++` branch), add a best-effort stamp:
```ts
// Reflect the automated send in the UI (list chip + detail Activity) just like
// the manual path does. Best-effort — the reminder is already queued.
await db
  .update(invoices)
  .set({ lastReminderSentAt: now })
  .where(withTenant(invoices, organizationId, eq(invoices.id, inv.id)))
  .catch(() => {});
```
(Use the loop's `now` and `inv.id`. `eq` is already imported in this file; match the existing `withTenant` call style.)

- [ ] **Step 4: Run to verify pass; Step 5: tsc + commit**

`npx vitest run src/lib/communication/send-invoice-reminder.test.ts` (PASS), `npx tsc --noEmit` (0), then:
```bash
git add src/lib/communication/money-triggers.ts src/lib/communication/send-invoice-reminder.test.ts
git commit -m "fix(invoices): dunning sweep stamps lastReminderSentAt (visible in UI)"
```

---

### Task 3: Canonical invoice reference on the list row

**Files:**
- Modify: `src/components/admin/invoices/invoice-row.tsx` (~L59)

**Interfaces:**
- Consumes: `invoiceRef` from `@/lib/communication/money-triggers` (exported).

- [ ] **Step 1: Fix the divergence**

The list row shows `#{invoice.id.slice(-6).toUpperCase()}` (last 6) while the detail page and the SMS reminder show `invoiceRef(id)` = `#{first 8, uppercased}`. An operator can't reconcile the two. Replace the row's inline ref with the shared helper:
```tsx
import { invoiceRef } from '@/lib/communication/money-triggers';
// ...
<span className="font-mono tabular-nums">{invoiceRef(invoice.id)}</span>
```
(Removing the local `slice(-6)`.) NOTE: `invoiceRef` is defined in a module that also does DB work — confirm importing it into this client component does not pull `server-only` (it's a pure string function; if the import chain trips `server-only`, instead extract `invoiceRef` into the pure `invoice-collectible.ts` module from Task 1 and import from there, updating `money-triggers.ts` to re-export it). Verify with `npx tsc --noEmit` + a dev build check.

- [ ] **Step 2: tsc, lint, commit**

`npx tsc --noEmit` (0), `npx eslint src/components/admin/invoices/invoice-row.tsx` (0 errors), then:
```bash
git add src/components/admin/invoices/invoice-row.tsx
git commit -m "fix(invoices): list row uses canonical invoiceRef (matches detail + SMS)"
```

---

### Task 4: `getInvoiceOrgIdentity` fills company phone from `businessInfo`

**Files:**
- Modify: `src/lib/admin/invoice-queries.ts` (`getInvoiceOrgIdentity` ~L710)
- Test: `src/lib/admin/invoice-org-identity.test.ts` (create)

**Interfaces:**
- Consumes: `organizationSettings.businessInfo` (JSONB, shape `businessInfoSchema` in `org-config-types.ts` — has optional `phone: string`), `businessInfoSchema` for safe parsing.

- [ ] **Step 1: Write the failing test**

The invoice document renders the company phone when present, but `getInvoiceOrgIdentity` hard-returns `phone: null`. `businessInfo.phone` exists. Create `src/lib/admin/invoice-org-identity.test.ts` (chainable-proxy DB mock; mock schema `organizationSettings` with `companyName`, `businessInfo`, `organizationId`):
```ts
import { getInvoiceOrgIdentity } from './invoice-queries';
it('fills company phone from businessInfo', async () => {
  selectQueue.push([{ companyName: 'Spears Services', businessInfo: { phone: '(423) 555-0100' } }]);
  const id = await getInvoiceOrgIdentity('org-1');
  expect(id.companyName).toBe('Spears Services');
  expect(id.phone).toBe('(423) 555-0100');
  expect(id.address).toBeNull();
});
it('phone is null when businessInfo has none', async () => {
  selectQueue.push([{ companyName: 'X', businessInfo: {} }]);
  expect((await getInvoiceOrgIdentity('org-1')).phone).toBeNull();
});
```

- [ ] **Step 2: Run to verify it fails**, then **Step 3: implement**

Extend the select to also read `businessInfo: organizationSettings.businessInfo`, and safe-parse it:
```ts
import { businessInfoSchema } from "@/lib/admin/org-config-types";
// ...
  const [row] = await db
    .select({
      companyName: organizationSettings.companyName,
      businessInfo: organizationSettings.businessInfo,
    })
    .from(organizationSettings)
    .where(eq(organizationSettings.organizationId, organizationId))
    .limit(1);
  const info = businessInfoSchema.safeParse(row?.businessInfo ?? {});
  return {
    companyName: row?.companyName ?? "Your Company",
    address: null, // no structured column; businessInfo has no address (only free-text serviceArea)
    phone: info.success ? info.data.phone ?? null : null,
  };
```

- [ ] **Step 4: Run to verify pass; Step 5: tsc, commit**

`npx vitest run src/lib/admin/invoice-org-identity.test.ts` (PASS), `npx tsc --noEmit` (0), then:
```bash
git add src/lib/admin/invoice-queries.ts src/lib/admin/invoice-org-identity.test.ts
git commit -m "feat(invoices): invoice document shows company phone from businessInfo"
```

---

### Task 5: `pay-link` endpoint rejects synced invoices

**Files:**
- Modify: `src/app/api/admin/invoices/[id]/pay-link/route.ts`, and `src/lib/admin/invoice-queries.ts` (`getInvoiceCustomerId` → also return syncedSource, OR add a small state read)
- Test: `tests/api/invoice-pay-link.test.ts` (add a case)

**Interfaces:**
- The route already loads the invoice's `customerId` tenant-scoped; also fetch whether it's synced.

- [ ] **Step 1: Write the failing test**

Add to `tests/api/invoice-pay-link.test.ts`: when the looked-up invoice is synced (mock the customer/state lookup to indicate `fieldpulseInvoiceId`/`syncedSource` set), the route returns 400/409 and does NOT mint a token (`expect(mockGeneratePortalToken).not.toHaveBeenCalled()`).

- [ ] **Step 2: Run to verify it fails**, then **Step 3: implement**

Extend the invoice lookup used by the route to also return the synced discriminator (e.g. `getInvoiceCustomerId` returns `{ customerId, syncedSource }` via `deriveSyncedSource(fieldpulseInvoiceId, hcpInvoiceId)`, or add a sibling read). In the route, after resolving the invoice, if `syncedSource !== null` return `errorResponse("Synced invoice", "SYNCED_READONLY", 409)` BEFORE minting the token. Keep it consistent with the money-flow read-only guards.

- [ ] **Step 4: Run to verify pass; Step 5: tsc, lint, commit**

Run the pay-link test (PASS), `npx tsc --noEmit` (0), lint (0 errors), then:
```bash
git add "src/app/api/admin/invoices/[id]/pay-link/route.ts" src/lib/admin/invoice-queries.ts tests/api/invoice-pay-link.test.ts
git commit -m "fix(invoices): pay-link endpoint refuses synced invoices (defense in depth)"
```

---

### Task 6: List can re-chase after the cooldown expires

**Files:**
- Modify: `src/components/admin/invoices/invoice-row.tsx` (reminded branch ~L92)

**Interfaces:**
- Consumes: `REMINDER_COOLDOWN_MS` from `@/lib/admin/invoice-collectible` (Task 1).

- [ ] **Step 1: Fix the dead-end**

Today, once `lastReminderSentAt` is set, the row shows a permanent "✓ Reminded Nd ago" chip and never offers re-send — so a customer reminded 45 days ago can't be re-chased from the collections list (the backend cooldown is only 6h). Change the reminder branch so:
- when `lastReminderSentAt` is set AND `Date.now() - new Date(lastReminderSentAt).getTime() < REMINDER_COOLDOWN_MS` → show the passive "✓ Reminded {rel}" chip (recently reminded, no resend);
- when `lastReminderSentAt` is set AND the cooldown has passed → show a **"Remind again"** `Button` (same `onRemind(invoice.id)` handler, `disabled={pending}`) alongside a muted "· last {rel}" caption;
- when never reminded → the existing "Send reminder" button.
Keep this entire block gated on `isCollectible(invoice) && !invoice.syncedSource` (Task 1). Import `REMINDER_COOLDOWN_MS`.

- [ ] **Step 2: tsc, lint, commit**

`npx tsc --noEmit` (0), `npx eslint src/components/admin/invoices/invoice-row.tsx` (0 errors), then:
```bash
git add src/components/admin/invoices/invoice-row.tsx
git commit -m "feat(invoices): list allows re-chase once the reminder cooldown expires"
```

---

### Task 7: Restore the detail page `<h1>` landmark (a11y)

**Files:**
- Modify: `src/components/admin/invoices/invoice-detail-client.tsx` (toolbar ~L315-362)

- [ ] **Step 1: Add a heading landmark**

The re-layout dropped the page's `<h1>` (toolbar now shows only badges), so the single-invoice page has no heading/document landmark — a screen-reader regression. Add a visually-hidden heading in the toolbar region:
```tsx
<h1 className="sr-only">Invoice {invoiceRef(invoice.id)}</h1>
```
Place it at the top of the toolbar container. Reuse the `invoiceRef` import (already used for the canonical ref) or add it. Confirm `sr-only` is available (it's a standard Tailwind utility used elsewhere in the admin — grep `sr-only`).

- [ ] **Step 2: tsc, lint, commit**

`npx tsc --noEmit` (0), `npx eslint src/components/admin/invoices/invoice-detail-client.tsx` (0 errors), then:
```bash
git add src/components/admin/invoices/invoice-detail-client.tsx
git commit -m "fix(invoices): restore h1 landmark on invoice detail (a11y)"
```

---

## Self-Review notes (addressed)

- **Backlog coverage:** #1 collectible bug (Task 1), #6 cron stamp (Task 2), #4 ref divergence (Task 3), #3 org phone (Task 4), #9 pay-link guard (Task 5), #5 list re-chase (Task 6), #2 a11y h1 (Task 7). All verified against real code with file:line.
- **DRY:** one `isCollectible` + one `REMINDER_COOLDOWN_MS` shared by client and server (Task 1) — removes the hand-rolled `state !== 'paid'` in 5 places; Task 6 reuses the constant.
- **Type consistency:** `isCollectible(inv)` signature and `not_collectible` reason string are used identically in the query, the backend guard, the route map, and the components.
- **Verify-before-code hooks:** Task 3 flags the `invoiceRef` import possibly tripping `server-only` (with a fallback); Task 5 flags extending the invoice lookup shape.

## Out of scope (deferred — separate work)
- `⋯` row overflow menu (Copy pay link / Record payment / Void) — MED effort, own task.
- "Collected this month" summary tile — needs a new payments aggregate query.
- Reminder-history LOG table (a true audit trail vs the single timestamp) — needs a migration.
- Email-channel reminders; bulk chase; per-org invoice tagline; toast motion polish.
- Structured org **address** column (product/schema decision).
