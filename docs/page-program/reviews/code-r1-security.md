# Code review round 1 — security (adversarial)

Artifact: `git diff 7787352..HEAD -- src/ scripts/ drizzle/ tests/` (commits
`96a094a`, `e7450a7`, `3d4ca1e`, `fb27657`). Lens: does each claimed
security fix (A1–A13 per the dispatch brief) actually close the hole it
claims to close, end-to-end, at the layer where the request arrives —
not just at the demonstrated repro path. Working-tree uncommitted changes
from other agents were ignored; only the committed diff was reviewed.

## Summary

- **Findings: 0 blocker · 2 major · 3 minor** (5 total).
- **Is the chat/voice account-data leak (A7/A13) fully closed? YES**, for
  the threat the audit actually described (an unverified, self-reported
  phone/email disclosing another customer's balance/membership/appointment/
  history). Every code path that reads `customerSessions.customerId` (or
  the transient `customerContext.customerId` resolved from a self-reported
  contact) to disclose account data was traced; all of them now route
  through the shared `advanceVerify`/`requiresVerify` engine or
  `parseVerifyState`, and both new tests (146/146 across the files touched
  by this review) pass.
- Two **major** findings are real, verified completeness gaps in the
  supporting fixes (A1's token-masking misses one token-bearing route
  class; a legacy account-intent capability mapping has no corresponding
  verify-sensitivity entry, a landmine rather than a live hole). Neither
  reopens the A7/A13 leak itself.
- **Verdict: ship-with-fixes.** The core A7/A13 gate is sound and the other
  9 role/CSRF/audit fixes (A2, A4, A5, A8, A9, A10, A12, plus the 0044
  migration) all hold up under direct route-level tracing. SR-1 (analytics
  token masking gap) should be fixed before relying on the "every
  token-bearing path is masked" claim; it does not block shipping the
  A7/A13 chat-leak fix itself.

---

## Findings

### SR-1 — `major` · `verified` — A1's analytics masking omits `/admin/invite/[token]`, a real bearer-credential path

`src/lib/analytics-path.ts:16`
```ts
const TOKEN_ROUTE_PREFIXES = new Set(["portal", "estimates", "review"]);
```

There are four `[token]`-addressed page routes in the app
(`find src/app -type d -name "[token]"`): `src/app/portal/[token]`,
`src/app/review/[token]`, `src/app/estimates/[token]`, and
**`src/app/admin/invite/[token]`**. `maskTokenPath` only masks the first
three. `src/app/admin/invite/[token]/page.tsx:37` resolves the raw path
token server-side (`resolveInviteByToken(token)`) — the plaintext
single-use staff-invite token (per the repo's team-invites design: hashed
at rest, 72h TTL, single-use) is literally the URL segment loaded on this
page.

`MaskedAnalytics` (`src/components/masked-analytics.tsx`) wraps
`<Analytics/>` in the ROOT layout (`src/app/layout.tsx`), so it fires
unconditionally for every route including `/admin/invite/<token>`. I
confirmed the gap by hand-evaluating `maskTokenPath` against that path
(`segments[1] === "admin"`, not in `TOKEN_ROUTE_PREFIXES`, so the function
short-circuits at line 37 and returns the URL byte-identical, plaintext
token included) — traced against the actual production code, not a copy.
`src/lib/analytics-path.test.ts` only exercises the three known prefixes
(`it.each(["portal", "estimates", "review"])`), so this gap is untested
and would not be caught by CI.

