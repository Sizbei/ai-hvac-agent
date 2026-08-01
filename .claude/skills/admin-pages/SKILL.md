---
name: admin-pages
description: Use when working on ANY admin page — shared recipes (session mint, screenshots, gates, deploy), design-system rules, terminology canon, and repo-wide invariants the per-page skills reference.
---

# Admin pages — shared conventions and recipes

## Verify locally (visual)

1. Dev server: `npm run dev` — run it detached/background; never leave it
   running after you finish. `.env.local` is the DEV Neon branch — NEVER
   point it at prod (ep-withered-hill).
2. Session: `npx tsx scripts/agent/mint-admin-session.mjs` prints a JWT.
   The payload **must include `name`** — `verifyToken` rejects tokens
   without it (scripts handle this; hand-rolled mints often forget).
3. Screenshot: `node scripts/agent/screenshot-page.mjs /admin/<page> [width]`
   (1440 desktop, 390 mobile). LOOK at the image yourself before claiming
   visual success.
4. Dev-DB note: active dev requests carry seeded cached locations near the
   Johnson City base (label "dev seed", 2026-08-01) so map-adjacent pages
   show realistic pins. NEW unseeded test requests without a cached location
   are live-geocoded and fake addresses land in Manhattan — seed a
   customer_locations row (reuse the request's own address ciphertext) if
   that happens. Prod visuals: demo login (admin@demo-hvac.com / admin123).

## Gates (run before any commit)

- `npx tsc --noEmit` → 0 errors
- `npx eslint <changed files>` → 0 errors
- `npx vitest run` → capture the LIVE baseline first; it must not drop.
  No jsdom/RTL in this repo — pure-helper vitest only; component logic is
  tested by extracting pure functions.

## Deploy

`git push` does NOT reliably trigger builds — always
`vercel deploy --prod --yes`, then `bash scripts/agent/prod-smoke.sh`.
Migrations run in the Vercel build.

## Design system (compose, don't hand-roll)

Primitives in `src/components/admin/ui/` (PageShell, PageHeader, StatCard,
SectionCard, DataTableShell, Pager, TabGroup, SegmentedControl, InfoBanner,
ErrorState, SkeletonTable…). Status colors ONLY via
`src/lib/admin/status-colors.ts`. Bricolage Grotesque display font via
tokens; one cyan accent; oklch tokens in globals.

## Copy canon (enforced by review waves)

request (not job/booking — "Bookings" allowed only as the customer-profile
section title) · technician (not tech) · sign in (not login) · cancelled ·
Unicode … · sentence case (capitals only for brands/acronyms/24-7) · human
error copy ("Couldn't save X. Please try again."), never err.message or
"Unknown error" in UI.

## Repo-wide invariants

- Tenancy: every admin query scopes by the session's organizationId.
- Demo account (admin@demo-hvac.com): blocked from GDPR erase
  (super_admin gate) and outbound SMS (`isDemoAccount` in
  `src/lib/auth/authz.ts`) — deliberate, do not "fix".
- Money: synced invoices (fieldpulse_invoice_id / HCP source set) are
  read-only in money flows; money mutations are atomic/CAS-guarded.
- neon-http: `db.transaction()` throws — use `db.batch()` (also 1 HTTP
  round-trip vs Promise.all's N).
- Serverless background work: `after()` from next/server, never detached
  promises.
- FROZEN safety text in `src/lib/ai` prompts and the guardrail regexes in
  `src/lib/ai/output-guardrail.ts` must not be touched (chat streaming's
  safety proof depends on the regex shape — see page-chat skill).
