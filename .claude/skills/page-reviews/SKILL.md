---
name: page-reviews
description: Use when working on the /admin/reviews page — post-job review requests dashboard with average rating, send count, and response rate.
---

# Reviews (/admin/reviews)

**Purpose:** operators monitor the outbound review-request pipeline: how many
requests were sent, how many customers responded, what the average rating is,
and whether a public link was clicked.

**Files:** page `src/app/admin/(dashboard)/reviews/page.tsx` · hook
`src/hooks/use-reviews.ts` · API `src/app/api/admin/reviews/route.ts` · table
`review_requests`.

**Data flow:** `useReviews({ page })` fetches `/api/admin/reviews` with a
monotonic run-counter (latest-wins) to drop stale responses on rapid page
changes. Server-paginated at 50/page. Stats (`avgRating`, `count`, `responded`)
are aggregated in the API query. No polling — manual page navigation.

**Invariants:**
- Review requests are created automatically when a job is completed — there is
  no manual "send" button on this page (the empty state copy says exactly this).
- Status values: `pending` · `sent` · `responded` — must match the enum in
  `review_requests` schema exactly.
- `responseRate` is computed client-side: `Math.round((responded / count) * 100)`;
  returns 0 when count is 0 to avoid division by zero.
- Status badge colors come from inline class maps (`REVIEW_STATUS_CLASS`) aligned
  with the design-system token set — use `src/lib/admin/status-colors.ts` for
  any new status variants; do not hard-code raw Tailwind colors.
- Tenancy: the API query scopes all rows by `session.organizationId`.

**Gotchas:**
- `publicClicked` is a boolean on `review_requests` — indicates whether the
  customer clicked through to the public review link (e.g. Google). It does not
  mean they left a review on the external platform.
- Average rating tracks only responses that include a numeric rating; nulls
  are rendered as `—` via `Stars`.
- No write operations on this page — it is read-only.

**Verify changes:** `npx vitest run` (no dedicated test file; hook logic is
pure-function only). Visual via admin-pages recipe (`/admin/reviews`).
