# Invoice Collections — Void invoice (Phase 5)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let an admin void a native, unpaid open/draft invoice from the collections list — a guarded money-state mutation with a confirmation step.

**Architecture:** A guarded `voidInvoice` query (read to classify the failure reason, then an atomic guarded `UPDATE ... RETURNING` that re-checks every guard) sets `state='void'`. A POST endpoint mirrors the existing send-reminder route (session gate, rate limit, reason→status, audit). The hook exposes `voidInvoice(id)`. The row's `⋯` menu gains a destructive "Void invoice" item that opens a confirmation dialog before calling it.

**Tech Stack:** Next.js 16 App Router, Drizzle ORM over Neon Postgres HTTP, React client components, Base UI Dialog/DropdownMenu, Vitest (node env).

## Global Constraints

- **Voidable = native (fieldpulseInvoiceId AND hcpInvoiceId both null) AND `state ∈ {open, draft}` AND `amountPaidCents === 0`.** A synced invoice, a paid/void/refunded one, or one with ANY payment recorded is NOT voidable (money against it must be refunded first, not voided).
- **Neon HTTP:** no transactions/row locks. Use the atomic claim pattern — a guarded `UPDATE ... WHERE <all guards> RETURNING`; if no row returns, the guard failed (treat as not-voidable). Every query `withTenant`-scoped; org from `session.organizationId`, never the client.
- Enum: `draft|open|paid|void|refunded` (`invoiceStateEnum`). Void is a terminal state.
- Mirror the existing route conventions verbatim from `src/app/api/admin/invoices/[id]/send-reminder/route.ts`: `getAdminSession`→401, `slidingWindow(RATE_LIMITS.adminMutation…)`→429, `params: Promise<{id}>`, a `REASON_STATUS` map, `logAudit({ organizationId, userId, action, entity, entityId })`, `successResponse`/`errorResponse`.
- No new dependencies. node-env tests (query + route helpers tested; components not render-tested).
- Pure helpers a client imports must live in a db/server-only-free module. **Run `npx next build` in the final gate** (tsc does not catch server-only leaks).
- Commit style: conventional commits, NO Co-Authored-By trailer.

---

## File Structure

- `src/lib/admin/invoice-queries.ts` — NEW `voidInvoice(orgId, id, now?)`.
- `src/app/api/admin/invoices/[id]/void/route.ts` — NEW POST endpoint.
- `src/hooks/use-invoices.ts` — expose `voidInvoice(id)`.
- `src/components/admin/invoices/invoice-row.tsx` — `⋯` "Void invoice" item + `onVoid` prop.
- `src/app/admin/(dashboard)/invoices/page.tsx` — confirm dialog + `handleVoid`.

---

### Task 1: `voidInvoice` query + endpoint + hook

**Files:**
- Modify: `src/lib/admin/invoice-queries.ts` (add `voidInvoice`)
- Create: `src/app/api/admin/invoices/[id]/void/route.ts`
- Modify: `src/hooks/use-invoices.ts`
- Test: `src/lib/admin/void-invoice.test.ts` (create) — add cases to the existing `invoice-queries-list.test.ts` mock IF a standalone file would need to re-mock the whole module; prefer extending `invoice-queries-list.test.ts` (it already mocks the module). Add `isNull` and `inArray` to its `drizzle-orm` mock and `updatedAt`/`state`/`amountPaidCents`/`fieldpulseInvoiceId`/`hcpInvoiceId` to its `invoices` schema mock as needed.

**Interfaces:**
- Produces: `voidInvoice(organizationId: string, invoiceId: string, now?: Date): Promise<{ ok: true } | { ok: false; reason: "not_found" | "synced_read_only" | "not_voidable" | "has_payments" }>`. The endpoint is `POST /api/admin/invoices/[id]/void`. `use-invoices` gains `voidInvoice(id): Promise<{ ok: boolean; reason?: string }>`.

- [ ] **Step 1: Write the failing test**

