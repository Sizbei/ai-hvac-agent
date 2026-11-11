---
name: page-platform
description: Use when working on the /admin/platform page — platform-admin-only tenant console for provisioning new organizations and viewing existing ones.
---

# Platform (/admin/platform)

**Purpose:** multi-tenant operator console — list all organizations, provision new
tenant orgs (which issues a one-time owner invite link), and purge orgs. Visible
only to platform admins.

**Files:** page `src/app/admin/(dashboard)/platform/page.tsx` (server component,
access-gated) · console component
`src/components/admin/platform/platform-console.tsx` · auth helpers
`src/lib/auth/authz.ts` (`isPlatformAdmin`) · APIs
`src/app/api/platform/organizations/route.ts` (list + create) ·
`src/app/api/platform/organizations/[id]/route.ts` (purge) · tables
`organizations`, `platform_audit_log`

**Send owner invite:** rows whose org has an owner email on file
(`hasOwnerEmail` from the list API; the address never reaches the client) show
"Send owner invite" → `POST /api/platform/organizations/[id]/owner-invite`
(`src/app/api/platform/organizations/[id]/owner-invite/route.ts`): platform
gate → same-origin → rate limit → `createInvite(id, { email: owner_email,
role: "admin" }, session)` → `deliverInvite`. Returns `{ emailed, url? }` —
the platform admin always gets `url` (when `NEXT_PUBLIC_APP_URL` is set);
404 `NO_OWNER_EMAIL`, 409 while an invite is still live. After expiry,
`createInvite` revokes the stale invite, so re-sending works. Only a platform
admin's invite promotes the owner to super_admin.

**Data flow:** `PlatformConsole` fetches the org list on mount and after any
mutation (create / purge). All API calls are client-side from the console component.
Create returns a one-time invite URL to display in a copy dialog — this URL is
shown once and is not stored in plaintext.

**Invariants:**
- `isPlatformAdmin` checks the session's email against the `PLATFORM_ADMIN_EMAILS`
  env var (comma-separated, normalized). The page calls `notFound()` unless
  `seesPlatformUi(viewer)` — a platform admin who is NOT previewing (spec P7:
  "View as" applies the target's gates). The API gate stays on the real session.
- Org status values: `active`, `suspended`, `trial`, `past_due`. Displayed via
  `OrgStatusBadge`; unknown status renders the raw value with neutral styling —
  never crash on an unexpected enum.
- Destructive actions (purge) are logged to `platform_audit_log` — a cross-org
  table separate from the per-org `audit_log` because the purge destroys the org
  record including its own audit rows.
- `DELETE /api/platform/organizations/[id]` refuses to purge the org matching
  `PLATFORM_ORG_ID` — `users.organizationId` cascades on org delete, so purging
  it would delete every platform admin user row and permanently lock out
  `isPlatformAdmin` (which requires `session.organizationId === platformOrgId`).
  Never remove this check even if it looks redundant with `isPlatformAdmin`'s
  own fail-closed behavior when the env var is unset.
- Platform admin access is controlled exclusively by env var — no database role.
  There is no UI to grant/revoke it.

**Gotchas:**
- The page is a server component (no `'use client'`), which lets it call
  `getAdminSession` synchronously before rendering. The console itself is a client
  component imported inside the page.
- On dev: `PLATFORM_ADMIN_EMAILS` must include the test user's email (and
  `PLATFORM_ORG_ID` its org) or the page 404s.

**Verify changes:** visual via the admin-pages recipe at `/admin/platform`
(requires `PLATFORM_ADMIN_EMAILS` set to the session user's email in `.env.local`)
· confirm org list loads and the create dialog surfaces the invite URL.
