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
- Token endpoint is admin-session-gated (getAdminSession) and returns
  `{ token, expiresAt }`; JWT TTL 30 min; claims iss=team id, iat, exp, and
  `origin` pinned to the request origin. NEVER expose the private key.
- No visual regression to the MapLibre fallback: shared pin-builder extraction
  must leave `dispatch-map.tsx` behavior unchanged (presentation-only moves).
- The AR "money owed" layer's XSS-escaping (`esc()`) survives the port —
  popups/callouts render the same escaped HTML.
- Feature parity checklist for the Apple map: job pins colored by status,
  unassigned ring treatment, tech live-location dots (ping animation), AR
  layer toggle, legend, popup content (customer, ref, issue, window, price,
  technician), fit-bounds on data load, cluster behavior at low zoom
  (`clusteringIdentifier`), reduced-motion respect.
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
- Create: `src/components/admin/dispatch/dispatch-map-provider.tsx` (chooses
  Apple vs MapLibre from the Task-1 config; both dynamic-imported, ssr:false)
- Modify: `src/app/admin/(dashboard)/map/page.tsx` (render the provider)

**Steps:** doc-verify MapKit JS current API FIRST (script tag/loader, init
with authorizationCallback hitting Task 1's endpoint, `mapkit.Map` with
`mapType: mapkit.Map.MapTypes.MutedStandard`, `colorScheme: Dark`,
annotations via DOM factory reusing Task 2 builders, callouts via
`calloutElementForAnnotation`-style delegate, `clusteringIdentifier`,
region-fit from data bounds). Port the legend/toggles as the same overlay DOM.
Reduced-motion: skip ping animation. Handle token-fetch failure → render the
MapLibre fallback (never a blank pane). tsc/eslint/tests green; the Apple path
compiles but is UNVERIFIED-LIVE without credentials — the MapLibre path must
be screenshot-verified unchanged. Commit.

### Task 4: Gate + docs + handoff

**Steps:** full gate (tsc, eslint changed files, full vitest vs 4,012/1
baseline); update `docs/` map/feature doc if one references the map basemap;
append `.env.example` (three vars, commented, with the Apple portal
click-path); ledger entry; commit. Deploy is allowed (fallback makes it
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
