# Setup guide: onboarding that completes itself

Status: v2 (2026-11-04) after adversarial review round 1 (three lenses; log in
`docs/superpowers/specs/2026-11-04-onboarding-review-log.md`).
Owner: Raymond Chen. Replaces the existing six-step checklist
(`src/lib/admin/onboarding-queries.ts`, `src/components/admin/onboarding/onboarding-checklist.tsx`,
`GET/PATCH /api/admin/onboarding`, `organization_settings.onboarding_state`).

## 1. Goal

A new office signs in and, without reading a manual, reaches "a scheduled request is on a
technician's phone" by following one list. Every step is finished by *doing the real thing*
(adding a technician, saving hours, scheduling a request), and the list notices on its own.
Nobody ticks boxes. The office always knows how far along it is, from the home page and
the sidebar, and the guide gets out of the way once the business is running.

Inspiration (public FieldPulse owner guide, see `replica/recon.md`): an ordered path of
company → team → app → pricing → customers → first job, imperative step copy with one "why"
sentence, "Optional, but recommended" labels, admin-only setup. What FieldPulse does not have
publicly and we add: auto-detected completion, time estimates, deep links that open the exact
dialog, persistent progress, and a finishing moment.

Non-goals (v1): guided tours/tooltips, in-app video, sample-data seeding, per-plan variation,
a technician-side onboarding, scheduling a human setup call, analytics/telemetry, per-user
(as opposed to per-org) dismiss state.

## 2. Surfaces

| surface | what it shows | when |
| --- | --- | --- |
| `/admin/setup` (new page; "Setup" nav item) | the full guide: three phases, every step with status, an "Up next" hero, time estimates, deep links; a finished state | always reachable. The nav item sits first in the Operations group until `completedSeenAt` or `dismissedAt` is set, then moves to the end of the Integrations group |
| Home card (replaces `OnboardingChecklist`) | required progress `N of 6`, the "Up next" step as a one-tap CTA, the next two not-done steps (Up-next order), "See all steps" → `/admin/setup`, dismiss (×) | until `dismissedAt` or `completedSeenAt` is set; after the last required step completes it shows the finished state until × |
| Sidebar count | bare mono digit of required steps left on the Setup item (DIRECTION §nav: 11px mono 500 `--muted-foreground`, no chip; `sr` label "4 setup steps left") | hidden when 0, when `dismissedAt` is set, or when `completedSeenAt` is set |
| "Back to setup" banner | on the four dialog pages only (Staff, Pricebook, Requests, Customers) when the URL carried `from=setup`: a slim `InfoBanner` "Setup guide · <step title> · Back to setup guide"; when the store sees that step flip to done it becomes "Done · Back to setup guide" with the inline `Check` 120 ms fade | that visit only; nothing stored |

Admin and super_admin only (technicians have no admin session). State is **per org**
(`organization_settings`), so a × by one admin hides the card for every admin of that org;
the page stays one click away. Demo accounts: everything is derived and shown, but no write
ever persists (no stamps, PATCH returns the merged state without saving).

## 3. The steps

Order follows the FieldPulse owner path. Each step: imperative title, one "why" line, a time
estimate (minutes; "varies" where it depends on other people or systems), required/optional,
a deep link, and a completion rule computed from the org's real data. Every rule is scoped by
`organization_id` (through `withTenant`/explicit predicates inside each `EXISTS`).

### Phase 1 — Set up your company

| id | title | why | est | required | deep link | done when |
| --- | --- | --- | --- | --- | --- | --- |
| `company_name` | Add your company name | Customers see it on every message and invoice. | 1 | yes | `/admin/settings?tab=branding` | `organization_settings.company_name` non-empty |
| `phone_hours` | Add your phone and business hours | The assistant tells callers when you're open and how to reach you. | 3 | yes | `/admin/settings?tab=business` | `business_info.phone` non-empty AND `business_info.businessHours` non-empty |
| `brand` | Add your logo | Your portal, chat widget and emails carry your brand. | 2 | optional | `/admin/settings?tab=branding` | `logo_url` set (the primary color has a default, so it never counts) |

### Phase 2 — Get your team and prices in

