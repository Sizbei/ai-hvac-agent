# Setup guide: onboarding that completes itself

Status: v4 FINAL (2026-11-04) after three adversarial review rounds (log in
`docs/superpowers/specs/2026-11-04-onboarding-review-log.md`).
Owner: Raymond Chen. Replaces the existing six-step checklist
(`src/lib/admin/onboarding-queries.ts`, `src/components/admin/onboarding/onboarding-checklist.tsx`
mounted in `src/app/admin/(dashboard)/page.tsx`, `GET/PATCH /api/admin/onboarding`,
`organization_settings.onboarding_state`).

## 1. Goal

A new office signs in and, without reading a manual, reaches "a booked request is on a
technician's phone" by following one short list. Every step is finished by *doing the real
thing*, and the list notices on its own. Nobody ticks boxes. The office always knows how far
along it is, from the home page and the sidebar, and the guide gets out of the way once the
business is running.

Inspiration (public FieldPulse owner guide, `replica/recon.md`): an ordered path of company →
team → app → pricing → customers → first job, imperative step copy with one "why" sentence,
"Optional, but recommended" labels, admin-only setup. What FieldPulse does not have publicly
and we add: auto-detected completion, time estimates, deep links that open the exact dialog,
persistent progress, and a finishing moment.

Non-goals (v1): guided tours/tooltips, in-app video, sample-data seeding, per-plan variation,
a technician-side onboarding, scheduling a human setup call, analytics/telemetry, per-user
(as opposed to per-org) dismiss state, QR codes, email prefill on the technician sign-in page.

## 2. Surfaces

| surface | what it shows | when |
| --- | --- | --- |
| `/admin/setup` (new page; "Setup" nav item) | the full guide: three phases, every step with status, an "Up next" hero (or the needs-attention step, or the finished state), time estimates, deep links | always reachable. Nav placement is decided SERVER-SIDE on every admin page from the existing layout query (`src/app/admin/(dashboard)/layout.tsx` already selects the org; it gains a left join to `organization_settings` and passes `setupPlacement: "operations" | "integrations"` into `DashboardShell`): second in Operations (after Dashboard) while neither `completedSeenAt` nor `dismissedAt` (nor legacy `dismissed`) is set, else at the end of the Integrations group. The client store never moves it mid-session; the next page load reflects a change. No `localStorage` |
| Home card (replaces `OnboardingChecklist`) | required progress `N of 4`, the "Up next" step as a one-tap CTA, the next two not-done steps (Up-next order, with the Optional badge where applicable), "See all steps" → `/admin/setup`, dismiss (×) | until `dismissedAt` or `completedSeenAt` is set; after the last required step completes it shows the finished state until × |
| Sidebar digit | bare mono digit on the Setup item (DIRECTION nav rule: 11 px mono 500 `--muted-foreground`, no chip; `sr` label "1 setup step left" / "N setup steps left" / "1 setup step needs attention") = required steps not done | hidden when 0 and never after `dismissedAt`; after `completedSeenAt` it shows only when some step `needsAttention` |
| "Back to guide" banner | on Staff, Pricebook, Requests and Settings when the URL carried `from=setup`: a slim `InfoBanner` "Setup guide: <step title> · Back to guide". When the store refresh after a save flips the step to done it becomes "Done · Back to guide" (inline `Check` 120 ms fade); when the save left the step open it shows the step's `note` ("Saved. Pick a time and a technician on that request to finish this step · Back to guide"); after an invite create it reads "Invite created. This step completes when they accept it · Back to guide" | that visit only; nothing stored; after a cancelled dialog it stays, pointing back |

Admin and super_admin only (technicians have no admin session). State is **per org**
(`organization_settings`); a × by one admin hides the card for every admin of that org; the
page stays one click away. Demo org (`organizationId === DEMO_ORG_ID`, the same check on the
admin and technician paths): steps are derived and shown, `tech_sign_in` derives as done,
grandfathering is skipped, × and the finished-state acknowledgement are kept in
`sessionStorage` (try/catch), and no write ever persists (no stamps, no PATCH, no flag).

## 3. The steps

Order follows the FieldPulse owner path, cut to what this app needs. Each step: imperative
title, one "why" line, a time estimate, required/optional, a deep link with a short
`hrefLabel` verb phrase for the button, and a completion rule computed from the org's real
data. Every scalar subquery, nested ones included, carries its own `organization_id`
predicate.

