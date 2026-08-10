# Round 1 — Sequencing, collision and blast-radius audit: PLAN.md

Lens: not "is the work worth doing" but **would dispatching Waves 0/A/B/C to
parallel subagents, as the plan's own claim implies, actually survive
contact with the real repo**. Method: for every item in Wave 0/A/B/C,
resolved the file each item must *actually* touch by reading the code and
following imports/callers — not just the plan's Files column — then checked
same-wave pairs for overlap, checked the two explicit cross-wave orderings
the plan asserts, checked the migration-numbering claim against
`drizzle/meta/_journal.json`, checked the shared-chokepoint item's real
caller graph, and checked whether any item's fix contradicts an assertion
an existing test currently locks in.

**Headline result: zero literal same-wave file collisions found across
Waves 0, A, B, C.** The plan's core claim — "items inside a wave touch
disjoint files" — holds for every pair checked. The real risk this review
surfaces is different: several items' Files columns are **wrong or
incomplete** (point at paths that don't exist, or omit files the fix
necessarily touches), one item (A2) describes work that is **already
shipped**, one item (A7) is a **certain, named test-breaking change** not
disclosed in its Files column, and the shared-chokepoint item (A3)
undercounts its own caller graph in a way that changes what "one guard"
has to mean. None of these are collisions in the sense the plan warns
about; all of them are blast-radius or gate risks a wave-parallel executor
would hit.

## Findings

### S-1 — A2 describes work that is already shipped

**Item:** A2 · **Severity:** major · **Tag:** verified

> `A2 | `Rauth-1` | Apply the repo's existing `isSameOriginRequest` + JSON content-type guard to `/api/auth/login`, `/api/auth/tech/login`, `/api/auth/invite/accept` | `src/app/api/auth/**`, reuse `src/lib/session-csrf.ts` |`

All three routes already have this guard, verbatim, today:

```ts
// src/app/api/auth/login/route.ts:45-52 (tech/login and invite/accept match)
if (!isSameOriginRequest(request)) {
  return errorResponse("Cross-origin request rejected", "FORBIDDEN_ORIGIN", 403);
}
if (!hasJsonContentType(request)) {
  return errorResponse("Expected application/json", "UNSUPPORTED_MEDIA_TYPE", 415);
}
```

`git log` shows this landed in `9991c2e` ("fix(app): R2 adversarial
remediation — security, perf, error-resilience, a11y"), dated
**2026-07-16** — three weeks before `docs/page-program/specs/auth.md` and
`PLAN.md` were authored (**2026-08-11**, per `git log -1 --format=%ci`).
`src/app/api/auth/tech/login/route.test.ts:92-110` already has both
acceptance-criterion tests the spec calls for ("rejects a cross-origin
request with a 403 before touching the DB", "rejects a request with no
Origin header"). The spec (`auth.md:150-161`) was written as if this is
future work; it is describing the pre-9991c2e state.

**Blast-radius risk:** an agent dispatched on A2 with no instruction to
verify current state will either (a) correctly find nothing to do and
report a no-op — a wasted wave slot — or (b) not check carefully, "helpfully"
wrap/duplicate the existing guard, or touch these three route files for no
functional reason, which is exactly the kind of unrelated-line churn that
increases merge risk with nothing gained.

**Recommendation:** drop A2, or replace it with a one-line verification
task ("confirm the guard + tests are present and current, no code change
expected"). Re-run the spec's evidence check against HEAD before trusting
any other requirement in `auth.md` that claims something is *not yet* true.

---

### S-2 — A6's Files column omits the two files the fix actually requires

**Item:** A6 · **Severity:** major · **Tag:** verified

> `A6 | `Rauth-2` | Password reset invalidates prior session tokens. Needs a `users` column — sequence AFTER W0-2 and follow the same hand-authored migration process | `src/lib/auth/`, `drizzle/0045_*` |`

Two files the fix cannot avoid touching are missing from the Files column:

1. **`src/lib/db/schema.ts`** — the hand-authored migration process (per
   `AGENTS.md` and W0-2's own row) ends with `drizzle-kit generate`
   reporting "No schema changes," which only holds if `schema.ts` already
   declares the new column. Confirmed no existing column can be reused:
   the `users` table (`schema.ts:260-290`) has no `tokenVersion` or
   `passwordChangedAt` field today.
2. **`src/lib/admin/staff-queries.ts`** — `passwordHash` is written on
   reset by `resetStaffPassword` (`staff-queries.ts:382-386`, `.set({
   passwordHash, updatedAt: new Date() })`), called from
   `src/app/api/admin/staff/[id]/reset-password/route.ts`. Neither file is
   under `src/lib/auth/`. The spec's own acceptance criterion — "bumped in
   the same statement that updates `passwordHash`" (`auth.md:167`) —
   requires editing exactly this function, not anything in `src/lib/auth/`.

**Collision check:** no other Wave A item touches `schema.ts` or
`staff-queries.ts`, so this is not a same-wave blocker — but a subagent
scoped strictly to the declared Files column would not find the write site
and could not complete the item as specified.

**Recommendation:** correct A6's Files column to `src/lib/db/schema.ts,
src/lib/admin/staff-queries.ts, src/lib/auth/session-revocation.ts,
drizzle/0045_*`.

---

### S-3 — A10's Files glob points at a directory that doesn't exist

**Item:** A10 · **Severity:** major · **Tag:** verified

> `A10 | `Rsettings-2` | Google Calendar / Housecall Pro / FieldPulse credential connect+disconnect require only `getAdminSession()`, not `isSuperAdmin` — any admin can overwrite the org's external CRM credential. Matches the page's own precedent (AI model and billing are both `super_admin`-gated) | `src/app/api/admin/settings/**/connect routes` |`

