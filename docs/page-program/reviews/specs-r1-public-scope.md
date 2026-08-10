# Adversarial review — round 1 — severity calibration & scope discipline

**Lens:** does each spec ask for the right work at the right priority?
Factual accuracy of individual claims is out of scope (another critic's lens);
this review only judges P0/P1/P2 calibration, testability of acceptance
criteria given the no-jsdom/RTL constraint, invariant safety, cross-spec
contradictions, and blast radius/migration disclosure.

**Specs reviewed:** `home.md`, `chat.md`, `auth.md`, `portal.md`, `tech.md`

---

## Findings

### P-S-1 — home.md — Rhome-1 is rated P1 but reads as P2 polish

- **severity:** major
- **tag:** verified
- **quote:** `"No page-specific SEO/social metadata — home ships the generic app-wide `<title>HVAC Customer Service</title>` and description instead of Spears branding used throughout the visible page, and no Open Graph tags exist for social shares | P1 |"`

METHOD.md defines P1 as a "workflow hole." A missing branded `<title>`/
`description`/Open Graph tag doesn't obstruct anything in the product's
actual workflow — a visitor who lands on `/` can still read the page, start
a chat, or call. The effect (if any) is on pre-arrival acquisition: how the
link previews in a search result or a social share. That is squarely P2
"polish" by the spec contract's own definitions, not a functional hole.

This matters more than a one-tier severity quibble: **Rhome-1 is the only
requirement opened in the entire home.md spec.** If it's actually P2, the
whole spec fails the severity gate ("only P0/P1 gaps become requirements")
and the entire brainstorm→spec→review→plan→implement→review pipeline for
this page is being run to fix a meta tag — the "manufactured work to look
productive" failure mode this review is explicitly hunting for, in a repo
whose own home.md brainstorm section is otherwise commendably disciplined
(it rejects six other ideas as YAGNI/out-of-scope). The one thing it did
accept should get the same scrutiny.

**What it should be:** P2, filed in `README.md`'s backlog table alongside
G2–G4, not opened as a requirement in this pass — unless the author can
articulate a concrete conversion/workflow harm (e.g., "N% of paid traffic
bounces off an unbranded snippet"), which the spec doesn't attempt.

### P-S-2 — auth.md — Rauth-2 needs a schema migration the spec never names as one

- **severity:** major
- **tag:** verified
- **quote:** `"Rauth-2's exact storage mechanism (new column vs. reusing a timestamp) is a plan-phase decision, not specified beyond "cheap, one DB read, compared inside the existing revocation check.""`

Verified against `src/lib/db/schema.ts`: the `users` table (`:259-...`) has
no `passwordChangedAt` or `tokenVersion` column, and
`grep -rln "password_changed\|token_version" drizzle/` returns nothing — no
migration ever added one. So satisfying Rauth-1's own acceptance criterion
("a stored per-user marker … embedded in the JWT at sign time and bumped in
the same statement that updates `passwordHash`") requires a **new column on
`users`**, i.e. a hand-authored migration under AGENTS.md's process
(`drizzle/00XX.sql` + `--> statement-breakpoint` + `_journal.json` +
snapshot copy, then `drizzle-kit generate` must report "No schema
changes"). It also requires touching JWT-signing code in more than one
place — `src/lib/auth/config.ts` (admin) and `src/lib/auth/tech-config.ts`
(technician) both mint tokens, and `isSessionUserCurrent` in
`session-revocation.ts` is shared by both session types — so the real
change surface is wider than "extend one function."

None of this is wrong to build, but the spec's Non-goals section frames the
storage mechanism as an open "plan-phase decision" without flagging that
*either* choice requires a migration, and the Verification section
(`npx tsc --noEmit`, eslint, vitest, the auth regression pack) never
mentions `drizzle-kit generate` or a `drizzle/00XX.sql` file — the exact
process AGENTS.md makes non-negotiable for schema changes. A plan-phase
reader could reasonably miss that this is a migration-carrying requirement
until they're mid-implementation.

**What it should say:** state explicitly that Rauth-2 requires a new
`users` column and a hand-authored migration per AGENTS.md, and add
"`drizzle-kit generate` reports no schema changes after the hand-authored
migration" to the Verification section.

### P-S-3 — tech.md — Rtech-1's acceptance criterion claims a testability the repo doesn't have

- **severity:** major
- **tag:** verified
- **quote:** `"Acceptance: at a 390px viewport, the rendered hit area (padding included, verified via computed style or a wrapping element) of the remove control in the materials list is ≥44×44px."`

"Verified via computed style" reads as an automatable check (e.g., a test
that renders the component and reads `getComputedStyle`). The repo has no
jsdom/RTL (AGENTS.md: "No jsdom/RTL — pure-helper vitest only"), so nothing
in `npx vitest run` can render this button and measure it. The spec's own
Verification section (§8) later concedes this: `"could not verify with
existing tooling — `mint-admin-session.mjs` / `screenshot-page.mjs` only
mint an `hvac_admin_session` cookie; the tech portal gates on the separate
`hvac_tech_session` cookie"` and requires *new* tooling (a tech-session-
minting screenshot variant) or a fully manual pass. That caveat is good and
honest — but it belongs in the Requirements section's acceptance criterion
itself, not three pages later, since a plan-phase reader working from §5
alone would reasonably believe "computed style" verification is available
today.

**What it should say:** fold the §8 caveat into Rtech-1's acceptance
criterion directly: "verified by a manual `/tech-login` pass and
screenshot at 390px width — no automated check exists for rendered
dimensions in this repo," and list "build a tech-session-minting variant of
`screenshot-page.mjs`" as part of the requirement's own scope, not an
implicit prerequisite discovered in Verification.

### P-S-4 — tech.md — Rtech-2 has the identical unstated-tooling gap as Rtech-1

- **severity:** major
- **tag:** verified
- **quote:** `"Acceptance: each listed control uses a button size variant (existing `lg`/`icon-lg` at 36px do not qualify; needs a new ≥44px variant or explicit height) measured ≥44px at 390px width."`

Same defect as P-S-3: "measured ≥44px at 390px width" is only checkable by
rendering the page in a real viewport. §8 scopes its "could not verify with
existing tooling" admission to `"Verifying Rtech-1/Rtech-2 needs a
tech-session-minting variant of the script…"` — so this one is at least
named in §8 (better than Rtech-3/4/5 below), but the acceptance criterion
in §5 still doesn't say so itself.

### P-S-5 — tech.md — Rtech-3's acceptance criterion needs a render+interaction test that has no verification path anywhere in the spec

- **severity:** major
- **tag:** verified
- **quote:** `"Acceptance: simulating a fetch failure renders a retry control; tapping it re-invokes the same load function and clears the error on success, without a full page reload."`

"Renders a retry control" and "tapping it" describe DOM output and user
interaction — unlike Rtech-4's confirm-affordance case, §8's verification
list for tech.md never extends its "needs a tech-session-minting variant of
the script, or a manual `/tech-login` pass" note to Rtech-3. The
Verification section's only nod to test coverage is the general line "any
new logic worth testing — e.g. a pure 'is this a destructive status'
predicate for Rtech-4, or a retry-payload helper for Rtech-5 — ships as an
extracted pure function," which explicitly names Rtech-4 and Rtech-5's
*payload/predicate* logic but not Rtech-3, and even for those two, a pure
helper test proves the retry *payload* is correct — it doesn't prove the
retry *control renders* or that *tapping it* re-invokes the fetch, which is
what the acceptance criterion actually promises. As written, Rtech-3 has no
stated way to be verified true or false in this repo.

### P-S-6 — tech.md — Rtech-4's acceptance criterion has the same gap; not covered by the manual/visual step either

- **severity:** major
- **tag:** verified
- **quote:** `"Acceptance: tapping "Cancelled" or "Completed" shows a confirm affordance before the `POST /api/tech/jobs/[id]/status` request fires; the other three targets POST immediately as today."`

The Verification section's mention of "a pure 'is this a destructive
status' predicate for Rtech-4" covers only the classification logic (is
`cancelled`/`completed` in the destructive set) — it does not cover the
actual behavioral promise, which is sequencing ("shows a confirm affordance
*before* the POST fires"). That sequencing can only be observed by
rendering the component and simulating a tap, which is unavailable given no
jsdom/RTL, and §8's manual-screenshot carve-out is scoped only to
Rtech-1/Rtech-2's static sizing, not to Rtech-4's interactive sequencing (a
single screenshot can't show "before a POST fires" either — that needs
network inspection during a live manual pass, which isn't described).

### P-S-7 — tech.md — Rtech-5's acceptance criterion has the same gap

- **severity:** major
- **tag:** verified
- **quote:** `"Acceptance: simulating a network failure on submit leaves the form's input populated (not cleared) and shows a retry control; tapping it re-POSTs without requiring the technician to retype anything."`

Same shape as P-S-5/P-S-6: "the form's input populated," "shows a retry
control," "tapping it re-POSTs" are all render/interaction facts. §8 names
only "a retry-payload helper for Rtech-5" as the pure-testable slice — that
proves the retry POST body is reconstructed correctly, not that the input
field visually retains its value or that a retry control appears. Three of
five tech.md requirements (Rtech-3, -4, -5) share this same unstated gap;
recommend the reviser address it once, systemically, rather than
per-requirement — e.g. by adding an explicit "manual `/tech-login` +
screenshot pass, one per requirement" line to §8 the same way it already
exists for Rtech-1/2, or by being honest that these three requirements are
verified by code review + manual QA, not by the automated gate.

### P-S-8 — tech.md — Gtech-1 (P0) vs Gtech-2 (P1) severity split is a judgment call worth double-checking

- **severity:** minor
- **tag:** inferred
- **quote:** `"Gtech-1: "Remove material" control is a bare icon button with no padding — hit area ≈16×16px, far below any touch-target floor | P0 |"`

Both Gtech-1 (≈16×16px, rated P0) and Gtech-2 (28–36px, rated P1) are the
same underlying defect class (sub-44px touch targets on the core field
flow) at different degrees of severity. Rating the smaller one P0
("broken/wrong" per METHOD.md) while five-to-eleven-times-larger-but-still-
noncompliant targets are P1 is internally consistent (smaller = worse) but
debatable against METHOD's own P0 bar — nothing is functionally *broken*;
a 16px hit area is still tappable, just harder. This reads more like the
worst instance of a P1 class than a distinct P0. Not blocking — the
distinction is defensible given the field-use context (one-handed, at a
furnace) — but flagging since a P0 rating is what forces this into "must
fix before P1 items" priority ordering, and the gap between "the app's
core action is impossible" (a true P0) and "the smallest button on the page
is annoying to tap precisely" is real.

---

## Non-findings worth recording (calibration checked, found sound)

- **auth.md Gauth-1/Gauth-2 (both P1, login-CSRF and no session-revocation-
  on-reset):** checked against real-world exploitability. Both are genuine
  login-CSRF-class issues (account-association tricks, not direct victim-
  session theft) and a stale-token-after-reset window — real, worth fixing,
  correctly short of P0 "broken" since nothing malfunctions for a normal
  user today. Not inflated, not deflated.
- **portal.md Rportal-1 (P0, bearer token leaking to Vercel Analytics) and
  Rportal-2 (P0, service history silently empty for every customer):** both
  match METHOD's P0 bar precisely — a live security/privacy leak of a
  payment-capable bearer token, and a feature that is completely
  non-functional for 100% of users. Correctly the highest tier.
- **chat.md Gchat-1 (P1, dead History sidebar):** correctly P1, not P0 — a
  secondary feature is non-functional, but the primary intake→submit
  workflow is unaffected. Rchat-1's acceptance criterion is a model for
  this program: it names a pure, jsdom-free unit test for the logic
  ("linked session → truthy prop, unlinked → null") *and* separately labels
  the rendering check as manual/visual in §8 — no untestable claim hides in
  the Requirements section itself. No finding.
- **chat.md invariants:** explicitly confirms Rchat-1 touches only
  `use-chat-session.ts`/`history-sidebar.tsx`/`chat-experience.tsx`, nowhere
  near `output-guardrail.ts` or the FROZEN prompt strings, and calls this
  out by name. The highest-risk spec in this batch stays clean of the
  guarded-flush/guardrail surface.
- **portal.md invariants:** correctly preserves "token is the sole
  authority," cost/PII exclusion, hashed-at-rest tokens, and the
  no-sentiment-gating review requirement across all four requirements; no
  violation found.
- **No cross-spec file contradictions found.** `auth.md` and `tech.md` both
  reference `/tech-login` and `/api/auth/tech/login`, but auth.md's Rauth-1
  change (Origin check on the tech-login POST route) and tech.md's five
  requirements (all scoped to `/tech/jobs*` UI, not the login route) don't
  touch the same lines. `home.md` and `auth.md` state the same
  `?password=1` invariant identically — reinforcing, not conflicting.

---

## Verdicts

| Spec | Verdict |
|---|---|
| home.md | blocked |
| chat.md | sign-off |
| auth.md | blocked |
| portal.md | sign-off |
| tech.md | blocked |
