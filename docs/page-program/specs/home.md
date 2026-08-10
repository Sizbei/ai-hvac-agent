# Spec: home (`/`)

## 1. Purpose

The public marketing/landing page for Spears Services. Its one job: convince a
visitor with a broken HVAC/refrigeration/appliance system to either start a
chat intake at `/chat` or call the real business line, while also giving
staff/prospects a one-click path into the admin demo. Audience: prospective
customers (primary) and prospects evaluating the product (secondary, via the
"two surfaces" and staff-login sections).

## 2. Brainstorm

Ideas considered for a "great version" of this page, including rejected ones:

- **Page-specific SEO/social metadata (title, description, Open Graph).**
  ACCEPTED — becomes Rhome-1. The page is 100% marketing copy but ships with
  the app's generic, non-branded `<title>`. Cheap, high-leverage fix.
- **Embed a real, live chat widget on the homepage** instead of the static
  `ChatPreview` mock. REJECTED — `/chat` already is the live, fully-guarded
  surface one click away; embedding a second live AI surface on the
  marketing page doubles the FROZEN-safety-text attack surface and hosting
  cost for no clear conversion benefit over a single prominent CTA.
- **Blog / content-marketing section.** REJECTED — no CMS or content
  pipeline exists anywhere in the repo; building one is a multi-week feature
  wildly out of scope for a landing-page spec.
- **Real customer testimonials/review carousel** sourced from the reviews
  system. REJECTED — `page-reviews` is an internal/admin surface; wiring
  live customer reviews onto the public page needs new moderation and data
  plumbing that doesn't exist. Not justified for this pass.
- **A/B testing framework for hero copy.** REJECTED — the repo has no
  experimentation infra (only `@vercel/analytics/next` is wired); premature
  for a pre-launch demo product.
- **JSON-LD `LocalBusiness` structured data** for rich search snippets.
  REJECTED for this pass — valuable, but it's a distinct enhancement
  requiring business-schema decisions (hours, geo, aggregate rating) beyond
  a plain title/description fix. Left as a P2 follow-up, not bundled into
  Rhome-1 to keep the diff surgical.
- **Visual service-area map** on the page (radius circle over NE TN/SW
  VA/W NC). REJECTED — purely decorative; the existing text line already
  states the region and matches `BUSINESS_BASE_LOCATION`; a real map already
  exists on the admin dispatch-map page for actual mapping needs.
- **Sticky mobile "get a quote" floating action button.** REJECTED — the
  page already surfaces a sticky-header CTA, a hero CTA pair, and a bottom
  CTA band; no evidence existing CTAs underperform, and another floating
  element adds visual clutter.
- **Fix the duplicate Bricolage Grotesque font loader** (page.tsx loads it a
  second time on top of the root layout). Considered real but scoped as a
  P2 tech-debt cleanup, not a requirement — doesn't change behavior a user
  can observe.
- **Fix "Staff demo login" → "Staff demo sign in"** for copy-canon
  compliance. Considered real but kept as P2 backlog — one word, cosmetic,
  no functional impact.

## 3. Current state

All claims `verified` by reading `src/app/page.tsx` in full unless noted.

- Fully static server component, no data fetching, no `"use client"`
  (`src/app/page.tsx:91`). Brand facts are hardcoded in `SPEARS` and
  `DEMO_PHONE` consts (`src/app/page.tsx:31-41`).
- Nav links to `/chat`, `/admin`, `/docs.html` (`src/app/page.tsx:43-47`),
  duplicated verbatim in `src/app/_components/mobile-nav.tsx:13-17`.
  `/docs.html` exists as a static file at `public/docs.html` (verified via
  `ls`). `/chat` (`src/app/chat/page.tsx`) and `/admin/login`
  (`src/app/admin/login/page.tsx`) both exist.
- Hero CTAs: "Start a service request" → `/chat`; "Call {phone}" →
  `tel:` link (`src/app/page.tsx:196-212`). Bottom CTA band repeats the same
  pattern (`src/app/page.tsx:357-373`).
- Staff demo-login link is `/admin/login?password=1`
  (`src/app/page.tsx:230`), required because plain `/admin/login` defaults
  to Google-only mode (comment at `src/app/page.tsx:227-228`, corroborated
  by `page-home` skill).
