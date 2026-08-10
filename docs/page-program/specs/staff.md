# staff — target-state spec

`/admin/staff` — team roster (admins + technicians), role management,
password resets, tokenized copyable invite links.

## 1. Purpose

Let an org's admins manage who else can access the org's data and at what
privilege level: create/deactivate staff, change roles, reset passwords, and
invite new teammates via a one-time link — without a lower-privileged actor
ever granting themselves or anyone else more access than they already have,
and without the org ever locking itself out of its own admin console.

## 2. Brainstorm

- **Tokenized copyable links, not email-dependent invites** — shipped.
  Rejected: send-email-only invite. Reason: no email infra dependency to
  onboard a first teammate; the link still expires (72h) and is single-use.
  verified (`src/lib/admin/invites.ts:13-31`).
- **Role hierarchy enforced server-side, UI only hides options** — shipped
  (`src/lib/auth/authz.ts`, `staff-queries.ts:283-294`). Rejected: trusting
  the client's `canManageAdmins` prop. Reason: every mutation route
  re-derives authority from `session.role`, never the request body. verified.
- **DB trigger as the authoritative last-admin backstop, app check as the
  fast path** — shipped, but see Gstaff-1: not reproducible from the current
  migration chain. Rejected: app-only check. Reason: neon-http has no
  transactions, so a read-then-write check alone races (`staff-queries.ts:18-28`).
- **Self-service super_admin promotion for an existing super_admin** —
  considered, found silently dead (Gstaff-2): UI offers it, but
  `canAssignRole` categorically refuses to grant `super_admin` through the
  assign path (`authz.ts:100`), by design ("must NEVER be assignable through
  the invite/assign path"). Decision: fix the UI to match policy (P1), not
  loosen the policy — no evidence the policy itself is wrong.
- **Global email-uniqueness check at invite-CREATE time** — should have
  shipped with the global unique index (migration 0016) but didn't; see
  Gstaff-3. A missed update, not a new idea.
- **Seat-limit gate on invite creation** — shipped (`invites.ts:158-175`,
  Stage 10 entitlements). Not re-litigated; out of scope here.
- **Bulk staff import / CSV invite** — rejected. No demand evidence;
  FieldPulse import already provisions synced technicians, and a
  human-reviewed one-at-a-time flow is safer for a surface that can grant
  admin access. YAGNI.
- **Per-permission (granular) ACLs instead of the 3-tier role model** —
  rejected. Three roles already cover every access decision in the
  codebase; a permission matrix is unrequested complexity. YAGNI.
- **Editable invite (change role/email post-creation)** — rejected. Cheap
  to revoke and recreate instead; mutating a live invite would reopen the
  enumeration surface `createInvite` already closes at creation. Not worth it.

## 3. Current state

**Pages / components** (verified — read in full):
- `src/app/admin/(dashboard)/staff/page.tsx` — composes `StaffTable`,
  `PendingInvites`, `StaffFormDialog`, `StaffResetPasswordDialog`,
  `InviteDialog`. Derives `canManageAdmins` client-side from the caller's own
  row in the fetched staff list (`:25-26`) — UI gating only, server
  re-derives from `session.role` on every route.
- `staff-table.tsx` — role/status badges, "(you)" tag for the caller's own
  row, reset-password + edit actions per row.
- `staff-form-dialog.tsx` — create/edit form. Role `<Select>` shows
  `super_admin` when `canManageAdmins && isEditMode` (`:289-292`, comment:
  "DB/edit-only — POST route rejects it") — see Gstaff-2, the comment's
  premise is false for PATCH too.
- `invite-dialog.tsx` — email + role form; on success shows the one-time
  plaintext link with a copy button, never re-fetchable.
- `pending-invites.tsx` — lists live invites, revoke button per row.
- `use-admin-staff.ts` / `use-admin-invites.ts` — fetch-on-mount, manual
  `refetch`, no polling (staff/invites change infrequently).

**Server** (verified):
- `GET/POST /api/admin/staff/route.ts`, `PATCH .../[id]/route.ts`,
  `POST .../[id]/reset-password/route.ts` — every handler calls
  `getAdminSession()` first (401 if absent), rate-limits per
  `session.userId`, and passes `session.role`/`session.organizationId` into
  the query layer — never trusts a client-asserted role.
- `src/lib/admin/staff-queries.ts` — `createStaff`/`updateStaff`/
  `resetStaffPassword` each call `canManageRole`/`canAssignRole`
  (`src/lib/auth/authz.ts`) before touching a row. All reads/writes go
  through `withTenant(users, organizationId, …)` (`:148,173,204,276,368,429`).
- `src/lib/auth/authz.ts` — single policy source. `canManageRole` (:78-85):
  managing an admin-tier target requires `super_admin`. `canAssignRole`
  (:92-103): `super_admin` is **never** grantable through this function,
  regardless of actor (`:100`) — the only path to `super_admin` is the
  provisioned-owner promotion in `acceptInvite`. `isPlatformAdmin` (:45-67)
  is a wholly separate cross-org authority gated by an env allowlist AND the
  designated platform org id — cannot be reached via any in-app role change.
- `src/lib/admin/invites.ts` — `createInvite` checks `canAssignRole` (:106),
  a per-org live-invite duplicate (:140-156), and the seat-limit entitlement
  (:158-175) before inserting. `acceptInvite` creates the user in the
  invite's own org FIRST, then claims the invite (:368-421, ordering is the
  race arbiter). Owner-promotion to `super_admin` is one org-scoped UPDATE
  keyed on `organizations.ownerEmail`, consumed (set NULL) on use (:423-467).
