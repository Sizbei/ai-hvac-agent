# Replica M3d: Forms + site view

Status: v4 FINAL (2026-11-07) after adversarial review rounds 1–3 (7 critics; log in
`docs/superpowers/specs/2026-11-07-replica-m3d-review-log.md`). Owner: Raymond Chen.
Milestone source: `replica/architecture.md` build order "M3d Forms + site view" (line 609) and the F04
ownership rule (lines 156–159). Builds on M3a (ownership, visit trigger), M3b (idempotency keys) and M3c
(field preambles, L_req, intents storage, equipment).

## 1. Goal

The office builds a checklist under Settings. On site, the technicians working a visit see the forms that
apply to the job near the top of the job page, fill one in, and the answers are saved on the server as
they type, so a reload (or a second phone) shows the draft. Submitting locks it. The office sees the
answers on the request's detail sheet, and erasing the customer removes them. A Site page shows what the
technician should know about this address: the earlier jobs there, the open estimates and, when the
customer has exactly one address, the membership and its next maintenance visit. Photos get a quality
setting, are resized on the phone, and the Photos card also takes PDF files.

Native and FieldPulse-synced jobs both carry forms. On a synced job the writer is the technician
FieldPulse lists first (the only one with an assignment row); other FieldPulse technicians and unassigned
synced jobs have none (dev: 191 of 207 synced jobs have a live visit with a lead row, 16 are unassigned,
44 list extra FieldPulse technicians).

Done when (architecture.md): an admin creates a checklist, the tech fills half, reloads, sees the draft,
submits; the submission shows on the admin job and is anonymised by erase; the location tab lists past
jobs, open estimates and the membership.

Feature rows (`replica/features.csv`, row = file line):
- **125** Job forms and checklists (must) → `yes`, note "native and synced jobs; on synced jobs the
  technician FieldPulse lists first fills them".
- **131** Location info tab (must) → `partial`, note "past jobs, open estimates and membership at the same
  location or saved address; FieldPulse-synced jobs carry no address, so their history is counted, not
  shown; flips to yes when FieldPulse job addresses are imported (follow-up)".
- **122** Photos / video / files with quality setting (must) → `partial`, note "photos with a quality
  setting + PDF files; no video".
- **126** Required forms block close-out (should) → `no`, note "forms can be marked Required; the Forms
  card, the close-out sheet and the office remind; nothing blocks (deferred: it would change the M3a
  close-out batch)".
- Not touched: 127 (non-job and PDF-overlay forms), 124 (offline mode).

## 2. Surfaces

| surface | who | what |
| --- | --- | --- |
| Settings → `Forms` tab (`/admin/settings?tab=forms`; `forms` added to `SETTINGS_TABS` after `job-types`, `settings-tabs.ts`) | admin | §7.1 list |
| Form builder `/admin/settings/forms/new` and `/admin/settings/forms/[id]` (`src/app/admin/(dashboard)/settings/forms/[id]/page.tsx`; `new` is the same page with no row) | admin | §7.1 |
| Request detail sheet, `Forms` section after `Visits` (`request-forms-section.tsx`) | admin | §7.5 |
| Job page `Forms` card, **directly after the summary** | every technician who can read the job | §7.2 |
| Fill page `/tech/jobs/[id]/forms/[formId]?visit=<aid>` | readers see it; writers per §5.1 fill it | §7.3 |
| Close-out sheet (`close-out-sheet.tsx`, native jobs) | the lead | non-blocking reminder links (§7.4) |
| Job page `Site` card (after Forms) and Site page `/tech/jobs/[id]/site` | every reader | §7.6 |
| Job page `Photos` card | as today | §7.7 |

Row 131's "tab" is the Site page reached from the job page (the M3c estimate-page pattern); the job client
(`tech-job-detail-client.tsx`) is not restructured into tabs.

## 3. Data model

