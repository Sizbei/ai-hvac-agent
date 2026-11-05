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

**Run the day (M3a):** ownership, actions and time live in `src/lib/tech/`.
- **Ownership read rule** (`ownership.ts`): a technician reads a request when
  they hold a non-cancelled assignment (cancelled-with-progress still counts) on
  a non-cancelled visit, OR `assigned_to` is theirs. The *active visit* is the
  earliest visit with an open assignment row, else the latest with a
  non-cancelled row; the *active lead* is that visit's lead row. Only the
  active lead may hold or close out. `?visit=<appointment id>` on
  `/tech/jobs/[id]` (UUID-checked) picks which of the tech's visits to show;
  list rows link with it.
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
  `ALREADY_OPEN`), one open general entry per technician (partial unique
  index, migration `0050`). Job time entries (`kind='job'`, with
  `appointment_id`) open on arrived/in_progress and close on pause, hold or
  done; `clock_in_method` records `auto` (status tap) vs `manual`. SQL in
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
  re-sends the same Blob + key). If finalize fails after the signature landed,
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
  invoice after a paid one seeds only the unbilled materials. Sold-estimate
  jobs bill materials through the office.
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

**Invariants:**
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
  `tech-status-confirm.ts`) and only post on its confirm; the travel and
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