- `src/app/api/auth/invite/accept/route.ts` — public, pre-auth. Rate-limited
  per IP (:33-38). Every failure reason (not_found/expired/used/revoked/
  email_conflict) collapses to one generic 400 (:68-76) — no enumeration.
  Token shape regex-constrained (`^[0-9a-f]{64}$`) before any DB lookup (:26).
- `src/lib/auth/config.ts` — `verifyToken` (:29-59) validates JWT claims at
  runtime; `role` must be `super_admin` or `admin` or the token is rejected
  (:45) — a `technician` can never hold an admin session, so it cannot
  reach any `/admin/staff` route regardless of UI.
- `src/lib/auth/session.ts` / `session-revocation.ts` — every
  `getAdminSession()` call re-checks the user is still active and still
  holds the token's claimed role (`session.ts:41-51`). A passing check is
  cached 30s per warm lambda instance; a failing check is never cached
  (`session-revocation.ts:26-34,48`) — deactivating/demoting a user revokes
  their live session within ≤30s per instance, not at token expiry (24h).
- `staff_invites` schema (`schema.ts:360-400`) — `tokenHash` is SHA-256
  (`:373-375`), `role` enum is `admin`/`technician` only (`:372`, DB cannot
  store `super_admin`), `staff_invites_live_unique` partial unique index on
  `(organizationId, email) WHERE acceptedAt IS NULL AND revokedAt IS NULL`
  (`:396-398`) enforces one live invite per org+email.

