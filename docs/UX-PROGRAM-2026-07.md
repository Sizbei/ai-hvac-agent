# UX polish program — 10 feelable rounds (2026-07)

This program turns a 30-item UX audit into **10 coherent, shippable rounds**. Every
round is one change a user literally *feels* — faster, fewer steps, or visibly better —
never an invisible refactor. Rounds are ordered so shared foundations land first
(route-level loading, transition/motion primitives, a stale-while-revalidate cache
pattern), then page-level polish builds on them, and the most visible flourishes
(customer-facing chat + portal + homepage) come last so the program escalates.

**Ground rules carried through every round**
- oklch tokens + `--hvac-accent`; navy grouped admin sidebar; Bricolage display font on
  marketing/auth; one cyan accent. Sentence case for all UI copy.
- Motion is GPU-only (transform/opacity), ease-out, under 300ms, respects
  `prefers-reduced-motion`, and never fires on keyboard-driven actions.
- Do not touch FROZEN safety text in `src/lib/ai`. No RTL/jsdom tests (pure-helper vitest only).
- Verify each round: `npx tsc --noEmit` (0), `npx eslint <changed>` (0), related vitest,
  and Playwright screenshots for anything visible.

## The 10 rounds

| # | Round | Category | Feel |
|---|-------|----------|------|
| 1 | Route-level loading skeletons | perf | Admin pages show a shape-matched skeleton the instant you click, never a blank white area. |
| 2 | Motion + transition primitives | visual | Hover, sidebar collapse, and row-expand feel smooth and honor "reduce motion" everywhere. |
| 3 | Stale-while-revalidate list hooks | perf | Filtering or paging Requests and Conversations keeps the old rows visible while new data loads. |
| 4 | Stale-while-revalidate KPI hooks | perf | Switching date presets on Reports/Operations keeps the previous numbers painted, not blanked. |
| 5 | Shape-matched loading skeletons | visual | Dispatch, estimates, and tech job lists fade from a skeleton that matches the real layout. |
| 6 | Layout-consistency + heading pass | visual | Insights, Operations, Reports, and Staff cap at 1280px and use the same bold headings as every other page. |
| 7 | Keyboard-first admin | qol | `/` focuses search, arrow keys walk the inbox, and ⌘K opens as a launcher — hands stay on the keyboard. |
| 8 | Consistent confirms, empty states, and toasts | qol | Deactivate uses the branded dialog, empty tables offer a next step, and reminders toast without shoving the page. |
| 9 | Customer chat feels alive | qol | The chat box grows as you type, the progress stepper never overflows, and you can fix a misread field inline. |
| 10 | Public surfaces on-brand + fast | visual | The homepage loads from edge cache with a working mobile menu, and the portal matches the Spears design system. |

---

## Round 1 — Route-level loading skeletons

**Category:** perf · **Complexity:** low

**Feel:** Navigating to Customers, Requests, Dispatch, or Invoices shows a shape-matched
skeleton the instant you click the link, instead of a blank white content area until the
client component's first fetch resolves.

**Files**
- `src/app/admin/(dashboard)/requests/loading.tsx` (new)
- `src/app/admin/(dashboard)/customers/loading.tsx` (new)
- `src/app/admin/(dashboard)/dispatch/loading.tsx` (new)
- `src/app/admin/(dashboard)/invoices/loading.tsx` (new)

**Why first:** These are the App Router Suspense foundation the rest of the program leans
on. They reuse the existing `TableSkeleton` / `StatTileSkeleton` from `skeletons.tsx` — no
new primitives, no data changes. Read `node_modules/next/dist/docs/` to confirm this
build's `loading.tsx` conventions before writing.

**Acceptance**
- Four new `loading.tsx` files exist, each exporting a default component built from the
  existing skeleton components in `src/components/admin/skeletons.tsx` (no bespoke skeletons).
- Clicking each nav link shows the skeleton within the sidebar/header shell (shell stays
  painted) before the page hydrates — verified by Playwright screenshot mid-transition.
- Each skeleton's column/tile count matches the real page it fronts (e.g. invoices tiles = StatTileSkeleton row).
- `npx tsc --noEmit` and `npx eslint` on the new files pass with 0 errors.

---

## Round 2 — Motion + transition primitives

**Category:** visual · **Complexity:** low

**Feel:** Hovering a customer card, collapsing the sidebar, and expanding an invoice /
pricebook / estimate row all feel snappy and never stutter — and every one of them stops
moving when the OS "Reduce motion" preference is on.