`src/app/api/admin/settings/` contains exactly one subtree —
`faqs/[id]/`. There is no `connect` route anywhere under `settings/`. The
actual routes are under `src/app/api/admin/integrations/`:

```
src/app/api/admin/integrations/google/connect/route.ts
src/app/api/admin/integrations/housecall/connect/route.ts
src/app/api/admin/integrations/housecall/disconnect/route.ts
src/app/api/admin/integrations/fieldpulse/connect/route.ts
src/app/api/admin/integrations/fieldpulse/disconnect/route.ts
src/app/api/admin/integrations/{google,housecall,fieldpulse}/status/route.ts
```

The underlying spec itself confirms this scope: "`GET`/`POST`/`DELETE`
connect/status/disconnect routes for all three integrations"
(`settings.md:176-179`) — i.e. up to 7 route files under `integrations/`,
not `settings/`.

**Collision check:** `src/app/api/admin/integrations/**` is also the
directory space C5 (Wave C) touches ("`src/lib/admin/integration-queries.ts`,
integrations page"). C5's declared files are query-layer/page-layer, not
these route files, so no *same-wave* collision — but since A10's real
footprint is now known to include the `status/route.ts` files C5 might
also need to touch (to surface `lastSyncError`/`availabilitySyncStatus`),
flag this pair for a quick file-list confirmation before Wave C starts,
even though A precedes C.

**Recommendation:** correct A10's Files column to
`src/app/api/admin/integrations/{google,housecall,fieldpulse}/{connect,disconnect,status}/route.ts`
(7 files) plus each route's `.test.ts` companion where one exists (e.g.
`google/connect/route.test.ts`).

---

### S-4 — A3's "shared chokepoint" undercounts its own callers, and two of the six have no session to check

**Item:** A3 · **Severity:** major · **Tag:** verified

> `A3 | `Rcommunications-2` + `Rreviews-3` | Enforce the demo-account outbound block at the shared chokepoint so BOTH the admin `/api/communications/send` route and the technician-triggered `createReviewRequest` path are covered. One guard, not two | `src/lib/communication/` chokepoint + call sites |`

The actual shared function both named paths funnel through is
`queueCommunicationJob` (`src/lib/communication/job-queue.ts:26`).
Enumerated callers via `grep -rl "queueCommunicationJob"`:

1. `src/app/api/communications/send/route.ts` — admin route, has an
   `AdminSessionPayload` (`isDemoAccount(session)` works).
2. `src/lib/reviews/review-queries.ts` (`createReviewRequest`) — invoked
   from `src/app/api/tech/jobs/[id]/status/route.ts:98` inside a
   fire-and-forget `.catch()`; the function's own signature is
   `(organizationId, serviceRequestId, customerId)` — **no session, no
   email**.
