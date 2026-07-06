# Invoice Collections — Detail Page Implementation Plan (Phase 2)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rebuild the single-invoice detail page into a real service-invoice *document* (logo, meta box, job-performed-by, service address, itemized table, totals) wrapped in collections chrome (status + Send reminder / Copy pay link / Take payment toolbar, and a collections + activity sidebar) — matching the approved mock, without breaking the existing take-payment / refund flows.

**Architecture:** Extend `getInvoiceDetailById` to also return the joined display data the document needs (customer name/address/phone, technician name, service date, last-reminded) plus a small org-identity fetch. Add a tiny `POST /pay-link` endpoint that mints a portal token and returns the URL (reusing `generatePortalToken`). Rebuild `invoice-detail-client.tsx` into focused presentational pieces (invoice document + collections sidebar) while preserving its existing money-action handlers verbatim. Reuse the Phase-1 `send-reminder` endpoint.

**Tech Stack:** Next.js 16 App Router, Drizzle ORM over Neon Postgres HTTP, React client components, Vitest.

## Global Constraints

- **Neon HTTP has NO transactions and NO row locks.** No `db.transaction()`.
- **Multi-tenancy:** every query scoped with `withTenant(table, orgId, ...)`; joins carry their own org predicate.
- **PII encrypted at rest:** decrypt name/address/phone with `decrypt` from `@/lib/crypto`, wrapped in try/catch → null (reuse the existing `safeDecryptName` pattern in `invoice-queries.ts`; add address/phone variants the same way).
- **Money is cents;** display via `formatCentsExact` from `@/lib/admin/money-format`.
- **Synced (FieldPulse/HCP) invoices are read-only in money flows** — the existing take-payment/refund guards MUST remain; do not enable money mutations for `syncedSource !== null`.
- **Admin API routes:** `getAdminSession()` gate (401), rate-limit, `successResponse`/`errorResponse` envelopes.
- **Overdue is age-based** (no stored due date) — consistent with Phase 1. Do NOT add a `due_date` column; a displayed "Due date" is computed display-only (createdAt + 30 days) or omitted (see Task 3 decision).
- **Reuse Phase-1 building blocks:** the `last_reminder_sent_at` column, `sendInvoiceReminder`, `POST /api/admin/invoices/[id]/send-reminder`, `AgeChip`/`daysBetween`/`ageBucket` from `src/components/admin/invoices/age-chip.tsx`.
- **Commit style:** conventional commits, NO Co-Authored-By trailer.
- **TDD:** failing test first. Query tests use the chainable-proxy DB mock (see `src/lib/admin/invoice-queries-list.test.ts`).
- **No new dependencies.** The mock's visuals translate to existing Tailwind theme tokens.

---

## File Structure

- `src/lib/admin/invoice-queries.ts` — extend `InvoiceDetailView` + `getInvoiceDetailById` with display joins; add an `InvoiceOrgIdentity` fetch (modify).
- `src/app/api/admin/invoices/[id]/pay-link/route.ts` — POST mint pay link (create).
- `src/hooks/use-invoice-detail.ts` — if the detail client currently fetches inline, factor the fetch + new fields + `sendReminder`/`copyPayLink` here; otherwise extend the existing fetch (modify/create — Task decides based on current code).
- `src/components/admin/invoices/invoice-document.tsx` — the presentational "paper" (create).
- `src/components/admin/invoices/invoice-collections-side.tsx` — collections + activity sidebar (create).
- `src/components/admin/invoices/invoice-detail-client.tsx` — re-layout into toolbar + document + sidebar; KEEP the existing take-payment/refund handlers (modify).
- Tests colocated.

---

### Task 1: Extend the detail query with document display data

**Files:**
- Modify: `src/lib/admin/invoice-queries.ts` (`InvoiceDetailView` ~L804, `getInvoiceDetailById` ~L839)
- Test: `src/lib/admin/invoice-detail-query.test.ts` (create)

