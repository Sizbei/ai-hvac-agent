# technicians — target-state spec

`/admin/technicians` — a permanent redirect tombstone to `/admin/staff`,
where technician (and admin) user management actually lives.

## 1. Purpose

Send anyone who follows an old bookmark, integration link, or hand-typed URL
to `/admin/technicians` straight to `/admin/staff`, where the unified
staff-management screen (list, create, role change, deactivate, reset
password) already covers technicians as one of its two roles. The page's
entire job is: don't 404 a stale link. It owns no UI, no data fetch, no form.

## 2. Brainstorm

What a "great" version of this page does, and why most of it was rejected:

- **Keep it a pure redirect** — shipped. Rejected alternative: restore a
  standalone technician CRUD screen. Reason: `/admin/staff` already manages
  both admin and technician users from one screen with the fuller feature
  set (roles, last-admin guard, password reset, invites) — verified in
  commit `392cbc4` ("Sidebar points at /admin/staff; /admin/technicians
  307-redirects; the orphaned technician table/form components are
  removed."). Rebuilding a second, narrower screen for the same `users`
  rows would just reintroduce the exact fragmentation that commit
  deliberately collapsed. YAGNI.
- **Forward the query string to `/admin/staff`** — considered, rejected. No
  evidence any inbound link to `/admin/technicians` ever carried query
  params (git history shows the old page never had shareable filter state);
  inventing forwarding logic for a hypothetical is exactly the kind of
  speculative flexibility to avoid.
- **308 (permanent) redirect instead of 307** — considered, rejected as a
  requirement. `redirect()` from `next/navigation` issues a 307 by default;
  `permanentRedirect()` would issue a 308 (`node_modules/next/dist/docs/
  01-app/03-api-reference/04-functions/redirect.md:11`,
  `permanentRedirect.md:11`). The 307 was the *deliberate* choice at ship
  time — commit `392cbc4`'s own message says "/admin/technicians
  307-redirects" — not an oversight. This is an authenticated internal admin
  route with no search-engine exposure, so the cacheability difference
  between 307/308 has no real payoff. Not worth touching.
- **A technician-specific profile page (skills, certifications, service
  radius)** — rejected. No such fields exist anywhere in the schema today
  (no `skills`/`specialty`/`certification` column on `users` or any
  technician-adjacent table in `src/lib/db/schema.ts`), and dispatch scoring
  already derives "skill" from actual completed-job history
  (`skillJobsCompleted`/`skillJobsCompletedRecent`,
  `src/lib/ai/dispatch/score.ts:16-20`) rather than a self-reported tag. New
  product surface, not a gap in the redirect. `page-staff`/`page-dispatch`
  territory if ever wanted.
- **An availability editor on this page** — rejected for this spec, for a
  different reason than the others: it's a real, verified gap (see
  Gtechnicians-2), but this page has no form surface to hang it on — it is
  and should stay a bare redirect. The fix belongs on `/admin/staff` or
  `/admin/calendar`, not here. Recorded in Gaps/Non-goals so it isn't lost,
  not turned into a requirement of this page.

## 3. Current state

**The page itself** (verified, read in full):
- `src/app/admin/(dashboard)/technicians/page.tsx:9-11` — a Server Component
  that unconditionally calls `redirect('/admin/staff')`. No data fetch, no
  props, no client code.
- It sits inside the `(dashboard)` route group, so
  `src/app/admin/(dashboard)/layout.tsx:14-18` runs first and redirects an
  unauthenticated visitor to `/admin/login` before this page's own redirect
  ever executes — verified, no double-redirect or auth-bypass path.
- The sidebar never links here: `src/components/admin/nav-items.ts:67` points
  only at `{ label: 'Staff', href: '/admin/staff', ... }`. This route is
  reachable only by a stale/external link.

**Where the redirect lands** (verified, read in full — needed to answer the
assignment's lenses honestly, since this page's whole reason to exist is
that lens-worthy functionality moved elsewhere):

