# Spec: portal (`/portal/[token]` · `/estimates/[token]` · `/review/[token]`)

## 1. Purpose

Three unauthenticated, token-addressed surfaces a customer reaches via a link
in a text/email — no login, no session. Portal (`/portal/[token]`) is the
account hub: invoices, estimates, upcoming jobs, service history, pay an open
balance. Estimates (`/estimates/[token]`) is the e-sign approval page for one
quote. Review (`/review/[token]`) collects post-job star feedback and always
offers the public review link. Audience: the org's own customers holding a
link they were sent — never staff, never an admin session.

## 2. Brainstorm

- **Stop leaking the bearer token to Vercel Analytics.** ACCEPTED → Rportal-1.
  The token is the customer's entire authority; it must not land in a
  telemetry store in cleartext on every page view.
- **Source "Service history" from real completed jobs.** ACCEPTED →
  Rportal-2. Wired to a table that's empty org-wide, silently lying to every
  customer.
- **Hide draft/unfinalized invoices from the customer.** ACCEPTED →
  Rportal-3. A `draft` invoice (native pre-send, or FieldPulse/HCP still in
  draft upstream) isn't a bill the business has committed to yet.
- **Give admins a real "revoke portal access" control.** ACCEPTED →
  Rportal-4. `revokePortalToken` exists and is fully dead code; the only
  control today (Rotate) always leaves a new active link.
- **Clickable deep link for "Awaiting your approval" estimate rows.**
  REJECTED — the plaintext approval token is deliberately never persisted
  post-creation (`src/lib/portal/portal-queries.ts:167-173`); reconstructing
  a link would mean storing plaintext (breaks the hashed-at-rest invariant)
  or minting a fresh one (kills the link already texted to the customer).
  The existing separate-send design is correct as built.
- **Auto-expire portal tokens after N idle days.** REJECTED — bigger design
  decision (grace period, re-issuance, notification) than this pass needs;
  solve the missing revoke lever (Rportal-4) first.
- **Rate-limit the public GET page loads.** REJECTED for this pass — 192–256
  bit tokens make brute force impractical; P2 backlog only.
- **Itemized line items / downloadable PDF for portal invoices.** REJECTED —
  no evidence of demand; adds a cost/SKU-redaction surface for a want, not a
  need.
- **Self-service reschedule/cancel from the portal.** REJECTED — no
  cancellation-policy logic exists anywhere yet; needs new admin rules first.
- **Session cookie instead of token-in-URL.** REJECTED — that's the entire
  point of the surface; rearchitecting it to fix an analytics leak is a
  bulldozer where a scalpel (Rportal-1) works.
- **Live technician-location/ETA on "Upcoming service."** REJECTED — no
  live-location feed exists to pull from; net-new feature, not a gap.
- **Pagination on the four portal lists.** REJECTED — residential customers
  accumulate a handful of records over years, not pages. YAGNI.

## 3. Current state

`verified` by reading the cited lines unless tagged `inferred`.

**Token model (shared pattern):** each surface has its own SHA-256-hashed
bearer token, looked up with no org filter (the hash is the authority):
portal on `customers.portalTokenHash` (`src/lib/portal/portal-queries.ts:131-145`,
`src/lib/db/schema.ts:785`), estimate on `estimates.approvalTokenHash`
(`src/lib/admin/estimate-queries.ts:695-710`), review on
`reviewRequests.reviewTokenHash` (`src/lib/reviews/review-queries.ts:228-238`).
Portal token = 32 random bytes (256-bit, `:37,72`), **no expiry** by design
(`src/lib/db/schema.ts:779-784`). Estimate/review tokens = `randomBytes(24)`
(192-bit, `src/lib/admin/estimate-queries.ts:59`,
`src/lib/reviews/review-queries.ts:118`) and self-invalidate on use (estimate
`open→sold`; review `→responded`). Every downstream read/write re-derives
org/customer from the resolved token row, never a client param — verified in
`payPortalInvoice` (`:350-366`) and `approveEstimate`
(`src/lib/admin/estimate-queries.ts:177-189`). None of the three GET page
routes are session-gated (`src/proxy.ts:144-146` matcher excludes them; they
hit the default pass-through branch, headers only). The POST mutation routes
ARE IP rate-limited 10/60s each (`.../pay/route.ts:33`,
`.../approve/route.ts:23`, `.../review/[token]/route.ts:32`); the GET page
loads carry no rate limit.