### Phase 1 — Set up your company

| id | title | why | est | req | deep link / button | done when | note |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `phone_hours` | Add your business phone and hours | The assistant tells callers when you're open and how to reach you. | 3 | yes | `/admin/settings?tab=business&from=setup` · "Open business info" | `business_info->>'phone'` non-empty AND `business_info->>'businessHours'` non-empty | when exactly one is set: "Add both a phone number and hours." |
| `brand` | Add your logo | Your portal, chat widget and emails carry your brand. | 2 | no | `/admin/settings?tab=branding&from=setup` · "Open branding" | `logo_url` set | — |

The company name is not a step: `createOrgCore` now seeds `organization_settings.company_name`
from the signup business name (`left(name, 120)`; today it only lands in `organizations.name`,
so messages fall back to a default — a live bug), and migration 0051 backfills NULL
`company_name` from `organizations.name` (same truncation; an org that deliberately cleared it
gets it refilled — acceptable, stated).

### Phase 2 — Get your team and prices in

| id | title | why | est | req | deep link / button | done when | note |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `add_technician` | Add a technician | Requests need someone who can sign in on a phone and run them. Running them yourself? Add yourself with a second email. | 3 | yes | `/admin/staff?new=technician&from=setup` · "Add technician" (opens the Add staff form, Technician preselected, password required); secondary "Invite by link" → `/admin/staff?new=invite&from=setup`. When the org has FieldPulse-imported technicians that cannot sign in, the primary becomes `/admin/staff?from=setup` · "Set a password in Staff" | ≥1 `users` row with role `technician`, `is_active`, and (`password_hash` NOT NULL OR `google_id` NOT NULL). (A former admin who signed in with Google and was later demoted satisfies it — accepted as lenient.) | "Waiting for an invite to be accepted." when an unexpired, unrevoked technician `staff_invites` row exists; "N technicians from FieldPulse can't sign in yet. Use Reset password in Staff." (with Google OIDC enabled: "… Have them sign in with Google, or use Reset password in Staff.") when active technicians exist with neither a password nor `google_id` |
| `pricebook` | Add your first price | Estimates and invoices pull from the pricebook. | 5 | no | `/admin/pricebook?new=1&from=setup` · "Add price"; secondary "Import from FieldPulse" → `/admin/fieldpulse-import` | ≥1 `pricebook_items` row with `active` | — |

### Phase 3 — Run your first request

