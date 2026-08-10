# Review: specs R1 — public-surface MISSED RISK audit

Lens: MISSED RISK. Not "is what the spec says true" (a separate evidence
audit already covers that) — what did `home.md`, `chat.md`, `auth.md`,
`portal.md`, `tech.md` never look at, across authn/authz, token security,
input handling, abuse/cost, enumeration/disclosure, and session lifecycle.
Every finding below is grounded in code read directly for this pass, not
restated from the specs' own Gaps tables.

Method: read the full request lifecycle of every unauthenticated/
semi-authenticated route under `src/app/api/{session,chat,auth,portal,
estimates,review,tech,widget,upload}` and `src/proxy.ts` /
`next.config.ts`, cross-referenced against what each spec's Current
State/Gaps/Invariants sections claim or omit. A live `npm run dev` instance
was used to confirm the `/embed` header-conflict finding by direct `curl`;
the identity/verify-gate finding (P-R-1) is grounded in a full read of the
exact execution path (not live-exploited — the dev server was torn down
mid-session) but every line cited was opened and traced, matching the
specs' own convention of `verified` for code-level claims not re-run live.

---

## Findings

### P-R-1 — Chat's customer-identity gate has no possession proof; 3 of 5 account-data intents require ZERO secondary verification; and the (currently dead) history endpoint already leaks a stranger's past-conversation previews to anyone who types their phone/email

**Severity: blocker. Tag: verified.**

