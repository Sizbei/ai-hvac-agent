# Setup guide: onboarding that completes itself

Status: draft v1 (2026-11-04), for adversarial review.
Owner: Raymond Chen. Builds on the existing six-step checklist
(`src/lib/admin/onboarding-queries.ts`, `src/components/admin/onboarding/onboarding-checklist.tsx`,
`GET/PATCH /api/admin/onboarding`, `organization_settings.onboarding_state`).

## 1. Goal

A new office signs in and, without reading a manual, reaches "first request scheduled and
a technician can run it" by following one list. Every step is finished by *doing the real
thing* (adding a technician, saving hours, scheduling a request), and the list notices on its
own. Nobody ticks boxes. The office always knows how far along it is, from the home page and
the sidebar, and the guide gets out of the way once the business is running.

Inspiration (public FieldPulse owner guide, see `replica/recon.md`): an ordered path of
company → team → app → pricing → payments → customers → first job → invoice, imperative step
copy with one "why" sentence, "Optional, but recommended" labels, admin-only setup. What
FieldPulse does not have publicly and we add: auto-detected completion, time estimates, deep
links that open the exact dialog, persistent progress, and a finishing moment.

Non-goals (v1): guided tours/tooltips, in-app video, sample-data seeding, per-plan variation,
a technician-side onboarding, scheduling a human setup call, analytics/telemetry.

## 2. Surfaces

