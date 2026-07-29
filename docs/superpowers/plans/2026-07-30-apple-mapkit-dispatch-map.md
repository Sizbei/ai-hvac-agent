# Apple MapKit JS Dispatch Map Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Replace the dispatch map's basemap with Apple Maps (MapKit JS) in the
Flighty treatment — dark + muted-standard cartography — porting every existing
layer (job pins, tech dots, AR money layer, popups, legend, layer toggles,
fit-to-bounds), env-gated with graceful fallback to the current MapLibre map so
it ships before Apple credentials exist.

**Architecture:** A server route mints short-lived ES256 JWTs from an Apple
Maps private key (jose, already a dependency). The client loads mapkit.js on
demand, initializes with an authorizationCallback that fetches that token, and
renders `mapType: MutedStandard` + `colorScheme: Dark` — the literal Flighty
look. A thin wrapper component picks AppleDispatchMap when the server reports
MapKit configured, else the existing MapLibre DispatchMap. Pin/popup DOM
builders are shared between both maps (MapKit annotations accept DOM
factories, so the existing element builders port nearly verbatim).

**Tech Stack:** MapKit JS (Apple CDN), jose (ES256 JWT), existing React admin
map page, existing MapLibre map as fallback.

## Global Constraints

- **Verify current MapKit JS API against Apple's live docs before writing the
  component** (developer.apple.com/documentation/mapkitjs + Context7 if
  indexed) — training-data API drift is likely (script URL version, init
  shape, annotation/cluster APIs).
- Env vars (all three required to activate): `APPLE_TEAM_ID`,
  `APPLE_MAPKIT_KEY_ID`, `APPLE_MAPKIT_PRIVATE_KEY` (PKCS8 .p8 contents,
  `\n`-escaped). Absent ⇒ the map page behaves byte-identically to today.
- **Target MapKit JS v6** (current major; `mapkit.core.js` modular loader).
  Auth stays the dynamic ES256 JWT via `authorizationCallback` (still
  supported in v6 as the refresh mechanism) — chosen over v6's portal-static
  tokens because static tokens are domain-bound at generation and would break
  on every Vercel preview URL; our endpoint pins origin per-request. Task 3
  MUST read Apple's v5→v6 migration doc + mapkit-loader README before coding
  (developer.apple.com/documentation/mapkitjs/migrating-from-version-5-to-version-6,
  github.com/apple/mapkit-loader).
- Token endpoint (BUILT, reviewed, corrected): admin-session-gated, returns
  `{ token, expiresAt }`; TTL 30 min; `force-dynamic` (never cacheable);
  claims iss=team id, iat, exp, and `origin` = request host WITHOUT scheme
  (Apple validates a bare domain); localhost origins get NO origin claim.
  NEVER expose the private key.
- **Verified API facts for Task 3** (critic-checked 2026-07-30):
  `mapkit.Map.MapTypes.MutedStandard` exists in MapKit JS (string
  "mutedStandard"; verify the v6 enum path — may be `mapkit.MapType`);
  `colorScheme: "dark"` — LOWERCASE string, "Dark" silently fails;
  annotations = `new mapkit.Annotation(coord, domFactory, opts)`; callouts =
  delegate `calloutElementForAnnotation`; clustering = `clusteringIdentifier`;
  fit-bounds = `map.showItems(annotations, { animate: true })` (NOT
  fitBounds/setRegion). Free tier 250k map views/day.
- CSP: the authenticated admin dashboard currently sets NO restrictive CSP
  (proxy.ts constrains only widget frame-ancestors + the invite page), so no
  CSP change is needed — but IF a dashboard CSP is ever added,
  `https://*.apple-mapkit.com` must join script-src/img-src/connect-src.
- No visual regression to the MapLibre fallback: shared pin-builder extraction
  must leave `dispatch-map.tsx` behavior unchanged (presentation-only moves).
- The AR "money owed" layer's XSS-escaping (`esc()`) survives the port —
  popups/callouts render the same escaped HTML.
- Feature parity checklist for the Apple map (audited against the FULL
  dispatch-map.tsx — every item is a shipped behavior; omission = regression):
  job pins colored by status; tech live-location dots with `dm-ping`
  animation (the `@keyframes` is injected via a `<style>` tag in the map JSX
  — the Apple component must inject it too); tech callout content (name +
  "Updated N min ago" via `timeAgo(capturedAt)`); base headquarters marker
  (`baseMarkerEl`) with its "Base" callout; **service-radius circle**
  (dashed ring — use `mapkit.CircleOverlay` with equivalent
  fill-opacity/dash styling; MapLibre approximates via 64-pt polygon);
  AR "money owed" layer + toggle; legend; summary bar (request count,
  unassigned badge, AR total, Refresh button); `geocodeCapped` "Showing
  first 25 geocoded requests" chip; AR-empty chip; zoom controls (v6 map
  options — `showsZoomControl`); layer-toggle mobile stacking
  (`max-[480px]:right-2 max-[480px]:top-16`); job callout content
  (customer, ref, issue, window, price, technician); fit-bounds via
  `showItems` on data load; clustering at low zoom; reduced-motion respect
  (snapshot `matchMedia` read, matching current semantics); AR pin hover
  scale (verify inline mouse handlers work inside mapkit annotation DOM;
  acceptable to drop if mapkit intercepts, note it).
- Terminology canon applies to any new copy (request/technician/sentence
  case). No prompts, no guardrails, nothing outside the map surface.
