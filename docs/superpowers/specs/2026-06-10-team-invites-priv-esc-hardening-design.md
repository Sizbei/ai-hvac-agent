# Team Invites + Privilege-Escalation Hardening — Design

**Date:** 2026-06-10
**Status:** Approved
**Branch:** `feat/team-invites-priv-esc`

## Goal

Let an admin invite teammates to the org via a copyable, tokenized signup link
(no email dependency), and harden the staff/auth surface to production grade by
fixing the privilege-escalation and multi-tenant correctness findings from the
2026-06-10 audit. Roles are unchanged: `super_admin > admin > technician`
("technician" is field staff / "worker" — kept as-is, no new role).

This is one cohesive change set: the hardening fixes touch the exact
`users`/email surface the invite flow writes to, so they ship together.

## Non-Goals (YAGNI)

- No email/SMS delivery of invites. The admin copies the link and sends it
  however they like. A clean seam is left so email can be added later.
- No new role. "Worker" == existing `technician`.
- No cross-org access. Everything stays org-scoped.
- No bulk invites, no invite resend (revoke + re-invite covers it).

---

## Part A — Privilege-escalation & vulnerability fixes

From the audit (0 CRITICAL / 0 HIGH; these are the actionable MEDIUM/LOW):

### A1. `UNIQUE(organization_id, email)` on `users` (audit #6, #1, #2)

The per-org email uniqueness guarantee is currently application-only
(read-then-insert in `createStaff`), which is a TOCTOU race under concurrency,
and login/OIDC match email **globally** (no org filter), so a duplicate email
across orgs makes auth non-deterministic.

**Fix:** add `uniqueIndex("users_org_email_unique").on(organizationId, email)`
(migration `0029`). `createStaff` maps a unique-violation error to its existing
`email_conflict` sentinel (keeps the friendly pre-check as a fast path).

### A2. Normalize email before auth lookups (audit #3, #1, #2)

`login/route.ts` and `google-login.ts` look up the raw request email. User rows
are stored lowercased (`normalizeEmail`), so a mixed-case login silently fails
and the OIDC path can mis-resolve.

**Fix:** call `normalizeEmail()` before the lookup in both paths; add `.limit(1)`
to the login query defensively. (Login stays single-tenant-correct; with the
unique constraint in place the email→row mapping is now unambiguous within an org.)

### A3. Block `super_admin` self-demotion (audit #4)

A `super_admin` PATCHing their own id with `role: "admin"` passes the current
self-guard (which only blocks demotion to `technician`) and can silently strip
their own tier — irreversible if they're the org's last super_admin (the
last-admin trigger only counts admin-tier, not super_admin specifically).

**Fix:** in `PATCH /api/admin/staff/[id]`, reject ANY self role change (a user
may never change their own role), returning `SELF_MUTATION_FORBIDDEN` (403).

### A4. Consolidate authorization policy into `authz.ts` (audit #5)

`canManageRole` / `canAssignRole` are correct but dead; enforcement is duplicated
inline in `staff-queries.ts`. Two copies of a security rule drift.

**Fix:** make `staff-queries.ts` (and the new invite lib) call
`canManageRole` / `canAssignRole`. Single source of truth. Behavior unchanged;
covered by existing + new tests.

---

## Part B — Team Invites

### Data model — `staff_invites` (migration `0029`, same file as A1)

| column             | type        | notes |
|--------------------|-------------|-------|
| `id`               | uuid pk     | |
| `organization_id`  | uuid fk     | tenant scope |
| `email`            | text        | normalized (lowercased) |
| `role`             | enum        | `admin` \| `technician` — **never `super_admin`** |
| `token_hash`       | text unique | SHA-256 hex of the token; **plaintext never stored** |
| `invited_by_user_id` | uuid fk   | audit/trace |
| `expires_at`       | timestamptz | now + 72h |
| `accepted_at`      | timestamptz | nullable; set on accept → single-use |
| `revoked_at`       | timestamptz | nullable; admin revoke |
| `created_at`       | timestamptz | |

Indexes: `(organization_id)`, `(token_hash)`. Partial unique on
`(organization_id, email)` **where** `accepted_at IS NULL AND revoked_at IS NULL`
so an org can't have two live invites for the same email, but a re-invite after
accept/revoke is allowed.

### Token — mirrors `src/lib/widget/keys.ts` exactly

