# Round 1 — Missed-risk audit: pricebook / estimates / invoices / accounting / membership-plans

Lens: not "is what the spec says true" (see `specs-r1-money-evidence.md`) but
**what did the spec never look at**. Method: read the five specs in full,
then hunted the underlying code — schema, query modules, API routes,
integration importers, the public/portal token surfaces — for the six named
risk classes, independent of what each spec already flagged. Every finding
below is something none of the five specs' Current State / Gaps sections
mention, in a file the spec author had reason to open.

Two structural notes before the findings: this codebase is unusually
hardened already (documented multi-round adversarial review history per its
own commit log and code comments), which is why the yield here is lower than
a first-pass audit would expect — most of the classic traps (read-then-write
over-collection, missing tenancy scope, float cents, unguarded synced rows)
are already closed with an atomic-claim pattern the specs correctly credit.
The three findings below survived specifically because they sit one layer
below where each spec's own scrutiny stopped: a display-state derivation
next to an already-verified money claim, an aggregate computed one step past
where the "no float math" invariant was checked, and a payment-provider call
site the specs never enumerated as existing at all.

## Findings

### M-R-1 — `buildCsv`'s section subtotals are JS float-dollar sums, not integer-cent sums

**Severity:** minor · **Tag:** verified

`src/lib/admin/accounting-export.ts:334-335`:

```ts
const nativeTotal = result.native.reduce((s, l) => s + l.amountDollars, 0);
const syncedTotal = result.synced.reduce((s, l) => s + l.amountDollars, 0);
```

`amountDollars` on every `JournalLine` is already the *converted* value
(`centsToDollars(cents) = Math.round(cents) / 100`, `:70-73`). The two CSV
subtotal rows (`:347`, `:359`) are therefore built by summing binary
floating-point dollar values in JS — exactly the pattern the review lens
calls out ("a sum computed in JS... instead of in SQL/integers") and exactly
the pattern this file's own header comment warns against: *"cents are
converted to dollars ONLY at this export boundary... never by mutating
stored cents"* (`:8-9`). The invariant is honored for every individual line,
then broken once, silently, at the one place two-decimal float rounding
error actually accumulates: the reduce. The fix is one line — sum
`amountCents`/`amountDollars`'s *cents* source across `result.native`/
`result.synced` as integers, convert once, exactly the pattern already used
per-line.

At this codebase's realistic scale (per-invoice cents bounded to INT32,
period exports of at most a few thousand rows) the accumulated IEEE-754
error is many orders of magnitude below the half-cent `.toFixed(2)`
rounding threshold, so this is very unlikely to ever visibly flip a
subtotal by a cent today. It is flagged because it is a genuine, verified
instance of the exact anti-pattern the lens asks to hunt for, sitting
directly under an invariant the spec explicitly wrote to prevent it — and
because an accounting export is precisely the kind of surface where "off by
a cent, someday, at some org's scale" is the wrong failure mode to leave
latent on purpose.

**Which spec should have caught it:** `accounting.md`. Its own Invariants
section states: *"Cents→dollars conversion happens only at the export
boundary (`centsToDollars`), never by mutating stored cents. Reason:
repeated conversion elsewhere risks float drift."* (`accounting.md:218-220`).
The spec verified this invariant holds for every per-line `amountDollars`
conversion but never followed the same money value one step further into
`buildCsv`'s `reduce` — the one place in the file where "repeated
[floating-point] conversion" (repeated addition of already-converted
dollar floats) actually happens. Gaccounting-4 in the same spec even
flags `Promise.all` vs `db.batch()` in this exact file as a P2 nit, showing
the file was read closely — just not for this.

---

### M-R-2 — Membership enrollment's payment-provider charge is never recorded anywhere in the money surface

**Severity:** major · **Tag:** verified

`src/lib/admin/membership-queries.ts:230-251` (`enrollCustomer`):

```ts
opts: { readonly chargeFirstPeriod?: boolean } = {},
...
if (opts.chargeFirstPeriod) {
  const charge = await provider.createCharge({
    amountCents: plan.priceCents,
    description: `Membership: ${plan.name}`,
    idempotencyKey: membershipId,
  });
  if (charge.status !== "succeeded") {
    return { ok: false, reason: "charge_failed" };
  }
}
```