| id | title | why | est | required | deep link | done when |
| --- | --- | --- | --- | --- | --- | --- |
| `add_technician` | Add a technician | Requests need someone who can sign in on a phone and run them. Running them yourself? Add yourself as a technician with a second email. | 3 | yes | `/admin/staff?new=technician` (opens the Add staff form with Technician preselected and a password field) | ≥1 `users` row with role `technician`, `is_active`, and `password_hash` NOT NULL (FieldPulse-imported technicians have no password; the row then shows "N technicians from FieldPulse need a password to sign in. Set one in Staff.") |
| `tech_sign_in` | Sign in on a phone | Technicians see their requests and update them on site. | 2 | yes | `/admin/staff` with the technician sign-in URL in a copyable field on the step | `flags.techSignedInAt` set (written server-side when any technician of the org signs in; §5) |
| `pricebook` | Add your first price | Estimates and invoices pull from the pricebook. Optional, but recommended. | 5 | optional | `/admin/pricebook?new=1` (opens the item form); secondary "Import from FieldPulse" → `/admin/fieldpulse-import` | ≥1 `pricebook_items` row with `active` |

### Phase 3 — Run your first request

| id | title | why | est | required | deep link | done when |
| --- | --- | --- | --- | --- | --- | --- |
| `first_request` | Create your first request | Add the customer, the problem and a time in one dialog. | 3 | yes | `/admin/requests?new=1` (opens the New request dialog, which creates the customer inline and offers a time + technician) | ≥1 `service_requests` row |
| `first_schedule` | Schedule and assign it | A scheduled, assigned request shows on that technician's phone. | 2 | yes | `/admin/requests` (hrefLabel "Open requests"); the why line explains "Pick a time and a technician in the request" | ≥1 `appointments` row with `cancelled_at IS NULL` AND (`starts_at` OR `scheduled_date` NOT NULL) AND (an `appointment_assignments` row exists for it OR its request's `assigned_to` IS NOT NULL) |
| `chat_widget` | Put the assistant on your website | Customers book while you sleep. Optional, but recommended. | 5 | optional | `/admin/settings?tab=embed` | an active publishable `widget_keys` row (`key_type='publishable' AND is_active AND revoked_at IS NULL`) AND (`flags.embedCopied` OR `allowed_origins` non-empty) |
| `integrations` | Bring in data from your other tools | FieldPulse, Housecall Pro or Google Calendar, so nothing is typed twice. Optional. | varies | optional | `/admin/integrations` | any of the three connection rows with `connected = true` |

Required = 6 (`company_name`, `phone_hours`, `add_technician`, `tech_sign_in`,
`first_request`, `first_schedule`); about 15 minutes in total (shown in the page header).
Optional = 4. Removed vs the current checklist: `account_created` (always true) and
`job_types` (seeded at provisioning, so it is done before anyone starts); `first_customer`
is folded into `first_request` (the dialog creates the customer).

Existing orgs on upgrade: rules are evaluated live, so whatever they have already done shows
as done. Two rules are stricter than before (`add_technician` needs a technician, not any
second user; `phone_hours` needs both fields); such orgs may show one or two open steps,
which §4 "grandfathering" handles so nobody is nagged.

## 4. Behaviour

