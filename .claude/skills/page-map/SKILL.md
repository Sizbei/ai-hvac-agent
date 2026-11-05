---
name: page-map
description: Use when working on the /admin/map page — live dispatch map (technician locations, request pins, AR layer) with dual providers (Apple MapKit / MapLibre dark fallback).
---

# Map (/admin/map)

**Purpose:** live geographic view of active requests, technician locations
(opt-in), the service radius, and an accounts-receivable "money owed" layer.

**Files:** page `src/app/admin/(dashboard)/map/page.tsx` (server: resolves
mapProvider from Apple env vars) → `src/app/admin/(dashboard)/map/page-client.tsx`
→ provider `src/components/admin/dispatch/dispatch-map-provider.tsx` chooses
`src/components/admin/dispatch/apple-dispatch-map.tsx` (MapKit JS v6) or
`src/components/admin/dispatch/dispatch-map.tsx` (MapLibre, openfreemap
`dark` style). Shared DOM builders: `src/components/admin/dispatch/map-pins.ts`
(16 exports — pins, popups, esc, formatters). Token API
`src/app/api/admin/mapkit-token/route.ts`. Data API
`src/app/api/admin/dispatch/map/route.ts`.

**Data flow:** one fetch of the map API on load + manual Refresh (no polling).
Caps at first 25 geocoded requests (`geocodeCapped`). Geocoding happens
at intake; missed geocodes are backfilled by the booking-recovery cron.

**Invariants:**
- Both providers share `map-pins.ts` builders — any styling change there must
  look right on BOTH the MapLibre dark style and Apple MutedStandard dark
  (white rings not black shadows; that was deliberate).
- `notPlottedCount = needGeocode.length - geocodedJobs.length` (map API route)
  is distinct from `geocodeCapped`: a job can fail to plot from a live-geocode
  miss or a decrypt failure even when the 25-job cap wasn't hit. Both
  providers render `notPlottedChipMessage(notPlottedCount, geocodeCapped)` —
  it returns `null` (no chip) only when nothing was dropped; never collapse
  this back to `geocodeCapped &&` alone, or "jobs exist but silently didn't
  plot" becomes indistinguishable from "no jobs".
- The technician-location query filters `users.isActive = true` — a
  deactivated technician's last-known pin must never render alongside active
  technicians' pins.
- The provider conditional-renders exactly ONE dynamically-imported map;
  Apple failure (token non-2xx, script error, init throw, 8s watchdog,
  mid-session token-refresh failure) swaps to MapLibre — never a blank pane.
- Popup/callout HTML goes through `esc()` (AR layer renders customer data).
- MapKit facts: v6 `mapkit.core.js`; `colorScheme: "dark"` LOWERCASE;
  fit = `map.showItems`; service ring = `mapkit.CircleOverlay` (opacity via
  rgba — no strokeOpacity prop). Token claims: origin = bare domain, no
  scheme; omitted for localhost; route is force-dynamic.

**Gotchas:**
- `JOB_PIN_LEGEND` (in both `dispatch-map.tsx` and `apple-dispatch-map.tsx`)
  must list every `jobColor` in `map-pins.ts`, including Low (#0891b2). The
  MapLibre status chips sit at `bottom-10` to clear the attribution bar.
- Apple branch is inert until APPLE_TEAM_ID / APPLE_MAPKIT_KEY_ID /
  APPLE_MAPKIT_PRIVATE_KEY exist (\n-escaped .p8; see .env.example).
- Dev DB: active requests have seeded cached locations near Johnson City
  (2026-08-01). Unseeded new test requests live-geocode fake addresses to
  Manhattan — see the admin-pages skill for the seeding recipe.
- Mobile: layer toggle uses `max-[480px]:right-2 max-[480px]:top-16` to
  avoid colliding with the summary bar — preserve on both providers.

**Verify changes:** `npx vitest run src/components/admin/dispatch` (provider
swap logic + `map-pins.test.ts`) + `src/app/api/admin/mapkit-token/route.test.ts`
(7 tests) + `src/app/api/admin/dispatch/map/route.test.ts`.
Visual via the admin-pages recipe; zoom out ~3 clicks to check the service
ring. After deploy: `bash scripts/agent/prod-smoke.sh` covers the token
route's 503/200.
