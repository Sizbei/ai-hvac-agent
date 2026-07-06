# Invoice Collections — List + Backend Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the admin Invoices list into a collections workspace — aging summary, overdue-first list with customer names, and one-click "Send reminder" that fires the existing `invoice_overdue` SMS with a real pay link.

**Architecture:** Reuse existing infra. `listInvoices` gains a decrypted customer-name join + `lastReminderSentAt`. A new `sendInvoiceReminder()` in `money-triggers.ts` reuses the dunning path's helpers (contact, template, `queueCommunicationJob`) but adds a real pay link (`generatePortalToken`) and a short cooldown, and stamps a new `last_reminder_sent_at` column. A thin admin-gated POST route drives it. The page/hook are rebuilt to the approved Ledger design.

**Tech Stack:** Next.js 16 App Router, Drizzle ORM 0.45 over Neon Postgres HTTP, React client components, Vitest.

## Global Constraints

- **Neon HTTP has NO transactions and NO row locks.** Use single guarded `UPDATE ... RETURNING` for check-then-act; never `db.transaction()`.
- **Multi-tenancy:** every query MUST be scoped with `withTenant(table, organizationId, ...conditions)`. Joined tables get their own org predicate.
- **Admin API routes:** gate with `getAdminSession()` (401 if absent), rate-limit with `slidingWindow(...RATE_LIMITS...)`, return via `successResponse` / `errorResponse` envelopes.
- **Money is cents (integers).** Format for display with `formatCentsExact` from `@/lib/admin/money-format`.
- **PII (name/phone/email/address) is encrypted at rest.** Decrypt with `decrypt` from `@/lib/crypto`, always wrapped in try/catch → null on failure.
- **Commit style:** conventional commits, NO `Co-Authored-By` trailer (attribution disabled globally).
- **TDD:** write the failing test first every task. Vitest DB mocks follow the chainable-proxy pattern in `src/lib/admin/reporting-queries.test.ts` (mock `@/lib/db`, `@/lib/db/tenant`, `drizzle-orm`, `@/lib/db/schema`).
- **Migrations auto-run on deploy** (per branch-merge-state memory); still run `npm run db:migrate` locally after generating.

---

## File Structure

- `src/lib/db/schema.ts` — add `lastReminderSentAt` column to `invoices` (modify).
- `drizzle/00NN_*.sql` + `drizzle/meta/*` — generated migration (create).
- `src/lib/admin/invoice-queries.ts` — extend `InvoiceListRow` + `listInvoices` (modify).
- `src/lib/communication/money-triggers.ts` — add `sendInvoiceReminder()` (modify; reuses private helpers here).
- `src/app/api/admin/invoices/[id]/send-reminder/route.ts` — POST endpoint (create).
- `src/hooks/use-invoices.ts` — extend `InvoiceListItem` + add `sendReminder()` (modify).
- `src/app/admin/(dashboard)/invoices/page.tsx` — rebuild as collections list (modify).
- `src/components/admin/invoices/` — `summary-band.tsx`, `age-chip.tsx`, `invoice-row.tsx` (create).
- Tests colocated: `*.test.ts` next to each module.

---

### Task 1: Add `last_reminder_sent_at` to invoices

**Files:**
- Modify: `src/lib/db/schema.ts` (invoices table, after `hcpInvoiceId`)
- Create: `drizzle/00NN_invoice_last_reminder.sql` (generated)

**Interfaces:**
- Produces: `invoices.lastReminderSentAt` — `timestamp with time zone`, nullable.

- [ ] **Step 1: Add the column to the schema**

In `src/lib/db/schema.ts`, inside the `invoices` pgTable, immediately after the `hcpInvoiceId: text("hcp_invoice_id"),` line:

```ts
    // When a collections reminder was last sent for this invoice. Nullable
    // (never reminded). Powers the "Reminded 3d ago" chip and the send cooldown.
    lastReminderSentAt: timestamp("last_reminder_sent_at", { withTimezone: true }),
```