**Auto-completion.** Every rule is evaluated on `GET /api/admin/onboarding` by ONE
FROM-less `SELECT` of scalar subqueries (`(SELECT company_name … WHERE organization_id=$org)`,
`EXISTS(…)` per step), each with its own org predicate, so a missing `organization_settings`
row yields NULLs, not zero rows. All source tables carry an `organization_id` index
(`customers_org_id_idx`, `requests_org_id_idx`, `appointments_org_starts_at_idx`,
`pricebook_items_org_idx`, `users_org_id_idx`, `staff_invites_org_id_idx`,
`widget_keys_org_id_idx`, the three connection tables' org indexes); each `EXISTS` is one
index probe. No new index, so no schema migration.

**Done.** A step is `done` when its rule holds now OR a first-completion stamp exists —
except `add_technician` and `first_schedule`, which are evaluated live: if they were stamped
earlier and the rule no longer holds (the only technician was deactivated; the only scheduled
request was cancelled) they show as "Needs attention" on the page and in the sidebar count,
and the home card does not come back. All other steps stay done (momentum over strict truth).

**First-completion stamps.** When a GET derives a step as done and no stamp exists, the GET
writes `firstCompleted[stepId]` with the exact statement in §6, sending only the ids that
need a stamp, existing stamps winning. Once every step is stamped, GETs write nothing. Stamps
are internal (ordering and the finishing moment); v1 shows "Done" without a date. Derived
stamps are system-derived and deliberately not audited (they are not an admin action).

**Grandfathering (first GET only).** On the first GET for an org with no stamps yet:
if all required steps are already done → set `completedSeenAt` in the same statement (no
finishing moment for work done before the guide existed); else if the org is older than 14
days AND has ≥1 completed request → set `dismissedAt` (established businesses are not
nagged; the page stays reachable). Demo sessions apply both rules in memory without writing.

**Up next.** The first not-done required step in order; if all required are done, the first
not-done optional step; if everything is done, none. The home card's two extra rows follow
the same order.

**Deep links that open the thing.** A hook `useOpenFromParam(key, allowed)` reads
`window.location.search` in a `useState` initializer (first render, before any effect —
`useUrlFilterSync` strips unknown params in its mount effect, so the hook must be declared
before it on Pricebook, Customers and Requests), opens the page's existing dialog state when
the value is in the whitelist, and strips `new` and `from` with `history.replaceState` in an
effect. Whitelist: `new=1` (Pricebook, Customers, Requests), `new=technician` (Staff opens
`staff-form-dialog` with role technician), `from=setup`. Other values are ignored; URL values
are never rendered. Settings links use the existing `?tab=`.

**Progress numbers.** Headline, bar and sidebar count all use the 6 required steps
("4 of 6"); optional steps get their own line "Go further · 1 of 4". The three never
disagree.

**Step-complete feedback.** No toasts, no row stagger (DIRECTION: never). The row that just
flipped to done gets a CSS transition (opacity + 4 px translate, `--dur-enter` 180 ms, the
repo token; reduced motion keeps opacity only — transitions survive the global rule,
keyframes do not). The bar uses the existing `ProgressBar` primitive unchanged.

**Finishing moment (peak-end).** When `requiredDone === 6` and `completedSeenAt` is unset,
both surfaces render the finished state: "You're ready to run requests" with the three wins
listed (team, first request, on a phone) and the optional steps under "Go further". The home
card's × sets `completedSeenAt` (PATCH); the page keeps the finished state reachable.

**Dismiss.** The home card's × sets `dismissedAt` (PATCH, optimistic; on error the card
returns with "Couldn't update the setup guide. Please try again."). Card and sidebar count
hide; the Setup item moves down; the page stays. No undo.

**Client store.** One module, `src/lib/admin/onboarding-store.ts`: module-level cache,
shared in-flight promise (card + sidebar + page on a cold load = one request), subscribers,
`refresh()` and `invalidate()`. Refresh triggers: mount of the page or card; the sidebar's
`usePathname` changing to `/admin` or `/admin/setup`; a single `visibilitychange → visible`
listener when the data is older than 10 s; after every PATCH. No polling. A 429 or error
keeps the last good payload (the count never flickers to a skeleton). Rate: a handful of
GETs per minute under normal use, well inside `adminRead` (60/min).

**Empty/loading/error.** Under 300 ms nothing; then content-shaped skeletons (three phase
cards with row skeletons); on error an `ErrorState` with retry. The sidebar count is absent
until loaded.

## 5. Non-derivable signals

- `flags.embedCopied`: set by PATCH when the embed panel's "Copy" button is clicked (replaces
  the never-written `embedViewed`).
- `flags.techSignedInAt`: written inside `createTechSession` (`src/lib/auth/tech-session.ts`),
  which both technician sign-in paths use (`POST /api/auth/tech/login` and the Google OIDC
  callback), via `after()`; `organizationId` comes from the server-resolved user row, never
  from input; the statement is the flags merge in §6 guarded with
  `AND onboarding_state #> '{flags,techSignedInAt}' IS NULL`. No manual tick exists anywhere.

