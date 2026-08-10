# Spec: estimates (`/admin/estimates`, `/admin/estimates/[id]`)

## 1. Purpose

The sales pipeline workspace: operators build good/better/best proposals,
track pipeline value and stale follow-ups, convert a sold estimate to an
invoice, and (for native, non-FieldPulse orgs) let a customer e-sign a
proposal via a tokenized public link. Audience: office staff/sales admins
running quote-to-cash; the tokenized `/estimates/[token]` page is
customer-facing.

## 2. Brainstorm

- **Auto-expire/auto-lose stale native estimates** so `status` eventually
  leaves `open`. ACCEPTED → Restimates-1. Without it native estimates can
  never reach `dismissed`/`expired`, permanently inflating pipeline KPIs
  (G1).
- **Regenerate the approval link from the detail page** for an open,
  native, unsynced estimate. ACCEPTED → Restimates-2. The plaintext token
  is by design never persisted (only its hash), so there is currently no
  recovery path once the create-dialog's one-time link is dismissed.
- **Bound `quantity`/`unitPriceCents` in the create API schema** to match
  the `MAX_PRICE_CENTS` pattern the pricebook route already uses. ACCEPTED
  → Restimates-3. Narrow (needs a valid admin session) but a real
  INT32-overflow-into-500 gap in a money-mutation endpoint.
- **Separate "mark lost/dismissed" admin action.** Folded into
  Restimates-1's acceptance criterion — the expiry-transition function
  already needs a status writer, so an explicit reason code is cheap.
- **Editable line items on an open estimate.** REJECTED — line items are
  deliberately snapshotted (`estimate-queries.ts:1-8`) so a sent e-sign
  link can't change under the customer; create a new estimate instead.
- **CSV export / bulk actions / sortable columns.** REJECTED — no demand
  signal, no comparable pattern elsewhere in the admin; YAGNI.
- **Native "save as draft."** REJECTED — `draft` is FieldPulse-import-only
  today; a native draft state is a new workflow with no signal it's
  needed (an admin can just not open the dialog until ready).
- **Revision-history/activity timeline on the detail page.** REJECTED —
  `audit_log` already records `estimate_created`/`estimate_marked_sold`
  (`route.ts:196-207`, `[id]/route.ts:114-126`); surfacing it is a
  nice-to-have with no reported pain, deferred as P2 (G5).
- **Raise the 5,000-row search-decrypt scan cap.** REJECTED for this pass
  — no org is near that count; it's a documented, deliberate, repo-wide
  pattern (mirrors `search-queries.ts`), not page-specific (G4).
- **Win-rate trend chart / assigned-rep tracking.** REJECTED — no
  `assignedTo` column exists; a schema change beyond a page polish pass.

## 3. Current state

Claims `verified` by reading the cited files unless noted `inferred`.

- **List page** (`.../estimates/page.tsx`): client component, `useEstimates`
  hook fetches `/api/admin/estimates` with page/bucket/search, 60s SWR
  cache (`use-estimates.ts:64`). KPI band, 300ms-debounced search
  (`page.tsx:205-208`), status tabs (Open/Won/Lost/Draft/All,
  `page.tsx:140-146`), expandable rows, `Pager`. Default tab `open`,
  sorted oldest-first for triage (`estimate-queries.ts:362-364`); other
  tabs newest-first.
- **Detail page** (`.../estimates/[id]/page.tsx`): renders each option's
  line items, subtotal/tax, an admin-only margin readout (`rollUpMargin`,
  `page.tsx:236,277-301`), signature info if signed, "Generate invoice"
  (only `status==='sold' && !isSynced`, `page.tsx:324`), `FinancingPanel`
  for a sold option, "Mark sold" (only `isOpen && !isSynced`,
  `page.tsx:365`), FieldPulse spillover panel.
- **Money math is pure integer cents**: `lineTotalCents`/
  `computeOptionTotals` (`money.ts:17-29`) and `rollUpMargin`
  (`margin.ts:38-43`) have no float division for totals; tax is
  `Math.round((subtotal * taxBps) / 10000)`. All money columns
  (`estimates.totalCents`, `estimateOptions.*Cents`,
  `estimateLineItems.*Cents`, `invoices.*Cents`) are Postgres `integer`
  (INT32, max ~$21.5M) — `schema.ts:2663,2709-2711,2730-2749,2754-2757`.