| id | title | why | est | req | deep link / button | done when | note |
| --- | --- | --- | --- | --- | --- | --- | --- |
| `book_first_request` | Book your first request | Add the customer, the problem, a time and a technician in one dialog. | 4 | yes | `/admin/requests?new=1&from=setup` · "New request" (opens the New request dialog with the schedule panel expanded — applied inside the dialog's `reset()`, since the draft resets on every open) | ≥1 `appointments` row with `cancelled_at IS NULL` AND (`starts_at` OR `scheduled_date` NOT NULL) AND (an `appointment_assignments` row with `status <> 'cancelled'` whose technician is an active technician of the org, OR `EXISTS (service_requests r JOIN users u ON u.id = r.assigned_to WHERE r.id = a.service_request_id AND r.organization_id = $org AND u.organization_id = $org AND u.role='technician' AND u.is_active)`) | "Pick a time and a technician in the request." when a request exists but no qualifying appointment |
| `tech_sign_in` | Have a technician sign in on their phone | They see the requests assigned to them and run them from there. | null ("When they're ready") | yes | no navigation: primary action "Copy sign-in link" (the absolute `/tech-login` URL from `NEXT_PUBLIC_APP_URL`, trailing slash stripped, no query); after a click the label becomes "Copied" with the 14 px `Check` for 1.5 s (no false confirmation on failure); the bare URL is shown under the button as selectable mono text so it can be read aloud; instruction "Open it on the technician's phone and sign in with their email and password." plus, only when Google OIDC is enabled, "Use the password, not Google, if this email also signs in to the office." | `flags.techSignedInAt` set (§5) OR historical evidence: any `technician_time_entries` row or any `technician_locations` row for the org (written only through `/api/tech/*`), or any active technician with `google_id` NOT NULL (lenient, see above) | — |
| `chat_widget` | Add the chat widget to your website | Customers book while you sleep. | 5 | no | `/admin/settings?tab=embed&from=setup` · "Open embed settings" | an active publishable `widget_keys` row (`key_type='publishable' AND is_active AND revoked_at IS NULL`) AND (`flags.embedCopied` OR `jsonb_array_length(allowed_origins) > 0`) | — |
| `integrations` | Bring in data from your other tools | FieldPulse, Housecall Pro or Google Calendar, so nothing is typed twice. | null ("Depends on the tool") | no | `/admin/integrations` · "Open integrations" | any of the three connection rows with `connected = true` | — |

Required = 4 (`phone_hours`, `add_technician`, `book_first_request`, `tech_sign_in`); header
"about 10 min, plus your technician's sign-in". Optional = 4, labelled by the `ContextBadge`
"Optional" on page and card rows (why lines do not repeat it). The signed-in technician need
not be the assigned one (a completion rule, not a quality check). Removed vs the current
checklist: `account_created`, `embed_widget`, `job_types` (seeded), `company_name` (seeded by
this change), `first_customer`/`first_request`/`first_schedule` (merged).

## 4. Behaviour

**Auto-completion.** Every rule is evaluated on `GET /api/admin/onboarding` by ONE FROM-less
`SELECT` of scalar subqueries (`(SELECT … FROM organization_settings WHERE organization_id=$org)`,
`(SELECT created_at FROM organizations WHERE id=$org)`, one short-circuiting `EXISTS` per rule
on org-leading indexes — `requests_org_id_idx`, `appointments_org_starts_at_idx`,
`pricebook_items_org_idx`, `users_org_id_idx`, `staff_invites_org_id_idx`,
`widget_keys_org_id_idx`, `tte_org_idx`, `tloc_org_idx`, the three connection tables' org
indexes — plus the completed-request check, the pending-invite check and the FieldPulse
password-less technician count). A missing settings row yields NULLs, not zero rows. No new
index; no schema migration.

**Done (verbatim).** `live = id ∈ {add_technician, book_first_request}`;
`done = live ? rule : (rule || stamped)`; `needsAttention = live && stamped && !rule`;
`requiredDone = count(required && done)`; `digit = requiredTotal − requiredDone`. Live steps
re-open as "Needs attention" (warning glyph) on the page — rendered in the hero slot ABOVE the
finished block when the org is finished — and in the digit per §2; the home card never comes
back for them.

**First-completion stamps.** When the SELECT derives a step as done and no stamp exists, the
route runs the stamp statement (§6) as a SECOND round trip (its inputs come from the SELECT, so
it cannot share a `db.batch`), sending only the ids that need a stamp; existing stamps win.
The statement is sent iff `$keys` is non-empty OR `$top` is non-empty. The response never
depends on `RETURNING`: it is the SELECT's copy merged in memory with `$new` and `$top`. Once
every step is stamped, GETs write nothing. Stamps are internal (v1 shows "Done" without a
date) and system-derived, so they are deliberately not audited.

**Grandfathering (first GET only, non-demo).** When the org has no stamps yet: if all four
required steps derive as done (historical `tech_sign_in` evidence makes this reachable) →
`$top = { completedSeenAt: now }` (no finishing moment for work done before the guide existed);
else if the org is older than 14 days AND has ≥1 completed request → `$top = { dismissedAt:
now }`. For dismissed orgs the page header note reads "Hidden from the home page. Steps still
complete on their own." and the subtitle becomes "Steps complete on their own." (also for
`completedSeenAt` orgs).

**Up next.** The first not-done required step in order; then the first not-done optional
step; else none. The home card's two extra rows follow the same order.

