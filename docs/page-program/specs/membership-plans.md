# Membership plans — `/admin/membership-plans`

## Purpose

Let an operator define the org's recurring service-agreement plans (name,
price, billing period, maintenance-visit entitlement) that customers enroll
in for member pricing and automatically-scheduled maintenance visits.

## Brainstorm

Ideas for a great version of this page, including what was considered and
rejected:

- **Show + reactivate deactivated plans** — kept in scope. The confirm
  dialog already promises this ("You can re-activate it later",
  `page.tsx:94`) but nothing in the app can do it. Real hole; see
  Gaps/Requirements.
- **Enforce the price business cap consistently on update, not just create**
  — kept in scope; money-correctness lens. See Gaps/Requirements.
- **Structured `benefits` editor** (checkbox list: priority dispatch, waived
  diagnostic, discount %) — considered, **rejected**: the `benefits` JSONB
  column (`schema.ts:2952`) is written and read *nowhere* in the product
  (zero grep hits outside the declaration), and the form's own
  `description` free text already does this job in practice (placeholder:
  "e.g. 2 tune-ups/year + 15% off repairs", `membership-plan-form-dialog.
  tsx:171`). Building UI for an unconsumed column is speculative — recorded
  as a P2 cleanup gap, not a requirement (YAGNI).
- **Search/filter/pagination on the plan list** — considered, rejected: no
  evidence of scale pressure (a plan catalog is inherently small); the skill
  already flags this as "add before adding a client-side filter" if it ever
  grows. Not a requirement now.
- **A checkbox in the generic edit-plan form to flip `active`**, instead of
  a dedicated reactivate action — considered as the *mechanism*; folded into
  Rmembership-plans-1 rather than listed separately.
- **Server-side enforcement that `useMemberPrice` on an estimate line
  matches the customer's real active membership** — real gap (see Current
  state), but every file involved belongs to the estimates page, not this
  one. Cross-referenced in Non-goals for whoever specs `/admin/estimates`.
- **Auto-renewal / real Stripe charging on `currentPeriodEnd`** —
  deliberately deferred by the codebase itself (`membership-queries.ts:
  9-12`, "v1 does NOT auto-renew"); a payments-integration project, not a
  page fix. Kept as an Invariant to preserve, not a gap to close.

## Current state

**Is this page an island?** No — verified as a real, consumed feature, not a
CRUD-only stub:

- **Enrollment/cancellation UI** lives on the customer detail page, not this
  one: `CustomerMembershipCard` (`src/components/admin/memberships/customer-
  membership-card.tsx`) calls `POST`/`DELETE /api/admin/customers/[id]/
  membership` (`.../membership/route.ts:96,166`), which call `enrollCustomer`
  /`cancelMembership` (`membership-queries.ts:226,287`) — the only call
  sites of those functions in the repo (`verified`, grep). This page only
  creates/edits/deactivates the *catalog*; enrollment reads it separately.
- **Recurring maintenance visits are real**: a daily Vercel cron
  (`src/app/api/cron/generate-membership-visits/route.ts`, `vercel.json:25`,
  `0 9 * * *`) reads `visitsPerYear > 0` memberships and materializes due
  visits into real `service_requests` via `generateDueVisits`
  (`membership-visit-queries.ts`), idempotent on a unique index — wired and
  org-scoped, not dangling (`verified`).
