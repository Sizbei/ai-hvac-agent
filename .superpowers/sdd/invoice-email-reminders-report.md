# Invoice Email-Fallback Reminders — Implementation Report

**Branch:** feat/invoice-email-reminders  
**Plan:** docs/superpowers/plans/2026-07-09-invoice-email-reminders.md

## Status: DONE

## What was built

- `findActiveEmailTemplate` helper added to `money-triggers.ts` (mirrors `triggerEstimateSent` email lookup; `invoice_overdue` + `email_html` + active).
- `sendInvoiceReminder` channel ladder: no contact → `no_contact`; phone + smsTemplate → SMS; else email + emailTemplate → email; else → `no_template`. Claim/compensation unchanged.
- `sendOverdueInvoiceReminders` sweep: both template lookups hoisted outside loop; per-invoice ladder identical to manual path; skips only when neither channel resolves.
- Route `REASON_STATUS`: `no_phone` → `no_contact`.
- Page `REASON_MAP`: `NO_PHONE` → `NO_CONTACT`, deleted `NO_BALANCE`, added `NOT_COLLECTIBLE`.

## Tests (11 total, all pass)

New: email-fallback (manual), no_contact, prefers-SMS regression, no_template, sweep email-fallback, sweep neither-template (Fix 1 guard).  
Updated: SMS happy-path now asserts `channel: 'sms'`; sweep SMS test pushes correct template pair.

## Review fixes (commit d7d29de)

### Fix 1 — sweep: don't burn dedup slot when no channel resolves
Reordered `sendOverdueInvoiceReminders` per-invoice loop: `getCustomerContact` + channel resolution (`useSms`/`useEmail`) now happen BEFORE `claimOutboundOnce`. A customer with neither phone nor email (or no matching template) is skipped without consuming their 7-day ledger bucket. Manual path (`sendInvoiceReminder`) was already correct — untouched.

### Fix 2 — test precision + missing sweep case
- Prefers-SMS test: added assertion that `db.query.communicationTemplates.findFirst` was called exactly once (SMS only; email lookup never fires when SMS wins).
- Added sweep test "neither SMS nor email template configured → skipped, `claimOutboundOnce` NOT called".

## Verification

- `npx vitest run src/lib/communication` — 11 tests pass (send-invoice-reminder.test.ts), 1 pre-existing suite failure (`money-triggers.test.ts` server-only import, known baseline).
- `npx tsc --noEmit` — 0 errors.
- `npx eslint src/lib/communication/money-triggers.ts src/lib/communication/send-invoice-reminder.test.ts` — 0 errors.
- `npx next build` — compiles clean.
