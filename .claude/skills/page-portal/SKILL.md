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
- Shared: analytics masking `src/lib/analytics-path.ts` (pure) + client wrapper
  `src/components/masked-analytics.tsx`, mounted in `src/app/layout.tsx`

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
- **Token stays out of analytics:** for `/portal/[token]`, `/estimates/[token]`,
  `/review/[token]` and `/admin/invite/[token]` the path segment IS the
  credential — `MaskedAnalytics`
  (root layout) feeds `beforeSend` through `maskTokenPath`, which rewrites the
  token segment to `[token]` and drops query/hash, before Vercel Analytics
  ever sees it. It has to be a client wrapper (`'use client'`) because
  `beforeSend` is a function prop and the root layout is a Server Component —
  a nested layout can't remove the `<Analytics/>` the root already emits, so
  masking (not scoping-away) is the only feasible fix. Never swap
  `MaskedAnalytics` back for a bare `<Analytics/>`. `TOKEN_ROUTE_PREFIXES`
  holds segment paths (so nested routes like `admin/invite` work) and MUST
  gain an entry whenever a new `[token]` page route is added — a missing entry
  silently ships that credential.
- Portal history is sourced from `service_requests` (`status = 'completed'`),
  NOT the `service_history` table — that table is empty org-wide (same bug
  already fixed on the admin customer page via `getCustomerBookings`). Draft
  invoices (`state = 'draft'`, native pre-send or still-draft upstream) are
  excluded from the portal's invoice list — never a bill the business has
  committed to yet.

**Gotchas:**
- `params` is a `Promise` (this Next.js version) — always `await params` before
  destructuring in server components.
- `private feedback` on the review form is NEVER logged (see review-queries.ts comment
  on FTC/Google ToS). Do not accidentally add logging of the feedback field.
- The portal pay seam (`/api/portal/[token]/pay`) is a mock payment path — no real
  payment processor is wired; do not treat it as production billing.
- **Pay gate (M3b):** while `cardPaymentsEnabled()` is false (the mock
  provider) the pay route answers 409 `CARD_PAYMENTS_UNAVAILABLE` "Online
  payment isn't available yet." right after the rate check, BEFORE
  `resolvePortalToken`, so the gate never hits the token table. The page hides
  Pay now and shows `portalPaymentNotice` (`src/lib/portal/portal-notice.ts`,
  pure): "Pay your technician in person.", or "Pay your technician in person,
  or call <phone>." with a `tel:` link (`telHref`) when the org's
  `businessInfo.phone` is set. The technician's SMS pay link lands here, so it
  says "view", never "pay".

**Verify changes:**
- `npx vitest run src/lib/portal/portal-queries.test.ts`
- `npx vitest run src/lib/reviews/review-queries.test.ts`
- `npx vitest run src/lib/analytics-path.test.ts`
- `npx vitest run src/lib/portal/portal-notice.test.ts tests/api/portal-pay-route.test.ts`
- Gate: `npx tsc --noEmit`
