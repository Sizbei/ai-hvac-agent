# M3d Forms + site view — adversarial review log

## Spec round 1 (v1 → v2), 2026-11-07 — 3 critics (A data/concurrency/erasure/security, B UX/feasibility, C codebase reality/simplicity)

Counts: A 0 blocker / 6 major / 12 minor; B 1 blocker / 10 major / 14 minor; C 0 blocker / 6 major / 11
minor. Lead rulings 1–8 were binding and are marked (L1–L8).

Applied:
- Drafts server-only: the sessionStorage mirror is cut (it had no base values, so its merge on load could
  resurrect stale answers; plaintext on the phone after erase) (C1, A1; L1).
- `saveId` / `last_save_id` dropped: a retry of the technician's own landed write gets STALE, the
  in-memory `mergeDraft` keeps every changed field (all equal the server's), finds no foreign change and
  saves once more with no banner; stated in §4.2 with the reason a plain LWW can't work (one ciphertext,
  no interactive transaction) (C2, C17; L1).
- Drafts never fail on content: draft validation is type/parse only, the client sends only parseable
  values (`draftSafeValues`), a half-typed number stays unsaved; a draft 400 is a bug with its own status
  line that stops autosave; number min/max became an advisory `usualMin`/`usualMax` with "Outside the
  usual range"; submit checks required + parse only (B1 blocker, B M1, A8 partly; L2).
- Row 126 deferred: `required_for_close_out` → `required`; no change to `closeOutRequest`, `Blocker` or
  `closeOutBlockers`; the close-out sheet shows a non-blocking reminder with "Fill in “<name>”" links;
  row 126 → `no` with a note; regression item "close-out tests pass unchanged" (C4; L3). A2, A11 and the
  close-out race paragraph are moot.
- `deleteCustomer` unchanged: answers stay with the detached request like notes and photos (C3; L4).
- Photo erasure: the attachments DELETE returns `storage_key` and feeds the `after()` cleanup, the
  pre-read is dropped (A3); `attachmentMatch` also covers the customer's equipment attachments (C5); the
  spec says it erases office request documents too (A3, C5; L5).
