# Replica M3d: Forms + site view

Status: v2 (2026-11-07) after adversarial review round 1 (3 critics; log in
`docs/superpowers/specs/2026-11-07-replica-m3d-review-log.md`). Owner: Raymond Chen.
Milestone source: `replica/architecture.md` build order "M3d Forms + site view" (line 609) and the F04
ownership rule (lines 156–159). Builds on M3a (ownership), M3b (idempotency keys) and M3c (field
preambles, intents storage, equipment).

## 1. Goal

The office builds a checklist under Settings. On site, every technician working a visit sees the forms
that apply to the job near the top of the job page, fills one in, and the answers are saved on the
server as they type, so a reload (or a second phone) shows the draft. Submitting locks it. The office
sees the answers on the request's detail sheet, and erasing the customer removes them. A Site page shows
what the technician should know about this address: the earlier jobs there, the open estimates and,
when the customer has one address, the membership and its next maintenance visit. Photos get a quality
setting, are resized on the phone, and the Photos card also takes PDF files.

Done when (architecture.md): an admin creates a checklist, the tech fills half, reloads, sees the draft,
submits; the submission shows on the admin job and is anonymised by erase; the location tab lists past
jobs, open estimates and the membership.

Feature rows (`replica/features.csv`, row = file line):
- **125** Job forms and checklists (must) → `yes`.
- **131** Location info tab: history / opportunities / recurring (must) → `yes` (history = past jobs at
  this address; opportunities = open estimates on them; recurring = the membership and its upcoming
  maintenance visits, shown when the customer has one address, §7.3).
- **122** Photos / video / files on job with quality setting (must) → `yes`, note "photos with a quality
  setting + PDF files; no video". **Video is cut** (§10). Read as needing video, the row stays `partial`;
  architecture.md scoped it as "122 (photos/files)".
- **126** Required forms block close-out (should) → `no`, note "forms can be marked Required; the Forms
  card and the close-out sheet remind, nothing blocks (deferred, lead ruling: it would change the M3a
  close-out batch)".
- Not touched: 127 (non-job and PDF-overlay forms, could), 124 (offline mode, must).

## 2. Surfaces

| surface | who | what |
| --- | --- | --- |
| Settings → `Forms` tab (`/admin/settings?tab=forms`; `forms` added to `SETTINGS_TABS` after `job-types`, `src/lib/admin/settings-tabs.ts`) | admin | the org's forms: name, `N questions`, applies to (`All requests` or job type names), `Required` chip, `Archived` chip, last changed. `New form` |
| Form builder `/admin/settings/forms/[id]` | admin | §7.1 |
| Request detail sheet, `Forms` section after `Visits` (`request-detail-sheet.tsx` mounts `request-forms-section.tsx`) | admin | every submission of the request, newest visit first: form name, `Visit #N`, `Draft` / `Submitted` / `Answers removed`, who and when; expands to questions and answers from the submission's own snapshot (readings outside the usual range carry the same note as on the phone). Open request: "Not submitted yet: <name>" for required forms. `Reopen` on a submitted one (§5.5) |
| Job page `Forms` card, **directly after the summary** (before Site, Estimates, Time, Materials) | every technician who can read the job, native jobs | the forms for the card's visit (§7.2). Rows link to the fill page. `Add a form` when the caller can write |
| Fill page `/tech/jobs/[id]/forms/[formId]?visit=<appointment id>` | readers see it; technicians with a non-cancelled assignment on that visit fill it | §7.2 |
| Close-out sheet (`close-out-sheet.tsx`) | the lead, when they tap Close out | a non-blocking reminder: one `h-11` link "Fill in “<name>”" per required form not submitted on any visit (§7.2). Blockers and the close-out write are unchanged |
| Job page `Site` card (after Forms) and Site page `/tech/jobs/[id]/site` | every technician who can read the job (native or synced) | §7.3 |
| Job page `Photos` card | as today (any reader; late uploads allowed) | quality setting, client resize, retry, `Add file` for PDFs (§7.4) |

Row 131's "tab" is the Site page reached from the job page (the M3c estimate-page pattern); the 718-line
job client (`tech-job-detail-client.tsx`) is not restructured into tabs.

## 3. Data model

