# Replica M3d: Forms + site view

Status: v3 (2026-11-07) after adversarial review rounds 1–2 (5 critics; log in
`docs/superpowers/specs/2026-11-07-replica-m3d-review-log.md`). Owner: Raymond Chen.
Milestone source: `replica/architecture.md` build order "M3d Forms + site view" (line 609) and the F04
ownership rule (lines 156–159). Builds on M3a (ownership), M3b (idempotency keys) and M3c (field
preambles, L_req, intents storage, equipment).

## 1. Goal

The office builds a checklist under Settings. On site, every technician working a visit sees the forms
that apply to the job near the top of the job page (native or FieldPulse-synced), fills one in, and the
answers are saved on the server as they type, so a reload (or a second phone) shows the draft.
Submitting locks it. The office sees the answers on the request's detail sheet, and erasing the customer
removes them. A Site page shows what the technician should know about this address: the earlier jobs
there, the open estimates and, when the customer has exactly one address, the membership and its next
maintenance visit. Photos get a quality setting, are resized on the phone, and the Photos card also takes
PDF files.

Done when (architecture.md): an admin creates a checklist, the tech fills half, reloads, sees the draft,
submits; the submission shows on the admin job and is anonymised by erase; the location tab lists past
jobs, open estimates and the membership. Both a native and a synced job carry forms (§5.1).

Feature rows (`replica/features.csv`, row = file line):
- **125** Job forms and checklists (must) → `yes`.
- **131** Location info tab (must) → `yes`, note "history = past jobs at the same location or saved
  address; FieldPulse-synced jobs carry no address today, so their history is counted, not shown;
  opportunities = open estimates on those jobs; recurring = membership + upcoming visits for
  single-address customers". The lead may read this as `partial` until FieldPulse job addresses are
  imported.
- **122** Photos / video / files with quality setting (must) → `yes`, note "photos with a quality setting
  + PDF files; no video". **Video is cut** (§10); read as needing video the row stays `partial`.
- **126** Required forms block close-out (should) → `no`, note "forms can be marked Required; the Forms
  card, the close-out sheet and the office remind; nothing blocks (deferred: it would change the M3a
  close-out batch)".
- Not touched: 127 (non-job and PDF-overlay forms), 124 (offline mode).

## 2. Surfaces

| surface | who | what |
| --- | --- | --- |
| Settings → `Forms` tab (`/admin/settings?tab=forms`; `forms` added to `SETTINGS_TABS` after `job-types`, `settings-tabs.ts`) | admin | §7.1 list |
| Form builder `/admin/settings/forms/new` and `/admin/settings/forms/[id]` (`src/app/admin/(dashboard)/settings/forms/[id]/page.tsx`; `new` is the same page with no row) | admin | §7.1 |
| Request detail sheet, `Forms` section after `Visits` (`request-forms-section.tsx`) | admin | every submission of the request with answers, newest visit first; required forms not submitted; `Reopen` (§5.5, §7.5) |
| Job page `Forms` card, **directly after the summary** | every technician who can read the job, native or synced | §7.2 |
| Fill page `/tech/jobs/[id]/forms/[formId]?visit=<aid>` | readers see it; writers per §5.1 fill it | §7.3 |
| Close-out sheet (`close-out-sheet.tsx`, native jobs) | the lead | non-blocking reminder links (§7.4); blockers and the close-out write unchanged |
| Job page `Site` card (after Forms) and Site page `/tech/jobs/[id]/site` | every reader, native or synced | §7.6 |
| Job page `Photos` card | as today | §7.7 |

Row 131's "tab" is the Site page reached from the job page (the M3c estimate-page pattern); the job client
(`tech-job-detail-client.tsx`) is not restructured into tabs.

## 3. Data model