- Site scope: never the customer's other addresses. Match by `location_id`, plus NULL-location requests
  with the same normalised address; with no location, by normalised address; else an honest empty state;
  headings say "At this address". Estimates follow the matched requests (request-less ones left out).
  Membership only when the customer has one known address (the safe option: membership is per customer,
  and "Member" at a landlord's other building invites member pricing it may not cover). Address matching
  also keeps unsplit prod customer rows from crossing businesses. Dev counts moved to "verified" (B M8,
  A5, C7; L6).
- Reaching forms: the Forms card sits directly after the summary; the close-out reminder links to the
  form; `submittedOn` shows "Submitted on visit #N" and the fill page offers that visit's answers; the
  fill page has `Back to job` and a defined post-submit state (B M4, B M5, B minor 7; L7).
- Archived forms, one rule: can't be started (INSERT `f.active`, pre-read and GET `FORM_ARCHIVED`);
  existing rows continue from their snapshot (UPDATE never reads `active`); active non-applicable forms
  can be started; copy and tests (g) agree (C6, B minor 11; L8).
- Submit takeover: `submit_key = derivedId(scope, "form-submit")`; the zero-row map recognises its own
  committed submit → 200 and writes a missing audit row; integration (c) (A6).
- `visitGateSql` gets its `a.appointment_id = p.id` join and a render test (A7).
- `carryValues` re-validates with `draftValueOk` (removed options drop) (A8).
- Values cap 128 KB in UTF-8 bytes, ≤ 10 long-text fields per form; `pagehide` skips bodies over 60 KB (A9).
- Undecryptable answers: GET read-only (`unreadable`), the writer refuses to overwrite → FORM_LOCKED (A10).
- Erase uses an in-batch subquery on `customer_id` (A12); `requestGateSql` refuses new rows on an
  anonymised customer's requests → FORM_LOCKED (A13).
- The fill-page GET reads the form with `organization_id = $org`; foreign form id → 404, route test (A14).
- Submit STALE / FORM_CHANGED: merge, unlock, require a new tap and confirm (new key) (A15).
- `pagehide` keepalive only when no save is in flight; the ≤ 1.5 s loss window is accepted and stated
  (A16, C13).
- Error `details` are `{ fieldIds }` / `{ path }` only; form CRUD audit shapes pinned; a test that stored
  envelopes hold no submitted string; §12's claim narrowed to server-side, the submit intent body removed
  on a definitive answer (A17, C14).
- 0058 snapshot produced by `drizzle-kit generate` into a scratch output; the lower(name) index and the
  uuid[] default declared with `sql` (A18).
- Forms-card visit for readers without a row: `?visit=` → own assignment → `summary.activeVisitId` (new
  summary field) → "No visit on this job yet." (B M3).
- `yes_no` gains `allowNa` (`N/A` satisfies a required item) so a checklist item that doesn't fit is never
  falsified (B M2).
- Submit cancels the debounce and waits for the in-flight save before sending (B M7).
- Number inputs get a `±` button (iOS decimal pad has no minus) (B M9).
- Photos: the prepared blob is kept with `Try again` / `Discard`; decode through `HTMLImageElement` +
  `img.decode()` drawn straight at the target size (orientation and memory); one upload at a time (B M10).
- B minors: decode-failure copy (1); `TECH_UPLOAD_LIMIT_BYTES` named as new and enforced by the tech
  photo route (2); file-specific failure and success copy (3); admin copy says "request" (4); one quote
  style for the form name (5); confirm reads "only the office can reopen it" (6); status line repeated in
  a sticky footer (8); unsaved answers listed read-only when someone else submitted (9); merge banner once
  per load (10); Site contract drops property type and access notes and adds `submittedFormNames` (12);
  builder: `Add question below`, unit datalist, no-job-types empty state, "Forms already started keep the
  earlier version", filter in `Add a form` above 10 (13); compact "Quality: Standard · Change" line and
  the capture-time note (14, part).
- C: `useUnsavedChangesGuard` verified, the builder renders its own confirm, Back not held (C7);
  photo route facts stated, `isUuid` on POST (C7); form intents live in `ESTIMATE_INTENTS_KEY` with a
  `form:submit:` prefix so `recoverEstimateIntents` needs no change (C8); `upcoming` visits filtered to
  `due_date >=` today (C9); `techFormPreamble` = `techEquipmentPreamble`'s gates + a visit filter on the
  same rows, `isUuid` on the form id (C10); `forms` added to `SETTINGS_TABS` (C11); citations fixed
  (ownership rule lines 156–159, §-refs, `version` default noted against appointments' 0) (C12); the PDF
  tile fixes today's broken office PDFs (C16).

Rejected / deferred:
- Durable localStorage mirror for basement work (B M6): rejected by lead ruling L1. Without stored base
  values it can't merge safely (A1/C1), it leaves answers on shared phones and after erasure, and a
  durable offline copy is offline mode (row 124, out of scope). The server save on `hidden` covers the
  common case.
- Anonymise submissions on `deleteCustomer` instead of keeping them (A4): rejected by L4. Delete is a
  detach that keeps the request's encrypted contact snapshot, notes and photos; the PII path is erasure.
  Its close-out concern is moot with row 126 deferred.
- `prevSaveId` acceptance for a `pagehide` PUT behind an in-flight save (A16 option b): rejected with
  the save token (L1/C2); the PUT is skipped and the small loss window accepted.
- Hard `min`/`max` for impossible values plus separate expected range (B M1, first option): rejected by
  L2; one advisory range plus a fixed sanity bound (|x| ≤ 1,000,000) is enough.
- Per-field `allowNote` (B M2, optional part): rejected as scope; a `short_text` after the item does it.
- Upload queue for a second photo while one uploads (B M10 c, queue part): rejected; the buttons stay
  disabled during an upload, as today.
- Cut technician-picked extra forms (`otherForms`, `Add a form`) (B minor 14): rejected. Forms not tied
  to a job type (and jobs with no job type, 24% of native jobs on dev) need a way in; it is one list and
  one sheet.
- Rendering location access notes and property type on the Site page (B minor 12, first option):
  rejected; dropped from the contract instead, the summary already shows the job's access notes.
- Equipment-touched count on past jobs (B minor 12): rejected as scope; submitted form names were added.
- Reuse `getMembershipSummary` / `getNextVisit` from `src/lib/ai/account-tools.ts` (C9, reuse part):
  rejected; their shapes serve the bot's tool contract, and coupling the tech page to it makes either
  harder to change. The date filter was adopted.
- Deploy precondition "Site page only after the prod customer-identity split" (A5 b): not needed;
  address matching keeps one business's history from another's address.
- Keep row 126 with the blocker and list its consumers (C4 option b): rejected by L3.

Verdict: v2 for round 2. Round 1 had one blocker (B1), resolved by L2.

## Spec round 2 (v2 → v3), 2026-11-07 — 2 critics (A correctness/data/concurrency/erasure, B UX/buildability)

Counts: A 0 blocker / 5 major / 13 minor; B 2 blocker / 9 major / 20 minor. Neither signed off. Lead
rulings R2-1…R2-10 binding.

Correction recorded: round 1's C2 ("a retry merges cleanly without a save token") was wrong. A tick whose
response is lost, then an untick, then the retry re-applies the tick and raises a false "someone else"
banner (A2-2). v3 restores `saveId` / `last_save_id`.

Applied:
- Forms on FieldPulse-synced jobs: allowed for any technician holding an assignment on the visit (synced
  jobs get visit #1 and a lead row from `assigned_to` via the 0049 trigger). Synced status window = any
  status but cancelled, because the status there is FieldPulse's. Status, close-out and money stay
  native-only. The "Managed in FieldPulse" forms stub and MANAGED_EXTERNALLY are removed from forms;
  integration (g) covers it, and Done-when names both (R2-1; supersedes B M7).
- Site scope: a request with neither location nor address matches nothing (no fallback to the customer's
  address); address-less candidates never match; "Synced jobs included" removed, replaced with a counted
  line "N earlier jobs have no saved address."; membership only when every one of the customer's requests
  has an address normalising to this one (and ≤ 1 location); row 131 note made honest (R2-2, A2-5).
- Draft retry: `saveId` back; an unknown write is retried with its own body and saveId before any newer
  write; a replay returns the stored revision with no merge. Drafts send `changes` (every touched field,
  `null` = cleared), applied server-side to the decrypted document under the revision gate (R2-3, A2-2).
- Half-typed numbers: `numberInputState` (empty / partial / invalid / value); "1,200" accepted by stripping
  thousands separators; a partial or invalid input keeps its last valid value in `changes`, never deletes
  it; inline notes "Not saved yet. Finish the number." / "Enter a number like 12.5 (up to 3 decimal
  places)."; status line "Not saved yet: 1 answer isn't a number." and never `Saved` while any input is
  unparsed; submit refused with "Fix the highlighted answers." (R2-4, A2-3, B M2).
- FORM_CHANGED: carry then the same three-way merge against the re-read row, so a colleague's answers
  survive; dropped answers listed (R2-5, A2-4).
- Locking: draft and submit batches take L_req first; the erase batch updates `service_requests` before
  the answers UPDATE (same lock order, no deadlock, no missed row); two-connection integration case (R2-6,
  A2-1).
- Empty forms: `New form` inserts nothing; the first valid Save creates the row whole (≥ 1 non-heading
  question), so an empty form is never listed (R2-7, B blocker 1).
- Walk: the other-address request belongs to customer B, so A's membership shows; the helper taps Done
  before the lead's Close out (R2-8, B blocker 2, B M8 walk part).
- B majors (R2-9): `myVisit` + `backHref` with `from=` so `?visit=` links never 404 (M1); "Some job types"
  with none ticked → "Pick at least one job type, or choose All requests.", archived job types kept as
  ticked "(archived)" rows (M3); `changeType` forces Heading's required off and drops type extras, Choice
  seeds two options (M4); a message for every builder rule, Save disabled with "Fix these to save:" and the
  list linking to rows (M5; the lead's ruling chose disabled-with-reasons over B's "enabled Save");
  `missingRequired` on completed requests ("Required, not submitted: …"), not on cancelled ones (M6); the
  close-out reminder renders when the sheet is blocked too (M8); the status-line table covers first load
  (with day and other-editor name), 401 with a sign-in link, other refusals → read-only + "Not saved"
  list, 400 with `Try again`, over-size (M9); mistaken drafts are emptied with `Clear answers` (no new
  writer; an answerless draft reads `Not started` and is hidden from the office) (M9).
- A minors: `submit_key` in the tail; the `form_submitted` audit is an in-batch INSERT gated on the row's
  xmin, so takeovers and resubmits audit correctly (A2-6); `attachmentsDeleted` computed in SQL in an
  audit INSERT placed before the DELETE (A2-7); the request arm of `attachmentMatch` is an in-batch
  subquery (A2-8); `addJobPhoto` refuses an erased customer's request (`CUSTOMER_REMOVED`) and deletes the
  uploaded object (A2-9); C0 controls refused, the 128 KB cap enforced by measuring `JSON.stringify`
  bytes on both sides, the "every form fits" claim removed (A2-10, R2-10); the fill page recovers its own
  submit intent `{ base, body }` and merges on STALE / FORM_CHANGED (A2-11); every PUT ≤ 60 KB uses
  keepalive, `hidden` / `pagehide` bypass the 3 s floor (A2-12, B minor 5); drafts get their own
  `form-draft` bucket at 60/min (A2-13); admin form GET/PATCH org-scoped, admin answers `unreadable`
  never 500 (A2-14); migration procedure (copy `drizzle/` to scratch, diff hand SQL against generated SQL,
  migrate dev, compare catalogs, `RETURNING id`) (A2-15); submit request hash over an HMAC of the changes
  (A2-17); ids lowercased before comparing (A2-18).
- B minors: `±` behaviour and visibility (1); one-bound range copy and unit spacing (2); chip combinations
  (3); `submittedOn` = this visit has no submitted row (4); `plural` helper (6); Forms tab sort, empty
  state, question count, job type names from the full list (7); builder route path, `Back to forms`,
  title, Archive refused while dirty (8); option ids `o_` + 8 (9); "Required form" switch label (10);
  `maxLength` + count from 80 % (11); footer static while an input has focus (12); inline quality radio
  (13); still-over-4 MB copy (14); `PHOTO_UPLOAD_FAILED` changes, "Photo uploaded." kept (15); buttons
  disabled while a failed blob waits, PDF retry (16); the limit in a pure `upload-limits.ts` (17); Site:
  future unstarted jobs excluded, `generated` → "Booked", "Paid through" (omitted when null), forms line,
  `This job` on an upcoming visit, card copy with no customer (18); office: unreadable copy, cancelled
  visit label and not counted, Reopen warns when no technician is on the visit, office tells the
  technician (19); the erase widening ships as its own commit and test group (20).

Rejected:
- A2-16 site-only address folding (Tennessee → TN, trailing USA): not needed; strict matching finds no
  false match on dev, and a miss only hides history. Recorded under §11.
- B minor 20, trimming `submittedOn` / `View visit #N's answers` / the `Add a form` filter / PDF tiles:
  kept. `submittedOn` is lead ruling L7, the rest are small, and the PDF tile fixes a live defect.
- A `Discard draft` writer that deletes the row (B M9 option): not taken; `Clear answers` reuses the draft
  write, needs no new endpoint or audit, and the empty row is invisible.
- Forms-tab line about FieldPulse orgs (B M7): moot under R2-1.

Verdict: v3 for round 3.

## Spec round 3 (v3 → v4 FINAL), 2026-11-07 — 2 critics (A correctness/data/concurrency/erasure, B UX/buildability)

Counts: A 1 blocker / 2 major / 10 minor; B 0 blocker / 9 major / 17 minor. Neither signed off. Lead
rulings R3-1…R3-13 binding.

Applied:
- Submissions survive the visit trigger (A B1, R3-1): `form_submissions.appointment_id` is NO ACTION; 0058
  `CREATE OR REPLACE`s `sync_request_appointment()` with 0050's body verbatim (`drizzle/0050_m3a_run_the_day.sql`,
  the live definition; v3 wrongly cited 0049) and one change: `v_has_progress` also counts a form submission
  on the visit. Render test diffs the body against 0050; integration (g) covers an unassigned, undated
  synced job and a progress-less native completed job keeping visit and submission, and a submission-less
  visit still deleted as in 0050.
- One "visit counts" rule (A M1, R3-2): not cancelled, or work completed/progressed on it, or it has a
  submission. It governs the GET `visit` check, `submittedOn`, links, `missingRequired` and the office label
  (`· ended` vs `· cancelled`); writes need a live visit (`VISIT_ENDED`). Integration (m).
- Photos vs erase (A M2, R3-3): the photo write is `runBatch([lockRequestSql, INSERT … WHERE NOT anonymised
  RETURNING id])`; the erase batch locks the customer's requests as statement 0, so its attachments count and
  DELETE see one set; two-connection integration case. The office uploader stays ungated (stated, §10).
- Helper access (B M4, R3-4): native writes allowed when the request is in `BILL_STATUSES` or the caller's
  own row on that visit has `arrived_at` / `started_at` / `completed_at`; synced keeps "not cancelled".
  Un-cancel stated (A m4): 0050 leaves cancelled rows cancelled, so the technician sees NOT_ASSIGNED with
  "Ask the office to assign you to this job again." until reassigned.
- Sign-in link (B M1, R3-5): plain `/tech-login`; copy "Sign in again, then open this job again."; return-to
  listed out of scope.
- Membership (B M2, R3-6): `member | none | withheld`, each with copy; `withheld` doesn't leak existence;
  population = every non-cancelled request, counted in SQL with no cap (A m10).
- Erased forms (B M5, R3-7): the card carries `erased`; `formChips` precedence puts `Answers removed` first;
  the office omits only unerased answerless drafts (B minor 12); `hasAnswers` = `values_encrypted IS NOT
  NULL` (the writer stores NULL for an empty document).
- Touched fields (B M3, R3-8): each PUT freezes its body; on landing, base advances by that body and a field
  leaves `touched` only if its current value equals the landed one; edits during the flight stay touched.
- Read-only codes (B M6, R3-9): `writeBlockedReason` enumerated (10 values) with `readOnlyCopy`;
  FORM_LOCKED split into `ANSWERS_REMOVED`, `CUSTOMER_REMOVED`, `ANSWERS_UNREADABLE` (all stored, each with
  copy); autosave refusals re-GET and render the reason; 404 → "This form is no longer on this job."
- Unknown submit (B M7, R3-10): page locked with `MAY_NOT_HAVE_SAVED` + `Try again`, as M3c `pageLocked`;
  draft unknowns keep "Not saved yet. Retrying…".
- Builder first Save (B M8, R3-11): 201 → `router.replace` to the form URL, edit continues with `version: 1`;
  200 replay → GET the row, stay dirty with its version when the builder differs, so the next Save PATCHes;
  unknown → re-POST the same token; `firstSaveOutcome` tests.
- features.csv (B M9, R3-12): 131 and 122 `partial` with notes; 125 `yes` with the synced-technician note
  (A m5); 126 `no`.
- Minors (R3-13): replay check before decrypt/apply/measure, and a values-size 400 offers no same-body retry
  (A m1); `frontGates` takes a `limit`, `RATE_LIMITS.techFormDraft` 60/min, route test 31st/61st (A m3); the
  submit audit gated on `status = 'submitted' AND submit_key AND xmin` (A m2); native = no FieldPulse and no
  HCP id, HCP takes the synced window (A m7); the unique index leads with `appointment_id` (A m8a); CHECK
  erased ⇒ no answers (A m8b); journal `when` > 1793975702677 (A m8c); `macHex("hvac-form-changes-v1", …)`
  in crypto.ts and an exported `canonicalJson` defined in the spec (A m9); `missingRequired` on completed
  requests only for forms created before completion (A m6); synced coverage stated with dev counts (A m5).
  B minors: close-out citation `:145` and the ready-state order (1); `Discard changes` added (2); archive
  confirm corrected (3); range copy "can't be above" (4); "to N characters or fewer" (5); "questions and
  headings" (6); plural number copy and `src/lib/format/plural.ts` (7); `out_of_bounds` with its own copy
  (8); "1,2" mid-typing is partial (9); `myVisit` defined as the job page's `?visit=` rule (10); `none`
  scope still lists this job's estimates, card copy, non-tappable empty card (11); `answerText` (13); new
  form starts with one blank Checkbox, errors shown for touched fields or after tapping disabled Save
  (14); retry schedule and read rates (15); the pending submit intent named as the one browser copy (16);
  17 a–l (browser Back wording, Clear answers buttons and partial reset, reopen STALE copy, explicit resize
  steps, CUSTOMER_REMOVED shows Discard only, file tile link, `h-11` Change, admin copy says technician app,
  one `aria-live` without `Saving…`, `planName` verbatim, a synced-job step in the walk, builder GET `{
  form, submissionCount }`).

Rejected:
- `/tech-login?next=` with a validated return-to (B M1 option b): not taken per R3-5; listed out of scope.
- Folding a lead-row re-arm on un-cancel into the trigger (A m4 option a): not taken; R3-1 allows only the
  one predicate change, and the office reassigning is the stated path.
- Unique index on `(appointment_id, form_id)` alone (A m8a option): kept the three columns with
  `appointment_id` first, so the architecture's "unique per request/visit/form" reads directly from it.

Verdict: v4 FINAL. Round 3's blocker (submissions deleted by the visit trigger) is closed by R3-1; every
other finding was a text edit, applied. The plan and the code get their own reviews.