**Cost/PII discipline:** `getPortalData` never selects cost/margin fields
(full-file read, `src/lib/portal/portal-queries.ts:224-286`; header comment
`:9-21`). `loadOptionsWithLineItems` gates line-item cost behind
`includeCost`, and the public estimate read passes `false`
(`src/lib/admin/estimate-queries.ts:514-517,713-714`). Customer name is
decrypted server-side only (`:45-52,222`). Review `feedback` is never logged
— `recordReviewResponse` logs only `{ id, rating }`
(`src/lib/reviews/review-queries.ts:217-221`).

**Portal page:** async server component, `await params` (`:257`); invalid
token → generic "This link isn't valid" card (`:260-267`). Four sections:
Invoices, Estimates, Upcoming service, Service history (`:100-250`).
**Invoice query has no state filter** — `src/lib/portal/portal-queries.ts:225-235`
selects every state including `draft`; `payable` correctly gates the Pay
button to `state === "open"` (`:114`) but the draft row's existence/total
still renders. `draft` is reachable for synced rows, not just a transient
native default: FieldPulse's mapper can return `"draft"`
(`src/lib/integrations/fieldpulse/invoice-sync.ts:279-282,297-298`) and HCP's
mapper defaults unknown status to `"draft"`
(`src/lib/integrations/housecall-pro/invoice-sync.ts:28-29,45-48`).
**"Service history" is sourced from the `service_history` table**
(`src/lib/portal/portal-queries.ts:274-285`). `inferred` (prior documented
audit, memory `imported-data-display-and-agenda`, not re-queried live this
pass): that table is empty org-wide — already root-caused once for the admin
customer page and fixed there via `service_requests`
(`getCustomerBookings`, `src/lib/admin/queries.ts:1677`); portal's
`HistorySection` was never migrated to that fix, so it shows "No past
service on record." even for customers with real completed jobs.
`JobsSection` correctly filters to active statuses only (`:200-206`) — the
"Upcoming service" section itself is accurate. No `.limit()` on any of the
four list queries. Arrival windows format in
`BUSINESS_BASE_LOCATION.timezone`, not UTC (`:7,12,18-43`) — correct.

**Pay flow:** `PayButton` sends only `invoiceId`+`balanceCents`
(`pay-button.tsx:9-11`); org/customer re-derived server-side.
`payPortalInvoice` enforces exact full-balance payment only —
`amountCents !== balanceCents` → `amount_mismatch`
(`src/lib/portal/portal-queries.ts:370-376`), no partial payments. Payment is
best-effort audited (`.../pay/route.ts:106-121`). Mock payment seam (per
`page-portal` skill), not a live processor — unchanged here.

**Estimates page:** not-found / already-decided / expired each collapse to a
generic card, no detail leaked (`:30-59`). Options render with subtotal/tax/
total, no cost (`:80-120`). `ApproveForm` posts
`{token, optionId, signatureName}`; success swaps to a static confirmation,
no navigation. `approveEstimate` is status-guarded in its final `UPDATE...
WHERE` (`src/lib/admin/estimate-queries.ts:195-208`) so concurrent
double-submits can't both win; option ownership re-checked against the
resolved estimate's org (`:177-189`).

**Review page:** `responded` → thank-you + public link, no form (`:45-67`).
The public review URL is resolved and shown **identically regardless of
rating** — no sentiment branch in any of `page.tsx`/`review-form.tsx`/the
POST route (full read of all three). `recordReviewResponse` is
idempotency-guarded (second submit on a `responded` row updates zero rows,
returns `already_responded`, `:189-214`); the client treats that 409 the
same as success (`review-form.tsx:44-46`) — correct per the no-gating
requirement.

