# tech — target-state spec

`/tech-login` · `/tech/jobs` · `/tech/jobs/[id]` — the mobile field app a
technician uses standing at a customer's furnace.

## 1. Purpose

Let a technician, one-handed on a phone, see only the jobs assigned to them,
navigate to the site, advance the job's status, and capture the on-site
record (materials used, a note, photos, the customer's signature, and their
own clocked time) — without ever seeing or touching another technician's or
another org's job.

## 2. Brainstorm

Ideas considered, and what shipped or got cut:

- **Assignee + tenant guard on every read/write, mirrored across list/detail/
  mutation routes** — shipped. Necessary: this is the one invariant that
  can't regress on this page — a tech app that leaks another tech's job is a
  privacy incident, not a bug. verified (`src/lib/tech/field-queries.ts:6-8,
  139-172`, `src/app/api/tech/jobs/[id]/status/route.ts:50-67`).
- **A session cookie distinct from the admin session** (`hvac_tech_session`,
  separate signing) — shipped. Rejected: reuse the admin JWT with a
  `role=technician` claim. Reason: a shared cookie slot risks the two
  session types aliasing under a future refactor; a distinct cookie makes
  "wrong session type" a route boundary, not a runtime check. verified
  (`src/lib/auth/tech-session.ts:8-12`).
- **Server-side pricebook cost/price snapshot on material add** — shipped.
  Necessary: a technician's phone is not a trusted price source; money must
  come from the org's own pricebook. verified
  (`src/lib/tech/field-queries.ts:223-236`).
- **Bottom tab bar / multi-section nav** — rejected. The tech app has exactly
  two destinations (list, detail) reached by one tap each; a tab bar would
  be chrome for chrome's sake. YAGNI.
- **Full offline queue (service worker + IndexedDB, sync-on-reconnect)** —
  considered, rejected for THIS spec. The real problem it would solve
  (losing a note/material/signature typed with no signal) is real (see
  Gtech-5), but a full offline-first rewrite is a multi-week architecture
  change. Cheaper fix scoped instead: preserve the form's contents and offer
  one-tap retry on a failed submit (Rtech-5) — closes the data-loss case
  without service-worker complexity.
- **PWA installability (manifest + "Add to Home Screen")** — rejected for
  this pass. Nice-to-have, not blocking arrive→work→close-out; no evidence a
  technician can't just keep the login tab open. Backlog P2, not a requirement.
- **Job history (completed/cancelled jobs) view** — rejected for this pass.
  The list is explicitly "my ACTIVE jobs"; a technician needing history has
  the office. Backlog P2, revisit only if a real workflow need shows up.
- **"Today only" date grouping on the jobs list** — rejected for this pass.
  The list is tenant+assignee scoped and typically small; sorting by
  `arrivalWindowStart` ascending already puts the next job first. Backlog P2.
- **Confirmation step before a destructive/terminal status change**
  (cancelled, completed) — accepted, becomes Rtech-4. A technician
  fat-fingering "Cancelled" next to "In progress" with no undo is a real
  field failure mode, not a hypothetical.
- **44px-minimum touch targets on the core-flow controls** — accepted,
  becomes Rtech-1/Rtech-2. The single lens this task calls out explicitly,
  and current sizes measurably fail it (see Gaps).

## 3. Current state

**Files** (verified — read in full): login page
`src/app/tech-login/page.tsx`, login form
`src/app/tech-login/tech-login-form.tsx`, session gate
`src/app/tech/layout.tsx`, jobs list page `src/app/tech/jobs/page.tsx` +
client `src/components/tech/tech-jobs-list-client.tsx`, job detail page
`src/app/tech/jobs/[id]/page.tsx` + client
`src/components/tech/tech-job-detail-client.tsx` + summary
`src/components/tech/tech-job-summary.tsx`, location tracker
`src/components/tech/tech-location-tracker.tsx`, sign-out
`src/components/tech/tech-sign-out-button.tsx`, server queries
`src/lib/tech/field-queries.ts`, session `src/lib/auth/tech-session.ts`.

