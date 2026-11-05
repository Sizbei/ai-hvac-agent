# Technician getting-started guide: a tutorial that completes itself

Status: v4 FINAL (2026-11-05) after adversarial review rounds 1–3 (6 critics; log in
`docs/superpowers/specs/2026-11-05-tech-getting-started-review-log.md`). Owner: Raymond Chen.
Sibling of the office setup guide (`docs/superpowers/specs/2026-11-04-onboarding-tutorial.md`,
shipped 2026-11-04 as `/admin/setup`). That guide ends at "Have a technician sign in on their
phone"; nothing then teaches the technician the app. This spec adds the technician side.

## 1. Goal

A technician signs in on their phone for the first time and, without being shown by anyone,
learns what the field app does by doing it on real jobs. One screen lists nine steps with a
short "how" each, the list notices on its own when a step is done, and the technician sees how
far along they are from the jobs list. Nobody ticks boxes. The guide gets out of the way once a
job has been run start to finish.

Model: the office guide's, cut down. Steps derive from this technician's own rows on every
read; first completions are stamped write-once so a step never un-does itself; hiding the card
is per technician.

Non-goals (v1): tooltips or overlays on the job page, video, sample jobs, per-org step
configuration, office visibility of each technician's progress, Spanish, grandfathering (a
veteran sees the finished block for a day and it leaves on its own), an audit row (a technician
hiding their own tutorial card is not an office action), a demo-org rule (see §5),
FieldPulse/Housecall Pro-managed jobs (taps are refused there today; the × covers a technician
whose every job is managed elsewhere).

## 2. Surfaces

| surface | what it shows | when |
| --- | --- | --- |
| `/tech/guide` (new page, "Getting started") | `Back` link to `/tech/jobs`; progress line + bar over the two required steps; the "Up next" hero or the finished block; one "Run a job" card with the two required rows; one "Go further · N of 7" card with the seven optional rows (every row: glyph, title, chip where applicable, how line) | always reachable |
| Jobs list card (`/tech/jobs`, between the clock row and the Today / Upcoming / Past control) | `Getting started` · `N of 2` · bar · `Up next` title + how line (+ note) (+ `Open the job` button when `todayFirst` is set) · `See all steps` → `/tech/guide` · × | while `hiddenAt` is null and the guide is not finished; when finished, the finished block (with `See all steps` and ×) for 24 hours after the `finish_job` stamp, then the card leaves on its own |
| Header link (`src/app/tech/layout.tsx`, client component `src/components/tech/guide-link.tsx`) | a `Link` to `/tech/guide` with `BookOpen` icon + visible text `Guide`, 13 px medium, `min-h-11`, `aria-current="page"` on the guide page (`usePathname`), in a `flex items-center gap-3` wrapper with Sign out (the header is `justify-between` with two children); the title block gets `min-w-0` and the name `truncate` | always, so the page stays one tap away after × |

Technician session only (`getTechSession`). State is **per technician** (`users.field_guide_state`).

**Refresh model.** No global store and no `visibilitychange` listener. Each surface fetches
`GET /api/tech/guide` on mount (leaving a job and coming back remounts the list, so a step done
on the job page shows on return). The one step done on the card's or page's own screen is
`share_location` (the toggle sits in the layout above every tech screen): the toggle's success
path dispatches `window.dispatchEvent(new CustomEvent("tech:guide:refresh"))` and the card and
page listen and refetch. (Clock in is optional and the card only ever shows the two required
steps or the finished block, so no clock refresh is needed; the page counts it on its next
mount.) A failed refetch keeps the last good payload; a failed first load renders nothing on
the list (the jobs are the priority) and the error state on the page.

