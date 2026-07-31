---
name: page-portal
description: Use when working on /portal/[token], /estimates/[token], or /review/[token] — tokenized customer-facing pages; the token is the sole authority.
---

# Portal (/portal/[token] · /estimates/[token] · /review/[token])

**Purpose:** public, no-login customer surfaces. Portal shows invoices, estimates,
upcoming jobs, and service history; customers can pay an open invoice balance.
Estimates lets a customer review options, choose one, and e-sign to approve.
Review collects post-job satisfaction feedback and always offers a public review link.

**Files:**
- Portal: page `src/app/portal/[token]/page.tsx` · pay button
  `src/app/portal/[token]/pay-button.tsx` · queries
  `src/lib/portal/portal-queries.ts` · pay route
  `src/app/api/portal/[token]/pay/route.ts`
- Estimates: page `src/app/estimates/[token]/page.tsx` · approval form
  `src/app/estimates/[token]/approve-form.tsx` · queries
  `src/lib/admin/estimate-queries.ts` · approve route
  `src/app/api/estimates/approve/route.ts`
- Review: page `src/app/review/[token]/page.tsx` · review form
  `src/app/review/[token]/review-form.tsx` · queries
  `src/lib/reviews/review-queries.ts` · review route
  `src/app/api/review/[token]/route.ts`

**Data flow:** all three pages are async server components. The token arrives as a
route param (a `Promise` in this Next.js version — `await params`). Each page
resolves the token server-side against its hashed-token column; on ANY failure it
renders a generic error card (no detail about why). Portal then fetches customer data
scoped to the `(organizationId, customerId)` from the token row only. Estimates
checks `status === 'open'` and `expiresAt` before rendering the approve form.
Review checks `status === 'responded'` to show the already-recorded state.

**Invariants:**
- **Token IS the authority** — org and customer IDs come ONLY from the token row, never
  from query params or the client. `portal-queries.ts` comment: "resolvePortalToken
  is the ONLY authority."
- Internal cost fields (`costCents`, `unitCostCents`, margins) are NEVER selected into
  portal payloads — customers must not see cost.
- Portal token is SHA-256 hashed at rest (plaintext returned to admin once, then
  unrecoverable). Rotating overwrites the hash instantly.
- Review page MUST offer the public review URL to ALL respondents regardless of rating
  (FTC / Google ToS compliance — no sentiment routing). The public URL is resolved via
  `getReviewProvider().getPublicReviewUrl('self')`.
- Arrival windows are formatted in the BUSINESS timezone (`BUSINESS_BASE_LOCATION.timezone`,
  America/New_York) — never in UTC or server TZ.
- Estimate approval is gated: `status !== 'open'` or `expiresAt` past → generic error
  card, form never renders.

**Gotchas:**
- `params` is a `Promise` (this Next.js version) — always `await params` before
  destructuring in server components.
- `private feedback` on the review form is NEVER logged (see review-queries.ts comment
  on FTC/Google ToS). Do not accidentally add logging of the feedback field.
- The portal pay seam (`/api/portal/[token]/pay`) is a mock payment path — no real
  payment processor is wired; do not treat it as production billing.

**Verify changes:**
- `npx vitest run src/lib/portal/portal-queries.test.ts`
- `npx vitest run src/lib/reviews/review-queries.test.ts`
- Gate: `npx tsc --noEmit`