**Deep links that open the thing.** A hook `useOpenFromParam(key, allowed, open)` reads
`window.location.search` in a `useEffect` declared BEFORE `useUrlFilterSync` in the page
component (effects run in declaration order within a commit, so it reads the URL before the
filter hook's write effect calls `replaceState`); it calls `open(value)` when the value is in
the whitelist and records `from=setup` in state for the banner (one extra render; no hydration
mismatch because nothing reads `window` during render); it strips `new` and `from` with
`history.replaceState`. Whitelist: `new=1` (Pricebook, Requests), `new=technician` and
`new=invite` (Staff), `from=setup` (those three plus Settings). Other values are ignored; URL
values are never rendered.

**Refresh after doing the thing.** When `from=setup` was present: Staff (Add staff form,
Invite dialog and Reset password dialog success), Pricebook (item form success), Requests
(New request dialog success) and Settings (`saveConfig` resolving `true` on the Business,
Branding or Embed tab) call `onboardingStore.refresh()`, so the banner flips without leaving
the page.

**Progress numbers.** Headline, bar and digit all use the 4 required steps ("2 of 4"). Phase
`meta` counts required steps only ("1 of 1") and is omitted for a phase with no required
steps; a phase collapses when its required steps are done. Optional steps are grouped under
an "Optional" heading below the phases with meta "Go further · 1 of 4".

**Step-complete feedback.** No toasts, no row stagger (DIRECTION forbids it). The row that
just flipped to done gets a CSS transition (opacity + 4 px translate, `--dur-enter` 180 ms;
reduced motion keeps opacity only — transitions survive the global rule, keyframes do not).
The bar uses the existing `ProgressBar` primitive unchanged.

**Finishing moment (peak-end).** When `requiredDone === 4` and `completedSeenAt` is unset,
both surfaces render the finished state: title "You're ready to run requests", the three wins
verbatim — "Your technician can sign in", "Your first request is booked", "It's on a
technician's phone" — and the optional steps under "Go further". The home card's × sets
`completedSeenAt`; the page keeps the finished state reachable.

**Dismiss.** The home card's × sets `dismissedAt` (optimistic; on error the card returns with
"Couldn't update the setup guide. Please try again."). Card and digit hide; the page stays;
the nav moves on the next page load. No undo.

**Client store.** `src/lib/admin/onboarding-store.ts`: module-level cache, shared in-flight
promise (card + sidebar + page on a cold load = one request), subscribers, `refresh()`
(no-op while a request is in flight or when the data is younger than 1 s) and `invalidate()`.
Refresh triggers: mount of the page or card; the sidebar's `usePathname` changing to `/admin`
or `/admin/setup`; one `visibilitychange → visible` listener when the data is older than 10 s;
after every PATCH; the save/success calls above. No polling. A 429 or error keeps the last
good payload. A pure `navGroupsFor(placement)` derives the nav groups for the sidebar, the
dashboard shell and ⌘K search from the server-provided placement (`global-search.tsx` builds
its item list inside the component, not at module scope). Setup is searchable.

**Empty/loading/error.** Under 300 ms nothing; then content-shaped skeletons (three phase
cards with row skeletons); on error an `ErrorState` with retry. The digit is absent until
loaded.

## 5. Non-derivable signals

- `flags.embedCopied`: set by PATCH when the embed panel's copy of the REVEALED key/snippet is
  clicked (not the placeholder snippet copy); the never-written `embedViewed` is retired.
- `flags.techSignedInAt`: written inside `createTechSession` (`src/lib/auth/tech-session.ts`,
  which has `payload.organizationId` from the server-resolved user row), used by both
  technician sign-in paths (`POST /api/auth/tech/login` and the Google OIDC callback), via
  `after()` inside a try/catch that only logs; skipped when `organizationId === DEMO_ORG_ID`
  (`src/lib/tenancy/organization.ts`); the statement is the flags upsert in §6 guarded with
  `onboarding_state #> '{flags,techSignedInAt}' IS NULL`; tested with a pure test of the
  statement (the login route test mocks the module). `scripts/agent/mint-tech-session.mjs`
  bypasses this (dev only; noted in `page-tech`). No manual tick exists anywhere.

## 6. Data

`organization_settings.onboarding_state` (jsonb, nullable; the schema `$type` is widened):

```ts
{
  dismissedAt?: string;          // ISO, write-once
  completedSeenAt?: string;      // ISO, write-once
  firstCompleted?: Partial<Record<StepId, string>>; // ISO per step; internal
  flags?: { embedCopied?: boolean; techSignedInAt?: string };
  dismissed?: boolean; embedViewed?: boolean;       // legacy, read for one release
}
```

Parsed with a zod schema whose fields each `.catch(undefined)` (one malformed field never
drops the others); dates are strings validated with `Date.parse`. Every write is one
server-side upsert; JS never read-modify-writes the object. Params: jsonb values as
`JSON.stringify` text params cast `::jsonb`; arrays via `sql.param([...])::text[]`.
`OLD` below stands for
`CASE WHEN jsonb_typeof(organization_settings.onboarding_state) = 'object' THEN organization_settings.onboarding_state ELSE '{}'::jsonb END`
(a top-level JSON `null` would otherwise turn `||` into an array).