Migration `drizzle/0058_m3d_forms.sql`, hand-authored and idempotent (`CREATE TABLE IF NOT EXISTS`, one
`DO $$ … EXCEPTION WHEN duplicate_object` block per constraint, `CREATE [UNIQUE] INDEX IF NOT EXISTS`,
`--> statement-breakpoint` separators). Journal `idx 58`, tag `0058_m3d_forms`, `when` strictly greater
than 0057's `1793975702677` (the migrator skips a lower one). Procedure: copy `drizzle/` into a scratch
directory, run `drizzle-kit generate` there against the new schema.ts, take its `0058_snapshot.json`
(`prevId` = 0057's id) and diff the hand SQL against its generated SQL statement by statement (modulo the
idempotency wrappers and the trigger function, which drizzle doesn't model); in the repo `drizzle-kit
generate` then reports "No schema changes"; `npm run db:migrate` on the dev branch before the integration
suite, then compare `pg_indexes` / `pg_constraint`. Prod migrates in the build. No branch carries a 0058.
Every CHECK is a `check()` in schema.ts; the name index `uniqueIndex(…).on(t.organizationId,
sql\`lower(${t.name})\`).where(sql\`${t.active}\`)`, the array default `sql\`'{}'::uuid[]\``.

### 3.1 `forms`

| column | type | notes |
| --- | --- | --- |
| `id` | uuid PK | `officeId("form", org, clientToken)` (§4.1) |
| `organization_id` | uuid NOT NULL → organizations ON DELETE CASCADE | |
| `name` | text NOT NULL | 1–80, trimmed |
| `description` | text NULL | ≤ 300 |
| `fields` | jsonb NOT NULL | §3.3; CHECK `jsonb_typeof(fields) = 'array'`. A row exists only once a valid definition (≥ 1 non-heading question) was saved (§4.1) |
| `job_type_ids` | uuid[] NOT NULL DEFAULT `'{}'` | empty = all requests; else `job_types` ids (validated by the writer, intersected by readers) |
| `required` | boolean NOT NULL DEFAULT false | "Required form": reminds, blocks nothing |
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
| `form_id` | uuid NOT NULL → forms, NO ACTION | forms are never deleted; the org purge is one `DELETE FROM organizations` and NO ACTION is checked at the end of the statement |
| `service_request_id` | uuid NOT NULL → service_requests ON DELETE CASCADE | session delete (`conversation-queries.ts:686`) hard-deletes requests |
| `appointment_id` | uuid NOT NULL → appointments, **NO ACTION** | a request delete still removes visit and submission in one statement; a lone visit delete that would orphan answers fails loudly (no code path deletes a visit directly; the trigger, §3.4, keeps visits with submissions) |
| `form_name`, `form_version`, `fields` | text / integer / jsonb NOT NULL | snapshot at row creation; `fields` CHECK array |
| `values_encrypted` | text NULL | `encrypt(JSON.stringify(values))` (`crypto.ts:30`); NULL = no answers (the writer stores NULL for an empty document) or erased; CHECK `erased_at IS NULL OR values_encrypted IS NULL` |
| `status` | text NOT NULL DEFAULT `'draft'` | CHECK `IN ('draft','submitted')` |
| `revision` | integer NOT NULL DEFAULT 0 | +1 per write, submit, reopen; CHECK `>= 0` |
| `last_save_id` | uuid NULL | the client `saveId` of the last applied draft write (§4.2) |
| `submit_key` | uuid NULL | `derivedId(scope, "form-submit")` of the submit that landed (§5.3) |
| `started_by`, `updated_by`, `submitted_by` | uuid NULL → users ON DELETE SET NULL | technician ids |
| `submitted_at` | timestamptz NULL | CHECK `(status = 'submitted') = (submitted_at IS NOT NULL)` |
| `erased_at` | timestamptz NULL | set by customer erasure |
| `created_at`, `updated_at` | timestamptz NOT NULL DEFAULT now() | |

Indexes: `form_submissions_visit_form_unique` UNIQUE `(appointment_id, form_id, service_request_id)`
(leads with `appointment_id`, so the FK check and the trigger probe use it; a visit belongs to one request,
so this is the architecture's "unique per request/visit/form"); `form_submissions_org_request_idx
(organization_id, service_request_id)`; `form_submissions_form_idx (form_id)`.

### 3.3 Field definitions (`src/lib/forms/form-schema.ts`, pure, zod, shared by server and both clients)

A flat list. Each field: `{ id, type, label (1–120), help? (≤ 200), required }` plus per type:

| type | in | value | extra definition | why |
| --- | --- | --- | --- | --- |
| `checkbox` | yes | `true` (unticked = absent) | — | checklist item; required = must be ticked |
| `yes_no` | yes | `'yes'` \| `'no'` \| `'na'` | `allowNa?` adds `N/A` | pass / fail; N/A so a non-applicable required item is never falsified |
| `short_text` | yes | string 1–200 | — | model, filter size |
| `long_text` | yes | string 1–2000 | ≤ 10 per form | findings |
| `number` | yes | finite, \|x\| < 1,000,000, ≤ 3 decimals | `unit?` (≤ 12), `usualMin?`, `usualMax?` (min ≤ max) | readings; the usual range is advice only: an outside reading saves and submits with a note, because it is the fault being recorded |
| `choice` | yes | one option id | `options: [{ id, label 1–60 }]` 2–12, labels unique case-insensitively | filter condition |
| `heading` | yes | none; `required` always false | — | a section title |
| `photo`, `signature` | **no** | | | dev has no R2, uploads aren't keyed, a photo answer needs its own erase path; the job's Photos card and signature exist |
| multi-select, date, calculated, conditional, per-field notes | **no** | | | scope |

Ids: fields `f_` + 10 × `[a-z0-9]`, options `o_` + 8 × `[a-z0-9]`, minted on add, kept across relabels,
unique within the form. Limits: 1–60 fields with ≥ 1 non-heading; ≤ 10 `long_text`; definition ≤ 64 KB.
Text values: C0 control characters other than tab, LF and CR are refused (the client strips them on
input); lengths are UTF-16 code units (`maxLength`). The values document is capped at 128 KB **measured**
as UTF-8 bytes of `JSON.stringify(values)`; over it → 400 `INVALID_INPUT` `{ path: ["values"] }`; the
client measures the same before sending.

Validation (`src/lib/forms/form-values.ts`, pure):
- **`draftValueOk(field, value)`**: the key is a non-heading field id of the snapshot; the value has the
  field's type and parses (number bounds; choice id exists; text within length, no controls). No required
  or range check. `null` is valid and means "cleared".
- **`numberInputState(raw)`** → `empty` | `partial` | `invalid` | `out_of_bounds` | `{ value }`. Thousands
  separators are stripped when the text matches `^-?\d{1,3}(,\d{3})+(\.\d+)?$` ("1,200" → 1200).
  `partial` = a prefix that could still become a number: `-`, `12.`, `-.`, and `^-?\d{1,3}(,\d{3})*,\d{0,2}$`
  (mid-typing "1,2"). `out_of_bounds` = parses but \|x\| ≥ 1,000,000. `invalid` = anything else (`1e3`,
  `12.3456`, letters).
- **submit**: every change passes `draftValueOk`, then `missingRequired(fields, values)` on the resulting
  document → 400 `FORM_INCOMPLETE` `{ fieldIds }`. Nothing else is checked.
- Error `details` are `{ fieldIds }` or `{ path }` only, never zod messages.
- **`answerText(field, value)`** (shared by the office section and every read-only view): checkbox →
  "Done" / "Not done"; yes_no → "Yes" / "No" / "N/A"; choice → the option label; number → "118 psi" (a
  space before the unit) plus the range note; text verbatim; absent → "No answer"; heading → its title.

Why not `custom_field_definitions` (`schema.ts:1750`): one plaintext current value per entity, no visit,
snapshot or draft state.

### 3.4 Visit trigger (in 0058)
The live `sync_request_appointment()` is 0050's `CREATE OR REPLACE` (`drizzle/0050_m3a_run_the_day.sql:36-164`).
Its step 1 deletes visit #1 when the request has no date, window or `assigned_to` and no assignment on the
visit has progress (`:69-83`). The FieldPulse sync rewrites `assigned_to`, date and window nightly
(`fieldpulse/import/jobs.ts:528-536`) and technicians never stamp progress on synced jobs (dev: 0 of the
synced assignment rows), so an unassigned, undated synced job would lose its visit; with a CASCADE its
submitted answers would vanish silently. 0058 therefore `CREATE OR REPLACE`s the function with 0050's body
**verbatim** except one predicate: `v_has_progress` also ORs `EXISTS (SELECT 1 FROM form_submissions s
WHERE s.appointment_id = v_appt_id)`. A visit with a submission is then kept with its times nulled and its
lead demoted, as 0050 does for a visit with progress. The function is created after `form_submissions`. A
render test diffs the 0058 body against 0050's and allows only that line.

## 4. Ids, idempotency, versioning, locking

### 4.1 Office writes
`New form` opens the builder unsaved (empty name, one blank `Checkbox` question); nothing is inserted
until the first valid `Save`, which POSTs `{ clientToken, name, description, jobTypeIds, required, fields }`
validated by `formDefinitionSchema`. id = `officeId("form", org, clientToken)` (`idempotency.ts:89`, `kind`
gains `"form"`), `ON CONFLICT (id) DO NOTHING RETURNING id` (the token is minted when the builder opens).
- **201:** `router.replace('/admin/settings/forms/<id>')`; the builder continues as an edit with `version:
  1`.
- **200 (replay; `officeId` ignores the body):** the builder GETs the row and replaces the URL; if its own
  state differs from the row, it stays dirty with the row's `version`, so the next Save PATCHes the later
  edits instead of losing them.
- **Unknown result:** Save stays enabled; the next Save re-POSTs the same token with the current body, and
  the 201/200 rules above apply. Pure helper `firstSaveOutcome`.
Edits are `PATCH` with `{ version }`: `UPDATE forms SET …, version = version + 1, updated_at = now() WHERE
id = $id AND organization_id = $org AND version = $v RETURNING version`; zero rows → missing → 404, else
409 `STALE`. A name collision (`isUniqueViolation(err, "forms_org_name_active_unique")`) → 409 `NAME_TAKEN`
(also on restoring an archived form whose name is now taken).

### 4.2 Draft writes: changes + revision gate + save id, no key
The values are one AES ciphertext, so two technicians' answers can't be merged in SQL, and neon-http has no
interactive read-merge-write. A draft PUT sends **changes**: `{ [fieldId]: value | null }` for every
touched field (`null` = cleared; §7.3 defines touched), with `baseRevision`, `formVersion` and `saveId` (a
`mintKey()` uuid per write, reused by its retries). The server applies the changes to the decrypted
document and the UPDATE lands only when `revision = baseRevision`, so the document it changed is the one it
read.
- **Retry:** a write whose result is unknown is re-sent with the same body and `saveId` before any newer
  write. The replay check runs **first** (§5.2): `revision = baseRevision + 1 AND last_save_id = saveId` →
  200 with that revision, before any decrypt, apply, measure or merge. (Round 1's claim that a merge
  resolves a retry cleanly was wrong; log R2.)
- **Anything else** → 409 `STALE` `{ revision }`: the page re-reads and merges (§7.3).
No idempotency key: autosave would add an `idempotency_keys` row per burst, and the save id rule is the
"re-send the old body first" rule for this one route.

### 4.3 Submit: keyed
`POST …/forms/[formId]/submit` carries `{ appointmentId, formVersion, baseRevision, changes }` and an
`Idempotency-Key` through `withIdempotency` (`idempotency.ts:210`). The request hash is computed over `{
appointmentId, formVersion, baseRevision, changesMac }` with `changesMac = macHex("hvac-form-changes-v1",
canonicalJson(changes))`: `macHex(label, s)` is new in `crypto.ts`, an HMAC-SHA256 under a key derived from
`ENCRYPTION_KEY` with its own label (as `blindIndex` derives with `"hvac-blind-index-v1"`, `crypto.ts:14`),
so it never shares the contact blind-index domain; `canonicalJson(v)` is exported from `idempotency.ts`
(the existing private `canonical` — object keys sorted recursively, `undefined` dropped, arrays in order —
then `JSON.stringify`) and `canonicalHash` reuses it. The stored hash can't be dictionary-attacked back to
answers after an erase.

Client intent `form:submit:<formId>:<appointmentId>` in `ESTIMATE_INTENTS_KEY(rid)` storing `{ base, body
}`. The **fill page recovers its own intent** on mount (not `recoverEstimateIntents`, which drops it on
`STALE`): a 2xx or stored code removes it; `STALE` / `FORM_CHANGED` merge `body.changes` as `mine` over the
re-read row (§7.3), show the merge line and require a new Submit. While the intent is `sent` or `unknown`
the page is locked (M3c `pageLocked`) and autosave paused (§7.3).
- `STORED_CODES` gains `FORM_SUBMITTED`, `FORM_INCOMPLETE`, `ANSWERS_REMOVED`, `CUSTOMER_REMOVED`,
  `ANSWERS_UNREADABLE` (`INVALID_INPUT` is already stored).
- Not stored: `STALE`, `FORM_CHANGED`, `FORM_ARCHIVED`, `NOT_ASSIGNED`, `NOT_ON_SITE`, `JOB_CLOSED`,
  `VISIT_ENDED`, `NOT_FOUND`.

### 4.4 Versioning
A submission renders from its own snapshot forever; the snapshot is taken when the row is created (first
write). Before that, `formVersion` guards: the INSERT copies the live form only `WHERE f.version =
$formVersion` and the UPDATE requires `form_version = $formVersion`; a miss → 409 `FORM_CHANGED`. The page
carries (`base' = carryValues(base)`, `mine' = carryValues(mine)`, keeping what passes `draftValueOk`
against the new fields) and runs the same three-way merge (§7.3) when the re-read returns a row (a
colleague's answers survive), else sends `mine'` on revision 0. Dropped answers are listed "Not saved: …".
A row is never re-snapshotted.

### 4.5 Locking
Request-scoped writers take the request row lock first: the draft and submit batches and the photo write
start with `lockRequestSql(org, rid)` (L_req, `invoice-field-writes.ts:42`, `FOR NO KEY UPDATE`), as every
M3c field write does. The erase batch's **first statement** locks all of the customer's requests: `SELECT 1
FROM service_requests WHERE organization_id = $org AND customer_id = $cust ORDER BY id FOR NO KEY UPDATE`.
Every later erase statement (the attachments count and DELETE, the answers UPDATE) runs after any
in-flight writer on those requests has committed, and any writer that starts later waits and then sees
`anonymized_at`. Lock order is request → rows in every path, so no deadlock.

## 5. Writers (`src/lib/tech/form-writes.ts`, `src/lib/admin/form-queries.ts`)

### 5.1 Who may fill, and when
F04: technicians write "notes, photos, materials and forms on jobs they can read"; status, close-out and
money stay native-only. Submissions are app-owned rows the FieldPulse sync never touches, so forms are
allowed on synced jobs. **Native** = `fieldpulse_job_id IS NULL AND hcp_job_id IS NULL` (`ownership.ts`);
FieldPulse- and HCP-synced jobs both take the synced rule.

The writer holds a non-cancelled assignment on **that visit**, and the visit is live (`cancelled_at IS
NULL`); otherwise `NOT_ASSIGNED` / `VISIT_ENDED`. Readers see every submission read-only. On-site window:
- native: the request status is in `BILL_STATUSES` (`arrived`…`completed`), **or** the caller's own row on
  that visit has `arrived_at`, `started_at` or `completed_at` set (a helper who arrived before the lead's tap
  is not refused); `cancelled` → `JOB_CLOSED`; otherwise `NOT_ON_SITE`;
- synced: any request status but `cancelled` (→ `JOB_CLOSED`), because the status is FieldPulse's.
Un-cancel: when a request leaves `cancelled`, 0050 reopens the visit but leaves rows it cancelled cancelled
(step 4 skips them; step 3 runs only when `assigned_to` changes), so the technician gets `NOT_ASSIGNED`
("Ask the office to assign you to this job again.") until the office reassigns. Close-out cancels untouched
open rows (`status-writes.ts:270-273`), so after it only technicians who started work can fill a form late.

**Visit counts** (one rule, `visitCountsSql(p)` / `visitCounts` pure): `p.cancelled_at IS NULL OR EXISTS (an
assignment on p with a progress timestamp or status 'completed') OR EXISTS (a form_submissions row on p)`.
It governs reads (the GET `visit` check), `submittedOn`, links, `missingRequired` and the office label. A
visit a hold ended counts (its submissions count; label `Visit #1 · ended`); a visit cancelled before any
work and with no submission doesn't (`· cancelled`). Writes still need a live visit.

Shared SQL (rendered with `PgDialect`):
- `visitGateSql(org, rid, aid, me)` = `EXISTS (SELECT 1 FROM appointments p JOIN appointment_assignments
  a ON a.appointment_id = p.id WHERE p.id = $aid AND p.service_request_id = $rid AND p.organization_id =
  $org AND a.organization_id = $org AND p.cancelled_at IS NULL AND a.technician_id = $me AND a.status <>
  'cancelled')`.
- `requestGateSql(org, rid, aid, me)` = the request is in `$org`; `(native AND (status IN BILL_STATUSES OR
  the caller's row on $aid has arrived_at / started_at / completed_at)) OR (NOT native AND status <>
  'cancelled')`; and its customer is not erased (`NOT EXISTS (customers c WHERE c.id = r.customer_id AND
  c.anonymized_at IS NOT NULL)`, `schema.ts:894`).
- `formAppliesSql(f, r)` = `(cardinality(f.job_type_ids) = 0 OR r.job_type_id = ANY(f.job_type_ids))`; a
  NULL `job_type_id` (all synced jobs on dev) gets only all-requests forms.

### 5.2 Save draft (`saveFormDraft`)
Input `{ appointmentId, formVersion, baseRevision, saveId, changes }`. Pre-read the row by natural key
(`revision, last_save_id, status, erased_at, form_version, values_encrypted`):
1. `revision = base + 1 AND last_save_id = saveId` → 200 replay, nothing else read.
2. Row exists: `erased_at` → 409 `ANSWERS_REMOVED`; `submitted` → 409 `FORM_SUBMITTED`; `formVersion ≠
   form_version` → `FORM_CHANGED`; the blob must decrypt (else 409 `ANSWERS_UNREADABLE`; unreadable answers
   are never overwritten); `values' = apply(decrypted, changes)` validated against its snapshot.
3. No row: read the form with `organization_id = $org` (missing → 404; inactive → 409 `FORM_ARCHIVED`;
   `version ≠ formVersion` → `FORM_CHANGED`); `values' = apply({}, changes)`.
Measure; encrypt (an empty `values'` stores NULL). One batch:
0. `lockRequestSql(org, rid)`.
1. `INSERT INTO form_submissions (…, form_name, form_version, fields, started_by) SELECT … FROM forms f
   JOIN service_requests r ON r.id = $rid WHERE f.id = $form AND f.organization_id = $org AND f.active AND
   f.version = $formVersion AND requestGate AND visitGate ON CONFLICT (appointment_id, form_id,
   service_request_id) DO NOTHING RETURNING id`.
2. `UPDATE form_submissions SET values_encrypted = $enc, revision = revision + 1, last_save_id = $saveId,
   updated_by = $me, updated_at = now() WHERE organization_id = $org AND (natural key) AND status = 'draft'
   AND erased_at IS NULL AND revision = $baseRevision AND form_version = $formVersion AND requestGate AND
   visitGate RETURNING revision`.
3. Tail `SELECT status, revision, form_version, erased_at, last_save_id, submit_key` of the row.
Zero rows from 2 → in order: replay (as 1 above); no row → the gates as reads → `NOT_ASSIGNED` /
`VISIT_ENDED` / `NOT_ON_SITE` / `JOB_CLOSED` / `CUSTOMER_REMOVED` / `FORM_ARCHIVED` / `FORM_CHANGED` / 404;
`erased_at` → `ANSWERS_REMOVED`; `submitted` → `FORM_SUBMITTED`; `form_version ≠ formVersion` →
`FORM_CHANGED`; gates failing → their codes; else `STALE` `{ revision }`. Success → 200 `{ submissionId,
revision, savedAt }` (201 when step 1 inserted). No audit.

**Archived forms:** an archived form can't be started (step 1's `f.active`, the pre-read, the GET's 409).
An existing row keeps working from its snapshot: step 2 never reads `forms.active`. An active form that
doesn't apply to the job type can be started from `Add a form`.

**Clearing a mistaken draft** needs no new writer: `Clear answers` sends every answered field as `null`; the
row then stores NULL, reads `Not started` on the card and is hidden in the office section.

### 5.3 Submit (`submitForm`)
Same input without `saveId`, keyed; same pre-read (no replay step: the key handles replays); submit
validation on `values'`. Same batch with step 2 also setting `status = 'submitted', submitted_by = $me,
submitted_at = now(), submit_key = $derived` (`derivedId(scope, "form-submit")`, `idempotency.ts:81`), plus
step 2b: `INSERT INTO audit_log (… 'form_submitted', 'form_submissions', s.id, details) SELECT … FROM
form_submissions s WHERE (natural key) AND s.status = 'submitted' AND s.submit_key = $derived AND s.xmin =
pg_current_xact_id()::xid` (the M3c `equipment-writes.ts:84` gate, narrowed to a row this batch actually
submitted; details `{ formId, appointmentId, formVersion }`). Zero rows → first `status = 'submitted' AND
submit_key = $derived` → 200 with the row's revision and `submitted_at` (a takeover re-run; its audit
committed with it); then the §5.2 map, `submitted` → stored `FORM_SUBMITTED`. Success → 200 `{
submissionId, revision, submittedAt }`.

### 5.4 Erasure (`anonymizeCustomer`, `erasure-queries.ts:124`)
Batch order: (0) lock the customer's requests (§4.5); (1) the `customer_erased` audit INSERT computing
`attachmentsDeleted` in SQL (`(SELECT count(*) FROM attachments WHERE organization_id = $org AND
<match>)`); (2) the attachments DELETE … `RETURNING storage_key` (still before the messages it references);
… the existing statements …; the `service_requests` UPDATE; then the answers UPDATE. With (0) holding the
request locks, (1) and (2) see the same set.
- **Answers:** `UPDATE form_submissions SET values_encrypted = NULL, erased_at = now(), updated_at = now()
  WHERE organization_id = $org AND service_request_id IN (SELECT id FROM service_requests WHERE
  organization_id = $org AND customer_id = $cust)`. Status, who and when are kept. New rows and writes on
  the erased customer's requests answer `CUSTOMER_REMOVED`.
- **Attachments:** `attachmentMatch` (`:181`) today is `customer_id = X OR session_id IN sessions`, but
  `addJobPhoto` (`field-queries.ts:595`) writes only `service_request_id`, and the office uploader
  (`api/admin/attachments/route.ts`) writes request files with only `serviceRequestId` and equipment files
  with only `equipmentId`; all survive erase today. The match gains `service_request_id IN (the same
  subquery)` (technician photos and PDFs and the office's request documents) and `equipment_id IN (SELECT
  id FROM customer_equipment WHERE organization_id = $org AND customer_id = $cust)`. The `after()` R2 delete
  takes the returned keys plus the signature keys; the attachments pre-read is dropped.
- **Photos after an erase:** `addJobPhoto` becomes `runBatch([lockRequestSql(org, rid), INSERT … SELECT …
  WHERE NOT EXISTS (customer of the request anonymised) RETURNING id])`; no row → the route deletes the
  uploaded object and answers 409 `CUSTOMER_REMOVED`. The office uploader gets no gate (out of scope: the
  office performed the erase).
- `deleteCustomer` (`crm-queries.ts:1111`) is unchanged: delete detaches; answers stay with the request.
- The erase widening ships as its own commit and test group (a revert of M3d must not revert it).

### 5.5 Office reopen (`reopenSubmission`)
`POST /api/admin/requests/[id]/forms/[submissionId]/reopen` `{ revision }`: `UPDATE … SET status =
'draft', submitted_at = NULL, submitted_by = NULL, submit_key = NULL, revision = revision + 1, updated_at
= now() WHERE id = $sid AND organization_id = $org AND service_request_id = $rid AND status = 'submitted'
AND erased_at IS NULL AND revision = $revision RETURNING revision`. Zero rows → missing → 404; a draft →
200 `{ changed: false }`; erased → `ANSWERS_REMOVED`; else `STALE`. Audit `form_reopened` `{ formId,
appointmentId }`. Nobody is notified; the office tells the technician.

### 5.6 Office form writes
`createForm` (§4.1; ≤ 100 forms per org including archived → 409 `LIMIT_REACHED`); `updateForm` (`fields`
replaced whole, validated by `formDefinitionSchema`; `jobTypeIds` must be the org's job types, archived
ones included → else 400 `UNKNOWN_JOB_TYPE`). Audit: `form_created` `{ formId }`, `form_updated` `{ formId,
version, fieldCount }`, `form_archived` / `form_restored` `{ formId, version }`.

## 6. Routes (all `force-dynamic`)

`frontGates` gains a `limit` parameter (`frontGates(request, id, bucket, limit =
RATE_LIMITS.adminMutation)`, `invoice-route-guards.ts:66`) and `RATE_LIMITS.techFormDraft = { maxRequests:
60, windowMs: 60_000 }`. `techFormPreamble` = front gates with bucket `form` (submit, 30/min) or
`form-draft` (draft PUT, 60/min: a page sends ≤ 20/min) plus `isUuid` on the form id, then readable job,
then the body's `appointmentId` (lowercased, as `resolveTarget` does, `:120`) against the caller's
`findTechAssignments` rows → `NOT_ASSIGNED`, then the live-visit check → `VISIT_ENDED`, then the on-site
window (§5.1); submit then reads the key. Writers re-check everything inside the batch.

| route | gate | success |
| --- | --- | --- |
| `GET /api/tech/jobs/[id]/forms?visit=<aid>` | session, readable job, `visit` a visit of the request that counts (§5.1; else 404), rate `tech:form:read:<user>` (`adminRead`, 60/min) | `{ visitId, visitNumber, myVisit, canWrite, writeBlockedReason, forms: [{ formId, name, description, required, submission: { id, status, revision, hasAnswers, erased, updatedAt, submittedAt, submittedByName } \| null, submittedOn: { appointmentId, appointmentNumber, submittedAt } \| null }], otherForms: [{ formId, name }] }`. `forms` = active applicable forms + forms with a row on this visit. `submittedOn` = the newest submitted copy on another visit that counts, when this visit has no submitted row. `hasAnswers` = `values_encrypted IS NOT NULL` (no decrypt). Order: required and not submitted anywhere first, then name |
| `GET /api/tech/jobs/[id]/forms/[formId]?visit=<aid>` | same; form read with `organization_id = $org` (foreign id → 404) | `{ form: { name, description, version, fields }` (snapshot when a row exists, else live; archived with no row → 409 `FORM_ARCHIVED`) `, submission: { id, status, revision, values, updatedAt, updatedByName, updatedByMe, submittedAt, submittedByName, erased } \| null, submittedOn, myVisit, canWrite, writeBlockedReason }`; undecryptable → `values: null` |
| `PUT …/forms/[formId]/draft` | `techFormPreamble` (`form-draft`), no key | 201/200 `{ submissionId, revision, savedAt }` |
| `POST …/forms/[formId]/submit` | `techFormPreamble` (`form`) + key | 200 `{ submissionId, revision, submittedAt }` |
| `GET /api/tech/jobs/[id]/site` | session, `isUuid`, readable job, rate `tech:site:read:<user>` (`adminRead`) | §7.6 |
| `GET /api/admin/settings/forms` | admin session, `adminRead` | `{ forms: [{ id, name, questionCount (non-heading), jobTypeIds, required, active, version, updatedAt, submissionCount }] }` |
| `POST /api/admin/settings/forms` | admin, `adminMutation` | 201/200 `{ id }` |
| `GET /api/admin/settings/forms/[id]` | admin, `isUuid`, `organization_id = $org` (foreign → 404) | `{ form, submissionCount }` |
| `PATCH /api/admin/settings/forms/[id]` | same, `adminMutation` | `{ version }` |
| `GET /api/admin/requests/[id]/forms` | admin, `isUuid`, request in org | `{ submissions: [{ id, formId, formName, formVersion, appointmentId, appointmentNumber, visitState: 'live' \| 'ended' \| 'cancelled', status, revision, erased, unreadable, fields, values, updatedAt, updatedByName, submittedAt, submittedByName, visitHasTechnician }], missingRequired: [{ formId, name }] }`. Omitted: `status = 'draft' AND erased_at IS NULL AND values_encrypted IS NULL`. Undecryptable → `values: null, unreadable: true`, never a 500. `missingRequired`: every request except `cancelled`, counting submissions on visits that count; on a completed request only forms with `f.created_at < r.completed_at` |
| `POST /api/admin/requests/[id]/forms/[sid]/reopen` | admin, `isUuid` ×2, `adminMutation` | `{ revision, changed }` |

`myVisit` = the caller has any assignment row on this visit (the job page's `?visit=` rule,
`field-queries.ts:156-161`). `writeBlockedReason` is one of `null`, `not_assigned`, `visit_ended`,
`not_on_site`, `job_closed`, `archived`, `answers_removed`, `customer_removed`, `unreadable`, `submitted`
(§7.3 maps each). Admin routes follow the job-types routes (`getAdminSession`, `admin:forms-<op>:<user>`,
`readJsonBody`, `VALIDATION_ERROR` + `details.path` → `settingsFieldErrorCopy`). Logs carry codes and ids
only.

## 7. Client

Tech: base shadcn primitives, `h-11` targets, sentence case, human errors, "job". Admin: admin-ui
primitives, `SectionCard`, "request". One `plural(n, one, many)` helper in `src/lib/format/plural.ts`.

### 7.1 Forms tab and builder
- **Tab:** active forms by name, archived last; each row: name, `1 question` / `N questions`
  (non-heading), `All requests` or job type names (from `GET /api/admin/settings/job-types`, which includes
  archived ones), `Required` chip, `Archived` chip, last changed. Empty: "No forms yet. Forms you build here
  show in the technician app." + `New form`.
- **Builder header:** `Back to forms` (`/admin/settings?tab=forms`), title (the name or "New form"), name,
  description, `Applies to` (`All requests` / `Some job types` + checkboxes of active job types, plus any
  archived ones already in `jobTypeIds` as ticked rows "<name> (archived)"; none at all → "No job types
  yet. Add them on the Job types tab."), `Required form` switch with "Technicians see this form as Required
  and are reminded before closing out. Nothing is blocked."
- **Questions:** type select (`Checkbox`, `Yes / no`, `Short answer`, `Long answer` (disabled at 10),
  `Number`, `Choice`, `Heading`), label, help, `Required` (hidden for `Heading`), `Allow N/A` for `Yes / no`
  ("Use N/A for items that don't apply to every system."), for `Number` a `Unit` with a datalist (`psi`,
  `°F`, `A`, `V`, `µF`, `inWC`, `microns`, `CFM`) and `Usual range` from/to ("Readings outside it are still
  saved, with a note."), for `Choice` an options editor. `Move up` / `Move down`, `Add question below`,
  `Remove` with a 5-second `Undo`; `Add question` at the end (disabled at 60). Hint: "Need a photo? Ask
  technicians to add it in the technician app's Photos card."
- **Pure helpers** (`src/lib/admin/form-builder.ts`): `addField(at)`, `moveField`, `removeField`,
  `changeType` (keeps label and help; keeps `required` except `heading` → false; drops `options`, `unit`,
  `usualMin/Max`, `allowNa`; `choice` seeds two empty options), `newFieldId`, `newOptionId`,
  `builderErrors(form)` (one message per rule, §8), `firstSaveOutcome`.
- **Save** is disabled while `builderErrors` is non-empty or nothing changed. The reasons are listed above
  it under "Fix these to save:", each linking to its row, for fields the admin has touched, and all of them
  after a tap on the disabled Save area. 409 `STALE` keeps the draft with `Reload`; other failures
  "Couldn't save the form. Please try again." When `submissionCount > 0`: "Forms already started keep the
  earlier version." `Discard changes` (an edit with changes) resets to the loaded row.
  `useUnsavedChangesGuard` (`use-unsaved-changes-guard.ts:21`) while dirty, which holds in-app links such
  as `Back to forms`; the confirm is rendered by the builder as `settings/page.tsx` does; the browser's
  Back button is not held. `Archive` / `Restore` (confirm "Archive this form? Technicians can't start it
  any more. Forms already started can still be finished, and answers are kept."); while dirty: "Save or
  discard your changes first."

### 7.2 Forms card
- **Visit:** `?visit=` if present, else `summary.assignment.appointmentId`, else `summary.activeVisitId`
  (the summary, `field-queries.ts:154-161`, gains this already-computed field), else "No visit on this job
  yet." Header names it when the job has several visits (`Visit #2`).
- **Chips** (pure `formChips`, in precedence): `erased` → `Answers removed`; submitted here → `Submitted`;
  `submittedOn` → `Submitted on visit #1`; else `Draft` when `hasAnswers`, `Not started` otherwise, with
  `Required` beside them for a required form. Empty card: "No forms for this job." `Add a form` (writers)
  opens a sheet of `otherForms` with a filter above 10 ("No other forms.").

### 7.3 Fill page
- **Header:** `Back to job` → `/tech/jobs/[id]`, plus `?visit=<aid>` only when `myVisit`; name,
  description. With `submittedOn`: "Submitted on visit #1 · Nov 6. Fill it in again only if this visit needs
  it." + `View visit #1's answers` (that visit's fill page, read-only, `&from=<aid>`; its back link reads
  `Back` and returns to `from`). Pure `backHref`.
- **Controls:** `checkbox` 44 px row; `yes_no` radio group `Yes` / `No` (/ `N/A`); texts `Input` /
  `Textarea` with `maxLength` and a count from 80 % of the limit; `choice` radio list; `heading` sub-title;
  required questions show `Required`. `number`: `Input inputMode="decimal"`, unit suffix, a `±` button
  (`h-11`, `aria-label="Switch sign"`, toggles a leading `-`, empty → `-`) shown when `usualMin` is unset or
  below 0. Under it: `partial` → "Not saved yet. Finish the number."; `invalid` → "Enter a number like 12.5
  (up to 3 decimal places)."; `out_of_bounds` → "Enter a number under 1,000,000."; a valid outside reading
  → "Outside the usual range (5–15 °F)" / "(at least 5 °F)" / "(at most 15 °F)", no unit → "(5–15)".
- **Touched and sent:** a field becomes touched when the technician changes it. Each PUT freezes its body.
  When it lands, `base` = the previous base with that body's changes applied, and a field leaves `touched`
  only if its current value equals the value in the landed body; fields edited during the flight stay
  touched and go in the next PUT. `changes` = every touched field: its parsed value, `null` when emptied,
  and for a `partial` / `invalid` / `out_of_bounds` number its **last valid value** (never a deletion; not
  sent if it never had one).
- **Autosave** (`nextSaveState`, pure): a save starts 1.5 s after the last change, on blur of a text field,
  and on `visibilitychange → hidden` / `pagehide` (these bypass the 3 s floor but keep one in flight and
  any back-off; `pagehide` only when dirty). One write in flight; an unknown result is retried with its own
  body and `saveId` before any newer one; otherwise ≤ one PUT per 3 s. Retries wait `Retry-After` or 3 s,
  doubling to 30 s; a new edit doesn't reset the wait. Every PUT ≤ 60 KB uses `keepalive: true`. Nothing is
  stored in the browser except a pending submit intent (sessionStorage, removed on any definitive answer).
- **Status line** in the header; the footer beside `Submit form` repeats it (only the footer copy is
  `aria-live="polite"`, and `Saving…` is not announced); the footer is static while a text or number input
  has focus, so the iOS keyboard doesn't cover the input.

  | state | copy |
  | --- | --- |
  | no row, nothing typed | (blank) |
  | loaded draft | `Saved · 2:41 PM` today, `Saved · Nov 6, 2:41 PM` earlier; `· Sam` when `updatedByMe` is false |
  | saving | `Saving…` |
  | landed, no unparsed input | `Saved · 2:41 PM` |
  | any `partial` / `invalid` / `out_of_bounds` number | `Not saved yet: 1 answer isn't a number.` / `Not saved yet: 2 answers aren't numbers.` (never `Saved`) |
  | network, 5xx, 429 | `Not saved yet. Retrying…` |
  | 401 | stops; `You've been signed out. Sign in again, then open this job again.` + `Sign in` (`/tech-login`) + the "Not saved" list |
  | 400 `{ path: ["values"] }` | stops; `This form is too long to save. Shorten the longest answers.` (no same-body retry; the next edit re-enables saving) |
  | other 400 | stops; `Couldn't save your answers.` + `Try again` (same body and `saveId`); later edits wait |
  | a refusal code or 404 during autosave | re-GET; render that GET's `writeBlockedReason` (404 → "This form is no longer on this job.") + the "Not saved" list |
  | submit `sent` | `Submitting…`, page locked |
  | submit `unknown` | page locked; `MAY_NOT_HAVE_SAVED` + `Try again` (same body, same key), as M3c `pageLocked` |
  | submitted | `Submitted · Nov 7, 2:41 PM · Alex Rivera` |

  The "Not saved" list shows unsaved answers read-only ("Not saved: Suction pressure · 118 psi", via
  `answerText`) so they can go in the on-site note.
- **Read-only reasons** (pure `readOnlyCopy`): `not_assigned` "Only a technician on this visit can fill in
  its forms." · `visit_ended` "This visit has ended." · `not_on_site` "Arrive at the job first." ·
  `job_closed` "This job is closed." · `archived` "This form was archived by the office." ·
  `answers_removed` "These answers were removed." · `customer_removed` "This job's customer was removed." ·
  `unreadable` "These answers can't be shown." · `submitted` (the status line only). On an un-cancelled job
  `not_assigned` adds "Ask the office to assign you to this job again." when the caller's row is cancelled.
- **Merge** (`mergeDraft(base, mine, theirs)`, pure; `mine` = the touched fields): touched fields take
  `mine`, others `theirs`; rendered at once, saved on `theirs.revision`. When a field not touched here
  changed from `base`, the page shows once per load "Someone else changed this form. Their answers are
  shown, and yours are kept." If `theirs` is submitted: read-only, "<name> submitted this form. Your last
  changes weren't saved." + the "Not saved" list.
- **Clear answers** (writers, a draft with answers): confirm "Clear all answers on this form?" `Clear
  answers` / `Go back` → every answered field sent as `null`; partial number inputs reset.
- **Submit:** refused on the client while any number isn't a value ("Fix the highlighted answers.", focus
  on the first) or required answers are missing ("Answer this." per question, top line "1 required question
  isn't answered." / "2 required questions aren't answered."). Else confirm "Submit “<form name>”? After
  this, only the office can reopen it." `Submit` / `Go back`. Submit cancels the debounce, waits for the
  write in flight, then sends with the latest revision. `STALE` / `FORM_CHANGED` → merge (or carry), unlock,
  show the line, new tap and confirm (a new body mints a new key). Stored `FORM_SUBMITTED` → refetch. After
  success: read-only, primary `Back to job`.

### 7.4 Close-out reminder (native jobs)
The job page passes the card's required forms with no submitted copy on any visit that counts to
`close-out-sheet.tsx`. It renders "Not submitted yet:" and one `h-11` link per form, "Fill in “<name>”", to
the fill page for the card's visit, in both states: under the blocker list when blocked (no confirm, the
`{blocked.length === 0 && …}` branch at `close-out-sheet.tsx:145`), and when ready in this order: invoice
and parts warnings (`:119`), the reminder, the confirm. Pure `reminderVisible`. Blockers, the close-out
route and `status-writes.ts` are unchanged.