**No skeleton for a hidden guide.** `src/app/tech/jobs/page.tsx` becomes an async server
component: it reads the session (null → render nothing; the layout redirects) and
`readGuideHidden(userId, organizationId, now)` (`src/lib/tech/guide-queries.ts`: one select
of `field_guide_state` by primary key, then the pure `cardHiddenFor(state, now)` =
`hiddenAt` set OR the stored `firstCompleted.finish_job` stamp older than 24 hours; any error
is caught, logged with ids only, and returns `false`) and passes `guideHidden` to
`TechJobsListClient`; when true the card never mounts and never fetches. The GET payload
carries the same server-computed `cardHidden` (so the phone's clock never decides) and the
client also hides on it (a cached page restored by Back can carry a stale `guideHidden`). A
finish stamp that never lands (repeated write failures, logged) keeps the card for that
technician; accepted.

## 3. The steps

Nine steps. Each: imperative title, one "why" line, one "how" line naming the real buttons,
required/optional, lead-only where the app refuses helpers, and a completion rule over THIS
technician's rows. `$u` = session `userId`, `$o` = session `organizationId`. Every subquery,
nested ones included, carries `organization_id = $o`; every row-level rule carries
`technician_id = $u` (or the column named). Vocabulary follows the app's own strings: the
list says "visit", the sheets say "request", the guide says "job" for the thing the technician
opens and "request" where the sheet it points at says so.

Required = `start_job`, `finish_job` ("Run a job"). Optional = the other seven ("Go further").
Progress = required done of 2. "Finished" = both required done.

`LEAD_ON_LIVE(r)` = `EXISTS (SELECT 1 FROM appointment_assignments a JOIN appointments p ON
p.id = a.appointment_id WHERE p.service_request_id = r.id AND a.organization_id = $o AND
p.organization_id = $o AND a.technician_id = $u AND a.is_lead AND a.status <> 'cancelled' AND
p.cancelled_at IS NULL)`. `ASSIGNED_ON_LIVE(r)` = the same without `a.is_lead`.

### Run a job (required)

| id | title | why | how | done when |
| --- | --- | --- | --- | --- |
| `start_job` | Start your first job | The office sees where you are without calling you. | Open your job in the list. Tap On my way when you leave. Tap I've arrived at the door, then Working. | `EXISTS (SELECT 1 FROM appointment_assignments WHERE organization_id = $o AND technician_id = $u AND (en_route_at IS NOT NULL OR arrived_at IS NOT NULL OR started_at IS NOT NULL))` |
| `finish_job` | Finish a job | Done tells the office your part is finished. Close out finishes the whole request. | Tap Done when your part is finished. If Close out shows instead, tap that. | `EXISTS (SELECT 1 FROM appointment_assignments WHERE organization_id = $o AND technician_id = $u AND completed_at IS NOT NULL AND started_at IS NOT NULL)` — a lead's hold completes every started row on the visit, so a technician who was Working when the lead held the request counts as finished (lenient, stated); a row that only reached On my way does not |

`start_job` notes (payload `note`, client-chosen variant on the card):
- `has_open_job` false → "The office hasn't assigned you a job yet. It shows in your jobs
  when they do." `has_open_job` = `EXISTS (SELECT 1 FROM appointment_assignments a JOIN
  appointments p ON p.id = a.appointment_id JOIN service_requests r ON r.id =
  p.service_request_id WHERE a.organization_id = $o AND p.organization_id = $o AND
  r.organization_id = $o AND a.technician_id = $u AND a.status IN <OPEN_ASSIGNMENT_STATUSES
  from ownership.ts> AND p.cancelled_at IS NULL AND r.status NOT IN ('completed','cancelled'))`
  (the list hides open rows on a completed request, so they do not count here either).
- card only, `hasOpenJob` true and the Today fetch succeeded with no rows → "Your next job is
  under Upcoming."

### Go further (optional)

| id | title | why | how | chip | done when |
| --- | --- | --- | --- | --- | --- |
| `clock_in` | Clock in for the day | Your hours land on the office timesheet without a paper form. | Tap Clock in above your jobs list, not the one on a job. Tap Clock out when you're done. | — | `EXISTS (SELECT 1 FROM technician_time_entries WHERE organization_id = $o AND technician_id = $u AND kind = 'general')` |
| `share_location` | Share your location while working | Dispatch sends the nearest technician to the next job. | Turn on Share my location at the top of the screen. | — | `COALESCE((SELECT location_sharing_enabled FROM users WHERE id = $u AND organization_id = $o), false)` — the only non-monotonic signal; the toggle's refresh event catches it (a flip on and off between two reads is missed; accepted) |
| `add_material` | Add a part you used | Parts you add here land on the invoice, so nothing is billed from memory. | On the job, under Materials used, pick an item from the pricebook or type one in, then tap Add. | — | `EXISTS (SELECT 1 FROM job_materials WHERE organization_id = $o AND created_by = $u)` |
| `note_or_photo` | Add a note or a photo | The office and the next technician see what you saw. | On the job, write an on-site note and tap Save note, or add a photo under Photos. | — | `EXISTS (SELECT 1 FROM request_notes WHERE organization_id = $o AND author_id = $u) OR EXISTS (SELECT 1 FROM attachments t JOIN service_requests r ON r.id = t.service_request_id WHERE t.organization_id = $o AND r.organization_id = $o AND t.session_id IS NULL AND t.message_id IS NULL AND position('_admin_' in t.storage_key) = 0 AND ASSIGNED_ON_LIVE(r))` — photos carry no uploader; office uploads are excluded by their `_admin_` storage-key segment, and any other technician's photo on one of this technician's live jobs counts (lenient, stated) |
| `capture_signature` | Get the customer's signature | Proof the work was approved, kept on the job. | On the job, under Customer signature, hand the phone to the customer, then tap Save signature. Only the lead technician can do this. | Lead only | `EXISTS (SELECT 1 FROM service_requests r WHERE r.organization_id = $o AND r.signed_at IS NOT NULL AND LEAD_ON_LIVE(r))` |
| `build_invoice` | Build the invoice and get it approved | The invoice goes out while you're still on site. | On the job, tap Open invoice, then Create invoice if there isn't one. Check the lines, tap Customer approval, and have the customer sign and tap Approve and finalize. Only the lead technician builds the invoice. | Lead only | `EXISTS (SELECT 1 FROM invoices i JOIN service_requests r ON r.id = i.service_request_id WHERE i.organization_id = $o AND r.organization_id = $o AND i.fieldpulse_invoice_id IS NULL AND i.hcp_invoice_id IS NULL AND i.state IN ('open','paid','refunded') AND LEAD_ON_LIVE(r))` — an office finalize on this technician's job counts (lenient, stated) |
| `collect_payment` | Collect payment on site | Cash and checks are recorded on the spot. A pay link lets the customer pay by phone. | After the customer approves, record cash or a check in the sheet that opens, or tap Send pay link. | Lead only | `EXISTS (SELECT 1 FROM payments WHERE organization_id = $o AND recorded_by = $u AND status = 'succeeded') OR EXISTS (SELECT 1 FROM invoices i JOIN service_requests r ON r.id = i.service_request_id WHERE i.organization_id = $o AND r.organization_id = $o AND i.pay_link_sent_at IS NOT NULL AND LEAD_ON_LIVE(r))` — a pay-link claim that is released after a failed send can be read in between and stamp the step (write-once; accepted) |

**Button labels** in the how lines are the app's, verified against the components: `Clock in`
/ `Clock out` (`tech-jobs-list-client.tsx`), `Share my location` (`tech-location-tracker.tsx`),
`On my way`, `I've arrived`, `Done`, `Close out` (`tech-status-confirm.ts`), card titles
`Materials used`, `On-site note`, `Customer signature`, `Photos` and buttons `Add`, `Save note`
(`tech-job-detail-client.tsx`), `Save signature` (`signature-pad.tsx`), `Open invoice`,
`Create invoice`, `Customer approval`, `Approve and finalize`, `Send pay link`
(`tech-invoice-card.tsx`, `create-invoice-prompt.tsx`, `invoice-collect-buttons.tsx`,
`approval-sheet.tsx`). The Record payment sheet opens by itself after approval.