Add to `src/lib/admin/invoice-queries-list.test.ts` (extend its drizzle mock with `isNull: (c) => ({ kind:'isNull', c })` and `inArray: (c, arr) => ({ kind:'inArray', c, arr })`; ensure the `invoices` schema mock has `state`, `amountPaidCents`, `fieldpulseInvoiceId`, `hcpInvoiceId`, `updatedAt`):
```ts
import { voidInvoice } from './invoice-queries';

describe('voidInvoice', () => {
  const openNative = { state: 'open', amountPaidCents: 0, fieldpulseInvoiceId: null, hcpInvoiceId: null };
  it('voids a native, unpaid, open invoice (atomic claim returns a row)', async () => {
    selectQueue.push([openNative]);      // the classify read
    selectQueue.push([{ id: 'i1' }]);    // the guarded UPDATE ... RETURNING
    expect(await voidInvoice('org-1', 'i1')).toEqual({ ok: true });
  });
  it('refuses a synced invoice', async () => {
    selectQueue.push([{ ...openNative, fieldpulseInvoiceId: 'fp1' }]);
    expect(await voidInvoice('org-1', 'i1')).toEqual({ ok: false, reason: 'synced_read_only' });
  });
  it('refuses an invoice with payments', async () => {
    selectQueue.push([{ ...openNative, amountPaidCents: 5000 }]);
    expect(await voidInvoice('org-1', 'i1')).toEqual({ ok: false, reason: 'has_payments' });
  });
  it('refuses a paid/terminal invoice', async () => {
    selectQueue.push([{ ...openNative, state: 'paid' }]);
    expect(await voidInvoice('org-1', 'i1')).toEqual({ ok: false, reason: 'not_voidable' });
  });
  it('returns not_found when the invoice is absent', async () => {
    selectQueue.push([]);
    expect(await voidInvoice('org-1', 'i1')).toEqual({ ok: false, reason: 'not_found' });
  });
  it('returns not_voidable when the atomic claim loses the race (no row returned)', async () => {
    selectQueue.push([openNative]); // classify passes
    selectQueue.push([]);            // UPDATE returns nothing
    expect(await voidInvoice('org-1', 'i1')).toEqual({ ok: false, reason: 'not_voidable' });
  });
});
```
Note the chainable-proxy mock resolves `.returning()` from the same `selectQueue`; if the mock's `db.update` path doesn't feed from `selectQueue`, adapt these pushes to whatever the file's mock uses for update-returning (read the mock first and mirror the pattern used by other update-based tests, e.g. in `send-invoice-reminder.test.ts`).

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/lib/admin/invoice-queries-list.test.ts` → FAIL (`voidInvoice` missing).

- [ ] **Step 3: Implement the query**

In `src/lib/admin/invoice-queries.ts` (ensure `isNull` and `inArray` are imported from `drizzle-orm` — `inArray` already is; add `isNull` if missing):
```ts
/**
 * Voids a NATIVE, unpaid, open/draft invoice (terminal state). Refuses synced
 * invoices (money owned externally), invoices with any recorded payment (refund
 * first), and already-terminal states. Read classifies the failure reason; the
 * guarded UPDATE ... RETURNING re-checks every guard for atomicity (neon-http
 * has no row locks).
 */
export async function voidInvoice(
  organizationId: string,
  invoiceId: string,
  now: Date = new Date(),
): Promise<
  | { ok: true }
  | { ok: false; reason: "not_found" | "synced_read_only" | "not_voidable" | "has_payments" }
> {
  const [inv] = await db
    .select({
      state: invoices.state,
      amountPaidCents: invoices.amountPaidCents,
      fieldpulseInvoiceId: invoices.fieldpulseInvoiceId,
      hcpInvoiceId: invoices.hcpInvoiceId,
    })
    .from(invoices)
    .where(withTenant(invoices, organizationId, eq(invoices.id, invoiceId)))
    .limit(1);

  if (!inv) return { ok: false, reason: "not_found" };
  if (inv.fieldpulseInvoiceId || inv.hcpInvoiceId) return { ok: false, reason: "synced_read_only" };
  if (inv.state !== "open" && inv.state !== "draft") return { ok: false, reason: "not_voidable" };
  if (inv.amountPaidCents > 0) return { ok: false, reason: "has_payments" };

  const [claimed] = await db
    .update(invoices)
    .set({ state: "void", updatedAt: now })
    .where(
      withTenant(
        invoices,
        organizationId,
        eq(invoices.id, invoiceId),
        inArray(invoices.state, ["open", "draft"]),
        eq(invoices.amountPaidCents, 0),
        isNull(invoices.fieldpulseInvoiceId),
        isNull(invoices.hcpInvoiceId),
      ),
    )
    .returning({ id: invoices.id });

  if (!claimed) return { ok: false, reason: "not_voidable" };
  return { ok: true };
}
```

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run src/lib/admin/invoice-queries-list.test.ts` → PASS.