**Files**
- `src/components/admin/customers/customer-people-cards.tsx`
- `src/components/admin/sidebar.tsx`
- `src/components/admin/invoices/invoice-row.tsx`
- `src/components/admin/pricebook/pricebook-table.tsx`
- `src/app/admin/(dashboard)/estimates/page.tsx`

**Why second:** This establishes the motion contract (GPU-only + `motion-reduce`) that
later visible rounds inherit. Replace `transition-all` on the people card with
`transition-[transform,box-shadow,border-color] duration-150 ease-out motion-reduce:transition-none`;
narrow the sidebar's `transition-all` to `transition-[width]` and add
`motion-reduce:transition-none` to the mobile slide-in; add `motion-reduce:animate-none`
to the three row-expand panels.

**Acceptance**
- No `transition-all` remains in the five listed files (grep confirms).
- All three row-expand panels include `motion-reduce:animate-none`; the sidebar mobile
  slide and desktop rail include `motion-reduce:transition-none`.
- With macOS Reduce motion on, expanding a row and toggling the sidebar produce no
  slide/fade (verified in-app).
- `npx tsc --noEmit` and `npx eslint` on changed files pass 0.

---

## Round 3 — Stale-while-revalidate list hooks

**Category:** perf · **Complexity:** low

**Feel:** Clicking a filter chip, changing sort, or turning the page on Requests and
Conversations keeps the existing rows on screen (briefly dimmed) while fresh data loads —
no full skeleton flash, no background-poll flicker.

**Files**
- `src/hooks/use-admin-requests.ts`
- `src/components/admin/request-table.tsx`
- `src/hooks/use-admin-conversations.ts`
- `src/components/admin/conversations/conversation-inbox.tsx`

**Why here:** `createSwrCache` and the pattern already exist in `use-admin-customers.ts`
(module-level cache, `isLoading` seeded from `cache.get(key) === null`). This round ports
that exact pattern to the two hooks still calling `setIsLoading(true)` unconditionally, so
it depends on no new infra — only the primitive that's already shipped.

**Acceptance**
- `use-admin-requests.ts` adds a module-level `createSwrCache` (30s TTL), seeds
  `requests`/`total` from cache, and only sets `isLoading=true` when the cache entry is
  absent (mirrors `use-admin-customers.ts`).
- `use-admin-conversations.ts` no longer sets `isLoading=true` on the 10s poll or on
  filter-driven refetches when a list is already loaded.
- On a filter change, previous rows stay mounted (dimmed via `opacity-50 pointer-events-none`),
  confirmed by Playwright: no 5-row skeleton appears between filter clicks.
- Related pure-helper vitest (if any touch these hooks) pass; `tsc`/`eslint` 0.

---

## Round 4 — Stale-while-revalidate KPI hooks

**Category:** perf · **Complexity:** medium

**Feel:** Switching "Last 30 days" to "Last 90 days" on Reports or Operations keeps the
previous KPI numbers painted while the new range loads, with only a small spinner on the
active preset button — instead of every card blanking to a skeleton for the round-trip.

**Files**
- `src/hooks/use-reports.ts`
- `src/hooks/use-operations-metrics.ts`
- `src/app/admin/(dashboard)/reports/page.tsx`
- `src/app/admin/(dashboard)/operations/page.tsx`

**Why here:** Same SWR pattern as Round 3, applied to the KPI hooks that currently start
each fetch from `data: null`. Kept separate because the KPI cards need a *second* affordance
(spinner on the active preset) that the list tables don't, and the range-keyed cache differs
from the list-keyed one. Pattern reference: `use-estimates.ts`.

**Acceptance**
- Both hooks add a `createSwrCache` keyed by the range string (`from+to`, 60s TTL) and
  seed state before fetching; `isLoading` is only true when the cache is empty.
- On a preset switch with cached prior data, KPI cards keep their previous values (no
  `Skeleton` swap) — verified by Playwright.
- The active preset button shows a subtle inline spinner while revalidating and clears
  when data settles.
- `tsc`/`eslint` 0; any pure-helper tests for these hooks pass.

---

## Round 5 — Shape-matched loading skeletons

**Category:** visual · **Complexity:** low

**Feel:** The dispatch board, estimates table, and tech job list each fade in from a
skeleton that mirrors the real layout — column headers with stacked cards, a 6-column
table, 3-line job cards — so there's no jump from flat grey bars to structured content.