- Five `SERVICES` cards and six `WHY_CHOOSE` cards are static arrays
  (`src/app/page.tsx:49-84`).
- `ChatPreview` (`src/app/page.tsx:501-554`) is a fully static, hardcoded
  mock conversation — no connection to the real chat backend.
- "Two surfaces" section links `/chat` and `/admin` with bullet lists of
  claimed capabilities (`src/app/page.tsx:314-341`). `inferred`: the listed
  capabilities (technician assignment, conversation log, scheduling
  calendar, customer CRM, AI disclosure/handoff, safety escalation, resume
  on refresh) correspond to real features documented in
  `page-dispatch`/`page-calendar`/`page-conversations`/`page-customers`/
  `page-chat` skills — not re-verified by reading those pages in this pass.
- Root layout (`src/app/layout.tsx:16-19`) sets app-wide
  `metadata = { title: "HVAC Customer Service", description: "AI-powered
  HVAC service request assistant" }`. `src/app/page.tsx` has **no**
  `metadata` or `generateMetadata` export — verified by reading the full
  file (no such symbol present). No page in the repo defines Open Graph
  tags (verified: `grep -rn "openGraph\|OpenGraph"` under `src/app` returns
  no matches).
- Bricolage Grotesque is loaded twice with the identical config
  (`subsets: ['latin'], weight: ['600','700','800'], variable:
  '--font-display'`): once in `src/app/layout.tsx:10-14` applied to
  `<html>`, and again independently in `src/app/page.tsx:24-28` applied to
  the page's own root `<div>`.
- `SPEARS.address` is assigned from `BUSINESS_BASE_LOCATION.address`
  (`src/app/page.tsx:37`) but never read anywhere in the file — the footer
  instead reads `BUSINESS_BASE_LOCATION.address` directly
  (`src/app/page.tsx:389`). Confirmed via `grep -n "SPEARS.address"` — zero
  usages.
- "Staff demo login" (`src/app/page.tsx:233`) is the only place in the file
  using the word "login" as user-facing copy; the destination page itself
  correctly says "Sign in" (`src/app/admin/login/login-form.tsx:54,191`),
  per the repo's copy canon (`sign in`, not `login`).
- `src/app/icon.svg` exists and is brand-colored (cyan gradient, wind-icon
  mark) — favicon is already handled via Next's file convention, not a gap.