`src/lib/admin/invites.ts`:
- `generateInviteToken()`: `randomBytes(32).toString("hex")` → plaintext;
  `sha256` → `tokenHash`. Plaintext returned ONCE, embedded in the link, never
  persisted. No prefix needed (not user-recognizable; it's a one-shot bearer).
- `hashInviteToken(token)`: deterministic sha256 for lookup.

### Queries — `src/lib/admin/invites.ts` (all org-scoped, server-only)

- `createInvite(orgId, { email, role }, actorRole, invitedByUserId)` →
  `{ ok: true, invite, token }` | `{ ok:false, reason: "forbidden" | "email_conflict" | "invite_exists" }`.
  - Authz: `canAssignRole(actorRole, role)` — admin can only invite technicians;
    only super_admin can invite admins. `super_admin` role is rejected outright.
  - Refuses if a user with that email already exists in the org (`email_conflict`)
    or a live invite already exists (`invite_exists`).
- `listInvites(orgId)` → pending (not accepted/revoked/expired) invites, no token.
- `revokeInvite(orgId, id)` → sets `revoked_at`; idempotent-ish (404 if absent).
- `resolveInviteByToken(token)` → the live invite row or a denial reason
  (`not_found` | `expired` | `used` | `revoked`). Used by the accept page/route.
  Token looked up by hash; constant-time not required (indexed hash lookup, like
  widget keys).
- `acceptInvite(token, { name, password })` → creates the user via `createStaff`
  with the role **from the invite row** (not client input), marks `accepted_at`,
  returns the new user + session payload. Re-validates liveness atomically-enough
  for neon-http (single-row read then writes; the partial unique index +
  `accepted_at` guard prevent double-accept races from creating two users).

### API routes

Admin (gated by `getAdminSession`, rate-limited, audited; details = enum/ids only):
- `POST /api/admin/invites` — body `{ email, role }`; passes `session.role` as
  actorRole. Returns `{ invite, url }` where `url` is the one-time accept link.
  `forbidden`→403, `email_conflict`/`invite_exists`→409.
- `GET /api/admin/invites` — list pending.
- `POST /api/admin/invites/[id]/revoke` — revoke.

Public (no session):
- `POST /api/auth/invite/accept` — body `{ token, name, password }`. Re-resolves
  the invite, creates the user (role from invite), creates the session, returns
  the new user. Rate-limited per-IP (reuse `sessionCreate`). Generic errors on
  invalid/expired/used token (no enumeration). The token is the only bearer of
  authority; **role is never taken from the request body**.

### UI

- `GET /admin/invite/[token]` — public server component. Resolves the token; on
  failure renders a generic "This invitation is no longer valid." On success
  renders a client form: **email read-only** (from invite), Name, Password
  (min 8). Submits to the accept route, then redirects to `/admin`.
- Staff page (`/admin/(dashboard)/staff`): an **Invite** button beside **Add
  Staff** opens a dialog (email + role, role options gated by `canManageAdmins`).
  On success it shows the copyable link with a Copy button (shown once). A
  **Pending Invites** card lists outstanding invites (email, role, expiry) with a
  Revoke action. Reuses the `useAdminStaff` refetch pattern via a new
  `useAdminInvites` hook.

### Security properties (production checklist)

- Token: 256-bit random, **hashed at rest** (SHA-256), plaintext shown once,
  unrecoverable. Single-use (`accepted_at`), 72h expiry, revocable.
- Role is bound to the invite row, never to request input → no escalation via a
  forged `role` field on accept.
- Invites can never grant `super_admin`.
- Authz on create reuses `canAssignRole` (admin ⇒ technician only).
- Per-org unique email (+ live-invite partial unique) prevents cross-tenant
  collision and double-accept.
- Accept route rate-limited; generic errors prevent invite/account enumeration.
- All admin invite routes rate-limited + audited (no PII in audit details).
- The accept page is the only unauthenticated write surface added; it is fully
  token-gated and creates only the pre-authorized role in the invite's own org.

### Testing (≥80% per repo bar)

- `invites.ts`: token gen/hash determinism; create (authz forbidden, email
  conflict, existing live invite, super_admin rejected); list; revoke; resolve
  (live/expired/used/revoked/unknown/wrong-org); accept (role-from-invite,
  marks used, second accept fails).
- Accept route: role from invite not body; invalid/expired token → generic;
  rate limit.
- Admin routes: actorRole passed; admin can't invite admin (403); audit logged.
- Part A: per-org unique email conflict mapping; login/OIDC email normalization;
  super_admin self-demotion blocked; authz.ts wired (existing staff tests still
  green).

## Migration / deploy note

Migrations are NOT run on Vercel deploy — run `npm run db:migrate` after merge.
`0029` adds the unique index + `staff_invites` table; written idempotently
(`IF NOT EXISTS`) and split with `--> statement-breakpoint` (neon-http: one
statement per prepared query).
