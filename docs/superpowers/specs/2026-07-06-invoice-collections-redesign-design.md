# Invoice Collections Redesign — Design

**Date:** 2026-07-06
**Status:** Draft — pending review
**Author:** brainstorm session (Raymond Chen)
**Prototype:** https://claude.ai/code/artifact/f8333054-66ba-4cc4-948e-661b42916d98

## Goal

Redesign the admin **Invoices** experience (list + single-invoice detail) from a
flat data table into a **collections workspace** whose primary job is *getting
paid*: surface who owes, how overdue, and let the operator chase it in one tap.
The current list is a plain table (Created / State / Total / Balance / Links); it
has no summary, no aging, no customer names, no search, and no chase action.

**Audience:** the owner / office manager doing a weekly (or daily) collections
pass. Optimize for "who do I chase, and chase them now."

## Decisions locked in brainstorm

| Decision | Choice |
|---|---|
| Scope | **Both** surfaces — list first, then detail |
| Primary goal | **Collections / getting paid** |
| "Overdue" definition | **Age-based, no schema change** — open invoice older than 30 days; aging buckets 0–30 / 31–60 / 60+ (matches the Operations page AR aging) |
| Chase action | **One-click reminder per invoice** — fires the existing `invoice_overdue` SMS (with pay link) through the comms queue; consent + quiet-hours enforced automatically |

## Open decisions (recommendations below; confirm before build)

1. **Visual direction.** The prototype offers two:
   - **Ledger (recommended)** — crisp, airy data table with real contrast: dark
     header row, heavy tabular amounts, precise columns, one restrained accent.
     Reads as professional and scannable; fits the rest of the admin.
   - **Cockpit** — dark, action-forward worklist; each invoice a card with a
     left severity stripe (red/amber/green by age) and the CTA up front.
   *Recommendation: Ledger* as the shipping direction (consistency with the
   admin), borrowing Cockpit's **left severity accent** on overdue rows.

2. **Reminded-state treatment** (prototype has a live toggle):
   - **New (recommended)** — a single calm status chip "✓ Reminded · 3d ago"
     that flips to "Send again ↻" on hover. One element, no caption, never wraps.
   - **Current** — outline "Send again" button + a caption underneath.
   *Recommendation: New.*

3. **Reminder memory.** The "3d ago" needs a `last_reminder_sent_at` timestamp on
   `invoices` (one nullable column, tiny migration). *Recommendation: add it* —
   without a last-sent signal the operator nags customers daily. If rejected, the
   button ships without the "reminded" state and no schema change is needed.

## List design — the collections workspace

### Information architecture (top → bottom)
1. **Summary band** (3 stat cards): **Outstanding** (total open balance + count),
   **Overdue › 30 days** (amount + count + oldest age, red-accented), **Collected
   this month** (amount + progress vs billed). Computed client-side from the
   fetched list — no extra query.
