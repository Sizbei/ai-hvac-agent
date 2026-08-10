# Spec: communications (`/admin/communications/templates`)

## 1. Purpose

Let an operator (admin/super_admin) fully control the copy and lifecycle of
every SMS/email message the system sends to customers automatically — create,
edit, activate/deactivate, delete — for every trigger event the product
fires. One job: the single place to author what an automated customer
message says. `verified` — page.tsx:118-206, template-editor-dialog.tsx.

## 2. Brainstorm

Ideas considered for a "great" version of this page, kept or rejected:

- **Surface send-health inline** (sent/failed/suppressed). KEEP → R5 — API
  already exists (`observability.ts`), unused, near-zero cost.
- **Cover every live trigger type in the CRUD + dropdown.** KEEP → R1, R4 —
  four DB enum values are currently unreachable from this page.
- **Validate a saved template's variables get supplied at send time**, not
  just Handlebars syntax. KEEP partially → R5 gives visibility; a full static
  cross-check against `templateVariableSchemas` (`sms-templates.ts:73-193`,
  data exists, not wired to the editor) is deferred P2 — no cheap acceptance
  test can prove "will never throw," so scope this round to observability.
- **Route every automated send through templates+queue.** KEEP → R7
  (booking-recovery bypasses it today).
- **Outbound-ledger dedupe on every trigger, not just cron ones.** KEEP → R6.
- **Drag-and-drop / WYSIWYG email builder.** REJECTED — YAGNI. SMS is the
  dominant channel; the React Email engine (`email-templates.tsx`) was built
  and never wired in — building on unused code compounds debt.
- **A/B testing of template copy.** REJECTED — one location's volume can't
  reach significance; no evidence of demand.
- **i18n / multi-language templates.** REJECTED — no evidence of non-English
  service areas in the codebase.
- **Template version history / diff view.** REJECTED this pass — the P0
  finding is deletion destroys send *history* via CASCADE (below); fix that
  before a versioning UI on top of it.
- **Bulk CSV import/export.** REJECTED — YAGNI, template count is bounded
  (≤15/org).
- **Admin-configurable quiet-hours window** (hardcoded 21:00–08:00
  `America/New_York`, `consent.ts:26-28`). REJECTED here — a customer/org
  consent-settings concern, not template authoring.
- **"Send test message to my number" button.** Real gap, P2 polish, deferred.

## 3. Current state

**Files** (page skill, `verified`): page
`src/app/admin/(dashboard)/communications/templates/page.tsx` · editor
`src/components/admin/communications/template-editor-dialog.tsx` · CRUD API
`src/app/api/admin/communications/templates/route.ts` + `[id]/route.ts` ·
table `communication_templates` (`src/lib/db/schema.ts:1781-1823`).

**Pipeline** (`verified`, read in full): a trigger function (`triggers.ts`
for lifecycle events, `money-triggers.ts` for estimate/payment/dunning,
`warranty-queries.ts`, `review-queries.ts`) looks up the org's active
template for `(triggerType, templateType)` and calls `queueCommunicationJob`
(`job-queue.ts:26-59`), inserting a `communication_jobs` row with recipient
PII AES-256-GCM encrypted (`job-queue.ts:49-50`). A per-minute Vercel cron
(`api/cron/process-communications/route.ts`) calls `processPendingJobs`:
checks `checkSendAllowed` (TCPA/CAN-SPAM gate, `consent.ts:120-171`),
cancelling with `suppressed:<reason>` if blocked (`job-queue.ts:120-136`);
atomically claims `pending→processing` so overlapping drains can't
double-send (`job-queue.ts:142-159`); renders via Handlebars
(`sms-templates.ts:209-227`, `strict: true`); sends via `twilio-adapter.ts`
(SMS) or `resend-adapter.ts` (email); retries up to `maxAttempts` (default 3)
with backoff (`job-queue.ts:174-201`).

**Lens (a) — outbound ledger.** `outbound-ledger.ts` provides
`claimOutboundOnce`, an atomic `(org, customer, trigger, periodKey)` claim via
a unique index (`schema.ts:1951-1977`), documented as the dedupe primitive for
"retry-prone Vercel crons." `verified` callers: `money-triggers.ts:450`
(dunning), `warranty-queries.ts:217`, `review-queries.ts:97`,
`booking-recovery.ts:79,184`. `verified`: **`triggers.ts`** — the
event-driven path fired by user actions (scheduled/reminded/rescheduled/
cancelled/enroute/completed/follow-up) — calls `queueCommunicationJob`
directly, zero `claimOutboundOnce` calls in the file (grepped). Cron-driven
sends are deduped; event-driven sends are not.