**Attack**: whoever has read access to the Vercel Analytics project for
this app (the operator's own vendor dashboard/export — not an open
internet-facing leak, which is why this is `major` not `blocker`) can read
the plaintext invite token for any staff invite sent in the last 72h from
the recorded pageview URL, and redeem it before the intended recipient —
self-enrolling as a staff/admin user in that organization. This is the
same class of leak A1 was built to close (per its own docstring: "the
plaintext token is transmitted to a third-party collector on every page
view"), just for a credential class the fix's route-prefix list forgot.

**Fix**: add `"invite"` handling — either add `"admin"` as a prefix with a
sub-path check (the token is `segments[3]`, not `segments[2]`, since the
route is `/admin/invite/<token>` not `/invite/<token>`), or special-case
`/admin/invite/<token>` directly in `maskTokenPath`. Add a test case for
it alongside the existing three.

### SR-2 — `minor` · `verified` — a legacy account-capability mapping exists with no corresponding verify-sensitivity entry (landmine, not currently reachable)

`src/lib/ai/account-dispatch.ts:48-53`
```ts
const LEGACY_ACCOUNT_INTENT_TOOL: Record<string, AccountCapability> = {
  "membership-account": "membership",
  "account-check-status": "appointment",
  "account-change-appointment": "reschedule",
  "scheduling-reschedule": "reschedule",
};
```
vs. `src/lib/ai/account-verify.ts:24-35` (`INTENT_SENSITIVITY`), which only
has entries for `account-check-status`, `account-change-appointment`, and
`scheduling-reschedule` — **not** `membership-account`.

I traced whether `"membership-account"` can currently reach
`buildAccountLookupReply` with `verdict.action === "ACCOUNT_LOOKUP"`: it
cannot today. `src/lib/ai/intent-router.ts:128-132`
(`LEGACY_ACCOUNT_REFERENCE_INTENTS`) — the only set that gets the special
`ACCOUNT_LOOKUP` treatment for a `FALLBACK_LLM`-categorized entry — has
just the same three ids as `INTENT_SENSITIVITY`. The `membership-account`
knowledge-base entry (`src/lib/ai/knowledge-base.ts:1695`) is
`category: "membership"`, `action: "FALLBACK_LLM"`, and is NOT in
`LEGACY_ACCOUNT_REFERENCE_INTENTS`, so the router's `FALLBACK` branch
nulls its `intentId` before it could ever reach the account-lookup gate
in `route.ts:879` or `voice-turn.ts:331`. Not exploitable today; verified
by reading the full router dispatch chain, not by inference.

**Why it's worth flagging anyway**: `account-verify.ts`'s own doc comment
says "If a new identified-customer account capability is ever added, it
MUST be added here too (this table has no safe default)." But
`account-dispatch.ts` already has the capability WIRING for
`membership-account` sitting there, unused. A future engineer who adds
`"membership-account"` to `LEGACY_ACCOUNT_REFERENCE_INTENTS` (to actually
turn on this capability) has every reason to believe the intent is fully
wired already — the dispatch map already resolves it — and could easily
miss that `account-verify.ts` needs a matching entry too. Since
`requiresVerify` defaults to `false` for any id not in its map, that
oversight would ship `getMembershipSummary` (financial data) with zero
ZIP check, silently.

**Fix**: either delete the dead `"membership-account"` entry from
`LEGACY_ACCOUNT_INTENT_TOOL` until the capability is actually wired up, or
add it to `INTENT_SENSITIVITY` now (as `"financial"`) so the two maps stay
in lockstep and the landmine is defused ahead of time.

### SR-3 — `minor` · `verified` — the financial-verify ZIP lockout is per-session, not per-identity; a new session resets the attempt counter

`src/lib/ai/account-verify.ts:41-42`
```ts
/** Up to 2 verify attempts per call before deferral. */
export const MAX_VERIFY_ATTEMPTS = 2;
```
The lockout (`status: "failed"`) is persisted on `customerSessions.metadata`
(a single session row), keyed by session token/cookie — not by customer
identity. `src/app/api/chat/route.ts` rate-limits session creation at
`RATE_LIMITS.sessionCreate = 5/min` and chat messages at
`RATE_LIMITS.chat = 20/min` (`src/lib/rate-limit.ts:82-84`), both keyed by
IP. An attacker who already knows a target customer's email/phone (enough
to link a session to `accountCustomerId`) can burn the 2-attempt budget,
start a fresh session (new cookie, same IP), and try again — up to 5
sessions/min × 2 ZIP guesses = 10 guesses/min per IP, with no cross-session
memory of prior failures for that customer. This is not a regression this
diff introduced (the same per-session lockout model is shared with the
pre-existing voice channel, and the fix's job was closing the
zero-proof-required leak, which it does), but it means "failed" status is
a soft speed bump, not a hard lockout, and IP rotation removes even that.

**Fix (optional, not blocking)**: consider keying a secondary lockout
counter off `(organizationId, customerId)` with a longer TTL (e.g. in the
existing rate-limit store) so repeated ZIP failures against the SAME
customer across sessions compound, independent of session/cookie churn.

