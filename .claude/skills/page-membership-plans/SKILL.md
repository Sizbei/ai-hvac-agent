---
name: page-membership-plans
description: Use when working on the /admin/membership-plans page — recurring service-agreement plan catalog that drives member pricing and maintenance visit entitlements.
---

# Membership plans (/admin/membership-plans)

**Purpose:** operators define recurring service-agreement plans (name, price,
billing period, visits per year, benefits). Customers enroll in plans which
unlocks member pricing on estimates and invoices.

**Files:** page `src/app/admin/(dashboard)/membership-plans/page.tsx` · table
`src/components/admin/memberships/membership-plans-table.tsx` · form dialog
`src/components/admin/memberships/membership-plan-form-dialog.tsx` · hook
`src/hooks/use-membership-plans.ts` · API
`src/app/api/admin/membership-plans/route.ts` · plan detail API
`src/app/api/admin/membership-plans/[id]/route.ts` · queries
`src/lib/admin/membership-queries.ts` · tables `membership_plans`
`customer_memberships` (schema `src/lib/db/schema.ts`).

**Data flow:** `useMembershipPlans` fetches `/api/admin/membership-plans` on
mount (no pagination — plan counts are small). No SWR cache; data refreshes
after every mutation via `refetch()`. Mutations use the individual-plan API
(`/api/admin/membership-plans/[id]`).

**Invariants (violate = bug):**
- Plans are soft-deactivated only (DELETE sets `active=false`); never hard-delete
  — historical `customer_memberships` rows reference the plan id.
- `priceCents=0` is valid (free plan); `null` is not — the column is NOT NULL.
- `visitsPerYear=0` means billing-only (no auto-generated maintenance visits);
  the generate-membership-visits cron skips these plans. Don't treat 0 as
  unset.
- `benefits` is a nullable JSONB free-form field — keep null when no benefits
  are defined; write an empty object `{}` only if the schema explicitly allows it.
- `customerMemberships.membershipStatus` on the `customers` table is a DERIVED
  CACHE kept in sync with `customer_memberships` in the same `db.batch()` — any
  enrollment/cancellation mutation must update both tables atomically.
- `memberPriceCents` on `pricebook_items` (not this table) is what actually
  prices line items for members; plans define entitlements, pricebook items
  define the member rate.
- Compose `PageShell`, `PageHeader` from `src/components/admin/ui/`.

**Gotchas:**
- There is no server-side pagination here; the hook fetches all plans in one
  request. If plan counts grow large, add pagination before adding a client-side
  filter.
- The deactivate confirm dialog uses the same `ConfirmDialog` pattern as the
  pricebook page — both clear `deactivateError` when the dialog closes via the
  `onOpenChange` handler; preserve this or error state persists across opens.
- `billingPeriod` is an enum (`monthly`/`annual`/…); the form must only submit
  valid enum values — never send a free-form string.

**Verify changes:** `npx vitest run src/lib/admin/membership-queries.test.ts
src/lib/admin/membership-visit-queries.test.ts` · visual via admin-pages recipe.