Stamps (`$new` = only the ids not yet stamped; `$top` = grandfathering keys or `'{}'`;
`$keys` = ids in `$new`; `$topKeys` = keys in `$top`; old values win everywhere, so
timestamps are write-once):

```sql
INSERT INTO organization_settings (organization_id, onboarding_state)
VALUES ($org, $top::jsonb || jsonb_build_object('firstCompleted', $new::jsonb))
ON CONFLICT (organization_id) DO UPDATE SET onboarding_state = jsonb_set(
  $top::jsonb || OLD, '{firstCompleted}',
  $new::jsonb || CASE WHEN jsonb_typeof(OLD->'firstCompleted') = 'object' THEN OLD->'firstCompleted' ELSE '{}'::jsonb END, true)
WHERE NOT (COALESCE(OLD->'firstCompleted','{}'::jsonb) ?& $keys::text[])
   OR NOT (OLD ?& $topKeys::text[]);
```

(`?&` with an empty array is true, so an empty `$keys` or `$topKeys` never blocks the other
branch.)

Flags and PATCH keys (`$flags` = `'{}'` when none; the bracketed guard only for the
technician hook):

```sql
INSERT INTO organization_settings (organization_id, onboarding_state)
VALUES ($org, $top::jsonb || jsonb_build_object('flags', $flags::jsonb))
ON CONFLICT (organization_id) DO UPDATE SET onboarding_state = jsonb_set(
  $top::jsonb || OLD, '{flags}',
  $flags::jsonb || CASE WHEN jsonb_typeof(OLD->'flags') = 'object' THEN OLD->'flags' ELSE '{}'::jsonb END, true)
[WHERE OLD #> '{flags,techSignedInAt}' IS NULL]
RETURNING onboarding_state;
```

Concurrency: `organization_id` is the primary key and every other column has a default; two
concurrent GETs stamping different steps both land (READ COMMITTED re-evaluates SET against
the committed row); a PATCH racing the technician hook keeps both flags; a row-less org is
created by whichever statement runs first.

Migration `drizzle/0051_onboarding_state_v2.sql` (data only; no schema change; journal +
re-id'd snapshot copy like `0044_last_admin_guard`; `--> statement-breakpoint` between
statements; `drizzle-kit generate` → "No schema changes"): ADDITIVE —

```sql
UPDATE organization_settings SET onboarding_state = onboarding_state
  || CASE WHEN onboarding_state->>'dismissed' = 'true' AND NOT (onboarding_state ? 'dismissedAt')
          THEN jsonb_build_object('dismissedAt', to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')) ELSE '{}'::jsonb END
  || CASE WHEN onboarding_state->>'embedViewed' = 'true' AND onboarding_state #> '{flags,embedCopied}' IS NULL
          THEN jsonb_build_object('flags', COALESCE(onboarding_state->'flags','{}'::jsonb) || '{"embedCopied":true}'::jsonb) ELSE '{}'::jsonb END
WHERE jsonb_typeof(onboarding_state) = 'object'
  AND ((onboarding_state->>'dismissed' = 'true' AND NOT (onboarding_state ? 'dismissedAt'))
    OR (onboarding_state->>'embedViewed' = 'true' AND onboarding_state #> '{flags,embedCopied}' IS NULL));
--> statement-breakpoint
UPDATE organization_settings s SET company_name = left(o.name, 120)
  FROM organizations o WHERE o.id = s.organization_id AND s.company_name IS NULL;
```

Legacy keys are kept (old code may still serve during the deploy); a later migration drops
them; `dismissed = false` is left alone; re-runs are no-ops. `scripts/agent/seed-org.mjs`
writes the new keys.

## 7. API

`GET /api/admin/onboarding` → `successResponse(payload)` with `payload = { steps: Step[],
progress: { requiredDone, requiredTotal, optionalDone, optionalTotal }, upNext: StepId | null,
dismissedAt, completedSeenAt }` (no `onboarding` wrapper), `Step = { id, phase, title, why,
estimateMinutes: number | null, estimateLabel, required, done, needsAttention, href,
hrefLabel, action?: "copy_sign_in_link", copyValue?, instruction?, secondaryHref?,
secondaryLabel?, note? }`. Admin session, `adminRead` rate limit, tenancy by session org. Two
round trips at most: the SELECT, then the stamp statement iff `$keys` or `$top` is non-empty
and the org is not the demo org.