- **Server-side price authority**: `POST /api/admin/estimates`
  (`route.ts:126-178`) re-resolves every catalog line's name/price/cost
  from the tenant-scoped pricebook item; client-sent values are ignored.
  Manual lines require client name+price (uncapped server-side, G2). Tax
  rate is the org default, resolved server-side (`route.ts:181`).
- **Estimate→invoice conversion is double-billing-safe**:
  `createInvoiceFromSoldEstimate` (`invoice-queries.ts:59-95`) requires
  `status==='sold'`, rejects synced estimates, and checks for an existing
  invoice by `estimateId` first (idempotent read-then-return) **plus** a
  DB partial unique index `invoices_estimate_unique` on
  `invoices.estimate_id` (`schema.ts:2786-2788`) closes the concurrent-call
  race; the route also catches `isUniqueViolation` → clean 409
  (`route.ts:187-195`). Both the app-level check and the DB constraint are
  verified present and wired together.
- **Mark-sold/approve are CAS-guarded**: `markEstimateSold`
  (`estimate-queries.ts:628-680`) and `approveEstimate`
  (`estimate-queries.ts:150-210`) both `UPDATE ... WHERE status='open' AND
  fieldpulse_estimate_id IS NULL ... RETURNING id`, treating a missing
  returned row as `already_decided` — closes the double-approval race
  between the admin path and the public e-sign path.
- **Tokenized public page** (`estimates/[token]/page.tsx` +
  `approve-form.tsx` + `api/estimates/approve/route.ts`): token is
  `randomBytes(24)` (192 bits) hex, stored only as a SHA-256 hash
  (`estimate-queries.ts:22-24,59,120`) — plaintext exists only once, in
  the create-response payload. The public read looks up by token hash
  with no org filter (the token is the bearer of authority) and never
  returns the token hash, signature IP, or `costCents`
  (`includeCost` defaults `false`, `estimate-queries.ts:517,714`). The
  approve POST is intentionally session-bypassing (`approve/route.ts:9-
  10`), rate-limited 10/min/IP (`:23`), IP captured server-side (`:21`),
  and re-verifies the chosen `optionId` belongs to the token's own
  estimate+org (`estimate-queries.ts:177-189`). An unauthenticated caller
  with a valid token can only ever flip that one `open` estimate to
  `sold`, once — no other read/write is reachable.
- **Pipeline KPIs are real SQL**, one round trip via `FILTER` clauses
  (`getEstimatePipelineStats`, `estimate-queries.ts:281-323`) — not a
  client reduce. `winRatePct` is `null` with no closed estimates
  (guarded, `page.tsx:117-119`); `stats=null` on partial failure defaults
  every KPI to 0 (`page.tsx:93-131`).
- **Bucket classification** (`BUCKET_CASE_SQL`, `:240-247`): `won` = FP
  status in (accepted, completed) OR native `status='sold'`; `lost` = FP
  status `lost` OR native `status` in (dismissed, expired); `draft` = FP
  `draft`; else `open`. Client's `isOpenEstimate` (`page.tsx:83-89`)
  mirrors this ELSE-arm.
- **No writer for native `dismissed`/`expired` exists anywhere** —
  verified via full read of every status-writing function
  (`createEstimate` always inserts `'open'`;
  `markEstimateSold`/`approveEstimate` only ever write `'sold'`) and a
  scan of `src/app/api/cron/*` (availability-sync, booking-recovery,
  payment-reconcile, FP/HCP invoice sync, comms, membership-visits,
  webhook-cleanup, cleanup, dunning, dispatch-digest, delay-sweep — none
  estimate-related).
- **Create dialog** (`estimate-create-dialog.tsx`): good/better/best
  options (max 10, `:551`), catalog picks (server re-prices) or manual
  lines (dollars parsed via `parseDollarsToCents`, which clamps to
  `MAX_PRICE_CENTS`/$999,999.99 client-side, `money-format.ts:28-34`).
  Member-price toggle defaults from real membership status (`:100-140`).
  "Suggest with AI" only pre-fills catalog picks (server re-prices, never
  a binding AI price, `suggest/route.ts:11`). Approval link shown exactly
  once in-dialog (`:360-371`), never persisted in plaintext or shown again
  anywhere in the admin UI (no other `approvalUrl`/`approvalToken`
  reference in any admin component).
