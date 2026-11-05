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
`TRIGGER_TYPES`, `TEMPLATE_TYPES`, and the `Template` type — `TRIGGER_TYPES`
is now a re-export of `COMMUNICATION_TRIGGER_TYPES`, not a hand-maintained
list) · trigger-type source of truth
`src/lib/communication/sms-templates.ts` (`COMMUNICATION_TRIGGER_TYPES`,
`COMMUNICATION_TRIGGER_TYPE_VALUES`) · APIs
`src/app/api/admin/communications/templates/route.ts` (GET list + POST create),
`src/app/api/admin/communications/templates/[id]/route.ts` (PATCH update +
DELETE) · table `communication_templates`, `communication_jobs`.

**Data flow:** page fetches `/api/admin/communications/templates` on mount and
after any mutation (create, toggle active, delete). The route answers the
standard envelope `{ success, data: { templates } }`; parse it ONLY via
`parseTemplatesResponse` in `src/lib/admin/template-response.ts` (tested) —
the page once read `json.templates` and every org showed "No templates yet".
Delete errors go through `templateDeleteErrorMessage` (copy by code). The
editor lists the trigger's variables and warns about names the trigger won't
fill, via `src/lib/admin/template-variables.ts` (reads
`templateVariableSchemas`; keep that map in step with what each trigger
actually passes). No pagination — all templates
for the org are returned in a single request, ordered by `triggerType` then
`priority`. State lives in local React state; `fetchTemplates` is the shared
re-fetch callback.

**Invariants:**
- Trigger types are the full 15-value `communicationTriggerTypeEnum`
  (schema.ts), enumerated in `COMMUNICATION_TRIGGER_TYPES`
  (`src/lib/communication/sms-templates.ts`). Before this list existed, the
  editor dropdown hand-maintained its own 10-value copy and the CRUD zod
  schemas a separate 11-value copy — `technician_arrived` and 4 money/lead-gen
  triggers (`estimate_sent`, `payment_receipt`, `invoice_overdue`,
  `warranty_expiring`, added by a seed that bypassed CRUD validation) were
  unmanageable from this page. `COMMUNICATION_TRIGGER_TYPES` is now the ONLY
  source of truth — both CRUD routes' zod schemas
  (`COMMUNICATION_TRIGGER_TYPE_VALUES`) and the editor dropdown
  (`TRIGGER_TYPES`) import it. Never hand-maintain a second copy; a value
  present in the DB enum but missing here makes those rows unmanageable again.
- Template types: `sms`, `email_html`, `email_text`. The `isEmail` flag on the
  card checks `templateType.startsWith("email")`.
- The `communication_templates` table has a `uniqueIndex` on
  `(organizationId, key)` — each org can have at most one template per key.
- Tenancy: all API routes scope by `session.organizationId`.
- `DELETE` refuses (409 `HAS_SEND_HISTORY`) when any `communication_jobs` row
  references the template — `templateId` CASCADEs on delete, and the confirm
  dialog's "falls back to defaults" promise doesn't exist. Deactivate
  (`isActive: false`) instead to stop future sends without losing history.
  Deletion is only reachable for templates with zero send history.
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

**Verify changes:** `npx vitest run
src/app/api/admin/communications/templates/route.test.ts
src/app/api/admin/communications/templates/[id]/route.test.ts`.
Visual via admin-pages recipe (`/admin/communications/templates`).
