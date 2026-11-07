# Replica M3d: Forms + site view

Status: v1 DRAFT (2026-11-07), for adversarial review. Owner: Raymond Chen.
Milestone source: `replica/architecture.md` build order "M3d Forms + site view" (line 609) and the F04
tech-loop ownership rule (line 146). Builds on M3a (ownership, close-out), M3b (idempotency keys) and
M3c (field preambles, intents storage, equipment location rule).

## 1. Goal

The office builds a checklist under Settings. On site, every technician working a visit sees the forms
that apply to the job, fills one in, and leaves; the answers are saved on the server as they type, so a
reload (or a second phone) shows the draft. Submitting locks it. The office sees the answers on the
request's detail sheet, and erasing the customer removes them. A lead cannot close out while a required
form is unsubmitted. A Site page shows what the technician should know about the address before they
start: the earlier jobs there, the open estimates and the customer's membership with its next
maintenance visit. Photos get a quality setting, are resized on the phone, and the Photos card also takes
PDF files.

Done when (architecture.md): an admin creates a checklist, the tech fills half, reloads, sees the draft,
submits; the submission shows on the admin job and is anonymised by erase; the location tab lists past
jobs, open estimates and the membership.

Feature rows (`replica/features.csv`, row = file line):
- **125** Job forms and checklists (must) → `yes`.
- **131** Location info tab: history / opportunities / recurring (must) → `yes` (history = past jobs at
  the address; opportunities = open estimates; recurring = the active membership and its upcoming
  maintenance visits).
- **126** Required forms block close-out (should) → `yes` (ruled in, §5.5).
- **122** Photos / video / files on job with quality setting (must) → `yes` with the note "photos with a
  quality setting + PDF files; no video". **Video is cut** (§10). If the lead reads row 122 as needing
  video, it stays `partial` and parity loses one must; architecture.md already scoped it as
  "122 (photos/files)", so this spec marks it `yes`.
- Not touched: 127 (non-job and PDF-overlay forms, could), 124 (offline mode, must).

## 2. Surfaces

| surface | who | what |
| --- | --- | --- |
| Settings → `Forms` tab (`/admin/settings?tab=forms`) | admin | list of the org's forms: name, `N questions`, applies to (`All jobs` or the job type names), `Required to close out` chip, `Archived` chip, last changed. `New form` |
| Form builder `/admin/settings/forms/[id]` | admin | §7.1 |
| Request detail sheet, new `Forms` section after `Visits` (`request-detail-sheet.tsx` mounts `request-forms-section.tsx`) | admin | every submission of the request, newest visit first: form name, `Visit #N`, `Draft` / `Submitted` / `Answers removed`, who and when; expands to the questions and answers from the submission's own snapshot. Missing required forms on an open request: "Not submitted yet: <name>". `Reopen` on a submitted one (§5.6) |
| Job page `Forms` card (`/tech/jobs/[id]`, after `Equipment`) | every technician who can read the job, native jobs | the forms for the visit the page shows (§4.3). Rows link to the fill page. `Add a form` when the caller can write |
| Fill page `/tech/jobs/[id]/forms/[formId]?visit=<appointment id>` | readers see it; technicians with a non-cancelled assignment on that visit fill it | §7.2 |
| Job page `Site` card (after the summary, before `Estimates`) | every technician who can read the job (native or synced) | one line of counts and a link to the Site page |
| Site page `/tech/jobs/[id]/site` | same | §7.3 |
| Job page `Photos` card | as today (any reader; late uploads allowed) | quality setting, client resize, `Add file` for PDFs (§7.4) |

"Tab" in row 131 is satisfied by the Site page reached from the job page, the same pattern as the M3c
estimate pages. The 718-line job client (`src/components/tech/tech-job-detail-client.tsx`) is not
restructured into tabs.

## 3. Data model

Migration `drizzle/0058_m3d_forms.sql` (hand-authored, idempotent: `CREATE TABLE IF NOT EXISTS`, one
`DO $$ … EXCEPTION WHEN duplicate_object` block per constraint, `CREATE [UNIQUE] INDEX IF NOT EXISTS`,
`--> statement-breakpoint` between statements). `_journal.json` entry `idx 58`, tag `0058_m3d_forms`, a
fresh `when`; `meta/0058_snapshot.json` copied from `0057_snapshot.json` with the two tables added, a new
`id`, `prevId` = 0057's id; `npx drizzle-kit generate` must then report "No schema changes". 0057 is the
latest on main (`drizzle/meta/_journal.json`) and no local branch carries a 0058; re-check the journal
when writing it. Declared in `src/lib/db/schema.ts` with `check()` for every CHECK below.

### 3.1 `forms`