**`Working` is a required fix, not a copy choice.** `TECH_STATUS_LABELS` has no `in_progress`
entry, so the tap today reads "In progress" while two sheet strings say "Tap Working first" /
"Tap Working when you are back at it" and the page-tech skill calls it the Working tap. This
spec adds `in_progress: 'Working'` to `TECH_STATUS_LABELS` and updates
`tech-status-confirm.test.ts` (one assertion). The status badge (`labelAssignmentStatus`) keeps
"In progress". The guide's how line then matches the button.

Notes:
- All steps are sticky once stamped. No live steps, no `needsAttention`.
- Stamps are written only when a guide read sees the signal. A material added then removed
  before any read never stamps; the technician does it again. Accepted.
- Helpers can never complete the three lead-only steps; they sit under "Go further" with the
  `Lead only` chip and nothing depends on them.
- The job page's own `Clock In` button writes `kind='job'` entries and does not count for
  `clock_in`; the how line says so.
- The office guide's `tech_sign_in` flag is untouched.

## 4. Payload and derivation

`GET /api/tech/guide` (tech session 401; rate `tech:guide-get:${userId}` with
`RATE_LIMITS.adminRead`) →

```
{ steps: DerivedStep[], progress: { requiredDone, requiredTotal: 2, optionalDone, optionalTotal: 7 },
  upNext: StepId | null, finished: boolean, hasOpenJob: boolean,
  hiddenAt: string | null, cardHidden: boolean }
```