**Interfaces:**
- Consumes: `invoices`, `customers`, `serviceRequests`, `users` tables; `withTenant`; `decrypt`.
- Produces: `InvoiceDetailView` additionally has:
  `customerName: string | null`, `customerAddress: string | null`, `customerPhone: string | null`, `technicianName: string | null`, `serviceDate: Date | null`, `lastReminderSentAt: Date | null`.

- [ ] **Step 1: Write the failing test**

Create `src/lib/admin/invoice-detail-query.test.ts` copying the mock scaffolding from `src/lib/admin/invoice-queries-list.test.ts` (the `vi.hoisted`/`chain`/`vi.mock('@/lib/db')`/`vi.mock('@/lib/db/tenant')`/`drizzle-orm`/`@/lib/crypto` blocks). Mock `@/lib/db/schema` to include `invoices`, `invoiceLineItems`, `payments`, `refunds`, `customers` (with `nameEncrypted`,`addressEncrypted`,`phoneEncrypted`,`organizationId`), `serviceRequests` (with `id`,`assignedTo`,`scheduledDate`,`organizationId`), `users` (with `id`,`name`,`organizationId`). Queue: the invoice row (with joined `nameEncrypted:'EN'`, `addressEncrypted:'EA'`, `phoneEncrypted:'EP'`, `technicianName:'Davis Reed'`, `serviceDate:new Date('2026-04-22')`, `lastReminderSentAt:new Date('2026-07-03')`), then empty line-items, empty payments.

```ts
import { getInvoiceDetailById } from './invoice-queries';

it('returns decrypted customer identity + technician + service date on the detail view', async () => {
  // (queue rows per the scaffolding above)
  const v = await getInvoiceDetailById('org-1', 'i1');
  expect(v?.customerName).toBe('dec(EN)');
  expect(v?.customerAddress).toBe('dec(EA)');
  expect(v?.customerPhone).toBe('dec(EP)');
  expect(v?.technicianName).toBe('Davis Reed');
  expect(v?.serviceDate).toEqual(new Date('2026-04-22'));
  expect(v?.lastReminderSentAt).toEqual(new Date('2026-07-03'));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npx vitest run src/lib/admin/invoice-detail-query.test.ts`
Expected: FAIL — `customerName` undefined on the view.

- [ ] **Step 3: Extend the type and the invoice SELECT**

In `InvoiceDetailView` (`~L804`) add:
```ts
  readonly customerName: string | null;
  readonly customerAddress: string | null;
  readonly customerPhone: string | null;
  readonly technicianName: string | null;
  readonly serviceDate: Date | null;
  readonly lastReminderSentAt: Date | null;
```

In `getInvoiceDetailById`, extend the first `db.select({...})` to LEFT JOIN `customers` (name/address/phone encrypted, org-scoped), `serviceRequests` (org-scoped, for `serviceDate`), and `users` (the technician via `serviceRequests.assignedTo`, org-scoped). Add these selected columns:
```ts
      nameEncrypted: customers.nameEncrypted,
      addressEncrypted: customers.addressEncrypted,
      phoneEncrypted: customers.phoneEncrypted,
      technicianName: users.name,
      serviceDate: serviceRequests.scheduledDate,
      lastReminderSentAt: invoices.lastReminderSentAt,
```
and the joins (after `.from(invoices)`):
```ts
    .leftJoin(customers, and(eq(customers.id, invoices.customerId), eq(customers.organizationId, organizationId)))
    .leftJoin(serviceRequests, and(eq(serviceRequests.id, invoices.serviceRequestId), eq(serviceRequests.organizationId, organizationId)))
    .leftJoin(users, and(eq(users.id, serviceRequests.assignedTo), eq(users.organizationId, organizationId)))
```
When building the returned object, decrypt the three encrypted fields with the existing `safeDecryptName` helper (rename its use or add `safeDecrypt` — it already handles null/try-catch; reuse it for all three), and pass through `technicianName`, `serviceDate`, `lastReminderSentAt`. Ensure `customers`, `serviceRequests`, `users` are imported from `@/lib/db/schema` and `and` from `drizzle-orm` (add any missing).