`chat.md`'s Current State treats "account lookups (ZIP-verify gated)" as a
settled, verified fact (line 109: *"then the deterministic router
(`:783-1500ish`) for known-slot capture, emergencies, account lookups
(ZIP-verify gated), and only falls back to `streamText`..."*). Reading the
actual gate shows this description is true for exactly 2 of 5 account-data
intents and is not the identity check the phrasing implies.

**1. The "identity" step is a self-reported, unauthenticated contact field.**
`src/app/api/chat/route.ts:701-727`: whenever a session has no linked
customer yet, the route calls `lookupCustomerContext(organizationId, {
email: resolvedEmail, phone: resolvedPhone })` where `resolvedEmail`/
`resolvedPhone` come straight from `extractSlots(guardrailResult.sanitized)`
— i.e. whatever the current chat message says. `lookupCustomerContext` →
`findCustomerIdByContact` (`src/lib/admin/crm-queries.ts:643-681`) does an
indexed blind-index lookup on `customers.emailHash`/`customers.phoneHash`
and returns the first match — **no OTP, no email-link, no callback, no
possession proof of any kind**. A match immediately writes
`customerSessions.customerId` for the session (`chat/route.ts:713-716`).
Anyone who knows (not owns) a real customer's phone number or email —
trivially obtainable from mail, a doorhanger, a reverse-phone lookup, or
simply guessing a common local number — can "become" that customer for the
rest of the session by typing it into the public chat widget.

**2. Only 2 of 5 account-data intents gate on anything past that.**
`src/lib/ai/account-verify.ts:4-9` (`INTENT_SENSITIVITY`): only
`account-data-balance` and `account-data-membership-status` are
`"financial"` (ZIP-gated); `account-data-next-visit`,
`account-data-appointment-status`, and `account-data-reschedule` are
`"none"`. `requiresVerify()` (`:11-13`) returns `false` for those three, so
`advanceVerify` (`account-verify.ts:82-91`) short-circuits straight to
`{ kind: "serve", verify: state }` with **no ZIP challenge at all**. In
`chat/route.ts:879-987` (the `verdict.action === "ACCOUNT_LOOKUP" &&
accountCustomerId` branch), `needZips` at `:889` is only computed
`requiresVerify(verdict.intentId) && verifyState?.status === "pending"` —
for the three "none" intents this is always false, and `buildAccountLookupReply`
is invoked directly. Net effect: typing any customer's phone/email into the
public chat, with **zero** follow-up verification, returns that customer's
real upcoming-appointment date/status (`getUpcomingAppointment`,
`account-tools.ts:241-278`) and lets the attacker file a `requestReschedule`
staff note against their real service request (`account-tools.ts:292-335`)
— an unauthorized write attributed to a request they don't own.

**3. Even where the ZIP gate applies, it's cheaply resettable.** The
2-attempt lockout (`MAX_VERIFY_ATTEMPTS = 2`, `account-verify.ts:16`) lives
in `customerSessions.metadata` — per session, not per customer/phone. A
fresh session is 5/min/IP (`RATE_LIMITS.sessionCreate`,
`src/app/api/session/route.ts:33-38`), with no per-target-phone or
per-target-customer throttle anywhere. An attacker gets 2 fresh ZIP guesses
every 12 seconds against the same target by discarding the session cookie
and calling `POST /api/session` again. The valid-answer space is not the
full 100,000 five-digit range — `loadOnFileZips` returns the real
customer's on-file ZIP(s), which for an HVAC contractor's actual service
radius (`BUSINESS_BASE_LOCATION`, ~50km) is a small regional set. This is a
practically breakable secondary factor, not a real second factor.

**4. `GET /api/chat/history` already returns this data today, independent of
the Gchat-1 UI bug.** `src/app/api/chat/history/route.ts:1-124` requires
only a valid `hvac_session_token` cookie and `currentSession.customerId` —
the SAME weakly-established link from point 1. If set, it returns up to 10
past session previews for that customer including a 60-character snippet of
their first message (`:106-111`) — address fragments, issue descriptions,
names. `chat.md`'s own Gchat-1 frames this purely as a UI wiring bug ("the
History button ... is permanently non-functional dead UI") and never asks
whether the *server* route it's about to surface more prominently is itself
safe to expose. It currently is not gated by anything beyond the same
unauthenticated contact-field match — this is a live, callable leak today
via a direct fetch to `/api/chat/history`, not a hypothetical dependent on
the UI fix shipping.

**5. Rchat-1, as specified, would deliberately widen this into a more
visible UI surface using the exact same weak trust anchor.** `chat.md:166-167`
(the Rchat-1 acceptance criterion): *"with a session whose `customerId` is
set server-side (e.g. after a contact-field match), opening the History
sidebar calls `GET /api/chat/history` and renders the returned sessions."*
The spec's own fix text names "a contact-field match" as the trust signal
that should unlock a stranger's conversation history in the UI — the exact
mechanism shown above to require no possession proof. Shipping Rchat-1
exactly as written does not introduce a new bug, but it does take a
currently-obscure API-only leak and put it one button-click away in the
product UI, which is a materially different risk posture that the spec
never discusses.

**Which spec should have caught this:** `chat.md`. Its own lens (this
review's Abuse & cost / authn item, and the assignment's explicit callout
of "the chat endpoint takes free text straight to an LLM... IDOR on any
`[id]`/`[token]` route") is exactly the shape of this bug — a customer
"identity" resolved from attacker-controlled free text. The spec instead
describes the mechanism approvingly: *"account lookups (ZIP-verify gated)"*
(line 109) and, in the Requirements section, writes the fix in a way that
inherits the same gap (`chat.md:166-167`, quoted above).

**Suggested fix shape (not scoring — flagging for the next spec pass):** the
`INTENT_SENSITIVITY` table should not have a `"none"` tier for
`account-data-next-visit`/`account-data-appointment-status`/
`account-data-reschedule` — at minimum they need the same ZIP gate the
financial intents get, and `GET /api/chat/history` needs the same. The
deeper fix (fixing the contact-match itself, e.g. an OTP-style
confirm-your-phone-number step before ANY account read, financial or not)
is a bigger design decision that at least needs to be named as a gap, not
silently inherited by Rchat-1.

---

### P-R-2 — Chat's own highest-cost surface (LLM token spend) relies on the identical per-instance-only rate limiter auth.md flags as a gap for itself, but `chat.md` never examines it

**Severity: major. Tag: verified.**

`src/lib/rate-limit.ts:5` backs `slidingWindow` with a module-level `Map` —
every warm serverless instance gets an independent budget. `auth.md` names
this explicitly as Gauth-4 for the login/invite routes ("per-lambda-instance,
not shared... repo-wide pattern... recorded rather than treated as new
work"). `chat.md` never mentions it, despite `/api/chat` and `/api/session`
being the two routes in this entire spec set that directly spend real money
per request (an LLM call on every fallback turn, plus the async extraction
LLM call + up to one repair re-prompt on nearly every turn —
`src/lib/ai/extract.ts:267-325`).

Concretely: `RATE_LIMITS.chat` = 20 req/min per IP
(`src/app/api/chat/route.ts:333-340`) and `RATE_LIMITS.sessionCreate` =
5 req/min per IP for session creation (`src/app/api/session/route.ts:33-38`)
are both keyed `` `chat:${ip}` ``/`` `session:create:${ip}` `` against the
same per-instance `Map`. Under normal Vercel autoscaling this budget
multiplies by however many warm instances are serving traffic, and an
attacker rotating across a handful of source IPs (residential proxy pools
are cheap and commonly used for exactly this) faces no aggregate ceiling at
all — no per-organization token budget cap is enforced at the rate-limit
layer (the per-org `maxTurns`/token budget in `chat-limits.ts` gates a
single session's turns, not the rate of *new* sessions being created). This
is the one endpoint in the whole public surface where "abuse costs the
business real money on every successful request" is the literal threat
model, and the spec's own lens item 4 ("missing or per-instance-only rate
limiting on anything that costs money (LLM tokens...)") names this exact
scenario — yet `chat.md`'s Current State only records that rate limiting
"exists" (`chat.md:103`: *"`POST /api/chat`... CSRF... rate limiting,
terminal/submitted-state gates..."*) with no interrogation of whether it's
adequate against the page's own stated cost surface.

**Which spec should have caught this:** `chat.md`. Quote of the blind spot:
*"`POST /api/chat` (`src/app/api/chat/route.ts`, 2169 lines) — CSRF
(same-origin + JSON content-type, `:346-355`), rate limiting,
terminal/submitted-state gates..."* (`chat.md:102-105`) — "rate limiting"
is stated as a settled fact with no assessment of its per-instance
weakness, unlike `auth.md`, which named the identical mechanism as a
tracked gap for a lower-cost surface (bcrypt compares, not LLM calls).

---

### P-R-3 — `/embed` ships two conflicting frame-protection headers on the same response; the CSP-based per-org allowlist chat.md verifies is silently paired with a global `X-Frame-Options: DENY` from `next.config.ts`

**Severity: minor. Tag: verified (confirmed live).**

`chat.md:131-135` verifies the `/embed` framing story entirely through
`src/proxy.ts:25-49` ("`X-Frame-Options: DENY` in `next.config.ts:22` and
`proxy.ts:11` does NOT apply to `/embed`" — asserted, not checked against
the actual merged response). `next.config.ts`'s `headers()` function
(`next.config.ts:16-36`) applies `X-Frame-Options: DENY` to `source:
"/:path*"` — i.e. **every** route, including `/embed`, with no exclusion.
Confirmed live:

```
$ curl -s -D - -o /dev/null http://localhost:3000/embed
X-Frame-Options: DENY
content-security-policy: frame-ancestors 'self'
```

Both headers are present simultaneously. Per the CSP spec, a browser that
understands `frame-ancestors` ignores `X-Frame-Options` when both are set,
so this does not currently break embedding in any evergreen browser — the
practical risk is the opposite of a security hole: an older or embedded
webview that honors `X-Frame-Options` but not CSP `frame-ancestors` would
silently refuse to frame the widget even for an org on its own allowlist, a
functional regression rather than an exploitable one. Flagged as minor
because the spec's Brainstorm section presents the per-org `frame-ancestors`
scoping as a deliberate, verified security control ("This blocks
clickjacking by sites the org hasn't authorized" — proxy.ts:31) without
having checked what actually reaches the wire once `next.config.ts`'s
blanket header is layered on top.

**Which spec should have caught this:** `chat.md`, same "verified"
`/embed` framing paragraph cited above — it read `proxy.ts` and
`next.config.ts` separately but never composed the two into what a real
response actually contains.

---

## Checked and clean (no finding — not restating spec-found gaps)

- `src/lib/ai/extract.ts` — the async slot-extraction LLM call is a genuine
  prompt-injection target (free text → model → structured JSON merged into
  session state) but `neutralizeUnsafeExtraction` (`extract.ts:353-369`)
  already drops every free-text field when `validateExtractionOutput` flags
  the turn, and no LLM in this codebase is wired with tool-calling / side
  effects (`grep -rln "tool(" src/lib/ai src/app/api` → zero matches), so
  there is no reachable indirect-injection-to-action path today.
- `src/lib/widget/cors.ts` / `origin.ts` — reflects `Access-Control-Allow-
  Origin` only for allowlisted origins (or when the org has configured no
  allowlist, matching the documented "empty = open, key-gated" policy); no
  `Access-Control-Allow-Credentials` is ever set, so this isn't a credentialed-
  CORS hole.
- `src/app/api/upload/route.ts` / `src/lib/storage/r2-client.ts` — CSRF-
  gated, session-rate-limited, magic-byte content validation (not
  extension/MIME-string trust), 15-minute signed read URLs. No IDOR: keys
  are namespaced by org+session, never client-suppliable.
- `src/app/widget.js/route.ts` — app origin is pinned from
  `NEXT_PUBLIC_APP_URL` (never the spoofable `Host` header) with a hard
  production fail-closed if unset; SVG injection uses a `<template>` parse,
  not `innerHTML` on remote content. No cache-poisoning or XSS vector found.
- `src/app/api/session/escalate/route.ts`, `.../feedback/route.ts` — both
  independently CSRF-guarded (`isSameOriginRequest`) and rate-limited in
  their own buckets (feedback deliberately separated from escalate "so
  feedback votes can't exhaust the escalation budget," `feedback/route.ts:26-27`)
  — a real instance of the abuse-lens working as intended, not a gap.
- `src/app/api/auth/signup/start` / `.../callback` — the cross-org existing-
  email check (`signup.ts:63-69`) is not a practical enumeration oracle: it
  only fires after a real, freshly-verified Google id_token for that exact
  email, which requires controlling the target's Google account, not just
  knowing their email address.
- All 8 `/api/tech/*` route files import `getTechSession` (verified by
  listing every route under `src/app/api/tech` and confirming none is
  missing it) — `tech.md`'s "mirrored across list/detail/mutation routes"
  claim holds with no exception found.
- `src/lib/session-csrf.ts` — the Origin-anchoring design (same-origin OR
  `NEXT_PUBLIC_APP_URL`, absent-Origin denied) is sound and its own doc
  comment already discloses the one real caveat (Host-header trust off
  Vercel), so there's nothing this review can add.

---

## Counts

- Blocker: 1 (P-R-1)
- Major: 1 (P-R-2)
- Minor: 1 (P-R-3)

## Most dangerous thing the specs missed

**P-R-1**: the chat page's account-lookup "identity" is nothing more than a
phone number or email typed into the box — no possession proof — and for 3
of its 5 account-data capabilities (next-visit, appointment-status,
reschedule) that's the *entire* gate, with no ZIP/OTP/anything-else behind
it. Anyone who knows a real customer's phone number can pull their upcoming
appointment info through the public, unauthenticated chat widget today, and
`GET /api/chat/history` — already live, not gated behind the Gchat-1 fix —
will hand over snippets of that stranger's past conversations on the same
unverified link. `chat.md` treats the whole account-lookup surface as
"ZIP-verify gated" and writes its own headline fix (Rchat-1) to trust the
identical weak signal for showing conversation history in the UI.

## Per-spec verdicts

| Spec | Verdict |
|---|---|
| `home.md` | sign-off — no material blind spot found for this lens. |
| `chat.md` | **blocked** — P-R-1 (blocker) and P-R-2 (major) are both squarely inside this page's own attack surface. |
| `auth.md` | sign-off — no material blind spot found beyond what the spec itself already tracks (Gauth-1–5). |
| `portal.md` | sign-off — no material blind spot found; the spec's own P0/P1 findings already cover this surface's real risk. |
| `tech.md` | sign-off — assignee+tenant guard verified with no exception across all 8 routes; no material blind spot found. |