`cardHidden` = `cardHiddenFor(storedState, now)` from the SELECT copy (the stored stamp
only, never this read's new stamp), so the card shows the finished block for the 24 hours
after the stamp landed and then leaves.
`DerivedStep = { id, group: 'run' | 'further', title, why, how, required, leadOnly, done,
note? }`. Nothing in the payload links to a job: the list already has its rows.

Pure module `src/lib/tech/guide-steps.ts` (`STEP_DEFS`, `deriveGuide(signals, now)`,
`upNext`, `GuidePayload`, `Signals`; imports only types — client code uses `import type`).
`upNext` = first not-done required step in order, else first not-done optional step in order.

One FROM-less SELECT (`src/lib/tech/guide-sql.ts`, `guideSelectSql(organizationId, userId)`),
one boolean column per rule above plus `has_open_job` and `field_guide_state`. Rendered-SQL
tests pin a literal count of `organization_id` parameters and assert every user predicate by
column name.

**Stamps** (`guideStampSql({ organizationId, userId, newStamps })`): one statement

```
UPDATE users SET field_guide_state = jsonb_set(OLD, '{firstCompleted}',
  $new::jsonb || FC, true)
WHERE id = $u AND organization_id = $o AND role = 'technician'
  AND NOT (FC ?& $keys::text[])
```

with `OLD` = `CASE WHEN jsonb_typeof(field_guide_state) = 'object' THEN field_guide_state ELSE
'{}'::jsonb END` and `FC` = `CASE WHEN jsonb_typeof(OLD->'firstCompleted') = 'object' THEN
OLD->'firstCompleted' ELSE '{}'::jsonb END`. Old values win; undefined keys are dropped before
`$keys` is built (`definedOnly`). At most one stamp statement per GET, only when `newStamps` is
non-empty; the payload is built from the SELECT copy merged in memory, never from RETURNING; a
failed stamp write is logged (`logger.warn`, ids only) and the derived payload still returns.
Two concurrent GETs stamping disjoint keys both land (row lock + re-evaluated WHERE under READ
COMMITTED).

**PATCH `/api/tech/guide`** (tech session 401 → `isSameOriginRequest` 403, absent `Origin`
included, the signature route's order; rate `tech:guide-patch:${userId}` with
`RATE_LIMITS.adminMutation`; body zod strict `{ hidden: true }`) → `guideHideSql({
organizationId, userId, hiddenAt })`:

```
UPDATE users SET field_guide_state = jsonb_build_object('hiddenAt', $iso::text) || OLD
WHERE id = $u AND organization_id = $o AND role = 'technician'
RETURNING field_guide_state
```

(old wins, so a repeat keeps the first timestamp). Zero rows → 404 `NOT_FOUND` "Technician not
found". Response: `{ hiddenAt }` parsed from RETURNING. No audit.

State (`src/lib/tech/guide-state.ts`, zod, tolerant parse that never throws): `{ hiddenAt?:
string; firstCompleted: Partial<Record<StepId, string>> }`. Unknown keys ignored; bad dates
dropped.

## 5. Data model

Migration `drizzle/0054_tech_guide.sql`: `ALTER TABLE users ADD COLUMN IF NOT EXISTS
field_guide_state jsonb;` (nullable; absent = never read). Journal entry (`idx` 54, `version`
`"7"`, `when` = a fresh `Date.now()` greater than 0053's 1793755484801, tag `0054_tech_guide`,
`breakpoints: true`) and a REAL snapshot: copy `0053_snapshot.json`, add the column under
`users`, new `id`, `prevId` = 0053's id; `drizzle-kit generate` must then report "No schema
changes". Run `npm run db:migrate` on the dev branch before the integration suite or the walk.
Schema: `fieldGuideState: jsonb("field_guide_state")` on `users`. The column holds ISO
timestamps and step ids only. Erasure: nothing to do (no customer data; technicians are
deactivated, never deleted). No new indexes: each rule is an EXISTS over one org's rows for one
technician; acceptable at current sizes (stated).

**No demo-org rule.** The office guide skips writes for `DEMO_ORG_ID` because its state is one
row per org that demo visitors share. Here the state is one column on the technician's own user
row, and `PLATFORM_ORG_ID` in production equals `DEMO_ORG_ID`, so an org-id gate would strip
the real business's technicians of their progress and bring the card back on every phone
session. Writes are per user and harmless, so they always happen. The dev default org's
technicians therefore get stamped on dev; that is fine.

## 6. UI

Tech conventions (`page-tech`): base shadcn primitives only, `h-11` targets, one-handed,
`max-w-md`. Sentence case; no `err.message` in UI. Copy strings live in
`src/lib/tech/guide-copy.ts` and `STEP_DEFS`; tests pin them.

- **Progress**: label `N of 2 done` (13 px mono tabular muted) and a 6 px track
  (`bg-surface-sunken`, `rounded-full`) with a `bg-primary` fill; `<div role="progressbar"
  aria-valuemin="0" aria-valuemax="2" aria-valuenow={N} aria-valuetext="N of 2 done"
  aria-label="Getting started progress">`; fill width transition 300 ms
  `cubic-bezier(0.23,1,0.32,1)`, none under `prefers-reduced-motion`.
- **Step glyph**: done → `Check` 16 px `text-success-strong`; up next → 8 px filled dot
  `bg-primary`; other → 8 px ring `border border-border-strong`. `sr-only` text `Done` /
  `Up next` / `To do`. A row that flips to done while mounted fades its glyph in over 180 ms.
- **Row**: `min-h-11`, title 15 px medium, chip 11 px medium `border border-border
  text-muted-foreground rounded-[3px] px-1.5` (`Lead only` where set), how line 13 px muted
  under the title (suppressed on the up-next row on the page, where the hero already shows
  it), note 13 px muted under the how. Rows are static; the hero's button is the page's one
  link to the list.
- **Hero** (up next, page only): `Up next` eyebrow (11 px uppercase tracking-wide muted), title
  17 px semibold, why 15 px, how 13 px muted, note, then one `Button` `h-12 rounded-xl w-full`
  `Go to my jobs` → `/tech/jobs`.
- **Finished block**: title `You've run a job start to finish` (17 px semibold), two check
  lines `You started a job` / `You finished a job`, then `The rest are optional. Pick them up
  when they're useful.` (13 px muted). The page shows it in place of the hero, with the "Go
  further" card underneath; the card shows it with `See all steps` and ×.
- **Card** (`src/components/tech/guide-card.tsx`, rendered by `TechJobsListClient`): the list
  keeps `todayFirst: { href } | null | 'unknown'`, captured only from a successful `today`
  fetch (preferring a row whose `assignmentStatus` is `in_progress`, `arrived` or `en_route`,
  else the first row), never cleared by a tab switch and never derived from another range. The
  card renders only once both the guide payload and the first Today fetch have settled, so
  nothing pops in afterwards. Layout: header row (`Getting started` 15 px semibold · `N of 2`
  mono muted · × `h-11 w-11` ghost `aria-label="Hide the guide from your jobs"` / finished
  `"Close the getting started card"`), bar, `Up next` eyebrow + title + how (+ note), `Open the
  job` `h-12 rounded-xl w-full` when not finished and `todayFirst` is set, then `See all steps`
  (13 px medium primary, `min-h-11`). The skeleton (after 300 ms) has the card's own layout
  (header row, bar, two text lines, an `h-12` block, a link line) and the card's `min-h`, so the
  swap does not move the list. On ×: the card is replaced at once by one line `Tap Guide at
  the top to see it again.` (13 px muted, `role="status"`, this visit only) and focus moves to
  the checked radio of the Today / Upcoming / Past control (`[role=radio][aria-checked=true]`
  through a wrapper ref); the PATCH runs after; on failure the card returns with `Couldn't
  update the guide. Please try again.` (`role="alert"`) under the link and focus stays where
  it is.
- **Page** (`src/app/tech/guide/page.tsx` + `src/components/tech/guide-page-client.tsx`):
  `ArrowLeft` link `Back` → `/tech/jobs` (`min-h-11`), title `Getting started` 20 px semibold
  (an `h1`, matching the invoice page), progress, hero or finished block, card `Run a job`
  (17 px title) with the two required rows, card `Go further` with meta `N of 7` and the seven
  optional rows. Loading: nothing for 300 ms, then a skeleton of the progress and three rows.
  Error: `Couldn't load the guide.` with a `Try again` button (`h-11`; `Loading…` and disabled
  while the refetch runs).
- **Jobs list**: the card sits between the clock row and the segmented control. Compact by
  design (header, bar, title, how, at most one button, link); it leaves within a day of the
  first finished job. On a 375×667 phone the first job stays reachable with one scroll (a
  screenshot in §9 checks the tallest state). Accepted.

Pure seams for the no-DOM test rule: `src/lib/tech/guide-view.ts` — `cardState(payload |
null, { loading, failed, slowElapsed, guideHidden, todaySettled })` → `'nothing' |
'skeleton' | 'card' | 'finished' | 'hidden'` (hidden when `guideHidden` or when
`payload.cardHidden`; `todaySettled` is true once the first Today fetch succeeded, failed or
was aborted by a tab switch, so the card never waits for the whole visit),
`progressLabel(progress)`, `cardNote(step, hasOpenJob, todayFirst)`, `glyphFor(step, upNext)`;
`src/lib/tech/guide-state.ts` also exports `cardHiddenFor(state, now)` (shared by the server
read and the GET);
`src/lib/tech/guide-refresh.ts` — the event name constant and `subscribeGuideRefresh(cb,
target)` (adds/removes the listener; tested with a stub target).

## 7. Tests

Pure (vitest, no DOM): `guide-steps.test.ts` (each rule from signals; sticky stamps; upNext
order; progress counts; `finished`/`finishedAt`; the no-job note; `leadOnly`),
`guide-state.test.ts` (tolerant parse), `guide-sql.test.ts` (rendered SQL via
`PgDialect().sqlToQuery`: a literal count of `organization_id` params for the SELECT; every
user predicate present by column name; stamp statement: `?&` guard, both `jsonb_typeof`
CASEs, `definedOnly`, `role = 'technician'`; hide statement: `||` old-wins order and
RETURNING), route tests (GET: 401, payload shape, stamp statement executed only with new
stamps, stamp failure still 200; PATCH: 401 with a valid Origin, missing Origin 403,
cross-origin 403, 400 on `{}` and `{ hidden: false }`, 404 on zero rows),
`guide-queries.test.ts` (`readGuideHidden` returns false on a thrown select and true for a
day-old finish stamp), `guide-state.test.ts` also covers `cardHiddenFor` (hiddenAt; stamp
23 h vs 25 h old; no stamp), `guide-view.test.ts` (every `cardState` branch incl.
`guideHidden`, `payload.cardHidden`, `todaySettled` after an abort; `cardNote` variants;
`progressLabel`),
`guide-refresh.test.ts`, `guide-copy.test.ts`, and the one-line `tech-status-confirm.test.ts`
change for `Working`.

Integration (`tests/integration/tech-guide.test.ts`, in `INTEGRATION_SUITES`, dev DB only, two
throwaway orgs via `createOrgCore`, deleted in `afterAll`; every UPDATE in the suite carries
`WHERE id = $row AND organization_id = $org`). Seeding recipe: insert the request with
`assigned_to = <lead>` and `scheduled_date = today` so the 0050 trigger creates visit #1 and
the lead row, then insert only the helper's assignment row. Cases, in order: (a) the helper
BEFORE any request is seeded → 0 of 2, upNext `start_job` with the no-job note, no stamp
statement run, `cardHidden` false; then seed the request; (b) the helper's row stamped
`en_route_at` → `start_job` done and stamped; nulling that row's `en_route_at` (by id and org)
leaves it done (sticky); (c) `completed_at` + `started_at` → `finished` with `finishedAt`,
next GET writes nothing; (d) PATCH hidden → stored; a second PATCH keeps the first timestamp;
(e) tenancy: technician B in org 2 with materials, notes and a started assignment → none of it
counts for A, and `guideSelectSql(org2, A.id)` returns every boolean column false (the org
parameter gates, not the user id alone); (f) concurrency smoke: two stamp statements with
disjoint keys → both keys present; (g) a finish stamp backdated 25 hours by SQL (by id and
org) → `cardHidden` true from both `readGuideHidden` and the GET.

## 8. Docs

`page-tech` skill: new "Getting started guide" section (files, rules, stamps, refresh event,
the 24-hour finished rule, probe recipe: mint with `MINT_ORG_ID npx tsx
scripts/agent/mint-tech-session.mjs` and assert the token's `userId`, `GET /api/tech/guide`,
PATCH with `Origin: http://localhost:3000`); `replica/build-log.md` row "Tech getting
started"; no `replica/features.csv` row (not a replica feature; same ruling as the office
guide); `replica/architecture.md`: one line under the technician app. Memory:
`replica-program-fp-st.md` paragraph.