- **Create API validation gap**: `unitPriceCents` (manual lines) has
  `.min(0)` with no `.max()`; `quantity` has `.min(1)` with no `.max()` at
  all, client or server (`route.ts:36-46`; dialog quantity input is
  `min="1"` only, `dialog.tsx:517`). Contrast the pricebook route, which
  caps every price field at `MAX_PRICE_CENTS = 99_999_999`
  (`pricebook/route.ts:19,28-31`).
- **Tests**: `estimate-queries.test.ts`, `estimate-list-pagination.test.ts`,
  `estimate-synced-guards.test.ts` — ran locally, 3 files/35 tests, all
  passing.

## 4. Gaps

| Gap | Severity | Evidence |
|---|---|---|
| Native estimates can never leave `status='open'` except via `sold` — no code path writes `dismissed`/`expired`, no cron sweeps `expiresAt`. A declined or long-expired native estimate stays in "Open pipeline"/"Needs follow-up" forever; `winRatePct` for a native-only org can only trend toward 100% since `lost` is unreachable | P1 | `estimate-queries.ts` full read (no `dismissed`/`expired` writer); `find src/app/api/cron` (no estimate job); `BUCKET_CASE_SQL` (`:240-247`) requires `status IN ('dismissed','expired')` for native `lost`, which nothing sets |
| No way to view/resend/regenerate an estimate's approval link once the create-dialog is dismissed — the plaintext token is by design never persisted, and the detail page has no link/regenerate affordance for an open, native, unsynced estimate | P1 | `estimate-queries.ts:22-24,59,120` (hash-only storage); `[id]/page.tsx` full read (no approval-link UI); `grep -rn "regenerate\|resend" src/app/api/admin/estimates` → no matches |
| `POST /api/admin/estimates` accepts unbounded `quantity` and unbounded manual-line `unitPriceCents` (server-side); a crafted request can overflow the `integer` (INT32) money columns on insert, surfacing as an opaque 500 instead of a 400 | P2 | `route.ts:36-46` (schema); `schema.ts:2709-2711,2750` (INT32 columns); contrast `pricebook/route.ts:19,28-31` (`MAX_PRICE_CENTS` bound exists there) |
| Search scans/decrypts at most the newest 5,000 rows per keystroke; matches beyond that are silently unreachable | P2 | `estimate-queries.ts:388-402` (documented, deliberate — mirrors `search-queries.ts`) |
| No revision/activity history surfaced on the detail page | P2 | `route.ts:196-207`, `[id]/route.ts:114-126` (writes only); detail page full read (no activity section) |

No P0s found. The estimate→invoice conversion seam and the public token
flow — the two areas most likely to hide a money or security bug — are
both solidly guarded; the real gaps are pipeline hygiene (G1) and a
customer-recovery workflow hole (G2).

## 5. Requirements

- **Restimates-1**: A native estimate whose `expiresAt` has passed (or that
  an admin explicitly marks declined) can reach a terminal
  `dismissed`/`expired` status, and pipeline KPIs
  (`openCents`/`openCount`, `staleCents`/`staleCount`, `winRatePct`)
  reflect it leaving `open` on the next stats fetch. **Acceptance**: a) a
  unit test on the new status-transition function proves it flips a
  native `open` estimate past `expiresAt` to `expired` (no-op for
  synced/already-decided, mirroring `markEstimateSold`'s guard shape); b)
  a unit test on `getEstimatePipelineStats` proves an `expired` estimate
  counts in `lostCents`/`lostCount` and is excluded from
  `openCents`/`staleCents`.
- **Restimates-2**: An admin can obtain a fresh approval link for an open,
  native, unsynced estimate after the original create-dialog session has
  ended (new token; old token invalidated so only one link is ever live).
  **Acceptance**: a unit test proves calling the regenerate function
  twice invalidates the first token (the old plaintext token then fails
  `not_found`, matching the existing hash-lookup contract) and returns a
  new plaintext token once; the detail page exposes a "Copy new link"
  action gated the same way "Mark sold" is (`isOpen && !isSynced`).
- **Restimates-3**: `POST /api/admin/estimates` rejects (400) `quantity` or
  manual-line `unitPriceCents` above a defined cap before any DB write.
  **Acceptance**: a) the zod schema gets `.max()` bounds on both fields
  (reusing/matching `MAX_PRICE_CENTS` from `money-format.ts`); b) a test
  asserting the schema rejects an over-cap payload with
  `VALIDATION_ERROR` rather than reaching `createEstimate`.

