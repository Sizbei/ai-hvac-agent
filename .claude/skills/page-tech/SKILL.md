---
name: page-tech
description: Use when working on /tech-login, /tech/jobs or /tech/guide — the mobile-first technician portal for viewing assigned jobs, capturing on-site work, and the getting-started guide.
---

# Tech portal (/tech-login · /tech/jobs · /tech/jobs/[id] · /tech/guide)

**Purpose:** mobile-first portal for field technicians. Login lands on the job list
(requests assigned to the calling technician); tapping a job opens the detail view for
materials capture, on-site notes, photos, customer signature, and time tracking.

**Files:** login page `src/app/tech-login/page.tsx` · login form
`src/app/tech-login/tech-login-form.tsx` · login route
`src/app/api/auth/tech/login/route.ts` · logout route
`src/app/api/auth/tech/logout/route.ts` ·
jobs list page `src/app/tech/jobs/page.tsx` · jobs list client
`src/components/tech/tech-jobs-list-client.tsx` ·
job detail page `src/app/tech/jobs/[id]/page.tsx` · job detail client
`src/components/tech/tech-job-detail-client.tsx` · job summary
`src/components/tech/tech-job-summary.tsx` · action-sheet and label helpers
`src/components/tech/tech-status-confirm.ts` ·
field queries `src/lib/tech/field-queries.ts` ·
location queries `src/lib/tech/location-queries.ts` ·
timesheet queries `src/lib/tech/timesheet-queries.ts` ·
job API `src/app/api/tech/jobs/route.ts` ·
job detail API `src/app/api/tech/jobs/[id]/route.ts` ·
materials API `src/app/api/tech/jobs/[id]/materials/route.ts` ·
note API `src/app/api/tech/jobs/[id]/note/route.ts` ·
photo API `src/app/api/tech/jobs/[id]/photo/route.ts` ·
signature API `src/app/api/tech/jobs/[id]/signature/route.ts` ·
status API `src/app/api/tech/jobs/[id]/status/route.ts` ·
timesheet API `src/app/api/tech/jobs/[id]/timesheet/route.ts` ·
location consent API `src/app/api/tech/location/consent/route.ts` ·
getting-started guide: see "Getting started guide" below (`src/app/tech/guide/page.tsx`,
`src/components/tech/guide-*.tsx`, `src/lib/tech/guide-*.ts`, `src/app/api/tech/guide/route.ts`)

**Data flow:** login issues a `role=technician` JWT cookie via
`/api/auth/tech/login`. `/tech/*` routes are inside a session gate that verifies this
cookie and scopes every query to the tech's `userId`. Jobs list: client component
(`TechJobsListClient`) fetches `GET /api/tech/jobs` on mount (assignee + tenant
scoped). Job detail: `TechJobDetailClient` fetches the full job by id; mutations POST
to the sub-routes listed above. Catalog material costs/prices are SNAPSHOTTED
server-side from the pricebook at add time — client-sent cost values are ignored.
A typed-in (manual) material may carry `unitPriceCents` (the "Price each $"
field, `parseManualPrice` in `material-form.ts`); the route 400s it on a catalog
line, and `validManualPrice` (`field-queries.ts`) caps the unit price and the
line total at `MAX_PRICE_CENTS`.

