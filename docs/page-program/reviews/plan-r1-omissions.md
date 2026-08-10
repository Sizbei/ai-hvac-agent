# Plan review — round 1 — lens: OMISSION AND HONESTY

Reviewer judges only whether `docs/page-program/PLAN.md` is a truthful,
complete account of what the program found — not whether the individual
fixes are well-designed (other critics' lens). Method: read `PLAN.md` in
full (final state, 152 lines); read every P0/P1 Requirements entry in all 30
specs under `docs/page-program/specs/`; read all 14 files in
`docs/page-program/reviews/` in full (`*-evidence.md`, `*-missedrisk.md`,
`*-scope.md` for the customers, money, operations, public, and workspace
clusters — note `customers` has no `missedrisk` file; that is a gap in the
upstream review process, not something `PLAN.md` misrepresents, so it is not
scored here); cross-referenced every `Rxxx-N` id and every `blocker`/`major`
review finding against the plan's Waves, Reviser-decisions table, and
"Not being built" list.

The plan is under active revision (it grew from 119 to 152 lines, and the
review directory grew from 10 to 14 files, over the course of this pass) —
several defects this review would otherwise have flagged first (the
`0008`-vs-`0027` migration mixup, the non-idempotent-migration deploy risk,
the `dispatch.md` UTC-timezone bug, the `platform_audit_log`/`org_provisioned`
gap) were fixed by the reviser while this review was in progress. Findings
below are against the current, stable, final text (confirmed stable via two
successive re-reads with an identical hash).

## Findings

### O-1 — blocker — verified — Wave D's "best-effort" framing buries four P0-severity requirements

**Quote (verbatim):** `## Wave D — workflow holes (best-effort; ordered by value)`

Four requirements sitting inside Wave D are P0 in their own spec's Gaps
table, the same severity tier as every item in Wave A ("security and
safety") and B4's `Restimates-1`:

- `Rconv-1` — `conversations.md`'s `Gconv-1` is rated **P0** ("The
  human-reply / takeover feature has a complete, tested backend and zero UI
  entry point"); the spec's own Brainstorm section even states "Decision:
  wire it (P0)". Lives in `D1`.
- `Rcommunications-1` (merged with `-4` per the Reviser-decisions table) —
  `communications.md`'s corresponding Gap ("Templates CRUD... rejects...
  4 of 15 live trigger types") is rated **P0**. Lives in `D6`.
- `Rcommunications-3` (re-scoped per the Reviser-decisions table) —
  `communications.md`'s corresponding Gap ("Deleting a template
  CASCADE-deletes all its `communication_jobs` history...") is also rated
  **P0**. Lives in `D6`, alongside the P0 item above.
- `Rtech-1` — `tech.md`'s `Gtech-1` ("bare icon button... hit area
  ≈16×16px") is rated **P0**. Lives in `D4`.

METHOD.md's severity gate treats P0 as unconditional implementation work —
the same bar Wave A/B/C items are held to. "Best-effort; ordered by value"
is a materially weaker commitment than the rest of the plan gives P0/P1 work
sequenced into Waves 0-C. Grouping by problem theme ("workflow holes") is a
reasonable organizing principle, but labeling the whole wave "best-effort"
erases the severity distinction between these four P0 items and the P1
items sharing the same wave (`D7`'s `Rstaff-2,3`, `D8`'s `Rsettings-1`) —
exactly the failure mode this lens was asked to check for.

**What the plan should say instead:** either drop "best-effort" from Wave
D's heading and state explicitly that its P0 items (`Rconv-1`,
`Rcommunications-1/-3`, `Rtech-1`) are committed the same as Wave A-C, with
only the P1/P2-adjacent remainder genuinely discretionary, or split Wave D
into a committed sub-list (the P0s) and a true best-effort remainder.

---

### O-2 — blocker — verified — "Not being built" contradicts Wave C's own C7 entry on the same page

**Quote (verbatim), "Not being built" section:**
> `- `dispatch` — 0 P0/P1. The spec signed the page off and the evidence held.`

**Quote (verbatim), Wave C, item C7:**
> `| C7 | **new — P1** (ops-scope O-S, verified by me) | Dispatch board job cards format a real ISO instant with `timeZone: 'UTC'` (`dispatch-column.tsx:29-33`), so every arrival time on an Eastern-anchored board displays 4–5 hours off. ... This partially overturns `dispatch.md`'s 0 P0/P1 all-clear | `src/components/admin/dispatch/dispatch-column.tsx` |`

These two sentences are both currently in the document and directly
contradict each other. C7 is real, committed work for the `dispatch` page,
explicitly labeled P1, with the plan's own text stating it "partially
overturns `dispatch.md`'s 0 P0/P1 all-clear." The "Not being built" bullet
was never updated to reflect this — it still asserts, unqualified, that
`dispatch` has zero P0/P1 work and needs nothing. A reader who reads only
"Not being built" (exactly the section this lens exists to audit) is told
something the plan's own Wave C disproves three sections earlier.

**What the plan should say instead:** delete the `dispatch` bullet from
"Not being built" (it is not an accurate description of the plan's own
scope), or reword it to something like: "`dispatch`'s confidence-gate and
shadow-mode invariants — the page's two highest-risk lenses — signed off
clean; the one gap found (`C7`, timezone display) is built, not deferred."

---

### O-3 — major — verified — `A7` closes only part of `P-R-1`; two of its five sub-findings are never mentioned

`specs-r1-public-missedrisk.md`'s `P-R-1` (blocker) has five numbered
sub-findings. `PLAN.md`'s `A7` addresses sub-findings 1-2 (extend the
ZIP-verify gate to every `account-data-*` intent) but its file list —
`src/lib/ai/account-verify.ts`, `src/app/api/chat/route.ts` — never touches
two of the other three:

