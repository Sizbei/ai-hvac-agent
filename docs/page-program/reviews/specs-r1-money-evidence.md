# Round 1 — Evidence audit: pricebook / estimates / invoices / accounting / membership-plans

Method: every `verified` claim that is load-bearing for a P0/P1 gap or a
requirement was checked by opening the cited file at the cited lines in the
current working tree (not run — read only). Line numbers were treated as
`minor` drift if content matched at a nearby line; a `blocker` requires the
cited file/lines to actually disagree with the spec's claim.

## Findings

| id | spec | severity | tag | spec line under attack | what I found |
|---|---|---|---|---|---|
| — | — | — | — | — | No blockers or majors found. Every load-bearing `verified` citation checked out against the code exactly as claimed (see coverage list below). No minor line-drift found either — every cited line range pointed at the claimed content, often to the exact line. |

No findings table rows because none survived scrutiny — not because scrutiny
was shallow. Claims actually opened and checked, file:line against spec
citation:

**pricebook.md**
- `estimate-create-dialog.tsx:81` calling `usePricebook({ limit: 20000 })` — confirmed, exact line.
- `route.ts:64` `Math.min(20000, Math.max(1, ...))` cap — confirmed, exact line.
- `quantityAvailable`/`vendorType`: written in `fieldpulse/import/items.ts:130-152` (confirmed, lines 133-134 and 152-153 set them), typed columns in `schema.ts` pricebook_items block (confirmed), omitted from `ADMIN_ITEM_PROJECTION` (`pricebook-queries.ts:102-120`, confirmed — projection has no `quantityAvailable`/`vendorType` key) and from the `PricebookItem` client type (`use-pricebook.ts:7-24`, confirmed), denylisted from spillover via `ITEMS_PROMOTED` in `src/lib/integrations/fieldpulse/import/spillover.ts` (spec cites `spillover.ts:96`; confirmed `quantity_available`/`vendor_type` sit in that set at line 96 of that file).
- Category tree: `categoryId` accepted by both Zod schemas (`route.ts:23`, `[id]/route.ts:24`, confirmed exact lines), absent from `FormState` in `pricebook-form-dialog.tsx:39-51` (confirmed — no `categoryId` field in the interface), no `categoryId`/`category` token anywhere in `page.tsx` (confirmed via grep — zero hits).
- PATCH `.refine()` on `memberPriceCents <= priceCents` only fires when both fields are present in the same body — confirmed verbatim at `[id]/route.ts:36-43` (the refine literally short-circuits `if (v.memberPriceCents == null || v.priceCents == null) return true;`).
- `pricebook-queries.ts:225-231` (LIMIT/OFFSET) and `:233-237` (`Promise.all`) — both citations land on the exact lines claimed.

**estimates.md**
- No writer for `dismissed`/`expired`: grepped every `status:` literal assignment in `estimate-queries.ts` — only `"open"` (create) and `"sold"` (mark-sold/approve) are ever written. Confirmed.
- No cron touches estimates: `src/app/api/cron/` listing has no estimate-related job. Confirmed.
- No regenerate/resend affordance: grep for "regenerate"/"resend" under `src/app/api/admin/estimates` returns zero matches. Confirmed. Token stored only as `hashToken(approvalToken)` (SHA-256), plaintext never persisted — confirmed in `estimate-queries.ts` create path.
- `markEstimateSold`'s synced/already-decided guards at `:641,673` — both line numbers are exact (641 = `if (est.fieldpulseEstimateId != null)`, 673 = `isNull(estimates.fieldpulseEstimateId)` in the atomic UPDATE predicate).
- `POST /api/admin/estimates` schema gap (Restimates-3): `route.ts` confirmed — `quantity: z.number().int().min(1)` and `unitPriceCents: z.number().int().min(0).optional()`, neither has `.max()`, matching the spec's claim exactly.

**invoices.md (P0 claim)**
- `sendInvoiceReminder` (`money-triggers.ts`) reads `id`/`customerId`/`totalCents`/`amountPaidCents`/`state`/`lastReminderSentAt` only — no `fieldpulseInvoiceId`/`hcpInvoiceId` field is even selected, let alone checked. Confirmed: the function has no synced-guard branch anywhere in its body.
- Sibling `sendOverdueInvoiceReminders` in the same file does filter `isNull(invoices.fieldpulseInvoiceId), isNull(invoices.hcpInvoiceId)` with a comment explaining why ("the UI already refuses reminders on synced rows, and dunning them here would double-text real customers"). Confirmed verbatim.
- `invoice-synced-guards.test.ts` — grepped for "sendInvoiceReminder"/"Reminder", zero matches. Confirmed no test coverage for this path.
- UI-only gate confirmed: `invoice-row.tsx` and `invoice-detail-client.tsx` both branch on `invoice.syncedSource === null` (or `!invoice.syncedSource`) before rendering the reminder button — client-side only, nothing stops a direct API call.
- This P0 is real and precisely as described. It is the single most important finding across all five specs (see summary below) — not because the audit found it wrong, but because it's the one live, exploitable gap the specs correctly caught.
- Also spot-checked and confirmed: `takePayment`/`refundPayment`/`voidInvoice` synced guards + CAS predicates (`amountPaidCents + amount <= totalCents`, `amountRefundedCents + amount <= amountCents`), refund gate (`isSuperAdmin` both server-component and route), INT32 clamp (`route.ts:72-92`, rejects rather than clamps), `collectedThisMonthCents` native-only scope (`fieldpulsePaymentId IS NULL`) and its undisclosed sublabel ("Payments received since the 1st"). All confirmed exactly as the spec states.

