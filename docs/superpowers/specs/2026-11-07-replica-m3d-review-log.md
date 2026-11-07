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