- **Sub-finding 3** (the ZIP lockout is cheaply resettable: 2 attempts per
  session, a fresh session every ~12s, no per-customer/per-phone throttle)
  applies to every account-data intent, including the two that already
  require ZIP-verify today. `A7` widens *which* intents require the gate;
  it does nothing to the gate's own weakness. Not mentioned anywhere in
  `PLAN.md`.
- **Sub-finding 4** (`GET /api/chat/history` already returns a stranger's
  past-conversation previews today, gated only by the same weak
  contact-match `customerId` link, independent of any UI) is not in `A7`'s
  file list (`chat/history/route.ts` is never named anywhere in `PLAN.md`).

This matters specifically because `D11` states: *"`Rchat-1` history sidebar
— **blocked behind A7**: the spec's fix trusts 'a contact-field match' as
the signal to surface a customer's past conversations, which inherits
exactly the authorization gap A7 closes."* If `A7` does not touch
`chat/history/route.ts`, the route stays exploitable by direct fetch with
or without `Rchat-1`'s UI wiring — blocking the UI behind `A7` does not
make the underlying API safe, and the plan's own wording ("the
authorization gap A7 closes") overstates what `A7`'s stated scope actually
closes.

**What the plan should say instead:** either widen `A7`'s file list to
include `chat/history/route.ts` (route it through the same identity check),
or add an explicit line acknowledging sub-findings 3 and 4 are known,
deferred gaps with a reason — the same treatment the plan gives `M-R-1`/
`M-R-2` in "Not being built."

---

### O-4 — major — verified — `P-R-2` (chat's per-instance rate limiter on its highest-cost surface) is never mentioned

`specs-r1-public-missedrisk.md`'s `P-R-2` (major, verified): `/api/chat` and
`/api/session` — the two routes in the entire public surface that spend
real money per request (LLM calls) — share the same per-serverless-instance,
in-memory `slidingWindow` rate limiter that `auth.md` already names as a
tracked gap (`Gauth-4`) for a *lower*-cost surface (bcrypt compares). No
Wave item, no Reviser-decisions row, and no "Not being built" entry
addresses or acknowledges this anywhere in `PLAN.md`.

