# Spec: reviews (`/admin/reviews`)

## 1. Purpose

Lets an operator monitor the outbound review-request pipeline: how many
post-job review asks went out, how many customers responded, the average
rating, and whether responders clicked through to the public review
platform. Audience: owner/office staff checking reputation health and
deciding whether to follow up with an unhappy customer.

## 2. Brainstorm

Ideas considered for a great version of this page, including rejected ones:

- **Surface the private written feedback text in the admin UI.** ACCEPTED
  — becomes Rreviews-1. Customers are explicitly asked "anything you'd like
  to share?" but the answer is currently unreadable by anyone. Wasted
  signal.
- **Show which customer/service request each review row belongs to.**
  ACCEPTED — becomes Rreviews-2. Without this an operator who sees a 1-star
  row can't identify or follow up with that customer.
- **Close the demo-account outbound-SMS gap in the automated review-request
  path.** ACCEPTED — becomes Rreviews-3. The two other outbound-send-safety
  checks in the repo are route-local; this pipeline has none at all.
- **Manual "send"/"resend" button** for a stuck request. REJECTED — the
  page's own empty-state copy and page skill declare requests are
  automatic-only; the per-job idempotency (ledger claim + partial unique
  index) is built around "created exactly once," and a manual trigger needs
  new override semantics nobody has asked for. YAGNI.
- **Sentiment-based routing** (hide the public link from low raters).
  REJECTED — explicitly forbidden by FTC/Google ToS; multiple existing
  comments already guard against this. Never build it.
- **Reply-to-feedback / moderation tools.** REJECTED — no evidence of
  demand; feedback is a one-way private input by design, and a reply
  workflow is a distinct CRM-ticket-like feature beyond this page's scope.
- **Second review-platform selector (Yelp/BBB) in the UI.** REJECTED — the
  provider seam (`review-provider.ts`) already supports swapping the single
  configured link via an env var; a picker UI is speculative configurability.
- **Trend chart / date-range filter on the stat cards.** Real gap (can't
  tell if ratings trend up/down) but kept P2 backlog — flat totals are
  still honest/actionable at small-business volume; a chart is polish.
- **Fix the schema's unreachable `pending` status.** Real but purely
  cosmetic/dead-code — no operator-visible behavior change. P2 backlog.
- **Add token expiry to the public review link.** Considered, but the
  token is 192-bit unguessable and dedupe already blocks re-submission
  after a response; touches public schema outside this page. Deferred, P2.

## 3. Current state

All claims `verified` by reading the cited files unless tagged `inferred`.

- Page: `src/app/admin/(dashboard)/reviews/page.tsx` — client component, 3
  `StatCard`s (avg rating, requests sent, response rate) plus one table
  (`:93-172`). Table columns are exactly: Status, Rating, Public link
  clicked, Sent, Responded (`:124-129`) — no customer, no service-request
  link, no feedback text anywhere in the render.
- Hook `src/hooks/use-reviews.ts`: `useReviews({ page })` fetches
  `/api/admin/reviews`, monotonic run-counter drops stale responses
  (`:47,62`). `ReviewRow` (`:6-15`) has `serviceRequestId` but it's used
  only as the React `key` (`page.tsx:152`), never rendered or linked.
- API `src/app/api/admin/reviews/route.ts`: `getAdminSession` gate
  (`:10-13`), sliding-window rate limit (`:15-21`), calls
  `listReviews`/`getReviewStats` in parallel (`:30-33`).