NOTE: `serviceRequests.scheduledDate` and `serviceRequests.assignedTo` and `users.name` are the real column names (confirmed in schema). If any differs, use the real one and note it.

- [ ] **Step 4: Run test to verify it passes**

Run: `npx vitest run src/lib/admin/invoice-detail-query.test.ts`
Expected: PASS.

- [ ] **Step 5: Type-check and commit**

Run: `npx tsc --noEmit` (expect 0), then:
```bash
git add src/lib/admin/invoice-queries.ts src/lib/admin/invoice-detail-query.test.ts
git commit -m "feat(invoices): detail query joins customer, technician, service date"
```

---

### Task 2: Org identity + `POST /pay-link` endpoint

**Files:**
- Modify: `src/lib/admin/invoice-queries.ts` (add `getInvoiceOrgIdentity`)
- Create: `src/app/api/admin/invoices/[id]/pay-link/route.ts`
- Test: `tests/api/invoice-pay-link.test.ts` (create)

**Interfaces:**
- Produces: `getInvoiceOrgIdentity(organizationId): Promise<{ companyName: string; address: string | null; phone: string | null }>` reading `organizationSettings`. And a `POST` route that mints a portal token for the invoice's customer and returns `{ payLink: string }`.

- [ ] **Step 1: Confirm the org identity columns**

Read `organizationSettings` in `src/lib/db/schema.ts` (~L965). Confirm which columns hold the company name, business address, and phone (e.g. `companyName`, and address/phone fields — `onboarding-queries.ts:59` selects `companyName`). Use the REAL column names in `getInvoiceOrgIdentity`; if there is no address column, return `address: null` and render only what exists. Record what you found.

- [ ] **Step 2: Implement `getInvoiceOrgIdentity`**

Add to `invoice-queries.ts`:
```ts
export async function getInvoiceOrgIdentity(
  organizationId: string,
): Promise<{ companyName: string; address: string | null; phone: string | null }> {
  const [row] = await db
    .select({
      companyName: organizationSettings.companyName,
      // use the REAL address/phone columns confirmed in Step 1, or omit:
      // address: organizationSettings.<addressCol>,
      // phone: organizationSettings.<phoneCol>,
    })
    .from(organizationSettings)
    .where(eq(organizationSettings.organizationId, organizationId))
    .limit(1);
  return {
    companyName: row?.companyName ?? "Your Company",
    address: /* row?.<addressCol> ?? */ null,
    phone: /* row?.<phoneCol> ?? */ null,
  };
}
```
Import `organizationSettings` from `@/lib/db/schema`.

- [ ] **Step 3: Write the failing pay-link route test**

Create `tests/api/invoice-pay-link.test.ts`. Mock `@/lib/auth/session` (admin), `@/lib/rate-limit` (allowed), and a query that returns the invoice's `customerId`, plus `@/lib/portal/portal-queries` (`generatePortalToken: vi.fn(async () => 'TOK')`). Set `process.env.NEXT_PUBLIC_APP_URL = 'https://app.test'`.
```ts
it('mints a pay link for the invoice customer', async () => {
  const res = await POST(req(), { params: Promise.resolve({ id: 'i1' }) } as any);
  const body = await res.json();
  expect(res.status).toBe(200);
  expect(body.data.payLink).toBe('https://app.test/portal/TOK');
});
it('401 when not admin', async () => { /* getAdminSession → null → 401 */ });
```

- [ ] **Step 4: Run to verify it fails, then implement the route**