**accounting.md (P0 claim)**
- Gaccounting-1, the headline finding: both the native AND synced invoice queries in `getAccountingExport` filter by `gte(invoices.createdAt, fromDate)`/`lte(invoices.createdAt, toDate)` and both journal-line builders use `date: isoDate(inv.createdAt)` — confirmed at the exact lines cited (`accounting-export.ts:133,141-142` for the synced filter, `:246` for the synced date field). No `coalesce(issuedAt, createdAt)` anywhere in this file.
- Confirmed `invoice-queries.ts` and `operations-metrics-queries.ts` already use `coalesce(issuedAt, createdAt)` at the cited lines (877-878, 944, 1015 and 243-245, 268-272 respectively) — the divergence claim is real, not a misread.
- Confirmed schema comment at `schema.ts` (~2769-2774) explaining `issuedAt` vs `createdAt` for mirrored invoices, word-for-word as quoted in the spec.
- Confirmed FieldPulse importer sets `issuedAt: parseFpDate(invoice.invoicedDate ?? invoice.createdAt)` on both insert and update, never touching `createdAt` on insert (defaults to `defaultNow()`); HCP importer sets `issuedAt: parseFpDate(invoice.createdAt)` the same way. Both match the spec's description.
- Gaccounting-2: `buildCsv`'s synced-section marker is correctly source-neutral ("already booked in FieldPulse/HCP") at line ~351, but the subtotal row three lines later is hardcoded `"FieldPulse synced subtotal"` at line 358 — confirmed exact line and exact string.
- Gaccounting-3 (HCP never writes `payments`): grep for `payments` under `src/lib/integrations/housecall-pro/` returns nothing; `fieldpulse/import/payments.ts` does insert into `payments` with a correct `createdAt`. Confirmed.
- This P0 is real, precisely cited, and correctly reasoned (a period export can misdate/omit revenue for FP/HCP-mirrored invoices). Second most important finding in this batch.

**membership-plans.md (P0 claim)**
- `useMembershipPlans` (`use-membership-plans.ts`) fetches `/api/admin/membership-plans` with literally no query string — confirmed, no `includeInactive` param sent anywhere in the hook.
- List API defaults `includeInactive` to `false` and `listMembershipPlans` filters `active=true` in that case — confirmed.
- Confirm-dialog copy "You can re-activate it later" — confirmed present in `page.tsx`.
- Grep for "reactivate" across `src/` — zero matches; `MembershipPlanUpdate = Partial<MembershipPlanInput>` and `MembershipPlanInput` has no `active` field, so `updateMembershipPlan` structurally cannot flip it back on. Confirmed — the P0 is real and precisely as described.
- Rmembership-plans-2: `POST` schema caps `priceCents` at a locally-redeclared `MAX_PRICE_CENTS = 99_999_999` (route.ts:14, not imported from `money-format.ts`); `PATCH` schema has `priceCents: z.number().int().min(0).optional()` with no `.max()` at all. Both confirmed exactly.
- "Show inactive" pattern reference to `pricebook/page.tsx:204-207` — confirmed, that's exactly the toggle button block in the pricebook page.

## Per-spec verdict

- **pricebook.md** — sign-off
- **estimates.md** — sign-off
- **invoices.md** — sign-off
- **accounting.md** — sign-off
- **membership-plans.md** — sign-off

## Summary

0 blockers, 0 majors, 0 minors. Every load-bearing `verified` citation checked
against the current source — including all three P0 claims (invoices'
unguarded manual reminder, accounting's `createdAt`-vs-`issuedAt` date bug,
membership-plans' unreachable-reactivate gap) and every P1/P2 citation feeding
a requirement — matched the code exactly, often down to the exact line
number, not just the right neighborhood. No claim cited the wrong file, no
claim asserted a bug that was actually already guarded elsewhere, and no
`verified` tag looked like it required actually running the code to know.

The single most important fact the specs got right (and that a less careful
audit would want to double-check hardest): **accounting.md's Gaccounting-1**
— the accounting export dates and filters FieldPulse/HCP-synced invoices by
`invoices.createdAt` (import time) while every other money surface
(`/admin/invoices`, `/admin/operations`) already migrated to
`coalesce(issuedAt, createdAt)` specifically because `createdAt` was proven
wrong for mirrored rows (a live case cited in the FieldPulse importer's own
comment: invoice invoiced 2025-10-30, row imported 2026-07-07). This is a real
period-boundary revenue bug in a financial export tool, correctly diagnosed
and correctly scoped as P0.

No factual errors found in this round.
