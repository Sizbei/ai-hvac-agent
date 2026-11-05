---
name: page-settings
description: Use when working on the /admin/settings page — 11-tab org configuration (branding, services, business info, custom Q&A, embed/keys, limits, after-hours, dispatch, integrations, job types, tags) plus the super-admin-only /admin/settings/billing sub-page.
---

# Settings (/admin/settings + /admin/settings/billing)

**Purpose:** full org configuration surface. Eleven tabs (branding, services, business info, custom Q&A, embed/keys, limits, after-hours, dispatch, integrations, job types, tags) cover every tunable that
affects the AI chatbot's appearance, scope, and behavior, plus integration
credentials and dispatch policy.

**Files:** page `src/app/admin/(dashboard)/settings/page.tsx` (11-tab shell, `narrow`
layout) · billing sub-page `src/app/admin/(dashboard)/settings/billing/page.tsx`
(server component, access-gated) · hook `src/hooks/use-org-settings.ts` · panels
`src/components/admin/settings/branding-panel.tsx` ·
`src/components/admin/settings/services-panel.tsx` ·
`src/components/admin/settings/business-info-panel.tsx` ·
`src/components/admin/settings/custom-faqs-panel.tsx` ·
`src/components/admin/settings/embed-panel.tsx` ·
`src/components/admin/settings/conversation-limits-panel.tsx` ·
`src/components/admin/settings/after-hours-panel.tsx` ·
`src/components/admin/settings/dispatch-panel.tsx` ·
`src/components/admin/settings/google-calendar-panel.tsx` ·
`src/components/admin/settings/housecall-pro-panel.tsx` ·
`src/components/admin/settings/fieldpulse-panel.tsx` ·
`src/components/admin/settings/ai-model-panel.tsx` ·
`src/components/admin/settings/billing-link-panel.tsx` ·
`src/components/admin/settings/platform-link-panel.tsx` · APIs
`src/app/api/admin/settings/route.ts` ·
`src/app/api/admin/settings/faqs/route.ts` · integration credential APIs
`src/app/api/admin/integrations/fieldpulse/connect/route.ts`,
`.../fieldpulse/disconnect/route.ts`, `.../google/connect/route.ts`,
`.../google/route.ts` (DELETE), `.../housecall/connect/route.ts`,
`.../housecall/disconnect/route.ts`

**Job types + Tags tabs (M0b):** the page also hosts two config tabs, selected
by `?tab=job-types` / `?tab=tags` (the shell reads `useSearchParams().get('tab')`,
default `branding`). Panels `src/components/admin/settings/job-types-panel.tsx`
and `.../tags-panel.tsx`; types/schemas `src/lib/admin/job-type-types.ts`,
`tag-types.ts`; queries `job-type-queries.ts`, `tag-queries.ts`.
- `GET/POST /api/admin/settings/job-types` (`?active=1` filters to active) and
  `PATCH .../job-types/[id]`. A job type = name, `kind` (the canonical
  `job_type` enum value, which stays canonical), `defaultDurationMinutes`
  (15-1440), `defaultPriority`, `active`, `position`. Nine rows are seeded per
  org (migration 0047 + `provisioning.ts`; defaults in `DEFAULT_JOB_TYPES`).
- `GET/POST /api/admin/settings/tags` (`?entity=customer|location|job&active=1`)
  and `PATCH .../tags/[id]`. A tag type = entity, name (≤40), `color` token
  (graphite/marker/danger/success/warning/info), `visibleOnBoard` (job tags
  only meaningfully: shows on dispatch cards), `active`. `entity` is immutable
  after create (not in the patch schema). Tag types are deactivated, not deleted.
- `GET/PUT /api/admin/tags/[entity]/[id]` reads/replaces the tags on one
  customer/location/job; unknown entity or tag id -> 400 `UNKNOWN_TAG`, missing
  target row -> 404.

**Tabs:** ids live in `src/lib/admin/settings-tabs.ts` (`resolveSettingsTab`,
`settingsTabSearch`). Switching tabs rewrites `?tab=` with
`history.replaceState` (other params such as `from=setup` kept); the setup
banner keys off the tab the page OPENED on (captured once). The config-form
tabs (branding, services, business, faqs, embed, limits, after-hours,
dispatch) use `keepMounted`, so an unsaved draft survives a tab switch; the
fetch-on-mount tabs (job types, tags, integrations) don't.