- [ ] **Step 5: Create the endpoint**

Create `src/app/api/admin/invoices/[id]/void/route.ts` mirroring the send-reminder route:
```ts
import { NextRequest } from "next/server";
import { getAdminSession } from "@/lib/auth/session";
import { voidInvoice } from "@/lib/admin/invoice-queries";
import { logAudit } from "@/lib/admin/audit";
import { successResponse, errorResponse } from "@/lib/api-response";
import { slidingWindow, RATE_LIMITS } from "@/lib/rate-limit";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

const REASON_STATUS: Record<string, number> = {
  not_found: 404,
  synced_read_only: 409,
  not_voidable: 409,
  has_payments: 409,
};

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> },
) {
  try {
    const session = await getAdminSession();
    if (!session) return errorResponse("Unauthorized", "UNAUTHORIZED", 401);

    const rateCheck = slidingWindow(
      `admin:invoice-void:${session.userId}`,
      RATE_LIMITS.adminMutation.maxRequests,
      RATE_LIMITS.adminMutation.windowMs,
    );
    if (!rateCheck.allowed) {
      return errorResponse("Rate limit exceeded", "RATE_LIMITED", 429);
    }

    const { id } = await params;
    const result = await voidInvoice(session.organizationId, id);

    if (!result.ok) {
      return errorResponse(
        "Could not void invoice",
        result.reason.toUpperCase(),
        REASON_STATUS[result.reason] ?? 400,
      );
    }

    await logAudit({
      organizationId: session.organizationId,
      userId: session.userId,
      action: "invoice.voided",
      entity: "invoice",
      entityId: id,
    });

    return successResponse({ ok: true });
  } catch (error) {
    logger.error({ error }, "Failed to void invoice");
    return errorResponse("Internal server error", "INTERNAL_ERROR", 500);
  }
}
```

- [ ] **Step 6: Wire the hook**

In `src/hooks/use-invoices.ts`, add `voidInvoice: (id: string) => Promise<{ ok: boolean; reason?: string }>` to `UseInvoicesResult`, implement it modeled EXACTLY on the existing `sendReminder` (POST `/api/admin/invoices/${id}/void`, on success `await fetchAll()` and return `{ ok: true }`, else `{ ok: false, reason: body.error?.code }`), and return it.

- [ ] **Step 7: Run tests, tsc, lint, commit**

Run `npx vitest run src/lib/admin/invoice-queries-list.test.ts` (PASS), `npx tsc --noEmit` (0), `npx eslint src/lib/admin/invoice-queries.ts "src/app/api/admin/invoices/[id]/void/route.ts" src/hooks/use-invoices.ts` (0 errors). Then:
```bash
git add src/lib/admin/invoice-queries.ts src/lib/admin/invoice-queries-list.test.ts "src/app/api/admin/invoices/[id]/void/route.ts" src/hooks/use-invoices.ts
git commit -m "feat(invoices): void endpoint for native unpaid open/draft invoices"
```

---

### Task 2: `⋯` "Void invoice" item + confirmation dialog

**Files:**
- Modify: `src/components/admin/invoices/invoice-row.tsx` (`⋯` menu + `onVoid` prop)
- Modify: `src/app/admin/(dashboard)/invoices/page.tsx` (confirm dialog + `handleVoid`)

**Interfaces:**
- Consumes: `voidInvoice` from `useInvoices` (Task 1); the Base UI `Dialog` primitive (`@/components/ui/dialog`).
- Produces: row `onVoid: (id: string) => void` prop.

- [ ] **Step 1: Add the destructive menu item**

In `invoice-row.tsx`, add `onVoid: (id: string) => void` to `InvoiceRowProps` and destructure it. In the `⋯` `DropdownMenuContent`, AFTER the "Copy pay link" item, add (only for native, non-terminal invoices):
```tsx
{invoice.syncedSource === null &&
  invoice.state !== 'paid' &&
  invoice.state !== 'void' &&
  invoice.state !== 'refunded' && (
    <DropdownMenuItem
      variant="destructive"
      onClick={() => onVoid(invoice.id)}
    >
      Void invoice
    </DropdownMenuItem>
  )}
```
(`DropdownMenuItem` accepts `variant="destructive"` per its definition — verify in `dropdown-menu.tsx`; if it does not, use `className="text-destructive"` instead.)