- [ ] **Step 2: Generate the migration**

Run: `npx drizzle-kit generate`
Expected: a new `drizzle/00NN_*.sql` containing `ALTER TABLE "invoices" ADD COLUMN "last_reminder_sent_at" timestamp with time zone;` and updated `drizzle/meta/_journal.json`.

- [ ] **Step 3: Verify types compile**

Run: `npx tsc --noEmit`
Expected: exit 0 (no errors).

- [ ] **Step 4: Apply locally**

Run: `npm run db:migrate`
Expected: migration applies cleanly.

- [ ] **Step 5: Commit**

```bash
git add src/lib/db/schema.ts drizzle/
git commit -m "feat(invoices): add last_reminder_sent_at column"
```

---

### Task 2: Extend `listInvoices` with customer name + last-reminded

**Files:**
- Modify: `src/lib/admin/invoice-queries.ts` (`InvoiceListRow` ~L701, `listInvoices` ~L727)
- Test: `src/lib/admin/invoice-queries-list.test.ts` (create)

**Interfaces:**
- Consumes: `invoices`, `customers` tables; `withTenant`; `decrypt` from `@/lib/crypto`.
- Produces: `InvoiceListRow` now additionally has `customerName: string | null` and `lastReminderSentAt: Date | null`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/admin/invoice-queries-list.test.ts` following the chainable-proxy mock pattern from `reporting-queries.test.ts` (copy its `vi.hoisted`/`chain`/`vi.mock('@/lib/db')`/`vi.mock('@/lib/db/tenant')` scaffolding). Mock `drizzle-orm` with `eq`, `desc`, `sql`. Mock `@/lib/crypto` so `decrypt` returns `` `dec(${c})` ``. Mock `@/lib/db/schema` with `invoices` and `customers` (with `id`, `nameEncrypted`, `organizationId`). Then:

```ts
import { listInvoices } from './invoice-queries';

