# Review: specs R1 — public-surface evidence audit

Lens: EVIDENCE AUDIT. Method: every `verified`-tagged claim backing a P0/P1
gap or requirement in `home.md`, `chat.md`, `auth.md`, `portal.md`, `tech.md`
was opened at its cited file/lines and compared against the actual code (and,
for two claims, against a live `npm run dev` response). Findings below are
the discrepancies found; everything else checked out and is not re-listed
(per METHOD.md: a clean check is not a finding).

## Mandated high-stakes checks

### 1. `portal.md` — does `<Analytics/>` leak the raw token path to Vercel Analytics?

**VERDICT: HOLDS. The claim is true.**

`src/app/layout.tsx:30` renders `<Analytics />` in the root layout body, with
no nested `layout.tsx` under `app/portal`, `app/estimates`, or `app/review`
(confirmed via `find` — zero matches). Reading the installed package:

- `node_modules/@vercel/analytics/dist/next/index.mjs:222-232` (`useRoute`):
  `path = usePathname()` (raw pathname) and a separately-masked `route =
  computeRoute(path, finalParams)` are both returned.
- `:247-260` (`AnalyticsComponent`): passes both `path` and `route` straight
  into `<Analytics path={path} route={route} ... />`.
- `:213-217` (base `Analytics`): `if (props.route && props.path) {
  pageview({ route: props.route, path: props.path }); }`.
- `:172-178` (`pageview`): `window.va("pageview", { route, path })` — both
  fields queued/sent together, unredacted.

So for `/portal/<256-bit-token>`, the raw `path` containing the literal
bearer token is handed to the injected Vercel Analytics client on every page
view, exactly as the spec claims. The spec's own `inferred` tag on "this
reaches Vercel's collection endpoint in production" (network traffic not
inspected) is an honest, correctly-scoped caveat — the code-level claim
itself is `verified` and correct.

### 2. `auth.md` — do `/api/auth/login`, `/api/auth/tech/login`,
`/api/auth/invite/accept` really lack the `isSameOriginRequest` CSRF guard,
with no other layer covering them?

**VERDICT: HOLDS. The claim is true.**

- Read all three route files in full: none imports `isSameOriginRequest` or
  `hasJsonContentType` from `src/lib/session-csrf.ts`.
- `grep -rln "isSameOriginRequest\|hasJsonContentType" src/app/api` returns
  exactly 6 files — `availability`, `chat`, `session/confirm`,
  `session/escalate`, `session/feedback`, `upload` — none of the three auth
  routes.
- Checked the one remaining place a guard could hide: `src/proxy.ts`. Its
  `matcher` (`["/api/:path*", "/admin/:path*", "/embed/:path*", "/embed"]`)
  does include `/api/auth/*`, so the middleware **does** run for these
  routes — but the middleware body only special-cases `/embed*`,
  `/admin/*`, and `/api/admin/*`. Everything else, including `/api/auth/*`,
  falls through to the final `// --- Default: apply security headers and
  pass through ---` branch (`proxy.ts:135-141`), which adds only
  `X-Request-Id`/`X-Content-Type-Options`/`X-Frame-Options`/
  `Referrer-Policy`/HSTS — no Origin check, no CSRF guard.
- `readJsonBody` (`src/lib/api-response.ts:28-37`) calls bare
  `request.json()`, which does not inspect `Content-Type` — confirms the
  spec's claim that a cross-site `<form enctype="text/plain">` POST reaches
  these handlers with an attacker-controlled JSON body.

No wrapper, shared helper, or middleware layer covers these three routes.
Gauth-1 is real.

## Findings