Migration `drizzle/0058_m3d_forms.sql`, hand-authored and idempotent (`CREATE TABLE IF NOT EXISTS`, one
`DO $$ … EXCEPTION WHEN duplicate_object` block per constraint, `CREATE [UNIQUE] INDEX IF NOT EXISTS`,
`--> statement-breakpoint` separators), journal `idx 58` with a fresh `when`. Procedure (schema.ts has no
expression index or array column to copy from): copy `drizzle/` into a scratch directory, run `drizzle-kit
generate` there against the new schema.ts, take its `0058_snapshot.json` (its `prevId` is 0057's id) and
diff the hand SQL against its generated SQL statement by statement (modulo the idempotency wrappers); then
in the repo `drizzle-kit generate` reports "No schema changes"; `npm run db:migrate` on the dev branch
before the integration suite and compare `pg_indexes` / `pg_constraint` for both tables; prod migrates in
the build. 0057 is the latest; no branch carries a 0058; re-check when writing. Every CHECK below is a
`check()` in schema.ts; the name index is `uniqueIndex(…).on(t.organizationId,
sql\`lower(${t.name})\`).where(sql\`${t.active}\`)`, the array default `sql\`'{}'::uuid[]\``.

### 3.1 `forms`

| column | type | notes |
| --- | --- | --- |
| `id` | uuid PK | `officeId("form", org, clientToken)` (§4.1) |
| `organization_id` | uuid NOT NULL → organizations ON DELETE CASCADE | |
| `name` | text NOT NULL | 1–80, trimmed |
| `description` | text NULL | ≤ 300 |
| `fields` | jsonb NOT NULL | §3.3; CHECK `jsonb_typeof(fields) = 'array'`. A row exists only once a valid definition (≥ 1 non-heading question) was saved (§4.1), so no form without questions is ever listed |
| `job_type_ids` | uuid[] NOT NULL DEFAULT `'{}'` | empty = all requests; else `job_types` ids (validated by the writer, intersected by readers) |
| `required` | boolean NOT NULL DEFAULT false | the "Required form" flag; reminds, blocks nothing |
| `active` | boolean NOT NULL DEFAULT true | archive, never delete |
| `version` | integer NOT NULL DEFAULT 1 | CAS token and snapshot version, +1 per PATCH (the `appointments.version` CAS, `schema.ts:713`, which defaults to 0) |
| `created_by` | uuid NULL → users ON DELETE SET NULL | |
| `created_at`, `updated_at` | timestamptz NOT NULL DEFAULT now() | |

Indexes: `forms_org_active_idx (organization_id, active)`; `forms_org_name_active_unique` UNIQUE
`(organization_id, lower(name)) WHERE active`.

### 3.2 `form_submissions`

| column | type | notes |
| --- | --- | --- |
| `id` | uuid PK DEFAULT gen_random_uuid() | creation is idempotent by the natural key |
| `organization_id` | uuid NOT NULL → organizations ON DELETE CASCADE | |
| `form_id` | uuid NOT NULL → forms (NO ACTION; forms are never deleted; the org purge is one `DELETE FROM organizations`) | |
| `service_request_id` | uuid NOT NULL → service_requests ON DELETE CASCADE | session delete (`conversation-queries.ts:686`) hard-deletes requests |
| `appointment_id` | uuid NOT NULL → appointments ON DELETE CASCADE | the visit |
| `form_name`, `form_version`, `fields` | text / integer / jsonb NOT NULL | snapshot at row creation; `fields` CHECK array |
| `values_encrypted` | text NULL | `encrypt(JSON.stringify(values))` (`crypto.ts:30`); NULL = no answers yet, or erased |
| `status` | text NOT NULL DEFAULT `'draft'` | CHECK `IN ('draft','submitted')` |
| `revision` | integer NOT NULL DEFAULT 0 | +1 per write, submit, reopen; CHECK `>= 0` |
| `last_save_id` | uuid NULL | the client `saveId` of the last applied draft write (§4.2) |
| `submit_key` | uuid NULL | `derivedId(scope, "form-submit")` of the submit that landed (§5.3) |
| `started_by`, `updated_by`, `submitted_by` | uuid NULL → users ON DELETE SET NULL | technician ids |
| `submitted_at` | timestamptz NULL | CHECK `(status = 'submitted') = (submitted_at IS NOT NULL)` |
| `erased_at` | timestamptz NULL | set by customer erasure |
| `created_at`, `updated_at` | timestamptz NOT NULL DEFAULT now() | |

Indexes: `form_submissions_visit_form_unique` UNIQUE `(service_request_id, appointment_id, form_id)`;
`form_submissions_org_request_idx (organization_id, service_request_id)`; `form_submissions_form_idx`.

### 3.3 Field definitions (`src/lib/forms/form-schema.ts`, pure, zod, shared by server and both clients)

A flat list. Each field: `{ id, type, label (1–120), help? (≤ 200), required }` plus per type:

| type | in | value | extra definition | why |
| --- | --- | --- | --- | --- |
| `checkbox` | yes | `true` (unticked = absent) | — | checklist item; required = must be ticked |
| `yes_no` | yes | `'yes'` \| `'no'` \| `'na'` | `allowNa?` adds `N/A` | pass / fail; N/A so a non-applicable required item is never falsified |
| `short_text` | yes | string 1–200 | — | model, filter size |
| `long_text` | yes | string 1–2000 | ≤ 10 per form | findings |
| `number` | yes | finite, \|x\| ≤ 1,000,000, ≤ 3 decimals | `unit?` (≤ 12), `usualMin?`, `usualMax?` (min ≤ max) | readings; the usual range is advice only: an outside reading saves and submits with a note, because it is the fault being recorded |
| `choice` | yes | one option id | `options: [{ id, label 1–60 }]` 2–12, labels unique case-insensitively | filter condition |
| `heading` | yes | none; `required` always false | — | a section title |
| `photo`, `signature` | **no** | | | dev has no R2, uploads aren't keyed, a photo answer needs its own erase path; the job's Photos card and signature exist |
| multi-select, date, calculated, conditional, per-field notes | **no** | | | scope |

Ids: fields `f_` + 10 × `[a-z0-9]`, options `o_` + 8 × `[a-z0-9]`, minted on add, kept across relabels,
unique within the form. Limits: 1–60 fields with ≥ 1 non-heading; ≤ 10 `long_text`; definition ≤ 64 KB.
Text values: C0 control characters other than tab, LF and CR are refused (the client strips them on
input); lengths are UTF-16 code units (`maxLength`). The values document is capped at 128 KB **measured**
as UTF-8 bytes of `JSON.stringify(values)`; over it → 400 `INVALID_INPUT` `{ path: ["values"] }`, and the
client checks the same measure before sending ("This form is too long to save. Shorten the longest
answers.").

Validation (`src/lib/forms/form-values.ts`, pure):
- **`draftValueOk(field, value)`**: the key is a non-heading field id of the snapshot; the value has the
  field's type and parses (number limits; choice id exists; text within length, no controls). No required
  or range check. `null` is valid and means "cleared".
- **`numberInputState(raw)`** → `empty` | `partial` | `invalid` | `{ value }`. Thousands separators are
  stripped when the text matches `^-?\d{1,3}(,\d{3})+(\.\d+)?$` ("1,200" → 1200). `partial` = a prefix
  that could still become a number (`-`, `12.`, `-.`); `invalid` = anything else that doesn't parse (`1e3`,
  `12.3456`, `2000000`, letters).
- **submit**: every changed value passes `draftValueOk`, then `missingRequired(fields, values)` on the
  resulting document → 400 `FORM_INCOMPLETE` `{ fieldIds }`. Nothing else is checked.
- Error `details` are `{ fieldIds }` or `{ path }` only, never zod messages.

Why not `custom_field_definitions` (`schema.ts:1750`): one plaintext current value per entity, no visit,
snapshot or draft state.

## 4. Ids, idempotency, versioning, locking

### 4.1 Office writes
`New form` opens the builder unsaved; nothing is inserted until the first valid `Save`, which POSTs `{
clientToken, name, description, jobTypeIds, required, fields }` validated by `formDefinitionSchema`. id =
`officeId("form", org, clientToken)` (`idempotency.ts:89`, `kind` gains `"form"`), `ON CONFLICT (id) DO
NOTHING RETURNING id` → 201 / 200 replay (M3b §8; the token is minted when the builder opens). Edits are
`PATCH` with `{ version }`: `UPDATE forms SET …, version = version + 1, updated_at = now() WHERE id = $id
AND organization_id = $org AND version = $v RETURNING version`; zero rows → missing → 404, else 409
`STALE`. A name collision (`isUniqueViolation(err, "forms_org_name_active_unique")`) → 409 `NAME_TAKEN`
(also on restoring an archived form whose name is now taken).

### 4.2 Draft writes: changes + revision gate + save id, no key
The values are one AES ciphertext, so two technicians' answers can't be merged in SQL, and neon-http has
no interactive read-merge-write. A draft PUT therefore sends **changes**, not the document: `changes = {
[fieldId]: value | null }` holding every field the technician touched since the base (`null` = cleared),
with `baseRevision`, `formVersion` and `saveId` (a `mintKey()` uuid per write, reused by its retries).
The server decrypts the stored document, applies the changes, validates and re-encrypts, and the UPDATE
lands only when `revision = baseRevision` (so the document it changed is the one it read).
- **Retry:** a write whose result is unknown is re-sent with the same body and `saveId` before any newer
  write; newer edits wait. If it had landed, the row has `revision = baseRevision + 1 AND last_save_id =
  saveId` → 200 replay with that stored revision, no merge. (v2 claimed a merge resolves a retry cleanly;
  round 2 showed a revert in the lost-response window re-applies the old value — log R2.)
- **Anything else** → 409 `STALE` `{ revision }`: the page re-reads and merges (§7.3).
No idempotency key: autosave would add an `idempotency_keys` row per burst, and the key reducer's "re-send
the old body first" is what the save id rule above already does for this one route.

### 4.3 Submit: keyed
`POST …/forms/[formId]/submit` carries `{ appointmentId, formVersion, baseRevision, changes }` and an
`Idempotency-Key` through `withIdempotency` (`idempotency.ts:210`). The request hash is computed over `{
appointmentId, formVersion, baseRevision, changesMac: blindIndex(canonical(changes)) }` (HMAC with the
server key, `crypto.ts:92`), so `idempotency_keys.request_hash` can't be dictionary-attacked back to the
answers after an erase. Client intent `form:submit:<formId>:<appointmentId>` in `ESTIMATE_INTENTS_KEY(rid)`
(as equipment intents are) storing `{ base, body }`; the **fill page recovers its own intent** on mount
(not `recoverEstimateIntents`, which drops the intent on `STALE`): a 2xx or stored code removes it; `STALE`
/ `FORM_CHANGED` merge `body.changes` as `mine` over the re-read row (§7.3), show the merge line and require
a new Submit. Autosave is paused while it is `sent` or `unknown`.
- `STORED_CODES` gains `FORM_SUBMITTED`, `FORM_INCOMPLETE`, `FORM_LOCKED` (`INVALID_INPUT` already stored).
- Not stored: `STALE`, `FORM_CHANGED`, `FORM_ARCHIVED`, `NOT_ASSIGNED`, `NOT_ON_SITE`, `JOB_CLOSED`,
  `NOT_FOUND`.

### 4.4 Versioning
A submission renders from its own snapshot forever; the snapshot is taken when the row is created (first
write). The gap before is guarded by `formVersion`: the INSERT copies the live form only `WHERE f.version =
$formVersion` and the UPDATE requires `form_version = $formVersion`; a miss → 409 `FORM_CHANGED`. The page
then uses the same three-way merge (§7.3) after carrying: `base' = carryValues(base)`, `mine' =
carryValues(mine)` against the new fields (`carryValues` keeps what passes `draftValueOk`; removed fields,
changed types, removed options drop), and `mergeDraft(base', mine', theirs)` when the re-read returns a row
(a colleague's answers survive), else `mine'` on revision 0. Dropped answers are listed "Not saved: …".
A row is never re-snapshotted.

### 4.5 Locking
The draft and submit batches take `lockRequestSql(org, rid)` (L_req, `invoice-field-writes.ts:42`, `FOR
NO KEY UPDATE` on the request) first, as every M3c field write does. The erase batch updates
`service_requests` (the same row lock) **before** its `form_submissions` UPDATE, so the two lock in the
same order (no deadlock) and erase can't miss a row a form batch is creating: either the form batch
commits first and the later UPDATE (fresh statement snapshot) nulls it, or the form batch waits and its
gate sees `anonymized_at`.

## 5. Writers (`src/lib/tech/form-writes.ts`, `src/lib/admin/form-queries.ts`)

### 5.1 Who may fill, and when
F04 ownership: technicians write "notes, photos, materials and forms on jobs they can read"; status,
close-out and money stay native-only. Submissions are app-owned rows the FieldPulse sync never touches, so
**forms are allowed on synced jobs** too. One rule for both: the writer holds a non-cancelled assignment on
**that visit** (`NOT_ASSIGNED` otherwise; readers see every submission read-only). Synced jobs have one:
the 0049 trigger (`drizzle/0049_appointments_shifts.sql`, step 3) mirrors visit #1 and a lead row from `assigned_to`, which is
also how the technician reads the job. The status window differs, because on a synced job the status is
FieldPulse's, not the technician's:
- native: request status in `BILL_STATUSES` (`arrived`…`completed`); `cancelled` → `JOB_CLOSED`; earlier
  → `NOT_ON_SITE`;
- synced: any status but `cancelled` (→ `JOB_CLOSED`).
Close-out cancels untouched open rows (`status-writes.ts:270-273`), so after a close-out only technicians
who started work can still fill a form late.

Shared SQL (rendered with `PgDialect`):
- `visitGateSql(org, rid, aid, me)` = `EXISTS (SELECT 1 FROM appointments p JOIN appointment_assignments
  a ON a.appointment_id = p.id WHERE p.id = $aid AND p.service_request_id = $rid AND p.organization_id =
  $org AND a.organization_id = $org AND p.cancelled_at IS NULL AND a.technician_id = $me AND a.status <>
  'cancelled')`.
- `requestGateSql(org, rid)` = the request is in `$org`; `(native AND status IN BILL_STATUSES) OR (NOT
  native AND status <> 'cancelled')`; and its customer is not erased (`NOT EXISTS (customers c WHERE c.id
  = r.customer_id AND c.anonymized_at IS NOT NULL)`, `schema.ts:894`).
- `formAppliesSql(f, r)` = `(cardinality(f.job_type_ids) = 0 OR r.job_type_id = ANY(f.job_type_ids))`; a
  NULL `job_type_id` (all synced jobs on dev) gets only all-requests forms.

### 5.2 Save draft (`saveFormDraft`)
Input `{ appointmentId, formVersion, baseRevision, saveId, changes }`. Pre-read the row by natural key:
if it exists, `formVersion ≠ row.form_version` → `FORM_CHANGED`, the stored blob must decrypt (else 409
`FORM_LOCKED`: unreadable answers are never overwritten), and `values' = apply(decrypted, changes)` is
validated against its snapshot; if not, read the form with `organization_id = $org` (missing → 404;
inactive → 409 `FORM_ARCHIVED`; `version ≠ formVersion` → `FORM_CHANGED`) and `values' = apply({},
changes)`. Measure, encrypt. One batch:
0. `lockRequestSql(org, rid)`.
1. `INSERT INTO form_submissions (…, form_name, form_version, fields, started_by) SELECT … FROM forms f
   JOIN service_requests r ON r.id = $rid WHERE f.id = $form AND f.organization_id = $org AND f.active AND
   f.version = $formVersion AND requestGate AND visitGate ON CONFLICT (service_request_id,
   appointment_id, form_id) DO NOTHING RETURNING id`.
2. `UPDATE form_submissions SET values_encrypted = $enc, revision = revision + 1, last_save_id = $saveId,
   updated_by = $me, updated_at = now() WHERE organization_id = $org AND (natural key) AND status = 'draft'
   AND erased_at IS NULL AND revision = $baseRevision AND form_version = $formVersion AND requestGate AND
   visitGate RETURNING revision`.
3. Tail `SELECT status, revision, form_version, erased_at, last_save_id, submit_key` of the row.
Zero rows from 2 → in order: `revision = base + 1 AND last_save_id = $saveId` → 200 replay; no row →
gates as reads → `NOT_ASSIGNED` / `NOT_ON_SITE` / `JOB_CLOSED` / `FORM_LOCKED` (customer erased) /
`FORM_ARCHIVED` / `FORM_CHANGED` / 404; `erased_at` → `FORM_LOCKED`; `submitted` → 409 `FORM_SUBMITTED`;
`form_version ≠ formVersion` → `FORM_CHANGED`; else `STALE` `{ revision }`. Success → 200 `{
submissionId, revision, savedAt }` (201 when step 1 inserted). No audit.

**Archived forms, one rule:** an archived form can't be started (step 1's `f.active`, the pre-read, the
GET's 409). An existing row keeps working from its snapshot: step 2 never reads `forms.active`. An
active form that doesn't apply to the job type can be started from `Add a form`.

**Clearing a mistaken draft** needs no new writer: `Clear answers` sends every answered field as `null`. A
draft with no answers is shown as `Not started` on the card and is hidden in the office section.

### 5.3 Submit (`submitForm`)
Same input without `saveId`, keyed; same pre-read; submit validation on `values'`. Same batch with step 2
also setting `status = 'submitted', submitted_by = $me, submitted_at = now(), submit_key =
derivedId(scope, "form-submit")` (`idempotency.ts:81`), plus step 2b: `INSERT INTO audit_log (…
'form_submitted', 'form_submissions', id, details) SELECT … FROM form_submissions WHERE (natural key) AND
xmin = pg_current_xact_id()::xid` (the M3c `equipment-writes.ts:84` gate: only the batch that wrote the
row audits; details `{ formId, appointmentId, formVersion }`). Zero rows → first `status = 'submitted'
AND submit_key = this derived id` → 200 with the row's revision and `submitted_at` (a takeover re-run of
the same submit; its audit already committed with it); then the §5.2 map, `submitted` → stored
`FORM_SUBMITTED`. Success → 200 `{ submissionId, revision, submittedAt }`.

### 5.4 Erasure (`anonymizeCustomer`, `erasure-queries.ts:124`)
Batch order: the attachments DELETE stays first (before the messages it references); the `customer_erased`
audit INSERT moves to just before it and computes `attachmentsDeleted` in SQL (`(SELECT count(*) FROM
attachments WHERE organization_id = $org AND <match>)`), since the pre-read is gone; the `service_requests`
UPDATE comes before the new `form_submissions` UPDATE (§4.5).
- **Answers:** `UPDATE form_submissions SET values_encrypted = NULL, erased_at = now(), updated_at = now()
  WHERE organization_id = $org AND service_request_id IN (SELECT id FROM service_requests WHERE
  organization_id = $org AND customer_id = $cust)`. Status, who and when are kept. New rows and writes on
  the erased customer's requests are refused (`requestGateSql`, `FORM_LOCKED`).
- **Attachments:** `attachmentMatch` (`:181`) today is `customer_id = X OR session_id IN sessions`, but
  `addJobPhoto` (`field-queries.ts:595`) writes only `service_request_id`, and the office uploader
  (`api/admin/attachments/route.ts`) writes request files with only `serviceRequestId` and equipment files
  with only `equipmentId`; all survive erase today. The match gains `service_request_id IN (the same
  subquery)` (technician photos and PDFs and the office's request documents) and `equipment_id IN (SELECT
  id FROM customer_equipment WHERE organization_id = $org AND customer_id = $cust)`. The DELETE becomes
  `.returning({ storageKey })`; the `after()` R2 delete takes those keys plus the signature keys.
- **Photos after an erase:** `addJobPhoto` becomes `INSERT … SELECT … WHERE NOT EXISTS (customer of the
  request anonymised)`; a refusal deletes the uploaded object and answers 409 `CUSTOMER_REMOVED` "This
  job's customer was removed." (copy only on the photo card).
- `deleteCustomer` (`crm-queries.ts:1111`) is unchanged: delete detaches, answers stay with the request.
- The erase widening ships as its own commit with its own tests (a revert of M3d must not revert it).

### 5.5 Office reopen (`reopenSubmission`)
`POST /api/admin/requests/[id]/forms/[submissionId]/reopen` `{ revision }`: `UPDATE … SET status =
'draft', submitted_at = NULL, submitted_by = NULL, submit_key = NULL, revision = revision + 1, updated_at
= now() WHERE id = $sid AND organization_id = $org AND service_request_id = $rid AND status = 'submitted'
AND erased_at IS NULL AND revision = $revision RETURNING revision`. Zero rows → missing → 404; a draft →
200 `{ changed: false }`; erased → `FORM_LOCKED`; else `STALE`. Audit `form_reopened` `{ formId,
appointmentId }`. Nobody is notified; the office tells the technician.

### 5.6 Office form writes
`createForm` (§4.1; ≤ 100 forms per org including archived → 409 `LIMIT_REACHED`); `updateForm` (`fields`
replaced whole, validated by `formDefinitionSchema`; `jobTypeIds` must be the org's job types, archived
ones included → else 400 `UNKNOWN_JOB_TYPE`). Audit: `form_created` `{ formId }`, `form_updated` `{
formId, version, fieldCount }`, `form_archived` / `form_restored` `{ formId, version }`.

## 6. Routes (all `force-dynamic`)

`techFormPreamble` = `techEquipmentPreamble`'s front gates (`invoice-route-guards.ts:89`) with bucket
`form` (submit, `adminMutation` 30/min) or `form-draft` (draft PUT, 60/min: a page sends ≤ 20/min, two open
forms stay under it) and `isUuid` on the form id, then readable job, then the status window of §5.1, then
the body's `appointmentId` (lowercased, as `resolveTarget` does, `:120`) against the caller's
`findTechAssignments` rows (non-cancelled, on that visit) → else 403 `NOT_ASSIGNED`; submit then reads the
key. No native gate. Writers re-check everything inside the batch.

| route | gate | success |
| --- | --- | --- |
| `GET /api/tech/jobs/[id]/forms?visit=<aid>` | session, readable job, `visit` a non-cancelled visit of the request (else 404), rate `tech:form:read:<user>` | `{ visitId, visitNumber, myVisit, canWrite, writeBlockedReason, forms: [{ formId, name, description, required, submission: { id, status, revision, hasAnswers, updatedAt, submittedAt, submittedByName } \| null, submittedOn: { appointmentId, appointmentNumber, submittedAt } \| null }], otherForms: [{ formId, name }] }`. `forms` = active applicable forms + forms with a row on this visit. `submittedOn` = the newest submitted copy on another non-cancelled visit, when this visit has no submitted row. Order: required and not submitted anywhere first, then name |
| `GET /api/tech/jobs/[id]/forms/[formId]?visit=<aid>` | same; form read with `organization_id = $org` (foreign id → 404) | `{ form: { name, description, version, fields }` (snapshot when a row exists, else live; archived with no row → 409 `FORM_ARCHIVED`) `, submission: { id, status, revision, values, updatedAt, updatedByName, updatedByMe, submittedAt, submittedByName, erased } \| null, submittedOn, myVisit, canWrite, writeBlockedReason }`. Undecryptable → `values: null`, `canWrite: false`, reason `unreadable` |
| `PUT …/forms/[formId]/draft` | `techFormPreamble`, no key | 201/200 `{ submissionId, revision, savedAt }` |
| `POST …/forms/[formId]/submit` | `techFormPreamble` + key | 200 `{ submissionId, revision, submittedAt }` |
| `GET /api/tech/jobs/[id]/site` | session, `isUuid`, readable job, rate `tech:site:read:<user>` | §7.6 |
| `GET /api/admin/settings/forms` | admin session, `adminRead` | `{ forms: [{ id, name, questionCount (non-heading), jobTypeIds, required, active, version, updatedAt, submissionCount }] }` |
| `POST /api/admin/settings/forms` | admin, `adminMutation` | 201/200 `{ id }` |
| `GET/PATCH /api/admin/settings/forms/[id]` | admin, `isUuid`, `organization_id = $org` (foreign id → 404) | the form / `{ version }` |
| `GET /api/admin/requests/[id]/forms` | admin, `isUuid`, request in org | `{ submissions: [{ id, formId, formName, formVersion, appointmentId, appointmentNumber, visitCancelled, status, revision, erased, unreadable, fields, values, updatedAt, updatedByName, submittedAt, submittedByName, visitHasTechnician }], missingRequired: [{ formId, name }] }`; drafts without answers omitted; undecryptable → `values: null, unreadable: true`, never a 500; `missingRequired` for every request except `cancelled` (native or synced), counting only submissions on non-cancelled visits |
| `POST /api/admin/requests/[id]/forms/[sid]/reopen` | admin, `isUuid` ×2, `adminMutation` | `{ revision, changed }` |

Admin routes follow the job-types routes (`getAdminSession`, `admin:forms-<op>:<user>`, `readJsonBody`,
`VALIDATION_ERROR` + `details.path` → `settingsFieldErrorCopy`). Logs carry codes and ids only.

## 7. Client

Tech: base shadcn primitives, `h-11` targets, sentence case, human errors, `MAY_NOT_HAVE_SAVED` for
unknown writes, the technician app says "job". Admin: admin-ui primitives, `SectionCard`, "request". One
`plural(n, one, many)` helper for every count.

### 7.1 Forms tab and builder
- **Tab:** active forms by name, archived last; each row: name, `1 question` / `N questions` (non-heading),
  `All requests` or job type names (from `GET /api/admin/settings/job-types`, all, so archived ones still
  name), `Required` chip, `Archived` chip, last changed. Empty: "No forms yet. Forms you build here show on
  technicians' jobs." + `New form`.
- **Builder header:** `Back to forms` (`/admin/settings?tab=forms`), title (the name or "New form"), name,
  description, `Applies to` (`All requests` / `Some job types` + checkboxes of active job types, plus any
  archived ones already in `jobTypeIds` as ticked rows "<name> (archived)"; none at all → "No job types yet.
  Add them on the Job types tab."), `Required form` switch with "Technicians see this form as Required and
  are reminded before closing out. Nothing is blocked."
- **Questions:** type select (`Checkbox`, `Yes / no`, `Short answer`, `Long answer` — disabled at 10 —,
  `Number`, `Choice`, `Heading`), label, help, `Required` (hidden for `Heading`), `Allow N/A` for `Yes / no`
  ("Use N/A for items that don't apply to every system."), for `Number` a `Unit` with a datalist (`psi`,
  `°F`, `A`, `V`, `µF`, `inWC`, `microns`, `CFM`) and `Usual range` from/to ("Readings outside it are still
  saved, with a note."), for `Choice` an options editor. `Move up` / `Move down`, `Add question below`,
  `Remove` with a 5-second `Undo`; `Add question` at the end (disabled at 60). Hint under the list: "Need a
  photo? Ask technicians to add it in the job's Photos card."
- **Pure helpers** (`src/lib/admin/form-builder.ts`): `addField(at)`, `moveField`, `removeField`,
  `changeType` (keeps label and help; keeps `required` except `heading` → false; drops `options`, `unit`,
  `usualMin/Max`, `allowNa`; `choice` seeds two empty options), `newFieldId`, `newOptionId`,
  `builderErrors(form)` → one message per rule (§8).
- **Save** is disabled while `builderErrors` is non-empty, and the reasons are listed above it under "Fix
  these to save:", each linking to its row; also disabled when not dirty. 409 `STALE` keeps the draft with
  `Reload`; other failures "Couldn't save the form. Please try again." When submissions exist: "Forms
  already started keep the earlier version." `useUnsavedChangesGuard` (`use-unsaved-changes-guard.ts:21`)
  while dirty, confirm rendered by the builder as `settings/page.tsx` does; Back is not held. `Archive` /
  `Restore` (confirm "Archive this form? Technicians won't see it on new requests. Answers already given are
  kept."); while dirty: "Save or discard your changes first."

### 7.2 Forms card
- **Visit:** `?visit=` if present, else `summary.assignment.appointmentId`, else `summary.activeVisitId`
  (the summary, `field-queries.ts:154-161`, gains this already-computed field), else "No visit on this
  job yet." Header names it when the job has several visits (`Visit #2`).
- **Rows:** a required form shows `Required` beside its state chip (`Not started` / `Draft`) until
  submitted; `Submitted`, `Answers removed` and `Submitted on visit #1` replace both. A draft without
  answers reads `Not started`. Empty card: "No forms for this job." `Add a form` (writers) opens a sheet of
  `otherForms` with a filter above 10 ("No other forms.").

### 7.3 Fill page
- **Header:** `Back to job` → `/tech/jobs/[id]`, plus `?visit=<aid>` only when `myVisit`; form name,
  description. With `submittedOn`: "Submitted on visit #1 · Nov 6. Fill it in again only if this visit needs
  it." + `View visit #1's answers` (the fill page for that visit, read-only, with `&from=<aid>`; its back
  link reads `Back` and returns to `from`). Pure `backHref` helper.