`PATCH /api/admin/onboarding` body (`readJsonBody`; `z.strictObject({ dismissed:
z.literal(true).optional(), completedSeen: z.literal(true).optional(), flags:
z.strictObject({ embedCopied: z.literal(true).optional() }).optional() })` refined to at least
one leaf) → the merged state. `adminMutation` rate limit. Audit `onboarding_updated`,
`details = JSON.stringify({ keys: [...] })` (field names only). Demo org: the merged state is
returned with no write and no audit.

Consumers of the old envelope: the home card (rewritten) and its mount in
`src/app/admin/(dashboard)/page.tsx`, `onboarding-queries.test.ts` (rewritten),
`seed-org.mjs` (updated).

## 8. UI

- `/admin/setup`: `PageShell narrow`, `PageHeader` "Setup guide", subtitle "Finish these to
  run your first request. Steps complete on their own · about 10 min, plus your technician's
  sign-in" (or "Steps complete on their own." for dismissed/finished orgs, plus the dismissed
  note). Hero `SectionCard` "Up next" with title, why, estimate label, `note` when present,
  and one primary button (`hrefLabel`, or "Copy sign-in link" with the URL text and
  instruction below). Needs-attention step takes the hero slot when present (above the
  finished block). Three phase `SectionCard`s (`SectionCard` gains `meta?: string`) with rows:
  a new `StepGlyph` (done = `Check` in a success chip; todo = step number in a neutral chip;
  needs attention = `AlertTriangle` in a warning chip), title, why (muted 13 px), right side
  `~N min` mono or the estimate label, a secondary link button on todo rows, "Done" on done
  rows, `ContextBadge neutral` "Optional", a `note` line when present. "Optional" group below
  with "Go further · N of 4". At 390 px: phases stack, the hero button is full width,
  estimates wrap under titles, phases whose required steps are done collapse.
- Home card: `SectionCard` "Setup guide" with `meta` "2 of 4"; the Up-next row as a primary
  CTA; two more rows (Optional badge where applicable); footer "See all steps"; × in the
  action slot.
- Sidebar: `NavItem.badge` becomes a map-driven union (`'unscheduled' | 'setup'`) with one
  hook per badge; the setup digit renders as a bare muted mono digit; `navGroupsFor(placement)`
  places the Setup item from the server-provided placement.
- Staff form dialog title fixed to sentence case ("Add staff member") in the same change.
- Copy canon: sentence case, "request", "technician", "sign in", Unicode …; no exclamation
  marks; errors "Couldn't … Please try again."

## 9. Acceptance

1. Fresh org created through `createOrgCore` (provisioning): `company_name` equals the
   signup business name (truncated to 120); `/admin/setup` shows "0 of 4", Up next = "Add
   your business phone and hours" with button "Open business info", digit 4, home card shows
   the same CTA; the Setup item renders second in Operations on first paint (server
   placement) with no movement after hydration.
2. Save phone + hours on `?tab=business` with `from=setup`: the banner flips to "Done · Back to
   guide" without leaving Settings; saving only the phone shows "Add both a phone number and
   hours."; back on `/admin/setup` Up next = "Add a technician", digit 3.
3. `/admin/staff?new=technician&from=setup` opens the Add staff form with Technician
   preselected and the banner; saving flips the banner to "Done · Back to guide" and
   completes `add_technician`; refreshing does not reopen the form; the URL no longer carries
   `new`/`from`. `new=invite` opens the Invite dialog; creating an invite shows the "Invite
   created…" banner and the row note "Waiting for an invite to be accepted."; accepting it and
   signing in completes `add_technician` then `tech_sign_in`. An unknown `new` value does
   nothing. The same banner flip holds on Pricebook and Requests.
4. `/admin/requests?new=1&from=setup` opens the New request dialog with the schedule panel
   expanded; saving with a time and a technician completes `book_first_request`; saving
   without them leaves it open, the banner shows the "Saved. Pick a time and a technician…"
   note and the row shows "Pick a time and a technician in the request."
5. A technician signing in through `POST /api/auth/tech/login` or the Google callback sets
   `flags.techSignedInAt` once and completes `tech_sign_in`; "Copy sign-in link" copies the
   absolute `/tech-login` URL (no query), shows "Copied" for 1.5 s, and the URL is visible as
   text; the Google clause appears only with OIDC enabled; an admin cannot set the flag by
   PATCH; a technician with `google_id` and no password satisfies `add_technician`.