**Lens (b) — demo-account SMS block.** `isDemoAccount` (`authz.ts:22-26`) is
checked at exactly two call sites: `invoices/[id]/send-reminder/route.ts:31`
and `conversations/[id]/message/route.ts:37` (403 `DEMO_RESTRICTED`). `verified`:
**not** checked in `api/communications/send/route.ts` (the generic
manual-trigger endpoint), nor in `job-queue.ts`, `triggers.ts`, or
`money-triggers.ts`. Any authenticated session (incl. demo) can
`POST /api/communications/send` with an arbitrary `recipientPhone` against an
active template/trigger, and the cron delivers it via Twilio/Resend for real.

**Lens (c) — variable substitution on a missing variable.**
`renderSmsTemplate` compiles with `Handlebars.compile(template, { strict:
true })` (`sms-templates.ts:216`). Strict mode **throws** — it does not
silently render `Hi {{name}}` — when a template references a key absent from
the variables object. `validateSmsTemplate` (`sms-templates.ts:235-242`), the
only check run at save time (`templates/route.ts:105-115`,
`[id]/route.ts:92-102`), only compiles (syntax check); it never renders
against the real variable set a trigger would supply, so a
nonexistent/misspelled variable **passes validation** and then **throws on
every send** (`job-queue.ts:243`), landing the job in `failed`
(`job-queue.ts:180-201`), retried 3× with backoff, then dead — the customer
receives nothing, silently. `communication_templates.variables` (the column
that could document expected inputs) is never populated by the editor UI
(`buildInitialForm`, `template-editor-dialog.tsx:70-82`, no `variables`
field).

**Lens (d) — consent/opt-out.** `checkSendAllowed` (`consent.ts:120-171`) is
the single send-time chokepoint: global `doNotContact`, per-channel toggle,
per-trigger-type toggle (`TRIGGER_RULES`, `consent.ts:46-68`), quiet-hours
(21:00–08:00 customer-local, transactional exempted). Inbound STOP/START/HELP
(`classifySmsKeyword`, `consent.ts:185-191`) flips `doNotContact`
(`setDoNotContactByPhone`, `consent.ts:198-229`) before the agent sees the
message. Solid, out of scope — see Non-goals.

**Other verified findings:**
- Deleting a template (`[id]/route.ts:196-198`) hard-deletes the row; FK
  `communication_jobs.template_id → communication_templates.id` is
  `onDelete: "cascade"` (`schema.ts:1835-1837`), destroying **every job ever
  sent through it** (`externalId`, timestamps, errors). The confirm dialog
  claims a "fall back to defaults" (page.tsx:197), but `defaultSmsTemplates`
  (`sms-templates.ts:273-325`) is never imported anywhere else — no fallback
  exists; the trigger just finds no active template and skips the send.
- `communicationTriggerTypeEnum` has 15 values (`schema.ts:1732-1752`); the
  CRUD zod schema (`templates/route.ts:26-38`, `[id]/route.ts:26-38`) allows
  only 11 — missing `estimate_sent`, `payment_receipt`, `invoice_overdue`,
  `warranty_expiring`. The editor's `TRIGGER_TYPES` list
  (`template-editor-dialog.tsx:40-51`) has only 10, also missing `technician_arrived`.
- `booking-recovery.ts` (`recoverAbandonedBookings`,
  `recoverAbandonedWebSessions`) claims the ledger and checks consent, then
  calls `sendSms` **directly** with a hardcoded constant `RECOVERY_MESSAGE`
  (`booking-recovery.ts:21-22,102`) — never through
  `communication_templates`/`communication_jobs`, so this real SMS is neither
  editable here nor visible in comms observability.
- `getCommsOutcomeSummary`/`api/admin/communications/outcomes`
  (`observability.ts`, `outcomes/route.ts`) is fully built (sent/failed/
  pending/suppressed-by-reason/email-stalled); zero UI callers — dead
  capability today.
