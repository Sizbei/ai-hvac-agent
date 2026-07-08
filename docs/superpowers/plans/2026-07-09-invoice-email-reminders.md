# Invoice Collections — Email-fallback reminders (Phase 7)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Reminders reach customers without a phone: both reminder paths (manual + cron sweep) fall back to an email reminder when SMS isn't possible, mirroring the existing `triggerEstimateSent` ladder.

**Architecture:** `getCustomerContact` (local to `money-triggers.ts`) gains `email` (decrypt `customers.emailEncrypted`). Both reminder paths resolve a channel with the same deterministic ladder as `triggerEstimateSent`: **SMS** when `contact.phone && smsTemplate`; else **email** when `contact.email && emailTemplate` (`invoice_overdue` + `templateType='email_html'` + active); else fail with a precise reason. The manual path's reason `no_phone` becomes **`no_contact`** (no phone AND no email); the route map and page flash copy follow. Atomic cooldown claim + compensation are unchanged — only the enqueue's channel/template/recipient vary.

**Tech Stack:** Next.js 16 App Router, Drizzle ORM over Neon Postgres HTTP, Vitest (node env).

## Global Constraints

- **Channel ladder (both paths, deterministic):**
  1. no contact row OR (no phone AND no email) → `no_contact`
  2. `phone && smsTemplate` → SMS (exactly today's behavior)
  3. else `email && emailTemplate` → email (`recipientEmail`, `channel:'email'`)
  4. else → `no_template`
- The **atomic claim / compensation and `lastReminderSentAt` stamping are untouched** — channel resolution happens BEFORE the claim; the claim/enqueue/compensate sequence stays byte-identical apart from the enqueue's channel/template/recipient fields.
- `templateVariables` stay identical across channels (customerName, amount, invoiceNumber, invoiceId, payLink, companyName, phoneNumber) — reminder history (Phase 6) keys on them.
- Email template lookup matches `triggerEstimateSent`: `communicationTemplates` where org + `triggerType='invoice_overdue'` + `templateType='email_html'` + `isActive`, columns `{id}`.
- Reason rename: `no_phone` → **`no_contact`** everywhere (return union, route `REASON_STATUS` (400), page `REASON_MAP` → `NO_CONTACT: 'No phone or email on file for this customer.'`). While in `REASON_MAP`: delete the dead `NO_BALANCE` entry and ADD `NOT_COLLECTIBLE: 'This invoice isn't collectible.'` (missing since the Phase-3 rename).
- The **sweep** applies the same ladder per invoice: currently it skips when no phone; now it skips only when neither channel resolves (count as `skipped`, same as today). Sweep stamps `lastReminderSentAt` on success regardless of channel (existing behavior).
- Decrypt email with the same `safe()` try/catch-null pattern already in `getCustomerContact`.
- node-env tests; conventional commits, NO Co-Authored-By trailer. `npx next build` in the final gate (page copy touched).

---

### Task 1: channel ladder in both reminder paths + reason rename

**Files:**
- Modify: `src/lib/communication/money-triggers.ts` (`CustomerContact` + `getCustomerContact` ~L33-64; `sendInvoiceReminder` ~L236-330; `sendOverdueInvoiceReminders` per-invoice loop), `src/app/api/admin/invoices/[id]/send-reminder/route.ts` (`REASON_STATUS`), `src/app/admin/(dashboard)/invoices/page.tsx` (`REASON_MAP` ~L129)
- Test: `src/lib/communication/send-invoice-reminder.test.ts` (extend)

**Interfaces:**
- `sendInvoiceReminder` return union: reasons become `"not_found" | "not_collectible" | "no_contact" | "no_template" | "cooldown"`.
- `getCustomerContact` returns `{ phone: string | null; email: string | null; name: string | null }`.

- [ ] **Step 1: Write the failing tests** (extend `send-invoice-reminder.test.ts`; read its mocks first — it captures `queueCommunicationJob` calls and mocks the db)

```ts
it('falls back to EMAIL when the customer has no phone but has an email + email template', async () => {
  // contact row: phoneEncrypted null, emailEncrypted 'ENCEMAIL' (decrypt-mocked)
  // db.query.communicationTemplates.findFirst → { id: 'tpl-email' } (email_html lookup)
  // assert: queueCommunicationJob called ONCE with channel 'email',
  //   templateId 'tpl-email', recipientEmail set, NO recipientPhone,
  //   and the SAME templateVariables keys as the SMS path (incl. invoiceId, payLink)
  // assert: result { ok: true } and lastReminderSentAt claim UPDATE happened
});
it('returns no_contact when the customer has neither phone nor email', async () => {
  // contact row: both encrypted fields null → { ok:false, reason:'no_contact' }, no enqueue, NO claim UPDATE
});
it('prefers SMS when both phone and SMS template exist (email untouched)', async () => {
  // phone + smsTemplate present → channel 'sms' exactly as before, email template lookup NOT consulted
});
it('returns no_template when phone-less customer has email but no email template', async () => {
  // email present, findFirst → undefined → { ok:false, reason:'no_template' }, no claim
});
it('sweep falls back to email for a phone-less customer (enqueued++, stamp still written)', async () => {
  // drive sendOverdueInvoiceReminders with one overdue invoice whose contact has
  // email only; email template found → assert channel 'email' enqueue + the
  // lastReminderSentAt stamp UPDATE (reuse the existing sweep-test scaffolding)
});
```
Also UPDATE existing tests that assert reason `no_phone` → `no_contact`.

- [ ] **Step 2: Run to verify they fail**, then **Step 3: implement**

1. `getCustomerContact`: select `emailEncrypted: customers.emailEncrypted` too; return `email: safe(row.emailEncrypted)`; extend the `CustomerContact` interface.
2. Add a small local helper (mirrors `triggerEstimateSent`'s email lookup):
```ts
async function findActiveEmailTemplate(
  organizationId: string,
  triggerType: "invoice_overdue",
): Promise<{ id: string } | null> {
  const tpl = await db.query.communicationTemplates.findFirst({
    where: and(
      eq(communicationTemplates.organizationId, organizationId),
      eq(communicationTemplates.triggerType, triggerType),
      eq(communicationTemplates.templateType, "email_html"),
      eq(communicationTemplates.isActive, true),
    ),
    columns: { id: true },
  });
  return tpl ?? null;
}
```
3. `sendInvoiceReminder`: replace the `no_phone`/template block with the ladder BEFORE the claim:
```ts
const contact = await getCustomerContact(organizationId, inv.customerId);
if (!contact || (!contact.phone && !contact.email)) {
  return { ok: false, reason: "no_contact" };
}
const smsTemplate = contact.phone
  ? await findActiveSmsTemplate(organizationId, "invoice_overdue")
  : null;
const emailTemplate =
  !smsTemplate && contact.email
    ? await findActiveEmailTemplate(organizationId, "invoice_overdue")
    : null;
if (!smsTemplate && !emailTemplate) return { ok: false, reason: "no_template" };
```
   Then in the enqueue, branch the channel fields (everything else identical):
```ts
...(smsTemplate
  ? { templateId: smsTemplate.id, channel: "sms" as never, recipientPhone: contact.phone! }
  : { templateId: emailTemplate!.id, channel: "email" as never, recipientEmail: contact.email! }),
```
   (Or an equivalent explicit if/else building the job object — match the file's style; keep `priority: 30`, `customerId`, and the exact `templateVariables` unchanged.)
4. Update the return union (`no_phone` → `no_contact`).
5. Sweep loop: apply the same ladder — currently it `continue`s (skipped++) when `!contact?.phone` and when no SMS template; change to resolve `smsTemplate`/`emailTemplate` per the ladder and skip only when neither resolves; enqueue with the resolved channel fields. Keep the stamp + claimOutboundOnce + error handling as-is. NOTE: resolve the SMS/email template lookups efficiently — the sweep currently fetches the SMS template ONCE outside the loop; keep that, and fetch the email template ONCE outside the loop too (not per-invoice).
6. Route `REASON_STATUS`: `no_phone` → `no_contact` (400).
7. Page `REASON_MAP`: replace `NO_PHONE` with `NO_CONTACT: 'No phone or email on file for this customer.'`; delete `NO_BALANCE`; add `NOT_COLLECTIBLE: "This invoice isn't collectible."`.

- [ ] **Step 4: verify** — `npx vitest run src/lib/communication/send-invoice-reminder.test.ts src/lib/admin/invoice-queries-list.test.ts` (PASS), `npx tsc --noEmit` (0), eslint changed files (0 errors), `npx next build` (compiles).

- [ ] **Step 5: Commit**
```bash
git add src/lib/communication/money-triggers.ts src/lib/communication/send-invoice-reminder.test.ts "src/app/api/admin/invoices/[id]/send-reminder/route.ts" "src/app/admin/(dashboard)/invoices/page.tsx"
git commit -m "feat(invoices): email-fallback reminders (manual + sweep) with no_contact reason"
```

---

## Self-Review notes (addressed)

- **Ladder is deterministic and identical in both paths**; SMS behavior for phone-holding customers is byte-identical (regression-guarded by the "prefers SMS" test).
- **Claim ordering preserved:** channel resolution is pre-claim, so a `no_contact`/`no_template` failure never burns the cooldown.
- **History compatibility:** `templateVariables` unchanged ⇒ Phase-6 history picks up email sends automatically (`channel: 'email'` shows in the entries).
- **Reason rename blast radius** enumerated: union, route map, page map, tests. The detail client uses no reason map (generic failure copy) — untouched.
- **Sweep efficiency:** both template lookups hoisted outside the per-invoice loop.

## Out of scope
- Authoring/seeding an `invoice_overdue` email template (orgs without one simply don't get the fallback — same feature-gating as estimate-sent).
- Bulk chase; inline record-payment; structured org address (unchanged deferrals).