6. A FieldPulse org with password-less technicians: the hero shows "Set a password in
   Staff" and the note; Reset password success refreshes the store; SQL-inserting customers,
   pricebook items, requests and assigned appointments (as an import would) completes
   `pricebook` and `book_first_request`; an unassigned or cancelled appointment does not.
7. After the 4th required step the home card shows the finished state with the three wins
   verbatim; × sets `completedSeenAt`, hides the card and the digit; `/admin/setup` keeps the
   finished state with the optional steps under "Go further"; the Setup item is at the end of
   Integrations on the next page load.
8. Afterwards, deactivating the only technician re-opens `add_technician` as "Needs attention"
   in the hero slot above the finished block and shows digit 1 (sr "1 setup step needs
   attention") without the home card returning; cancelling the only booked request re-opens
   `book_first_request`; deleting the only pricebook item leaves `pricebook` done (stamp).
   After `dismissedAt` the digit never shows.
9. Integration suite `tests/integration/onboarding-state.test.ts` (added to
   `INTEGRATION_SUITES`; run manually with `npm run test:integration` against the dev DB —
   it mocks `server-only`, parses `.env.local` like `seed-org.mjs`, and refuses
   `ep-withered-hill`; orgs created via `createOrgCore({ skipOrgCountCheck })` and deleted
   afterwards; statements exercised through the query module): two concurrent GETs stamping
   different steps leave both stamps; a PATCH `embedCopied` racing the flags upsert keeps
   both flags; a row-less org is created by the stamp statement and by the flags statement;
   repeated PATCH `dismissed` keeps the first timestamp; a `dismissedAt`-only grandfather
   write (empty `$keys`) lands.
10. Tenancy: org B seeded "done" in every source table incl. a settings row with stamps and
    flags; org A shows "0 of 4" and "0 of 4"; B's `onboarding_state` is byte-identical after
    A's GET and PATCH; a pure test asserts the generated SQL carries the org parameter once
    per subquery; technician sessions get 401 on both routes.
11. Upgrade: an org that finished the old checklist long ago AND has technician evidence gets
    `completedSeenAt` on its first GET and sees no card; an 18-month-old org missing
    `phone_hours` gets `dismissedAt`, sees no card or digit, and its page shows the dismissed
    note and subtitle; legacy `dismissed`/`embedViewed` gain the new keys by migration 0051
    and keep the old ones; NULL `company_name` is backfilled; the demo org shows "4 of 4" and
    the finished state, × survives a reload within the tab, and nothing is written.
12. Surfaces pinned: dismiss error rollback copy; `screenshot-page.mjs /admin/setup 390`
    looked at (phases stack, hero full width, done phase collapsed); reduced-motion keeps
    the opacity transition; the revealed-key copy sets `embedCopied` and the placeholder copy
    does not; skeletons appear only after 300 ms; the staff dialog title is sentence case.
13. Gates: tsc 0, eslint 0 errors, unit vitest baseline not lowered; pure tests for
    `deriveSteps` (incl. `live`/`needsAttention`, notes), `upNext`, progress, the
    grandfathering decision, state parsing (legacy + per-field malformed + top-level null),
    digit text/visibility incl. sr labels, `navGroupsFor`, the `useOpenFromParam` whitelist
    parser, the stamp/flags statement builders (rendered SQL incl. the `OLD` guards and both
    `?&` branches), the technician-hook statement; route tests for GET (stamp statement sent
    iff keys/top; demo skips writes) and PATCH (strict body, audit keys, demo no-write);
    `verify-skills` 0 missing; skills updated: `page-dashboard`, `page-settings`,
    `page-staff`, `page-requests`, `page-pricebook`, `page-tech` (mint script note), new
    `page-setup`.

## 10. Risks and decisions

- Rules are lenient by design (EXISTS, not quality checks) except where leniency misleads (a
  technician must be able to sign in; a booking must reach a phone).
- Two live steps can re-open; everything else is sticky.
- Per-org state is a known simplification; per-user dismiss is a later change.
- The finished state is suppressed for work done before the guide existed; established orgs
  that still have an open step are dismissed silently rather than nagged.
- Deep-link params are read once; cancelling the dialog is not re-prompted (the banner stays).
- Provisioning now seeds `company_name`; the backfill fixes the default-name fallback for
  existing orgs.
- The nav label for `/admin/settings` is "Chatbot settings"; a user returning later may not
  look there for business hours (outside this change).