**Last-admin guard — verified against the live dev DB, not just source**:
`page-staff/SKILL.md` and `staff-queries.ts:23` both cite "migration 0008"
as the `BEFORE UPDATE` trigger's origin. `drizzle/0008_equipment_warranty.sql`
(current repo) is unrelated (`ALTER TYPE ... ADD VALUE 'warranty_expiring'`).
Git archaeology: the trigger was originally `drizzle/0008_last_admin_guard.sql`
(commit `392cbc4`), extended to admin-tier by
`drizzle/0027_last_admin_guard_super_admin.sql` (commit `a117843`), then
**both files were deleted** by commit `0cea181` ("squash migrations to a
single baseline") which replaced the whole chain with
`drizzle/0000_baseline.sql`, generated from `schema.ts` — drizzle-kit's
table-diff generator cannot emit a hand-authored `CREATE FUNCTION`/
`CREATE TRIGGER`, so the trigger DDL was silently dropped from every current
`.sql` file (`grep -rn "CREATE TRIGGER" drizzle/*.sql` → zero hits,
checked). A direct read-only query against the dev DB (`pg_trigger`/
`pg_proc`) confirms `trg_enforce_last_active_admin` /
`enforce_last_active_admin` **do exist** on dev right now — the squash
commit set the baseline's journal `when` below the already-migrated ledger
max so `neon-http`'s migrator SKIPS re-running it on prod/dev. The guard is
live today only because dev/prod predate the squash. See Gstaff-1.

## 4. Gaps

| Gap | Severity | Evidence |
|---|---|---|
| Gstaff-1: The last-admin DB trigger is unreproducible — absent from every current migration file, so any freshly-migrated database (new Neon branch created from scratch, disaster recovery, a future CI/test DB) would have ONLY the race-prone app-level check, not the documented "authoritative" backstop | P0 | `drizzle/0008_last_admin_guard.sql` and `drizzle/0027_last_admin_guard_super_admin.sql` were deleted by commit `0cea181`; `drizzle/0000_baseline.sql` (drizzle-kit-generated from `schema.ts`) contains no `CREATE TRIGGER`/`CREATE FUNCTION` (verified via grep, zero hits across `drizzle/*.sql`). `staff-queries.ts:18-28` explicitly says the app check "is NOT race-proof on its own" and depends on this trigger as backstop. Confirmed present on the *current* dev DB only via a live `pg_trigger`/`pg_proc` query — i.e. it survives by historical accident, not by anything in the tracked migration chain. |
| Gstaff-2: "Super Admin" is offered as a role choice in the edit dialog for any super_admin actor, but selecting and saving it always fails — `canAssignRole` unconditionally refuses to grant `super_admin` regardless of actor role. Net effect: no in-app way exists for an org to mint a second `super_admin` (only the original provisioned-owner invite can) | P1 | `staff-form-dialog.tsx:289-291` renders `<SelectItem value="super_admin">` guarded only by `canManageAdmins && isEditMode`, with the comment "DB/edit-only — POST route rejects it" (implying PATCH succeeds). `authz.ts:100`: `if (desiredRole === "super_admin") return false` — unconditional, runs before the actor-role check, so even a `super_admin` actor gets `{ok:false, reason:"forbidden"}` from `updateStaff` (`staff-queries.ts:290-294`), surfaced as "Only a super admin can manage admin accounts" (`api/admin/staff/[id]/route.ts:104-109`) — a confusing message when the actor already IS a super_admin. No route-level test exists for this path (`find src/app/api/admin/staff -name "*.test.ts"` → none). |
| Gstaff-3: `createInvite` only checks email collision within the CALLER's org (`invites.ts:118-127`, `withTenant(...)`), not the global `users_email_global_unique` index (`schema.ts:334`) that actually governs account creation. An admin can create an invite for an email that already belongs to a user in a DIFFERENT org; the invite is accepted-shown as live/pending, but `acceptInvite` → `createStaff` will always fail the global unique index at accept time, and the public accept route collapses that to a generic "This invitation is no longer valid" (`api/auth/invite/accept/route.ts:71-75`) — the inviting admin gets no signal the invite was doomed from creation, and it just sits in Pending invites until it expires | P1 | Traced: `createInvite`'s pre-check (`invites.ts:118-127`) is org-scoped only; `users_email_global_unique` (`schema.ts:334`) is enforced only later, inside `createStaff`'s insert (`staff-queries.ts:213-235`), called from `acceptInvite` (`invites.ts:383-388`). No test in `invites.test.ts` covers a cross-org email at invite-creation time (grep for "global"/"cross-org"/"other org" → zero hits). |
| Gstaff-4: Copy-canon drift on this page specifically: `staff-form-dialog.tsx:226,230` uses Title Case ("Add Staff Member", "Edit Staff Member") where every sibling admin form dialog uses sentence case ("Add customer", "Add equipment" — `customer-form-dialog.tsx:81`, `equipment-form-dialog.tsx:173`); `invite-dialog.tsx:194`, `pending-invites.tsx:78`, `staff-reset-password-dialog.tsx:148` use literal `"..."` where sibling dialogs use Unicode `…` (`customer-form-dialog.tsx:151`, `equipment-form-dialog.tsx:306`); the reset-password submit button says "Reset Password" (Title Case) while the table row action for the same feature says "Reset password" (`staff-table.tsx:141`, sentence case) — an inconsistency within the same page | P2 | Direct diff against sibling components, cited above. |
| Gstaff-5: `createInvite`'s `db.insert(staffInvites)` (`invites.ts:180-196`) has no try/catch around the `staff_invites_live_unique` race, unlike `createStaff`'s analogous `isUniqueEmailViolation` handling (`staff-queries.ts:213-235`) for the equivalent users-table race — two concurrent invite-creation clicks for the same org+email could surface a raw 500 instead of the clean 409 `invite_exists` the pre-check normally returns | P2 | Code comparison: `createStaff` wraps its insert in try/catch mapping the unique-violation to a sentinel; `createInvite`'s insert (`invites.ts:180-196`) does not. |

That's the full list. Tenancy scoping, invite-token hashing/expiry/
single-use, technician session exclusion, and the JWT revocation-freshness
check are all solid and evidenced above; this spec does not invent
additional work to pad them out.

## 5. Requirements

Only P0/P1 gaps clear the bar.

- **Rstaff-1** (Gstaff-1): A fresh, empty database migrated with
  `npm run db:migrate` must end up with `trg_enforce_last_active_admin` on
  `users`, without depending on being forked/branched from an
  already-migrated database.
  **Acceptance criterion**: a new hand-authored migration (recipe:
  `CREATE OR REPLACE FUNCTION enforce_last_active_admin()` + `DROP TRIGGER
  IF EXISTS` + `CREATE TRIGGER`, idempotent) reproduces the exact trigger
  body from `0cea181^:drizzle/0027_last_admin_guard_super_admin.sql`
  (already admin-tier-aware). Verify: (a) applying it to dev is a no-op
  (trigger/function already present, identical body), `npm run db:migrate`
  exits clean; (b) a from-empty scratch DB, migrated head-to-toe, then a
  direct `SELECT` against `pg_trigger`/`pg_proc` shows the trigger now
  exists; (c) `staff-queries.test.ts`'s trigger-mapping tests (`:298-309`)
  stay green.
- **Rstaff-2** (Gstaff-2): The edit dialog must never offer a role option
  the server unconditionally rejects regardless of actor.
  **Acceptance criterion**: remove the `super_admin` `<SelectItem>` from
  `staff-form-dialog.tsx`'s role select entirely — it can never succeed for
  any actor, so this isn't a tier gate to widen, it's a dead control to
  delete. The "You cannot change your own role" hint stays. A `vitest`
  pure-function test (no jsdom) on the role-options-derivation function
  confirms `super_admin` is never in the returned list, for any
  `canManageAdmins`/`isEditMode` combination.
- **Rstaff-3** (Gstaff-3): `createInvite` must reject at creation time an
  email already belonging to a user in a different org, instead of creating
  an invite that can never be accepted.
  **Acceptance criterion**: `createInvite` (`invites.ts`) checks email
  existence GLOBALLY (no org filter) before inserting the invite row; on a
  different-org match, return a distinct result reason and a route message
  that doesn't claim the email is already in *this* organization. A
  `vitest` unit test in `invites.test.ts` covers: same-org existing user →
  conflict (unchanged); different-org existing user → conflict at CREATE
  time (new); no existing user anywhere → invite created (unchanged).

## 6. Non-goals

- Not changing the role hierarchy, `authz.ts` policy functions, or the
  provisioned-owner promotion mechanism — see Invariants. Rstaff-2 fixes
  the UI to match documented policy; it doesn't touch the policy. Loosening
  `canAssignRole` to allow super_admin-to-super_admin promotion is a
  product decision this spec doesn't make on its own authority — flagged as
  a business-continuity note (only the owner-invite path mints a
  `super_admin` today), not implemented.
- Not building granular/per-permission ACLs (Brainstorm, YAGNI).
- Not building bulk/CSV staff import (Brainstorm, YAGNI — FieldPulse import
  already covers synced-technician provisioning).
- Not adding email-based (vs. link-based) invite delivery — no demand
  evidence, and it adds an infra dependency this flow currently has none of.
- Gstaff-4/5 (P2) are recorded in Gaps and left in the backlog per
  METHOD.md's severity gate; not implementation work in this run.

## 7. Invariants

- **Privilege-escalation policy is single-sourced in `authz.ts`** —
  `canManageRole`/`canAssignRole` are the only functions allowed to decide
  who may act on whom; never re-implement the check inline.
- **`super_admin` is never assignable via create/update/invite, only via
  provisioned-owner acceptance** (`authz.ts:96-100`, `invites.ts:423-467`) —
  deliberate ("must NEVER be assignable through the invite/assign path").
  Rstaff-2 only removes the dead UI affordance; it doesn't touch the policy.
- **Technician never holds an admin session** — `verifyToken`
  (`config.ts:45`) hard-rejects any role other than `super_admin`/`admin`.
  Do not weaken this for any future technician-facing feature here.
- **Last-admin lockout must be impossible** — both the app-level check
  (`staff-queries.ts:296-310`) and the DB trigger are required; neither
  alone is race-proof (Gstaff-1/Rstaff-1). Keep the app-level check even
  after Rstaff-1 ships — it's the friendly fast path.
- **Invite tokens**: hashed (SHA-256) at rest, never stored/logged in
  plaintext after creation; 72h expiry; single-use; revocable; per-org
  unique live invite; role fixed from the invite row, never request input.
  None of Rstaff-1..3 touch token hashing/generation or the accept route's
  generic-error collapsing.
- **Tenancy**: every staff/invite read or write is scoped by
  `withTenant(…, organizationId, …)`. Rstaff-3's global-email check is the
  one deliberate exception (the point is to look outside the org) and must
  stay read-only — never return another org's user data, only a
  boolean/conflict signal.
- **Audit trail never carries PII/secrets** — `details` on staff/invite
  audit actions is role/field-name enums only, per `admin-pages` skill; new
  requirements must keep this shape.
- **Session revocation**: deactivation/demotion keeps taking effect within
  the existing ≤30s cache window (`session-revocation.ts:33`); nothing here
  changes that cache or its fail-open behavior.

## 8. Verification

- `npx tsc --noEmit` → 0.
- `npx eslint src/components/admin/staff-form-dialog.tsx src/lib/admin/invites.ts src/lib/admin/staff-queries.ts` → 0 errors.
- `npx vitest run` → must not drop below the live baseline (`docs/page-program/README.md`).
- `npx vitest run src/lib/admin/invites.test.ts src/lib/admin/staff-queries.test.ts` → green; add the new Rstaff-2 (role-options derivation) and Rstaff-3 (cross-org email at create time) cases here.
- Rstaff-1: `npm run db:migrate` against dev exits clean; manual `SELECT`
  against `pg_trigger`/`pg_proc` confirms `trg_enforce_last_active_admin`
  present; also exercise once against a from-empty scratch DB to prove the
  fresh-DB case the gap is about.
- Manual/visual: mint an admin session, `npm run dev` (background),
  `node scripts/agent/screenshot-page.mjs /admin/staff` — confirm the edit
  dialog's role select no longer offers "Super Admin" (Rstaff-2); create an
  invite for an email seeded in a second org and confirm it's rejected at
  creation (Rstaff-3), not shown in Pending invites.