| column | type | notes |
| --- | --- | --- |
| `id` | uuid PK | `officeId("form", org, clientToken)` (§4.1) |
| `organization_id` | uuid NOT NULL → organizations ON DELETE CASCADE | |
| `name` | text NOT NULL | 1–80, trimmed |
| `description` | text NULL | ≤ 300; shown to the technician above the questions |
| `fields` | jsonb NOT NULL DEFAULT `'[]'` | the flat field list (§3.3). CHECK `jsonb_typeof(fields) = 'array'` |
| `job_type_ids` | uuid[] NOT NULL DEFAULT `'{}'` | empty = all jobs; else the `job_types` ids (no FK on array elements; the writer validates them against the org's job types, readers intersect) |
| `required_for_close_out` | boolean NOT NULL DEFAULT false | §5.5 |
| `active` | boolean NOT NULL DEFAULT true | archive, never delete |
| `version` | integer NOT NULL DEFAULT 1 | CAS token and snapshot version; +1 on every PATCH (the `appointments.version` pattern, `schema.ts:713`) |
| `created_by` | uuid NULL → users ON DELETE SET NULL | |
| `created_at`, `updated_at` | timestamptz NOT NULL DEFAULT now() | |

Indexes: `forms_org_active_idx (organization_id, active)`; `forms_org_name_active_unique` UNIQUE on
`(organization_id, lower(name)) WHERE active`.

### 3.2 `form_submissions`

| column | type | notes |
| --- | --- | --- |
| `id` | uuid PK DEFAULT gen_random_uuid() | the natural key below makes creation idempotent; no derived id needed |
| `organization_id` | uuid NOT NULL → organizations ON DELETE CASCADE | |
| `form_id` | uuid NOT NULL → forms (default NO ACTION: forms are never deleted; an org purge removes both sides in one cascade, which NO ACTION allows, as in M3c §3) | |
| `service_request_id` | uuid NOT NULL → service_requests ON DELETE CASCADE | the session delete in `conversation-queries.ts:686` hard-deletes requests |
| `appointment_id` | uuid NOT NULL → appointments ON DELETE CASCADE | the visit |
| `form_name` | text NOT NULL | snapshot |
| `form_version` | integer NOT NULL | snapshot of `forms.version` |
| `fields` | jsonb NOT NULL | snapshot of `forms.fields` at row creation; CHECK array |
| `values_encrypted` | text NULL | `encrypt(JSON.stringify(values))` (`src/lib/crypto.ts:30`); NULL = nothing answered yet, or erased |
| `status` | text NOT NULL DEFAULT `'draft'` | CHECK `status IN ('draft','submitted')` |
| `revision` | integer NOT NULL DEFAULT 0 | +1 on every values write, submit and reopen; CHECK `revision >= 0` |
| `last_save_id` | uuid NULL | the client's save token of the last write (§4.2) |
| `started_by`, `updated_by`, `submitted_by` | uuid NULL → users ON DELETE SET NULL | technician ids, not customer data |
| `submitted_at` | timestamptz NULL | CHECK `(status = 'submitted') = (submitted_at IS NOT NULL)` |
| `erased_at` | timestamptz NULL | set by customer erasure |
| `created_at`, `updated_at` | timestamptz NOT NULL DEFAULT now() | |

Indexes: `form_submissions_visit_form_unique` UNIQUE `(service_request_id, appointment_id, form_id)`
(architecture: "unique per request/visit/form"); `form_submissions_org_request_idx (organization_id,
service_request_id)`; `form_submissions_form_idx (form_id)`.

### 3.3 Field definitions (`src/lib/forms/form-schema.ts`, pure, zod, shared by server and both clients)

A form is a flat list (no sections table, no nesting, no conditional logic). Each field:
`{ id, type, label (1–120), help? (≤ 200), required (boolean) }` plus per type:

| type | in | value | extra definition | why |
| --- | --- | --- | --- | --- |
| `checkbox` | yes | `true` (unticked = absent) | — | the checklist item. Required means "must be ticked" |
| `yes_no` | yes | `'yes'` \| `'no'` | — | pass / fail questions |
| `short_text` | yes | string 1–200 | — | model, filter size |
| `long_text` | yes | string 1–2000 | — | findings |
| `number` | yes | finite number, ≤ 3 decimals, within `min`/`max` when set, else −100000…100000 | `unit?` (≤ 12, e.g. `psi`, `°F`, `A`), `min?`, `max?` (min ≤ max) | the "reading" type: refrigerant pressure, superheat, amps. No separate `reading` type |
| `choice` | yes | one option id | `options: [{ id, label 1–60 }]` 2–12, labels unique case-insensitively | filter condition: clean / dirty / replaced |
| `heading` | yes | none (never required) | — | a section title inside the flat list, so a long checklist reads in groups without a sections model |
| `photo` | **no** | | | dev has no R2 (page-tech gotcha), photo uploads are not keyed (a retry duplicates), and a photo answer would need its own erase path. Technicians use the job's Photos card |
| `signature` | **no** | | | the job's drawn signature already exists (`POST /api/tech/jobs/[id]/signature`) |
| multi-select, date, dropdown, calculated, conditional | **no** | | | scope |

`id` = `f_` + 10 characters `[a-z0-9]`, minted by the builder when a field is added, kept when its label
or settings change; unique within the form. Limits: 1–60 fields per saved form with at least one non-
`heading`; definition JSON ≤ 64 KB. Values JSON (`{ [fieldId]: value }`, unanswered = key absent) ≤
32 KB after `JSON.stringify` → else 400 `INVALID_INPUT`.

Validation, two strengths (`src/lib/forms/form-values.ts`, pure):
- **draft**: every key is a field id of the snapshot with a well-typed value; `heading` keys refused;
  required is not checked.
- **submit**: draft rules plus `missingRequired(fields, values)` = required fields without a value →
  400 `FORM_INCOMPLETE` with `details: { fieldIds }`.

Why not reuse `custom_field_definitions` (`schema.ts:1750`): those hold one current value per entity with
no visit, no snapshot, no draft/submitted state and plaintext jsonb values; a checklist answer must be
per visit, versioned by snapshot and encrypted.

## 4. Ids, idempotency and versioning

### 4.1 Office writes
`POST /api/admin/settings/forms` takes `{ clientToken: uuid, name }`; the server derives the id with
`officeId("form", org, clientToken)` (`src/lib/http/idempotency.ts:89`, its `kind` union gains `"form"`)
and inserts `ON CONFLICT (id) DO NOTHING` → 201 created / 200 replay (M3b §8 pattern; the dialog mints
the token when it opens and a new one after a success). Edits are `PATCH` with `{ version }`:
`UPDATE forms SET …, version = version + 1, updated_at = now() WHERE id = $id AND organization_id =
$org AND version = $v RETURNING version`. Zero rows → missing → 404; else 409 `STALE` "Someone else
changed this form. Reload to see their changes." A name collision (`isUniqueViolation(err,
"forms_org_name_active_unique")`, `src/lib/db/unique-violation.ts`) → 409 `NAME_TAKEN` "A form with this
name already exists." (also on restore of an archived form whose name is now taken).

### 4.2 Draft autosave: no idempotency key
Autosave is a whole-document, last-write-wins PUT of the values, so it is made naturally idempotent
instead of keyed (M3b §4 precedent: "Line DELETE is naturally idempotent and needs no key"). Keying it
would add an `idempotency_keys` row per keystroke burst, and the key reducer's "re-send the old body
first" rule fights autosave, where the newest values always replace older ones. Each PUT carries:
- `baseRevision`: the `revision` the client last saw (0 when no row exists yet);
- `formVersion`: the version the client rendered (the snapshot's, or the live form's when no row);
- `saveId`: a `mintKey()` uuid per save attempt, re-used when the same body is retried.
The write lands only when `revision = baseRevision`; it sets `revision = revision + 1`, `last_save_id =
saveId`. A retry after an unknown result finds `revision = baseRevision + 1 AND last_save_id = saveId`
→ 200 replay with the same revision. Any other revision → 409 `STALE` with `details: { revision }`;
the client merges (§7.2) and saves again.

### 4.3 Submit: keyed
`POST …/forms/[formId]/submit` carries an `Idempotency-Key` and runs through `withIdempotency`
(`src/lib/http/idempotency.ts:210`, M3b §4). Client intent id `form:submit:<formId>:<appointmentId>` in
its own storage key `tech:form:<rid>:intents` via `useIdempotencyKey({ storageKey, rehydrate: false })`
(`src/hooks/use-idempotency-key.ts:37`); the fill page re-sends a stored intent on mount before it unlocks
(the M3c `recoverEstimateIntents` rule), and autosave is paused while that intent is `sent` or `unknown`.
- Stored codes added to `STORED_CODES` (`src/lib/http/idempotency-codes.ts:13`): `FORM_SUBMITTED`,
  `FORM_INCOMPLETE`, `FORM_LOCKED`. `INVALID_INPUT` is already stored.
- Not stored: `STALE`, `FORM_CHANGED`, `FORM_ARCHIVED`, `NOT_ASSIGNED`, `NOT_ON_SITE`, `JOB_CLOSED`,
  `MANAGED_EXTERNALLY`, `NOT_FOUND`.

### 4.4 Versioning
A submission renders from its own `fields` / `form_name` / `form_version` forever. The snapshot is taken
when the row is created (first draft save or a submit with no draft). Before that, the GET shows the live
form. The race "office edits between the GET and the first save" is closed by `formVersion`: the INSERT
copies the live form only `WHERE f.version = $formVersion`, and the values UPDATE requires
`form_version = $formVersion`; a miss re-reads and answers 409 `FORM_CHANGED` "The office changed this
form. Check your answers." The client refetches, keeps answers whose field id still exists with the same
type (`carryValues`, pure), and saves again. An existing row is never re-snapshotted: a draft started on
version 2 stays on version 2 after the office saves version 3.

## 5. Writers (`src/lib/tech/form-writes.ts`, `src/lib/admin/form-queries.ts`)

Shared SQL fragments (rendered and tested with `PgDialect`):
- `visitGateSql(org, rid, aid, me)` = `EXISTS (appointments p JOIN appointment_assignments a WHERE p.id =
  $aid AND p.service_request_id = $rid AND p.organization_id = $org AND a.organization_id = $org AND
  p.cancelled_at IS NULL AND a.technician_id = $me AND a.status <> 'cancelled')` — the per-visit form of
  M3c `onJobSql` (`src/lib/tech/equipment-writes.ts:28`).
- `requestGateSql(org, rid)` = the request is in `$org`, native (`fieldpulse_job_id IS NULL AND
  hcp_job_id IS NULL`) and its status is in `BILL_STATUSES` (`arrived`, `in_progress`, `on_hold`,
  `completed`; `src/lib/tech/field-sale-statuses.ts`).
- `formAppliesSql(f, r)` = `(cardinality(f.job_type_ids) = 0 OR r.job_type_id = ANY(f.job_type_ids))`.
  A request with NULL `job_type_id` (`schema.ts:531`) gets only all-jobs forms.

### 5.1 Who may fill, and when
Ownership rule (architecture line 146): technicians write "notes, photos, materials and forms on jobs
they can read". Narrowed here: a form is written by any technician — lead or helper — holding a
non-cancelled assignment on **that visit** (`NOT_ASSIGNED` otherwise); readers of the job see every
submission read-only. Request status: `arrived` … `completed` (late completion after close-out is
legitimate, as for equipment); `cancelled` → `JOB_CLOSED`; earlier → `NOT_ON_SITE`. Native jobs only
(F04: "M3 applies to NATIVE requests only"); a FieldPulse/HCP job answers 409 `MANAGED_EXTERNALLY` and
the card reads "Managed in FieldPulse". Consequence, stated: in an org whose requests are all pushed to
FieldPulse, forms (like estimates, invoices and equipment) do not appear.

### 5.2 Save draft (`saveFormDraft`)
Input `{ appointmentId, formVersion, baseRevision, saveId, values }`. Pre-read the row by natural key;
if it exists, check `formVersion = row.form_version` (else `FORM_CHANGED`) and validate (draft) against
its snapshot; if not, read the form (`organization_id = $org`; missing → 404; `active = false` →
409 `FORM_ARCHIVED` "This form was archived by the office."; `version ≠ formVersion` → `FORM_CHANGED`)
and validate against its live fields. Encrypt. One batch:
1. `INSERT INTO form_submissions (organization_id, form_id, service_request_id, appointment_id,
   form_name, form_version, fields, started_by) SELECT … FROM forms f JOIN service_requests r ON r.id =
   $rid WHERE f.id = $form AND f.organization_id = $org AND f.active AND f.version = $formVersion AND
   requestGate AND visitGate ON CONFLICT (service_request_id, appointment_id, form_id) DO NOTHING`.
   An archived or non-applicable form can still be started: applicability decides what is LISTED, the
   tech may add any active form (§7.2 `Add a form`).
2. `UPDATE form_submissions SET values_encrypted = $enc, revision = revision + 1, last_save_id = $saveId,
   updated_by = $me, updated_at = now() WHERE organization_id = $org AND (natural key) AND status =
   'draft' AND erased_at IS NULL AND revision = $baseRevision AND form_version = $formVersion AND
   requestGate AND visitGate RETURNING revision`.
3. Tail `SELECT status, revision, last_save_id, form_version, erased_at` of the row.
Zero rows from 2 → in order: no row → re-run the gates as reads → `NOT_ASSIGNED` / `NOT_ON_SITE` /
`JOB_CLOSED` / `MANAGED_EXTERNALLY` / `FORM_ARCHIVED` / `FORM_CHANGED` / 404; `erased_at` set → 409
`FORM_LOCKED` "This form can't be changed."; `submitted` → 409 `FORM_SUBMITTED` "This form was already
submitted."; `revision = base + 1 AND last_save_id = $saveId` → 200 replay; `form_version ≠ formVersion`
→ `FORM_CHANGED`; else 409 `STALE` `{ revision }`. Success → 200 `{ submissionId, revision, savedAt }`
(201 when step 1 inserted). No audit (drafts are noise).

### 5.3 Submit (`submitForm`)
Input `{ appointmentId, formVersion, baseRevision, values }`, keyed. Same pre-read, submit-strength
validation (`FORM_INCOMPLETE`), same batch with step 2 also setting `status = 'submitted', submitted_by
= $me, submitted_at = now()`. `baseRevision = 0` with no row submits in one go (the tech never paused
long enough for an autosave). Zero rows → the §5.2 map, except `submitted` → stored `FORM_SUBMITTED`
(a different key; the same key replays the stored success). Success → 200 `{ submissionId, revision,
submittedAt }`; audit `form_submitted` (entity `form_submissions`, details `{ formId, appointmentId,
formVersion }`), never on a replay.

### 5.4 Erasure
- `anonymizeCustomer` (`src/lib/admin/erasure-queries.ts:124`) adds one statement to its batch:
  `UPDATE form_submissions SET values_encrypted = NULL, erased_at = now(), updated_at = now() WHERE
  organization_id = $org AND service_request_id IN (requestIds)` (the same `requestIds` pre-read it
  already does; `inArray([])` is a no-op). Status, who and when are kept; the snapshot holds only
  org-authored labels. The admin section reads "Answers removed". A later save on an erased draft →
  `FORM_LOCKED`.
- `deleteCustomer` (`src/lib/admin/crm-queries.ts:1111`) adds `DELETE FROM form_submissions WHERE
  organization_id = $org AND service_request_id IN (SELECT id FROM service_requests WHERE
  organization_id = $org AND customer_id = $cust)`, placed BEFORE its statement that nulls
  `service_requests.customer_id`. (M3c left field-typed estimate names in place on delete; forms do not
  repeat that gap.)
- **Job photos (ruled in):** today `attachmentMatch` (`erasure-queries.ts:181`) matches
  `attachments.customer_id` or the customer's chat sessions, but `addJobPhoto` (`field-queries.ts:595`)
  writes only `service_request_id`, so erase leaves job photos of the customer's home in place. M3d is
  the photos milestone: `attachmentMatch` gains `inArray(attachments.serviceRequestId, requestIds)`; the
  existing pre-read and `after()` storage delete then cover them. The `customer_erased` audit details keep
  their shape (`attachmentsDeleted` grows).
- Org purge cascades both tables (org FK).

### 5.5 Required forms block close-out (row 126: in)
A form with `required_for_close_out` blocks the lead's close-out on a request it applies to
(`formAppliesSql`) until a **submitted** submission of it exists on any non-cancelled visit of the
request. Only active forms count (archiving a required form unblocks). Not blocked: helpers' Done, the
lead's hold, and the office's completion (`completeRequestFromAdmin`, `status-writes.ts:259`): the
office is the override, and its Forms section names what is missing.
- `requiredFormsDoneSql(org, rid)` = `NOT EXISTS (SELECT 1 FROM forms f, service_requests r WHERE r.id =
  $rid AND r.organization_id = $org AND f.organization_id = $org AND f.active AND
  f.required_for_close_out AND formApplies(f, r) AND NOT EXISTS (SELECT 1 FROM form_submissions s JOIN
  appointments p ON p.id = s.appointment_id WHERE s.organization_id = $org AND s.form_id = f.id AND
  s.service_request_id = $rid AND s.status = 'submitted' AND p.cancelled_at IS NULL))`.
- `closeOutRequest` (`status-writes.ts:227`) passes it into `completeRequest`'s guard next to
  `openRowsOnLiveVisits` and `stillLead`. The batch stays one statement longer in its guard only; the
  lead's own row still completes first, as for every other blocker today (the active lead stays
  authorised with a completed row, F04).
- `Blocker` (`status-actions.ts:12`) gains `{ kind: "form_required"; formId: string; formName: string }`;
  `closeOutBlockers` (`status-writes.ts:315`) appends one per missing form (names go to response bodies
  only); `tech-status-confirm.ts` maps it to "Submit “<form name>” first."; `close-out-sheet.tsx` keys it
  `form_required-<formId>`. The job summary already carries `blockers` (`field-queries.ts:173`).
- Race, accepted: a submit and a close-out do not share a lock. A close-out that reads before the submit
  commits refuses (the safe direction; the lead taps again). An office reopen racing a close-out can let
  the close-out land with the form reopened; the office caused it.
- A required "all jobs" form created mid-day blocks every open native job in the org until filled. The
  builder says so under the switch (§7.1).

### 5.6 Office reopen (`reopenSubmission`)
`POST /api/admin/requests/[id]/forms/[submissionId]/reopen` `{ revision }`: `UPDATE form_submissions SET
status = 'draft', submitted_at = NULL, submitted_by = NULL, revision = revision + 1, updated_at = now()
WHERE id = $sid AND organization_id = $org AND service_request_id = $rid AND status = 'submitted' AND
erased_at IS NULL AND revision = $revision RETURNING revision`. Zero rows → missing → 404; already a
draft → 200 `{ changed: false }`; erased → 409 `FORM_LOCKED`; else 409 `STALE`. Audit `form_reopened`
(`{ formId, appointmentId }`). The technician can then edit and submit again (same row, same snapshot).
Reopen never un-completes a request.

### 5.7 Office form writes
`createForm` (§4.1; name required, everything else defaults; ≤ 100 forms per org including archived →
409 `LIMIT_REACHED` "You've reached the limit of 100 forms."), `updateForm` (PATCH; whole `fields` array
replaced; `jobTypeIds` must all be the org's job types → 400 `UNKNOWN_JOB_TYPE` "One of those job types
no longer exists."; field ids must stay unique; `fields` validated by `formDefinitionSchema`). Audit:
`form_created`, `form_updated` (`{ version, fieldCount }`), `form_archived` / `form_restored`.

## 6. Routes (all `force-dynamic`)

Tech writes use `techFormPreamble` (new in `src/lib/tech/invoice-route-guards.ts`, beside
`techEquipmentPreamble`): session 401 → same-origin 403 → `isUuid` (request, form) 400 → rate
`tech:form:write:<user>` (`adminMutation`, 30/min) → readable job 404 → native 409 → status
(`FORM_PREAMBLE = { bucket: "form", statuses: BILL_STATUSES, beforeCopy: "Arrive at the job first.",
closedCopy: "This job is closed." }`) → body (`appointmentId` uuid) → the caller's non-cancelled row on
that visit (`findTechAssignments`, `ownership.ts:114`) else 403 `NOT_ASSIGNED` "Only a technician on this
visit can fill in its forms." → (submit only) key → writer. The writers re-check status and visit inside
the batch.

| route | gate | body | success |
| --- | --- | --- | --- |
| `GET /api/tech/jobs/[id]/forms?visit=<aid>` | session, readable job, native (409), `visit` a non-cancelled visit of the request (else 404), read rate `tech:form:read:<user>` (`adminRead`) | — | `{ visitId, canWrite, forms: [{ formId, name, description, required, submission: { id, status, revision, updatedAt, submittedAt, submittedByName } \| null }], otherForms: [{ formId, name }] }`. `forms` = active applicable forms plus any form with a submission on this visit (archived or not applicable included); required = applies and `required_for_close_out` and active. Order: required first, then name. `otherForms` = active forms not in `forms` |
| `GET /api/tech/jobs/[id]/forms/[formId]?visit=<aid>` | same | — | `{ form: { name, description, version, fields }` (the submission's snapshot when a row exists, else the live form; an archived form with no row → 409 `FORM_ARCHIVED`) `, submission: { id, status, revision, values, updatedAt, updatedByName, submittedAt, submittedByName, erased } \| null, canWrite, writeBlockedReason }`. `values` decrypted (`{}` when NULL; an undecryptable value → `values: null` and the page says "These answers can't be shown.") |
| `PUT /api/tech/jobs/[id]/forms/[formId]/draft` | `techFormPreamble`, no key | §5.2 | 201/200 `{ submissionId, revision, savedAt }` |
| `POST /api/tech/jobs/[id]/forms/[formId]/submit` | `techFormPreamble` + key | §5.3 | 200 `{ submissionId, revision, submittedAt }` |
| `GET /api/tech/jobs/[id]/site` | session, `isUuid`, readable job (native or synced; read-only), read rate `tech:site:read:<user>` | — | §7.3 contract |
| `GET /api/admin/settings/forms` | admin session, `adminRead` | — | `{ forms: [{ id, name, fieldCount, jobTypeIds, requiredForCloseOut, active, version, updatedAt, submissionCount }] }` |
| `POST /api/admin/settings/forms` | admin session, `adminMutation` | `{ clientToken, name }` | 201/200 `{ id }` |
| `GET /api/admin/settings/forms/[id]` | admin session, `isUuid` | — | the full form |
| `PATCH /api/admin/settings/forms/[id]` | admin session, `isUuid`, `adminMutation` | `{ version, name?, description?, jobTypeIds?, requiredForCloseOut?, fields?, active? }` | `{ version }` |
| `GET /api/admin/requests/[id]/forms` | admin session, `isUuid`, request in org (404) | — | `{ submissions: [{ id, formId, formName, formVersion, appointmentId, appointmentNumber, status, revision, erased, fields, values, updatedAt, updatedByName, submittedAt, submittedByName }], missingRequired: [{ formId, name }] }` (`missingRequired` empty unless the request is native and not completed/cancelled) |
| `POST /api/admin/requests/[id]/forms/[sid]/reopen` | admin session, `isUuid` ×2, `adminMutation` | `{ revision }` | `{ revision, changed }` |

Admin routes follow the job-types routes (`src/app/api/admin/settings/job-types/route.ts`):
`getAdminSession`, rate key `admin:forms-<op>:<user>`, `readJsonBody`, `VALIDATION_ERROR` with
`details.path` rendered through `settingsFieldErrorCopy`. Logs carry codes and ids only, never values
(`logger.error({ code, submissionId }, …)`; the pino serializer already drops Drizzle `query`/`params`).

## 7. Client

Tech conventions (base shadcn primitives, `h-11` targets, sentence case, human errors, `MAY_NOT_HAVE_SAVED`
for unknown writes). Admin conventions (admin-ui primitives, `SectionCard`, sentence case).

### 7.1 Form builder (`/admin/settings/forms/[id]`, `src/components/admin/settings/form-builder.tsx`)
- Header: name input, description textarea, `Applies to` (`All jobs` / `Some job types` + checkbox list
  of active job types from `GET /api/admin/settings/job-types?active=1`), `Required to close out` switch
  with the line "Leads can't close out a job until this form is submitted. This applies to open jobs too."
- Questions: one row per field: type select (`Checkbox`, `Yes / no`, `Short answer`, `Long answer`,
  `Number`, `Choice`, `Heading`), label, help, `Required` switch (hidden for `Heading`), `Unit` / `Min` /
  `Max` for `Number`, an options editor for `Choice` (add, rename, remove; 2–12). `Move up` / `Move down`
  buttons (no drag), `Remove` with a 5-second `Undo`. `Add question` appends a `Checkbox`.
- Pure helpers (`src/lib/admin/form-builder.ts`): `addField`, `moveField`, `removeField`, `changeType`
  (keeps label/help/required, drops type-specific settings), `newFieldId`, `builderErrors(fields)` →
  inline copy per row.
- `Save` enabled when dirty and valid; sends the whole form with `version`; a 409 `STALE` keeps the
  draft and shows the copy with `Reload`. `useUnsavedChangesGuard` (`src/hooks/use-unsaved-changes-guard.ts:21`)
  while dirty. `Archive` / `Restore` (confirm "Archive this form? Technicians won't see it on new jobs.
  Answers already given are kept."). The list tab opens the builder; `New form` asks for a name in a
  dialog (with `clientToken`) and opens the builder.

### 7.2 Fill page (`/tech/jobs/[id]/forms/[formId]?visit=<aid>`, `src/components/tech/forms/`)
- Header: form name, description, then a status line: `Saving…`, `Saved · 2:41 PM`, `Not saved yet.
  Retrying…` (network/5xx/429), `Submitted · Nov 7, 2:41 PM · <technician name>`.
- Controls: `checkbox` = 44 px checkbox row; `yes_no` = a two-button radio group `Yes` / `No`; texts =
  `Input` / `Textarea` with a character count near the limit; `number` = `Input inputMode="decimal"` with
  the unit as a suffix, inline "Enter a number between 0 and 50."; `choice` = a radio list; `heading` =
  a sub-title with its help. Required questions show `Required` after the label.
- **Autosave** (state machine `nextSaveState`, pure): a change marks dirty; a save starts 1.5 s after
  the last change, on blur of a text field, and on `visibilitychange` → hidden; `pagehide` sends a
  `fetch(…, { keepalive: true })` PUT. One save in flight at a time; a change during a save queues one
  more. Never more than one PUT per 3 s (≤ 20/min, under the 30/min bucket); a 429 waits 10 s.
- **Local mirror (both, not offline mode):** each dirty state is mirrored to `sessionStorage`
  `tech:form:<rid>:<aid>:<formId>:draft` = `{ baseRevision, formVersion, values }` (try/catch; cleared
  after a save lands and after submit). On load: a mirror with `baseRevision` equal to the server's
  revision and the same `formVersion` is applied over the server values and saved; any other mirror goes
  through the merge below. A tab closed while offline loses unsaved edits (sessionStorage; offline mode
  row 124 stays out).
- **Merge on `STALE`** (`mergeDraft(base, mine, theirs)`, pure): for each field id, a value the
  technician changed since `base` wins; every other field takes `theirs`. The page shows "Someone else
  changed this form. Their answers are shown, and yours are kept." and saves on the new revision. If
  `theirs` is submitted: read-only, "<name> submitted this form. Your last changes weren't saved."
- **Submit**: `Submit form` (full width, bottom). Missing required answers → no request; each missing
  question shows "Answer this." and a top line "2 required questions aren't answered." with focus on the
  first. Else a confirm "Submit <form name>? You can't change it after." with `Submit` / `Go back`;
  `Submitting…` locks the page. A stored `FORM_SUBMITTED` refetches and shows the submitted state.
- Read-only when `canWrite` is false: `writeBlockedReason` → "Only a technician on this visit can fill in
  its forms." / "Arrive at the job first." / "This job is closed." / "This form was archived by the office."
- Erased: "These answers were removed." and no inputs.

### 7.3 Site page (`/tech/jobs/[id]/site`, `src/lib/tech/site-queries.ts`)
Every query is anchored on the readable request (`findReadableJob`, `ownership.ts:134`): the customer and
location come from `service_requests.customer_id` / `location_id` server-side, never from the client;
every table carries `organization_id = $org`. **Location rule** = the M3c rule
(`locationRuleSql`, `equipment-writes.ts:23`): request without a location → all of the customer's rows;
else rows at that location or with no location.

GET contract `{ hasCustomer, location: { label, propertyType, accessNotes } | null, pastJobs: [...],
openEstimates: [...], membership: {...} | null }`; `hasCustomer: false` → everything else empty.
- `location`: `customer_locations` (`schema.ts:2296`) of `r.location_id`, same customer and org.
- `pastJobs` (newest 20): other `service_requests` of the customer by the location rule, `id <> $rid`,
  status not `cancelled`, ordered by `COALESCE(completed_at, scheduled_date, created_at) DESC, id`.
  Row: `{ id, referenceNumber, date, status, jobTypeName (job_types.name) or issueLabel(issue_type),
  leadTechnicianName (the lead of the request's latest non-cancelled visit, first name only),
  submittedForms (count) }`. FieldPulse-synced jobs are included (history lives there; `service_history`
  is empty). Never `description`, notes, addresses, contact fields or signature names.
- `openEstimates`: `estimates` (`schema.ts:2881`) with `status = 'open'` and `expires_at` NULL or future,
  where `customer_id = r.customer_id` OR `service_request_id` is one of the customer's requests, and the
  location rule through the estimate's request (estimates with no request count). Row: `{ id, label
  (estimateLabel(createdAt, optionCount), estimate-display.ts:20; FieldPulse ones use their `title` or
  "Estimate"), createdAt, totalCents, optionCount, thisJob (service_request_id = $rid), fromFieldPulse }`.
  Display: "Up to $X" when `optionCount > 1`, else "$X".
- `membership`: the customer's `customer_memberships` row with `status = 'active'` (at most one, partial
  unique index, `schema.ts:3274`) joined to `membership_plans` → `{ planName, startedAt,
  currentPeriodEnd, visitsPerYear, upcoming: [{ dueDate, status }] }` where `upcoming` = up to 3
  `membership_visits` (`schema.ts:3323`) with status `scheduled`/`generated`, ordered by `due_date`.
  Memberships are per customer, not per location; the page says nothing about which address it covers.
  No price, no billing fields, no `benefits` jsonb.
- Page: `Back to job`, title `Site` with the location label (or "Service address"), sections `Past
  jobs`, `Open estimates`, `Membership` (`Upcoming maintenance` inside it). Rows are not links (other jobs
  are not readable by this technician; open estimates of this job link to the M3c estimate page for the
  lead only).
- Job page `Site` card: "4 past jobs · 1 open estimate · Member" (each part omitted when zero; all zero →
  "No history at this address yet."), whole card links to the page. It fetches the same GET (one
  query set, counts derived client-side).

### 7.4 Photos (`job-photos-card.tsx`)
- `Photo quality` radio pair `Standard` / `High` with the line "Standard saves data. High keeps more
  detail." Remembered on this phone in `localStorage` `tech:photo-quality` (try/catch; default
  `standard`; a per-viewer convenience). Not an org setting.
- Before upload (`src/lib/tech/photo-resize.ts`, pure plan + a thin browser adapter): decode with
  `createImageBitmap(file, { imageOrientation: 'from-image' })`, draw to a canvas, encode JPEG.
  `standard` = longest edge 1600 px, quality 0.8; `high` = longest edge 3200 px, quality 0.9. Never
  upscale. If the blob is over `UPLOAD_LIMIT_BYTES` (4 MB), step down (0.8 → 0.7 → longest edge × 0.75)
  up to 3 times. Name `<original stem>.jpg`, type `image/jpeg` (passes the server's magic-byte check).
  Re-encoding drops EXIF, including GPS (a privacy gain; stated, not a goal).
- Decode failure (e.g. HEIC on a browser that can't decode it) → upload the original when ≤ 4 MB, else
  "This photo is too large to upload. Try Standard quality." The button reads `Preparing photo…` during
  the resize, then `Uploading…`.
- `Add file` (second button, `accept="application/pdf"`): PDFs upload unchanged through the same route
  (already allowed: `ADMIN_DOCUMENT_MIME_TYPES`, `r2-client.ts:117`); over 4 MB → "This file is too large.
  The limit is 4 MB." The gallery renders non-image rows as a file tile (icon + filename, opens the signed
  URL) instead of an `<img>`.
- Why 4 MB: Vercel Functions cap a request body at 4.5 MB (platform limit; **unverified against this
  deployment**, see §11). Today a full-size iPhone photo (often 3–8 MB) can exceed it, so the resize is the
  fix, not only a setting. The server's 20 MB `MAX_DOCUMENT_FILE_SIZE` is unchanged.
- The photo route is otherwise unchanged (no key, no native gate; a double tap can still store two photos,
  as today).

## 8. Copy

| where | copy |
| --- | --- |
| Forms card, empty | "No forms for this job." (+ `Add a form` when writable) |
| Forms card chips | `Required`, `Not started`, `Draft`, `Submitted`, `Answers removed` |
| Add a form sheet | title "Add a form"; empty "No other forms." |
| Status line | `Saving…` · `Saved · 2:41 PM` · `Not saved yet. Retrying…` · `Submitted · Nov 7, 2:41 PM · Alex Rivera` |
| Unknown submit | `MAY_NOT_HAVE_SAVED` + `Try again` (re-sends the stored body and key) |
| STALE merge | "Someone else changed this form. Their answers are shown, and yours are kept." |
| FORM_CHANGED | "The office changed this form. Check your answers." |
| FORM_SUBMITTED | "This form was already submitted." |
| FORM_LOCKED | "This form can't be changed." |
| FORM_ARCHIVED | "This form was archived by the office." |
| FORM_INCOMPLETE | "2 required questions aren't answered." / per field "Answer this." |
| NOT_ASSIGNED | "Only a technician on this visit can fill in its forms." |
| Confirm | "Submit Maintenance checklist? You can't change it after." `Submit` / `Go back` |
| Close-out blocker | "Submit “Maintenance checklist” first." |
| Office section | "Not submitted yet: Maintenance checklist" · "Answers removed" · `Reopen` (confirm "Reopen this form? The technician can change the answers and submit again.") |
| Builder | "Leads can't close out a job until this form is submitted. This applies to open jobs too." · "Archive this form? Technicians won't see it on new jobs. Answers already given are kept." · NAME_TAKEN "A form with this name already exists." · STALE "Someone else changed this form. Reload to see their changes." · per row "Add a label.", "Add at least two options.", "Min must be less than max." |
| Site card | "4 past jobs · 1 open estimate · Member" · "No history at this address yet." |
| Site page empties | "No other jobs at this address." · "No open estimates." · "Not a member." · no customer: "No customer on this job yet. Ask the office to add one." |
| Site rows | "Nov 3, 2026 · Maintenance · Completed · Alex" · "Estimate · Nov 6 · 2 options" "Up to $4,812.00" `This job` `From FieldPulse` · "Gold plan · Member since Mar 2026 · Renews Apr 1, 2027" · "2 visits a year" · "May 1, 2027 · Scheduled" |
| Photos | "Standard saves data. High keeps more detail." · `Preparing photo…` · `Uploading…` · "This photo is too large to upload. Try Standard quality." · "This file is too large. The limit is 4 MB." · `Add file` |

Canon: request / technician / sign in / cancelled / Unicode … and “ ” / sentence case / no `err.message`
in UI. Dates in the business timezone (`BUSINESS_BASE_LOCATION.timezone`, as `job-display.ts:8` and
`estimate-display.ts:10` use it; the constant there is module-private).

## 9. Tests

No jsdom/RTL; component logic lives in pure helpers.

**Pure (vitest):** `formDefinitionSchema` (each type, id format and uniqueness, option rules, unit/min/max,
heading never required, 60-field and 64 KB caps, at least one non-heading); values validation draft vs
submit per type (decimals, range, unknown ids, heading keys, 32 KB cap); `missingRequired`; `carryValues`
(same id same type kept, type change dropped, removed field dropped); `mergeDraft` (mine-changed wins,
untouched takes theirs, both changed → mine, deletions); `nextSaveState` (debounce, one in flight, queued
follow-up, 3 s floor, 429 back-off, pause while a submit intent is sent/unknown); local mirror parse
(garbage, wrong version); fill-page `writeBlockedReason` → copy; chips; builder helpers (`addField`,
`moveField` at edges, `removeField` + undo, `changeType`, `newFieldId` format, `builderErrors`);
`formApplies`; close-out blocker copy for `form_required`; site row formatters (past job line, "Up to",
membership line, counts line with zero parts omitted); photo `resizePlan` (no upscale, both qualities,
step-down sequence, PDF passthrough, limit) and `qualityFromStorage`; reason → code/copy maps.

**SQL renders (`PgDialect`):** every statement of the draft and submit batches carries `organization_id`
on each table it touches; `visitGateSql`, `requestGateSql`, `formAppliesSql`; `requiredFormsDoneSql` inside
`closeOutRequest`'s guard; the site queries' org predicates and location rule; the erase statement, the
`deleteCustomer` delete order (before the customer_id null), the widened `attachmentMatch`.

**Route tests:** every gate and code of the six tech and six admin routes; 201/200 splits; GET never
returns `values` for another org's request; the site GET returns no key named like `phone`, `email`,
`description`, `signature` (a test walks the payload keys).

**Integration (`tests/integration/field-forms.test.ts`, `VITEST_INTEGRATION=1`, dev DB, throwaway org
created by SQL; never the FieldPulse-connected default org):**
(a) `createForm` with a client token twice → one row; PATCH with a stale version → STALE; duplicate active
name → NAME_TAKEN;
(b) the done-when path: a checklist with 4 checkboxes (2 required) → helper saves 2 answers (revision 1)
→ GET shows them → same `saveId` again → 200, revision 1 → submit with a missing required → FORM_INCOMPLETE
→ complete submit → `submitted`; same key → replay; new key → FORM_SUBMITTED; draft save → FORM_SUBMITTED;
(c) two technicians on one visit save from revision 0 concurrently → one 201, one STALE `{ revision: 1 }`;
(d) office edits the form to version 2 after a draft exists → the draft keeps version 1's fields and
submits against them; a new visit snapshots version 2; a save with `formVersion` 1 on the new visit →
FORM_CHANGED;
(e) gates: a technician only on visit #1 saving on visit #2 → NOT_ASSIGNED; a cancelled visit → 404;
another org's technician → 404; FieldPulse-synced request → MANAGED_EXTERNALLY; `pending` → NOT_ON_SITE;
`cancelled` → JOB_CLOSED; `completed` → allowed;
(f) required: a required form for this job type blocks the lead's close-out (blocker `form_required`,
request stays `in_progress`, the lead's row is `completed`); a required form for another job type does not
block; after submit, close-out completes; office `completeRequestFromAdmin` is not blocked; archiving the
required form unblocks; a submission only on a cancelled visit does not count;
(g) erase: `anonymizeCustomer` → `values_encrypted` NULL, `erased_at` set, status kept; admin GET shows
`erased`; a later save → FORM_LOCKED; the request's job photo attachment rows are gone (storage delete
mocked/absent on dev); `deleteCustomer` deletes the submissions;
(h) reopen → draft, revision +1; stale revision → STALE; a draft reopen → `changed: false`; the
technician edits and resubmits;
(i) archived form: an existing draft still saves and submits; starting it on a new visit →
FORM_ARCHIVED;
(j) site view: past jobs exclude this job, cancelled jobs, other customers' and other locations' jobs, and
include NULL-location jobs; a request without a location lists all of the customer's jobs; open
estimates exclude expired, sold and other customers'; membership with its next visit; a second org's rows
never appear; no customer → `hasCustomer: false`; a FieldPulse-synced job is readable;
(k) audit rows carry ids and enums only (no answer text, no names).

**Browser walk** (throwaway org via `createOrgCore`; admin, technician, helper, customer with a location,
two past requests, an open estimate, an active membership with a scheduled visit, a native request with a
job type, assignments, all by SQL; mint admin and tech sessions with `MINT_ORG_ID` and assert the token's
user and org; queue guard before and zero `communication_jobs` after; 390×844 for tech pages):
admin creates "Maintenance checklist" (4 checkboxes, one number with `psi`, required to close out) →
tech opens the job → Site card counts → Site page lists 2 past jobs, the estimate and the membership →
back → Forms card shows the checklist as `Required` → fill half → wait for `Saved` → reload → the answers
are there → second phone (the helper's session) sees the same draft → lead taps Close out → the sheet
lists "Submit “Maintenance checklist” first." → fill the rest, Submit, confirm → Close out works → admin
request sheet shows the submission with answers → erase the customer → the section reads "Answers
removed". Photo resize and upload cannot run on dev (no R2 write credentials): proved by the pure plan
tests and a mocked route test; the quality toggle is checked on a real phone after deploy and noted.

## 10. Out of scope

- Video upload (row 122 note), photo and signature form fields, file fields.
- Conditional logic, calculated fields, multi-select, dates, sections as a model, form templates library,
  copying forms, drag-to-reorder, a builder preview.
- Non-job forms and PDF overlays (row 127), customer-facing forms in the portal, emailing a submission,
  a PDF of a submission.
- Offline mode (row 124): the session mirror only survives a reload, not a closed tab or a long outage.
- Office editing of answers (the office reopens; the technician edits).
- Reports over answers (values are encrypted as one document per submission; no per-question SQL).
- Forms on FieldPulse/HCP-synced jobs.
- Required forms blocking the office's completion, hold, or a helper's Done.
- Keying the photo upload (double-tap duplicates stay as today); server-side image processing.
- Site page: equipment (already on the job page), invoices / balances, customer contact details, links
  into other jobs, membership price or benefits, per-location membership.

## 11. Rulings and things not verified

Rulings (critics: attack them):
1. Autosave is an unkeyed revision CAS with a save token (§4.2); submit is keyed.
2. One submission per visit per form, shared by every technician on the visit; per-visit write right.
3. Attach by job type (`job_type_ids`, empty = all jobs) plus technician-picked extras; required applies
   only to forms that apply.
4. Snapshot at row creation; `formVersion` guards the gap before it.
5. Locked after submit; only the office reopens.
6. Row 126 in; office completion not blocked.
7. Values encrypted as one ciphertext per submission; erase nulls it, delete removes the row.
8. Job photos are erased with the customer (widened `attachmentMatch`).
9. Site page is read-only and allowed on synced jobs; forms are native-only.
10. Photo quality is a per-device setting; 4 MB client cap; PDFs in, video out.

Not verified (check during the plan or on deploy):
- The Vercel 4.5 MB request-body limit applies to this project's photo route (platform documentation, not
  in the repo). Measure with a 5 MB upload on a preview deploy before relying on it.
- How iOS Safari hands a camera capture to `<input type="file" accept="image/*" capture>` (JPEG vs HEIC)
  and whether `createImageBitmap` honours `imageOrientation` on the iOS versions in use; the fallback
  (upload the original) covers a decode failure but not a sideways image.
- Whether FieldPulse-imported requests carry `location_id` and `job_type_id`; if not, the site view falls
  back to "all of the customer's jobs" and forms show only all-jobs ones (correct by the rules, less
  useful).
- `useUnsavedChangesGuard` composes with a full-page builder route outside the settings shell (it was
  built for the tabbed page).

## 12. Review focus

- **Tenancy and ownership:** every statement org-scoped; the per-visit gate inside both batches; a reader
  without a row on the visit sees but never writes; the site queries can't be steered to another customer.
- **Autosave correctness:** the zero-row re-map order in §5.2, the replay test `revision = base + 1 AND
  last_save_id`, the `formVersion` race at first insert, the merge rule, the 3 s floor against the
  30/min bucket, `keepalive` on `pagehide`.
- **Close-out change:** `requiredFormsDoneSql` inside `completeRequest`'s guard (the M3a batch), the new
  `Blocker` kind end to end, the no-lock race reasoning, the "required form created mid-day" effect.
- **Erasure:** the three changes (anonymize nulls values, delete removes rows before the customer link
  is cut, job photos erased) and that no log, audit or idempotency body ever holds an answer.
- **Idempotency:** the new stored codes are deterministic for their body; `FORM_CHANGED` / `STALE` /
  `FORM_ARCHIVED` are correctly unstored; the submit intent pauses autosave and is re-sent on mount.
- **Scope honesty:** row 122 marked `yes` without video; row 131 "recurring" read as membership visits.
- **Photo resize:** the 4 MB reasoning and the fallback paths.

## 13. Docs

`page-tech` (forms card and page, site page, photo quality, required-form blocker), `page-settings`
(Forms tab and builder), `page-requests` (Forms section, reopen), `page-customers` (erase now covers
form answers and job photos), `admin-pages` if a shared primitive is added, `replica/features.csv` rows
122/125/126/131, `replica/parity.md`, `replica/build-log.md`, `replica/architecture.md` annotation (video
cut, office-only reopen), memory.