- **Entity relationship (lens a)**: a technician IS a staff user account —
  one `users` table row, `role = 'technician'`
  (`src/lib/admin/queries.ts:942-961`, `src/lib/admin/staff-queries.ts:
  99-121`). There is no separate "technician profile" table to drift out of
  sync with a login. A technician provisioned without local credentials
  (FieldPulse-synced import) is surfaced honestly in the Staff UI as "no
  local sign-in" rather than silently — `staff-table.tsx:111-113` — and
  claims a password only through `claimPasswordlessStaff`
  (`staff-queries.ts:397-462`), which re-checks `passwordHash IS NULL` at
  write time so two concurrent claims can't both win. No drift found here.
- **Deactivation semantics (lens c)**: deactivating a technician does NOT
  silently orphan their already-assigned jobs. Both the dispatch board
  (`getDispatchBoard`, `src/lib/admin/queries.ts:1316-1320`) and the
  scheduling calendar (`getSchedulingCalendar`, `:1441-1445`) seed a column
  only for *active* technicians and explicitly fall a job whose assignee is
  "missing, deactivated, or otherwise not a visible active tech" through to
  the unassigned pile — a deliberate, commented decision — so a dispatcher
  always sees the job and can reassign it. Future booking capacity is
  likewise correctly scoped to active techs only (`computeOpenWindows`,
  `src/lib/admin/availability.ts:123-126`, consuming `activeTechIds`). No
  drift found here.
- **Tenancy (lens d)**: every technician/staff query is `withTenant`-scoped
  — `staff-queries.ts` (`listStaff:148`, `createStaff:204`,
  `updateStaff:276,324`), `queries.ts` (`getTechnicians:955`,
  `createTechnician:981`, `updateTechnician:1028ish`). Verified sound.
- **Skills/availability data (lens b) — mixed**: `technicianAvailability`
  (recurring weekly hours) is genuinely *consumed*, not decorative — by
  dispatch scoring's day-capacity term (`sumAvailabilityMinutes`,
  `src/lib/ai/dispatch/score.ts:91-96`, fed from
  `src/lib/ai/dispatch/signals.ts:346-356`) and by the customer-facing
  open-windows computation (`src/lib/admin/availability.ts`). But the
  *write* path is dead: `setTechnicianAvailability`
  (`src/lib/admin/scheduling-queries.ts:188-224`) has zero callers anywhere
  under `src/app` — grep confirms only its own unit test exercises it. There
  has never been an admin UI to set a technician's recurring hours by hand
  (git history: the original 2026-05-27 technician page never had one
  either, `05805ba`); today, availability rows exist only via FieldPulse
  sync (`src/lib/integrations/fieldpulse/availability-sync.ts:267`) or seed
  data. This is real (Gtechnicians-2 below) but not this page's fix — no
  form exists here to add it to.
- **Two divergent technician-mutation code paths** — `/api/admin/technicians`
  (`POST`/`PATCH`) duplicates `/api/admin/staff` with weaker guarantees and
  no live UI caller. Details in Gtechnicians-3.

**Last-admin guard — verified present at runtime, but not reproducible from
migrations (Gtechnicians-1, see Gaps)**: `staff-queries.ts:22-28` and this
page's own skill (`.claude/skills/page-technicians/SKILL.md:35-37`) both
describe a `BEFORE UPDATE` trigger on `users`
(`trg_enforce_last_active_admin` / `enforce_last_active_admin()`) as the
*authoritative* backstop for the racy app-level last-admin check. A live
read-only query against the DEV database (`pg_trigger`/`pg_proc`) confirms
the trigger and function both exist there today. But `git log --all
--diff-filter=D -- "*last_admin*"` shows the migration that created it
(`drizzle/0008_last_admin_guard.sql`, added in `392cbc4`) was deleted by the
later squash commit `0cea181` ("squash migrations to a single baseline"),
and grepping every current `drizzle/*.sql` file (`0000_baseline.sql` through
`0043_aggressive_tidy.sql`) for `TRIGGER`, `FUNCTION`, `plpgsql`, or
`last_active_admin` returns nothing — `drizzle-kit generate`'s baseline is
derived from `schema.ts`, which (correctly) has no representation for raw
SQL triggers, so the squash silently dropped hand-authored DDL that isn't
expressible in the ORM schema. Existing databases (dev, and per `0cea181`'s
own commit message, prod) kept the trigger because a squash doesn't drop
objects on an already-migrated DB — only the *migration file* disappeared.