- [ ] **Step 2: Confirmation dialog + handler in the page**

In `src/app/admin/(dashboard)/invoices/page.tsx`:
- Import the Dialog primitive: `import { Dialog, DialogContent, DialogHeader, DialogTitle, DialogDescription, DialogFooter, DialogClose } from '@/components/ui/dialog';` and `Button`, and `invoiceRef` from `@/lib/admin/invoice-collectible`.
- Destructure `voidInvoice` from `useInvoices()`.
- Add state: `const [voidingId, setVoidingId] = useState<string | null>(null);` and `const [voidBusy, setVoidBusy] = useState(false);`
- Row `onVoid`: `onVoid={(id) => setVoidingId(id)}` (opens the dialog).
- Add `handleVoidConfirm`:
```tsx
async function handleVoidConfirm() {
  if (!voidingId) return;
  setVoidBusy(true);
  try {
    const result = await voidInvoice(voidingId);
    showFlash(result.ok ? 'Invoice voided' : 'Could not void this invoice', result.ok);
  } finally {
    setVoidBusy(false);
    setVoidingId(null);
  }
}
```
- Render the dialog (controlled by `voidingId`), e.g. near the flash/list:
```tsx
<Dialog open={voidingId !== null} onOpenChange={(open) => { if (!open) setVoidingId(null); }}>
  <DialogContent>
    <DialogHeader>
      <DialogTitle>Void this invoice?</DialogTitle>
      <DialogDescription>
        {voidingId ? `${invoiceRef(voidingId)} will be marked void and can no longer be collected. This can't be undone.` : ''}
      </DialogDescription>
    </DialogHeader>
    <DialogFooter>
      <DialogClose render={<Button variant="outline" />}>Cancel</DialogClose>
      <Button variant="destructive" disabled={voidBusy} onClick={handleVoidConfirm}>
        {voidBusy ? 'Voiding…' : 'Void invoice'}
      </Button>
    </DialogFooter>
  </DialogContent>
</Dialog>
```
VERIFY the Dialog's controlled-open API against `dialog.tsx` (Base UI uses `open`/`onOpenChange` on the root; `DialogClose`/`DialogContent` may use `render` for composition — check an existing Dialog usage in the codebase, e.g. `grep -rl DialogContent src/components src/app`, and mirror its prop shape). Adjust prop names to match the primitive; do not invent props.

- [ ] **Step 3: tsc, lint, commit**

Run `npx tsc --noEmit` (0), `npx eslint src/components/admin/invoices/invoice-row.tsx "src/app/admin/(dashboard)/invoices/page.tsx"` (0 errors). Then:
```bash
git add src/components/admin/invoices/invoice-row.tsx "src/app/admin/(dashboard)/invoices/page.tsx"
git commit -m "feat(invoices): void invoice from the row menu with confirmation"
```

---

## Self-Review notes (addressed)

- **Guard parity:** `voidInvoice` mirrors `takePayment`'s synced/state guards and ADDS the zero-payments guard; the atomic `UPDATE ... RETURNING` re-checks all guards so a concurrent payment can't slip a void through.
- **Reason→status:** synced/not-voidable/has-payments are 409 (state conflict), not_found 404 — consistent with the send-reminder route's shape.
- **Type consistency:** the `{ ok, reason }` union is identical across query → endpoint `REASON_STATUS` → hook.
- **Primitive-API risk flagged:** both the DropdownMenu `variant="destructive"` and the Dialog controlled-open/`render` props must be verified against the actual Base UI wrappers (they are NOT Radix — `asChild` does not exist; composition uses `render`).
- **Final gate:** `npx next build` after both tasks (Dialog is a new client-primitive usage; the hook/route boundary is touched).

## Out of scope (still deferred)
- Record-payment inline from the list (detail page already handles take-payment).
- Reminder-history LOG table (migration); email-channel reminders; bulk chase; per-org tagline.
- Un-void / restore (void is terminal by design).
