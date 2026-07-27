# Admin Redesign — Unified Design-System Refactor

**Branch:** `feat/admin-redesign` (branch from `main`)
**Date:** 2026-07-27
**Type:** Refine-and-extend (no net-new product surface; recompose existing admin onto shared primitives)
**Owner:** Design lead

---

## Goal

Bring all 29 admin dashboard pages onto **one coherent design system** by extending the two languages we already ship — the Spears admin chrome (navy grouped sidebar, elevated cards, cyan `--primary`, BrandMark) and the just-shipped auth-page language (`src/components/auth/auth-shell.tsx`: Bricolage Grotesque display font, sentence case, one cyan accent, ~2× headline-to-body scale, generous spacing).

The audits found the same defects repeated across every cluster: **four+ page-header patterns**, **six+ diverging stat-card implementations**, **three+ hand-rolled table chromes**, **four+ ad-hoc pagers**, **177 raw Tailwind palette classes** running parallel to the token system, **uppercase-tracking-widest overuse**, **Title Case copy against a sentence-case target**, and **Bricolage never reaching the dashboard** (`--font-heading` aliases `--font-sans`). This plan builds the shared foundation once, then recomposes each cluster onto it.

**This is a planning artifact.** Do NOT implement or run migrations. There are no DB/schema changes here — this is a pure presentation refactor.

---

## Architecture

Two layers, built in order:

1. **Shared foundation** (`src/app/globals.css`, `src/app/layout.tsx`, `src/components/admin/ui/*`, `src/components/ui/*`) — tokens, the display font, and ~10 canonical primitives. Nothing renders differently until pages adopt them, so the foundation ships behind the existing pages with zero visual regression risk on its own.
2. **Cluster recomposition** (`src/app/admin/(dashboard)/**`) — six page clusters, each recomposed onto the foundation. Clusters are independent and can land in any order after Foundation.

**Evolution, not reinvention.** Every primitive extends an existing one: `PageHeader`/`PageShell`/`EmptyState` already exist and are correct — we add props (`narrow`, `back`) and get pages to actually use them. `StatusBadge` and `Card` exist — we remap their color source to tokens. We delete duplicates (`stats-cards.tsx`, local badges) rather than add abstractions.

**Directory conventions (unchanged):** shared admin primitives live in `src/components/admin/ui/`; shadcn-style base primitives in `src/components/ui/`; domain components in `src/components/admin/<domain>/`.

---

## Tech Stack

- Next.js App Router (**CUSTOMIZED fork** — consult `node_modules/next/dist/docs/` before touching routing/font/layout conventions; heed deprecation notices)
- Tailwind v4, oklch design tokens in `src/app/globals.css` `@theme inline` block
- shadcn-style primitives in `src/components/ui/` (Card, Table, Badge, Select, Tabs, Tooltip, Switch, Skeleton all present)
- `next/font/google` for Bricolage Grotesque (already used locally in `auth-shell.tsx`)
- Drizzle + Neon **neon-http** — no `db.transaction()` (use `db.batch()`). Not relevant here; no DB work.
- Verification: `npx tsc --noEmit`, `npm run lint`, Playwright screenshots (`e2e/admin.spec.ts` harness — mint an `hvac_admin_session` JWT, `npm run dev`, screenshot desktop 1440px + mobile 390px). **No jsdom / RTL** in this repo — component tests are pure-helper only.

---

## Global Constraints

**Target design language (refine + extend, do NOT reinvent).** The existing Spears admin system EXTENDED with the auth-shell language:

- **Display font:** Bricolage Grotesque for all headings (`--font-heading`). Body stays Inter (`--font-sans`).
- **Sentence case for all copy.** Capitals reserved for brand names, acronyms (AI, SMS, GDPR, FieldPulse, HCP, FP), and "24/7". This includes page titles, card titles, table column headers, button labels, badge labels, filter labels, and nav labels.
- **One accent.** Cyan `--primary`, used sparingly for primary actions and active states only. All status color goes through semantic tokens (`--success`/`--warning`/`--danger`/`--info` + `-light` variants). **No raw Tailwind palette classes** (`bg-blue-100`, `text-emerald-700`, `#eab308`, etc.) in the admin layer.
- **Type-scale hierarchy:** headline ~2× body. Page title (`text-2xl`/`text-3xl` display) → card section title (~15px medium) → body (14px) → label (12px muted). No two adjacent tiers within 6px of each other.
- **Generous spacing.** Keep `PageShell`'s `space-y-7 p-6 sm:p-7` rhythm; nested sections must not collapse it.
- **`uppercase tracking-[…]` is reserved** for the BrandMark wordmark sub-label and nav-group eyebrows only (intentional micro-label treatment). Nowhere else.

