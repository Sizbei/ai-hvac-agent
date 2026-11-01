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
`src/components/tech/tech-job-summary.tsx` · terminal-status confirm helpers
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

**Invariants:**
- **Assignee + tenant guard**: every mutation route checks BOTH
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
- Tapping a terminal status target (`cancelled`, `completed`) in
  `TechJobSummary` does NOT fire the status POST immediately — it opens an
  inline confirm (`role="alertdialog"`, copy from `tech-status-confirm.ts`'s
  `buildStatusConfirmCopy`) and only advances on the explicit "Yes, mark …"
  tap. Non-terminal targets (`scheduled`, `in_progress`, `on_hold`) still
  advance on first tap. `isTerminalStatus`/`buildStatusConfirmCopy` are pure —
  keep new terminal statuses added there, not hardcoded in the component.
- Travel taps: "On my way" (`en_route`) and "I've arrived" (`arrived`) post
  to the same `POST /api/tech/jobs/[id]/status` route; wording comes from
  `techStatusLabel` in `tech-status-confirm.ts`. Chain: scheduled/assigned/
  on_hold → en_route → arrived → in_progress; there is no arrived →
  completed. Ownership is still `assigned_to` (visit assignment rows do not
  grant tech access). Both are non-terminal, so no confirm step.
- `/api/auth/tech/login` starts with the same-origin + JSON content-type
  guard (`isSameOriginRequest` / `hasJsonContentType`) before any DB read or
  session mint — see page-auth for the shared pattern.

**Gotchas:**
- `params` in `TechJobDetailPage` is a `Promise` (this Next.js version) — always
  `await params` before reading `id`.
- The tech portal has no admin-pages design system dependency — it uses base shadcn
  primitives (`Card`, `CardContent`, `Button`, `Input`, `Skeleton`); do not import
  admin-ui primitives here.
- Photos are uploaded to R2 via `/api/upload`; signature is captured as a data-URI
  blob; both are stored as `attachments` rows linked to the service request.

**Verify changes:**
- `npx vitest run src/app/api/tech/jobs/[id]/route.test.ts`
- `npx vitest run src/lib/tech/field-queries.test.ts src/lib/tech/timesheet-queries.test.ts`
- `npx vitest run src/app/api/auth/tech/login/route.test.ts src/app/api/auth/tech/logout/route.test.ts`
- `npx vitest run src/components/tech/tech-status-confirm.test.ts`
- Gate: `npx tsc --noEmit`