### 7.5 Office Forms section
Each submission: form name, `Visit #N` (`· ended` / `· cancelled` from `visitState`), `Draft` /
`Submitted` / `Answers removed` / "These answers can't be shown.", who and when, answers via `answerText`
with the range note. `missingRequired`: "Not submitted yet: <name>" on open requests, "Required, not
submitted: <name>" (warning tone) on completed ones. `Reopen` confirm "Reopen this form? The technician can
change the answers and submit again."; when `visitHasTechnician` is false it adds "No technician is on this
visit any more."; `STALE` → "Someone else changed this form. Reload to see the latest."

### 7.6 Site page (`/tech/jobs/[id]/site`, `src/lib/tech/site-queries.ts`)
Anchored on the readable request (`findReadableJob`, `ownership.ts:134`): customer, location and address
come from `service_requests` server-side; every table carries `organization_id = $org`. **Never show the
customer's jobs at another address, and never guess an address.** Dev: synced requests have neither
`address_encrypted` nor `location_id` (0/207; the FieldPulse import writes addresses only to `customers`,
`fieldpulse/import/customer-split.ts`); native requests with a customer 75/76 with an address; strict
`normalizeAddress` finds no false or near match. **Site match** (`siteScope`, pure decision over SQL reads):
- Candidates: the customer's other non-cancelled requests (newest 500) with `location_id` and decrypted
  `address_encrypted`, compared by `normalizeAddress` (private in `admin/location-queries.ts:15`,
  exported). A candidate with no address and no location never matches.