**Analytics leak (all three surfaces):** `src/app/layout.tsx:30` renders
`<Analytics/>` from `@vercel/analytics/next` in the ROOT layout; no nested
`layout.tsx` exists under `app/portal`, `app/estimates`, or `app/review` to
override it. Reading the installed package
(`node_modules/@vercel/analytics/dist/next/index.mjs:221-232`): `useRoute()`
takes `path = usePathname()` (the raw pathname, e.g. `/portal/a1b2c3...`) and
separately computes a masked `route` via `computeRoute()` (`:50-77`). **Both
are sent together** — `pageview({ route, path })`
(`:172-178,213-217`) — so the raw, unmasked `path` containing the full
plaintext bearer token reaches Vercel's analytics collector on every page
view. `verified` against the package source; `inferred` that this reaches
Vercel's collection endpoint in production (network traffic not inspected
this pass).

## 4. Gaps

| Gap | Severity | Evidence |
|---|---|---|
| Full plaintext bearer token (portal: 256-bit non-expiring pay-capable; estimate/review: 192-bit) sent to Vercel Analytics in cleartext via `path` on every page view — root layout's `<Analytics/>` has no opt-out for tokenized routes | P0 | `src/app/layout.tsx:30`; `node_modules/@vercel/analytics/dist/next/index.mjs:172-178,213-232`; no `layout.tsx` under `app/portal`\|`app/estimates`\|`app/review` |
| "Service history" sourced from `service_history`, empty org-wide per prior audit — silently shows "No past service on record." even for customers with real completed jobs, instead of `service_requests` (status=`completed`) like the admin page's already-shipped fix | P0 | `src/lib/portal/portal-queries.ts:274-285`; `src/lib/admin/queries.ts:1677` (`getCustomerBookings`); memory `imported-data-display-and-agenda` (`inferred`, not re-queried live) |
| Invoice query has no state filter — customers see `draft` invoices (unfinalized native, or FieldPulse/HCP still draft upstream) with a dollar total before the business has committed to the bill | P1 | `src/lib/portal/portal-queries.ts:225-235` (no `state` predicate); `src/lib/integrations/fieldpulse/invoice-sync.ts:279-282,297-298`; `src/lib/integrations/housecall-pro/invoice-sync.ts:28-29,45-48` |
| `revokePortalToken` is dead code — admins cannot disable portal access; only control (`PortalLinkCard`) is Generate/Rotate, always leaving a new active link | P1 | `src/lib/portal/portal-queries.ts:107-117`; zero call sites via `grep -rn "revokePortalToken" src`; `src/components/admin/portal-link-card.tsx:112-124`; `.../portal-token/route.ts` has only `POST`, no `DELETE` |
| Public GET page loads carry no rate limit, unlike their POST siblings | P2 | `src/proxy.ts:144-146`; `.../pay/route.ts:33` vs. no equivalent on the page route |
| Portal's four lists are unbounded — no `.limit()` on any query | P2 | `src/lib/portal/portal-queries.ts:224-286` |

## 5. Requirements

- **Rportal-1**: None of the three pages may transmit the raw token to
  Vercel Analytics — exclude `<Analytics/>` from these route subtrees, or
  redact `path`/`url` via `beforeSend` before it leaves the browser.
  **Acceptance:** load `/portal/<real-token>` with devtools Network open;
  no request to `/_vercel/insights/*` contains the literal token. Add a
  pure-helper test covering the redaction/exclusion logic for all three
  prefixes.
- **Rportal-2**: Portal's history reflects real completed jobs — source from
  `service_requests` (status=`completed`), mirroring `getCustomerBookings`,
  instead of (or with documented precedence over) `service_history`.
  **Acceptance:** a case in `portal-queries.test.ts` seeds a completed
  `service_requests` row + empty `service_history` and asserts
  `getPortalData(...).history` is non-empty.
- **Rportal-3**: Invoice query excludes `state = 'draft'`. **Acceptance:** a
  case in `portal-queries.test.ts` seeds one `draft` + one `open` invoice for
  the same customer and asserts only the `open` row is returned.