## 6. Data

`organization_settings.onboarding_state` (jsonb, nullable, typed with `$type` only):

```ts
{
  dismissedAt?: string;          // ISO
  completedSeenAt?: string;      // ISO
  firstCompleted?: Partial<Record<StepId, string>>; // ISO per step; internal
  flags?: { embedCopied?: boolean; techSignedInAt?: string };
}
```

Every write is a single server-side merge; JS never read-modify-writes the object.

Stamps (GET; `$new` = only the ids not yet stamped; existing stamps win; NULL-safe):

```sql
INSERT INTO organization_settings (organization_id, onboarding_state)
VALUES ($org, jsonb_build_object('firstCompleted', $new::jsonb))
ON CONFLICT (organization_id) DO UPDATE SET onboarding_state = jsonb_set(
  COALESCE(organization_settings.onboarding_state, '{}'::jsonb) || $top::jsonb, '{firstCompleted}',
  $new::jsonb || COALESCE(organization_settings.onboarding_state->'firstCompleted', '{}'::jsonb), true)
WHERE NOT (COALESCE(organization_settings.onboarding_state->'firstCompleted','{}'::jsonb) ?& $keys::text[])
RETURNING onboarding_state;
```

`$top` carries the grandfathering keys (`dismissedAt`/`completedSeenAt`) or `'{}'`. `updated_at`
is not bumped by derived stamps. Two concurrent GETs stamping different steps both land
(READ COMMITTED re-evaluates SET against the committed row).

Flags and PATCH keys:

```sql
UPDATE organization_settings SET onboarding_state = jsonb_set(
  COALESCE(onboarding_state,'{}'::jsonb) || $top::jsonb, '{flags}',
  COALESCE(onboarding_state->'flags','{}'::jsonb) || $flags::jsonb, true)
WHERE organization_id = $org [AND onboarding_state #> '{flags,techSignedInAt}' IS NULL]
RETURNING onboarding_state;
```

Legacy keys: a hand-authored **data** migration `drizzle/0051_onboarding_state_v2.sql` (no
schema change; `drizzle-kit generate` still reports none; journal + snapshot copy per the
repo recipe) rewrites `{dismissed:true}` → `dismissedAt = now()` and `{embedViewed:true}` →
`flags.embedCopied`, dropping the legacy keys; the reader tolerates both shapes for one
release; `scripts/agent/seed-org.mjs` writes the new keys. The state is parsed with a zod
schema using `.catch({})` so a malformed blob never throws.

## 7. API

`GET /api/admin/onboarding` → `{ steps: Step[], progress: { requiredDone, requiredTotal,
optionalDone, optionalTotal }, upNext: StepId | null, dismissedAt, completedSeenAt }`,
`Step = { id, phase, title, why, estimateMinutes: number | null, required, done,
needsAttention, href, hrefLabel, secondaryHref?, secondaryLabel?, note? }`. Admin session,
`adminRead` rate limit, tenancy by session org. One `db.batch`: [the SELECT] then, only when
new stamps or grandfathering keys are needed, [the stamp statement]; both skipped for demo
sessions' writes.

`PATCH /api/admin/onboarding` body (zod `strict`, `readJsonBody`, at least one key):
`{ dismissed?: true, completedSeen?: true, flags?: { embedCopied?: true } }` → the merged
state. `adminMutation` rate limit. Audit `onboarding_updated`, `details =
JSON.stringify({ keys: [...] })` (field names only). Demo sessions get the merged state back
without a write and no audit.

Consumers of the old envelope: the home card (rewritten), `onboarding-queries.test.ts`
(rewritten), `seed-org.mjs` (updated).

## 8. UI

- `/admin/setup`: `PageShell narrow`, `PageHeader` "Setup guide", subtitle "Finish these to
  run your first request. Steps complete on their own · about 15 min". Hero `SectionCard`
  "Up next" with title, why, estimate and one primary button (the deep link, labelled with
  the imperative title). Three `SectionCard`s (one per phase; `SectionCard` gains an optional
  `meta?: string` prop for "2 of 3") with rows: a new small `StepGlyph` (done = `Check` in a
  success chip; todo = the step number in a neutral chip; needs attention = `AlertTriangle`
  in a warning chip), title, why (muted 13 px), right side `~N min` mono (or "varies") and a
  secondary link button on todo rows; "Done" on done rows; `ContextBadge neutral` "Optional".
  At 390 px: phases stack, the hero button is full width, estimates wrap under titles, fully
  done phases collapse. Finished state replaces the hero.