Migration `drizzle/0058_m3d_forms.sql` (hand-authored, idempotent: `CREATE TABLE IF NOT EXISTS`, one `DO
$$ … EXCEPTION WHEN duplicate_object` block per constraint, `CREATE [UNIQUE] INDEX IF NOT EXISTS`,
`--> statement-breakpoint` between statements). `_journal.json` entry `idx 58`, tag `0058_m3d_forms`, a
fresh `when`. schema.ts has no expression index and no array column today, so the snapshot is not
hand-edited: run `drizzle-kit generate` from the new schema.ts into a scratch `--out`, take its JSON as
`meta/0058_snapshot.json` (new `id`, `prevId` = 0057's id), hand-author only the SQL to match it; then
`drizzle-kit generate` must report "No schema changes". 0057 is the latest on main; no branch carries a
0058; re-check when writing. Declared in `src/lib/db/schema.ts` with `check()` for every CHECK below; the
name index as `uniqueIndex(…).on(t.organizationId, sql\`lower(${t.name})\`).where(sql\`${t.active}\`)`,
the array default as `sql\`'{}'::uuid[]\``.

### 3.1 `forms`

| column | type | notes |
| --- | --- | --- |
| `id` | uuid PK | `officeId("form", org, clientToken)` (§4.1) |
| `organization_id` | uuid NOT NULL → organizations ON DELETE CASCADE | |
| `name` | text NOT NULL | 1–80, trimmed |
| `description` | text NULL | ≤ 300; shown above the questions |
| `fields` | jsonb NOT NULL DEFAULT `'[]'` | the flat field list (§3.3); CHECK `jsonb_typeof(fields) = 'array'` |
| `job_type_ids` | uuid[] NOT NULL DEFAULT `'{}'` | empty = all requests; else `job_types` ids (no FK on elements; the writer validates them, readers intersect) |
| `required` | boolean NOT NULL DEFAULT false | shown as `Required` and in the close-out reminder; blocks nothing (row 126 deferred) |
| `active` | boolean NOT NULL DEFAULT true | archive, never delete (§5.6) |
| `version` | integer NOT NULL DEFAULT 1 | CAS token and snapshot version, +1 per PATCH (the `appointments.version` CAS, `schema.ts:713`, which defaults to 0) |
| `created_by` | uuid NULL → users ON DELETE SET NULL | |
| `created_at`, `updated_at` | timestamptz NOT NULL DEFAULT now() | |

Indexes: `forms_org_active_idx (organization_id, active)`; `forms_org_name_active_unique` UNIQUE on
`(organization_id, lower(name)) WHERE active`.

### 3.2 `form_submissions`

| column | type | notes |
| --- | --- | --- |
| `id` | uuid PK DEFAULT gen_random_uuid() | creation is idempotent by the natural key below |
| `organization_id` | uuid NOT NULL → organizations ON DELETE CASCADE | |
| `form_id` | uuid NOT NULL → forms (NO ACTION: forms are never deleted; an org purge is one `DELETE FROM organizations` and NO ACTION allows both sides to go in one cascade) | |
| `service_request_id` | uuid NOT NULL → service_requests ON DELETE CASCADE | the session delete (`conversation-queries.ts:686`) hard-deletes requests |
| `appointment_id` | uuid NOT NULL → appointments ON DELETE CASCADE | the visit |
| `form_name`, `form_version`, `fields` | text / integer / jsonb NOT NULL | snapshot at row creation; `fields` CHECK array |
| `values_encrypted` | text NULL | `encrypt(JSON.stringify(values))` (`crypto.ts:30`); NULL = nothing answered yet, or erased |
| `status` | text NOT NULL DEFAULT `'draft'` | CHECK `status IN ('draft','submitted')` |
| `revision` | integer NOT NULL DEFAULT 0 | +1 per values write, submit and reopen; CHECK `revision >= 0` |
| `submit_key` | uuid NULL | `derivedId(scope, "form-submit")` of the submit that landed (§5.3) |
| `started_by`, `updated_by`, `submitted_by` | uuid NULL → users ON DELETE SET NULL | technician ids, not customer data |
| `submitted_at` | timestamptz NULL | CHECK `(status = 'submitted') = (submitted_at IS NOT NULL)` |
| `erased_at` | timestamptz NULL | set by customer erasure |
| `created_at`, `updated_at` | timestamptz NOT NULL DEFAULT now() | |

Indexes: `form_submissions_visit_form_unique` UNIQUE `(service_request_id, appointment_id, form_id)`;
`form_submissions_org_request_idx (organization_id, service_request_id)`; `form_submissions_form_idx
(form_id)`.

### 3.3 Field definitions (`src/lib/forms/form-schema.ts`, pure, zod, shared by server and both clients)

A flat list (no sections table, no nesting, no conditional logic). Each field: `{ id, type, label
(1–120), help? (≤ 200), required (boolean) }` plus per type:

| type | in | value | extra definition | why |
| --- | --- | --- | --- | --- |
| `checkbox` | yes | `true` (unticked = absent) | — | the checklist item; required = must be ticked |
| `yes_no` | yes | `'yes'` \| `'no'` \| `'na'` | `allowNa?` adds an `N/A` button | pass / fail; N/A so a required item that doesn't fit this system is never falsified |
| `short_text` | yes | string 1–200 | — | model, filter size |
| `long_text` | yes | string 1–2000 | ≤ 10 per form | findings |
| `number` | yes | finite, \|x\| ≤ 1,000,000, ≤ 3 decimals | `unit?` (≤ 12), `usualMin?`, `usualMax?` (min ≤ max) | the "reading" type. The usual range is **advice only**: an outside reading saves and submits with the note "Outside the usual range (5–15 °F)", because that reading is the fault being recorded |
| `choice` | yes | one option id | `options: [{ id, label 1–60 }]` 2–12, labels unique case-insensitively | filter condition |
| `heading` | yes | none (never required) | — | a section title inside the flat list |
| `photo`, `signature` | **no** | | | dev has no R2, uploads aren't keyed, a photo answer needs its own erase path; the job's Photos card and drawn signature exist. Builder hint: "Need a photo? Ask technicians to add it in the job's Photos card." |
| multi-select, date, calculated, conditional, per-field notes | **no** | | | scope; a note is a `short_text` |

`id` = `f_` + 10 × `[a-z0-9]`, minted when the field is added, kept across label or setting changes;
unique within the form. Limits: 1–60 fields with at least one non-`heading`; ≤ 10 `long_text`;
definition ≤ 64 KB. Values `{ [fieldId]: value }` (unanswered = key absent) ≤ 128 KB measured in UTF-8
bytes (`Buffer.byteLength`), which every valid form fits (10 × 2000 + 50 × 200 characters at 4 bytes).

Validation (`src/lib/forms/form-values.ts`, pure):
- **draft** (`draftValueOk(field, value)`): each key is a non-heading field id of the snapshot, the
  value has the field's type and parses (number limits above; choice id exists; text within length).
  No required check, no range check. The client sends only values that pass (`draftSafeValues`); a
  half-typed number ("12.", "-") stays in its input and is simply not saved yet. A draft is never
  refused for its content in normal use: a 400 on a draft means a client bug.
- **submit**: draft rules plus `missingRequired(fields, values)` (required fields without a value) →
  400 `FORM_INCOMPLETE` `details: { fieldIds }`. Nothing else is checked.
- Error `details` are `{ fieldIds }` or `{ path }` only, never zod messages, so no stored idempotency
  body holds answer text.

Why not `custom_field_definitions` (`schema.ts:1750`): one plaintext current value per entity, with no
visit, snapshot or draft state.

## 4. Ids, idempotency and versioning

### 4.1 Office writes
`POST /api/admin/settings/forms` takes `{ clientToken: uuid, name }`; id = `officeId("form", org,
clientToken)` (`idempotency.ts:89`, its `kind` union gains `"form"`), `ON CONFLICT (id) DO NOTHING` →
201 / 200 replay (M3b §8). Edits are `PATCH` with `{ version }`: `UPDATE forms SET …, version = version +
1, updated_at = now() WHERE id = $id AND organization_id = $org AND version = $v RETURNING version`. Zero
rows → missing → 404, else 409 `STALE` "Someone else changed this form. Reload to see their changes." A
name collision (`isUniqueViolation(err, "forms_org_name_active_unique")`) → 409 `NAME_TAKEN` "A form with
this name already exists." (also on restoring an archived form whose name is now taken).

### 4.2 Draft autosave: revision gate, no key
The values are one AES ciphertext per submission, so two technicians' answers can't be merged in SQL and
neon-http has no interactive read-merge-write; a plain last-write-wins would silently drop the other
technician's answers. So every draft PUT carries `baseRevision` (the revision the page last loaded or
saved; 0 when no row exists) and `formVersion`, and lands only when `revision = baseRevision`. Anything
else answers 409 `STALE` `{ revision }`; the page re-reads and merges (§7.2) and saves again. No
idempotency key and no save token: a retry whose first attempt actually landed gets `STALE` against its
own write, the merge keeps every field the technician changed (all of them equal the server's), finds no
foreign change, shows nothing and saves once more. Keying autosave would add an `idempotency_keys` row per
burst, and the reducer's "re-send the old body first" rule fights autosave, where the newest values
replace older ones.

### 4.3 Submit: keyed
`POST …/forms/[formId]/submit` carries an `Idempotency-Key` through `withIdempotency` (`idempotency.ts:210`).
The client intent `form:submit:<formId>:<appointmentId>` lives in the existing `ESTIMATE_INTENTS_KEY(rid)`
(`tech:estimate:<rid>:intents`), as equipment intents already do, so `recoverEstimateIntents`
(`recover-intents.ts:15`) re-sends it on mount with a `form:submit:` match and no new code; the fill page
stays locked until it is answered, and autosave is paused while it is `sent` or `unknown`. The intent is
removed on a definitive answer.
- `STORED_CODES` (`idempotency-codes.ts:13`) gains `FORM_SUBMITTED`, `FORM_INCOMPLETE`, `FORM_LOCKED`
  (`INVALID_INPUT` is already stored).
- Not stored: `STALE`, `FORM_CHANGED`, `FORM_ARCHIVED`, `NOT_ASSIGNED`, `NOT_ON_SITE`, `JOB_CLOSED`,
  `MANAGED_EXTERNALLY`, `NOT_FOUND`.

### 4.4 Versioning
A submission renders from its own `fields` / `form_name` / `form_version` forever. The snapshot is taken
when the row is created (first draft save, or a submit with no draft); before that the GET shows the live
form. The gap is closed by `formVersion`: the INSERT copies the live form only `WHERE f.version =
$formVersion`, and the values UPDATE requires `form_version = $formVersion`; a miss answers 409
`FORM_CHANGED` "The office changed this form. Check your answers." The page refetches and keeps each
answer that still passes `draftValueOk` against the new field (`carryValues`, pure: removed fields,
changed types and removed choice options drop). A row is never re-snapshotted: a draft started on
version 2 stays on version 2 after the office saves version 3.

## 5. Writers (`src/lib/tech/form-writes.ts`, `src/lib/admin/form-queries.ts`)

Shared SQL (rendered and tested with `PgDialect`):
- `visitGateSql(org, rid, aid, me)` = `EXISTS (SELECT 1 FROM appointments p JOIN appointment_assignments
  a ON a.appointment_id = p.id WHERE p.id = $aid AND p.service_request_id = $rid AND p.organization_id =
  $org AND a.organization_id = $org AND p.cancelled_at IS NULL AND a.technician_id = $me AND a.status <>
  'cancelled')` — the per-visit form of M3c `onJobSql` (`equipment-writes.ts:28`).
- `requestGateSql(org, rid)` = the request is in `$org`, native (`fieldpulse_job_id IS NULL AND
  hcp_job_id IS NULL`), status in `BILL_STATUSES` (`arrived`, `in_progress`, `on_hold`, `completed`;
  `field-sale-statuses.ts`), and its customer is not erased (`NOT EXISTS (customers c WHERE c.id =
  r.customer_id AND c.anonymized_at IS NOT NULL)`, `schema.ts:894`).
- `formAppliesSql(f, r)` = `(cardinality(f.job_type_ids) = 0 OR r.job_type_id = ANY(f.job_type_ids))`;
  a NULL `job_type_id` (`schema.ts:531`) gets only all-requests forms.

### 5.1 Who may fill, and when
F04: technicians write "notes, photos, materials and forms on jobs they can read". Narrowed: a form is
written by any technician, lead or helper, holding a non-cancelled assignment on **that visit**
(`NOT_ASSIGNED` otherwise); readers of the job see every submission read-only. Request status `arrived` …
`completed` (late completion is legitimate, as for equipment); `cancelled` → `JOB_CLOSED`; earlier →
`NOT_ON_SITE`. Native jobs only (F04); synced jobs answer 409 `MANAGED_EXTERNALLY` and the card reads
"Managed in FieldPulse". So in an org whose requests are all pushed to FieldPulse, forms (like
estimates, invoices and equipment) do not appear.

### 5.2 Save draft (`saveFormDraft`)
Input `{ appointmentId, formVersion, baseRevision, values }`. Pre-read the row by natural key. If it
exists: `formVersion ≠ row.form_version` → `FORM_CHANGED`; the stored blob must decrypt (else 409
`FORM_LOCKED`: an unreadable answer set is never overwritten); validate (draft) against its snapshot.
If not: read the form with `organization_id = $org` (missing → 404; `active = false` → 409
`FORM_ARCHIVED`; `version ≠ formVersion` → `FORM_CHANGED`) and validate against its live fields.
Encrypt. One batch:
1. `INSERT INTO form_submissions (organization_id, form_id, service_request_id, appointment_id,
   form_name, form_version, fields, started_by) SELECT … FROM forms f JOIN service_requests r ON r.id =
   $rid WHERE f.id = $form AND f.organization_id = $org AND f.active AND f.version = $formVersion AND
   requestGate AND visitGate ON CONFLICT (service_request_id, appointment_id, form_id) DO NOTHING`.
2. `UPDATE form_submissions SET values_encrypted = $enc, revision = revision + 1, updated_by = $me,
   updated_at = now() WHERE organization_id = $org AND (natural key) AND status = 'draft' AND erased_at
   IS NULL AND revision = $baseRevision AND form_version = $formVersion AND requestGate AND visitGate
   RETURNING revision`.
3. Tail `SELECT status, revision, form_version, erased_at` of the row.
Zero rows from 2 → in order: no row → re-run the gates as reads → `NOT_ASSIGNED` / `NOT_ON_SITE` /
`JOB_CLOSED` / `MANAGED_EXTERNALLY` / `FORM_LOCKED` (customer erased) / `FORM_ARCHIVED` / `FORM_CHANGED` /
404; `erased_at` set → `FORM_LOCKED` "This form can't be changed."; `submitted` → 409 `FORM_SUBMITTED`
"This form was already submitted."; `form_version ≠ formVersion` → `FORM_CHANGED`; else `STALE` `{
revision }`. Success → 200 `{ submissionId, revision, savedAt }` (201 when step 1 inserted). No audit.

**Archived forms, one rule:** an archived form can't be STARTED (step 1's `f.active`, the pre-read's
`FORM_ARCHIVED`, the GET's 409). A row that already exists keeps working from its snapshot: step 2 never
looks at `forms.active`, so a draft of a form archived later still saves and submits. An active form that
doesn't apply to the job type can be started from `Add a form` (§7.2); applicability only decides what is
listed.

### 5.3 Submit (`submitForm`)
Input `{ appointmentId, formVersion, baseRevision, values }`, keyed. Same pre-read, submit validation
(`FORM_INCOMPLETE`), same batch with step 2 also setting `status = 'submitted', submitted_by = $me,
submitted_at = now(), submit_key = derivedId(scope, "form-submit")` (`idempotency.ts:81`). `baseRevision
= 0` with no row submits in one go. Zero rows → first, `status = 'submitted' AND submit_key = this
derived id` → success (a takeover re-run of this same submit after its batch committed; M3b's derived-id
rule): 200 with the row's revision and `submitted_at`, and the audit row written if none exists for the
submission; then the §5.2 map, with `submitted` → stored `FORM_SUBMITTED`. Success → 200 `{ submissionId,
revision, submittedAt }`; audit `form_submitted` (entity `form_submissions`, details `{ formId,
appointmentId, formVersion }`), never on a replay.

### 5.4 Erasure (`anonymizeCustomer`, `erasure-queries.ts:124`)
- **Answers:** one statement in its batch: `UPDATE form_submissions SET values_encrypted = NULL,
  erased_at = now(), updated_at = now() WHERE organization_id = $org AND service_request_id IN (SELECT id
  FROM service_requests WHERE organization_id = $org AND customer_id = $cust)` (an in-batch subquery, like
  its appointments scrub, so a request linked after the pre-read is covered). Status, who and when are
  kept; the snapshot holds only org-authored labels. The admin section reads "Answers removed". New rows
  on the erased customer's requests are refused by `requestGateSql` (`FORM_LOCKED`), so answers can't be
  collected after an erase.
- **Attachments:** today `attachmentMatch` (`:181`) is `customer_id = X OR session_id IN sessions`, but
  `addJobPhoto` (`field-queries.ts:595`) writes only `service_request_id`, and the office uploader
  (`api/admin/attachments/route.ts`) writes request files with only `serviceRequestId` and equipment files
  with only `equipmentId`. All three survive erase today. `attachmentMatch` gains `service_request_id IN
  (the customer's requests)` (technician photos and PDFs **and the office's request documents**) and
  `equipment_id IN (SELECT id FROM customer_equipment WHERE organization_id = $org AND customer_id =
  $cust)` (data-plate and house photos on the customer's units; the de-identified unit rows stay). The
  batch's attachments DELETE (still first, before the messages it references) becomes `.returning({
  storageKey })`; the R2 delete in `after()` takes those returned keys plus the signature keys, and the
  attachments pre-read is dropped, so a photo inserted between a pre-read and the batch can't lose its
  row and keep its object. `attachmentsDeleted` in the `customer_erased` audit counts the returned rows.
- `deleteCustomer` (`crm-queries.ts:1111`) is unchanged: delete detaches (`customer_id` nulled, "the
  request/conversation history survives", `:1096-1103`), so answers stay with the request like its notes
  and photos. Erasure is the PII path.
- Org purge cascades both tables.

### 5.5 Office reopen (`reopenSubmission`)
`POST /api/admin/requests/[id]/forms/[submissionId]/reopen` `{ revision }`: `UPDATE form_submissions SET
status = 'draft', submitted_at = NULL, submitted_by = NULL, submit_key = NULL, revision = revision + 1,
updated_at = now() WHERE id = $sid AND organization_id = $org AND service_request_id = $rid AND status =
'submitted' AND erased_at IS NULL AND revision = $revision RETURNING revision`. Zero rows → missing → 404;
already a draft → 200 `{ changed: false }`; erased → 409 `FORM_LOCKED`; else 409 `STALE`. Audit
`form_reopened` `{ formId, appointmentId }`. The only correction path (the office doesn't edit answers).

### 5.6 Office form writes
`createForm` (§4.1; ≤ 100 forms per org including archived → 409 `LIMIT_REACHED` "You've reached the
limit of 100 forms."); `updateForm` (PATCH; `fields` replaced whole and validated by
`formDefinitionSchema`; `jobTypeIds` all the org's → else 400 `UNKNOWN_JOB_TYPE` "One of those job types
no longer exists."). Audit, ids and enums only: `form_created` `{ formId }`, `form_updated` `{ formId,
version, fieldCount }`, `form_archived` / `form_restored` `{ formId, version }`.

## 6. Routes (all `force-dynamic`)

Tech writes use `techFormPreamble` = `techEquipmentPreamble`'s gates (`invoice-route-guards.ts:89`) with
`FORM_PREAMBLE = { bucket: "form", statuses: BILL_STATUSES, beforeCopy: "Arrive at the job first.",
closedCopy: "This job is closed." }`, plus `isUuid` on the form id (front gates check only the request
id), then the body's `appointmentId` checked against the same `findTechAssignments` rows (`r.appointmentId
=== appointmentId && r.status !== 'cancelled'`) → else 403 `NOT_ASSIGNED` "Only a technician on this visit
can fill in its forms."; submit then reads the key. Writers re-check status and visit inside the batch.

| route | gate | body | success |
| --- | --- | --- | --- |
| `GET /api/tech/jobs/[id]/forms?visit=<aid>` | session, readable job, native (409), `visit` a non-cancelled visit of the request (else 404), rate `tech:form:read:<user>` (`adminRead`) | — | `{ visitId, visitNumber, canWrite, forms: [{ formId, name, description, required, submission: { id, status, revision, updatedAt, submittedAt, submittedByName } \| null, submittedOn: { appointmentId, appointmentNumber, submittedAt } \| null }], otherForms: [{ formId, name }] }`. `forms` = active applicable forms plus any form with a submission on this visit. `submittedOn` = the newest submitted copy on another non-cancelled visit, when this visit has none. Order: required and not submitted anywhere first, then name. `otherForms` = active forms not in `forms` |
| `GET /api/tech/jobs/[id]/forms/[formId]?visit=<aid>` | same; the form read with `organization_id = $org` (another org's id → 404) | — | `{ form: { name, description, version, fields }` (snapshot when a row exists, else live; archived with no row → 409 `FORM_ARCHIVED`) `, submission: { id, status, revision, values, updatedAt, updatedByName, submittedAt, submittedByName, erased } \| null, submittedOn, canWrite, writeBlockedReason }`. An undecryptable blob → `values: null`, `canWrite: false`, `writeBlockedReason: 'unreadable'` |
| `PUT /api/tech/jobs/[id]/forms/[formId]/draft` | `techFormPreamble`, no key | §5.2 | 201/200 `{ submissionId, revision, savedAt }` |
| `POST /api/tech/jobs/[id]/forms/[formId]/submit` | `techFormPreamble` + key | §5.3 | 200 `{ submissionId, revision, submittedAt }` |
| `GET /api/tech/jobs/[id]/site` | session, `isUuid`, readable job (native or synced; read-only), rate `tech:site:read:<user>` | — | §7.3 |
| `GET /api/admin/settings/forms` | admin session, `adminRead` | — | `{ forms: [{ id, name, fieldCount, jobTypeIds, required, active, version, updatedAt, submissionCount }] }` |
| `POST /api/admin/settings/forms` | admin session, `adminMutation` | `{ clientToken, name }` | 201/200 `{ id }` |
| `GET /api/admin/settings/forms/[id]` | admin session, `isUuid` | — | the full form |
| `PATCH /api/admin/settings/forms/[id]` | admin session, `isUuid`, `adminMutation` | `{ version, name?, description?, jobTypeIds?, required?, fields?, active? }` | `{ version }` |
| `GET /api/admin/requests/[id]/forms` | admin session, `isUuid`, request in org (404) | — | `{ submissions: [{ id, formId, formName, formVersion, appointmentId, appointmentNumber, status, revision, erased, fields, values, updatedAt, updatedByName, submittedAt, submittedByName }], missingRequired: [{ formId, name }] }` (`missingRequired` only for a native request not completed/cancelled) |
| `POST /api/admin/requests/[id]/forms/[sid]/reopen` | admin session, `isUuid` ×2, `adminMutation` | `{ revision }` | `{ revision, changed }` |

Admin routes follow the job-types routes (`api/admin/settings/job-types/route.ts`): `getAdminSession`,
rate key `admin:forms-<op>:<user>`, `readJsonBody`, `VALIDATION_ERROR` with `details.path` through
`settingsFieldErrorCopy`. Logs carry codes and ids only (`logger.error({ code, submissionId }, …)`).

## 7. Client

Tech conventions (base shadcn primitives, `h-11` targets, sentence case, human errors,
`MAY_NOT_HAVE_SAVED` for unknown writes). Admin conventions (admin-ui primitives, `SectionCard`, admin
canon "request").

### 7.1 Form builder (`/admin/settings/forms/[id]`, `src/components/admin/settings/form-builder.tsx`)
- Header: name, description, `Applies to` (`All requests` / `Some job types` + a checkbox list from `GET
  /api/admin/settings/job-types?active=1`; none → "No job types yet. Add them on the Job types tab."),
  `Required` switch with "Technicians see this form as Required and are reminded before closing out.
  Nothing is blocked."
- Questions, one row each: type select (`Checkbox`, `Yes / no`, `Short answer`, `Long answer`, `Number`,
  `Choice`, `Heading`), label, help, `Required` (hidden for `Heading`), `Allow N/A` for `Yes / no` with
  "Use N/A for items that don't apply to every system.", for `Number` a `Unit` input with a datalist
  (`psi`, `°F`, `A`, `V`, `µF`, `inWC`, `microns`, `CFM`) and `Usual range` from/to with "Readings
  outside it are still saved, with a note.", an options editor for `Choice` (2–12). `Move up` / `Move
  down`, `Add question below`, `Remove` with a 5-second `Undo`. `Add question` at the end.
- Pure helpers (`src/lib/admin/form-builder.ts`): `addField(at)`, `moveField`, `removeField`,
  `changeType` (keeps label/help/required), `newFieldId`, `builderErrors(fields)` → inline row copy.
- `Save` when dirty and valid, with `version`; `STALE` keeps the draft with `Reload`; any other failure
  "Couldn't save the form. Please try again." When submissions exist: "Forms already started keep the
  earlier version." `useUnsavedChangesGuard` (`use-unsaved-changes-guard.ts:21`) while dirty; the builder
  renders the leave confirm itself from `pendingHref` / `stay` / `leave`, as `settings/page.tsx` does;
  browser Back is not held. `Archive` / `Restore` (confirm "Archive this form? Technicians won't see it
  on new requests. Answers already given are kept."). `New form` asks for a name in a dialog (with
  `clientToken`), then opens the builder.

### 7.2 Forms card, fill page and reminder (`src/components/tech/forms/`)
- **Card visit:** `?visit=` if present, else `summary.assignment.appointmentId`, else
  `summary.activeVisitId` (the job summary, `field-queries.ts:154-161`, gains this already-computed
  field), else "No visit on this job yet." The card header names it when the job has several visits
  (`Visit #2`).
- **Card rows:** chips `Required`, `Not started`, `Draft`, `Submitted`, `Answers removed`; with no
  submission on this visit and `submittedOn` set → `Submitted on visit #1` instead of `Required` / `Not
  started` (sorted after outstanding ones). `Add a form` opens a sheet of `otherForms` (filter input above
  10).
- **Fill page header:** `Back to job`, form name, description. With `submittedOn`: "Submitted on visit
  #1 · Nov 6. Fill it in again only if this visit needs it." + `View visit #1's answers`.
- **Controls:** `checkbox` = 44 px row; `yes_no` = radio group `Yes` / `No` (/ `N/A`); texts =
  `Input` / `Textarea` with a count near the limit; `number` = `Input inputMode="decimal"` with the unit
  as a suffix and a `±` button (`h-11`; iOS's decimal pad has no minus), an outside-range note under it,
  a half-typed value left unsaved; `choice` = radio list; `heading` = sub-title + help. Required
  questions show `Required`.
- **Status line** in the header and repeated (`aria-live="polite"`) in the sticky footer beside `Submit
  form`: `Saving…`, `Saved · 2:41 PM`, `Not saved yet. Retrying…` (network, 5xx, 429), `Couldn't save your
  answers. Please try again.` (a 400: stops autosave; logged by code), `Submitted · Nov 7, 2:41 PM ·
  <technician name>`.
- **Autosave** (`nextSaveState`, pure): a change marks dirty; a save starts 1.5 s after the last change,
  on blur of a text field and on `visibilitychange` → hidden. One save in flight; a change during it
  queues one more; never more than one PUT per 3 s (≤ 20/min under the 30/min bucket); a 429 waits 10 s.
  `pagehide` sends a `fetch(…, { keepalive: true })` PUT only when no save is in flight and the body is
  under 60 KB; otherwise the last ≤ 1.5 s of edits can be lost when the tab closes (accepted; `hidden`
  usually flushed first). Server-only: nothing is kept in browser storage.
- **Merge** (`mergeDraft(base, mine, theirs)`, pure; `base` = the values of the last load or landed save,
  held in memory): a field the technician changed since `base` takes `mine`, every other field takes
  `theirs`. The merged values are rendered at once and saved on `theirs.revision`. When some field took a
  value different from `base` from `theirs`, the page shows once per load "Someone else changed this
  form. Their answers are shown, and yours are kept." (later merges only flash `Saved`). A retry of the
  technician's own landed write has no such field, so nothing shows. If `theirs` is submitted: read-only,
  "<name> submitted this form. Your last changes weren't saved." with the unsaved answers listed
  read-only ("Not saved: Suction pressure · 118 psi") so they can go in the on-site note.
- **Submit:** missing required → no request; each shows "Answer this." and the top line "2 required
  questions aren't answered." with focus on the first. Else confirm "Submit “<form name>”? After this,
  only the office can reopen it." `Submit` / `Go back`. Tapping Submit cancels the debounce, waits for an
  in-flight save, then sends with the latest revision; `Submitting…` locks the page. `STALE` or
  `FORM_CHANGED` on submit → merge (or carry), unlock, show the line, and require a new tap and confirm
  (a new body mints a new key). Stored `FORM_SUBMITTED` → refetch, submitted state. After success:
  read-only, status `Submitted · …`, primary `Back to job` (the job page refetches the card).
- **Read-only reasons** (`writeBlockedReason`): "Only a technician on this visit can fill in its forms." /
  "Arrive at the job first." / "This job is closed." / "This form was archived by the office." / "These
  answers can't be shown." (unreadable) / "These answers were removed." (erased).
- **Close-out reminder:** the job page passes the card's required forms with no submitted copy on any
  visit to `close-out-sheet.tsx`; above its confirm it lists "Not submitted yet:" and one link per form,
  "Fill in “Maintenance checklist”", to the fill page for the card's visit. The sheet's blockers, the
  close-out route and `status-writes.ts` are unchanged; the lead can still close out.

### 7.3 Site page (`/tech/jobs/[id]/site`, `src/lib/tech/site-queries.ts`)
Every query is anchored on the readable request (`findReadableJob`, `ownership.ts:134`): customer,
location and address come from `service_requests` server-side, never from the client; every table carries
`organization_id = $org`. **Never show the customer's jobs at another address.** Dev data (2026-11-07):
FieldPulse-synced requests 0/207 with `location_id`, native 16/94; `customer_locations` 16 rows, 4
customers with more than one. So the M3c location rule (which falls back to "all of the customer's rows"
and admits NULL-location rows) is not used here. Instead, **site match** (`siteScope`, pure decision + one
SQL read):
- Candidates: the customer's other requests (same org, same `customer_id`, not cancelled, newest 500),
  with `location_id` and decrypted `address_encrypted`, compared on `normalizeAddress` (today private in
  `src/lib/admin/location-queries.ts:15`, exported for this).
- `scope = 'location'` when the request has a `location_id`: candidates with that `location_id`, plus
  NULL-location candidates whose normalised address equals this request's. Heading "At this address".
- `scope = 'address'` when the request has no location but an address: candidates whose normalised
  address equals it. Heading "At this address".
- `scope = 'none'` when there is neither (or the customer is erased): empty, "This job has no saved
  address, so there's no site history." No customer → "No customer on this job yet. Ask the office to add
  one."
Address matching also stops an unsplit prod customer row (several FieldPulse customers sharing an AP
email, memory `customer-identity-program`) from showing one business's history to another: different
addresses don't match.

GET contract `{ scope, title, pastJobs, openEstimates, membership }`:
- `title`: the location's `label`, else "Service address". No address text, access notes or property
  type (the summary already shows this job's address and access notes).
- `pastJobs` (newest 20 matches, ordered by `COALESCE(completed_at, scheduled_date, created_at) DESC,
  id`): `{ id, referenceNumber, date, status, jobTypeName (job_types.name) or issueLabel(issue_type),
  leadTechnicianName (first name of the lead on the request's latest non-cancelled visit),
  submittedFormNames (≤ 3) }`. Synced jobs included (history lives there). Never `description`, notes,
  addresses, contact fields or signature names.
- `openEstimates`: `estimates` with `status = 'open'`, `expires_at` NULL or future, `service_request_id`
  = this request or a matched one. Estimates with no request are left out (their address is unknown).
  Row `{ id, label (estimateLabel, estimate-display.ts:20; FieldPulse: `title` or "Estimate"), createdAt,
  totalCents, optionCount, thisJob, fromFieldPulse }`; "Up to $X" when `optionCount > 1`.
- `membership`, **only when the customer has one known address** (≤ 1 `customer_locations` row and every
  candidate's normalised address equals this request's or is empty); otherwise `null` with the line
  "Membership is on the customer's account. Ask the office." Memberships belong to the customer, not a
  property, so at a landlord's second building "Member" would invite member pricing for a property the
  plan may not cover; with one address it can only mean this one. Shape: the active `customer_memberships`
  row (≤ 1, `schema.ts:3274`) with its plan → `{ planName, startedAt, currentPeriodEnd, visitsPerYear,
  upcoming }`, `upcoming` = up to 3 `membership_visits` with status `scheduled`/`generated` and `due_date
  >=` the start of today in the business timezone (`schema.ts:3323`). No price, billing or `benefits`.
  The AI tool readers (`getMembershipSummary`, `getNextVisit`, `src/lib/ai/account-tools.ts:92,140`) are
  not reused: their shapes serve the bot contract, and the tech page should not couple to it.
- Page: `Back to job`, title, `At this address` with `Past jobs` and `Open estimates`, then `Membership`
  (`Upcoming maintenance` inside). Rows are not links, except this job's open estimates for the lead (M3c
  page).
- Job page `Site` card: "4 past jobs · 1 open estimate · Member" (zero parts omitted; all zero → "No
  history at this address yet."; `scope: none` → "No saved address."), linking to the page; same GET.

### 7.4 Photos (`job-photos-card.tsx`)
Today: the card sends the raw file, clears the input, shows one `PHOTO_UPLOAD_FAILED` for every failure
and renders every row as `<img>` (an office PDF on the request shows broken); the route
(`api/tech/jobs/[id]/photo/route.ts`) allows jpeg/png/webp/heic/pdf by magic bytes up to 20 MB.
- One compact line under the buttons: "Quality: Standard · Change" → a choice `Standard` / `High`, "Standard
  saves data. High keeps more detail." Remembered on this phone in `localStorage` `tech:photo-quality`
  (try/catch; default `standard`; a per-viewer convenience, no answers).
- Before upload (`src/lib/tech/photo-resize.ts`: pure plan + thin browser adapter): load the file into an
  `HTMLImageElement` and `await img.decode()` (browsers apply EXIF orientation when drawing an `<img>`),
  draw it straight onto a canvas at the target size, encode JPEG. `standard` = longest edge 1600 px, q 0.8;
  `high` = 3200 px, q 0.9; never upscale; over `TECH_UPLOAD_LIMIT_BYTES` (new, 4 × 1024 × 1024, in that
  file) step down (q 0.8 → 0.7 → edge × 0.75) up to 3 times. Name `<stem>.jpg`, type `image/jpeg`.
  Re-encoding drops EXIF (GPS and capture time; `attachments.created_at` is the upload time).
- Decode failure → upload the original when ≤ 4 MB, else "This photo can't be prepared on this phone.
  Take it again, or use a smaller photo." Labels: `Preparing photo…`, `Uploading…`.
- The prepared blob stays in memory until the upload lands (a camera capture is not in the Camera Roll):
  failure → "Couldn't upload that photo." with `Try again` (same blob) and `Discard`. One upload at a time;
  the buttons are disabled while one runs.
- `Add file` (`accept="application/pdf"`): PDFs upload unchanged; over 4 MB → "This file is too large.
  The limit is 4 MB."; failure → `FILE_UPLOAD_FAILED` "Couldn't upload that file. Please try again.";
  success "File uploaded.". Non-image rows render as a file tile (icon + filename, opens the signed URL),
  which also fixes today's broken image for office PDFs.
- The tech photo route enforces `TECH_UPLOAD_LIMIT_BYTES` (400 `INVALID_INPUT` "This file is too large.
  The limit is 4 MB."), so server and client state the same limit, and gains `isUuid` on POST. Why 4 MB:
  Vercel Functions cap a request body at 4.5 MB (`FUNCTION_PAYLOAD_TOO_LARGE`, platform documentation;
  measure on a preview, §11); a full-size iPhone photo can exceed it today. No key on the photo POST (a
  double tap can still store two, as today).

## 8. Copy

| where | copy |
| --- | --- |
| Forms card | empty "No forms for this job." · chips `Required`, `Not started`, `Draft`, `Submitted`, `Submitted on visit #1`, `Answers removed` · "No visit on this job yet." · "Managed in FieldPulse" |
| Add a form | title "Add a form" · empty "No other forms." |
| Status line | `Saving…` · `Saved · 2:41 PM` · `Not saved yet. Retrying…` · `Couldn't save your answers. Please try again.` · `Submitted · Nov 7, 2:41 PM · Alex Rivera` |
| Unknown submit | `MAY_NOT_HAVE_SAVED` + `Try again` |
| Merge | "Someone else changed this form. Their answers are shown, and yours are kept." · "<name> submitted this form. Your last changes weren't saved." + "Not saved: <question> · <answer>" |
| Codes | FORM_CHANGED "The office changed this form. Check your answers." · FORM_SUBMITTED "This form was already submitted." · FORM_LOCKED "This form can't be changed." · FORM_ARCHIVED "This form was archived by the office." · NOT_ASSIGNED "Only a technician on this visit can fill in its forms." |
| Fill page | "Answer this." · "2 required questions aren't answered." · "Outside the usual range (5–15 °F)" · "Submitted on visit #1 · Nov 6. Fill it in again only if this visit needs it." · `View visit #1's answers` · `Back to job` |
| Confirm | "Submit “Maintenance checklist”? After this, only the office can reopen it." `Submit` / `Go back` |
| Close-out sheet | "Not submitted yet:" · "Fill in “Maintenance checklist”" |
| Office section | "Not submitted yet: Maintenance checklist" · "Answers removed" · `Reopen` (confirm "Reopen this form? The technician can change the answers and submit again.") · the usual-range note |
| Builder | `All requests` · "Technicians see this form as Required and are reminded before closing out. Nothing is blocked." · "Use N/A for items that don't apply to every system." · "Readings outside it are still saved, with a note." · "Need a photo? Ask technicians to add it in the job's Photos card." · "Forms already started keep the earlier version." · "Archive this form? Technicians won't see it on new requests. Answers already given are kept." · NAME_TAKEN "A form with this name already exists." · STALE "Someone else changed this form. Reload to see their changes." · "Couldn't save the form. Please try again." · rows "Add a label.", "Add at least two options.", "The low end must be below the high end." · "No job types yet. Add them on the Job types tab." |
| Site | card "4 past jobs · 1 open estimate · Member" · "No history at this address yet." · "No saved address." · page "At this address" · "No other jobs at this address." · "No open estimates." · "Not a member." · "Membership is on the customer's account. Ask the office." · "This job has no saved address, so there's no site history." · "No customer on this job yet. Ask the office to add one." · rows "Nov 3, 2026 · Maintenance · Completed · Alex" · "Estimate · Nov 6 · 2 options" "Up to $4,812.00" `This job` `From FieldPulse` · "Gold plan · Member since Mar 2026 · Renews Apr 1, 2027" · "2 visits a year" · "May 1, 2027 · Scheduled" |
| Photos | "Quality: Standard · Change" · "Standard saves data. High keeps more detail." · `Preparing photo…` · `Uploading…` · "Couldn't upload that photo." `Try again` `Discard` · "This photo can't be prepared on this phone. Take it again, or use a smaller photo." · `Add file` · "File uploaded." · "Couldn't upload that file. Please try again." · "This file is too large. The limit is 4 MB." |

Canon: request (admin) / technician / sign in / cancelled / Unicode … and “ ” / sentence case / no
`err.message` in UI. The technician app keeps "job", as it does today. Dates in the business timezone
(`BUSINESS_BASE_LOCATION.timezone`, as `job-display.ts:8` uses it).

## 9. Tests

No jsdom/RTL; component logic lives in pure helpers.

**Pure (vitest):** `formDefinitionSchema` (each type, ids, options, `allowNa`, unit, usual range order,
heading never required, 60-field / 10-long-text / 64 KB caps, one non-heading); `draftValueOk` and
`draftSafeValues` ("12.", "-", "-.", 4 decimals and > 1,000,000 left out; an out-of-usual-range number
kept; one bad field never blocks the others); `missingRequired` (`na` satisfies a required yes/no); the
128 KB UTF-8 cap with multibyte text; `carryValues` (removed field, type change, removed option dropped);
`mergeDraft` (mine-changed wins, untouched takes theirs, both changed → mine, own retry shows no foreign
change, foreign change flagged); `nextSaveState` (debounce, one in flight, queued follow-up, 3 s floor,
429 back-off, 400 stops, pause while a submit intent is sent/unknown, submit waits for the in-flight save,
`pagehide` skipped while in flight or over 60 KB); `±` parse; outside-range note copy; card visit pick and
chips incl. `Submitted on visit #N`; reminder list (required, not submitted on any visit);
`writeBlockedReason` → copy; builder helpers (`addField(at)`, `moveField` at edges, `removeField` + undo,
`changeType`, `newFieldId`, `builderErrors`); `formApplies`; `siteScope` (location / address / none,
NULL-location candidates matched by address only, another address never matched, single-address
membership test); site formatters; photo `resizePlan` (no upscale, both qualities, step-down, PDF
passthrough, limit) and `qualityFromStorage`; reason → code/copy maps.

**SQL renders (`PgDialect`):** each statement of the draft and submit batches carries `organization_id`
on each table; `visitGateSql` contains `a.appointment_id = p.id`; `requestGateSql` (native, statuses,
not anonymised); `formAppliesSql`; site queries' org predicates; the erase UPDATE's in-batch subquery; the
widened `attachmentMatch` (request, equipment) and its `RETURNING storage_key`.

**Route tests:** every gate and code of the tech and admin routes; 201/200 splits; own request + another
org's form id → 404; the stored `INVALID_INPUT` / `FORM_INCOMPLETE` envelopes contain no submitted
string; the site GET payload has no key like `phone`, `email`, `description`, `address`, `signature`;
the photo POST refuses over 4 MB and a non-UUID id; close-out routes and `status-writes.test.ts` pass
unchanged.

**Integration (`tests/integration/field-forms.test.ts`, `VITEST_INTEGRATION=1`, dev DB, throwaway org by
SQL; never the FieldPulse-connected default org):**
(a) `createForm` twice with one token → one row; stale PATCH → STALE; duplicate active name → NAME_TAKEN;
(b) done-when: 4 checkboxes (2 required) and a number with a usual range → a helper saves 2 answers and
an out-of-range reading (revision 1) → GET shows them → a save from revision 0 again (a lost-response
retry) → STALE `{ revision: 1 }` → the merged save lands as revision 2 with the same values → submit with
a required missing → FORM_INCOMPLETE → full submit → `submitted`; same key → replay; new key →
FORM_SUBMITTED; a draft save → FORM_SUBMITTED;
(c) submit takeover: run the batch, leave the key claimed and aged past the takeover window, re-send the
same key → 200, one `form_submitted` audit row;
(d) two technicians on one visit save from revision 0 concurrently → one 201, one STALE;
(e) office saves version 2 after a draft exists → the draft keeps version 1 and submits; a new visit
snapshots version 2; a save with `formVersion` 1 there → FORM_CHANGED;
(f) gates: technician only on visit #1 saving on #2 → NOT_ASSIGNED; cancelled visit → 404; another org's
technician → 404; synced request → MANAGED_EXTERNALLY; `pending` → NOT_ON_SITE; `cancelled` →
JOB_CLOSED; `completed` → allowed;
(g) archived: an existing draft still saves and submits; starting it on a new visit → FORM_ARCHIVED; GET
of it with no row → 409; an active non-applicable form can be started;
(h) erase: insert by SQL an attachment on the request and one on the customer's equipment; after
`anonymizeCustomer` → `values_encrypted` NULL, `erased_at` set, status kept, both attachment rows gone and
their keys handed to the storage cleanup (mocked); a later save → FORM_LOCKED; starting another form on
that request → FORM_LOCKED; admin GET shows `erased`; `deleteCustomer` on another customer leaves its
submissions intact;
(i) reopen → draft, revision +1; stale → STALE; on a draft → `changed: false`; the technician resubmits;
(j) an undecryptable blob (written by SQL) → GET `canWrite: false`, a save → FORM_LOCKED;
(k) site: the request with a location lists past jobs at that location and NULL-location ones with the
same address, never the customer's other location or another customer; a request without a location
matches by address; neither → `scope: 'none'`, empty; open estimates of matched requests only (expired,
sold, request-less excluded); membership shown for a single-address customer and `null` for a
two-location one; overdue scheduled visits not listed; another org never appears; a synced job is
readable;
(l) audit rows carry ids and enums only.

**Browser walk** (throwaway org via `createOrgCore`; admin, technician, helper, a customer with one
location, two past requests at it and one at another address, an open estimate, an active membership with
a scheduled visit, a native request with a job type and assignments, all by SQL; mint sessions with
`MINT_ORG_ID` and assert the token's user and org; queue guard before and zero `communication_jobs` after;
390×844): admin creates "Maintenance checklist" (4 checkboxes, a `psi` number with a usual range,
Required) → the job page shows Forms first with `Required` → Site lists 2 past jobs (not the other
address), the estimate and the membership → fill half incl. an out-of-range reading → `Saved` → reload →
the answers are there → the helper's session sees the same draft → lead taps Close out → the sheet lists
"Fill in “Maintenance checklist”" and closing out is still possible; follow the link instead → submit →
the admin sheet shows the answers with the range note → erase the customer → "Answers removed". Photo
upload can't run on dev (no R2): pure plan tests and a mocked route test; the quality line and resize are
checked on a real phone after deploy.

## 10. Out of scope

- Required forms blocking close-out (row 126, deferred), on any path.
- Video upload (row 122 note); photo, signature and file form fields.
- Conditional logic, calculated fields, multi-select, dates, per-field notes, sections as a model,
  template library, copying forms, drag-to-reorder, a builder preview.
- Non-job and PDF-overlay forms (row 127), portal forms, emailing or a PDF of a submission.
- Offline mode (row 124) and any browser copy of answers: drafts are server-only.
- Office editing of answers (the office reopens); reports over answers (one ciphertext per submission).
- Forms on FieldPulse/HCP-synced jobs.
- Keying the photo upload; server-side image processing; an upload queue.
- Site page: equipment, invoices, contact details, links into other jobs, request-less estimates,
  membership at multi-address customers, price or benefits.

## 11. Rulings and things not verified

Rulings (critics: attack them):
1. Drafts are server-only; autosave is a revision gate + in-memory `mergeDraft`, no key, no save token;
   submit is keyed with a derived `submit_key` for takeover re-runs.
2. Drafts never fail on content; usual range is advice; submit checks required + parse only.
3. One submission per visit per form, shared by the visit's technicians; per-visit write right.
4. Attach by job type plus technician-picked active forms; archived forms can't be started, existing
   rows continue.
5. Snapshot at row creation; `formVersion` guards the gap.
6. Locked after submit; only the office reopens.
7. Row 126 deferred: `Required` + close-out reminder only.
8. Erase nulls answers, refuses new ones, and deletes the request's and equipment's attachments by
   `DELETE … RETURNING`; delete-customer keeps answers.
9. Site page matches by location or normalised address, never the customer at large; membership only
   for single-address customers; read-only and allowed on synced jobs. Forms are native-only.
10. Photo quality per device; 4 MB cap on client and route; PDFs in, video out.

Verified during review: FieldPulse-synced requests carry no `location_id` or `job_type_id` on dev (0/207);
native 16/94 and 71/94. `useUnsavedChangesGuard` is self-contained (the caller renders the confirm).

Not verified (plan or deploy):
- The Vercel 4.5 MB body limit on this project's photo route: measure a 5 MB upload on a preview.
- iOS hands camera captures as JPEG with `accept="image/*"` (believed, not tested here); `img.decode()`
  memory on 48 MP captures on older iPhones.
- `normalizeAddress` quality on FieldPulse-imported address strings (unit numbers, abbreviations): a
  miss only hides history, never shows another address.

## 12. Review focus

- **Tenancy and ownership:** org predicates everywhere; the per-visit gate (with its join) in both
  batches; readers never write; the site match can't be steered to another customer or address.
- **Autosave:** the §5.2 zero-row map; the claim that an own-write retry merges to the same values with
  no banner; the `formVersion` race at first insert; submit waiting for the in-flight save; the `pagehide`
  loss window.
- **Submit idempotency:** stored codes deterministic for their body; `submit_key` takeover path and its
  audit.
- **Erasure:** in-batch subquery; new answers refused after erase; attachments by request and equipment
  with `RETURNING`; no answer in logs, audit or stored envelopes (server-side; the submit intent body sits
  in sessionStorage until answered, then is removed).
- **Site scope:** the location/address/none decision and the single-address membership rule.
- **Scope honesty:** 122 `yes` without video; 126 `no`; 131's "recurring" read as membership visits.

## 13. Docs

`page-tech` (Forms card and page, reminder, Site page, photo quality and retry), `page-settings` (Forms
tab and builder), `page-requests` (Forms section, reopen), `page-customers` (erase covers form answers,
request and equipment attachments), `replica/features.csv` rows 122/125/126/131, `replica/parity.md`,
`replica/build-log.md`, `replica/architecture.md` annotation (video cut, row 126 deferred, office-only
reopen), memory.