**Files**
- `src/app/admin/(dashboard)/dispatch/page.tsx`
- `src/app/admin/(dashboard)/estimates/page.tsx`
- `src/components/tech/tech-jobs-list-client.tsx`

**Why here:** Builds directly on Round 1's skeleton vocabulary and Round 2's motion
contract, now applied to the *in-component* loading branches (distinct from route-level).
Dispatch's four featureless boxes become Card skeletons with a header bar + 2–3 job-card
bars; estimates uses `<TableSkeleton rows={8} cols={6} />` in a bordered wrapper; tech job
list uses 2–3 Card-shaped skeletons matching the 3-line card anatomy.

**Acceptance**
- Dispatch skeleton renders as columns (header bar + stacked card bars), not `h-64 w-72`
  rectangles.
- Estimates loading branch renders `TableSkeleton` with 6 columns inside an
  `overflow-hidden rounded-lg border` wrapper matching the real table container.
- Tech job list skeleton has a header row + two sub-lines per card, matching the rendered
  card; no layout shift when real data arrives (Playwright before/after screenshots align).
- `tsc`/`eslint` 0.

---

## Round 6 — Layout-consistency + heading pass

**Category:** visual · **Complexity:** medium

**Feel:** Insights, Operations, Reports, and Staff now cap at 1280px on wide monitors like
Invoices/Estimates/Pricebook/Customers do, and their page headings read as bold and
authoritative as every other page — the app stops looking like two different products.

**Files**
- `src/app/admin/(dashboard)/insights/page.tsx`
- `src/app/admin/(dashboard)/operations/page.tsx`
- `src/app/admin/(dashboard)/reports/page.tsx`
- `src/app/admin/(dashboard)/staff/page.tsx`

**Why here:** These four pages were already visited in Round 4 (reports/operations) for
data behavior; now they get their shell. Swap the hand-rolled `space-y-6 p-6` roots for
`PageShell`, and the hand-rolled header blocks for `PageHeader` (which supplies
`font-heading text-2xl font-bold tracking-tight` + muted subtitle). Leave Settings' narrow
`max-w-3xl` as-is (intentional form width).

**Acceptance**
- All four pages use `PageShell` as their root (`mx-auto max-w-[1280px]`) and `PageHeader`
  for the heading block; no remaining `space-y-6 p-6` root or `font-semibold` h1 in these files.
- Headings render in the Bricolage/heading font, bold, tracking-tight, matching Invoices
  (side-by-side Playwright screenshot on a 1440px viewport).
- Settings page is untouched.
- `tsc`/`eslint` 0.

---

## Round 7 — Keyboard-first admin

**Category:** qol · **Complexity:** low

**Feel:** Power users stay on the keyboard: `/` focuses search on Pricebook and Estimates,
arrow keys walk the Conversations inbox (Enter opens), and ⌘K opens as a launcher showing
quick navigation before you type a single character.

**Files**
- `src/app/admin/(dashboard)/pricebook/page.tsx`
- `src/app/admin/(dashboard)/estimates/page.tsx`
- `src/components/admin/conversations/conversation-inbox.tsx`
- `src/components/admin/global-search.tsx`

**Why here:** One coherent "keyboard control" theme across three surfaces, reusing the
`activeIndex`/arrow-handling already in `global-search.tsx` as the reference implementation.
Motion rule honored: keyboard-driven focus changes are instant, never animated.

**Acceptance**
- Pressing `/` (when focus is not already in an input/textarea/contenteditable) focuses the
  search input on both Pricebook and Estimates and calls `preventDefault()`.
- The Conversations inbox supports ArrowDown/ArrowUp to move a `focusedIndex` and Enter to
  open the focused row, with `tabIndex` roving on the row buttons.
- Opening ⌘K with an empty query shows up to 8 `NAV_ITEMS` as "Quick navigation" instead of
  the "Type at least 2 characters" dead state; typing still filters records.
- `tsc`/`eslint` 0; keyboard flows verified in-app.

---

## Round 8 — Consistent confirms, empty states, and toasts

**Category:** qol · **Complexity:** low

**Feel:** Deactivating a pricebook or membership item opens the same branded dialog as
invoice Void (not a bare OS `confirm`); an empty Requests table offers an icon, message,
and "Clear filters" button; and sending a reminder toasts in the corner without shoving the
invoice list up and down.