| id | spec | severity | tag | quote (verbatim) | what's actually true |
|---|---|---|---|---|---|
| P-E-1 | chat.md | major | verified | "the global `X-Frame-Options: DENY` in `next.config.ts:22` and `proxy.ts:11` does NOT apply to `/embed`. verified." | Empirically false as stated. Booted `npm run dev` and `curl -sD- http://localhost:3000/embed`: the response carries **both** `X-Frame-Options: DENY` (from `next.config.ts`'s `headers()`, which applies to `/:path*` — i.e. every route, including `/embed`) **and** `content-security-policy: frame-ancestors 'self'` (from `proxy.ts:52`) simultaneously. The header is sent on every `/embed` response; it isn't absent. What actually happens is that modern browsers, per the CSP2 spec, prefer `frame-ancestors` over `X-Frame-Options` when both are present — so embedding still works in practice, but by browser-side precedence, not because the header "does not apply." A browser/webview that doesn't implement CSP `frame-ancestors` (rare today, but not zero — some in-app webviews) would still honor `X-Frame-Options: DENY` and block the very embedding this feature exists for. The spec's own cited comment at `proxy.ts:25-31` ("`/embed` ... must NOT get the blanket `X-Frame-Options: DENY`") describes an intent that the code does not fully deliver — `next.config.ts`'s blanket `headers()` config was not given a `/embed` exclusion to match. |
| P-E-2 | portal.md | minor | verified | "None of the three GET page routes are session-gated (`src/proxy.ts:144-146` matcher excludes them; they hit the default pass-through branch, headers only)." | Self-contradictory once you look at what "matcher excludes them" implies. Next.js's middleware `matcher` controls whether the middleware function runs at all for a path — if `/portal/[token]` etc. don't match `["/api/:path*", "/admin/:path*", "/embed/:path*", "/embed"]` (they don't), `proxy.ts`'s function body, including its "default pass-through branch," **never executes** for these routes; there is no branch to "hit." Confirmed empirically: `curl -sD- http://localhost:3000/portal/<token>` returns no `x-request-id` header (which `proxy.ts`'s default branch always sets, `proxy.ts:136-140`), but does return `X-Content-Type-Options`/`X-Frame-Options`/`Referrer-Policy`/HSTS/`Permissions-Policy` — these come from `next.config.ts`'s separate `headers()` config (`next.config.ts:16-38`, explicitly documented there as "including ones the edge middleware doesn't match"), not from `proxy.ts` at all. The citation (`proxy.ts:144-146`, the matcher array) is correct; the inference drawn from it about which code path supplies the headers is wrong. Doesn't affect any Rportal-1..4 requirement — it's scene-setting in Current State, not load-bearing for a gap. |

No other `verified` claim backing a P0/P1 gap or requirement was found to be
inaccurate. Specifically checked and confirmed exact-or-near-exact
(line-drift ≤2, content correct) against source:

- **home.md** — Rhome-1's entire evidentiary basis: `layout.tsx:16-19`
  generic metadata, `page.tsx` full-file read confirms no `metadata`/
  `generateMetadata` export, `grep -rn "openGraph"` under `src/app` → zero
  matches, duplicate Bricolage loader (`layout.tsx:10-14` vs `page.tsx:24-28`,
  identical config), dead `SPEARS.address` (`page.tsx:37`, zero read sites),
  "Staff demo login" copy-canon gap (`page.tsx:233` vs `login-form.tsx:54,191`
  "Sign in"). All confirmed exact.
- **chat.md** — Gchat-1 (the only requirement-backing gap): every citation
  checked exact via `grep -n`, including the precise `customerId={null}`
  line (`chat-experience.tsx:200`, exact), `history-sidebar.tsx:57-61`
  early-return-on-null and the `:121-124` "Sign in to see..." copy (found at
  line 123, in range), and `GET /api/chat/history` deriving the customer
  from the session cookie server-side with no `customerId` param
  (`route.ts:38-56`, confirmed no such param anywhere in the handler).
- **auth.md** — Gauth-2's citation (`session-revocation.ts:22-24`) quotes
  the code comment verbatim, correct. `DUMMY_HASH` timing-safe pattern
  confirmed in both `login/route.ts` and `tech/login/route.ts`.
- **portal.md** — Rportal-3 (invoice `draft` state, no filter in
  `portal-queries.ts:225-235`, FieldPulse/HCP mappers both defaulting to
  `"draft"`) confirmed exact. Rportal-4 (`revokePortalToken` dead code,
  `portal-queries.ts:107-117`, zero call sites) confirmed exact — only the
  definition itself matches the grep. Rportal-2 (P0, service-history table
  empty) is honestly tagged `inferred`/not re-queried this pass — independently
  checked the code instead: `grep` for any `db.insert(serviceHistory)` call
  found exactly one write path, `housecall-pro/webhook-sync.ts:357`, fired
  only on an HCP webhook-driven completion. Neither the tech-portal status
  route (`/api/tech/jobs/[id]/status`) nor any admin dispatch status-update
  route writes to `service_history` at all — so for the product's actual
  native completion path (a technician or dispatcher marking a job done in
  this app), the table is *structurally* guaranteed never to gain a row,
  regardless of any org's historical data state. This is stronger evidence
  for the P0 than the spec cites; the `inferred` tag undersells rather than
  oversells the finding.
- **tech.md** — Gtech-1 (bare `<Trash2>` `<button>` with zero size/padding
  classes, `tech-job-detail-client.tsx:581-588`) confirmed exact, including
  the exact className string. Gtech-2 button-height table
  (`button.tsx:22-34`: `default`=h-8/32px, `sm`=h-7/28px, `lg`=h-9/36px,
  `icon`=size-8/32px; `input.tsx:18`=h-8/32px) confirmed exact against the
  `cva` definition. Gtech-3 (dead-end error strings, no retry) and Gtech-5
  (no retry on failed material/note/signature submit) confirmed at all six
  cited call sites via `grep -n`, all within 1-2 lines of the cited numbers.
  Gtech-4 (`tech-job-summary.tsx:194-207`, every status renders as an
  identically-weighted `Button`, no confirm step, direct `advance(s)` call)
  confirmed exact.

## Verdicts

- **home.md** — sign-off
- **chat.md** — sign-off
- **auth.md** — sign-off
- **portal.md** — sign-off (P-E-2 is a minor, non-blocking correction to a
  scene-setting sentence; no requirement depends on it)
- **tech.md** — sign-off

`chat.md`'s P-E-1 is a `major`, not a `blocker`: it doesn't back a P0/P1 gap
or invalidate Rchat-1 (the spec's only requirement, which is about the
History sidebar and untouched by framing headers). It's flagged because the
brainstorm section marks the whole frame-ancestors mechanism `verified` and
"shipped," and a future reader could reasonably conclude from that sentence
that `/embed` is exempt from `X-Frame-Options: DENY` at the header level,
when in fact the exemption is incomplete and currently rests on browser-side
CSP precedence rather than the header actually being withheld.
