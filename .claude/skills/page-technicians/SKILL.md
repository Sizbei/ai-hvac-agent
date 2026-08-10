---
name: page-technicians
description: Use when working on the /admin/technicians route — permanent redirect to /admin/staff where technician management actually lives.
---

# Technicians (/admin/technicians)

**Purpose:** this route is a permanent redirect only — the standalone technicians
screen was superseded by the unified Staff page (/admin/staff), which manages
both admins and technicians with the full set of controls. Old bookmarks and
integrations that link to `/admin/technicians` are silently redirected.

**Files:** redirect page `src/app/admin/(dashboard)/technicians/page.tsx` ·
actual page `src/app/admin/(dashboard)/staff/page.tsx` · hooks
`src/hooks/use-admin-staff.ts` · `src/hooks/use-admin-invites.ts` ·
APIs `src/app/api/admin/staff/route.ts` ·
`src/app/api/admin/staff/[id]/route.ts` ·
`src/app/api/admin/staff/[id]/reset-password/route.ts` ·
`src/app/api/admin/invites/route.ts` ·
queries `src/lib/admin/staff-queries.ts` (`listStaff`, `createStaff`) ·
`src/lib/admin/invites.ts` · last-admin guard trigger
`drizzle/0044_last_admin_guard.sql` ·
components `src/components/admin/staff-table.tsx` ·
`src/components/admin/staff-form-dialog.tsx` ·
`src/components/admin/staff-reset-password-dialog.tsx` ·
`src/components/admin/invite-dialog.tsx` ·
`src/components/admin/pending-invites.tsx` ·
tables `users`, `staffInvites`

**Data flow:** `useAdminStaff` fetches `/api/admin/staff` (no polling — staff
changes are rare). The route returns both `staff` and `currentUserId` in one
response so the UI can disable self-demote/self-deactivate without a second
call. Invites are fetched separately by `useAdminInvites`.

**Invariants:**
- Last-admin guard: a plpgsql BEFORE UPDATE trigger on `users`
  (`drizzle/0044_last_admin_guard.sql`, idempotent via `CREATE OR REPLACE
  FUNCTION` + `DROP TRIGGER IF EXISTS` so it's safe to re-run on Vercel's
  auto-migrate) raises `last_active_admin` when a write would demote or
  deactivate the last active admin-TIER user (`role IN ('admin',
  'super_admin')`) in the org. The route catches this sentinel and surfaces a
  user-friendly message — never re-raise the raw DB error.
- Role assignment: only a `super_admin` can create or assign `admin`-tier roles.
  The server enforces this in `createStaff` regardless of the `canManageAdmins`
  flag the UI reads from the staff list.
- Invites: tokenized single-use links (hashed token, 72 h TTL,
  per-org UNIQUE(org, email)). The `InviteDialog` passes `canInviteAdmins`
  derived from `canManageAdmins` — same super_admin gate.
- Technician API routes at `/api/admin/technicians/[id]` (location/profile
  updates) are a separate surface from staff CRUD — they target the `users`
  table by role but expose technician-specific fields (labor rate, FieldPulse
  user id, location). Do not merge them.

**Gotchas:**
- Any work on technician behavior (dispatch scoring, availability, location
  tracking) touches `technicianAvailability`, `technicianLocations`, and
  `src/lib/ai/dispatch/` — not this page. The technicians page is purely a
  redirect tombstone.
- `canManageAdmins` is derived CLIENT-SIDE from the staff list for UX gating
  only; the server re-checks the caller's role on every mutation.

**Verify changes:** `npx vitest run src/lib/admin/staff-queries.test.ts`
· `src/lib/admin/invites.test.ts`. Visual: admin-pages recipe at /admin/staff;
confirm /admin/technicians redirects there.
