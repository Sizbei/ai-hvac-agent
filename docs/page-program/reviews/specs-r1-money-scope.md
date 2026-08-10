# Adversarial review — round 1 — lens: severity calibration & scope discipline

Reviewer judges whether each spec asks for the RIGHT work at the RIGHT
priority per `docs/page-program/METHOD.md`'s severity gate ("Only `P0` and
`P1` gaps become implementation work in this run. `P2` items are recorded in
the spec and left in the backlog table"). Facts are assumed correct (that's
another critic's lens); this pass is about manufactured work, mis-rated
severity in either direction, untestable acceptance criteria, invariant
violations, cross-spec contradictions, and blast radius.

---

## pricebook.md

### M-S-1 — `blocker` — `verified`

Gap table rates this **P2**:

> `PATCH's member/standard price `.refine()` only fires when both fields are in the same request — API doesn't actually guarantee the invariant it error-messages | P2 | `[id]/route.ts:36-43``

Yet the very same spec builds it as a required, in-scope deliverable:

> `**Rpricebook-4**: PATCH `/api/admin/pricebook/[id]` enforces `memberPriceCents <= priceCents` against the resulting row (existing + patched), not only when both appear in the same body. **Acceptance:** a test asserts PATCHing only `memberPriceCents` above the item's existing `priceCents` is rejected 400 `VALIDATION_ERROR`.`

This directly contradicts METHOD.md's gate ("Only P0 and P1 gaps become
implementation work"). The spec even self-confirms the slip: the P2 backlog
recap right after Requirements says

> `P2 gaps (index tuning, distinct-query caching, test filename) are backlog per the severity gate.`

— a list that conspicuously omits the `.refine()` gap, because it was quietly
promoted instead of backlogged. The spec's own evidence text says this bug is
"not exploitable via the shipped form today" — that's a textbook P2, not
implementation work this pass. **Fix:** either drop Rpricebook-4 from
Requirements and file it in the P2 backlog table, or re-label the gap P1 with
a stated reason (neither is done here — the label and the work disagree).

### M-S-2 — `major` — `inferred`

> `**Category tree browsing/assignment UI** for `pricebook_categories` (table + `categoryId` API support already exist). ACCEPTED → Rpricebook-3 — schema/API-complete, only the UI is missing.`

The justification for a P1, four-part requirement (create + rename + assign +
filter) is "the plumbing already exists," not any observed operator pain.
Every item in the 17.5k-row prod catalog has `categoryId = null` today — that
is equally consistent with "nobody has ever needed this" as with "the gap
described here." "Schema/API-complete, only the UI is missing" is the
canonical shape of manufactured work: build the last mile of a feature
because the earlier miles happen to be sitting there, not because an operator
asked. Contrast `Rinvoices-1` or `Raccounting-1` in the sibling specs, both
of which cite a concrete failure mode a real user would hit. Recommend either
demoting to P2 backlog, or keeping P1 but adding operator-facing evidence
(e.g., "large-catalog orgs report search-only browsing is unusable") instead
of an availability-of-plumbing argument.

---

## estimates.md

### M-S-3 — `blocker` — `verified`

Gap table rates this **P2**:

> `POST /api/admin/estimates` accepts unbounded `quantity` and unbounded manual-line `unitPriceCents` (server-side); a crafted request can overflow the `integer` (INT32) money columns on insert, surfacing as an opaque 500 instead of a 400 | P2 | `route.ts:36-46` (schema); `schema.ts:2709-2711,2750` (INT32 columns); contrast `pricebook/route.ts:19,28-31` (`MAX_PRICE_CENTS` bound exists there)`

Yet Requirements builds exactly this as in-scope work:

> `**Restimates-3**: `POST /api/admin/estimates` rejects (400) `quantity` or manual-line `unitPriceCents` above a defined cap before any DB write. **Acceptance:** a) the zod schema gets `.max()` bounds on both fields...`

Same violation pattern as M-S-1: the post-Requirements recap line

> `G4/G5 (search scan cap, no activity history) stay P2 backlog, not requirements in this pass.`

silently skips G3 (this exact gap) — it isn't in the backlog list because it
was promoted to Restimates-3 without a severity change. The Brainstorm
section even hedges it as "Narrow (needs a valid admin session)," i.e. an
already-authenticated admin can only 500 themselves — consistent with P2, not
with build-this-pass work. **Fix:** drop Restimates-3 from Requirements (P2
backlog per the gate) or re-label the gap P1 with a stated reason.

### M-S-4 — `major` — `inferred`

> `Native estimates can never leave `status='open'` except via `sold` — no code path writes `dismissed`/`expired`, no cron sweeps `expiresAt`. A declined or long-expired native estimate stays in "Open pipeline"/"Needs follow-up" forever; `winRatePct` for a native-only org can only trend toward 100% since `lost` is unreachable | P1`

METHOD.md defines P0 as "broken/wrong," P1 as "workflow hole." A dashboard
metric (`winRatePct`) that is structurally incapable of reflecting reality —
it can only ever climb toward 100% for native-only orgs, forever — is a
number actively lying on a stat card, not merely a missing workflow. This
codebase has an explicit, self-cited precedent for treating exactly this
class of defect as top-severity: `accounting.md`'s own Brainstorm section
references "this codebase's earlier 'AR shows $0 on one surface, $152k on
another' bug" as the failure mode to avoid re-opening. A KPI that can only
trend to 100% is the same shape of defect (a displayed number that is
structurally wrong, not just incomplete). This is a judgment call — no
evidence is cited that a real org is *currently* being misled by this number
— but the severity reasoning in this spec doesn't engage with that precedent
at all, and P0 vs. P1 changes nothing about scope here (both gate to
"implementation work"), so there's no cost to getting the label right.
Recommend the spec at least discuss why this isn't P0 given the codebase's
own history, rather than assign P1 silently.

---

## invoices.md

No blocker/major severity-calibration findings. `Rinvoices-1` (P0) is the
only requirement, matches the only P0 gap in the table, and the P2 gaps
("Collected this month" scope-disclosure, 5,000-row search cap) are
correctly left in the backlog with no requirement built for either — this
spec follows its own severity gate cleanly. The P0 rating itself holds up:
the manual reminder path bypasses a guard whose *sibling function in the same
file* carries an explicit code comment explaining why the guard is required
— that's about as strong as "verified, broken" evidence gets.

**VERDICT: sign-off**

---

## accounting.md

### M-S-5 — `minor` — `inferred`

> `Gaccounting-3: HCP-synced invoices never have a corresponding `payment` journal line — the HCP integration writes no rows to `payments` at all, so the synced section's "for reconciliation" promise can't be kept for HCP-only orgs | P2 | grep for `insert(payments)` under `src/lib/integrations/housecall-pro/` — no matches; contrast `fieldpulse/import/payments.ts:132-155``

Correctly *not* built this pass (it's a cross-cutting HCP-integration change,
outside this page's query logic — the Non-goals section gives a sound reason
to defer regardless of severity). But P2 in this program means "polish"; this
gap means the export's own stated promise ("for reconciliation") is
structurally unkeepable for an entire class of orgs (HCP-only), not
cosmetic. Mislabeling it P2 risks it sinking to the bottom of
`README.md`'s backlog table under items that really are polish. Recommend
relabeling P1 for backlog-prioritization accuracy — this doesn't change what
gets built in this pass (still deferred, still cross-page), only how it's
triaged later.

Everything else in this spec is well-calibrated: `Raccounting-1` (P0, a real
revenue-miscount-by-import-date bug) and `Raccounting-2` (P1, a mislabeled
CSV subtotal) are the only two items promoted to Requirements, and both match
their gap-table severities exactly — no quiet promotions found, unlike
pricebook/estimates.

**VERDICT: sign-off**

---

## membership-plans.md

No findings. `Rmembership-plans-1` (P0 — the page makes a promise in its own
confirm-dialog copy, "You can re-activate it later," that literally nothing
in the codebase can fulfill; a reactivate code path doesn't exist anywhere,
verified by grep) and `Rmembership-plans-2` (P1 — money-cap asymmetry between
POST and PATCH) both match their gap-table ratings, and both P2 gaps
(`benefits` dead column, no pagination) are correctly left unbuilt. No quiet
promotions, no manufactured work — the `benefits` structured-editor idea is
explicitly rejected with the right reasoning ("written and read *nowhere* in
the product... building UI for an unconsumed column is speculative").

**VERDICT: sign-off**

---

## Summary

| id | spec | severity | tag |
|---|---|---|---|
| M-S-1 | pricebook | blocker | verified |
| M-S-2 | pricebook | major | inferred |
| M-S-3 | estimates | blocker | verified |
| M-S-4 | estimates | major | inferred |
| M-S-5 | accounting | minor | inferred |

Counts: 2 blocker, 2 major, 1 minor.

**Per-spec verdicts:** pricebook — blocked · estimates — blocked · invoices —
sign-off · accounting — sign-off · membership-plans — sign-off.

**Worst calibration error:** the identical process violation in both
`pricebook.md` and `estimates.md` — each spec's own Gaps table rates an item
P2, and each spec then builds that exact item as a required, in-scope
deliverable (Rpricebook-4, Restimates-3) without relabeling it, contradicting
METHOD.md's explicit gate ("Only P0 and P1 gaps become implementation
work... P2 items are recorded in the spec and left in the backlog table").
Both specs even show awareness of the rule — each has a "P2 gaps ... stay
backlog" recap sentence immediately after Requirements — but that recap
silently omits the exact gap that got smuggled through, in both cases. This
is the pattern most worth fixing before these specs move to implementation
planning: it's not that the underlying validation gaps are wrong to fix
eventually, it's that the spec's own stated gate was not applied to its own
stated severity table, twice, in the same mechanical way.
