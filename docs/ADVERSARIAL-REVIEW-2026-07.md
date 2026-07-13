# Adversarial Review & Remediation Plan — Admin Pages (2026-07-14)

Five parallel adversarial reviewers (code + **live** Playwright/API probing against a
seeded dev branch) covered all 22 admin pages. Every P0 below was **reproduced live**
(HTTP 500 confirmed via authenticated curl). Security held up under probing: **no
IDOR, tenant-isolation, XSS, or SQL-injection holes** were found — auth is
server-enforced, every query is `withTenant()`-scoped, map popups are `esc()`-escaped,
and pagination bounds are clamped.

**Execution rule:** fix top-down. After each fix, re-run the live probe (`curl` for
500s, Playwright screenshot for UI) to confirm 500→200 / broken→rendered. The dev
server + session harness (see [[playwright-visual-verification]]) is the verifier.

---

## P0 — CRITICAL (verified-live 500s / data integrity). Fix first.

### P0-1 · Systemic: non-UUID path param → unhandled 500 (many routes)
A malformed id in any un-guarded `[id]` route reaches Postgres as a bad `uuid` cast and
500s. **Verified live 500:** `/api/admin/invoices/not-a-uuid`, `/api/admin/estimates/not-a-uuid`,
`/api/admin/customers/not-a-uuid`, `PATCH /api/admin/membership-plans/not-a-uuid`,
`/api/admin/inventory/purchase-orders/not-a-uuid`. The `staff/[id]` route already guards
(returns **400** — pattern proven).
- **Fix:** add a shared `isUuid(id)` helper (`src/lib/validation/uuid.ts`), guard the top
  of **every** `[id]` handler (GET/PATCH/DELETE/subroutes: void, payments, revoke, etc.);
  return `404` for GET reads, `400 VALIDATION_ERROR` for mutations.
- **Files:** `src/app/api/admin/{invoices,estimates,customers,membership-plans}/[id]/route.ts`,
  `.../invoices/[id]/{void,payments}/…`, `.../inventory/purchase-orders/[id]/route.ts`,
  and the `[id]/page.tsx` server components (call `notFound()` on mismatch).
- **Effort:** M (one helper + ~10 route edits). **Verify:** each returns 404/400, not 500.

### P0-2 · Reports & Insights pages fully 500 — Drizzle `coalesce()`-in-GROUP BY
`.groupBy(sql\`coalesce(${col}, ${literal})\`)` parameterizes the literal at a different
`$N` in SELECT vs GROUP BY, so Postgres rejects it (`check_ungrouped_columns_walker`:
"column … must appear in the GROUP BY clause"). **Verified live 500** on both endpoints.
A `::text` cast does **not** fix it (tested live).
- **Fix:** `.groupBy(rawColumn)` and coalesce NULL→placeholder in the JS mapper.
- **Files:** `src/lib/admin/reporting-queries.ts:323,346,370,401` (leadSource),
  `:490,514,533` (location); `src/lib/admin/bot-analytics-queries.ts:162` (outcome).
- **Also:** the routes use `Promise.all`, so one failing sub-query blanks the whole page —
  fixing the GROUP BY restores all queries at once.
- **Effort:** S. **Verify:** `/api/admin/reports` & `/api/admin/bot-analytics` → 200 with data.

### P0-3 · Invoice amount filter overflows INT32 → 500
`minCents`/`maxCents` from the "$ min/max" box are `parseInt`'d and passed to an `integer`
column with no upper bound. **Verified live:** `?minCents=2147483648` → 500 (`2147483647`
→ 200). Introduced with the Phase 07 balance-range filter.
- **Fix:** clamp to `[0, 2_147_483_647]` in `src/app/api/admin/invoices/route.ts:80-84`
  (drop the condition if out of range). **Effort:** S. **Verify:** overflow input → 200.

---

## P1 — HIGH (money correctness / convention / safety)

### P1-1 · Accounting export misfiles HCP-synced invoices as "native" → money double-count
Native query correctly excludes both `fieldpulseInvoiceId` and `hcpInvoiceId`, but the
"synced" query only checks `isNotNull(fieldpulseInvoiceId)` — an HCP-only invoice matches
**neither correctly** and lands in the native/QB export, double-counting revenue HCP
already pushed to QuickBooks.
- **Fix:** synced guard → `or(isNotNull(fieldpulseInvoiceId), isNotNull(hcpInvoiceId))`.
- **File:** `src/lib/admin/accounting-export.ts:127-143`. **Effort:** S.