3. `src/lib/admin/warranty-queries.ts` — not named in A3 at all.
4. `src/lib/communication/money-triggers.ts` — not named in A3; this file
   is *also* Wave B's B1 target.
5. `src/lib/communication/triggers.ts` (booking-recovery / renewal
   nudges, per the file's own docstring on cron-driven messaging) — not
   named in A3.
6. `job-queue.ts` itself (`retryFailedJobs`).

`isDemoAccount()` (`src/lib/auth/authz.ts:19-26`) is defined as
`session.email.trim().toLowerCase() === DEMO_ACCOUNT_EMAIL` — it takes a
**session**, and there is no org-id-based equivalent anywhere in the repo
(confirmed: `grep -rn "DEMO_ACCOUNT\|isDemoOrg\|demoOrganizationId"` finds
only the email constant). Callers 3-5 above are cron-driven
(`job-queue.ts`'s own docstring: "Vercel cron") and have no session to
pass `isDemoAccount` at all. Guarding "at the chokepoint" (inside
`queueCommunicationJob`, which only receives `organizationId`) is the only
way to cover all six callers uniformly, but that requires a **new**
org-id-keyed demo check that doesn't exist today and that A3's one-line
description doesn't disclose needing.

**False-positive risk called out by the review brief:** none identified —
org-id-based blocking of the seeded demo org (`slug: "demo-hvac"`) is
strictly what the deliberate demo-account posture wants, and no non-demo
org would be affected. The risk is scope, not correctness: if the guard is
instead bolted on as two route-level `isDemoAccount(session)` checks (matching
the existing pattern in `send-reminder/route.ts` and
`conversations/[id]/message/route.ts`) rather than moved into
`queueCommunicationJob`, the fix satisfies A3's literal acceptance
criterion (both named paths covered) while leaving callers 3-5 unguarded —
which is exactly the "two guards, not one, and still leaky" outcome A3
says it's rejecting.

**Recommendation:** retitle A3's Files line to name the real chokepoint —
`src/lib/communication/job-queue.ts` (`queueCommunicationJob`) — not
"call sites," and add one sentence: the guard must be keyed on
`organizationId` (new helper, e.g. `isDemoOrganization(organizationId)`),
not session email, because 3 of 6 real callers are cron-driven and carry
no session. Sequence B1 (`money-triggers.ts`) to start only after A3
lands, since B1 edits a direct caller of the function A3 changes.

---

### S-5 — A7 will fail 3 named existing tests; its Files column doesn't include the file that breaks

**Item:** A7 · **Severity:** blocker · **Tag:** verified

> `A7 | **new — P0** | **Public chat account-lookup has no possession proof.** A self-reported phone/email links the session to a real customer (`api/chat/route.ts:703-727`), and `requiresVerify` gates only the two `financial` intents — `next-visit`, `appointment-status` and `reschedule` are `"none"` (`src/lib/ai/account-verify.ts:4-13`). Anyone who knows a customer's phone number can pull their upcoming appointment from the public widget. Extend the ZIP-verify gate to every `account-data-*` intent | `src/lib/ai/account-verify.ts`, `src/app/api/chat/route.ts` |`

`requiresVerify` is imported and called directly by
`src/lib/ai/voice-turn.ts:388` (`(requiresVerify(intentId) ||
isVerifyAnswerTurn) && ...`) — **not listed in A7's Files column**.
Extending the gate in `account-verify.ts` therefore changes voice behavior
too, and breaks three tests that currently assert the pre-fix behavior as
correct:

1. `src/lib/ai/account-verify.test.ts:16-23` — `describe("requiresVerify",
   () => { it("gates financial intents only", ...` asserts
   `requiresVerify("account-data-next-visit")` and
   `requiresVerify("account-data-appointment-status")` are `false`.
2. `src/lib/ai/voice-turn.test.ts:1125` — `it("REGRESSION F1: non-financial
   intent must not fabricate verify:passed...")` runs `intentId:
   "account-data-next-visit"` through `voiceReply` and asserts
   `turn1.reply` **contains the actual answer** ("Monday") rather than a
   ZIP challenge (`:1151`).
3. `src/lib/ai/voice-turn.test.ts:1215` — `it("REGRESSION F2b:
   nextGatherMode is absent/undefined on a normal (non-verify) turn")`
   uses `account-data-next-visit` as its example of a turn that must
   *not* set `nextGatherMode: "dtmf_zip"`.

All three tests currently pass and will fail the moment `account-verify.ts`
is changed as A7 describes — this reads as a vitest-baseline drop against
the plan's own gate ("must not drop below 297 files / 4022 passed / 1
skipped") unless the implementer proactively rewrites these three tests in
the same commit, which nothing in A7's row says to do.

**Recommendation:** expand A7's Files column to `src/lib/ai/account-verify.ts,
src/lib/ai/account-verify.test.ts, src/app/api/chat/route.ts,
src/lib/ai/voice-turn.ts` and flag `src/lib/ai/voice-turn.test.ts:1120-1230`
(both REGRESSION F1 and F2b blocks) as tests that must be rewritten, not
just re-run, because their premise ("next-visit is a normal non-verify
turn") is exactly what A7 is correcting. This also means A7's real
blast radius includes voice, not just chat — worth a line acknowledging
the voice channel gets the same fix for free (or flagging it if that's
unintentional scope creep beyond `Rauth-` chat-only intent).

---

### S-6 — No explicit "waves run strictly in sequence" rule; two cross-wave same-file pairs rely on it being true anyway

**Item:** A3 / B1, A10 / C5 (see also S-3, S-4) · **Severity:** minor · **Tag:** inferred

The plan's only stated collision-safety claim is scoped to "items inside a
wave"; the only two *cross-wave* orderings it states explicitly are W0-2
before A6 and A7 before D11 (both verified correct — `A6`'s row says
"sequence AFTER W0-2," and Wave D's text says D11 is "**blocked behind
A7**... Do not wire the sidebar until A7 lands"). Nothing in the document
says Waves 0/A/B/C/D execute strictly in that order with no overlap; it is
only implied by section ordering and by the per-wave Gates section. Two
real (not merely globbed) same-file dependencies found during this review
— A3 rewriting `job-queue.ts`, a function B1's file (`money-triggers.ts`)
calls into (S-4); A10's real footprint overlapping the `integrations/**`
tree C5 also touches (S-3) — are only safe because Wave A fully completes,
including its gates, before Wave B/C starts. If a future executor reads
"items inside a wave... can run in parallel" as license to *also* start
the next wave's items whose Files column doesn't literally string-match
anything in the current wave, these two pairs would collide.

**Recommendation:** add one line to the plan: "Waves execute strictly in
order 0 → A → B → C → D; a wave's gates (tsc/eslint/vitest/skills) must
pass before the next wave's items start. No cross-wave parallelism."

---

### S-7 — No same-wave file collisions found (control result)

**Severity:** n/a · **Tag:** verified

Explicitly checked and found disjoint for every same-wave pair, following
imports/callers rather than trusting the Files column alone:

- **Wave 0**: W0-1 (new script file) vs W0-2 (migration + journal +
  snapshot) — disjoint.
- **Wave A**: all 10 items' resolved file sets (including the corrections
  in S-2/S-3/S-4/S-5) are pairwise disjoint. Notably `A8`
  (`membership-plans/route.ts:86`, `pricebook/route.ts:125` — both inside
  each file's `POST` handler, editing only the `logAudit({ details: ...
  })` call) does **not** collide with `B5`/`B6` even though those items'
  declared globs (`membership-plans/**`, `pricebook/**`) technically
  include `route.ts`: `B5`'s `MAX_PRICE_CENTS` PATCH-parity fix and `B6`'s
  `memberPriceCents <= priceCents` fix both land in the **`[id]/route.ts`**
  PATCH handlers (verified: `membership-plans/[id]/route.ts:18` has
  `priceCents: z.number().int().min(0).optional()` — no `.max()`;
  `pricebook/[id]/route.ts:39-40` has the refine check that only fires
  when both fields are present in the same payload — a different file
  from the one A8 touches). This is a Files-column precision problem
  worth tightening (the glob overclaims), not an actual collision — and it
  is cross-wave (A vs B) regardless, so wave ordering covers it either way.
- **Wave B**: B1/B2/B3/B4/B5/B6/B7 resolved file sets are pairwise
  disjoint. Specifically checked `estimate-create-dialog.tsx` (B6): it is
  rendered from `src/app/admin/(dashboard)/estimates/page.tsx` (the list
  page) and `scoped-estimates-section.tsx`; B4's approval-link work
  ("the detail page exposes a 'Copy new link' action") lands in
  `estimates/[id]/page.tsx` — a different page component. No overlap.
- **Wave C**: C1/C2/C3/C4/C5/C6 resolved file sets are pairwise disjoint.

---

## Migration numbering

**Verified free.** `drizzle/meta/_journal.json` has 44 entries (`idx` 0-43),
last tag `0043_aggressive_tidy`; `drizzle/` and `drizzle/meta/` both stop at
`0043*`. `0044` and `0045` are unused. W0-2's process description
(`--> statement-breakpoint` separators, `_journal.json` entry, snapshot
copy, then `drizzle-kit generate` reporting "No schema changes") matches
all four steps `AGENTS.md` requires. A6 references "the same hand-authored
migration process" by pointer rather than restating it — acceptable, not a
missing-step problem — but see **S-2** for the missing-*files* problem
(A6's Files column omits `schema.ts`, without which `drizzle-kit generate`
cannot report "No schema changes" for `0045`).

## Test-baseline risk summary

| Item | Test file(s) at risk | Nature of risk |
|---|---|---|
| A7 | `src/lib/ai/account-verify.test.ts:16-23`, `src/lib/ai/voice-turn.test.ts:1125` (F1), `:1215` (F2b) | Certain failure — tests assert the exact pre-fix behavior A7 removes (see S-5) |
| A2 | `src/app/api/auth/{login,tech/login,invite/accept}/route.test.ts` | No risk — guard and tests already exist; flagged only because A2 itself is a no-op (S-1) |
| B7 | `src/lib/admin/invoice-queries.test.ts:53-120` | No risk — existing `takePayment` tests only exercise single-call scenarios; the concurrent-partial-payment case B7 fixes has no existing test locking in the buggy behavior |

No other item reviewed had a matching existing test that asserts the
pre-fix behavior as correct.

## Recommended collision-free execution order

The plan's wave order is sound; the fixes below are corrections to file
scope and one dropped/no-op item, not resequencing:

1. **Wave 0** — W0-1, W0-2 in parallel (genuinely disjoint).
2. **Wave A** — after W0-2's gate passes. Within Wave A:
   - Drop or reduce A2 to a verification-only task (S-1).
   - Correct A6's Files column to include `schema.ts` +
     `staff-queries.ts` (S-2) before dispatch.
   - Correct A10's Files column to the `integrations/**` tree (S-3)
     before dispatch.
   - Retarget A3 at `job-queue.ts`'s `queueCommunicationJob` with an
     org-id-keyed demo check, not a session-keyed one (S-4).
   - Expand A7's Files column to include `voice-turn.ts` and rewrite
     (not just re-run) `voice-turn.test.ts`'s F1/F2b blocks in the same
     commit (S-5).
   - With those five corrections, A1/A2(or its replacement)/A3/A4/A5/A6/
     A7/A8/A9/A10 remain pairwise file-disjoint and are safe to dispatch
     in parallel.
3. **Wave B** — only after Wave A's gate passes (S-4: B1 depends on A3's
   `job-queue.ts` change; S-6: no explicit rule currently guarantees this
   ordering, add one). B1-B7 are pairwise disjoint as declared.
4. **Wave C** — only after Wave B's gate passes. C1-C6 are pairwise
   disjoint as declared; re-confirm C5's real file set against A10's
   corrected `integrations/**` footprint before dispatch (S-3).
5. **Wave D** — unchanged; A7 → D11 ordering already correctly stated in
   the plan and now additionally motivated by S-5 (D11's "contact-field
   match" gap is the same authorization hole A7 closes).

Add the explicit rule from S-6 ("waves execute strictly in order, gates
must pass between them, no cross-wave parallelism") to remove the one
remaining ambiguity a literal reading of "items inside a wave... can run
in parallel" leaves open.