## 9. Verification walk (after the build)

Dev server on :3000, dev branch migrated. A throwaway org via `createOrgCore`; by SQL: a
customer WITHOUT a phone; the lead technician with `is_active = false` (so
`mint-tech-session.mjs`, which takes the first active technician, can only mint the helper);
the helper technician (active, password irrelevant); the request with `assigned_to = <lead>`
and `scheduled_date = today` (the trigger makes visit #1 + the lead row); the helper's
assignment row (default status `assigned`). Mint with `MINT_ORG_ID`, decode the token and
assert `userId` = the helper and `organizationId` = the org. Queue guard before the first tap:
`SELECT count(*) FROM communication_jobs WHERE status = 'pending' AND scheduled_for <= now() +
interval '15 minutes'` = 0.

Playwright walk (390×844, geolocation granted, `Origin` set by the browser), a screenshot per
state: `/tech/jobs` → card `0 of 2`, up next `Start your first job`, `Open the job` present,
no note → `/tech/guide` (hero, `Run a job`, `Go further · 0 of 7`) → `Go to my jobs` → tap the
row → `On my way` → `I've arrived` → `Working` → back → card `1 of 2`, up next `Finish a job` →
open the job → `Done` → in the dialog (`getByRole('dialog')`) tap `Done` → back → finished
block → `/tech/guide` → toggle `Share my location` on → `Go further` reads `1 of 7` without a
reload (the refresh event) → back to the list → × → the hint line, focus on the checked radio
→ `Guide` in the header → the page with the finished block → back → `Clock in` on the list →
`Guide` again → `Go further · 2 of 7`. Plus one 375×667 shot of the card in its tallest state
(note + button).
Afterwards assert `SELECT count(*) FROM communication_jobs WHERE organization_id =
<throwaway>` = 0 and delete the org. The dev default org is never used for taps (FieldPulse
push).
