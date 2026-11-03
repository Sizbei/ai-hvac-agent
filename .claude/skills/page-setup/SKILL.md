---
name: page-setup
description: Use when working on the /admin/setup guide, the home Setup guide card, the sidebar setup digit, the onboarding API/state, or the deep-link and back-to-guide banner wiring on staff, pricebook, requests and settings.
---

# Setup guide (/admin/setup + home card)

**Purpose:** auto-completing onboarding. Eight steps (4 required, 4 optional) are
derived from real data on every read; nothing is ticked by hand.

**Files:** page `src/app/admin/(dashboard)/setup/page.tsx` · components
`src/components/admin/setup/*` (`setup-page-client`, `setup-phase-card`,
`setup-step-row`, `setup-hero`, `setup-finished`, `copy-sign-in-link`,
`back-to-guide-banner`) · home card `src/components/admin/onboarding/setup-card.tsx`
· API `src/app/api/admin/onboarding/route.ts` (GET/PATCH) · server
`src/lib/admin/onboarding-queries.ts` (`getOnboarding`, `patchOnboarding`),
`onboarding-sql.ts` (SELECT + the two upserts), `onboarding-steps.ts`
(`STEP_DEFS`, `deriveSteps`, `grandfatherDecision`, `upNext`, `OnboardingPayload`),
`onboarding-state.ts` (zod parse, legacy fold) · client
`src/lib/admin/onboarding-store.ts` (`useOnboarding`, `refreshOnboarding`,
`invalidateOnboarding`, `getOnboardingSnapshot`), `setup-digit.ts`,
`setup-view.ts`, `setup-card-view.ts` · deep links
`src/lib/admin/open-from-param.ts`, `src/hooks/use-open-from-param.ts` · nav
`src/components/admin/nav-items.ts` (`navGroupsFor`), `sidebar.tsx`,
`src/app/admin/(dashboard)/layout.tsx` (server placement) · tests
`tests/integration/onboarding-state.test.ts`.

**Step rules:** required = `phone_hours`, `add_technician`, `book_first_request`,
`tech_sign_in`; optional = `brand`, `pricebook`, `chat_widget`, `integrations`.
Steps flagged `live` (add technician, book first request) re-derive every read
and can reopen (`needsAttention` when stamped but no longer true); others stay
done once stamped. `add_technician` needs an active technician with a password
or Google id (FieldPulse-imported passwordless ones show a note); `book_first_request`
needs a booked appointment with a technician (role only, active not required);
`tech_sign_in` is done by time entries, locations, a Google-linked technician or
`flags.techSignedInAt`. Step copy is exact per spec §3/§4; do not reword.

**Stamps and flags:** `organization_settings.onboarding_state` holds
`firstCompleted` (write-once per step), `dismissedAt`, `completedSeenAt` and
`flags` (`embedCopied`, `techSignedInAt`). GET = the SELECT, then the stamp upsert
only if there are new stamps or grandfather keys (the payload is built from the
SELECT copy, never RETURNING). Old values always win (`$new || OLD`). The two
upserts are single-statement and row-less safe; concurrent writers cannot lose
keys. A failed stamp write is logged, not fatal.

**Grandfathering:** only while no stamps exist. Required 4 of 4 sets
`completedSeenAt` (hides the card); an org older than 14 days with a completed
request gets `dismissedAt`. Ordering matters in tests and probes: do the GET after
phone+hours BEFORE adding the rest, or the card is hidden by grandfathering.

**Demo org** (`organizationId === DEMO_ORG_ID`, the dev default org): everything
derived, `tech_sign_in` always done, no stamp, no PATCH write, no flag write, no
audit. PATCH applies the body in memory; the card's dismiss lives in
`sessionStorage` (`readDemoFlags`/`writeDemoFlags`).

**Client store contract:** fetches are sequence-tagged (older responses dropped);
`refreshOnboarding({ force: true })` during an in-flight fetch chains another;
`invalidateOnboarding()` forces a refresh when there are subscribers, else marks
stale; the visibility listener is refcounted from an effect, never module scope;
writers `await` their PATCH before refreshing; the snapshot is a cached immutable
object. `onboarding-state.ts` and `onboarding-steps.ts` import only zod and types
(never `@/lib/db` or `server-only`), so client code uses `import type`.

**Deep-link whitelist:** `?new=technician|invite` (staff), `?new=1` (pricebook,
requests), `?tab=…` (settings), always with `from=setup`. Only whitelisted `new`
values open anything; `from` must equal `setup`; both params are stripped with
`history.replaceState`. See admin-pages for the hook recipe.

**Gotchas:**
- Audit `details` = `JSON.stringify({ keys })` only. Never `err.message` in UI.
- The nav placement (operations/integrations) is computed server-side in the
  layout so the sidebar never flashes; the digit comes from the store.
- Throwaway-org recipe for screenshots and probes (never `seed-org.mjs`, never
  `POST /api/admin/requests` on dev, which is FieldPulse-connected): a temporary
  `probe.mts` run as `NODE_OPTIONS=--conditions=react-server npx tsx probe.mts`
  loads `.env.local` first, then `await import("./src/lib/admin/provisioning.ts")`
  and calls `createOrgCore({ name, createdBy: null, ownerEmail: null, ownerUser:
  { email: "owner-<uuid>@throwaway.example", name, googleId: "probe-<uuid>" },
  skipOrgCountCheck: true })`. Mint with `MINT_ORG_ID=<id>`. Add "finished" rows
  by SQL (phone+hours, GET, technician, customer session, service request, time
  entry; the request trigger makes the visit). Delete with one
  `DELETE FROM organizations WHERE id = …`. Delete `probe.mts` afterwards.

**Verify changes:** `npx vitest run src/lib/admin/onboarding-*.test.ts
src/lib/admin/setup-*.test.ts src/lib/admin/open-from-param.test.ts
src/app/api/admin/onboarding/route.test.ts` · DB:
`VITEST_INTEGRATION=1 npx vitest run tests/integration/onboarding-state.test.ts`
(dev DB only, refuses prod) · visual via the admin-pages recipe.