- No unit test file exists for this page (`page-home` skill states "no unit
  tests (static page)"; confirmed no `src/app/page.test.*`).

## 4. Gaps

| Gap | Severity | Evidence |
|---|---|---|
| No page-specific SEO/social metadata — home ships the generic app-wide `<title>HVAC Customer Service</title>` and description instead of Spears branding used throughout the visible page, and no Open Graph tags exist for social shares | P1 | `src/app/layout.tsx:16-19` (generic metadata, applies repo-wide); `src/app/page.tsx` has no `metadata`/`generateMetadata` export (full-file read); `grep -rn "openGraph"` under `src/app` → no matches |
| "Staff demo login" copy contradicts the repo's copy canon (`sign in`, not `login`); the linked destination page already says "Sign in" | P2 | `src/app/page.tsx:233`; `src/app/admin/login/login-form.tsx:54,191`; canon defined in `.claude/skills/admin-pages/SKILL.md:48-54` |
| Bricolage Grotesque font is loaded twice with identical config (root layout + page.tsx), producing a redundant `next/font` instance/CSS for the same `--font-display` variable | P2 | `src/app/layout.tsx:10-14` vs `src/app/page.tsx:24-28` |
| `SPEARS.address` field is dead code — assigned but never read | P2 | `src/app/page.tsx:37`; zero usages via `grep -n "SPEARS.address"` |

Only one P1, zero P0. The page is otherwise well-built (recently redesigned,
consistent branding, working CTAs, correct demo-login query param, static
render with no data-fetch failure modes). This is an honest, short list —
no P0/workflow-breaking issues were found.

## 5. Requirements

- **Rhome-1**: `src/app/page.tsx` exports page-specific `metadata` (or
  `generateMetadata`) that overrides the root layout's generic title and
  description with Spears-branded copy (e.g. title containing "Spears
  Services", description reflecting the AI intake/24-7 positioning already
  on the page), plus `openGraph.title`/`openGraph.description` matching.
  **Acceptance criterion:** loading `/` and inspecting the resolved
  `<head>` (e.g. `curl -s http://localhost:3000/ | grep -o
  "<title>[^<]*</title>"` against a running dev server, or browser
  devtools) shows a title containing "Spears Services" — not the literal
  string "HVAC Customer Service" — and a `<meta name="description">`
  distinct from "AI-powered HVAC service request assistant". `npx tsc
  --noEmit` and `npx eslint src/app/page.tsx` both stay at 0.

No other gap reaches P1/P0, so no further requirements are opened in this
pass. G2–G4 remain recorded above as P2 backlog for a future pass.

## 6. Non-goals

- No live/embedded chat widget on the homepage — `/chat` already serves
  this, one click away, without duplicating the guarded AI surface.
- No blog/CMS/content-marketing build-out — no content pipeline exists;
  out of scope for a landing-page spec.
- No live testimonials/review carousel — no data plumbing from the
  internal reviews system to a public surface exists yet.
- No A/B testing/experimentation infrastructure.
- No JSON-LD structured data in this pass — separable, larger enhancement;
  left for a future spec if desired.
- No visual service-area map.
- No mobile sticky CTA.
- No fix to the P2 items (copy-canon "login" wording, duplicate font
  loader, dead `SPEARS.address` field) in this pass — recorded as backlog,
  not required work, to keep the change surgical per Rhome-1 only.

## 7. Invariants

- The staff demo-login link must always carry `?password=1`
  (`/admin/login?password=1`) — without it `/admin/login` defaults to
  Google-only mode and the on-page password credentials dead-end. Source:
  `.claude/skills/page-home/SKILL.md:21-23`, `src/app/page.tsx:227-230`.
- `SPEARS.phoneDisplay`/`SPEARS.phoneTel` must stay in sync; `DEMO_PHONE` is
  the Twilio voice-demo number, not Spears' real line — never swap them.
  Source: `.claude/skills/page-home/SKILL.md:24-26`.
- Bricolage Grotesque stays scoped to the `--font-display` CSS variable via
  `next/font/google` — do not add a *third* loader when fixing Rhome-1 or
  anything else on this page (there are already two; see G3). Source:
  `.claude/skills/page-home/SKILL.md:27-28`.
- `lp-rise`, `lp-float`, `lp-mesh`, `lp-grid` CSS animation utilities
  (`src/app/globals.css:215-295`) must not be removed or renamed.
- The service-radius/region copy must keep matching
  `BUSINESS_BASE_LOCATION` (`src/lib/config/business-location.ts`) — never
  hardcode a separate radius/region string on this page.
- Copy canon (request/technician/**sign in**/cancelled/Unicode …/sentence
  case/human error copy) is repo-wide — any future edit to this page must
  not introduce *new* violations even though one (G2) is left unfixed here.
  Source: `.claude/skills/admin-pages/SKILL.md:48-54`.
- No jsdom/RTL — this page has and needs no component tests; any pure logic
  extracted must be covered by pure-helper vitest only, per
  `AGENTS.md:13-17`.
- This page makes no AI calls and touches no FROZEN safety text or
  `output-guardrail.ts` regexes — Rhome-1's metadata-only change keeps it
  that way; do not let a future change on this page start calling `/lib/ai`
  directly.

## 8. Verification

1. `npx tsc --noEmit` → 0 errors.
2. `npx eslint src/app/page.tsx` → 0 errors.
3. `npx vitest run` → must not drop below the run's captured baseline
   (297 files · 4022 passed · 1 skipped, per `docs/page-program/README.md`).
4. Visual: `npm run dev` (background), then
   `node scripts/agent/screenshot-page.mjs / 1440` and
   `node scripts/agent/screenshot-page.mjs / 390` — look at both images to
   confirm no visual regression from the metadata-only change.
5. Metadata check: with the dev server running,
   `curl -s http://localhost:3000/ | grep -o "<title>[^<]*</title>"` shows a
   title containing "Spears Services"; confirm `<meta name="description">`
   differs from the generic app-wide copy.
6. `node scripts/agent/verify-skills.mjs` → 0 missing paths (this spec cites
   real files only; skill itself is unchanged unless Rhome-1's implementation
   also updates `.claude/skills/page-home/SKILL.md`, in which case re-run
   after that edit).