- Suite baseline 4,012 pass / 1 skip must hold; new unit tests for the token
  endpoint (throwaway generated ES256 key — never a real Apple key in the
  repo).
- **Live verification is BLOCKED until the user supplies Apple credentials**
  (Apple Developer Program → Certificates, Identifiers & Profiles → Keys →
  Maps ID + MapKit JS key). Until then the Apple path ships dark; the ledger
  and final report must say UNVERIFIED-LIVE explicitly.

---

### Task 1: Token minting endpoint + config surface

**Files:**
- Create: `src/app/api/admin/mapkit-token/route.ts`
- Create: `src/app/api/admin/mapkit-token/route.test.ts`
- Modify: the map page's config source so the client knows whether MapKit is
  configured (a `mapProvider: "apple" | "maplibre"` field on an existing
  admin-config response the map page already fetches, or the page's server
  component reading env directly — implementer picks the smallest seam after
  reading `src/app/admin/(dashboard)/map/page.tsx`).

**Steps:** TDD — tests first: 401 unauthenticated; 503 `NOT_CONFIGURED` when
env absent; 200 shape `{ token, expiresAt }` with a generated throwaway P-256
key (jose `generateKeyPair`), decoded claims assert iss/exp≈30min/origin.
`vi.mock("server-only", () => ({}))` per repo pattern. Implement with jose
`importPKCS8` + `SignJWT` (ES256, kid header = key id). Commit.

### Task 2: Shared pin/popup builders (presentation-only extraction)

**Files:**
- Create: `src/components/admin/dispatch/map-pins.ts` (move `createJobPin`,
  tech-dot builder, AR pin builder, popup/callout HTML builders, `esc`,
  `jobColor`, formatters out of `dispatch-map.tsx`)
- Modify: `src/components/admin/dispatch/dispatch-map.tsx` (import from the
  new module; zero behavior change)

**Steps:** extract, `git diff` review confirms move-only, full map-adjacent
tests + tsc + eslint green, visual spot-check the MapLibre map still renders
(dev server + screenshot). Commit.

### Task 3: AppleDispatchMap component + provider wrapper

**Files:**
- Create: `src/components/admin/dispatch/apple-dispatch-map.tsx`
- Create: `src/components/admin/dispatch/dispatch-map-provider.tsx`
- Modify: `src/app/admin/(dashboard)/map/page-client.tsx` — NOT page.tsx.
  Task 1 already split the page: page.tsx (server) computes `mapProvider`
  and passes it to `DispatchMapPageClient` in page-client.tsx, where the
  prop currently arrives unused (`_mapProvider`) and `<DispatchMap />` is
  hardcoded with its own `dynamic()` import. Task 3 replaces that render
  with `<DispatchMapProvider mapProvider={mapProvider} />` and REMOVES
  page-client.tsx's now-redundant dynamic import (the provider owns both).
  The `MapProvider` type exported from page-client.tsx is the canonical one.

**Steps:** read Apple's v6 migration doc + mapkit-loader README FIRST (URLs
in Global Constraints), then build against the VERIFIED API facts listed
there (v6 `mapkit.core.js` loading, `authorizationCallback` refresh wired to
Task 1's endpoint, MutedStandard + `colorScheme: "dark"` lowercase, DOM
factories from Task 2's map-pins, `calloutElementForAnnotation`,
`clusteringIdentifier`, `showItems` fit, `mapkit.CircleOverlay` service
radius, v6 zoom-control option). Port every parity-checklist item. Provider:
CONDITIONAL RENDER of exactly one dynamically-imported map (never render
both / never CSS-hide — only the active branch's chunk may load).
**Concrete fallback mechanism ("never a blank pane"):** the Apple component
reports failure via an `onFail` callback; the provider then swaps to the
MapLibre branch via state. Failure triggers: (a) token fetch returns
non-2xx (incl. 401 expired-session and 503), (b) script load error,
(c) `mapkit.init`/load throws synchronously, (d) watchdog — no map instance
ready 8s after mount. Reduced-motion: skip ping. tsc/eslint/tests green; the
Apple path compiles but is UNVERIFIED-LIVE without credentials — the
MapLibre fallback path (unconfigured env) must be screenshot-verified
unchanged, AND the provider's swap-on-fail must have a unit test (mock
onFail → MapLibre branch renders). Commit.

### Task 4: Gate + docs + handoff

**Steps:** full gate (tsc, eslint changed files, full vitest — capture the
LIVE baseline with `npx vitest run` first; it moves as tasks add tests, was
4,019/1 after the Task-1 review fixes); update `docs/` map/feature doc if one
references the map basemap; append `.env.example` (three vars, commented,
with the Apple portal click-path AND the `\n`-escape note for the multiline
.p8: each newline stored as literal `\n`); ledger entry; commit. Deploy is allowed (fallback makes it
inert); prod verify = MapLibre map still renders + `/api/admin/mapkit-token`
returns 503 NOT_CONFIGURED for an admin session.

**User homework to go live (10 min, only the user can do this):**
1. Apple Developer Program membership ($99/yr) on developer.apple.com.
2. Certificates, Identifiers & Profiles → Identifiers → new **Maps ID**
   (e.g. `maps.com.spears.hvac`).
3. Keys → new key with **MapKit JS** enabled, bound to that Maps ID →
   download the `.p8` once.
4. Provide: Team ID (Membership page), Key ID, and the `.p8` contents →
   `vercel env add` the three vars (prod + preview) → redeploy → I
   visually verify the Flighty look and tune pin contrast for MutedStandard.