**Job page states (UX wave 2026-11-05):** list cards, status history and the
arrival window use `src/lib/tech/job-display.ts` (`issueLabel`, `visitWhen`
"Thu, Aug 13 · 10:41 PM", `visitWindow`, `overdueLabel` "Overdue · Aug 13",
`visitBadge` → "On hold" for a held request). A 404/400 summary load
(`jobLoadOutcome`, `job-page-state.ts`) replaces the page with one "This job
isn't yours, or it no longer exists." state; the `materials`, `timeline`,
`photo` and `timesheet` GETs 400 `INVALID_ID` on a non-UUID id. No form renders
until the summary has loaded. A completed or cancelled request (`jobIsClosed`)
hides only the material form and signature pad: notes and photos stay allowed
(late uploads are legitimate). The materials POST refuses a closed request with
409 `JOB_CLOSED` "This job is closed. Ask the office to add parts."
(`addJobMaterial` → `job_closed`).
- **Unbilled parts:** the materials GET adds `onInvoice` per material
  (`billedMaterialIds`, `invoice-queries.ts`: on a non-void native invoice of
  the request; never cost fields). Rows with `onInvoice: false` carry a "Not on
  an invoice" chip. When the summary's `invoiceSummary.state` is open/paid/
  refunded, the material form warns before saving (`lateMaterialWarning`,
  "This part won't be on the open invoice. The office can bill it
  separately."); the part still saves. Close out adds
  `unbilledPartsWarning` ("2 parts aren't on an invoice yet.") even with no
  invoice. The primary status button sits first, full width
  (`actionSpansRow`). One primary status button per state
(`actionButtonVariant`; Close out is never red); urgency is amber only for
high/emergency (`urgencyTone`). Photos and signatures never show server text
(`PHOTO_UPLOAD_FAILED`, `SIGNATURE_DIDNT_SAVE`). Sign-in errors come from
`techLoginErrorCopy` (`login-copy.ts`).

**Run the day (M3a):** ownership, actions and time live in `src/lib/tech/`.
- **Ownership read rule** (`ownership.ts`): a technician reads a request when
  they hold a non-cancelled assignment (cancelled-with-progress still counts) on
  a non-cancelled visit, OR `assigned_to` is theirs. The *active visit* is the
  earliest visit with an open assignment row, else the latest with a
  non-cancelled row; the *active lead* is that visit's lead row. Only the
  active lead may hold or close out. `?visit=<appointment id>` on
  `/tech/jobs/[id]` (UUID-checked) picks which of the tech's visits to show;
  list rows link with it.
- **Office side of a hold:** the office shows the same active visit
  (`src/lib/admin/current-visit.ts`); a visit a hold ended reads "Visit ended"
  and the office resumes by scheduling the next visit (`addAppointment` flips
  `on_hold` → `scheduled` in its batch). A bare status resume on an ended visit
  is refused (409 `VISIT_ENDED`). status-writes and the 0050 trigger are
  unchanged by this (see page-requests "Current visit").
- **Actions** (`status-actions.ts`, pure; `status-writes.ts` writes one
  `db.batch` per tap, lock-first, xmin-gated): `en_route`, `arrived`,
  `in_progress` stamp the tech's own row (the lead's tap also advances the
  request); `pause` puts the row on hold without ending the visit; `on_hold`
  (hold) is lead-only and ENDS the visit — request goes `on_hold` with a
  `hold_reason` and optional `followUpDate`, open rows are closed; `completed`
  (done) marks only the caller done (needs `startedAt`); `close_out` is
  lead-only and completes the request (`closeOutRequest` in
  `status-writes.ts`), cancelling untouched rows. Pause is offered only once on site (row `arrived` or
  `in_progress`). Close out is offered only while the request is
  `in_progress` or `on_hold` (`closeOutAllowedStatuses`); a replay on a
  completed request is a 200 no-op (`changed: false`), a cancelled request
  refuses it. A solo active lead (no other open row on
  any live visit, `otherOpenRows` in `ResolveInput`) sees Close out, not
  Done. Body: `POST /api/tech/jobs/[id]/status`
  `{ appointmentId, action, holdReason?, followUpDate?, expectedStatus? }`
  — `appointmentId` and `action` are required; there is no legacy
  `{ status }` body. Codes: 400 `INVALID_INPUT` "That isn't a technician
  action." (cancelled/scheduled included), 403 `NOT_LEAD`, 409
  `INVALID_TRANSITION`, `MANAGED_EXTERNALLY` (FieldPulse/HCP-owned jobs are
  read-only here), `STALE` (expectedStatus differs from the server-read row,
  or the write lost a race; the CAS always uses the server-read row),
  `CLOSE_OUT_BLOCKED`, `REQUEST_NOT_STARTED`. Lead-only request writes
  (tap, hold, close-out) re-check `is_lead` inside the write.
- **Close-out blockers** (`Blocker` in `status-actions.ts`): another technician
  still open, a planned visit, an earlier visit open, request not started, not
  the lead. `close-out-sheet.tsx` lists them; it forgets stale blockers when
  reopened. The waiting notice is derived from the loaded blockers.
- **List** `GET /api/tech/jobs?range=today|upcoming|past` (`visit-range.ts`,
  business-timezone days; past = last 30 days of done/cancelled rows); one row
  per visit, tabs in `tech-jobs-list-client.tsx`.
- **General clock** `GET/POST /api/tech/time` (`{ action: "in" | "out" }`, 409
  `ALREADY_OPEN`; GET is 200 `{ id: null, clockInAt: null }` when clocked
  out), one open general entry per technician (partial unique
  index, migration `0050`). The list labels it "Clock in for the day" /
  "Day clock h:mm:ss" + "Clock out" (`dayClockText`, `clock-display.ts`).
  Job time entries (`kind='job'`, with
  `appointment_id`) open on arrived/in_progress and close on pause, hold or
  done; `clock_in_method` records `auto` (status tap) vs `manual`. Status taps
  are the ONLY job clock: the job page's "Time on this job" card
  (`job-time-card.tsx`, `jobClockLine`) is read-only and reloads as soon as a
  tap's POST succeeds (in parallel with the summary reload); the timesheet GET
  adds the tech's closed `totalMinutes` and `closedEntries`. Lines: "On the
  clock since 8:03 PM · 12m (42m on this job)" (earlier time added), "0m so
  far" after a sub-minute pause, "Total 20m" on a closed job. The timesheet
  POST route stays but no client calls it. SQL in
  `time-entry-sql.ts`; admins read them in the staff Timesheets dialog.
- GPS geostamps, backdating, en-route texts, required forms, offline: not built.