**Files**
- `src/app/admin/(dashboard)/pricebook/page.tsx`
- `src/app/admin/(dashboard)/membership-plans/page.tsx`
- `src/components/admin/request-table.tsx`
- `src/app/admin/(dashboard)/invoices/page.tsx`
- `src/components/admin/invoices/scoped-invoices-section.tsx`

**Why here:** Three "consistency" gaps that all replace ad-hoc UI with existing shared
components (`ConfirmDialog`, `EmptyState`) or a small shared toast. The toast uses the
Round 2 motion contract (fixed `bottom-4 right-4`, translate+opacity enter, 200ms ease-out,
`motion-reduce`). The `flash` timer logic stays; only the render target moves out of flow.

**Acceptance**
- No `window.confirm` remains in the pricebook or membership-plans pages; both use
  `ConfirmDialog` with an `isConfirming` busy state and surface `deactivateError`.
- The Requests empty state renders `EmptyState` (icon + title + description) plus a "Clear
  filters" action that resets status/urgency/search/assignedTo when filters are active.
- The invoice `flash` renders as a fixed-position toast (GPU translate+opacity enter, 3s
  auto-dismiss, `motion-reduce:animate-none`); the SummaryBand/list no longer jump when it
  appears (Playwright: no vertical shift).
- `tsc`/`eslint` 0.

---

## Round 9 — Customer chat feels alive

**Category:** qol · **Complexity:** medium

**Feel:** The chat input grows from one line up to ~5 as you type (Enter sends,
Shift+Enter newlines), the intake progress stepper never pushes chips off a narrow phone,
and you can fix a misheard field inline before confirming instead of abandoning the flow.

**Files**
- `src/components/chat/chat-input.tsx`
- `src/components/chat/extraction-pills.tsx`
- `src/components/chat/extraction-card.tsx`
- `src/components/chat/confirmation-dialog.tsx`

**Why here:** First customer-facing round, three tightly-coupled chat-flow gaps on the same
surface. Highest-impact qol item (inline edit reduces extraction-error abandonment). Do
**not** touch any FROZEN safety text; this is presentation/interaction only.

**Acceptance**
- The chat input is an auto-sizing `<textarea>` growing 1→~5 rows; Enter submits,
  Shift+Enter inserts a newline; 2,000-char cap preserved.
- The extraction stepper stays within a 375px (iPhone SE) viewport with 5 collected fields
  — chips wrap or use a compact dot-stepper, none clipped off-screen (Playwright at 375px).
- Each field in the confirmation flow has an inline edit affordance that updates the value
  before submit; corrected values are what gets submitted.
- No `src/lib/ai` prompt/safety text is modified; `tsc`/`eslint` 0.

---

## Round 10 — Public surfaces on-brand + fast

**Category:** visual · **Complexity:** medium

**Feel:** The marketing homepage loads noticeably faster from edge cache and finally has a
working mobile menu for its nav links, and the customer portal looks like a real part of
the Spears product (brand tokens, dark-mode-ready) instead of a plain grey HTML page.

**Files**
- `src/app/page.tsx`
- `src/app/portal/[token]/page.tsx`

**Why last:** The most visible, most-shared surfaces — the flourish that closes the
program. The homepage change is a genuine perf win (`force-dynamic` → static edge-cached)
bundled with the mobile-nav fix on the same file; the portal re-skin swaps raw `gray-*` /
`green-*` classes for the oklch token vocabulary (`text-foreground`, `text-muted-foreground`,
`bg-card`, `bg-success-light/text-success`). Bricolage display font applies on the marketing
surface per brand rules.

**Acceptance**
- `export const dynamic = 'force-dynamic'` is removed from `src/app/page.tsx` (page is
  statically generatable — confirm no server data fetch remains); build output marks the
  route static.
- The homepage nav exposes Live Demo, Admin, and Docs on mobile via a hamburger/sheet
  overlay; all three are reachable at 375px (Playwright).
- The portal page uses no raw `gray-*` / hardcoded `green-*` classes; badges and sections
  use the token vocabulary and render correctly in dark mode.
- `tsc`/`eslint` 0; Playwright screenshots of homepage (mobile) and portal (light + dark).

---

### Category coverage

- **perf:** Rounds 1, 3, 4 (3)
- **qol:** Rounds 7, 8, 9 (3)
- **visual:** Rounds 2, 5, 6, 10 (4)

Meets the mix requirement (≥2 each) with foundations first and the customer-facing
flourish last.