## 4. Gaps

| Gap | Severity | Evidence |
|---|---|---|
| Gtechnicians-1: The last-admin lockout guard trigger is absent from every current migration file, so a fresh database (a new dev/staging Neon branch, disaster recovery, CI) would silently deploy with ZERO database-level protection against an org losing its last active admin — only the racy, admittedly-non-race-proof app-level check in `updateStaff` would remain, contradicting the code's own claim that the trigger is the "authoritative" backstop. | P0 | `git log --all --diff-filter=D -- "*last_admin*"` shows `0cea181` deleted `drizzle/0008_last_admin_guard.sql` (originally added in `392cbc4`); `grep -rin "trigger\|plpgsql\|last_active_admin" drizzle/*.sql` across all 44 current migration files returns nothing; a live `pg_trigger`/`pg_proc` query against the DEV database confirms `trg_enforce_last_active_admin`/`enforce_last_active_admin` exist there only because that database predates the squash — `staff-queries.ts:22-28` and `.claude/skills/page-technicians/SKILL.md:35-37` both document the trigger as the authoritative guard, and neither is currently true for a from-scratch database. |
| Gtechnicians-2: No admin UI anywhere has ever let staff set a technician's recurring weekly availability by hand, even though that data is genuinely consumed by dispatch scoring and customer-facing booking capacity. | P1 (not actionable on this page — see Non-goals) | `setTechnicianAvailability` (`src/lib/admin/scheduling-queries.ts:188-224`) has no caller under `src/app`; only its own unit test (`scheduling-queries.test.ts`) exercises it. Git history: the original standalone technician page (`05805ba`, 2026-05-27) never had one either. Today availability rows arrive only via FieldPulse sync (`availability-sync.ts:267`) or `seed-demo.ts` — an org with no FieldPulse integration has no way to configure hours at all. |
| Gtechnicians-3: `/api/admin/technicians` `POST`/`PATCH` is a second, weaker technician-mutation surface that duplicates `/api/admin/staff`'s create/update but skips its per-org email pre-check, so a duplicate-email create 500s instead of returning the friendly 409 conflict `staff-queries.ts` gives. It is reachable by any authenticated admin session but called by no admin UI (`useAdminTechnicians` only ever `GET`s). | P2 | `src/lib/admin/queries.ts:972-1003` (`createTechnician`, no email pre-check, no try/catch on the unique-violation path) vs. `src/lib/admin/staff-queries.ts:198-241` (`createStaff`, pre-checks + maps the violation to `email_conflict`); grep of `src` for `fetch('/api/admin/technicians'` / template-literal equivalents finds only `GET` callers. |

The redirect itself, the auth ordering, the entity model, and the
deactivation-safety design are sound and evidenced above — this spec is not
padding out a short list.

## 5. Requirements

Only Gtechnicians-1 clears the P0/P1 bar as work this page's spec commits to;
Gtechnicians-2 is real but explicitly not this page's surface (Non-goals).