- Home card: `SectionCard` "Setup guide" with `meta` "4 of 6"; the Up-next row as a primary
  CTA; two more rows; footer "See all steps"; × in the action slot.
- Sidebar: `NavItem.badge` becomes a map-driven union (`'unscheduled' | 'setup'`) with one
  hook per badge; the setup count renders as a bare muted mono digit; the Setup item's group
  position comes from the store state.
- Copy canon: sentence case, "request", "technician", "sign in", "color", Unicode …; no
  exclamation marks; errors "Couldn't … Please try again."

## 9. Acceptance

1. Fresh org created through `createOrgCore` (provisioning, not raw SQL): `/admin/setup`
   shows "0 of 6", Up next = "Add your company name", sidebar digit 6, home card shows the
   same CTA; `job_types` being seeded changes nothing.
2. Save the company name on `?tab=branding`, navigate back to `/admin/setup` → step done
   without reload (route-change refresh), Up next = phone and hours, digit 5.
3. `/admin/staff?new=technician&from=setup` opens the Add staff form with Technician
   preselected and the banner; saving a technician flips the banner to "Done · Back to setup
   guide" and completes `add_technician`; refreshing does not reopen the form; the URL no
   longer carries `new`/`from`.
4. A technician signing in through `POST /api/auth/tech/login` or the Google callback sets
   `flags.techSignedInAt` once and completes `tech_sign_in`; an admin cannot set it by PATCH.
5. SQL-inserting customers, pricebook items, requests and assigned appointments (as a
   FieldPulse import would) completes `pricebook`, `first_request`, `first_schedule` with no
   clicks; an unassigned appointment does not complete `first_schedule`.
6. After the 6th required step the home card shows the finished state; × sets
   `completedSeenAt`, hides the card and the digit, and moves the Setup item; `/admin/setup`
   keeps the finished state with the optional steps under "Go further".
7. Deactivating the only technician afterwards re-opens `add_technician` as "Needs
   attention" (digit 1) without the home card returning; deleting the only pricebook item
   leaves `pricebook` done (stamp).
8. Integration suite (`npm run test:integration`, real dev DB): two concurrent GETs stamping
   different steps leave both stamps; a PATCH `embedCopied` racing the technician hook keeps
   both flags; a missing settings row is created by the stamp statement.
9. Tenancy: another org seeded with rows in every source table leaves the fresh org at
   "0 of 6"; technician sessions get 401 on both routes.
10. Upgrade: an org that finished the old checklist long ago gets `completedSeenAt` on its
    first GET and sees no card; an 18-month-old org missing `phone_hours` gets `dismissedAt`
    and sees no card or digit; legacy `dismissed`/`embedViewed` are rewritten by migration
    0051; demo sessions never write.
11. Gates: tsc 0, eslint 0 errors, unit vitest baseline not lowered; pure tests for
    `deriveSteps`, `upNext`, progress, needs-attention, the grandfathering decision, state
    parsing (legacy + malformed), badge text, `useOpenFromParam`'s whitelist parser; route
    tests for GET (stamp statement sent only when needed; demo skips writes) and PATCH
    (strict body, audit keys, demo no-write); `verify-skills` 0 missing; skills updated:
    `page-dashboard`, `page-settings`, `page-staff`, `page-requests`, `page-pricebook`,
    `page-customers`, new `page-setup`.

## 10. Risks and decisions

- Rules are lenient by design (EXISTS, not quality checks) except where leniency misleads
  (a technician must be able to sign in; a schedule must reach a phone).
- Two live steps can re-open; everything else is sticky.
- Per-org state is a known simplification; per-user dismiss is a later change.
- The finished state is suppressed for work done before the guide existed, so launch day
  shows nothing to established orgs.
- Deep-link params are read once; cancelling the dialog is not re-prompted.