**What the plan should say instead:** add a Reviser-decisions row or a
"Not being built" entry, e.g.: "`chat` P-R-2 — per-instance rate limiter on
the LLM-cost surface | Accepted, deferred: repo-wide limitation
(`rate-limit.ts`), same root cause as `Gauth-4`; fixing it means adding a
shared store (Redis/KV), out of this program's page-level scope."

---

### O-5 — major — verified — `settings.md`'s smuggled-P2 finding (`W-S-3`) has no Reviser-decisions row

`specs-r1-workspace-scope.md`'s `W-S-3` (major, verified) found that
`settings.md`'s `Rsettings-1` bundles `Gsettings-1b` — a gap the spec's own
Gaps table rates **P2**, and whose Non-goals section explicitly states
"Gsettings-1b and Gsettings-3 (P2) stay in the backlog per METHOD.md's
severity gate" — into the P1 `Rsettings-1` deliverable as tested, in-scope
work (deleting the unreachable `businessInfo.email` schema field). This is
the identical mechanical pattern (`pricebook.md`'s `Rpricebook-4`,
`estimates.md`'s `Restimates-3`) that `PLAN.md`'s Reviser-decisions table
explicitly caught and fixed via a dedicated row for `pricebook`/`estimates`
(the `M-S-1`/`M-S-3` row). There is no equivalent row for `settings`/`W-S-3`
anywhere in the table, and `D8`'s one-line gloss —
`Rsettings-1 (saved-but-ignored `businessInfo.website`)` — describes only
the `website`-field half of the requirement, not the `email`-field deletion
`W-S-3` flagged.

**What the plan should say instead:** add a Reviser-decisions row parallel
to the `M-S-1`/`M-S-3` one, e.g.: "`settings` W-S-3 — Gsettings-1b (P2)
smuggled into Rsettings-1 | Accepted the process error, kept the work: it's
a one-field schema deletion riding along with the `website` fix in the same
file, not a new feature."

---

### O-6 — minor — verified — W0-2's own row says it is "the only migration in the run"; A6 is a second one, two rows later

**Quote (verbatim):**
> `| W0-2 | Re-author the last-admin guard trigger as `drizzle/0044_last_admin_guard.sql` ... | `drizzle/` | Only migration in the run; must land alone to avoid numbering collisions. Serves `Rstaff-1` + `Rtechnicians-1` |`

Two rows later:
> `| A6 | `Rauth-2` | Password reset invalidates prior session tokens. Needs a `users` column — sequence AFTER W0-2 and follow the same hand-authored migration process | `src/lib/auth/`, `drizzle/0045_*` |`

The plan's actual migration count (2: `W0-2`/`drizzle/0044`, `A6`/
`drizzle/0045`) is correct, complete, and correctly sequenced (`A6`
explicitly runs "AFTER W0-2"). No other item in the plan needs a migration
— this was checked against every Wave A/B/C/D item's stated files. This is
a wording defect only: W0-2's own "Why first" column, read in isolation,
misstates itself as the sole migration in the entire run.

