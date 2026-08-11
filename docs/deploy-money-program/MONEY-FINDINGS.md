# Money findings — what is verified, what is fixed, what is yours to decide

Everything here was measured, not inferred. DB figures come from SELECTs against
the dev mirror; upstream figures come from read-only GETs to the live FieldPulse
account. Dollar amounts are deliberately omitted where they are the operator's
own business totals — this repo is public. Counts and mechanisms are kept,
because those are what make the findings actionable.

Status key: **FIXED** (shipped on this branch) · **OPEN** (needs a decision).

---

## FIXED

### Zero-quantity components fabricated money
FieldPulse sends `quantity: "0"` for a component that contributes nothing. The
importer coerced it to `1`. Proven by arithmetic on a live invoice: the header
total and the line sum agree to the cent when `0` is treated as `0`, and differ
by a five-figure phantom line when it is treated as `1`.

Reconciliation impact, measured before and after: invoices whose line sum
disagrees with `total − tax` by more than $1 fell from **273 to 133**.

### Invoices could be permanently orphaned
The UPDATE branch refreshed money but never `customerId`, so an invoice first
synced before its customer existed stayed unlinked forever. Re-linking is now
asymmetric: link when a customer resolves, never null out when one doesn't.

### Deleted FieldPulse invoices became live AR
`upsertInvoiceRecord` — the webhook and daily-cron entry point — had no
`deletedAt` check at all. A deleted invoice arriving that way was mirrored as an
open balance and handed to collections, and nothing downstream could correct it
because `deriveInvoiceState` never returns `void`. Creation is now refused;
rows mirrored *before* an upstream deletion are logged for review rather than
silently voided, because voiding is a money mutation.

### Display quantity contradicted the money
Both floors are wrong on their own: flooring at 1 renders `1 × $5,500.00`
against a $0.00 line; flooring at 0 renders `0 × $100.00` against a $25.00 line.
Now shared by invoices and estimates: zero means zero, anything above zero shows
as at least one.

### Erasure was undone by the nightly sweep
Anonymizing scrubs the encrypted contact fields but leaves
`fieldpulseCustomerId`, so the next sweep found the row and rewrote every field
from FieldPulse — while `anonymizedAt` stayed set, so a compliance check would
still report it erased.

---

## OPEN — needs your decision

### 1. Distinct FieldPulse customers are merged into one native row

**This is the root cause of the orphaned-invoice backlog.** Contact dedupe keys
on an HMAC blind index over email *or* phone. That is wrong for commercial work:
a single accounts-payable address covers many unrelated businesses, because
third-party AP desks, warranty administrators and property managers pay on
behalf of dozens of customers. All of them collapse onto one native row; the
first FieldPulse id to arrive wins the link, and the rest exist on no row at all.

- **506** mirrored FieldPulse invoices had no customer (**93** unpaid).
- An invoice with no customer is invisible to collections — no reminder, no pay
  link, no AR owner. The AR *total* is unaffected (the headline aggregate reads
  `invoices` directly, with no join), so the number is right and only the
  actionability is broken.

An earlier attempt to repair this at the invoice level, by matching on email,
was **wrong and has been reverted in effect**: it filed one company's invoices
under another company's row, which also drives the customer portal. The heal now
refuses any row that already belongs to a different FieldPulse customer, so it
is deliberately a no-op for merged groups.

**Decide:** give each FieldPulse customer its own native row (an identity/schema
change, and the honest fix), or mark merged rows explicitly and teach the money
surfaces about them. Until then the backlog stays visibly unlinked, which is the
correct failure state.

> Dev-mirror note: before the correction, repair passes wrote **66** email-only
> links into the dev database (orphans fell 506 → 440). Because the sync never
> un-links, they persist. Dev only — this code has never run against production.

### 2. FieldPulse discounts are not mirrored, so line revenue is overstated

Line items store `quantity × unitPrice` and ignore FieldPulse's header and line
discounts. Verified against the dev mirror:

| measure | count |
|---|---|
| invoices where Σ line total ≠ `total − tax` (>$1) | **133** |
| invoices with a `$0.00` header but non-zero line items | **41** |
| invoices whose computed subtotal is negative | **29** |

This is not cosmetic. `rollUpMargin` (`src/lib/admin/margin.ts`) sums
`lineTotalCents`, and the invoice detail page selects it, so a fully discounted
invoice can report a large revenue figure at 100% margin against a $0.00 total.
The negative subtotals come from the same root: `subtotal = total − tax` goes
below zero when a discount zeroes the header but tax remains.

**Decide:** model the discount (a column, or a synthetic discount line so the
document sums correctly). Both change how invoices render, which is why this was
not done unilaterally.

### 3. Invoices marked paid that FieldPulse says nobody paid

Reported by review and **not yet independently confirmed**: live invoices with
`total > 0`, `amount_paid = 0`, `amount_unpaid = 0` and an empty `payments`
array. `deriveInvoiceState` reads the zero balance as "paid", and the H2 guard
then writes `amountPaidCents = totalCents`.

If confirmed, AR is understated, collections never chases those invoices, and
the accounting export reports them collected. Pre-existing; not introduced by
this branch. **Verify before acting** — the claim is precise and checkable
against `payments` rows in the mirror.

---

## Operational notes worth keeping

- The nightly workflow passes `--allow-prod`, which disables the importer's
  target guard on the only path that writes to production. A positive assertion
  (`--expect-host`) would be strictly better than an opt-out.
- The heal re-fetches merged customers on every run and can never persist a
  result, so that work repeats forever. Bounded (one GET per distinct orphaned
  customer per run) and acceptable, but it disappears only when finding 1 is
  fixed.
- GitHub's `schedule` trigger delivers ~8.8% of a five-minute cron on this repo
  (40 runs against 455 requested; median gap 51 min). Treat the Actions pinger
  as roughly hourly.