| surface | what it shows | when |
| --- | --- | --- |
| `/admin/setup` (new page, "Setup" nav item, Operations group, first position) | the full guide: three phases, every step with status, "Up next" hero, time estimates, deep links; a completed state | always reachable; nav badge `N left` (required steps left) until all required steps are done |
| Home card (replaces the current `OnboardingChecklist`) | progress `N of M`, the "Up next" step as a one-tap CTA, the next two steps as a short list, "See all steps" → `/admin/setup`, dismiss (×) | until dismissed or all required steps done; after the last required step completes it shows the finished state once until dismissed |
| Sidebar badge | `N left` on the Setup item (same style as Calendar's unscheduled badge) | until all required steps are done |

Admin and super_admin only (technicians have no admin session). Demo accounts see the same
surfaces (their seeded data completes most steps; the guide hides itself).

## 3. The steps

Phase copy and order follow the FieldPulse owner path, compressed to one screen. Each step is
one sentence in the imperative plus one "why" line, a time estimate, a required/optional
label, a deep link, and a completion rule computed from the org's real data. `estimate` is
minutes.

### Phase 1 — Set up your company

| id | title | why | est | required | deep link | done when |
| --- | --- | --- | --- | --- | --- | --- |
| `company_profile` | Add your company name and phone | Customers see these on every message and invoice. | 2 | yes | `/admin/settings?tab=business` | `organization_settings.company_name` non-empty AND `business_info.phone` non-empty |
| `business_hours` | Set your business hours | The assistant books inside them and flags after-hours calls. | 3 | yes | `/admin/settings?tab=business` | `business_info.businessHours` non-empty |
| `brand` | Add your logo and colour | Your portal, chat widget and emails carry your brand. | 2 | optional | `/admin/settings?tab=branding` | `logo_url` set OR `primary_color` set |

### Phase 2 — Get your team and prices in

| id | title | why | est | required | deep link | done when |
| --- | --- | --- | --- | --- | --- | --- |
| `invite_team` | Add a technician | Requests need someone to run them. | 3 | yes | `/admin/staff?new=technician` (opens the add/invite dialog) | ≥1 active `users` row with role `technician` OR ≥1 `staff_invites` row |
| `pricebook` | Add your prices | Estimates and invoices pull from the pricebook. | 5 | yes | `/admin/pricebook?new=1` (opens the item form); secondary link "Import from FieldPulse" → `/admin/fieldpulse-import` | ≥1 active `pricebook_items` row |
| `job_types` | Name your job types | Requests and reports group by them. | 2 | optional | `/admin/settings?tab=job-types` | ≥1 active `job_types` row |

### Phase 3 — Run your first request

| id | title | why | est | required | deep link | done when |
| --- | --- | --- | --- | --- | --- | --- |
| `first_customer` | Add a customer | Every request belongs to a customer. | 2 | yes | `/admin/customers?new=1` (opens the new-customer dialog) | ≥1 `customers` row |
| `first_request` | Create a request | This is the job your technician will run. | 3 | yes | `/admin/requests?new=1` (opens the new-request dialog) | ≥1 `service_requests` row |
| `first_schedule` | Put it on the calendar | A scheduled request shows on the technician's phone. | 2 | yes | `/admin/calendar` | ≥1 `appointments` row with `starts_at` NOT NULL |
| `tech_app` | Sign in on a phone | Technicians run the day from `/tech`. | 2 | optional | `/admin/staff` (step text includes the sign-in URL) | any technician of the org has signed in (see §5 for the signal) |
| `chat_widget` | Put the assistant on your website | Customers book while you sleep. | 5 | optional | `/admin/settings?tab=embed` | an active publishable `widget_keys` row exists AND (`flags.embedCopied` OR `allowed_origins` non-empty) |
| `integrations` | Connect your other tools | FieldPulse, Housecall Pro or Google Calendar keep data in one place. | 5 | optional | `/admin/integrations` | any of `fieldpulse_connections.connected`, a Housecall Pro connection, a Google Calendar connection |

Required = 7 (`company_profile`, `business_hours`, `invite_team`, `pricebook`, `first_customer`,
`first_request`, `first_schedule`). Optional = 5. Progress headline counts all 12; the
finished state and the nav badge key off the 7 required.

Removed from v1 compared with the current checklist: `account_created` (always true; a step
that is done before you start is noise) and the manual-only `embed_widget` flag (replaced by
`chat_widget`, which is detectable). Existing orgs: everything they have already done shows
as done on first load; nothing is reset.

## 4. Behaviour

**Auto-completion.** Every `done when` rule is evaluated on each `GET /api/admin/onboarding`
with ONE database round trip: a single `SELECT` of scalar `EXISTS`/boolean subqueries scoped
by `organization_id` (no counts; EXISTS stops at the first row). The result is cached in the
client SWR cache for 60 s and revalidated on window focus, so returning from a deep link shows
the step ticked without a reload. No step is ever ticked by hand except the two non-derivable
flags below.

**First-completion stamps.** The first time a step is seen as done, the server records
`firstCompleted[stepId] = now` in `onboarding_state`. Stamps drive ordering of "done" rows
(most recent first), the one-time finishing moment, and never un-complete a step: a step
is `done` if its rule holds now OR a stamp exists (deleting the only customer later does not
re-open the guide).

**Up next.** The first not-done required step in order; if all required are done, the first
not-done optional step; if everything is done, none.

**Deep links that open the thing.** Four admin pages gain a tiny hook, `useOpenFromParam`,
reading `window.location.search` once on mount (the `useUrlFilterSync` pattern, no Suspense
boundary): `/admin/staff?new=technician`, `/admin/pricebook?new=1`, `/admin/customers?new=1`,
`/admin/requests?new=1`. The param is stripped from the URL after opening
(`history.replaceState`) so a refresh does not reopen the dialog. Settings deep links use the
existing `?tab=`.

**Back to the guide.** When a deep link carries `&from=setup`, the target page shows a slim
`InfoBanner` under its header for that visit only: "Setup guide · Step 4 of 12 — back to
setup" (link). It disappears on navigation; nothing is stored.

**Step-complete feedback.** The setup page and the home card keep the previous payload in
memory; when a revalidation flips a step to done, that row animates (opacity + 4px
translate, `--dur-enter`, reduced-motion → fade only) and the progress bar fills. No toasts.

**Finishing moment (peak-end).** When `requiredDone === requiredTotal` and
`completedSeenAt` is unset, both surfaces render the finished state: "You're set up to run
jobs" with the three biggest wins listed (team, prices, first request) and the optional steps
left under "Go further". The home card shows this once; its × (or any later visit after 7
days) sets `completedSeenAt` and the card hides for good. The setup page always keeps the
finished state reachable.

**Dismiss.** The home card's × sets `dismissedAt`; the card hides; the Setup nav item and page
stay. There is no "undo" because the page is one click away. PATCH is optimistic (card hides
immediately, reverts on error with "Couldn't update the setup guide. Please try again.").

**Nav badge.** `N left` = required steps not done, from the same cached payload (one fetch
feeds card, badge and page). Hidden at 0.

**Empty/loading/error.** Under 300 ms nothing; then content-shaped skeletons (three phase
cards with row skeletons); on error an `ErrorState` with retry. The badge never shows a
skeleton (absent until loaded).

## 5. Non-derivable signals

Two steps have no clean data signal today and get a stored flag, set by the real action,
never by a checkbox:

- `chat_widget.embedCopied`: set when the embed panel's "Copy snippet" is clicked (the
  existing `embedViewed` flag is renamed; it was never set by any UI — fix that bug here).
- `tech_app`: set when a technician session is minted for a user of the org (`POST` sign-in
  handler for `/tech`). Detail: the plan must confirm where technician sign-in lands
  (`src/lib/auth/tech-config.ts` signs the token); add `onboarding_state.flags.techSignedInAt`
  write there (one `UPDATE … SET onboarding_state = jsonb_set(...)` guarded on the key being
  absent, fire-and-forget via `after()`). If no server-side sign-in path exists (tokens minted
  elsewhere), the step shows a "Mark as done" button — the only manual tick in the guide,
  allowed because the step is optional.

## 6. Data

`organization_settings.onboarding_state` (jsonb, already exists, typed with `$type` only — no
migration) widens to:

```ts
{
  dismissedAt?: string;          // ISO
  completedSeenAt?: string;      // ISO; set when the finished state is acknowledged
  firstCompleted?: Partial<Record<StepId, string>>; // ISO per step
  flags?: { embedCopied?: boolean; techSignedInAt?: string };
  // legacy keys read once and migrated in memory: dismissed → dismissedAt, embedViewed → flags.embedCopied
}
```

All writes merge (never replace the object) with a single guarded `UPDATE` so two concurrent
GETs stamping different steps do not lose each other's keys (`jsonb_set`/`||` on the server,
not read-modify-write in JS).

## 7. API

`GET /api/admin/onboarding` → `{ steps: Step[], progress: { done, total, requiredDone,
requiredTotal }, upNext: StepId | null, dismissedAt, completedSeenAt }` where `Step = { id,
phase, title, why, estimateMinutes, required, done, completedAt, href, hrefLabel,
secondaryHref?, secondaryLabel? }`. Admin session, `adminRead` rate limit, tenancy by session
org. The GET also performs the first-completion stamping (idempotent, guarded UPDATE only when
a new stamp is needed).

`PATCH /api/admin/onboarding` body (zod, via `readJsonBody`): `{ dismissed?: true,
completedSeen?: true, flags?: { embedCopied?: true, techAppDone?: true } }` → the merged
state. `adminMutation` rate limit. Audit `onboarding_updated` with `details = { keys: [...] }`
(field names only).

The existing `GET`'s `{ onboarding }` envelope and the old step ids are replaced; the only
consumer is the home card, which is rewritten in the same change.

## 8. UI

- `/admin/setup`: `PageShell narrow`, `PageHeader` "Setup guide" with subtitle "Finish these
  to run your first job. Steps complete on their own." Hero `SectionCard` "Up next" with the
  step title, why, estimate, and one primary button (the deep link; label = the imperative
  title). Then three `SectionCard`s (one per phase) with rows: status glyph (done = `Check` in
  a success `IconChip`; todo = numbered neutral chip), title, why (muted 13px), right side:
  `~N min` mono and a secondary link button for todo rows, "Done · 2 Nov" for done rows.
  Optional rows carry a "Optional" `ContextBadge`. Finished state replaces the hero. Row
  entrance stagger 50 ms; width animation on the bar via `transform: scaleX` (not width).
- Home card: `SectionCard` "Setup guide" with `count` = `N of M`; body: the Up-next row as a
  primary CTA; two more rows; footer link "See all steps"; × in the action slot.
- Sidebar: `badge: 'setup'` added to the `NavItem` union; rendered like `unscheduled` (mono
  11px) but in `--marker` not warning.
- Copy canon: sentence case, "request", "technician", "sign in", Unicode …; every error
  "Couldn't … Please try again."
- Mobile (390): phase cards stack; the hero button is full width; rows wrap estimate under
  the title. Reduced motion honoured via the global rule.

## 9. Acceptance

1. Fresh org (SQL-seeded, nothing configured): `/admin/setup` shows 0 of 12, Up next = "Add
   your company name and phone"; badge "7 left"; home card shows the same Up-next CTA.
2. Save company name + phone in settings → return to `/admin/setup` without reload → step 1
   done (focus revalidation), Up next = business hours, badge "6 left".
3. `/admin/staff?new=technician&from=setup` opens the add dialog with the "back to setup"
   banner; adding a technician completes `invite_team`; refreshing the page does not reopen
   the dialog.
4. Importing from FieldPulse (or SQL-inserting customers + pricebook + requests + appointments)
   completes `pricebook`, `first_customer`, `first_request`, `first_schedule` with no clicks.
5. After the 7th required step the home card shows the finished state once; × hides it;
   `/admin/setup` keeps the finished state and lists the optional steps under "Go further";
   badge gone.
6. Deleting the only customer afterwards does not re-open `first_customer` (stamp).
7. Two concurrent GETs that each stamp a different step leave both stamps.
8. Technician sessions get 401 on both routes; another org's data never affects the steps
   (tenancy test).
9. Existing orgs on upgrade: no migration; legacy `dismissed`/`embedViewed` honoured.
10. Gates: tsc 0, eslint 0 errors, vitest baseline not lowered; pure tests for
    `deriveSteps`, `upNext`, progress, legacy-state migration, badge text; route tests for
    GET/PATCH; `verify-skills` 0 missing; `page-home` and `page-settings` skills updated and a
    new `page-setup` skill.

## 10. Risks and decisions

- "Done when" rules are deliberately lenient (EXISTS, not quality checks); the aim is momentum,
  not validation.
- Steps never un-complete (stamps). Decision: momentum over strict truth; the page says
  "Done · date".
- One SELECT with 12 EXISTS subqueries on indexed `organization_id` columns is cheap
  (sub-10 ms on dev); no caching server-side.
- Deep-link params are read once on mount; a user who lands with `?new=1` and cancels the
  dialog is not re-prompted.
- The `tech_app` signal depends on where technician sign-in happens; the plan verifies it and
  falls back to the manual tick if needed.