**Collect (M3b, S40 `/tech/jobs/[id]/invoice`):**
- **Files:** page `src/app/tech/jobs/[id]/invoice/page.tsx` · components
  `src/components/tech/invoice/` (`invoice-page-client.tsx`, `invoice-lines.tsx`,
  `add-item-sheet.tsx`, `invoice-collect-buttons.tsx`, `approval-sheet.tsx`,
  `record-payment-sheet.tsx`, `pay-link-sheet.tsx`, `invoice-record.tsx`,
  `tech-invoice-card.tsx` (the job detail's Invoice card),
  `use-invoice-writes.ts`, `post-json.ts`) · shared pad
  `src/components/tech/signature-pad.tsx` · key hook
  `src/hooks/use-idempotency-key.ts` · view + GET query
  `src/lib/tech/invoice-view.ts`, `src/lib/tech/invoice-queries.ts` · write
  gates `src/lib/tech/invoice-route-guards.ts` (`techWritePreamble`,
  `resolveTarget`) · route plumbing `src/lib/tech/invoice-write-route.ts` ·
  reason → code map `src/lib/tech/invoice-errors.ts` · allowed actions
  `src/lib/tech/invoice-actions.ts` · pure client logic
  `invoice-key-state.ts`, `invoice-intent-persist.ts`,
  `invoice-client-errors.ts`, `invoice-view-diff.ts`, `invoice-page-copy.ts`,
  `approval-flow.ts`, `record-payment-form.ts` (all `src/lib/tech/`) · writers
  `src/lib/admin/invoice-field-writes.ts` (create/lines/finalize) and
  `src/lib/admin/invoice-payment-writes.ts` · idempotency
  `src/lib/http/idempotency.ts` + `idempotency-codes.ts` · pay link
  `sendInvoicePayLink` in `src/lib/communication/money-triggers.ts`.
- **Routes** (all under `src/app/api/tech/jobs/[id]/invoice/`): `GET`/`POST
  route.ts` (view; adopt-or-create the draft, `{}` body), `POST lines/route.ts`
  (`{ invoiceId, pricebookItemId, quantity }` or `{ invoiceId, jobMaterialId }`),
  `DELETE lines/[lid]/route.ts?invoiceId=`, `POST finalize/route.ts`
  (`{ invoiceId }`), `POST payments/route.ts` (`{ invoiceId, method:
  'cash'|'check', amountCents, checkNumber? }`), `POST pay-link/route.ts`
  (`{ invoiceId }`); plus `POST /api/tech/jobs/[id]/signature` (multipart, keyed)
  and `GET /api/tech/pricebook?scope=invoice&q=` (every active type, q ≥ 2).
  Every write names its `invoiceId` (it is part of the request hash).
- **Gate order** (`techWritePreamble`): tech session 401 → same-origin 403 →
  `isUuid` 400 → rate limit → readable job 404 → native 409
  `MANAGED_EXTERNALLY` → active lead 403 `NOT_LEAD` (writes are lead-only;
  writers re-check `stillLead` inside the batch) → on site: request status
  ∈ {`arrived`, `in_progress`, `on_hold`, `completed`} else 409 `NOT_ON_SITE`
  → body → `Idempotency-Key` → `withIdempotency` → target check → writer.
- **GET contract:** `{ invoice, otherOpen, history, materialsNotOnInvoice,
  pendingWrite, customerHasPhone, isLead, onSite, externalInvoice, allowed }`.
  Never any cost field (a test asserts no key containing `cost`). Non-leads get
  `invoice` reduced to `{ id, state, totalCents, balanceCents }`. While draft,
  `invoice.signature` is the request's current signature with `fresh =
  signedAt >= invoice.updatedAt`; once open/paid it is the invoice's own
  snapshot (`none|present|erased|unavailable|estimate`). `pendingWrite` = an
  `in_progress` key younger than 2 min on any `/api/tech/jobs/<rid>/…` route.
  `allowed` comes from `invoiceAllowedActions`. Live = draft or open. With no
  live invoice, `invoice` is the newest PAID or REFUNDED one in full read-only
  form (lines, payments, signature) and `allowed` includes `create` (a second
  invoice for unbilled materials); `history` is then `null`. `history` is
  non-null only when the request has no live and no paid/refunded invoice
  (the newest voided one).
  The page keys the totals footer on `state` (paid → "Paid", refunded →
  "Refunded") and detects a landed `create` by a new invoice id, not by
  `before.invoice === null`. (Final-wave ruling; spec §5.1/§6.2.1 resolved
  toward §7.4.)
- **Keys:** the client mints with `mintKey()` (`idempotency-codes.ts`) and
  sends `Idempotency-Key` on every money POST. One reducer state per intent
  (`nextKeyState`: `idle → armed → sent → idle | unknown`). A changed body
  never gets a new key while the old intent is `unknown`: the OLD body is
  re-sent with the OLD key first (`sendPlan` → `resend_stored`). Gate every
  send on the phase RETURNED by the `edit` dispatch (a double tap in `sent`
  is skipped, never re-sent). `sent`/`unknown` intents persist in
  `sessionStorage` (`tech:invoice:<rid>:intents`) and are re-sent on mount
  before the page unlocks. A 4xx whose code is in `STORED_CODES` (shared
  with the server) spends the key. `classifyWriteError` decides
  refetch/retry/new key; `intentLanded` decides whether a refetch shows that
  an unknown write actually landed. Stored 409s map to
  `show_message_refetch`, which keeps the spent key until the next edit.
  This is harmless and accepted.
- **Stale unknown intents:** a refetch that shows the signature landed
  (`signature.fresh`, or the invoice is no longer a draft) drops an `unknown`
  signature intent, and a landed finalize drops it too, so the "may not have
  saved" banner never outlives the write it was about.
- **Approval sheet order:** signature FIRST (the request-level capture, its own
  key and held Blob), THEN finalize. Finalize snapshots the request signature
  onto the invoice only when `signed_at >= invoices.updated_at` (signed after
  the last line change); otherwise the invoice says "No signature". The
  snapshot is never written again: a later "Sign again" changes the job
  signature only. If the signature fails nothing is finalized ("Try again"
  re-sends the same Blob + key; the sheet and the page banner both read "The
  signature didn't save."). "Customer not here? Finalize without signature"
  (`noSignatureOffered`) first asks `NO_SIGNATURE_CONFIRM` ("Finalize without
  the customer's signature? The invoice will say 'No signature' and can't be
  edited."), then calls finalize alone while no signature has landed, labelled
  `FINALIZING`; the invoice then reads "No signature". If finalize fails after the signature landed,
  only finalize is retried. A $0 draft finalizes to `open`. In this sheet the
  shared pad's button reads "Use this signature" (it only captures; nothing is
  sent until "Approve and finalize").
- **Signature freshness:** the totals statement bumps `invoices.updated_at`
  when the subtotal OR the total changes (a tax-rate change moves the total
  without the subtotal), never on a no-op retry. Spec §5.4 deviation.
- **Materials once:** create seeds lines from the job's materials that are not
  yet on a non-void native invoice of the request (`invoice_line_items.
  job_material_id`, ids `materialLineId(invoice, material)`). Adding a material
  that is already billed → 409 `ALREADY_BILLED`, across invoices. A second
  invoice after a paid one seeds only the unbilled materials. A sold-estimate job bills on
  the phone: the field bill (M3c) puts the estimate's lines on the job's draft, and
  materials still seed through the normal create above.
- **Target scope:** lines and finalize need the request's newest live invoice,
  else 409 `STALE`. Payments and pay link accept any non-void native invoice
  of the request; the writer then refuses `INVOICE_NOT_CHARGEABLE`. Both
  checks run inside the idempotency `run`, so a replay wins over STALE.
- **Pay link:** SMS only (`invoice_sent` / `invoice_sent_sms`). A 5-minute
  per-invoice cooldown (longer than the 2-minute idempotency takeover window,
  so a crashed send retried by takeover can't text twice; spec §6.4 said 2
  minutes) is claimed on `invoices.pay_link_sent_at` BEFORE the portal token
  is minted (409 `COOLDOWN`). The claim UPDATE carries the lead predicate
  (`stillLeadSql`), so a lead reassigned after the preamble sends nothing. A
  throw from the queue insert → 500 `SEND_FAILED` "The link may not have gone
  out. Try again in 5 minutes." (stored, claim kept; spec said "Couldn't send
  the link. Try again.", deviation kept because the claim is kept). The demo
  org → 403 `DEMO_RESTRICTED`. Receipts and pay links call
  `processPendingJobs()` inside `after()`. Accepted: a committed-but-thrown
  insert waits for the daily cron; a lead can send at most one link per 5
  minutes per invoice, with no daily cap.
- **Logs:** route and writer error logs carry codes and ids only. The pino
  `error` serializer in `src/lib/logger.ts` drops Drizzle's `query`/`params`
  (they held the signature name, check numbers and the pay link), so prefer
  `logger.error({ code: errorCode(error), invoiceId }, "…")`.
- **Probes:** mint tech sessions with `MINT_ORG_ID=<throwaway org> npx tsx
  scripts/agent/mint-tech-session.mjs` and assert the token's
  `organizationId` before any fetch. Send `Origin: http://localhost:3000`.
  Insert the technician + request by SQL (`assigned_to`, status `arrived`).
  Queue-drain guard: before anything that could queue a message, run
  `SELECT count(*) FROM communication_jobs WHERE status='pending' AND
  scheduled_for <= now() + interval '15 minutes'` and abort unless it is 0
  (`processPendingJobs` drains every org through real Twilio). Integration
  suite: `VITEST_INTEGRATION=1 npx vitest run
  tests/integration/field-invoice.test.ts`.

**Sell on site (M3c, `/tech/jobs/[id]/estimates/new`, `/tech/jobs/[id]/estimates/[eid]`):**
- **Files:** pages `src/app/tech/jobs/[id]/estimates/{new,[eid]}/page.tsx` · components
  `src/components/tech/estimates/` (`estimates-card.tsx`, `estimate-builder-client.tsx`,
  `estimate-page-client.tsx`, `customer-view.tsx`, `use-estimate-write.ts`,
  `recover-intents.ts`, `fetch-estimates.ts`) and `src/components/tech/equipment/`
  (`equipment-card.tsx`, `equipment-sheet.tsx`) · writers `src/lib/tech/estimate-writes.ts`,
  `src/lib/tech/equipment-writes.ts`, `billSoldEstimate` in
  `src/lib/admin/invoice-field-writes.ts` · billed(eid) SQL `src/lib/admin/estimate-billing-sql.ts`
  · read models `src/lib/tech/estimate-queries.ts`, `src/lib/tech/equipment-queries.ts` · pure
  `estimate-input.ts`, `estimate-builder.ts`, `estimate-display.ts`, `estimate-page-copy.ts`,
  `customer-view-state.ts`, `estimate-intents.ts`, `equipment-input.ts`, `equipment-display.ts`,
  `material-overlap.ts`, `field-sale-statuses.ts`, `add-item-done.ts` (all `src/lib/tech/`).
- **Routes:** `GET/POST /api/tech/jobs/[id]/estimates`, `POST …/estimates/[eid]/{sell,bill,decline}`,
  `GET/POST /api/tech/jobs/[id]/equipment`. Preambles: estimate create/sell/decline =
  lead + arrived/in_progress/on_hold ("Arrive at the job first." / "This job is closed.");
  bill = lead + invoicing statuses, same copy; equipment = any technician with a
  non-cancelled assignment (403 `NOT_ASSIGNED`) + arrived…completed. Invoice routes: a
  cancelled request now answers 409 `JOB_CLOSED` (copy unchanged).
- **Billing once:** billed(eid) = a non-void invoice with `estimate_id = eid` (office) OR a
  linked line (`invoice_line_items.estimate_line_item_id`) on a non-void native invoice
  with `estimate_id IS NULL` (job). The bill pre-checks, drafts through
  `createInvoiceFromJob` (seeds materials), then inserts under L_req → L_inv with
  `NOT billed(eid)` (`billLinesSql`). `ALREADY_BILLED` renders as the billed state. Linked
  lines can't be removed in the field (`FROM_ESTIMATE`). Spec deviations: when this key's
  derived invoice is paid, refunded or voided the bill answers STORED `INVOICE_CHANGED`
  "The job's invoice changed. Try again." (a new key derives a new invoice; unstored STALE
  looped forever); `INVOICE_LOCKED` copy is "The job's invoice is already finalized. Ask
  the office to bill this estimate." (Generate refuses while a paid draft exists).
- **GET contract** adds `requestStatus` and `priorInvoicePaid` to spec §6; the bill success
  adds `hasMaterials`. Never cost, never the typed signature name.
- **Sold estimate actions (final wave):** `Leave for the office` shows only when the job has
  no live invoice (`soldBillingView(...).leave`). With a draft and no payment the draft IS the
  job's invoice, so only `Add to the job's invoice` is offered (spec §7.3 deviation, lead
  ruling: the office's Generate would answer `request_has_draft`). The estimate page stays
  locked while a sell is `sent` or `unknown` (`pageLocked`), also after Back closed the layer
  during "Approving…"; a successful sell refetches before it settles, so the page reads Sold.
  The layer is portalled to `<body>` with every other body child `inert`, and Tab wraps inside
  it (`focusTrapTarget`). Option cards read "Tax (8.25%)" only when the org rate reproduces the
  stored tax (`optionTaxLabel`). The technician's failure note shows only once the layer closes
  (`techNoteVisible`). Unknown writes on every M3c surface read `MAY_NOT_HAVE_SAVED`.
- **Customer view:** `#customer` via native pushState/popstate (`layerStep`); Back closes
  onto the estimate page, never further; a reload reopens the layer only while sellable
  AND no stored intent for the estimate is unanswered (`left === 0`), else strips the hash;
  a reload that reopens it runs replaceState (strip) then pushState('#customer'), so every
  close is one Back (spec deviation; a reload on an already-pushed entry leaves one extra
  estimate-page entry). Customer-facing failures read "Something went wrong. Please hand
  the phone back to your technician." only; the technician reads the real reason on the page
  after the layer closes (`saleFailNote`, `techNoteVisible`). Money locks: after an unknown
  sell the page stays locked behind `MAY_NOT_HAVE_SAVED` with Try again, which re-sends the
  stored sell (old body, old key); a second Approve after an unknown sell never shows a blind
  success (`approveFirst`); a refetch that makes the estimate unsellable closes an open layer
  unless a sale started in it (`layerStale`); the whole page is locked while a sell is `sent`
  or `unknown` (`pageLocked`).
- **Builder:** adding a pricebook item already on the option adds to its quantity (capped at
  999) instead of a second line (`addLine`); the add-item sheet shows no rows while the query
  differs from the one its hits answer (`hitsUsable`). When the re-sent earlier body lands
  (`resentOld`), the builder says `EARLIER_SAVE_WON` ("Your earlier save went through. Your
  newer edits weren't saved.") with an "Open the estimate" button and does not navigate on
  its own. One Subtotal · Tax · Total formatter (`totalsLine`) serves the builder, the
  estimate page and the customer view.
- **Keys:** estimate/equipment intents live under `tech:estimate:<rid>:intents`
  (`useIdempotencyKey({ storageKey, rehydrate })`); the builder, the estimate page and the
  equipment card re-send stored intents on mount (`recoverEstimateIntents`) and stay
  locked with "Try again" while any is unanswered; the equipment sheet rehydrates its own
  intent and re-sends the old body with the old key before Save unlocks. The invoice
  view's `pendingWrite` counts only `/invoice%` and `/signature` keys.
- **Equipment:** location rule `(r.location_id IS NULL OR ce.location_id IS NULL OR
  ce.location_id = r.location_id)` in the GET and every write; replace = lock old →
  insert while old is live → retire old only when this transaction wrote the new row.
  Install date stored as noon Eastern. An "Other" unit's description (`notes`) shows under its
  type on the card (`unitDescription`). The add/replace tail SELECTs re-check the customer and
  the on-job predicate, so a replay by a technician taken off the job answers NOT_FOUND
  (replace) or STALE (add) instead of the stored success.
- **Erasure:** customer erasure scrubs `signature_name` / `signature_ip` on the customer's
  estimates and on estimates of the customer's requests; `sold_by` is a technician id, not
  customer data, and is kept (lead ruling).
- **Verify:** `npx vitest run src/lib/tech/estimate-*.test.ts src/lib/tech/equipment-*.test.ts src/lib/tech/customer-view-state.test.ts "src/app/api/tech/jobs/[id]/estimates" "src/app/api/tech/jobs/[id]/equipment"`;
  dev DB: `VITEST_INTEGRATION=1 npx vitest run tests/integration/field-estimate.test.ts`.

**Forms + site view (M3d, `/tech/jobs/[id]/forms/[formId]`, `/tech/jobs/[id]/site`):**
- **Files:** pages `src/app/tech/jobs/[id]/forms/[formId]/page.tsx`, `src/app/tech/jobs/[id]/site/page.tsx` ·
  components `src/components/tech/forms/` (`forms-card.tsx`, `form-fill-client.tsx` (state and
  saving), `form-fill-view.tsx` (markup), `use-form-save-effects.ts` (autosave timer, leave saves,
  `leaveTo`), `form-fill-io.ts` (reads, leave mark), `form-fill-sheets.tsx`, `form-field-input.tsx`), `src/components/tech/site/` (`site-card.tsx`, `site-page-client.tsx`,
  `fetch-site.ts`), `job-photos-card.tsx` · writers `src/lib/tech/form-writes.ts`
  (`saveFormDraft`, `submitForm`), `src/lib/tech/photo-writes.ts` (`addJobPhoto`) · reads
  `src/lib/tech/form-reads.ts`, `src/lib/tech/site-queries.ts` · route guards
  `src/lib/tech/form-route-guards.ts` (`techFormFront`, `formGateFail`, `findSubmitReplay`) · pure `src/lib/forms/`
  (`form-schema.ts`, `form-values.ts`, `form-gates.ts`, `site-scope.ts`, `form-bodies.ts`),
  `src/lib/tech/` (`form-fill-state.ts`, `form-save-machine.ts`, `form-copy.ts`, `form-view.ts`,
  `site-display.ts`, `photo-resize.ts`, `upload-limits.ts`).
- **Routes:** `GET /api/tech/jobs/[id]/forms?visit=`, `GET …/forms/[formId]?visit=`,
  `PUT …/forms/[formId]/draft` (no key; `saveId` replay checked first, revision gate, 60/min
  bucket `form-draft`), `POST …/forms/[formId]/submit` (keyed; hash over an HMAC of the
  changes, `macHex("hvac-form-changes-v1", …)`), `GET /api/tech/jobs/[id]/site`.
- **Who writes:** a non-cancelled row on THAT live visit; native on site (`BILL_STATUSES`) or
  the caller's own row arrived/started/completed; synced (FieldPulse or HCP) any status but
  cancelled. One gate read (`readFormGatesSql`) + `gateReason`, in this order: cancelled request
  → JOB_CLOSED; erased customer → CUSTOMER_REMOVED; ended visit → VISIT_ENDED for a technician
  with a row on it, else NOT_ASSIGNED; no live row → NOT_ASSIGNED; native and not on site →
  NOT_ON_SITE. Replays run BEFORE the gates: the draft route's `findDraftReplay` (saveId), the
  submit route's idempotency key, and inside the keyed run `findSubmitReplay` (a row already
  submitted with this key's derived `submit_key` answers 200) runs before `formGateFail`, so a
  committed submit whose response was lost still answers 200 after the visit ended or the job
  was cancelled. A pre-read revision other than `baseRevision` is STALE before any decrypt.
- **Visit counts** = live, or progressed/completed work on it, or a submission. Migration 0058
  re-creates `sync_request_appointment()` with ONE added predicate: a visit with any
  `form_submissions` row (an empty draft included) is kept (times nulled, lead demoted) instead
  of deleted. `form_submissions.appointment_id` is NO ACTION.
- **Client:** autosave timing is `form-save-machine.ts` (1.5 s debounce, one in flight, 3 s
  floor, unknown re-sent first with its saveId, 3 → 30 s back-off, hidden/pagehide flush);
  the `submitted` stop is final (`resume` never clears it, and the page stays read-only even if
  the post-submit re-read fails). Answer bookkeeping is `form-fill-state.ts` (touched fields,
  last valid number, landed body advances base); `mergeIntoInputs` reseeds `lastValid` for
  untouched number fields, so a later half-typed number can't send a stale value over a
  colleague's answer, and a live merge keeps half-typed numbers (touched ∪ carried). A failed
  re-read after STALE retries after the machine's back-off instead of sticking on "Retrying…";
  one re-read runs at a time (a call made meanwhile is queued, never dropped; autosave waits
  while one is scheduled or in flight; a re-read times out into the back-off; a successful
  save or submit cancels a scheduled re-read, and nothing re-reads a submitted page or runs
  after unmount), and a recovered submit's changes are folded into the inputs as touched edits
  first, so answers typed during the back-off survive the re-read. On FORM_CHANGED a field the
  new version drops leaves the touched set and is listed under "Not saved". The re-read merge
  itself is the pure `reconcileTransition` (`form-fill-state.ts`, tested); `reconcileOnce` only
  assigns its result to the refs.
- **Leaving (ruling R1, refines spec §4.2):** (a) `Back to job`, `Back` and `View visit #N's
  answers` go through `leaveTo`: it waits for the write in flight and any re-read, sends what's
  left (a STALE merge re-saves on the merged row; pure `settleStep` in `form-save-machine.ts`)
  and navigates only when nothing is left; meanwhile the link reads "Saving…". A save that
  fails (signed out, too large, bad request, network) keeps the page with its line; a blocked
  or submitted page navigates at once. Every wait is bounded by a 15 s deadline (`withDeadline`):
  a stalled connection leaves the page with "Not saved yet. Retrying…", never on "Saving…".
  Draft PUTs time out after 15 s into the back-off (same body and saveId), except the leave save
  sent as the page goes, which stays fire-and-forget. A leave body keeps `leave` and its `bases`
  through retries, and a merged answer doesn't move the page's revision until the re-read lands. (b) Saves sent as the page is left (hidden, pagehide, or
  an in-app unmount such as the browser's Back) carry `leave: true` and `bases` (the value this
  page last saw for each changed field, null = absent). On a revision mismatch the server merges
  field-wise under the same lock: it applies a field only when the stored value equals its base
  and skips fields a colleague changed, answering 200 `{ revision, skipped }`. A non-leave save
  keeps STALE. If the page is still open when a leave save merges, it re-reads (`leaveOutcome`).
  (c) A leave save writes a `tech:form:leave:<formId>:<aid>` sessionStorage mark (removed when
  it lands). A load that finds a recent mark and a row that doesn't hold the mark's changes yet
  (a revision can't tell: a colleague's save moves it too) doesn't say "Saved" over the read;
  it reads again for up to 3 s and applies the row that holds them (a skipped field never
  will: the line stays blank until the next save). Without a mark the
  loaded draft shows "Saved · <time>" as the spec table says. After `Clear answers` lands the
  line is blank.
- **Read-only answers:** an erased row shows "Answers removed" and no field values; an
  unreadable one "These answers can't be shown." (`answersHidden`). `±` never takes focus
  (`onPointerDown` / `onMouseDown` preventDefault), so it works while the number is focused and
  sits beside the input.
- **Unreadable job (ruling R3):** every technician form route answers "This job isn't yours."
  for a job the technician can't read; a missing or foreign form on a readable job is "This
  form is no longer on this job.", which the fill page also shows for any 404.
  The submit intent lives in `tech:estimate:<rid>:intents` as `form:submit:<formId>:<aid>`;
  the fill page re-sends only an intent restored at mount. A live submit is never re-sent
  automatically: a lost response locks the page on "Your last change may not have saved. Try
  again." and only Try again sends it again (same key).
- **Close-out:** required forms not submitted on any visit that counts show as non-blocking
  "Fill in “…”" links in `close-out-sheet.tsx` (native jobs: the sheet takes `native` and
  `reminderVisible` decides); nothing blocks (row 126 deferred). The Forms card on a closed job
  with no visit to show says "This job is closed."
- **Site:** match by `location_id`, else by `normalizeAddress` of the request's own address;
  never the customer's other address, never a fallback. Membership `member | none | withheld`;
  an erased customer is always `withheld`, never "Not a member." (ruling R2).
  `isLead` comes from `isActiveLead` (`ownership.ts`, shared with the M3c estimates GET); this
  job's open native estimates are links for the lead only (chevron row, as other tech links).
- **Photos:** quality per device (`tech:photo-quality`), resized on the phone, PDFs via
  `Add file`, 4 MB on phone and route; an erased customer's job refuses uploads
  (409 CUSTOMER_REMOVED, object deleted); a failed insert batch answers 409 STALE "This job
  changed. Try again." (object deleted, retryable). A photo the phone can't prepare unlocks the
  card with `PHOTO_CANT_PREPARE` (`photo-resize.ts`); `Add file` takes PDFs only (client MIME check).
- **Verify:** `npx vitest run src/lib/forms src/lib/tech/form-*.test.ts src/lib/tech/site-*.test.ts src/lib/tech/photo-*.test.ts "src/app/api/tech/jobs/[id]/forms" "src/app/api/tech/jobs/[id]/site" "src/app/api/tech/jobs/[id]/photo" tests/api/tech-photo.test.ts`;
  dev DB: `VITEST_INTEGRATION=1 npx vitest run tests/integration/field-forms.test.ts`.

**Invariants:**
- "View as" a technician: the layout provides `TechReadOnlyProvider`
  (`src/components/tech/tech-read-only-context.tsx`); the day clock and the
  status buttons render disabled under a "Read-only preview" title span.
- **Assignee + tenant guard** (legacy sub-routes): every mutation route checks BOTH
  `assignedTo == techUserId` AND the session's `organizationId`. A technician may only
  touch THEIR OWN job. The guard in `field-queries.ts` must mirror
  `src/app/api/tech/jobs/[id]/status/route.ts` exactly — keep them in sync.
- Tech-login page lives at `/tech-login` (top-level), OUTSIDE the `/tech/*` session
  gate — this is deliberate to avoid a redirect loop. Do not move it inside `/tech/`.
- The "Continue with Google" button on the tech login form renders ONLY when Google
  OIDC is configured (`googleEnabled` prop) — a dead button must never appear.
- Location tracking is consent-gated (`/api/tech/location/consent`) — never send
  coordinates without an active consent record.
- Money is integer cents throughout; unit cost/price for catalog materials are
  snapshotted from the pricebook (client-sent costs are not trusted).
- Interactive controls (buttons, the remove-material tap target) are `h-11` /
  `min-h-11 min-w-11` (44×44px) — this is a mobile app used one-handed at a
  customer's furnace, not a desktop density.
- Done, Pause, Hold and Close out open the bottom sheet
  (`close-out-sheet.tsx`, copy from `buildActionSheetCopy` in
  `tech-status-confirm.ts`) and only post on its confirm; Close out warns
  (without blocking) when the invoice is a draft or has a balance
  (`closeOutInvoiceWarning`, from the summary's `invoiceSummary`); the travel and
  Working taps post on first tap (`actionNeedsSheet`).
- Travel taps: "On my way" (`en_route`) and "I've arrived" (`arrived`) post
  to the same `POST /api/tech/jobs/[id]/status` route; wording comes from
  `techStatusLabel` in `tech-status-confirm.ts`. Chain: scheduled/assigned/
  on_hold → en_route → arrived → in_progress; there is no arrived →
  completed. Both are non-terminal, so no confirm step. (Ownership is no
  longer `assigned_to` only — see "Run the day".)
- `/api/auth/tech/login` starts with the same-origin + JSON content-type
  guard (`isSameOriginRequest` / `hasJsonContentType`) before any DB read or
  session mint — see page-auth for the shared pattern.

**Gotchas:**
- `params` in `TechJobDetailPage` is a `Promise` (this Next.js version) — always
  `await params` before reading `id`.
- The tech portal has no admin-pages design system dependency — it uses base shadcn
  primitives (`Card`, `CardContent`, `Button`, `Input`, `Skeleton`); do not import
  admin-ui primitives here.
- The list's status badge is humanized by `labelAssignmentStatus`
  ("In progress", "En route"). A 409 `STALE` reloads the summary so the
  buttons match the server.
- Dev org is FieldPulse-connected: never create throwaway requests through the
  API to test taps (see admin-pages).
- Photos go through `POST /api/tech/jobs/[id]/photo` (validated, uploaded to
  R2, metadata in `attachments` via `addJobPhoto`). The customer signature is
  NOT an attachment: `POST /api/tech/jobs/[id]/signature` uploads the PNG and
  `recordSignature` stores its public URL on `service_requests.signature_url`
  (+ `signature_name`, `signed_at = now()` from the DB clock).
- Dev has no R2 write credentials in `.env.local`: signature/photo uploads and
  signed read URLs cannot run on dev (the invoice signature reads
  `unavailable`). Prove those paths with mocked unit tests.

**Verify changes:**
- `npx vitest run src/app/api/tech/jobs/[id]/route.test.ts`
- `npx vitest run src/lib/tech/field-queries.test.ts src/lib/tech/timesheet-queries.test.ts`
- `npx vitest run src/app/api/auth/tech/login/route.test.ts src/app/api/auth/tech/logout/route.test.ts`
- `npx vitest run src/components/tech/tech-status-confirm.test.ts`
- `npx vitest run src/app/api/tech/jobs/[id]/invoice src/app/api/tech/jobs/[id]/signature src/app/api/tech/pricebook`
- `npx vitest run src/lib/tech/invoice-*.test.ts src/lib/tech/approval-flow.test.ts src/lib/tech/record-payment-form.test.ts src/lib/admin/invoice-field-writes.test.ts src/lib/admin/invoice-payment-writes.test.ts src/lib/http/idempotency.test.ts`
- Dev DB: `VITEST_INTEGRATION=1 npx vitest run tests/integration/field-invoice.test.ts`
- `npx vitest run src/lib/tech/ownership.test.ts src/lib/tech/status-actions.test.ts src/lib/tech/status-writes.test.ts src/lib/tech/time-entry-sql.test.ts src/lib/tech/visit-range.test.ts`
- `npx vitest run src/lib/tech/guide-*.test.ts src/app/api/tech/guide`
- Dev DB: `VITEST_INTEGRATION=1 npx vitest run tests/integration/tech-guide.test.ts`
- Gate: `npx tsc --noEmit`

**Setup guide hook:** `createTechSession` (`src/lib/auth/tech-session.ts`) writes
`flags.techSignedInAt` write-once via `after()` (`flagsStatementSql` with
`guardTechSignedIn`), skipped for the demo org; failures only log. That flag is
what completes the `tech_sign_in` step. `scripts/agent/mint-tech-session.mjs`
signs the cookie directly and BYPASSES this hook, so a minted session never
completes the step. See page-setup.

**Getting started guide (spec 2026-11-05):** `/tech/guide` page plus a card on
`/tech/jobs` and a header Guide link.
- **Files:** page `src/app/tech/guide/page.tsx` · components
  `src/components/tech/guide-{card,page-client,step-row,progress,finished,link}.tsx`
  · hook `src/hooks/use-tech-guide.ts` · logic
  `src/lib/tech/guide-{state,sql,steps,copy,queries,view,refresh}.ts` · route
  `src/app/api/tech/guide/route.ts` (GET payload, PATCH hide) · integration
  `tests/integration/tech-guide.test.ts` · migration `drizzle/0054_tech_guide.sql`
  (`users.field_guide_state`).
- **Steps:** nine ids in `STEP_IDS` (`guide-state.ts`): `start_job`, `finish_job`,
  `clock_in`, `share_location`, `add_material`, `note_or_photo`,
  `capture_signature`, `build_invoice`, `collect_payment`. Required =
  `start_job`, `finish_job`; progress counts those two, the rest sit under "Go
  further". Steps self-complete from real data.
- **Sticky stamps:** `users.field_guide_state` = `{ hiddenAt?, firstCompleted }`.
  One guarded UPDATE on GET writes new stamps; the old value wins.
- **Card visibility:** `cardHiddenFor` (× tapped, or more than 24 h after the
  `finish_job` stamp, server clock). The jobs page reads it server-side with
  `readGuideHidden(organizationId, userId, now?)` and the payload echoes it as
  `cardHidden`. `cardState` (`guide-view.ts`): while the payload or the Today
  list is unsettled, nothing renders until the 300 ms delay
  (`SKELETON_DELAY_MS`), then a skeleton at `CARD_MIN_H` (`guide-card.tsx`) so
  the list does not jump; `guideHidden` or `cardHidden` short-circuits to hidden.
- **Jobs-list inputs:** `todayFirst` is captured once from the first successful
  Today fetch (`pickTodayFirst`, active row first) and never from another range;
  `todaySettled` flips on Today success/failure or the first tab switch; the card
  renders only once both it and the guide payload have settled. × fills the
  mounted `role=status` region with the hint and focuses
  `[role=radio][aria-checked=true]` via `groupRef`; PATCH failure restores the
  card with a `role=alert` line.
- **Page hero:** the guide page's Up next card shows the step's why only;
  every step row shows its how (the hero's how repeated the why).
- **Refresh:** the location toggle dispatches `tech:guide:refresh`
  (`guide-refresh.ts`, from `tech-location-tracker.tsx`); the hook re-fetches.
- **Rulings:** no demo rule (PLATFORM_ORG_ID = DEMO_ORG_ID in prod, so a demo
  check would hide it for real orgs). The tap label for `in_progress` is
  `Working` (`tech-status-confirm.ts`). Lenient rules: office finalize counts, a
  Working-then-held row counts as finished, any technician's photo on your live
  job counts.
- **Probe:** `MINT_ORG_ID=<org> npx tsx scripts/agent/mint-tech-session.mjs`,
  decode the token and assert `userId`/`organizationId`, then `GET
  /api/tech/guide`, and `PATCH` with `Origin: http://localhost:3000`.
