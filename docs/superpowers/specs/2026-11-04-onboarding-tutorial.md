# Setup guide: onboarding that completes itself

Status: v3 (2026-11-04) after adversarial review rounds 1–2 (log in
`docs/superpowers/specs/2026-11-04-onboarding-review-log.md`).
Owner: Raymond Chen. Replaces the existing six-step checklist
(`src/lib/admin/onboarding-queries.ts`, `src/components/admin/onboarding/onboarding-checklist.tsx`,
`GET/PATCH /api/admin/onboarding`, `organization_settings.onboarding_state`).

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
(as opposed to per-org) dismiss state.

## 2. Surfaces

| surface | what it shows | when |
| --- | --- | --- |
| `/admin/setup` (new page; "Setup" nav item) | the full guide: three phases, every step with status, an "Up next" hero, time estimates, deep links; a finished state | always reachable. Nav position: before the store has loaded, and whenever `completedSeenAt` or `dismissedAt` is set, the item sits at the end of the Integrations group; once loaded for an org still in setup it sits second in Operations (after Dashboard). The last known position is cached in `localStorage` (try/catch) so returning users never see it jump |
| Home card (replaces `OnboardingChecklist`) | required progress `N of 4`, the "Up next" step as a one-tap CTA, the next two not-done steps (Up-next order), "See all steps" → `/admin/setup`, dismiss (×) | until `dismissedAt` or `completedSeenAt` is set; after the last required step completes it shows the finished state until × |
| Sidebar digit | bare mono digit on the Setup item (DIRECTION nav rule: 11 px mono 500 `--muted-foreground`, no chip; `sr` label "2 setup steps left") = required steps not done | hidden when 0 and never after `dismissedAt`; after `completedSeenAt` it shows only when some step `needsAttention` |
| "Back to guide" banner | on Staff, Pricebook, Requests and Settings when the URL carried `from=setup`: a slim `InfoBanner` "Setup guide: <step title> · Back to guide"; when the store sees that step flip to done it becomes "Done · Back to guide" with the inline `Check` 120 ms fade | that visit only; nothing stored; after a cancelled dialog it stays, pointing back |

Admin and super_admin only (technicians have no admin session). State is **per org**
(`organization_settings`); a × by one admin hides the card for every admin of that org; the
page stays one click away. Demo sessions: steps are derived and shown, grandfathering is
skipped, × and the finished-state acknowledgement are kept in memory for the session, and no
write ever persists (no stamps, no PATCH).

## 3. The steps

Order follows the FieldPulse owner path, cut to what this app needs. Each step: imperative
title, one "why" line, a time estimate (minutes; "varies" where it depends on another person
or system), required/optional, a deep link, and a completion rule computed from the org's real
data. Every scalar subquery, nested ones included, carries its own `organization_id` predicate.

### Phase 1 — Set up your company

| id | title | why | est | req | deep link | done when |
| --- | --- | --- | --- | --- | --- | --- |
| `phone_hours` | Add your business phone and hours | The assistant tells callers when you're open and how to reach you. | 3 | yes | `/admin/settings?tab=business&from=setup` | `business_info->>'phone'` non-empty AND `business_info->>'businessHours'` non-empty |
| `brand` | Add your logo | Your portal, chat widget and emails carry your brand. | 2 | no | `/admin/settings?tab=branding&from=setup` | `logo_url` set |

The company name is no longer a step: provisioning now copies the signup "Business name" into
`organization_settings.company_name` (today it only lands in `organizations.name`, so messages
fall back to a default — a live bug), and migration 0051 backfills NULL `company_name` from
`organizations.name`.

### Phase 2 — Get your team and prices in