**Auth / role scoping** (verified, and it's solid): `/tech/*` is gated by
`TechLayout`, which `redirect()`s to `/tech-login` when `getTechSession()`
returns null (`src/app/tech/layout.tsx:15-18`). The tech session lives in a
cookie distinct from the admin session (`hvac_tech_session`,
`sameSite: "lax"`, 24h) and is revocation-checked on every read
(`src/lib/auth/tech-session.ts:11,44-53`) — a fired/deactivated tech's
still-valid token is rejected. Every field-data read and every mutation
route re-derives ownership from `session.userId` +
`session.organizationId` and ANDs `assignedTo == techUserId` with the
tenant filter (`src/lib/tech/field-queries.ts:96-105, 160-169`;
`src/app/api/tech/jobs/[id]/status/route.ts:51-64`; same pattern in
materials/note/photo/signature/timesheet routes, each importing
`getTechSession` + `slidingWindow` rate limiting — verified by grep across
all 5 sub-routes). A job that isn't the caller's returns 404, not 403
(`src/app/api/tech/jobs/[id]/route.ts:16,38-40`) — doesn't confirm existence
to a tech probing IDs.

**Jobs list** (verified): `GET /api/tech/jobs` filters to
`status IN (scheduled, assigned, in_progress, on_hold)` for the caller's
`assignedTo`, ordered by `arrivalWindowStart` ascending
(`src/app/api/tech/jobs/route.ts:19,53-63`). Client fetches once on mount,
renders a 3-card skeleton while loading, a flat error string on failure with
no retry, an empty state, or a card list (reference #, status pill, issue
type, address, arrival time) linking to the detail page
(`src/components/tech/tech-jobs-list-client.tsx:42-120`).

**Job detail** (verified): `TechJobSummary` shows customer name/phone
(tap-to-call), address (tap-to-navigate via Google Maps deep link),
issue/system/urgency badges, arrival window, description, access notes, and
the FSM-filtered next-status buttons (`src/components/tech/
tech-job-summary.tsx:121-213`; allowed targets computed server-side by
intersecting `allowedTransitions(status)` with `MANUAL_TARGET_STATUSES`,
`src/lib/tech/field-queries.ts:110-113`). Below it: a clock-in/out card with
a live-ticking elapsed timer and today's entries
(`tech-job-detail-client.tsx:488-552`), a materials card (pricebook search +
manual-entry fallback, add/remove, cents-exact pricing via
`formatCentsExact`) (`:554-647`), an on-site note textarea (`:650-673`), a
pointer-event signature canvas (320×140 backing store, typed-name fallback
if nothing is drawn) (`:676-712`), a photo upload (`capture="environment"`,
grid gallery) (`:715-764`), and a read-only status timeline (`:766-790`).

**Status transitions** (verified): `MANUAL_TARGET_STATUSES` = scheduled,
in_progress, on_hold, completed, cancelled
(`src/lib/admin/request-status.ts:47-53`) — a technician can reach
`cancelled` from `assigned`/`scheduled`/`in_progress`/`on_hold`
(`request-status.ts:30-38`), same as a dispatcher, with no reason captured
(`grep` for a cancellation-reason field in the admin queries/routes found
none) and no confirmation step (`tech-job-summary.tsx:194-207` renders every
allowed status as an equally-weighted `Button`).

**Location tracking** (verified): consent-gated toggle
(`tech-location-tracker.tsx:88-115`), throttled to one POST/minute
client-side (`:9,38-41`), best-effort (a failed post or denied permission
surfaces a hint string, never throws) (`:16,54-56`).

**Design system**: the tech portal deliberately does NOT use the
`src/components/admin/ui/` primitives — base shadcn (`Card`, `Button`,
`Input`, `Skeleton`) only, per `.claude/skills/page-tech/SKILL.md:59-61`.
Button sizes (`src/components/ui/button.tsx:22-34`): `default` = `h-8`
(32px), `sm` = `h-7` (28px), `lg` = `h-9` (36px), `icon` = `size-8` (32px).
Inputs are `h-8` (32px) (`src/components/ui/input.tsx:18`). None reach the
44px minimum touch target (WCAG 2.5.5 / Apple HIG 44pt / Android 48dp;
`~/.claude/design-principles.md:73` states the same 44px floor for dropdown
triggers).

## 4. Gaps

| Gap | Severity | Evidence |
|---|---|---|
| Gtech-1: "Remove material" control is a bare icon button with no padding — hit area ≈16×16px, far below any touch-target floor | P0 | `tech-job-detail-client.tsx:581-588` — `<button>` wraps only `<Trash2 className="size-4" />`, no size/padding class |
| Gtech-2: every primary control on the core arrive→work→close-out flow (Clock In/Out, status-advance, Add material, Save note, Save/Clear signature) renders at 28–36px tall, under the 44px minimum | P1 | `button.tsx:24-27` (`h-8`/`h-7`/`h-9`); used unsized or `size="sm"` throughout `tech-job-summary.tsx:197-204`, `tech-job-detail-client.tsx:501-517,636-643,662-667,697-706` |
| Gtech-3: load-error states on the jobs list and job summary are dead ends — a static string with no retry action | P1 | `tech-jobs-list-client.tsx:75-77`; `tech-job-summary.tsx:106-113` |
| Gtech-4: destructive/terminal status changes (Cancelled, Completed) fire on a single tap with no confirmation and no visual distinction from safe transitions (Scheduled, In progress, On hold) | P1 | `tech-job-summary.tsx:194-207` — all allowed statuses render as identical `Button` elements in one `flex-wrap` row |
| Gtech-5: a network failure mid-submit (note/material/signature/photo) surfaces a generic error string with no retry — the technician must notice it and manually redo the entry | P1 | `tech-job-detail-client.tsx:311-313` (material), `:345-347` (note), `:447-449` (signature); no retry control renders in any of these catch paths |
| Gtech-6: the load-error banner tells the tech to "pull to refresh," a gesture the app never implements | P2 | `tech-job-detail-client.tsx:483` |
| Gtech-7: no PWA manifest — no home-screen install, no offline app shell | P2 | no `manifest.json`/`.webmanifest` found under `src/app` or `public/` |
| Gtech-8: completed/cancelled jobs disappear from the list with no history view | P2 | `src/app/api/tech/jobs/route.ts:19` (`ACTIVE_STATUSES` excludes both) |
| Gtech-9: jobs list has no "today" grouping — a job scheduled next week sits in the same flat list as one starting in 20 minutes | P2 | `tech-jobs-list-client.tsx:87-119` — single flat `<ul>`, sort is the only ordering signal |
| Gtech-10: signature canvas is a fixed 320×140 backing store — small for a one-handed signature capture, and its Save/Clear controls are 28px (`size="sm"`) | P2 | `tech-job-detail-client.tsx:683-684,697-706` |

## 5. Requirements

- **Rtech-1**: The "remove material" control has a tap target ≥44×44px.
  Acceptance: at a 390px viewport, the rendered hit area (padding included,
  verified via computed style or a wrapping element) of the remove control
  in the materials list is ≥44×44px.
- **Rtech-2**: Every control on the core flow (Clock In/Out, status-advance
  buttons, Add material, Save note, Save signature, Clear) renders at
  ≥44px tall at mobile widths. Acceptance: each listed control uses a button
  size variant (existing `lg`/`icon-lg` at 36px do not qualify; needs a new
  ≥44px variant or explicit height) measured ≥44px at 390px width.
- **Rtech-3**: The jobs-list and job-summary error states include a "Try
  again" action that re-runs the failed fetch in place. Acceptance:
  simulating a fetch failure renders a retry control; tapping it re-invokes
  the same load function and clears the error on success, without a full
  page reload.
- **Rtech-4**: Advancing a job to `cancelled` or `completed` requires an
  explicit second confirmation step; advancing to `scheduled`, `in_progress`,
  or `on_hold` does not. Acceptance: tapping "Cancelled" or "Completed" shows
  a confirm affordance before the `POST /api/tech/jobs/[id]/status` request
  fires; the other three targets POST immediately as today.
- **Rtech-5**: A failed material/note/signature submission preserves the
  entered value and offers a one-tap retry that resubmits the same payload.
  Acceptance: simulating a network failure on submit leaves the form's input
  populated (not cleared) and shows a retry control; tapping it re-POSTs
  without requiring the technician to retype anything.

Gtech-6 through Gtech-10 (P2) are recorded in `README.md`'s backlog table
and are NOT implementation work in this run, per the severity gate in
`docs/page-program/METHOD.md`.

## 6. Non-goals

- **Full offline-first rewrite** (service worker, IndexedDB queue,
  background sync) — the practical data-loss case is closed by Rtech-5's
  preserve-and-retry instead; a full offline architecture is out of scope
  for a spec-sized change.
- **PWA installability / home-screen app** — no evidence of technician
  demand or workflow blocker; tracked as backlog P2 (Gtech-7).
- **Job history / past-jobs view** — the page's job is "my active work,"
  not "my job archive"; office/admin already has full history.
- **Redesigning the tech portal onto the `admin-pages` design system** — the
  skill explicitly documents this as deliberate (mobile-first, lighter
  shadcn primitives, no admin chrome); not revisiting that call here.
- **Changing the manual-status FSM itself** (e.g. removing a technician's
  ability to reach `cancelled`) — that's a business-process decision for
  dispatch/ops, not a UI-polish spec; this spec adds a confirmation gate,
  not a permission change.

## 7. Invariants

- Assignee + tenant guard on every field-data read and mutation — a
  technician may only see/touch a job `assignedTo` them in their own org.
  Reason: this is the page's core privacy/security property; a regression
  here is a data leak, not a bug. (`.claude/skills/page-tech/SKILL.md:42-46`)
- The guard in `field-queries.ts` mirrors
  `src/app/api/tech/jobs/[id]/status/route.ts` exactly and must stay in
  sync. Reason: two independently-drifting copies of the same check is how
  this class of bug gets introduced.
- `/tech-login` stays top-level, outside the `/tech/*` session gate. Reason:
  moving it inside creates a redirect loop (gate redirects to login, login
  is inside the gate).
- The "Continue with Google" button renders only when Google OIDC is
  configured. Reason: a dead button must never appear.
- Location tracking never sends coordinates without an active consent
  record. Reason: consent-gated by design, not a UI nicety.
- Money is integer cents; catalog material cost/price are snapshotted
  server-side from the pricebook at add time — client-sent costs are never
  trusted. Reason: a technician's phone is not a pricing authority.
- Tenancy: every tech query scopes by `session.organizationId` in addition
  to the assignee check (repo-wide invariant, `AGENTS.md`).
- No admin-pages design-system primitives in the tech portal (base shadcn
  only). Reason: documented deliberate choice, not an oversight.

## 8. Verification

- `npx tsc --noEmit` → 0.
- `npx eslint <changed files>` → 0 errors.
- `npx vitest run` → must not drop below the live baseline (no jsdom/RTL;
  any new logic worth testing — e.g. a pure "is this a destructive status"
  predicate for Rtech-4, or a retry-payload helper for Rtech-5 — ships as an
  extracted pure function with its own vitest file, not component tests).
- Existing tech-page suites must stay green:
  `npx vitest run src/app/api/tech/jobs/[id]/route.test.ts
  src/lib/tech/field-queries.test.ts src/lib/tech/timesheet-queries.test.ts
  src/app/api/auth/tech/login/route.test.ts
  src/app/api/auth/tech/logout/route.test.ts`.
- Visual check at 390px (mobile) for `/tech/jobs` and a job detail page:
  **could not verify with existing tooling** — `mint-admin-session.mjs` /
  `screenshot-page.mjs` only mint an `hvac_admin_session` cookie; the tech
  portal gates on the separate `hvac_tech_session` cookie
  (`src/lib/auth/tech-session.ts:11`). Verifying Rtech-1/Rtech-2 needs a
  tech-session-minting variant of the script, or a manual `/tech-login`
  pass with a seeded technician account before screenshotting at width 390.
- `node scripts/agent/verify-skills.mjs` → 0 missing, after updating
  `.claude/skills/page-tech/SKILL.md` if implementation changes files/flows.
