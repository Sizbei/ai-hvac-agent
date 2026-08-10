# Adversarial review — round 1 — lens: severity calibration & scope discipline

Reviewer judges whether each spec asks for the RIGHT work at the RIGHT
priority per `docs/page-program/METHOD.md`'s severity gate ("Only `P0` and
`P1` gaps become implementation work in this run. `P2` items are recorded in
the spec and left in the backlog table"). Facts are assumed correct (that's
another critic's lens); this pass is about manufactured work, mis-rated
severity in either direction, untestable acceptance criteria, invariant
violations, blocked-on-credentials work, and migration blast radius.

**Specs reviewed:** `reports.md`, `operations.md`, `staff.md`, `settings.md`,
`integrations.md`, `inventory.md`, `audit-log.md`, `fieldpulse-import.md`,
`platform.md`

---

## staff.md ↔ technicians.md (cross-spec)

### W-S-1 — `blocker` — `verified`

`staff.md` and `technicians.md` (the latter outside this review's assigned
set, but directly relevant to lens 7) each independently propose authoring a
**new** hand-authored migration to recreate the exact same DB object — the
`trg_enforce_last_active_admin` trigger / `enforce_last_active_admin()`
function on `users` — and neither spec references the other anywhere
(`grep -in "technicians.md\|Gtechnicians\|Rtechnicians" staff.md` → zero
hits; `grep -in "staff.md\|Gstaff\|Rstaff" technicians.md` → zero hits).

`staff.md`'s Rstaff-1:

> `**Rstaff-1** (Gstaff-1): A fresh, empty database migrated with `npm run db:migrate` must end up with `trg_enforce_last_active_admin` on `users`, without depending on being forked/branched from an already-migrated database.`
> `**Acceptance criterion**: a new hand-authored migration (recipe: `CREATE OR REPLACE FUNCTION enforce_last_active_admin()` + `DROP TRIGGER IF EXISTS` + `CREATE TRIGGER`, idempotent) reproduces the exact trigger body from `0cea181^:drizzle/0027_last_admin_guard_super_admin.sql` (already admin-tier-aware).`

`technicians.md`'s Rtechnicians-1:

> `**Rtechnicians-1**: Re-author the last-admin guard trigger as a new hand-authored migration so a from-scratch database provisions it, matching what `staff-queries.ts` and this page's skill already claim is true.`
> `**Acceptance criterion**: a new `drizzle/0044_*.sql` recreates `enforce_last_active_admin()` and `trg_enforce_last_active_admin` verbatim (same guard condition: fires only when the row was an active admin-tier user and the update would remove that, raises `last_active_admin` with the org id)...`

Both specs did their own independent code-archaeology (same commits cited:
`392cbc4` added the original trigger, `0cea181` squashed it away) and reached
the same conclusion via the same evidence, but wrote it up as two separate
P0 requirements in two separate page specs with no cross-reference. If both
proceed to the implementation-plan stage as written, two outcomes are both
bad: (a) two subagents working in parallel each try to claim the "next"
migration slot (`technicians.md` explicitly names it `drizzle/0044_*.sql`;
`staff.md` names no number) and collide on the journal entry, or (b)
whichever spec is implemented first silently satisfies the other's
requirement, and the second implementer wastes a full plan→build→review
cycle re-authoring (or worse, re-diverging) DDL for an object that already
exists. Per AGENTS.md's own migration rule, a `_journal.json` entry and
snapshot copy are per-migration-file artifacts — two independently-authored
migrations for the same trigger is exactly the "blast radius" collision
lens 7 asks this review to check for.