The charge result is used only to gate enrollment (fail closed on
non-success) and then discarded — no `payments` row, no `invoices` row, no
`refunds` row, nothing. `chargeFirstPeriod` is a real, client-supplied
boolean threaded straight through from `POST
/api/admin/customers/[id]/membership` (`route.ts:19,96,100`) to this
function, so this is a live, reachable code path today, not dead code. A
repo-wide grep for every call site of `PaymentProvider.createCharge`
confirms there are exactly two: `invoice-queries.ts:262` (`takePayment`,
which inserts a `payments` row *before* charging and updates it after —
fully ledgered) and this one, which does neither. Money "moves" (today, in
the mock provider's in-model sense; the moment a real Stripe adapter
replaces `MockPaymentProvider` per `payments/provider.ts:97-110`, it moves
for real, unmodified) with zero corresponding row in `payments` or
`invoices` — meaning it is structurally invisible to every reconciliation
surface these five pages own: it is excluded from
`collectedThisMonthCents` (`invoice-queries.ts:755-777`, which only sums
`payments.amountCents`), from every `getAccountingExport` section
(`accounting-export.ts:99-225`, which only reads `invoices`/`payments`/
`refunds`/`technicianTimeEntries`), and from the invoice-level detail page
for that customer. A customer who is told they were charged for their
first membership period, and whose enrollment succeeded *because* that
charge succeeded, has no receipt, no refundable payment row (super_admin
refund UI only operates on `payments` rows), and no trace in any revenue
report in the app.

**Which spec should have caught it:** both, for different reasons.
`accounting.md`'s Purpose statement claims the export is the org's
"period-scoped... journal (invoices, payments, refunds, labor)"
(`accounting.md:8-9`) — the word "membership" does not appear anywhere in
the file (confirmed by reading it in full), so this entire revenue category
was never checked against the export's implicit completeness claim; a grep
for `createCharge` call sites (the same kind of grep the spec already ran
for `insert(payments)` to find Gaccounting-3, `accounting.md:139`) would
have found it immediately. `membership-plans.md` comes closer — it reads
`enrollCustomer` and quotes it discussing `chargeFirstPeriod`
(`membership-plans.md:138-143`, discussing `getPaymentProvider()`/mock
posture) — but stops at "recurring billing stays mock-only, not a page fix"
(`membership-plans.md:222-224`) without noticing that the *existing*,
already-wired, already-reachable enrollment charge (not a future renewal
charge) leaves no ledger record independent of whether Stripe is real.

---

### M-R-3 — `takePayment`'s post-claim display-state write can permanently strand a fully-paid invoice at `state='open'`

**Severity:** major · **Tag:** inferred (code-path traced, not reproduced under live concurrency)

`src/lib/admin/invoice-queries.ts`: the function reads `inv` once at the top
(`:181-192`, a snapshot including `amountPaidCents`), then performs the
atomic CAS claim against the *live* DB row (`:219-241`, correctly
concurrency-safe for the money column itself), then computes the display
state from the **stale pre-claim snapshot**, not the post-claim row:

```ts
// :246-247
const newPaid = inv.amountPaidCents + params.amountCents;
const invoiceState = newPaid >= inv.totalCents ? "paid" : "open";
```

...and writes it unconditionally in the closing `db.batch` (`:315-328`),
with no CAS on the `state` write itself. Walk two concurrent partial
payments that together exactly cover the balance (e.g. total 1000, both
requests read `amountPaidCents: 0`, payment A claims 600, payment B claims
400 — the atomic claim predicate correctly serializes against the *live*
column, so both succeed and `amountPaidCents` correctly ends at 1000): A
computes `newPaid = 0 + 600 = 600` → `'open'`; B computes
`newPaid = 0 + 400 = 400` → `'open'`. Whichever batch commits last leaves
`invoices.state = 'open'` permanently, even though `amountPaidCents ===
totalCents`. Nothing ever revisits this row's `state` column afterward —
contrast `reconcilePayment`, which explicitly *re-reads* the invoice after
its own CAS before deriving the same state hint (`:625-652`, comment: "Refresh
the display state ONLY... Re-adding pay.amountCents here double-credited the
invoice" — the same author clearly understood this failure mode in one
function but not the sibling one three hundred lines up).