### P1-2 · Audit-log stores money **values** in `details` — violates the no-values invariant
`audit_log.details` is supposed to hold field names/ids/enums only ([[audit-details-no-pii]]),
but invoice-sync writes `totalCents` (and the portal pay route writes `amountCents`), so
6,184/6,185 entries expose transaction amounts to any admin with audit access.
- **Fix:** drop `totalCents`/`amountCents` (and timestamp values) from `details`; keep
  from/to state + source + external id. Amounts already live on `invoices`.
- **Files:** `src/lib/integrations/fieldpulse/invoice-sync.ts:449-455,492-497`,
  `src/lib/integrations/housecall-pro/invoice-sync.ts:160-167,201+`,
  `src/app/api/portal/[token]/pay/route.ts:~109`, `src/app/api/admin/requests/[id]/route.ts:~258`.
- **Effort:** S. (Historical rows can be left; new writes clean.)

### P1-3 · Dashboard "today" KPIs use UTC midnight, not Eastern
`startOfTodayUTC()` powers assignedToday/completedToday/afterHoursToday + today's-schedule.
After ~8pm ET the buckets flip to tomorrow — wrong numbers every evening. The dispatch
board already migrated to `businessDayBounds`; the dashboard did not.
- **Fix:** use `businessDayBounds(businessIsoDate(new Date()))!.start`.
- **File:** `src/lib/admin/queries.ts:85,1032,1044-1062,1169-1187`. **Effort:** S.

### P1-4 · Map popup arrival times render in the browser timezone
`formatWindow()` uses `d.getHours()` on a UTC-pinned ET wall-clock → off by the viewer's
offset (showed 21:00 for an 8am ET window). Sibling `dispatch-column.tsx` does it right.
- **Fix:** format with `timeZone:'America/New_York'`. **File:** `dispatch-map.tsx:90`. **Effort:** S.

### P1-5 · "Deactivate" fires irreversible DELETE with no confirmation (+ silent failure)
Pricebook and membership-plans Deactivate buttons call `fetch(DELETE)` directly — a
mis-click destroys with no prompt, and non-ok responses are swallowed (no toast).
- **Fix:** wrap in an `AlertDialog` confirm; surface errors on non-ok / catch.
- **Files:** `src/app/admin/(dashboard)/{pricebook,membership-plans}/page.tsx`,
  `membership-plans-table.tsx`. **Effort:** M.

### P1-6 · List search decrypts the **entire** org table with no LIMIT
Customer-name search (encrypted → must decrypt-scan) fetches all rows unbounded on every
keystroke — fine at ~2.2k rows, a timeout/memory risk past ~10k after a full import.
- **Fix:** cap the scan (e.g. `.limit(5000)`, matching `search-queries.ts` SCAN_LIMIT).
- **Files:** `invoice-queries.ts` + `estimate-queries.ts` (search branch), `crm-queries.ts:248-272`.
- **Effort:** S.

### P1-7 · No rate limit on `GET /api/admin/dispatch/map` and `GET /api/admin/requests/[id]`
map fires ≤25 live geocodes + decrypts over 200 jobs/300 AR rows per call; requests/[id]
decrypts full PII. Sibling mutating routes are limited; these reads are not.
- **Fix:** add `slidingWindow(..., RATE_LIMITS.adminRead)` after the session check.
- **Files:** `dispatch/map/route.ts:46`, `requests/[id]/route.ts`. **Effort:** S.

---

## P2 — MEDIUM (correctness / UX / a11y). Batch after P0/P1.

- **Dispatch "suggested technicians" returns 0 for every request** (skill-gate drops all
  techs w/o prior matching-category jobs; null jobType on FP jobs). Dead feature — needs a
  **product decision**: fall back to unfiltered ranking, or show "no matching-experience
  techs". `score.ts:170`, `scheduling-queries.ts:1114`.
- **staff `RoleBadge` renders super_admin as "Technician"** (no super_admin branch) —
  `staff-table.tsx`. Add a Super Admin badge.