- `location`: this request has a `location_id` → candidates with it, plus location-less candidates whose
  normalised address equals this request's (when it has one).
- `address`: no location but an address → candidates with an equal normalised address.
- `none`: neither, or the customer is erased → no other job matches. No fallback to the customer's address.

GET `{ scope, title, pastJobs, unaddressedCount, openEstimates, membership, hasCustomer }`:
- `title`: the location's `label`, else "Service address".
- `pastJobs` (newest 20 matches), excluding unstarted future jobs (`status IN
  ('pending','assigned','scheduled') AND COALESCE(scheduled_date, arrival_window_start) > now()`), ordered by
  `COALESCE(completed_at, scheduled_date, created_at) DESC, id`: `{ id, referenceNumber, date, status,
  jobTypeName or issueLabel(issue_type), leadTechnicianName (first name), submittedFormNames (≤ 3) }`.
  Never description, notes, addresses, contact fields or signature names.
- `unaddressedCount`: the customer's other non-cancelled requests with neither address nor location.
- `openEstimates`: `status = 'open'`, `expires_at` NULL or future, `service_request_id` = this request or a
  matched one (request-less excluded; under `none` this job's own still list): `{ id, label (estimateLabel;
  FieldPulse: title or "Estimate"), createdAt, totalCents, optionCount, thisJob, fromFieldPulse }`.
- `membership`: `{ state: 'member', planName, startedAt, currentPeriodEnd, visitsPerYear, upcoming: [{
  dueDate, status, thisJob }] } | { state: 'none' } | { state: 'withheld' }`. It is evaluated only when
  this request has a normalised address, the customer has ≤ 1 `customer_locations` row, and **every**
  non-cancelled request of the customer (counted in SQL, no cap; cancelled ones don't count) has an
  address normalising to that same one; otherwise `withheld`, whether or not a membership exists (existence
  is not leaked). Evaluated: the active `customer_memberships` row (≤ 1) with its plan → `member`, else
  `none`. `upcoming` = up to 3 `membership_visits` with status `scheduled` / `generated` and `due_date >=`
  the start of today in the business timezone. No price, billing or benefits. (`account-tools.ts` readers
  are not reused: they serve the bot's contract.) Memberships belong to the customer, so "Member" at a
  landlord's other building would invite member pricing the plan may not cover.
- Page: `Back to job`, title, `At this address`: `Past jobs`, "3 earlier jobs have no saved address." when
  `unaddressedCount > 0`, `Open estimates`, then `Membership` with `Upcoming maintenance`. Rows aren't links,
  except this job's open estimates for the lead (M3c page).
- Job page `Site` card: "4 past jobs · 1 open estimate · Member" (zero parts omitted; all zero → "No history
  at this address yet."; `none` → "No saved address", with " · 1 open estimate" when this job has one; no
  customer → "No customer on this job yet."). Not tappable when the page would be all-empty.

### 7.7 Photos (`job-photos-card.tsx`)
Today the card sends the raw file, shows one `PHOTO_UPLOAD_FAILED` ("Couldn't upload that photo. Try
again.", `job-page-state.ts:19`) and renders every row as `<img>`; the route allows jpeg/png/webp/heic/pdf
by magic bytes up to 20 MB.
- "Quality: Standard · Change": `Change` (`h-11`) expands an inline radio pair `Standard` / `High`
  ("Standard saves data. High keeps more detail.") that collapses on pick; remembered in `localStorage`
  `tech:photo-quality` (try/catch; default `standard`).
- Resize (`photo-resize.ts`: pure `resizePlan` + thin browser adapter): `HTMLImageElement` + `await
  img.decode()` (EXIF orientation applied on draw), drawn onto a canvas at the target size, JPEG. Steps until
  the blob is ≤ `TECH_UPLOAD_LIMIT_BYTES` (4 × 1024 × 1024, in a pure `src/lib/tech/upload-limits.ts` the
  route also imports): standard 1600 px q 0.8 → 1600/q 0.7 → 1200/q 0.7 → 900/q 0.7; high 3200/q 0.9 →
  3200/q 0.8 → 2400/q 0.7 → 1600/q 0.7; never upscale. Still over, or decode failure with an original over
  4 MB → "This photo can't be prepared on this phone. Take it again, or use a smaller photo."; decode failure
  ≤ 4 MB → the original. Re-encoding drops EXIF (GPS and capture time).
- A failed upload keeps the prepared blob (or the PDF `File`): "Couldn't upload that photo." / "Couldn't
  upload that file." with `Try again` and `Discard` (`CUSTOMER_REMOVED`: its copy and `Discard` only); `Take
  photo` and `Add file` stay disabled until one is chosen, and during any upload. Success: "Photo uploaded."
  / "File uploaded."
- `Add file` (`accept="application/pdf"`): over 4 MB → "This file is too large. The limit is 4 MB.";
  non-image rows render as a file tile linking to the signed URL (`target="_blank"`), which fixes today's
  broken `<img>` for office PDFs.
- The route enforces the 4 MB limit (400 `INVALID_INPUT`, same copy), gains `isUuid` on POST, the request
  lock and the erased-customer refusal (§5.4). Why 4 MB: Vercel Functions cap request bodies at 4.5 MB
  (platform docs; measure, §11).

## 8. Copy (beyond the tables above)

| where | copy |
| --- | --- |
| Codes | FORM_CHANGED "The office changed this form. Check your answers." · FORM_SUBMITTED "This form was already submitted." · the read-only reasons in §7.3 for NOT_ASSIGNED, VISIT_ENDED, NOT_ON_SITE, JOB_CLOSED, FORM_ARCHIVED, ANSWERS_REMOVED, CUSTOMER_REMOVED, ANSWERS_UNREADABLE |
| Builder errors (`builderErrors`, one per rule) | "Give the form a name." · "Keep the name to 80 characters or fewer." · "Keep the description to 300 characters or fewer." · "Add at least one question." (headings don't count) · "Up to 60 questions and headings." · "Up to 10 long answers per form." · "Add a label." · "Keep the label to 120 characters or fewer." · "Keep the help to 200 characters or fewer." · "Keep the unit to 12 characters or fewer." · "Add at least two options." · "Up to 12 options." · "Each option needs a label." · "Keep each option to 60 characters or fewer." · "Two options have the same label." · "The low end can't be above the high end." · "Pick at least one job type, or choose All requests." · "This form is too large. Remove some questions." (64 KB) |
| Builder other | NAME_TAKEN "A form with this name already exists." · STALE "Someone else changed this form. Reload to see their changes." · LIMIT_REACHED "You've reached the limit of 100 forms." · UNKNOWN_JOB_TYPE "One of those job types no longer exists." |
| Site rows | "Nov 3, 2026 · Maintenance · Completed · Alex · Forms: Maintenance checklist" · "Estimate · Nov 6 · 2 options" "Up to $4,812.00" `This job` `From FieldPulse` · member: "<planName> · Member since Mar 2026 · Paid through Apr 1, 2027" (the last part omitted when null), "2 visits a year", "May 1, 2027 · Scheduled" / "· Booked" (generated) + `This job` · none: "Not a member." · withheld: "Membership is on the customer's account. Ask the office." · empties "No other jobs at this address.", "No open estimates.", "This job has no saved address, so there's no site history.", "No customer on this job yet. Ask the office to add one." |

Canon: request (admin) / technician / sign in / cancelled / Unicode … and “ ” / sentence case / no
`err.message`. Dates in the business timezone (`BUSINESS_BASE_LOCATION.timezone`, as `job-display.ts:8`).

## 9. Tests

No jsdom/RTL; component logic lives in pure helpers.

**Pure:** `formDefinitionSchema` (types, ids, option ids, `allowNa`, unit, usual range, heading never
required, caps, ≥ 1 non-heading); `draftValueOk` (controls refused, `null` valid); `numberInputState`
("1,200" → 1200; "1," / "1,2" / "12." / "-" partial; "1e3" / "12.3456" invalid; "2000000" out of bounds);
the `changes` builder ("12" landed then "12." → body still 12; emptied → `null`; never-valid partial → not
sent; an edit during flight survives the landing); the 128 KB measure (control characters, multibyte,
emoji); `missingRequired` (`na` satisfies); `answerText`; `carryValues`; `mergeDraft` (touched wins, banner
only for foreign changes, the carried FORM_CHANGED path keeps a colleague's answers); `nextSaveState`
(debounce, one in flight, unknown retried first with its `saveId`, 3 s floor, hidden/pagehide bypass,
back-off schedule, 400 variants, 401 stop, never `Saved` with unparsed input, submit waits, locked while
submit `sent`/`unknown`); `readOnlyCopy` for every reason; status-line table; `backHref`; card visit pick;
`formChips` precedence incl. `erased`; `visitCounts` (live, hold-ended with progress, with a submission,
cancelled untouched); `reminderVisible` (blocked and ready); `plural`; builder helpers incl. `changeType`,
every `builderErrors` rule, archived job type ids kept, errors only for touched fields, `firstSaveOutcome`
(201, replay with a diff, unknown then re-POST); `formApplies`; `siteScope` (location / address / none,
address-less candidates never match, no fallback, membership `withheld` for a second location, an
address-less sibling or a different address, cancelled requests ignored); site formatters; `resizePlan`
(both step lists); `qualityFromStorage`.

**SQL renders (`PgDialect`):** the 0058 trigger body differs from 0050's only in the `v_has_progress`
predicate; draft and submit batches start with `lockRequestSql`, carry `organization_id` on each table,
`visitGateSql` with `a.appointment_id = p.id`, `requestGateSql` (both windows, the own-row arm, not
anonymised); the submit audit gated on `status`, `submit_key` and xmin; `visitCountsSql`; site queries' org
predicates; the erase batch order (request lock → audit count → attachments DELETE … RETURNING → … →
`service_requests` UPDATE → answers UPDATE) and both new `attachmentMatch` arms; the photo batch.

**Route tests:** every gate and code; 201/200; foreign form id → 404 (tech and admin); the 31st draft PUT in
a minute passes and the 61st is 429; stored envelopes and the request-hash input contain no submitted
string; site payload has no key like `phone`, `email`, `description`, `address`, `signature`; photo POST
refuses > 4 MB, a non-UUID id and an erased customer; `status-writes.test.ts` and the close-out route tests
pass unchanged.

**Integration (`tests/integration/field-forms.test.ts`, `VITEST_INTEGRATION=1`, dev DB, throwaway org by
SQL, never the FieldPulse-connected default org):**
(a) `createForm` twice with one token → one row; an empty definition → 400, no row; stale PATCH → STALE;
duplicate name → NAME_TAKEN;
(b) done-when: 4 checkboxes (2 required) + a number with a usual range → a helper saves 2 answers and an
out-of-range reading → GET shows them → the same `saveId` again → 200 replay (also after a colleague's
long answer pushes the document near the cap); tick, lost response, untick, retry the first then the
second → unticked; submit missing a required → FORM_INCOMPLETE → full submit → `submitted`, one audit row;
same key → replay; new key → FORM_SUBMITTED; draft save → FORM_SUBMITTED;
(c) submit takeover: commit the batch, leave the key claimed past the takeover window, re-send → 200, one
audit row; submit, reopen, resubmit → two audit rows; a first-insert batch whose update misses writes no
audit row;
(d) two technicians from revision 0 concurrently → one lands, one STALE;
(e) office saves version 2 after a version-1 draft → the draft submits on version 1; on a new visit
technician B answers on version 2, technician A's version-1 save → FORM_CHANGED, the carried merge keeps
B's answers;
(f) gates: only on visit #1, saving on #2 → NOT_ASSIGNED; a native helper whose own row is `arrived` while
the request is still `scheduled` → allowed; a helper with no progress then → NOT_ON_SITE; cancelled visit
→ VISIT_ENDED for writes; another org → 404; `cancelled` → JOB_CLOSED; native `completed` → allowed;
(g) synced job (`fieldpulse_job_id`, `assigned_to`, lead row from the trigger), status `scheduled` → the
technician saves and submits; `cancelled` → JOB_CLOSED; a sync-style UPDATE setting `assigned_to`,
`scheduled_date` and both window ends to NULL → the visit still exists (times NULL, lead demoted), the
submission survives and the office GET lists it; the same on a native `completed` job with no progress;
a visit with no submissions under the same UPDATE is deleted, as in 0050;
(h) archived: an existing draft saves and submits; starting it on a new visit → FORM_ARCHIVED; an active
non-applicable form can be started; `Clear answers` → `values_encrypted` NULL, `Not started`, hidden in the
office GET;
(i) erase: an attachment on the request and one on the customer's equipment inserted by SQL; after
`anonymizeCustomer` → values NULL, `erased_at` set, both attachment rows gone, their keys handed to the
cleanup (mocked), `attachmentsDeleted` = 2; a later save → ANSWERS_REMOVED; a new form → CUSTOMER_REMOVED;
erase interleaved with a first save, and with a photo insert, on two connections → no ciphertext and no
attachment row left; `deleteCustomer` keeps submissions;
(j) reopen; stale → STALE; draft → `changed: false`; resubmit;
(k) an undecryptable blob → tech GET `unreadable`, a save → ANSWERS_UNREADABLE, admin GET `unreadable`, no
500;
(l) site: location scope lists same-location and same-address location-less jobs, never the customer's
other location or another customer; address scope; a synced job → `none`, `unaddressedCount` counted, its
own estimate listed; a future unstarted job excluded; estimates of matched requests only; membership
`member` for a single-address customer, `withheld` for a two-location customer (member or not) and for a
native job with an address-less synced sibling; a cancelled request at another address ignored; overdue
visits excluded; another org never appears;
(m) `missingRequired` on a completed request; not on a cancelled one; a submission on a hold-ended visit
counts, one on a visit cancelled before any work doesn't; a required form created after completion isn't
listed;
(n) audit rows carry ids and enums only.

**Browser walk** (throwaway org via `createOrgCore`; everything by SQL; mint sessions with `MINT_ORG_ID`
and assert user and org; queue guard before, zero `communication_jobs` after; 390×844). Data: customer A
with one location; two past requests at it, an open estimate on one, an active membership with a scheduled
visit; the native job (with a job type) with a lead and a helper. Customer B, another customer at a
different address, with one request. A synced job for A's technician. Walk: admin `New form` →
"Maintenance checklist" (4 checkboxes, a `psi` number with a usual range, Required form) → Save → the URL
becomes the form's → the job page shows Forms first with `Required` · `Not started` → Site lists A's 2 past
jobs (none of B's), the estimate and the membership → the helper (arrived) fills half incl. an out-of-range
reading and a "12." (`Not saved yet: 1 answer isn't a number.`) → finishes it → `Saved` → reload → answers
there → the lead's session sees the same draft → the helper taps Done → the lead taps Close out → the sheet
shows "Fill in “Maintenance checklist”" above the confirm; follow it → submit → `Back to job` → close out →
the admin sheet shows the answers with the range note → the synced job: Forms card writable, no close-out,
Site "No saved address" → erase A → "Answers removed". Photo upload can't run on dev (no R2): pure plan and
mocked route tests; the quality line and resize are checked on a real phone after deploy.

