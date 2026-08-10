# Adversarial review — round 1 — lens: severity calibration & scope discipline

Reviewer judges whether each spec asks for the RIGHT work at the RIGHT
priority per `docs/page-program/METHOD.md`'s severity gate ("Only `P0` and
`P1` gaps become implementation work in this run. `P2` items are recorded in
the spec and left in the backlog table"). Facts are assumed correct (that's
another critic's lens); this pass is about manufactured work, mis-rated
severity in either direction, untestable acceptance criteria, invariant
violations, and blast radius. Specs reviewed: `dashboard.md`, `calendar.md`,
`dispatch.md`, `requests.md`, `technicians.md`, `map.md`.

---

## dashboard.md

### O-S-1 — `major` — `verified`

Gap table rates this **P2**:

> `page-dashboard/SKILL.md:27` claims the overview query runs "in one round-trip", inaccurate while `Promise.all` (not `db.batch`) is used | P2 |

Yet the very next section builds fixing it as part of a required, in-scope
deliverable's acceptance criterion:

> **Rdashboard-1**: `getDashboardOverview` (`queries.ts:1187-1266`) uses `db.batch([...])` in place of `Promise.all([...])` for its four queries, matching `ai-insights-queries.ts`/`conversation-queries.ts`/`crm-queries.ts`. `page-dashboard/SKILL.md:27`'s round-trip claim is corrected to match reality.

And the spec's own post-Requirements recap claims the opposite — that this
exact item stays unbuilt:

> G3-G5 (P2) are recorded as backlog per the severity gate (`METHOD.md:41-43`) and are not implementation work in this pass.

This is the identical process violation already caught twice in this program
(`reviews/specs-r1-money-scope.md`'s M-S-1/M-S-3 on `pricebook.md`/
`estimates.md`): a Gaps-table P2 quietly becomes required work, and the
"stays backlog" recap sentence is written as if it doesn't. I rate this
`major` rather than `blocker` because the smuggled item itself is a one-line
doc-string correction, not a money/security bug, and METHOD.md separately
mandates skill updates "in the same commit when files/flows/invariants
change" — so the work happens regardless of its Gaps-table label. That
mitigating fact should be *stated* in the spec (e.g., "G4 rides along with
Rdashboard-1 because the skill-update gate requires it anyway, not because
it was promoted") rather than left as an unacknowledged contradiction between
the acceptance criterion and the recap sentence.
**Fix**: either say explicitly why G4 rides along with Rdashboard-1, or drop
the round-trip-claim clause from Rdashboard-1's acceptance criterion and let
the skill-update gate handle it silently.

### O-S-2 — `minor` — `verified`

> **Acceptance criterion:** the dashboard payload/UI includes a visible element showing the current overdue-invoice count, sourced from a tenant-scoped query that reuses (imports or matches verbatim) the overdue SQL predicate at `page-invoices/SKILL.md:41-43`; clicking it navigates to `/admin/invoices`; a pure-helper vitest test asserts the count matches `invoice-queries.ts`'s overdue predicate for a fixture set of invoices.

The acceptance criterion has three clauses: element renders, count is
correct (covered by the pure-helper vitest test), and **clicking it
navigates to `/admin/invoices`**. Section 8 Verification only exercises the
first two:

> 5. Visual: ... `node scripts/agent/screenshot-page.mjs /admin 1440` and `... 390` — look at both; confirm Rdashboard-2's new element renders without regressing the existing stat-card/list-card layout.

No verification step (automated or manual) actually clicks the element and
confirms navigation — a static screenshot proves the tile renders, not that
it links anywhere. Minor because it's a one-line fix (add "click it" to the
manual-visual step), but as written the acceptance criterion has an
unverified clause.

**VERDICT: blocked** (on O-S-1; O-S-2 is a one-line fix, not itself
blocking).

---

## calendar.md

### O-S-3 — `minor` — `inferred`

> **Acceptance**: inspect the rendered DOM for dnd-kit's live region and confirm it updates with human-readable text on a simulated drag start/end; the announcement formatter is a pure function covered by `vitest` (no jsdom/RTL).

This repo has no jsdom/RTL, so "inspect the rendered DOM ... on a simulated
drag start/end" cannot be an automated vitest assertion — it can only be a
human looking at a live page (Playwright/screenshot). The clause is not
labeled manual where it appears (unlike Rcalendar-1's parallel clause, which
says "screenshot or DB read" explicitly). Section 8 item 6 does separately
call this a "spot check," so a careful reader resolves the ambiguity two
sections later — but the acceptance criterion itself reads as if both halves
might be automatable, which risks an implementer treating the DOM-inspection
half as a to-be-automated test rather than a manual gate. Recommend labeling
the first clause "manual:" inline, matching Rcalendar-1's convention.