- **Conversations inbox: no pagination** — only first 20 of 118 reachable; hook/API support
  paging. `conversation-inbox.tsx:120`.
- **Conversations poll clears the error banner every 10s** → flicker on a persistent
  failure. Clear error only on success. `use-admin-conversations.ts:41-42`.
- **`getCustomerById` hardcodes `lastServiceDate: null`** — detail omits what the list card
  shows; fold the `max(created_at)` into the existing `Promise.all`. `crm-queries.ts:395`.
- **Reports KPI cards show Skeleton forever after an error** (isLoading=false, value=null) —
  add an error branch / `"—"`. `reports/page.tsx`. Also `use-reports.ts` concurrent-guard
  drops presets on rapid switch (port the `use-operations-metrics` latest-wins pattern).
- **`localStorage` read in `useState` initializer → hydration mismatch** (calendar "Show
  completed", dispatch `todayBusiness()`). Move to `useEffect`. `calendar/page.tsx:124`.
- **Keyboard a11y gaps:** no `KeyboardSensor` for dnd reschedule (`interactive-scheduling-calendar.tsx`);
  clickable `<tr onClick>` with no tabIndex/role/keydown (`request-table.tsx:71`); ARIA
  double-role on draggable cards (`draggable-job-card.tsx:44`); unlabeled sort `<select>`
  (`inventory/page.tsx`), unlabeled conversation status Select, unlabeled job-card buttons.
- **`getReviewStats` raw `::int` cast** — use `count()` + `Number()` (repo convention).
  `review-queries.ts:318-319`.
- **`getRequests` default limit 20 ≠ API default 50** — align to 50. `queries.ts:125`.
- **BotAnalytics error state has no retry** wired (refetch exists, unbound). `bot-analytics-section.tsx`.
- **Operations AR aging bar % uses native-only denominator** while the headline is
  native+synced — can misread. `operations/page.tsx:151-154`.
- **DECISION — settings mutations not `super_admin`-gated:** any admin can change branding,
  widget `allowedOrigins`, chatbot `businessInfo`, and revoke admin invites. May be
  intentional (all admins configure their org). Confirm intent; gate to super_admin if not.

---

## P3 — LOW (cleanup / hardening)

- Every admin page shares one `<title>` ("Admin - HVAC Dashboard") — per-page titles.
- Reviews API `?limit` cap of **20,000** is far too high — lower to ~200.
- Audit-log `entity` filter is read by the API but never sent by the UI (dead surface).
- Staff POST Zod accepts `role:"super_admin"` (blocked at business layer → 403; tighten to
  `z.enum(["admin","technician"])` to reject at the boundary).
- Dead prop: `DashboardGreeting` accepts `name`, never passed.
- `agenda-view.tsx:233` `row.booking!` non-null assertion — add a guard.
- Invalid list filter params return 200 unfiltered (defensive, but a real filter bug would
  look like it "works") — consider surfacing invalid-filter feedback.
- Audit-log trusts `X-Forwarded-For` verbatim (IP spoofable) — known limitation.

---

## Not bugs (probed and ruled out — do not re-flag)
- `DropdownMenuTrigger render={<Button/>}` — this repo uses **base-ui**, where `render` is
  the correct API (see `button.tsx`). Not a defect.
- `"FieldPulse customer (deleted #N)"` names — intentional placeholder for orphaned FP
  records (`import/customers.ts:439`), not a broken join.
- IDOR / tenant isolation / XSS (`esc()`) / SQL injection / pagination bounds / last-admin
  guard / privilege-escalation via staff create — all adversarially probed, all held.
- `button` inside `Badge` (span) origin-remove — valid HTML5 phrasing content.

---

## Suggested execution order
1. **P0-2 + P0-3** (S, isolated query/route edits) → 3 pages/filters stop 500ing.
2. **P0-1** (systemic UUID guard) → ~10 routes hardened with one helper.
3. **P1-1, P1-2** (money correctness/convention) → highest business risk.
4. **P1-3, P1-4** (timezone) → correct numbers.
5. **P1-5, P1-6, P1-7** (safety/perf/rate-limit).
6. **P2 batch** (per-page; the settings-gating one needs a decision first).
7. **P3** cleanup as capacity allows.