**Saves:** the PATCH replaces nested objects wholesale. Business info builds
its object with `mergeBusinessInfo` (`src/lib/admin/business-info-merge.ts`)
so keys the panel doesn't edit (and the contact email, which it now edits)
survive. A VALIDATION_ERROR carries `details.path`; the UI shows
`settingsSaveErrorMessage` / `settingsFieldErrorCopy`
(`src/lib/admin/settings-errors.ts`), never zod text. After-hours uses hour
and timezone selects (`src/lib/admin/after-hours-options.ts`).

**Embed snippet:** keys are stored hashed, so `buildEmbedSnippet`
(`src/lib/admin/embed-snippet.ts`) fills in only a key created on this page
in this visit; otherwise it shows `YOUR_PUBLISHABLE_KEY` and hides Copy.
Never put the `keyPrefix…` display string in a snippet.

**FSM panels vs /admin/integrations:** both must agree. An org served by the
server env key (only the single-tenant org, see
`src/lib/integrations/env-fallback.ts`) reads `configured && !connected`;
`fsmConnectionView` (`src/lib/admin/fsm-connection-view.ts`) turns that into
"Connected … account key set up on the server", matching the overview's
detail. The FieldPulse status route also returns `syncFailed` (same rule as
the overview's "Sync failed" badge).

**Data flow:** `useOrgSettings` fetches `/api/admin/settings` and
`/api/admin/settings/faqs` in parallel on mount, then provides typed save/CRUD
helpers. Each panel receives `config` + `onSave`; saves are per-panel (not a
single global form). FAQs use separate create/update/delete helpers.

**Invariants:**
- The `integrations` tab hosts several self-hiding panels: `AiModelPanel` renders
  null on 403 (super_admin only); `BillingLinkPanel` renders null on 403
  (super_admin/platform-admin only); `PlatformLinkPanel` renders null on 403
  (platform-admin only). Never add a role check in the page — panels self-gate.
- `settings/billing` is a server component; it calls `getAdminSession` + checks
  `isSuperAdmin || isPlatformAdmin` and redirects to `/admin/settings` on failure.
- Google Calendar / Housecall Pro / FieldPulse credential connect AND
  disconnect routes are ALL `isSuperAdmin`-gated (not just `getAdminSession`)
  — a regular admin overwriting or clearing the org's external CRM/calendar
  credential is the same tier of destructive as the AI-model and billing
  panels, which were already super_admin-only. GET/status reads stay
  admin-session-gated; only the mutating connect/disconnect calls require
  super_admin.
- Tab overflow: `[mask-image:linear-gradient(…)]` on `TabsList` provides a soft
  scroll fade. Do not remove it — 11 tabs overflow on small viewports.
- Page uses `<PageShell narrow>` — narrower max-width than standard pages.

**Gotchas:**
- `useOrgSettings` fetches both settings and FAQs on mount regardless of which tab
  is active — FAQs are loaded eagerly.
- After-hours panel controls bot disclosure behavior; changes go live immediately
  for the next chat session.
- Unlike `AiModelPanel`/`BillingLinkPanel`/`PlatformLinkPanel`, the FieldPulse/
  Google Calendar/Housecall Pro panels do NOT self-hide for a non-super_admin
  — they render normally and the connect/disconnect action 403s at submit time.
  If adding self-hiding to these panels, it needs a real GET-based capability
  check, not a copy of the other panels' pattern verbatim.

**Verify changes:** `npx vitest run src/app/api/admin/integrations/fieldpulse
src/app/api/admin/integrations/google src/app/api/admin/integrations/housecall`
· visual via the admin-pages recipe at `/admin/settings` · check each tab
renders without console errors.

**Setup guide:** `?tab=…&from=setup` shows a `BackToGuideBanner` on the branding,
business and embed tabs. The page wraps those panels' `onSave` (`saveFromSetup`):
a successful save on the banner's own tab sets the banner to "Done" and calls
`refreshOnboarding({ force: true })`. The embed panel also PATCHes
`flags.embedCopied` when a revealed publishable key is copied. See page-setup.
