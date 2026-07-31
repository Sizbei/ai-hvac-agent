---
name: page-home
description: Use when working on the / (root) marketing homepage — Spears Services branding, hero, service cards, demo-login funnel, and static chat preview.
---

# Home (/)

**Purpose:** marketing landing page for Spears Services that introduces the AI intake
demo, showcases the five service categories, and funnels visitors into the chat or the
staff demo login.

**Files:** page `src/app/page.tsx` · nav component
`src/app/_components/mobile-nav.tsx` · business constants
`src/lib/config/business-location.ts`

**Data flow:** fully static server render (no data fetching). Brand facts are hardcoded
in `SPEARS` and `DEMO_PHONE` consts inside the page file. The `ChatPreview` component
is a static mock — it has no connection to the live chat.

**Invariants:**
- The staff demo-login link must always carry `?password=1`
  (`/admin/login?password=1`) — without it the page defaults to Google-only mode and
  the password credentials shown on the page dead-end.
- `SPEARS.phoneDisplay` / `SPEARS.phoneTel` must stay in sync;
  `DEMO_PHONE` is the Twilio voice demo number (not Spears' real line) — do not swap
  them.
- Bricolage Grotesque is loaded per-page via `next/font/google` and scoped to
  `--font-display`; do not add a second font loader here.
- `lp-rise`, `lp-float`, `lp-mesh`, `lp-grid` are landing-page-only CSS animation
  utilities (defined in globals); do not remove or rename them.
- The service-radius and region copy ("NE Tennessee, SW Virginia, Western North
  Carolina") must match `BUSINESS_BASE_LOCATION` — do not hardcode separately.

**Gotchas:**
- `delay()` returns a `React.CSSProperties` object used as inline style for
  stagger animation — it is NOT a setTimeout wrapper.
- The `SurfaceCard` / `SectionHeading` sub-components are local to this file;
  do not extract them to shared components without checking usage elsewhere.

**Verify changes:** no unit tests (static page). Visual: `npm run dev` + browser
at `http://localhost:3000`. Gate: `npx tsc --noEmit`.
