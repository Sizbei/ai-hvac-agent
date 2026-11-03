---
name: page-tech
description: Use when working on /tech-login or /tech/jobs — the mobile-first technician portal for viewing assigned jobs and capturing on-site work.
---

# Tech portal (/tech-login · /tech/jobs · /tech/jobs/[id])

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
location consent API `src/app/api/tech/location/consent/route.ts`

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
  lead-only and completes the request (`completeRequestFromAdmin`), cancelling
  untouched rows. Pause is offered only once on site (row `arrived` or
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
- Photos are uploaded to R2 via `/api/upload`; signature is captured as a data-URI
  blob; both are stored as `attachments` rows linked to the service request.

**Verify changes:**
- `npx vitest run src/app/api/tech/jobs/[id]/route.test.ts`
- `npx vitest run src/lib/tech/field-queries.test.ts src/lib/tech/timesheet-queries.test.ts`
- `npx vitest run src/app/api/auth/tech/login/route.test.ts src/app/api/auth/tech/logout/route.test.ts`
- `npx vitest run src/components/tech/tech-status-confirm.test.ts`
- `npx vitest run src/lib/tech/ownership.test.ts src/lib/tech/status-actions.test.ts src/lib/tech/status-writes.test.ts src/lib/tech/time-entry-sql.test.ts src/lib/tech/visit-range.test.ts`
- Gate: `npx tsc --noEmit`

**Setup guide hook:** `createTechSession` (`src/lib/auth/tech-session.ts`) writes
`flags.techSignedInAt` write-once via `after()` (`flagsStatementSql` with
`guardTechSignedIn`), skipped for the demo org; failures only log. That flag is
what completes the `tech_sign_in` step. `scripts/agent/mint-tech-session.mjs`
signs the cookie directly and BYPASSES this hook, so a minted session never
completes the step. See page-setup.