This is not a money bug — `amountPaidCents`/`totalCents` stay exact per the
CAS, and `isCollectible` (`state==='open' && total>paid`) correctly
short-circuits to `false` once the balance is 0, so no further dunning or
over-collection is reachable from the stuck state. The concrete blast
radius is display: the "Unpaid" tab maps to raw `state='open'` with **no**
balance re-check (`page.tsx:69-73`, `// 'overdue' and 'unpaid' both filter
to state='open' on the server` — unlike "Overdue," which additionally
requires `totalCents > amountPaidCents`, `invoice-queries.ts:972-974`), so a
fully-paid invoice can sit in the collections operator's "Unpaid" queue
indefinitely, inviting a human to chase a customer who already paid in
full.

**Which spec should have caught it:** `invoices.md`. It explicitly reviewed
this exact code region and signed off on its atomicity: *"Over-collection/
refund guard is the same pattern: `takePayment`'s claim predicate is
`amountPaidCents + amount <= totalCents`... single conditional writes, not
read-then-write, verified"* (`invoices.md:85-88`). That statement is true of
the money column and false, one paragraph of code later, of the state
column the spec's own Current State section says drives the "Unpaid"/
"Overdue" tabs (`invoices.md:45-48`) — the spec verified the CAS pattern
holds for `amountPaidCents` but never asked whether the *non-CAS* state
write three lines below it could drift from a value that write is supposed
to summarize.

## Not flagged (checked, found solid)

For completeness, since the lens rewards honest "nothing here" results as
much as findings: the public estimate-approval token flow
(`estimates/[token]`, `api/estimates/approve`), the portal pay-link surface
(`resolvePortalToken`/`payPortalInvoice`, `src/lib/portal/portal-queries.ts`
— full-balance-only payments delegated straight into the same
`takePayment` CAS, ownership re-verified by `(organizationId, customerId,
invoiceId)` on every read/write, cost fields never selected), the
FieldPulse invoice/payment webhook and cron importers (idempotent via a
signed-event ledger and `onConflictDoUpdate` on the FP-id unique index,
respectively), `voidInvoice`'s payment/synced guards, the tax-rate
single-default `db.batch()` race (a concurrent second `isDefault` write
fails cleanly on the partial unique index, mapped to a 409 in both routes,
never a silent double-default), and every `::int`/`::bigint` cast on a
money `SUM` (all correctly `bigint`; only `count(*)` uses `::int`) were all
read and are sound. No unauthenticated surface among these five pages'
territory grants more than what its own spec already describes.

## Per-spec verdict

- **pricebook.md** — sign-off (no missed risk found in this pass)
- **estimates.md** — sign-off (no missed risk found in this pass)
- **invoices.md** — blocked (M-R-3: state-hint drift on the exact code path the spec certified as fully CAS-guarded; not a money-loss bug, but a verified logic gap directly contradicting the spec's own atomicity claim, in the page whose entire purpose is the "who owes money" queue)
- **accounting.md** — blocked (M-R-1 float-sum minor + M-R-2 major: an entire revenue category — membership enrollment charges — invisible to the one page whose job is being the complete money journal)
- **membership-plans.md** — blocked (M-R-2: the enrollment charge this spec itself reads and quotes has no ledger trace; a real defect in a code path the spec treated as "out of scope for this page" without checking it also has no home on *any* page)

## Summary

3 findings: 0 blocker, 2 major, 1 minor. 2 tagged `verified`, 1 tagged
`inferred` (traced through the code deterministically; the concurrent-timing
trigger itself was not reproduced live — recommend a targeted
`vitest`/integration test with two overlapping `takePayment` calls summing
exactly to `totalCents` before treating M-R-3 as closed either way).

The single most dangerous thing the specs missed: **M-R-2**. It is the only
finding of the three with a real path to moving real money with zero
ledger trace — today harmless only because `MockPaymentProvider` is
hardcoded regardless of `STRIPE_SECRET_KEY` (`payments/provider.ts:97-110`),
but the enrollment code path itself requires no change at all when a real
Stripe adapter lands; the gap goes live silently on that day, not on a day
anyone is looking at `membership-queries.ts` again. `accounting.md`'s own
purpose statement is to be the org's complete money journal; it is not, by
a whole category of transaction its author never enumerated.