- **Rtechnicians-1**: Re-author the last-admin guard trigger as a new
  hand-authored migration so a from-scratch database provisions it, matching
  what `staff-queries.ts` and this page's skill already claim is true.
  **Acceptance criterion**: a new `drizzle/0044_*.sql` recreates
  `enforce_last_active_admin()` and `trg_enforce_last_active_admin` verbatim
  (same guard condition: fires only when the row was an active admin-tier
  user and the update would remove that, raises `last_active_admin` with the
  org id) using `--> statement-breakpoint` separators per
  `AGENTS.md`'s hand-authored-migration convention; `drizzle/meta/
  _journal.json` gets the matching entry and a snapshot copy exists; running
  `npx drizzle-kit generate` afterward reports "No schema changes" (the
  trigger is DDL, not a `schema.ts` construct, so it can't itself cause a
  diff — this check just proves the migration didn't accidentally touch
  something `schema.ts` *does* track). A test against a scratch/CI database
  (or the existing mocked unit test path, if no real-DB test harness exists
  in this repo per the no-jsdom/pure-helper convention) confirms two
  concurrent last-admin-removing updates can't both succeed once the trigger
  is applied to a freshly-migrated database.

## 6. Non-goals

- Not rebuilding a standalone technician CRUD screen on this route — `/admin/
  staff` already owns that surface with a superset of controls (Brainstorm).
- Not forwarding query strings through the redirect — no evidence any link
  ever needed it (Brainstorm).
- Not switching `redirect()` to `permanentRedirect()` — the 307 was a
  deliberate ship-time choice on an authenticated internal route with no SEO
  exposure, not a bug (Brainstorm).
- Not adding a skills/certification field to technicians — none exists
  today, and dispatch already derives skill from job history rather than a
  self-reported tag; inventing one is new product surface, not a gap
  (Brainstorm).
- Gtechnicians-2 (no availability editor) is real and P1-severity in spirit,
  but this page is a bare redirect with no form to attach it to. It belongs
  on `/admin/staff` or `/admin/calendar`'s own spec — recorded here so it
  isn't lost, deliberately not claimed as a requirement of this spec.
- Gtechnicians-3 (the orphaned `/api/admin/technicians` write surface) is
  P2 and left in the backlog per METHOD.md's severity gate — it has no live
  UI caller today, so there is no user-facing symptom to fix urgently.

## 7. Invariants

- Tenancy: every technician/staff read and write stays `withTenant`-scoped
  by the session's `organizationId` — Rtechnicians-1's migration must not
  weaken this; the trigger itself already scopes its lockout check to
  `OLD.organization_id` (verified in the deleted migration's recovered text,
  `git show 392cbc4:drizzle/0008_last_admin_guard.sql`), and the re-authored
  version must preserve that scoping exactly.
- Last-admin guard is defense-in-depth, not a replacement for the app-level
  check: `staff-queries.ts`'s `countActiveAdmins` pre-check must stay in
  place after Rtechnicians-1 ships — the trigger is the race-proof backstop
  for the case the app check misses, not a substitute for the friendly
  synchronous 409 in the common (non-racing) case.
  `updateStaff`'s existing `isLastAdminViolation` error-message match
  (`staff-queries.ts:69-77`) must keep working against whatever exact
  exception text the re-authored trigger raises — don't change the
  `last_active_admin` marker string.
  Copy canon: technician (never "tech") in any UI text this migration's
  work might touch (it shouldn't touch UI at all, but noted for the
  reviewer).
- Hand-authored migration convention (`AGENTS.md`): `drizzle/00XX.sql` needs
  `--> statement-breakpoint` separators, a `_journal.json` entry, and a
  snapshot copy; `drizzle-kit generate` must then report "No schema
  changes."
- The redirect page itself must keep redirecting unconditionally to
  `/admin/staff` — nothing in this spec touches
  `src/app/admin/(dashboard)/technicians/page.tsx`.

## 8. Verification

- `npx tsc --noEmit` → 0.
- `npx eslint <any changed files>` → 0 errors (Rtechnicians-1 is
  migration-only; if no `.ts`/`.tsx` changes, this step is a no-op).
- `npx vitest run` → must not drop below the live baseline (297 files ·
  4022 passed · 1 skipped, per `docs/page-program/README.md`).
- `npx vitest run src/lib/admin/staff-queries.test.ts` → the existing mocked
  last-admin-trigger tests (`staff-queries.test.ts:298-320`) must still pass
  unchanged — they assert on the `last_active_admin` message shape the
  re-authored trigger must preserve.
- `npx drizzle-kit generate` → "No schema changes" after adding the new
  migration.
- Manual: apply the new migration to a scratch/local Postgres (or the DEV
  Neon branch, never prod) and confirm `SELECT tgname FROM pg_trigger WHERE
  tgrelid = 'users'::regclass` includes `trg_enforce_last_active_admin`
  starting from a database that had NOT already had it (i.e., actually
  proves the migration — not just an already-migrated DB — creates it).
- Visual: none required — this page has no visual surface and this spec's
  only requirement is a migration. Confirm `/admin/technicians` still
  redirects to `/admin/staff` with
  `node scripts/agent/screenshot-page.mjs /admin/technicians` (should render
  the Staff page).