Run: `npx vitest run tests/api/invoice-pay-link.test.ts` → FAIL (no route).
Create `src/app/api/admin/invoices/[id]/pay-link/route.ts`: `getAdminSession` gate (401), rate-limit (`RATE_LIMITS.adminMutation`), load the invoice's `customerId` tenant-scoped (404 if missing/no customer), `generatePortalToken(session.organizationId, customerId)` → build `${NEXT_PUBLIC_APP_URL?.replace(/\/$/,'')}/portal/${token}` (404/400 if token null), return `successResponse({ payLink })`. Mirror the `send-reminder` route's structure (`src/app/api/admin/invoices/[id]/send-reminder/route.ts`) for the gate/params/error shape.

- [ ] **Step 5: Run to verify pass, tsc, commit**

Run the test (PASS), `npx tsc --noEmit` (0), then:
```bash
git add src/lib/admin/invoice-queries.ts "src/app/api/admin/invoices/[id]/pay-link/route.ts" tests/api/invoice-pay-link.test.ts
git commit -m "feat(invoices): org identity + copy-pay-link endpoint"
```

---

### Task 3: Invoice document component

**Files:**
- Create: `src/components/admin/invoices/invoice-document.tsx`
- Test: `src/components/admin/invoices/invoice-document.test.tsx`