- Email sends (`job-queue.ts:260-291`) render via the same Handlebars
  plain-text function as SMS, wrapped as `` `<p>${body}</p>` ``.
  `email-templates.tsx` (React Email engine) has zero importers — dead code.
  Resend `from` is hardcoded (`"notifications@spears-services.com"`,
  `job-queue.ts:272`, `// TODO: Make configurable per org`).
- No dedicated test file for this page, `triggers.ts`, or `job-queue.ts`
  (confirmed by directory listing: `outbound-ledger.test.ts`,
  `consent.test.ts`, `money-triggers.test.ts`, `booking-recovery.test.ts`,
  `observability.test.ts`, `send-invoice-reminder.test.ts`,
  `web-recovery.test.ts` exist; `triggers.test.ts`/`job-queue.test.ts` don't).

## 4. Gaps

| Gap | Severity | Evidence |
|---|---|---|
| Templates CRUD (POST/PATCH) rejects `estimate_sent`, `payment_receipt`, `invoice_overdue`, `warranty_expiring` — 4 of 15 live trigger types are unmanageable from this page | P0 | `templates/route.ts:26-38`, `[id]/route.ts:26-38` vs `schema.ts:1732-1752` |
| `/api/communications/send` has no `isDemoAccount` check — a demo session can trigger a real SMS/email to an arbitrary recipient | P0 | `src/app/api/communications/send/route.ts` (no import) vs `send-reminder/route.ts:3,31` |
| Deleting a template CASCADE-deletes all its `communication_jobs` history (incl. already-sent records), and the confirm dialog claims a nonexistent "fallback to defaults" | P0 | `schema.ts:1835-1837`; `page.tsx:197`; `defaultSmsTemplates` unused (`sms-templates.ts:273-325`) |
| Editor `TRIGGER_TYPES` dropdown offers only 10 of 15 trigger types | P1 | `template-editor-dialog.tsx:40-51` |
| Template save only validates Handlebars syntax, not variable availability; a bad variable throws on every send with zero admin-facing signal (outcomes API built, not shown) | P1 | `sms-templates.ts:235-242`; `job-queue.ts:243`; `observability.ts` unused in UI |
| Event-driven triggers (`triggers.ts`) have no outbound-ledger dedupe, unlike every cron-driven trigger | P1 | `triggers.ts` (no `claimOutboundOnce`) vs `money-triggers.ts:450`, `warranty-queries.ts:217` |
| `booking-recovery.ts` sends bypass templates + the comms queue entirely (hardcoded copy, no retry, invisible to observability) | P1 | `booking-recovery.ts:21-22,102` |
| Comms-health summary API exists, unused in any admin UI | P2 | `observability.ts`, `outcomes/route.ts` |
| Resend `from` address hardcoded, not per-org | P2 | `job-queue.ts:272` |
| `email_html` template type doesn't render real HTML (dead React Email engine) | P2 | `email-templates.tsx` (0 importers); `job-queue.ts:265-275` |
| No variable-reference/preview in the editor for the selected trigger | P2 | `template-editor-dialog.tsx` (no reference panel) |

## 5. Requirements

- **Rcommunications-1**: Templates CRUD zod schemas (`templates/route.ts`,
  `[id]/route.ts`) MUST accept all 15 `communicationTriggerTypeEnum` values.
  *AC*: `POST /api/admin/communications/templates` with
  `triggerType: "invoice_overdue"` returns 201, not `VALIDATION_ERROR`.
- **Rcommunications-2**: `/api/communications/send` MUST reject demo-account
  sessions before enqueueing, matching `send-reminder`/`conversations/message`.
  *AC*: a demo-session POST returns 403 `DEMO_RESTRICTED`; no
  `communication_jobs` row is inserted.
- **Rcommunications-3**: Deleting a template MUST NOT delete historical
  `communication_jobs` rows; confirm-dialog copy MUST NOT claim a fallback
  that doesn't exist. *AC*: after DELETE, prior job rows referencing that
  `templateId` still exist (FK off `cascade`, e.g. `restrict`/`set null`);
  dialog states future triggers for that key won't send until restored.
- **Rcommunications-4**: The editor's `TRIGGER_TYPES` list MUST include every
  trigger type reachable per R1 (all 15). *AC*: the "Trigger type" `<Select>`
  renders 15 options, confirmed via `screenshot-page.mjs`.
- **Rcommunications-5**: The templates page MUST surface send-health
  (sent/failed/pending/suppressed) via the existing outcomes API. *AC*:
  the page fetches `/api/admin/communications/outcomes` and renders the
  counts; a template with jobs stuck `failed` is visible without leaving.
- **Rcommunications-6**: Event-driven triggers in `triggers.ts` MUST claim an
  outbound-ledger slot before `queueCommunicationJob`, matching
  `money-triggers.ts`/`warranty-queries.ts`. *AC*: a new `triggers.test.ts`
  asserts calling `triggerAppointmentScheduled` twice with the same
  `(organizationId, customerId, serviceRequestId)` enqueues exactly one job.
- **Rcommunications-7**: `recoverAbandonedBookings`/`recoverAbandonedWebSessions`
  MUST render an editable template via `queueCommunicationJob`, not a
  hardcoded `sendSms` call. *AC*: a template controls the recovery message
  text; the send appears in `communication_jobs` and in
  `getCommsOutcomeSummary`.

## 6. Non-goals

- No WYSIWYG/drag-and-drop email builder — SMS dominates volume; building on
  the already-dead React Email engine compounds debt (Brainstorm).
- No A/B testing or i18n for templates — no evidence of need at this scale.
- No template version history/diff UI this round — fix the CASCADE data-loss
  bug (R3) first; a history UI on a lossy delete is backwards.
- No changes to `consent.ts` (quiet hours, per-type toggles, STOP/START) —
  verified solid (lens d) and a separate consent-settings concern.
- No changes to the *existing* `isDemoAccount` call sites or mechanism —
  deliberate and correct where present; R2 only closes a coverage gap.
- No proactive variable-availability *prevention* at save time (full
  cross-check against `templateVariableSchemas`) — R5 gives visibility
  instead; prevention is a larger effort deferred P2 (Brainstorm).
- No bulk import/export of templates — count is small and bounded.

## 7. Invariants

- Tenancy: every query scopes by `session.organizationId` — verified in every
  read/write above.
- The consent gate (`checkSendAllowed`) stays the single send-time
  chokepoint; R6/R7 must route through `queueCommunicationJob`, never a
  "simpler" direct send that skips it.
- `communication_templates` keeps `uniqueIndex(organizationId, key)` — R1
  must not touch this constraint.
- neon-http: no `db.transaction()` — a multi-row change for R3 uses
  `db.batch()` (AGENTS.md).
- Background work stays on Vercel `after()`/cron, never a detached promise.
- Money-loop comms (`payment_receipt`, `estimate_sent`, `invoice_overdue`)
  stay best-effort/non-blocking — never fail or roll back the underlying
  payment/estimate/invoice action.
- Demo account: outbound sending stays blocked wherever already blocked; R2
  extends, never narrows, that coverage.
- Copy canon: sentence case, "technician" not "tech", human error copy (no
  `err.message` in UI) — applies to new UI text from R3/R5.

## 8. Verification

- `npx tsc --noEmit` → 0. `npx eslint <changed files>` → 0.
- `npx vitest run` → capture the live baseline first, must not drop. Existing
  relevant suites: `outbound-ledger.test.ts`, `consent.test.ts`,
  `money-triggers.test.ts`, `booking-recovery.test.ts`,
  `observability.test.ts`, `send-invoice-reminder.test.ts`,
  `web-recovery.test.ts`. New pure-helper tests (no jsdom/RTL) required:
  `triggers.test.ts` (R6 double-call dedupe) and R7's recovery path routing
  through `queueCommunicationJob`.
- Manual API (R1/R2): POST the templates API with each of the 4
  previously-rejected `triggerType` values → 201/200, not `VALIDATION_ERROR`;
  `POST /api/communications/send` under a demo session → 403
  `DEMO_RESTRICTED`.
- Visual (R4/R5): mint session → `npm run dev` (background) →
  `node scripts/agent/screenshot-page.mjs /admin/communications/templates` —
  confirm the dropdown lists 15 options and a send-health summary renders.
  Look at the image.
- `node scripts/agent/verify-skills.mjs` → 0 missing, after
  `page-communications/SKILL.md` is updated for any changed files/flows.
