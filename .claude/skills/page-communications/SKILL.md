---
name: page-communications
description: Use when working on the /admin/communications/templates page — message template manager for SMS and email automated communications.
---

# Communication templates (/admin/communications/templates)

**Purpose:** operators create, edit, activate/deactivate, and delete the SMS and
email templates that power automated customer communications (confirmations,
reminders, review requests, etc.).

**Files:** page `src/app/admin/(dashboard)/communications/templates/page.tsx` ·
editor dialog
`src/components/admin/communications/template-editor-dialog.tsx` (exports
`TRIGGER_TYPES`, `TEMPLATE_TYPES`, and the `Template` type) · APIs
`src/app/api/admin/communications/templates/route.ts` (GET list + POST create),
`src/app/api/admin/communications/templates/[id]/route.ts` (PATCH update +
DELETE) · table `communication_templates`.

**Data flow:** page fetches `/api/admin/communications/templates` on mount and
after any mutation (create, toggle active, delete). No pagination — all templates
for the org are returned in a single request, ordered by `triggerType` then
`priority`. State lives in local React state; `fetchTemplates` is the shared
re-fetch callback.

**Invariants:**
- Trigger types (from `TRIGGER_TYPES` in the editor dialog): `appointment_scheduled`,
  `appointment_reminder_24h`, `appointment_reminder_2h`, `appointment_rescheduled`,
  `appointment_cancelled`, `technician_enroute`, `job_completed`,
  `review_request`, `follow_up`, `escalation`. The schema enforces this enum.
- Template types: `sms`, `email_html`, `email_text`. The `isEmail` flag on the
  card checks `templateType.startsWith("email")`.
- The `communication_templates` table has a `uniqueIndex` on
  `(organizationId, key)` — each org can have at most one template per key.
- Tenancy: all API routes scope by `session.organizationId`.
- Deleting a template warns that automations fall back to defaults — no cascaded
  outbound action on delete.
- `priority` is a numeric field (lower = higher priority); shown as "Priority N"
  on the card.

**Gotchas:**
- Inactive templates (isActive=false) render at 60% opacity — this is
  intentional visual distinction.
- The editor dialog is re-mounted (via `key` prop) on each open so the form
  re-seeds without a `useEffect` reset — preserve the `key` approach when
  modifying the dialog.
- There is no "send now" button on this page; templates are triggered
  programmatically by the communications pipeline. The outcomes of triggered
  sends appear at `/api/admin/communications/outcomes`.

**Verify changes:** `npx vitest run` (no dedicated test file for this page).
Visual via admin-pages recipe (`/admin/communications/templates`).