**Interfaces:**
- Consumes: the `InvoiceDetailView` fields (Task 1) + `{ companyName, address, phone }` (Task 2), `formatCentsExact`.
- Produces: `<InvoiceDocument invoice={InvoiceDetailView} org={OrgIdentity} />` — the presentational paper: logo lockup + company lines, a bordered meta box (Invoice #, Service date, Invoice date, Due date, Amount due), Job-performed-by + Service address, the line-item table (Description / Qty·Hrs / Unit price·Rate / Amount), Notes + totals (Subtotal / Tax / Total / Amount paid / Balance due).

**Design decisions (resolve the mock's data gaps):**
- **Invoice #:** use `invoiceRef(invoice.id)` (from `money-triggers.ts`) — there is no numeric invoice number. Export `invoiceRef` if not already exported, or duplicate the 1-line helper locally.
- **Invoice date** = `createdAt`. **Service date** = `serviceDate` (nullable → omit that meta row when null). **Due date** = display-only `createdAt + 30 days` labeled "Net 30" (age-based; not stored). **Amount due** = `totalCents - amountPaidCents`, red when > 0.
- **Job performed by** = `technicianName` (omit the block when null). **Service address** = `customerName` + `customerAddress` + `customerPhone` (render available lines only).
- Reference the approved mock for layout: `/private/tmp/claude-501/-Users-sizbei-Documents-GitHub-ai-hvac-agent/fd176dae-c5fb-4716-b3c2-66644193ea95/scratchpad/invoice-detail-mock.html`. Translate to the app's Tailwind theme tokens (no raw hex).

- [ ] **Step 1: Write the failing test (the money-math the document displays)**

```tsx
import { render, screen } from '@testing-library/react';
import { InvoiceDocument } from './invoice-document';

const base = { id: '1042abcd', state: 'open', subtotalCents: 227000, taxCents: 21000,
  totalCents: 248000, amountPaidCents: 0, customerName: 'Marta Delgado',
  customerAddress: '118 Ash St', customerPhone: '(423) 555-0148',
  technicianName: 'Davis Reed', serviceDate: new Date('2026-04-22'),
  createdAt: new Date('2026-04-23'), lastReminderSentAt: null, serviceRequestId: 'sr1',
  customerId: 'c1', estimateId: null, syncedSource: null,
  lineItems: [{ id:'l1', name:'Condenser fan motor', quantity:1, unitPriceCents:124000, costCents:0, lineTotalCents:124000 }],
  payments: [], actualMaterialsCostCents: null } as any;

it('renders balance due = total - amount paid', () => {
  render(<InvoiceDocument invoice={base} org={{ companyName:'Spears Services', address:null, phone:null }} />);
  expect(screen.getByText('Balance due')).toBeInTheDocument();
  expect(screen.getAllByText('$2,480.00').length).toBeGreaterThan(0);
});
it('omits Job performed by when technician is null', () => {
  render(<InvoiceDocument invoice={{ ...base, technicianName: null }} org={{ companyName:'X', address:null, phone:null }} />);
  expect(screen.queryByText(/Job performed by/i)).toBeNull();
});
```
(Confirm the project's React test setup — `@testing-library/react` + jsdom — is configured; the age-chip test from Phase 1 proves `.tsx` component tests run. Match its imports.)

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run src/components/admin/invoices/invoice-document.test.tsx` → FAIL (no module).

- [ ] **Step 3: Implement `invoice-document.tsx`**

Build the presentational component per the design decisions above, using theme tokens and `formatCentsExact`. Pure display — no data fetching, no handlers. Keep it one focused file.

- [ ] **Step 4: Run to verify pass**

Run the test → PASS.

- [ ] **Step 5: tsc, lint, commit**

Run `npx tsc --noEmit` (0) and `npx eslint src/components/admin/invoices/invoice-document.tsx` (0 errors), then:
```bash
git add src/components/admin/invoices/invoice-document.tsx src/components/admin/invoices/invoice-document.test.tsx
git commit -m "feat(invoices): invoice document (real-invoice layout)"
```

---

### Task 4: Collections sidebar component

**Files:**
- Create: `src/components/admin/invoices/invoice-collections-side.tsx`
- Test: `src/components/admin/invoices/invoice-collections-side.test.tsx`

**Interfaces:**
- Consumes: `InvoiceDetailView` (`createdAt`, `state`, `totalCents`, `amountPaidCents`, `lastReminderSentAt`, `payments`), `daysBetween` from `age-chip.tsx`, `formatCentsExact`.
- Produces: `<InvoiceCollectionsSide invoice={InvoiceDetailView} />` — a **Collections** panel (Days overdue = `daysBetween(createdAt, now)` when open+overdue else "—", Last reminded = relative time of `lastReminderSentAt` or "Not yet") and an **Activity** panel (a timeline built from REAL events only: invoice created (`createdAt`), each payment (`payments[].createdAt`), each refund, and the last reminder (`lastReminderSentAt`) — sorted newest first). Do NOT invent a "reminders sent count"; only `lastReminderSentAt` exists.

- [ ] **Step 1: Write the failing test**

```tsx
import { render, screen } from '@testing-library/react';
import { InvoiceCollectionsSide } from './invoice-collections-side';
it('shows days overdue and a "reminded" activity entry when lastReminderSentAt is set', () => {
  const now = new Date();
  const created = new Date(now.getTime() - 40*24*3600*1000);
  render(<InvoiceCollectionsSide invoice={{ createdAt: created.toISOString?.() ?? created, state:'open',
    totalCents: 5000, amountPaidCents: 0, lastReminderSentAt: new Date(now.getTime()-3*24*3600*1000),
    payments: [] } as any} />);
  expect(screen.getByText(/overdue/i)).toBeInTheDocument();
  expect(screen.getByText(/remind/i)).toBeInTheDocument();
});
```

- [ ] **Step 2: Run to verify fail; Step 3: implement; Step 4: run to verify pass.**

Implement the two panels per the interface. Reuse `daysBetween`. Relative-time helper: a small local `rel(date)` returning "3d ago"/"just now" (or reuse `src/lib/admin/relative-time.ts` if it exists — check and prefer it).

- [ ] **Step 5: tsc, lint, commit**

`npx tsc --noEmit` (0), `npx eslint src/components/admin/invoices/invoice-collections-side.tsx` (0 errors), then:
```bash
git add src/components/admin/invoices/invoice-collections-side.tsx src/components/admin/invoices/invoice-collections-side.test.tsx
git commit -m "feat(invoices): collections + activity sidebar"
```

---

### Task 5: Re-layout the detail client (preserve money flows)

**Files:**
- Modify: `src/components/admin/invoices/invoice-detail-client.tsx`

**Interfaces:**
- Consumes: `InvoiceDocument` (Task 3), `InvoiceCollectionsSide` (Task 4), the extended detail fetch (Task 1 fields + Task 2 org identity), the Phase-1 `sendReminder` path, the Task-2 pay-link endpoint.

- [ ] **Step 1: Read the current client carefully**

Read `src/components/admin/invoices/invoice-detail-client.tsx` in full. Identify: how it fetches the invoice (inline `fetch` or a hook), and the EXISTING take-payment and refund handlers/state. These money handlers MUST be preserved verbatim — the re-layout only moves them, it does not rewrite them.

- [ ] **Step 2: Extend the fetch for the new fields + org identity**

Ensure the detail API returns the Task-1 fields and the Task-2 org identity (extend the GET `/api/admin/invoices/[id]` route response to include `getInvoiceOrgIdentity` output alongside the detail view; confirm the route's current shape first). Update the client's fetched-data types accordingly.

- [ ] **Step 3: Re-layout into toolbar + document + sidebar**

Restructure the render into: (a) a top **toolbar** — back link, a status chip (Overdue Nd / Paid / Open via existing `InvoiceStateBadge` + age), and actions: **Send reminder** (POST the Phase-1 `/send-reminder`, inline confirmation, disabled while pending, hidden for `syncedSource !== null` and for paid), **Copy pay link** (POST the Task-2 `/pay-link`, `navigator.clipboard.writeText(payLink)`, confirmation; hidden for synced), **Take payment** (opens the EXISTING take-payment UI — unchanged, still guarded to native invoices); (b) `<InvoiceDocument>`; (c) `<InvoiceCollectionsSide>`. Keep the existing refund UI reachable from the payments area (it can live inside the document's payments section or the sidebar — do not remove or rewrite its handler).

- [ ] **Step 4: Verify money flows intact + gates**

Manually confirm in the code: take-payment and refund handlers are the same functions as before; both remain disabled/absent when `syncedSource !== null` (the existing `canTakePayment`/`!invoice.syncedSource` guards are preserved). Send-reminder and copy-pay-link are hidden for synced invoices.

- [ ] **Step 5: tsc, lint, run component tests, commit**

Run `npx tsc --noEmit` (0), `npx eslint src/components/admin/invoices/invoice-detail-client.tsx` (0 errors), `npx vitest run src/components/admin/invoices` (PASS), then:
```bash
git add src/components/admin/invoices/invoice-detail-client.tsx "src/app/admin/(dashboard)/invoices/[id]"
git commit -m "feat(invoices): detail page — invoice document + collections chrome"
```

---

## Self-Review notes (addressed)

- **Spec coverage:** document layout (Task 3), collections sidebar (Task 4), get-paid actions Send reminder/Copy pay link/Take payment (Task 5, reusing Phase-1 send-reminder + new pay-link), business identity (Task 2), job-performed-by + service address + dates (Task 1). The take-payment/refund flows are explicitly preserved (Task 5 constraint).
- **Data-gap resolutions are explicit:** invoice # via `invoiceRef`; due date display-only (age-based, no column); activity from real events only (no fabricated reminder count); org address/phone gated on real columns (Task 2 Step 1).
- **Verify-before-code hooks:** Task 1 flags the `serviceRequests`/`users` column names; Task 2 Step 1 flags the org-settings address/phone columns; Task 5 flags confirming the current fetch + preserving money handlers.
- **Type consistency:** `InvoiceDetailView` field names (`customerName`, `customerAddress`, `customerPhone`, `technicianName`, `serviceDate`, `lastReminderSentAt`) used identically in Tasks 1, 3, 4, 5.

## Out of scope (YAGNI)
- Editing line items / creating invoices from the detail page.
- A stored `due_date` / net-terms (age-based, per Phase 1).
- Reminder-history log table (only `last_reminder_sent_at` is tracked).
- PDF export / print stylesheet (the document is print-friendly HTML; a dedicated print CSS can follow later).
