---
name: page-settings
description: Use when working on the /admin/settings page — 9-tab org configuration (branding, services, business info, custom Q&A, embed/keys, limits, after-hours, dispatch, integrations) plus the super-admin-only /admin/settings/billing sub-page.
---

# Settings (/admin/settings + /admin/settings/billing)

**Purpose:** full org configuration surface. Nine tabs cover every tunable that
affects the AI chatbot's appearance, scope, and behavior, plus integration
credentials and dispatch policy.

**Files:** page `src/app/admin/(dashboard)/settings/page.tsx` (9-tab shell, `narrow`
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
  scroll fade. Do not remove it — 9 tabs overflow on small viewports.
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