- **Controls:** `checkbox` 44 px row; `yes_no` radio group `Yes` / `No` (/ `N/A`); texts `Input` /
  `Textarea` with `maxLength` and a count from 80 % of the limit; `choice` radio list; `heading` sub-title;
  required questions show `Required`. `number`: `Input inputMode="decimal"`, unit suffix (`118 psi`, `15
  °F`: a space before the unit), a `±` button (`h-11`, `aria-label="Switch sign"`, toggles a leading `-`,
  empty → `-`) shown when `usualMin` is unset or below 0. Under it: `partial` → "Not saved yet. Finish the
  number."; `invalid` → "Enter a number like 12.5 (up to 3 decimal places)."; a valid outside reading →
  "Outside the usual range (5–15 °F)" / "(at least 5 °F)" / "(at most 15 °F)", no unit → "(5–15)".
- **What is sent:** `changes` = every touched field: its parsed value, `null` when emptied, and for a
  `partial` / `invalid` number its **last valid value** (never a deletion; untouched if it never had one).
- **Autosave** (`nextSaveState`, pure): a save starts 1.5 s after the last change, on blur of a text
  field, and on `visibilitychange → hidden` / `pagehide` (these two bypass the 3 s floor but keep one in
  flight and a pending 429 back-off; `pagehide` only when dirty). One write in flight; an unknown result is
  retried with its own body and `saveId` before any newer one (§4.2); otherwise ≤ one PUT per 3 s. Every
  PUT with a body ≤ 60 KB uses `keepalive: true`. Nothing is stored in the browser.