No other findings on `calendar.md`: the two P1 gaps map 1:1 to Rcalendar-1/2,
and all three P2 gaps (G3 tab-stop, G4 poll flicker, G5 duplicate today-calc)
are correctly and completely listed in Non-goals with no partial promotion.

**VERDICT: sign-off** (O-S-3 is cosmetic wording, not a scope/severity
defect).

---

## dispatch.md

### O-S-4 — `major` — `inferred`

The spec signs off the entire board with:

> No P0 or P1 gaps found. The four target lenses (auto-assign invariant, shadow-mode isolation, graceful degradation, telemetry correctness) all checked out — see Current state for the trail.

But its own Gaps table rates this **P2**:

> Gdispatch-3: board-card time display forces `timeZone: 'UTC'` (`dispatch-column.tsx:29-33`) while the board is bucketed by BUSINESS (Eastern) day — a card's displayed hour can read differently from the Eastern wall-clock the bucketing implies | P2 | `dispatch-column.tsx:25-34` vs Eastern-anchored `businessDayBounds` (`queries.ts:1280-1288`) — inferred (display-only; not confirmed against a live example this session)

Taken at the spec's own description, this isn't an edge case: if a
formatter is hard-coded to `timeZone: 'UTC'` while every other piece of this
page (bucketing, business-day anchoring) is Eastern-anchored, every card's
displayed arrival hour would be off by the full ET-UTC offset (4-5h
depending on DST) — always, not intermittently. This is the one screen
whose entire purpose is time-sensitive placement ("give a dispatcher one
screen to see and place every request for a single business day" — §1); a
systematically wrong displayed hour on every card is closer to "broken/wrong"
(P0) than "polish" (P2), and at minimum clears P1 ("workflow hole" — a
dispatcher could misjudge how soon a job needs to be staffed). I rate my own
finding `major` rather than `blocker` because the spec itself flags the
severity as uncertain ("inferred... not confirmed against a live example
this session") — the same caveat that should have prompted verifying this
before signing off the page's confidence-gated autopilot surface with a
clean "0 P0/P1" headline, rather than after. Given lens 4 of this review
explicitly asks whether a 0/0 sign-off on an autopilot surface is earned:
this item is the reason it isn't, as written — the spec needed to either
confirm the magnitude with a live example (raising or lowering the rating
with evidence) or not lead with an unqualified "No P0 or P1 gaps found"
while an unconfirmed, potentially-P1 display bug sits three lines below it
in the same document.

**VERDICT: blocked** (re-verify Gdispatch-3's actual displayed offset against
a live example before repeating the "0 P0/P1" claim; everything else in
Current State — auto-assign invariant, shadow isolation, graceful
degradation, telemetry correctness — is well-evidenced and I found no issue
with those four lenses).

---

## requests.md

No findings. All three P1 gaps (no emergency row escalation, default sort
buries emergencies, no header emergency count) map to Rrequests-1/2/3 without
inflation or padding; all three P2 gaps (missing composite index, no
name/phone search, redundant status index) are explicitly and completely
listed in the post-Requirements recap and in §6 Non-goals — no silent
omission. The apparent partial miss — Rrequests-1 doesn't change the default
sort itself, only adds row-level visual escalation — is not a hidden gap:
Brainstorm states the design choice directly ("Pin/highlight emergencies
regardless of sort — kept (R-1/R-2)"), a reasoned alternative to changing
sort order, not a dropped requirement.

**VERDICT: sign-off**

---

## technicians.md

### O-S-5 — `blocker` — `verified`

The spec's own Current State establishes that the live databases this
program actually deploys to already have the objects Rtechnicians-1's
migration recreates:

> Existing databases (dev, and per `0cea181`'s own commit message, prod) kept the trigger because a squash doesn't drop objects on an already-migrated DB — only the *migration file* disappeared.

`AGENTS.md` states migrations "auto-run in the build" on every deploy. The
acceptance criterion for Rtechnicians-1 never specifies that the new
`0044_*.sql` must be idempotent against an environment that already has
`enforce_last_active_admin()`/`trg_enforce_last_active_admin` (no mention of
`CREATE OR REPLACE FUNCTION` or `DROP TRIGGER IF EXISTS` anywhere in the
Requirements, Invariants, or Verification sections):

> **Acceptance criterion**: a new `drizzle/0044_*.sql` recreates `enforce_last_active_admin()` and `trg_enforce_last_active_admin` verbatim ... using `--> statement-breakpoint` separators per `AGENTS.md`'s hand-authored-migration convention; `drizzle/meta/_journal.json` gets the matching entry and a snapshot copy exists; running `npx drizzle-kit generate` afterward reports "No schema changes"

If the migration issues plain `CREATE FUNCTION`/`CREATE TRIGGER` (the literal
reading of "recreates ... verbatim"), running it against DEV or PROD — the
only two real environments in this repo, both of which already have these
objects per the spec's own verified evidence — will error at
already-exists, and because migrations auto-run in the build, that failure
happens **at deploy time**, on the next `vercel deploy --prod --yes` after
this migration ships. The spec's own Verification section then contradicts
itself about how this would even be caught pre-deploy:

> Manual: apply the new migration to a scratch/local Postgres (or the DEV Neon branch, never prod) and confirm `SELECT tgname FROM pg_trigger WHERE tgrelid = 'users'::regclass` includes `trg_enforce_last_active_admin` starting from a database that had NOT already had it (i.e., actually proves the migration — not just an already-migrated DB — creates it).

This sentence simultaneously (a) offers the DEV Neon branch as an acceptable
test target and (b) requires the test target to be "a database that had NOT
already had it" — but the spec's own Current State says DEV already has it.
DEV therefore cannot satisfy this instruction as written, and the spec gives
no other concrete environment to test against, and no idempotency guard in
the acceptance criterion to make the DEV/PROD case safe in the first place.
This is exactly the "blast radius without a rollback story" the task's lens
7 asks about: the fix for a real P0 (fresh-DB safety gap) risks breaking the
auto-run migration step on the two environments that actually matter, with
no stated mitigation.

**Fix**: add an explicit idempotency requirement to Rtechnicians-1's
acceptance criterion (`CREATE OR REPLACE FUNCTION` + `DROP TRIGGER IF EXISTS
... ; CREATE TRIGGER ...`, or an equivalent guard), and correct the
Verification section's self-contradictory instruction about which database
can prove the migration — a spun-up scratch/CI Postgres with a full,
from-scratch migration replay is the only target the spec's own evidence
says qualifies as "had NOT already had it."

**VERDICT: blocked**

---

## map.md

No findings. Gmap-1 (P0) and Gmap-2 (P1) map to Rmap-1/2 without inflation;
Gmap-3 (P2, 200-job hard cap) is explicitly and completely carried into §6
Non-goals with no partial build. Acceptance criteria are honestly split
between automated (`vitest` route/pure-function tests) and manual/visual
(garbage-address seed + screenshot) — no criterion silently requires a
jsdom/RTL render.

**VERDICT: sign-off**

---

## Summary

| id | spec | severity | tag |
|---|---|---|---|
| O-S-1 | dashboard | major | verified |
| O-S-2 | dashboard | minor | verified |
| O-S-3 | calendar | minor | inferred |
| O-S-4 | dispatch | major | inferred |
| O-S-5 | technicians | blocker | verified |

Counts: 1 blocker, 2 major, 2 minor.

**Per-spec verdicts:** dashboard — blocked · calendar — sign-off · dispatch —
blocked · requests — sign-off · technicians — blocked · map — sign-off.

**Worst calibration error:** O-S-5 on `technicians.md`. It's the only
`blocker` in this batch because it isn't a mislabeled-severity nit — it's a
concrete deploy-time failure mode. The spec correctly identifies a real P0
(the last-admin guard trigger is missing from every current migration file)
and writes a plausible-looking fix, but the fix as specified would recreate
database objects that the spec's own Current State proves already exist on
both real environments (dev, prod) this repo deploys to, with no idempotency
requirement in the acceptance criterion and a Verification section that
contradicts itself about which database could even prove the migration
works pre-deploy. Left as written, implementing Rtechnicians-1 risks turning
a documentation-and-safety fix into a broken `vercel deploy --prod --yes`
the next time this org ships anything else. `dispatch.md`'s O-S-4 is the
second-worst: an unqualified "No P0 or P1 gaps found" headline sits three
lines above a gap the spec itself can't rule out being a systematically
wrong time display on every card of a time-sensitive dispatch board —
exactly the kind of false all-clear this lens exists to catch, softened only
by the spec's own honesty in tagging it `inferred`/unconfirmed rather than
asserting it's harmless.
