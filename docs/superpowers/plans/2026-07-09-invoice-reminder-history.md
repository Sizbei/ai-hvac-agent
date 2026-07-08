# Invoice Collections — Reminder history (Phase 6)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Show a true per-send reminder history on the invoice detail (activity timeline + "Reminders sent" count), replacing the single-timestamp view — with **no migration**.

**Architecture:** Every reminder (manual `sendInvoiceReminder` AND the cron sweep) is already persisted as a `communication_jobs` row with `triggerType='invoice_overdue'` and `templateVariables.invoiceNumber = invoiceRef(id)`. A new `listInvoiceReminders` query derives history from that table (matching `templateVariables->>'invoiceId'` going forward, falling back to `->>'invoiceNumber'` for pre-existing rows). Both enqueue paths gain `invoiceId` in `templateVariables` as the precise key. The detail GET returns the history; the sidebar's activity timeline emits one event per send and the Collections panel gains a real "Reminders sent" count.

**Tech Stack:** Next.js 16 App Router, Drizzle ORM over Neon Postgres HTTP (JSONB `->>` filter via `sql`), React client components, Vitest (node env).

## Global Constraints

- **No migration.** History is derived from `communication_jobs` (org-scoped, `triggerType='invoice_overdue'`). GDPR erasure already wipes a customer's jobs — history correctly dies with the customer.
- Every query `withTenant`/org-scoped; org from `session.organizationId`.
- Match key: `templateVariables->>'invoiceId' = <uuid>` **OR** `templateVariables->>'invoiceNumber' = invoiceRef(<uuid>)` (retroactive). Order `createdAt` DESC, LIMIT 20.
- **Avoid double-counting in the timeline:** when history is non-empty, do NOT also emit the legacy `lastReminderSentAt` event (it's the same send); only fall back to `lastReminderSentAt` when history is empty.
- node-env tests; pure functions tested, components not render-tested. Pure client helpers stay db/server-only-free. **Run `npx next build` in the final gate.**
- Conventional commits, NO Co-Authored-By trailer.

---

## File Structure

- `src/lib/communication/money-triggers.ts` — both enqueues add `invoiceId` to `templateVariables`.
- `src/lib/admin/invoice-queries.ts` — NEW `listInvoiceReminders(orgId, invoiceId)`.
- `src/app/api/admin/invoices/[id]/route.ts` — GET also returns `reminders`.
- `src/components/admin/invoices/invoice-activity.ts` — `buildActivity` takes history; `collectionsStats` unchanged.
- `src/components/admin/invoices/invoice-collections-side.tsx` — "Reminders sent" count row + pass history.
- `src/components/admin/invoices/invoice-detail-client.tsx` — hydrate + thread `reminders`.

---

### Task 1: enqueue key + `listInvoiceReminders` + detail route

**Files:**
- Modify: `src/lib/communication/money-triggers.ts` (2 enqueue sites), `src/lib/admin/invoice-queries.ts`, `src/app/api/admin/invoices/[id]/route.ts`
- Test: extend `src/lib/admin/invoice-queries-list.test.ts` (query) + `src/lib/communication/send-invoice-reminder.test.ts` (enqueue carries invoiceId)

**Interfaces:**
- Produces: `listInvoiceReminders(organizationId: string, invoiceId: string): Promise<ReminderHistoryEntry[]>` where `ReminderHistoryEntry = { at: Date; channel: string; status: string }` (`at` = `sentAt ?? createdAt`). Detail GET returns `{ invoice, org, reminders }` (reminders ISO-serialized).

- [ ] **Step 1: Write the failing tests**

(a) In `send-invoice-reminder.test.ts`, assert both the manual path's and the sweep's `queueCommunicationJob` call carries `templateVariables.invoiceId === <the invoice id>` (extend the existing captured-call assertions).

(b) In `invoice-queries-list.test.ts`, add (extend the drizzle mock with `or`/`desc` if missing; add a `communicationJobs` schema mock with `organizationId`, `triggerType`, `channel`, `status`, `templateVariables`, `createdAt`, `sentAt`):
```ts
import { listInvoiceReminders } from './invoice-queries';

describe('listInvoiceReminders', () => {
  it('returns history entries (sentAt preferred, createdAt fallback), newest first', async () => {
    selectQueue.push([
      { channel: 'sms', status: 'sent', sentAt: new Date('2026-07-08T10:00:00Z'), createdAt: new Date('2026-07-08T09:59:00Z') },
      { channel: 'sms', status: 'pending', sentAt: null, createdAt: new Date('2026-07-01T12:00:00Z') },
    ]);
    const rows = await listInvoiceReminders('org-1', '11111111-2222-3333-4444-555555555555');
    expect(rows).toEqual([
      { at: new Date('2026-07-08T10:00:00Z'), channel: 'sms', status: 'sent' },
      { at: new Date('2026-07-01T12:00:00Z'), channel: 'sms', status: 'pending' },
    ]);
    const where = JSON.stringify(captured.at(-1)!.where);
    expect(where).toContain('invoice_overdue');
    expect(where).toContain('org-1');
  });
  it('returns [] when no jobs match', async () => {
    selectQueue.push([]);
    expect(await listInvoiceReminders('org-1', '11111111-2222-3333-4444-555555555555')).toEqual([]);
  });
});
```

- [ ] **Step 2: Run to verify they fail**, then **Step 3: implement**

1. `money-triggers.ts`: in BOTH `sendInvoiceReminder`'s and `sendOverdueInvoiceReminders`'s `queueCommunicationJob({... templateVariables: {...}})`, add `invoiceId` (the full uuid — manual path uses its `invoiceId` param; sweep uses `inv.id`) alongside the existing `invoiceNumber`.
2. `invoice-queries.ts` (import `communicationJobs` from schema; `desc`, `or`, `sql`, `eq`, `and` are available):
```ts
export type ReminderHistoryEntry = {
  readonly at: Date;
  readonly channel: string;
  readonly status: string;
};

/**
 * Per-send reminder history, derived from the communication-jobs queue (no
 * dedicated table). Matches the precise invoiceId key written since Phase 6,
 * falling back to the invoiceNumber ref for older rows.
 */
export async function listInvoiceReminders(
  organizationId: string,
  invoiceId: string,
): Promise<ReminderHistoryEntry[]> {
  const ref = invoiceRef(invoiceId);
  const rows = await db
    .select({
      channel: communicationJobs.channel,
      status: communicationJobs.status,
      sentAt: communicationJobs.sentAt,
      createdAt: communicationJobs.createdAt,
    })
    .from(communicationJobs)
    .where(
      and(
        eq(communicationJobs.organizationId, organizationId),
        eq(communicationJobs.triggerType, "invoice_overdue"),
        or(
          sql`${communicationJobs.templateVariables}->>'invoiceId' = ${invoiceId}`,
          sql`${communicationJobs.templateVariables}->>'invoiceNumber' = ${ref}`,
        ),
      ),
    )
    .orderBy(desc(communicationJobs.createdAt))
    .limit(20);
  return rows.map((r) => ({ at: r.sentAt ?? r.createdAt, channel: r.channel, status: r.status }));
}
```
   VERIFY against the real schema first: the exact `communicationJobs` column names (`sentAt` vs `completedAt` — read the schema block and use the column that records the send moment; adjust the test/mock to the real name) and that `invoiceRef` is importable here (it is — same module already imports it from `invoice-collectible`).
3. Detail route: `const reminders = await listInvoiceReminders(session.organizationId, id);` → `successResponse({ invoice, org, reminders })`.

- [ ] **Step 4: Run to verify pass; Step 5: tsc, lint, commit**

`npx vitest run src/lib/admin/invoice-queries-list.test.ts src/lib/communication/send-invoice-reminder.test.ts` (PASS), `npx tsc --noEmit` (0), eslint changed files (0 errors). Then:
```bash
git add src/lib/communication/money-triggers.ts src/lib/admin/invoice-queries.ts src/lib/admin/invoice-queries-list.test.ts src/lib/communication/send-invoice-reminder.test.ts "src/app/api/admin/invoices/[id]/route.ts"
git commit -m "feat(invoices): per-send reminder history derived from communication jobs"
```

---

### Task 2: surface history in the detail sidebar

**Files:**
- Modify: `src/components/admin/invoices/invoice-activity.ts`, `invoice-collections-side.tsx`, `invoice-detail-client.tsx`
- Test: `src/components/admin/invoices/invoice-activity.test.ts` (extend)

**Interfaces:**
- Consumes: `ReminderHistoryEntry[]` from Task 1 (ISO strings over the wire → hydrate to `Date`).
- Produces: `buildActivity(inv, reminders: ReminderHistoryEntry[])` — one `'reminder'` event per entry (label `'Reminder sent'`, sms→`'Reminder sent'`); **falls back** to the single `lastReminderSentAt` event ONLY when `reminders.length === 0`. `InvoiceCollectionsSide` gains a `reminders` prop → "Reminders sent" `{reminders.length || (lastReminderSentAt ? 1 : 0)}` row.

- [ ] **Step 1: Write the failing tests** (extend the existing `invoice-activity` pure tests)

```ts
it('emits one reminder event per history entry, newest included, no lastReminderSentAt double-count', () => {
  const events = buildActivity(
    { createdAt: d('2026-06-01'), lastReminderSentAt: d('2026-07-08'), payments: [] },
    [ { at: d('2026-07-08'), channel: 'sms', status: 'sent' },
      { at: d('2026-07-01'), channel: 'sms', status: 'sent' } ],
  );
  expect(events.filter(e => e.kind === 'reminder')).toHaveLength(2);
});
it('falls back to lastReminderSentAt when history is empty', () => {
  const events = buildActivity(
    { createdAt: d('2026-06-01'), lastReminderSentAt: d('2026-07-08'), payments: [] }, [],
  );
  expect(events.filter(e => e.kind === 'reminder')).toHaveLength(1);
});
```
(Use the file's existing test helpers/shape; `d()` = `new Date(...)`.)

- [ ] **Step 2: Run to verify fail**, then **Step 3: implement**

1. `invoice-activity.ts`: `buildActivity(inv, reminders: ReminderHistoryEntry[] = [])`; replace the single `lastReminderSentAt` push with: if `reminders.length > 0`, push one `{ kind:'reminder', at: r.at, label: 'Reminder sent' }` per entry; else keep the existing fallback. Import the `ReminderHistoryEntry` TYPE with `import type` (type-only — safe across the server boundary).
2. `invoice-collections-side.tsx`: accept `reminders` prop, pass to `buildActivity`, add `<Row label="Reminders sent" value={String(reminders.length || (invoice.lastReminderSentAt ? 1 : 0))} />` above "Last reminder".
3. `invoice-detail-client.tsx`: read `reminders` from the GET body (`body.data.reminders ?? []`), hydrate `at` ISO→`Date`, keep in state, pass to `<InvoiceCollectionsSide reminders={...}>`.

- [ ] **Step 4: tests + tsc + lint + `next build`, Step 5: commit**

`npx vitest run src/components/admin/invoices` (PASS), `npx tsc --noEmit` (0), eslint (0 errors), `npx next build` (compiles — a type-only import must not pull server code into the client bundle). Then:
```bash
git add src/components/admin/invoices/invoice-activity.ts src/components/admin/invoices/invoice-activity.test.ts src/components/admin/invoices/invoice-collections-side.tsx src/components/admin/invoices/invoice-detail-client.tsx
git commit -m "feat(invoices): detail sidebar shows real per-send reminder history"
```

---

## Self-Review notes (addressed)

- **No-migration decision:** jobs table already persists both send paths with timestamps + status; retroactive matching via `invoiceNumber`; erasure semantics come for free. A dedicated table would duplicate this for no gain.
- **Double-count guard** is explicit (history non-empty ⇒ skip the legacy single event).
- **Type-only import risk flagged:** the client `invoice-activity.ts` imports ONLY the `ReminderHistoryEntry` type from `invoice-queries` (already imports `InvoiceDetailView` the same way) — `import type` is erased at compile time, so no server-only leak; `next build` verifies.
- **Column-name verify hook:** Task 1 tells the implementer to confirm `sentAt` vs `completedAt` on `communicationJobs` before coding.

## Out of scope
- Distinguishing manual vs automated sends in the history (jobs don't record the actor; would need an enqueue field — YAGNI until asked).
- Email-channel reminders; bulk chase (unchanged deferrals).