**What the plan should say instead:** "Only migration in Wave 0" (or "first
of two migrations in the run — see A6").

---

### O-7 — minor — verified — `C9` labels a `major`-severity finding "P2", inconsistent with `C8`'s treatment of its equal-severity sibling

**Quote (verbatim):**
> `| C9 | **new — P2→built** (ops missed-risk O-R-3) | The dispatch map's technician-location query has no `isActive` filter ... |`

`specs-r1-operations-missedrisk.md` rates `O-R-3` **major**, not P2 — the
same severity as `O-R-2`, which the plan carries into `C8` as
`**new — P1**`. Both findings come from the same review file and are rated
identically there; the plan gives them different labels (`P1` vs.
`P2→built`) with no stated reason for the split. The work still ships
either way (`C9` is built), so this doesn't drop anything — it's a
labeling inconsistency, not lost work.

**What the plan should say instead:** `**new — P1** (ops missed-risk
O-R-3)`, matching `C8`'s treatment, or a one-line reason for rating it
lower despite the source review's `major` tag.

---

### O-8 — minor — verified — `A11`/`A12` are not clearly assigned to a wave in the document's own structure

`A11` (`new — P0`, ops missed-risk `O-R-1`) is appended directly after Wave
A's table with an intervening blank line and no repeated table header —
breaks the table in a strict Markdown renderer. `A12` (`new — P1`, workspace
missed-risk `W-R-2`) is placed physically between Wave C's table (`C1`-`C9`)
and the Wave D heading, with no wave heading of its own, despite its
`A`-prefixed id naturally implying Wave A. Given the plan's own stated
premise — "items inside a wave touch disjoint files and can run in
parallel" — a reader/implementer cannot tell from the document's structure
which wave actually executes `A12` (or, for that matter, whether `A11`
belongs to Wave A's parallel batch or is meant to run after it). This is
presentation debt from incremental editing, not dropped work — both items
are real, cited, and described — but it undercuts the plan's own
parallel-execution contract.

**What the plan should say instead:** move `A11`/`A12` into Wave A's table
proper (or give `A12` its own clearly-labeled placement if it's meant to run
alongside Wave C).

---

## Checked and found honest (no finding)

- **`M-S-5` (`accounting` HCP-never-writes-`payments`, deferred "cross-
  integration change, out of this program's page scope")** — verified
  accurate. The fix lives in `src/lib/integrations/housecall-pro/`, code no
  page spec owns; unlike the blanket "Housecall Pro/FieldPulse API keys the
  repo lacks" exclusion, this gap isn't credential-blocked and the plan
  correctly does *not* claim it is — it gives the real, narrower reason.
- **`M-R-2` (membership-enrollment `chargeFirstPeriod` ledger gap, deferred
  "the Stripe adapter is hardcoded to mock today")** — verified accurate
  against `payments/provider.ts:97-110` and the missed-risk review's own
  framing. The plan explicitly flags it as "a release blocker the day a
  real payment adapter lands" rather than quietly burying it — one of the
  more honestly-framed deferrals in the document.
- **`insights-ai` `Promise.all`→`db.batch` rejection** — sound, not
  self-serving. `.claude/skills/admin-pages/SKILL.md:64-65` lists
  "`db.transaction()` throws — use `db.batch()` (also 1 HTTP round-trip vs
  Promise.all's N)" as one of exactly five repo-wide invariants, on par with
  tenancy/money/demo-account/`after()` — the same invariant `PLAN.md`'s own
  closing "Never touched" list cites. The critic's rebuttal (`C-S-5`, "a
  style/cost rule, not a correctness invariant") is reasonable on `AGENTS.md`
  alone, but doesn't have visibility into `admin-pages/SKILL.md`'s explicit
  bundling of both rationales into one invariant bullet, which is the
  stronger fact the plan should be citing. Minor citation imprecision only:
  the plan attributes this to "`AGENTS.md`," but the round-trip-specific
  framing is `admin-pages/SKILL.md`'s, not `AGENTS.md`'s own (`AGENTS.md`'s
  Hard Invariants bullet only says "`db.transaction()` throws at runtime —
  use `db.batch()`," without the `Promise.all` comparison). Not rated as a
  finding — doesn't change the rejection's soundness.
- **"All 74 P2 items"** — verified exact: `grep -oE '\| *P2 *\|'
  docs/page-program/specs/*.md | wc -l` → `74`.
- **Every other `blocker`/`major` finding across all 14 review files** is
  either accepted or explicitly rejected with a reason in the
  Reviser-decisions table, or built directly into a Wave item with a
  citation back to its source id (`C-S-1/2/3`, `C-S-5`, `C-S-6`, `M-S-1..5`,
  `M-R-2/3`, `O-E-1`, `O-S-4/5`, `P-E-1`, `P-S-1/2/3-7`, `W-S-1`, `W-E-10`,
  `W-R-1/2`, `O-R-1/2/3`). `O-E-1` and `O-S-5` (both technicians.md
  migration-correctness blockers) and `O-S-4`/dispatch's UTC bug and
  `W-R-1`/platform's audit-trail gap were all fixed in the plan's own
  self-revision during this review — see the note at the top.
- **`O-S-1`/`W-S-2`** (dashboard P2-smuggling; staff.md's incomplete
  migration checklist) are substantively resolved (`C3`'s "(repo
  invariant)" parenthetical; `W0-2`'s merge inherits `technicians.md`'s
  fuller checklist) but don't get a dedicated Reviser-decisions row the way
  comparable findings do — noted here as a minor traceability gap, not
  scored as a separate finding since the underlying work is genuinely done.

## Requirement-coverage check

Every `Rxxx-N` id across all 30 specs (72 total: `Raccounting-1/2`,
`Raudit-log-1..4`, `Rauth-1/2`, `Rcalendar-1/2`, `Rchat-1`,
`Rcommunications-1..7`, `Rconv-1..4`, `Rcustomers-1/2`, `Rdashboard-1/2`,
`Restimates-1..3`, `Rfieldpulse-import-1/2`, `Rhome-1`, `Rinsights-ai-1/2`,
`Rintegrations-1/2`, `Rinventory-1`, `Rinvoices-1`, `Rmap-1/2`,
`Rmembership-plans-1/2`, `Rops-1`, `Rplatform-1/2`, `Rportal-1..4`,
`Rpricebook-1..4`, `Rreports-1/2`, `Rrequests-1..3`, `Rreviews-1..3`,
`Rsettings-1/2`, `Rstaff-1..3`, `Rtech-1..5`, `Rtechnicians-1`) was traced
to a Wave item or the "Not being built" list. `dispatch.md` has zero
`Rxxx-N` requirements (0 P0/P1 in its own Gaps table) and is separately
listed in "Not being built" (see `O-2` above for why that listing is now
stale).

**Requirement ids appearing in neither the Waves nor "Not being built":
none.** Every P0/P1 requirement from every spec is accounted for somewhere
in the plan.

## Counts

- Blocker: 2 (`O-1`, `O-2`)
- Major: 3 (`O-3`, `O-4`, `O-5`)
- Minor: 3 (`O-6`, `O-7`, `O-8`)

## Verdict

The plan is **substantially honest but not fully honest as currently
written**. Its strongest evidence of good faith: a complete, zero-gap
requirement-coverage map; a Reviser-decisions table that engages with (and
in one case, `insights-ai`, defensibly rejects) nearly every blocker/major
finding across five independent review clusters; two deliberately-deferred
money gaps (`M-S-5`, `M-R-2`) framed with their real reasons instead of
being hidden under the generic "blocked on API keys" excuse; and visible,
in-progress self-correction (the `W0-2` corrections block, `A11`/`A12`/`C7`/
`C8`/`C9`) that fixed several severe defects — including a real deploy-time
migration hazard and a P0 authorization gap — during the course of this
review.

Against that: two blockers survive in the current text. `O-2` is a plain
factual contradiction on the page — "Not being built" asserts `dispatch`
needs zero P0/P1 work in the same document where `C7` says it partially
overturns exactly that claim. `O-1` is the more consequential one: four
P0-severity requirements are filed under a wave explicitly labeled
"best-effort," which is a real risk of exactly the "swallows real P0 work"
failure mode this review was asked to check for, not a hypothetical one —
`Rconv-1`, `Rcommunications-1`/`-3`, and `Rtech-1` are all confirmed P0 in
their source specs' own Gaps tables. Both are fixable with small edits (one
deleted/reworded bullet; a reworded wave heading or a split wave), not
structural problems with the plan's approach — but as written, a reader
relying on "Not being built" or on Wave D's stated commitment level would be
misled on both counts.
