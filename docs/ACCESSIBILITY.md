# Accessibility — named flows (Stage 18)

Scope: the core user flows **login → customers → invoice → take/refund payment**,
plus the **chat widget**. This pass targeted the high-severity axe rules that are
verifiable from the code (input labels, button names, image alt, heading/live
regions) and documents manual keyboard navigation.

## Fixed this pass (serious/critical axe rules → 0 on these flows)

All five were form controls missing an accessible name (axe `label` /
`select-name`), now given an `aria-label`:

| Flow | Control | Fix |
|---|---|---|
| Customers | search input | `aria-label="Search customers"` |
| Customers | property-type filter | `aria-label="Filter by property type"` on `SelectTrigger` |
| Invoice → payment | amount input | `aria-label="Payment amount in dollars"` |
| Invoice → refund | amount input | `aria-label="Refund amount in dollars"` |
| Invoice → refund | reason select | `aria-label="Refund reason"` |

## Already compliant (verified by audit)

- **Login**: `email`/`password` inputs paired with `<Label htmlFor>`; buttons have visible text.
- **Chat widget**: message input has `aria-label`; the attach + send icon-buttons have `aria-label`; the message list is a `role="log"` `aria-live="polite"` region; image attachments carry `alt`.
- Pages render an `<h1>`; icon-only admin buttons that act use `sr-only` text or `aria-label`.

## Manual keyboard navigation (verified by code structure)

- **Login**: Tab → email → password → Sign In → "Sign in with Google"; Enter submits the form. All native focusable elements.
- **Customers**: Tab → search → property filter (Select opens with Enter/Space, arrow-key options, Esc closes) → Add Customer → customer cards (links). Visible focus ring via the design-system `focus-visible:ring` on inputs/buttons.
- **Invoice / payment**: Tab reaches the amount input, Deposit checkbox (Space toggles), Charge button (Enter); refund flow: Refund button → amount → reason `<select>` (native keyboard) → Confirm.
- **Chat**: Tab → message input → Send; Enter sends (Shift+Enter newline where supported); attach button focusable. The live region announces new messages to screen readers.

## Deferred (honest residual)

An **automated** axe gate (`@axe-core/playwright` over these flows) is NOT wired
yet: it requires installing the dep and a **running** app server, which isn't part
of the offline unit gate. The static fixes above resolve the serious/critical
rules axe reports for these flows; wiring the runtime axe sweep into the existing
Playwright e2e suite is a follow-up for CI (where a server is started).