- **Status line** (header, repeated `aria-live="polite"` in the footer beside `Submit form`; the footer is
  static while a text or number input has focus, so the iOS keyboard doesn't cover the input):

  | state | copy |
  | --- | --- |
  | no row, nothing typed | (blank) |
  | loaded draft | `Saved · 2:41 PM` today, `Saved · Nov 6, 2:41 PM` earlier; `· Sam` when `updatedByMe` is false |
  | saving | `Saving…` |
  | landed, no unparsed input | `Saved · 2:41 PM` |
  | any `partial` / `invalid` number | `Not saved yet: 1 answer isn't a number.` (never `Saved`) |
  | network, 5xx, 429 | `Not saved yet. Retrying…` |
  | 401 | stops; `You've been signed out. Sign in again, then check your answers.` + `Sign in` (`/tech-login?next=<fill page>`) + the "Not saved" list |
  | 400 | stops; `Couldn't save your answers.` + `Try again` (re-sends the same body and `saveId`); later edits wait |
  | `NOT_ASSIGNED`, `JOB_CLOSED`, `FORM_LOCKED`, 404 during autosave | read-only with the reason copy + the "Not saved" list |
  | over 128 KB | `This form is too long to save. Shorten the longest answers.` |
  | submitted | `Submitted · Nov 7, 2:41 PM · Alex Rivera` |

  The "Not saved" list shows the unsaved answers read-only ("Not saved: Suction pressure · 118 psi") so
  they can go in the on-site note.
- **Merge** (`mergeDraft(base, mine, theirs)`, pure; `base` = values of the last load or landed write,
  `mine` = the touched fields): touched fields take `mine`, others `theirs`; rendered at once, saved on
  `theirs.revision`. When a field not touched here changed from `base`, the page shows once per load
  "Someone else changed this form. Their answers are shown, and yours are kept." If `theirs` is submitted:
  read-only, "<name> submitted this form. Your last changes weren't saved." + the "Not saved" list.
- **Clear answers** (writers, a draft with answers): confirm "Clear all answers on this form?" → sends
  every answered field as `null`.
- **Submit:** refused on the client while any number is `partial` / `invalid` ("Fix the highlighted
  answers.", focus on the first) or required answers are missing ("Answer this." per question, top line
  "1 required question isn't answered." / "2 required questions aren't answered."). Else confirm "Submit
  “<form name>”? After this, only the office can reopen it." `Submit` / `Go back`. Submit cancels the
  debounce, waits for the write in flight, then sends with the latest revision; `Submitting…` locks the
  page. `STALE` / `FORM_CHANGED` → merge (or carry), unlock, show the line, new tap and confirm (a new
  body mints a new key). Stored `FORM_SUBMITTED` → refetch. After success: read-only, primary `Back to job`.
- **Read-only reasons:** "Only a technician on this visit can fill in its forms." / "Arrive at the job
  first." / "This job is closed." / "This form was archived by the office." / "These answers can't be
  shown." / "These answers were removed."

### 7.4 Close-out reminder (native jobs)
The job page passes the card's required forms with no submitted copy on any non-cancelled visit to
`close-out-sheet.tsx`. It renders "Not submitted yet:" and one `h-11` link per form, "Fill in “<name>”", to
the fill page for the card's visit, **in both states**: under the blocker list when the sheet is blocked
(no confirm button, `close-out-sheet.tsx:139`), above the confirm when ready. Pure helper
`reminderVisible`. Blockers, the close-out route and `status-writes.ts` are unchanged.

### 7.5 Office Forms section
Each submission: form name, `Visit #N` (`Visit #2 · cancelled` for a cancelled visit), `Draft` /
`Submitted` / `Answers removed` / "These answers can't be shown.", who and when, answers with the
outside-range note. `missingRequired`: "Not submitted yet: <name>" on open requests, "Required, not
submitted: <name>" (warning tone) on completed ones. `Reopen` confirm "Reopen this form? The technician can
change the answers and submit again."; when `visitHasTechnician` is false it adds "No technician is on this
visit any more."

### 7.6 Site page (`/tech/jobs/[id]/site`, `src/lib/tech/site-queries.ts`)
Anchored on the readable request (`findReadableJob`, `ownership.ts:134`): customer, location and address
come from `service_requests` server-side; every table carries `organization_id = $org`. **Never show the
customer's jobs at another address, and never guess an address.** Dev (2026-11-07): synced requests have
neither `address_encrypted` nor `location_id` (0/207; the FieldPulse import writes addresses only to
`customers`, `fieldpulse/import/customer-split.ts`); native requests with a customer 75/76 with an
address; `customer_locations` 16 rows. **Site match** (`siteScope`, pure decision over one SQL read):
- Candidates: the customer's other requests (org, `customer_id`, not cancelled, newest 500) with
  `location_id` and decrypted `address_encrypted`, compared by `normalizeAddress` (private today in
  `admin/location-queries.ts:15`, exported). A candidate with no address and no location never matches.
- `location`: this request has a `location_id` → candidates with it, plus location-less candidates whose
  normalised address equals this request's (when this request has one).
- `address`: no location but an address → candidates with an equal normalised address.
- `none`: neither, or the customer is erased → nothing matches. No fallback to the customer's address
  (a FieldPulse customer with several properties would leak history across them).
GET `{ scope, title, pastJobs, unaddressedCount, openEstimates, membership, hasCustomer }`:
- `title`: the location's `label`, else "Service address".
- `pastJobs` (newest 20): matched candidates, excluding ones not yet started with a future date (`status
  IN ('pending','assigned','scheduled') AND COALESCE(scheduled_date, arrival_window_start) > now()`),
  ordered by `COALESCE(completed_at, scheduled_date, created_at) DESC, id`: `{ id, referenceNumber, date,
  status, jobTypeName or issueLabel(issue_type), leadTechnicianName (first name), submittedFormNames (≤ 3)
  }`. Never description, notes, addresses, contact fields or signature names.
- `unaddressedCount`: the customer's other requests with neither address nor location (synced ones today).
- `openEstimates`: `status = 'open'`, `expires_at` NULL or future, `service_request_id` = this request or a
  matched one (request-less ones excluded): `{ id, label (estimateLabel; FieldPulse: title or "Estimate"),
  createdAt, totalCents, optionCount, thisJob, fromFieldPulse }`.
- `membership`, only when this request has a normalised address, the customer has ≤ 1
  `customer_locations` row, and **every** one of the customer's requests has an address normalising to
  that same one; else `null`. Memberships belong to the customer, so "Member" at a landlord's other
  building would invite member pricing the plan may not cover. Shape: the active `customer_memberships`
  row (≤ 1) with its plan → `{ planName, startedAt, currentPeriodEnd, visitsPerYear, upcoming: [{ dueDate,
  status, thisJob }] }`, up to 3 `membership_visits` with status `scheduled` / `generated` and `due_date >=`
  the start of today in the business timezone. No price, billing or benefits. (`account-tools.ts` readers
  are not reused: they serve the bot's contract.)
- Page: `Back to job`, title, `At this address`: `Past jobs`, then the line "3 earlier jobs have no saved
  address." when `unaddressedCount > 0`, `Open estimates`, then `Membership` with `Upcoming maintenance`.
  Rows aren't links, except this job's open estimates for the lead (M3c page).
- Job page `Site` card: "4 past jobs · 1 open estimate · Member" (zero parts omitted; all zero → "No history
  at this address yet."; `none` → "No saved address."; no customer → "No customer on this job yet.").

### 7.7 Photos (`job-photos-card.tsx`)
Today the card sends the raw file, shows one `PHOTO_UPLOAD_FAILED` ("Couldn't upload that photo. Try
again.", `job-page-state.ts:19`) and renders every row as `<img>`; the route allows jpeg/png/webp/heic/pdf
by magic bytes up to 20 MB.
- "Quality: Standard · Change": `Change` expands an inline radio pair `Standard` / `High` ("Standard saves
  data. High keeps more detail.") that collapses on pick; remembered in `localStorage`
  `tech:photo-quality` (try/catch; default `standard`).
- Resize (`photo-resize.ts`: pure plan + thin browser adapter): `HTMLImageElement` + `await img.decode()`
  (EXIF orientation applied on draw), drawn onto a canvas at target size, JPEG. `standard` 1600 px q 0.8,
  `high` 3200 px q 0.9; never upscale; over `TECH_UPLOAD_LIMIT_BYTES` (4 × 1024 × 1024, in a pure
  `src/lib/tech/upload-limits.ts` the route also imports) step down q 0.8 → 0.7 → edge × 0.75, 3 times;
  still over, or decode failure with an original over 4 MB → "This photo can't be prepared on this phone.
  Take it again, or use a smaller photo."; decode failure ≤ 4 MB → the original. Re-encoding drops EXIF
  (GPS and capture time).
- A failed upload keeps the prepared blob (or the PDF `File`): `PHOTO_UPLOAD_FAILED` becomes "Couldn't
  upload that photo." (files: "Couldn't upload that file.") with `Try again` and `Discard`; `Take photo` and
  `Add file` stay disabled until one is chosen, and during any upload. Success: "Photo uploaded." / "File
  uploaded."
- `Add file` (`accept="application/pdf"`): over 4 MB → "This file is too large. The limit is 4 MB.";
  non-image rows render as a file tile (fixes today's broken `<img>` for office PDFs).
- The route enforces the 4 MB limit (400 `INVALID_INPUT`, same copy), gains `isUuid` on POST, and the
  erased-customer refusal (§5.4). Why 4 MB: Vercel Functions cap request bodies at 4.5 MB (platform docs;
  measure, §11).

## 8. Copy (beyond the tables above)

| where | copy |
| --- | --- |
| Codes | FORM_CHANGED "The office changed this form. Check your answers." · FORM_SUBMITTED "This form was already submitted." · FORM_LOCKED "This form can't be changed." · FORM_ARCHIVED "This form was archived by the office." · NOT_ASSIGNED "Only a technician on this visit can fill in its forms." · CUSTOMER_REMOVED "This job's customer was removed." |
| Builder errors (`builderErrors`, one per rule) | "Give the form a name." · "Keep the name under 80 characters." · "Keep the description under 300 characters." · "Add at least one question." (headings don't count) · "Up to 60 questions." · "Up to 10 long answers per form." · "Add a label." · "Keep the label under 120 characters." · "Keep the help under 200 characters." · "Keep the unit under 12 characters." · "Add at least two options." · "Up to 12 options." · "Each option needs a label." · "Keep each option under 60 characters." · "Two options have the same label." · "The low end must be below the high end." · "Pick at least one job type, or choose All requests." · "This form is too large. Remove some questions." (64 KB) |
| Builder other | NAME_TAKEN "A form with this name already exists." · STALE "Someone else changed this form. Reload to see their changes." · LIMIT_REACHED "You've reached the limit of 100 forms." · UNKNOWN_JOB_TYPE "One of those job types no longer exists." |
| Site rows | "Nov 3, 2026 · Maintenance · Completed · Alex · Forms: Maintenance checklist" · "Estimate · Nov 6 · 2 options" "Up to $4,812.00" `This job` `From FieldPulse` · "Gold plan · Member since Mar 2026 · Paid through Apr 1, 2027" (omitted when null) · "2 visits a year" · "May 1, 2027 · Scheduled" / "· Booked" (generated) + `This job` · empties "No other jobs at this address.", "No open estimates.", "Not a member.", "Membership is on the customer's account. Ask the office." (null by rule), "This job has no saved address, so there's no site history.", "No customer on this job yet. Ask the office to add one." |

Canon: request (admin) / technician / sign in / cancelled / Unicode … and “ ” / sentence case / no
`err.message`. Dates in the business timezone (`BUSINESS_BASE_LOCATION.timezone`, as `job-display.ts:8`).

## 9. Tests

No jsdom/RTL; component logic lives in pure helpers.

**Pure:** `formDefinitionSchema` (types, ids, option ids, `allowNa`, unit, usual range, heading never
required, caps, ≥ 1 non-heading); `draftValueOk` (controls refused, `null` valid); `numberInputState`
("1,200" → 1200, "12." / "-" / "-." partial, "1e3" / "12.3456" / "2000000" invalid); `changes` builder
("12" saved then "12." → body still 12; emptied → `null`; never-valid partial → untouched); the 128 KB
measure (control characters, multibyte, emoji); `missingRequired` (`na` satisfies); `carryValues`;
`mergeDraft` (touched wins, untouched takes theirs, banner only for foreign changes, FORM_CHANGED path
with a colleague's row keeps their answers); `nextSaveState` (debounce, one in flight, unknown retried
first with its `saveId`, 3 s floor, hidden/pagehide bypass, 429, 400 stop + Try again, 401 stop, status
line never `Saved` with unparsed input, submit waits); status-line copy table; `backHref`; card visit pick
and chip combinations; `reminderVisible` (blocked and ready); `plural`; builder helpers incl. `changeType`
(required → heading → false; choice → number drops options; → choice seeds two) and every `builderErrors`
rule incl. "Some job types" with none and archived ids kept; `formApplies`; `siteScope` (location / address
/ none; address-less candidates never match; no fallback; membership `null` with an address-less sibling,
a second location, or a different address); site formatters; `resizePlan`; `qualityFromStorage`.

**SQL renders (`PgDialect`):** draft and submit batches start with `lockRequestSql`, carry
`organization_id` on each table, `visitGateSql` with `a.appointment_id = p.id`, `requestGateSql` (both
status windows, not anonymised), the xmin-gated audit INSERT; site queries' org predicates; the erase batch
order (audit with SQL count → attachments DELETE … RETURNING → … → `service_requests` UPDATE → answers
UPDATE), both new `attachmentMatch` arms as subqueries; `addJobPhoto`'s anonymised gate.

**Route tests:** every gate and code; 201/200; foreign form id → 404 (tech and admin); stored envelopes and
the request hash input contain no submitted string; site payload has no key like `phone`, `email`,
`description`, `address`, `signature`; photo POST refuses > 4 MB, a non-UUID id and an erased customer;
`status-writes.test.ts` and the close-out route tests pass unchanged.

**Integration (`tests/integration/field-forms.test.ts`, `VITEST_INTEGRATION=1`, dev DB, throwaway org by
SQL, never the FieldPulse-connected default org):**
(a) `createForm` twice with one token → one row; an empty definition → 400, no row; stale PATCH → STALE;
duplicate name → NAME_TAKEN;
(b) done-when: 4 checkboxes (2 required) + a number with a usual range → a helper saves 2 answers and an
out-of-range reading → GET shows them → the same `saveId` again → 200 replay; tick, lost response (send,
discard the reply), untick, retry the first then the second → unticked; submit missing a required →
FORM_INCOMPLETE → full submit → `submitted`, one audit row; same key → replay; new key → FORM_SUBMITTED;
draft save → FORM_SUBMITTED;
(c) submit takeover: commit the batch, leave the key claimed past the takeover window, re-send → 200, still
one audit row; submit, reopen, resubmit → two audit rows;
(d) two technicians from revision 0 concurrently → one lands, one STALE;
(e) office saves version 2 after a version-1 draft → the draft submits on version 1; on a new visit
technician B answers on version 2, technician A's version-1 save → FORM_CHANGED, the carried merge keeps
B's answers;
(f) gates: only on visit #1, saving on #2 → NOT_ASSIGNED; cancelled visit → 404; another org → 404; native
`pending` → NOT_ON_SITE; `cancelled` → JOB_CLOSED; native `completed` → allowed;
(g) **synced job:** a request with `fieldpulse_job_id` and `assigned_to` (lead row from the 0049 trigger)
in status `scheduled` → the technician saves and submits; `cancelled` → JOB_CLOSED; a later sync-style
UPDATE of the request's status leaves the submission unchanged;
(h) archived: an existing draft saves and submits; starting it on a new visit → FORM_ARCHIVED; an active
non-applicable form can be started; `Clear answers` → `Not started` on the card, hidden in the office GET;
(i) erase: an attachment on the request and one on the customer's equipment inserted by SQL; after
`anonymizeCustomer` → values NULL, `erased_at` set, both attachment rows gone, their keys handed to the
cleanup (mocked), `attachmentsDeleted` = 2; later save and a new form → FORM_LOCKED; a photo insert →
CUSTOMER_REMOVED; erase interleaved with a first save on two connections (form batch holding L_req) → no
ciphertext left; `deleteCustomer` keeps submissions;
(j) reopen; stale → STALE; draft → `changed: false`; resubmit;
(k) an undecryptable blob → tech GET read-only, save → FORM_LOCKED, admin GET `unreadable`, no 500;
(l) site: location scope lists same-location and same-address location-less jobs, never the customer's
other location or another customer; address scope; a synced job → `none`, `unaddressedCount` counted; a
future scheduled job excluded; estimates of matched requests only; membership shown for a single-address
customer, `null` for a two-location customer and for a native job with an address-less synced sibling;
overdue visits excluded; another org never appears;
(m) `missingRequired` on a completed request; not on a cancelled one; a submission on a cancelled visit
doesn't count;
(n) audit rows carry ids and enums only.

**Browser walk** (throwaway org via `createOrgCore`; everything by SQL; mint sessions with `MINT_ORG_ID`
and assert user and org; queue guard before, zero `communication_jobs` after; 390×844). Data: customer A
with one location; two past requests at it, an open estimate on one, an active membership with a scheduled
visit; the native job (with a job type) with a lead and a helper. Customer B, another customer at a
different address, with one request. Walk: admin `New form` → "Maintenance checklist" (4 checkboxes, a
`psi` number with a usual range, Required form) → Save → the job page shows Forms first with `Required` ·
`Not started` → Site lists A's 2 past jobs (none of B's), the estimate and the membership → fill half incl.
an out-of-range reading and a "12." (status `Not saved yet: 1 answer isn't a number.`) → finish it →
`Saved` → reload → answers there → the helper's session sees the same draft → the helper taps Done → the
lead taps Close out → the sheet shows "Fill in “Maintenance checklist”" above the confirm; follow it →
submit → `Back to job` → close out → the admin sheet shows the answers with the range note → erase A →
"Answers removed". Photo upload can't run on dev (no R2): pure plan and mocked route tests; the quality
line and resize are checked on a real phone after deploy.

## 10. Out of scope

- Required forms blocking close-out (row 126, deferred).
- Video; photo, signature and file form fields; conditional logic, calculated fields, multi-select,
  dates, per-field notes, sections as a model, templates, copying, drag-to-reorder, builder preview.
- Non-job and PDF-overlay forms (row 127), portal forms, emailing or a PDF of a submission.
- Offline mode (row 124) and any browser copy of answers.
- Office editing of answers; reports over answers; deleting a draft row (`Clear answers` empties it).
- Status, close-out and money on synced jobs (unchanged).
- Keying the photo upload; server-side image processing; an upload queue.
- Site page: equipment, invoices, contact details, links into other jobs, request-less estimates,
  membership at multi-address customers, price or benefits; showing synced history (no address on file).

## 11. Rulings and things not verified

Rulings (critics: attack them):
1. Drafts server-only; changes + revision gate + `saveId` replay, no key; submit keyed with `submit_key`,
   an in-batch xmin-gated audit and an HMAC'd request hash.
2. Drafts never fail on content; a half-typed number keeps its last valid value; usual range is advice;
   submit checks required + parse.
3. One submission per visit per form; per-visit write right; forms on native and synced jobs.
4. Attach by job type plus picked active forms; archived forms can't be started, existing rows continue;
   forms exist only with ≥ 1 question.
5. Snapshot at row creation; `formVersion` + carry + three-way merge.
6. Locked after submit; only the office reopens; `Clear answers` instead of discarding drafts.
7. Row 126 deferred: Required + reminders (card, close-out sheet in both states, office incl. completed).
8. Form batches take L_req first; erase updates the request before the answers.
9. Erase nulls answers, refuses new answers and photos, deletes request and equipment attachments by
   `DELETE … RETURNING`; delete-customer keeps answers.
10. Site page matches by location or saved address only, never a fallback; membership only when every
    request of the customer has one same address.
11. Photo quality per device; 4 MB on client and route; PDFs in, video out.

Verified in review: synced requests have no address, location or job type on dev (0/207); native 75/76
with an address; `useUnsavedChangesGuard` is self-contained; `normalizeAddress` is
`trim().toLowerCase()` + whitespace collapse and finds no false match on dev.

Not verified (plan or deploy):
- The 0049 trigger gives every synced job with `assigned_to` its visit and lead row on prod data (seen in
  the trigger source, `drizzle/0049_appointments_shifts.sql` lines 130, 182–197; check counts on dev before relying on it).
- The Vercel 4.5 MB body limit on this route (measure a 5 MB upload on a preview).
- iOS camera captures arrive as JPEG; `img.decode()` memory on 48 MP captures on older iPhones.
- Strict `normalizeAddress` misses "…, Tennessee 37601" vs "…, TN 37604" for the same house: a miss only
  hides history.

## 12. Review focus

- Tenancy and ownership: org predicates; the per-visit gate in both batches; the synced status window;
  readers never write; the site match can't reach another customer or address.
- Draft writes: changes applied to the read document under the revision gate; the `saveId` replay and the
  unknown-first retry order; merge and carry paths; half-typed numbers never deleting; the status table.
- Submit: stored codes deterministic; `submit_key` takeover; the xmin-gated audit; the HMAC'd hash.
- Locking and erasure: L_req first in form batches; the erase batch order; the SQL-computed count; new
  answers and photos refused after erase; no answer in logs, audit or stored envelopes.
- Site scope and the membership rule; row 131's honesty with synced history absent.

## 13. Docs

`page-tech` (Forms card and page, synced jobs, reminder, Site page, photos), `page-settings` (Forms tab and
builder), `page-requests` (Forms section, reopen), `page-customers` (erase covers answers and request /
equipment attachments; photos refused after erase), `replica/features.csv` rows 122/125/126/131,
`replica/parity.md`, `replica/build-log.md`, `replica/architecture.md` annotation (forms on synced jobs,
video cut, row 126 deferred, office-only reopen), memory.
