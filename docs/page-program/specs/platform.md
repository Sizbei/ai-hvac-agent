# platform — target-state spec

`/admin/platform` — the cross-tenant operator console.

## 1. Purpose

Let a PLATFORM admin (env-allowlisted, bound to one designated org — not any
in-org role) provision new tenant organizations, see every tenant that
exists, pull a tenant's data for due-diligence/portability, and destroy a
tenant. One job: the single place cross-tenant power is exercised, so its
gating and guardrails ARE the multi-tenancy boundary for this repo's most
dangerous actions.

## 2. Brainstorm

Considered, and what shipped or got cut:

- **Env-allowlist + designated-org binding for platform authority (not a DB
  role)** — shipped. Rejected alternative: a `platform_admin` boolean on
  `users`. Reason documented in the code itself: email-only allowlisting was
  tenant-forgeable (a tenant super_admin could mint a user with an
  allowlisted email inside their OWN org and self-escalate to all-tenant
  access); binding to `PLATFORM_ORG_ID` closes that because an attacker can't
  place a user inside an org they don't control. verified
  (`src/lib/auth/authz.ts:50-57`).
- **Cross-org data export for due diligence / GDPR portability** — shipped
  (`src/app/api/platform/organizations/[id]/export/route.ts`). Rejected
  alternative: no export, tell the platform admin to query the DB directly.
  Reason: DB access is a bigger blast radius than a gated, audited,
  secret-free application route. verified.
- **Purge = irreversible cascade delete, not a soft "archived" flag** —
  shipped. Rejected: soft-delete/archive. Reason:
  `docs/page-program/specs/platform.md` domain reality — a tenant asking to
  be fully removed (offboarding, GDPR) needs the org gone, and migration 0017
  already makes the FK cascade the mechanism (`erasure-queries.ts:15-18`).
  Soft-delete would need a parallel "is this org actually gone" concept
  everywhere else in the app for no real benefit. YAGNI.
- **Type-the-org-name confirmation gate before purge (client-side)** —
  shipped (`platform-console.tsx:216,281` — button `disabled` until
  `confirmText === org.name`). Rejected a stronger second factor (re-auth, a
  server confirmation token): the route is already platform-admin +
  rate-limited + audited, and the self-purge gap this spec found
  (Gplatform-1) is a bigger hole than the confirmation UX — fix that first.
- **No sidebar nav entry for `/admin/platform`** — shipped (absent from
  `src/components/admin/nav-items.ts:43-92`, confirmed by grep). Deliberate:
  reach is by direct URL only, server-gated either way; a nav link would only
  advertise a surface ~100% of admins can't use. Not a gap.
- **Manual org status override (suspend/reactivate)** — rejected.
  `organizations.status` is written in exactly one place outside
  provisioning/erasure: `src/lib/billing/webhook-sync.ts`. Status is
  billing-automation-owned; a manual override would create two writers with
  no evidenced demand.
- **Search/filter/pagination on the org list** — rejected. Hard-capped at
  `PLATFORM_MAX_ORGS` (default 100, `provisioning.ts:57-64`), 4 columns; a
  flat table is enough at that scale.
- **Per-org drill-in detail page** — rejected. No evidence of demand and it
  would duplicate what the export flow already answers.
- **An admin UI to grant/revoke platform-admin access** — rejected by
  design: env-only precisely so cross-tenant power is never an in-app grant
  (`authz.ts:36-44`). No such UI exists anywhere in `src/app/admin`.
- **A read surface for `platform_audit_log`** — considered cutting it (ship
  without one, like today) vs. fixing now. Decision: fix now (Gplatform-2 →
  Rplatform-2) — an unreadable audit trail gives none of the accountability
  it exists for; every write path already produces the rows, this only adds
  a read.

## 3. Current state

**Pages / components** (verified — read in full):
- `src/app/admin/(dashboard)/platform/page.tsx` — server component; calls
  `getAdminSession()` then `isPlatformAdmin(session)`, `redirect('/admin')`
  on failure (`:17-20`). Renders `PageShell` + `PageHeader` +
  `PlatformConsole`.
- `src/components/admin/platform/platform-console.tsx` (438 lines) — client
  component. Fetches `GET /api/platform/organizations` on mount
  (`:80-101`), renders a table (name / status badge / created / actions).
  Per-row actions: **Export** (`window.location.href` navigation to the
  export route, `:153-161`) and **Purge** (opens `PurgeTenantDialog`,
  `:165-172`). Header action: **Create tenant** dialog
  (`CreateTenantDialog`, `:293-438`) — on success shows the one-time invite
  URL with a copy button (`:365-394`); the URL is never persisted client-side
  beyond component state.