**Engineering constraints:**

- Immutable/surgical edits — every changed line traces to a cited finding. Do not "improve" adjacent code. When a change orphans an import/component, remove it (e.g. deleting `stats-cards.tsx`).
- Preserve all existing data-fetch, auth-gate, and money-guard behavior. This is presentation-only.
- **Verify every task:** `npx tsc --noEmit` clean + `npm run lint` clean + Playwright screenshot **desktop (1440×900) and mobile (390×844)** of each touched page, visually confirming the acceptance criteria. Body must never scroll horizontally.
- Consult `~/.claude/design-principles.md` for the concrete numbers (spacing, timing, empty-state kinds, 60:30:10, contrast floors).

---

# TASKS

## Task group 1 — SHARED FOUNDATION

> Build/standardize the primitives the audit revealed. No page should look different from Foundation alone except where a primitive's own defaults change (fonts, token remaps) — that is the intended, reviewed shift. Land this group first; clusters depend on it.

### Task 1.1 — Tokens + display font

**Files:** `src/app/globals.css`, `src/app/layout.tsx`

**Changes:**
- **Load Bricolage Grotesque at root.** In `layout.tsx`, add `Bricolage_Grotesque({ subsets:['latin'], weight:['600','700','800'], variable:'--font-display' })` and apply `${bricolage.variable}` to `<html>` alongside `inter.className`. (Consult `node_modules/next/dist/docs/` for the fork's font conventions.)
- **Remap `--font-heading`** in the `@theme inline` block from `var(--font-sans)` → `var(--font-display)`. This single line gives every existing `font-heading` usage the display face — no component edits needed.
- **Add `--primary-deep`** (`oklch(0.62 0.13 222)`) to `:root` and expose `--color-primary-deep` in `@theme inline`. Replaces the hardcoded gradient lower-stop duplicated in BrandMark / OnboardingChecklist / auth-shell.
- **Add `--background-admin`** (`oklch(0.97 0.006 240)`) to `:root` + dark override; expose `--color-background-admin`. Replace the hardcoded `bg-[oklch(0.97_0.006_240)]` in `dashboard-shell.tsx` with `bg-background-admin`.
- **Add `--info` / `--info-light` / `--info-foreground`** using system cyan at lower chroma (`--info: oklch(0.62 0.10 222)`, `--info-light: oklch(0.95 0.03 220)`); expose in `@theme inline`. Backs the InfoBanner + integration/sync surfaces.
- **Fix `--hvac-accent`:** it currently equals `--foreground` exactly. Keep the value but document it as the deliberate navy accent (rename intent in comment), and **delete `--hvac-accent-light` and `--hvac-primary-light`** (zero admin usage) plus their `@theme inline` lines. Fix `--chart-2` semantics later is out of scope; leave chart tokens.

**Resolves:** foundation items (primary-deep, background-admin, hvac-accent dead tokens, info token); chrome "Bricolage never loaded"; per-cluster "`--font-heading` aliases `--font-sans`" (reports/insights/operations/billing/accounting).

**Acceptance:**
- `font-heading` renders Bricolage on a dashboard page (verify visually — page title weight/shape differs from body).
- `--primary-deep`, `--background-admin`, `--info*` resolve in devtools; `--hvac-accent-light`/`--hvac-primary-light` gone with no build error.
- No page layout shift beyond the intended heading font change.

**verify:** `npx tsc --noEmit` + `npm run lint` + Playwright screenshot desktop+mobile of `/admin` (confirm heading font changed, no h-scroll).

---

### Task 1.2 — PageShell/PageHeader variants + AdminHeader title

**Files:** `src/components/admin/ui/page-shell.tsx`, `src/components/admin/ui/page-header.tsx`, `src/components/admin/admin-header.tsx`

**Changes:**
- `PageShell`: add `narrow?: boolean` (caps `max-w-3xl` for settings/billing/accounting single-panel pages) and `fullHeight?: boolean` (drops `max-w`/vertical padding for the map, still renders children; header strip supplied by the page). Default behavior unchanged.
- `PageHeader`: add optional `back?: { href: string; label?: string }` — renders an `ArrowLeft` ghost link before the title in the same flex row. Kills the bespoke back-header in `customers/[id]`, `invoices/[id]`, `estimates/[id]`. Keep title as `font-heading text-2xl font-bold tracking-tight` (now Bricolage). Actions slot unchanged.
- `AdminHeader` (mobile topbar): add optional `title?: string` prop; render it between the hamburger and BrandMark so inner pages show location context when the sidebar is closed. Thread it through `DashboardShell` (derive from pathname or accept per-page — pass via a lightweight context or prop; simplest: derive from `usePathname()` against `NAV_GROUPS`).

**Resolves:** shared "PageShell narrow", "AdminPageHeader back-chevron", "PageShell FullHeight"; chrome "AdminHeader has no page title slot".

**Acceptance:** `<PageShell narrow>` caps at 48rem; `<PageHeader back={{href}}>` shows a working back link; mobile topbar shows current page name.

**verify:** `npx tsc --noEmit` + `npm run lint` + Playwright screenshot desktop+mobile of `/admin/requests` (header unchanged) and `/admin/customers/[id]` after 3.x migration.

---

### Task 1.3 — StatCard, SectionCard, SectionHeading primitives

**Files (new):** `src/components/admin/ui/stat-card.tsx`, `src/components/admin/ui/section-card.tsx`, `src/components/admin/ui/section-heading.tsx`, `src/components/admin/ui/icon-chip.tsx`
**Files (delete):** `src/components/admin/stats-cards.tsx` (dead once dashboard migrates)

**Changes:**
- **`IconChip`** — `<IconChip intent="primary|success|warning|danger|info|neutral">` mapping to `--primary/10`, `--success-light`, `--warning-light`, `--danger-light`, `--info-light`, `--muted`. Replaces ~30 `bg-green-100 dark:bg-green-900/30` ad-hoc chip patterns.
- **`StatCard`** (unified `MetricTile`/`KpiTile`/`KpiCard`) — one component, `size="sm"|"lg"`, props `{ icon, label (sentence case), value, sublabel?, delta?, intent?, loading? }`. Value uses `font-heading` + `tabular-nums` at 2× body (`text-3xl` lg / `text-2xl` sm). Icon rendered through `IconChip`. Skeleton matches loaded shape. Replaces the six diverging implementations: `stats-cards.tsx`, `dashboard-stat-cards.tsx`, reports `KpiCard`, operations `KpiCard`, insights inline cards, `ops-insights-section` `StatCard`.
- **`SectionCard`** — thin wrapper over `Card`+`CardHeader`+`CardContent`: props `{ title, icon?, count?, action?, children }`, `border-b` divider between header and body, sentence-case title at ~15px medium. Replaces per-page card-header rows across reviews/reports/integrations/insights and the 6 detail-page section cards.
- **`SectionHeading`** — card-level h2/h3: sentence-case ~14–15px medium title + optional 12px muted descriptor + right slot. Replaces the `text-xs font-semibold uppercase tracking-wide text-muted-foreground` heading pattern (integrations, fieldpulse-import, dispatch exceptions, reports subheads) and unifies the 3 CardSectionHeading variants.

**Resolves:** foundation "MetricTile"; shared "KpiTile"/"KpiCard (unified)"/"SectionCard"/"SectionHeader"/"IconChip"; dashboard/reports/insights/operations stat-card + uppercase-label findings; chrome "177 raw palette classes" (stat-card share).

**Acceptance:** all four primitives typecheck and render; `StatCard` value visibly ~2× its label; no raw Tailwind hue class inside any of them; `stats-cards.tsx` deleted with no dangling import.

**verify:** `npx tsc --noEmit` + `npm run lint` + Playwright screenshot desktop+mobile of a throwaway harness page mounting one of each (or defer visual to first consuming cluster).

---

### Task 1.4 — DataTableShell, Pager, SegmentedControl, TabGroup, Textarea

**Files (new):** `src/components/admin/ui/data-table-shell.tsx`, `src/components/admin/ui/pager.tsx`, `src/components/ui/segmented-control.tsx`, `src/components/admin/ui/tab-group.tsx`, `src/components/ui/textarea.tsx`

**Changes:**
- **`DataTableShell`** — wraps `Card` + `overflow-x-auto` + shadcn `Table`. Slots: `toolbar`, `children` (rows), `footer` (pager). Enforces one column-header treatment: sentence case, ~11–12px, `text-muted-foreground`, **no uppercase/tracking**. Absorbs the money-cluster "MoneyTable" need. Targets ~200 lines removed across requests/staff/pricebook/inventory/invoices/estimates/customers/reports/audit-log.
- **`Pager`** — stateless `{ page, totalPages, total?, perPage?, onPageChange, showFirstLast? }`. ChevronLeft/Right Lucide icons (no ASCII arrows), 44px min touch targets, centered "Showing X–Y of Z" label. Replaces the 6+ ad-hoc pagers (requests, conversations, customers, reviews, invoices, estimates, pricebook, inventory, audit-log).
- **`SegmentedControl`** — `{ options, value, onChange, optionBadge? }`, active = `bg-foreground text-background`. Replaces the 3-per-page hand-rolled pill/underline/native filters in invoices/estimates/pricebook. **Decision: pill control is canonical** for data-workspace filters (estimates' underline tabs converge onto this).
- **`TabGroup`** — accessible wrapper adding `role="tablist"`/`role="tab"`/`aria-selected` + arrow-key nav around the existing Button-based visual (no visual change). For calendar view toggle + conversation channel tabs + settings tabs.
- **`Textarea`** — shadcn primitive matching `Input`'s focus-ring/border/sizing. Replaces 5+ hand-copied `<textarea>` class strings (settings panels, template editor).

**Resolves:** foundation "DataTableShell"; shared "Pager"/"FilterBar"/"SegmentedControl"/"TabGroup"/"MoneyTable"/"Textarea"; chrome nested-tooltip (context reuse via single provider in shell, addressed in 1.5).

**Acceptance:** each primitive typechecks; `Pager` renders icons + 44px targets; `TabGroup` announces tabs with arrow-key switching; `Textarea` visually matches `Input`.

**verify:** `npx tsc --noEmit` + `npm run lint` + Playwright screenshot (defer visual to first consuming cluster; smoke-mount in harness).

---

### Task 1.5 — StatusBadge token remap + shared badges + chrome fixes

**Files:** `src/components/admin/status-badge.tsx`, `src/components/admin/urgency-badge.tsx`, `src/components/admin/sidebar.tsx`, `src/components/admin/brand-mark.tsx`, `src/components/admin/dashboard-shell.tsx`, `src/components/admin/nav-items.ts`
**Files (new):** `src/components/admin/ui/context-badge.tsx`, `src/lib/admin/status-colors.ts`

**Changes:**
- **Remap `StatusBadge`** — replace `bg-yellow-100 text-yellow-700` etc. with semantic tokens (`bg-warning-light text-warning-foreground`, `bg-success-light text-success-foreground`, `bg-danger-light text-danger`, `bg-info-light text-info`, `bg-muted text-muted-foreground`). Gets dark-mode for free. Same map exported from `status-colors.ts` for the inline-style dot callers (booking-history, people-cards) as token classes, killing the `#eab308` inline styles.
- **`ContextBadge`** — single source for the scattered `Auto` (info), `After-hrs` (warning), `queued outcome` chips currently hand-rolled in `dispatch-column`, `dispatch/page`, `request-table`, `dashboard-list-card`.
- **BrandMark:** subtitle → sentence case "Service console" (currently "SERVICE CONSOLE" via uppercase CSS), matching the auth-shell convention. Keep the uppercase-CSS eyebrow treatment on nav-group headings only.
- **nav-items:** split the 13-item **Workspace** group into **Workspace** (Staff, Pricebook, Inventory, Membership plans) and **Money** (Estimates, Invoices, Accounting, Reports, Operations); move Reviews→Customers, Chatbot Settings→its own or Integrations, Communications→Customers, Audit Log→Integrations (final placement: keep each group 4–5 items). Sentence-case all labels ("Membership Plans"→"Membership plans", "AI Insights" keeps "AI", "FP Import"→"FP import").
- **Sidebar chrome:** (a) inactive nav icon `text-white/70`→`text-white/80` (contrast margin); (b) collapsed rail: add a 28px initials chip at the bottom with a tooltip so identity is always visible; (c) consolidate the two nested `TooltipProvider`s into one wrapping the aside interior.
- **DashboardShell:** move `GlobalSearch` inside `main` (or portal to body root) so its overlay/backdrop isn't clipped by the `overflow-hidden` column.

**Resolves:** foundation StatusBadge/UrgencyBadge token map, BrandMark sentence case, Workspace split; all 5 sidebar/header chrome issues; shared "ContextBadge", "status-colors map", "Design-token Badge variants".

**Acceptance:** no raw Tailwind hue class in status/urgency/context badges; sidebar shows initials chip when collapsed; nav has two ≤5-item groups replacing Workspace; single TooltipProvider; GlobalSearch overlay not clipped; inactive icons pass ≥3.5:1.

**verify:** `npx tsc --noEmit` + `npm run lint` + Playwright screenshot desktop (expanded + collapsed sidebar) + mobile of `/admin` (confirm nav groups, initials chip, sentence-case "Service console").

---

## Task group 2 — CLUSTER RECOMPOSITION

> Each task recomposes one cluster onto the Task-1 primitives. Independent; any order after Foundation. Every task: migrate to PageShell/PageHeader, swap stat/table/pager/badge duplicates for primitives, delete orphaned local components, sentence-case all copy.

### Task 2.1 — Ops cluster: dashboard, requests, dispatch, calendar, conversations, technicians

**Files:** `src/app/admin/(dashboard)/page.tsx`, `requests/page.tsx`, `dispatch/page.tsx`, `calendar/page.tsx`, `conversations/page.tsx`, `technicians/page.tsx`; `src/components/admin/dashboard/*` (greeting, dashboard-stat-cards, dashboard-list-card, recent-conversations-card), `request-filters.tsx`, `request-table.tsx`, `dispatch/dispatch-column.tsx`, `conversations/conversation-inbox.tsx`; new `src/components/admin/ui/urgency-legend.tsx`; Alert `warning` variant in `src/components/ui/alert.tsx`.

**Changes:**
- Dashboard: replace inline `div.mx-auto.max-w-[1280px]…` with `PageShell`; greeting uses `PageHeader` (Bricolage title now real); swap `DashboardStatCards` → `StatCard` grid via `IconChip`; `DashboardListCard`/`RecentConversationsCard` empty states → `EmptyState`; greeting CTA "New request"→"View requests"; delete `stats-cards.tsx` usage.
- Requests: remove the redundant `<StatsCards/>` KPI bar (dupes dashboard; header already shows total); `RequestFilters` → one control paradigm via `SegmentedControl` (status) + Selects, `FilterBar` grouping; "After Hours"→"After hours" as a `Switch`; pager → `Pager`; table headers sentence case ("Assigned To"→"Assigned to", "Date"→"Submitted"); `request-table` After-hrs chip → `ContextBadge`; table onto `DataTableShell`.
- Dispatch: `PageShell`+`PageHeader`; 3 ad-hoc badges → `ContextBadge`; exceptions heading → `SectionHeading`; empty states → `EmptyState`; fix `.replace('_',' ')` non-global bug via label map; extract `UrgencyLegend` and render it.
- Calendar: `PageShell`+`PageHeader`; view toggle → `TabGroup`; warning Alert → `variant="warning"`; extract/consume `UrgencyLegend`; hide "Today" button when already today (or tooltip).
- Conversations: add visible/`sr-only` `h1` landmark; channel tabs → `TabGroup`; pager footer → `Pager` (44px targets); "Status" placeholder → "All statuses"; needs-action dot → labelled `ContextBadge`.
- Technicians: `PageShell`+`PageHeader`, sentence-case copy, any stat/table onto primitives.

**Resolves:** entire ops-cluster audit (dashboard 8, requests 5, dispatch 5, calendar 5, conversations 6 findings) + shared ops needs.

**Acceptance:** all 6 pages use PageShell/PageHeader; zero raw hue classes; one pager/badge/tab implementation; conversations has a heading landmark; sentence-case throughout.

**verify:** `npx tsc --noEmit` + `npm run lint` + Playwright screenshot desktop+mobile of all six pages.

---

### Task 2.2 — Customers cluster: list, detail, and detail subcomponents

**Files:** `customers/page.tsx`, `customers/[id]/page.tsx`, `customers/loading.tsx`; `src/components/admin/customers/*` (customer-drawer, people-cards, booking-history-list, bookings-section), `src/components/admin/memberships/customer-membership-card.tsx`; new `src/components/admin/ui/section-list-item.tsx`.

**Changes:**
- List: filter toolbar grouped via `FilterBar` (content filters separated from view-toggle); "FP synced only"→"Synced from FieldPulse" + aria-label; pager → `Pager` with "Page X of Y"; residential/commercial icon fix (User vs Building2) + `aria-hidden`; list-view stat glyphs get text labels; `document.title` → Next metadata.
- Detail: header → `PageHeader back={{href:'/admin/customers'}}`; move Archive/Delete/Erase(GDPR) into a `MoreActions` dropdown / DangerZone (out of the primary row); type + tax-exempt badges → token-based `StatusBadge`; section cards → `SectionCard`; the 4 repeated `rounded-lg border p-3` rows → `SectionListItem`; contact-card icon Building2→User; warranty expiring-soon → `warning` variant; `loading.tsx` + inline detail skeleton rebuilt to mirror real card layout (kill layout shift); `aria-labelledby` on section regions.
- Subcomponents: drawer "Booking history" heading loses `uppercase tracking-wide`; booking-history + people-cards dots → `status-colors.ts` token classes; membership card green badge → `--success` token; people-cards `aria-pressed`→`aria-current`/`aria-expanded`.

**Resolves:** customers-cluster audit (list 9, detail 8, subcomponents 5 findings) + its shared needs (SectionListItem, SectionCard, status-colors, DangerZone, Pager, token badges).

**Acceptance:** one header pattern (list + detail); destructive actions not in primary row; skeleton matches loaded shape; no inline hex-color dots; sentence-case; no raw hue classes.

**verify:** `npx tsc --noEmit` + `npm run lint` + Playwright screenshot desktop+mobile of list, detail, and a filtered list.

---

### Task 2.3 — Money cluster: invoices, estimates, pricebook, accounting, billing

**Files:** `invoices/page.tsx`, `invoices/[id]/page.tsx`, `estimates/page.tsx`, `estimates/[id]/page.tsx`, `pricebook/page.tsx`, `accounting/page.tsx`, `settings/billing/page.tsx`; `src/components/admin/invoices/*` (summary-band, invoice-detail-client, invoice-document, invoice-collections-side), `src/components/admin/pricebook/*` (pricebook-table, tax-rates-panel), `src/components/admin/accounting/accounting-export-panel.tsx`, `src/components/admin/settings/billing-panel.tsx`; new `src/components/admin/ui/info-banner.tsx`, `src/components/admin/ui/error-state.tsx`.

**Changes:**
- Lists: all tables → `DataTableShell` (sentence-case headers, kill `uppercase tracking-widest text-[10.5px]` + `bg-foreground` header fills + CSS-grid header); `SummaryBand`/`KpiBand` → `StatCard` grid; all segmented filters → `SegmentedControl`; all pagers → `Pager`; native `<select>` → shadcn `Select`; estimates empty state → `EmptyState`; `FPS_PILL_STYLES`/`NATIVE_PILL_STYLES`/`InvoiceStateBadge`/pricebook `TypeBadge` → token `StatusBadge`; estimates ⚠ emoji → `AlertTriangle`; flash toast success icon → `CheckCircle`.
- Detail pages: `invoice-detail-client`/`estimate-detail` use `PageShell`+`PageHeader back` (real visible h1, not sr-only); synced-source violet banner → `InfoBanner` (`--info`); margin readout → single-level `SectionCard` (no triple-nest, no uppercase label); error path → `ErrorState`; loading skeleton mirrors real layout; label-mutation button feedback → shared toast; `invoice-document` uses document-appropriate hairline/sentence-case table (not data-table chrome); `invoice-collections-side` uses `Card`.
- Settings-ish: accounting + billing use `<PageShell narrow>` + `PageHeader` (kills the 3 divergent max-widths); date inputs → shadcn `Input type=date`; billing plan rows → `Card`/`PlanCard`; entitlements → checklist with `CheckCircle` (not comma-join); org status badge → token `StatusBadge`.
- Copy pass: "Add Item"→"Add item", "Tax Rates"→"Tax rates", "Add Rate"→"Add rate", "Saving..."→"Saving…", subtitle slang → professional register.

**Resolves:** money-cluster audit (invoices list 10, invoice detail 6, estimates 5, estimate detail 4, pricebook 4, accounting 3, billing 4 findings) + all shared money needs.

**Acceptance:** one table/pager/segmented/select/badge implementation across the cluster; detail pages have visible h1; `--info` banner replaces violet; narrow settings pages share one width; sentence-case; no raw hue/native-select.

**verify:** `npx tsc --noEmit` + `npm run lint` + Playwright screenshot desktop+mobile of invoices list, invoice detail, estimates list, estimate detail, pricebook, accounting, billing.

---

### Task 2.4 — Analytics cluster: reports, insights, operations, audit-log, map, inventory

**Files:** `reports/page.tsx`, `insights/page.tsx`, `operations/page.tsx`, `audit-log/page.tsx`, `map/page.tsx`, `inventory/page.tsx`; `src/components/admin/insights/bot-analytics-section.tsx`, `ops-insights-section.tsx`; `src/components/admin/inventory/*` (inventory-table, purchase-orders-panel); new `src/components/admin/ui/progress-bar.tsx`.

**Changes:**
- Reports/insights/operations: all KPI cards → unified `StatCard` (sentence-case labels — kill operations' uppercase labels and reports' mixed-case); hand-rolled tables (LeadSource/Location/Technician) → `DataTableShell`; card subheads → `SectionHeading` (subordinate to page title); IconChips → semantic `IconChip`; insights sub-section spacing synced to shell rhythm (don't collapse `space-y-7`); insights heading levels get a real H1→H2→H3 scale; hero cards get form-based emphasis (bigger padding/tint), not size-only; empty states → `EmptyState`; feedback thumbs get aria-labels; jargon copy softened ("Deterministic vs LLM"→"Instant vs AI replies", "Native invoices only"→"Your invoices only"); operations AR grid restructured (no orphan full-width card); disclose window mismatches on dispatch-health/bot-analytics cards.
- Audit-log: `PageShell`+`PageHeader` (kill `p-6 space-y-6` + Title-Case "Audit Log"); custom CSS-grid → `DataTableShell` (`<th scope>` semantics, horizontal scroll); `humanize()` → sentence case; filter toolbar gets a surface + "Clear filters"; entry count always shown.
- Map: `<PageShell fullHeight>` + slim `PageHeader` (text-2xl, not text-xl); map-shaped skeleton with explicit height (replace bare "Loading map…"); always-visible layer legend/toggle strip; subtitle acknowledges opt-in tech location.
- Inventory: native `<select>` → shadcn `Select`; empty states → `EmptyState` with CTA; "Purchase Orders"→"Purchase orders", "Track Material"→"Track material"; low-stock row + badge both → `--warning` token (resolve amber-bg/red-badge mismatch); pager → `Pager`; PO panel gets `SectionHeading` divider.
- AR aging bars → `ProgressBar` (`role=progressbar`, aria-value*, `--success`/`--warning`/`--danger` tokens, dark-mode-safe).

**Resolves:** analytics-cluster audit (reports 7, insights 7, operations 7, audit-log 6, map 4, inventory 6 findings) + shared needs (KpiCard, DataTable, Pager, ProgressBar, SectionHeader, IconChip, FullHeight PageShell).

**Acceptance:** one KPI/table/pager across cluster; audit-log is a real table with th semantics; map has a shaped skeleton + legend; inventory semantics coherent; sentence-case; no raw hue classes; progress bars accessible.

**verify:** `npx tsc --noEmit` + `npm run lint` + Playwright screenshot desktop+mobile of all six pages.

---

### Task 2.5 — Config cluster: settings, staff, integrations, fieldpulse-import, membership-plans, platform

**Files:** `settings/page.tsx`, `staff/page.tsx`, `integrations/page.tsx`, `fieldpulse-import/page.tsx`, `membership-plans/page.tsx`, `platform/page.tsx`; `src/components/admin/settings/*` (branding/business-info/custom-faqs/ai-model/conversation-limits panels), `staff-table.tsx`, `pending-invites.tsx`, `src/components/admin/memberships/membership-plans-table.tsx`, `src/components/admin/platform/platform-console.tsx`; new `src/lib/admin/integration-meta.ts`, `src/components/admin/ui/section-divider.tsx`, `src/components/admin/ui/skeleton-table.tsx`.

**Changes:**
- Settings: `PageShell`+`PageHeader` (title "Settings", "Chatbot configuration" as subtitle/section); 9-item tab bar → `TabGroup` with edge-fade + horizontal scroll (no hidden tabs); resolve the Settings-Integrations vs standalone `/integrations` duplication (make the sub-tab link to the page or share one component); all raw `<textarea>` → `Textarea`.
- Staff: `RoleBadge` hues → token map (super_admin→`--hvac-accent`, admin→`--primary`, technician→`--muted`); empty state → `EmptyState` with "Invite your first teammate"; "Reset"→"Reset password"; tooltips distinguishing Invite vs Add staff; `SectionDivider` above `PendingInvites`; `SkeletonTable` loading.
- Integrations: `PageShell`+`PageHeader`; category headings → `SectionHeading` (kill widest tracking); per-service icons via `integration-meta.ts` registry (Google Calendar→Calendar, FieldPulse→Zap, HCP→Wrench, Stripe→CreditCard, Twilio→Phone) with `IconChip` tint (kill generic Plug on slate); status badges → token `StatusBadge` (live/connected→success, mock/not_configured→warning, error→danger); skeleton matches card shape; empty state when a category filters to zero.
- FieldPulse-import: phase cards → `Card`; `SectionHeading` for "Recent runs"/phase labels (kill flat uppercase hierarchy); elapsed timer gets `aria-live`; tallies get subtle health coloring; `SkeletonTable` where applicable.
- Membership-plans: "Add Plan"→"Add plan"; "(inactive)" inline text → `Badge` slot; empty state → `EmptyState` with CTA + onboarding copy.
- Platform: `PageShell`+`PageHeader` (kill max-w-4xl third width); Purge → ghost trigger opening a danger-marked confirm (not a primary destructive row button); org status badge → token `StatusBadge` (suspended→danger, trial→warning, capitalized); loading → `SkeletonTable` (4-col) + retry on error.

**Resolves:** config-cluster audit (settings 5, billing echoes 2.3, staff 4, integrations 4, fieldpulse-import 4, membership-plans 3, platform 4 findings) + shared config needs (Textarea, StatusBadge, PageShell narrow, SectionHeading, EmptyState, integration registry, role map, SkeletonTable, SectionDivider).

**Acceptance:** all pages use PageShell/PageHeader; settings tabs fully reachable; integrations show distinct per-service icons + token status; destructive platform actions gated; one skeleton/badge/divider pattern; sentence-case; no raw hue classes.

**verify:** `npx tsc --noEmit` + `npm run lint` + Playwright screenshot desktop+mobile of settings, staff, integrations, fieldpulse-import, membership-plans, platform.

---

## Task group 3 — SWEEP + SIGN-OFF

### Task 3.1 — Copy + palette sweep and final verification

**Changes:** Grep the admin layer for residual raw Tailwind palette classes (`bg-(blue|green|amber|yellow|sky|purple|emerald|rose|slate|violet|indigo|orange)-[0-9]`), inline hex in `style=`, `uppercase tracking-`, and Title-Case button/label copy; fix any stragglers onto tokens/primitives/sentence-case. Confirm no page scrolls horizontally at 390px. Full-suite `tsc`+`lint`; Playwright screenshot pass over all 29 pages desktop+mobile.

**Acceptance:** grep for raw hue classes in `src/app/admin` + `src/components/admin` returns only intentional brand-gradient stops; zero `uppercase tracking-` outside BrandMark eyebrow + nav-group headings; `tsc`/`lint` clean; all screenshots match the target language.

**verify:** `npx tsc --noEmit` + `npm run lint` + `npm run test` (pure-helper suites) + Playwright screenshot sweep desktop+mobile.

---

## Notes / risks

- **Font load cost:** Bricolage at root adds one font family site-wide. Acceptable — it's already loaded on auth; weights limited to 600/700/800.
- **Nav re-grouping** changes muscle memory; keep it to the 4→2-group split the audit prescribes, don't reshuffle beyond that.
- **No jsdom/RTL** — primitives get pure-helper unit tests only (e.g. label maps, status→token functions); visual correctness is verified by Playwright screenshots.
- **Ordering:** Task group 1 must land before any 2.x. Within 2.x, order by blast radius (2.1 dashboard first for the most-seen surface).