- **Rportal-4**: A working revoke path — admin-gated route/action calling
  `revokePortalToken`, plus a "Disable link" control in `PortalLinkCard`
  distinct from "Rotate." **Acceptance:** a test proves
  `resolvePortalToken(oldToken)` returns `null` after revoke, and the
  customer detail page shows a disabled state without requiring a new link.

Only P0/P1 gaps become requirements; the two P2 items stay backlog.

## 6. Non-goals

- Real payment processor integration — documented mock seam; separate spec.
- Auto-expiry/TTL for the portal token — Rportal-4 gives an explicit revoke
  lever; time-based expiry is a bigger decision for later.
- Rate limiting the three public GET routes — token entropy makes brute
  force impractical; P2 backlog only.
- Pagination on the portal's four lists — no evidence of need.
- Itemized line items / downloadable PDF for portal invoices.
- Clickable in-portal deep link for "Awaiting your approval" — the
  separately-sent e-sign link at creation time is the correct, working path.
- Self-service reschedule/cancel, live technician tracking, multi-tenant
  review-provider config — net-new features with no existing plumbing.

## 7. Invariants

- **Token is the sole authority** — org/customer IDs derive only from the
  resolved token row, never a client param. Source:
  `src/lib/portal/portal-queries.ts:14-17`, `page-portal` skill:36-38.
- Internal cost/margin fields never enter a portal/estimate-approval
  payload. Source: `portal-queries.ts:18-21`,
  `estimate-queries.ts:467-468,510-517`. Rportal-2/3 must not add a query
  path that leaks cost.
- Portal tokens are SHA-256 hashed at rest; plaintext shown once, then
  unrecoverable; rotate overwrites instantly. Source: `schema.ts:779-784`.
  Rportal-4's revoke must clear the hash the same way.
- Review page offers the public link to EVERY respondent regardless of
  rating (FTC/Google ToS). Source: `review/[token]/page.tsx:39-42`,
  `review-queries.ts:11-13`. Not touched by this spec; must not regress.
- Arrival windows render in `BUSINESS_BASE_LOCATION.timezone`, never UTC.
  Source: `portal/[token]/page.tsx:10-12`.
- Estimate approval stays gated on `status === 'open'` and unexpired
  `expiresAt`. Source: `estimates/[token]/page.tsx:39-59`.
- `params` is a `Promise` — always `await params` first.
- Review `feedback` free text is never logged. Source:
  `review-queries.ts:216-221`.
- Every downstream read/write re-verifies (org, customer)/(org, estimate)
  ownership even though the token lookup has no org filter — defense in
  depth already in `payPortalInvoice`/`approveEstimate`; Rportal-2/3 must
  preserve this.
- No jsdom/RTL — cover Rportal-1/2/3 changes with pure-helper vitest only.

## 8. Verification

1. `npx tsc --noEmit` → 0 errors.
2. `npx eslint <changed files>` → 0 errors.
3. `npx vitest run` → must not drop below the captured baseline (297 files ·
   4022 passed · 1 skipped, per `docs/page-program/README.md`).
4. `npx vitest run src/lib/portal/portal-queries.test.ts` → covers Rportal-2
   and Rportal-3.
5. `npx vitest run src/lib/reviews/review-queries.test.ts` → confirm no
   regression.
6. Rportal-1: these pages are unauthenticated, so
   `scripts/agent/screenshot-page.mjs` (admin-session-based) doesn't apply.
   Instead: `npm run dev` (background), mint a real portal/estimate/review
   token, load each page with devtools Network open, confirm no
   `/_vercel/insights/*` request body contains the literal token.
7. Rportal-4: via the admin UI, generate a portal link, use "Disable link,"
   confirm the old `/portal/<token>` URL now renders "This link isn't
   valid" (`portal/[token]/page.tsx:260-267`).
8. `node scripts/agent/verify-skills.mjs` → 0 missing; update
   `.claude/skills/page-portal/SKILL.md` in the same commit if paths, the
   history source, the invoice filter, or the revoke control change, then
   re-run.