- `OrgStatusBadge` (`:43-67`) maps `active/suspended/trial/past_due` to
  token-based badge classes; an unrecognized status renders the raw string
  with neutral styling instead of crashing (`:59-60`) — matches the page
  skill's documented invariant.
- `PurgeTenantDialog` (`:196-291`) requires typing the exact org name
  (`confirmText.trim() === org.name`, `:216`) before the destructive button
  enables (`:281`).

**Server** (verified — read in full):
- `GET /api/platform/organizations` (`route.ts:29-70`) — `getAdminSession`
  → `isPlatformAdmin` → 401/403, then a rate check
  (`RATE_LIMITS.adminRead` = 60/min/user, `rate-limit.ts:90`), then an
  UNSCOPED `SELECT id, name, status, createdAt FROM organizations ORDER BY
  createdAt DESC` (`:48-56`) — this is the one legitimate cross-tenant list
  query in the repo; it returns no PII beyond the org's business name.
- `POST /api/platform/organizations` (`route.ts:77-175`) — same gate order,
  `RATE_LIMITS.adminMutation` (30/min/user, `rate-limit.ts:86`), Zod-validates
  `{name, ownerEmail}` (`:72-75`), calls `provisionOrganization` →
  `createOrgCore` (`provisioning.ts`), which runs the whole
  org+settings(+user) insert as ONE `db.batch` (`provisioning.ts:241,243` —
  correctly avoids `db.transaction()`, which neon-http doesn't support). A
  DB-backed org-count cap (`resolveMaxOrgs`, default 100,
  `provisioning.ts:57-64`) is the real ceiling — the route's in-memory rate
  limiter can't throttle across serverless instances (comment,
  `provisioning.ts:62`). On success: audits `org_provisioned` to the per-org
  `audit_log` in the NEW org, details carry only ids/enums, never
  `ownerEmail` (`route.ts:151-165`); returns a one-time invite URL built from
  the request origin (`:146-149`), never stored in plaintext.
- `DELETE /api/platform/organizations/[id]` (`[id]/route.ts:27-64`) — same
  gate order + `adminMutation` rate limit, UUID-format check (`:47-49`),
  calls `purgeOrganization(id, actor)` (`erasure-queries.ts:406-…`), which:
  pre-reads the org's R2 storage keys BEFORE the cascade
  (`erasure-queries.ts:419-435`), writes evidence to `platform_audit_log`
  FIRST — deliberately not org-FK'd so it survives the cascade
  (`:437-…`, module doc `:15-18`) — then a single `DELETE FROM organizations
  WHERE id = ...` cascades all 24 org-scoped FKs (migration 0017, per module
  doc). R2 cleanup runs in `after()`, never a detached promise
  (`erasure-queries.ts:63-76`).
- `GET /api/platform/organizations/[id]/export` (`export/route.ts:26-78`) —
  same gate order + `adminRead` rate limit, UUID check, calls
  `exportOrganization(id)` (`export-queries.ts:72-221`) which decrypts every
  PII column for the target org (customer name/phone/email/address,
  signatures) into one JSON object — legitimate because the export IS the
  data subject's data for a due-diligence/portability use case — but
  explicitly EXCLUDES secrets and auth material (module doc,
  `export-queries.ts:6-8`: no ciphertext ids, `passwordHash`, token hashes,
  or blind-index hashes). Streamed back as a `Content-Disposition: attachment`
  JSON download (`export/route.ts:67-73`). Records `org_data_exported` to
  `platform_audit_log` with row COUNTS only, never the payload
  (`export-queries.ts:227-235`, `export/route.ts:58-65`).
- `isPlatformAdmin` (`authz.ts:45-67`) fails CLOSED unless BOTH
  `PLATFORM_ADMIN_EMAILS` and `PLATFORM_ORG_ID` are set (`:56`), and requires
  `session.organizationId === platformOrgId` (`:57`) — the fix for the
  tenant-forgeable email-only design, documented inline (`:50-55`).
- All three routes independently re-run `getAdminSession` →
  `isPlatformAdmin`; there is no shared middleware doing this for
  `/api/platform/*` (verified by reading all three files in full — each
  repeats the same two-line gate).