### SR-4 — `minor` · `inferred` — `mint-tech-session.mjs` has no runtime guard against pointing at a production database

`scripts/agent/mint-tech-session.mjs:1-40` reads `DATABASE_URL` from
`.env.local` and, without checking which Neon branch that URL resolves to,
signs and prints a real technician session JWT for whatever `users` row it
finds. This mirrors `scripts/agent/mint-admin-session.mjs` exactly (same
pattern, same lack of a guard) — it is not a new risk this diff
introduces, and the repo's hard invariant ("`.env.local` = DEV Neon
branch. NEVER point it at prod") already governs this at the process
level for both scripts symmetrically. Flagging only because the brief
asked specifically about this new file: it inherits the pre-existing
script's risk profile 1:1, it does not add a new one, and it does not
independently verify the DB it's about to query against a prod hostname
pattern before minting a token.

**Fix (optional, not blocking)**: if this class of risk is ever
hardened, do it once in a shared helper both mint scripts call (e.g.
reject `DATABASE_URL` hosts matching the known prod branch host), rather
than duplicating a check into each script.

### SR-5 — `verified` — everything else claimed (A2, A3, A4, A5, A8, A9, A10, A12, the 0044 migration) holds

Traced directly, not inferred:

- **A2 (CSRF)**: `isSameOriginRequest`/`hasJsonContentType`
  (`src/lib/session-csrf.ts`) are called at the top of
  `POST /api/auth/login`, `POST /api/auth/tech/login`, and
  `POST /api/auth/invite/accept`, before any DB read/bcrypt
  compare/session mint. Absent `Origin` is denied (not silently allowed);
  same-origin is anchored on `request.nextUrl.origin` (host-derived, safe
  on Vercel) plus the configured app origin, not a single hardcoded env
  value. 108/108 relevant tests pass.
- **A3 (demo-send guard)**: correctly scoped. The new
  `isDemoAccount` check in `/api/communications/send`
  (`src/app/api/communications/send/route.ts:55-66`) only fires for an
  authenticated admin session literally logged in as
  `admin@demo-hvac.com` — it cannot suppress the live public `/chat` or
  voice-line demo, since those paths never call `getAdminSession`. The
  separate `consent.ts` guard (`DEMO_ORG_BLOCKED_TRIGGERS`) is scoped to
  ONLY `review_request` (the one no-actor-in-the-loop pipeline), and its
  own test explicitly asserts `appointment_scheduled` (and by extension
  reminders/receipts) is NOT blocked for the same org id — "live
  voice/chat demo must keep sending."
- **A4 (hard-delete/erase → super_admin)**: `isSuperAdmin` gate sits
  directly in the `DELETE`/`POST` handler body in both
  `src/app/api/admin/customers/[id]/route.ts:445-447` and
  `.../erase/route.ts:38-46`, before any query touches the target row —
  not skippable via direct API call. `isDemoAccount` defense-in-depth is
  additive on top, not a replacement.
- **A5 (platform self-purge)**: `src/app/api/platform/organizations/[id]/route.ts:465`
  compares `id === process.env.PLATFORM_ORG_ID?.trim()` before calling
  `purgeOrganization`, with a test asserting `purgeOrganization` is never
  invoked in that case.
- **A8 (audit details free-text)**: both cited sites
  (`membership-plans/route.ts:84`, `pricebook/route.ts:...`) now log
  `JSON.stringify({ billingPeriod/type, fields: Object.keys(...) })`
  instead of interpolating `name`. I additionally grepped every
  `logAudit(...)` call under `src/app/api/admin` and `src/lib/admin` for
  a `name`/`title`/`note` free-text leak beyond the two cited sites; the
  one other hit (`inventory/purchase-orders/[id]/route.ts:120`,
  `` details: `provider=${vendor.name}` ``) is a fixed provider-seam
  identifier (`getVendorProvider().name === "mock"`), not user-entered
  free text — not a violation.
- **A9 (conversation delete)**: gated `super_admin`
  (`src/app/api/admin/conversations/[id]/route.ts:985-987`); the deleted
  session's `audit_log` rows are now `UPDATE ... SET session_id = NULL`
  (`src/lib/admin/conversation-queries.ts:5099-5104`) instead of
  `DELETE`, preserving the audit trail.