| id | title | why | est | req | deep link | done when |
| --- | --- | --- | --- | --- | --- | --- |
| `add_technician` | Add a technician | Requests need someone who can sign in on a phone and run them. Running them yourself? Add yourself with a second email. | 3 | yes | `/admin/staff?new=technician&from=setup` (opens the Add staff form, Technician preselected, password required); secondary "Invite by link" → `/admin/staff?new=invite&from=setup` | ≥1 `users` row with role `technician`, `is_active`, and (`password_hash` NOT NULL OR `google_id` NOT NULL) — OR `flags.techSignedInAt` is set. If the org has active technicians that match none of these (FieldPulse-imported, no password) and Google sign-in is not configured, the row shows "N technicians from FieldPulse need a password to sign in. Set one in Staff." |
| `pricebook` | Add your first price | Estimates and invoices pull from the pricebook. | 5 | no | `/admin/pricebook?new=1&from=setup` (opens the item form); secondary "Import from FieldPulse" → `/admin/fieldpulse-import` | ≥1 `pricebook_items` row with `active` |

### Phase 3 — Run your first request

| id | title | why | est | req | deep link | done when |
| --- | --- | --- | --- | --- | --- | --- |
| `book_first_request` | Book your first request | Add the customer, the problem, a time and a technician in one dialog. | 4 | yes | `/admin/requests?new=1&from=setup` (opens the New request dialog with the schedule panel open) | ≥1 `appointments` row with `cancelled_at IS NULL` AND (`starts_at` OR `scheduled_date` NOT NULL) AND (an `appointment_assignments` row with `status <> 'cancelled'` whose technician is an active technician of the org, OR the request's `assigned_to` is an active technician of the org). A request saved without a time and technician leaves the step open with the note "Pick a time and a technician in the request." |
| `tech_sign_in` | Have a technician sign in on their phone | They see the request you just booked and run it from there. | varies | yes | no navigation: the primary action is "Copy sign-in link" (the absolute `/tech-login` URL, `?email=` prefilled with the newest technician's email); instruction line "Open the link on the phone and sign in with the technician's email and password — not Google if that account is an admin." | `flags.techSignedInAt` set (§5) OR historical evidence: any `technician_time_entries` row, any technician-location row, or any active technician with `google_id` NOT NULL for the org (these exist only when a technician has used the app) |
| `chat_widget` | Add the chat widget to your website | Customers book while you sleep. | 5 | no | `/admin/settings?tab=embed&from=setup` | an active publishable `widget_keys` row (`key_type='publishable' AND is_active AND revoked_at IS NULL`) AND (`flags.embedCopied` OR `jsonb_array_length(allowed_origins) > 0`) |
| `integrations` | Bring in data from your other tools | FieldPulse, Housecall Pro or Google Calendar, so nothing is typed twice. | varies | no | `/admin/integrations` | any of the three connection rows with `connected = true` |

Required = 4 (`phone_hours`, `add_technician`, `book_first_request`, `tech_sign_in`); header
"about 10 min, plus your technician's sign-in". Optional = 4; the `ContextBadge` "Optional"
carries that label (why lines do not repeat it). Removed vs the current checklist:
`account_created`, `embed_widget` (manual flag), `job_types` (seeded), `company_name`
(seeded by this change), `first_customer`/`first_request`/`first_schedule` (merged).

## 4. Behaviour

**Auto-completion.** Every rule is evaluated on `GET /api/admin/onboarding` by ONE FROM-less
`SELECT` of scalar subqueries (`(SELECT … FROM organization_settings WHERE organization_id=$org)`,
`(SELECT created_at FROM organizations WHERE id=$org)`, and one short-circuiting `EXISTS` per
rule on org-leading indexes: `customers_org_id_idx`, `requests_org_id_idx`,
`appointments_org_starts_at_idx`, `pricebook_items_org_idx`, `users_org_id_idx`,
`widget_keys_org_id_idx`, the three connection tables' org indexes, the time-entry and
location tables' org indexes). A missing settings row yields NULLs, not zero rows. Subqueries
beyond the rules: the completed-request check and the FieldPulse password-less technician
count (for the note). No new index; no schema migration.

**Done (verbatim).** `live = id ∈ {add_technician, book_first_request}`;
`done = live ? rule : (rule || stamped)`; `needsAttention = live && stamped && !rule`;
`requiredDone = count(required && done)`; `digit = requiredTotal − requiredDone`. Live steps
re-open as "Needs attention" on the page (warning glyph) and in the digit per §2; the home
card never comes back for them.

**First-completion stamps.** When the SELECT derives a step as done and no stamp exists, the
route runs the stamp statement (§6) as a SECOND round trip (the statement's inputs come from
the SELECT, so it cannot share a `db.batch`), sending only the ids that need a stamp; existing
stamps win. Grandfathering implies a non-empty `$keys`, so the statement is sent iff `$keys` is
non-empty. The response never depends on `RETURNING`: it is the SELECT's copy merged in memory
with `$new` and `$top`. Once every step is stamped, GETs write nothing. Stamps are internal
(v1 shows "Done" without a date) and are system-derived, so they are deliberately not audited.

**Grandfathering (first GET only, non-demo).** When the org has no stamps yet: if all four
required steps derive as done (the `tech_sign_in` historical evidence makes this reachable
for established orgs) → `$top = { completedSeenAt: now }` (no finishing moment for work done
before the guide existed); else if the org is older than 14 days AND has ≥1 completed request
→ `$top = { dismissedAt: now }`. For dismissed orgs the page header reads "Setup guide ·
dismissed. Steps still complete on their own."

**Up next.** The first not-done required step in order (so `tech_sign_in`, which waits on
another person, comes last); then the first not-done optional step; else none. The home
card's two extra rows follow the same order.

**Deep links that open the thing.** A hook `useOpenFromParam(key, allowed, open)` reads
`window.location.search` in a `useEffect` declared BEFORE `useUrlFilterSync` in the page
component (effects run in declaration order within a commit, so it reads the URL before the
filter hook's write effect calls `replaceState`); it calls `open(value)` when the value is in
the whitelist and records `from=setup` in state for the banner (one extra render; no
hydration mismatch because nothing reads `window` during render). It strips `new` and `from`
with `history.replaceState`. Whitelist: `new=1` (Pricebook, Requests), `new=technician` and
`new=invite` (Staff), `from=setup` (those three plus Settings). Other values are ignored; URL
values are never rendered. With `new=1&from=setup`, the New request dialog opens with the
schedule panel expanded.

**Refresh after doing the thing.** The four dialog pages call `onboardingStore.refresh()` from
their create success callback when `from=setup` was present, so the banner flips without
leaving the page.

**Progress numbers.** Headline, bar and digit all use the 4 required steps ("2 of 4"); optional
steps get their own line "Go further · 1 of 4".

**Step-complete feedback.** No toasts, no row stagger (DIRECTION forbids it). The row that
just flipped to done gets a CSS transition (opacity + 4 px translate, `--dur-enter` 180 ms;
reduced motion keeps opacity only — transitions survive the global rule, keyframes do not).
The bar uses the existing `ProgressBar` primitive unchanged.

**Finishing moment (peak-end).** When `requiredDone === 4` and `completedSeenAt` is unset,
both surfaces render the finished state: "You're ready to run requests" with the three wins
(team, first request, on a phone) and the optional steps under "Go further". The home card's
× sets `completedSeenAt`; the page keeps the finished state reachable.

**Dismiss.** The home card's × sets `dismissedAt` (optimistic; on error the card returns with
"Couldn't update the setup guide. Please try again."). Card and digit hide; the Setup item
moves down; the page stays. No undo.

**Client store.** `src/lib/admin/onboarding-store.ts`: module-level cache, shared in-flight
promise (card + sidebar + page on a cold load = one request), subscribers, `refresh()`
(no-op while a request is in flight or when the data is younger than 1 s) and `invalidate()`.
Refresh triggers: mount of the page or card; the sidebar's `usePathname` changing to `/admin`
or `/admin/setup`; one `visibilitychange → visible` listener when the data is older than
10 s; after every PATCH; the dialog-success calls above. No polling. A 429 or error keeps the
last good payload. A pure `navGroupsFor(state)` derives the nav groups for the sidebar, the
dashboard shell and ⌘K search (Setup is searchable).

**Empty/loading/error.** Under 300 ms nothing; then content-shaped skeletons (three phase
cards with row skeletons); on error an `ErrorState` with retry. The digit is absent until
loaded.

## 5. Non-derivable signals

- `flags.embedCopied`: set by PATCH when the embed panel's copy of the REVEALED key/snippet is
  clicked (not the placeholder snippet copy); the never-written `embedViewed` is retired.
- `flags.techSignedInAt`: written inside `createTechSession` (`src/lib/auth/tech-session.ts`),
  which both technician sign-in paths use (`POST /api/auth/tech/login` and the Google OIDC
  callback), via `after()` inside a try/catch that only logs (a failed write never fails a
  sign-in); `organizationId` comes from the server-resolved user row; skipped for the demo org
  (org-id check); the statement is the flags upsert in §6 guarded with
  `onboarding_state #> '{flags,techSignedInAt}' IS NULL`. `scripts/agent/mint-tech-session.mjs`
  bypasses this (dev only; noted in `page-tech`). No manual tick exists anywhere.

## 6. Data

`organization_settings.onboarding_state` (jsonb, nullable, `$type` only):

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

Stamps (`$new` = only the ids not yet stamped; `$top` = grandfathering keys or `'{}'`;
old values win everywhere, so timestamps are write-once):

```sql
INSERT INTO organization_settings (organization_id, onboarding_state)
VALUES ($org, $top::jsonb || jsonb_build_object('firstCompleted', $new::jsonb))
ON CONFLICT (organization_id) DO UPDATE SET onboarding_state = jsonb_set(
  $top::jsonb || COALESCE(organization_settings.onboarding_state, '{}'::jsonb), '{firstCompleted}',
  $new::jsonb || CASE WHEN jsonb_typeof(organization_settings.onboarding_state->'firstCompleted') = 'object'
                      THEN organization_settings.onboarding_state->'firstCompleted' ELSE '{}'::jsonb END, true)
WHERE NOT (COALESCE(organization_settings.onboarding_state->'firstCompleted','{}'::jsonb) ?& $keys::text[]);
```

Flags and PATCH keys (`$flags` = `'{}'` when none; the bracketed guard only for the
technician hook):

```sql
INSERT INTO organization_settings (organization_id, onboarding_state)
VALUES ($org, $top::jsonb || jsonb_build_object('flags', $flags::jsonb))
ON CONFLICT (organization_id) DO UPDATE SET onboarding_state = jsonb_set(
  $top::jsonb || COALESCE(organization_settings.onboarding_state,'{}'::jsonb), '{flags}',
  $flags::jsonb || CASE WHEN jsonb_typeof(organization_settings.onboarding_state->'flags') = 'object'
                        THEN organization_settings.onboarding_state->'flags' ELSE '{}'::jsonb END, true)
[WHERE organization_settings.onboarding_state #> '{flags,techSignedInAt}' IS NULL]
RETURNING onboarding_state;
```

Concurrency: `organization_id` is the primary key; two concurrent GETs stamping different
steps both land (READ COMMITTED re-evaluates SET against the committed row); a PATCH racing
the technician hook keeps both flags; a row-less org is created by whichever statement runs
first.

Migration `drizzle/0051_onboarding_state_v2.sql` (data only; no schema change; journal +
re-id'd snapshot copy like `0044_last_admin_guard`; `drizzle-kit generate` → "No schema
changes"): ADDITIVE — adds `dismissedAt` (ISO via
`to_char(now() AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')`) where `dismissed = true`
and `flags.embedCopied` where `embedViewed = true`, keeps the legacy keys (old code may still
serve during the deploy), guarded `WHERE onboarding_state ?| array['dismissed','embedViewed']
AND NOT (onboarding_state ? 'dismissedAt')` so re-runs are no-ops; `dismissed = false` is
left alone; plus `UPDATE organization_settings s SET company_name = o.name FROM organizations
o WHERE o.id = s.organization_id AND s.company_name IS NULL`. A later migration drops the
legacy keys. `scripts/agent/seed-org.mjs` writes the new keys.

## 7. API

`GET /api/admin/onboarding` → `successResponse(payload)` with `payload = { steps: Step[],
progress: { requiredDone, requiredTotal, optionalDone, optionalTotal }, upNext: StepId | null,
dismissedAt, completedSeenAt }` (no `onboarding` wrapper), `Step = { id, phase, title, why,
estimateMinutes: number | null, required, done, needsAttention, href, hrefLabel, action?:
"copy_sign_in_link", copyValue?, secondaryHref?, secondaryLabel?, note? }`. Admin session,
`adminRead` rate limit, tenancy by session org. Two round trips at most: the SELECT, then the
stamp statement iff `$keys` is non-empty and the session is not demo.

`PATCH /api/admin/onboarding` body (`readJsonBody`; `z.strictObject({ dismissed:
z.literal(true).optional(), completedSeen: z.literal(true).optional(), flags:
z.strictObject({ embedCopied: z.literal(true).optional() }).optional() })` refined to at least
one leaf) → the merged state. `adminMutation` rate limit. Audit `onboarding_updated`,
`details = JSON.stringify({ keys: [...] })` (field names only). Demo sessions get the merged
state back with no write and no audit.

Consumers of the old envelope: the home card (rewritten), `onboarding-queries.test.ts`
(rewritten), `seed-org.mjs` (updated).

## 8. UI

- `/admin/setup`: `PageShell narrow`, `PageHeader` "Setup guide", subtitle "Finish these to
  run your first request. Steps complete on their own · about 10 min, plus your technician's
  sign-in". Hero `SectionCard` "Up next" with title, why, estimate and one primary button
  (the deep link labelled with the imperative title, or "Copy sign-in link" for
  `tech_sign_in`). Three `SectionCard`s (one per phase; `SectionCard` gains `meta?: string`
  for "1 of 2") with rows: a new `StepGlyph` (done = `Check` in a success chip; todo = step
  number in a neutral chip; needs attention = `AlertTriangle` in a warning chip), title, why
  (muted 13 px), right side `~N min` mono (or "varies") and a secondary link button on todo
  rows; "Done" on done rows; `ContextBadge neutral` "Optional"; a `note` line when present.
  At 390 px: phases stack, the hero button is full width, estimates wrap under titles, fully
  done phases collapse. Finished state replaces the hero; dismissed orgs get the header note.
- Home card: `SectionCard` "Setup guide" with `meta` "2 of 4"; the Up-next row as a primary
  CTA; two more rows; footer "See all steps"; × in the action slot.
- Sidebar: `NavItem.badge` becomes a map-driven union (`'unscheduled' | 'setup'`) with one
  hook per badge; the setup digit renders as a bare muted mono digit; `navGroupsFor(state)`
  places the Setup item.
- Copy canon: sentence case, "request", "technician", "sign in", Unicode …; no exclamation
  marks; errors "Couldn't … Please try again."

## 9. Acceptance

1. Fresh org created through `createOrgCore` (provisioning): `company_name` equals the
   signup business name; `/admin/setup` shows "0 of 4", Up next = "Add your business phone
   and hours", digit 4, home card shows the same CTA; the Setup item sits second in Operations
   once loaded (and at the end of Integrations before load, with no visible jump on the next
   visit thanks to the cached position).
2. Save phone + hours on `?tab=business` (banner shown via `from=setup`), navigate back to
   `/admin/setup` → step done without reload, Up next = "Add a technician", digit 3.
3. `/admin/staff?new=technician&from=setup` opens the Add staff form with Technician
   preselected and the banner; saving flips the banner to "Done · Back to guide" (store
   refresh from the dialog) and completes `add_technician`; refreshing does not reopen the
   form; the URL no longer carries `new`/`from`. `new=invite` opens the Invite dialog; an
   unknown `new` value does nothing. The same banner flip holds on Pricebook and Requests.
4. `/admin/requests?new=1&from=setup` opens the New request dialog with the schedule panel
   expanded; saving with a time and a technician completes `book_first_request`; saving
   without them leaves it open with the "Pick a time and a technician" note.
5. A technician signing in through `POST /api/auth/tech/login` or the Google callback sets
   `flags.techSignedInAt` once and completes `tech_sign_in`; the step's "Copy sign-in link"
   copies the absolute `/tech-login` URL; an admin cannot set the flag by PATCH; a technician
   with `google_id` and no password satisfies `add_technician`.
6. SQL-inserting customers, pricebook items, requests and assigned appointments (as a
   FieldPulse import would) completes `pricebook` and `book_first_request`; an unassigned or
   cancelled appointment does not.
7. After the 4th required step the home card shows the finished state; × sets
   `completedSeenAt`, hides the card and the digit, moves the Setup item; `/admin/setup` keeps
   the finished state with the optional steps under "Go further".
8. Afterwards, deactivating the only technician re-opens `add_technician` as "Needs attention"
   on the page and shows digit 1 (the `completedSeenAt` exception) without the home card
   returning; cancelling the only booked request re-opens `book_first_request`; deleting the
   only pricebook item leaves `pricebook` done (stamp). After `dismissedAt` the digit never
   shows.
9. Integration suite `tests/integration/onboarding-state.test.ts` (added to
   `INTEGRATION_SUITES`, run manually with `npm run test:integration` against the dev DB;
   orgs created via `createOrgCore({ skipOrgCountCheck })` and deleted afterwards; the
   statements tested through the query module): two concurrent GETs stamping different steps
   leave both stamps; a PATCH `embedCopied` racing the flags upsert keeps both flags; a
   row-less org is created by the stamp statement and by the flags statement; repeated
   PATCH `dismissed` keeps the first timestamp.
10. Tenancy: org B seeded "done" in every source table incl. a settings row with stamps and
    flags; org A shows "0 of 4" and "0 of 4"; B's `onboarding_state` is byte-identical after
    A's GET and PATCH; a pure test asserts the generated SQL carries the org parameter once
    per subquery; technician sessions get 401 on both routes.
11. Upgrade: an org that finished the old checklist long ago AND has technician evidence gets
    `completedSeenAt` on its first GET and sees no card; an 18-month-old org missing
    `phone_hours` gets `dismissedAt`, sees no card or digit, and its page header shows the
    dismissed note; legacy `dismissed`/`embedViewed` gain the new keys by migration 0051 and
    keep the old ones; NULL `company_name` is backfilled; demo sessions never write and never
    grandfather.
12. Surfaces pinned: dismiss error rollback copy; `screenshot-page.mjs /admin/setup 390`
    looked at (phases stack, hero full width, done phase collapsed); reduced-motion keeps
    the opacity transition; the FieldPulse password note appears only without Google OIDC;
    the revealed-key copy sets `embedCopied` and the placeholder copy does not; skeletons
    appear only after 300 ms.
13. Gates: tsc 0, eslint 0 errors, unit vitest baseline not lowered; pure tests for
    `deriveSteps` (incl. `live`/`needsAttention`), `upNext`, progress, the grandfathering
    decision, state parsing (legacy + per-field malformed), digit text and visibility,
    `navGroupsFor`, the `useOpenFromParam` whitelist parser; route tests for GET (stamp
    statement sent iff keys; demo skips writes) and PATCH (strict body, audit keys, demo
    no-write); `verify-skills` 0 missing; skills updated: `page-dashboard`, `page-settings`,
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