- Role-gate test coverage exists and passes for all three routes: a
  non-platform-admin (including an in-org `super_admin`) gets 403 on
  GET/POST list-create (`organizations/route.test.ts:85-92`), DELETE purge
  (`[id]/route.test.ts:61-68`), and GET export (`export/route.test.ts:61-68`)
  — directly answers "can a plain org admin/super_admin reach any of it": no.

**Not yet documented in `.claude/skills/page-platform/SKILL.md`**: the
Export button/route and `/api/platform/billing` do not appear in the
skill's Files list, which cites only the create+purge routes. Not this
spec's job to fix, noted so the next editor isn't surprised.

## 4. Gaps

| Gap | Severity | Evidence |
|---|---|---|
| Gplatform-1: Purge has no guard against deleting the platform's own operating org | P0 | `DELETE /api/platform/organizations/[id]` (`[id]/route.ts:27-64`) never compares `id` to `PLATFORM_ORG_ID` or to the acting session's own `organizationId`. `GET /api/platform/organizations` (`route.ts:48-56`) lists ALL orgs with no filter excluding the platform's own org, so it appears as an orderable row in the console table with a live Purge button. `users.organizationId` is `ON DELETE CASCADE` to `organizations.id` (`schema.ts` users table def), so purging that org deletes every user row bound to it — including every platform admin — and `isPlatformAdmin` requires `session.organizationId === platformOrgId` (`authz.ts:57`), so once that org is gone, no session can ever satisfy the check again (env vars alone are insufficient without a live, matching org). This is an irrecoverable, product-wide lockout triggerable by one confirmed click in the tool that exists specifically to manage tenants — a destructive platform action with an insufficient guard. |
| Gplatform-2: `platform_audit_log` — the record of every cross-tenant action (provision, export, purge) — has no read surface anywhere in the app | P1 | Every write path exists and is correct (`route.ts:154-165` org_provisioned, `export/route.ts:58-65` org_data_exported, `erasure-queries.ts:437-…` org_purged), but a repo-wide grep for `platformAuditLog` (`grep -rln platformAuditLog src`) finds it referenced only in the three write sites, `schema.ts`, and their own tests — no `GET` route or admin page selects from it. The per-org `/admin/audit-log` page is scoped to the session's own `organizationId` and structurally cannot show this table (it isn't org-FK'd, per the module doc `erasure-queries.ts:17-18`, precisely so it survives an org purge). The most consequential action surface in the app (irreversible cross-tenant deletes and PII exports) currently has zero in-app accountability trail for the platform admins who are the only people allowed to act on it. |
| Gplatform-3: `GET /api/platform/organizations` (the list read) is not itself audited | P2 | Unlike create/export/purge, the list route (`route.ts:29-70`) writes nothing to `platform_audit_log` when a platform admin enumerates every tenant on the platform. Low severity — the response carries only `id/name/status/createdAt`, no PII — but it is the one cross-tenant read with no audit trail at all. |
| Gplatform-4: Skill doc drift — Export button/route and the billing route are undocumented in `.claude/skills/page-platform/SKILL.md` | P2 | Skill's Files list (`SKILL.md:12-18`) cites only the page, console, `authz.ts`, the list+create route, and the purge route — not `[id]/export/route.ts` (which the console links to, `platform-console.tsx:157`) or `api/platform/billing/route.ts`. Documentation gap, not a code gap; `verify-skills.mjs` doesn't catch missing entries, only invalid ones. |

## 5. Requirements

Gplatform-1 (P0) and Gplatform-2 (P1) clear the bar.

- **Rplatform-1**: `DELETE /api/platform/organizations/[id]` must refuse to
  purge the org bound to `PLATFORM_ORG_ID`, and the console must not offer a
  working Purge action for that row.
  **Acceptance criterion**: calling
  `DELETE /api/platform/organizations/{PLATFORM_ORG_ID}` returns a 4xx (not
  200, not 500) with a human error, and no row in
  `organizations`/`platform_audit_log` reflects a completed purge of it. A
  new route-level test asserts this (mirrors the existing 401/403/404 cases
  in `[id]/route.test.ts`). Client-side, the Purge button for that org's row
  is disabled/hidden — belt-and-suspenders; the server check is authoritative
  per repo convention (`platform/page.tsx:13-14`).
- **Rplatform-2**: A platform admin can view the cross-tenant audit trail
  (`platform_audit_log`) from within the app.
  **Acceptance criterion**: a new `GET` route (same gate + rate-limit order
  as the existing three routes) returns recent `platform_audit_log` rows
  (action, actor email, target org id, created at — no `details` payload
  unless it's already counts-only, per this table's existing PII-free
  convention), and `PlatformConsole` renders them. No new cross-org table is
  introduced — only a read path for rows that already exist. A pure-function
  test (no jsdom) covers the row-shaping function extracted for the list.