2. **Reconcile banner** — kept as-is (stuck 'pending' payments → Reconcile now).
3. **Toolbar** — segment filter **Overdue / All / Unpaid / Paid** (Overdue carries
   a count badge) + **search** (customer name or invoice #).
4. **List**, sorted **most-overdue-first** (oldest open balance; paid rows last).

### Row anatomy (Ledger)
Fixed grid, identical tracks for header and rows so columns align exactly:
`Customer · Invoice · Age · Balance(right) · Get-paid(right)`.
- **Customer**: identity **monogram** (stable hue per name — NOT severity), name
  (heavy), contact, and a `2 invoices` tag when the customer owes on several.
- **Invoice**: `#1042` + created date.
- **Age**: heat chip — green (0–30) / amber (31–60) / red (60+) with a status dot
  (shape + color, not color alone).
- **Balance**: heavy tabular amount; when partially paid, a muted `of $1,120`.
- **Get-paid rail** (right-aligned, fixed width, buttons align across rows):
  primary **Send reminder** + a **⋯ overflow** (View invoice / Copy pay link /
  Record payment / Void). After sending → the reminded chip (see open decision 2).

### States
- **Loading** — skeleton rows.
- **Empty** — filter-aware empty state ("No invoices match this filter").
- **Error** — inline alert (existing pattern).
- **Paid** rows — no CTA; a calm "Paid {date}" marker; only shown under All/Paid.
- **Zero/`—`** — never render a misleading `$0.00`/`NaN`.

## Detail design — collections-flavored single invoice

Keep the existing capabilities (line items, Take payment, Payments/Refunds) but
re-order for "get paid":
1. **Header**: customer, invoice #, and a prominent **balance due** with an age
   chip; the **Send reminder** + **Copy pay link** actions sit here.
2. **Money actions** (Take payment / Record payment) directly under the balance.
3. **Line items** (document-style, clean).
4. **Payments & refunds** timeline (existing), plus **reminder history** (when
   `last_reminder_sent_at` is adopted).
Synced FieldPulse/HCP invoices stay read-only in money flows (existing guard);
the reminder action is still allowed (it only sends a message).

## Motion & interaction spec (Emil design-eng principles)
- `--ease-out: cubic-bezier(.23,1,.32,1)`; UI transitions ≤ 200ms.
- Buttons: `:active { transform: scale(.96) }` at 150ms; scope transitions to
  `transform / background / border-color` (never `all`).
- Overflow menu: fixed-positioned (dodges card clipping), `transform-origin` top-
  right, scale .96→1 + opacity at 140ms; closes on outside-click / Esc / scroll.
- Toast on send: slides up from bottom-right (`translateY` + opacity, 340ms
  ease-out), auto-dismiss ~2.6s.
- Row entrance: subtle stagger (8px + opacity, ~40ms apart), gated by
  `prefers-reduced-motion`.
- No animation on keyboard-repeated actions.

## Architecture

| File | Change |
|---|---|
| `src/lib/admin/invoice-queries.ts` (+ `use-invoices` hook) | List query joins **customer name**, returns **balance** and **createdAt** (age derived client-side). Add `lastReminderSentAt` when adopted. |
| `src/lib/db/schema.ts` + migration | (If decision 3 = yes) add nullable `last_reminder_sent_at timestamptz` to `invoices`. |
| `src/app/api/admin/invoices/[id]/send-reminder/route.ts` (new) | `POST` — admin-gated, org-scoped, rate-limited. Resolves customer phone + pay link; enqueues the `invoice_overdue` comms job through the existing queue (consent + quiet hours). Stamps `last_reminder_sent_at`. Guards: open invoice with a balance only; idempotency/soft cooldown to prevent double-send. |
| `src/app/admin/(dashboard)/invoices/page.tsx` | Rebuild as the collections list (summary band + toolbar + Ledger rows + rail + reminded chip + menu). |
| `src/components/admin/invoices/*` | Extract `InvoiceRow`, `SummaryBand`, `AgeChip`, `RemindButton`, `RowMenu` — small, focused components. |
| `src/components/admin/invoices/invoice-detail-client.tsx` | Re-order for balance-first; add Send reminder / Copy pay link. |

### Data notes
- **Aging** from `createdAt` (age-based decision), consistent with
  `operations-metrics` AR aging.
- **Pay link**: reuse the existing customer **portal** (`/portal/[token]`); the
  send-reminder endpoint resolves/creates the token like the current pay flow.
- **Summary** numbers computed from the already-fetched list (no new aggregate).

## Testing
- `send-reminder` route: auth gate, org scope, rate limit, "no phone / no balance
  / already-paid" rejections, cooldown/idempotency, comms-queue enqueue with the
  right template + payLink, `last_reminder_sent_at` stamped.
- List query: customer-name join is org-scoped; balance/age correctness.
- Component: age-chip bucket boundaries; reminded-state rendering; empty/paid
  states render `—`, not `$0`.
- Full gate (tsc / lint / tests) before commit.

## Out of scope (YAGNI)
- Bulk chase (select-many) — revisit after one-click proves out.
- Real due-date / net-terms (age-based chosen).
- Email reminders (SMS template exists; email is a later channel).
- Statements / customer-level AR rollup page.
- Payment plans / "promise to pay" / snooze.