- Query layer `src/lib/reviews/review-queries.ts`:
  - `listReviews` (`:258-301`) is tenant-scoped (`withTenant`, `:266`),
    paginated at 50/page. Its `SELECT` (`:271-280`) has no join to
    `customers` — no name is fetched, matching the API/UI never surfacing
    one.
  - `getReviewStats` (`:313-333`) computes count/responded/avgRating via one
    aggregate `FILTER(WHERE)` query, tenant-scoped.
  - `createReviewRequest` (`:86-159`) is the sole creation path. Idempotent
    via `claimOutboundOnce({periodKey: "review:{serviceRequestId}"})`
    (`:97-105`, unique index in `outbound-ledger.ts:19-36`) plus a DB
    partial unique index on `service_request_id` (`schema.ts:3096-3098`).
    Skips (no row, no send) when there is no `customerId` (`:92-94`), no
    active `review_request` SMS template (`:107-110`), or no decryptable
    phone (`:112-115`) — none of these skips write any log/row/UI signal.
  - Row is inserted with `status: "sent"` directly (`:125`) — the schema's
    `pending` enum value (`schema.ts:1757-1760`, comment at `:1755-1756`
    describing a pending→sent→responded lifecycle) is never actually
    written. `inferred`: no other writer of `reviewRequests.status` exists.
  - `recordReviewResponse` (`:172-222`) is concurrency-guarded (`WHERE id
    = ... AND status = existing.status`, `:204-209`). Logs `rating` only,
    never `feedback` (`:216-220`, matching the PRIVATE comment at
    `:13,3081-3082`).
  - `feedback` column (`schema.ts:3082`, "PRIVATE ... must NEVER be
    logged") is written on response but never read back by `listReviews`,
    the API route, `use-reviews.ts`, or `page.tsx`. `grep -rn "\.feedback\b"`
    under `src/lib/admin`, `src/app/api/admin`, `src/components/admin`
    returns zero matches — `request-detail-sheet.tsx` also has no
    review reference (its only `"review"` hit is an unrelated "preview"
    substring).
- Trigger call site `src/app/api/tech/jobs/[id]/status/route.ts:94-105`: a
  **technician** session (`getTechSession`, `:31`), not an admin session,
  calls `createReviewRequest` inside `after()` on completion. No
  `isDemoAccount`/demo check anywhere in this route.
- Outbound safety: `isDemoAccount` (`authz.ts:19-26`, checks
  `session.email === "admin@demo-hvac.com"`) is referenced in exactly two
  files — `invoices/[id]/send-reminder/route.ts:31` and
  `conversations/[id]/message/route.ts:37` — both admin-session-gated,
  manually-triggered sends (`grep -rn "isDemoAccount"` confirms no third
  call site). `checkSendAllowed` (`consent.ts:120-171`, the documented
  single "send chokepoint," `:1-13`) checks only per-customer
  `communicationPreferences` — no organization/demo check. `sendSms`
  (`twilio-adapter.ts`, read in full) has no demo/org check either.
  `prod-smoke.sh:26-27` smoke-tests "demo SMS blocked" only against the
  conversations-message route — no probe covers job-completion →
  review-request.
- Public token page (`src/app/review/[token]/page.tsx` + `review-form.tsx`
  + `src/app/api/review/[token]/route.ts`): token is `randomBytes(24)`
  (192 bits, `review-queries.ts:118`), only its sha256 stored (`:29-31,126`),
  bearer-authorized, IP-rate-limited at 10/min (`route.ts:32`). No
  `expiresAt` column exists on `reviewRequests` (`schema.ts:3063-3100`, full
  block read). Public link shown to every responder regardless of rating —
  verified in `review-form.tsx:14-19,57-76`, `[token]/route.ts:6-9,64-67`,
  `[token]/page.tsx:39-43`.
- Review-provider seam `src/lib/reviews/review-provider.ts`: mock Google
  "write a review" link unless `GOOGLE_REVIEW_URL` is set, loud
  `console.warn` when it isn't (`:53-64`).
- Dead/unrelated code nearby: `triggerJobCompleted`
  (`src/lib/communication/triggers.ts:402-517`) takes a `reviewLink` param
  but `grep -rn "triggerJobCompleted("` finds only its own definition —
  zero callers. Separate, unused review-adjacent flow; not touched here.
- Tests: `review-queries.test.ts` (idempotency, no-customer skip, response
  recording incl. low-vs-high rating, stats) and
  `review-list-pagination.test.ts` (pagination, tenant scoping) — pure-mock
  unit tests, no jsdom.

## 4. Gaps

| Gap | Severity | Evidence |
|---|---|---|
| Private customer feedback text is captured but never surfaced anywhere in the admin UI — the most actionable part of a review response is write-only | P1 | `src/lib/db/schema.ts:3082`; `review-queries.ts:172-222` (writes, never returns feedback); `use-reviews.ts:6-15` (`ReviewRow` has no `feedback` field); `page.tsx:120-172` (no feedback column/detail); `grep -rn "\.feedback\b"` under admin lib/api/components → 0 hits |
| Review rows are anonymous: no customer name and no link to the customer profile or originating request, despite `serviceRequestId` being fetched | P1 | `use-reviews.ts:8` (`serviceRequestId` in type); `page.tsx:151-167` (rendered row has no name/link, `serviceRequestId` used only as React key at `:152`); `review-queries.ts:271-280` (`listReviews` SELECT has no customer join) |
| The automated review-request send path has no demo-account guard, unlike the two other manually-triggered outbound routes | P1 | `authz.ts:19-26` + only 2 call sites (`send-reminder/route.ts:31`, `conversations/[id]/message/route.ts:37`); `tech/jobs/[id]/status/route.ts:94-105` calls `createReviewRequest` with no demo check; `consent.ts:120-171` (`checkSendAllowed`, the documented send chokepoint) checks only per-customer prefs; `prod-smoke.sh:26-27` only probes the conversations route |
| Silent request-creation skips (`no_phone`, `no_template`) are invisible to the operator — a completed job can quietly never get a review ask with zero UI/log signal | P2 | `review-queries.ts:74-77,92-94,108-110,112-115` (skip reasons returned to caller only); caller (`tech/jobs/[id]/status/route.ts:98-103`) only logs on a thrown error, not on a returned skip reason; no row exists to show "skipped" in `listReviews` |
| Schema's `pending` status is unreachable dead state — every row is inserted directly as `sent` | P2 | `review-queries.ts:125` (`status: "sent"` on insert); `schema.ts:1755-1760` (comment describes pending→sent→responded); `page.tsx:27-37` still renders a `pending` badge variant that can never appear |
| Status badge colors are a page-local inline map instead of the shared registry every other admin list uses | P2 | `page.tsx:27-31` (`REVIEW_STATUS_CLASS`); `.claude/skills/admin-pages/SKILL.md:44-46` ("Status colors ONLY via `src/lib/admin/status-colors.ts`"); `src/lib/admin/status-colors.ts` has no reviews entry (confirmed by reading the file's exports) |
| No period/trend view — three flat lifetime totals only, no way to see whether ratings/response rate are improving | P2 | `page.tsx:93-116` (three static `StatCard`s, no date-range control anywhere on the page) |
| Unused, review-adjacent dead code left in the codebase (`triggerJobCompleted`) | P2 (`inferred` scope note) | `triggers.ts:402-517`; zero callers via `grep -rn "triggerJobCompleted("` |

## 5. Requirements

- **Rreviews-1**: Operators can read a responded review's private feedback
  text from the admin UI. Add `feedback` to the `listReviews` result (still
  never logged) and render it per-row (e.g. an expandable detail, so the
  table still scans as status/rating only). **Acceptance:** a review with
  `status = 'responded'` and non-null `feedback` shows that exact text
  after expanding the row; a responded row with null feedback shows no
  feedback UI; `grep` confirms `feedback` stays absent from any `logger.*`
  call in `review-queries.ts`.
- **Rreviews-2**: Each review row identifies the customer and links to
  their existing admin profile, so an operator seeing a low rating can
  follow up. **Acceptance:** `listReviews` fetches the decrypted customer
  name (tenant-scoped, pattern of `getCustomerContact`,
  `review-queries.ts:34-56`); `page.tsx` renders it as a link to the
  customer's admin page for every row with a `customerId`; a row with a
  null `customerId` renders a plain dash, not a broken link.
- **Rreviews-3**: The demo organization can never trigger a real Twilio SMS
  send via the job-completion → review-request pipeline. **Acceptance:**
  `createReviewRequest` (or a check it calls) short-circuits with
  `created: false` and enqueues no `communicationJobs` row for the demo
  org; a new `review-queries.test.ts` case covers this skip; the existing
  duplicate/no_phone/no_template skip contract is unchanged for other orgs.

No P0s were found — the page renders correctly, is tenant-scoped, paginates
server-side, and the anti-review-gating compliance behavior is solid. G4-G8
remain P2 backlog, not required in this pass.

## 6. Non-goals

- No manual "send"/"resend" button — automatic-only creation is an existing,
  deliberate invariant (see Brainstorm); none of Rreviews-1..3 adds one.
- No sentiment-based routing or hiding the public link from low raters —
  forbidden by FTC/Google ToS; must not regress under any requirement here.
- No reply-to-feedback/moderation workflow — feedback stays a one-way input;
  Rreviews-1 only makes it *readable*, not a two-way thread.
- No multi-platform (Yelp/BBB) review-link selector — the existing
  single-URL provider seam is untouched.
- No trend chart / date-range filter (G7) and no fix to the dead `pending`
  status or `triggerJobCompleted` dead code (G5, G8) — cosmetic/out-of-scope;
  `triggerJobCompleted` belongs to communications/triggers, not this page.
- No centralizing `REVIEW_STATUS_CLASS` into `status-colors.ts` (G6) —
  pure polish, left as backlog so the diff for Rreviews-1..3 stays surgical.
- No silent-skip visibility/telemetry for `no_phone`/`no_template` (G4) —
  real but lower-value; a template is seeded by default
  (`src/lib/communication/seeds.ts:170-173`), and `no_phone` skips are
  idempotent (jobs don't re-fire once completed).
- No token-expiry addition to the public review link — token is
  effectively unguessable and dedupe already blocks reuse after a response.

## 7. Invariants

- Tenancy: every reviews query (list, stats, the new customer-name fetch in
  Rreviews-2) stays scoped by `organizationId` via `withTenant` — same
  pattern as `review-queries.ts:44,266,324`. Prevents cross-org data leaks.
- No sentiment routing, ever: the public review link is offered to every
  responder regardless of rating (`review-form.tsx`, `[token]/route.ts`,
  `[token]/page.tsx`) — FTC/Google ToS. Rreviews-1 must not introduce any
  branch that treats low vs. high ratings differently.
- `feedback` is PRIVATE free text and must NEVER be logged
  (`schema.ts:3081-3082`, enforced at `review-queries.ts:216-220`) —
  Rreviews-1 adds a *read* path only, never passes `feedback` to `logger.*`
  or any telemetry call.
- Idempotent-per-completed-job creation (outbound ledger claim +
  `service_request_id` partial unique index, `outbound-ledger.ts:19-36` +
  `schema.ts:3096-3098`) is the single source of truth for "already asked"
  — Rreviews-3's demo-org check must short-circuit *before* this claim (no
  ledger row burned for a demo no-op) without weakening it for real orgs.
- Automatic-only creation: no manual "send review request" trigger exists
  or should be added (page skill's stated invariant; empty-state copy at
  `page.tsx:146`).
- Status values must exactly match `reviewRequestStatusEnum`
  (`pending`/`sent`/`responded`) — `schema.ts:1757-1760`.
- `responseRate` stays division-by-zero-safe (`page.tsx:70-73`, `0` when
  `count` is `0`) if any requirement touches the stats rendering.
- Demo account (`admin@demo-hvac.com`): already blocked from GDPR erase and
  the two ad-hoc outbound-SMS routes (`authz.ts:19-26`, `AGENTS.md`) —
  Rreviews-3 *extends* this to a third, previously-unguarded send path
  without weakening the existing two checks.
- neon-http: no `db.transaction()` — new joins/queries for Rreviews-1/2
  use plain `db.select()`/`db.batch()`, per `AGENTS.md`.
- Background work for the review-request enqueue stays inside `after()`
  (`tech/jobs/[id]/status/route.ts:97`) — a comms failure must never fail
  the status-change response that already committed.
- FROZEN safety text / `output-guardrail.ts` regexes are untouched — this
  page has no AI-generation path.

## 8. Verification

1. `npx tsc --noEmit` → 0 errors.
2. `npx eslint <changed files>` → 0 errors.
3. `npx vitest run` → must not drop below the captured baseline (297 files
   · 4022 passed · 1 skipped, per `docs/page-program/README.md`). Extend
   `review-queries.test.ts`: `listReviews` returns `feedback` (Rreviews-1)
   and a customer name (Rreviews-2) for a responded row; `createReviewRequest`
   short-circuits with no `communicationJobs` insert for the demo
   organization (Rreviews-3).
4. Visual: `npm run dev` (background) + mint an admin session + `node
   scripts/agent/screenshot-page.mjs /admin/reviews 1440` and `... 390` —
   confirm the customer-name link and feedback-expand affordance render
   correctly at both widths, and a no-feedback row shows no broken control.
5. Demo-safety check for Rreviews-3: the trigger is technician-owned, not
   admin-session-based, so verify via the unit test in step 3 rather than
   `prod-smoke.sh` (which only holds an admin-session cookie); if a demo-org
   technician fixture exists, additionally confirm no new row appears in
   `communication_jobs` after completing a demo-org job.
6. `node scripts/agent/verify-skills.mjs` → 0 missing paths (re-run once
   `page-reviews` SKILL.md is updated for any new files/columns).
