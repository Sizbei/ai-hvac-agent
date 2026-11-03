---
name: page-staff
description: Use when working on the /admin/staff page — team roster (admins + technicians), role management, password resets, and tokenized copyable invite links.
---

# Staff (/admin/staff)

**Purpose:** manage the organization's team — view and edit staff members, reset
passwords, and generate tokenized invite links for new admins or technicians.

**Files:** page `src/app/admin/(dashboard)/staff/page.tsx` · components
`src/components/admin/staff-table.tsx` · `src/components/admin/staff-form-dialog.tsx`
· `src/components/admin/staff-reset-password-dialog.tsx` ·
`src/components/admin/invite-dialog.tsx` ·
`src/components/admin/pending-invites.tsx` · hooks
`src/hooks/use-admin-staff.ts` · `src/hooks/use-admin-invites.ts` · APIs
`src/app/api/admin/staff/route.ts` · `src/app/api/admin/invites/route.ts` ·
last-admin guard trigger `drizzle/0044_last_admin_guard.sql` ·
table `users`, `staff_invites`

**Time off (M0a):** each technician row has a "Time off" action opening
`src/components/admin/staff/time-off-dialog.tsx` (multi-day ranges expanded to
one shift per day by `src/lib/admin/time-off-expand.ts`). It writes
`technician_shifts` (kinds `on_call` / `time_off` / `non_job`; no repeat rule)
via `GET/POST /api/admin/technicians/[id]/shifts` and `DELETE …/shifts/[sid]`
(queries `src/lib/admin/shift-queries.ts`, types `shift-types.ts`). Only
`time_off` removes capacity; see page-calendar for where it is subtracted.

**Timesheets (M3a):** each technician row has a "Timesheets" action opening
`src/components/admin/timesheets-dialog.tsx` — a read-only list of a
technician's time entries (general clock and per-job, auto vs manual) for a
date range. API `GET /api/admin/timesheets?technicianId=&from=&to=`
(`src/app/api/admin/timesheets/route.ts`; UUID + real ISO dates, max 92 days,
tenant-scoped; queries `src/lib/admin/timesheet-admin-queries.ts`). Entries are
written by the tech app (`/api/tech/time`, status taps), never here.

**Data flow:** `useAdminStaff` fetches `/api/admin/staff`; `useAdminInvites` fetches
`/api/admin/invites` (pending only). Both are plain fetch-on-mount with manual
`refetch`. No SWR cache — staff lists are small and infrequently changed.

**Invariants (from `staff_invites` schema):**
- Token stored SHA-256 hashed at rest (`tokenHash`); plaintext shown once at
  creation, never recoverable afterward.
- Invites are single-use (`acceptedAt` non-null = consumed), expire after 72 hours
  (`expiresAt`), and are revocable (`revokedAt`).
- Role constraint: invites can only grant `admin` or `technician` — `super_admin`
  is never invitable. The accept flow takes role from the invite row, not request
  input.
- Per-org unique live invite: `uniqueIndex("staff_invites_live_unique")` on
  `(organizationId, email)` WHERE `acceptedAt IS NULL AND revokedAt IS NULL` —
  one pending invite per email per org at a time. An expired-but-not-revoked invite
  still blocks a duplicate until revoked.
- `canManageAdmins` is derived client-side from the current user's role in the
  staff list; the server is the authoritative guard regardless.
- Last-admin guard: a database trigger (`drizzle/0044_last_admin_guard.sql`,
  idempotent — `CREATE OR REPLACE FUNCTION` + `DROP TRIGGER IF EXISTS`) prevents
  demoting or deactivating the last active `admin`/`super_admin` — do not
  attempt to enforce this in application code alone (the app-level check in
  `staff-queries.ts` is a fast-path only; the trigger is authoritative).

**Gotchas:**
- `canInviteAdmins` prop on `InviteDialog` controls whether `admin` role is
  offered; only `super_admin` users see it. Technicians invited via this page
  get role `technician`.
- `isSelf` prop on `StaffFormDialog` restricts self-edits (can't change own role).

**Verify changes:** `npx vitest run src/lib/admin/invites.test.ts` ·
visual via the admin-pages recipe at `/admin/staff`.