it('returns invoices with decrypted customer name + lastReminderSentAt, org-scoped', async () => {
  selectQueue.push([
    { id: 'i1', state: 'open', totalCents: 5000, amountPaidCents: 0,
      customerId: 'c1', serviceRequestId: 'sr1', createdAt: new Date('2026-06-01'),
      fieldpulseInvoiceId: null, hcpInvoiceId: null,
      nameEncrypted: 'ENC', lastReminderSentAt: new Date('2026-06-20') },
  ]);
  const rows = await listInvoices('org-1');
  expect(rows[0].customerName).toBe('dec(ENC)');
  expect(rows[0].lastReminderSentAt).toEqual(new Date('2026-06-20'));
  expect(rows[0].syncedSource).toBeNull();
  // customers join is org-scoped (defense in depth)
  const joins = JSON.stringify(captured.flatMap(c => c.joins));
  expect(joins).toContain('customers');
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/admin/invoice-queries-list.test.ts`
Expected: FAIL — `customerName` is undefined (not yet selected).

- [ ] **Step 3: Extend the type and query**

In `src/lib/admin/invoice-queries.ts`, add to the `InvoiceListRow` interface (~L701):

```ts
  readonly customerName: string | null;
  readonly lastReminderSentAt: Date | null;
```

Add the import if missing at the top: `import { decrypt } from "@/lib/crypto";` and `customers` to the schema import. Then rewrite `listInvoices` (~L727):

```ts
export async function listInvoices(
  organizationId: string,
): Promise<InvoiceListRow[]> {
  const rows = await db
    .select({
      id: invoices.id,
      state: invoices.state,
      totalCents: invoices.totalCents,
      amountPaidCents: invoices.amountPaidCents,
      customerId: invoices.customerId,
      serviceRequestId: invoices.serviceRequestId,
      createdAt: invoices.createdAt,
      lastReminderSentAt: invoices.lastReminderSentAt,
      fieldpulseInvoiceId: invoices.fieldpulseInvoiceId,
      hcpInvoiceId: invoices.hcpInvoiceId,
      nameEncrypted: customers.nameEncrypted,
    })
    .from(invoices)
    // Org-scope the join too (defense in depth): a customerId can only ever be
    // this org's, but the predicate guarantees a cross-tenant row can't leak.
    .leftJoin(
      customers,
      and(
        eq(customers.id, invoices.customerId),
        eq(customers.organizationId, organizationId),
      ),
    )
    .where(withTenant(invoices, organizationId))
    .orderBy(desc(invoices.createdAt));

  return rows.map(({ fieldpulseInvoiceId, hcpInvoiceId, nameEncrypted, ...r }) => ({
    ...r,
    customerName: safeDecryptName(nameEncrypted),
    syncedSource: deriveSyncedSource(fieldpulseInvoiceId, hcpInvoiceId),
  }));
}

/** Decrypt an encrypted name for display; null on absent/garbled ciphertext. */
function safeDecryptName(ciphertext: string | null): string | null {
  if (!ciphertext) return null;
  try {
    return decrypt(ciphertext);
  } catch {
    return null;
  }
}
```

Ensure `and` is imported from `drizzle-orm` (add if missing).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/admin/invoice-queries-list.test.ts`
Expected: PASS.

- [ ] **Step 5: Type-check and commit**

Run: `npx tsc --noEmit` (expect 0), then:

```bash
git add src/lib/admin/invoice-queries.ts src/lib/admin/invoice-queries-list.test.ts
git commit -m "feat(invoices): join customer name + last-reminded into list query"
```

---

### Task 3: `sendInvoiceReminder()` — one-click reminder with pay link

**Files:**
- Modify: `src/lib/communication/money-triggers.ts` (add exported fn; reuse local helpers `getCustomerContact`, `findActiveSmsTemplate`, `getOrgBrand`, `invoiceRef`)
- Test: `src/lib/communication/send-invoice-reminder.test.ts` (create)

**Interfaces:**
- Consumes: `queueCommunicationJob`, `generatePortalToken` from `@/lib/portal/portal-queries`, `formatCentsExact`, `invoices`/`withTenant`, `process.env.NEXT_PUBLIC_APP_URL`.
- Produces: `sendInvoiceReminder(organizationId: string, invoiceId: string, now?: Date): Promise<{ ok: true } | { ok: false; reason: "not_found" | "no_balance" | "no_phone" | "no_template" | "cooldown" }>`. Cooldown window: 6 hours.

- [ ] **Step 1: Write the failing test**

Create `src/lib/communication/send-invoice-reminder.test.ts`. Mock `@/lib/db` (chainable proxy with a `select` queue and an `update` that records `.set()` values + resolves `.returning()`), `@/lib/db/tenant`, `drizzle-orm` (`eq`,`and`,`sql`,`lt`,`gte`), `@/lib/db/schema` (`invoices`,`customers`,`communicationTemplates`), `@/lib/portal/portal-queries` (`generatePortalToken: vi.fn(async () => 'TOK')`), `@/lib/communication/job-queue` (`queueCommunicationJob: vi.fn()`), and stub the brand/contact reads. Set `process.env.NEXT_PUBLIC_APP_URL = 'https://app.test'`.

```ts
import { sendInvoiceReminder } from './money-triggers';
import { queueCommunicationJob } from './job-queue';

it('enqueues invoice_overdue SMS with a real pay link and stamps lastReminderSentAt', async () => {
  // invoice read: open, $50 balance, customer c1, never reminded
  selectQueue.push([{ id:'i1', customerId:'c1', totalCents:5000, amountPaidCents:0,
    state:'open', lastReminderSentAt:null }]);
  // customer contact read: phone present
  selectQueue.push([{ phoneEncrypted:'P', emailEncrypted:null, nameEncrypted:'N' }]);
  // active template read
  templateQueue.push({ id: 'tpl-1' });

  const res = await sendInvoiceReminder('org-1', 'i1', new Date('2026-07-06T12:00:00Z'));

  expect(res).toEqual({ ok: true });
  const call = (queueCommunicationJob as any).mock.calls[0][0];
  expect(call.triggerType).toBe('invoice_overdue');
  expect(call.templateId).toBe('tpl-1');
  expect(call.templateVariables.payLink).toBe('https://app.test/portal/TOK');
  expect(call.templateVariables.amount).toBe('$50.00');
  // stamped last_reminder_sent_at via UPDATE
  expect(updateSetCalls[0]).toHaveProperty('lastReminderSentAt');
});

it('rejects when the last reminder was under 6h ago (cooldown)', async () => {
  selectQueue.push([{ id:'i1', customerId:'c1', totalCents:5000, amountPaidCents:0,
    state:'open', lastReminderSentAt: new Date('2026-07-06T10:00:00Z') }]);
  const res = await sendInvoiceReminder('org-1', 'i1', new Date('2026-07-06T12:00:00Z'));
  expect(res).toEqual({ ok:false, reason:'cooldown' });
  expect(queueCommunicationJob).not.toHaveBeenCalled();
});

it('rejects a fully-paid invoice (no balance)', async () => {
  selectQueue.push([{ id:'i1', customerId:'c1', totalCents:5000, amountPaidCents:5000,
    state:'paid', lastReminderSentAt:null }]);
  const res = await sendInvoiceReminder('org-1', 'i1', new Date());
  expect(res).toEqual({ ok:false, reason:'no_balance' });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/communication/send-invoice-reminder.test.ts`
Expected: FAIL — `sendInvoiceReminder` not exported.

- [ ] **Step 3: Implement in money-triggers.ts**

Add near the top imports: `import { generatePortalToken } from "@/lib/portal/portal-queries";`. Then add:

```ts
const REMINDER_COOLDOWN_MS = 6 * 60 * 60 * 1000; // don't double-send within 6h

/**
 * One-click manual collections reminder for a single invoice. Unlike the weekly
 * dunning sweep, this is operator-initiated, so it is NOT gated by the 7-day
 * bucket — only a short 6h cooldown guards against accidental double-clicks.
 * Includes a real pay link (fresh portal token). Best-effort at SEND time
 * (consent + quiet hours enforced in processPendingJobs). Stamps
 * lastReminderSentAt so the UI can show "Reminded Nd ago".
 */
export async function sendInvoiceReminder(
  organizationId: string,
  invoiceId: string,
  now: Date = new Date(),
): Promise<
  | { readonly ok: true }
  | { readonly ok: false; readonly reason:
      "not_found" | "no_balance" | "no_phone" | "no_template" | "cooldown" }
> {
  const [inv] = await db
    .select({
      id: invoices.id,
      customerId: invoices.customerId,
      totalCents: invoices.totalCents,
      amountPaidCents: invoices.amountPaidCents,
      state: invoices.state,
      lastReminderSentAt: invoices.lastReminderSentAt,
    })
    .from(invoices)
    .where(withTenant(invoices, organizationId, eq(invoices.id, invoiceId)))
    .limit(1);

  if (!inv || !inv.customerId) return { ok: false, reason: "not_found" };
  const balanceCents = inv.totalCents - inv.amountPaidCents;
  if (inv.state === "paid" || balanceCents <= 0) return { ok: false, reason: "no_balance" };
  if (
    inv.lastReminderSentAt &&
    now.getTime() - inv.lastReminderSentAt.getTime() < REMINDER_COOLDOWN_MS
  ) {
    return { ok: false, reason: "cooldown" };
  }

  const contact = await getCustomerContact(organizationId, inv.customerId);
  if (!contact || !contact.phone) return { ok: false, reason: "no_phone" };

  const smsTemplate = await findActiveSmsTemplate(organizationId, "invoice_overdue");
  if (!smsTemplate) return { ok: false, reason: "no_template" };

  // Real pay link: mint a fresh portal token for this customer.
  const token = await generatePortalToken(organizationId, inv.customerId);
  const base = process.env.NEXT_PUBLIC_APP_URL?.replace(/\/$/, "") ?? "";
  const payLink = token ? `${base}/portal/${token}` : "";

  const brand = await getOrgBrand(organizationId);
  await queueCommunicationJob({
    organizationId,
    templateId: smsTemplate.id,
    triggerType: "invoice_overdue",
    channel: "sms" as never,
    recipientPhone: contact.phone,
    templateVariables: {
      customerName: contact.name ?? "",
      amount: formatCentsExact(balanceCents),
      invoiceNumber: invoiceRef(inv.id),
      payLink,
      companyName: brand.companyName,
      phoneNumber: brand.phoneNumber,
    },
    priority: 30,
    customerId: inv.customerId,
  });

  // Stamp last-reminded (best-effort; the send already committed to the queue).
  await db
    .update(invoices)
    .set({ lastReminderSentAt: now, updatedAt: now })
    .where(withTenant(invoices, organizationId, eq(invoices.id, invoiceId)));

  return { ok: true };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npx vitest run src/lib/communication/send-invoice-reminder.test.ts`
Expected: PASS (3 tests).

- [ ] **Step 5: Type-check and commit**

Run: `npx tsc --noEmit` (expect 0), then:

```bash
git add src/lib/communication/money-triggers.ts src/lib/communication/send-invoice-reminder.test.ts
git commit -m "feat(invoices): sendInvoiceReminder — one-click dunning with pay link + cooldown"
```

---

### Task 4: POST `/api/admin/invoices/[id]/send-reminder`

**Files:**
- Create: `src/app/api/admin/invoices/[id]/send-reminder/route.ts`
- Test: `tests/api/invoice-send-reminder.test.ts` (create; mirror an existing admin-route test's session/rate mocks)

**Interfaces:**
- Consumes: `getAdminSession`, `slidingWindow`/`RATE_LIMITS`, `sendInvoiceReminder`, `successResponse`/`errorResponse`, `logAudit`.
- Produces: `POST` handler. 200 `{ ok:true }` on success; 400/404/409 by reason; 401/429 on gate.

- [ ] **Step 1: Write the failing test**

Create `tests/api/invoice-send-reminder.test.ts`. Mock `@/lib/auth/session` (`getAdminSession` → `{ userId:'u1', organizationId:'org-1' }`), `@/lib/rate-limit` (allowed), `@/lib/communication/money-triggers` (`sendInvoiceReminder: vi.fn()`), `@/lib/admin/audit` (`logAudit: vi.fn()`).

```ts
import { POST } from '@/app/admin-route-under-test'; // adjust import to route path
import { sendInvoiceReminder } from '@/lib/communication/money-triggers';

function req() { return new Request('http://t/api/admin/invoices/i1/send-reminder', { method:'POST' }); }
const ctx = { params: Promise.resolve({ id: 'i1' }) };

it('401 when not an admin', async () => {
  (getAdminSession as any).mockResolvedValueOnce(null);
  const res = await POST(req() as any, ctx as any);
  expect(res.status).toBe(401);
});

it('200 on success', async () => {
  (sendInvoiceReminder as any).mockResolvedValueOnce({ ok: true });
  const res = await POST(req() as any, ctx as any);
  expect(res.status).toBe(200);
  expect(sendInvoiceReminder).toHaveBeenCalledWith('org-1', 'i1');
});

it('409 on cooldown', async () => {
  (sendInvoiceReminder as any).mockResolvedValueOnce({ ok:false, reason:'cooldown' });
  const res = await POST(req() as any, ctx as any);
  expect(res.status).toBe(409);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run tests/api/invoice-send-reminder.test.ts`
Expected: FAIL — route module does not exist.

- [ ] **Step 3: Implement the route**

Create `src/app/api/admin/invoices/[id]/send-reminder/route.ts`:

```ts
import { NextRequest } from "next/server";
import { getAdminSession } from "@/lib/auth/session";
import { sendInvoiceReminder } from "@/lib/communication/money-triggers";
import { logAudit } from "@/lib/admin/audit";
import { successResponse, errorResponse } from "@/lib/api-response";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";

const REASON_STATUS: Record<string, number> = {
  not_found: 404, no_balance: 400, no_phone: 400, no_template: 400, cooldown: 409,
};

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await getAdminSession();
    if (!session) return errorResponse("Unauthorized", "UNAUTHORIZED", 401);

    const rate = slidingWindow(
      `admin:invoice-reminder:${session.userId}`,
      RATE_LIMITS.adminWrite.maxRequests,
      RATE_LIMITS.adminWrite.windowMs,
    );
    if (!rate.allowed) return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);

    const { id } = await params;
    const result = await sendInvoiceReminder(session.organizationId, id);
    if (!result.ok) {
      return errorResponse(
        "Could not send reminder",
        result.reason.toUpperCase(),
        REASON_STATUS[result.reason] ?? 400,
      );
    }
    await logAudit({
      organizationId: session.organizationId,
      actorId: session.userId,
      action: "invoice.reminder_sent",
      targetType: "invoice",
      targetId: id,
    });
    return successResponse({ ok: true });
  } catch (error) {
    logger.error({ error }, "Failed to send invoice reminder");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
```

Confirm `RATE_LIMITS.adminWrite` exists (grep `RATE_LIMITS` in `src/lib/rate-limit.ts`; use `adminRead` if `adminWrite` is absent) and `logAudit`'s exact parameter shape (grep its definition; match field names — adjust `action`/`targetType`/`targetId` to the real signature).

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run tests/api/invoice-send-reminder.test.ts`
Expected: PASS.

- [ ] **Step 5: Type-check and commit**

Run: `npx tsc --noEmit` (expect 0), then:

```bash
git add "src/app/api/admin/invoices/[id]/send-reminder/route.ts" tests/api/invoice-send-reminder.test.ts
git commit -m "feat(invoices): POST send-reminder endpoint (admin-gated, rate-limited)"
```

---

### Task 5: Extend `use-invoices` hook

**Files:**
- Modify: `src/hooks/use-invoices.ts`

**Interfaces:**
- Produces: `InvoiceListItem` gains `customerName: string | null`, `lastReminderSentAt: string | null`. `UseInvoicesResult` gains `sendReminder(id: string): Promise<{ ok: boolean; reason?: string }>` which POSTs and refetches on success.

- [ ] **Step 1: Extend the item type**

In `src/hooks/use-invoices.ts` add to `InvoiceListItem`:

```ts
  readonly customerName: string | null;
  readonly lastReminderSentAt: string | null;
```

- [ ] **Step 2: Add `sendReminder` to the hook**

Add inside `useInvoices`, before the return:

```ts
  const sendReminder = useCallback(
    async (id: string): Promise<{ ok: boolean; reason?: string }> => {
      const res = await fetch(`/api/admin/invoices/${id}/send-reminder`, { method: 'POST' });
      const body = (await res.json().catch(() => ({}))) as { success?: boolean; error?: { code?: string } };
      if (res.ok && body.success) {
        await fetchAll();
        return { ok: true };
      }
      return { ok: false, reason: body.error?.code };
    },
    [fetchAll],
  );
```

Add `sendReminder` to `UseInvoicesResult` and the returned object.

- [ ] **Step 3: Type-check and commit**

Run: `npx tsc --noEmit` (expect 0), then:

```bash
git add src/hooks/use-invoices.ts
git commit -m "feat(invoices): use-invoices exposes customerName, lastReminded, sendReminder"
```

---

### Task 6: Rebuild the list page (collections workspace)

**Files:**
- Create: `src/components/admin/invoices/age-chip.tsx`, `summary-band.tsx`, `invoice-row.tsx`
- Modify: `src/app/admin/(dashboard)/invoices/page.tsx`
- Test: `src/components/admin/invoices/age-chip.test.tsx`

**Interfaces:**
- Consumes: `useInvoices` (Task 5), `formatCentsExact`.
- Produces: `ageBucket(days: number): 'green'|'amber'|'red'` and `<AgeChip createdAt state>`; `<SummaryBand invoices>`; `<InvoiceRow invoice reminded onRemind>`.

- [ ] **Step 1: Write the failing test (age buckets — the logic that drives severity color)**

Create `src/components/admin/invoices/age-chip.test.tsx`:

```ts
import { ageBucket, daysBetween } from './age-chip';

it('buckets invoice age into green/amber/red at 30 and 60 days', () => {
  expect(ageBucket(10)).toBe('green');
  expect(ageBucket(30)).toBe('amber');
  expect(ageBucket(59)).toBe('amber');
  expect(ageBucket(60)).toBe('red');
});

it('daysBetween counts whole days elapsed', () => {
  const created = new Date('2026-06-01T00:00:00Z');
  const now = new Date('2026-06-11T00:00:00Z');
  expect(daysBetween(created, now)).toBe(10);
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/components/admin/invoices/age-chip.test.tsx`
Expected: FAIL — module not found.

- [ ] **Step 3: Implement age-chip.tsx**

```tsx
'use client';
const DAY_MS = 24 * 60 * 60 * 1000;
export function daysBetween(from: Date, to: Date): number {
  return Math.max(0, Math.floor((to.getTime() - from.getTime()) / DAY_MS));
}
export function ageBucket(days: number): 'green' | 'amber' | 'red' {
  if (days >= 60) return 'red';
  if (days >= 30) return 'amber';
  return 'green';
}
const CLS: Record<string, string> = {
  green: 'bg-emerald-100 text-emerald-700', amber: 'bg-amber-100 text-amber-700',
  red: 'bg-rose-100 text-rose-700',
};
export function AgeChip({ createdAt, state }: { createdAt: string; state: string }) {
  if (state === 'paid') {
    return <span className="inline-flex items-center gap-1.5 rounded-full bg-emerald-100 px-2.5 py-1 text-xs font-semibold text-emerald-700"><span className="size-1.5 rounded-full bg-emerald-600" />Paid</span>;
  }
  const days = daysBetween(new Date(createdAt), new Date());
  const b = ageBucket(days);
  return <span className={`inline-flex items-center gap-1.5 rounded-full px-2.5 py-1 text-xs font-semibold ${CLS[b]}`}><span className="size-1.5 rounded-full bg-current opacity-70" />{days} days</span>;
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/components/admin/invoices/age-chip.test.tsx`
Expected: PASS.

- [ ] **Step 5: Implement `summary-band.tsx`**

A client component `<SummaryBand invoices={InvoiceListItem[]} />` computing, from open invoices (`state !== 'paid' && total-paid > 0`): outstanding total + count; overdue (age ≥ 30) total + count + oldest age. Render three cards (Outstanding / Overdue >30d, red-accented / a placeholder "Collected this month" is out of scope — omit for v1, show only the two computed cards + count chips). Use `formatCentsExact`. Empty → render "—", never `$0.00` when there are zero open invoices? (Zero is a real amount here — show `$0`.)

```tsx
'use client';
import { formatCentsExact } from '@/lib/admin/money-format';
import type { InvoiceListItem } from '@/hooks/use-invoices';
import { daysBetween } from './age-chip';
export function SummaryBand({ invoices }: { invoices: readonly InvoiceListItem[] }) {
  const open = invoices.filter(i => i.state !== 'paid' && i.totalCents - i.amountPaidCents > 0);
  const outstanding = open.reduce((s, i) => s + (i.totalCents - i.amountPaidCents), 0);
  const overdue = open.filter(i => daysBetween(new Date(i.createdAt), new Date()) >= 30);
  const overdueSum = overdue.reduce((s, i) => s + (i.totalCents - i.amountPaidCents), 0);
  const oldest = overdue.reduce((m, i) => Math.max(m, daysBetween(new Date(i.createdAt), new Date())), 0);
  return (
    <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
      <div className="rounded-xl border bg-card p-5">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Outstanding</p>
        <p className="mt-2 font-heading text-2xl font-bold tabular-nums">{formatCentsExact(outstanding)}</p>
        <p className="mt-1 text-xs text-muted-foreground">across {open.length} open invoices</p>
      </div>
      <div className="rounded-xl border border-rose-200 bg-card p-5">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted-foreground">Overdue &gt; 30 days</p>
        <p className="mt-2 font-heading text-2xl font-bold tabular-nums text-rose-600">{formatCentsExact(overdueSum)}</p>
        <p className="mt-1 text-xs text-muted-foreground">{overdue.length} invoices{oldest ? ` · oldest ${oldest} days` : ''}</p>
      </div>
    </div>
  );
}
```

- [ ] **Step 6: Implement `invoice-row.tsx`**

A `<InvoiceRow invoice reminded onRemind>` rendering: monogram (initials from `customerName`, stable hue via a hash of the id), name + linked contact/refs, invoice created date, `<AgeChip>`, balance (`formatCentsExact(total-paid)`, with `of {total}` when partially paid), and the action rail. Rail = a primary `Send reminder` button, or — when `invoice.lastReminderSentAt` is set — a single-text-node `inline-block` `<span>` reading `✓ Reminded {rel}` (compute `rel` from `lastReminderSentAt`), plus a `View` link to `/admin/invoices/{id}`. IMPLEMENTATION NOTE from the design spec: keep the reminded chip a **single text node** span (nesting child spans inside a flex row blockifies the item and blows up its width). `onRemind(id)` calls the hook's `sendReminder` and shows a toast.

(Full JSX mirrors the approved prototype `invoices-mock.html` in scratchpad; match its Tailwind classes to the admin theme tokens.)

- [ ] **Step 7: Rebuild `page.tsx`**

Rewrite `src/app/admin/(dashboard)/invoices/page.tsx`: keep `PageShell`/`PageHeader`/`ReconcileBanner`; add `<SummaryBand>`; replace the plain `<table>` with the filter segment (Overdue default / All / Unpaid / Paid — Overdue computed as age≥30 & open & balance>0), a search box (customer name or the id prefix), the overdue-first sort (`sort by daysBetween desc, paid last`), and `<InvoiceRow>` rows. Wire `sendReminder` from `useInvoices`; on success show a toast (reuse the app's toast — grep `toast(` usage) reading "Reminder sent to {name}". Keep the existing loading skeleton and filter-aware empty state.

- [ ] **Step 8: Type-check, lint, run tests**

Run: `npx tsc --noEmit` (expect 0); `npx eslint src/components/admin/invoices src/app/admin/\(dashboard\)/invoices/page.tsx` (expect 0 errors); `npx vitest run src/components/admin/invoices` (expect PASS).

- [ ] **Step 9: Commit**

```bash
git add src/components/admin/invoices src/app/admin/\(dashboard\)/invoices/page.tsx
git commit -m "feat(invoices): collections list — summary band, aging, one-click reminders"
```

---

## Self-Review notes (addressed)

- **Spec coverage:** age-based overdue (Task 6 `ageBucket`), one-click reminder through the comms queue with pay link (Task 3), customer name join (Task 2), `last_reminder_sent_at` (Task 1/decision confirmed IN), summary band + sorted list + rail + reminded chip (Task 6). The **detail page** is intentionally a **separate follow-up plan** (`2026-07-06-invoice-collections-detail.md`) — it's an independent deliverable and keeps this plan shippable on its own.
- **Reuse:** the reminder path reuses `money-triggers` helpers rather than re-implementing consent/template/queue logic; only the pay-link + cooldown + stamp are new. The existing weekly dunning sweep is unchanged.
- **Verify-before-code hooks:** Task 4 flags two names to confirm against the codebase (`RATE_LIMITS.adminWrite`, `logAudit` signature) rather than assuming them.

## Out of scope (this plan)
- Detail page rebuild (separate plan).
- "Collected this month" summary tile (needs the payments aggregate — add later).
- Bulk chase; email-channel reminders; net-terms due dates.