## 10. Out of scope

- Required forms blocking close-out (row 126, deferred).
- Video; photo, signature and file form fields; conditional logic, calculated fields, multi-select,
  dates, per-field notes, sections as a model, templates, copying, drag-to-reorder, builder preview.
- Non-job and PDF-overlay forms (row 127), portal forms, emailing or a PDF of a submission.
- Offline mode (row 124) and any browser copy of answers beyond the pending submit intent.
- Office editing of answers; reports over answers; deleting a draft row (`Clear answers` empties it).
- Status, close-out and money on synced jobs; forms for FieldPulse's extra technicians; re-arming a lead
  row when a job leaves `cancelled` (the office reassigns).
- `/tech-login` return-to (`next=`); an erased-customer gate on the office uploader.
- Keying the photo upload; server-side image processing; an upload queue.
- Site page: equipment, invoices, contact details, links into other jobs, request-less estimates,
  membership at multi-address customers, price or benefits; synced history (no address on file).

## 11. Rulings and things not verified

Rulings:
1. Drafts server-only; changes + revision gate + `saveId` replay checked first, no key; submit keyed with
   `submit_key`, an in-batch audit gated on the submitted row, and a labelled-HMAC request hash.
2. Drafts never fail on content; a half-typed number keeps its last valid value; usual range is advice.
3. One submission per visit per form; per-visit write right with the own-row arrival arm; native and
   synced jobs (synced: FieldPulse's first technician).
4. Submissions keep their visit: NO ACTION FK and the 0050 trigger with one added predicate.
5. One "visit counts" rule for reads and reminders; writes need a live visit.
6. Attach by job type plus picked active forms; archived forms can't be started, existing rows continue;
   forms exist only with ≥ 1 question.
7. Snapshot at row creation; `formVersion` + carry + three-way merge.
8. Locked after submit; only the office reopens; `Clear answers` instead of discarding drafts.
9. Row 126 deferred: Required + reminders (card, close-out sheet in both states, office incl. completed).
10. Request locks first everywhere, erase included; erase nulls answers, refuses new answers and photos,
    deletes request and equipment attachments by `DELETE … RETURNING`; delete-customer keeps answers.
11. Site page matches by location or saved address only; membership `member | none | withheld`.
12. Photo quality per device; 4 MB on client and route; PDFs in, video out. Rows 131 and 122 `partial`.

Verified in review: synced requests carry no address, location or job type on dev (0/207); 191/207 synced
jobs have a gateable lead row; native 75/76 with an address; `normalizeAddress` has no false or near match
on dev; `useUnsavedChangesGuard` is self-contained; no code path deletes a visit directly.

Not verified (plan or deploy):
- The Vercel 4.5 MB body limit on this route (measure a 5 MB upload on a preview).
- iOS camera captures arrive as JPEG; `img.decode()` memory on 48 MP captures on older iPhones.

## 12. Review focus (for the plan and code reviews)

- The 0058 trigger replacement is byte-for-byte 0050 plus one predicate.
- Draft writes: replay first; changes applied to the read document under the revision gate; touched-set
  bookkeeping across in-flight writes; merge and carry; half-typed numbers never deleting.
- Locking and erasure: request locks first in form, photo and erase batches; the erase batch order.
- Submit: stored codes; `submit_key` takeover; the narrowed audit gate; the labelled HMAC.
- Site scope and the membership states.

## 13. Docs

`page-tech` (Forms card and page, synced jobs, reminder, Site page, photos), `page-settings` (Forms tab and
builder), `page-requests` (Forms section, reopen), `page-customers` (erase covers answers and request /
equipment attachments; photos refused after erase), `replica/features.csv` rows 122/125/126/131,
`replica/parity.md`, `replica/build-log.md`, `replica/architecture.md` annotation (forms on synced jobs,
trigger change, video cut, row 126 deferred, office-only reopen), memory.