G4/G5 (search scan cap, no activity history) stay P2 backlog, not
requirements in this pass.

## 6. Non-goals

- No editable line items on an existing estimate — snapshotting protects
  the e-signature's legal meaning; create a new estimate instead.
- No native "save as draft" workflow — `draft` stays FieldPulse-only.
- No CSV export, bulk actions, or sortable columns.
- No revision-history/activity-timeline UI on the detail page (G5 stays
  backlog).
- No change to the 5,000-row search-decrypt scan cap (G4 stays backlog) —
  repo-wide pattern, not page-specific.
- No win-rate trend chart, assigned-rep tracking, or any change needing a
  new `estimates` column beyond Restimates-1/2.
- No change to the public token page's visual design or copy.

## 7. Invariants

- FieldPulse-synced estimates (`fieldpulseEstimateId != null`) stay
  read-only: hide "Mark sold"/"Generate invoice"; any new Restimates-1/2
  function must keep the `isNull(estimates.fieldpulseEstimateId)` guard —
  never let a status write reach a synced row. Source:
  `page-estimates/SKILL.md:26-30`; enforced today in `markEstimateSold`
  (`:641,673`) and `approveEstimate` (`:205`).
- `effectiveCreatedAt`, not `createdAt`, drives age/stale calc — new
  expiry logic must key off `expiresAt`, not a naive `createdAt` diff.
- Client `isOpenEstimate` mirrors server `BUCKET_CASE_SQL`'s ELSE-arm — if
  Restimates-1 changes what counts as `open` server-side, update this
  helper in the same change (`page.tsx:79-89`).
- Generate-invoice idempotency (`invoices_estimate_unique` partial index +
  app-level existing-invoice check) closes the double-billing race —
  neither may be removed or weakened.
- The approval token stays hash-only at rest — Restimates-2's regenerate
  function must preserve this (generate, hash, store hash, return
  plaintext once, same as `createEstimate`).
- `costCents` stays admin-only — `loadOptionsWithLineItems`'s
  `includeCost` must stay `false` on every call reachable from the public
  token page.
- Money stays integer cents throughout; no new float math.
- Compose `PageShell`/`PageHeader`/`StatCard`/`Pager`/`SegmentedControl`
  from `src/components/admin/ui/`; status colors only via
  `status-colors.ts`. Tenancy: every admin query scopes by
  `session.organizationId`. Copy canon applies to any new UI text.
- neon-http: no `db.transaction()` — use `db.batch()` for multi-statement
  atomicity if Restimates-1/2 need it.

## 8. Verification

1. `npx tsc --noEmit` → 0 errors.
2. `npx eslint <changed files>` → 0 errors.
3. `npx vitest run` → must not drop below the captured baseline (297
   files · 4022 passed · 1 skipped, per `docs/page-program/README.md`);
   also run `npx vitest run src/lib/admin/estimate-queries.test.ts
   src/lib/admin/estimate-list-pagination.test.ts
   src/lib/admin/estimate-synced-guards.test.ts` plus any new test(s) for
   Restimates-1/2/3.
4. Visual: `npm run dev` (background) →
   `node scripts/agent/screenshot-page.mjs /admin/estimates 1440` and the
   detail page for a real id — confirm the KPI band and "Copy new link"
   render correctly; look at both images.
5. `node scripts/agent/verify-skills.mjs` → 0 missing (update
   `.claude/skills/page-estimates/SKILL.md` in the same commit if
   Restimates-1/2/3 change files/flows/invariants, per METHOD.md).