- **A10 (integration connect/disconnect)**: `isSuperAdmin` gate confirmed
  present, in the route body, before the mutating call, on all four pairs
  — FieldPulse connect/disconnect, Google connect/disconnect, Housecall
  connect/disconnect (all six route files checked directly).
- **A12 (audit actor join)**: `src/lib/admin/audit-queries.ts:79-82`
  changed the join predicate from `eq(auditLog.userId, users.id)` to
  `and(eq(auditLog.userId, users.id), eq(users.organizationId, organizationId))`
  — a foreign-org `userId` (e.g. platform-provisioned rows) now resolves
  to `actorName: null` instead of leaking the platform admin's real name
  into a tenant's own audit log.
- **0044 migration**: idempotent (`CREATE OR REPLACE FUNCTION` +
  `DROP TRIGGER IF EXISTS` + `CREATE TRIGGER`, three
  `--> statement-breakpoint`-separated statements), and reproduces the
  admin-TIER semantics (`OLD.role IN ('admin', 'super_admin')`), not the
  older admin-only 0008 version. The `'last_active_admin'` RAISE marker
  matches `isLastAdminViolation` in `src/lib/admin/staff-queries.ts:76`
  exactly. `_journal.json` has the matching `idx: 44` entry.
- **A1's event-shape coverage**: `@vercel/analytics`'s `BeforeSendEvent`
  type (`node_modules/@vercel/analytics/dist/index.d.ts`) has exactly two
  fields, `type` and `url` — no `referrer` or other field carries a path.
  `MaskedAnalytics`'s `beforeSend` rewrites `url` on every event, so the
  full documented event surface is covered (the gap is which URLs get
  masked — see SR-1 — not which event fields).

No FROZEN-surface (`src/lib/ai/output-guardrail.ts`,
`src/lib/ai/guarded-stream.ts`) or safety-regex touch anywhere in this
diff — confirmed via `git diff 7787352..HEAD -- src/lib/ai/output-guardrail.ts src/lib/ai/guarded-stream.ts` returning nothing.

---

## Test verification

Ran the tests directly touching every claim above (not the full suite,
per instructions):

```
npx vitest run src/app/api/chat/history/route.test.ts src/lib/ai/account-verify.test.ts \
  src/app/api/auth/login/route.test.ts src/app/api/auth/tech/login/route.test.ts \
  src/app/api/auth/invite/accept/route.test.ts \
  "src/app/api/admin/conversations/[id]/route.test.ts" \
  "src/app/api/admin/customers/[id]/erase/route.test.ts" \
  "src/app/api/admin/customers/[id]/route.test.ts" \
  src/app/api/admin/integrations/fieldpulse/{connect,disconnect}/route.test.ts \
  src/app/api/admin/integrations/google/{connect,route}.test.ts \
  src/app/api/admin/integrations/housecall/{connect,disconnect}/route.test.ts \
  "src/app/api/platform/organizations/[id]/route.test.ts" \
  src/lib/admin/audit-queries.test.ts src/lib/admin/conversation-queries.test.ts \
  src/lib/communication/consent.test.ts src/lib/analytics-path.test.ts \
  src/app/api/admin/membership-plans/route.test.ts src/app/api/admin/pricebook/route.test.ts

Test Files  21 passed (21)
     Tests  146 passed (146)
```

I also hand-evaluated `maskTokenPath` against
`/admin/invite/<64-hex-token>` outside the test harness (reimplementing
the pure function verbatim from source) to confirm SR-1: output was
byte-identical to input, plaintext token intact.

---

## Verdict: **ship-with-fixes**

The A7/A13 chat/voice account-data leak — the headline finding driving
this whole diff — is closed for every code path that can reach it today,
traced end-to-end from the self-reported contact match
(`lookupCustomerContext`/`session.customerId`) through both the chat
route's `ACCOUNT_LOOKUP` gate and `GET /api/chat/history`, on both channels
(chat and voice share `advanceVerify`). The other 8 role/CSRF/audit fixes
(A2, A4, A5, A8, A9, A10, A12, plus the 0044 migration) all hold up under
direct route-level tracing — no guard found in a skippable layer, no
false-positive over-blocking on A3. Ship the diff. Before the next
release, close SR-1 (the invite-token analytics gap — a few lines) and
consider SR-2 (delete or wire up the dangling `membership-account`
mapping) so the two verify maps can't silently drift.