## 6. Non-goals

- Not building a manual org-status override (suspend/reactivate) — status is
  billing-webhook-owned; see Brainstorm.
- Not adding search/filter/pagination to the org list — scale doesn't
  warrant it (see Brainstorm, `PLATFORM_MAX_ORGS` default 100).
- Not building a per-org drill-in detail page — the export flow already
  answers that need; see Brainstorm.
- Not adding any in-app way to grant/revoke platform-admin status — that is
  the deliberate, tested security boundary (env-only, `authz.ts:36-44`); an
  in-app grant path would reopen exactly the tenant-forgery hole the
  `PLATFORM_ORG_ID` binding was added to close.
- Not touching the type-the-org-name purge confirmation UX, the invite-URL
  one-time-display pattern, `isPlatformAdmin`'s env-binding logic, or the
  export route's PII-inclusion/secret-exclusion boundary — verified correct.
- Gplatform-3 and Gplatform-4 (P2) stay in Gaps/backlog per METHOD.md's
  severity gate; not implementation work in this run.

## 7. Invariants

- **Platform authority is env-only, never a DB role or in-app grant** —
  `isPlatformAdmin` checks `PLATFORM_ADMIN_EMAILS` AND requires
  `session.organizationId === PLATFORM_ORG_ID` (`authz.ts:45-67`). Rplatform-1
  and Rplatform-2 must not introduce any other way to grant/check it.
- **Every `/api/platform/*` route re-checks `getAdminSession` →
  `isPlatformAdmin` independently** — no shared gate exists; a new route
  (Rplatform-2) must repeat the same gate + `slidingWindow` rate check the
  other platform routes use.
- **`platform_audit_log` is intentionally not FK'd to `organizations`**, so
  it outlives a purged org (`erasure-queries.ts:15-18`). Rplatform-2's read
  route must not join it against `organizations` in a way that would drop
  rows for already-purged orgs.
- **Audit `details` never carries PII** — every existing write stores
  ids/enums/counts only (`route.ts:160-163`, `export-queries.ts:227-235`).
  Rplatform-2's display must not decrypt or add anything beyond that.
- **Purge stays a real, irreversible cascade delete** — Rplatform-1 blocks
  ONE target (the platform's own org), not purge in general; the cascade
  mechanics (migration 0017, pre-read→audit→delete order in
  `erasure-queries.ts`) are unchanged.
- **Evidence-before-destruction ordering** — new guard logic must preserve
  writing the audit row before/atomically-with the irreversible action.
- Tenancy: the org-list/export/purge queries are the intentional exception to
  per-request `organizationId` scoping (cross-tenant by design, gated by
  `isPlatformAdmin`) — this does not license any OTHER route to drop scoping.
- Demo account / FROZEN chat safety text / neon-http `db.batch` /
  `after()`-not-detached — repo-wide invariants from `AGENTS.md` and
  `admin-pages` SKILL.md; none touched by this page's fixes.

## 8. Verification

- `npx tsc --noEmit` → 0.
- `npx eslint src/app/api/platform/organizations/[id]/route.ts src/components/admin/platform/platform-console.tsx <any new route file>` → 0 errors.
- `npx vitest run` → must not drop below the live baseline (`docs/page-program/README.md`).
- Targeted platform-route regression pack (must stay green):
  `npx vitest run src/app/api/platform/organizations/route.test.ts src/app/api/platform/organizations/[id]/route.test.ts src/app/api/platform/organizations/[id]/export/route.test.ts src/lib/admin/erasure-queries.test.ts`
- New tests for Rplatform-1: purge-own-platform-org returns a 4xx and does
  not delete the row; existing 401/403/404 purge cases still pass unchanged.
- New tests for Rplatform-2: the new audit-read route 403s for a
  non-platform-admin, 200s with shaped rows for a platform admin; a pure
  formatting/derivation function has a no-jsdom vitest unit test.
- Manual/visual: `npm run dev` (background), mint a session whose org id
  matches a dev `PLATFORM_ORG_ID`/`PLATFORM_ADMIN_EMAILS`, then
  `node scripts/agent/screenshot-page.mjs /admin/platform` — confirm the
  platform's own org row shows Purge disabled/guarded, and the new audit
  view renders recent provision/export/purge entries.