- **Member pricing is applied on estimates**: `POST /api/admin/estimates`
  selects `item.memberPriceCents` when a line's `useMemberPrice` flag is true
  (`api/admin/estimates/route.ts:149-150`); the create dialog defaults that
  flag from the customer's real membership (`estimate-create-dialog.tsx:
  105-131`). Caveat (belongs to the estimates page): the server trusts the
  client-submitted flag and never re-checks `getActiveMembership` at write
  time — noted for completeness, out of scope here (see Non-goals).
- **Chat/voice AI reads membership status read-only** (no enroll/cancel
  tool): `buildCustomerContextHint` adds "acknowledge their membership
  warmly" when `context.membershipStatus === "active"` (`src/lib/ai/
  customer-context.ts:280`), used by chat (`api/chat/route.ts:1737`) and
  voice (`src/lib/ai/voice-turn.ts:1056`); `getMembershipSummary` is read by
  the account-lookup tool (`src/lib/ai/account-dispatch.ts:79`).
- **Customer list filters by `membershipStatus`** (display only — no
  scheduling-priority/dispatch-scoring read exists, `verified` by grep):
  `customers/page.tsx:164-176` → `crm-queries.ts:108`.

**Page** `src/app/admin/(dashboard)/membership-plans/page.tsx` — client
component; composes `PageShell`/`PageHeader` (`page.tsx:11-12,56-57`, per the
`admin-pages` design-system rule). Add/Edit via `MembershipPlanFormDialog`,
deactivate via the shared `ConfirmDialog` pattern (`page.tsx:90-100`), both
`verified`.

**Data fetch** `useMembershipPlans` (`use-membership-plans.ts:23-57`) fetches
`GET /api/admin/membership-plans` **with no query params** on mount, no
cache, `refetch()` after every mutation (`verified`). The list API
(`route.ts:24-50`) supports `?includeInactive=true` (`:40-41`) but the hook
never sends it — so the default (`false`) is the *only* state this page can
ever show (`verified`). `listMembershipPlans` (`membership-queries.ts:
74-86`) filters `active=true` in that default case (`:78-80`).

**Table rendering** `membership-plans-table.tsx` has fully-built dead code
for the inactive case: an `Inactive` badge and `opacity-60` row styling
(`:68-79`) that can never render, since inactive plans never reach `plans`
(see above), `verified`.

**Deactivate-only mutation surface**: `DELETE /api/admin/membership-plans/[id]`
→ `deactivateMembershipPlan` (`membership-queries.ts:127-135`) sets
`active=false`. There is no reactivate function anywhere in the repo
(`verified`, grep for "reactivate" across `src/` returns zero matches), and
`MembershipPlanUpdate`/`updateMembershipPlan`
(`membership-queries.ts:100-124`) never accepts an `active` field — so `PATCH`
cannot restore it either. Yet the deactivate confirm dialog tells the admin
**"You can re-activate it later"** (`page.tsx:94`) — a promise the product
currently cannot keep.

**Money validation asymmetry**: `POST /api/admin/membership-plans`
(`route.ts:16-22`) caps price at `MAX_PRICE_CENTS = 99_999_999`
(`route.ts:14,19`, a **locally re-declared constant**, not the one exported
from `src/lib/admin/money-format.ts:20`). `PATCH
/api/admin/membership-plans/[id]` (`[id]/route.ts:15-21`) has **no upper
bound** — `priceCents: z.number().int().min(0).optional()` — so an update
can set a plan's price to any non-negative integer, bypassing the cap
enforced at creation, `verified`. The client form protects normal use
(`parseDollarsToCents` returns `0` for over-cap input,
`money-format.ts:28-34`) but a direct API call is not stopped server-side.

**`benefits` column is fully unused**: declared in the schema (`schema.ts:
2950-2952`, nullable JSONB) but absent from `PLAN_PROJECTION`
(`membership-queries.ts:45-53`), both Zod schemas (`route.ts:16-22`,
`[id]/route.ts:15-21`), and the form dialog (`membership-plan-form-dialog.
tsx:35-51`) — zero read/write sites anywhere, `verified` by grep.

**Money format**: `formatCentsExact`/`parseDollarsToCents` (`money-format.
ts:15-34`) — integer cents throughout, no float drift (`Math.round`, `:31`),
used consistently in the table (`membership-plans-table.tsx:96`) and form
(`membership-plan-form-dialog.tsx:58,230`), `verified`.

**Tenancy**: every query in `membership-queries.ts` goes through `withTenant`
(`:79-80,95,123,134`, `verified`); both API routes call `getAdminSession()`
and 401 without one (`route.ts:26-29`, `[id]/route.ts:29-31`).

**Billing period enum**: `monthly`/`annual` only, consistent everywhere —
schema (`schema.ts:2916-2919`), both Zod schemas, and the form's `<Select>`
(`membership-plan-form-dialog.tsx:33,202-203`), `verified`.

**Recurring billing is deliberately mocked**: `getPaymentProvider()`
(`src/lib/payments/provider.ts`) always returns the mock provider even with
`STRIPE_SECRET_KEY` set (logs a warning); `currentPeriodEnd` (`schema.ts:
2985-2987`) is set once at enrollment and never renewed by any cron/webhook,
`verified` (grep for `currentPeriodEnd` reads — only display sites, no
renewal writer).

## Gaps

| Gap | Severity | Evidence |
|---|---|---|
| A deactivated plan disappears from this page entirely (hook never requests `includeInactive=true`) with no way to view or reactivate it, directly contradicting the confirm dialog's own promise ("You can re-activate it later"). No reactivate capability exists anywhere in the codebase. | P0 | `src/hooks/use-membership-plans.ts:33` (no query param); `src/app/api/admin/membership-plans/route.ts:40-41` (default false); `src/app/admin/(dashboard)/membership-plans/page.tsx:94` (the false promise); `src/lib/admin/membership-queries.ts:100-124` (`MembershipPlanUpdate` excludes `active`); grep for "reactivate" — zero matches |
| `PATCH /api/admin/membership-plans/[id]` has no upper bound on `priceCents`, while `POST` caps it at `MAX_PRICE_CENTS` (99,999,999 cents) — an update can push a plan's price arbitrarily high, and that value is later charged verbatim via `provider.createCharge` at enrollment. | P1 | `src/app/api/admin/membership-plans/[id]/route.ts:15-21` (no `.max()`) vs. `src/app/api/admin/membership-plans/route.ts:19` (`.max(MAX_PRICE_CENTS)`); `src/lib/admin/membership-queries.ts:242-247` (charge uses `plan.priceCents` uncapped) |
| `MAX_PRICE_CENTS` is locally re-declared in the create route instead of importing the one export from `money-format.ts` — risk of the two caps drifting apart. | P2 | `src/app/api/admin/membership-plans/route.ts:14` vs. `src/lib/admin/money-format.ts:20` |
| `benefits` JSONB column exists in the schema but has zero read/write sites in the product — dead field, and the page's own purpose statement ("benefits") is not actually deliverable through any UI. | P2 | `src/lib/db/schema.ts:2950-2952`; no matches in `membership-queries.ts` `PLAN_PROJECTION`, either Zod schema, or the form dialog |
| No pagination/search on the plan list — currently fine at expected catalog scale, but undocumented if it ever grows. | P2 | `.claude/skills/page-membership-plans/SKILL.md:44-46` (self-documented gotcha) |

## Requirements

- **Rmembership-plans-1**: This page must be able to show deactivated plans
  and let an admin reactivate one. *Acceptance:* a "Show inactive" toggle
  (matching the pricebook page's existing pattern,
  `src/app/admin/(dashboard)/pricebook/page.tsx:204-207`) fetches
  `includeInactive=true`; an inactive plan renders with the existing
  `Inactive` badge/`opacity-60` styling (`membership-plans-table.tsx:68-79`,
  already built, currently unreachable); an inactive row shows a
  "Reactivate" action that sets `active=true` (new query function or an
  extended `updateMembershipPlan` accepting `active`) and the plan reappears
  in the default active-only view afterward. The confirm-dialog copy at
  `page.tsx:94` becomes true.
- **Rmembership-plans-2**: `PATCH /api/admin/membership-plans/[id]` must
  reject `priceCents` above `MAX_PRICE_CENTS`, matching `POST`. *Acceptance:*
  a `PATCH` with `priceCents: 100_000_000` (or higher) returns `400
  VALIDATION_ERROR`; a `PATCH` with `priceCents` at or below the cap succeeds
  unchanged. Import the shared `MAX_PRICE_CENTS` from `money-format.ts` in
  both routes instead of the local re-declaration (folds in the P2 DRY gap
  at no extra cost).

(P2 gaps — `benefits` cleanup and pagination — are recorded above and in
`README.md`'s backlog table; not built in this pass per the severity gate.)

## Non-goals

- A structured `benefits` editor — no consumer anywhere for the field today;
  `description` free text already covers real usage. Revisit only if a
  future requirement (e.g. customer-facing plan comparison) needs structured
  data, not speculatively.
- Search/filter/pagination on the plan list — no evidence of scale need;
  plan catalogs are inherently small. Add if `README.md`'s backlog item is
  ever triggered by real growth.
- Server-side enforcement that an estimate's `useMemberPrice` flag matches
  the customer's actual active membership — real gap, but every file
  involved (`estimate-create-dialog.tsx`, `api/admin/estimates/route.ts`)
  belongs to the estimates page. Flagged for whoever specs
  `/admin/estimates`; not this page's requirement.
- Real Stripe/recurring-charge integration for renewals — v1-out of scope by
  the codebase's own design comment (`membership-queries.ts:9-12`); a
  payments-integration project, not a page fix.
- Editing `visitsPerYear`/`billingPeriod` semantics or the maintenance-visit
  cron itself — both already work correctly (verified above); this spec
  only touches the plan-catalog page's own gaps.

## Invariants

- **Tenancy**: every plan/membership query is scoped by
  `session.organizationId` via `withTenant` — repo-wide invariant
  (`AGENTS.md`); no unscoped query when building Rmembership-plans-1.
- **Never hard-delete a plan**: `customer_memberships` rows reference
  `membershipPlans.id` (`schema.ts:2978-2980`); deactivate/reactivate must
  only ever flip `active`, never `DELETE FROM membership_plans`.
- **`priceCents` is `NOT NULL`, `0` is a valid free plan** (`schema.ts:
  2942`); do not add a `null` price path.
- **`visitsPerYear=0` means billing-only** (no auto-generated visits, not
  "unset") — the generate-membership-visits cron depends on this exact
  semantic (`membership-visit-queries.ts` header comment).
- **Money is integer cents everywhere**; use `formatCentsExact`/
  `parseDollarsToCents` (`money-format.ts`), never float dollar arithmetic.
- **Business price cap** (`MAX_PRICE_CENTS = 99_999_999`) must hold on every
  write path setting `priceCents` — the invariant Rmembership-plans-2
  restores; do not regress it on a future route.
- **Audit logs never carry money values** — existing `create`/`update`
  audit calls log only `billingPeriod`/`name`/changed-field names
  (`route.ts:79-86`, `[id]/route.ts:61-67`, "H1: strip money values from
  audit details"); preserve this when adding the reactivate audit entry.
- **Recurring billing stays mock-only**: do not wire a real Stripe charge
  into Rmembership-plans-1/2 — `getPaymentProvider()` mock posture is
  deliberate v1 scope (`payments/provider.ts`).
- **Compose `PageShell`/`PageHeader`** from `src/components/admin/ui/` — no
  hand-rolled page chrome (`admin-pages/SKILL.md`).
- **`billingPeriod` is a closed enum** (`monthly`/`annual`) — never submit a
  free-form string; keep the `<Select>` as the only input mechanism.

## Verification

- `npx tsc --noEmit` → 0.
- `npx eslint` on every changed file (page, table, form dialog, hook, both
  API routes, `membership-queries.ts`) → 0 errors.
- `npx vitest run src/lib/admin/membership-queries.test.ts
  src/lib/admin/membership-visit-queries.test.ts` → must not drop below the
  live baseline captured at program start (`README.md`).
- New coverage: `membership-queries.test.ts` case asserting a reactivated
  plan has `active=true` and reappears in `listMembershipPlans` with
  `includeInactive` unset (Rmembership-plans-1); a route/schema test
  asserting `PATCH .../[id]` with `priceCents` over `MAX_PRICE_CENTS`
  returns `400 VALIDATION_ERROR` (Rmembership-plans-2).
- Visual: `node scripts/agent/screenshot-page.mjs /admin/membership-plans`
  per the `admin-pages` recipe — confirm "Show inactive" and Reactivate
  render correctly against existing table styling.
- Manual: deactivate a test plan, toggle "Show inactive," confirm the
  badge, click "Reactivate," confirm it reappears in the default view —
  closes the loop the confirm-dialog copy currently promises falsely.
