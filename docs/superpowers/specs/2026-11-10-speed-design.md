# Admin speed — design v3

Date: 2026-11-10 · Status: v3 after adversarial rounds 1–2 (feasibility +
scope). Companion to `2026-11-10-spears-go-live-design.md`.

## Why
The client says every click "takes a second for any data or the page to load".
Round-0 (from Tokyo; prod `iad1`, Neon `us-east-1`): warm server work is small;
the felt cost is a client waterfall (page segment fetch, then the client hook's
`/api/admin/*` fetch), occasional cold starts (1.5–2 s), large list payloads
(invoices ~92 KB, requests ~40 KB per page), and 26 admin routes with **no
`loading.tsx`**, so a click shows nothing until the server answers.

## Goals
1. Every navigation shows the page frame instantly.
2. Less data on the wire for the heaviest lists.
3. Numbers before and after, from a real time-to-first-row metric.
4. Nothing risky ships in the go-live deploy.

## Non-goals
Server-seeded first page (S2 in v1 — **deferred**: ~40–80 ms gain for a US
user against a refactor of money-adjacent list queries and the
`useUrlFilterSync` first-key mismatch); cross-request caching; credentialed
warmers; DB region moves.

## Design
### S1 — Measure (Playwright)
`scripts/agent/measure-latency.mjs`: mints a dev session, opens each admin page
in headless Chromium against a base URL, records time to navigation commit and
time to the first data row/empty state in the DOM (a stable selector per page),
×5, prints p50/p90. Run against `next build && next start` locally (relative
numbers) and, after deploy, prod (the user's real experience).

### S2 — Instant frame
One generic `src/app/admin/(dashboard)/loading.tsx` (header + panel skeleton
from existing primitives) covering every route without its own; dedicated
skeletons only for Dashboard, Calendar, Estimates and Customers detail if the
generic one shifts their layout visibly. Skip `map` (gated off).

### S3 — Payload trims
List endpoints `/api/admin/invoices`, `/api/admin/requests` (then customers,
estimates if large) stop returning fields the list UI doesn't render (e.g.
`fieldpulseData` blobs); detail endpoints unchanged. Verified by grepping each
list component's field usage; contract tests on the trimmed shape.

### S4 — Serial client chains
Find fetch chains on Dashboard, Requests, Invoices, Customers, Dispatch where a
second request waits on the first without needing its result (e.g. invoices
page → `/api/admin/payments/reconcile`); run them in parallel or defer
non-critical ones until after first paint.

### S5a — Localhost (honest expectation)
`next dev` compiles each route on first visit and every DB query crosses the
Pacific from this machine (~130 ms each), so localhost will never feel like
prod. Do what is cheap: confirm Turbopack dev and its filesystem cache are on
(check `node_modules/next/dist/docs/` for the Next 16 option), and report dev
numbers separately from prod. Say this plainly to the user.

### S5 — Cold starts
Report the project's Vercel compute mode (Fluid or not) and function memory for
the user to check; keep-warm unchanged (unauthenticated pings can't warm admin
pages).

## Notes
- S3 edits the same list queries as go-live P6 — run it after P6, not in
  parallel.
- Measure as both rchen (all rows) and Chick (preview; hidden rows excluded).

## Success
Before/after table (local prod-build and prod): every route shows a frame
< 100 ms after click locally; Requests/Invoices time-to-first-row p50 improves;
no route regresses; gates green.