**Fix:** pick one spec to own `Rtechnicians-1`/`Rstaff-1` (recommend
`staff.md`, since `/admin/technicians` is a bare redirect to `/admin/staff`
per `technicians.md`'s own Non-goals section — "not rebuilding a standalone
technician CRUD screen on this route"), and have the other spec's
requirement either point at it or be dropped/merged before either goes to
planning.

### W-S-2 — `major` — `verified`

`staff.md`'s Rstaff-1 acceptance criterion, quoted above, states the recipe
as "`CREATE OR REPLACE FUNCTION` + `DROP TRIGGER IF EXISTS` + `CREATE
TRIGGER`, idempotent" and nothing else. A repo-wide grep of `staff.md`
confirms **zero** mentions anywhere in the file of `statement-breakpoint`,
`_journal.json`, `snapshot`, or `drizzle-kit generate` — the exact
non-negotiable checklist AGENTS.md requires for every hand-authored
migration ("`drizzle/00XX.sql` needs `--> statement-breakpoint` separators +
`_journal.json` entry + snapshot copy; `drizzle-kit generate` must then
report 'No schema changes'").

By contrast, `technicians.md`'s Rtechnicians-1 — fixing the *identical*
underlying gap — spells the full checklist out explicitly in both its
acceptance criterion and its Invariants section:

> `using `--> statement-breakpoint` separators per `AGENTS.md`'s hand-authored-migration convention; `drizzle/meta/_journal.json` gets the matching entry and a snapshot copy exists; running `npx drizzle-kit generate` afterward reports "No schema changes"`

and Verification section (`npx drizzle-kit generate` → "No schema changes"
as an explicit gate step). `staff.md`'s Verification section for Rstaff-1
only lists `npm run db:migrate exits clean` and a manual `pg_trigger` query —
no `drizzle-kit generate` check anywhere. A plan-phase reader working from
`staff.md` alone would reasonably miss that this is a migration-carrying
requirement with a mandatory post-check, exactly the failure mode the sibling
`specs-r1-public-scope.md` review already flagged once for `auth.md`
(P-S-2). **Fix:** port the same four-line checklist from `technicians.md`'s
Invariants section into `staff.md`'s Rstaff-1 acceptance criterion and
Verification section (contingent on resolving W-S-1 first, since only one of
the two specs should own this migration).

---

## settings.md

### W-S-3 — `major` — `verified`

Gap table rates this **P2**:

> `Gsettings-1b: `businessInfo.email` is a validated schema field with no way to set it and no consumer | P2 | ... Lower severity than Gsettings-1: unreachable through the product, so it's a false doc comment on dead schema, not an operator-facing lie.`

Yet Requirements folds it into the P1 Rsettings-1 as an explicit,
independently-tested deliverable:

> `**Rsettings-1**: ... Wire `businessInfo.website` into `brandInfoFromConfig`'s `BrandInfo` mapping the same way `phone`/`serviceArea` already are (via the existing `biString` helper) — the smaller, more surgical fix vs. a new FAQ intent. Remove the unreachable `email` field from `businessInfoSchema` (`org-config-types.ts:70`) and its false doc comment (Gsettings-1b) rather than build a UI + intent for a field with zero evidence of demand — matches the spec's own YAGNI stance on `positioning`/`serviceScope`/`voiceCues`.`
> `**Acceptance criterion**: ... `businessInfoSchema` no longer has an `email` key (and `orgConfigUpdateSchema`/`OrgConfig`/`DEFAULT_ORG_CONFIG` stay in sync); ...`

The Verification section adds a dedicated test for it too: "`(b)
businessInfoSchema.safeParse({..., email: "x@y.com"}) now fails, proving the
field is really gone (Rsettings-1)`." This is the same pattern already found
twice in this program (pricebook.md's Rpricebook-4, estimates.md's
Restimates-3, per `specs-r1-money-scope.md`): a gap the spec's own table
rates P2 ships as in-scope, tested work under a P1 requirement's number,
without being relabeled. It is a much smaller instance than those two —
deleting one dead schema key plus one test, not a new validation feature —
so I'm not rating it `blocker`, but it's the same mechanical violation of
METHOD.md's gate ("Only P0 and P1 gaps become implementation work... P2
items are recorded in the spec and left in the backlog table"), and the
Non-goals section's explicit claim — "Gsettings-1b and Gsettings-3 (P2) stay
in the backlog per METHOD.md's severity gate; not implementation work in
this run" — is directly contradicted by Rsettings-1's own acceptance
criterion three sections earlier in the same document. **Fix:** either move
the `email` deletion out of Rsettings-1 into its own explicitly-labeled
P2-but-bundled-for-convenience note (with a one-line reason it's safe to do
opportunistically), or strike the Non-goals claim that it's staying in the
backlog.

---

## audit-log.md

### W-S-4 — `major` — `inferred`

Gaudit-1 is rated **P0**:

> `Gaudit-1: Two writers store a free-text, admin-supplied value (not a field name/id/enum) in `details`, violating the hard invariant | P0 | ...`

Gaudit-3 is rated **P1**:

> `Gaudit-3: `DELETE /api/admin/conversations/[id]` (any authenticated admin/technician role) permanently deletes that session's entire prior `audit_log` history, breaking the page's own "immutable record" claim, and no DB-level guard prevents it | P1 | ...`

Both gaps are framed by the spec's own Purpose section as violations of the
page's core promise — "render a tenant-scoped, paginated, filterable,
**tamper-evident** trail" — and both are described in Gaps as breaking a
named hard property (Gaudit-1: "violating the hard invariant"; Gaudit-3:
"breaking the page's own 'immutable record' claim"). Gaudit-1 is a
data-hygiene leak (two writers store a name where they shouldn't); Gaudit-3
is a live, unguarded, any-admin-reachable route that **permanently deletes**
the audit trail itself for an affected session — arguably the more severe of
the two by METHOD.md's own P0 bar ("broken/wrong"): the record this page's
entire Purpose depends on being immutable is not immutable, today, for any
technician who can reach `DELETE /api/admin/conversations/[id]`. This is a
judgment call — no evidence is cited that a real technician has actually
exercised this route to erase audit history — and it doesn't change what
gets built this pass (Raudit-log-3 is already a requirement regardless of P0
vs. P1 label), so there's no scope cost to getting the label right. Flagging
because the spec doesn't engage with why an unguarded permanent-delete path
against the audit trail itself is one tier below "two writers leak a name
into a JSON field," when both are framed as violations of the same
"tamper-evident"/"immutable" promise in the Purpose section.

---

## staff.md — additional finding

### W-S-5 — `minor` — `inferred`

> `Gstaff-1: The last-admin DB trigger is unreproducible — absent from every current migration file, so any freshly-migrated database (new Neon branch created from scratch, disaster recovery, a future CI/test DB) would have ONLY the race-prone app-level check, not the documented "authoritative" backstop | P0 | ...`

Checked against the specific instruction to judge honestly whether a
fresh-database-only defect is P0 "for this business today": the spec's own
Current-state section confirms the trigger **is** live on the actual running
dev (and per commit message, prod) database right now — "The guard is live
today only because dev/prod predate the squash." Nothing about the org's
current production system is broken; both the app-level check AND the DB
trigger are active and working today. The gap is a reproducibility/
disaster-recovery defect (a fresh Neon branch, a new CI DB, or a future
DR restore would silently lose the backstop), not a live P0 malfunction.
METHOD.md defines P0 as "broken/wrong" — this reads more like "the safety
net has a hole that hasn't been fallen through yet" than "broken right now."
I'm not recommending a relabel (the risk class — an org permanently locking
itself out of its own admin console — is severe enough that treating it with
P0 urgency is defensible even though it's latent, and, per the W-S-4
pattern, the label doesn't change what ships), but the spec doesn't discuss
this distinction anywhere, and a reader could reasonably ask why a
zero-current-impact gap outranks Gstaff-2/Gstaff-3 (both P1, both have an
actual live, exercisable failure mode today: a dead UI control, a
doomed-from-creation invite).

---

## reports.md

No findings. Greports-1 (P0) and Greports-2 (P1) are the only two items
promoted to Requirements and both match their Gaps-table severities exactly;
Greports-3 and Greports-4 (both P2) are correctly left in the backlog, and
the Non-goals section names both by id rather than silently dropping them.
Rreports-1's acceptance criterion is a pure `reporting-queries.test.ts`
unit test (no jsdom claim anywhere); Rreports-2 is a labeling-only fix with
no query-logic change, appropriately scoped to its P1 gap. No manufactured
work, no invariant violations, no HCP/FieldPulse-blocked work.

**VERDICT: sign-off**

---

## operations.md

No findings. Only Gops-1 (P1, which explicitly subsumes Gops-2/P2 "same root
cause, same requirement, rolled in") is promoted; Gops-3 (P2, a
self-documented, author-flagged scale seam) is correctly left in the
backlog. Rops-1's acceptance criterion is a pure filter-clause assertion
test, fully automatable given the array-returning DB mock pattern already in
use elsewhere in this file. No manufactured work found.

**VERDICT: sign-off**

---

## integrations.md

No findings. Only Gint-1 and Gint-2 (both P1) are promoted; Gint-3 and
Gint-4 (both P2) are correctly left in the backlog with reasons tied to
evidence (HCP is key-blocked with no recurring sync to validate against; the
AI card has no connect/disconnect lifecycle to lie about). Both
requirements' acceptance criteria are pure status-derivation-function unit
tests. No blocked-on-credentials work is proposed (the spec explicitly
excludes HCP live-API work and FieldPulse full-import in Non-goals, citing
the correct API-key blockers). No invariant violations — the "never return a
secret" check is explicitly re-asserted for the one new field
(`lastSyncError`) added to the response shape.

**VERDICT: sign-off**

---

## inventory.md

No findings. Only Ginventory-1 (P1) is promoted; Ginventory-2 and
Ginventory-3 (both P2) are correctly left in the backlog with sound reasons
(a stuck draft PO has no stock/money effect; the pager gap has "no current
risk for a single-location HVAC shop"). Rinventory-1's acceptance criterion
is fully testable via existing pure-function patterns (`field-queries.ts`
already has a best-effort `.catch()` test convention for the symmetric add
path). The spec is unusually disciplined about NOT overreaching: it
explicitly declines to solve the clamp-at-0 restock-precision edge case
inside the same fix, calling it out as a known, accepted, documented
limitation rather than quietly expanding scope to cover it.

**VERDICT: sign-off**

---

## fieldpulse-import.md

No findings. Only Gfieldpulse-import-1 and -2 (both P1) are promoted;
-3, -4, -5 (all P2) are correctly left in the backlog and named by id in
Non-goals. Both requirements' acceptance criteria lead with pure-function
tests (`latestRunPerPhase`, `isStaleRun`) and clearly separate the
rendering-level checks into the Verification section's Manual/visual step
rather than claiming them as automated. The spec explicitly excludes a
"trigger import" button specifically because it's blocked on a FieldPulse
API key this repo doesn't have (Non-goals) — the correct call given lens 6.
Observability-only invariant is preserved by design (Rfieldpulse-import-2's
staleness check is a pure client derivation, never a write).

**VERDICT: sign-off**

---

## platform.md

No findings. Gplatform-1 (P0, self-purge/lockout) and Gplatform-2 (P1,
unreadable cross-tenant audit trail) are the only items promoted;
Gplatform-3 and Gplatform-4 (both P2) are correctly left in the backlog.
The P0 rating on Gplatform-1 is exactly right by METHOD.md's own bar — an
irrecoverable, one-click, product-wide lockout is about as "broken" as a gap
gets. Rplatform-2's acceptance criterion leads with a pure row-shaping
function test and correctly scopes the new route's payload to
non-PII fields (action, actor email, target org id, created at — no
`details` payload), consistent with the "audit `details` never carries PII"
invariant the spec itself restates. No manufactured work: the spec
explicitly declines search/filter/pagination, a per-org drill-in page, and
any in-app grant path for platform authority, each with an evidence-based
reason.

**VERDICT: sign-off**

---

## Summary

| id | spec | severity | tag |
|---|---|---|---|
| W-S-1 | staff.md ↔ technicians.md | blocker | verified |
| W-S-2 | staff.md | major | verified |
| W-S-3 | settings.md | major | verified |
| W-S-4 | audit-log.md | major | inferred |
| W-S-5 | staff.md | minor | inferred |

Counts: 1 blocker, 3 major, 1 minor.

**Per-spec verdicts:** reports.md — sign-off · operations.md — sign-off ·
staff.md — blocked · settings.md — blocked · integrations.md — sign-off ·
inventory.md — sign-off · audit-log.md — blocked · fieldpulse-import.md —
sign-off · platform.md — sign-off.

**Smuggled-P2 instances found:** one — settings.md's Rsettings-1 bundles
Gsettings-1b (explicitly rated P2 in the Gaps table, and explicitly
reaffirmed as backlog-only in the Non-goals section) into the P1 Rsettings-1
as tested, in-scope work (W-S-3). This is the same violation class already
caught twice in this program's money-scope review (pricebook.md's
Rpricebook-4, estimates.md's Restimates-3) — three instances now, all in
different specs, all the same mechanical shape: a gap-table P2 rating and a
Requirements-section deliverable that silently disagree. Unlike the prior
two, this instance is small (a one-field schema deletion plus one test, not
a new validation feature), so it's rated `major` rather than `blocker`.

**Do the two migration-proposing specs collide?** Yes — confirmed, not
hypothetical. `staff.md`'s Rstaff-1 and `technicians.md`'s Rtechnicians-1
(the latter outside this review's nine-spec assignment but directly
implicated by lens 7's own prompt) independently propose authoring a new
hand-authored migration to recreate the identical `users` trigger
(`trg_enforce_last_active_admin` / `enforce_last_active_admin()`), reached
via the same code-archaeology (commits `392cbc4`/`0cea181`), with zero
cross-reference between the two spec files in either direction (verified by
grep). See W-S-1.

**Single worst calibration error:** W-S-1, the staff.md/technicians.md
migration collision. It's the only `blocker` in this batch, it's fully
`verified` (not inferred), and unlike a mis-rated severity label (which
costs nothing if the item was going to be built either way), an
uncoordinated duplicate migration is a genuine implementation-time hazard:
two independent plan→build→review cycles could each try to claim the same
migration slot, or one could silently satisfy the other's requirement while
both specs still list it as open work. This is exactly the kind of
cross-spec blast-radius problem the severity-gate process is supposed to
catch before either spec reaches the planning stage, and it was missed
because the two specs were evidently authored (and evidence-gathered)
independently without checking whether another in-flight spec already
covered the same fix.
